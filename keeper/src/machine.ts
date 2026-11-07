// Pure logic: state derivation (SPEC §2.2), countdown math, and keeper step scheduling (SPEC §2.4, §3).
import type { ChainName, VaultState, VaultView } from './types.js';

export const toMs = (s: number) => s * 1000;

/** Moment at which the vault enters Warning (one missed interval). */
export function warningAtMs(v: Pick<VaultView, 'last_beat_ms' | 'heartbeat_interval_s'>): number {
  return v.last_beat_ms + toMs(v.heartbeat_interval_s);
}

/** Moment at which `poke` becomes legal: last_beat + interval * (grace_missed + 1). */
export function triggerAtMs(
  v: Pick<VaultView, 'last_beat_ms' | 'heartbeat_interval_s' | 'grace_missed'>,
): number {
  return v.last_beat_ms + toMs(v.heartbeat_interval_s) * (v.grace_missed + 1);
}

/** Alive / Warning are derived from the clock; Triggered / Settled are stored. */
export function deriveState(v: VaultView, now: number): VaultState {
  if (v.state === 'Triggered' || v.state === 'Settled') return v.state;
  return now < warningAtMs(v) ? 'Alive' : 'Warning';
}

/** True when the vault has not been poked yet but the deadline has passed. */
export function isDue(v: VaultView, now: number): boolean {
  if (v.state === 'Triggered' || v.state === 'Settled') return false;
  return now >= triggerAtMs(v);
}

export interface Countdown {
  state: VaultState;
  /** ms until the next heartbeat is due (Warning starts); <= 0 once late. */
  msToWarning: number;
  /** ms until poke becomes legal; <= 0 once due. */
  msToTrigger: number;
  due: boolean;
}

export function countdown(v: VaultView, now: number): Countdown {
  return {
    state: deriveState(v, now),
    msToWarning: warningAtMs(v) - now,
    msToTrigger: triggerAtMs(v) - now,
    due: isDue(v, now),
  };
}

/** "42s", "1m05s", "2h03m". Never negative; rounds up so the display hits 0 only at the deadline. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

/** The pulse daemon's countdown line. */
export function pulseLine(msToNextBeat: number): string {
  if (msToNextBeat <= 0) return 'alive · beating now';
  return `alive · next beat in ${formatDuration(msToNextBeat)}`;
}

/** Time of the next beat given the last beat and the daemon interval. */
export function nextBeatAt(lastBeatAt: number, intervalS: number): number {
  return lastBeatAt + toMs(intervalS);
}

/** Basis-point split with floor division, matching the contract's `balance * bps / 10000`. */
export function bpsShare(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10_000n;
}

export const bpsTotal = (heirs: { bps: number }[]) => heirs.reduce((a, h) => a + h.bps, 0);

// ---------------------------------------------------------------- scheduling

export type KeeperAction =
  | { kind: 'relay'; index: number; chain: ChainName }
  | { kind: 'poke' }
  /** `chain` is set when step 3 needs chain-environment params for foreign[index]. */
  | { kind: 'step'; step: number; chain?: ChainName; index?: number };

/**
 * The single next thing the keeper should do for a vault, or null.
 * Relaying comes first: a Solana blockhash baked into a signed tx expires in ~60-90 s.
 */
export function nextAction(v: VaultView, now: number): KeeperAction | null {
  if (v.state === 'Triggered' || v.state === 'Settled') {
    const idx = v.foreign.findIndex((p) => p.status === 'signed' && !!p.signed_tx);
    if (idx >= 0) return { kind: 'relay', index: idx, chain: v.foreign[idx].chain };
  }
  if (v.state === 'Settled') return null;
  if (v.state === 'Triggered') {
    if (v.step === 3 && v.foreign_index < v.foreign.length) {
      return { kind: 'step', step: 3, chain: v.foreign[v.foreign_index].chain, index: v.foreign_index };
    }
    return { kind: 'step', step: v.step };
  }
  if (isDue(v, now)) return { kind: 'poke' };
  return null;
}

/** Everything the keeper must still do for one vault, in order (used for status/preview, not execution). */
export function describeAction(a: KeeperAction): string {
  switch (a.kind) {
    case 'poke':
      return 'poke';
    case 'relay':
      return `relay payout #${a.index} (${a.chain})`;
    case 'step':
      return a.chain ? `execute_step ${a.step} (${a.chain} payout #${a.index})` : `execute_step ${a.step}`;
  }
}

export function isTerminal(v: VaultView): boolean {
  return v.state === 'Settled' && !v.foreign.some((p) => p.status === 'signed');
}
