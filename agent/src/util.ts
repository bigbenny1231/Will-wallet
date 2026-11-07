export const YOCTO = 10n ** 24n;

/** "0.12" -> yoctoNEAR bigint. Exact decimal parse (no floats). Throws on anything else. */
export function parseNear(s: string): bigint {
  const t = String(s).trim();
  if (!/^\d+(\.\d{1,24})?$/.test(t)) throw new Error(`not a NEAR amount: ${JSON.stringify(s)}`);
  const [w, f = ''] = t.split('.');
  return BigInt(w) * YOCTO + BigInt(f.padEnd(24, '0'));
}

/** yoctoNEAR -> exact decimal string, trailing zeros trimmed ("0.12", "1", "2.9"). */
export function fmtNear(y: string | bigint): string {
  const v = BigInt(y);
  const w = v / YOCTO;
  const f = (v % YOCTO).toString().padStart(24, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : `${w}`;
}

export const nearTxLink = (hash: string) => (hash.startsWith('sim-') ? `simulated:${hash}` : `https://testnet.nearblocks.io/txns/${hash}`);
export const nearAccountLink = (id: string) => `https://testnet.nearblocks.io/address/${id}`;

// NEAR implicit/named account ids, lower-case, 2..64 chars.
export const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isAccountId = (s: string) => s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);

export function parseEvents(logs: string[]): { event: string; data: Record<string, unknown> }[] {
  const out: { event: string; data: Record<string, unknown> }[] = [];
  for (const l of logs) {
    const i = l.indexOf('EVENT_JSON:');
    if (i < 0) continue;
    try {
      const j = JSON.parse(l.slice(i + 'EVENT_JSON:'.length));
      if (j?.standard === 'dmw' && typeof j.event === 'string') {
        out.push({ event: j.event, data: Array.isArray(j.data) ? (j.data[0] ?? {}) : (j.data ?? {}) });
      }
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

export const errMsg = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 300 ? m.slice(0, 300) + '…' : m;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const TRANSIENT = /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|timeout|timed out|429|Too Many|50[0-4]|Server error|UNKNOWN_BLOCK|overloaded/i;
const PANIC = /Smart contract panicked|ExecutionError|FunctionCallError|MethodResolveError|InvalidAccessKey|AccessKeyNotFound/;

/** Retry transport hiccups only. Contract panics and key-scope rejections are never retried. */
export async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? `${e.message} ${e.name}` : String(e);
      if (i >= retries || PANIC.test(msg) || !TRANSIENT.test(msg)) throw e;
      await sleep(Math.min(8000, 500 * 2 ** i));
    }
  }
}
