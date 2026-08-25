/* The agent: a connected session against the Fulcrum Ops control plane.
 *
 * `connect()` authenticates and reports what the caller may do; every domain
 * below is the same surface the console uses, so anything the UI can do the
 * agent can do too. Every request is timed and recorded in `telemetry`, which
 * is what the test harness asserts against.
 */

import { FulcrumClient, ApiError } from './client.js';

export class ControlPlaneAgent {
  /**
   * @param {object} [opts] passed through to FulcrumClient; see .env.example
   * @param {string} [opts.name] shows up in logs, not sent to the server
   */
  constructor(opts = {}) {
    this.name = opts.name || 'fulcrum-probe';
    this.telemetry = [];
    this.client = new FulcrumClient({
      ...opts,
      onRequest: (event) => {
        this.telemetry.push({ ...event, at: new Date().toISOString() });
        opts.onRequest?.(event);
      },
    });
    this.#bindDomains();
  }

  get session() { return this.client.session; }
  get isConnected() { return this.client.isAuthenticated; }
  get origin() { return this.client.origin; }

  /**
   * Authenticate and describe the reachable surface.
   * Uses FULCRUM_API_KEY when present, otherwise the operator email/password.
   * @returns {Promise<{mode: string, user: object, workspace: object, role: string, entitlements: object}>}
   */
  async connect() {
    if (this.client.apiKey) {
      // An API key needs no login round-trip; /auth/me proves it is live.
      const me = await this.client.me();
      this.client.session = me;
      return { mode: 'api-key', ...describe(me) };
    }
    const session = await this.client.login();
    return { mode: 'password', ...describe(session) };
  }

  async disconnect() {
    if (this.client.apiKey) return;
    await this.client.logout();
  }

  /** Cheap liveness probe: is the control plane up and is our session still good? */
  async health() {
    const startedAt = performance.now();
    try {
      const me = await this.client.me();
      return {
        ok: true,
        authenticated: true,
        latencyMs: Math.round(performance.now() - startedAt),
        workspace: me?.workspace?.slug ?? null,
        expiresAt: me?.expires_at ?? null,
      };
    } catch (err) {
      return {
        ok: err instanceof ApiError && err.status > 0,
        authenticated: false,
        latencyMs: Math.round(performance.now() - startedAt),
        error: { code: err.code, status: err.status, message: err.message, requestId: err.requestId },
      };
    }
  }

  /** A one-call picture of the workspace — what the console's landing screens show. */
  async overview() {
    const [agents, runs, connections, policies, alerts] = await Promise.allSettled([
      this.agents.summary(),
      this.runs.summary(),
      this.connections.summary(),
      this.policies.summary(),
      this.alerts.summary(),
    ]);
    const value = (r) => (r.status === 'fulfilled' ? r.value : { error: r.reason?.message });
    return {
      workspace: this.session?.workspace ?? null,
      agents: value(agents),
      runs: value(runs),
      connections: value(connections),
      policies: value(policies),
      alerts: value(alerts),
    };
  }

  /** Timing rollup over everything the agent has done so far. */
  stats() {
    const durations = this.telemetry.map(t => t.durationMs).sort((a, b) => a - b);
    const at = (q) => (durations.length ? Math.round(durations[Math.min(durations.length - 1, Math.floor(durations.length * q))]) : 0);
    return {
      requests: this.telemetry.length,
      failures: this.telemetry.filter(t => t.status >= 400 || t.status === 0).length,
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      maxMs: durations.length ? Math.round(durations.at(-1)) : 0,
    };
  }

  #bindDomains() {
    const c = this.client;
    const collection = (base) => c.collection(base);

    this.auth = {
      me: () => c.me(),
      switchWorkspace: (slug) => c.switchWorkspace(slug),
      apiKeys: Object.assign(collection('/workspaces/api-keys'), {
        summary: () => c.get('/workspaces/api-keys/summary'),
        revoke: (id, body) => c.post(`/workspaces/api-keys/${encodeURIComponent(id)}/revoke`, body || {}),
        usage: (id, params) => c.get(`/workspaces/api-keys/${encodeURIComponent(id)}/usage`, params),
      }),
      users: Object.assign(collection('/workspaces/users'), {
        summary: () => c.get('/workspaces/users/summary'),
        directory: () => c.get('/workspaces/users/directory'),
        setRole: (id, body) => c.post(`/workspaces/users/${encodeURIComponent(id)}/role`, body || {}),
      }),
    };

    this.agents = Object.assign(collection('/agents'), {
      /**
       * `/agents/{id}` is the one detail endpoint that answers with a composite
       * envelope — {agent, configuration, connectors, policies, versions, stats,
       * latency_series} — because it backs a whole screen. Flatten it so callers
       * get an agent that looks like a list row, with the extras hung off it;
       * `detail()` hands back the envelope untouched.
       */
      get: async (id) => {
        const payload = await c.get(`/agents/${encodeURIComponent(id)}`);
        if (!payload || !payload.agent) return payload;
        const { agent, ...extras } = payload;
        return { ...agent, ...extras };
      },
      detail: (id) => c.get(`/agents/${encodeURIComponent(id)}`),
      summary: () => c.get('/agents/summary'),
      runs: (id, params) => c.get('/runs', { agent_id: id, ...(params || {}) }),
      versions: (id) => c.get(`/agents/${encodeURIComponent(id)}/versions`),
      createVersion: (id, body) => c.post(`/agents/${encodeURIComponent(id)}/versions`, body),
      versionDiff: (id, params) => c.get(`/agents/${encodeURIComponent(id)}/versions/diff`, params),
      configuration: (id) => c.get(`/agents/${encodeURIComponent(id)}/export`),
      activate: (id) => c.post(`/agents/${encodeURIComponent(id)}/activate`, {}),
      deactivate: (id) => c.post(`/agents/${encodeURIComponent(id)}/deactivate`, {}),
      run: (id, body) => c.post(`/agents/${encodeURIComponent(id)}/run`, body || {}),
      clone: (id, body) => c.post(`/agents/${encodeURIComponent(id)}/clone`, body || {}),
    });

    this.runs = {
      list: (params) => c.get('/runs', params),
      history: (params) => c.get('/runs/history', params),
      get: (id) => c.get(`/runs/${encodeURIComponent(id)}`),
      trace: (id) => c.get(`/runs/${encodeURIComponent(id)}/trace`),
      replay: (id) => c.get(`/runs/${encodeURIComponent(id)}/replay`),
      response: (id) => c.get(`/runs/${encodeURIComponent(id)}/response`),
      summary: (params) => c.get('/runs/summary', params),
      flag: (id, body) => c.post(`/runs/${encodeURIComponent(id)}/flag`, body || {}),
      /** Live run feed. `for await (const frame of agent.runs.stream())` */
      stream: (opts) => c.stream('/runs/stream', opts),
      all: (params, opts) => c.all('/runs', params, opts),
    };

    this.metrics = {
      summary: (params) => c.get('/metrics/summary', params),
      series: (params) => c.get('/metrics/series', params),
      models: (params) => c.get('/metrics/models', params),
      platforms: (params) => c.get('/metrics/platforms', params),
    };

    this.connections = Object.assign(collection('/connections'), {
      summary: () => c.get('/connections/summary'),
      test: (id) => c.post(`/connections/${encodeURIComponent(id)}/test`, {}),
      activity: (params) => c.get('/connections/activity', params),
      /**
       * Tool calls and data flows derived from spans. Connection kinds are a
       * superset of agent platforms, so for a kind nothing runs "on" the
       * response sets `attributable: false` rather than reporting a zero.
       */
      traffic: (id, params) => c.get(`/connections/${encodeURIComponent(id)}/traffic`, params),
    });

    this.connectors = Object.assign(collection('/connectors'), {
      summary: () => c.get('/connectors/summary'),
      test: (id) => c.post(`/connectors/${encodeURIComponent(id)}/test`, {}),
    });

    this.policies = Object.assign(collection('/policies'), {
      summary: () => c.get('/policies/summary'),
    });

    this.approvals = Object.assign(collection('/approvals'), {
      rules: collection('/approvals/rules'),
    });

    this.evaluations = collection('/evaluations');
    this.guardrails = collection('/guardrails');
    this.environments = collection('/environments');
    this.deployments = collection('/deployments');
    this.prompts = collection('/prompts');
    this.knowledge = collection('/knowledge');
    this.secrets = collection('/secrets');
    this.memory = collection('/memory');
    this.configurations = collection('/configurations');

    this.testing = Object.assign(collection('/testing/suites'), {
      runs: (id, params) => c.get(`/testing/suites/${encodeURIComponent(id)}/runs`, params),
      schedules: collection('/testing/schedules'),
    });

    this.alerts = Object.assign(collection('/alerts'), {
      summary: () => c.get('/alerts/summary'),
      rules: collection('/alerts/rules'),
    });

    // ---- surfaces the manual documents beyond the console's own client ----

    /**
     * Ingest. Every path here refuses a sign-in session with a 403 by design —
     * "the ingest API accepts API keys only". Give the client an API key with
     * the `ingest` scope to actually write.
     */
    this.ingest = {
      config: () => c.get('/ingest/config'),
      traces: (items) => c.post('/ingest/traces', { items }),
      spans: (items) => c.post('/ingest/spans', { items }),
      scores: (items) => c.post('/ingest/scores', { items }),
      events: (items) => c.post('/ingest/events', { items }),
      /** OTLP lands at the app root, not under /api/v1. */
      otlp: (body, contentType = 'application/json') =>
        c.rootPost('/v1/traces', body, { 'Content-Type': contentType }),
    };

    /** Append-only, hash-chained governance record. */
    this.audit = {
      list: (params) => c.get('/audit', params),
      /** Re-walks the chain; `intact: false` means a row was altered or removed. */
      verify: () => c.get('/audit/verify'),
    };

    this.licensing = Object.assign(collection('/licensing/tenants'), {
      plans: collection('/licensing/plans'),
      tenants: collection('/licensing/tenants'),
      /** The same resolution the ingest path performs, for one entitlement key. */
      entitlementCheck: (key) => c.get('/licensing/entitlement-check', { key }),
    });

    this.quota = Object.assign(collection('/quota'), {
      budgets: collection('/quota/budgets'),
    });

    this.feedback = Object.assign(collection('/feedback'), {
      issues: collection('/feedback/issues'),
      backlog: collection('/feedback/backlog'),
    });

    this.exports = Object.assign(collection('/exports'), {
      schedules: collection('/exports/schedules'),
    });

    /** Platform liveness — served at the origin root, outside /api/v1. */
    this.serviceHealth = () => c.rootGet('/health');

    /** Escape hatch for endpoints not wrapped above. */
    this.raw = {
      get: (path, params) => c.get(path, params),
      rootGet: (path, params) => c.rootGet(path, params),
      /** The undecoded Response — for /export, which streams a file. */
      rawGet: (path, params) => c.request('GET', path, { params, raw: true }),
      post: (path, body) => c.post(path, body),
      patch: (path, body) => c.patch(path, body),
      del: (path, body) => c.del(path, body),
    };
  }
}

function describe(session) {
  return {
    user: session?.user ?? null,
    workspace: session?.workspace ?? null,
    role: session?.role ?? null,
    entitlements: session?.entitlements ?? null,
    expiresAt: session?.expires_at ?? null,
  };
}

/** Convenience: build an agent and connect it in one call. */
export async function connect(opts = {}) {
  const agent = new ControlPlaneAgent(opts);
  const info = await agent.connect();
  return { agent, info };
}

export { ApiError };
