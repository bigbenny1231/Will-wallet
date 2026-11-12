// Contract v3 (docs/SECURITY_FIXES_V3.md): Solana keeper re-sign cap, M-1 "skipped" payouts, non-keeper fee
// replacement at the clamp (H-1(3)), get_config / get_sign_track fields and the per-vault payout limits.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig, parseSignTrack } from '../src/backend.js';
import { isSkippedPayout, makeDeps, tickOnce } from '../src/keeperLoop.js';
import { MOCK_SKIPPED_DETAIL, MockBackend, mockChains, mockCreate, mockSetForeignPayouts, mockValidatePayouts } from '../src/mock.js';
import { RELAY_COOLDOWN } from '../src/relay.js';
import { nonKeeperFeeClamp, nonKeeperResignArgs, signedAboveClamp } from '../src/resign.js';
import type { VaultView } from '../src/types.js';
import { recordingLogger, seedBackend } from './helpers.js';

const GWEI = 1_000_000_000n;
const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
const HOUR = 3_600_000;
const C = 'dmw-mock.testnet';

const fresh = (clock: { t: number }, seed = {}) => {
  const file = join(mkdtempSync(join(tmpdir(), 'dmw-')), 'm.json');
  return new MockBackend(file, () => clock.t, { heartbeat_interval_s: 10, grace_missed: 1, ...seed });
};

/** A vault whose Solana payout is signed but whose relays always fail with an expired blockhash. */
async function staleSolana(clock: { t: number }) {
  const backend = fresh(clock, { foreign: 'solana' });
  await backend.getVaults();
  clock.t += 25_000;
  const chains = mockChains();
  chains.broadcastSolana = async () => {
    throw new Error('sendTransaction: Blockhash not found');
  };
  const resign = vi.spyOn(backend, 'resignForeign');
  const { log, lines } = recordingLogger();
  const deps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log });
  return { backend, chains, resign, deps, lines };
}

describe('Solana keeper re-sign cap (3 per keeper epoch)', () => {
  it('re-signs a stale signed payout at most 3 times, then parks it, logs once and never counts it as a failure', async () => {
    const clock = { t: 1_000_000 };
    const { backend, resign, deps, lines } = await staleSolana(clock);
    const errors: (string | undefined)[] = [];
    for (let i = 0; i < 30; i++) {
      errors.push((await tickOnce(deps)).error);
      clock.t += 310_000;
    }
    const ok = resign.mock.results.filter((r) => r.type === 'return');
    expect(resign).toHaveBeenCalledTimes(3); // never a 4th call: the view says 0 left before it is made
    expect(ok).toHaveLength(3);
    expect((await backend.getSignTrack('1', 0)).keeper_resigns_left).toBe(0);
    expect(lines.filter((l) => l.includes('keeper re-sign limit reached'))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith('err'))).toBe(false);
    expect(errors.every((e) => e === undefined)).toBe(true);
    expect(deps.relayBlock.get('1:0')?.reason).toBe('resign-capped');
    expect((await backend.getVault('1')).foreign[0].status).toBe('signed'); // the last signature stays as it was
  });

  it('a new keeper epoch resets the allowance: the parked payout is re-signed again after the park', async () => {
    const clock = { t: 1_000_000 };
    const { backend, resign, deps, lines } = await staleSolana(clock);
    backend.keeperResigns.set('1:0', { used: 3, epoch: 0 });
    await tickOnce(deps);
    clock.t += 310_000;
    await tickOnce(deps);
    expect(resign).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.includes('keeper re-sign limit reached'))).toHaveLength(1);
    backend.keeperEpoch = 1; // e.g. accept_keeper or an executed admin proposal
    expect((await backend.getSignTrack('1', 0)).keeper_resigns_left).toBe(3);
    clock.t += RELAY_COOLDOWN.parked;
    await tickOnce(deps);
    expect(resign).toHaveBeenCalledTimes(1);
    expect(deps.noted.has('capped:1:0')).toBe(false);
  });

  it('the contract error "keeper re-sign limit reached" is final: parked, logged once, not an action failure', async () => {
    const clock = { t: 1_000_000 };
    const { backend, resign, deps, lines } = await staleSolana(clock);
    // A view without the v3 counter (or one read just before another keeper's call): the contract refuses.
    const real = backend.getSignTrack.bind(backend);
    backend.getSignTrack = async (id, i) => ({ ...(await real(id, i)), keeper_resigns: undefined, keeper_resigns_left: undefined });
    backend.keeperResigns.set('1:0', { used: 3, epoch: 0 });
    await tickOnce(deps);
    clock.t += 310_000;
    const r = await tickOnce(deps);
    expect(resign).toHaveBeenCalledTimes(1);
    expect(r.error).toBeUndefined();
    expect(lines.some((l) => l.startsWith('err'))).toBe(false);
    expect(lines.filter((l) => l.includes('keeper re-sign limit reached'))).toHaveLength(1);
    expect(deps.relayBlock.get('1:0')).toMatchObject({ reason: 'resign-capped', until: clock.t + RELAY_COOLDOWN.parked });
    clock.t += 310_000;
    await tickOnce(deps);
    expect(resign).toHaveBeenCalledTimes(1); // parked: not retried every cooldown
  });

  it('a non-keeper never tries to re-sign a signed Solana payout (the contract would refuse); parked, logged once', async () => {
    const clock = { t: 1_000_000 };
    const { backend, resign, deps, lines } = await staleSolana(clock);
    backend.callerIsKeeper = false;
    for (let i = 0; i < 3; i++) {
      await tickOnce(deps);
      clock.t += 310_000;
    }
    expect(resign).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.includes('only a keeper may re-sign a signed Solana payout'))).toHaveLength(1);
  });
});

/** A vault at step III with one pending Solana payout; step 3 started at T0. */
function atStep3(clock: { t: number }) {
  const s = seedBackend(clock, [
    {
      token_id: '1',
      foreign: 'solana',
      patch: (v: VaultView) => {
        Object.assign(v, { state: 'Triggered', step: 3, foreign_index: 0 });
        v.log.push({ ms: T0, event: 'step_2', detail: 'deleted 2 keys' });
      },
    },
  ]);
  return s;
}

describe('M-1: a non-operator step 3 on a Solana payout after the operator hour', () => {
  it('records the payout failed ("skipped: ...", no signature); a non-operator keeper says so and does not try to re-sign', async () => {
    const clock = { t: T0 + HOUR + 10_000 };
    const s = atStep3(clock);
    s.backend.accountId = 'dmw-sweep-1.testnet';
    const resign = vi.spyOn(s.backend, 'resignForeign');
    const { log, lines } = recordingLogger();
    const deps = makeDeps({ backend: s.backend, chains: mockChains(), contractId: C, now: () => clock.t, log });
    const r = await tickOnce(deps);
    const v = s.stored('1');
    expect(v.foreign[0]).toMatchObject({ status: 'failed', signed_tx: null });
    expect(v.log.some((e) => e.event === 'foreign_failed' && e.detail === `#0 ${MOCK_SKIPPED_DETAIL}`)).toBe(true);
    expect(isSkippedPayout(v, 0)).toBe(true);
    expect(v.step).toBe(5); // settlement moved on (step 4 had no DAO)
    expect(r.error).toBeUndefined();
    expect(lines.some((l) => l.includes('solana payout #0 skipped'))).toBe(true);
    expect(resign).not.toHaveBeenCalled();
    await tickOnce(deps);
    expect(lines.filter((l) => l.includes('is not an operator of this vault, so only the keeper'))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith('err'))).toBe(false);
  });

  it('an operator re-signs a skipped payout at once, and it does not use the keeper allowance', async () => {
    const clock = { t: T0 + HOUR + 10_000 };
    const s = atStep3(clock);
    s.backend.accountId = 'dmw-sweep-1.testnet';
    const deps0 = makeDeps({ backend: s.backend, chains: mockChains(), contractId: C, now: () => clock.t, log: recordingLogger().log });
    await tickOnce(deps0);
    expect(s.stored('1').foreign[0].status).toBe('failed');

    // the contract keeper (an operator, and a keeper) runs next, a minute later: no 5 min wait, no allowance used
    clock.t += 60_000;
    s.backend.accountId = 'ck.testnet';
    s.backend.config.keeper = 'ck.testnet';
    const resign = vi.spyOn(s.backend, 'resignForeign');
    const { log, lines } = recordingLogger();
    const deps = makeDeps({ backend: s.backend, chains: mockChains(), contractId: C, now: () => clock.t, log });
    await tickOnce(deps);
    expect(resign).toHaveBeenCalledTimes(1);
    expect(resign.mock.calls[0][2].solana?.recent_blockhash).toBeTruthy();
    expect(lines.some((l) => l.includes('no keeper allowance used'))).toBe(true);
    expect(['signed', 'broadcast']).toContain(s.stored('1').foreign[0].status);
    expect((await s.backend.getSignTrack('1', 0)).keeper_resigns).toBe(0);
  });

  it('an heir running the keeper (operator, not a keeper) may re-sign the skipped payout too', async () => {
    const clock = { t: T0 + HOUR + 10_000 };
    const s = atStep3(clock);
    s.backend.accountId = 'dmw-sweep-1.testnet';
    await tickOnce(makeDeps({ backend: s.backend, chains: mockChains(), contractId: C, now: () => clock.t, log: recordingLogger().log }));
    s.backend.accountId = 'sarah.testnet';
    s.backend.callerIsKeeper = false;
    const resign = vi.spyOn(s.backend, 'resignForeign');
    await tickOnce(makeDeps({ backend: s.backend, chains: mockChains(), contractId: C, now: () => clock.t, log: recordingLogger().log }));
    expect(resign).toHaveBeenCalledTimes(1);
    expect(s.stored('1').foreign[0].status).not.toBe('failed');
  });

  it('an operator step 3 is never skipped', async () => {
    const clock = { t: T0 + HOUR + 10_000 };
    const s = atStep3(clock);
    s.backend.accountId = 'sarah.testnet';
    await tickOnce(makeDeps({ backend: s.backend, chains: mockChains(), contractId: C, now: () => clock.t, log: recordingLogger().log }));
    expect(s.stored('1').foreign[0].status).not.toBe('failed');
    expect(isSkippedPayout(s.stored('1'), 0)).toBe(false);
  });
});

describe('H-1(3): a non-keeper replaces a keeper fee above the clamp at exactly the clamp', () => {
  const clamp = 10n * GWEI;
  it('max fee exactly the clamp, priority fee max(min(last, clamp), min(fresh, clamp))', () => {
    const fresh = { nonce: 0, max_fee_per_gas: String(3n * GWEI), max_priority_fee_per_gas: String(GWEI / 1000n), gas_limit: '21000' };
    const a = nonKeeperResignArgs(fresh, { max_fee_per_gas: String(50n * GWEI), max_priority_fee_per_gas: String(2n * GWEI) }, 'base', clamp)!;
    expect(a.max_fee_per_gas).toBe(String(clamp));
    expect(a.max_priority_fee_per_gas).toBe(String(2n * GWEI));
    const b = nonKeeperResignArgs(fresh, { max_fee_per_gas: String(50n * GWEI), max_priority_fee_per_gas: String(40n * GWEI) }, 'base', clamp)!;
    expect(b.max_fee_per_gas).toBe(String(clamp));
    expect(b.max_priority_fee_per_gas).toBe(String(clamp)); // min(last, clamp)
    // fresh priority above the old one, still never above the clamp
    const c = nonKeeperResignArgs({ ...fresh, max_priority_fee_per_gas: String(5n * GWEI), max_fee_per_gas: String(20n * GWEI) }, { max_fee_per_gas: String(50n * GWEI), max_priority_fee_per_gas: String(GWEI) }, 'base', clamp)!;
    expect(c).toMatchObject({ max_fee_per_gas: String(clamp), max_priority_fee_per_gas: String(5n * GWEI) });
  });
  it('below the clamp the 110% rule applies; a bump that would pass the clamp is not sent (null)', () => {
    const fresh = { nonce: 0, max_fee_per_gas: String(GWEI), max_priority_fee_per_gas: '1000000', gas_limit: '21000' };
    expect(signedAboveClamp({ max_fee_per_gas: String(clamp), max_priority_fee_per_gas: '1' }, clamp)).toBe(false);
    expect(nonKeeperResignArgs(fresh, { max_fee_per_gas: String(2n * GWEI), max_priority_fee_per_gas: '1000000' }, 'base', clamp)).toMatchObject({ max_fee_per_gas: String(2_200_000_000n), max_priority_fee_per_gas: '1100000' });
    expect(nonKeeperResignArgs(fresh, { max_fee_per_gas: String(clamp), max_priority_fee_per_gas: '1000000' }, 'base', clamp)).toBeNull();
  });
  it('the clamp comes from get_config().chains, with the registry values as fallback', () => {
    expect(nonKeeperFeeClamp('base')).toBe(10n * GWEI);
    expect(nonKeeperFeeClamp('monad')).toBe(200n * GWEI);
    expect(nonKeeperFeeClamp('base', { chains: [{ chain: 'base', non_keeper_max_fee_per_gas: '7000000000' }] })).toBe(7n * GWEI);
  });

  it('keeper loop: an heir re-signs a stale EVM payout a keeper signed at 50 gwei with exactly the clamp, and the contract takes it', async () => {
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
    const deps = makeDeps({ backend, chains, contractId: 'c', now: () => clock.t, log: recordingLogger().log });
    await tickOnce(deps); // signed by "the keeper" (the mock records the fresh fees); then stale, waiting
    backend.tracks.set('1:0', { ...(await backend.getSignTrack('1', 0)), max_fee_per_gas: String(50n * GWEI), max_priority_fee_per_gas: String(2n * GWEI) });
    backend.callerIsKeeper = false; // an heir's keeper
    const resign = vi.spyOn(backend, 'resignForeign');
    clock.t += 310_000;
    await tickOnce(deps);
    expect(resign).toHaveBeenCalledTimes(1);
    expect(resign.mock.calls[0][2].evm).toMatchObject({ max_fee_per_gas: String(10n * GWEI), max_priority_fee_per_gas: String(2n * GWEI) });
    expect(resign.mock.results[0].type).toBe('return');
    expect((await backend.getSignTrack('1', 0)).max_fee_per_gas).toBe(String(10n * GWEI)); // now at the clamp: normal rule again
  });

  it('mock contract: a non-keeper below the clamp, or with a dropped priority fee, is refused', async () => {
    const clock = { t: 1_000_000 };
    const backend = fresh(clock, { foreign: 'base' });
    await backend.getVaults();
    clock.t += 25_000;
    await tickOnce(makeDeps({ backend, chains: mockChains(), contractId: 'c', now: () => clock.t, log: recordingLogger().log }));
    backend.tracks.set('1:0', { last_request_ms: 0, inflight: false, max_fee_per_gas: String(50n * GWEI), max_priority_fee_per_gas: String(2n * GWEI), resign_allowed_after_ms: 0 });
    backend.callerIsKeeper = false;
    const evm = { nonce: 0, max_fee_per_gas: String(9n * GWEI), max_priority_fee_per_gas: String(2n * GWEI), gas_limit: '21000' };
    await expect(backend.resignForeign('1', 0, { evm })).rejects.toThrow(/re-sign below a keeper's fee/);
    await expect(backend.resignForeign('1', 0, { evm: { ...evm, max_fee_per_gas: String(10n * GWEI), max_priority_fee_per_gas: String(GWEI) } })).rejects.toThrow(/priority fee may not drop/);
    // above the clamp is clamped to it by the contract, so it is accepted
    await expect(backend.resignForeign('1', 0, { evm: { ...evm, max_fee_per_gas: String(30n * GWEI) } })).resolves.toBeTruthy();
  });
});

describe('views and payout limits', () => {
  it('parseSignTrack keeps the v3 counters, and leaves them out on a v2 view', () => {
    const v3 = parseSignTrack({ last_request_ms: 5, inflight: false, max_fee_per_gas: '1', max_priority_fee_per_gas: '2', resign_allowed_after_ms: 300_005, keeper_resigns: 2, keeper_resigns_left: 1 });
    expect(v3).toMatchObject({ keeper_resigns: 2, keeper_resigns_left: 1, resign_allowed_after_ms: 300_005 });
    const v2 = parseSignTrack({ last_request_ms: 5, inflight: true, max_fee_per_gas: '1', max_priority_fee_per_gas: '2', resign_allowed_after_ms: 300_005 });
    expect('keeper_resigns_left' in v2).toBe(false);
  });

  it('parseConfig reads the v3 get_config fields (and a v2 config without them)', () => {
    const c = parseConfig({
      owner_id: 'dmw.testnet',
      keeper: 'k.testnet',
      pending_keeper: 'k2.testnet',
      keeper_admin: 'cold.testnet',
      admin_timelock_ms: 172800000,
      admin_proposal: { action: 'keeper', account_id: 'k3.testnet', proposed_ms: 1, eta_ms: 172800001 },
      keeper_epoch: 2,
      max_keeper_solana_resigns: 3,
      sale_min_interval_s: 86400,
      sale_min_grace: 1,
      step3_open_after_ms: 3600000,
      chains: [
        { chain: 'base', kind: 'evm', max_fee_per_gas: '100000000000', non_keeper_max_fee_per_gas: '10000000000', max_payouts: 4, min_gas_limit: '50000' },
        { chain: 'solana', kind: 'solana', max_payouts: 1, max_keeper_resigns: 3 },
      ],
    });
    expect(c).toMatchObject({ pending_keeper: 'k2.testnet', keeper_admin: 'cold.testnet', keeper_epoch: 2, max_keeper_solana_resigns: 3, sale_min_interval_s: 86400, sale_min_grace: 1 });
    expect(c.admin_proposal).toEqual({ action: 'keeper', account_id: 'k3.testnet', proposed_ms: 1, eta_ms: 172800001 });
    expect(c.chains?.[1]).toEqual({ chain: 'solana', kind: 'solana', max_payouts: 1, max_keeper_resigns: 3 });
    expect(nonKeeperFeeClamp('base', c)).toBe(10n * GWEI);
    const v2 = parseConfig({ owner_id: 'dmw.testnet', keeper: null, step3_open_after_ms: 3600000 });
    expect(v2).toMatchObject({ keeper: null, pending_keeper: null, admin_proposal: null });
    expect(v2.keeper_epoch).toBeUndefined();
  });

  it('mock set_foreign_payouts: at most 1 Solana payout, a 32-byte base58 key, an amount within u64; EVM 0x + 40 hex', () => {
    const v = mockCreate(T0, { foreign: 'none' });
    const sol = { chain: 'solana' as const, to: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', amount: '1000000' };
    mockSetForeignPayouts(v, [sol], T0);
    expect(v.foreign).toHaveLength(1);
    expect(() => mockValidatePayouts([sol, sol])).toThrow('too many solana payouts (max 1 per vault)');
    expect(() => mockValidatePayouts([{ ...sol, to: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9Pus' }])).toThrow('solana `to` must be a base58 32-byte public key');
    expect(() => mockValidatePayouts([{ ...sol, to: '0OIl' + sol.to.slice(4) }])).toThrow('base58 32-byte');
    expect(() => mockValidatePayouts([{ ...sol, amount: '18446744073709551616' }])).toThrow('u64');
    expect(() => mockValidatePayouts([{ ...sol, amount: '18446744073709551615' }])).not.toThrow();
    expect(() => mockValidatePayouts([{ chain: 'base', to: '0x123', amount: '1' }])).toThrow('evm `to` must be 0x + 40 hex');
    expect(() => mockValidatePayouts([{ chain: 'monad', to: '0x' + 'a'.repeat(40), amount: '1' }, { chain: 'monad', to: '0x' + 'b'.repeat(40), amount: '1' }])).toThrow('too many monad payouts');
    const settled = { ...mockCreate(T0, { foreign: 'none' }), state: 'Settled' as const };
    expect(() => mockSetForeignPayouts(settled, [sol], T0)).toThrow(/Settled/);
  });
});
