import { fmtTime, yoctoToNear } from "../lib/format";
import { agentRowAmount, parseAgentLog } from "../lib/logparse";
import type { VaultView } from "../types";

export default function AgentPanel({ v }: { v: VaultView }) {
  const rows = v.log
    .filter((l) => l.event === "agent_pay_allowed" || l.event === "agent_pay_denied")
    .map(parseAgentLog)
    .sort((a, b) => b.ms - a.ms);
  const p = v.policy;
  return (
    <div>
      <dl className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Per transaction max" value={`${yoctoToNear(p.per_tx_max)} NEAR`} />
        <Stat label="Daily max" value={`${yoctoToNear(p.daily_max)} NEAR`} sub={`${yoctoToNear(v.daily_spent)} spent in the current 24 h window`} />
        <Stat label="Allowlist" value={p.allowlist.length ? p.allowlist.join(", ") : "any receiver"} mono />
      </dl>
      <div className="h-section !mb-2">Agent payments, newest first</div>
      {rows.length === 0 ? (
        <p className="text-mute">No agent payments yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {rows.map((r, i) => (
            <li key={`${r.ms}-${i}`} className={`flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 ${r.allowed ? "bg-alive/5" : "bg-dead/5"}`}>
              <span className={`w-24 shrink-0 text-base font-bold uppercase tracking-wide ${r.allowed ? "text-alive" : "text-dead"}`}>{r.allowed ? "Allowed" : "Denied"}</span>
              <span className="font-mono text-sm text-mute">{fmtTime(r.ms)}</span>
              {!r.allowed && r.reason && <span className="rounded-md bg-dead/20 px-2 py-0.5 font-mono text-sm text-dead">{r.reason}</span>}
              <span className="font-semibold">{agentRowAmount(r)}</span>
              <span className="mono text-ink/90">{r.receiver && `to ${r.receiver}`}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-sm text-mute">The contract keeps the last 40 log entries; older payments scroll out. The agent is denied with vault_not_alive as soon as the vault is in Warning.</p>
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
