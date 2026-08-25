/* The learning loop.
 *
 * A round is: look at an endpoint the agent knows least about, show the local
 * model that endpoint's real shape alongside what the manual says about it, ask
 * for invariants it thinks should hold, throw out the malformed ones, check the
 * rest against live data, confirm the survivors on a second independent sample,
 * and write down what held and what did not.
 *
 * The "learning" is the store: every round starts from what is already known and
 * already disproved, so the model stops re-proposing both. Nothing is fine-tuned
 * — the weights never move. What accumulates is verified knowledge.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlPlaneAgent } from './agent.js';
import { LocalModel } from './llm.js';
import {
  PROPOSAL_SCHEMA, PREDICATES, PREDICATE_NAMES,
  validateProposal, evaluate, keyOf, describe, at,
} from './invariants.js';
import { DOCUMENTED_ENUMS } from './manual-enums.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'knowledge');

/**
 * A closed-world claim needs a real sample behind it. Below this many applicable
 * rows, "the field only ever holds these values" is a statement about the page
 * that happened to be fetched, not about the API.
 */
const MIN_ROWS_TO_CLOSE_AN_ENUM = 25;

/**
 * Catch the loop overfitting to its own sample. A model shown four policies will
 * claim enforcement is one of three values; the manual documents eight. Reject
 * that rather than bank it, and hand back the reason so the next round sees it.
 */
function overfitting(candidate, applicable) {
  if (candidate.predicate !== 'enum_subset') return null;
  const documented = DOCUMENTED_ENUMS[`${candidate.endpoint}|${candidate.field}`];
  const proposed = candidate.args.values ?? [];

  if (documented) {
    const missing = documented.filter(v => !proposed.includes(v));
    if (missing.length) {
      return `overfit to the sample — the manual documents ${documented.length} values ` +
             `for this field and the proposal omits ${JSON.stringify(missing)}`;
    }
    return null;                       // matches the manual: a real invariant
  }
  if (applicable < MIN_ROWS_TO_CLOSE_AN_ENUM) {
    return `only ${applicable} rows — too few to claim a field can hold nothing else`;
  }
  return null;
}

/** Endpoints worth learning about, and the manual chapter that describes each. */
export const TARGETS = [
  { endpoint: '/agents',              chapter: 'Agent Registry' },
  { endpoint: '/runs',                chapter: 'Live Runs' },
  { endpoint: '/policies',            chapter: 'Policy Center' },
  { endpoint: '/guardrails',          chapter: 'Guardrails' },
  { endpoint: '/guardrails/events',   chapter: 'Guardrails' },
  { endpoint: '/connectors',          chapter: 'Connector & MCP Governance' },
  { endpoint: '/connections',         chapter: 'Hosting & Deployment' },
  { endpoint: '/alerts',              chapter: 'Alerts' },
  { endpoint: '/workspaces/api-keys', chapter: 'API Access Tokens' },
  { endpoint: '/workspaces/users',    chapter: 'Users' },
  { endpoint: '/quota',               chapter: 'Quota, Cost & Capacity' },
  { endpoint: '/approvals',           chapter: 'Approvals & Audit' },
  { endpoint: '/audit',               chapter: 'Approvals & Audit' },
  { endpoint: '/environments',        chapter: 'Environments & Releases' },
  { endpoint: '/deployments',         chapter: 'Environments & Releases' },
  { endpoint: '/evaluations',         chapter: 'Evaluations' },
  { endpoint: '/feedback',            chapter: 'Feedback & Quality Loop' },
  { endpoint: '/exports',             chapter: 'Exports' },
  { endpoint: '/testing/suites',      chapter: 'Testing & Regression Suite' },
];

/* ── the store ───────────────────────────────────────────────────────────── */

const EMPTY = { verified: [], rejected: [], coverage: {}, rounds: 0, updatedAt: null };

export async function loadStore() {
  const path = join(STORE, 'knowledge.json');
  if (!existsSync(path)) return { ...EMPTY };
  return { ...EMPTY, ...JSON.parse(await readFile(path, 'utf8')) };
}

export async function saveStore(store) {
  await mkdir(STORE, { recursive: true });
  store.updatedAt = new Date().toISOString();
  await writeFile(join(STORE, 'knowledge.json'), JSON.stringify(store, null, 2) + '\n');
}

/* ── the manual, cached locally ──────────────────────────────────────────── */

export async function manualText(origin) {
  const cached = join(STORE, 'manual.txt');
  if (existsSync(cached)) return readFile(cached, 'utf8');

  const html = await (await fetch(`${origin}/docs/`)).text();
  const text = html
    .replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<(h[1-4])[^>]*>/g, (_, h) => `\n\n${'#'.repeat(Number(h[1]))} `)
    .replace(/<\/(h[1-4])>/g, '\n')
    .replace(/<li[^>]*>/g, '\n- ').replace(/<\/p>/g, '\n')
    .replace(/<tr[^>]*>/g, '\n| ').replace(/<\/t[dh]>/g, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) =>
      ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' })[m])
    .replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');

  await mkdir(STORE, { recursive: true });
  await writeFile(cached, text);
  return text;
}

/** The slice of the manual that talks about one chapter. */
export function chapterOf(manual, chapter, limit = 2200) {
  const start = manual.search(new RegExp(`^#{2,4} .*${escapeRe(chapter)}`, 'im'));
  if (start === -1) return '';
  const rest = manual.slice(start + 1);
  const end = rest.search(/^#{2,3} /m);
  return (end === -1 ? rest : rest.slice(0, end)).slice(0, limit).trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ── describing live data to the model ───────────────────────────────────── */

/**
 * A compact picture of what an endpoint actually returns: every field, its type,
 * and a couple of real values. Far cheaper than pasting raw rows into an 8k
 * context, and it is what the model needs to propose a field-level invariant.
 */
export function shapeOf(items, { maxValues = 4 } = {}) {
  const fields = new Map();
  const walk = (object, prefix = '') => {
    for (const [key, value] of Object.entries(object ?? {})) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (prefix) continue;                      // one level of nesting is enough
        walk(value, path);
        continue;
      }
      const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      if (!fields.has(path)) fields.set(path, { types: new Set(), values: new Set(), nulls: 0 });
      const entry = fields.get(path);
      entry.types.add(type);
      if (value === null) entry.nulls++;
      else if (entry.values.size < maxValues) entry.values.add(JSON.stringify(value).slice(0, 40));
    }
  };
  items.forEach(item => walk(item));

  const lines = [...fields].map(([path, e]) => {
    const types = [...e.types].filter(t => t !== 'null').join('|') || 'null';
    const nullable = e.nulls > 0 ? `, null in ${e.nulls}/${items.length}` : '';
    return `  ${path}: ${types}${nullable}  e.g. ${[...e.values].slice(0, maxValues).join(', ')}`;
  });
  return { text: lines.join('\n'), fields: new Set(fields.keys()) };
}

/* ── the prompt ──────────────────────────────────────────────────────────── */

const SYSTEM = `You verify a governance API against its documentation.

You propose INVARIANTS: statements that must hold for every row an endpoint returns.
You never write code. You choose a field, a predicate from the fixed list, and its arguments.

Predicates and their arguments:
  always_present                          - the field exists on every row
  never_null                              - the field is never null
  type_is        {type}                   - "string" | "number" | "boolean" | "array"
  enum_subset    {values:[...]}           - the field only ever holds these values
  matches        {pattern}                - a JS regex the string field always matches
  bounded        {min,max}                - a number always inside this range
  non_negative                            - a number never below zero
  unique                                  - no two rows share this value
  iso_timestamp                           - the field parses as a date
  sum_equals     {addends:[f1,f2]}        - this field equals those fields added up
  lte_field      {other}                  - this field never exceeds that field
  ordered_desc                            - the collection is sorted by this field, largest first
  null_when_zero {when}                   - where {when} is 0, this field must be null
  present_when   {when,equals}            - where {when} equals that value, this field is present

Rules:
- Only use field paths that appear in the shape you are shown. Do not invent fields.
- Prefer invariants the documentation implies over ones the sample merely happens to satisfy.
- An invariant that is true only because the sample is small is a bad invariant.
- Never close an enum from a small sample. Only propose enum_subset when the documentation
  states the full set of values — and then list ALL of them, not just the ones in the sample.
- Do not repeat anything listed as already known or already disproved.
- Reply with JSON only.`;

function buildPrompt({ endpoint, chapter, docText, shape, known, rejected, count }) {
  const list = (rows, empty) => rows.length
    ? rows.map(r => `  - ${r}`).join('\n')
    : `  (${empty})`;

  return `Endpoint: GET ${endpoint}

What the operator manual says about ${chapter}:
"""
${docText || '(the manual has no section for this endpoint)'}
"""

The shape this endpoint actually returns, sampled live:
${shape.text}

Already verified — do not propose these again:
${list(known, 'nothing yet')}

Already disproved — do not propose these again:
${list(rejected, 'nothing yet')}

Propose ${count} NEW invariants for GET ${endpoint} that you believe hold for every row.
Favour ones the manual supports. For each, give the claim in a short sentence, the field
path, the predicate, its args, and one line of reasoning.`;
}

/* ── a round ─────────────────────────────────────────────────────────────── */

/**
 * Learn about one endpoint.
 * @returns {Promise<{endpoint, proposed, malformed, promoted, rejected, vacuous, known}>}
 */
export async function learnEndpoint(agent, model, store, target, { count = 6, log = () => {} } = {}) {
  const { endpoint, chapter } = target;

  const sample = await agent.raw.get(endpoint, { page_size: 100 }).catch(() => null);
  const items = sample?.items ?? [];
  if (items.length < 3) {
    log(`  ${endpoint}: only ${items.length} rows — too few to learn from`);
    store.coverage[endpoint] = { ...(store.coverage[endpoint] ?? {}), rounds: (store.coverage[endpoint]?.rounds ?? 0) + 1, rows: items.length };
    return { endpoint, proposed: 0, malformed: 0, promoted: [], rejected: [], vacuous: 0, known: 0 };
  }

  const shape = shapeOf(items);
  const manual = await manualText(agent.origin);
  const docText = chapterOf(manual, chapter);

  const forEndpoint = (rows) => rows.filter(r => r.endpoint === endpoint);
  const proposal = await model.json({
    system: SYSTEM,
    schema: PROPOSAL_SCHEMA,
    prompt: buildPrompt({
      endpoint, chapter, docText, shape, count,
      known: forEndpoint(store.verified).map(r => describe(r)),
      rejected: forEndpoint(store.rejected).map(r => `${describe(r)} — ${r.why}`),
    }),
  });

  const candidates = (proposal.invariants ?? []).map(inv => ({ ...inv, endpoint }));
  const result = { endpoint, proposed: candidates.length, malformed: 0, promoted: [], rejected: [], vacuous: 0, known: 0 };

  const seen = new Set([...store.verified, ...store.rejected].map(keyOf));

  for (const candidate of candidates) {
    candidate.args = candidate.args ?? {};

    if (seen.has(keyOf(candidate))) { result.known++; continue; }

    // 1. structural check — before anything touches the API
    const problem = validateProposal(candidate, shape.fields);
    if (problem) {
      result.malformed++;
      log(`  ✗ ${candidate.field} ${candidate.predicate} — ${problem}`);
      continue;
    }

    // 2. check against the sample we already have
    const first = evaluate(candidate, items);
    if (first.applicable === 0) {
      result.vacuous++;
      log(`  ○ ${describe(candidate)} — held over 0 applicable rows, proves nothing`);
      continue;
    }
    const overfit = overfitting(candidate, first.applicable);
    if (overfit) {
      const record = { ...candidate, why: overfit, disprovedAt: new Date().toISOString() };
      store.rejected.push(record);
      result.rejected.push(record);
      seen.add(keyOf(candidate));
      log(`  ✗ ${describe(candidate)} — ${overfit}`);
      continue;
    }

    if (!first.held) {
      const record = { ...candidate, why: `${first.violations}/${first.sampled} rows break it`,
                       counterexamples: first.counterexamples, disprovedAt: new Date().toISOString() };
      store.rejected.push(record);
      result.rejected.push(record);
      seen.add(keyOf(candidate));
      log(`  ✗ ${describe(candidate)} — ${record.why}`);
      continue;
    }

    // 3. confirm on a second, independent sample — a small page can be lucky
    const second = await agent.raw.get(endpoint, { page_size: 100, page: 2 }).catch(() => null);
    const confirmItems = second?.items?.length ? second.items : items;
    const confirm = evaluate(candidate, confirmItems);
    if (!confirm.held) {
      const record = { ...candidate, why: `held on page 1 but broke on page 2 (${confirm.violations} rows)`,
                       counterexamples: confirm.counterexamples, disprovedAt: new Date().toISOString() };
      store.rejected.push(record);
      result.rejected.push(record);
      seen.add(keyOf(candidate));
      log(`  ✗ ${describe(candidate)} — ${record.why}`);
      continue;
    }

    const record = {
      ...candidate,
      verifiedAt: new Date().toISOString(),
      evidence: { sampled: first.sampled + (confirmItems === items ? 0 : confirm.sampled),
                  applicable: first.applicable, pages: confirmItems === items ? 1 : 2 },
      confirmations: 1,
    };
    store.verified.push(record);
    result.promoted.push(record);
    seen.add(keyOf(candidate));
    log(`  ✓ ${describe(candidate)}  [${first.applicable} rows]`);
  }

  const prior = store.coverage[endpoint] ?? { rounds: 0 };
  store.coverage[endpoint] = {
    rounds: prior.rounds + 1,
    rows: items.length,
    verified: forEndpoint(store.verified).length,
    rejected: forEndpoint(store.rejected).length,
    lastSeen: new Date().toISOString(),
  };
  return result;
}

/**
 * Re-check everything already learned. A previously-verified invariant that now
 * fails is the most valuable signal the loop produces: the API changed.
 */
export async function regress(agent, store, { log = () => {} } = {}) {
  const byEndpoint = new Map();
  for (const inv of store.verified) {
    if (!byEndpoint.has(inv.endpoint)) byEndpoint.set(inv.endpoint, []);
    byEndpoint.get(inv.endpoint).push(inv);
  }

  const broken = [];
  for (const [endpoint, invariants] of byEndpoint) {
    const sample = await agent.raw.get(endpoint, { page_size: 100 }).catch(() => null);
    const items = sample?.items ?? [];
    if (items.length < 3) continue;
    for (const inv of invariants) {
      const result = evaluate(inv, items);
      if (result.held) { inv.confirmations = (inv.confirmations ?? 1) + 1; inv.lastConfirmedAt = new Date().toISOString(); continue; }
      inv.brokenAt = new Date().toISOString();
      inv.brokenBy = result.counterexamples;
      broken.push({ ...inv, violations: result.violations, sampled: result.sampled });
      log(`  ⚠ REGRESSION — ${describe(inv)} no longer holds (${result.violations}/${result.sampled} rows)`);
    }
  }
  store.verified = store.verified.filter(inv => !inv.brokenAt);
  store.rejected.push(...broken.map(inv => ({ ...inv, why: `regressed: ${inv.violations}/${inv.sampled} rows break it` })));
  return broken;
}

/** Pick the endpoint the agent knows least about. */
export function nextTarget(store, targets = TARGETS) {
  return [...targets].sort((a, b) =>
    (store.coverage[a.endpoint]?.rounds ?? 0) - (store.coverage[b.endpoint]?.rounds ?? 0))[0];
}

/** One full pass: regression-check what is known, then learn something new. */
export async function runRounds({ rounds = 3, count = 6, log = console.log } = {}) {
  const agent = new ControlPlaneAgent({ name: 'fulcrum-learner' });
  const model = new LocalModel();

  const ready = await model.available();
  if (!ready.ok) {
    throw new Error(`local model unavailable: ${ready.reason}\n` +
      `  start it with:  ollama serve\n` +
      `  and pull one:   ollama pull ${model.model}`);
  }

  await agent.connect();
  const store = await loadStore();
  log(`\n  model ${model.model} · workspace ${agent.session.workspace.slug} · ` +
      `${store.verified.length} invariants known, ${store.rejected.length} disproved\n`);

  log('  re-checking what is already known…');
  const broken = await regress(agent, store, { log });
  log(`  ${store.verified.length} still hold${broken.length ? `, ${broken.length} regressed` : ''}\n`);

  const summary = [];
  for (let round = 1; round <= rounds; round++) {
    const target = nextTarget(store);
    log(`  round ${round}/${rounds} — ${target.endpoint}  ‹${target.chapter}›`);
    const result = await learnEndpoint(agent, model, store, target, { count, log });
    summary.push(result);
    store.rounds++;
    await saveStore(store);
    log('');
  }

  await agent.disconnect();
  return { store, summary, broken, model: model.stats(), agent: agent.stats() };
}
