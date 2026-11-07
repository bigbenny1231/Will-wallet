// Parsers for the `detail` strings the contract writes into the vault log (lib.rs `record(...)`).
import { yoctoToNear } from "./format";
import type { LogEntry } from "../types";

export interface AgentLogRow {
  ms: number;
  allowed: boolean;
  /** policy reason when denied */
  reason: string;
  receiver: string;
  /** amount in yoctoNEAR (string), "" when the detail has none */
  amount: string;
}

/**
 * agent_pay_allowed detail: `<receiver> <yocto>`
 * agent_pay_denied  detail: `<reason> <receiver> <yocto>`
 * (also accepts the older `reason=x receiver=y amount=z NEAR` form from mock mode)
 */
export function parseAgentLog(e: LogEntry): AgentLogRow {
  const allowed = e.event === "agent_pay_allowed";
  const d = (e.detail ?? "").trim();
  const kv = d.match(/reason=([a-z_]+)/i);
  if (kv) {
    const r = d.match(/receiver=(\S+)/i);
    const a = d.match(/amount=([0-9.]+)/i);
    return { ms: e.ms, allowed, reason: kv[1], receiver: r?.[1] ?? "", amount: a ? nearStrToYocto(a[1]) : "" };
  }
  const parts = d.split(/\s+/).filter(Boolean);
  if (!allowed) {
    const [reason = "", receiver = "", amount = ""] = parts;
    return { ms: e.ms, allowed, reason, receiver, amount: /^\d+$/.test(amount) ? amount : "" };
  }
  const [receiver = "", amount = ""] = parts;
  return { ms: e.ms, allowed, reason: "", receiver, amount: /^\d+$/.test(amount) ? amount : "" };
}

function nearStrToYocto(n: string): string {
  const [w, f = ""] = n.split(".");
  return (BigInt(w || "0") * 10n ** 24n + BigInt(f.padEnd(24, "0").slice(0, 24) || "0")).toString();
}

export function agentRowAmount(r: AgentLogRow): string {
  return r.amount ? `${yoctoToNear(r.amount, 6)} NEAR` : "";
}

export interface Step1Payout {
  account: string;
  /** NEAR as printed by the contract (fmt_near), e.g. "1.29" */
  amount: string;
}

/**
 * step_1 detail: `<account> <amount> NEAR, <account> <amount> NEAR, ...`
 * Account ids never contain spaces or commas, so splitting on ", " is safe.
 */
export function parseStep1Detail(detail?: string | null): Step1Payout[] {
  if (!detail) return [];
  const out: Step1Payout[] = [];
  for (const item of detail.split(/\s*[,;]\s+/)) {
    const m = item.trim().match(/^(\S+)\s+([0-9]+(?:\.[0-9]+)?)\s+NEAR$/);
    if (m) out.push({ account: m[1], amount: m[2] });
  }
  return out;
}

export function step1AmountFor(detail: string | null | undefined, account: string): string | null {
  return parseStep1Detail(detail).find((p) => p.account === account)?.amount ?? null;
}

/** Latest log entry for an event name. */
export function lastEvent(log: LogEntry[], event: string): LogEntry | undefined {
  for (let i = log.length - 1; i >= 0; i--) if (log[i].event === event) return log[i];
  return undefined;
}
