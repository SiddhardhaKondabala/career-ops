/**
 * integration-identity.mjs — stable identity for a job crossing the bridge.
 *
 * Both repos must agree on two things about a posting: its CANONICAL URL (so the
 * same job discovered twice is one row) and its INTEGRATION ID (the idempotency
 * anchor the importer matches on). This derives both from the existing LinkedIn
 * URL parser in linkedin-url.mjs, so the bridge never re-invents URL handling
 * that the scan/liveness path already tests.
 *
 * Dependency-light on purpose (crypto + linkedin-url only): test fixtures copy
 * it next to the scripts they exercise.
 */

import { createHash } from 'node:crypto';
import { linkedInJobId } from './linkedin-url.mjs';

/** Parse a URL string, returning null instead of throwing on junk. */
export function parseUrl(raw) {
  try {
    return new URL(String(raw));
  } catch {
    return null;
  }
}

/** The numeric LinkedIn job id in a URL string, or null. */
export function linkedInJobIdFromUrl(raw) {
  const u = parseUrl(raw);
  return u ? linkedInJobId(u) : null;
}

/** True when a URL string points at one LinkedIn job posting. */
export function isValidLinkedInUrl(raw) {
  return linkedInJobIdFromUrl(raw) !== null;
}

/**
 * The canonical form of a posting URL.
 *
 * A LinkedIn posting collapses to `https://www.linkedin.com/jobs/view/{id}`
 * regardless of the shape it arrived in (search view, email `/comm` link,
 * `?currentJobId=`), so two spellings of one job compare equal. Any other URL
 * is normalized conservatively: https, lowercase host, no query/hash, no
 * trailing slash. Returns null for input that is not a URL.
 */
export function canonicalUrl(raw) {
  const u = parseUrl(raw);
  if (!u) return null;
  const id = linkedInJobId(u);
  if (id) return `https://www.linkedin.com/jobs/view/${id}`;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, '');
  return `https://${host}${path}`;
}

/**
 * The deterministic integration id for a job.
 *
 * For a LinkedIn posting it is `linkedin:{jobId}` — the same id every reader
 * derives from any spelling of the URL. For anything else it is
 * `{source}:{16-hex}` where the hex is a sha256 over the most specific stable
 * key available (external_job_id, then requisition_id, then canonical URL), so
 * it never collides by company+role alone.
 *
 * @param {{source?: string, canonical_url?: string, requisition_id?: string|null,
 *   external_job_id?: string|null}} fields
 * @returns {string}
 */
export function integrationId({
  source = 'linkedin',
  canonical_url = '',
  requisition_id = null,
  external_job_id = null,
} = {}) {
  const u = parseUrl(canonical_url);
  const id = u ? linkedInJobId(u) : null;
  if (id) return `linkedin:${id}`;
  const key = external_job_id || requisition_id || canonical_url || '';
  const hex = createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
  return `${source}:${hex}`;
}
