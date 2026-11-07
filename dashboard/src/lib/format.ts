const YOCTO = 10n ** 24n;

export function yoctoToNear(y: string | bigint | undefined | null, maxFrac = 4): string {
  if (y === undefined || y === null || y === "") return "0";
  const v = BigInt(y);
  const whole = v / YOCTO;
  const frac = v % YOCTO;
  if (frac === 0n) return whole.toString();
  const f = frac.toString().padStart(24, "0").slice(0, maxFrac).replace(/0+$/, "");
  return f ? `${whole}.${f}` : whole.toString();
}

/** yocto -> NEAR with 2 to 4 decimals (truncated, never rounded up), e.g. "0.05", "1.2346". */
export function fmtNear(y: string | bigint | undefined | null, minFrac = 2, maxFrac = 4): string {
  if (y === undefined || y === null || y === "") return "0.00";
  const v = BigInt(y);
  const whole = v / YOCTO;
  let f = (v % YOCTO).toString().padStart(24, "0").slice(0, maxFrac).replace(/0+$/, "");
  f = f.padEnd(minFrac, "0");
  return `${whole}.${f}`;
}

/** Replaces raw yocto integers (15+ digits) inside a contract log detail with "<n> NEAR". */
export function humanizeYocto(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\b\d{15,}\b/g, (m) => `${fmtNear(m)} NEAR`);
}

export function nearToYocto(near: string): string {
  const s = near.trim();
  if (!/^\d+(\.\d{0,24})?$/.test(s)) throw new Error(`Invalid NEAR amount: ${near}`);
  const [w, f = ""] = s.split(".");
  return (BigInt(w) * YOCTO + BigInt(f.padEnd(24, "0"))).toString();
}

export function bpsToPct(bps: number): string {
  const p = bps / 100;
  return Number.isInteger(p) ? `${p}%` : `${p.toFixed(2)}%`;
}

export function shareOf(balance: string, bps: number): string {
  return ((BigInt(balance) * BigInt(bps)) / 10000n).toString();
}

export function shortKey(k: string, n = 10): string {
  const i = k.indexOf(":");
  const body = i >= 0 ? k.slice(i + 1) : k;
  return `${i >= 0 ? k.slice(0, i + 1) : ""}${body.slice(0, n)}…${body.slice(-4)}`;
}

export function shortAddr(a: string, n = 8): string {
  return a.length <= n * 2 + 1 ? a : `${a.slice(0, n)}…${a.slice(-6)}`;
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

export function fmtInterval(s: number): string {
  if (s % 86400 === 0) return `${s / 86400} day${s === 86400 ? "" : "s"}`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function unitsFor(chain: "base" | "solana", amount: string): string {
  const a = BigInt(amount || "0");
  if (chain === "base") {
    const d = 10n ** 18n;
    return `${trim(a, d, 18)} ETH`;
  }
  return `${trim(a, 10n ** 9n, 9)} SOL`;
}

function trim(a: bigint, d: bigint, digits: number): string {
  const w = a / d;
  const f = (a % d).toString().padStart(digits, "0").replace(/0+$/, "");
  return f ? `${w}.${f}` : w.toString();
}

export function toSmallest(chain: "base" | "solana", human: string): string {
  const digits = chain === "base" ? 18 : 9;
  const s = human.trim();
  if (!new RegExp(`^\\d+(\\.\\d{0,${digits}})?$`).test(s)) throw new Error("Invalid amount");
  const [w, f = ""] = s.split(".");
  return (BigInt(w) * 10n ** BigInt(digits) + BigInt(f.padEnd(digits, "0"))).toString();
}

/** Step 1 keeps a reserve in the vault: 1.5 NEAR with a DAO (bond + gas), 0.1 NEAR without. */
export function step1Reserve(hasDao: boolean): bigint {
  return hasDao ? 15n * 10n ** 23n : 10n ** 23n;
}

/** What an heir with `bps` would receive in step 1 at the current balance. */
export function expectedShare(balance: string, bps: number, hasDao: boolean): string {
  const b = BigInt(balance);
  const r = step1Reserve(hasDao);
  const d = b > r ? b - r : 0n;
  return ((d * BigInt(bps)) / 10000n).toString();
}
