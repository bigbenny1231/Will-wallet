import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { agentDemo, planDemoCalls } from '../src/commands/agentDemo.js';
import { daoArgs, nearCliCommand, validDaoName } from '../src/commands/dao.js';
import { startPulse } from '../src/commands/pulse.js';
import { driveVault, makeDeps, runKeeper, tickOnce, type Logger } from '../src/keeperLoop.js';
import { MockBackend, mockChains, mockPaths } from '../src/mock.js';
import { bumpedEvmArgs, clampEvm, msUntilResign } from '../src/resign.js';
import { seedBackend } from './helpers.js';
import { backoffDelay, foreignTxLink, isTransient, nearTxLink, parseEvents, withRetry } from '../src/util.js';

const quiet: Logger = { ok() {}, warn() {}, err() {}, info() {} };
const fresh = (clock: { t: number }, seed = {}) => {
  const file = join(mkdtempSync(join(tmpdir(), 'dmw-')), 'm.json');
  const b = new MockBackend(file, () => clock.t, { heartbeat_interval_s: 10, grace_missed: 1, ...seed });
  return b;
};

describe('keeper loop against the mock vault', () => {
  it('does nothing while the vault is healthy', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock);
    const deps = makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log: quiet });
    expect((await tickOnce(deps)).actions).toEqual([]);
  });

  it('pokes, settles, relays and marks every payout in one tick', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock);
    await backend.getVaults(); // seed
    clock.t += 25_000;
    const deps = makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log: quiet });
    const r = await tickOnce(deps);
    expect(r.error).toBeUndefined();
    const v = await backend.getVault('1');
    expect(v.state).toBe('Settled');
    expect(v.foreign.map((p) => p.status)).toEqual(['broadcast', 'broadcast']);
    expect(v.foreign.every((p) => p.tx_hash)).toBe(true);
    const kinds = r.actions.map((a) => a.kind);
    expect(kinds[0]).toBe('poke');
    expect(kinds.filter((k) => k === 'broadcast')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'mark')).toHaveLength(2);
    expect((await tickOnce(deps)).actions).toEqual([]); // idempotent
  });

  it('a heartbeat keeps the keeper away', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock);
    await backend.getVaults();
    clock.t += 15_000;
    await backend.heartbeat('1');
    clock.t += 15_000;
    const deps = makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log: quiet });
    expect((await tickOnce(deps)).actions).toEqual([]);
  });

  it('survives RPC errors: tick reports them and the loop keeps going with backoff', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock);
    let calls = 0;
    const orig = backend.getVaults.bind(backend);
    backend.getVaults = async () => {
      if (calls++ < 2) throw new Error('fetch failed');
      return orig();
    };
    const deps = makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log: quiet });
    const ac = new AbortController();
    const sleeps: number[] = [];
    await runKeeper(deps, {
      pollS: 5,
      signal: ac.signal,
      sleepFn: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 3) ac.abort();
      },
    });
    expect(calls).toBe(3);
    expect(sleeps[0]).toBe(10_000); // 1 error  -> 2x
    expect(sleeps[1]).toBe(20_000); // 2 errors -> 4x
    expect(sleeps[2]).toBe(5_000); // recovered
  });

  it('a chain-params failure on step 3 is logged, not thrown, and resumes next tick', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock);
    await backend.getVaults();
    clock.t += 25_000;
    const chains = mockChains();
    const good = chains.evmParams;
    let fail = true;
    chains.evmParams = async (a) => {
      if (fail) throw new Error('not wired: evm params');
      return good(a);
    };
    const errs: string[] = [];
    const deps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: { ...quiet, err: (_t, m) => errs.push(m) } });
    const r1 = await tickOnce(deps);
    expect(r1.error).toBe('action_failed');
    expect(errs.join()).toMatch(/not wired/);
    expect((await backend.getVault('1')).step).toBe(3);
    fail = false;
    await tickOnce(deps);
    expect((await backend.getVault('1')).state).toBe('Settled');
  });

  it('re-marks without re-broadcasting when mark_broadcast failed earlier', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock, { foreign: 'base' });
    await backend.getVaults();
    clock.t += 25_000;
    const chains = mockChains();
    const send = vi.spyOn(chains, 'broadcastEvm');
    const realMark = backend.markBroadcast.bind(backend);
    let boom = true;
    backend.markBroadcast = async (...a) => {
      if (boom) {
        boom = false;
        throw new Error('fetch failed');
      }
      return realMark(...a);
    };
    const deps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: quiet });
    await driveVault(deps, (await backend.getVaults())[0]);
    await tickOnce(deps);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await backend.getVault('1')).foreign[0].status).toBe('broadcast');
  });
});

describe('relay failures', () => {
  it('an unfunded source parks the payout (status stays signed) and never blocks settlement', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock);
    await backend.getVaults();
    clock.t += 25_000;
    const chains = mockChains();
    chains.broadcastEvm = async () => {
      throw new Error('eth_sendRawTransaction: insufficient funds for gas * price + value: have 0 want 1');
    };
    chains.broadcastSolana = async () => {
      throw new Error('sendTransaction: Transaction simulation failed {"err":"AccountNotFound"}');
    };
    const warns: string[] = [];
    const deps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: { ...quiet, warn: (_t, m) => warns.push(m) } });
    const r = await tickOnce(deps);
    expect(r.error).toBeUndefined(); // unfunded is expected, not an action failure
    const v = await backend.getVault('1');
    expect(v.state).toBe('Settled');
    expect(v.foreign.map((p) => p.status)).toEqual(['signed', 'signed']);
    expect(warns.filter((w) => /unfunded/.test(w))).toHaveLength(2);
    // inside the cooldown nothing is retried; after it the keeper tries again
    const send = vi.spyOn(chains, 'broadcastEvm');
    await tickOnce(deps);
    expect(send).not.toHaveBeenCalled();
    clock.t += 61_000;
    await tickOnce(deps);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('after the cooldown a still-stale solana tx is re-signed by the keeper, unless the old signature landed', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock, { foreign: 'solana' });
    await backend.getVaults();
    clock.t += 25_000;
    const chains = mockChains();
    let stale = true;
    chains.broadcastSolana = async (raw) => {
      if (stale) throw new Error('sendTransaction: Blockhash not found');
      return `mocksolsig${raw.slice(-6)}`;
    };
    const resign = vi.spyOn(backend, 'resignForeign');
    const deps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: quiet });
    await tickOnce(deps);
    clock.t += 310_000;
    // old signature landed: record it, never sign again
    chains.txLanded = async () => true;
    const landedDeps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: quiet });
    await tickOnce(landedDeps);
    expect(resign).not.toHaveBeenCalled();
    expect((await backend.getVault('1')).foreign[0].status).toBe('broadcast');
  });

  it('re-signs a never-landed stale solana payout once allowed, then relays the new signature', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock, { foreign: 'solana' });
    await backend.getVaults();
    clock.t += 25_000;
    const chains = mockChains();
    let calls = 0;
    chains.broadcastSolana = async (raw) => {
      if (++calls === 1) throw new Error('sendTransaction: Blockhash not found');
      return `mocksolsig${raw.slice(-6)}`;
    };
    const resign = vi.spyOn(backend, 'resignForeign');
    const deps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: quiet });
    await tickOnce(deps); // stale, parked until allowed
    expect(resign).not.toHaveBeenCalled();
    clock.t += 310_000;
    // first retry after the wait would succeed in this mock; force it stale once more
    calls = 0;
    await tickOnce(deps);
    expect(resign).toHaveBeenCalledTimes(1);
    const v = await backend.getVault('1');
    expect(v.foreign[0].status).toBe('broadcast');
    expect(v.foreign[0].signed_tx!.endsWith('r')).toBe(true);
  });

  it('EVM re-sign waits, then sends max(fresh, 1.1 x last) for both fees', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock, { foreign: 'base' });
    await backend.getVaults();
    clock.t += 25_000;
    const chains = mockChains();
    let n = 0;
    chains.broadcastEvm = async (raw) => {
      if (++n <= 2) throw new Error('eth_sendRawTransaction: replacement transaction underpriced');
      return `mock0xevm${raw.slice(-6)}`;
    };
    const resign = vi.spyOn(backend, 'resignForeign');
    const deps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: quiet });
    await tickOnce(deps);
    expect(resign).not.toHaveBeenCalled();
    clock.t += 310_000;
    await tickOnce(deps);
    expect(resign).toHaveBeenCalledTimes(1);
    const sent = resign.mock.calls[0][2].evm!;
    expect(sent.max_fee_per_gas).toBe('1650000000'); // 1.1 x 1.5 gwei
    expect(sent.max_priority_fee_per_gas).toBe('1100000');
    expect(sent.gas_limit).toBe('21000');
    expect((await backend.getVault('1')).foreign[0].status).toBe('broadcast');
  });

  it('monad payout: EVM args for the monad chain, relayed through the monad RPC, linked on monadexplorer', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock, { foreign: 'monad' });
    await backend.getVaults();
    clock.t += 25_000;
    const chains = mockChains();
    const params = vi.spyOn(chains, 'evmParams');
    const bcast = vi.spyOn(chains, 'broadcastEvm');
    const deps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: quiet });
    const r = await tickOnce(deps);
    expect(r.error).toBeUndefined();
    // the source is derived from the vault's monad path (v2), not the owner-typed from_address
    expect(params).toHaveBeenCalledWith((await chains.deriveAddresses('c', mockPaths('1'))).monad, 'monad');
    expect(bcast.mock.calls[0][1]).toBe('monad');
    const v = await backend.getVault('1');
    expect(v.foreign[0].chain).toBe('monad');
    expect(v.foreign[0].status).toBe('broadcast');
    expect(foreignTxLink('monad', '0xabc')).toBe('https://testnet.monadexplorer.com/tx/0xabc');
  });

  it('K-1: a malformed from_address is never sent to the RPC; the derived address is used and step 3 goes through', async () => {
    for (const bad of ['yyyy', '', '0x1234', 'not an address; DROP', '0x' + 'g'.repeat(40)]) {
      const clock = { t: 1_000_000 };
      const { backend } = seedBackend(clock, [{ foreign: 'base', patch: (v) => void (v.foreign[0].from_address = bad) }]);
      await backend.getVaults();
      clock.t += 25_000;
      const chains = mockChains();
      // a real node rejects a malformed address: fail the test the same way if one ever reaches it
      chains.evmParams = vi.fn(async (from: string) => {
        if (!/^0x[0-9a-fA-F]{40}$/.test(from) && !from.startsWith('0xMOCK')) throw new Error(`eth_getTransactionCount: invalid argument 0: ${from} (-32602)`);
        return { nonce: 0, max_fee_per_gas: '1500000000', max_priority_fee_per_gas: '1000000', gas_limit: '21000' };
      });
      const deps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: quiet });
      const r = await tickOnce(deps);
      expect(r.error, `from_address ${JSON.stringify(bad)}`).toBeUndefined();
      const derived = (await chains.deriveAddresses('c', mockPaths('1'))).base;
      expect(chains.evmParams).toHaveBeenCalledWith(derived, 'base');
      expect((await backend.getVault('1')).state, `from_address ${JSON.stringify(bad)}`).toBe('Settled');
    }
  });

  it('v2: a well-formed but wrong owner-typed from_address is ignored; the address derived from derivation_paths is used', async () => {
    const clock = { t: 1_000_000 };
    const typed = '0x' + '12'.repeat(20);
    const { backend } = seedBackend(clock, [{ foreign: 'base', patch: (v) => void (v.foreign[0].from_address = typed) }]);
    await backend.getVaults();
    clock.t += 25_000;
    const chains = mockChains();
    const derive = vi.spyOn(chains, 'deriveAddresses');
    chains.evmParams = vi.fn(async () => ({ nonce: 0, max_fee_per_gas: '1500000000', max_priority_fee_per_gas: '1000000', gas_limit: '21000' }));
    const deps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: quiet });
    await tickOnce(deps);
    expect(derive).toHaveBeenCalledWith('c', mockPaths('1'));
    const derived = (await chains.deriveAddresses('c', mockPaths('1'))).base;
    expect(chains.evmParams).toHaveBeenCalledWith(derived, 'base');
    expect(chains.evmParams).not.toHaveBeenCalledWith(typed, expect.anything());
  });

  it('F-08: when the landed-lookup fails, a stale solana payout is NOT re-signed (unknown is not "not landed")', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock, { foreign: 'solana' });
    await backend.getVaults();
    clock.t += 25_000;
    const chains = mockChains();
    chains.broadcastSolana = async () => {
      throw new Error('sendTransaction: Blockhash not found');
    };
    const resign = vi.spyOn(backend, 'resignForeign');
    const warns: string[] = [];
    const deps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: { ...quiet, warn: (_t, m) => warns.push(m) } });
    await tickOnce(deps);
    clock.t += 310_000; // past the re-sign cooldown
    chains.txLanded = async () => {
      throw new Error('getSignatureStatuses: HTTP 429, no result in the answer');
    };
    const later = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: { ...quiet, warn: (_t, m) => warns.push(m) } });
    await tickOnce(later);
    expect(resign).not.toHaveBeenCalled();
    expect(warns.some((w) => /could not check whether .* landed/.test(w))).toBe(true);
    // once the lookup answers "not landed", the re-sign goes ahead
    clock.t += 61_000;
    chains.txLanded = async () => false;
    await tickOnce(later);
    expect(resign).toHaveBeenCalledTimes(1);
  });

  it('monad fee cap is 1000 gwei (Base 100 gwei)', () => {
    const a = { nonce: 0, max_fee_per_gas: '300000000000', max_priority_fee_per_gas: '1', gas_limit: '21000' };
    expect(clampEvm(a, 'monad').max_fee_per_gas).toBe('300000000000');
    expect(clampEvm(a, 'base').max_fee_per_gas).toBe('100000000000');
    expect(bumpedEvmArgs(a, { max_fee_per_gas: '300000000000', max_priority_fee_per_gas: '1' }, 'monad')!.max_fee_per_gas).toBe('330000000000');
  });

  it('relays the stored signed_tx again when a broadcast payout hash is not on chain', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock, { foreign: 'base' });
    await backend.getVaults();
    clock.t += 25_000;
    const chains = mockChains();
    const deps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: quiet });
    await tickOnce(deps);
    expect((await backend.getVault('1')).foreign[0].status).toBe('broadcast');
    // the network dropped it
    chains.txLanded = async () => false;
    const send = vi.spyOn(chains, 'broadcastEvm');
    clock.t += 31_000;
    await tickOnce(deps);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await backend.getVault('1')).foreign[0].status).toBe('broadcast');
  });
});

describe('resign planning (hardened contract)', () => {
  const fresh1 = { nonce: 0, max_fee_per_gas: '1000000000', max_priority_fee_per_gas: '1000000', gas_limit: '21000' };
  it('takes max(fresh, 1.1 x last) for both fees, rounding up', () => {
    const r = bumpedEvmArgs(fresh1, { max_fee_per_gas: '2000000000', max_priority_fee_per_gas: '1000001' })!;
    expect(r.max_fee_per_gas).toBe('2200000000');
    expect(r.max_priority_fee_per_gas).toBe('1100002');
    // fresh already higher: keep fresh
    const r2 = bumpedEvmArgs({ ...fresh1, max_fee_per_gas: '9000000000' }, { max_fee_per_gas: '2000000000', max_priority_fee_per_gas: '1' })!;
    expect(r2.max_fee_per_gas).toBe('9000000000');
    expect(BigInt(r.max_fee_per_gas) * 100n).toBeGreaterThanOrEqual(2_000_000_000n * 110n);
  });
  it('clamps gas and fee caps, and holds a bump over the cap at the cap (contract v2 takes it, second review F4)', () => {
    expect(clampEvm({ ...fresh1, gas_limit: '500000', max_fee_per_gas: '900000000000' }).gas_limit).toBe('100000');
    expect(clampEvm({ ...fresh1, max_fee_per_gas: '900000000000' }).max_fee_per_gas).toBe('100000000000');
    expect(clampEvm({ ...fresh1, gas_limit: '1' }).gas_limit).toBe('21000');
    expect(bumpedEvmArgs(fresh1, { max_fee_per_gas: '95000000000', max_priority_fee_per_gas: '1' }).max_fee_per_gas).toBe('100000000000');
    const atCap = bumpedEvmArgs(fresh1, { max_fee_per_gas: '100000000000', max_priority_fee_per_gas: '100000000000' });
    expect([atCap.max_fee_per_gas, atCap.max_priority_fee_per_gas]).toEqual(['100000000000', '100000000000']);
  });
  it('waits until resign_allowed_after_ms', () => {
    expect(msUntilResign({ resign_allowed_after_ms: 10_000 }, 0)).toBe(13_000);
    expect(msUntilResign({ resign_allowed_after_ms: 10_000 }, 20_000)).toBe(0);
  });
});

describe('filtering', () => {
  it('--token style filter leaves other vaults alone', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock);
    await backend.getVaults();
    clock.t += 25_000;
    const deps = makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log: quiet, only: new Set(['99']) });
    expect((await tickOnce(deps)).vaults).toBe(0);
    expect((await backend.getVault('1')).state).not.toBe('Triggered');
  });
});

describe('retry and helpers', () => {
  it('classifies transient vs contract errors', () => {
    expect(isTransient(new Error('fetch failed'))).toBe(true);
    expect(isTransient(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(isTransient(new Error('Smart contract panicked: not_due'))).toBe(false);
  });
  it('backs off exponentially up to a cap and retries only transient errors', async () => {
    expect([0, 1, 2, 10].map((n) => backoffDelay(n, 500, 15_000))).toEqual([500, 1000, 2000, 15_000]);
    let n = 0;
    const waits: number[] = [];
    const v = await withRetry(async () => { if (++n < 3) throw new Error('ETIMEDOUT'); return 'ok'; }, { sleep: async (m) => { waits.push(m); } });
    expect(v).toBe('ok');
    expect(waits).toEqual([500, 1000]);
    let m = 0;
    await expect(withRetry(async () => { m++; throw new Error('Smart contract panicked: x'); }, { sleep: async () => {} })).rejects.toThrow();
    expect(m).toBe(1);
  });
  it('parses NEP-297 events and builds explorer links', () => {
    const logs = ['hello', 'EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"agent_pay_denied","data":{"reason":"over_per_tx_max"}}', 'EVENT_JSON:{"standard":"nep171","event":"x","data":[]}', 'EVENT_JSON:{bad'];
    expect(parseEvents(logs)).toEqual([{ event: 'agent_pay_denied', data: { reason: 'over_per_tx_max' } }]);
    expect(nearTxLink('ABC123')).toBe('https://testnet.nearblocks.io/txns/ABC123');
  });
});

describe('commands', () => {
  it('pulse beats immediately, logs once per beat without a TTY, and announces the owner disappearing on stop', async () => {
    vi.useFakeTimers();
    const clock = { t: 1_000_000 };
    const backend = fresh(clock);
    const lines: string[] = [];
    const p = startPulse({ backend, tokenId: '1', intervalS: 5, out: { write: (s: string) => lines.push(s), isTTY: false }, now: () => clock.t });
    await vi.advanceTimersByTimeAsync(10);
    clock.t += 2000;
    await vi.advanceTimersByTimeAsync(2000);
    p.stop();
    await p.done;
    vi.useRealTimers();
    const text = lines.join('');
    // not a TTY: one line per beat (carrying the next-beat time), no per-second countdown lines
    expect(text).toMatch(/heartbeat sent .*alive · next beat in \ds/);
    expect(lines.filter((l) => l.includes('next beat in')).length).toBe(1);
    expect(text).toContain('pulse stopped — this is the moment the owner disappears');
  });
  it('agent-demo shows one allowed and one denied call with parsed events', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock);
    const lines: string[] = [];
    const calls = await agentDemo({ backend, tokenId: '1', out: { write: (s: string) => lines.push(s) } });
    expect(calls.map((c) => (c.tx?.returnValue as { allowed: boolean }).allowed)).toEqual([true, false]);
    const text = lines.join('');
    expect(text).toContain('agent_pay_allowed');
    expect(text).toContain('over_per_tx_max');
    expect(planDemoCalls({ per_tx_max: '100', allowlist: [] }).allowed.receiver).toBe('agent-demo-receiver.testnet');
  });
  it('builds the Sputnik factory args and a copy-pasteable near-cli command', () => {
    const a = daoArgs('estate-1', 'andrew.testnet', 'p');
    expect(JSON.parse(Buffer.from(a.args, 'base64').toString())).toEqual({ config: { name: 'estate-1', purpose: 'p', metadata: '' }, policy: ['andrew.testnet'] });
    const cmd = nearCliCommand('estate-1', 'andrew.testnet', 'p');
    expect(cmd).toContain("attached-deposit '6 NEAR'");
    expect(cmd).toContain('sputnik-v2.testnet create');
    expect(validDaoName('estate-1')).toBe(true);
    expect(validDaoName('Bad Name')).toBe(false);
  });
});
