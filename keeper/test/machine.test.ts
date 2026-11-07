import { describe, expect, it } from 'vitest';
import {
  bpsShare, countdown, deriveState, formatDuration, isDue, nextAction, nextBeatAt, pulseLine, triggerAtMs, warningAtMs,
} from '../src/machine.js';
import { mockCreate } from '../src/mock.js';

const T0 = 1_700_000_000_000;
const vault = (o = {}) => ({ ...mockCreate(T0, { heartbeat_interval_s: 60, grace_missed: 2 }), ...o });

describe('state derivation (SPEC 2.2)', () => {
  it('is Alive before one interval, Warning after, and due after interval*(grace+1)', () => {
    const v = vault();
    expect(deriveState(v, T0 + 59_999)).toBe('Alive');
    expect(deriveState(v, T0 + 60_000)).toBe('Warning');
    expect(isDue(v, T0 + 179_999)).toBe(false);
    expect(isDue(v, T0 + 180_000)).toBe(true);
    expect(triggerAtMs(v)).toBe(T0 + 180_000);
    expect(warningAtMs(v)).toBe(T0 + 60_000);
  });
  it('keeps stored Triggered/Settled states regardless of the clock and is never "due" again', () => {
    expect(deriveState(vault({ state: 'Triggered' }), T0)).toBe('Triggered');
    expect(deriveState(vault({ state: 'Settled' }), T0 + 1e12)).toBe('Settled');
    expect(isDue(vault({ state: 'Triggered' }), T0 + 1e12)).toBe(false);
  });
});

describe('countdown math', () => {
  it('reports ms to warning and trigger', () => {
    const c = countdown(vault(), T0 + 30_000);
    expect(c).toMatchObject({ state: 'Alive', msToWarning: 30_000, msToTrigger: 150_000, due: false });
  });
  it('goes negative once late and flags due', () => {
    const c = countdown(vault(), T0 + 200_000);
    expect(c.msToTrigger).toBe(-20_000);
    expect(c.due).toBe(true);
  });
  it('formats durations, rounding up and never negative', () => {
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(41_001)).toBe('42s');
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(65_000)).toBe('1m05s');
    expect(formatDuration(3_723_000)).toBe('1h02m');
  });
  it('renders the pulse line and schedules the next beat', () => {
    expect(pulseLine(42_000)).toBe('alive · next beat in 42s');
    expect(pulseLine(0)).toBe('alive · beating now');
    expect(nextBeatAt(T0, 60)).toBe(T0 + 60_000);
  });
  it('splits balances by bps with floor division', () => {
    expect(bpsShare(1_000_000n, 6000)).toBe(600_000n);
    expect(bpsShare(10n, 3333)).toBe(3n);
    expect(bpsShare(100n, 6000) + bpsShare(100n, 4000)).toBe(100n);
  });
});

describe('step scheduling', () => {
  it('does nothing for a healthy vault, pokes when due', () => {
    expect(nextAction(vault(), T0 + 1000)).toBeNull();
    expect(nextAction(vault(), T0 + 180_000)).toEqual({ kind: 'poke' });
  });
  it('executes the current step for a Triggered vault', () => {
    expect(nextAction(vault({ state: 'Triggered', step: 1 }), T0)).toEqual({ kind: 'step', step: 1 });
    expect(nextAction(vault({ state: 'Triggered', step: 4 }), T0)).toEqual({ kind: 'step', step: 4 });
  });
  it('asks for chain params on step 3 for the next payout only', () => {
    const v = vault({ state: 'Triggered', step: 3, foreign_index: 1 });
    expect(nextAction(v, T0)).toEqual({ kind: 'step', step: 3, chain: 'solana', index: 1 });
    const done = vault({ state: 'Triggered', step: 3, foreign_index: 2 });
    expect(nextAction(done, T0)).toEqual({ kind: 'step', step: 3 });
  });
  it('relays signed payouts before stepping, and after Settled', () => {
    const v = vault({ state: 'Triggered', step: 3, foreign_index: 1 });
    v.foreign[0] = { ...v.foreign[0], status: 'signed', signed_tx: '0xabc' };
    expect(nextAction(v, T0)).toEqual({ kind: 'relay', index: 0, chain: 'base' });
    const s = vault({ state: 'Settled', step: 5 });
    s.foreign[1] = { ...s.foreign[1], status: 'signed', signed_tx: 'AAAA' };
    expect(nextAction(s, T0)).toEqual({ kind: 'relay', index: 1, chain: 'solana' });
    s.foreign[1].status = 'broadcast';
    expect(nextAction(s, T0)).toBeNull();
  });
  it('ignores failed payouts', () => {
    const v = vault({ state: 'Settled' });
    v.foreign[0].status = 'failed';
    expect(nextAction(v, T0)).toBeNull();
  });
});
