import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CONTRACT, MOCK, POLL_MS } from "../config";
import { api } from "../lib/near";
import { useWallet } from "../lib/wallet";
import { usePoll } from "../lib/usePoll";
import { bpsToPct, fmtInterval, yoctoToNear } from "../lib/format";
import TxBanner from "../components/TxBanner";
import { ErrorNote, Ribbon } from "../components/ui";

export default function Home() {
  const { accountId, connect, ready } = useWallet();
  const nav = useNavigate();
  const [open, setOpen] = useState("");
  const mine = usePoll(() => (accountId ? api.getVaultsForOwner(accountId) : Promise.resolve([])), POLL_MS * 2, [accountId]);
  // Without a wallet, list every vault on the contract so the app is browsable read-only.
  const everyone = usePoll(() => (accountId ? Promise.resolve([]) : api.getAllVaults()), POLL_MS * 2, [accountId]);
  const list = accountId ? mine.data : everyone.data;

  return (
    <div className="space-y-8">
      <TxBanner />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-4xl font-semibold">My vaults</h1>
        <Link to="/create" className="btn btn-primary">Create vault</Link>
      </div>

      {!accountId && (
        <div className="panel flex flex-col items-start gap-4">
          <p className="text-lg text-mute">Connect a NEAR wallet to see your vaults. All vaults on {CONTRACT} are listed below.</p>
          <button className="btn btn-primary" onClick={connect} disabled={!ready}>Connect wallet</button>
        </div>
      )}

      {accountId && mine.error && <ErrorNote>{mine.error}</ErrorNote>}
      {accountId && mine.loaded && (mine.data?.length ?? 0) === 0 && !mine.error && (
        <div className="panel text-lg text-mute">No vaults for {accountId} yet.</div>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        {list?.map((v) => (
          <Link key={v.token_id} to={`/vault/${v.token_id}`} className="panel block transition hover:border-accent">
            <div className="flex items-start justify-between">
              <div className="text-3xl font-semibold">#{v.token_id}</div>
              <Ribbon state={v.state} />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-base">
              <div><div className="text-sm text-mute">Balance</div>{yoctoToNear(v.balance)} NEAR</div>
              <div><div className="text-sm text-mute">Heartbeat</div>every {fmtInterval(v.heartbeat_interval_s)}</div>
              <div className="col-span-2">
                <div className="text-sm text-mute">Heirs</div>
                {v.heirs.map((h) => `${h.account_id} ${bpsToPct(h.bps)}`).join(", ")}
              </div>
            </div>
          </Link>
        ))}
      </div>

      <form
        className="flex max-w-md items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (open.trim()) nav(`/vault/${open.trim()}`);
        }}
      >
        <label className="flex-1">
          <span className="label">Open a vault by id</span>
          <input className="input" value={open} onChange={(e) => setOpen(e.target.value)} inputMode="numeric" placeholder={MOCK ? "1" : "token id"} />
        </label>
        <button className="btn" type="submit">Open</button>
      </form>
    </div>
  );
}
