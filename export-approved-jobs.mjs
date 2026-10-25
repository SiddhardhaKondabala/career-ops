#!/usr/bin/env node
/**
 * export-approved-jobs.mjs — build the LinkedIn-bot approved-job queue.
 *
 * Phase 2 of the career-ops <-> LinkedIn-bot integration. career-ops is the
 * system of record; this exports ONLY the jobs that pass the approval policy,
 * as an approved-jobs.v1 queue the bot consumes without re-scoring or searching.
 *
 * It reads the canonical tracker (data/applications.md), each selected job's
 * report (reports/NNN-*.md, for the posting URL and the evaluation's Machine
 * Summary), and the PDF manifest (data/pdf-index.tsv, for the tailored resume
 * and cover letter), all through the existing data-root resolvers so an external
 * CAREER_OPS_ROOT and localized tracker headers just work.
 *
 * Selection (a job must pass ALL):
 *   - has a report (so we have a URL and an evaluation)
 *   - status is "Evaluated" (scored, not yet submitted — no prior submission)
 *   - score >= min-score (default 4.0/5)
 *   - evaluation confidence is medium or high
 *   - posting legitimacy is verified (not low-confidence/unverified)
 *   - the evaluation's final decision is "Apply"
 *   - no hard stop (work-authorization/legal/etc.)
 *   - no unresolved agency gate (Via/agency is empty)
 *   - company/URL is not blacklisted
 *   - the URL is a valid LinkedIn posting (for --source linkedin)
 *   - the tailored resume passed its CV fact check
 *   - a tailored resume PDF exists
 *   - has a tracker date (so created_at is stable across runs)
 *
 * Each built job is validated against approved-jobs.v1 individually; a row that
 * would produce an invalid job is skipped rather than aborting the whole export.
 * Output is deterministically ordered and validated against approved-jobs.v1.
 * The queue is written idempotently: an unchanged queue is not rewritten.
 *
 * Nothing here writes to a tracked personal-data path; the queue goes to
 * --out (typically $CAREER_OPS_INTEGRATION_DIR, outside both git repos).
 *
 * The pure selection core is exported for unit testing; the CLI wires the real
 * loaders around it. See docs/INTEGRATION_LINKEDIN.md.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';

import { resolveTrackerPath, getCareerOpsRoot } from './path-resolver.mjs';
import {
  resolveColumns,
  parseTrackerRow,
  parseScore,
  parseMarkdownLinks,
  firstLinkTarget,
  extractReqNumber,
} from './tracker-parse.mjs';
import {
  assertApprovedJobs,
  validate,
  APPROVED_JOBS_SCHEMA,
  APPROVED_JOBS_SCHEMA_ID,
} from './lib/integration-schema.mjs';
import { canonicalUrl, integrationId, isValidLinkedInUrl } from './lib/integration-identity.mjs';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

// These two helpers also live in tracker-utils.mjs, but importing that module
// pulls in js-yaml (via lib/yaml-document.mjs). The exporter stays dependency-
// free — like the rest of the integration layer — so it runs, and its tests run,
// without `npm install`. The logic mirrors tracker-utils exactly.

/** The workspace root that owns a tracker: <root>/data/applications.md -> <root>. */
function workspaceRootOf(trackerPath) {
  return resolve(dirname(trackerPath), '..');
}

/** Resolve the PDF manifest for a tracker (CAREER_OPS_PDF_INDEX overrides). */
function resolvePdfIndexPath(trackerPath) {
  return process.env.CAREER_OPS_PDF_INDEX || join(workspaceRootOf(trackerPath), 'data', 'pdf-index.tsv');
}

/** Write via a temp file + rename, so a reader never sees a half-written queue. */
function writeFileAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * The SHA-256 of a file's bytes as a lowercase hex string, or null when the
 * path is absent or unreadable. The bot recomputes this before upload, so the
 * exact artifact career-ops approved is the one the executor sends, and a file
 * swapped or regenerated between export and run is caught as an integrity
 * mismatch rather than silently applied with.
 */
export function sha256File(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

// --- vocabulary -------------------------------------------------------------

/** The one tracker status that means "scored, not yet submitted". */
export const ELIGIBLE_STATUS = 'evaluated';

/** Statuses that mean the job was already submitted — never re-export. */
export const SUBMITTED_STATUSES = new Set([
  'applied', 'responded', 'assessment', 'interview', 'offer', 'hired', 'rejected',
]);

/** Statuses that mean the user decided NOT to apply. */
export const SKIP_STATUSES = new Set(['skip', 'discarded']);

/** Evaluation confidences allowed into the queue. */
export const CONFIDENCE_OK = new Set(['medium', 'high']);

/** Posting-legitimacy tiers that count as verified/live. */
export function isVerifiedTier(tier) {
  const t = String(tier ?? '').toLowerCase();
  return /\b(high|medium)\s+confidence\b/.test(t) || t === 'verified';
}

// --- report parsing ---------------------------------------------------------

/**
 * Pull the structured signals out of a report file: the posting URL from the
 * header and the evaluation fields from the fenced ```yaml Machine Summary.
 * Tolerant of a missing block (returns what it can).
 *
 * @param {string} text - Report markdown.
 * @returns {{url: string|null, score: number|null, confidence: string|null,
 *   legitimacyTier: string|null, finalDecision: string|null, hardStops: string[],
 *   via: string|null, company: string|null, role: string|null}}
 */
export function parseReport(text) {
  const src = String(text ?? '');
  const url = src.match(/\*\*URL:\*\*\s*(\S+)/i)?.[1] ?? null;
  const block = src.match(/```ya?ml\s*([\s\S]*?)```/i);
  const summary = block ? parseMachineSummary(block[1]) : {};
  const headerLegit = src.match(/\*\*Legitimacy:\*\*\s*(.+)/i)?.[1]?.trim() ?? null;
  const score = summary.score != null && summary.score !== '' ? Number(summary.score) : null;
  return {
    url,
    score: Number.isFinite(score) ? score : null,
    confidence: scalarOrNull(summary.confidence),
    legitimacyTier: scalarOrNull(summary.legitimacy_tier) ?? headerLegit,
    finalDecision: scalarOrNull(summary.final_decision),
    hardStops: Array.isArray(summary.hard_stops) ? summary.hard_stops.filter(Boolean) : [],
    via: scalarOrNull(summary.via),
    company: scalarOrNull(summary.company),
    role: scalarOrNull(summary.role),
  };
}

function scalarOrNull(v) {
  return v == null || v === '' ? null : String(v);
}

function stripQuotes(s) {
  return String(s).replace(/^["']|["']$/g, '');
}

/**
 * Parse the controlled, flat Machine Summary YAML the evaluator emits. This is
 * not a general YAML parser — the integration layer stays dependency-free (no
 * js-yaml), and the Machine Summary is a generated block of `key: scalar`,
 * `key: []`, `key: [a, b]`, and `key:` + `  - item` block lists.
 */
export function parseMachineSummary(block) {
  const out = {};
  const lines = String(block ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    if (val === '') {
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        items.push(stripQuotes(lines[j].replace(/^\s*-\s+/, '').trim()));
        j++;
      }
      out[key] = items;
      i = j - 1;
    } else if (val === '[]') {
      out[key] = [];
    } else if (/^\[.*\]$/.test(val)) {
      out[key] = val.slice(1, -1).split(',').map((s) => stripQuotes(s.trim())).filter((s) => s !== '');
    } else if (val === 'null' || val === '~') {
      out[key] = null;
    } else {
      out[key] = stripQuotes(val);
    }
  }
  return out;
}

// --- selection (pure) -------------------------------------------------------

/** Treat tracker "no data" sentinels as absent. */
function blank(value) {
  const v = String(value ?? '').trim();
  return v === '' || v === '—' || v === '-' || v === 'N/A';
}

/**
 * The reason a job is excluded, or null when it is eligible. Ordered so the most
 * fundamental gate reported wins when several would apply.
 *
 * @param {object} job - A record from loadTrackerJobs().
 * @param {{minScore: number, blacklistMatcher: (company: string, url: string) => unknown}} options
 * @returns {string|null}
 */
export function exclusionReason(job, { minScore, blacklistMatcher }) {
  if (!job.reportPath) return 'missing_report';

  const status = String(job.status ?? '').toLowerCase();
  if (SUBMITTED_STATUSES.has(status)) return 'already_applied';
  if (SKIP_STATUSES.has(status)) return 'skipped';
  if (status !== ELIGIBLE_STATUS) return 'not_evaluated';

  if (!(job.score >= minScore)) return 'low_score';
  if (!CONFIDENCE_OK.has(String(job.confidence ?? '').toLowerCase())) return 'low_confidence';
  if (!isVerifiedTier(job.legitimacyTier)) return 'unverified_posting';
  if (job.finalDecision != null && String(job.finalDecision).toLowerCase() !== 'apply') {
    return 'not_apply_decision';
  }
  if (Array.isArray(job.hardStops) && job.hardStops.length > 0) return 'hard_stop';
  if (!blank(job.via)) return 'agency_gate';
  if (blacklistMatcher(job.company ?? '', job.url ?? '')) return 'blacklisted';
  if (!isValidLinkedInUrl(job.url)) return 'invalid_linkedin_url';
  if (job.resumeFactCheckFailed) return 'failed_cv_fact_check';
  if (!job.resumePath) return 'missing_resume';
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(job.date ?? '').trim())) return 'missing_date';
  return null;
}

/**
 * Turn an eligible job record into an approved-jobs.v1 job object.
 *
 * @param {object} job
 * @param {{source: string, generatedAt: string}} options
 */
export function buildApprovedJob(job, { source, generatedAt }) {
  const canonical = canonicalUrl(job.url);
  const approved = {
    integration_id: integrationId({
      source,
      canonical_url: canonical,
      requisition_id: job.requisitionId ?? null,
    }),
    canonical_url: canonical,
    company: job.company,
    role: job.role,
    career_ops_score: job.score,
    evaluation_confidence: String(job.confidence).toLowerCase(),
    report_number: typeof job.reportNumber === 'number' ? job.reportNumber : String(job.reportNumber),
    report_path: job.reportPath,
    resume_path: job.resumePath,
    cover_letter_path: job.coverLetterPath ?? null,
    resume_sha256: job.resumeSha256 ?? null,
    cover_letter_sha256: job.coverLetterSha256 ?? null,
    source,
    application_status: 'approved',
    created_at: dateToIso(job.date, generatedAt),
  };
  if (job.requisitionId) approved.requisition_id = job.requisitionId;
  return approved;
}

/** Normalize a tracker date (YYYY-MM-DD) to an ISO-8601 instant. */
export function dateToIso(date, fallbackIso) {
  const d = String(date ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return `${d}T00:00:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(d)) return d;
  return fallbackIso;
}

/**
 * Select the approved jobs from a batch of tracker job records.
 *
 * Deduplicates eligible jobs by canonical URL (first wins) and by requisition
 * id, and returns a deterministically ordered approved list plus skip reasons.
 *
 * @param {object[]} jobs
 * @param {{minScore: number, blacklistMatcher: Function, source: string, generatedAt: string}} options
 */
export function selectApprovedJobs(jobs, { minScore, blacklistMatcher, source, generatedAt }) {
  const jobSchema = APPROVED_JOBS_SCHEMA.properties.jobs.items;
  const approved = [];
  const skipped = [];
  const seenUrls = new Set();
  const seenReqs = new Set();

  for (const job of jobs) {
    const reason = exclusionReason(job, { minScore, blacklistMatcher });
    if (reason) {
      skipped.push({ job, reason });
      continue;
    }
    const built = buildApprovedJob(job, { source, generatedAt });
    // A row that would produce an invalid job (e.g. a score outside 1–5) is
    // skipped, so one bad row never aborts the whole export.
    if (!validate(built, jobSchema).valid) {
      skipped.push({ job, reason: 'invalid_job' });
      continue;
    }
    if (seenUrls.has(built.canonical_url)) {
      skipped.push({ job, reason: 'duplicate_url' });
      continue;
    }
    if (built.requisition_id && seenReqs.has(built.requisition_id)) {
      skipped.push({ job, reason: 'duplicate_requisition' });
      continue;
    }
    seenUrls.add(built.canonical_url);
    if (built.requisition_id) seenReqs.add(built.requisition_id);
    approved.push(built);
  }

  // Deterministic ordering regardless of tracker row order: best score first,
  // then integration id as a stable tie-break.
  approved.sort((a, b) =>
    b.career_ops_score - a.career_ops_score ||
    (a.integration_id < b.integration_id ? -1 : a.integration_id > b.integration_id ? 1 : 0),
  );

  const counts = { approved: approved.length };
  for (const { reason } of skipped) counts[reason] = (counts[reason] ?? 0) + 1;
  return { approved, skipped, counts };
}

/** Wrap approved jobs in the approved-jobs.v1 envelope. */
export function buildQueue(approved, { minScore, executor, generatedAt }) {
  return {
    schema: APPROVED_JOBS_SCHEMA_ID,
    generated_at: generatedAt,
    min_score: minScore,
    executor,
    jobs: approved,
  };
}

/** Two queues are equivalent when everything but generated_at matches. */
export function queuesEquivalent(a, b) {
  if (!a || !b) return false;
  const strip = (q) => JSON.stringify({ schema: q.schema, min_score: q.min_score, executor: q.executor, jobs: q.jobs });
  return strip(a) === strip(b);
}

/**
 * Write the queue to outPath, but only when it differs from what is already
 * there (ignoring generated_at). Returns whether a write happened.
 */
export function writeQueueIdempotent(outPath, queue) {
  if (existsSync(outPath)) {
    try {
      const existing = JSON.parse(readFileSync(outPath, 'utf-8'));
      if (queuesEquivalent(existing, queue)) return { written: false, reason: 'unchanged' };
    } catch {
      // unreadable/corrupt existing file — overwrite it
    }
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileAtomic(outPath, JSON.stringify(queue, null, 2) + '\n');
  return { written: true };
}

// --- loaders (CLI side) -----------------------------------------------------

/** Read data/pdf-index.tsv into a Map keyed `${reportNum}:${kind}` -> pdf path. */
export function readPdfIndex(indexPath) {
  const map = new Map();
  if (!indexPath || !existsSync(indexPath)) return map;
  for (const line of readFileSync(indexPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const [reportNum, pdf, , , , kind] = line.split('\t');
    if (reportNum == null || pdf == null) continue;
    map.set(`${String(reportNum).trim()}:${String(kind ?? '').trim()}`, String(pdf).trim());
  }
  return map;
}

function pdfPathFor(index, workspaceRoot, reportNumber, kind) {
  const rel = index.get(`${reportNumber}:${kind}`);
  if (!rel) return null;
  return isAbsolute(rel) ? rel : resolve(workspaceRoot, rel);
}

/**
 * Read the tracker and assemble one job record per data row, joining in each
 * row's report and PDF-manifest data.
 *
 * @param {{trackerPath: string}} options
 * @returns {object[]}
 */
export function loadTrackerJobs({ trackerPath }) {
  const text = readFileSync(trackerPath, 'utf-8');
  const lines = text.split('\n');
  const colmap = resolveColumns(lines);
  const trackerDir = dirname(trackerPath);
  const workspaceRoot = workspaceRootOf(trackerPath);
  const pdfIndex = readPdfIndex(resolvePdfIndexPath(trackerPath));

  const jobs = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;

    const reportTarget = firstLinkTarget(row.report);
    const reportPath = reportTarget ? resolve(trackerDir, reportTarget) : null;
    const reportNumber = reportNumberFrom(row, reportTarget);

    const report = reportPath && existsSync(reportPath)
      ? parseReport(readFileSync(reportPath, 'utf-8'))
      : {};

    const resumePath = pdfPathForExisting(pdfIndex, workspaceRoot, reportNumber, 'cv');
    const coverLetterPath = pdfPathForExisting(pdfIndex, workspaceRoot, reportNumber, 'cover');

    jobs.push({
      reportNumber,
      reportPath: reportPath && existsSync(reportPath) ? reportPath : null,
      company: row.company,
      role: row.role,
      date: row.date,
      status: row.status,
      score: parseScore(row.score) || report.score || 0,
      confidence: report.confidence ?? null,
      legitimacyTier: report.legitimacyTier ?? null,
      finalDecision: report.finalDecision ?? null,
      hardStops: report.hardStops ?? [],
      via: !blank(row.via) ? row.via : report.via ?? null,
      url: (!blank(row.url) ? row.url : null) ?? report.url ?? null,
      requisitionId: extractReqNumber(row.notes),
      resumePath,
      coverLetterPath,
      resumeSha256: sha256File(resumePath),
      coverLetterSha256: sha256File(coverLetterPath),
      resumeFactCheckFailed: false,
    });
  }
  return jobs;
}

function pdfPathForExisting(index, workspaceRoot, reportNumber, kind) {
  const p = pdfPathFor(index, workspaceRoot, reportNumber, kind);
  return p && existsSync(p) ? p : null;
}

function reportNumberFrom(row, reportTarget) {
  const label = parseMarkdownLinks(row.report)[0]?.label;
  const fromLabel = label && /^\d+$/.test(label.trim()) ? parseInt(label, 10) : null;
  if (fromLabel != null) return fromLabel;
  const fromFile = reportTarget?.match(/(\d+)/)?.[1];
  if (fromFile) return parseInt(fromFile, 10);
  return row.num;
}

/** Default blacklist matcher: the canonical scan.mjs rules, lazily imported. */
export async function defaultBlacklistMatcher() {
  try {
    const scan = await import('./scan.mjs');
    const blacklist = scan.loadBlacklist();
    return (company, url) => scan.findBlacklistEntry(blacklist, company, url);
  } catch (err) {
    console.error(`[export-approved-jobs] blacklist unavailable (${err.message}); proceeding with no blacklist`);
    return () => null;
  }
}

// --- CLI --------------------------------------------------------------------

export async function runExport(argv = process.argv.slice(2), { blacklistMatcher, now } = {}) {
  const source = flagValue(argv, '--source') || 'linkedin';
  const minScore = parseFloat(flagValue(argv, '--min-score') ?? '4.0');
  const out = flagValue(argv, '--out');
  const dryRun = hasFlag(argv, '--dry-run');
  const generatedAt = (now ?? new Date()).toISOString();

  if (source !== 'linkedin') {
    throw new Error(`export-approved-jobs: unsupported --source "${source}" (only "linkedin" in v1)`);
  }
  if (!Number.isFinite(minScore)) {
    throw new Error('export-approved-jobs: --min-score must be a number');
  }
  if (!out && !dryRun) {
    throw new Error('export-approved-jobs: provide --out <path> or --dry-run');
  }

  const trackerPath = resolveTrackerPath(getCareerOpsRoot());
  const jobs = loadTrackerJobs({ trackerPath });
  const matcher = blacklistMatcher ?? (await defaultBlacklistMatcher());
  const { approved, skipped, counts } = selectApprovedJobs(jobs, {
    minScore,
    blacklistMatcher: matcher,
    source,
    generatedAt,
  });

  const queue = buildQueue(approved, { minScore, executor: source, generatedAt });
  assertApprovedJobs(queue);

  let write = { written: false, reason: dryRun ? 'dry-run' : 'no-out' };
  if (!dryRun && out) write = writeQueueIdempotent(out, queue);

  const skipLine = Object.entries(counts)
    .filter(([k]) => k !== 'approved')
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
  const where = dryRun ? '(dry-run, not written)' : write.written ? `-> ${out}` : `(unchanged, ${out})`;
  console.error(`[export-approved-jobs] approved=${approved.length} ${where}${skipLine ? `  skipped: ${skipLine}` : ''}`);

  return { queue, approved, skipped, counts, write, trackerPath };
}

if (isMainModule(import.meta.url)) {
  runExport().catch((err) => {
    console.error(`[export-approved-jobs] ${err.message}`);
    process.exit(1);
  });
}
