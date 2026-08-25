/* Fulcrum Ops control plane — HTTP client.
 *
 * Mirrors the console's own api.js so behaviour matches what the UI sees:
 *   - list endpoints take {page, page_size, q, sort, ...filters} and return
 *     {items, total, page, page_size, pages}
 *   - errors return {error:{code,message,details,request_id}} with a real status
 *   - a session lives in the httpOnly `fo_session` cookie; an API key may be
 *     supplied instead via the X-Fulcrum-Api-Key header
 *
 * No dependencies — Node's fetch does the work, and the cookie jar below is the
 * one piece fetch does not provide.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(status, body, requestId) {
    const info = (body && body.error) || {};
    super(info.message || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = info.code || 'http_error';
    this.details = info.details || null;
    this.requestId = info.request_id || requestId || null;
  }
  get isAuth() { return this.status === 401; }
  get isForbidden() { return this.status === 403; }
  get isNotFound() { return this.status === 404; }
  get isConflict() { return this.status === 409; }
  get isValidation() { return this.status === 422; }
  /** Field-level messages, keyed by field name. */
  get fieldErrors() {
    const fields = (this.details && this.details.fields) || [];
    return Object.fromEntries(fields.map(f => [f.field, f.message]));
  }
}

/** Minimal cookie jar: enough for one host and one session cookie. */
class CookieJar {
  #jar = new Map();
  absorb(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.#jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() {
    if (this.#jar.size === 0) return null;
    return [...this.#jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  clear() { this.#jar.clear(); }
  has(name) { return this.#jar.has(name); }
}

export class FulcrumClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl]   origin of the control plane
   * @param {string} [opts.apiKey]    workspace API key; skips password login
   * @param {string} [opts.workspace] workspace slug, when the account has several
   * @param {number} [opts.timeoutMs]
   * @param {(event: object) => void} [opts.onRequest] hook for logging/metrics
   */
  constructor(opts = {}) {
    const origin = (opts.baseUrl || process.env.FULCRUM_BASE_URL || 'https://controlplane.fdprod.net')
      .replace(/\/$/, '');
    this.origin = origin;
    this.base = `${origin}/api/v1`;
    this.apiKey = opts.apiKey ?? process.env.FULCRUM_API_KEY ?? null;
    this.workspace = opts.workspace ?? process.env.FULCRUM_WORKSPACE ?? null;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onRequest = opts.onRequest ?? null;
    this.session = null;
    this.jar = new CookieJar();
  }

  get isAuthenticated() { return Boolean(this.apiKey || this.jar.has('fo_session')); }

  #qs(params) {
    if (!params) return '';
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach(item => sp.append(k, String(item)));
      else sp.append(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  /**
   * One request. Returns parsed JSON, `null` for 204, or the raw Response when
   * `raw` is set (exports stream a file rather than JSON).
   */
  async request(method, path, { body, params, raw, signal, headers: extra, root } = {}) {
    const url = `${root ? this.origin : this.base}${path}${this.#qs(params)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

    const headers = { Accept: 'application/json', ...(extra || {}) };
    if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (this.apiKey) headers['X-Fulcrum-Api-Key'] = this.apiKey;
    if (this.workspace) headers['X-Fulcrum-Workspace'] = this.workspace;
    const cookie = this.jar.header();
    if (cookie) headers.Cookie = cookie;

    const startedAt = performance.now();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (err) {
      clearTimeout(timer);
      const timedOut = err.name === 'AbortError';
      throw new ApiError(0, {
        error: {
          code: timedOut ? 'timeout' : 'network',
          message: timedOut ? 'The request timed out.' : `Cannot reach the control plane: ${err.message}`,
        },
      });
    }
    clearTimeout(timer);
    this.jar.absorb(res);

    const durationMs = performance.now() - startedAt;
    const requestId = res.headers.get('X-Request-Id');
    this.onRequest?.({ method, path, status: res.status, durationMs, requestId });

    if (raw) {
      if (!res.ok) throw new ApiError(res.status, await safeJson(res), requestId);
      return res;
    }
    if (res.status === 204) return null;

    const payload = await safeJson(res);
    if (!res.ok) throw new ApiError(res.status, payload, requestId);
    return payload;
  }

  get(path, params, opts) { return this.request('GET', path, { params, ...(opts || {}) }); }

  /**
   * A few documented endpoints live at the origin root rather than under
   * /api/v1 — `/health` and the OTLP receiver at `/v1/traces`.
   */
  rootGet(path, params) { return this.request('GET', path, { params, root: true }); }
  rootPost(path, body, headers) { return this.request('POST', path, { body, headers, root: true }); }
  post(path, body, params) { return this.request('POST', path, { body, params }); }
  put(path, body) { return this.request('PUT', path, { body }); }
  patch(path, body) { return this.request('PATCH', path, { body }); }
  del(path, body) { return this.request('DELETE', path, { body }); }

  /**
   * Sign in with operator credentials and hold the session cookie.
   * Agents should prefer an API key; this exists so the harness can run with
   * nothing but the console login.
   */
  async login(email = process.env.FULCRUM_EMAIL, password = process.env.FULCRUM_PASSWORD) {
    if (!email || !password) {
      throw new ApiError(0, { error: { code: 'config', message: 'Set FULCRUM_EMAIL and FULCRUM_PASSWORD (see .env.example).' } });
    }
    this.session = await this.post('/auth/login', { email, password });
    if (!this.workspace && this.session?.workspace?.slug) this.workspace = this.session.workspace.slug;
    return this.session;
  }

  async logout() {
    try { await this.post('/auth/logout', {}); } finally { this.jar.clear(); this.session = null; }
  }

  me() { return this.get('/auth/me'); }

  async switchWorkspace(slug) {
    const session = await this.post('/auth/workspace', { workspace: slug });
    this.workspace = slug;
    this.session = session;
    return session;
  }

  /** A CRUD surface for one collection, matching the console's helper. */
  collection(base) {
    return {
      list: (params) => this.get(base, params),
      get: (id) => this.get(`${base}/${encodeURIComponent(id)}`),
      create: (body) => this.post(base, body),
      update: (id, body) => this.patch(`${base}/${encodeURIComponent(id)}`, body),
      remove: (id) => this.del(`${base}/${encodeURIComponent(id)}`),
      action: (id, verb, body) => this.post(`${base}/${encodeURIComponent(id)}/${verb}`, body || {}),
      pages: (params) => this.pages(base, params),
      all: (params, opts) => this.all(base, params, opts),
    };
  }

  /** Walk a list endpoint page by page. */
  async *pages(path, params = {}) {
    const pageSize = params.page_size ?? 50;
    let page = params.page ?? 1;
    while (true) {
      const payload = await this.get(path, { ...params, page, page_size: pageSize });
      yield payload;
      const pages = payload?.pages ?? 1;
      if (!payload?.items?.length || page >= pages) return;
      page += 1;
    }
  }

  /** Every item from a list endpoint, with a hard cap so a bad filter cannot spin. */
  async all(path, params = {}, { limit = 1000 } = {}) {
    const out = [];
    for await (const payload of this.pages(path, params)) {
      out.push(...(payload.items || []));
      if (out.length >= limit) return out.slice(0, limit);
    }
    return out;
  }

  /**
   * Consume a server-sent event stream. Yields {event, data} frames until the
   * caller breaks out of the loop or `signal` aborts.
   */
  async *stream(path, { params, signal } = {}) {
    const headers = { Accept: 'text/event-stream' };
    if (this.apiKey) headers['X-Fulcrum-Api-Key'] = this.apiKey;
    if (this.workspace) headers['X-Fulcrum-Workspace'] = this.workspace;
    const cookie = this.jar.header();
    if (cookie) headers.Cookie = cookie;

    const res = await fetch(`${this.base}${path}${this.#qs(params)}`, { headers, signal });
    if (!res.ok) throw new ApiError(res.status, await safeJson(res), res.headers.get('X-Request-Id'));

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    // This server frames with CRLF, which the spec allows; normalising here
    // keeps the splitter and the field parser to one line ending.
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value.replace(/\r\n?/g, '\n');
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const parsed = parseFrame(frame);
          if (parsed) yield parsed;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}

function parseFrame(frame) {
  let event = 'message';
  let id = null;
  const data = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;          // `: keep-alive`
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    else if (line.startsWith('id:')) id = line.slice(3).trim();
  }
  if (data.length === 0) return null;
  const body = data.join('\n');
  try { return { id, event, data: JSON.parse(body) }; }
  catch { return { id, event, data: body }; }
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}
