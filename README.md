# Fulcrum Ops control-plane agent

An agent that authenticates against the Fulcrum Ops control plane at
`https://controlplane.fdprod.net`, drives its `/api/v1` surface, and carries a
test harness for exercising that API.

No dependencies — Node's own `fetch`, `node:test`, and `--env-file` do the work.
Requires Node ≥ 20.6 (built and verified on 24.4).

## Layout

| Path | What it is |
| --- | --- |
| `src/client.js` | HTTP client: cookie jar, error shape, pagination, SSE |
| `src/agent.js` | `ControlPlaneAgent` — connect, the typed API surface, telemetry |
| `bin/fulcrum.js` | CLI over the agent |
| `src/dashboard.js`, `ui/index.html` | Live dashboard — the agent running, in a browser |
| `src/llm.js` | The local model client — Ollama over localhost, no dependency |
| `src/invariants.js` | The predicate vocabulary the model may propose in, and the checker |
| `src/learn.js` | The learning loop: propose → validate → verify → confirm → remember |
| `src/manual-enums.js` | The manual's enums — used by the doc pack *and* by the loop to check itself |
| `knowledge/knowledge.json` | What the agent has learned, and what it has disproved |
| `tests/learned.test.js` | Replays the learned invariants as a live test suite |
| `tests/smoke.test.js` | Read-only contract tests against the live control plane |
| `tests/documented.test.js` | The documented-behaviour pack — every test asserts a claim from the manual |
| `tests/helpers/manual.js` | The manual's enums, the citation helper, and the triaged-divergence baseline |

## Configure

Credentials live in `.env` (gitignored, `chmod 600`), copied from `.env.example`:

```
FULCRUM_BASE_URL=https://controlplane.fdprod.net
FULCRUM_EMAIL=ops@fulcrumops.com
FULCRUM_PASSWORD=…
```

The console's own sign-in screen says it plainly: *"Agents connect with an API
key, not this password."* Password login is what the harness uses to bootstrap;
for anything long-lived, mint a workspace key under Workspace settings and set
`FULCRUM_API_KEY` instead — the client sends it as `X-Fulcrum-Api-Key` and skips
the login round-trip entirely.

## Dashboard

```bash
node bin/dashboard.js          # → http://127.0.0.1:4173
```

The agent connects once at boot and holds the session; the browser talks only to
this local server. Nothing on the page is fixture data — every number is a call
this process just made.

- **KPI row** — agents, runs, success rate, latency, policy violations, open alerts
- **Runs per day** — 30-day series with a crosshair tooltip
- **Runs by model** — magnitude by bar length, one hue, with per-model latency and cost
- **Live run feed** — the SSE stream from `/api/v1/runs/stream`, rows arriving as they happen
- **Agent request log** — every call the agent has made, with the status and latency it saw
- **Test suite** — pick a pack and it runs for real, streaming TAP results into the page

Light and dark both ship; the header toggle overrides the OS setting.

## CLI

```bash
node bin/fulcrum.js connect      # who am I, which workspace, what am I entitled to
node bin/fulcrum.js health       # liveness + session check, with latency
node bin/fulcrum.js overview     # agents / runs / connections / policies / alerts rollup
node bin/fulcrum.js agents       # list agents
node bin/fulcrum.js agent <id|slug>
node bin/fulcrum.js runs --agent <id> --limit 20
node bin/fulcrum.js watch        # follow the live run stream
node bin/fulcrum.js get /metrics/summary window=30d
```

## Library

```js
import { connect } from './src/index.js';

const { agent, info } = await connect();
console.log(info.workspace.slug, info.role);

const { items } = await agent.agents.list({ status: 'Active' });
const detail   = await agent.agents.get(items[0].id);
const runs     = await agent.runs.all({ agent_id: items[0].id }, { limit: 500 });

for await (const frame of agent.runs.stream()) {
  if (frame.event === 'run') console.log(frame.data.run.status);
}

console.log(agent.stats());   // { requests, failures, p50Ms, p95Ms, maxMs }
```

Every domain the console talks to is bound on the agent — `agents`, `runs`,
`metrics`, `connections`, `connectors`, `policies`, `approvals`, `evaluations`,
`guardrails`, `environments`, `deployments`, `prompts`, `knowledge`, `secrets`,
`memory`, `configurations`, `testing`, `alerts`, plus `auth.apiKeys` and
`auth.users`. Anything unwrapped is reachable through `agent.raw.get/post/patch/del`.

## Self-learning

The agent runs a **local** model — nothing about this workspace leaves the machine,
which is the point of not using a hosted one against a production tenant.

```bash
brew install ollama
ollama serve &
ollama pull qwen2.5-coder:3b

node bin/learn.js --rounds 5 --count 7    # learn
npm run test:learned                       # re-check everything learned so far
```

Model and host are configurable: `FULCRUM_LLM_MODEL`, `OLLAMA_HOST`. The 3B is the
default because this machine has 8 GB of unified memory — a 7B at q4 is ~4.7 GB and
will swap against macOS itself. If you have more headroom, `qwen2.5-coder:7b`
proposes noticeably better invariants.

### What "learning" means here

The weights never move — no fine-tuning, no training. What accumulates is a store
of **verified knowledge**, and every round begins from it, so the model stops
re-proposing what it already knows and what it has already been shown is false.

One round:

1. **Pick** the endpoint the agent knows least about (`coverage` in the store).
2. **Sample** it live and summarise its real shape — every field, its type, its
   nullability, a few real values. Far cheaper than pasting rows into an 8k context.
3. **Ask** the model for invariants, showing it the shape, the matching chapter of
   the operator manual, and everything already verified or disproved for that endpoint.
4. **Validate structurally** — is the predicate real, are its arguments present, does
   the field actually exist? A field the model invented is the most common failure
   mode, and it is caught before anything touches the API.
5. **Check** against the sample. No violations, or it is recorded as disproved with
   its counterexample.
6. **Confirm** on a second, independent page — a small page can be lucky.
7. **Write it down**, either way.

### The model never writes code

It emits a declarative invariant — an endpoint, a field path, a predicate from a
fixed list, and its arguments — and `src/invariants.js` executes it. Fourteen
predicates: `always_present`, `never_null`, `type_is`, `enum_subset`, `matches`,
`bounded`, `non_negative`, `unique`, `iso_timestamp`, `sum_equals`, `lte_field`,
`ordered_desc`, `null_when_zero`, `present_when`.

The worst a hallucinating 3B can produce is a claim that fails verification and gets
recorded as rejected. It cannot produce an action.

### Three guards, each of which caught a real failure

- **Vacuity.** `session_id parses as a timestamp` held over 100 rows — every one of
  them `null`. An invariant with no applicable rows has proved nothing, and is now
  refused rather than banked.
- **Overfitting.** Shown four policies, the model claimed `enforcement is one of
  Warn, Log Only, Block`. The manual documents **eight**. Where the manual governs a
  field, a proposed enum is checked against the manual rather than the sample;
  where it does not, closing an enum needs at least 25 applicable rows.
- **Regression.** Every run re-checks the whole store first. An invariant that held
  when it was learned and fails now means the API changed — the most valuable thing
  the loop produces. It moves to `rejected` with the counterexample that broke it.

### Learning produces real tests

`tests/learned.test.js` replays the store against the live API, so knowledge cannot
quietly rot into a stale JSON file:

```
✔ /runs — cost is never negative  ‹learned 2026-08-25, confirmed 3×›
```

## Tests

```bash
npm test               # all three packs
npm run test:smoke     # the API contract pack   — 25 tests
npm run test:pack      # the documented pack     — 77 tests
npm run test:learned   # the self-taught pack    — grows each learning round
```

**Every test is read-only** — GETs, plus writes the server is expected to reject —
so both packs are safe to point at production. Nothing creates, mutates or deletes
workspace data. The one probe that would leave a trace (the inline guardrail
content checker, which appends a row to the audit trail) is gated behind
`FULCRUM_ALLOW_PROBES=1` and skips with that reason by default.

What is covered today:

- **auth** — session identity; wrong password and unknown email are rejected
  identically (no user enumeration); anonymous and bogus-key callers are refused
- **list contract** — the `{items, total, page, page_size, pages}` envelope holds
  on every collection; `page_size` is honoured; pages don't overlap; past-the-end
  is empty rather than an error
- **agents** — `/agents/summary` agrees with the list it summarises; a listed
  agent round-trips by id; search narrows; unknown ids 404 cleanly
- **runs** — fetch and trace; `agent_id` filtering doesn't leak other agents'
  runs; `tokens == input_tokens + output_tokens` and `duration_seconds` matches
  `ended_at - occurred_at` across a page
- **live run stream** — the SSE feed opens, frames share a stream id, no run is
  emitted before it occurred, and a streamed run agrees with `/runs/{id}`
- **errors** — 4xx bodies carry `code`, `message` and a `request_id`
- **security headers** — HSTS, `nosniff`, frame-deny and CSP on the console;
  `fo_session` is HttpOnly, Secure and SameSite

### The documented-behaviour pack

77 tests derived from the operator manual at
[`/docs/`](https://controlplane.fdprod.net/docs/). Each one is named for the claim
it checks and tagged with the chapter it came from, so a failure says which
sentence broke:

```
✔ anything but Global carries a scope_ref  ‹Policy Center›
✔ traffic says "not attributable" rather than reporting a zero  ‹Hosting & Deployment›
✖ match_count agrees with the entity counts beside it  ‹Quality › Guardrails›
```

Fifteen chapters are covered. The tests worth knowing about:

- **Ingest is key-only** — `/ingest/{traces,spans,scores,events}` and the OTLP
  receiver at `/v1/traces` all refuse a sign-in session with a 403, as documented
- **Policy scope** — every non-Global policy (and guardrail) carries a `scope_ref`,
  and every Global one does not
- **Connection traffic** — for a kind nothing runs "on" (Vector Database, Custom
  REST API…) the response sets `attributable: false` rather than reporting a zero
- **Metrics** — all four windows; each KPI measured over the window *and* the equal
  span immediately before it; the eight documented series; `agent_id` repeatable
  across `/summary`, `/series`, `/models`, `/platforms`
- **A dash is not a zero** — an agent with no runs reports `success_rate_30d: null`,
  because 0% would be a claim about nothing
- **Audit** — the hash chain verifies intact across all ~2,700 rows, the trail is
  ordered and append-only, and it filters by actor and action
- **Entitlements** — `included_seats/tokens/runs` are hard numeric ceilings, feature
  grants are soft booleans, and `/licensing/entitlement-check` resolves each one the
  same way the session does
- **Keys** — no response field anywhere carries plaintext key material; only the
  elided `fo_live_263…lgga` hint
- **Enums** — agent platform/type/status, policy enforcement/scope/status/category,
  guardrail action, connector type/access, connection kind, run status, policy
  result, environments, alert severity, key scopes, span types

### What the pack currently reports

**One product bug (failing).**

> `match_count` is `0` on **every** guardrail event, while `matched` beside it
> carries real counts — e.g. `match_count: 0` next to `{"CARD":1,"PHONE":1}`.
> 50 of 50 sampled events disagree. The Guardrails screen promises "the matched
> entity counts", so the feed contradicts itself.

**Two manual-vs-product divergences (triaged, reported on every run).** These are
baselined in `KNOWN_DIVERGENCES` so they print as warnings rather than failing
forever — but a *new* undocumented value in the same field is still a hard failure:

| Field | Product | Manual |
|---|---|---|
| `connector.connector_type` | `Tool` | the Add Connector dialog lists `Custom Tool` |
| `connection.kind` | `Custom Agent` | lists six kinds and omits this one — and it is the kind that makes traffic attributable |

**Two skips**, each with its reason: no connector is currently blocked, so the
"a blocked connector keeps its grants" test has nothing to assert against; and the
content-checker probe is gated as described above.

### Not covered, and why

- **Role enforcement.** The manual says roles are enforced on the server, not the
  interface. Proving it needs a second, lower-privileged account; with one `owner`
  login there is nothing to assert.
- **The ingest path itself.** Partial-success batching, `agent_unprovisioned`
  rejections, the guardrail `matched`-shape rejection, and the OTLP `415` on a bad
  content type are all documented and all need a key with the `ingest` scope.
  Auth runs before content negotiation, so the `415` is unreachable without one.
  Set `FULCRUM_API_KEY` and these become testable.

## Notes on the API, found while building this

- `/agents/{id}` is the only detail endpoint that answers with a composite
  envelope (`{agent, configuration, connectors, policies, versions, stats,
  latency_series}`) rather than a bare object — it backs a whole screen.
  `agent.agents.get()` flattens it; `agent.agents.detail()` returns it as-is.
- The SSE stream frames with **CRLF** line endings and sends `: keep-alive`
  comments. A parser that splits on `\n\n` sees nothing at all; `src/client.js`
  normalises before splitting.
- Sessions last 12 hours (`Max-Age=43200`).

## Next

- Mint an API key and switch `FULCRUM_API_KEY` in, so the agent isn't holding an
  operator password.
- A write suite behind `FULCRUM_ALLOW_WRITES=1`, ideally pointed at the
  Development environment: create → version → activate → run → deactivate →
  delete, each step asserting the state the console would show.
- Authorization tests: a second, lower-privileged account to prove `viewer` and
  `member` roles are actually refused where `owner` is allowed.
