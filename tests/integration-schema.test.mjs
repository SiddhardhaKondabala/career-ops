// tests/integration-schema.test.mjs — the versioned bridge contract (Phase 1).
//
// Pins that career-ops rejects unsupported schema versions and missing/invalid
// fields on BOTH the approved-jobs queue and the application-result record,
// using the dependency-free validator in lib/integration-schema.mjs. The bot
// side validates the same JSON Schema files with `jsonschema`; these tests guard
// career-ops' half so the two halves cannot drift silently.
//
// HERMETIC: no fixtures on disk, no personal data.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVED_JOBS_SCHEMA_ID,
  APPLICATION_RESULT_SCHEMA_ID,
  RESULT_VALUES,
  CONFIDENCE_LEVELS,
  validateApprovedJobs,
  validateApplicationResult,
  assertApprovedJobs,
  assertApplicationResult,
  assertSupportedSchema,
  IntegrationSchemaError,
} from '../lib/integration-schema.mjs';

function validJob(overrides = {}) {
  return {
    integration_id: 'linkedin:4012345678',
    canonical_url: 'https://www.linkedin.com/jobs/view/4012345678',
    company: 'Acme',
    role: 'Staff Engineer',
    career_ops_score: 4.2,
    evaluation_confidence: 'high',
    report_number: 17,
    report_path: 'reports/17.md',
    resume_path: '/abs/resume.pdf',
    cover_letter_path: '/abs/cover.pdf',
    source: 'linkedin',
    application_status: 'approved',
    created_at: '2026-10-24T12:00:00Z',
    ...overrides,
  };
}

function validQueue(jobs = [validJob()]) {
  return {
    schema: APPROVED_JOBS_SCHEMA_ID,
    generated_at: '2026-10-24T12:00:00Z',
    min_score: 4.0,
    executor: 'linkedin',
    jobs,
  };
}

function validResult(overrides = {}) {
  return {
    schema: APPLICATION_RESULT_SCHEMA_ID,
    executor_run_id: 'run-1',
    integration_id: 'linkedin:4012345678',
    canonical_url: 'https://www.linkedin.com/jobs/view/4012345678',
    started_at: '2026-10-24T12:00:00Z',
    finished_at: '2026-10-24T12:01:00Z',
    result: 'submitted',
    confidence: 'high',
    company: 'Acme',
    role: 'Staff Engineer',
    career_ops_score: 4.2,
    resume_path: '/abs/resume.pdf',
    cover_letter_path: '/abs/cover.pdf',
    screenshot_paths: ['/abs/shot-1.png'],
    questions_encountered: [],
    fields_filled: ['first_name', 'last_name'],
    error_code: null,
    error_message: null,
    manual_action_required: false,
    ...overrides,
  };
}

test('a well-formed approved-jobs queue validates', () => {
  const r = validateApprovedJobs(validQueue());
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
});

test('unsupported queue schema version is rejected', () => {
  const r = validateApprovedJobs({ ...validQueue(), schema: 'approved-jobs.v2' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('schema')));
});

test('missing required queue field is rejected', () => {
  const q = validQueue();
  delete q.min_score;
  const r = validateApprovedJobs(q);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('min_score')));
});

test('missing required job field is rejected', () => {
  const job = validJob();
  delete job.resume_path;
  const r = validateApprovedJobs(validQueue([job]));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('resume_path')));
});

test('wrong-typed score is rejected', () => {
  const r = validateApprovedJobs(validQueue([validJob({ career_ops_score: '4.2' })]));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('career_ops_score')));
});

test('out-of-range score is rejected', () => {
  const r = validateApprovedJobs(validQueue([validJob({ career_ops_score: 6 })]));
  assert.equal(r.valid, false);
});

test('bad evaluation_confidence enum is rejected', () => {
  const r = validateApprovedJobs(validQueue([validJob({ evaluation_confidence: 'certain' })]));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('evaluation_confidence')));
});

test('unexpected job property is rejected (additionalProperties:false)', () => {
  const r = validateApprovedJobs(validQueue([validJob({ hacked: true })]));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('hacked')));
});

test('nullable cover_letter_path is allowed', () => {
  const r = validateApprovedJobs(validQueue([validJob({ cover_letter_path: null })]));
  assert.equal(r.valid, true);
});

test('string report_number is allowed', () => {
  const r = validateApprovedJobs(validQueue([validJob({ report_number: 'REQ-17' })]));
  assert.equal(r.valid, true);
});

test('assertApprovedJobs throws IntegrationSchemaError with details', () => {
  assert.throws(
    () => assertApprovedJobs({ ...validQueue(), schema: 'nope' }),
    (e) => e instanceof IntegrationSchemaError && Array.isArray(e.errors) && e.errors.length > 0,
  );
});

test('a well-formed result validates', () => {
  const r = validateApplicationResult(validResult());
  assert.deepEqual(r.errors, []);
});

test('every allowed result value validates', () => {
  for (const value of RESULT_VALUES) {
    const r = validateApplicationResult(validResult({ result: value }));
    assert.equal(r.valid, true, `${value} should be valid: ${r.errors.join('; ')}`);
  }
});

test('an unknown result value is rejected', () => {
  const r = validateApplicationResult(validResult({ result: 'definitely_applied' }));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('result')));
});

test('result confidence accepts the known levels and null', () => {
  for (const c of [...CONFIDENCE_LEVELS, null]) {
    assert.equal(validateApplicationResult(validResult({ confidence: c })).valid, true);
  }
  assert.equal(validateApplicationResult(validResult({ confidence: 'vibes' })).valid, false);
});

test('a failed result still requires its fields', () => {
  const r = validateApplicationResult(validResult({ result: 'failed', error_code: 'E_NAV', error_message: 'navigation timeout' }));
  assert.equal(r.valid, true);
});

test('assertApplicationResult rejects a missing required field', () => {
  const bad = validResult();
  delete bad.manual_action_required;
  assert.throws(() => assertApplicationResult(bad), IntegrationSchemaError);
});

// --- Contract hardening: timestamps and the keyword guard ---

test('an empty queue timestamp is rejected', () => {
  const r = validateApprovedJobs({ ...validQueue(), generated_at: '' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('generated_at')));
});

test('a malformed queue timestamp is rejected', () => {
  const r = validateApprovedJobs({ ...validQueue(), generated_at: '2026-10-24 12:00' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('generated_at')));
});

test('a malformed job created_at is rejected', () => {
  const r = validateApprovedJobs(validQueue([validJob({ created_at: 'yesterday' })]));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('created_at')));
});

test('a malformed result timestamp is rejected', () => {
  const r = validateApplicationResult(validResult({ started_at: '' }));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('started_at')));
});

test('a timestamp with a UTC offset is accepted', () => {
  assert.equal(validateApprovedJobs({ ...validQueue(), generated_at: '2026-10-24T12:00:00+05:30' }).valid, true);
  assert.equal(validateApplicationResult(validResult({ started_at: '2026-10-24T12:00:00.123Z' })).valid, true);
});

test('assertSupportedSchema throws on a keyword the validator does not implement', () => {
  const schema = { type: 'object', properties: { x: { type: 'string', uniqueItems: true } } };
  assert.throws(
    () => assertSupportedSchema(schema),
    (e) => e instanceof IntegrationSchemaError && /uniqueItems/.test(e.message),
  );
});

test('assertSupportedSchema accepts the implemented subset', () => {
  const schema = {
    type: 'object',
    required: ['a'],
    additionalProperties: false,
    properties: {
      a: { type: 'string', minLength: 1, pattern: '^x' },
      b: { type: 'array', items: { type: 'number', minimum: 0, maximum: 9 } },
      c: { const: 'k' },
      d: { enum: ['p', 'q', null] },
    },
  };
  assert.doesNotThrow(() => assertSupportedSchema(schema));
});
