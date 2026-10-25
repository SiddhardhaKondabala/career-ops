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
import { assertApplicationResult } from './lib/integration-schema.mjs';
import { buildRowIndex, planImports } from './lib/application-result-importer.mjs';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** Read + validate an application-result.v1 JSONL file. Throws on bad input. */
export function readResults(resultsPath) {
  if (!existsSync(resultsPath)) throw new Error(`results file not found: ${resultsPath}`);
  const out = [];
  readFileSync(resultsPath, 'utf-8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let doc;
    try {
      doc = JSON.parse(line);
    } catch (e) {
      throw new Error(`results line ${i + 1} is not valid JSON: ${e.message}`);
    }
    assertApplicationResult(doc); // throws on a record that violates application-result.v1
    out.push(doc);
  });
  return out;
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
  const results = readResults(resultsPath);
  const jobs = loadTrackerJobs({ trackerPath });
  const index = buildRowIndex(jobs);
  const actions = planImports(results, index);

  const apply = applyFn ?? defaultApplyFn();
  const counts = { apply: 0, refuse: 0, skip: 0, status_changed: 0, note_only: 0 };

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
    const state = a.setStatus || a.currentStatus || 'Evaluated';
    if (a.setStatus) counts.status_changed++;
    else counts.note_only++;
    if (!dryRun) await apply({ reportNumber: a.reportNumber, state, note: a.note });
  }

  console.error(
    `[import] results=${results.length} applied=${counts.apply} ` +
      `(status→${counts.status_changed}, note-only=${counts.note_only}) ` +
      `refused=${counts.refuse} skipped=${counts.skip}${dryRun ? '  (dry-run, nothing written)' : ''}`,
  );
  return { actions, counts };
}

if (isMainModule(import.meta.url)) {
  runImport().catch((err) => {
    console.error(`[import-application-results] ${err.message}`);
    process.exit(1);
  });
}
