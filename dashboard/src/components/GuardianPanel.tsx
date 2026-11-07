import { useEffect, useState } from "react";
import { PAUSE_RANGE_S, pauseCall, setGuardianCall } from "../lib/calls";
import { fmtDuration, fmtInterval, fmtTime } from "../lib/format";
import type { CallArgs, VaultView } from "../types";
import { Figure, Tip } from "./ui";

const UNITS = { minutes: 60, hours: 3600, days: 86400 } as const;
type Unit = keyof typeof UNITS;

/** Whether a pause is holding the vault right now. */
export function isPaused(v: VaultView, now: number): boolean {
  return !!v.paused_until_ms && now < v.paused_until_ms;
}

function split(s: number): [string, Unit] {
  if (s >= 86400 && s % 86400 === 0) return [String(s / 86400), "days"];
  if (s >= 3600 && s % 3600 === 0) return [String(s / 3600), "hours"];
  return [String(Math.max(1, Math.round(s / 60))), "minutes"];
}

export default function GuardianPanel({ v, now, accountId, isOwner, busy, send }: { v: VaultView; now: number; accountId: string | null; isOwner: boolean; busy: boolean; send: (label: string, build: () => CallArgs) => void }) {
  const supported = v.guardian_id !== undefined;
  const guardian = v.guardian_id ?? null;
  const maxS = v.max_pause_s ?? 0;
  const live = v.state === "Alive" || v.state === "Warning";
  const paused = isPaused(v, now);
  // paused_until_ms stays set after the pause runs out, until the next heartbeat: the one pause of this cycle is spent.
  const spent = !!v.paused_until_ms && !paused;
  const due = now >= v.trigger_at_ms;
  const isGuardian = !!accountId && accountId === guardian;

  const [who, setWho] = useState(guardian ?? "");
  const [n, setN] = useState(() => split(maxS || 7 * 86400)[0]);
  const [unit, setUnit] = useState<Unit>(() => split(maxS || 7 * 86400)[1]);
  useEffect(() => {
    setWho(guardian ?? "");
    const [a, b] = split(maxS || 7 * 86400);
    setN(a);
    setUnit(b);
  }, [guardian, maxS]);

  const secs = Math.round(Number(n) * UNITS[unit]);
  const whoOk = /^[a-z0-9._-]{2,64}$/.test(who.trim());
  const secsOk = Number.isFinite(secs) && secs >= PAUSE_RANGE_S.min && secs <= PAUSE_RANGE_S.max;
  const formWhy = !isOwner ? "Only the vault owner can name a guardian" : !live ? "The guardian is fixed once the vault is triggered" : !whoOk ? "Enter the guardian's NEAR account" : !secsOk ? "The longest pause must be between 10 seconds and 90 days" : who.trim() === guardian && secs === maxS ? "No change" : "";

  const pauseWhy = !guardian
    ? "Name a guardian first"
    : !(isOwner || isGuardian)
      ? "Only the guardian or the owner can pause"
      : !live
        ? "The vault is already triggered"
        : due
          ? "The deadline has passed; a pause can no longer hold it"
          : paused
            ? "Already paused"
            : spent
              ? "One pause per heartbeat cycle: the next heartbeat re-arms it"
              : "";

  if (!supported)
    return <p className="text-[15px] text-text-2">The contract at this address predates guardians. Redeploy it to name one.</p>;

  return (
    <div className="space-y-10">
      {paused && (
        <div className="border-l-2 border-warn pl-5">
          <div className="display text-[32px] text-warn">Paused until {fmtTime(v.paused_until_ms!)}.</div>
          <p className="mt-2 max-w-[60ch] text-[15px] leading-relaxed text-text-2">
            Settlement cannot start for another <span className="num text-text">{fmtDuration(v.paused_until_ms! - now)}</span>. The agent is disarmed meanwhile. A heartbeat from the owner ends the pause.
          </p>
        </div>
      )}

      <dl className="grid grid-cols-1 gap-8 sm:grid-cols-3 sm:gap-0 sm:[&>div+div]:border-l sm:[&>div+div]:border-rule sm:[&>div+div]:pl-8 sm:[&>div]:pr-6">
        <Figure label="Guardian" value={guardian ?? "None named"} mono={!!guardian} tone={guardian ? "" : "text-text-2"} />
        <Figure label="Longest pause" value={guardian ? fmtInterval(maxS) : "—"} />
        <Figure label="This cycle" value={!guardian ? "—" : paused ? "Paused" : spent ? "Pause used" : "Pause available"} tone={paused ? "text-warn" : spent ? "text-text-2" : ""} />
      </dl>

      <p className="max-w-[62ch] text-[16px] leading-relaxed">
        A guardian is someone you trust to say “wait”: a partner, a doctor, an attorney. They can pause the vault once per heartbeat cycle, for up to the longest pause you set. While paused, the vault reads Warning, the agent is disarmed and settlement cannot begin. Only the owner’s next heartbeat
        ends a pause and allows another. A guardian cannot move funds, change heirs or stop a settlement that has started.
      </p>

      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        {(isOwner || isGuardian) && (
          <Tip why={pauseWhy}>
            <button className={isGuardian && !pauseWhy ? "pill" : "tl"} disabled={!!pauseWhy || busy} onClick={() => send("Pause", () => pauseCall(v.token_id))}>
              Pause for {guardian ? fmtInterval(maxS) : "…"}
            </button>
          </Tip>
        )}
        {isGuardian && <span className="text-[14px] text-text-2">You are this vault’s guardian.</span>}
        {!isOwner && !isGuardian && guardian && <span className="text-[14px] text-text-2">Connect as {guardian} or the owner to pause.</span>}
      </div>

      {isOwner && (
        <div className="rule grid gap-8 pt-8 sm:grid-cols-[1fr_7rem_9rem_auto] sm:items-end">
          <label className="block min-w-0">
            <span className="sc block">Guardian account</span>
            <input className="field mono mt-1" placeholder="ana.testnet" value={who} onChange={(e) => setWho(e.target.value)} disabled={!live} />
          </label>
          <label className="block">
            <span className="sc block">Longest pause</span>
            <input className="field num mt-1" inputMode="decimal" value={n} onChange={(e) => setN(e.target.value)} disabled={!live} />
          </label>
          <label className="block">
            <span className="sc block">&nbsp;</span>
            <select className="field mt-1" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} disabled={!live} aria-label="Pause unit">
              {Object.keys(UNITS).map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </label>
          <div className="flex items-baseline gap-6 pb-2">
            <Tip why={formWhy}>
              <button className="tl" disabled={!!formWhy || busy} onClick={() => send(guardian ? "Guardian updated" : "Guardian named", () => setGuardianCall(v.token_id, who.trim(), secs))}>
                {guardian ? "Update" : "Name guardian"}
              </button>
            </Tip>
            {guardian && (
              <button className="tl" disabled={!live || busy} onClick={() => confirm(`Remove ${guardian} as guardian?`) && send("Guardian removed", () => setGuardianCall(v.token_id, null))}>
                Remove
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
