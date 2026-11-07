import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { agentDemo, planDemoCalls } from '../src/commands/agentDemo.js';
import { daoArgs, nearCliCommand, validDaoName } from '../src/commands/dao.js';
import { startPulse } from '../src/commands/pulse.js';
import { driveVault, makeDeps, runKeeper, tickOnce, type Logger } from '../src/keeperLoop.js';
import { MockBackend, mockChains } from '../src/mock.js';
import { backoffDelay, isTransient, nearTxLink, parseEvents, withRetry } from '../src/util.js';

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
  it('pulse prints a countdown, beats immediately, and announces the owner disappearing on stop', async () => {
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
    expect(text).toMatch(/alive · next beat in \ds/);
    expect(text).toMatch(/heartbeat sent/);
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
