/**
 * application-result-importer.mjs — map executor results back onto the tracker.
 *
 * Pure planning for Phase 5: given application-result.v1 records and the current
 * tracker rows, decide which row each result matches, what status change (if
 * any) it implies, and the note to append. The CLI
 * (import-application-results.mjs) applies the plan through the canonical
 * set-status.mjs writer — this module never touches data/applications.md.
 *
 * Dependency-light (integration-schema + integration-identity only), so the
 * planning and its tests run without `npm install`.
 */

import { canonicalUrl, integrationId } from './integration-identity.mjs';

/**
 * Tracker statuses that mean the application was already submitted (or further).
 * A result must never move a row OUT of one of these — "do not downgrade Applied".
 */
export const SUBMITTED_OR_LATER = new Set([
  'applied', 'responded', 'assessment', 'interview', 'offer', 'hired', 'rejected',
]);

/**
 * Make a string safe for a single markdown-table Notes cell: no newlines or
 * tabs (they break the row), no "|" (a column separator), and no "; " (which
 * set-status uses to split notes). Collapses runs of whitespace.
 */
function sanitizeNote(s) {
  return String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s*;\s+/g, ', ')
    .replace(/\|/g, '/')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * A deterministic, table-safe note for a result. Deterministic matters:
 * set-status appends notes idempotently by exact text, so re-importing the same
 * result adds no duplicate note. The executor's error_message can be a multi-line
 * traceback, so it is sanitized and truncated before it reaches the tracker.
 */
export function buildNote(result) {
  const parts = [`LinkedIn apply: ${result.result}`];
  if (result.error_code) parts.push(`(${result.error_code})`);
  parts.push(`[run ${result.executor_run_id} @ ${result.finished_at}]`);
  if (result.error_message) {
    let msg = sanitizeNote(result.error_message);
    if (msg.length > 200) msg = `${msg.slice(0, 197)}...`;
    parts.push(`— ${msg}`);
  }
  return sanitizeNote(parts.join(' '));
}

/**
 * The status change a result implies for a row currently at `currentStatus`.
 * Only a confirmed submission advances a row to Applied, and only when the row
 * is not already submitted-or-later (no downgrade). Every other result keeps the
 * row's status and records a note explaining what happened.
 *
 * @returns {{setStatus: string|null, note: string}} setStatus null = note only.
 */
export function mapResult(result, currentStatus) {
  const note = buildNote(result);
  const current = String(currentStatus ?? '').toLowerCase();
  const alreadySubmitted = SUBMITTED_OR_LATER.has(current);
  if (result.result === 'submitted' || result.result === 'already_applied') {
    return { setStatus: alreadySubmitted ? null : 'Applied', note };
  }
  // manual_review / captcha / requires_mfa / failed / skipped / expired / invalid
  return { setStatus: null, note };
}

/**
 * Build lookup indexes from tracker job records (loadTrackerJobs output).
 * A row is indexed only when it has a URL we can derive an identity from.
 */
export function buildRowIndex(jobs) {
  const byIntegrationId = new Map();
  const byCanonicalUrl = new Map();
  for (const job of jobs) {
    if (!job.url) continue;
    const canonical = canonicalUrl(job.url);
    if (!canonical) continue;
    const id = integrationId({
      source: 'linkedin',
      canonical_url: canonical,
      requisition_id: job.requisitionId ?? null,
    });
    const entry = {
      reportNumber: job.reportNumber,
      status: job.status,
      canonical_url: canonical,
      company: job.company,
      role: job.role,
      integration_id: id,
    };
    const idEntries = byIntegrationId.get(id) ?? [];
    idEntries.push(entry);
    byIntegrationId.set(id, idEntries);
    const list = byCanonicalUrl.get(canonical) ?? [];
    list.push(entry);
    byCanonicalUrl.set(canonical, list);
  }
  return { byIntegrationId, byCanonicalUrl };
}

/**
 * Resolve the tracker row a result refers to: integration_id first, then a
 * UNIQUE canonical-URL match. Several URL matches are refused as ambiguous
 * rather than guessed.
 *
 * @returns {{status: 'matched'|'ambiguous'|'unmatched', entry?: object, by?: string, candidates?: object[]}}
 */
export function resolveMatch(result, index) {
  const byId = index.byIntegrationId.get(result.integration_id) ?? [];
  if (byId.length === 1) return { status: 'matched', entry: byId[0], by: 'integration_id' };
  if (byId.length > 1) return { status: 'ambiguous', candidates: byId };

  const canonical = canonicalUrl(result.canonical_url);
  const hits = (canonical && index.byCanonicalUrl.get(canonical)) || [];
  if (hits.length === 1) return { status: 'matched', entry: hits[0], by: 'canonical_url' };
  if (hits.length > 1) return { status: 'ambiguous', candidates: hits };
  return { status: 'unmatched' };
}

/**
 * Plan one action per result: apply (status change and/or note), refuse
 * (ambiguous), or skip (unmatched).
 */
export function planImports(results, index) {
  const actions = [];
  for (const result of results) {
    const match = resolveMatch(result, index);
    if (match.status === 'ambiguous') {
      actions.push({ result, action: 'refuse', reason: 'ambiguous_match', candidates: match.candidates });
      continue;
    }
    if (match.status === 'unmatched') {
      actions.push({ result, action: 'skip', reason: 'unmatched' });
      continue;
    }
    const { setStatus, note } = mapResult(result, match.entry.status);
    actions.push({
      action: 'apply',
      result,
      by: match.by,
      reportNumber: match.entry.reportNumber,
      currentStatus: match.entry.status,
      setStatus,
      note,
    });
  }
  return actions;
}
