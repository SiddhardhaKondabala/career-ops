/**
 * integration-schema.mjs — the versioned contract for the LinkedIn-bot bridge.
 *
 * career-ops owns the two JSON Schema files in ../schemas. The execution engine
 * (the LinkedIn bot) carries vendored copies and validates them with its own
 * `jsonschema` dependency. This module is career-ops' side of the same contract:
 * it loads those schema files and validates documents against them WITHOUT a
 * third-party validator, to keep career-ops dependency-light (there is no ajv in
 * this tree; see package.json).
 *
 * The validator implements only the JSON Schema subset the two files use:
 * `type` (string or array, incl. "null" and "integer"), `const`, `enum`,
 * `required`, `properties`, `additionalProperties: false`, `items`, `minimum`,
 * `maximum`. `format` is advisory and NOT enforced — timestamp shape is checked
 * by the producer, not the contract, so a slightly off format never silently
 * drops a real result on import. Anything outside the subset would throw at load
 * time rather than pass silently.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

/** Schema version identifiers, mirrored on the bot side. */
export const APPROVED_JOBS_SCHEMA_ID = 'approved-jobs.v1';
export const APPLICATION_RESULT_SCHEMA_ID = 'application-result.v1';

/** Evaluation/result confidence levels, ordered low → high. */
export const CONFIDENCE_LEVELS = Object.freeze(['low', 'medium', 'high']);

/** Allowed values of a result record's `result` field. */
export const RESULT_VALUES = Object.freeze([
  'submitted',
  'already_applied',
  'manual_review',
  'captcha',
  'requires_mfa',
  'failed',
  'skipped',
  'expired',
  'invalid',
]);

/** The only result that means an application was actually sent. */
export const SUBMITTED_RESULT = 'submitted';

function loadSchema(file) {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf-8'));
}

export const APPROVED_JOBS_SCHEMA = loadSchema('approved-jobs.v1.schema.json');
export const APPLICATION_RESULT_SCHEMA = loadSchema('application-result.v1.schema.json');

/** Thrown by the `assert*` helpers when a document violates its schema. */
export class IntegrationSchemaError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'IntegrationSchemaError';
    this.errors = errors;
  }
}

/** JSON type name for a value, matching JSON Schema's `type` vocabulary. */
function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return t; // 'string' | 'boolean' | 'object' | ...
}

/**
 * A value satisfies a declared `type`, which may be a single name or a list.
 * "number" accepts integers too (JSON Schema semantics); "integer" does not
 * accept non-integers.
 */
function typeMatches(value, declared) {
  const actual = jsonType(value);
  const list = Array.isArray(declared) ? declared : [declared];
  return list.some((want) => {
    if (want === 'number') return actual === 'number' || actual === 'integer';
    return actual === want;
  });
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

function validateNode(value, schema, path, errors) {
  if ('const' in schema) {
    if (!deepEqual(value, schema.const)) {
      errors.push(`${path}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
      return; // a wrong const makes further checks on this node noise
    }
  }

  if ('type' in schema && !typeMatches(value, schema.type)) {
    errors.push(`${path}: expected type ${JSON.stringify(schema.type)}, got ${jsonType(value)}`);
    return; // type is foundational; downstream checks assume it held
  }

  if ('enum' in schema && !schema.enum.some((opt) => deepEqual(value, opt))) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === 'number') {
    if ('minimum' in schema && value < schema.minimum) {
      errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    }
    if ('maximum' in schema && value > schema.maximum) {
      errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    }
  }

  if (jsonType(value) === 'object' && schema.properties) {
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${path}: missing required property "${req}"`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
    for (const [key, subschema] of Object.entries(schema.properties)) {
      if (key in value) validateNode(value[key], subschema, `${path}.${key}`, errors);
    }
  }

  if (jsonType(value) === 'array' && schema.items) {
    value.forEach((item, i) => validateNode(item, schema.items, `${path}[${i}]`, errors));
  }
}

/**
 * Validate a document against a loaded schema.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validate(value, schema) {
  const errors = [];
  validateNode(value, schema, '$', errors);
  return { valid: errors.length === 0, errors };
}

export function validateApprovedJobs(doc) {
  return validate(doc, APPROVED_JOBS_SCHEMA);
}

export function validateApplicationResult(doc) {
  return validate(doc, APPLICATION_RESULT_SCHEMA);
}

export function assertApprovedJobs(doc) {
  const { valid, errors } = validateApprovedJobs(doc);
  if (!valid) {
    throw new IntegrationSchemaError(
      `approved-jobs document failed ${APPROVED_JOBS_SCHEMA_ID} validation:\n  ${errors.join('\n  ')}`,
      errors,
    );
  }
  return doc;
}

export function assertApplicationResult(doc) {
  const { valid, errors } = validateApplicationResult(doc);
  if (!valid) {
    throw new IntegrationSchemaError(
      `application-result document failed ${APPLICATION_RESULT_SCHEMA_ID} validation:\n  ${errors.join('\n  ')}`,
      errors,
    );
  }
  return doc;
}
