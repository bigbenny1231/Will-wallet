import type { ReactNode } from "react";
import type { VaultState } from "../types";
import { fmtDuration } from "../lib/format";

export const STATE_STYLE: Record<VaultState, { text: string; bg: string; ring: string; label: string }> = {
  Alive: { text: "text-life", bg: "bg-life", ring: "border-life", label: "Alive" },
  Warning: { text: "text-warn", bg: "bg-warn", ring: "border-warn", label: "Warning" },
  Triggered: { text: "text-dead", bg: "bg-dead", ring: "border-dead", label: "Triggered" },
  Settled: { text: "text-still", bg: "bg-still", ring: "border-still", label: "Settled" },
};

/** The state, set as a word: serif italic in the state colour. */
export function Ribbon({ state, className = "" }: { state: VaultState; className?: string }) {
  const s = STATE_STYLE[state];
  return <span className={`display italic ${s.text} ${className}`}>{s.label}</span>;
}

/** Small-caps brass label. */
export function Label({ children, className = "", as: As = "div" }: { children: ReactNode; className?: string; as?: "div" | "dt" | "span" | "h2" }) {
  return <As className={`sc ${className}`}>{children}</As>;
}

/** Hairline-ruled section: label in the margin, content in the measure. */
export function Section({ label, children, note, id }: { label: string; children: ReactNode; note?: ReactNode; id?: string }) {
  return (
    <section id={id} className="rule grid gap-6 py-12 md:grid-cols-12 md:gap-10">
      <div className="md:col-span-3">
        <Label as="h2">{label}</Label>
        {note && <div className="mt-3 max-w-[22ch] text-[14px] leading-relaxed text-text-2">{note}</div>}
      </div>
      <div className="min-w-0 md:col-span-9">{children}</div>
    </section>
  );
}

export function Countdown({ state, warningAt, triggerAt, now }: { state: VaultState; warningAt: number; triggerAt: number; now: number }) {
  if (state === "Settled") return <Figure label="Settlement" value="Complete" />;
  if (state === "Triggered") return <Figure label="Deadline passed" value="Settling" tone="text-dead" />;
  if (now >= triggerAt) return <Figure label="Deadline passed" value="Waiting for poke" tone="text-dead" />;
  if (now >= warningAt) return <Figure label="Settles in" value={fmtDuration(triggerAt - now)} tone="text-warn" />;
  return <Figure label="Next heartbeat due in" value={fmtDuration(warningAt - now)} sub={`settles after ${fmtDuration(triggerAt - now)} of silence`} />;
}

/** A labelled figure: small caps over a large tabular number. */
export function Figure({ label, value, tone = "", sub, mono }: { label: string; value: ReactNode; tone?: string; sub?: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <Label>{label}</Label>
      <div className={`num mt-2 ${mono ? "mono !text-[15px] leading-snug" : "whitespace-nowrap text-[28px] leading-none font-[450] tracking-[-0.01em]"} ${tone}`}>{value}</div>
      {sub && <div className="mt-2 text-[13px] text-text-2">{sub}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <Label as="span" className="block">{label}</Label>
      <span className="mt-1 block">{children}</span>
      {hint && <span className="mt-2 block text-[14px] leading-relaxed text-text-2">{hint}</span>}
    </label>
  );
}

/** External link. Brass small caps by default (explorers); `plain` keeps the text case. */
export function ExtLink({ href, children, plain }: { href: string; children: ReactNode; plain?: boolean }) {
  return (
    <a className={plain ? "link" : "xl"} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export function CopyBox({ value, label }: { value: string; label?: string }) {
  const copy = () => navigator.clipboard?.writeText(value).catch(() => undefined);
  return (
    <div>
      {label && <Label className="mb-2">{label}</Label>}
      <div className="flex items-start gap-6 border-y border-rule py-3">
        <code className="mono flex-1 select-all text-text">{value}</code>
        <button type="button" className="tl shrink-0" onClick={copy}>Copy</button>
      </div>
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="break-words border-l border-dead py-1 pl-4 text-[15px] text-dead [overflow-wrap:anywhere]">
      {children}
    </div>
  );
}

export function ReconnectHint({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div role="status" className="border-l border-warn py-1 pl-4 text-[14px] text-warn">
      Reconnecting. The node is not responding; retrying automatically.
    </div>
  );
}

/** Hover text for a disabled control (disabled buttons do not always show their own title). */
export function Tip({ why, children }: { why: string; children: ReactNode }) {
  return (
    <span title={why || undefined} className="inline-flex">
      {children}
    </span>
  );
}

/** Roman numerals for document sections and settlement steps. */
export const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII"];
