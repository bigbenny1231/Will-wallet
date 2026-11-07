import { useEffect, useRef, useState } from "react";

/** Polls an async fetcher every `ms`; keeps last good value; exposes error. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    setLoaded(false);
    const tick = async () => {
      try {
        const v = await fnRef.current();
        if (!stop) {
          setData(v);
          setError(null);
        }
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
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
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loaded };
}

export function useNow(ms = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
