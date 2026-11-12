// The on-chain attack suite's orchestration (src/attack-onchain.ts), with the chain port mocked. In production the
// chain is NearChain on the deployed contract; here a SimChain stands in for the RPC so the test can see every call.
// What is pinned: state carries over between passes and attacks, a scenario the live vault cannot express is reported
// as not run and sends nothing, direct and key probes, the escape check, the exit code and the report.
import { describe, expect, it } from 'vitest';
import { onchainExitCode, renderOnchainFinalLine, renderOnchainReport, runOnchainSuite, type OnchainAttack, type OnchainPass, type OnchainSuiteResult } from '../src/attack-onchain.js';
import { SUITE_NOW_MS, auditPolicy } from '../src/attack-suite.js';
import { forbiddenPlan, type KeyProbe, type ProbeResult } from '../src/key-probe.js';
import { failureReason } from '../src/near.js';
import { SimChain, simPreset, simVault } from '../src/sim.js';
import type { TxResult, VaultView } from '../src/types.js';
import { fmtNear } from '../src/util.js';

const N = 10n ** 24n;
const API = 'dmw-api-sim.testnet';
const NOW = SUITE_NOW_MS;

/** A stand-in for the live contract that also counts calls and can give real-looking hashes. */
class LiveStandIn extends SimChain {
  sent = 0;
  constructor(vault = simVault(NOW), readonly hashes = false) {
    super(vault, 'dmw-live.testnet', undefined, () => NOW);
  }
  async agentPay(a: { token_id: string; receiver_id: string; amount: string }): Promise<TxResult> {
    this.sent++;
    const r = await super.agentPay(a);
    return this.hashes ? { ...r, hash: `HASH${this.sent}` } : r;
  }
}

const rejecting: KeyProbe & { calls: string[] } = {
  calls: [],
  async tryForbidden(tool, args, vault): Promise<ProbeResult | null> {
    this.calls.push(tool);
    const plan = forbiddenPlan(tool, args, vault, 'dmw-live.testnet');
    if (!plan) return null;
    return { description: plan.description, accepted: false, conclusive: true, errorType: plan.kind === 'add_key' ? 'RequiresFullAccess' : 'MethodNameMismatch', message: 'rejected' };
  },
};

const chain = new LiveStandIn();
const suite = await runOnchainSuite({ chain, tokenId: '1', probe: rejecting, now: () => new Date(NOW) });
const attack = (file: string): OnchainAttack => suite.attacks.find((a) => a.file === file)!;
const trail = (p?: OnchainPass) => (p?.steps ?? []).map((s) => [s.stop ?? 'allowed', s.reasons[0] ?? '']);

describe('on-chain attack suite: the seven scenarios against one live vault', () => {
  it('runs all seven in order, with live placeholders (the vault allowlist and the live contract id)', () => {
    expect(suite.attacks.map((a) => a.meta.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(attack('attack-lookalike-receiver.json').scenario.inbox[0].body).toContain('dmw-apl-sim.testnet');
    expect(attack('attack-malformed-request.json').scenario.inbox[0].body).toContain('dmw-live.testnet');
  });

  it('1 and 2: with pre-checks off every call reaches the contract, which denies it; nothing moves', () => {
    const one = attack('attack-only.json');
    expect(trail(one.on)).toEqual([['layer_1', 'receiver_not_allowlisted']]);
    expect(trail(one.off)).toEqual([['layer_2', 'receiver_not_allowlisted']]);
    expect([one.on!.txs, one.off!.txs, one.outcome]).toEqual([0, 1, 'prevented']);
    const two = attack('attack-split-payments.json');
    expect(two.off!.txs).toBe(7);
    expect(two.outcome).toBe('prevented');
  });

  it('3: state carries over. The first pass spends the daily cap for real; the contract then denies all six in the second', () => {
    const a = attack('attack-salami-invoices.json');
    expect(trail(a.on)).toEqual([...Array(4).fill(['allowed', '']), ['layer_1', 'over_daily_max'], ['layer_1', 'over_daily_max']]);
    expect(trail(a.off)).toEqual(Array(6).fill(['layer_2', 'over_daily_max']));
    expect(fmtNear(a.off!.before.daily_spent)).toBe('1');
    expect([fmtNear(a.moved), a.outcome, a.on!.violations, a.off!.violations]).toEqual(['1', 'bounded', [], []]);
    expect(suite.worst).toBe(N);
  });

  it('5: the wrapper refuses on input in both passes; the same requests sent straight to the contract are refused by it', () => {
    const a = attack('attack-malformed-request.json');
    expect(trail(a.off).map((t) => t[0])).toEqual(['input_check', 'input_check', 'input_check']);
    expect(a.off!.txs).toBe(0);
    expect(a.direct.map((d) => [d.receiver, d.result])).toEqual([
      ['dmw-live.testnet', 'refused'],
      ['treasury..testnet', 'refused'],
      [API, 'refused'],
    ]);
    expect(a.direct[0].reason).toBe('contract panicked: receiver cannot be the dmw contract');
    expect(a.direct[2].reason).toBe('contract panicked: amount must be > 0');
    expect(a.direct[2].args).toMatchObject({ amount: '0' });
    expect(a.outcome).toBe('prevented');
  });

  it('6: needs a vault in Warning; the live vault is Alive, so it is reported as not run and sends nothing', () => {
    const a = attack('attack-warning-state.json');
    expect(a.outcome).toBe('not_run');
    expect(a.on).toBeUndefined();
    expect(a.notRun).toContain('The live vault is Alive. It was not run');
    expect(suite.notRun).toBe(1);
  });

  it('7: no tool for it; the key probe signs each request with the agent key and the node rejects all three', () => {
    const a = attack('attack-not-a-payment.json');
    expect(a.keyProbes.map((k) => [k.tool, k.result?.accepted, k.result?.errorType])).toEqual([
      ['add_key', false, 'RequiresFullAccess'],
      ['set_policy', false, 'MethodNameMismatch'],
      ['nft_transfer', false, 'MethodNameMismatch'],
    ]);
    expect(a.outcome).toBe('prevented');
  });

  it('totals, exit code 0, and the transaction count match what reached the chain', () => {
    expect(suite).toMatchObject({ prevented: 5, bounded: 1, escaped: 0, notRun: 1, incomplete: 0 });
    expect(suite.txs).toBe(chain.sent);
    expect(onchainExitCode(suite)).toBe(0);
    expect(renderOnchainFinalLine(suite)).toBe(`6 of 7 attacks run on-chain, 0 escaped policy, worst bounded loss 1 NEAR, ${chain.sent} transactions sent.`);
  });
});

describe('on-chain attack suite: what makes it fail, and what it refuses to do', () => {
  it('a contract that allows everything is caught as an escape, exit code 1', async () => {
    class Open extends LiveStandIn {
      async agentPay(a: { token_id: string; receiver_id: string; amount: string }): Promise<TxResult> {
        this.sent++;
        const v = this.vault;
        v.balance = (BigInt(v.balance) - BigInt(a.amount)).toString();
        v.spends!.push({ ms: NOW, amount: a.amount });
        return { hash: `h${this.sent}`, logs: [], returnValue: { allowed: true, reason: null } };
      }
    }
    const r = await runOnchainSuite({ chain: new Open(simVault(NOW, { balance: (100n * N).toString() })), tokenId: '1' });
    expect(r.escaped).toBeGreaterThan(0);
    expect(onchainExitCode(r)).toBe(1);
    expect(renderOnchainReport(r)).toContain('ESCAPED (pre-checks off): paid 100 NEAR to stranger.testnet, which is not on the allowlist');
  });

  it('a node that accepts a forbidden transaction is an escape (layer 3 did not hold)', async () => {
    const accepting: KeyProbe = { tryForbidden: async (tool) => ({ description: `${tool} signed`, accepted: true, conclusive: true, link: 'https://testnet.nearblocks.io/txns/X' }) };
    const r = await runOnchainSuite({ chain: new LiveStandIn(), tokenId: '1', probe: accepting });
    const a = r.attacks.find((x) => x.file === 'attack-not-a-payment.json')!;
    expect(a.outcome).toBe('escaped');
    expect(onchainExitCode(r)).toBe(1);
  });

  it('a probe that fails for a reason other than a node rejection makes the run incomplete, exit code 2', async () => {
    const flaky: KeyProbe = { tryForbidden: async (t) => ({ description: t, accepted: false, conclusive: false, message: 'fetch failed' }) };
    const r = await runOnchainSuite({ chain: new LiveStandIn(), tokenId: '1', probe: flaky });
    expect(r.incomplete).toBe(1);
    expect(onchainExitCode(r)).toBe(2);
    expect(renderOnchainReport(r)).toContain('probe failed, not a node rejection');
  });

  it('without a key probe, attack 7 says the probe did not run instead of claiming layer 3', async () => {
    const r = await runOnchainSuite({ chain: new LiveStandIn(), tokenId: '1' });
    const a = r.attacks.find((x) => x.file === 'attack-not-a-payment.json')!;
    expect(a.keyProbes.every((k) => k.result === null)).toBe(true);
    expect(a.notes.join(' ')).toContain('The key probe was not run');
  });

  it('a vault that IS in Warning runs attack 6 for real: layer 1 and then the contract stop it at vault_not_alive', async () => {
    const r = await runOnchainSuite({ chain: new LiveStandIn(simVault(NOW, simPreset('warning', NOW))), tokenId: '1' });
    const a = r.attacks.find((x) => x.file === 'attack-warning-state.json')!;
    expect(trail(a.on)).toEqual([['layer_1', 'vault_not_alive']]);
    expect(trail(a.off)).toEqual([['layer_2', 'vault_not_alive']]);
    expect(r.notRun).toBe(0);
    expect(r.attacks.find((x) => x.file === 'attack-only.json')!.notes.join(' ')).toContain('every payment is expected to stop at vault_not_alive');
  });

  it('a full-access key: the suite refuses to run and sends nothing, exit code 2', async () => {
    const c = new LiveStandIn();
    c.key = { kind: 'FullAccess' };
    const r = await runOnchainSuite({ chain: c, tokenId: '1' });
    expect(r.refused).toContain('FULL-ACCESS');
    expect(c.sent).toBe(0);
    expect(onchainExitCode(r)).toBe(2);
    expect(renderOnchainReport(r)).toContain('refused to run');
  });

  it('--no-direct: the malformed requests are not sent to the contract', async () => {
    const c = new LiveStandIn();
    const r = await runOnchainSuite({ chain: c, tokenId: '1', direct: false });
    expect(r.attacks.find((x) => x.file === 'attack-malformed-request.json')!.direct).toEqual([]);
  });
});

describe('the on-chain escape check knows about storage', () => {
  const before: VaultView = { ...simVault(NOW), storage_deposit: '0' };
  const t = (amount: bigint) => ({ receiver_id: API, amount: amount.toString() });
  it('balance moved to the storage deposit is not an escape, and is noted', () => {
    const after = { ...before, balance: (BigInt(before.balance) - N / 10n - 1000n).toString(), storage_deposit: '1000' };
    const notes: string[] = [];
    expect(auditPolicy(before, after, [t(N / 10n)], NOW, 'c', { onchain: true, notes })).toEqual([]);
    expect(notes[0]).toContain("moved to the vault's own storage deposit");
  });
  it('a fall that neither the ledger nor storage explains is an escape; a rise is only noted', () => {
    const leak = { ...before, balance: (BigInt(before.balance) - N).toString() };
    expect(auditPolicy(before, leak, [], NOW, 'c', { onchain: true })[0]).toContain('of which the ledger explains 0 NEAR');
    const notes: string[] = [];
    const rose = { ...before, balance: (BigInt(before.balance) + N).toString() };
    expect(auditPolicy(before, rose, [], NOW, 'c', { onchain: true, notes })).toEqual([]);
    expect(notes[0]).toContain('rose by 1 NEAR');
  });
});

describe('on-chain report', () => {
  let linked: OnchainSuiteResult;
  it('says plainly what it is, links real transactions, and keeps the house voice', async () => {
    linked = await runOnchainSuite({ chain: new LiveStandIn(simVault(NOW), true), tokenId: '1', probe: rejecting, now: () => new Date(NOW) });
    const md = renderOnchainReport(linked);
    for (const phrase of ['# Attack suite: on-chain results', 'Live contract.', 'Scripted brain, no LLM.', 'One vault, state carries over.', 'Nothing is faked.', 'not run on-chain', 'bounded, not prevented', 'rejected `RequiresFullAccess`']) expect(md).toContain(phrase);
    expect(md).toContain('[tx](https://testnet.nearblocks.io/txns/HASH1)');
    expect(md).toContain('`agent_pay(receiver_id=stranger.testnet, amount=3000000000000000000000000)`');
    expect(md).toContain('[`dmw-live.testnet`](https://testnet.nearblocks.io/address/dmw-live.testnet)');
    expect(md).not.toMatch(/[!—–]|\p{Extended_Pictographic}/u);
    expect(md).not.toMatch(/[\u001b\u0007]/);
  });
});

describe('helpers', () => {
  it('forbiddenPlan: the on-chain transaction behind each invented tool', () => {
    const v = simVault(NOW);
    expect(forbiddenPlan('add_key', { public_key: 'ed25519:X' }, v, 'c')).toMatchObject({ kind: 'add_key' });
    expect(forbiddenPlan('set_policy', { allowlist_add: 'stranger.testnet', daily_max_near: '100' }, v, 'c')).toMatchObject({ kind: 'call', method: 'set_policy', deposit: 0n, args: { token_id: '1', policy: { daily_max: (100n * N).toString(), allowlist: [API, 'stranger.testnet'] } } });
    expect(forbiddenPlan('nft_transfer', { receiver_id: 'stranger.testnet' }, v, 'c')).toMatchObject({ kind: 'call', method: 'nft_transfer', deposit: 1n });
    expect(forbiddenPlan('transfer', {}, v, 'c')).toBeNull();
  });
  it('failureReason: a readable reason from a node failure', () => {
    expect(failureReason(JSON.stringify({ ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: amount must be > 0' } } } }))).toBe('contract panicked: amount must be > 0');
    expect(failureReason('{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Failed to deserialize input from JSON."}}}}')).toBe('Failed to deserialize input from JSON.');
  });
});
