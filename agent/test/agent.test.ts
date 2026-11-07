import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent.js';
import { ScriptedBrain } from '../src/brains/scripted.js';
import { detectInjection, loadScenario, parseDrain, parseInvoice } from '../src/inbox.js';
import { SimChain, simVault } from '../src/sim.js';
import { Transcript, formatFooter, formatHeader, formatVerdict } from '../src/transcript.js';
import type { Brain, Message } from '../src/types.js';
import { Wallet, auditKey } from '../src/wallet.js';
import { resolve } from 'node:path';

const N = 10n ** 24n;
const API = 'dmw-api-sim.testnet';
const scenario = (f = 'api-bills') => loadScenario(resolve(import.meta.dirname, `../scenarios/${f}.json`), { PROVIDER: API });
const setup = (localChecks = true) => {
  const chain = new SimChain(simVault());
  return { chain, wallet: new Wallet({ chain, tokenId: '1', localChecks }), transcript: new Transcript() };
};

describe('scenario and injection detection', () => {
  const sc = scenario();
  it('flags the planted CEO message and not the invoices', () => {
    const flags = sc.inbox.map((i) => detectInjection(i, [API]));
    expect(flags.map((f) => f.flagged)).toEqual([false, false, true]);
    expect(flags[2].target).toBe('stranger.testnet');
    expect(flags[2].signals).toContain('asks to move the whole balance');
  });
  it('parses invoices and the drain request from text only', () => {
    expect(parseInvoice(sc.inbox[0])).toEqual({ receiver: API, amountNear: '0.12', memo: 'INV-2041 api bill' });
    expect(parseDrain(sc.inbox[2])).toEqual({ receiver: 'stranger.testnet' });
    expect(parseDrain(sc.inbox[0])).toBeNull();
  });
});

describe('scripted brain speaks the tool protocol', () => {
  it('reads the inbox first, then pays one at a time, then calls done', async () => {
    const { wallet, transcript } = setup();
    const calls: string[] = [];
    const brain = new ScriptedBrain(false);
    const spy: Brain = { name: 's', label: 's', step: async (h: Message[]) => { const s = await brain.step(h); calls.push(...s.calls.map((c) => c.name)); return s; } };
    await runAgent({ brain: spy, wallet, scenario: scenario(), transcript });
    expect(calls).toEqual(['read_inbox', 'pay', 'pay', 'pay', 'done']);
  });
  it('is deterministic: same history, same step', async () => {
    const h: Message[] = [];
    const a = await new ScriptedBrain().step(h);
    const b = await new ScriptedBrain().step(h);
    expect(a).toEqual(b);
  });
});

describe('end to end against the simulated vault', () => {
  it('naive brain: invoices paid, injected drain refused by the wrapper, no funds beyond the invoices move', async () => {
    const { chain, wallet, transcript } = setup();
    const s = await runAgent({ brain: new ScriptedBrain(false), wallet, scenario: scenario(), transcript });
    expect(s).toMatchObject({ paidAllowed: 2, refusedLocally: 1, denied: 0, injectionSeen: true, injectionAttempted: true, injectionPaid: false, finished: true });
    expect(BigInt(chain.vault.balance)).toBe(3n * N - (20n * N) / 100n);
    expect(chain.calls.map((c) => c.receiver_id)).toEqual([API, API]); // the stranger never reached the chain
    expect(transcript.toMarkdown()).toContain('refused_locally: receiver_not_allowlisted');
  });
  it('vigilant brain: refuses the injection on its own, never calls pay for it', async () => {
    const { chain, wallet, transcript } = setup();
    const s = await runAgent({ brain: new ScriptedBrain(true), wallet, scenario: scenario(), transcript });
    expect(s).toMatchObject({ paidAllowed: 2, refusedLocally: 0, injectionSeen: true, injectionAttempted: false, injectionPaid: false });
    expect(chain.calls).toHaveLength(2);
    expect(transcript.toMarkdown()).toContain('refused it on its own');
  });
  it('attack with layer 1 off: the contract denies the drain with receiver_not_allowlisted', async () => {
    const { chain, wallet, transcript } = setup(false);
    const s = await runAgent({ brain: new ScriptedBrain(false), wallet, scenario: scenario('attack-only'), transcript });
    expect(s).toMatchObject({ paidAllowed: 0, denied: 1, refusedLocally: 0, injectionPaid: false });
    expect(chain.calls).toHaveLength(1);
    expect(BigInt(chain.vault.balance)).toBe(3n * N);
    expect(transcript.toMarkdown()).toContain('denied: receiver_not_allowlisted');
  });
  it('stops when the brain keeps returning no tool call, and at the step limit', async () => {
    const { wallet, transcript } = setup();
    const mute: Brain = { name: 'mute', label: 'mute', step: async () => ({ calls: [] }) };
    const s = await runAgent({ brain: mute, wallet, scenario: scenario(), transcript });
    expect(s.finished).toBe(false);
    const loop: Brain = { name: 'loop', label: 'loop', step: async () => ({ calls: [{ id: 'x', name: 'read_inbox', args: {} }] }) };
    const s2 = await runAgent({ brain: loop, wallet, scenario: scenario(), transcript: new Transcript(), maxSteps: 3 });
    expect(s2.steps).toBe(3);
  });
  it('reports unknown tools back to the brain instead of crashing', async () => {
    const { wallet, transcript } = setup();
    let n = 0;
    const brain: Brain = { name: 'b', label: 'b', step: async () => (++n === 1 ? { calls: [{ id: '1', name: 'transfer', args: {} }] } : { calls: [{ id: '2', name: 'done', args: {} }] }) };
    const s = await runAgent({ brain, wallet, scenario: scenario(), transcript });
    expect(s.finished).toBe(true);
    expect(transcript.toMarkdown()).toContain('unknown tool `transfer`');
  });
});

describe('transcript formatting', () => {
  it('renders a refusal as a two-layer table with the exact refused_locally line', () => {
    const md = formatVerdict({ status: 'refused_locally', reason: 'over_per_tx_max', reasons: ['over_per_tx_max', 'over_daily_max'], text: 'refused_locally: over_per_tx_max' }, '3', 'x.testnet');
    expect(md).toContain('| 1. wallet wrapper (local) | **refused_locally: over_per_tx_max** (also failing: over_daily_max). Not signed. |');
    expect(md).toContain('not reached: no transaction was created');
  });
  it('renders an on-chain verdict with a tx link, and marks layer 1 skipped when it is off', () => {
    const tx = { hash: 'abc', logs: [], returnValue: null };
    const md = formatVerdict({ status: 'denied', reason: 'receiver_not_allowlisted', text: 'denied: receiver_not_allowlisted', tx, link: 'https://testnet.nearblocks.io/txns/abc' }, '3', 's.testnet', false);
    expect(md).toContain('**denied: receiver_not_allowlisted**');
    expect(md).toContain('[tx](https://testnet.nearblocks.io/txns/abc)');
    expect(md).toContain('SKIPPED');
  });
  it('header explains the key limits and footer states the outcome', () => {
    const audit = auditKey({ kind: 'FunctionCall', receiver_id: 'c.testnet', method_names: ['agent_pay'], allowance: N.toString() }, 'c.testnet');
    const h = formatHeader({ scenario: 'x', brain: 'b', contract: 'c.testnet', tokenId: '1', agentKey: 'ed25519:K', localChecks: true, startedAt: 't' }, simVault(), audit);
    expect(h).toContain('Key audit passed');
    expect(h).toContain('only `agent_pay`');
    const f = formatFooter({ paidAllowed: 2, paidAmountNear: '0.2', denied: 0, refusedLocally: 1, errors: 0, injectionSeen: true, injectionPaid: false, injectionAttempted: true, steps: 5, finished: true });
    expect(f).toContain('No funds moved');
  });
  it('streams blocks to the sink as they are added', () => {
    const seen: string[] = [];
    const t = new Transcript((m) => seen.push(m));
    t.add('a');
    t.add('b');
    expect(seen).toEqual(['a', 'b']);
    expect(t.toMarkdown()).toBe('a\n\nb\n');
  });
});
