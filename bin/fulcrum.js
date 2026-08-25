#!/usr/bin/env node
/* fulcrum — drive the control plane from a terminal.
 *
 *   fulcrum connect                 who am I, and what may I do
 *   fulcrum health                  liveness + session check
 *   fulcrum overview                workspace rollup
 *   fulcrum agents [query]          list agents
 *   fulcrum agent <id|slug>         one agent, with its versions
 *   fulcrum runs [--agent <id>]     recent runs
 *   fulcrum watch                   follow the live run stream
 *   fulcrum get <path> [k=v ...]    any GET under /api/v1
 */

import { ControlPlaneAgent, ApiError } from '../src/agent.js';

// Load .env from the working directory when it exists, so the CLI behaves the
// same whether it is run through npm or invoked directly.
try { process.loadEnvFile('.env'); } catch { /* no .env — rely on the environment */ }

const [, , command = 'connect', ...rest] = process.argv;

const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (arg.startsWith('--')) flags[arg.slice(2)] = rest[i + 1]?.startsWith('--') ? true : rest[++i] ?? true;
  else positional.push(arg);
}

const out = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

function table(items, columns) {
  if (!items?.length) return '(none)';
  const rows = [columns, ...items.map(it => columns.map(col => String(it[col] ?? '')))];
  const widths = columns.map((_, i) => Math.max(...rows.map(r => r[i].length)));
  return rows
    .map((r, ri) => r.map((cell, i) => cell.padEnd(widths[i])).join('  ') +
      (ri === 0 ? `\n${widths.map(w => '─'.repeat(w)).join('  ')}` : ''))
    .join('\n');
}

const agent = new ControlPlaneAgent({ name: 'fulcrum-cli' });

try {
  await agent.connect();

  switch (command) {
    case 'connect': {
      const s = agent.session;
      out(`Connected to ${agent.origin}`);
      out(`  user       ${s.user.email} (${s.user.full_name})`);
      out(`  workspace  ${s.workspace.name} [${s.workspace.slug}] — role ${s.role}`);
      out(`  expires    ${s.expires_at}`);
      out(`  grants     ${Object.entries(s.entitlements).filter(([, v]) => v === true).map(([k]) => k).join(', ')}`);
      break;
    }
    case 'health':
      out(await agent.health());
      break;
    case 'overview':
      out(await agent.overview());
      break;
    case 'agents': {
      const { items, total } = await agent.agents.list({ q: positional[0], page_size: flags.limit ?? 25 });
      out(table(items, ['name', 'environment', 'status', 'risk', 'model', 'agent_type']));
      out(`\n${items.length} of ${total}`);
      break;
    }
    case 'agent': {
      const id = positional[0];
      if (!id) throw new Error('usage: fulcrum agent <id|slug>');
      const found = /^[0-9a-f-]{36}$/i.test(id)
        ? await agent.agents.get(id)
        : (await agent.agents.list({ q: id, page_size: 1 })).items[0];
      if (!found) throw new Error(`no agent matched "${id}"`);
      out(found);
      break;
    }
    case 'runs': {
      const { items, total } = await agent.runs.list({
        agent_id: flags.agent, status: flags.status, page_size: flags.limit ?? 15,
      });
      out(table(items, ['occurred_at', 'agent', 'status', 'model', 'tokens', 'duration_seconds', 'policy']));
      out(`\n${items.length} of ${total}`);
      break;
    }
    case 'watch': {
      out('Following /runs/stream — ctrl-c to stop.');
      // Frames arrive as {event, run, emitted_at, stream_id}; `open` carries no run.
      for await (const frame of agent.runs.stream()) {
        const run = frame.data?.run;
        if (!run) { out(`[${frame.event}]`); continue; }
        out(`[${frame.event}] ${run.occurred_at}  ${run.agent}  ${run.status}  ${run.model}  ${run.tokens}tok  ${run.duration_seconds}s  ${run.policy}`);
      }
      break;
    }
    case 'get': {
      const path = positional[0];
      if (!path) throw new Error('usage: fulcrum get /agents [page_size=5]');
      const params = Object.fromEntries(positional.slice(1).map(p => p.split('=')));
      out(await agent.raw.get(path.startsWith('/') ? path : `/${path}`, params));
      break;
    }
    default:
      out(`unknown command "${command}". try: connect | health | overview | agents | agent | runs | watch | get`);
      process.exitCode = 2;
  }
} catch (err) {
  if (err instanceof ApiError) {
    console.error(`✗ ${err.code} (${err.status}): ${err.message}${err.requestId ? `  [request ${err.requestId}]` : ''}`);
    if (Object.keys(err.fieldErrors).length) console.error(err.fieldErrors);
  } else {
    console.error(`✗ ${err.message}`);
  }
  process.exitCode = 1;
}
