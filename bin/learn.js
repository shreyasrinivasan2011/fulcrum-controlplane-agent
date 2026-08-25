#!/usr/bin/env node
/* Run the learning loop.  node bin/learn.js [--rounds 3] [--count 6] */

import { runRounds } from '../src/learn.js';
import { describe } from '../src/invariants.js';

try { process.loadEnvFile('.env'); } catch { /* rely on the environment */ }

const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const { store, summary, broken, model, agent } = await runRounds({
  rounds: flag('rounds', 3),
  count: flag('count', 6),
});

const promoted = summary.flatMap(s => s.promoted);
const rejected = summary.flatMap(s => s.rejected);

console.log('  ── this pass ' + '─'.repeat(52));
console.log(`  proposed   ${summary.reduce((n, s) => n + s.proposed, 0)}`);
console.log(`  malformed  ${summary.reduce((n, s) => n + s.malformed, 0)}  (bad field or predicate, thrown out before running)`);
console.log(`  vacuous    ${summary.reduce((n, s) => n + s.vacuous, 0)}  (held over no applicable rows)`);
console.log(`  disproved  ${rejected.length}`);
console.log(`  learned    ${promoted.length}`);
if (broken.length) console.log(`  REGRESSED  ${broken.length}  ← the API changed under a previously verified invariant`);

if (promoted.length) {
  console.log('\n  new knowledge:');
  for (const inv of promoted) console.log(`    ✓ ${inv.endpoint} — ${describe(inv)}`);
}

console.log(`\n  store: ${store.verified.length} verified · ${store.rejected.length} disproved · ${store.rounds} rounds total`);
console.log(`  model: ${model.calls} calls, ${model.outputTokens} tokens at ~${model.avgTokensPerSecond} tok/s (${model.totalSeconds}s)`);
console.log(`  api:   ${agent.requests} requests, p95 ${agent.p95Ms}ms\n`);
