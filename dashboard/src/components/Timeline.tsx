import { chainMeta } from "../lib/chainmeta";
import { links } from "../config";
import { fmtTime, humanizeYocto, shortAddr, unitsFor } from "../lib/format";
import { lastEvent, parseStep1Detail } from "../lib/logparse";
import type { ForeignPayout, VaultView } from "../types";
import { ExtLink, ROMAN } from "./ui";

type StepStatus = "pending" | "active" | "done";

function statusOf(v: VaultView, n: number): StepStatus {
  if (v.state === "Settled") return "done";
  if (v.state !== "Triggered") return "pending";
  if (n < v.step) return "done";
  if (n === v.step) return "active";
  return "pending";
}

const MARK: Record<StepStatus, string> = {
  pending: "text-text-2/50",
  active: "text-dead active-tick",
  done: "text-brass",
};
const WORD: Record<StepStatus, string> = { pending: "", active: "now", done: "done" };

function payoutLink(p: ForeignPayout) {
  if (!p.tx_hash) return null;
  return chainMeta(p.chain).tx(p.tx_hash);
}

const PAYOUT_TONE: Record<ForeignPayout["status"], string> = {
  pending: "text-text-2",
  signed: "text-warn",
  broadcast: "text-life",
  failed: "text-dead",
};

interface Props {
  v: VaultView;
  contract: string;
  /** Broadcast a signed payout and record it with mark_broadcast. Omit to hide the button. */
  onRelay?: (index: number) => void;
  relayBusy?: boolean;
}

export default function Timeline({ v, contract, onRelay, relayBusy }: Props) {
  const ev = (n: number) => lastEvent(v.log, `step_${n}`);
  const at = (n: number) => {
    const e = ev(n);
    return e ? <span className="num mono ml-3 !text-[12px] text-text-2">{fmtTime(e.ms)}</span> : null;
  };
  const trig = lastEvent(v.log, "triggered");
  const step1 = parseStep1Detail(ev(1)?.detail);

  const steps: { n: number; title: string; body: React.ReactNode }[] = [
    {
      n: 1,
      title: "NEAR paid to heirs",
      body:
        step1.length > 0 ? (
          <ul className="space-y-1">
            {step1.map((p) => (
              <li key={p.account}>
                <span className="num">{p.amount} NEAR</span> <span className="text-text-2">to</span>{" "}
                <a className="mono !text-[14px] text-text underline decoration-rule underline-offset-4" href={links.nearAddress(p.account)} target="_blank" rel="noreferrer">{p.account}</a>
              </li>
            ))}
          </ul>
        ) : ev(1)?.detail ? (
          <span className="mono">{humanizeYocto(ev(1)!.detail)}</span>
        ) : (
          <ExtLink href={links.nearAddress(contract)}>contract on nearblocks</ExtLink>
        ),
    },
    {
      n: 2,
      title: "Pulse and agent keys deleted",
      body: (
        <span>
          {ev(2)?.detail && <span className="mr-3">{humanizeYocto(ev(2)!.detail)}</span>}
          <ExtLink href={links.nearAddress(contract)}>access keys on nearblocks</ExtLink>
        </span>
      ),
    },
    {
      n: 3,
      title: "Foreign payouts signed by MPC",
      body:
        v.foreign.length === 0 ? (
          <span className="text-text-2">No foreign payouts configured</span>
        ) : (
          <ul className="space-y-2">
            {v.foreign.map((p, i) => {
              const href = payoutLink(p);
              return (
                <li key={i} className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="sc w-16 !text-text-2">{chainMeta(p.chain).short}</span>
                  <span className="num">{unitsFor(p.chain, p.amount)}</span>
                  <span className="mono !text-[13px] text-text-2">to {shortAddr(p.to)}</span>
                  <span className={`display text-[17px] italic ${PAYOUT_TONE[p.status]}`}>{p.status}</span>
                  {href && <ExtLink href={href}>tx</ExtLink>}
                  {onRelay && p.status === "signed" && (
                    <button className="tl !text-[14px]" disabled={relayBusy} onClick={() => onRelay(i)}>
                      Broadcast and record
                    </button>
                  )}
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
          {v.dao_proposal_id !== null && v.dao_proposal_id !== undefined && <span className="ml-3 text-text-2">proposal {v.dao_proposal_id}</span>}
        </span>
      ) : (
        <span className="text-text-2">{ev(4)?.detail ? humanizeYocto(ev(4)!.detail) : "No DAO set, step is skipped"}</span>
      ),
    },
    {
      n: 5,
      title: "Will NFT sent to primary heir",
      body: ev(5)?.detail ? <span className="mono">{humanizeYocto(ev(5)!.detail)}</span> : <ExtLink href={links.nearAddress(contract)}>contract on nearblocks</ExtLink>,
    },
  ];

  return (
    <div>
      {trig && (
        <p className="mb-6 text-[15px] text-text-2">
          Triggered at <span className="num mono !text-[13px] text-text">{fmtTime(trig.ms)}</span>, <span>{humanizeYocto(trig.detail)}</span>.
        </p>
      )}
      <ol>
        {steps.map((s, i) => {
          const st = statusOf(v, s.n);
          return (
            <li key={s.n} className={`grid grid-cols-[3rem_1fr] gap-x-4 py-5 sm:grid-cols-[3rem_1fr_4rem] ${i ? "border-t border-rule" : ""}`}>
              <span className={`display text-[26px] italic leading-none ${MARK[st]}`}>{ROMAN[s.n]}</span>
              <div className="min-w-0">
                <div className={`text-[17px] ${st === "pending" ? "text-text-2" : "text-text"}`}>
                  {s.title}
                  {at(s.n)}
                </div>
                <div className={`mt-2 text-[15px] ${st === "pending" ? "opacity-60" : ""}`}>{s.body}</div>
              </div>
              <span className={`hidden text-right text-[13px] sm:block ${st === "active" ? "text-dead" : "text-text-2"}`}>{WORD[st]}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
