import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONTRACT, POLL_MS, links } from "../config";
import { fmtDuration, fmtInterval, fmtTime } from "../lib/format";
import { PairingError, decidePairing, loadPulse, parsePairing, savePulse, PULSE_STORE, type Pairing, type StoredPulse } from "../lib/pairing";
import { beatPeriodS, idle, secondsUntil, settled, shouldBeat, tick, type Scheduler } from "../lib/pulseSchedule";
import { beatError, makeBeater } from "../lib/pulseSigner";
import { aliveStrip, warningStrip, SEAL_TRACE, STATE_COLOR } from "../lib/pulse";
import { HEX, drawSeal, sealDataUri, svgDataUri } from "../lib/seal";
import Seal from "../components/Seal";
import HoldToStop from "../components/HoldToStop";
import type { VaultView } from "../types";

/**
 * Stores a pairing that arrived on this phone, unless it is for another contract or would replace a different
 * stored key without the owner saying yes. Returns the stored pairing, or null when nothing changed.
 */
function acceptPairing(p: Pairing, current: StoredPulse | null): StoredPulse | null {
  const d = decidePairing(p, current, CONTRACT);
  if (d.kind === "refuse") throw new PairingError(d.message);
  if (d.kind === "same") return current;
  if (d.kind === "confirm" && !window.confirm(d.message)) return null;
  const v: StoredPulse = { ...p, pairedMs: Date.now(), periodS: null, keepAlive: false };
  savePulse(v);
  return v;
}

/** A stored pairing for another contract (an older build, or another deployment on this origin) is not used. */
function loadPulseHere(): StoredPulse | null {
  const v = loadPulse();
  return v && v.contract === CONTRACT ? v : null;
}

/** The owner's phone. Paired from the vault page; beats while open; hold to stop is the on-camera kill. */
export default function Pulse() {
  const [paired, setPaired] = useState<StoredPulse | null>(() => loadPulseHere());
  const [justPaired, setJustPaired] = useState(false);
  const [linkErr, setLinkErr] = useState<string | null>(null);

  // A pairing link opened on this phone: store the key, then drop it from the address bar and history.
  useEffect(() => {
    const h = window.location.hash;
    if (!/[#&]k=/.test(h)) return;
    // Drop the key from the address bar and history before anything else, whatever the link turns out to be.
    window.history.replaceState(null, "", window.location.pathname);
    try {
      const current = loadPulseHere();
      const v = acceptPairing(parsePairing(h), current);
      if (v && v !== current) {
        setPaired(v);
        setJustPaired(true);
      }
    } catch (e) {
      setLinkErr(e instanceof PairingError ? e.message : String(e));
    }
  }, []);

  if (!paired) return <Unpaired error={linkErr} onPaired={(v) => { setPaired(v); setJustPaired(true); }} />;
  return <Paired key={paired.secret} cfg={paired} justPaired={justPaired} notice={linkErr} onChange={(v) => { if (v) savePulse(v); else localStorage.removeItem(PULSE_STORE); setPaired(v); }} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="pulse-shell mx-auto flex min-h-[100svh] w-full max-w-[480px] flex-col px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))]">{children}</div>;
}

function TopBar({ left, right }: { left: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div className="flex items-center gap-2.5">
        <svg width="22" height="22" viewBox="0 0 40 40" aria-hidden className="shrink-0">
          <circle cx="20" cy="20" r="18.5" fill="none" stroke="var(--accent)" strokeWidth="1.2" />
          <circle cx="20" cy="20" r="16" fill="none" stroke="var(--accent)" strokeWidth=".6" />
          <path d="M8 21h6l1.5-1.5 1.5 1.5 2-9 2.5 14 2-5.5h8.5" fill="none" stroke="var(--text)" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <div className="leading-tight">{left}</div>
      </div>
      {right}
    </header>
  );
}

/* ---------------- not paired ---------------- */

function Unpaired({ error, onPaired }: { error: string | null; onPaired: (v: StoredPulse) => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(error);
  const pair = () => {
    try {
      const v = acceptPairing(parsePairing(text), null);
      if (v) onPaired(v);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Shell>
      <TopBar left={<span className="display text-[20px]">Dead Man’s Wallet</span>} />
      <div className="mt-10 flex justify-center opacity-70">
        <img src={sealDataUri("–", "Settled", "not paired", 0)} alt="" width={220} height={220} className="h-[220px] w-[220px] rounded-full" />
      </div>
      <h1 className="display mt-10 text-[48px] leading-[0.95]">Pair this phone.</h1>
      <p className="mt-4 text-[17px] leading-relaxed text-text-2">
        On the vault page, open Keys and choose <span className="text-text">Pair a phone</span>. Scan the code with this phone’s camera, or paste the link here.
      </p>
      <label className="sc mt-8 block" htmlFor="pair-link">Pairing link</label>
      <textarea id="pair-link" className="field mono mt-1 min-h-24 resize-none !text-[13px]" placeholder="https://…/pulse#c=…&t=…&k=…" value={text} onChange={(e) => setText(e.target.value)} />
      {err && <p role="alert" className="mt-3 border-l border-dead pl-3 text-[15px] text-dead">{err}</p>}
      <div className="mt-auto pt-10">
        <button className="pill w-full !py-3.5 !text-[17px]" onClick={pair} disabled={!text.trim()}>Pair</button>
        <p className="mt-4 text-[13px] leading-relaxed text-text-2">
          The key in the link can only call <span className="mono !text-[12px]">heartbeat</span>. It cannot move funds, change heirs or stop settlement.
        </p>
      </div>
    </Shell>
  );
}

/* ---------------- paired ---------------- */

type Phase = "beating" | "stopped";

function Paired({ cfg, justPaired, notice, onChange }: { cfg: StoredPulse; justPaired: boolean; notice?: string | null; onChange: (v: StoredPulse | null) => void }) {
  const beater = useMemo(() => makeBeater(cfg), [cfg.secret, cfg.contract, cfg.token]); // eslint-disable-line react-hooks/exhaustive-deps
  const [vault, setVault] = useState<VaultView | null>(null);
  const [viewErr, setViewErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("beating");
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [wasHidden, setWasHidden] = useState(false);
  const [sched, setSched] = useState<Scheduler>(idle);
  const [now, setNow] = useState(Date.now());
  const [beats, setBeats] = useState(0);
  const [lastOkMs, setLastOkMs] = useState(0);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [beatErr, setBeatErr] = useState<string | null>(null);
  const [stoppedAt, setStoppedAt] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const schedRef = useRef(sched);
  schedRef.current = sched;

  const state = vault?.state ?? null;
  const intervalS = vault?.heartbeat_interval_s ?? 30;
  const periodS = beatPeriodS(intervalS, cfg.periodS);
  const allowed = shouldBeat({ stopped: phase === "stopped", visible, keepAlive: cfg.keepAlive, state });

  // Chain view.
  useEffect(() => {
    let alive = true;
    const read = () =>
      beater
        .view()
        .then((v) => alive && (setVault(v), setViewErr(v ? null : `There is no vault ${cfg.token} on ${cfg.contract}.`)))
        .catch((e) => alive && setViewErr(beatError(e)));
    read();
    const t = setInterval(read, Math.max(POLL_MS, 4000));
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [beater, cfg.token, cfg.contract]);

  // Visibility: beat only while visible unless keep-alive is on.
  useEffect(() => {
    const on = () => {
      const v = document.visibilityState !== "hidden";
      setVisible(v);
      if (!v) setWasHidden(true);
    };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  // Keep the screen on while beating (best-effort; not every browser has the Wake Lock API).
  useEffect(() => {
    if (!allowed || !visible) return;
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => undefined);
    return () => {
      lock?.release().catch(() => undefined);
    };
  }, [allowed, visible]);

  const fire = useCallback(async () => {
    try {
      const hash = await beater.beat();
      setBeats((n) => n + 1);
      setLastOkMs(Date.now());
      setLastTx(hash);
      setBeatErr(null);
      setSched(settled(Date.now(), periodS, true));
    } catch (e) {
      setBeatErr(beatError(e));
      setSched(settled(Date.now(), periodS, false));
    }
  }, [beater, periodS]);

  // The scheduler loop: 250 ms ticks drive both the countdown and the beats.
  useEffect(() => {
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      const r = tick(schedRef.current, n, allowed);
      if (r.s !== schedRef.current) {
        schedRef.current = r.s;
        setSched(r.s);
      }
      if (r.fire) void fire();
    }, 250);
    return () => clearInterval(t);
  }, [allowed, fire]);

  const stop = () => {
    setPhase("stopped");
    setStoppedAt(Date.now());
    setSched(idle());
  };
  const resume = () => {
    setPhase("beating");
    setWasHidden(false);
  };

  const left = secondsUntil(sched, now);
  const stopped = phase === "stopped";
  const chainDead = state === "Triggered" || state === "Settled";
  const color = stopped ? "var(--dead)" : state ? STATE_COLOR[state] : "var(--still)";
  const paused = !!vault?.paused_until_ms && now < vault.paused_until_ms;

  // The phone's own seal: the chain state on the rim, the phone's view inside.
  const media = useMemo(() => {
    if (!vault) return sealDataUri(cfg.token, "Alive", "reading the vault…", 0);
    if (stopped && !chainDead)
      return svgDataUri(drawSeal({ id: cfg.token, rim: vault.state, color: HEX.Triggered, glow: "0.12", trace: SEAL_TRACE.Triggered, word: "Flatline", status: "this phone stopped beating", heirs: vault.heirs.length }));
    const status = chainDead ? (vault.state === "Settled" ? "settled" : "settling") : paused ? "paused by guardian" : "beating from this phone";
    return sealDataUri(cfg.token, vault.state, status, vault.heirs.length);
  }, [vault, stopped, chainDead, cfg.token, paused]);

  const lastBeatMs = Math.max(lastOkMs, 0);
  const warnAt = vault?.warning_at_ms ?? 0;
  const trigAt = vault?.trigger_at_ms ?? 0;

  return (
    <Shell>
      <TopBar
        left={
          <>
            <div className="text-[15px] font-medium">Vault {cfg.token}</div>
            <a className="mono block !text-[11.5px] text-text-2" href={links.nearAddress(cfg.contract)} target="_blank" rel="noreferrer">{cfg.contract}</a>
          </>
        }
        right={<button className="tl !text-[14px]" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>{showSettings ? "Close" : "Settings"}</button>}
      />

      {justPaired && beats === 0 && !stopped && <p className="mt-4 border-l border-life pl-3 text-[14px] text-text-2">Paired. The key is stored on this phone only.</p>}
      {notice && <p role="alert" className="mt-4 break-words border-l border-dead pl-3 text-[14px] text-dead">{notice} This phone still sends the heartbeat for vault {cfg.token}.</p>}

      {showSettings ? (
        <Settings cfg={cfg} intervalS={intervalS} periodS={periodS} publicKey={beater.publicKey} onChange={onChange} />
      ) : (
        <>
          <div className={`mx-auto mt-4 ${stopped ? "flatline-in" : ""}`} style={{ width: "min(280px, 30svh)" }}>
            <Seal media={media} id={cfg.token} state={stopped ? "Triggered" : state ?? "Alive"} heirs={vault?.heirs.length ?? 0} lastBeatMs={stopped ? 0 : lastBeatMs} size={280} />
          </div>

          {!stopped ? (
            <section className="mt-4 text-center" aria-live="polite">
              <div className="sc">{chainDead ? "No more beats" : allowed ? "Next beat in" : "Not beating"}</div>
              <div className="display num mt-1 text-[clamp(64px,10.5svh,112px)] leading-[0.9]" style={{ color: state === "Warning" ? "var(--warn)" : undefined }}>
                {chainDead ? "—" : left === null ? "·" : left === 0 ? <span className="text-[0.5em] italic text-text-2">sending</span> : <>{left}<span className="text-[0.4em] text-text-2"> s</span></>}
              </div>
              <p className="mx-auto mt-2 max-w-[36ch] text-[14px] leading-snug text-text-2">
                {chainDead ? (
                  <>The vault is {state?.toLowerCase()}. This phone no longer beats.</>
                ) : !visible ? (
                  "Paused while the screen is off."
                ) : (
                  <>
                    Every {periodS} s while this page is open.{" "}
                    {paused ? <>Paused by the guardian until <span className="num">{fmtTime(vault!.paused_until_ms!)}</span>.</> : warnAt ? <>Without a beat, Warning in <span className="num">{fmtDuration(Math.max(0, warnAt - now))}</span>.</> : null}
                  </>
                )}
              </p>
            </section>
          ) : (
            <section className="mt-4 text-center" aria-live="assertive">
              <h1 className="display text-[clamp(52px,9svh,72px)] leading-none text-dead">Stopped.</h1>
              <p className="mx-auto mt-3 max-w-[36ch] text-[14.5px] leading-snug text-text-2">
                Last beat from this phone at <span className="num text-text">{fmtTime(lastOkMs || stoppedAt)}</span>. If nothing else beats, the vault turns Warning at{" "}
                <span className="num text-text">{warnAt ? fmtTime(warnAt) : "…"}</span> and can be poked at <span className="num text-text">{trigAt ? fmtTime(trigAt) : "…"}</span>.
              </p>
            </section>
          )}

          <Trace state={stopped ? "stopped" : state === "Warning" ? "warning" : chainDead ? "dead" : "alive"} beatKey={stopped ? 0 : lastOkMs} color={color} />

          <div className="mt-2 min-h-[22px] text-center text-[13px]">
            {beatErr ? (
              <span role="alert" className="text-dead">{beatErr}</span>
            ) : viewErr ? (
              <span className="text-warn">{viewErr}</span>
            ) : lastOkMs ? (
              <span className="text-text-2">
                <span className="num">{beats}</span> beat{beats === 1 ? "" : "s"} sent, last at <span className="num">{fmtTime(lastOkMs)}</span>
                {lastTx && (
                  <>
                    {" "}
                    <a className="xl ml-1" href={links.nearTx(lastTx)} target="_blank" rel="noreferrer">tx</a>
                  </>
                )}
              </span>
            ) : wasHidden && !cfg.keepAlive ? (
              <span className="text-text-2">Beats pause while the screen is off.</span>
            ) : null}
          </div>

          <div className="mt-auto flex flex-col items-center pt-3">
            {stopped ? (
              <button className="pill w-full !py-3.5 !text-[17px]" onClick={resume} disabled={chainDead}>Resume beating</button>
            ) : (
              <HoldToStop onDone={stop} disabled={chainDead} />
            )}
            <p className="mt-2 text-center text-[12.5px] leading-snug text-text-2 [@media(max-height:700px)]:hidden">
              This phone holds a pulse key. It can only call <span className="mono !text-[11.5px]">heartbeat</span>.
            </p>
          </div>
        </>
      )}
    </Shell>
  );
}

/** Full-bleed trace under the countdown: rhythm while beating, a long red flatline when stopped. */
function Trace({ state, beatKey, color }: { state: "alive" | "warning" | "stopped" | "dead"; beatKey: number; color: string }) {
  const W = 480;
  const H = 76;
  const Y = 48;
  const flat = state === "stopped" || state === "dead";
  const d = state === "warning" ? warningStrip(W, Y) : aliveStrip(W, Y, 60, 0.9);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="-mx-6 mt-2 block h-[52px] w-[calc(100%+48px)]" role="img" aria-label={flat ? "Flatline" : "Pulse"}>
      <line x1="0" x2={W} y1={Y} y2={Y} stroke="var(--rule)" />
      {flat ? (
        <line key="flat" x1="0" x2={W} y1={Y} y2={Y} stroke={color} strokeWidth={2} className="flatline-draw" style={{ filter: state === "stopped" ? `drop-shadow(0 0 4px ${color})` : undefined }} />
      ) : (
        <>
          <path d={d} fill="none" stroke={color} strokeOpacity={0.28} strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={d} pathLength={1000} fill="none" stroke={color} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" className="sweep" vectorEffect="non-scaling-stroke" style={{ ["--len" as string]: 1000, ["--seg" as string]: 150, ["--dur" as string]: "3.6s" }} />
          {beatKey > 0 && <path key={beatKey} d={d} fill="none" stroke={color} strokeWidth={2.6} strokeLinejoin="round" className="beat" vectorEffect="non-scaling-stroke" />}
        </>
      )}
    </svg>
  );
}

function Settings({ cfg, intervalS, periodS, publicKey, onChange }: { cfg: StoredPulse; intervalS: number; periodS: number; publicKey: string; onChange: (v: StoredPulse | null) => void }) {
  const auto = beatPeriodS(intervalS, null);
  const [period, setPeriod] = useState(cfg.periodS ? String(cfg.periodS) : "");
  const commit = (raw: string) => {
    const n = Number(raw);
    onChange({ ...cfg, periodS: raw.trim() && Number.isFinite(n) && n > 0 ? n : null });
  };
  return (
    <div className="mt-8 space-y-8">
      <div>
        <label className="sc block" htmlFor="period">Beat every (seconds)</label>
        <input id="period" className="field num mt-1" inputMode="decimal" placeholder={`automatic, ${auto} s`} value={period} onChange={(e) => setPeriod(e.target.value)} onBlur={(e) => commit(e.target.value)} />
        <p className="mt-2 text-[13.5px] leading-relaxed text-text-2">
          Automatic is a third of the vault’s {fmtInterval(intervalS)} interval, at most 20 s. Now beating every {periodS} s. Each beat spends about 0.011 NEAR of the key’s 1 NEAR gas allowance.
        </p>
      </div>
      <label className="flex items-start gap-4">
        <input type="checkbox" className="mt-1 h-5 w-5 accent-[var(--brass)]" checked={cfg.keepAlive} onChange={(e) => onChange({ ...cfg, keepAlive: e.target.checked })} />
        <span>
          <span className="block text-[16px]">Keep beating in the background</span>
          <span className="mt-1 block text-[13.5px] leading-relaxed text-text-2">Best effort. Phones slow or suspend background pages, so beats may stop when the screen locks. Keep this page open for a reliable pulse.</span>
        </span>
      </label>
      <div className="rule pt-6">
        <div className="sc">Pulse key on this phone</div>
        <p className="mt-2 text-[14px] leading-relaxed text-text-2">
          Stored in this browser’s local storage. It can only call <span className="mono !text-[12.5px]">heartbeat</span> for vault {cfg.token} on {cfg.contract}. It cannot move funds, change heirs or stop settlement. Paired at{" "}
          {new Date(cfg.pairedMs).toLocaleString()}.
        </p>
        <p className="mono mt-3 !text-[12px] text-text-2">{publicKey}</p>
        <button
          className="tl mt-5 !text-[14px]"
          onClick={() => confirm("Forget the pulse key on this phone? The key stays registered on the vault until the owner removes it.") && onChange(null)}
        >
          Forget this key
        </button>
      </div>
      <p className="text-[13px] leading-relaxed text-text-2">
        On iPhone, an app added to the Home Screen keeps its own storage. If it opens unpaired, paste the pairing link once more inside it.
      </p>
    </div>
  );
}
