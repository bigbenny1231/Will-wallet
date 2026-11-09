// --owner-prefix filter, the bounded sweep (--until-idle / --max-seconds) and the read-only `due` pre-check.
// Everything here runs against the mock backend and mock chains: no network, no transactions.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { dueCommand, findWork } from '../src/commands/due.js';
import { driveVault, makeDeps, runKeeper, tickOnce } from '../src/keeperLoop.js';
import { effectiveTriggerAtMs, isDue, matchesFilter, needsSettlement } from '../src/machine.js';
import { mockChains, mockCreate } from '../src/mock.js';
import type { VaultView } from '../src/types.js';
import { GUEST, quiet, recordingLogger, seedBackend, type Seed } from './helpers.js';

const T0 = 1_000_000;
const OVERDUE = 25_000; // interval 10 s, grace 1: poke is legal after 20 s

/** vault 1 belongs to somebody else; 2 and 3 are guest vaults */
const three = (extra: Partial<Seed> = {}): Seed[] => [
  { token_id: '1', owner_id: 'dmw-andrew-8d2e.testnet', ...extra },
  { token_id: '2', owner_id: 'dmw-guest-aaa111.testnet', ...extra },
  { token_id: '3', owner_id: 'dmw-guest-bbb222.testnet', ...extra },
];

const spyWrites = (backend: ReturnType<typeof seedBackend>['backend']) => ({
  poke: vi.spyOn(backend, 'poke'),
  step: vi.spyOn(backend, 'executeStep'),
  mark: vi.spyOn(backend, 'markBroadcast'),
  resign: vi.spyOn(backend, 'resignForeign'),
});
const tokensOf = (spy: { mock: { calls: unknown[][] } }) => [...new Set(spy.mock.calls.map((c) => String(c[0])))].sort();

describe('--owner-prefix filter', () => {
  it('matches on the start of owner_id, and combines with --token (both must hold)', () => {
    const v = { token_id: '7', owner_id: 'dmw-guest-abc.testnet' };
    expect(matchesFilter(v, {})).toBe(true);
    expect(matchesFilter(v, { ownerPrefix: GUEST })).toBe(true);
    expect(matchesFilter({ ...v, owner_id: 'not-dmw-guest-abc.testnet' }, { ownerPrefix: GUEST })).toBe(false);
    expect(matchesFilter({ ...v, owner_id: 'dmw-guest.testnet' }, { ownerPrefix: GUEST })).toBe(false);
    expect(matchesFilter(v, { ownerPrefix: GUEST, only: new Set(['7']) })).toBe(true);
    expect(matchesFilter(v, { ownerPrefix: GUEST, only: new Set(['8']) })).toBe(false);
    expect(matchesFilter({ ...v, owner_id: 'sarah.testnet' }, { ownerPrefix: GUEST, only: new Set(['7']) })).toBe(false);
  });

  it('settles the overdue guest vaults and sends nothing for the other vault', async () => {
    const clock = { t: T0 };
    const { backend, stored } = seedBackend(clock, three());
    const before = JSON.stringify(stored('1'));
    clock.t += OVERDUE;
    const w = spyWrites(backend);
    const deps = makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log: quiet, ownerPrefix: GUEST });
    const r = await tickOnce(deps);
    expect(r.vaults).toBe(2);
    expect(r.error).toBeUndefined();
    expect(stored('2').state).toBe('Settled');
    expect(stored('3').state).toBe('Settled');
    // every write the loop can make went to a guest vault
    for (const spy of Object.values(w)) expect(tokensOf(spy).filter((t) => t !== '2' && t !== '3')).toEqual([]);
    expect(tokensOf(w.poke)).toEqual(['2', '3']);
    expect(tokensOf(w.mark)).toEqual(['2', '3']);
    expect(new Set(r.actions.map((a) => a.tokenId))).toEqual(new Set(['2', '3']));
    // the other vault is byte-for-byte what it was: overdue, not poked
    expect(JSON.stringify(stored('1'))).toBe(before);
    expect(isDue(await backend.getVault('1'), clock.t)).toBe(true);
  });

  it('with --token as well, only vaults that pass both are driven', async () => {
    const clock = { t: T0 };
    const { backend, stored } = seedBackend(clock, three());
    clock.t += OVERDUE;
    const deps = makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log: quiet, ownerPrefix: GUEST, only: new Set(['1', '2']) });
    expect((await tickOnce(deps)).vaults).toBe(1);
    expect(stored('1').state).toBe('Alive');
    expect(stored('2').state).toBe('Settled');
    expect(stored('3').state).toBe('Alive');
  });

  it('keeps matching while Triggered (owner_id is still the creator) and finishes a half-settled guest vault', async () => {
    const clock = { t: T0 };
    const halfway = (v: VaultView) => {
      v.state = 'Triggered';
      v.step = 3;
      v.pulse_keys = [];
      v.agent_keys = [];
    };
    const { backend, stored } = seedBackend(clock, [
      { token_id: '1', owner_id: 'dmw-andrew-8d2e.testnet', patch: halfway },
      { token_id: '2', owner_id: 'dmw-guest-aaa111.testnet', patch: halfway },
    ]);
    const before = JSON.stringify(stored('1'));
    const w = spyWrites(backend);
    const deps = makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log: quiet, ownerPrefix: GUEST });
    await tickOnce(deps);
    expect(stored('2').state).toBe('Settled');
    expect(stored('2').foreign.map((p) => p.status)).toEqual(['broadcast', 'broadcast']);
    expect(tokensOf(w.step)).toEqual(['2']);
    expect(JSON.stringify(stored('1'))).toBe(before); // Triggered at step 3, and left that way
  });

  it('applies to relay, mark_broadcast, re-broadcast and resign_foreign: other vaults with payouts in those states are not touched', async () => {
    const clock = { t: T0 };
    const settledWith = (status: 'signed' | 'failed' | 'broadcast') => (v: VaultView) => {
      v.state = 'Settled';
      v.step = 6;
      v.foreign[0].status = status;
      v.foreign[0].signed_tx = status === 'failed' ? null : '0xmocksigned0';
      v.foreign[0].tx_hash = status === 'broadcast' ? 'mock0xevmgned0' : null;
    };
    const { backend, stored } = seedBackend(clock, [
      { token_id: '1', owner_id: 'dmw-demo-sarah-3b15.testnet', foreign: 'base', patch: settledWith('signed') }, // would be relayed + marked
      { token_id: '4', owner_id: 'dmw-demo-sarah-3b15.testnet', foreign: 'base', patch: settledWith('failed') }, // would be re-signed
      { token_id: '5', owner_id: 'dmw-demo-sarah-3b15.testnet', foreign: 'base', patch: settledWith('broadcast') }, // would be re-broadcast
      { token_id: '2', owner_id: 'dmw-guest-aaa111.testnet', foreign: 'none' },
    ]);
    const before = ['1', '4', '5'].map((id) => JSON.stringify(stored(id)));
    clock.t += 400_000; // past the 5 min re-sign cooldown, and the guest vault is overdue
    const chains = mockChains();
    const sendEvm = vi.spyOn(chains, 'broadcastEvm');
    const sendSol = vi.spyOn(chains, 'broadcastSolana');
    const landed = vi.spyOn(chains, 'txLanded');
    const track = vi.spyOn(backend, 'getSignTrack');
    const w = spyWrites(backend);

    const filtered = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: quiet, ownerPrefix: GUEST });
    await tickOnce(filtered);
    await tickOnce(filtered);
    expect(stored('2').state).toBe('Settled');
    expect(tokensOf(w.step)).toEqual(['2']);
    expect(w.mark).not.toHaveBeenCalled();
    expect(w.resign).not.toHaveBeenCalled();
    expect(sendEvm).not.toHaveBeenCalled();
    expect(sendSol).not.toHaveBeenCalled();
    expect(landed).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
    expect(['1', '4', '5'].map((id) => JSON.stringify(stored(id)))).toEqual(before);

    // Control: the same store without the filter does relay, re-sign and re-broadcast, so the assertions above mean something.
    await tickOnce(makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: quiet }));
    expect(tokensOf(w.mark)).toContain('1');
    expect(tokensOf(w.resign)).toEqual(['4']);
    expect(sendEvm.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('driveVault itself refuses a vault outside the filter', async () => {
    const clock = { t: T0 };
    const { backend, stored } = seedBackend(clock, three());
    clock.t += OVERDUE;
    const w = spyWrites(backend);
    const deps = makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log: quiet, ownerPrefix: GUEST });
    expect(await driveVault(deps, await backend.getVault('1'))).toEqual([]);
    expect(w.poke).not.toHaveBeenCalled();
    expect(deps.lastState.has('1')).toBe(false);
    expect(stored('1').state).toBe('Alive');
  });

  it('lets go of a vault once it is Settled and the heir owns it: a parked relay is not retried', async () => {
    const clock = { t: T0 };
    const { backend, stored } = seedBackend(clock, [{ token_id: '2', owner_id: 'dmw-guest-aaa111.testnet', foreign: 'base' }]);
    clock.t += OVERDUE;
    const chains = mockChains();
    const send = vi.spyOn(chains, 'broadcastEvm').mockRejectedValue(new Error('eth_sendRawTransaction: insufficient funds for gas * price + value'));
    const deps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: quiet, ownerPrefix: GUEST });
    const r = await tickOnce(deps);
    expect(r.error).toBeUndefined();
    expect(r.pending).toEqual([]);
    expect(stored('2').state).toBe('Settled');
    expect(stored('2').owner_id).toBe('sarah.testnet');
    expect(stored('2').foreign[0].status).toBe('signed');
    expect(send).toHaveBeenCalledTimes(1); // tried once while the vault was still the guest's
    clock.t += 120_000; // past the 60 s unfunded cooldown
    expect((await tickOnce(deps)).vaults).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('--owner-prefix filter, checked before every action', () => {
  it('re-checks the owner on each fresh view: a relay that comes up after the hand-over to the heir is not sent', async () => {
    const clock = { t: T0 };
    const { backend, stored } = seedBackend(clock, [{ token_id: '2', owner_id: 'dmw-guest-aaa111.testnet', foreign: 'base' }]);
    clock.t += OVERDUE;
    // Slow transactions: each execute_step takes 20 s, so the 30 s relay cooldown runs out inside one pass.
    const real = backend.executeStep.bind(backend);
    backend.executeStep = async (id, args) => {
      const tx = await real(id, args);
      clock.t += 20_000;
      return tx;
    };
    const chains = mockChains();
    const send = vi.spyOn(chains, 'broadcastEvm').mockRejectedValue(new Error('eth_sendRawTransaction: connection reset'));
    const mark = vi.spyOn(backend, 'markBroadcast');
    const { log, lines } = recordingLogger();
    const deps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log, ownerPrefix: GUEST });
    const r = await tickOnce(deps);
    expect(stored('2').state).toBe('Settled');
    expect(stored('2').owner_id).toBe('sarah.testnet');
    expect(send).toHaveBeenCalledTimes(1); // the attempt made while the guest still owned the vault
    expect(mark).not.toHaveBeenCalled();
    expect(r.pending).toEqual([]);
    expect(lines.some((l) => /vault 2 no longer matches the filter \(owner is now sarah\.testnet\); not doing: relay payout #0 \(base\)/.test(l))).toBe(true);

    // Control: without the prefix the same pass does retry the relay after the hand-over.
    const clock2 = { t: T0 };
    const b2 = seedBackend(clock2, [{ token_id: '2', owner_id: 'dmw-guest-aaa111.testnet', foreign: 'base' }]);
    clock2.t += OVERDUE;
    const real2 = b2.backend.executeStep.bind(b2.backend);
    b2.backend.executeStep = async (id, args) => {
      const tx = await real2(id, args);
      clock2.t += 20_000;
      return tx;
    };
    const chains2 = mockChains();
    const send2 = vi.spyOn(chains2, 'broadcastEvm').mockRejectedValue(new Error('eth_sendRawTransaction: connection reset'));
    await tickOnce(makeDeps({ backend: b2.backend, chains: chains2, contractId: 'c', now: () => clock2.t, log: quiet }));
    expect(send2).toHaveBeenCalledTimes(2);
  });
});

describe('deadline with a guardian pause', () => {
  it('uses the later trigger_at_ms from the view, so a paused vault is neither due nor poked', async () => {
    const v = { ...mockCreate(T0, { heartbeat_interval_s: 10, grace_missed: 1 }), trigger_at_ms: T0 + 90_000 };
    expect(effectiveTriggerAtMs(v)).toBe(T0 + 90_000);
    expect(isDue(v, T0 + 25_000)).toBe(false);
    expect(needsSettlement(v, T0 + 25_000)).toBe(false);
    expect(isDue(v, T0 + 90_000)).toBe(true);
    // an older or missing view field never makes a vault due early
    expect(isDue({ ...v, trigger_at_ms: T0 + 1 }, T0 + 19_999)).toBe(false);
    expect(isDue({ ...v, trigger_at_ms: undefined }, T0 + 20_000)).toBe(true);
  });
});

describe('bounded sweep (--until-idle, --max-seconds)', () => {
  const sweep = (clock: { t: number }) => {
    const sleeps: number[] = [];
    return { sleeps, sleepFn: async (ms: number) => void (sleeps.push(ms), (clock.t += ms)) };
  };

  it('returns at once when nothing is due: one read, no writes, no sleep', async () => {
    const clock = { t: T0 };
    const { backend } = seedBackend(clock, three());
    clock.t += 5_000; // everyone is Alive
    const list = vi.spyOn(backend, 'getVaults');
    const w = spyWrites(backend);
    const s = sweep(clock);
    const r = await runKeeper(makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log: quiet, ownerPrefix: GUEST }), { pollS: 5, untilIdle: true, maxSeconds: 240, sleepFn: s.sleepFn });
    expect(r).toEqual({ reason: 'idle', ticks: 1, listed: 1, pending: [] });
    expect(list).toHaveBeenCalledTimes(1);
    for (const spy of Object.values(w)) expect(spy).not.toHaveBeenCalled();
    expect(s.sleeps).toEqual([]);
  });

  it('is also idle when only vaults outside the prefix are overdue or Triggered', async () => {
    const clock = { t: T0 };
    const { backend, stored } = seedBackend(clock, [
      { token_id: '1', owner_id: 'dmw-agent-owner-96af.testnet' },
      { token_id: '6', owner_id: 'dmw-andrew-8d2e.testnet', patch: (v) => void ((v.state = 'Triggered'), (v.step = 1)) },
    ]);
    clock.t += OVERDUE;
    const w = spyWrites(backend);
    const s = sweep(clock);
    const r = await runKeeper(makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log: quiet, ownerPrefix: GUEST }), { pollS: 5, untilIdle: true, maxSeconds: 240, sleepFn: s.sleepFn });
    expect(r.reason).toBe('idle');
    for (const spy of Object.values(w)) expect(spy).not.toHaveBeenCalled();
    expect(stored('1').state).toBe('Alive');
    expect(stored('6').step).toBe(1);
  });

  it('drives an overdue and a Triggered guest vault to Settled across passes, waiting while a signature is in flight', async () => {
    const clock = { t: T0 };
    const { backend, stored } = seedBackend(clock, [
      { token_id: '1', owner_id: 'dmw-andrew-8d2e.testnet' },
      { token_id: '2', owner_id: 'dmw-guest-aaa111.testnet', foreign: 'solana' },
      { token_id: '3', owner_id: 'dmw-guest-bbb222.testnet', foreign: 'none', patch: (v) => void ((v.state = 'Triggered'), (v.step = 2)) },
    ]);
    clock.t += OVERDUE;
    // The MPC answer for vault 2 arrives late: the first two step-3 calls return without advancing (in-flight guard).
    const real = backend.executeStep.bind(backend);
    let inflight = 2;
    const stepsAt3: number[] = [];
    backend.executeStep = async (id, args) => {
      const v = await backend.getVault(id);
      if (id === '2' && v.step === 3) {
        stepsAt3.push(clock.t);
        if (inflight-- > 0) return { hash: 'mockinflight', logs: [], returnValue: 3 };
      }
      return real(id, args);
    };
    const s = sweep(clock);
    const { log, lines } = recordingLogger();
    const r = await runKeeper(makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log, ownerPrefix: GUEST }), { pollS: 5, untilIdle: true, maxSeconds: 240, sleepFn: s.sleepFn });
    expect(r).toEqual({ reason: 'idle', ticks: 3, listed: 3, pending: [] });
    expect(s.sleeps).toEqual([5_000, 5_000]);
    expect(stepsAt3).toHaveLength(3); // one sign request per pass, never a burst
    expect(stored('2').state).toBe('Settled');
    expect(stored('2').foreign[0].status).toBe('broadcast');
    expect(stored('3').state).toBe('Settled');
    expect(stored('1').state).toBe('Alive'); // overdue, not a guest vault, not poked
    expect(lines.some((l) => /nothing left to settle/.test(l))).toBe(true);
  });

  it('unfunded relays do not keep the sweep alive: the vault settles, payouts stay signed, the run ends idle', async () => {
    const clock = { t: T0 };
    // The primary heir is a guest account too, so the vault still matches the prefix after it is Settled.
    const { backend, stored } = seedBackend(clock, [
      { token_id: '2', owner_id: 'dmw-guest-aaa111.testnet', patch: (v) => void (v.heirs = [{ account_id: 'dmw-guest-heir99.testnet', bps: 10_000 }]) },
    ]);
    clock.t += OVERDUE;
    const chains = mockChains();
    chains.broadcastEvm = async () => {
      throw new Error('eth_sendRawTransaction: insufficient funds for gas * price + value: have 0 want 1');
    };
    chains.broadcastSolana = async () => {
      throw new Error('sendTransaction: Transaction simulation failed {"err":"AccountNotFound"}');
    };
    const s = sweep(clock);
    const r = await runKeeper(makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: quiet, ownerPrefix: GUEST }), { pollS: 5, untilIdle: true, maxSeconds: 240, sleepFn: s.sleepFn });
    expect(r).toEqual({ reason: 'idle', ticks: 1, listed: 1, pending: [] });
    expect(s.sleeps).toEqual([]);
    const v = stored('2');
    expect(v.state).toBe('Settled');
    expect(v.owner_id).toBe('dmw-guest-heir99.testnet');
    expect(v.foreign.map((p) => p.status)).toEqual(['signed', 'signed']);
  });

  it('stops at the time limit when a vault cannot be finished, and reports what is left', async () => {
    const clock = { t: T0 };
    const { backend, stored } = seedBackend(clock, three());
    clock.t += OVERDUE;
    const start = clock.t;
    // Vault 2 is stuck: every execute_step comes back failed. Vault 3 settles normally.
    const real = backend.executeStep.bind(backend);
    const stuckCallsAt: number[] = [];
    backend.executeStep = async (id, args) => {
      if (id !== '2') return real(id, args);
      stuckCallsAt.push(clock.t);
      return { hash: 'mockfail', logs: [], returnValue: null, failure: '{"ActionError":"boom"}' };
    };
    const s = sweep(clock);
    const { log, lines } = recordingLogger();
    const r = await runKeeper(makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log, ownerPrefix: GUEST }), { pollS: 5, untilIdle: true, maxSeconds: 240, sleepFn: s.sleepFn });
    expect(r.reason).toBe('time_limit');
    expect(r.pending).toEqual(['2']);
    expect(clock.t - start).toBe(240_000); // slept exactly up to the limit: the last wait is cut short
    expect(s.sleeps).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 50_000]);
    expect(stuckCallsAt.every((t) => t < start + 240_000)).toBe(true); // nothing started at or after the limit
    expect(stored('3').state).toBe('Settled');
    expect(stored('2').state).toBe('Triggered');
    expect(stored('1').state).toBe('Alive');
    expect(lines.some((l) => /time limit of 240s reached; still to settle: vault 2/.test(l))).toBe(true);
  });

  it('starts no new action once the limit passes in the middle of a pass', async () => {
    const clock = { t: T0 };
    const { backend, stored } = seedBackend(clock, three());
    clock.t += OVERDUE;
    const realPoke = backend.poke.bind(backend);
    backend.poke = async (id) => {
      const tx = await realPoke(id);
      clock.t += 300_000; // a very slow transaction
      return tx;
    };
    const w = spyWrites(backend);
    const s = sweep(clock);
    const r = await runKeeper(makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log: quiet, ownerPrefix: GUEST }), { pollS: 5, untilIdle: true, maxSeconds: 240, sleepFn: s.sleepFn });
    expect(r.reason).toBe('time_limit');
    expect(r.pending).toEqual(['2', '3']);
    expect(w.step).not.toHaveBeenCalled();
    expect(stored('2').state).toBe('Triggered'); // poked, then the run stopped
    expect(stored('3').state).toBe('Alive'); // never started
    expect(s.sleeps).toEqual([]);
  });

  it('an RPC that never answers is not mistaken for "idle": the run ends at the limit with listed = 0', async () => {
    const clock = { t: T0 };
    const { backend } = seedBackend(clock, three());
    backend.getVaults = async () => {
      throw new Error('fetch failed');
    };
    const s = sweep(clock);
    const r = await runKeeper(makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log: quiet, ownerPrefix: GUEST }), { pollS: 5, untilIdle: true, maxSeconds: 60, sleepFn: s.sleepFn });
    expect(r.reason).toBe('time_limit');
    expect(r.listed).toBe(0);
    expect(r.ticks).toBeGreaterThan(1);
  });

  it('--once is still exactly one pass, even when work is left', async () => {
    const clock = { t: T0 };
    const { backend } = seedBackend(clock, three());
    clock.t += OVERDUE;
    backend.executeStep = async () => ({ hash: 'mockfail', logs: [], returnValue: null, failure: 'boom' });
    const s = sweep(clock);
    const r = await runKeeper(makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log: quiet, ownerPrefix: GUEST }), { pollS: 5, once: true, untilIdle: true, sleepFn: s.sleepFn });
    expect(r.reason).toBe('once');
    expect(r.ticks).toBe(1);
    expect(r.pending).toEqual(['2', '3']);
    expect(s.sleeps).toEqual([]);
  });
});

describe('due (read-only pre-check)', () => {
  const view = (o: Seed, now: number): VaultView => {
    const { patch, ...opts } = o;
    const v = mockCreate(T0, { heartbeat_interval_s: 10, grace_missed: 1, ...opts });
    patch?.(v);
    return { ...v, trigger_at_ms: v.last_beat_ms + 20_000, warning_at_ms: v.last_beat_ms + 10_000, state: v.state === 'Alive' && now >= v.last_beat_ms + 10_000 ? 'Warning' : v.state };
  };
  const triggered = (v: VaultView) => void ((v.state = 'Triggered'), (v.step = 2));
  const settledSigned = (v: VaultView) => {
    v.state = 'Settled';
    v.step = 6;
    v.foreign[0].status = 'signed';
    v.foreign[0].signed_tx = '0xmocksigned0';
  };

  it('finds guest vaults that are past the deadline or Triggered', () => {
    const now = T0 + OVERDUE;
    const r = findWork(
      [
        view({ token_id: '1', owner_id: 'dmw-andrew-8d2e.testnet' }, now),
        view({ token_id: '2', owner_id: 'dmw-guest-aaa111.testnet' }, now),
        view({ token_id: '3', owner_id: 'dmw-guest-bbb222.testnet', patch: triggered }, now),
        view({ token_id: '4', owner_id: 'dmw-guest-ccc333.testnet', heartbeat_interval_s: 3600 }, now),
      ],
      now,
      { ownerPrefix: GUEST },
    );
    expect(r).toEqual({ checked: 4, matching: 3, due: ['2'], triggered: ['3'], work: true });
  });

  it('reports no work when only other vaults are overdue or Triggered, a guest vault is paused, or a settled one has signed payouts', () => {
    const now = T0 + OVERDUE;
    const r = findWork(
      [
        view({ token_id: '13', owner_id: 'dmw-agent-owner-96af.testnet' }, now), // overdue, not a guest
        view({ token_id: '14', owner_id: 'dmw-andrew-8d2e.testnet', patch: triggered }, now),
        { ...view({ token_id: '20', owner_id: 'dmw-guest-aaa111.testnet' }, now), trigger_at_ms: now + 60_000 }, // guardian pause
        view({ token_id: '21', owner_id: 'dmw-guest-heir99.testnet', patch: settledSigned }, now),
        view({ token_id: '22', owner_id: 'dmw-guest-ccc333.testnet', heartbeat_interval_s: 3600 }, now),
      ],
      now,
      { ownerPrefix: GUEST },
    );
    expect(r).toEqual({ checked: 5, matching: 3, due: [], triggered: [], work: false });
  });

  it('prints the flag, writes work/count to the GitHub output file, and only ever reads', async () => {
    const clock = { t: T0 };
    const { backend } = seedBackend(clock, three());
    const getVaults = vi.fn(() => backend.getVaults());
    const ghFile = join(mkdtempSync(join(tmpdir(), 'dmw-gh-')), 'out');
    writeFileSync(ghFile, '');
    const lines: string[] = [];
    const out = { write: (s: string) => lines.push(s) };
    const w = spyWrites(backend);

    const idle = await dueCommand({ backend: { getVaults }, contract: 'dmw-x8cx.testnet', filter: { ownerPrefix: GUEST }, now: () => clock.t, githubOutput: ghFile, out });
    expect(idle.work).toBe(false);
    expect(readFileSync(ghFile, 'utf8')).toBe('work=false\ncount=0\n');
    expect(lines.join('')).toContain('work=false');
    expect(lines.join('')).toContain('checked 3 vaults on dmw-x8cx.testnet; 2 match owner prefix "dmw-guest-"');

    clock.t += OVERDUE;
    lines.length = 0;
    writeFileSync(ghFile, '');
    const busy = await dueCommand({ backend: { getVaults }, contract: 'dmw-x8cx.testnet', filter: { ownerPrefix: GUEST }, now: () => clock.t, githubOutput: ghFile, out });
    expect(busy).toMatchObject({ work: true, due: ['2', '3'], triggered: [], owner_prefix: GUEST, checked: 3, matching: 2 });
    expect(readFileSync(ghFile, 'utf8')).toBe('work=true\ncount=2\n');
    expect(lines.join('')).toMatch(/work=true {2}2 to settle \(past deadline: 2, 3\)/);

    lines.length = 0;
    const asJson = await dueCommand({ backend: { getVaults }, contract: 'dmw-x8cx.testnet', filter: { ownerPrefix: GUEST }, now: () => clock.t, json: true, out });
    expect(JSON.parse(lines.join(''))).toEqual(asJson);

    expect(getVaults).toHaveBeenCalledTimes(3);
    for (const spy of Object.values(w)) expect(spy).not.toHaveBeenCalled();
  });
});
