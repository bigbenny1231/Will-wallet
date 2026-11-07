import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { CONTRACT, MOCK, POLL_MS } from "../config";
import { api } from "../lib/near";
import { useWallet } from "../lib/wallet";
import { usePoll, useNow } from "../lib/usePoll";
import { bpsToPct, expectedShare, fmtInterval, fmtTime, nearToYocto, yoctoToNear } from "../lib/format";
import { claimCall, depositCall, executeStepCall, heartbeatCall, markBroadcastCall, nftTransferCall, pokeCall } from "../lib/calls";
import { broadcastForeign, stepArgsFor } from "../lib/chains";
import { step1AmountFor, lastEvent } from "../lib/logparse";
import type { CallArgs } from "../types";
import AgentPanel from "../components/AgentPanel";
import KeysPanel from "../components/KeysPanel";
import Timeline from "../components/Timeline";
import TxBanner from "../components/TxBanner";
import { Countdown, ErrorNote, ExtLink, Ribbon } from "../components/ui";
import { links } from "../config";
import { currentForeign } from "../lib/chains";

export default function Vault() {
  const { id = "" } = useParams();
  const { accountId, connect, call } = useWallet();
  const now = useNow(250);
  const vault = usePoll(() => api.getVault(id), POLL_MS, [id]);
  const nft = usePoll(() => api.nftToken(id), POLL_MS, [id]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);

  const v = vault.data;
  if (!vault.loaded) return <p className="text-mute">Loading vault #{id}…</p>;
  if (!v) {
    return (
      <div className="space-y-3">
        {vault.error && <ErrorNote>{vault.error}</ErrorNote>}
        <p className="text-mute">Vault #{id} was not found on {CONTRACT}.</p>
        <Link className="link" to="/">Back to vaults</Link>
      </div>
    );
  }

  const isOwner = accountId === v.owner_id;
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

  return (
    <div className="space-y-8">
      <TxBanner />
      {vault.error && <ErrorNote>Could not refresh: {vault.error}</ErrorNote>}

      <section className="grid gap-8 lg:grid-cols-[400px_1fr]">
        <div className="space-y-3">
          <div className="overflow-hidden rounded-2xl border border-line bg-panel">
            {media ? (
              <img src={media} alt={`Will NFT for vault ${v.token_id}`} className="block aspect-square w-full" />
            ) : (
              <div className="flex aspect-square items-center justify-center text-mute">No NFT image</div>
            )}
          </div>
          <div className="text-center text-sm text-mute">Will NFT, refreshes every {POLL_MS / 1000} s</div>
        </div>

        <div className="panel flex flex-col justify-between gap-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-sm uppercase tracking-widest text-mute">Vault</div>
              <h1 className="text-4xl font-semibold">#{v.token_id}</h1>
              <div className="mt-1 text-mute">
                owner <span className="font-mono text-ink">{v.owner_id}</span>
                {isOwner && <span className="ml-2 text-accent">(you)</span>}
              </div>
            </div>
            <Ribbon state={v.state} className="!text-xl !px-5 !py-2" />
          </div>

          <Countdown state={v.state} warningAt={v.warning_at_ms} triggerAt={v.trigger_at_ms} now={now} />

          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Kv k="Balance" v={`${yoctoToNear(v.balance)} NEAR`} />
            <Kv k="Heartbeat every" v={fmtInterval(v.heartbeat_interval_s)} />
            <Kv k="Missed beats allowed" v={String(v.grace_missed)} />
          </dl>

          <div className="space-y-3">
            <div className="flex flex-wrap gap-3">
              {accountId ? (
                <>
                  <Tip why={canHeartbeat ? "" : isOwner ? "Heartbeat is rejected once the vault is Triggered" : "Heartbeat is limited to the owner or a pulse key"}>
                    <button className="btn btn-primary" disabled={!canHeartbeat || busy} onClick={() => send("Heartbeat", () => heartbeatCall(v.token_id))}>
                      Heartbeat
                    </button>
                  </Tip>
                  <Tip why={pokeWhy}>
                    <button className="btn" disabled={!pokeDue || busy} onClick={() => send("Poke", () => pokeCall(v.token_id))}>
                      Poke
                    </button>
                  </Tip>
                  <Tip why={execWhy}>
                    <button className="btn" disabled={!execOk || busy} onClick={executeNext}>
                      {execOk ? `Execute next step (${v.step} of 5: ${STEP_NAMES[v.step]})` : "Execute next step"}
                    </button>
                  </Tip>
                  {v.state === "Settled" && (
                    <Tip why={claimWhy}>
                      <button className="btn" disabled={!canClaim || !claimable || busy} onClick={() => send("Claim", () => claimCall(v.token_id))}>
                        Claim remaining balance
                      </button>
                    </Tip>
                  )}
                </>
              ) : (
                <button className="btn btn-primary" onClick={connect}>Connect wallet</button>
              )}
            </div>
            {accountId && !isOwner && v.state !== "Settled" && <p className="text-mute">Poke and Execute can be sent by any account. Heartbeat is limited to the owner or a pulse key.</p>}
            {msg && (
              <p className="text-alive">
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

      <section className="panel">
        <h2 className="h-section">Kill the heartbeat</h2>
        <p className="text-lg">
          To simulate death, stop the daemon: press <kbd className="rounded-md border border-line bg-bg px-2 py-0.5 font-mono">Ctrl-C</kbd> in the terminal running{" "}
          <code className="font-mono text-accent">npm run pulse</code>, or run <code className="font-mono text-accent">make kill</code> from the repo root.
        </p>
        <p className="mt-2 text-mute">
          After {fmtInterval(v.heartbeat_interval_s)} the vault turns Warning. After {v.grace_missed + 1} intervals ({fmtInterval(v.heartbeat_interval_s * (v.grace_missed + 1))}) anyone can poke it.
        </p>
      </section>

      <section className="panel">
        <h2 className="h-section">Heirs</h2>
        <ul className="divide-y divide-line">
          {v.heirs.map((h) => (
            <li key={h.account_id} className="flex items-baseline justify-between gap-4 py-3">
              <span className="font-mono text-lg">{h.account_id}</span>
              <span className="text-lg">
                <span className="font-semibold">{bpsToPct(h.bps)}</span>
                <span className="ml-3 text-mute">{heirAmount(v, h.account_id, h.bps)}</span>
              </span>
            </li>
          ))}
        </ul>
        {v.foreign.length > 0 && (
          <p className="mt-4 text-mute">
            Also {v.foreign.length} foreign payout{v.foreign.length === 1 ? "" : "s"}; see the timeline below. Source addresses:{" "}
            {v.foreign.map((f, i) =>
              f.from_address ? (
                <span key={i} className="mr-3">
                  <ExtLink href={f.chain === "base" ? links.baseAddress(f.from_address) : links.solAddress(f.from_address)}>{f.chain}</ExtLink>
                </span>
              ) : null,
            )}
          </p>
        )}
      </section>

      <section className="panel">
        <h2 className="h-section">Settlement timeline</h2>
        <Timeline v={v} contract={CONTRACT} onRelay={accountId ? relay : undefined} relayBusy={busy} />
      </section>

      <section className="panel">
        <h2 className="h-section">Agent</h2>
        <AgentPanel v={v} />
      </section>

      <section className="panel">
        <h2 className="h-section">Fund and transfer</h2>
        <FundTransfer v={v} isOwner={isOwner} connected={!!accountId} busy={busy} onDeposit={(y) => send("Deposit", () => depositCall(v.token_id, y))} onTransfer={(to) => send("Transfer", () => nftTransferCall(to, v.token_id))} />
      </section>

      <section className="panel">
        <h2 className="h-section">Keys</h2>
        <KeysPanel v={v} isOwner={isOwner} />
      </section>

      {MOCK && (
        <p className="text-center text-sm text-mute">Mock mode: the vault cycles Alive, Warning, Triggered, Settled every 20 s.</p>
      )}
    </div>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-xl border border-line bg-bg px-4 py-3">
      <dt className="text-sm text-mute">{k}</dt>
      <dd className="mt-1 text-xl font-semibold">{v}</dd>
    </div>
  );
}

const STEP_NAMES: Record<number, string> = { 1: "pay heirs", 2: "delete keys", 3: "foreign payouts", 4: "DAO proposal", 5: "Will NFT to heir" };

function heirAmount(v: import("../types").VaultView, account: string, bps: number): string {
  if (v.state === "Settled" || v.step > 1) {
    const paid = step1AmountFor(lastEvent(v.log, "step_1")?.detail, account);
    return paid ? `${paid} NEAR paid` : "paid";
  }
  return `${yoctoToNear(expectedShare(v.balance, bps, !!v.dao_id))} NEAR at step 1`;
}

/** Hover text for a disabled control (disabled buttons do not always show their own title). */
function Tip({ why, children }: { why: string; children: ReactNode }) {
  return (
    <span title={why || undefined} className="inline-flex">
      {children}
    </span>
  );
}

function FundTransfer({ v, isOwner, connected, busy, onDeposit, onTransfer }: { v: import("../types").VaultView; isOwner: boolean; connected: boolean; busy: boolean; onDeposit: (yocto: string) => void; onTransfer: (to: string) => void }) {
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
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-2">
        <label className="label" htmlFor="dep">Deposit NEAR (anyone)</label>
        <div className="flex gap-3">
          <input id="dep" className="input" value={amt} onChange={(e) => setAmt(e.target.value)} />
          <Tip why={!connected ? "Connect a wallet first" : v.state === "Settled" ? "Settled vaults pay out through claim" : ""}>
            <button className="btn" disabled={!connected || busy || v.state === "Settled"} onClick={deposit}>Deposit</button>
          </Tip>
        </div>
        {bad && <p className="text-dead">{bad}</p>}
      </div>
      <div className="space-y-2">
        <label className="label" htmlFor="xfer">Transfer the Will NFT (owner, Alive or Warning only)</label>
        <div className="flex gap-3">
          <input id="xfer" className="input font-mono" placeholder="new-owner.testnet" value={to} onChange={(e) => setTo(e.target.value)} />
          <Tip why={!isOwner ? "Only the vault owner can transfer it" : !live ? "The Will NFT is locked once the vault is triggered" : !to.trim() ? "Enter the receiving account" : ""}>
            <button className="btn" disabled={!isOwner || !live || !to.trim() || busy} onClick={() => confirm(`Transfer vault #${v.token_id} to ${to.trim()}? They become the owner.`) && onTransfer(to.trim())}>
              Transfer
            </button>
          </Tip>
        </div>
      </div>
    </div>
  );
}
