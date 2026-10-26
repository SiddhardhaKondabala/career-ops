// tests/import-application-results.test.mjs — Phase 5 result importer (M4).
//
// Pure planning (map/match/downgrade/ambiguity) plus runImport against hermetic
// tmpdir trackers with an injected set-status, so nothing writes a real tracker
// and the suite needs no `npm install`.
//
// HERMETIC: tmpdir fixtures only; the apply step is injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  mapResult,
  buildNote,
  resolveMatch,
  planImports,
  buildRowIndex,
} from '../lib/application-result-importer.mjs';
import { runImport } from '../import-application-results.mjs';

const URL1 = 'https://www.linkedin.com/jobs/view/4012345678';

function result(overrides = {}) {
  return {
    schema: 'application-result.v1',
    executor_run_id: 'run-1',
    integration_id: 'linkedin:4012345678',
    canonical_url: URL1,
    started_at: '2026-10-24T12:00:00Z',
    finished_at: '2026-10-24T12:01:00Z',
    result: 'submitted',
    confidence: 'high',
    company: 'Acme',
    role: 'Staff Engineer',
    career_ops_score: 4.2,
    resume_path: '/abs/resume.pdf',
    cover_letter_path: null,
    screenshot_paths: [],
    questions_encountered: [],
    fields_filled: [],
    error_code: null,
    error_message: null,
    manual_action_required: false,
    ...overrides,
  };
}

// --- mapping ---

test('submitted and already_applied advance an unsubmitted row to Applied', () => {
  assert.equal(mapResult(result({ result: 'submitted' }), 'Evaluated').setStatus, 'Applied');
  assert.equal(mapResult(result({ result: 'already_applied' }), 'Evaluated').setStatus, 'Applied');
});

test('a submission never downgrades an already-submitted row', () => {
  assert.equal(mapResult(result({ result: 'submitted' }), 'Applied').setStatus, null);
  assert.equal(mapResult(result({ result: 'submitted' }), 'Interview').setStatus, null);
});

test('non-submission results are note-only (keep status)', () => {
  for (const r of ['manual_review', 'captcha', 'requires_mfa', 'failed', 'skipped', 'expired', 'invalid']) {
    const m = mapResult(result({ result: r }), 'Evaluated');
    assert.equal(m.setStatus, null, `${r} should not change status`);
    assert.ok(m.note.includes(r));
  }
});

test('buildNote is deterministic and "; "-free (idempotent note text)', () => {
  const a = buildNote(result({ error_code: 'E', error_message: 'a; b' }));
  const b = buildNote(result({ error_code: 'E', error_message: 'a; b' }));
  assert.equal(a, b);
  assert.ok(!a.includes('; '));
  assert.ok(a.includes('run run-1'));
});

test('buildNote strips newlines/tabs/pipes so it cannot corrupt the tracker row', () => {
  const note = buildNote(result({ error_code: 'E_NAV', error_message: 'line1\nline2 | piped\tTabbed' }));
  assert.ok(!/[\r\n\t]/.test(note), 'no newlines/tabs');
  assert.ok(!note.includes('|'), 'no pipe (markdown column separator)');
  assert.ok(!note.includes('; '));
});

test('buildNote truncates a very long error_message', () => {
  const note = buildNote(result({ error_code: 'E', error_message: 'x'.repeat(500) }));
  assert.ok(note.length < 300);
  assert.ok(note.endsWith('...'));
});

// --- matching ---

const E1 = { reportNumber: 1, status: 'Evaluated', canonical_url: URL1, integration_id: 'linkedin:4012345678' };

function indexOf(entries) {
  const byIntegrationId = new Map();
  const byCanonicalUrl = new Map();
  for (const e of entries) {
    const ids = byIntegrationId.get(e.integration_id) ?? [];
    ids.push(e);
    byIntegrationId.set(e.integration_id, ids);
    const l = byCanonicalUrl.get(e.canonical_url) ?? [];
    l.push(e);
    byCanonicalUrl.set(e.canonical_url, l);
  }
  return { byIntegrationId, byCanonicalUrl };
}

test('matches by integration_id first', () => {
  const m = resolveMatch(result(), indexOf([E1]));
  assert.equal(m.status, 'matched');
  assert.equal(m.by, 'integration_id');
});

test('falls back to a unique canonical URL', () => {
  const m = resolveMatch(result({ integration_id: 'linkedin:nomatch' }), indexOf([E1]));
  assert.equal(m.status, 'matched');
  assert.equal(m.by, 'canonical_url');
});

test('refuses an ambiguous canonical-URL match', () => {
  const a = { reportNumber: 2, status: 'Evaluated', canonical_url: 'https://x.test/a', integration_id: 'ats:aaa' };
  const b = { reportNumber: 3, status: 'Evaluated', canonical_url: 'https://x.test/a', integration_id: 'ats:bbb' };
  const m = resolveMatch({ integration_id: 'ats:zzz', canonical_url: 'https://x.test/a' }, indexOf([a, b]));
  assert.equal(m.status, 'ambiguous');
  assert.equal(m.candidates.length, 2);
});

test('refuses duplicate tracker rows with the same integration id', () => {
  const jobs = [
    { reportNumber: 1, status: 'Evaluated', url: URL1, company: 'Acme', role: 'Staff Engineer' },
    { reportNumber: 2, status: 'Evaluated', url: URL1, company: 'Acme', role: 'Staff Engineer' },
  ];
  const m = resolveMatch(result(), buildRowIndex(jobs));
  assert.equal(m.status, 'ambiguous');
  assert.equal(m.candidates.length, 2);
});

test('unmatched result resolves to unmatched', () => {
  assert.equal(resolveMatch(result({ integration_id: 'linkedin:9', canonical_url: 'https://www.linkedin.com/jobs/view/9' }), indexOf([E1])).status, 'unmatched');
});

test('planImports produces apply / refuse / skip', () => {
  const a = { reportNumber: 2, status: 'Evaluated', canonical_url: 'https://x.test/a', integration_id: 'ats:aaa' };
  const b = { reportNumber: 3, status: 'Evaluated', canonical_url: 'https://x.test/a', integration_id: 'ats:bbb' };
  const index = indexOf([E1, a, b]);
  const actions = planImports(
    [
      result(), // matches E1 -> apply
      result({ integration_id: 'ats:zzz', canonical_url: 'https://x.test/a' }), // ambiguous -> refuse
      result({ integration_id: 'linkedin:9', canonical_url: 'https://www.linkedin.com/jobs/view/9' }), // unmatched -> skip
    ],
    index,
  );
  assert.deepEqual(actions.map((x) => x.action), ['apply', 'refuse', 'skip']);
});

// --- runImport against a hermetic tracker ---

const ENV_KEYS = ['CAREER_OPS_ROOT', 'CAREER_OPS_TRACKER', 'CAREER_OPS_PDF_INDEX', 'CAREER_OPS_INTEGRATION_DIR', 'CAREER_OPS_PROFILE'];

async function runIn(root, argv, applyFn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.CAREER_OPS_ROOT = root;
  try {
    return await runImport(argv, { applyFn });
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function makeWorkspace({ status = 'Evaluated', header, results } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'import-aj-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'reports'), { recursive: true });
  const head = header || '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |';
  const tracker = [
    '# Applications Tracker',
    '',
    head,
    '|---|------|---------|-----|------|-------|--------|-----|--------|-------|',
    `| 1 | 2026-06-20 | Acme | — | Staff Engineer | 4.2/5 | ${status} | ✅ | [1](../reports/001.md) | strong fit |`,
    '',
  ].join('\n');
  writeFileSync(join(root, 'data', 'applications.md'), tracker);
  writeFileSync(join(root, 'reports', '001.md'), `# 001 — Acme — Staff Engineer\n**URL:** ${URL1}\n`);
  const resultsPath = join(root, 'results.jsonl');
  writeFileSync(resultsPath, (results || [result()]).map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { root, resultsPath };
}

function recorder() {
  const calls = [];
  return { fn: async (a) => calls.push(a), calls };
}

test('M4: a submitted result updates the row to Applied exactly once', async () => {
  const { root, resultsPath } = makeWorkspace();
  const { fn, calls } = recorder();
  const { counts } = await runIn(root, ['--results', resultsPath], fn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reportNumber, 1);
  assert.equal(calls[0].state, 'Applied');
  assert.ok(calls[0].note.includes('submitted'));
  assert.equal(counts.status_changed, 1);
});

test('a note-only result keeps the current status', async () => {
  const { root, resultsPath } = makeWorkspace({ results: [result({ result: 'captcha', error_code: 'captcha' })] });
  const { fn, calls } = recorder();
  await runIn(root, ['--results', resultsPath], fn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state, 'Evaluated'); // unchanged
  assert.ok(calls[0].note.toLowerCase().includes('captcha'));
});

test('a submission on an already-Applied row does not downgrade', async () => {
  const { root, resultsPath } = makeWorkspace({ status: 'Applied' });
  const { fn, calls } = recorder();
  const { actions } = await runIn(root, ['--results', resultsPath], fn);
  assert.equal(actions[0].setStatus, null); // no status change planned
  assert.equal(calls[0].state, 'Applied'); // passed through, no downgrade
});

test('dry-run plans but applies nothing', async () => {
  const { root, resultsPath } = makeWorkspace();
  const { fn, calls } = recorder();
  const { actions } = await runIn(root, ['--results', resultsPath, '--dry-run'], fn);
  assert.equal(calls.length, 0);
  assert.equal(actions[0].action, 'apply');
});

test('localized / custom tracker columns still match', async () => {
  const { root, resultsPath } = makeWorkspace({
    header: '| # | Fecha | Empresa | Via | Location | Puesto | Score | Status | PDF | Report | Notes |',
  });
  // Rewrite the data row to match the extra Location column.
  writeFileSync(
    join(root, 'data', 'applications.md'),
    [
      '# Applications Tracker',
      '',
      '| # | Fecha | Empresa | Via | Location | Puesto | Score | Status | PDF | Report | Notes |',
      '|---|-------|---------|-----|----------|--------|-------|--------|-----|--------|-------|',
      '| 1 | 2026-06-20 | Acme | — | Remote | Staff Engineer | 4.2/5 | Evaluated | ✅ | [1](../reports/001.md) | fit |',
      '',
    ].join('\n'),
  );
  const { fn, calls } = recorder();
  await runIn(root, ['--results', resultsPath], fn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state, 'Applied');
});

test('a later note-only result does not downgrade a status set earlier in the same run', async () => {
  const { root, resultsPath } = makeWorkspace({
    results: [
      result({ executor_run_id: 'run-1', result: 'submitted' }),
      result({ executor_run_id: 'run-2', result: 'failed', error_code: 'E_NAV', error_message: 'boom' }),
    ],
  });
  const { fn, calls } = recorder();
  await runIn(root, ['--results', resultsPath], fn);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].state, 'Applied'); // submitted → Applied
  assert.equal(calls[1].state, 'Applied'); // later 'failed' must NOT downgrade to Evaluated
});

test('a malformed result record is skipped, valid ones still imported', async () => {
  const { root, resultsPath } = makeWorkspace({ results: [result()] });
  writeFileSync(
    resultsPath,
    [
      JSON.stringify(result()), // valid
      '{ not json', // malformed JSON
      JSON.stringify({ ...result(), result: 'bogus' }), // schema-invalid
    ].join('\n') + '\n',
  );
  const { fn, calls } = recorder();
  const { counts } = await runIn(root, ['--results', resultsPath], fn);
  assert.equal(calls.length, 1); // only the valid record applied
  assert.equal(counts.malformed, 2);
});

test('one set-status failure does not abort the rest of the import', async () => {
  const { root, resultsPath } = makeWorkspace({
    results: [result({ executor_run_id: 'run-1' }), result({ executor_run_id: 'run-2' })],
  });
  const calls = [];
  let n = 0;
  const applyFn = async (a) => {
    calls.push(a);
    n += 1;
    if (n === 1) throw new Error('set-status boom');
  };
  const { counts } = await runIn(root, ['--results', resultsPath], applyFn);
  assert.equal(calls.length, 2); // both attempted despite the first failing
  assert.equal(counts.failed, 1);
});

test('re-importing the same result is deterministic (idempotent note text)', async () => {
  const { root, resultsPath } = makeWorkspace();
  const first = recorder();
  await runIn(root, ['--results', resultsPath], first.fn);
  const second = recorder();
  await runIn(root, ['--results', resultsPath], second.fn);
  assert.equal(first.calls[0].note, second.calls[0].note);
});
