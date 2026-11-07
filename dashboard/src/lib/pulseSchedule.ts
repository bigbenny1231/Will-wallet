// When the phone beats. Pure, so it can be tested with a fake clock.

/** Ceiling on the automatic period: never wait more than this between beats while the page is open. */
export const MAX_AUTO_PERIOD_S = 20;
/** Floor: the contract's shortest interval is 10 s, a third of that is 3.3 s; never beat faster than 3 s. */
export const MIN_PERIOD_S = 3;

/** Beat period in seconds: min(interval / 3, 20 s), or the override, clamped to [3 s, interval / 2]. */
export function beatPeriodS(intervalS: number, overrideS?: number | null): number {
  const auto = Math.min(intervalS / 3, MAX_AUTO_PERIOD_S);
  const want = overrideS && overrideS > 0 ? overrideS : auto;
  // An override longer than half the interval would risk missing a beat window.
  const ceiling = Math.max(MIN_PERIOD_S, intervalS / 2);
  return Math.round(Math.min(Math.max(want, MIN_PERIOD_S), ceiling) * 10) / 10;
}

/** Whether beats should be sent right now. */
export function shouldBeat(o: { stopped: boolean; visible: boolean; keepAlive: boolean; state: string | null }): boolean {
  if (o.stopped) return false;
  if (o.state === "Triggered" || o.state === "Settled") return false;
  return o.visible || o.keepAlive;
}

export interface Scheduler {
  /** ms timestamp of the next planned beat, or null when idle. */
  nextAt: number | null;
  /** A beat transaction is in flight; never overlap two (they would race on the key nonce). */
  inflight: boolean;
}

export const idle = (): Scheduler => ({ nextAt: null, inflight: false });

/**
 * One scheduler step. Returns the new schedule and whether to fire a beat now.
 * - When beating is not allowed, the schedule goes idle.
 * - Resuming from idle beats immediately (the page just became visible or was un-stopped).
 * - A beat in flight defers the next one; it is scheduled when the beat settles (`settled`).
 */
export function tick(s: Scheduler, now: number, allowed: boolean): { s: Scheduler; fire: boolean } {
  if (!allowed) return { s: { nextAt: null, inflight: s.inflight }, fire: false };
  if (s.inflight) return { s, fire: false };
  if (s.nextAt === null || now >= s.nextAt) return { s: { nextAt: null, inflight: true }, fire: true };
  return { s, fire: false };
}

/** Call when a beat finishes (ok or not). Failures retry sooner, but not in a tight loop. */
export function settled(now: number, periodS: number, ok: boolean): Scheduler {
  const wait = ok ? periodS : Math.min(periodS, 5);
  return { nextAt: now + wait * 1000, inflight: false };
}

/** Seconds until the next beat, for the countdown (0 while one is in flight). */
export function secondsUntil(s: Scheduler, now: number): number | null {
  if (s.inflight) return 0;
  if (s.nextAt === null) return null;
  return Math.max(0, Math.ceil((s.nextAt - now) / 1000));
}
