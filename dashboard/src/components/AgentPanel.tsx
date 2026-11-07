import { fmtTime, yoctoToNear } from "../lib/format";
import type { VaultView } from "../types";

function reasonOf(detail?: string | null): string {
  if (!detail) return "";
  const m = detail.match(/reason[=:]\s*"?([a-z_]+)/i);
  return m ? m[1] : "";
}

export default function AgentPanel({ v }: { v: VaultView }) {
  const rows = v.log.filter((l) => l.event.startsWith("agent_pay")).slice().sort((a, b) => b.ms - a.ms);
  const p = v.policy;
  return (
    <div>
      <dl className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Per transaction max" value={`${yoctoToNear(p.per_tx_max)} NEAR`} />
        <Stat label="Daily max" value={`${yoctoToNear(p.daily_max)} NEAR`} sub={`${yoctoToNear(v.daily_spent)} spent today`} />
        <Stat label="Allowlist" value={p.allowlist.length ? p.allowlist.join(", ") : "any receiver"} mono />
      </dl>
      <div className="h-section !mb-2">Agent payments, newest first</div>
      {rows.length === 0 ? (
        <p className="text-mute">No agent payments yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {rows.map((r, i) => {
            const ok = r.event === "agent_pay_allowed";
            const reason = reasonOf(r.detail);
            return (
              <li key={`${r.ms}-${i}`} className={`flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 ${ok ? "bg-alive/5" : "bg-dead/5"}`}>
                <span className={`w-24 shrink-0 text-base font-bold uppercase tracking-wide ${ok ? "text-alive" : "text-dead"}`}>{ok ? "Allowed" : "Denied"}</span>
                <span className="font-mono text-sm text-mute">{fmtTime(r.ms)}</span>
                {!ok && reason && <span className="rounded-md bg-dead/20 px-2 py-0.5 font-mono text-sm text-dead">{reason}</span>}
                <span className="mono text-ink/90">{r.detail}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, sub, mono }: { label: string; value: string; sub?: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-bg px-4 py-3">
      <dt className="text-sm text-mute">{label}</dt>
      <dd className={`mt-1 text-lg font-semibold ${mono ? "font-mono text-base break-all" : ""}`}>{value}</dd>
      {sub && <div className="text-sm text-mute">{sub}</div>}
    </div>
  );
}
