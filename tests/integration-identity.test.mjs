// tests/integration-identity.test.mjs — canonical URL + integration id (Phase 1).
//
// The bridge's deduplication and idempotency rest on these two functions
// agreeing across every spelling of a posting. Pins that all three LinkedIn URL
// shapes collapse to one canonical URL and one `linkedin:{id}`, and that
// non-LinkedIn URLs get a deterministic, collision-resistant id.
//
// HERMETIC: pure functions, no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalUrl,
  integrationId,
  isValidLinkedInUrl,
  linkedInJobIdFromUrl,
} from '../lib/integration-identity.mjs';

const CANON = 'https://www.linkedin.com/jobs/view/4012345678';

test('the three LinkedIn URL shapes collapse to one canonical URL', () => {
  const spellings = [
    'https://www.linkedin.com/jobs/view/4012345678',
    'https://www.linkedin.com/jobs/view/staff-engineer-at-acme-4012345678/?refId=abc',
    'https://www.linkedin.com/comm/jobs/view/4012345678?trk=eml',
    'https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=x',
    'https://uk.linkedin.com/jobs/view/4012345678',
  ];
  for (const url of spellings) {
    assert.equal(canonicalUrl(url), CANON, `failed for ${url}`);
  }
});

test('one LinkedIn posting yields one integration id across spellings', () => {
  const a = integrationId({ source: 'linkedin', canonical_url: 'https://www.linkedin.com/jobs/view/4012345678' });
  const b = integrationId({ source: 'linkedin', canonical_url: 'https://www.linkedin.com/comm/jobs/view/4012345678?trk=eml' });
  assert.equal(a, 'linkedin:4012345678');
  assert.equal(a, b);
});

test('isValidLinkedInUrl accepts postings and rejects everything else', () => {
  assert.equal(isValidLinkedInUrl('https://www.linkedin.com/jobs/view/4012345678'), true);
  assert.equal(isValidLinkedInUrl('https://www.linkedin.com/feed/'), false);
  assert.equal(isValidLinkedInUrl('https://boards.greenhouse.io/acme/jobs/123'), false);
  assert.equal(isValidLinkedInUrl('linkedin.com.evil.example/jobs/view/1'), false);
  assert.equal(isValidLinkedInUrl('not a url'), false);
});

test('linkedInJobIdFromUrl returns the numeric id or null', () => {
  assert.equal(linkedInJobIdFromUrl('https://www.linkedin.com/jobs/view/4012345678'), '4012345678');
  assert.equal(linkedInJobIdFromUrl('https://example.com/x'), null);
});

test('a non-LinkedIn URL gets a deterministic, source-prefixed id', () => {
  const url = 'https://boards.greenhouse.io/acme/jobs/123';
  const a = integrationId({ source: 'greenhouse', canonical_url: url });
  const b = integrationId({ source: 'greenhouse', canonical_url: url });
  assert.equal(a, b);
  assert.match(a, /^greenhouse:[0-9a-f]{16}$/);
});

test('external_job_id wins over URL for the fallback id key', () => {
  const withId = integrationId({ source: 'ats', canonical_url: 'https://x.example/a', external_job_id: 'JR-9' });
  const sameId = integrationId({ source: 'ats', canonical_url: 'https://x.example/b', external_job_id: 'JR-9' });
  assert.equal(withId, sameId); // same requisition, different landing URLs → one id
});

test('canonicalUrl normalizes a non-LinkedIn URL conservatively', () => {
  assert.equal(
    canonicalUrl('HTTPS://Boards.Greenhouse.io/acme/jobs/123/?utm=x#top'),
    'https://boards.greenhouse.io/acme/jobs/123',
  );
  assert.equal(canonicalUrl('garbage'), null);
});
