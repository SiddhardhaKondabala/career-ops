// tests/export-approved-jobs.test.mjs — the approved-job exporter (Phase 2, M1).
//
// Pins the approval policy and the queue it produces. The selection core is
// tested as pure functions (fast, exhaustive); the CLI is tested end-to-end
// against hermetic tmpdir workspaces (external data root, localized headers,
// dry-run, idempotent re-run).
//
// HERMETIC: tmpdir fixtures only; nothing reads or writes real user data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHash } from 'node:crypto';
import {
  exclusionReason,
  selectApprovedJobs,
  buildQueue,
  buildApprovedJob,
  parseReport,
  dateToIso,
  sha256File,
  runExport,
  parseIntegrationBlacklist,
  integrationBlacklistMatcher,
} from '../export-approved-jobs.mjs';
import { assertApprovedJobs } from '../lib/integration-schema.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'export-approved-jobs.mjs');
const NOW = '2026-10-24T12:00:00Z';
const OPTS = { minScore: 4.0, blacklistMatcher: () => null, source: 'linkedin', generatedAt: NOW };

function jobRecord(overrides = {}) {
  return {
    reportNumber: 1,
    reportPath: '/abs/reports/001.md',
    company: 'Acme',
    role: 'Staff Engineer',
    date: '2026-06-20',
    status: 'Evaluated',
    score: 4.2,
    confidence: 'High',
    legitimacyTier: 'High Confidence',
    finalDecision: 'Apply',
    hardStops: [],
    via: null,
    url: 'https://www.linkedin.com/jobs/view/4012345678',
    requisitionId: null,
    resumePath: '/abs/resume.pdf',
    coverLetterPath: '/abs/cover.pdf',
    resumeSha256: 'a'.repeat(64),
    coverLetterSha256: 'b'.repeat(64),
    resumeFactCheckFailed: false,
    ...overrides,
  };
}

// --- selection policy (pure) ---

test('a fully eligible job passes', () => {
  assert.equal(exclusionReason(jobRecord(), OPTS), null);
});

test('score 3.9 is excluded, 4.0 is included', () => {
  assert.equal(exclusionReason(jobRecord({ score: 3.9 }), OPTS), 'low_score');
  assert.equal(exclusionReason(jobRecord({ score: 4.0 }), OPTS), null);
});

test('low confidence is excluded', () => {
  assert.equal(exclusionReason(jobRecord({ confidence: 'Low' }), OPTS), 'low_confidence');
  assert.equal(exclusionReason(jobRecord({ confidence: 'Medium' }), OPTS), null);
});

test('already applied is excluded', () => {
  assert.equal(exclusionReason(jobRecord({ status: 'Applied' }), OPTS), 'already_applied');
  assert.equal(exclusionReason(jobRecord({ status: 'Interview' }), OPTS), 'already_applied');
});

test('a non-evaluated status (SKIP) is excluded', () => {
  assert.equal(exclusionReason(jobRecord({ status: 'SKIP' }), OPTS), 'skipped');
});

test('missing report is excluded', () => {
  assert.equal(exclusionReason(jobRecord({ reportPath: null }), OPTS), 'missing_report');
});

test('missing resume is excluded', () => {
  assert.equal(exclusionReason(jobRecord({ resumePath: null }), OPTS), 'missing_resume');
});

test('an unhashed artifact is excluded', () => {
  assert.equal(exclusionReason(jobRecord({ resumeSha256: null }), OPTS), 'missing_resume_hash');
  assert.equal(exclusionReason(jobRecord({ coverLetterSha256: null }), OPTS), 'missing_cover_letter_hash');
});

test('failed CV fact check is excluded', () => {
  assert.equal(exclusionReason(jobRecord({ resumeFactCheckFailed: true }), OPTS), 'failed_cv_fact_check');
});

test('a hard stop is excluded', () => {
  assert.equal(exclusionReason(jobRecord({ hardStops: ['Requires visa sponsorship'] }), OPTS), 'hard_stop');
});

test('an unresolved agency gate is excluded', () => {
  assert.equal(exclusionReason(jobRecord({ via: 'Hays' }), OPTS), 'agency_gate');
  assert.equal(exclusionReason(jobRecord({ via: '—' }), OPTS), null); // sentinel = no agency
});

test('a non-apply final decision is excluded', () => {
  assert.equal(exclusionReason(jobRecord({ finalDecision: 'Manual Review' }), OPTS), 'not_apply_decision');
  assert.equal(exclusionReason(jobRecord({ finalDecision: null }), OPTS), 'not_apply_decision');
});

test('an unverified posting is excluded', () => {
  assert.equal(exclusionReason(jobRecord({ legitimacyTier: 'Low Confidence' }), OPTS), 'unverified_posting');
});

test('a blacklisted company is excluded', () => {
  const opts = { ...OPTS, blacklistMatcher: () => ({ company: 'Acme' }) };
  assert.equal(exclusionReason(jobRecord(), opts), 'blacklisted');
});

test('dependency-free blacklist parser enforces company and domain entries', () => {
  const entries = parseIntegrationBlacklist([
    '| Company | Since | Scope | Reason |',
    '|---|---|---|---|',
    '| Acme Corp. | 2026-01-01 | company | user decision |',
    '| linkedin.com | 2026-01-02 | domain | blocked host |',
  ].join('\n'));
  const match = integrationBlacklistMatcher(entries);
  assert.equal(match('acme corp', 'https://example.com/jobs/1')?.reason, 'user decision');
  assert.equal(match('Other', 'https://www.linkedin.com/jobs/view/1')?.reason, 'blocked host');
});

test('an invalid LinkedIn URL is excluded', () => {
  assert.equal(
    exclusionReason(jobRecord({ url: 'https://boards.greenhouse.io/acme/jobs/1' }), OPTS),
    'invalid_linkedin_url',
  );
});

// --- batch selection, dedup, ordering ---

test('duplicate URL is excluded (first wins)', () => {
  const a = jobRecord({ reportNumber: 1 });
  const b = jobRecord({ reportNumber: 2 }); // same URL
  const { approved, skipped } = selectApprovedJobs([a, b], OPTS);
  assert.equal(approved.length, 1);
  assert.equal(skipped.filter((s) => s.reason === 'duplicate_url').length, 1);
});

test('duplicate requisition is excluded', () => {
  const a = jobRecord({ url: 'https://www.linkedin.com/jobs/view/111', requisitionId: 'R-9' });
  const b = jobRecord({ url: 'https://www.linkedin.com/jobs/view/222', requisitionId: 'R-9' });
  const { approved, skipped } = selectApprovedJobs([a, b], OPTS);
  assert.equal(approved.length, 1);
  assert.equal(skipped.filter((s) => s.reason === 'duplicate_requisition').length, 1);
});

test('ordering is deterministic regardless of input order', () => {
  const j1 = jobRecord({ url: 'https://www.linkedin.com/jobs/view/111', score: 4.0 });
  const j2 = jobRecord({ url: 'https://www.linkedin.com/jobs/view/222', score: 4.5 });
  const j3 = jobRecord({ url: 'https://www.linkedin.com/jobs/view/333', score: 4.2 });
  const order1 = selectApprovedJobs([j1, j2, j3], OPTS).approved.map((j) => j.canonical_url);
  const order2 = selectApprovedJobs([j3, j1, j2], OPTS).approved.map((j) => j.canonical_url);
  assert.deepEqual(order1, order2);
  // Best score first.
  assert.equal(order1[0], 'https://www.linkedin.com/jobs/view/222');
});

test('a row with no date is excluded (keeps created_at stable)', () => {
  assert.equal(exclusionReason(jobRecord({ date: '' }), OPTS), 'missing_date');
  assert.equal(exclusionReason(jobRecord({ date: 'N/A' }), OPTS), 'missing_date');
});

test('a row that would build an invalid job is skipped, not fatal', () => {
  // Score 5.5 passes the >=4.0 gate but violates the schema max (5); the row is
  // dropped with reason invalid_job and the rest of the export still succeeds.
  const good = jobRecord();
  const bad = jobRecord({ url: 'https://www.linkedin.com/jobs/view/999', score: 5.5 });
  const { approved, skipped } = selectApprovedJobs([bad, good], OPTS);
  assert.equal(approved.length, 1);
  assert.equal(approved[0].canonical_url, 'https://www.linkedin.com/jobs/view/4012345678');
  assert.equal(skipped.filter((s) => s.reason === 'invalid_job').length, 1);
});

test('runExport rejects an unsupported source and a non-numeric min-score', async () => {
  await assert.rejects(runExport(['--source', 'indeed', '--dry-run']), /unsupported --source/);
  await assert.rejects(runExport(['--min-score', 'abc', '--dry-run']), /min-score must be a number/);
  await assert.rejects(runExport(['--min-score', '4oops', '--dry-run']), /min-score must be a number/);
});

test('the produced queue validates against approved-jobs.v1', () => {
  const { approved } = selectApprovedJobs([jobRecord()], OPTS);
  const queue = buildQueue(approved, { minScore: 4.0, executor: 'linkedin', generatedAt: NOW });
  assert.doesNotThrow(() => assertApprovedJobs(queue));
  assert.equal(queue.jobs[0].integration_id, 'linkedin:4012345678');
});

// --- report parsing + date normalization ---

test('parseReport extracts URL and Machine Summary fields', () => {
  const r = parseReport(
    '**URL:** https://www.linkedin.com/jobs/view/999\n\n```yaml\n' +
      'score: 4.3\nconfidence: "High"\nlegitimacy_tier: "High Confidence"\n' +
      'final_decision: "Apply"\nhard_stops: []\nvia: null\n```\n',
  );
  assert.equal(r.url, 'https://www.linkedin.com/jobs/view/999');
  assert.equal(r.score, 4.3);
  assert.equal(r.confidence, 'High');
  assert.equal(r.finalDecision, 'Apply');
  assert.deepEqual(r.hardStops, []);
});

test('buildApprovedJob carries the artifact hashes through (Phase 6)', () => {
  const built = buildApprovedJob(
    jobRecord({ resumeSha256: 'a'.repeat(64), coverLetterSha256: 'b'.repeat(64) }),
    { source: 'linkedin', generatedAt: NOW },
  );
  assert.equal(built.resume_sha256, 'a'.repeat(64));
  assert.equal(built.cover_letter_sha256, 'b'.repeat(64));
});

test('buildApprovedJob defaults missing hashes to null', () => {
  const built = buildApprovedJob(
    jobRecord({ resumeSha256: null, coverLetterSha256: null }),
    { source: 'linkedin', generatedAt: NOW },
  );
  assert.equal(built.resume_sha256, null);
  assert.equal(built.cover_letter_sha256, null);
});

test('sha256File hashes a file and returns null for an absent path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sha-'));
  const f = join(dir, 'x.pdf');
  writeFileSync(f, '%PDF-1.4 bytes');
  const expected = createHash('sha256').update(readFileSync(f)).digest('hex');
  assert.equal(sha256File(f), expected);
  assert.equal(sha256File(join(dir, 'missing.pdf')), null);
  assert.equal(sha256File(null), null);
});

test('dateToIso upgrades a date-only tracker value to an instant', () => {
  assert.equal(dateToIso('2026-06-20', NOW), '2026-06-20T00:00:00Z');
  assert.equal(dateToIso('', NOW), NOW);
});

// --- CLI, end-to-end against a hermetic workspace ---

const LINKEDIN_REPORT = `# 001 — Acme — Staff Engineer

**Date:** 2026-06-20
**Score:** 4.2/5
**URL:** https://www.linkedin.com/jobs/view/4012345678
**PDF:** ✅
**Legitimacy:** High Confidence

## Machine Summary

\`\`\`yaml
company: "Acme"
role: "Staff Engineer"
score: 4.2
legitimacy_tier: "High Confidence"
final_decision: "Apply"
hard_stops: []
confidence: "High"
via: null
\`\`\`
`;

function makeWorkspace({ headerRow } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'export-aj-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'reports'), { recursive: true });
  mkdirSync(join(root, 'output'), { recursive: true });

  const header =
    headerRow ||
    '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |';
  const tracker = [
    '# Applications Tracker',
    '',
    header,
    '|---|------|---------|-----|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-06-20 | Acme | — | Staff Engineer | 4.2/5 | Evaluated | ✅ | [1](../reports/001-acme.md) | Strong fit |',
    '| 2 | 2026-06-21 | Globex | — | SRE | 3.1/5 | Evaluated | ❌ | [2](../reports/002-globex.md) | Below bar |',
    '| 3 | 2026-06-22 | Initech | — | DevOps | 4.4/5 | Applied | ✅ | [3](../reports/003-initech.md) | Already applied |',
    '',
  ].join('\n');
  writeFileSync(join(root, 'data', 'applications.md'), tracker);

  writeFileSync(join(root, 'reports', '001-acme.md'), LINKEDIN_REPORT);
  writeFileSync(join(root, 'reports', '002-globex.md'), LINKEDIN_REPORT.replace('4012345678', '555').replace(/4\.2/g, '3.1'));
  writeFileSync(join(root, 'reports', '003-initech.md'), LINKEDIN_REPORT.replace('4012345678', '777'));

  // Tailored resume PDFs for reports 1 and 3 (report 2 has none -> below bar anyway).
  writeFileSync(join(root, 'output', 'cv-001.pdf'), '%PDF-1.4 fake');
  writeFileSync(join(root, 'output', 'cv-003.pdf'), '%PDF-1.4 fake');
  writeFileSync(
    join(root, 'data', 'pdf-index.tsv'),
    [
      ['1', 'output/cv-001.pdf', 'output/cv-001.html', 'a4', '2026-06-20', 'cv'].join('\t'),
      ['3', 'output/cv-003.pdf', 'output/cv-003.html', 'a4', '2026-06-22', 'cv'].join('\t'),
      '',
    ].join('\n'),
  );
  return root;
}

function runCli(root, args) {
  const env = { ...process.env, CAREER_OPS_ROOT: root };
  delete env.CAREER_OPS_TRACKER;
  delete env.CAREER_OPS_PDF_INDEX;
  delete env.CAREER_OPS_DATA_DIR;
  delete env.CAREER_OPS_PROFILE;
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env, encoding: 'utf-8', timeout: 60_000 });
}

test('CLI exports only approved jobs, validates, from an external data root', () => {
  const root = makeWorkspace();
  const out = join(root, 'linkedin-approved.json');
  const r = runCli(root, ['--source', 'linkedin', '--min-score', '4.0', '--out', out]);
  assert.equal(r.status, 0, `exporter failed: ${r.stderr}`);
  assert.ok(existsSync(out), 'queue not written');
  const queue = JSON.parse(readFileSync(out, 'utf-8'));
  assert.doesNotThrow(() => assertApprovedJobs(queue));
  // Only report 1 qualifies: #2 is below bar, #3 already Applied.
  assert.equal(queue.jobs.length, 1);
  assert.equal(queue.jobs[0].canonical_url, 'https://www.linkedin.com/jobs/view/4012345678');
  assert.ok(queue.jobs[0].resume_path.endsWith('cv-001.pdf'));
  // Phase 6: the queue carries the exact SHA-256 of the exported resume PDF.
  const expectedSha = createHash('sha256')
    .update(readFileSync(join(root, 'output', 'cv-001.pdf')))
    .digest('hex');
  assert.equal(queue.jobs[0].resume_sha256, expectedSha);
});

test('CLI dry-run writes nothing', () => {
  const root = makeWorkspace();
  const out = join(root, 'linkedin-approved.json');
  const r = runCli(root, ['--source', 'linkedin', '--min-score', '4.0', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(out), 'dry-run must not write the queue');
});

test('CLI re-run is idempotent (unchanged queue not rewritten)', () => {
  const root = makeWorkspace();
  const out = join(root, 'linkedin-approved.json');
  assert.equal(runCli(root, ['--min-score', '4.0', '--out', out]).status, 0);
  const firstMtime = statSync(out).mtimeMs;
  const second = runCli(root, ['--min-score', '4.0', '--out', out]);
  assert.equal(second.status, 0);
  assert.equal(statSync(out).mtimeMs, firstMtime, 'identical queue should not be rewritten');
  assert.match(second.stderr, /unchanged/);
});

test('CLI reads localized tracker headers', () => {
  const root = makeWorkspace({
    headerRow: '| # | Fecha | Empresa | Via | Puesto | Score | Status | PDF | Report | Notes |',
  });
  const out = join(root, 'linkedin-approved.json');
  const r = runCli(root, ['--min-score', '4.0', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const queue = JSON.parse(readFileSync(out, 'utf-8'));
  assert.equal(queue.jobs.length, 1);
  assert.equal(queue.jobs[0].company, 'Acme');
});
