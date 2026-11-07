import { describe, expect, it } from 'vitest';
import {
  MOCK_RESERVE, mockAgentPay, mockCreate, mockExecuteStep, mockHeartbeat, mockMarkBroadcast, mockPoke,
} from '../src/mock.js';

const T0 = 1_700_000_000_000;
const NEAR = 10n ** 24n;
const mk = () => mockCreate(T0, { heartbeat_interval_s: 10, grace_missed: 1, withDao: true });
const args = { evm: { nonce: 0, max_fee_per_gas: '1', max_priority_fee_per_gas: '1', gas_limit: '21000' }, solana: { recent_blockhash: 'abc' } };

describe('mock vault state machine (SPEC 2.2/2.4)', () => {
  it('heartbeat resets the clock and is rejected once Triggered', () => {
    const v = mk();
    mockHeartbeat(v, T0 + 5000);
    expect(v.last_beat_ms).toBe(T0 + 5000);
    v.state = 'Triggered';
    expect(() => mockHeartbeat(v, T0 + 6000)).toThrow(/rejected/);
  });
  it('poke panics not_due, then triggers and pays the bounty', () => {
    const v = mk();
    expect(() => mockPoke(v, T0 + 19_999)).toThrow('not_due');
    const before = BigInt(v.balance);
    mockPoke(v, T0 + 20_000);
    expect(v.state).toBe('Triggered');
    expect(v.step).toBe(1);
    expect(BigInt(v.balance)).toBe(before - BigInt(v.bounty));
  });
  it('runs the five steps in order and ends Settled with the NFT at the top heir', () => {
    const v = mk();
    mockPoke(v, T0 + 20_000);
    const seen: number[] = [];
    while (v.state === 'Triggered') seen.push(mockExecuteStep(v, T0 + 21_000, args).step);
    expect(seen).toEqual([2, 3, 3, 4, 5, 5]);
    expect(v.state).toBe('Settled');
    expect(v.owner_id).toBe('sarah.testnet');
    expect(v.pulse_keys).toEqual([]);
    expect(v.agent_keys).toEqual([]);
    expect(v.dao_proposal_id).toBe(1);
    expect(BigInt(v.balance)).toBeGreaterThanOrEqual(0n);
  });
  it('step 1 pays heirs by bps and keeps the reserve', () => {
    const v = mk();
    mockPoke(v, T0 + 20_000);
    const bal = BigInt(v.balance);
    mockExecuteStep(v, T0 + 21_000);
    const dist = bal - MOCK_RESERVE;
    const paid = (dist * 6000n) / 10_000n + (dist * 4000n) / 10_000n;
    expect(BigInt(v.balance)).toBe(bal - paid);
    expect(BigInt(v.balance) - MOCK_RESERVE).toBeLessThan(2n); // only floor-division dust beyond the reserve
  });
  it('step 3 refuses to sign without the chain params and signs one payout per call', () => {
    const v = mk();
    mockPoke(v, T0 + 20_000);
    mockExecuteStep(v, T0 + 21_000);
    mockExecuteStep(v, T0 + 21_000);
    expect(() => mockExecuteStep(v, T0 + 21_000)).toThrow(/args\.evm/);
    mockExecuteStep(v, T0 + 21_000, args);
    expect(v.foreign.map((p) => p.status)).toEqual(['signed', 'pending']);
    expect(v.foreign_index).toBe(1);
    mockMarkBroadcast(v, 0, '0xhash', T0);
    expect(v.foreign[0]).toMatchObject({ status: 'broadcast', tx_hash: '0xhash' });
  });
  it('execute_step is rejected unless Triggered', () => {
    expect(() => mockExecuteStep(mk(), T0)).toThrow(/Alive/);
  });
});

describe('mock agent_pay policy', () => {
  it('allows a small allowlisted payment and debits the balance', () => {
    const v = mk();
    const r = mockAgentPay(v, T0, 'api.provider.testnet', NEAR / 10n);
    expect(r.allowed).toBe(true);
    expect(v.daily_spent).toBe(String(NEAR / 10n));
    expect(r.logs[0]).toContain('agent_pay_allowed');
  });
  it.each([
    ['over_per_tx_max', 'api.provider.testnet', 2n * NEAR],
    ['receiver_not_allowlisted', 'stranger.testnet', NEAR / 10n],
  ])('denies with %s', (reason, to, amt) => {
    const r = mockAgentPay(mk(), T0, to, amt);
    expect(r).toMatchObject({ allowed: false, reason });
    expect(r.logs[0]).toContain(reason);
  });
  it('enforces the daily cap and resets the window after 24h', () => {
    const v = mk();
    for (let i = 0; i < 5; i++) expect(mockAgentPay(v, T0, 'api.provider.testnet', NEAR).allowed).toBe(true);
    expect(mockAgentPay(v, T0, 'api.provider.testnet', NEAR).reason).toBe('over_daily_max');
    v.balance = String(10n * NEAR);
    expect(mockAgentPay(v, T0 + 86_400_000, 'api.provider.testnet', NEAR / 2n).allowed).toBe(true);
    expect(v.daily_spent).toBe(String(NEAR / 2n));
  });
  it('denies when the vault is not alive', () => {
    const v = mk();
    v.state = 'Triggered';
    expect(mockAgentPay(v, T0, 'api.provider.testnet', 1n).reason).toBe('vault_not_alive');
  });
});
