/* Helpers for the documented-behaviour pack.
 *
 * Every test in `documented.test.js` asserts a claim the operator manual makes,
 * and carries the chapter it came from so a failure says which sentence broke
 * rather than just which assertion did.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../../src/index.js';

// The manual's enums live in src/ so the learning loop can use them too.
export { DOC } from '../../src/manual-enums.js';

export const MANUAL = 'https://controlplane.fdprod.net/docs/';

/** A test named for its claim, tagged with the manual chapter behind it. */
export function spec(chapter, claim, fn, opts) {
  return test(`${claim}  ‹${chapter}›`, opts || {}, fn);
}

/**
 * Assert every observed value sits inside the set the manual documents.
 * Reports the offending values and the documented set — the useful pair when
 * the product and the manual have drifted apart.
 */
export function documentedEnum(observed, allowed, { field, chapter }) {
  const seen = [...new Set(observed.filter(v => v !== null && v !== undefined))];
  const known = KNOWN_DIVERGENCES[field] ?? {};
  const undocumented = seen.filter(v => !allowed.includes(v));
  const triaged = undocumented.filter(v => v in known);
  const fresh = undocumented.filter(v => !(v in known));

  // A divergence that has already been triaged is reported, not re-failed —
  // otherwise the pack cries wolf forever and stops being read. A value nobody
  // has looked at yet is still a hard failure.
  for (const value of triaged) {
    console.log(`      ⚠ ${field} = ${JSON.stringify(value)} — ${known[value]}`);
  }
  assert.deepEqual(fresh, [],
    `${field}: value(s) ${JSON.stringify(fresh)} are not in the set the manual documents ` +
    `(${allowed.join(', ')}) — see ‹${chapter}›. Observed: ${JSON.stringify(seen)}`);
  return seen;
}

/**
 * Divergences between the manual and the running product that have been looked
 * at and judged to be the manual's omission rather than a product fault. Each
 * is still printed on every run. Remove an entry when the manual is corrected —
 * the assertion above will then start failing again if the value comes back.
 *
 * Triaged 2026-08-25 against the manual as published.
 */
export const KNOWN_DIVERGENCES = {
  'connector.connector_type': {
    'Tool': 'the manual\'s Add Connector dialog lists "Custom Tool"; the stored value is "Tool"',
  },
  'connection.kind': {
    'Custom Agent': 'the manual lists six kinds and omits this one — it is the kind that makes ' +
                    'connection traffic attributable, so the omission matters',
  },
};

/** Run `fn`, expect an ApiError, hand it back. */
export async function capture(fn) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new assert.AssertionError({ message: 'expected the call to fail, but it succeeded' });
}

/** Skip with a reason rather than passing vacuously when there is no data. */
export function needs(t, condition, reason) {
  if (!condition) { t.skip(reason); return false; }
  return true;
}

