import { useEffect, useRef, useState } from "react";

/** Per-tick budget: a hung RPC request must not stall polling. */
export const POLL_TIMEOUT_MS = 8000;
/** Consecutive failures before the UI shows a "reconnecting" hint. */
export const RECONNECT_AFTER = 3;

/**
 * Runs `fn` with an AbortSignal and rejects after `timeoutMs` even if `fn`
 * ignores the signal (e.g. a fetch wrapper that never settles).
 */
export function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs = POLL_TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
  });
  return Promise.race([fn(ctrl.signal), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Polls an async fetcher every `ms`; keeps last good value; exposes error.
 * Each tick is capped at POLL_TIMEOUT_MS and the next tick is always scheduled.
 * `reconnecting` is true after RECONNECT_AFTER consecutive failures.
 */
export function usePoll<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failures, setFailures] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoaded(false);
    setFailures(0);
    const tick = async () => {
      try {
        const v = await withTimeout((s) => fnRef.current(s));
        if (!stop) {
          setData(v);
          setError(null);
          setFailures(0);
        }
      } catch (e) {
        if (!stop) {
          setError(e instanceof Error ? e.message : String(e));
          setFailures((n) => n + 1);
        }
      } finally {
        if (!stop) {
          setLoaded(true);
          timer = setTimeout(tick, ms);
        }
      }
    };
    tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loaded, failures, reconnecting: failures >= RECONNECT_AFTER };
}

export function useNow(ms = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
