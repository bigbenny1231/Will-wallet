import pc from 'picocolors';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function backoffDelay(attempt: number, baseMs = 500, maxMs = 15_000): number {
  return Math.min(maxMs, baseMs * 2 ** attempt);
}

const PANIC_MARKERS = ['Smart contract panicked', 'ExecutionError', 'FunctionCallError', 'MethodResolveError'];

/** Transport-level trouble worth retrying. Contract panics are NOT transient. */
export function isTransient(err: unknown): boolean {
  const e = err as { message?: string; type?: string; code?: string; cause?: { code?: string } };
  const msg = `${e?.message ?? err} ${e?.type ?? ''} ${e?.code ?? ''} ${e?.cause?.code ?? ''}`;
  if (PANIC_MARKERS.some((m) => msg.includes(m))) return false;
  return /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|timeout|timed out|TimeoutError|RetriesExceeded|429|Too Many|50[0-4]|Server error|UNKNOWN_BLOCK|UNAVAILABLE|network|Rate limit|overloaded/i.test(
    msg,
  );
}

export interface RetryOpts {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  isRetryable?: (e: unknown) => boolean;
  onRetry?: (e: unknown, attempt: number, delayMs: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, o: RetryOpts = {}): Promise<T> {
  const { retries = 4, baseMs = 500, maxMs = 15_000, sleep: sl = sleep, isRetryable = isTransient } = o;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !isRetryable(e)) throw e;
      const d = backoffDelay(attempt, baseMs, maxMs);
      o.onRetry?.(e, attempt + 1, d);
      await sl(d);
    }
  }
}

export const errMsg = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 300 ? m.slice(0, 300) + '…' : m;
};

// ------------------------------------------------------------------ explorers

export const isMockHash = (h: string) => h.startsWith('mock');

export function nearTxLink(hash: string): string {
  return isMockHash(hash) ? `(mock tx ${hash})` : `https://testnet.nearblocks.io/txns/${hash}`;
}
export function baseTxLink(hash: string): string {
  return isMockHash(hash) ? `(mock tx ${hash})` : `https://sepolia.basescan.org/tx/${hash}`;
}
export function solanaTxLink(sig: string): string {
  return isMockHash(sig) ? `(mock tx ${sig})` : `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}
export function monadTxLink(hash: string): string {
  return isMockHash(hash) ? `(mock tx ${hash})` : `https://testnet.monadexplorer.com/tx/${hash}`;
}
export function foreignTxLink(chain: 'base' | 'monad' | 'solana', hash: string): string {
  return chain === 'base' ? baseTxLink(hash) : chain === 'monad' ? monadTxLink(hash) : solanaTxLink(hash);
}

// ------------------------------------------------------------------- logging

const ts = () => new Date().toISOString().slice(11, 19);

/**
 * Strip C0/C1 control characters (ESC, CSI, BEL, CR, ...) from text that came from the chain or an RPC node, so a
 * vault log detail, payout address or node error cannot move the cursor, rewrite earlier lines or retitle the
 * terminal (AUDIT_FINAL_OFFCHAIN F-09). Newlines and tabs become spaces.
 */
export const termSafe = (s: string): string => String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => (c === '\n' || c === '\t' ? ' ' : ''));

export function logLine(tag: string, msg: string, color: (s: string) => string = (s) => s): void {
  process.stdout.write(`${pc.dim(ts())} ${color(tag.padEnd(9))} ${termSafe(msg)}\n`);
}
export const logOk = (tag: string, msg: string) => logLine(tag, msg, pc.green);
export const logWarn = (tag: string, msg: string) => logLine(tag, msg, pc.yellow);
export const logErr = (tag: string, msg: string) => logLine(tag, msg, pc.red);
export const logInfo = (tag: string, msg: string) => logLine(tag, msg, pc.cyan);

// ------------------------------------------------------------------- events

export interface DmwEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Parse NEP-297 `EVENT_JSON:{...}` lines, keeping only standard "dmw". */
export function parseEvents(logs: string[]): DmwEvent[] {
  const out: DmwEvent[] = [];
  for (const l of logs) {
    const i = l.indexOf('EVENT_JSON:');
    if (i < 0) continue;
    try {
      const j = JSON.parse(l.slice(i + 'EVENT_JSON:'.length));
      if (j?.standard === 'dmw' && typeof j.event === 'string') {
        const data = Array.isArray(j.data) ? (j.data[0] ?? {}) : (j.data ?? {});
        out.push({ event: j.event, data });
      }
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

export function formatYocto(y: string | bigint, digits = 4): string {
  const v = BigInt(y);
  const whole = v / 10n ** 24n;
  const frac = (v % 10n ** 24n).toString().padStart(24, '0').slice(0, digits);
  return `${whole}.${frac} NEAR`;
}
