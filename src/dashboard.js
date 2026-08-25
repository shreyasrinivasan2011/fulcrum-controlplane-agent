/* A local dashboard that runs the agent live.
 *
 * Everything the page shows is a real call this process makes to the control
 * plane — there is no fixture data. The browser talks only to this server; the
 * server holds the session and does the talking to Fulcrum.
 *
 *   node bin/dashboard.js [--port 4173] [--open]
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ControlPlaneAgent, ApiError } from './agent.js';
import { LocalModel } from './llm.js';
import { loadStore } from './learn.js';
import { describe as describeInvariant } from './invariants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function startDashboard({ port = 4173 } = {}) {
  const agent = new ControlPlaneAgent({ name: 'fulcrum-dashboard' });
  const connection = await agent.connect();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      switch (url.pathname) {
        case '/':            return await sendFile(res, join(ROOT, 'ui', 'index.html'), 'text/html; charset=utf-8');
        case '/_/state':     return json(res, 200, await state(agent, connection));
        case '/_/refresh':   return json(res, 200, await state(agent, connection));
        case '/_/log':       return json(res, 200, { telemetry: agent.telemetry.slice(-200), stats: agent.stats() });
        case '/_/knowledge': return json(res, 200, await knowledge());
        case '/_/runs':      return streamRuns(agent, req, res);
        case '/_/tests':     return streamTests(req, res, url.searchParams.get('pack'));
        default:             return json(res, 404, { error: { code: 'not_found', message: url.pathname } });
      }
    } catch (err) {
      const status = err instanceof ApiError && err.status >= 400 ? err.status : 500;
      json(res, status, { error: { code: err.code || 'server_error', message: err.message } });
    }
  });

  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { agent, connection, server, url: `http://127.0.0.1:${port}` };
}

/** One round of live calls — the page's whole picture, refreshed on demand. */
async function state(agent, connection) {
  const settled = await Promise.allSettled([
    agent.auth.me(),
    agent.agents.summary(),
    agent.agents.list({ page_size: 50 }),
    agent.runs.list({ page_size: 12 }),
    agent.runs.summary(),
    agent.metrics.summary({ window: '30d' }),
    agent.metrics.series({ window: '30d' }),
    agent.metrics.models(),
    agent.alerts.summary(),
    agent.policies.summary(),
  ]);
  const [me, agentSummary, agents, runs, runsSummary, metrics, series, models, alerts, policies] =
    settled.map(r => (r.status === 'fulfilled' ? r.value : { __error: r.reason?.message ?? String(r.reason) }));

  return {
    connection: { ...connection, origin: agent.origin, mode: connection.mode },
    session: me,
    agentSummary,
    agents: agents.items ?? [],
    runs: runs.items ?? [],
    runsSummary,
    metrics,
    series,
    models: models.items ?? [],
    alerts,
    policies,
    stats: agent.stats(),
    telemetry: agent.telemetry.slice(-60),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * What the agent has taught itself, plus whether the local model is up. The
 * page renders "model offline" rather than pretending, so an unstarted ollama
 * is visible instead of silently producing an empty store.
 */
async function knowledge() {
  const model = new LocalModel();
  const [store, availability] = await Promise.all([loadStore(), model.available()]);
  const byEndpoint = {};
  for (const inv of store.verified) {
    (byEndpoint[inv.endpoint] ??= []).push({
      claim: inv.claim,
      statement: describeInvariant(inv),
      predicate: inv.predicate,
      field: inv.field,
      confirmations: inv.confirmations ?? 1,
      verifiedAt: inv.verifiedAt,
      rows: inv.evidence?.applicable ?? null,
    });
  }
  return {
    model: { name: model.model, ...availability },
    rounds: store.rounds,
    updatedAt: store.updatedAt,
    verified: store.verified.length,
    rejected: store.rejected.slice(-12).map(r => ({
      statement: describeInvariant(r), why: r.why, endpoint: r.endpoint,
    })),
    rejectedTotal: store.rejected.length,
    byEndpoint,
    coverage: store.coverage,
  };
}

/** Proxy the control plane's live run feed straight through to the browser. */
function streamRuns(agent, req, res) {
  sseHead(res);
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  (async () => {
    try {
      for await (const frame of agent.runs.stream({ signal: controller.signal })) {
        send(res, frame.event, frame.data);
      }
    } catch (err) {
      if (err.name !== 'AbortError') send(res, 'error', { message: err.message });
    } finally {
      res.end();
    }
  })();
}

/** The suites the dashboard can run, by the name the page asks for. */
const PACKS = {
  smoke:      ['tests/smoke.test.js'],
  documented: ['tests/documented.test.js'],
  learned:    ['tests/learned.test.js'],
  all:        ['tests/smoke.test.js', 'tests/documented.test.js', 'tests/learned.test.js'],
};

/** Run a real test suite and stream TAP as it happens. */
function streamTests(req, res, pack) {
  sseHead(res);
  const files = PACKS[pack] ?? PACKS.smoke;
  const child = spawn(process.execPath,
    ['--env-file-if-exists=.env', '--test', '--test-reporter=tap', ...files],
    { cwd: ROOT, env: process.env });

  req.on('close', () => child.kill());

  let buffer = '';
  const consume = (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const parsed = parseTap(line);
      if (parsed) send(res, 'tap', parsed);
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.on('close', (code) => { send(res, 'done', { code }); res.end(); });
}

/**
 * Pull the useful lines out of TAP: results, the suite/test name, and the
 * summary counts. Indentation tells us a subtest from a top-level suite.
 */
function parseTap(line) {
  const result = /^(\s*)(ok|not ok)\s+\d+\s+-\s+(.*?)(\s*#.*)?$/.exec(line);
  if (result) {
    const [, indent, verdict, name, comment] = result;
    if (/# (SKIP|TODO)/i.test(comment || '')) return { kind: 'skip', name: name.trim() };
    return {
      kind: 'test',
      pass: verdict === 'ok',
      suite: indent.length === 0,
      name: name.trim(),
    };
  }
  const count = /^# (pass|fail|tests|duration_ms)\s+(.+)$/.exec(line.trim());
  if (count) return { kind: 'count', key: count[1], value: count[2].trim() };
  return null;
}

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': open\n\n');
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function sendFile(res, path, type) {
  const body = await readFile(path);
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}
