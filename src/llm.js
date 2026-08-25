/* The local model.
 *
 * Talks to an Ollama server on localhost over plain HTTP — no dependency, and
 * nothing leaves the machine. The control plane's data never reaches a hosted
 * model, which is the point of running one locally against a production tenant.
 *
 *   brew install ollama
 *   ollama serve
 *   ollama pull qwen2.5-coder:3b
 */

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5-coder:3b';

export class LocalModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.host]      Ollama base URL
   * @param {string} [opts.model]     model tag; a 3B fits 8 GB comfortably
   * @param {number} [opts.timeoutMs] a small model on CPU is slow — be generous
   */
  constructor(opts = {}) {
    this.host = (opts.host || process.env.OLLAMA_HOST || DEFAULT_HOST).replace(/\/$/, '');
    this.model = opts.model || process.env.FULCRUM_LLM_MODEL || DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.calls = [];
  }

  /** Is a server up, and does it have the model we asked for? */
  async available() {
    try {
      const res = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return { ok: false, reason: `ollama answered ${res.status}` };
      const { models = [] } = await res.json();
      const names = models.map(m => m.name);
      if (!names.includes(this.model)) {
        return { ok: false, reason: `model ${this.model} not pulled`, available: names };
      }
      return { ok: true, model: this.model, available: names };
    } catch (err) {
      return { ok: false, reason: `no ollama server at ${this.host} (${err.message})` };
    }
  }

  /**
   * One completion, constrained to a JSON schema so the caller gets an object
   * rather than prose it has to parse out of a code fence.
   *
   * @param {{system?: string, prompt: string, schema: object, temperature?: number}} req
   * @returns {Promise<any>} the parsed object
   */
  async json({ system, prompt, schema, temperature = 0 }) {
    const startedAt = performance.now();
    const res = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: schema,
        options: { temperature, num_ctx: 8192 },
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) throw new Error(`local model failed (${res.status}): ${await res.text()}`);
    const payload = await res.json();
    const durationMs = performance.now() - startedAt;
    this.calls.push({
      durationMs,
      promptTokens: payload.prompt_eval_count ?? 0,
      outputTokens: payload.eval_count ?? 0,
      tokensPerSecond: payload.eval_duration ? payload.eval_count / (payload.eval_duration / 1e9) : null,
    });

    try {
      return JSON.parse(payload.message.content);
    } catch {
      throw new Error(`the model did not return JSON: ${payload.message.content.slice(0, 200)}`);
    }
  }

  stats() {
    if (!this.calls.length) return { calls: 0 };
    const total = (f) => this.calls.reduce((sum, c) => sum + (c[f] || 0), 0);
    return {
      calls: this.calls.length,
      outputTokens: total('outputTokens'),
      avgTokensPerSecond: Math.round(
        this.calls.reduce((s, c) => s + (c.tokensPerSecond || 0), 0) / this.calls.length),
      totalSeconds: Math.round(total('durationMs') / 1000),
    };
  }
}
