import { fmtTime, yoctoToNear } from "../lib/format";
import { agentRowAmount, parseAgentLog } from "../lib/logparse";
import type { VaultView } from "../types";
import { Figure } from "./ui";

/** Policy as three figures, then the payment log typeset as a ledger. */
export default function AgentPanel({ v }: { v: VaultView }) {
  const rows = v.log
    .filter((l) => l.event === "agent_pay_allowed" || l.event === "agent_pay_denied")
    .map(parseAgentLog)
    .sort((a, b) => b.ms - a.ms);
  const p = v.policy;
  return (
    <div>
      <dl className="grid grid-cols-1 gap-8 sm:grid-cols-3">
        <Figure label="Per payment, at most" value={`${yoctoToNear(p.per_tx_max)} NEAR`} />
        <Figure label="Per day, at most" value={`${yoctoToNear(p.daily_max)} NEAR`} sub={`${yoctoToNear(v.daily_spent)} NEAR spent in the current 24 h window`} />
        <Figure label="Allowed receivers" value={p.allowlist.length ? p.allowlist.join(", ") : "Any receiver"} mono={p.allowlist.length > 0} />
      </dl>

      <div className="mt-10 font-mono text-[13px]">
        <div className="grid grid-cols-[6.5rem_6.5rem_1fr] gap-x-4 border-b border-rule pb-2 font-sans sm:grid-cols-[6.5rem_6.5rem_8.5rem_1fr]">
          <span className="sc">Time</span>
          <span className="sc">Verdict</span>
          <span className="sc hidden sm:block">Amount</span>
          <span className="sc">Receiver</span>
        </div>
        {rows.length === 0 ? (
          <p className="py-4 font-sans text-[15px] text-text-2">No agent payments yet.</p>
        ) : (
          <ul>
            {rows.map((r, i) => (
              <li key={`${r.ms}-${i}`} className="grid grid-cols-[6.5rem_6.5rem_1fr] items-baseline gap-x-4 border-b border-rule/60 py-3 sm:grid-cols-[6.5rem_6.5rem_8.5rem_1fr]">
                <span className="num text-text-2">{fmtTime(r.ms)}</span>
                <span className={r.allowed ? "text-life" : "text-dead"}>{r.allowed ? "allowed" : "denied"}</span>
                <span className="num hidden text-text sm:block">{agentRowAmount(r)}</span>
                <span className="min-w-0 break-all text-text">
                  {r.receiver}
                  {!r.allowed && r.reason && <span className="sc ml-3 !text-[11px] !text-dead">{r.reason.replace(/_/g, " ")}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-4 max-w-[64ch] text-[14px] text-text-2">The contract keeps the last 40 log entries; older payments scroll out. The agent is denied with vault_not_alive as soon as the vault is in Warning.</p>
    </div>
  );
}
