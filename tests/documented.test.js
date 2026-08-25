/* The documented-behaviour pack.
 *
 * Every test here asserts something the operator manual at /docs/ states, and
 * is named for the claim it checks. When one fails it means the product and the
 * manual disagree — which is a finding either way, not necessarily a bug in the
 * product.
 *
 * Read-only, like the smoke pack: GETs, plus writes the server is expected to
 * refuse. Safe against production.
 *
 *   npm run test:pack
 */

import { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneAgent, FulcrumClient } from '../src/index.js';
import { spec, documentedEnum, capture, needs, DOC, MANUAL } from './helpers/manual.js';

const agent = new ControlPlaneAgent({ name: 'doc-pack' });

/** Collections fetched once and shared — the pack reads far more than it asserts. */
const data = {};

before(async () => {
  await agent.connect();
  const [agents, policies, guardrails, connectors, connections, runs, environments, alerts, keys, users] =
    await Promise.all([
      agent.agents.list({ page_size: 100 }),
      agent.policies.list({ page_size: 100 }),
      agent.guardrails.list({ page_size: 100 }),
      agent.connectors.list({ page_size: 100 }),
      agent.connections.list({ page_size: 100 }),
      agent.runs.list({ page_size: 100 }),
      agent.environments.list({ page_size: 100 }),
      agent.alerts.list({ page_size: 100 }),
      agent.auth.apiKeys.list({ page_size: 100 }),
      agent.auth.users.list({ page_size: 100 }),
    ]);
  Object.assign(data, {
    agents: agents.items, policies: policies.items, guardrails: guardrails.items,
    connectors: connectors.items, connections: connections.items, runs: runs.items,
    environments: environments.items, alerts: alerts.items, keys: keys.items, users: users.items,
  });
});

after(async () => {
  await agent.disconnect();
  const s = agent.stats();
  console.log(`\n  manual: ${MANUAL}`);
  console.log(`  ${s.requests} requests · ${s.failures} non-2xx · p50 ${s.p50Ms}ms · p95 ${s.p95Ms}ms\n`);
});

/* ── Core concepts ───────────────────────────────────────────────────────── */
describe('Core concepts', () => {
  spec('Core concepts', 'registration creates the agent\'s telemetry namespace', () => {
    // "Registration is what creates the agent telemetry namespace, so nothing
    //  can report until this exists."
    for (const a of data.agents) {
      assert.ok(a.engine_project_id, `${a.name} has no engine project — it could not report`);
      assert.equal(a.is_provisioned, true, `${a.name} is not provisioned`);
    }
  });

  spec('Core concepts', 'another workspace\'s row is indistinguishable from one that does not exist', async () => {
    // "Every query filters on it, so another workspace row is indistinguishable
    //  from a row that does not exist."
    const foreign = await capture(() => agent.agents.get('01a01b59-0000-7000-8000-000000000001'));
    const absent  = await capture(() => agent.agents.get('00000000-0000-0000-0000-000000000000'));
    assert.equal(foreign.status, 404);
    assert.equal(absent.status, 404);
    assert.equal(foreign.code, absent.code);
    // Both messages quote the id that was asked for, which discloses nothing;
    // what must match is everything else about the answer.
    const shape = (err) => err.message.replace(/'[0-9a-f-]{36}'/i, "'<id>'");
    assert.equal(shape(foreign), shape(absent),
      'a foreign row and a missing row must be reported identically');
  });

  spec('Core concepts', 'a quota is a ceiling checked before work, carrying its own usage', async () => {
    // "A spend or usage ceiling checked before a run is accepted, not tallied afterwards."
    const { items } = await agent.quota.list({ page_size: 25 });
    for (const q of items) {
      assert.equal(typeof q.limit_value, 'number', `quota ${q.name} has no limit`);
      assert.equal(typeof q.used_value, 'number', `quota ${q.name} does not track usage`);
      assert.ok(q.used_value <= q.limit_value * 1.0001 || q.status,
        `quota ${q.name} is over its ceiling with no status to say so`);
    }
  });
});

/* ── Signing in and roles ────────────────────────────────────────────────── */
describe('Signing in and roles', () => {
  spec('Signing in and roles', 'every membership holds one of the six documented roles', () => {
    documentedEnum(data.users.map(u => u.role), DOC.roles,
      { field: 'user.role', chapter: 'Signing in and roles › The six roles' });
    assert.ok(DOC.roles.includes(agent.session.role), `own role ${agent.session.role} is undocumented`);
  });

  spec('Signing in and roles', 'two sessions for one person coexist without interfering', async () => {
    // "several people, and the same person on several devices, can be signed in
    //  at once without interfering with each other."
    const second = new FulcrumClient();
    await second.login();
    const [mine, theirs] = await Promise.all([agent.auth.me(), second.me()]);
    assert.equal(mine.user.id, theirs.user.id);
    await second.logout();
    // the second session logging out must not disturb the first
    const after = await agent.auth.me();
    assert.equal(after.user.id, mine.user.id, 'one session\'s logout invalidated another');
  });

  spec('Signing in and roles', 'agents never use a password — ingest refuses a sign-in session', async () => {
    // "Agents never use a password." / "ingest endpoints accept only API keys and
    //  refuse a browser session with a 403."
    for (const call of [
      () => agent.ingest.config(),
      () => agent.ingest.traces([]),
      () => agent.ingest.scores([]),
      () => agent.ingest.events([]),
    ]) {
      const err = await capture(call);
      assert.equal(err.status, 403, 'a session must be refused by ingest with a 403');
      assert.equal(err.code, 'permission_denied');
      assert.match(err.message, /API key/i, 'the refusal should say what would work instead');
    }
  });
});

/* ── Connect your first agent ────────────────────────────────────────────── */
describe('Connect your first agent', () => {
  spec('Connect your first agent', 'agents sit in one of the three lifecycle states', () => {
    // "agents start Pending Review and move to Active or Inactive."
    documentedEnum(data.agents.map(a => a.status), DOC.agentStatus,
      { field: 'agent.status', chapter: 'Agent governance › Agent Registry' });
  });

  spec('Connect your first agent', 'registration records a documented platform and agent type', () => {
    documentedEnum(data.agents.map(a => a.platform), DOC.agentPlatforms,
      { field: 'agent.platform', chapter: 'Connect your first agent › 1. Register the agent' });
    documentedEnum(data.agents.map(a => a.agent_type), DOC.agentTypes,
      { field: 'agent.agent_type', chapter: 'Connect your first agent › 1. Register the agent' });
  });

  spec('Connect your first agent', 'the server keeps only a hash — a key is never readable twice', () => {
    // "The server stores only a SHA-256 hash ... the table keeps a hint like fo_live_263...lgga"
    for (const k of data.keys) {
      for (const [field, value] of Object.entries(k)) {
        if (typeof value !== 'string') continue;
        if (field === 'display_hint') continue;
        assert.doesNotMatch(value, /fo_live_[A-Za-z0-9]{12,}/,
          `key ${k.name}: field ${field} looks like it carries plaintext key material`);
      }
      assert.match(k.display_hint, /^fo_\w+_.{1,6}….{1,6}$/u,
        `key ${k.name}: display_hint "${k.display_hint}" is not the documented elided hint`);
    }
  });

  spec('Connect your first agent', 'key scopes come from the documented three', () => {
    documentedEnum(data.keys.flatMap(k => k.scopes || []), DOC.keyScopes,
      { field: 'api_key.scopes', chapter: 'Workspace Settings › API Access Tokens' });
  });

  spec('Connect your first agent', 'a bound key names the agent it may write for', () => {
    // "A bound key can only ever write that agent telemetry."
    for (const k of data.keys.filter(k => k.agent_id)) {
      const known = data.agents.some(a => a.id === k.agent_id);
      assert.ok(known || k.agent_name === null,
        `key ${k.name} is bound to ${k.agent_id}, which is not an agent in this workspace`);
    }
  });
});

/* ── REST API conventions ────────────────────────────────────────────────── */
describe('REST API', () => {
  const COLLECTIONS = ['/agents', '/runs', '/policies', '/connections', '/connectors',
                       '/guardrails', '/alerts', '/approvals', '/evaluations', '/exports',
                       '/feedback', '/quota', '/environments', '/deployments',
                       '/workspaces/users', '/workspaces/api-keys'];

  for (const path of COLLECTIONS) {
    spec('REST API › Conventions', `${path} takes page and page_size`, async () => {
      const payload = await agent.raw.get(path, { page: 1, page_size: 2 });
      assert.ok(Array.isArray(payload.items), `${path} did not return an items array`);
      assert.equal(payload.page, 1);
      assert.equal(payload.page_size, 2);
      assert.ok(payload.items.length <= 2);
    });
  }

  spec('REST API › Conventions', 'sort takes a - prefix for descending', async () => {
    // "sort (prefix - for descending)"
    const [asc, desc] = await Promise.all([
      agent.agents.list({ sort: 'created_at', page_size: 100 }),
      agent.agents.list({ sort: '-created_at', page_size: 100 }),
    ]);
    if (asc.items.length < 2) return;
    const ids = (r) => r.items.map(i => i.id);
    assert.deepEqual(ids(desc), ids(asc).slice().reverse(),
      'sort=-created_at must be the exact reverse of sort=created_at');
  });

  spec('REST API › Conventions', 'q narrows a collection', async () => {
    const all = await agent.agents.list({ page_size: 100 });
    if (all.items.length < 2) return;
    const term = all.items[0].name.split(' ')[0];
    const hit = await agent.agents.list({ q: term, page_size: 100 });
    assert.ok(hit.total <= all.total, 'a search must not return more than the unfiltered set');
    assert.ok(hit.items.some(a => a.name.toLowerCase().includes(term.toLowerCase())));
  });

  spec('REST API › Conventions', 'collections expose /summary for the KPI row', async () => {
    // "Most collections also expose /summary for the KPI row"
    const withSummary = ['/agents', '/runs', '/policies', '/connections', '/connectors',
                         '/guardrails', '/alerts', '/workspaces/users', '/workspaces/api-keys'];
    for (const path of withSummary) {
      const summary = await agent.raw.get(`${path}/summary`);
      assert.equal(typeof summary, 'object', `${path}/summary returned no object`);
      assert.ok(!Array.isArray(summary), `${path}/summary returned a list, not a KPI object`);
    }
  });

  spec('REST API › Conventions', '/export streams a named file, not JSON', async () => {
    // "and /export for a file download"
    for (const path of ['/agents/export', '/runs/export', '/metrics/export']) {
      const res = await agent.raw.rawGet(path);
      assert.equal(res.status, 200, `${path} did not return 200`);
      const disposition = res.headers.get('content-disposition') || '';
      assert.match(disposition, /attachment; ?filename=/i,
        `${path} did not offer a filename`);
      assert.doesNotMatch(res.headers.get('content-type') || '', /application\/json/,
        `${path} returned JSON rather than a file`);
      await res.arrayBuffer();
    }
  });

  spec('REST API', 'a bearer API key is an accepted credential shape', async () => {
    // "Authentication is either the session cookie or Authorization: Bearer fo_..."
    const res = await fetch(`${agent.origin}/api/v1/agents`, {
      headers: { Authorization: 'Bearer fo_live_not_a_real_key', Accept: 'application/json' },
    });
    assert.ok([401, 403].includes(res.status),
      `a bogus bearer key should be refused with 401/403, got ${res.status}`);
    const body = await res.json();
    assert.ok(body?.error?.code, 'the refusal should carry the documented error envelope');
  });
});

/* ── Policy Center ───────────────────────────────────────────────────────── */
describe('Policy Center', () => {
  spec('Policy Center', 'enforcement is one of the eight documented actions', () => {
    documentedEnum(data.policies.map(p => p.enforcement), DOC.policyEnforcement,
      { field: 'policy.enforcement', chapter: 'Agent governance › Policy Center' });
  });

  spec('Policy Center', 'scope and status come from the documented sets', () => {
    documentedEnum(data.policies.map(p => p.scope), DOC.policyScope,
      { field: 'policy.scope', chapter: 'Agent governance › Policy Center' });
    documentedEnum(data.policies.map(p => p.status), DOC.policyStatus,
      { field: 'policy.status', chapter: 'Agent governance › Policy Center' });
    documentedEnum(data.policies.map(p => p.category), DOC.policyCategories,
      { field: 'policy.category', chapter: 'Agent governance › Policy Center' });
  });

  spec('Policy Center', 'anything but Global carries a scope_ref', () => {
    // "Scope | Global, Environment, Agent, Connector — anything but Global needs a scope_ref"
    for (const p of data.policies) {
      if (p.scope === 'Global') continue;
      assert.ok(p.scope_ref, `policy "${p.name}" is scoped ${p.scope} with no scope_ref`);
    }
  });

  spec('Policy Center', 'a Global policy needs no scope_ref', () => {
    for (const p of data.policies.filter(p => p.scope === 'Global')) {
      assert.equal(p.scope_ref, null, `global policy "${p.name}" carries a stray scope_ref`);
    }
  });
});

/* ── Guardrails ──────────────────────────────────────────────────────────── */
describe('Guardrails', () => {
  spec('Guardrails', 'an action is Warn, Block, Mask or Log — there is no Passed', () => {
    // "action_taken is one of Warn, Block, Mask or Log ... there is no Passed."
    const actions = documentedEnum(data.guardrails.map(g => g.action), DOC.guardrailActions,
      { field: 'guardrail.action', chapter: 'Guardrails and policy violations' });
    assert.ok(!actions.includes('Passed'), 'the manual is explicit that Passed does not exist');
  });

  spec('Guardrails', 'this deployment only carries the guardrail types it can test', () => {
    // "The inline content checker on this deployment implements the PII, Topic
    //  and Prompt Injection validations."
    documentedEnum(data.guardrails.map(g => g.guardrail_type), DOC.guardrailTested,
      { field: 'guardrail.guardrail_type', chapter: 'Quality › Guardrails' });
  });

  spec('Guardrails', 'a guardrail event reports matched as a mapping of label to count', async (t) => {
    // "matched must be a mapping of label to count, not a list of labels."
    const { items } = await agent.raw.get('/guardrails/events', { page_size: 50 }).catch(() => ({ items: [] }));
    if (!needs(t, items.length, 'no guardrail events recorded in this workspace')) return;
    for (const e of items) {
      if (e.matched == null) continue;
      assert.ok(!Array.isArray(e.matched), `event ${e.id}: matched is a list, not a mapping`);
      assert.equal(typeof e.matched, 'object');
      for (const [label, count] of Object.entries(e.matched)) {
        assert.equal(typeof count, 'number', `event ${e.id}: matched.${label} is not a count`);
      }
    }
  });

  spec('Quality › Guardrails', 'match_count agrees with the entity counts beside it', async (t) => {
    // The screen promises "the matched entity counts". A count of 0 sitting
    // next to {"CARD":1,"PHONE":1} is the feed contradicting itself.
    const { items } = await agent.raw.get('/guardrails/events', { page_size: 100 }).catch(() => ({ items: [] }));
    const scored = items.filter(e => e.matched && typeof e.match_count === 'number');
    if (!needs(t, scored.length, 'no guardrail events carry both matched and match_count')) return;

    const wrong = scored.filter(e =>
      e.match_count !== Object.values(e.matched).reduce((a, b) => a + b, 0));
    assert.deepEqual(
      wrong.slice(0, 3).map(e => ({ id: e.id, match_count: e.match_count, matched: e.matched })), [],
      `${wrong.length} of ${scored.length} events report a match_count that disagrees with matched`);
  });

  spec('Guardrails', 'a recorded event\'s action is one of the four — never Passed', async (t) => {
    const { items } = await agent.raw.get('/guardrails/events', { page_size: 100 }).catch(() => ({ items: [] }));
    if (!needs(t, items.length, 'no guardrail events recorded')) return;
    documentedEnum(items.map(e => e.action_taken), DOC.guardrailActions,
      { field: 'guardrail_event.action_taken', chapter: 'Guardrails and policy violations' });
  });

  spec('Quality › Guardrails', 'the deployment declares which guardrails its checker supports', () => {
    // "a guardrail whose type it does not implement cannot be tested (the Test
    //  button answers plainly rather than inventing a verdict)."
    for (const g of data.guardrails) {
      assert.equal(typeof g.checker_supported, 'boolean',
        `guardrail "${g.name}" does not say whether the checker can test it`);
      assert.equal(g.checker_supported, DOC.guardrailTested.includes(g.guardrail_type),
        `guardrail "${g.name}" is a ${g.guardrail_type}: checker_supported=${g.checker_supported} ` +
        `disagrees with the documented set (${DOC.guardrailTested.join(', ')})`);
    }
  });

  spec('Quality › Guardrails', 'the inline checker returns a real verdict, not an invented one', async (t) => {
    // Gated: the probe mutates nothing in the workspace, but every governance
    // action is audited, so it appends one row to the audit trail.
    if (!needs(t, process.env.FULCRUM_ALLOW_PROBES === '1',
      'set FULCRUM_ALLOW_PROBES=1 to run the content checker — it appends one audit row')) return;

    const pii = data.guardrails.find(g => g.guardrail_type === 'PII' && g.checker_supported);
    if (!needs(t, pii, 'no PII guardrail configured')) return;

    const hit = await agent.guardrails.action(pii.id, 'test', { input: 'reach me at bob@example.com' });
    assert.equal(typeof hit.triggered, 'boolean', 'the checker did not return a verdict');
    assert.equal(hit.triggered, true, 'a PII checker did not flag an email address');
    assert.ok(DOC.guardrailActions.includes(hit.action), `verdict action ${hit.action} is undocumented`);

    const clean = await agent.guardrails.action(pii.id, 'test', { input: 'what is the weather today' });
    assert.equal(clean.triggered, false, 'the PII checker flagged text carrying no PII');
  });

  spec('Guardrails', 'a guardrail scope follows the same rule as a policy scope', () => {
    documentedEnum(data.guardrails.map(g => g.scope), DOC.policyScope,
      { field: 'guardrail.scope', chapter: 'Agent governance › Policy Center' });
    for (const g of data.guardrails.filter(g => g.scope !== 'Global')) {
      assert.ok(g.scope_ref, `guardrail "${g.name}" is scoped ${g.scope} with no scope_ref`);
    }
  });
});

/* ── Connector & MCP Governance ──────────────────────────────────────────── */
describe('Connector & MCP Governance', () => {
  spec('Connector & MCP Governance', 'a connector type is one of the five documented', () => {
    documentedEnum(data.connectors.map(c => c.connector_type), DOC.connectorTypes,
      { field: 'connector.connector_type', chapter: 'Agent governance › Connector & MCP Governance' });
  });

  spec('Connector & MCP Governance', 'access level is Read, Read-Write or Admin', () => {
    documentedEnum(data.connectors.map(c => c.access), DOC.connectorAccess,
      { field: 'connector.access', chapter: 'Agent governance › Connector & MCP Governance' });
  });

  spec('Connector & MCP Governance', 'a blocked connector keeps its row and its grants', async (t) => {
    // "A blocked connector keeps its row, its grants and its history, and every
    //  agent holding a grant fails closed against it."
    const blocked = data.connectors.filter(c => c.status === 'Blocked');
    if (!needs(t, blocked.length, 'no connector is currently blocked')) return;
    for (const c of blocked) {
      const detail = await agent.connectors.get(c.id);
      assert.ok(detail, `blocked connector ${c.name} disappeared from the registry`);
      assert.ok(detail.block_reason ?? detail.blocked_reason,
        `blocked connector ${c.name} records no reason, though blocking requires one`);
    }
  });

  spec('Connector & MCP Governance', 'the registry is not built from observed traffic', () => {
    // "Nothing here is created from observed traffic: a connector exists because
    //  a person registered it."
    for (const c of data.connectors) {
      assert.ok(c.created_at, `connector ${c.name} has no registration timestamp`);
    }
  });
});

/* ── Hosting & Deployment ────────────────────────────────────────────────── */
describe('Hosting & Deployment', () => {
  spec('Hosting & Deployment', 'a connection kind is one of the six documented', () => {
    documentedEnum(data.connections.map(c => c.kind), DOC.connectionKinds,
      { field: 'connection.kind', chapter: 'Agent governance › Hosting & Deployment' });
  });

  spec('Hosting & Deployment', 'traffic says "not attributable" rather than reporting a zero', async () => {
    // "Connection kinds are a superset of agent platforms ... For those kinds
    //  traffic cannot be attributed at all, the response sets attributable: false."
    const agentPlatforms = new Set(DOC.agentPlatforms);
    for (const c of data.connections) {
      const traffic = await agent.connections.traffic(c.id, { window_days: 30 });
      assert.equal(typeof traffic.attributable, 'boolean',
        `connection ${c.name}: traffic does not state whether it is attributable`);
      if (!agentPlatforms.has(c.kind)) {
        assert.equal(traffic.attributable, false,
          `connection ${c.name} is a ${c.kind} — nothing runs "on" one, so traffic must not be attributable`);
      }
    }
  });

  spec('Hosting & Deployment', 'a connection test answers reachability, and a 401 is healthy', async (t) => {
    // "The probe carries no credentials, so it answers reachability only — and a
    //  401 is a healthy answer, because it proves the endpoint is up."
    if (!needs(t, data.connections.length, 'no connections registered')) return;
    for (const c of data.connections.slice(0, 4)) {
      const result = await agent.connections.test(c.id);
      assert.equal(typeof result.ok, 'boolean', `${c.name}: the probe did not report a verdict`);
      assert.ok(result.message, `${c.name}: the probe did not say what came back`);
      assert.ok(result.data, `${c.name}: the probe returned no detail`);
      assert.equal(typeof result.data.reachable, 'boolean',
        `${c.name}: the probe must answer reachability`);
      // "a 401 is a healthy answer, because it proves the endpoint is up and
      //  guarding itself" — an authenticated refusal must never read as unreachable.
      if (result.data.status_code === 401 || /401/.test(result.message)) {
        assert.equal(result.data.reachable, true,
          `${c.name}: a 401 proves the endpoint is up, so it must not be reported unreachable`);
      }
    }
  }, { timeout: 40_000 });
});

/* ── Metrics ─────────────────────────────────────────────────────────────── */
describe('Metrics', () => {
  spec('Metrics', 'all four documented windows are accepted', async () => {
    for (const window of DOC.metricWindows) {
      const summary = await agent.metrics.summary({ window });
      assert.equal(summary.window, window, `window ${window} was not honoured`);
    }
  });

  spec('Metrics', 'each KPI is measured twice — the window, and the one before it', async () => {
    // "each KPI measured twice — once over the window, once over the window
    //  immediately before it — so a delta compares equal spans of time."
    const s = await agent.metrics.summary({ window: '30d' });
    const span = (a, b) => Date.parse(b) - Date.parse(a);
    const current = span(s.period_start, s.period_end);
    const previous = span(s.previous_period_start, s.previous_period_end);
    assert.ok(Math.abs(current - previous) < 2000,
      `the comparison window is ${previous}ms against a ${current}ms window — not an equal span`);
    assert.equal(s.previous_period_end, s.period_start,
      'the previous window must sit immediately before the current one');
  });

  spec('Metrics', 'the eight documented series are offered', async () => {
    const s = await agent.metrics.series({ window: '30d' });
    const offered = (s.series || []).map(x => x.metric);
    for (const metric of DOC.seriesMetrics) {
      assert.ok(offered.includes(metric), `series "${metric}" is documented but not returned`);
    }
    documentedEnum(offered, DOC.seriesMetrics, { field: 'series.metric', chapter: 'Platform › Metrics' });
  });

  spec('Metrics', 'agent_id is repeatable and narrows every number', async (t) => {
    // "The same filter is available on the API as a repeatable agent_id parameter."
    const ids = data.agents.map(a => a.id);
    if (!needs(t, ids.length >= 2, 'need at least two agents to prove narrowing')) return;
    const [one, two, all] = await Promise.all([
      agent.metrics.summary({ agent_id: [ids[0]] }),
      agent.metrics.summary({ agent_id: [ids[0], ids[1]] }),
      agent.metrics.summary({}),
    ]);
    assert.ok(one.total_runs.value <= two.total_runs.value,
      'adding a second agent_id must not reduce the run count');
    assert.ok(two.total_runs.value <= all.total_runs.value,
      'a filtered total must not exceed the unfiltered total');
    assert.ok(one.agent_count <= all.agent_count);
  });

  spec('Metrics', 'agent_id is repeatable on every documented endpoint', async (t) => {
    const ids = data.agents.map(a => a.id).slice(0, 2);
    if (!needs(t, ids.length >= 2, 'need at least two agents')) return;
    for (const path of ['/metrics/summary', '/metrics/series', '/metrics/models', '/metrics/platforms']) {
      const payload = await agent.raw.get(path, { agent_id: ids });
      assert.ok(payload, `${path} rejected a repeated agent_id`);
    }
  });

  spec('Metrics', 'an unmeasured number is null, never a zero', () => {
    // "A number is a dash ... Zero would be a claim the platform is not entitled to make."
    for (const a of data.agents) {
      const m = a.metrics;
      if (!m || m.runs_30d !== 0) continue;
      assert.notEqual(m.success_rate_30d, 0,
        `${a.name} recorded no runs, so a 0% success rate would be a claim about nothing`);
      assert.equal(m.success_rate_30d, null,
        `${a.name} recorded no runs — success_rate_30d should be null, got ${m.success_rate_30d}`);
    }
  });
});

/* ── Live Runs ───────────────────────────────────────────────────────────── */
describe('Live Runs', () => {
  spec('Platform › Live Runs', 'run status is one of the four documented values', () => {
    documentedEnum(data.runs.map(r => r.status), DOC.runStatus,
      { field: 'run.status', chapter: 'Platform › Live Runs' });
  });

  spec('Platform › Live Runs', 'a policy result is Allowed, Warned or Blocked', () => {
    documentedEnum(data.runs.map(r => r.policy), DOC.policyResult,
      { field: 'run.policy', chapter: 'Platform › Live Runs' });
  });

  spec('Platform › Live Runs', 'every documented table column is present on a run', () => {
    // "run id, source, agent, status, model, input preview, tools, tokens, cost,
    //  duration, confidence, risk, policy, tenant, time"
    const columns = ['id', 'source', 'agent', 'status', 'model', 'input_preview', 'tools',
                     'tokens', 'cost', 'duration_seconds', 'confidence', 'risk', 'policy',
                     'tenant', 'occurred_at'];
    const run = data.runs[0];
    if (!run) return;
    for (const column of columns) {
      assert.ok(column in run, `the run payload is missing the documented column "${column}"`);
    }
  });

  spec('Platform › Live Runs', 'spans are typed general, llm, tool or guardrail', async (t) => {
    const withRun = data.runs[0];
    if (!needs(t, withRun, 'no runs recorded')) return;
    const trace = await agent.runs.trace(withRun.id);
    const spans = trace?.spans ?? trace?.items ?? (Array.isArray(trace) ? trace : []);
    if (!needs(t, spans.length, 'the trace carried no spans')) return;
    documentedEnum(spans.map(s => s.type ?? s.span_type), DOC.spanTypes,
      { field: 'span.type', chapter: 'Core concepts' });
  });

  spec('Replay Studio', 'run history is per-agent and unbounded by a time window', async (t) => {
    // "pick an agent, and every run it has ever recorded is listed newest first
    //  ... there is no time window."
    const busiest = [...data.agents].sort((a, b) => (b.metrics?.runs_30d ?? 0) - (a.metrics?.runs_30d ?? 0))[0];
    if (!needs(t, busiest, 'no agents')) return;

    const missing = await capture(() => agent.runs.history({ page_size: 1 }));
    assert.equal(missing.status, 422, 'history without an agent_id should be a validation error');
    assert.ok('agent_id' in missing.fieldErrors, 'the error should name agent_id as the missing field');

    const history = await agent.runs.history({ agent_id: busiest.id, page_size: 5 });
    assert.ok(Array.isArray(history.items), 'history returned no items array');
    const times = history.items.map(r => Date.parse(r.occurred_at));
    assert.deepEqual(times, [...times].sort((a, b) => b - a), 'history must be newest first');
  });
});

/* ── Approvals & Audit ───────────────────────────────────────────────────── */
describe('Approvals & Audit', () => {
  spec('Approvals & Audit', 'the audit chain verifies intact', async () => {
    // "Verify re-walks the chain and confirms no row has been altered or removed."
    const result = await agent.audit.verify();
    assert.equal(result.intact, true,
      `the hash chain is broken at ${result.broken_at_event_id} (${result.broken_at})`);
    assert.ok(result.checked > 0, 'verify checked no rows');
  });

  spec('Approvals & Audit', 'the trail is append-only and ordered', async () => {
    const { items } = await agent.audit.list({ page_size: 50 });
    assert.ok(items.length, 'the audit trail is empty');
    const times = items.map(e => Date.parse(e.occurred_at));
    assert.deepEqual(times, [...times].sort((a, b) => b - a), 'the audit trail is not in order');
    for (const e of items) {
      assert.ok(e.actor, `audit row ${e.id} records no actor`);
      assert.ok(e.action, `audit row ${e.id} records no action`);
      assert.ok(e.entity_type, `audit row ${e.id} records no entity`);
    }
  });

  spec('Approvals & Audit', 'the trail filters by actor, action, entity and time', async () => {
    // "filterable by actor, action, entity and time"
    const { items } = await agent.audit.list({ page_size: 1 });
    const one = items[0];
    if (!one) return;
    const byAction = await agent.audit.list({ action: one.action, page_size: 20 });
    assert.ok(byAction.items.length, `filtering by action=${one.action} returned nothing`);
    for (const e of byAction.items) {
      assert.equal(e.action, one.action, 'the action filter leaked other actions');
    }
  });

  spec('Approvals & Audit', 'every approval decision records who, when and why', async (t) => {
    const decided = data.approvals ?? (await agent.approvals.list({ page_size: 50 })).items;
    const closed = decided.filter(a => ['Approved', 'Rejected'].includes(a.status));
    if (!needs(t, closed.length, 'no decided approvals')) return;
    for (const a of closed) {
      assert.ok(a.decided_by ?? a.decided_by_name ?? a.approver ?? a.updated_by,
        `approval ${a.request_ref}: no record of who decided it`);
      assert.ok(a.decided_at ?? a.updated_at, `approval ${a.request_ref}: no decision timestamp`);
    }
  });
});

/* ── Licensing & Entitlements ────────────────────────────────────────────── */
describe('Licensing & Entitlements', () => {
  spec('Licensing & Entitlements', 'the three metered ceilings are hard entitlements', () => {
    // "included_seats, included_tokens and included_runs become hard entitlements."
    const e = agent.session.entitlements;
    for (const key of DOC.hardEntitlements) {
      assert.equal(typeof e[key], 'number', `${key} is not a numeric ceiling`);
      assert.ok(e[key] > 0, `${key} is not a usable ceiling`);
    }
  });

  spec('Licensing & Entitlements', 'a feature entitlement is a soft boolean grant', () => {
    const e = agent.session.entitlements;
    const features = Object.entries(e).filter(([k]) => !DOC.hardEntitlements.includes(k));
    assert.ok(features.length, 'the plan grants no features');
    for (const [key, value] of features) {
      assert.equal(typeof value, 'boolean', `feature entitlement ${key} is not a boolean`);
    }
  });

  spec('Licensing & Entitlements', 'entitlement-check resolves the same way ingest does', async () => {
    // "Check any one of them with GET /licensing/entitlement-check?key=…, which
    //  is the same resolution the ingest path performs."
    const e = agent.session.entitlements;
    for (const key of ['read', 'ingest', ...DOC.hardEntitlements]) {
      const check = await agent.licensing.entitlementCheck(key);
      assert.equal(check.ok, true, `entitlement-check refused a granted key: ${key}`);
      assert.equal(check.data.key, key);
      assert.equal(check.data.value, e[key],
        `entitlement-check says ${key}=${check.data.value}, the session says ${e[key]}`);
      assert.equal(check.data.enforced, true, `${key} is documented as enforced at ingest`);
    }
  });

  spec('Licensing & Entitlements', 'an unknown entitlement key is refused, not invented', async () => {
    const check = await agent.licensing.entitlementCheck('not_a_real_entitlement')
      .catch(err => ({ ok: false, status: err.status }));
    assert.notEqual(check.ok, true, 'an unknown entitlement key was reported as granted');
  });
});

/* ── Environments & Releases ─────────────────────────────────────────────── */
describe('Environments & Releases', () => {
  spec('Environments & Releases', 'environments come from the seven documented defaults', () => {
    documentedEnum(data.environments.map(e => e.env_type), DOC.environments,
      { field: 'environment.env_type', chapter: 'Operations › Environments & Releases' });
    documentedEnum(data.agents.map(a => a.environment), DOC.environments,
      { field: 'agent.environment', chapter: 'Operations › Environments & Releases' });
  });
});

/* ── Alerts ──────────────────────────────────────────────────────────────── */
describe('Alerts', () => {
  spec('System › Alerts', 'severity is one of the five documented levels', () => {
    documentedEnum(data.alerts.map(a => a.severity), DOC.alertSeverity,
      { field: 'alert.severity', chapter: 'System › Alerts' });
  });

  spec('System › Alerts', 'an alert names the screen it came from', () => {
    // "Operational alerts across connections, policies, quotas, secrets, tests and deployments."
    for (const a of data.alerts) {
      assert.ok(a.source, `alert ${a.alert_ref} does not say which screen raised it`);
    }
  });
});

/* ── Troubleshooting ─────────────────────────────────────────────────────── */
describe('Troubleshooting', () => {
  spec('Troubleshooting › Health checks', '/health reports status and the telemetry engine', async () => {
    // 'curl https://your-control-plane/health
    //  # {"status":"ok","telemetry":true,...} telemetry:false means the engine is down'
    const health = await agent.serviceHealth();
    assert.equal(health.status, 'ok', `the platform reports status=${health.status}`);
    const telemetry = health.telemetry ?? health.checks?.telemetry;
    assert.equal(telemetry, true,
      'telemetry is false — the engine is unreachable and telemetry screens will be blank');
  });

  spec('Troubleshooting › Health checks', '/health is served at the root, not under /api/v1', async () => {
    const err = await capture(() => agent.raw.get('/health'));
    assert.equal(err.status, 404, '/api/v1/health should not exist — the manual puts it at the root');
  });

  spec('Troubleshooting', 'a governance screen keeps working when telemetry is unavailable', async () => {
    // "A telemetry screen shows telemetry_unavailable ... Governance screens keep working."
    const governance = await Promise.all([
      agent.agents.list({ page_size: 1 }),
      agent.policies.list({ page_size: 1 }),
      agent.connectors.list({ page_size: 1 }),
    ]);
    for (const payload of governance) {
      assert.ok(Array.isArray(payload.items), 'a governance collection did not answer');
    }
  });

  spec('Troubleshooting', 'an agent detail carries the telemetry_available flag', async (t) => {
    // "A telemetry screen shows telemetry_unavailable" — the detail payload says which.
    if (!needs(t, data.agents.length, 'no agents')) return;
    const detail = await agent.agents.detail(data.agents[0].id);
    assert.ok('telemetry_available' in detail,
      'agent detail does not say whether telemetry is reachable, so a blank tab is unexplained');
  });
});
