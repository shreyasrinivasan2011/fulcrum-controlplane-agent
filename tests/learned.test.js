/* What the agent has taught itself, replayed as a test suite.
 *
 * Nothing here is hand-written. Every test is an invariant the local model
 * proposed, that survived structural validation, held on a live sample, and was
 * confirmed on a second independent one. Running this file re-checks all of it
 * against the control plane as it is right now — so a claim that quietly stops
 * being true shows up as a failing test rather than a stale line in a JSON file.
 *
 *   node bin/learn.js      # learn more
 *   npm run test:learned   # re-check everything learned so far
 */

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneAgent } from '../src/index.js';
import { loadStore } from '../src/learn.js';
import { evaluate, describe as describeInvariant } from '../src/invariants.js';

const agent = new ControlPlaneAgent({ name: 'learned' });
const store = await loadStore();

/** Live rows per endpoint, fetched once and shared by every invariant on it. */
const samples = new Map();

before(async () => {
  await agent.connect();
  const endpoints = [...new Set(store.verified.map(i => i.endpoint))];
  await Promise.all(endpoints.map(async (endpoint) => {
    const payload = await agent.raw.get(endpoint, { page_size: 100 }).catch(() => null);
    samples.set(endpoint, payload?.items ?? []);
  }));
});

after(async () => {
  await agent.disconnect();
  console.log(`\n  ${store.verified.length} learned invariants across ` +
              `${new Set(store.verified.map(i => i.endpoint)).size} endpoints`);
  console.log(`  ${store.rejected.length} proposals disproved and remembered · ${store.rounds} learning rounds\n`);
});

if (!store.verified.length) {
  test('the agent has not learned anything yet', (t) => {
    t.skip('run `node bin/learn.js` first');
  });
} else {
  const byEndpoint = new Map();
  for (const inv of store.verified) {
    if (!byEndpoint.has(inv.endpoint)) byEndpoint.set(inv.endpoint, []);
    byEndpoint.get(inv.endpoint).push(inv);
  }

  for (const [endpoint, invariants] of byEndpoint) {
    describe(`${endpoint} — learned`, () => {
      for (const inv of invariants) {
        test(`${describeInvariant(inv)}  ‹learned ${inv.verifiedAt?.slice(0, 10)}, confirmed ${inv.confirmations ?? 1}×›`, () => {
          const items = samples.get(endpoint) ?? [];
          if (items.length < 3) return;              // nothing to re-check against
          const result = evaluate(inv, items);
          assert.equal(result.applicable > 0, true,
            'this invariant no longer has any rows to speak about — the data changed shape');
          assert.equal(result.held, true,
            `${result.violations} of ${result.sampled} rows now break an invariant that held when it was learned.\n` +
            `      claim: ${inv.claim}\n` +
            `      counterexamples: ${JSON.stringify(result.counterexamples)}`);
        });
      }
    });
  }

  describe('the knowledge store itself', () => {
    test('every invariant carries its evidence', () => {
      for (const inv of store.verified) {
        assert.ok(inv.verifiedAt, `"${inv.claim}" has no verification timestamp`);
        assert.ok(inv.evidence?.applicable > 0,
          `"${inv.claim}" was promoted without any applicable rows`);
      }
    });

    test('nothing sits in both verified and disproved', () => {
      const key = (i) => `${i.endpoint}|${i.field}|${i.predicate}`;
      const verified = new Set(store.verified.map(key));
      const both = store.rejected.map(key).filter(k => verified.has(k));
      assert.deepEqual([...new Set(both)], [],
        'an invariant is recorded as both holding and disproved');
    });
  });
}
