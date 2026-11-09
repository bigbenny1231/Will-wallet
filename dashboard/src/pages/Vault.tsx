import { chainMeta } from "../lib/chainmeta";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { CONTRACT, MOCK, POLL_MS, SHOWCASE_VAULT, links } from "../config";
import { api } from "../lib/near";
import { useWallet } from "../lib/wallet";
import { usePoll, useNow } from "../lib/usePoll";
import { bpsToPct, expectedShare, fmtDuration, fmtInterval, fmtTime, nearToYocto, shortAccount, yoctoToNear } from "../lib/format";
import { claimCall, depositCall, executeStepCall, heartbeatCall, markBroadcastCall, nftTransferCall, pokeCall } from "../lib/calls";
import { broadcastForeign, currentForeign, stepArgsFor } from "../lib/chains";
import { deriveFor } from "../lib/derive";
import { guestAvailable } from "../lib/guest";
import { lastEvent, step1AmountFor } from "../lib/logparse";
import type { CallArgs, VaultView } from "../types";
import AgentPanel from "../components/AgentPanel";
import KeysPanel from "../components/KeysPanel";
import GuardianPanel, { isPaused } from "../components/GuardianPanel";
import Timeline from "../components/Timeline";
import TxBanner from "../components/TxBanner";
import Seal from "../components/Seal";
import PulseStrip from "../components/PulseStrip";
import GuestGuide from "../components/GuestGuide";
import Record from "../components/Record";
import { ErrorNote, ExtLink, Figure, Label, ReconnectHint, Ribbon, Section, Tip } from "../components/ui";

export default function Vault() {
  const { id = "" } = useParams();
  const { accountId, connect, call, guest, isGuest, guestAs, alias } = useWallet();
  const now = useNow(250);
  const vault = usePoll(() => api.getVault(id), POLL_MS, [id]);
  const nft = usePoll(() => api.nftToken(id), POLL_MS, [id]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);

  const v = vault.data;
  if (!vault.loaded) return <p className="wrap py-24 text-text-2">Loading vault {id}…</p>;
  if (!v) {
    return (
      <div className="wrap space-y-4 py-24">
        {vault.error && <ErrorNote>{vault.error}</ErrorNote>}
        <h1 className="display text-[48px]">No vault {id}.</h1>
        <p className="text-text-2">There is no vault with this number on {CONTRACT}.</p>
        <Link className="tl" to="/">Back to vaults</Link>
      </div>
    );
  }

  const isOwner = accountId === v.owner_id;
  // A guest run: this browser made the vault (lib/guest.ts). The guide drives it; the page below is the real console.
  const guided = isGuest && !!guest && guest.token === v.token_id ? guest : null;
  const showcase = !MOCK && SHOWCASE_VAULT === v.token_id;
  // Older vaults stored no source address for some payouts; it is a pure function of the contract and vault id.
  const derived = v.foreign.some((f) => !f.from_address) ? safeDerive(v.token_id) : null;
  const sourceOf = (f: VaultView["foreign"][number]) => f.from_address || derived?.[f.chain] || "";
  const who = (id: string) => {
    const a = alias(id);
    return a && a !== "You" ? a : null;
  };
  const nftOwner = nft.data?.owner_id ?? null;
  const canHeartbeat = isOwner && (v.state === "Alive" || v.state === "Warning");
  const canClaim = v.state === "Settled" && !!accountId && nftOwner === accountId;
  const media = nft.data?.metadata?.media;

  const send = async (label: string, build: () => CallArgs | Promise<CallArgs>) => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const outcome = (await call(await build())) as { transaction?: { hash?: string } } | undefined;
      const hash = outcome?.transaction?.hash;
      setMsg(hash ? `${label} sent: ${hash}` : `${label} sent.`);
      setTxHash(hash ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const executeNext = () =>
    send(`Step ${v.step}`, async () => {
      if (v.step === 3 && currentForeign(v)) setMsg("Fetching chain parameters for the signature request…");
      const args = await stepArgsFor(v);
      return executeStepCall(v.token_id, args);
    });

  const relay = (index: number) =>
    send("Broadcast", async () => {
      const hash = await broadcastForeign(v.foreign[index]);
      return markBroadcastCall(v.token_id, index, hash);
    });

  // Poke: anyone, once now >= trigger_at (browser clock; the contract re-checks).
  const live = v.state === "Alive" || v.state === "Warning";
  const pokeDue = live && now >= v.trigger_at_ms;
  const pokeWhy = pokeDue
    ? ""
    : v.state === "Settled"
      ? "The vault is already settled"
      : v.state === "Triggered"
        ? "The vault is already Triggered"
        : `Not due yet: the vault can be poked at ${fmtTime(v.trigger_at_ms)}`;
  const stepInflight = v.step === 3 && !!v.foreign_inflight;
  const execOk = v.state === "Triggered" && v.step >= 1 && v.step <= 5 && !stepInflight;
  const execWhy = execOk
    ? ""
    : v.state === "Settled"
      ? "Settlement is complete"
      : stepInflight
        ? "A signature request is in flight; try again when it returns (a lost request is failed after 10 minutes)"
        : "Only available once the vault is Triggered. Poke it first.";
  const claimable = BigInt(v.balance) > 0n;
  const claimWhy = canClaim ? (claimable ? "" : "Nothing left to claim: the balance is 0") : `Only the current Will NFT owner can claim${nftOwner ? ` (${nftOwner})` : ""}`;
  const heartbeatWhy = canHeartbeat ? "" : isOwner ? "Heartbeat is rejected once the vault is Triggered" : "Heartbeat is limited to the owner or a pulse key";

  // The one primary action depends on the moment.
  const primary: "heartbeat" | "poke" | "execute" | "claim" = v.state === "Settled" ? "claim" : v.state === "Triggered" ? "execute" : pokeDue ? "poke" : "heartbeat";
  const btn = (kind: typeof primary) => (kind === primary ? "pill" : "tl");
  const execLabel = execOk ? `Execute step ${v.step} of 5: ${STEP_NAMES[v.step]}` : "Execute next step";

  const silence = fmtInterval(v.heartbeat_interval_s * (v.grace_missed + 1));
  const triggered = lastEvent(v.log, "triggered");
  const settled = lastEvent(v.log, "settled");
  const lastBeat = lastEvent(v.log, "heartbeat");
  const paused = isPaused(v, now);

  return (
    <div className="wrap pb-24">
      <div className="space-y-3 pt-6 empty:hidden">
        <TxBanner />
        <ReconnectHint show={vault.reconnecting} />
        {vault.error && <ErrorNote>Could not refresh: {vault.error}</ErrorNote>}
      </div>

      {guided && <GuestGuide v={v} now={now} guest={guided} />}

      {/* ---------- the estate console ---------- */}
      <section className="grid gap-12 pb-16 pt-12 lg:grid-cols-12 lg:gap-10">
        <div className="flex flex-col items-center lg:col-span-5">
          <Seal media={media} id={v.token_id} state={v.state} heirs={v.heirs.length} lastBeatMs={v.last_beat_ms} />
          <Ribbon state={v.state} className="mt-8 text-[48px] md:text-[64px]" />
          <p className="mt-3 text-[13px] text-text-2">Will NFT {v.token_id}, drawn on chain, refreshed every {POLL_MS / 1000} s</p>
        </div>

        <div className="min-w-0 lg:col-span-7 lg:pt-4">
          <Label>
            Vault {v.token_id} on <ExtLink href={links.nearAddress(CONTRACT)}>{CONTRACT}</ExtLink>
          </Label>
          {showcase && (
            <p className="mt-3 max-w-[60ch] border-l border-accent pl-3 text-[14px] leading-relaxed text-text-2">
              The example vault. The project keeps it alive so there is always a living one to read. Its foreign payouts are pending, and nothing has been relayed.{" "}
              {guestAvailable() && <Link className="link" to="/try">Run one of your own, no wallet needed.</Link>}
            </p>
          )}
          <h1 className="display mt-4 text-[48px] md:text-[64px]">{paused ? "Paused." : headline(v)}</h1>
          <p className="mt-5 max-w-[56ch] text-[19px] leading-relaxed text-text-2">
            {paused ? (
              <>
                {lastEvent(v.log, "paused")?.detail?.startsWith("owner") ? (isOwner ? "You" : "The owner") : (v.guardian_id ?? "The guardian")} paused this vault until {fmtTime(v.paused_until_ms!)}. Settlement cannot start before then and the agent is disarmed. One heartbeat from {isOwner ? "you" : "the owner"} ends the pause.
              </>
            ) : (
              <Sentence v={v} silence={silence} isOwner={isOwner} />
            )}
          </p>

          <div className="mt-10">
            <PulseStrip v={v} contract={CONTRACT} />
            {paused && (
              <p className="mt-3 flex flex-wrap items-baseline gap-x-3 border-l-2 border-warn pl-3 text-[15px] text-warn" role="status">
                <span className="sc !text-warn">Paused until</span>
                <span className="num text-[17px]">{fmtTime(v.paused_until_ms!)}</span>
                <span className="text-text-2">{fmtDuration(v.paused_until_ms! - now)} left</span>
              </p>
            )}
            {live && (
              <p className="mt-2 text-[13px] text-text-2">
                {lastBeat ? <>Last heartbeat at <span className="num">{fmtTime(lastBeat.ms)}</span>{lastBeat.detail ? `, by ${lastBeat.detail === "pulse_key" ? "a pulse key" : "the owner"}` : ""}.</> : <>Counting from <span className="num">{fmtTime(v.last_beat_ms)}</span>.</>} Each new beat on chain pulses the seal.
              </p>
            )}
          </div>

          <dl className="mt-10 grid grid-cols-1 gap-8 border-t border-rule pt-8 sm:grid-cols-3 sm:gap-0 sm:[&>div+div]:border-l sm:[&>div+div]:border-rule sm:[&>div+div]:pl-8 sm:[&>div]:pr-6">
            {figures(v, now, nftOwner, triggered?.ms, settled?.ms, paused)}
          </dl>

          <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-4">
            {guided && !guestAs ? (
              <p className="max-w-[52ch] text-[15px] leading-relaxed text-text-2">The guest run above drives this vault. Everything on this page is read from the chain as it happens.</p>
            ) : accountId ? (
              <>
                {live && (
                  <Tip why={heartbeatWhy}>
                    <button className={btn("heartbeat")} disabled={!canHeartbeat || busy} onClick={() => send("Heartbeat", () => heartbeatCall(v.token_id))}>
                      Send heartbeat
                    </button>
                  </Tip>
                )}
                {live && (
                  <Tip why={pokeWhy}>
                    <button className={btn("poke")} disabled={!pokeDue || busy} onClick={() => send("Poke", () => pokeCall(v.token_id))}>
                      Poke
                    </button>
                  </Tip>
                )}
                {v.state !== "Settled" && (
                  <Tip why={execWhy}>
                    <button className={btn("execute")} disabled={!execOk || busy} onClick={executeNext}>
                      {execLabel}
                    </button>
                  </Tip>
                )}
                {v.state === "Settled" && (
                  <Tip why={claimWhy}>
                    <button className={btn("claim")} disabled={!canClaim || !claimable || busy} onClick={() => send("Claim", () => claimCall(v.token_id))}>
                      Claim remaining balance
                    </button>
                  </Tip>
                )}
              </>
            ) : (
              <>
                <button className="pill" onClick={connect}>Connect wallet</button>
                {guestAvailable() && <Link className="tl" to="/try">Try it without a wallet</Link>}
              </>
            )}
          </div>
          <div className="mt-5 space-y-3 text-[14px]">
            {accountId && !guided && !isOwner && v.state !== "Settled" && <p className="text-text-2">Poke and Execute can be sent by any account. Heartbeat is limited to the owner or a pulse key.</p>}
            {msg && (
              <p className="text-life">
                {msg}
                {txHash && (
                  <span className="ml-3">
                    <ExtLink href={links.nearTx(txHash)}>nearblocks</ExtLink>
                  </span>
                )}
              </p>
            )}
            {err && <ErrorNote>{err}</ErrorNote>}
          </div>
        </div>
      </section>

      {/* ---------- the record ---------- */}
      <Section label="Heirs" note={v.heirs.length > 1 ? "The largest share also receives the Will NFT." : undefined}>
        <ul>
          {v.heirs.map((h, i) => (
            <li key={h.account_id} className={`grid grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-1 py-4 sm:grid-cols-[1fr_7rem_14rem] ${i ? "border-t border-rule" : ""}`}>
              <span className="min-w-0">
                {who(h.account_id) && <span className="display mr-3 text-[24px] leading-none">{who(h.account_id)}</span>}
                <ExtLinkMono href={links.nearAddress(h.account_id)} title={h.account_id}>{shortAccount(h.account_id)}</ExtLinkMono>
              </span>
              <span className="display num text-right text-[34px]">{bpsToPct(h.bps)}</span>
              <span className="num col-span-2 text-[15px] text-text-2 sm:col-span-1 sm:text-right">{heirAmount(v, h.account_id, h.bps)}</span>
            </li>
          ))}
        </ul>
        {v.foreign.length > 0 && (
          <p className="mt-4 text-[15px] text-text-2">
            Also {v.foreign.length} foreign payout{v.foreign.length === 1 ? "" : "s"}, listed under settlement. Source addresses:{" "}
            {v.foreign.map((f, i) =>
              sourceOf(f) ? (
                <span key={i} className="mr-3">
                  <ExtLink href={chainMeta(f.chain).address(sourceOf(f))}>{chainMeta(f.chain).short}</ExtLink>
                </span>
              ) : null,
            )}
          </p>
        )}
      </Section>

      <Section label="Settlement" note="Five steps, in order. Anyone can execute the next one once the vault is triggered.">
        <Timeline v={v} contract={CONTRACT} onRelay={accountId ? relay : undefined} relayBusy={busy} />
      </Section>

      <Section label="Agent" note="An AI agent may spend from this vault within these limits, only while the owner is alive.">
        <AgentPanel v={v} alias={who} />
      </Section>

      <Section label="Keys" note="Pulse keys can only send heartbeats. Pair a phone to carry one. Agent keys can only pay within policy.">
        <KeysPanel v={v} isOwner={isOwner} />
      </Section>

      <Section label="Guardian" note="Someone you trust who can pause the vault once per heartbeat cycle.">
        <GuardianPanel v={v} now={now} accountId={accountId} isOwner={isOwner} busy={busy} send={send} />
      </Section>

      <Section label="Fund and transfer">
        <FundTransfer v={v} isOwner={isOwner} connected={!!accountId} busy={busy} onDeposit={(y) => send("Deposit", () => depositCall(v.token_id, y))} onTransfer={(to) => send("Transfer", () => nftTransferCall(to, v.token_id))} />
      </Section>

      <Section label="The record" note="Every event the contract kept for this Will NFT, newest first.">
        <Record v={v} nftOwner={nftOwner} alias={who} />
      </Section>

      {!guided && <Section label="Stop the heartbeat" note="For the demo: this is how absence is simulated.">
        <p className="max-w-[62ch] text-[17px] leading-relaxed">
          On a paired phone, press and hold <span className="text-text">Hold to stop</span> for two seconds. Or press <kbd className="mono rounded-sm border border-rule px-1.5 py-0.5 !text-[13px]">Ctrl-C</kbd> in the terminal running{" "}
          <code className="mono text-brass">npm run pulse</code>, or run <code className="mono text-brass">make kill</code> from the repo root.
        </p>
        <p className="mt-3 max-w-[62ch] text-[15px] text-text-2">
          After {fmtInterval(v.heartbeat_interval_s)} the vault turns Warning. After {v.grace_missed + 1} intervals ({silence}) anyone can poke it.
        </p>
      </Section>}

      {MOCK && <p className="rule pt-6 text-center text-[13px] text-text-2">Mock mode: the vault cycles Alive, Warning, Triggered, Settled every 20 s.</p>}
    </div>
  );
}

function headline(v: VaultView): string {
  if (v.state === "Alive") return "Nothing happens.";
  if (v.state === "Warning") return "A beat was missed.";
  if (v.state === "Triggered") return "This executes.";
  return "It is settled.";
}

function Sentence({ v, silence, isOwner }: { v: VaultView; silence: string; isOwner: boolean }) {
  const who = isOwner ? "you" : v.owner_id;
  const heirs = `${v.heirs.length} heir${v.heirs.length === 1 ? "" : "s"}`;
  if (v.state === "Alive")
    return (
      <>
        While <Who isOwner={isOwner} id={v.owner_id} /> {isOwner ? "keep" : "keeps"} a heartbeat every {fmtInterval(v.heartbeat_interval_s)}, this vault waits. After {silence} of silence it settles to {heirs}.
      </>
    );
  if (v.state === "Warning")
    return <>The agent is disarmed. If the silence lasts until {fmtTime(v.trigger_at_ms)}, settlement to {heirs} begins. One heartbeat from {who === "you" ? "you" : "the owner"} restores it.</>;
  if (v.state === "Triggered") return <>The owner went silent. Settlement is under way, step {Math.min(v.step, 5)} of 5. Any account can carry it forward.</>;
  return <>Settlement is complete. Every step has executed and the Will NFT has passed to the primary heir.</>;
}

function Who({ isOwner, id }: { isOwner: boolean; id: string }) {
  return isOwner ? <>you</> : <span className="mono !text-[16px] text-text" title={id}>{shortAccount(id)}</span>;
}

function figures(v: VaultView, now: number, nftOwner: string | null, trigMs?: number, settledMs?: number, paused = false): ReactNode {
  const bal = <Figure key="b" label={v.state === "Settled" ? "Remaining balance" : "Balance"} value={`${yoctoToNear(v.balance)} NEAR`} />;
  if (v.state === "Settled")
    return [
      <Figure key="s" label="Settled at" value={settledMs ? fmtTime(settledMs) : "Complete"} />,
      <Figure key="o" label="Will NFT held by" value={nftOwner ? <span title={nftOwner}>{shortAccount(nftOwner)}</span> : "…"} mono />,
      bal,
    ];
  if (v.state === "Triggered")
    return [<Figure key="s" label="Step" value={`${Math.min(v.step, 5)} of 5`} tone="text-dead" />, <Figure key="t" label="Triggered at" value={trigMs ? fmtTime(trigMs) : "…"} />, bal];
  if (paused)
    return [<Figure key="p" label="Paused until" value={fmtTime(v.paused_until_ms!)} tone="text-warn" />, <Figure key="l" label="Silent since" value={fmtTime(v.last_beat_ms)} />, bal];
  if (now >= v.trigger_at_ms)
    return [<Figure key="d" label="Deadline passed" value="Awaiting poke" tone="text-dead" />, <Figure key="l" label="Silent since" value={fmtTime(v.last_beat_ms)} />, bal];
  if (v.state === "Warning" || now >= v.warning_at_ms)
    return [<Figure key="w" label="Settles in" value={fmtDuration(v.trigger_at_ms - now)} tone="text-warn" />, <Figure key="l" label="Silent since" value={fmtTime(v.last_beat_ms)} />, bal];
  return [
    <Figure key="n" label="Next heartbeat due" value={fmtDuration(v.warning_at_ms - now)} />,
    <Figure key="t" label="Settles after" value={fmtDuration(v.trigger_at_ms - now)} tone="text-text-2" />,
    bal,
  ];
}

function safeDerive(tokenId: string) {
  try {
    return deriveFor(tokenId);
  } catch {
    return null;
  }
}

function ExtLinkMono({ href, children, title }: { href: string; children: ReactNode; title?: string }) {
  return (
    <a href={href} title={title} target="_blank" rel="noreferrer" className="mono !text-[15px] text-text decoration-rule underline-offset-4 hover:underline">
      {children}
    </a>
  );
}

const STEP_NAMES: Record<number, string> = { 1: "pay heirs", 2: "delete keys", 3: "foreign payouts", 4: "DAO proposal", 5: "Will NFT to heir" };

function heirAmount(v: VaultView, account: string, bps: number): string {
  if (v.state === "Settled" || v.step > 1) {
    const paid = step1AmountFor(lastEvent(v.log, "step_1")?.detail, account);
    return paid ? `${paid} NEAR paid` : "paid";
  }
  return `${yoctoToNear(expectedShare(v.balance, bps, !!v.dao_id))} NEAR at step 1`;
}

function FundTransfer({ v, isOwner, connected, busy, onDeposit, onTransfer }: { v: VaultView; isOwner: boolean; connected: boolean; busy: boolean; onDeposit: (yocto: string) => void; onTransfer: (to: string) => void }) {
  const [amt, setAmt] = useState("1");
  const [to, setTo] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  const live = v.state === "Alive" || v.state === "Warning";
  const deposit = () => {
    try {
      const y = nearToYocto(amt);
      if (BigInt(y) <= 0n) throw new Error("Amount must be above 0");
      setBad(null);
      onDeposit(y);
    } catch (e) {
      setBad(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="grid gap-10 md:grid-cols-2">
      <div>
        <label className="sc block" htmlFor="dep">Deposit NEAR, from any account</label>
        <div className="mt-2 flex items-end gap-6">
          <div className="relative flex-1">
            <input id="dep" className="field num pr-14" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
            <span className="absolute bottom-2.5 right-0 text-[14px] text-text-2">NEAR</span>
          </div>
          <Tip why={!connected ? "Connect a wallet first" : v.state === "Settled" ? "Settled vaults pay out through claim" : ""}>
            <button className="tl" disabled={!connected || busy || v.state === "Settled"} onClick={deposit}>Deposit</button>
          </Tip>
        </div>
        {bad && <p className="mt-2 text-[14px] text-dead">{bad}</p>}
      </div>
      <div>
        <label className="sc block" htmlFor="xfer">Transfer the Will NFT, owner only, while alive</label>
        <div className="mt-2 flex items-end gap-6">
          <input id="xfer" className="field mono flex-1" placeholder="new-owner.testnet" value={to} onChange={(e) => setTo(e.target.value)} />
          <Tip why={!isOwner ? "Only the vault owner can transfer it" : !live ? "The Will NFT is locked once the vault is triggered" : !to.trim() ? "Enter the receiving account" : ""}>
            <button className="tl" disabled={!isOwner || !live || !to.trim() || busy} onClick={() => confirm(`Transfer vault #${v.token_id} to ${to.trim()}? They become the owner.`) && onTransfer(to.trim())}>
              Transfer
            </button>
          </Tip>
        </div>
      </div>
    </div>
  );
}

