import type { ReactNode } from "react";
import type { VaultState } from "../types";
import { fmtDuration } from "../lib/format";

export const STATE_STYLE: Record<VaultState, { text: string; bg: string; ring: string; label: string }> = {
  Alive: { text: "text-alive", bg: "bg-alive/15", ring: "border-alive/60", label: "Alive" },
  Warning: { text: "text-warn", bg: "bg-warn/15", ring: "border-warn/60", label: "Warning" },
  Triggered: { text: "text-dead", bg: "bg-dead/15", ring: "border-dead/60", label: "Triggered" },
  Settled: { text: "text-settled", bg: "bg-settled/20", ring: "border-settled/60", label: "Settled" },
};

export function Ribbon({ state, className = "" }: { state: VaultState; className?: string }) {
  const s = STATE_STYLE[state];
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-base font-semibold ${s.text} ${s.bg} ${s.ring} ${className}`}>
      <span className={`h-2.5 w-2.5 rounded-full bg-current ${state === "Alive" || state === "Warning" ? "animate-pulse" : ""}`} />
      {s.label}
    </span>
  );
}

export function Countdown({ state, warningAt, triggerAt, now }: { state: VaultState; warningAt: number; triggerAt: number; now: number }) {
  if (state === "Settled") return <Big label="Settlement" value="Complete" tone="text-settled" />;
  if (state === "Triggered") return <Big label="Deadline passed" value="Settling" tone="text-dead" />;
  if (now >= triggerAt) return <Big label="Deadline passed" value="Waiting for poke" tone="text-dead" />;
  if (now >= warningAt) return <Big label="Triggers in" value={fmtDuration(triggerAt - now)} tone="text-warn" />;
  return <Big label="Warning in" value={fmtDuration(warningAt - now)} tone="text-alive" sub={`triggers in ${fmtDuration(triggerAt - now)}`} />;
}

function Big({ label, value, tone, sub }: { label: string; value: string; tone: string; sub?: string }) {
  return (
    <div>
      <div className="text-sm uppercase tracking-widest text-mute">{label}</div>
      <div className={`font-mono text-5xl font-semibold tabular-nums ${tone}`}>{value}</div>
      {sub && <div className="mt-1 text-sm text-mute">{sub}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-sm text-mute">{hint}</span>}
    </label>
  );
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="link" href={href} target="_blank" rel="noreferrer">
      {children} <span aria-hidden>↗</span>
    </a>
  );
}

export function CopyBox({ value, label }: { value: string; label?: string }) {
  const copy = () => navigator.clipboard?.writeText(value).catch(() => undefined);
  return (
    <div>
      {label && <div className="label">{label}</div>}
      <div className="flex items-start gap-3 rounded-xl border border-line bg-bg p-3">
        <code className="mono flex-1 select-all">{value}</code>
        <button type="button" className="btn !px-3 !py-1.5 text-sm" onClick={copy}>Copy</button>
      </div>
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dead/50 bg-dead/10 px-4 py-3 text-base text-dead">{children}</div>;
}

export function ReconnectHint({ show }: { show: boolean }) {
  if (!show) return null;
  return <div className="rounded-xl border border-warn/50 bg-warn/10 px-4 py-2 text-sm text-warn">reconnecting… the node is not responding, retrying automatically</div>;
}
