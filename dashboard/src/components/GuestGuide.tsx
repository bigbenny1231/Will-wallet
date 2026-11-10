import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CONTRACT, links } from "../config";
import { api } from "../lib/near";
import { useWallet } from "../lib/wallet";
import { agentPayCall, claimCall, executeStepCall, pokeCall } from "../lib/calls";
import { currentForeign, stepArgsFor } from "../lib/chains";
import { chainMeta } from "../lib/chainmeta";
import { fmtDuration, fmtTime, yoctoToNear } from "../lib/format";
import { lastEvent, parseStep1Detail } from "../lib/logparse";
import { beatError, makeBeater } from "../lib/pulseSigner";
import { GUEST_BEAT_MS, GUEST_PLAN, accountFor, guestError, guestStage, sendAs, type GuestSession, type GuestStage, type GuestTx } from "../lib/guest";
import type { VaultView } from "../types";
import HoldToStop from "./HoldToStop";
import { ErrorNote, ExtLink, ROMAN } from "./ui";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ACT: Record<GuestStage, { n: number; name: string; headline: string }> = {
  alive: { n: 1, name: "Alive", headline: "While you are alive, nothing happens." },
  silence: { n: 2, name: "Silence", headline: "The beats have stopped." },
  due: { n: 2, name: "Silence", headline: "Anyone may settle it now." },
  settling: { n: 3, name: "Settlement", headline: "This executes." },
  settled: { n: 3, name: "Settlement", headline: "It is settled." },
};

const STEP_LABEL: Record<number, string> = { 1: "Step I, heirs paid", 2: "Step II, keys deleted", 3: "Step III, payout signed", 4: "Step IV, DAO proposal", 5: "Step V, Will NFT to heir" };

const stepLabel = (v: VaultView) => (v.step === 4 && !v.dao_id ? "Step IV, no estate DAO, skipped" : v.step === 3 ? "Step III, foreign payouts done" : (STEP_LABEL[v.step] ?? `Step ${v.step}`));

interface AgentResult {
  ms: number;
  what: string;
  ok: boolean;
  line: string;
  hash: string | null;
}

/**
 * The guided run for a guest (lib/guest.ts). It sits on top of the real vault page and drives the same contract
 * calls a wallet would: the pulse key beats from this browser, the agent key pays and is refused, the guest holds to
 * stop, and then this browser acts as the keeper.
 */
export default function GuestGuide({ v, now, guest }: { v: VaultView; now: number; guest: GuestSession }) {
  const { setGuest, setGuestAs } = useWallet();
  const stage = guestStage(v, guest.stoppedMs, now);
  const act = ACT[stage];
  const id = v.token_id;

  const record = useCallback(
    (tx: Omit<GuestTx, "ms">) => setGuest((cur) => (cur ? { ...cur, txs: [...cur.txs, { ms: Date.now(), ...tx }].slice(-60) } : cur)),
    [setGuest],
  );

  /* ---------------- I. the pulse: this browser beats with the pulse key ---------------- */
  const beater = useMemo(() => makeBeater({ contract: CONTRACT, token: id, secret: guest.pulseSecret }), [id, guest.pulseSecret]);
  const [beats, setBeats] = useState(0);
  const [beatErr, setBeatErr] = useState<string | null>(null);
  const beating = stage === "alive" && guest.armed;
  useEffect(() => {
    if (!beating) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;
    const beat = async () => {
      if (inFlight) return; // one transaction at a time on this key: two would collide on its nonce
      inFlight = true;
      try {
        await beater.beat();
        if (stop) return;
        setBeats((n) => n + 1);
        setBeatErr(null);
      } catch (e) {
        if (!stop) setBeatErr(beatError(e));
      } finally {
        inFlight = false;
        if (!stop) timer = setTimeout(beat, GUEST_BEAT_MS);
      }
    };
    // First beat a little after the page settles, so a reload does not double up with the last one.
    timer = setTimeout(beat, Math.max(1500, Math.min(GUEST_BEAT_MS, v.last_beat_ms + GUEST_BEAT_MS - Date.now())));
    // Browsers pause timers in a hidden tab (on a phone, opening a "tx" link is enough), and this vault may be poked
    // after a minute of silence. Beat as soon as the page is in front again instead of waiting for the next timer.
    const onVisible = () => {
      if (stop || inFlight || document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beating, beater]);

  /* ---------------- I. the agent: a key that can only call agent_pay ---------------- */
  const [agentBusy, setAgentBusy] = useState<string | null>(null);
  const [agentLog, setAgentLog] = useState<AgentResult[]>([]);
  const agentOk = v.state === "Alive" && guest.armed;
  const note = (r: Omit<AgentResult, "ms">) => setAgentLog((l) => [{ ms: Date.now(), ...r }, ...l].slice(0, 4));

  const agentPay = async (what: string, receiver: string, amount: bigint) => {
    setAgentBusy(what);
    try {
      const sent = await sendAs(accountFor(CONTRACT, guest.agentSecret), [agentPayCall(id, receiver, amount.toString(), what)]);
      const res = sent.value as { allowed?: boolean; reason?: string | null } | undefined;
      const allowed = res?.allowed === true;
      note({
        what,
        ok: allowed,
        hash: sent.hash,
        line: allowed ? `Allowed. ${yoctoToNear(amount)} NEAR left the vault.` : `Denied by the contract: ${(res?.reason ?? "policy").replace(/_/g, " ")}. Nothing moved.`,
      });
      record({ label: allowed ? "agent_pay, allowed" : "agent_pay, denied", hash: sent.hash });
    } catch (e) {
      note({ what, ok: false, hash: null, line: guestError(e) });
    } finally {
      setAgentBusy(null);
    }
  };
  /** The agent key signs a plain Transfer. A function-call key cannot, so the node refuses before any contract runs. */
  const agentTransfer = async () => {
    const what = "A plain transfer, signed with the agent key";
    setAgentBusy(what);
    try {
      await accountFor(CONTRACT, guest.agentSecret).transfer({ receiverId: "stranger.testnet", amount: 10n ** 24n });
      note({ what, ok: true, hash: null, line: "The transfer went through. That should not happen: please report it." });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const kind = /RequiresFullAccess/i.test(m) ? "RequiresFullAccess" : /access key|InvalidAccessKey|not allowed|permission/i.test(m) ? "InvalidAccessKeyError" : null;
      if (kind) {
        note({ what, ok: false, hash: null, line: `Refused by the node before any contract code ran: ${kind}.` });
        record({ label: "transfer with the agent key", hash: null, note: "refused by the node" });
      } else {
        // A network or node error proves nothing about the key: say so instead of claiming a refusal.
        note({ what, ok: false, hash: null, line: `Could not send it: ${guestError(e)} Try again.` });
      }
    } finally {
      setAgentBusy(null);
    }
  };

  /* ---------------- III. this browser as the keeper ---------------- */
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const settle = async () => {
    setRunning(true);
    setRunErr(null);
    const keeper = accountFor(guest.accountId, guest.secret);
    let early = 0;
    try {
      for (let guard = 0; guard < 60 && alive.current; guard++) {
        const cur = await api.getVault(id);
        if (!cur || cur.state === "Settled") break;
        if (cur.state !== "Triggered") {
          if (Date.now() < cur.trigger_at_ms) {
            await sleep(1000);
            continue;
          }
          setRunNote("Poke: the deadline has passed, so any account may trigger the vault.");
          try {
            const t = await sendAs(keeper, [pokeCall(id)]);
            record({ label: "poke, bounty earned", hash: t.hash });
          } catch (e) {
            // The chain's clock can be a second or two behind this one.
            if (/not_due/.test(String(e)) && early++ < 6) {
              await sleep(1500);
              continue;
            }
            throw e;
          }
          continue;
        }
        if (cur.step > 5) {
          await sleep(1000);
          continue;
        }
        if (cur.step === 3 && cur.foreign_inflight) {
          setRunNote("Waiting for NEAR’s MPC network to return the signature.");
          await sleep(2500);
          continue;
        }
        const foreign = currentForeign(cur);
        setRunNote(
          foreign
            ? `Step III: asking NEAR’s MPC network to sign the ${chainMeta(foreign.chain).short} payout.`
            : `${stepLabel(cur).replace(",", ":")}.`,
        );
        const args = await stepArgsFor(cur);
        const t = await sendAs(keeper, [executeStepCall(id, args)], { quick: !!foreign });
        record({ label: foreign ? `Step III, ${chainMeta(foreign.chain).short} signature requested` : stepLabel(cur), hash: t.hash });
        // Give the view a moment to show the new step (and the in-flight flag for a signature request).
        await sleep(foreign ? 3000 : 1200);
      }
    } catch (e) {
      if (alive.current) setRunErr(guestError(e));
    } finally {
      if (alive.current) {
        setRunning(false);
        setRunNote(null);
      }
    }
  };

  /* ---------------- after: the heir claims ---------------- */
  const heir = guest.heirs.find((h) => h.accountId === v.owner_id) ?? guest.heirs[0];
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState<string | null>(null);
  const [claimErr, setClaimErr] = useState<string | null>(null);
  const claim = async () => {
    setClaiming(true);
    setClaimErr(null);
    try {
      const before = v.balance;
      const t = await sendAs(accountFor(heir.accountId, heir.secret), [claimCall(id)]);
      record({ label: `claim, signed by ${heir.name}`, hash: t.hash });
      setClaimed(yoctoToNear(before));
    } catch (e) {
      setClaimErr(guestError(e));
    } finally {
      setClaiming(false);
    }
  };

  const paid = parseStep1Detail(lastEvent(v.log, "step_1")?.detail);
  const nameOf = (account: string) => guest.heirs.find((h) => h.accountId === account)?.name ?? account;
  const signed = v.foreign.filter((p) => p.status === "signed" || p.status === "broadcast").map((p) => chainMeta(p.chain).short);
  const txs = [...guest.txs].reverse();

  return (
    <section aria-label="Guest run" className="guide mt-8">
      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-7">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="sc">Guest run</span>
            <ol className="flex items-baseline gap-3" aria-label="Acts">
              {[1, 2, 3].map((n) => (
                <li key={n} className={`display text-[17px] italic ${n === act.n ? "text-text" : n < act.n ? "text-accent" : "text-text-2/50"}`} aria-current={n === act.n ? "step" : undefined}>
                  {ROMAN[n]}
                </li>
              ))}
            </ol>
            <span className="text-[13px] text-text-2">{act.name}</span>
          </div>
          <h2 className="display mt-4 text-[34px] leading-[1.05] md:text-[44px]">{act.headline}</h2>

          {stage === "alive" && (
            <>
              <p className="mt-4 max-w-[58ch] text-[17px] leading-relaxed text-text-2">
                This browser holds a pulse key that can only call <code className="mono !text-[14px] text-text">heartbeat</code>. It beats every {GUEST_BEAT_MS / 1000} seconds; the vault expects one every {v.heartbeat_interval_s}.{" "}
                <span className="num text-text">{beats}</span> sent from this page. Keep this tab in front: a hidden tab stops beating, and this vault only waits a minute.
              </p>
              {beatErr && <div className="mt-3"><ErrorNote>{beatErr}</ErrorNote></div>}

              <div className="mt-8 border-t border-rule pt-6">
                <div className="sc">Your agent</div>
                <p className="mt-2 max-w-[58ch] text-[15px] leading-relaxed text-text-2">
                  It holds a key that can only call <code className="mono !text-[13px] text-text">agent_pay</code>, inside the policy below: 0.5 NEAR a payment, 1 NEAR a day, one allowed receiver. Give it three instructions.
                </p>
                <div className="mt-4 flex flex-col items-start gap-3">
                  <button className="tl text-left" disabled={!agentOk || !!agentBusy} onClick={() => agentPay("Invoice INV-2041", guest.provider, GUEST_PLAN.invoice)}>
                    Pay an invoice: 0.12 NEAR to the allowed provider
                  </button>
                  <button className="tl text-left" disabled={!agentOk || !!agentBusy} onClick={() => agentPay("URGENT from the CEO", "stranger.testnet", BigInt(v.balance))}>
                    Obey a planted message: send the whole balance to stranger.testnet
                  </button>
                  <button className="tl text-left" disabled={!guest.armed || !!agentBusy} onClick={agentTransfer}>
                    Skip the contract: sign a plain transfer with the agent key
                  </button>
                </div>
                {agentBusy && <p className="mt-4 text-[14px] text-text-2" role="status">Signing with the agent key: {agentBusy}…</p>}
                {agentLog.length > 0 && (
                  <ul className="mt-4 space-y-2" aria-live="polite">
                    {agentLog.map((r) => (
                      <li key={r.ms} className={`border-l pl-3 text-[14px] leading-relaxed ${r.ok ? "border-life" : "border-dead"}`}>
                        <span className="text-text-2">{r.what}.</span> <span className={r.ok ? "text-life" : "text-dead"}>{r.line}</span>
                        {r.hash && <span className="ml-3"><ExtLink href={links.nearTx(r.hash)}>tx</ExtLink></span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-4 border-t border-rule pt-6">
                <HoldToStop onDone={() => setGuest((cur) => (cur ? { ...cur, stoppedMs: Date.now() } : cur))} label="Hold to stop" />
                <p className="max-w-[34ch] text-[15px] leading-relaxed text-text-2">
                  When you are ready, hold for two seconds. The beats stop, as they would if you were gone, and the vault starts counting.
                </p>
              </div>
            </>
          )}

          {stage === "silence" && (
            <>
              <p className="mt-4 max-w-[58ch] text-[17px] leading-relaxed text-text-2">
                Nothing has been sent since <span className="num text-text">{fmtTime(v.last_beat_ms)}</span>.{" "}
                {now < v.warning_at_ms ? (
                  <>
                    In <span className="num text-warn">{fmtDuration(v.warning_at_ms - now)}</span> the vault turns Warning and the agent is disarmed.{" "}
                  </>
                ) : (
                  <>The vault is in Warning and the agent is disarmed. </>
                )}
                In <span className="num text-dead">{fmtDuration(v.trigger_at_ms - now)}</span> anyone may start settlement.
              </p>
              <p className="mt-3 max-w-[58ch] text-[15px] leading-relaxed text-text-2">A real vault waits days or years here. This one waits a minute.</p>
              <div className="mt-6">
                <button className="tl" onClick={() => setGuest((cur) => (cur ? { ...cur, stoppedMs: null } : cur))}>
                  Come back: resume the heartbeat
                </button>
              </div>
            </>
          )}

          {stage === "due" && (
            <>
              <p className="mt-4 max-w-[58ch] text-[17px] leading-relaxed text-text-2">
                The deadline has passed. <code className="mono !text-[14px] text-text">poke</code> and <code className="mono !text-[14px] text-text">execute_step</code> are open to every account. This browser will act as the keeper: it pokes the vault, earns the {yoctoToNear(v.bounty)} NEAR bounty, and carries the five steps forward.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3">
                <button className="pill" disabled={running} onClick={settle}>
                  {running ? "Settling…" : "Poke and settle"}
                </button>
                {!running && guest.stoppedMs && v.state !== "Triggered" && <span className="text-[14px] text-text-2">A heartbeat can no longer save it once it is poked.</span>}
              </div>
            </>
          )}

          {stage === "settling" && (
            <>
              <p className="mt-4 max-w-[58ch] text-[17px] leading-relaxed text-text-2">
                Step {Math.min(v.step, 5)} of 5. Each step is one NEAR transaction; the record below fills in as they land.
              </p>
              {!running && (
                <div className="mt-6">
                  <button className="pill" onClick={settle}>Continue settlement</button>
                </div>
              )}
            </>
          )}

          {(stage === "due" || stage === "settling") && (
            <div className="mt-5 space-y-3" aria-live="polite">
              {running && runNote && <p className="border-l border-dead pl-3 text-[15px] text-text">{runNote}</p>}
              {runErr && <ErrorNote>{runErr}</ErrorNote>}
            </div>
          )}

          {stage === "settled" && (
            <>
              <p className="mt-4 max-w-[60ch] text-[17px] leading-relaxed text-text-2">
                {paid.length > 0 ? (
                  <>
                    {paid.map((p, i) => (
                      <span key={p.account}>
                        {i > 0 && (i === paid.length - 1 ? " and " : ", ")}
                        <span className="text-text">{nameOf(p.account)}</span> received <span className="num text-text">{p.amount} NEAR</span>
                      </span>
                    ))}
                    , with nothing to sign.{" "}
                  </>
                ) : (
                  <>The heirs were paid on NEAR, with nothing to sign. </>
                )}
                The pulse and agent keys are deleted.{" "}
                {signed.length > 0 && (
                  <>NEAR’s MPC network signed the {signed.join(" and ")} payout{signed.length === 1 ? "" : "s"}; {signed.length === 1 ? "it is" : "they are"} not relayed, because the derived source {signed.length === 1 ? "address holds" : "addresses hold"} no funds. </>
                )}
                The Will NFT now belongs to {nameOf(v.owner_id)}.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-4">
                {!claimed && BigInt(v.balance) > 0n ? (
                  <button className="pill" disabled={claiming} onClick={claim}>
                    {claiming ? "Claiming…" : `Claim the remaining ${yoctoToNear(v.balance)} NEAR as ${heir.name}`}
                  </button>
                ) : (
                  <span className="text-[15px] text-life">{claimed ? `${heir.name} claimed ${claimed} NEAR. The vault is empty.` : "Nothing is left in the vault."}</span>
                )}
                <Link className="tl" to="/heir" onClick={() => setGuestAs(heir.accountId)}>See it as {heir.name}</Link>
                <Link className="tl" to="/try">Run it again</Link>
              </div>
              {claimErr && <div className="mt-4"><ErrorNote>{claimErr}</ErrorNote></div>}
            </>
          )}
        </div>

        {/* what this browser signed */}
        <aside className="min-w-0 lg:col-span-5">
          <div className="sc">Signed in this browser</div>
          <p className="mt-2 text-[13px] leading-relaxed text-text-2">
            A throwaway testnet account, <span className="mono !text-[12px] text-text">{guest.accountId}</span>. No wallet is involved.
          </p>
          {txs.length === 0 ? (
            <p className="mt-4 text-[14px] text-text-2">Nothing yet.</p>
          ) : (
            <ol className="guide-ledger mt-4">
              {txs.map((t, i) => (
                <li key={`${t.ms}-${i}`} className="grid grid-cols-[4.75rem_1fr_auto] items-baseline gap-x-3 border-b border-rule/60 py-2 text-[13px]">
                  <span className="num mono !text-[12px] text-text-2">{fmtTime(t.ms)}</span>
                  <span className="min-w-0 text-text">{t.label.replace(/_/g, "_​")}</span>
                  {t.hash ? <ExtLink href={links.nearTx(t.hash)}>tx</ExtLink> : <span className="text-[12px] text-text-2">{t.note ?? ""}</span>}
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>
    </section>
  );
}
