import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CONTRACT, MOCK, POLL_MS } from "../config";
import { api } from "../lib/near";
import { useWallet } from "../lib/wallet";
import { usePoll } from "../lib/usePoll";
import { bpsToPct, fmtInterval, yoctoToNear } from "../lib/format";
import { aliveStrip, STATE_COLOR } from "../lib/pulse";
import TxBanner from "../components/TxBanner";
import { ErrorNote, Label, Ribbon, ReconnectHint } from "../components/ui";
import type { VaultState } from "../types";

function MiniTrace({ state }: { state: VaultState }) {
  const d =
    state === "Alive"
      ? aliveStrip(84, 15, 10, 0.32)
      : state === "Warning"
        ? "M0 15h14l1 2 1.5-9 1.5 10 1-3h22l1 1 1-5 1 5h40"
        : "M0 15h84";
  return (
    <svg width="84" height="22" viewBox="0 0 84 22" aria-hidden className="shrink-0 overflow-visible">
      <path d={d} fill="none" stroke={STATE_COLOR[state]} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" opacity={state === "Settled" ? 0.7 : 1} />
    </svg>
  );
}

const COLS = "grid grid-cols-[4.5rem_1fr_auto] items-baseline gap-x-6 md:grid-cols-[5rem_13rem_1fr_9rem_8rem]";

export default function Home() {
  const { accountId } = useWallet();
  const nav = useNavigate();
  const [open, setOpen] = useState("");
  const mine = usePoll(() => (accountId ? api.getVaultsForOwner(accountId) : Promise.resolve([])), POLL_MS * 2, [accountId]);
  // Without a wallet, list every vault on the contract so the app is browsable read-only.
  const everyone = usePoll(() => (accountId ? Promise.resolve([]) : api.getAllVaults()), POLL_MS * 2, [accountId]);
  const list = [...((accountId ? mine.data : everyone.data) ?? [])].sort((a, b) => Number(BigInt(b.token_id) - BigInt(a.token_id)));
  const loaded = accountId ? mine.loaded : everyone.loaded;

  return (
    <div className="wrap pb-24">
      <div className="space-y-3 pt-6 empty:hidden">
        <TxBanner />
        <ReconnectHint show={mine.reconnecting || everyone.reconnecting} />
        {accountId && mine.error && <ErrorNote>{mine.error}</ErrorNote>}
      </div>

      <div className="grid gap-8 pb-14 pt-14 md:grid-cols-12 md:items-end">
        <div className="md:col-span-8">
          <Label>{accountId ? <>Kept by <span className="mono !text-[12px] normal-case tracking-normal">{accountId}</span></> : <>Every vault on {CONTRACT}</>}</Label>
          <h1 className="display mt-4 text-[52px] md:text-[72px]">{accountId ? "Your vaults" : "The register"}</h1>
          <p className="mt-5 max-w-[52ch] text-[19px] leading-relaxed text-text-2">
            {accountId ? (
              "Each vault waits while its owner keeps a heartbeat. When the heartbeat stops, it settles to the heirs named in it."
            ) : (
              <>
                Each vault waits while its owner keeps a heartbeat. Connect a NEAR wallet to see your own;{" "}
                until then, the full register is open to read.
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-8 md:col-span-4 md:justify-end">
          <Link to="/create" className="pill">Create a vault</Link>
        </div>
      </div>

      <div role="table" aria-label="Vaults">
        <div role="row" className={`${COLS} border-b border-rule pb-3`}>
          <span role="columnheader" className="sc">No.</span>
          <span role="columnheader" className="sc">State</span>
          <span role="columnheader" className="sc hidden md:block">Heirs</span>
          <span role="columnheader" className="sc hidden md:block">Heartbeat</span>
          <span role="columnheader" className="sc text-right">Balance</span>
        </div>

        {!loaded && <p className="py-8 text-text-2">Reading the register…</p>}
        {accountId && mine.loaded && list.length === 0 && !mine.error && (
          <div className="py-12">
            <p className="display text-[32px]">No vaults kept by this account yet.</p>
            <Link to="/create" className="tl mt-4">Create the first one</Link>
          </div>
        )}

        {list.map((v) => (
          <Link role="row" key={v.token_id} to={`/vault/${v.token_id}`} className={`${COLS} group border-b border-rule py-6 transition-colors duration-700 hover:bg-[color-mix(in_srgb,var(--text)_3%,transparent)]`}>
            <span role="cell" className="display num text-[44px] leading-none transition-colors duration-700 group-hover:text-accent">{v.token_id}</span>
            <span role="cell" className="flex items-center gap-4">
              <MiniTrace state={v.state} />
              <Ribbon state={v.state} className="text-[24px]" />
            </span>
            <span role="cell" className="hidden min-w-0 space-y-0.5 md:block">
              {v.heirs.map((h) => (
                <span key={h.account_id} className="flex items-baseline gap-3">
                  <span className="mono truncate !text-[13px]">{h.account_id}</span>
                  <span className="num text-[13px] text-text-2">{bpsToPct(h.bps)}</span>
                </span>
              ))}
            </span>
            <span role="cell" className="hidden text-[15px] text-text-2 md:block">every {fmtInterval(v.heartbeat_interval_s)}</span>
            <span role="cell" className="num text-right text-[17px]">{yoctoToNear(v.balance)} NEAR</span>
          </Link>
        ))}
      </div>

      <form
        className="mt-14 flex max-w-md items-end gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (open.trim()) nav(`/vault/${open.trim()}`);
        }}
      >
        <label className="flex-1">
          <span className="sc block">Open a vault by number</span>
          <input className="field num mt-1" value={open} onChange={(e) => setOpen(e.target.value)} inputMode="numeric" placeholder={MOCK ? "1" : "6"} />
        </label>
        <button className="tl" type="submit">Open</button>
      </form>
    </div>
  );
}
