import { Link } from "react-router-dom";
import { POLL_MS, links, CONTRACT } from "../config";
import { api } from "../lib/near";
import { useWallet } from "../lib/wallet";
import { usePoll } from "../lib/usePoll";
import { bpsToPct, expectedShare, unitsFor, yoctoToNear } from "../lib/format";
import { ErrorNote, ExtLink, Ribbon, ReconnectHint } from "../components/ui";
import { parseStep1Detail, step1AmountFor } from "../lib/logparse";
import type { VaultView } from "../types";

export default function Heir() {
  const { accountId, connect, ready } = useWallet();
  const res = usePoll(() => (accountId ? api.getHeirVaults(accountId) : Promise.resolve([])), POLL_MS * 2, [accountId]);

  return (
    <div className="space-y-8">
      <h1 className="text-4xl font-semibold">Heir</h1>
      {!accountId && (
        <div className="panel flex flex-col items-start gap-4">
          <p className="text-lg text-mute">Sign in with the NEAR account named as heir.</p>
          <button className="btn btn-primary" onClick={connect} disabled={!ready}>Connect wallet</button>
        </div>
      )}
      <ReconnectHint show={res.reconnecting} />
      {accountId && res.error && <ErrorNote>{res.error}</ErrorNote>}
      {accountId && res.loaded && (res.data?.length ?? 0) === 0 && !res.error && (
        <div className="panel text-lg text-mute">{accountId} is not named as an heir in any vault.</div>
      )}
      <div className="space-y-6">
        {res.data?.map((v) => (
          <HeirCard key={v.token_id} v={v} me={accountId!} />
        ))}
      </div>
    </div>
  );
}

function HeirCard({ v, me }: { v: VaultView; me: string }) {
  const mine = v.heirs.find((h) => h.account_id === me)!;
  const settled = v.state === "Settled";
  const step1 = v.log.find((l) => l.event === "step_1");
  const paid = v.step > 1 || settled; // step 1 (NEAR to heirs) is done once the cursor has moved on
  // After step 1 the vault balance only holds the reserve, so the paid amount comes from the step_1 log line
  // ("<account> <amount> NEAR, <account> <amount> NEAR").
  const paidAmount = step1AmountFor(step1?.detail, me);
  const paidMatch = paidAmount ? [paidAmount, paidAmount] : null;
  const allPaid = parseStep1Detail(step1?.detail);
  return (
    <div className="panel space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm uppercase tracking-widest text-mute">From</div>
          <div className="font-mono text-xl">{v.owner_id}</div>
        </div>
        <div className="flex items-center gap-4">
          <Ribbon state={v.state} />
          <Link className="btn" to={`/vault/${v.token_id}`}>Vault #{v.token_id}</Link>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Box label="Your share" value={bpsToPct(mine.bps)} />
        <Box
          label={paid ? "Sent to you" : "Will arrive (NEAR)"}
          value={paid ? (paidMatch ? `${paidMatch[1]} NEAR` : "Sent") : `${yoctoToNear(expectedShare(v.balance, mine.bps, !!v.dao_id))} NEAR`}
          sub={paid ? (paidMatch ? "from the settlement log" : "see the settlement log") : "at current balance, after the settlement reserve"}
        />
        <Box label="Status" value={v.state === "Settled" ? "Arrived" : v.state === "Triggered" ? `Settling, step ${Math.min(v.step, 5)} of 5` : "Waiting"} />
      </div>

      {v.foreign.length > 0 && (
        <div>
          <div className="h-section !mb-2">Foreign payouts in this vault</div>
          <ul className="space-y-2">
            {v.foreign.map((p, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-3">
                <span className="rounded-md border border-line px-2 py-0.5 text-xs uppercase tracking-wider text-mute">{p.chain}</span>
                <span>{unitsFor(p.chain, p.amount)}</span>
                <span className="mono text-mute">to {p.to}</span>
                <span className="text-sm font-semibold">{p.status}</span>
                {p.tx_hash && <ExtLink href={p.chain === "base" ? links.baseTx(p.tx_hash) : links.solTx(p.tx_hash)}>tx</ExtLink>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {allPaid.length > 0 && (
        <p className="text-mute">
          Settlement paid {allPaid.map((p) => `${p.account} ${p.amount} NEAR`).join(", ")}
        </p>
      )}
      <ExtLink href={links.nearAddress(me)}>Your account on nearblocks</ExtLink>
      <span className="ml-4 text-sm text-mute">contract {CONTRACT}</span>
    </div>
  );
}

function Box({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-bg px-4 py-3">
      <div className="text-sm text-mute">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {sub && <div className="text-sm text-mute">{sub}</div>}
    </div>
  );
}
