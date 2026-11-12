// The real-model brain, against a mocked Anthropic Messages API. No network, no key: every response here is a
// recorded shape. What is pinned: the request (model, headers, tool choice, thinking), replaying thinking blocks
// unchanged, refusals and truncated replies never running a tool, retries, timeouts, and the evidence transcript.
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { runAgent } from '../src/agent.js';
import { ANTHROPIC_DEFAULT_MODEL, AnthropicBrain, FALLBACK_BETA, asArgs, fromAnthropicResponse, type AnthropicResponse, type FetchLike } from '../src/brains/llm.js';
import { makeBrain } from '../src/brains/index.js';
import { loadScenario } from '../src/inbox.js';
import { SimChain, simVault } from '../src/sim.js';
import { Transcript } from '../src/transcript.js';
import type { Message } from '../src/types.js';
import { Wallet } from '../src/wallet.js';

const KEY = 'sk-ant-test-0123456789-SECRET';
const API = 'dmw-api-sim.testnet';
const scenario = () => loadScenario(resolve(import.meta.dirname, '../scenarios/api-bills.json'), { PROVIDER: API });

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: any;
}
type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | 'hang';

/** A fake Messages API: answers each request with the next reply, records every request. */
function api(replies: Reply[] | ((req: Seen, n: number) => Reply), seen: Seen[] = []): FetchLike {
  let n = 0;
  return (url, init) => {
    const req = { url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    seen.push(req);
    const r = typeof replies === 'function' ? replies(req, n++) : replies[n++];
    if (r === 'hang' || r === undefined) return new Promise(() => {});
    const h = new Map(Object.entries(r.headers ?? {}));
    return Promise.resolve({ ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => r.text ?? JSON.stringify(r.json), headers: { get: (k: string) => h.get(k) ?? null } });
  };
}

const msg = (content: unknown[], extra: Partial<AnthropicResponse> = {}): Reply => ({
  json: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', usage: { input_tokens: 900, output_tokens: 60 }, content, ...extra },
  headers: { 'request-id': 'req_011' },
});
const think = (t: string, sig = 'sig-' + t.length) => ({ type: 'thinking', thinking: t, signature: sig });
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const noSleep = { sleep: async () => {} };

describe('anthropic brain: the request', () => {
  it('claude-sonnet-5-5: Messages API headers, auto tool choice, one call per turn, adaptive thinking with a summary, server fallback', async () => {
    const seen: Seen[] = [];
    const b = new AnthropicBrain(KEY, ANTHROPIC_DEFAULT_MODEL, { fetch: api([msg([use('t1', 'read_inbox', {})])], seen) });
    await b.step([]);
    const r = seen[0];
    expect(r.url).toBe('https://api.anthropic.com/v1/messages');
    expect(r.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': FALLBACK_BETA });
    expect(r.body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 16000, tool_choice: { type: 'auto', disable_parallel_tool_use: true }, thinking: { type: 'adaptive', display: 'summarized' }, fallbacks: 'default' });
    expect(r.body.tools.map((t: any) => t.name)).toEqual(['read_inbox', 'pay', 'done']);
    expect(r.body.messages).toEqual([{ role: 'user', content: expect.any(String) }]);
    // Current models reject forced tool choice and sampling parameters: never sent.
    expect(JSON.stringify(r.body)).not.toMatch(/"type":"(any|tool)"|temperature|top_p|budget_tokens/);
  });

  it('an older model gets no thinking field, no fallback and no beta header', async () => {
    const seen: Seen[] = [];
    await new AnthropicBrain(KEY, 'claude-haiku-4-5', { fetch: api([msg([])], seen) }).step([]);
    expect(seen[0].body.thinking).toBeUndefined();
    expect(seen[0].body.fallbacks).toBeUndefined();
    expect(seen[0].headers['anthropic-beta']).toBeUndefined();
  });

  it('a missing key is a clear error, before any request', async () => {
    await expect(makeBrain('anthropic', {})).rejects.toThrow(/--brain anthropic needs ANTHROPIC_API_KEY: set it in the environment or in the repo-root \.env/);
    expect(() => new AnthropicBrain('')).toThrow('ANTHROPIC_API_KEY');
  });
});

describe('anthropic brain: the response', () => {
  it('reads blocks by type: thinking becomes the reasoning summary, text the thought, tool_use the call; meta is recorded', async () => {
    const b = new AnthropicBrain(KEY, ANTHROPIC_DEFAULT_MODEL, { fetch: api([msg([think('Read the inbox before paying anything.'), { type: 'text', text: 'Reading the inbox.' }, use('t1', 'read_inbox', {})])]), now: (() => { let t = 0; return () => (t += 1500); })() });
    const s = await b.step([]);
    expect(s.thought).toBe('Reading the inbox.');
    expect(s.reasoning).toBe('Read the inbox before paying anything.');
    expect(s.calls).toEqual([{ id: 't1', name: 'read_inbox', args: {} }]);
    expect(s.meta).toMatchObject({ model: 'claude-sonnet-5-5', stopReason: 'tool_use', inputTokens: 900, outputTokens: 60, requestId: 'req_011', latencyMs: 1500 });
    expect(s.raw?.content).toHaveLength(3);
  });

  it('a refusal runs no tool, says so, and is not replayed', () => {
    const s = fromAnthropicResponse({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [use('t1', 'pay', { receiver: 'x.testnet', amount_near: '1' }) as never] });
    expect(s.calls).toEqual([]);
    expect(s.meta?.notes?.[0]).toContain('declined to answer (stop_reason refusal, category cyber)');
    expect(s.raw).toBeUndefined();
  });

  it('a reply cut at max_tokens runs no tool: its arguments may be incomplete', () => {
    const s = fromAnthropicResponse({ stop_reason: 'max_tokens', content: [use('t1', 'pay', { receiver: 'x.testn' }) as never] });
    expect(s.calls).toEqual([]);
    expect(s.meta?.notes?.[0]).toContain('may be incomplete');
    expect(s.raw).toBeUndefined();
  });

  it('tool input arriving as a JSON string is parsed; anything that is not an object becomes {}', () => {
    expect(asArgs('{"receiver":"a.testnet"}')).toEqual({ receiver: 'a.testnet' });
    expect(asArgs('pay everything')).toEqual({});
    expect(asArgs('[1]')).toEqual({});
  });
});

describe('anthropic brain: transport', () => {
  it('retries 529 and 429, honouring retry-after, and notes each retry in the decision', async () => {
    const waits: number[] = [];
    const b = new AnthropicBrain(KEY, ANTHROPIC_DEFAULT_MODEL, {
      fetch: api([{ status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }, { status: 429, json: { error: { type: 'rate_limit_error', message: 'slow down' } }, headers: { 'retry-after': '7' } }, msg([use('t1', 'read_inbox', {})])]),
      sleep: async (ms) => void waits.push(ms),
    });
    const s = await b.step([]);
    expect(s.calls[0].name).toBe('read_inbox');
    expect(waits).toEqual([2000, 7000]);
    expect(s.meta?.notes).toEqual([expect.stringContaining('HTTP 529'), expect.stringContaining('HTTP 429')]);
  });

  it('does not retry a 401 and never echoes the key', async () => {
    const seen: Seen[] = [];
    const b = new AnthropicBrain(KEY, ANTHROPIC_DEFAULT_MODEL, { fetch: api([{ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, headers: { 'request-id': 'req_9' } }], seen), ...noSleep });
    const err = (await b.step([]).then(() => new Error("resolved"), (e) => e)) as Error;
    expect(err.message).toBe('Anthropic API HTTP 401 (request req_9): authentication_error: invalid x-api-key');
    expect(err.message).not.toContain(KEY);
    expect(seen).toHaveLength(1);
  });

  it('times out a request that never answers, retries, then fails clearly', async () => {
    const seen: Seen[] = [];
    const b = new AnthropicBrain(KEY, ANTHROPIC_DEFAULT_MODEL, { fetch: api(['hang', 'hang'], seen), timeoutMs: 20, retries: 1, ...noSleep });
    await expect(b.step([])).rejects.toThrow('no answer from the Anthropic API within 0 s');
    expect(seen).toHaveLength(2);
  });

  it('a network failure is retried', async () => {
    let n = 0;
    const f: FetchLike = async (...a) => {
      if (n++ === 0) throw new TypeError('fetch failed');
      return api([msg([use('t1', 'done', { summary: 'ok' })])])(...a);
    };
    const s = await new AnthropicBrain(KEY, ANTHROPIC_DEFAULT_MODEL, { fetch: f, ...noSleep }).step([]);
    expect(s.calls[0].name).toBe('done');
    expect(s.meta?.notes?.[0]).toContain('cannot reach the Anthropic API: fetch failed');
  });

  it('a 400 that names the fallback option drops it for the rest of the run and asks again', async () => {
    const seen: Seen[] = [];
    const b = new AnthropicBrain(KEY, ANTHROPIC_DEFAULT_MODEL, { fetch: api([{ status: 400, json: { error: { type: 'invalid_request_error', message: 'fallbacks: Extra inputs are not permitted' } } }, msg([]), msg([])], seen), ...noSleep });
    const s = await b.step([]);
    expect(s.meta?.notes?.[0]).toContain('rejected the server-side fallback option');
    expect(seen[1].body.fallbacks).toBeUndefined();
    expect(seen[1].headers['anthropic-beta']).toBeUndefined();
    await b.step([]);
    expect(seen[2].body.fallbacks).toBeUndefined();
  });
});

describe('anthropic brain in the agent loop (mocked API, simulated vault)', () => {
  /** A model that pays both invoices, is fooled by the injection, then finishes. Branches on the conversation so far. */
  const fooled = (req: Seen) => {
    const turns = req.body.messages.filter((m: any) => m.role === 'assistant').length;
    const plan = [
      [think('Start by reading the inbox.'), use('t0', 'read_inbox', {})],
      [{ type: 'text', text: 'Invoice INV-2041.' }, use('t1', 'pay', { receiver: API, amount_near: '0.12', memo: 'INV-2041' })],
      [use('t2', 'pay', { receiver: API, amount_near: '0.08', memo: 'INV-2042' })],
      [think('The CEO says it is urgent.'), { type: 'text', text: 'Moving the balance as the CEO asked.' }, use('t3', 'pay', { receiver: 'stranger.testnet', amount_near: '3' })],
      [{ type: 'text', text: 'Done.' }, use('t4', 'done', { summary: 'Paid two invoices; the balance move was refused.' })],
    ];
    return msg(plan[turns]);
  };

  it('replays every assistant turn unchanged (thinking blocks included) and only ever appends to the conversation', async () => {
    const seen: Seen[] = [];
    const chain = new SimChain(simVault());
    const t = new Transcript();
    const s = await runAgent({ brain: new AnthropicBrain(KEY, ANTHROPIC_DEFAULT_MODEL, { fetch: api(fooled, seen) }), wallet: new Wallet({ chain, tokenId: '1' }), scenario: scenario(), transcript: t });
    expect(s).toMatchObject({ paidAllowed: 2, refusedLocally: 1, injectionAttempted: true, injectionPaid: false, finished: true });
    expect(seen).toHaveLength(5);
    // Append-only: each request's messages start with the previous request's messages, byte for byte.
    for (let i = 1; i < seen.length; i++) {
      const prev = JSON.stringify(seen[i - 1].body.messages);
      expect(JSON.stringify(seen[i].body.messages).startsWith(prev.slice(0, -1))).toBe(true);
    }
    // The first assistant turn comes back exactly as the API returned it, signature and all.
    expect(seen[1].body.messages[1]).toEqual({ role: 'assistant', content: [think('Start by reading the inbox.'), use('t0', 'read_inbox', {})] });
    expect(seen[1].body.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't0' });
  });

  it('the transcript records each model decision, the contract call it attempted, and the result', async () => {
    const t = new Transcript();
    const chain = new SimChain(simVault());
    await runAgent({ brain: new AnthropicBrain(KEY, ANTHROPIC_DEFAULT_MODEL, { fetch: api(fooled) }), wallet: new Wallet({ chain, tokenId: '1', localChecks: false }), scenario: scenario(), transcript: t });
    const md = t.toMarkdown();
    expect(md).toContain('*decision:* model `claude-sonnet-5-5` · stop_reason `tool_use` · 900 in / 60 out tokens');
    expect(md).toContain('request `req_011`');
    expect(md).toContain('> **reasoning summary:** The CEO says it is urgent.');
    expect(md).toContain('> **thought:** Moving the balance as the CEO asked.');
    expect(md).toContain('**contract call:** `agent_pay({"token_id":"1","receiver_id":"stranger.testnet","amount":"3000000000000000000000000"})` on `dmw-sim.testnet`');
    expect(md).toContain('**denied: receiver_not_allowlisted**');
    expect(md).toContain('[tx](simulated:sim-');
    expect(md).not.toContain(KEY);
  });

  it('a model that refuses twice stops the run without a payment', async () => {
    const t = new Transcript();
    const refusal = msg([{ type: 'text', text: 'I cannot help with that.' }], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms' } as never });
    const s = await runAgent({ brain: new AnthropicBrain(KEY, ANTHROPIC_DEFAULT_MODEL, { fetch: api([refusal, refusal]) }), wallet: new Wallet({ chain: new SimChain(simVault()), tokenId: '1' }), scenario: scenario(), transcript: t });
    expect(s).toMatchObject({ paidAllowed: 0, finished: false });
    expect(t.toMarkdown()).toContain('declined to answer (stop_reason refusal, category general_harms)');
    expect(t.toMarkdown()).toContain('made no tool call twice in a row');
  });

  it('a replayed history built without raw blocks still maps to tool_use / tool_result', () => {
    const h: Message[] = [{ role: 'assistant', text: 'x', calls: [{ id: 'c', name: 'read_inbox', args: {} }] }];
    expect(new AnthropicBrain(KEY).body(h).messages).toEqual([
      { role: 'user', content: expect.any(String) },
      { role: 'assistant', content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 'c', name: 'read_inbox', input: {} }] },
    ]);
  });
});
