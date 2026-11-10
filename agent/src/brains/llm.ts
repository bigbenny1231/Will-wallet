// LLM brains: Anthropic Messages API and OpenAI-compatible chat completions (OpenAI, NEAR AI).
// fetch is injectable so the request/response mapping is unit-tested without a network.
import { FIRST_USER_MESSAGE, SYSTEM_PROMPT, TOOL_SPECS } from '../tools.js';
import type { Brain, BrainStep, Message, ToolCall } from '../types.js';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

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

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };
interface AnthropicMsg {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

/**
 * Tool arguments as a plain object. A model can answer with valid JSON that is not an object (`null`, a number,
 * a string, an array); the agent loop reads properties of `args`, so anything else becomes `{}` and the tool
 * reports the missing fields back to the model instead of the run crashing (SECURITY_REVIEW_3 A-1).
 */
export function asArgs(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function toAnthropicMessages(history: Message[]): AnthropicMsg[] {
  const out: AnthropicMsg[] = [{ role: 'user', content: FIRST_USER_MESSAGE }];
  for (const m of history) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const c of m.calls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    } else {
      const block: AnthropicBlock = { type: 'tool_result', tool_use_id: m.callId, content: m.content };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

export function fromAnthropicResponse(r: { content?: AnthropicBlock[] }): BrainStep {
  const text = (r.content ?? []).filter((b): b is Extract<AnthropicBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join(' ').trim();
  const calls: ToolCall[] = (r.content ?? []).filter((b): b is Extract<AnthropicBlock, { type: 'tool_use' }> => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: asArgs(b.input) }));
  return { ...(text ? { thought: text } : {}), calls };
}

/** Newest Claude Sonnet the key can see, via GET /v1/models (newest first). Falls back to claude-sonnet-4-5. */
export async function pickAnthropicModel(apiKey: string, f: FetchLike = defaultFetch): Promise<string> {
  try {
    const r = await getJson<{ data: { id: string }[] }>(f, 'https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
    const sonnet = r.data.map((m) => m.id).find((id) => /^claude-sonnet/.test(id));
    if (sonnet) return sonnet;
  } catch {
    /* fall through */
  }
  return 'claude-sonnet-4-5';
}

export class AnthropicBrain implements Brain {
  readonly name = 'anthropic';
  readonly label: string;
  constructor(
    private apiKey: string,
    private model: string,
    private f: FetchLike = defaultFetch,
  ) {
    this.label = `anthropic ${model}`;
  }
  async step(history: Message[]): Promise<BrainStep> {
    const r = await postJson<{ content?: AnthropicBlock[] }>(
      this.f,
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      {
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOL_SPECS,
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        messages: toAnthropicMessages(history),
      },
    );
    return fromAnthropicResponse(r);
  }
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
