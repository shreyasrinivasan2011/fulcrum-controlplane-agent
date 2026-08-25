/* Read-only contract tests against a live control plane.
 *
 * Everything here is a GET or a deliberately-rejected POST — nothing in this
 * file creates, mutates, or deletes workspace data, so it is safe to point at
 * production. Mutating suites belong in their own file behind an explicit
 * FULCRUM_ALLOW_WRITES gate.
 *
 *   npm test
 */

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneAgent, FulcrumClient, ApiError } from '../src/index.js';

const agent = new ControlPlaneAgent({ name: 'smoke' });

before(async () => {
  await agent.connect();
});

after(async () => {
  await agent.disconnect();
  const s = agent.stats();
  console.log(`\n  ${s.requests} requests · ${s.failures} non-2xx · p50 ${s.p50Ms}ms · p95 ${s.p95Ms}ms · max ${s.maxMs}ms`);
});

describe('auth', () => {
  test('session identifies the caller and their workspace', async () => {
    const me = await agent.auth.me();
    assert.equal(me.user.email, process.env.FULCRUM_EMAIL);
    assert.ok(me.user.is_active, 'user should be active');
    assert.match(me.workspace.slug, /^[a-z0-9-]+$/);
    assert.ok(['owner', 'admin', 'member', 'viewer'].includes(me.role), `unexpected role ${me.role}`);
  });

  test('a wrong password is rejected with one generic message', async () => {
    const fresh = new FulcrumClient();
    const err = await capture(() => fresh.login(process.env.FULCRUM_EMAIL, 'definitely-not-the-password'));
    assert.equal(err.status, 401);
    assert.equal(err.code, 'unauthenticated');
    assert.doesNotMatch(err.message, /user|account|exist/i, 'must not disclose whether the account exists');
    assert.ok(err.requestId, 'errors carry a request id');
  });

  test('an unknown email is rejected identically — no user enumeration', async () => {
    const a = await capture(() => new FulcrumClient().login(process.env.FULCRUM_EMAIL, 'wrong-password'));
    const b = await capture(() => new FulcrumClient().login('nobody@example.invalid', 'wrong-password'));
    assert.equal(a.status, b.status);
    assert.equal(a.message, b.message);
  });

  test('an anonymous caller cannot read the workspace', async () => {
    const err = await capture(() => new FulcrumClient().get('/agents'));
    assert.equal(err.status, 401);
  });

  test('a bogus API key is rejected', async () => {
    const err = await capture(() => new FulcrumClient({ apiKey: 'fo_live_not_a_real_key' }).get('/agents'));
    assert.ok([401, 403].includes(err.status), `expected 401/403, got ${err.status}`);
  });
});

describe('list contract', () => {
  const paths = ['/agents', '/runs', '/policies', '/connections', '/workspaces/api-keys'];

  for (const path of paths) {
    test(`${path} returns the paged envelope`, async () => {
      const payload = await agent.raw.get(path, { page: 1, page_size: 2 });
      assert.ok(Array.isArray(payload.items), 'items must be an array');
      assert.equal(payload.page, 1);
      assert.equal(payload.page_size, 2);
      assert.equal(typeof payload.total, 'number');
      assert.ok(payload.items.length <= 2, 'page_size must be honoured');
      assert.equal(payload.pages, Math.max(1, Math.ceil(payload.total / 2)));
    });
  }

  test('page 2 returns different rows than page 1', async () => {
    const first = await agent.runs.list({ page: 1, page_size: 3 });
    if (first.total <= 3) return; // nothing to compare against
    const second = await agent.runs.list({ page: 2, page_size: 3 });
    const overlap = first.items.map(r => r.id).filter(id => second.items.some(r => r.id === id));
    assert.equal(overlap.length, 0, `pages overlap: ${overlap.join(', ')}`);
  });

  test('a page past the end is empty, not an error', async () => {
    const payload = await agent.agents.list({ page: 9999, page_size: 25 });
    assert.deepEqual(payload.items, []);
  });
});

describe('agents', () => {
  test('summary agrees with the list it summarises', async () => {
    const [summary, list] = await Promise.all([
      agent.agents.summary(),
      agent.agents.list({ page_size: 100 }),
    ]);
    assert.equal(summary.total, list.total, 'summary.total must match /agents total');
    const active = list.items.filter(a => a.status === 'Active').length;
    assert.equal(summary.active, active, 'summary.active must match the Active rows');
  });

  test('a listed agent can be fetched by id and keeps its identity', async () => {
    const { items } = await agent.agents.list({ page_size: 1 });
    if (!items.length) return;
    const detail = await agent.agents.get(items[0].id);
    assert.equal(detail.id, items[0].id);
    assert.equal(detail.name, items[0].name);
    assert.equal(detail.slug, items[0].slug);
  });

  test('search narrows the result set to matching names', async () => {
    const { items } = await agent.agents.list({ page_size: 1 });
    if (!items.length) return;
    const term = items[0].name.split(' ')[0];
    const found = await agent.agents.list({ q: term, page_size: 50 });
    assert.ok(found.items.length > 0, `search for "${term}" returned nothing`);
    assert.ok(
      found.items.some(a => a.name.toLowerCase().includes(term.toLowerCase())),
      'at least one result should contain the search term',
    );
  });

  test('an unknown agent id is a clean 404', async () => {
    const err = await capture(() => agent.agents.get('00000000-0000-0000-0000-000000000000'));
    assert.equal(err.status, 404);
    assert.ok(err.message.length > 0);
  });
});

describe('runs', () => {
  test('a run can be fetched and traced', async () => {
    const { items } = await agent.runs.list({ page_size: 1 });
    if (!items.length) return;
    const run = await agent.runs.get(items[0].id);
    assert.equal(run.id, items[0].id);
    assert.ok(run.occurred_at, 'a run is stamped with when it happened');

    const trace = await agent.runs.trace(items[0].id);
    assert.ok(trace, 'trace should return something');
  });

  test('filtering by agent_id only returns that agent’s runs', async () => {
    const { items } = await agent.runs.list({ page_size: 1 });
    if (!items?.[0]?.agent_id) return;
    const agentId = items[0].agent_id;
    const filtered = await agent.runs.list({ agent_id: agentId, page_size: 20 });
    const strays = filtered.items.filter(r => r.agent_id !== agentId);
    assert.deepEqual(strays, [], 'filter leaked runs from other agents');
  });

  test('run totals are internally consistent', async () => {
    const { items } = await agent.runs.list({ page_size: 25 });
    for (const run of items) {
      if (run.input_tokens != null && run.output_tokens != null && run.tokens != null) {
        assert.equal(run.tokens, run.input_tokens + run.output_tokens,
          `run ${run.id}: tokens ${run.tokens} ≠ ${run.input_tokens} + ${run.output_tokens}`);
      }
      if (run.ended_at && run.duration_seconds != null) {
        const measured = (Date.parse(run.ended_at) - Date.parse(run.occurred_at)) / 1000;
        assert.ok(Math.abs(measured - run.duration_seconds) < 1,
          `run ${run.id}: duration ${run.duration_seconds}s ≠ measured ${measured}s`);
      }
    }
  });
});

describe('live run stream', () => {
  test('the SSE feed opens and delivers well-formed run frames', { timeout: 40_000 }, async () => {
    const controller = new AbortController();
    const frames = [];
    const stop = setTimeout(() => controller.abort(), 25_000);
    try {
      for await (const frame of agent.runs.stream({ signal: controller.signal })) {
        frames.push(frame);
        if (frames.filter(f => f.event === 'run').length >= 2) break;
      }
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    } finally {
      clearTimeout(stop);
      controller.abort();
    }

    assert.equal(frames[0]?.event, 'open', 'the stream should announce itself with an `open` frame');
    assert.ok(frames[0].data.stream_id, 'the open frame carries a stream id');

    const runs = frames.filter(f => f.event === 'run');
    assert.ok(runs.length >= 1, 'no run frames arrived within 25s — is the workspace idle?');
    for (const { data } of runs) {
      assert.equal(data.stream_id, frames[0].data.stream_id, 'frames must share one stream id');
      assert.ok(data.run?.id, 'a run frame carries a run');
      assert.ok(data.run.agent_id, 'a run frame names its agent');
      assert.ok(Date.parse(data.emitted_at) >= Date.parse(data.run.occurred_at),
        'a run cannot be emitted before it occurred');
    }
  });

  test('streamed runs also show up in the runs list', { timeout: 40_000 }, async () => {
    const controller = new AbortController();
    const stop = setTimeout(() => controller.abort(), 25_000);
    let streamed = null;
    try {
      for await (const frame of agent.runs.stream({ signal: controller.signal })) {
        if (frame.event === 'run' && frame.data.run) { streamed = frame.data.run; break; }
      }
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    } finally {
      clearTimeout(stop);
      controller.abort();
    }
    if (!streamed) return; // idle workspace; the frame test above already reports it

    const fetched = await agent.runs.get(streamed.id);
    assert.equal(fetched.id, streamed.id);
    assert.equal(fetched.agent_id, streamed.agent_id);
    assert.equal(fetched.status, streamed.status, 'the stream and the API disagree about the run status');
  });
});

describe('errors', () => {
  test('a malformed request is a 4xx with the documented error shape', async () => {
    const err = await capture(() => agent.raw.post('/auth/login', { email: 'not-an-email' }));
    assert.ok(err.status >= 400 && err.status < 500, `expected 4xx, got ${err.status}`);
    assert.ok(err.code, 'error carries a machine-readable code');
    assert.ok(err.message, 'error carries a human-readable message');
    assert.ok(err.requestId, 'error carries a request id for support');
  });

  test('an unknown path is a 404, not an HTML page', async () => {
    const err = await capture(() => agent.raw.get('/definitely-not-a-real-endpoint'));
    assert.equal(err.status, 404);
  });
});

describe('security headers', () => {
  test('the console is served with the expected hardening', async () => {
    const res = await fetch(agent.origin, { redirect: 'manual' });
    const h = (name) => res.headers.get(name) || '';
    assert.match(h('strict-transport-security'), /max-age=\d+/, 'HSTS missing');
    assert.equal(h('x-content-type-options'), 'nosniff');
    assert.match(h('x-frame-options'), /DENY|SAMEORIGIN/i);
    assert.match(h('content-security-policy'), /default-src/, 'CSP missing');
  });

  test('the session cookie is httpOnly, Secure and SameSite', async () => {
    const res = await fetch(`${agent.origin}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.FULCRUM_EMAIL, password: process.env.FULCRUM_PASSWORD }),
    });
    const cookies = res.headers.getSetCookie();
    const session = cookies.find(c => c.startsWith('fo_session='));
    assert.ok(session, 'login must set fo_session');
    assert.match(session, /HttpOnly/i, 'session cookie must be HttpOnly');
    assert.match(session, /Secure/i, 'session cookie must be Secure');
    assert.match(session, /SameSite=(lax|strict)/i, 'session cookie must set SameSite');
  });
});

/** Run `fn`, expecting it to reject with an ApiError, and hand that error back. */
async function capture(fn) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new assert.AssertionError({ message: 'expected the call to fail, but it succeeded' });
}
