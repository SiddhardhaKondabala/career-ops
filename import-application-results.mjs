#!/usr/bin/env node
/**
 * import-application-results.mjs — import executor results into the tracker.
 *
 * Phase 5 of the career-ops <-> LinkedIn-bot integration. Reads the bot's
 * application-result.v1 JSONL, matches each result to a tracker row by
 * integration_id (canonical URL only when unique), and records the outcome
 * through the canonical set-status.mjs writer. It NEVER edits
 * data/applications.md directly, never downgrades a submitted row, and is
 * idempotent: set-status appends notes by exact text, so re-importing the same
 * results changes nothing.
 *
 *   node import-application-results.mjs --results "$CAREER_OPS_INTEGRATION_DIR/linkedin-results.jsonl"
 *   node import-application-results.mjs --dry-run
 *
 * The planning core (lib/application-result-importer.mjs) is dependency-free and
 * the apply step is injectable, so the planning and its tests run without a
 * running tracker or `npm install`.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

import { resolveTrackerPath, getCareerOpsRoot } from './path-resolver.mjs';
import { loadTrackerJobs } from './export-approved-jobs.mjs';
import { validateApplicationResult } from './lib/integration-schema.mjs';
import { buildRowIndex, planImports } from './lib/application-result-importer.mjs';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Read + validate an application-result.v1 JSONL file. A malformed record (bad
 * JSON or a schema violation) is SKIPPED with a reason, not fatal — one corrupt
 * line must not block importing the rest. A missing file is still an error.
 *
 * @returns {{results: object[], skipped: {line: number, error: string}[]}}
 */
export function readResults(resultsPath) {
  if (!existsSync(resultsPath)) throw new Error(`results file not found: ${resultsPath}`);
  const results = [];
  const skipped = [];
  readFileSync(resultsPath, 'utf-8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let doc;
    try {
      doc = JSON.parse(line);
    } catch (e) {
      skipped.push({ line: i + 1, error: `invalid JSON: ${e.message}` });
      return;
    }
    const { valid, errors } = validateApplicationResult(doc);
    if (!valid) {
      skipped.push({ line: i + 1, error: errors.join('; ') });
      return;
    }
    results.push(doc);
  });
  return { results, skipped };
}

function defaultResultsPath() {
  const dir = process.env.CAREER_OPS_INTEGRATION_DIR;
  return dir ? join(dir, 'linkedin-results.jsonl') : null;
}

/** Default apply step: the canonical set-status.mjs CLI, under the tracker lock. */
function defaultApplyFn() {
  return async ({ reportNumber, state, note }) => {
    const args = [join(ROOT, 'set-status.mjs'), '--report', String(reportNumber), state, '--note', note];
    const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf-8', timeout: 60_000 });
    if (r.status !== 0) {
      throw new Error(`set-status failed for report ${reportNumber}: ${(r.stderr || r.stdout || '').trim()}`);
    }
    return r.stdout;
  };
}

export async function runImport(argv = process.argv.slice(2), { applyFn } = {}) {
  const dryRun = hasFlag(argv, '--dry-run');
  const resultsPath = flagValue(argv, '--results') || defaultResultsPath();
  if (!resultsPath) {
    throw new Error('import-application-results: provide --results <path> or set CAREER_OPS_INTEGRATION_DIR');
  }

  const trackerPath = resolveTrackerPath(getCareerOpsRoot());
  const { results, skipped: malformed } = readResults(resultsPath);
  for (const m of malformed) console.error(`[import] skipped malformed record (line ${m.line}): ${m.error}`);
  const jobs = loadTrackerJobs({ trackerPath });
  const index = buildRowIndex(jobs);
  const actions = planImports(results, index);

  const apply = applyFn ?? defaultApplyFn();
  const counts = { apply: 0, refuse: 0, skip: 0, status_changed: 0, note_only: 0, failed: 0, malformed: malformed.length };
  // Track the latest status we have driven each row to WITHIN this run, so a
  // later note-only result re-asserts the row's current status rather than the
  // stale pre-import one — otherwise it would downgrade a status an earlier
  // result in the same run already advanced (e.g. a later 'failed' undoing an
  // earlier 'submitted' → Applied).
  const latestStatus = new Map();

  for (const a of actions) {
    if (a.action === 'refuse') {
      counts.refuse++;
      console.error(`[import] REFUSED (ambiguous match): ${a.result.integration_id}`);
      continue;
    }
    if (a.action === 'skip') {
      counts.skip++;
      console.error(`[import] skip (no matching tracker row): ${a.result.integration_id}`);
      continue;
    }
    counts.apply++;
    const known = latestStatus.has(a.reportNumber) ? latestStatus.get(a.reportNumber) : a.currentStatus;
    const state = a.setStatus || known || 'Evaluated';
    if (a.setStatus) {
      counts.status_changed++;
      latestStatus.set(a.reportNumber, a.setStatus);
    } else {
      counts.note_only++;
    }
    if (!dryRun) {
      // One set-status failure (e.g. a row that no longer resolves) must not
      // block the remaining results.
      try {
        await apply({ reportNumber: a.reportNumber, state, note: a.note });
      } catch (e) {
        counts.failed++;
        console.error(`[import] apply failed for report ${a.reportNumber}: ${e.message}`);
      }
    }
  }

  console.error(
    `[import] results=${results.length} applied=${counts.apply} ` +
      `(status→${counts.status_changed}, note-only=${counts.note_only}) ` +
      `refused=${counts.refuse} skipped=${counts.skip} failed=${counts.failed} malformed=${counts.malformed}` +
      `${dryRun ? '  (dry-run, nothing written)' : ''}`,
  );
  return { actions, counts };
}

if (isMainModule(import.meta.url)) {
  runImport().catch((err) => {
    console.error(`[import-application-results] ${err.message}`);
    process.exit(1);
  });
}
