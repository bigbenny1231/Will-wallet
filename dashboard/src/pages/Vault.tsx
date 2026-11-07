import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CONTRACT, MOCK, POLL_MS } from "../config";
import { api } from "../lib/near";
import { useWallet } from "../lib/wallet";
import { usePoll, useNow } from "../lib/usePoll";
import { bpsToPct, fmtInterval, yoctoToNear } from "../lib/format";
import AgentPanel from "../components/AgentPanel";
import KeysPanel from "../components/KeysPanel";
import Timeline from "../components/Timeline";
import TxBanner from "../components/TxBanner";
import { Countdown, ErrorNote, ExtLink, Ribbon } from "../components/ui";
import { links } from "../config";

export default function Vault() {
  const { id = "" } = useParams();
  const { accountId, connect, call } = useWallet();
  const now = useNow(250);
  const vault = usePoll(() => api.getVault(id), POLL_MS, [id]);
  const nft = usePoll(() => api.nftToken(id), POLL_MS, [id]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const run = async (label: string, method: string, gas = "30000000000000") => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      await call({ method, args: { token_id: v.token_id }, gas });
      setMsg(`${label} sent.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

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
                  <button className="btn btn-primary" disabled={!canHeartbeat || busy} onClick={() => run("Heartbeat", "heartbeat")}>
                    Heartbeat
                  </button>
                  {v.state === "Settled" && (
                    <button className="btn" disabled={!canClaim || busy} onClick={() => run("Claim", "claim", "50000000000000")}>
                      Claim remaining balance
                    </button>
                  )}
                </>
              ) : (
                <button className="btn btn-primary" onClick={connect}>Connect wallet</button>
              )}
            </div>
            {accountId && !isOwner && v.state !== "Settled" && <p className="text-mute">Heartbeat is limited to the owner or a pulse key.</p>}
            {v.state === "Settled" && !canClaim && <p className="text-mute">Claim is available to the current NFT owner{nftOwner ? ` (${nftOwner})` : ""}.</p>}
            {msg && <p className="text-alive">{msg}</p>}
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
                <span className="ml-3 text-mute">{yoctoToNear((BigInt(v.balance) * BigInt(h.bps)) / 10000n)} NEAR now</span>
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
        <Timeline v={v} contract={CONTRACT} />
      </section>

      <section className="panel">
        <h2 className="h-section">Agent</h2>
        <AgentPanel v={v} />
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
