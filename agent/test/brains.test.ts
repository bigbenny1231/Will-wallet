import { describe, expect, it } from 'vitest';
import { AnthropicBrain, OpenAICompatBrain, fromAnthropicResponse, fromOpenAIResponse, pickAnthropicModel, toAnthropicMessages, toOpenAIMessages, type FetchLike } from '../src/brains/llm.js';
import { autoBrain, makeBrain } from '../src/brains/index.js';
import { loadAgentEnv, parseDotenv } from '../src/env.js';
import type { Message } from '../src/types.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const history: Message[] = [
  { role: 'assistant', text: 'reading', calls: [{ id: 'c1', name: 'read_inbox', args: {} }] },
  { role: 'tool', callId: 'c1', name: 'read_inbox', content: '{"tasks":[]}' },
  { role: 'assistant', calls: [{ id: 'c2', name: 'pay', args: { receiver: 'a.testnet', amount_near: '0.1' } }] },
  { role: 'tool', callId: 'c2', name: 'pay', content: '{"verdict":"allowed"}' },
];

const fakeFetch = (reply: unknown, seen: { url: string; body?: any; headers?: any }[] = []): FetchLike => async (url, init) => {
  seen.push({ url, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
  return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
};

describe('LLM brains map the tool protocol', () => {
  it('anthropic: tool_use / tool_result blocks, first user turn, parsed reply', async () => {
    const msgs = toAnthropicMessages(history);
    expect(msgs[0]).toEqual({ role: 'user', content: expect.any(String) });
    expect(msgs[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 'c1', name: 'read_inbox', input: {} }] });
    expect(msgs[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"tasks":[]}' }] });
    const seen: any[] = [];
    const b = new AnthropicBrain('sk-test', 'claude-sonnet-x', fakeFetch({ content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't9', name: 'done', input: { summary: 's' } }] }, seen));
    const step = await b.step(history);
    expect(step).toEqual({ thought: 'ok', calls: [{ id: 't9', name: 'done', args: { summary: 's' } }] });
    expect(seen[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen[0].headers['x-api-key']).toBe('sk-test');
    expect(seen[0].body.tools.map((t: any) => t.name)).toEqual(['read_inbox', 'pay', 'done']);
    expect(seen[0].body.model).toBe('claude-sonnet-x');
  });
  it('anthropic: model is the newest sonnet from /v1/models, with a fallback', async () => {
    expect(await pickAnthropicModel('k', fakeFetch({ data: [{ id: 'claude-opus-9' }, { id: 'claude-sonnet-9' }, { id: 'claude-sonnet-4-5' }] }))).toBe('claude-sonnet-9');
    const broken: FetchLike = async () => ({ ok: false, status: 500, text: async () => 'x' });
    expect(await pickAnthropicModel('k', broken)).toBe('claude-sonnet-4-5');
  });
  it('openai-compatible: assistant tool_calls and tool messages, parsed reply, bearer auth', async () => {
    const msgs = toOpenAIMessages(history);
    expect(msgs[0].role).toBe('system');
    expect(msgs[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_inbox', arguments: '{}' } }] });
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"tasks":[]}' });
    const seen: any[] = [];
    const b = new OpenAICompatBrain('nearai', 'https://cloud-api.near.ai/v1', 'near-key', 'm', fakeFetch({ choices: [{ message: { role: 'assistant', content: 'hm', tool_calls: [{ id: 'x', type: 'function', function: { name: 'pay', arguments: '{"receiver":"a.testnet","amount_near":"0.1"}' } }] } }] }, seen));
    const step = await b.step([]);
    expect(step.calls).toEqual([{ id: 'x', name: 'pay', args: { receiver: 'a.testnet', amount_near: '0.1' } }]);
    expect(seen[0].url).toBe('https://cloud-api.near.ai/v1/chat/completions');
    expect(seen[0].headers.authorization).toBe('Bearer near-key');
  });
  it('tolerates malformed tool arguments and empty replies', () => {
    expect(fromOpenAIResponse({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'x', type: 'function', function: { name: 'pay', arguments: '{oops' } }] } }] }).calls[0].args).toEqual({});
    expect(fromAnthropicResponse({})).toEqual({ calls: [] });
  });
});

describe('brain selection and env hygiene', () => {
  it('auto-selects by key: Anthropic, then OpenAI, then NEAR AI, else scripted', () => {
    expect(autoBrain({})).toBe('scripted');
    expect(autoBrain({ NEAR_AI_API_KEY: 'k' })).toBe('nearai');
    expect(autoBrain({ NEAR_AI_API_KEY: 'k', OPENAI_API_KEY: 'k' })).toBe('openai');
    expect(autoBrain({ NEAR_AI_API_KEY: 'k', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' })).toBe('anthropic');
  });
  it('an LLM brain without its key fails with a clear message; scripted needs nothing', async () => {
    await expect(makeBrain('openai', {})).rejects.toThrow('OPENAI_API_KEY');
    expect((await makeBrain('scripted', {})).name).toBe('scripted');
  });
  it('the agent never loads the keeper key or the contract full-access key from the root .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-env-'));
    const f = join(dir, '.env');
    writeFileSync(f, 'DMW_CONTRACT=c.testnet\nKEEPER_PRIVATE_KEY=ed25519:SECRET1\nDMW_CONTRACT_KEY=ed25519:SECRET2\n# DMW_AGENT_KEY=ed25519:commented\nDMW_AGENT_KEY="ed25519:AGENT"\n');
    const env = loadAgentEnv([f], {});
    expect(env).toEqual({ DMW_CONTRACT: 'c.testnet', DMW_AGENT_KEY: 'ed25519:AGENT' });
    expect(parseDotenv('A=1\nexport B=2')).toEqual({ A: '1', B: '2' });
  });
});
