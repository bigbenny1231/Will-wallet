// LLM brains: Anthropic Messages API and OpenAI-compatible chat completions (OpenAI, NEAR AI).
// fetch is injectable so the request/response mapping is unit-tested without a network.
import { FIRST_USER_MESSAGE, SYSTEM_PROMPT, TOOL_SPECS } from '../tools.js';
import type { Brain, BrainStep, DecisionMeta, Message, ToolCall } from '../types.js';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>;

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

async function postJson<T>(f: FetchLike, url: string, headers: Record<string, string>, body: unknown): Promise<T> {
  const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t) as T;
}
async function getJson<T>(f: FetchLike, url: string, headers: Record<string, string>): Promise<T> {
  const r = await f(url, { method: 'GET', headers });
  const t = await r.text();
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t) as T;
}

// ------------------------------------------------------------------ Anthropic
//
// Claude through the Messages API (POST /v1/messages, anthropic-version 2023-06-01), with plain fetch: the official
// SDK is not a dependency of this package. What the code relies on:
//  - tool use with tool_choice auto (current models reject forced tool choice), one call per turn;
//  - thinking blocks are bound to the conversation: every assistant turn is replayed with its content blocks
//    unchanged, and the rest of the history is append-only, so no earlier message is ever edited;
//  - stop_reason refusal (a safety classifier declined) and max_tokens (a reply cut short) never run a tool;
//  - every request has a timeout, and transient failures (network, 408, 409, 429, 5xx, 529) are retried with backoff.
//    A model call has no side effect, so a retry cannot pay twice. Payments are never retried (near.ts).

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string };
interface AnthropicMsg {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[] | unknown[];
}
export interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: AnthropicBlock[];
  stop_reason?: string | null;
  stop_details?: { type?: string; category?: string | null; explanation?: string | null } | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Tool arguments as a plain object. A model can answer with valid JSON that is not an object (`null`, a number,
 * a string, an array); the agent loop reads properties of `args`, so anything else becomes `{}` and the tool
 * reports the missing fields back to the model instead of the run crashing (SECURITY_REVIEW_3 A-1).
 */
export function asArgs(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    // Defensive: a tool input that arrives as a JSON string is parsed, never matched as text.
    try {
      return asArgs(JSON.parse(v));
    } catch {
      return {};
    }
  }
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function toAnthropicMessages(history: Message[]): AnthropicMsg[] {
  const out: AnthropicMsg[] = [{ role: 'user', content: FIRST_USER_MESSAGE }];
  for (const m of history) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      // Replay the turn exactly as the API returned it (thinking blocks included), so the conversation-binding check
      // sees an unchanged history.
      if (m.raw?.provider === 'anthropic' && m.raw.content.length) {
        out.push({ role: 'assistant', content: m.raw.content });
        continue;
      }
      const blocks: AnthropicBlock[] = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const c of m.calls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    } else {
      const block: AnthropicBlock = { type: 'tool_result', tool_use_id: m.callId, content: m.content };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) (last.content as AnthropicBlock[]).push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

export function fromAnthropicResponse(r: AnthropicResponse): BrainStep {
  const blocks = Array.isArray(r.content) ? r.content : [];
  const text = blocks.filter((b): b is Extract<AnthropicBlock, { type: 'text' }> => b?.type === 'text').map((b) => b.text).join(' ').trim();
  const reasoning = blocks.filter((b): b is Extract<AnthropicBlock, { type: 'thinking' }> => b?.type === 'thinking').map((b) => b.thinking ?? '').join(' ').trim();
  let calls: ToolCall[] = blocks.filter((b): b is Extract<AnthropicBlock, { type: 'tool_use' }> => b?.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: asArgs(b.input) }));
  const notes: string[] = [];
  let replay = true;
  if (r.stop_reason === 'refusal') {
    const cat = r.stop_details?.category;
    notes.push(`the model declined to answer (stop_reason refusal${cat ? `, category ${cat}` : ''}). No tool was run.`);
    calls = [];
    replay = false;
  } else if (r.stop_reason === 'max_tokens') {
    if (calls.length) notes.push('the reply hit max_tokens, so its tool call may be incomplete. It was not run.');
    else notes.push('the reply hit max_tokens.');
    calls = [];
    replay = false;
  }
  const meta: DecisionMeta = {
    ...(r.model ? { model: r.model } : {}),
    ...(r.stop_reason ? { stopReason: r.stop_reason } : {}),
    ...(typeof r.usage?.input_tokens === 'number' ? { inputTokens: r.usage.input_tokens } : {}),
    ...(typeof r.usage?.output_tokens === 'number' ? { outputTokens: r.usage.output_tokens } : {}),
    ...(notes.length ? { notes } : {}),
  };
  return {
    ...(text ? { thought: text } : {}),
    calls,
    ...(reasoning ? { reasoning } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
    // A refused or truncated turn is not replayed: its tool_use (if any) gets no tool_result, which the API rejects.
    ...(replay && blocks.length ? { raw: { provider: 'anthropic', content: blocks } } : {}),
  };
}

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Models that take `thinking: {type: "adaptive"}` (and reject the older forms). Others get no thinking field. */
export const supportsAdaptiveThinking = (model: string) => /^claude-(sonnet-5|opus-5|opus-4-[678]|sonnet-4-6|haiku-5|fable-|mythos-)/.test(model);
/** Models that take the server-side refusal fallback. */
export const supportsServerFallback = (model: string) => /^claude-(sonnet-5-5|opus-5|opus-5-5|fable-5-1|fable-5-2)$/.test(model);

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export class AnthropicError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface AnthropicOpts {
  fetch?: FetchLike;
  /** Per request. Default 180 s: a thinking model can take a while on a 16k-token budget. */
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  maxTokens?: number;
  now?: () => number;
}

export class AnthropicBrain implements Brain {
  readonly name = 'anthropic';
  readonly label: string;
  private f: FetchLike;
  private timeoutMs: number;
  private retries: number;
  private sleep: (ms: number) => Promise<void>;
  private maxTokens: number;
  private now: () => number;
  /** Optional request features. One the API rejects by name is dropped for the rest of the run, and noted. */
  private useThinking: boolean;
  private useFallback: boolean;
  private pendingNotes: string[] = [];

  constructor(
    private apiKey: string,
    readonly model: string = ANTHROPIC_DEFAULT_MODEL,
    o: AnthropicOpts | FetchLike = {},
  ) {
    if (!apiKey) throw new Error('the anthropic brain needs ANTHROPIC_API_KEY (environment or the repo-root .env)');
    const opts: AnthropicOpts = typeof o === 'function' ? { fetch: o } : o;
    this.f = opts.fetch ?? defaultFetch;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.retries = opts.retries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxTokens = opts.maxTokens ?? 16_000;
    this.now = opts.now ?? Date.now;
    this.useThinking = supportsAdaptiveThinking(model);
    this.useFallback = supportsServerFallback(model);
    this.label = `anthropic ${model} (Messages API)`;
  }

  /** The request body for one decision. Exported shape is pinned by tests. */
  body(history: Message[]): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      tools: TOOL_SPECS,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: toAnthropicMessages(history),
      // Adaptive thinking with a readable summary, so the transcript can show why the model decided what it did.
      ...(this.useThinking ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      // A safety-classifier refusal is retried on a fallback model server-side; the answering model is recorded.
      ...(this.useFallback ? { fallbacks: 'default' } : {}),
    };
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      ...(this.useFallback ? { 'anthropic-beta': FALLBACK_BETA } : {}),
    };
  }

  private async once(history: Message[]): Promise<{ r: AnthropicResponse; requestId?: string }> {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        ctrl?.abort();
        rej(new AnthropicError(`no answer from the Anthropic API within ${Math.round(this.timeoutMs / 1000)} s`, undefined, true));
      }, this.timeoutMs);
    });
    try {
      const res = await Promise.race([this.f(ANTHROPIC_URL, { method: 'POST', headers: this.headers(), body: JSON.stringify(this.body(history)), signal: ctrl?.signal }), timeout]);
      const text = await Promise.race([res.text(), timeout]);
      const requestId = res.headers?.get?.('request-id') ?? undefined;
      if (!res.ok) {
        const ra = Number(res.headers?.get?.('retry-after'));
        throw new AnthropicError(`Anthropic API HTTP ${res.status}${requestId ? ` (request ${requestId})` : ''}: ${apiErrorMessage(text)}`, res.status, RETRY_STATUS.has(res.status), Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
      }
      let r: AnthropicResponse;
      try {
        r = JSON.parse(text) as AnthropicResponse;
      } catch {
        throw new AnthropicError('the Anthropic API answered with a body that is not JSON', res.status, true);
      }
      return { r, requestId };
    } catch (e) {
      if (e instanceof AnthropicError) throw e;
      // fetch itself failed: DNS, TLS, reset, abort. Transient.
      throw new AnthropicError(`cannot reach the Anthropic API: ${(e as Error)?.message ?? String(e)}`, undefined, true);
    } finally {
      clearTimeout(timer);
    }
  }

  async step(history: Message[]): Promise<BrainStep> {
    const notes = this.pendingNotes.splice(0);
    const t0 = this.now();
    for (let attempt = 0; ; attempt++) {
      try {
        const { r, requestId } = await this.once(history);
        const step = fromAnthropicResponse(r);
        const meta: DecisionMeta = { ...step.meta, ...(requestId ? { requestId } : {}), latencyMs: this.now() - t0 };
        const all = [...notes, ...(step.meta?.notes ?? [])];
        if (all.length) meta.notes = all;
        return { ...step, meta };
      } catch (e) {
        const err = e as AnthropicError;
        // A 400 that names an optional feature: drop it and ask again, rather than failing the whole run.
        if (err.status === 400 && this.useFallback && /fallback/i.test(err.message)) {
          this.useFallback = false;
          notes.push('the API rejected the server-side fallback option; continuing without it.');
          attempt--;
          continue;
        }
        if (err.status === 400 && this.useThinking && /thinking|display/i.test(err.message)) {
          this.useThinking = false;
          notes.push('the API rejected the adaptive thinking option; continuing without a reasoning summary.');
          attempt--;
          continue;
        }
        if (!err.retryable || attempt >= this.retries) throw e;
        const wait = Math.min(30_000, err.retryAfterMs ?? 2000 * 2 ** attempt);
        notes.push(`attempt ${attempt + 1} failed (${err.status ? `HTTP ${err.status}` : err.message.slice(0, 80)}); retried after ${Math.round(wait / 1000)} s.`);
        await this.sleep(wait);
      }
    }
  }
}

/** The `error.message` of an API error body, else the start of the body. Never echoes request headers. */
function apiErrorMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { type?: string; message?: string } };
    if (j?.error?.message) return `${j.error.type ? `${j.error.type}: ` : ''}${j.error.message}`.slice(0, 300);
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300);
}

// ------------------------------------------------------------------ OpenAI-compatible

interface OAIMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export function toOpenAIMessages(history: Message[]): OAIMsg[] {
  const out: OAIMsg[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: FIRST_USER_MESSAGE },
  ];
  for (const m of history) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text ?? null,
        ...(m.calls.length ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
      });
    } else out.push({ role: 'tool', tool_call_id: m.callId, content: m.content });
  }
  return out;
}

export function fromOpenAIResponse(r: { choices?: { message?: OAIMsg }[] }): BrainStep {
  const msg = r.choices?.[0]?.message;
  const calls: ToolCall[] = (msg?.tool_calls ?? []).map((c) => {
    let args: Record<string, unknown> = {};
    try {
      args = asArgs(JSON.parse(c.function.arguments || '{}'));
    } catch {
      /* malformed arguments: pass empty, the tool will report the problem back to the model */
    }
    return { id: c.id, name: c.function.name, args };
  });
  const text = (msg?.content ?? '').trim();
  return { ...(text ? { thought: text } : {}), calls };
}

export const OPENAI_TOOLS = TOOL_SPECS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

export class OpenAICompatBrain implements Brain {
  readonly label: string;
  constructor(
    readonly name: 'openai' | 'nearai',
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private f: FetchLike = defaultFetch,
  ) {
    this.label = `${name} ${model}`;
  }
  async step(history: Message[]): Promise<BrainStep> {
    const r = await postJson<{ choices?: { message?: OAIMsg }[] }>(
      this.f,
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      { model: this.model, messages: toOpenAIMessages(history), tools: OPENAI_TOOLS, tool_choice: 'auto', parallel_tool_calls: false, max_tokens: 1024 },
    );
    return fromOpenAIResponse(r);
  }
}

export const OPENAI_BASE = 'https://api.openai.com/v1';
// docs.near.ai/cloud/quickstart: OpenAI-compatible, Bearer auth.
export const NEARAI_BASE = 'https://cloud-api.near.ai/v1';
export const NEARAI_DEFAULT_MODEL = 'zai-org/GLM-5.1-FP8';

export async function pickOpenAIModel(apiKey: string, f: FetchLike = defaultFetch): Promise<string> {
  try {
    const r = await getJson<{ data: { id: string }[] }>(f, `${OPENAI_BASE}/models`, { authorization: `Bearer ${apiKey}` });
    const ranked = r.data
      .map((m) => m.id)
      .filter((id) => /^gpt-5(\.\d+)?$/.test(id))
      .sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)));
    if (ranked[0]) return ranked[0];
  } catch {
    /* fall through */
  }
  return 'gpt-4.1';
}
