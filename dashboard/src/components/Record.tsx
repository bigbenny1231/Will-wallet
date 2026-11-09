import { fmtInterval, fmtNear, humanizeYocto, shortAccount, shortKey, yoctoToNear } from "../lib/format";
import { parseAgentLog, parseStep1Detail } from "../lib/logparse";
import type { LogEntry, VaultView } from "../types";

/**
 * The Will NFT's history: who made it, what it paid, who holds it now. Read from the vault's on-chain log
 * (`get_vault().log`, which keeps the last 40 entries), newest first, with runs of heartbeats folded into one line.
 */
export interface RecordRow {
  ms: number;
  /** Last entry of a folded run (heartbeats), else undefined. */
  untilMs?: number;
  tone: "life" | "warn" | "dead" | "brass" | "plain";
  title: string;
  detail: string;
}

const names = (alias: (id: string) => string | null, id: string) => alias(id) ?? shortAccount(id);

export function describe(e: LogEntry, alias: (id: string) => string | null = () => null): Omit<RecordRow, "ms"> {
  const d = (e.detail ?? "").trim();
  switch (e.event) {
    case "vault_created":
      return { tone: "brass", title: "Vault created, Will NFT minted", detail: d ? `to ${names(alias, d)}` : "" };
    case "deposit":
      return { tone: "plain", title: "Deposit", detail: /^\d+$/.test(d) ? `${fmtNear(d)} NEAR` : humanizeYocto(d) };
    case "heartbeat":
      return { tone: "life", title: "Heartbeat", detail: d === "pulse_key" ? "by a pulse key" : d ? "by the owner" : "" };
    case "key_added":
      return { tone: "plain", title: "Key added", detail: keyDetail(d) };
    case "key_add_requested":
      return { tone: "plain", title: "Key requested", detail: keyDetail(d) };
    case "key_add_failed":
      return { tone: "dead", title: "Key could not be added", detail: keyDetail(d) };
    case "key_add_revoked":
      return { tone: "warn", title: "Key revoked", detail: keyDetail(d) };
    case "key_removed":
      return { tone: "plain", title: "Key removed", detail: keyDetail(d) };
    case "owner_changed":
      return { tone: "brass", title: "Will NFT transferred", detail: d.replace(/[0-9a-f]{64}/g, (m) => names(alias, m)) };
    case "transfer_failed": {
      const m = d.match(/^(\S+) (\S+) (\d+)$/);
      return { tone: "warn", title: "A transfer failed and was returned to the vault", detail: m ? `${fmtNear(m[3])} NEAR to ${names(alias, m[2])}` : humanizeYocto(d) };
    }
    case "foreign_signed":
    case "foreign_failed":
    case "foreign_resign_failed": {
      const m = d.match(/^#(\d+) (.*)$/);
      const ok = e.event === "foreign_signed";
      return { tone: ok ? "brass" : "dead", title: `Step III: payout ${m ? Number(m[1]) + 1 : ""} ${ok ? "signed by NEAR’s MPC network" : "failed"}`.replace("  ", " "), detail: m ? shortHash(m[2].replace(/^signed /, "tx ")) : d };
    }
    case "dao_proposal":
      return { tone: "brass", title: "Step IV: proposal filed in the estate DAO", detail: d };
    case "dao_proposal_failed":
      return { tone: "warn", title: "Step IV: the DAO proposal failed; the bond returned", detail: d };
    case "heirs_set":
      return { tone: "plain", title: "Heirs changed", detail: d };
    case "policy_set":
      return { tone: "plain", title: "Agent policy changed", detail: humanizeYocto(d) };
    case "foreign_set":
      return { tone: "plain", title: "Foreign payouts set", detail: d };
    case "timing_set": {
      const m = d.match(/^(\d+)s x(\d+)$/);
      return { tone: "plain", title: "Timing changed", detail: m ? `every ${fmtInterval(Number(m[1]))}, ${m[2]} missed beat${m[2] === "1" ? "" : "s"} allowed` : d };
    }
    case "dao_set":
      return { tone: "plain", title: "Estate DAO set", detail: d };
    case "guardian_set":
      return { tone: "plain", title: d === "cleared" ? "Guardian cleared" : "Guardian named", detail: d === "cleared" ? "" : d.replace(/ (\d+)s$/, (_, s) => `, may pause up to ${fmtInterval(Number(s))}`) };
    case "paused":
      return { tone: "warn", title: "Paused", detail: d.replace(/ until \d+$/, "").replace(/^(guardian|owner) /, "by the $1, ") };
    case "agent_pay_allowed":
    case "agent_pay_denied": {
      const r = parseAgentLog(e);
      const amount = r.amount ? `${fmtNear(r.amount)} NEAR` : "";
      return r.allowed
        ? { tone: "life", title: "Agent payment allowed", detail: `${amount} to ${names(alias, r.receiver)}` }
        : { tone: "dead", title: "Agent payment denied", detail: `${amount} to ${names(alias, r.receiver)}: ${r.reason.replace(/_/g, " ")}` };
    }
    case "triggered":
      return { tone: "dead", title: "Triggered", detail: humanizeYocto(d).replace(/^by /, "poked by ").replace(/(\.\d*?[1-9])0+ NEAR/, "$1 NEAR") };
    case "step_1": {
      const paid = parseStep1Detail(d);
      return { tone: "brass", title: "Step I: heirs paid on NEAR", detail: paid.length ? paid.map((p) => `${p.amount} NEAR to ${names(alias, p.account)}`).join(", ") : humanizeYocto(d) };
    }
    case "step_2":
      return { tone: "brass", title: "Step II: pulse and agent keys deleted", detail: d };
    case "step_3":
      return { tone: "brass", title: "Step III: foreign payouts done", detail: d === "foreign payouts done" ? "" : d };
    case "step_4":
      return { tone: "brass", title: "Step IV: estate DAO", detail: d.replace(/^no dao; skipped$/, "none named, so skipped") };
    case "step_5":
      return { tone: "brass", title: "Step V: Will NFT handed over", detail: d.replace(/^will nft -> /, "to ").replace(/[0-9a-f]{64}/, (m) => names(alias, m)) };
    case "settled":
      return { tone: "brass", title: "Settled", detail: d ? `held by ${names(alias, d)}` : "" };
    case "claim": {
      const m = d.match(/^(\S+) (\d+)$/);
      return { tone: "plain", title: "Remaining balance claimed", detail: m ? `${yoctoToNear(m[2])} NEAR by ${names(alias, m[1])}` : /^\d+$/.test(d) ? `${yoctoToNear(d)} NEAR` : humanizeYocto(d) };
    }
    case "foreign_broadcast": {
      const m = d.match(/^#(\d+) (.*)$/);
      return { tone: "life", title: `Foreign payout ${m ? Number(m[1]) + 1 : ""} relayed`.replace("  ", " "), detail: m ? shortHash(`tx ${m[2]}`) : d };
    }
    case "dao_ratified":
      return { tone: "brass", title: "Ratified by the estate DAO", detail: d };
    default:
      return { tone: "plain", title: e.event.replace(/_/g, " "), detail: humanizeYocto(d) };
  }
}

function keyDetail(d: string): string {
  const m = d.match(/(ed25519:\S+)/);
  const kind = /agent/.test(d) ? "agent key " : /pulse|heartbeat/.test(d) ? "pulse key " : "";
  return m ? `${kind}${shortKey(m[1])}` : d;
}

/** Long transaction ids are shortened; the settlement section links the full ones. */
function shortHash(text: string): string {
  return text.replace(/\b(0x[0-9a-fA-F]{24,}|[1-9A-HJ-NP-Za-km-z]{40,})\b/g, (m) => `${m.slice(0, 10)}…${m.slice(-6)}`);
}

/** Newest first; consecutive heartbeats become one row with a count. */
export function recordRows(log: LogEntry[], alias: (id: string) => string | null = () => null): RecordRow[] {
  const out: RecordRow[] = [];
  let run: LogEntry[] = [];
  const flush = () => {
    if (!run.length) return;
    const first = run[0];
    const last = run[run.length - 1];
    if (run.length === 1) out.push({ ms: first.ms, ...describe(first, alias) });
    else out.push({ ms: first.ms, untilMs: last.ms, tone: "life", title: `${run.length} heartbeats`, detail: run.every((r) => r.detail === "pulse_key") ? "by a pulse key" : "" });
    run = [];
  };
  const sorted = [...log].sort((a, b) => a.ms - b.ms);
  // "requested" is only news when the key never arrived.
  const added = new Set(sorted.filter((e) => e.event === "key_added").map((e) => e.detail));
  for (const e of sorted) {
    if (e.event === "key_add_requested" && added.has(e.detail)) continue;
    if (e.event === "heartbeat") {
      run.push(e);
      continue;
    }
    flush();
    out.push({ ms: e.ms, ...describe(e, alias) });
  }
  flush();
  return out.reverse();
}

const TONE: Record<RecordRow["tone"], string> = { life: "bg-life", warn: "bg-warn", dead: "bg-dead", brass: "bg-accent", plain: "bg-text-2/50" };

const stamp = (ms: number) =>
  new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default function Record({ v, nftOwner, alias }: { v: VaultView; nftOwner: string | null; alias: (id: string) => string | null }) {
  const rows = recordRows(v.log, alias);
  const holder = nftOwner ?? v.owner_id;
  return (
    <div>
      <p className="max-w-[62ch] text-[15px] leading-relaxed text-text-2">
        Will NFT {v.token_id} is held by{" "}
        <span className="mono !text-[14px] text-text" title={holder}>
          {alias(holder) ? `${alias(holder)} (${shortAccount(holder)})` : shortAccount(holder)}
        </span>
        . Whoever holds it owns the vault while it is alive, and may claim what is left once it is settled.
      </p>
      {rows.length === 0 ? (
        <p className="mt-6 text-[15px] text-text-2">No events yet.</p>
      ) : (
        <ol className="record mt-6">
          {rows.map((r, i) => (
            <li key={`${r.ms}-${i}`} className="grid grid-cols-[0.75rem_1fr] gap-x-3 border-b border-rule/60 py-3 sm:grid-cols-[0.75rem_11.5rem_1fr]">
              <span className={`mt-[0.55em] h-1.5 w-1.5 rounded-full ${TONE[r.tone]}`} aria-hidden />
              <span className="num mono col-start-2 !text-[12px] leading-relaxed text-text-2 sm:col-start-auto">
                {stamp(r.ms)}
                {r.untilMs ? ` to ${clock(r.untilMs)}` : ""}
              </span>
              <span className="col-start-2 min-w-0 text-[15px] leading-snug sm:col-start-auto">
                <span className="text-text">{r.title}</span>
                {r.detail && <span className="ml-2 break-words text-text-2">{r.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-4 max-w-[62ch] text-[13px] leading-relaxed text-text-2">
        The contract keeps the last 40 entries, so on a long-lived vault the oldest scroll out. The full history is in the contract’s transactions on the explorer.
      </p>
    </div>
  );
}
