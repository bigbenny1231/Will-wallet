import { links } from "../config";
import { shortAddr, unitsFor } from "../lib/format";
import type { ForeignPayout, VaultView } from "../types";
import { ExtLink } from "./ui";

type StepStatus = "pending" | "active" | "done";

function statusOf(v: VaultView, n: number): StepStatus {
  if (v.state === "Settled") return "done";
  if (v.state !== "Triggered") return "pending";
  if (n < v.step) return "done";
  if (n === v.step) return "active";
  return "pending";
}

const DOT: Record<StepStatus, string> = {
  pending: "border-line text-mute",
  active: "border-dead bg-dead/15 text-dead animate-pulse",
  done: "border-alive bg-alive/15 text-alive",
};

function payoutLink(p: ForeignPayout) {
  if (!p.tx_hash) return null;
  return p.chain === "base" ? links.baseTx(p.tx_hash) : links.solTx(p.tx_hash);
}

const PAYOUT_TONE: Record<ForeignPayout["status"], string> = {
  pending: "text-mute",
  signed: "text-warn",
  broadcast: "text-alive",
  failed: "text-dead",
};

export default function Timeline({ v, contract }: { v: VaultView; contract: string }) {
  const steps: { n: number; title: string; body: React.ReactNode }[] = [
    {
      n: 1,
      title: "NEAR paid to heirs",
      body: <ExtLink href={links.nearAddress(contract)}>Contract on nearblocks</ExtLink>,
    },
    {
      n: 2,
      title: "Pulse and agent keys deleted",
      body: <ExtLink href={links.nearAddress(contract)}>Access keys on nearblocks</ExtLink>,
    },
    {
      n: 3,
      title: "Foreign payouts signed by MPC",
      body:
        v.foreign.length === 0 ? (
          <span className="text-mute">No foreign payouts configured</span>
        ) : (
          <ul className="space-y-2">
            {v.foreign.map((p, i) => {
              const href = payoutLink(p);
              return (
                <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="rounded-md border border-line px-2 py-0.5 text-xs uppercase tracking-wider text-mute">{p.chain}</span>
                  <span>{unitsFor(p.chain, p.amount)}</span>
                  <span className="mono text-mute">to {shortAddr(p.to)}</span>
                  <span className={`text-sm font-semibold ${PAYOUT_TONE[p.status]}`}>{p.status}</span>
                  {href && <ExtLink href={href}>tx</ExtLink>}
                </li>
              );
            })}
          </ul>
        ),
    },
    {
      n: 4,
      title: "Sputnik DAO proposal",
      body: v.dao_id ? (
        <span>
          <ExtLink href={links.dao(v.dao_id)}>{v.dao_id}</ExtLink>
          {v.dao_proposal_id !== null && <span className="ml-3 text-mute">proposal #{v.dao_proposal_id}</span>}
        </span>
      ) : (
        <span className="text-mute">No DAO set, step is skipped</span>
      ),
    },
    {
      n: 5,
      title: "Will NFT sent to primary heir",
      body: <ExtLink href={links.nearAddress(contract)}>Contract on nearblocks</ExtLink>,
    },
  ];

  return (
    <ol className="space-y-0">
      {steps.map((s, i) => {
        const st = statusOf(v, s.n);
        return (
          <li key={s.n} className="relative flex gap-5 pb-7 last:pb-0">
            {i < steps.length - 1 && <span className="absolute left-[19px] top-10 h-[calc(100%-2.5rem)] w-px bg-line" />}
            <span className={`z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 text-base font-bold ${DOT[st]}`}>
              {st === "done" ? "✓" : s.n}
            </span>
            <div className="pt-1">
              <div className={`text-lg font-semibold ${st === "pending" ? "text-mute" : "text-ink"}`}>{s.title}</div>
              <div className="mt-1 text-base">{s.body}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
