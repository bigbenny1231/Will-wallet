import { links } from "../config";
import { fmtTime } from "../lib/format";
import { lastEvent } from "../lib/logparse";
import { FLAT_FROM, STATE_COLOR, STRIP_H, STRIP_W, STRIP_Y, aliveStrip, flatStrip, tickX, warningStrip } from "../lib/pulse";
import type { VaultView } from "../types";
import { ROMAN } from "./ui";

const STEP_SHORT: Record<number, string> = { 1: "Heirs paid", 2: "Keys deleted", 3: "Foreign signed", 4: "DAO proposal", 5: "Will to heir" };

type Tick = "done" | "active" | "pending";

function tickState(v: VaultView, n: number): Tick {
  if (v.state === "Settled") return "done";
  if (v.state !== "Triggered") return "pending";
  return n < v.step ? "done" : n === v.step ? "active" : "pending";
}

/** Explorer links for a settlement step, as [label, href]. */
function stepLinks(v: VaultView, n: number, contract: string): [string, string][] {
  if (n === 1) return [["nearblocks", links.nearAddress(contract)]];
  if (n === 2) return [["keys", links.nearAddress(contract)]];
  if (n === 3)
    return v.foreign.map((p) => {
      const href = p.tx_hash ? (p.chain === "base" ? links.baseTx(p.tx_hash) : links.solTx(p.tx_hash)) : p.from_address ? (p.chain === "base" ? links.baseAddress(p.from_address) : links.solAddress(p.from_address)) : "";
      return [p.chain === "base" ? "basescan" : "solana", href] as [string, string];
    }).filter(([, h]) => h);
  if (n === 4) return v.dao_id ? [["sputnik", links.dao(v.dao_id)]] : [];
  return [["nearblocks", links.nearAddress(contract)]];
}

/**
 * The pulse strip. Alive: a slow rhythm with a sweep. Warning: thinner, amber, stuttering. Triggered and
 * Settled: the trace flatlines and the flat line becomes the settlement timeline, one tick per step.
 */
export default function PulseStrip({ v, contract }: { v: VaultView; contract: string }) {
  const color = STATE_COLOR[v.state];
  const flat = v.state === "Triggered" || v.state === "Settled";
  const d = v.state === "Alive" ? aliveStrip() : v.state === "Warning" ? warningStrip() : flatStrip();
  const settledTo = lastEvent(v.log, "settled")?.detail;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${STRIP_W} ${STRIP_H}`} className="block h-auto w-full overflow-visible" role="img" aria-label={`Pulse: ${v.state}`}>
        <defs>
          <linearGradient id="strip-fade" x1="0" x2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.12" stopColor="#fff" stopOpacity="1" />
          </linearGradient>
          <mask id="strip-mask">
            <rect width={STRIP_W} height={STRIP_H} fill="url(#strip-fade)" />
          </mask>
        </defs>
        {/* baseline hairline */}
        <line x1="0" x2={STRIP_W} y1={STRIP_Y} y2={STRIP_Y} stroke="var(--rule)" strokeWidth="1" />
        <g mask="url(#strip-mask)">
          {flat ? (
            <>
              <path d={d} fill="none" stroke="var(--still)" strokeOpacity={0.45} strokeWidth={1.5} strokeLinejoin="round" />
              <line x1={FLAT_FROM} x2={STRIP_W} y1={STRIP_Y} y2={STRIP_Y} stroke={color} strokeWidth={v.state === "Settled" ? 1.5 : 2} />
            </>
          ) : (
            <>
              <path d={d} fill="none" stroke={color} strokeOpacity={0.32} strokeWidth={v.state === "Warning" ? 1.25 : 1.75} strokeLinejoin="round" strokeLinecap="round" />
              <path
                d={d}
                pathLength={1000}
                fill="none"
                stroke={color}
                strokeWidth={v.state === "Warning" ? 1.5 : 2.25}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="sweep"
                style={{ ["--len" as string]: 1000, ["--seg" as string]: v.state === "Warning" ? 70 : 160, ["--dur" as string]: v.state === "Warning" ? "6.5s" : "4.2s", filter: `drop-shadow(0 0 4px ${color})` }}
              />
              {v.last_beat_ms > 0 && <path key={v.last_beat_ms} d={d} fill="none" stroke={color} strokeWidth={2.4} strokeLinejoin="round" className="beat" />}
            </>
          )}
        </g>
        {flat &&
          [1, 2, 3, 4, 5].map((n) => {
            const st = tickState(v, n);
            const x = tickX(n);
            return (
              <g key={n} className={st === "active" ? "active-tick" : undefined}>
                <line x1={x} x2={x} y1={STRIP_Y - (st === "pending" ? 6 : 12)} y2={STRIP_Y + (st === "pending" ? 6 : 12)} stroke={st === "pending" ? "var(--bone-2)" : st === "active" ? "var(--dead)" : "var(--bone)"} strokeOpacity={st === "pending" ? 0.35 : 1} strokeWidth={st === "pending" ? 1 : 1.5} />
                {st === "done" && <circle cx={x} cy={STRIP_Y} r={2.5} fill="var(--bone)" />}
              </g>
            );
          })}
      </svg>

      {flat && (
        <ol className="relative mt-2 h-[28px] sm:h-[124px]" aria-label="Settlement steps">
          {[1, 2, 3, 4, 5].map((n) => {
            const st = tickState(v, n);
            const ev = lastEvent(v.log, `step_${n}`);
            const left = `${(tickX(n) / STRIP_W) * 100}%`;
            return (
              <li key={n} className="tick-on absolute top-0 w-[64px] -translate-x-1/2 text-center sm:w-[118px]" style={{ left, animationDelay: `${n * 110}ms` }}>
                <div className={`display text-[17px] italic leading-none ${st === "pending" ? "text-brass-2/60" : "text-brass"}`}>{ROMAN[n]}</div>
                <div className={`mt-1 hidden text-[12.5px] leading-tight sm:block ${st === "pending" ? "text-text-2/60" : "text-text"}`}>{STEP_SHORT[n]}</div>
                <div className="num mono mt-1 hidden !text-[11px] text-text-2 sm:block">{ev ? fmtTime(ev.ms) : st === "active" ? "now" : "\u00a0"}</div>
                {st !== "pending" && (
                  <div className="mt-1 hidden flex-col items-center gap-0.5 sm:flex">
                    {stepLinks(v, n, contract).map(([label, href]) => (
                      <a key={label + href} className="xl leading-tight" href={href} target="_blank" rel="noreferrer">{label}</a>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {v.state === "Settled" && settledTo && (
        <p className="mt-3 text-[15px] text-text-2">
          The line is still. The Will passed to <span className="mono !text-[14px] text-text">{settledTo}</span>.
        </p>
      )}
    </div>
  );
}
