import { chainMeta } from "../lib/chainmeta";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { MOCK, NEAR_AUTH, POLL_MS, links, CONTRACT } from "../config";
import { continueWithGoogle, isImplicitAccount, loadIdentity, nearAuthAvailable, signOutGoogle, type HeirIdentity } from "../lib/nearAuth";
import { mockApi } from "../lib/mock";
import { api } from "../lib/near";
import { useWallet } from "../lib/wallet";
import { usePoll } from "../lib/usePoll";
import { bpsToPct, expectedShare, fmtInterval, unitsFor, yoctoToNear } from "../lib/format";
import { CopyBox, ErrorNote, ExtLink, Figure, Label, ReconnectHint } from "../components/ui";
import { parseStep1Detail, step1AmountFor } from "../lib/logparse";
import type { VaultView } from "../types";
import { sealDataUri } from "../lib/seal";

/** The one warm page: bone ground, ink type. App.tsx sets the inverted palette on this route. */
export default function Heir() {
  const { accountId, connect, ready } = useWallet();
  const [gid, setGid] = useState<HeirIdentity | null>(() => loadIdentity());
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState<string | null>(null);
  const googleOk = nearAuthAvailable();

  // A wallet account wins; otherwise the accounts NEAR Auth resolved for the Google identity.
  const candidates = useMemo(() => (accountId ? [accountId] : gid ? [gid.implicitId, ...gid.named] : []), [accountId, gid]);
  useEffect(() => {
    if (MOCK && gid && !accountId) mockApi.nameImplicitHeir(gid.implicitId);
  }, [gid, accountId]);
  const res = usePoll(
    async () => {
      if (!candidates.length) return [] as { v: VaultView; me: string }[];
      const all = await api.getAllVaults();
      return all.flatMap((v) => {
        const me = candidates.find((c) => v.heirs.some((h) => h.account_id === c));
        return me ? [{ v, me }] : [];
      });
    },
    POLL_MS * 2,
    [candidates.join(",")],
  );
  const count = res.data?.length ?? 0;
  const who = accountId ?? gid?.implicitId ?? null;

  const google = async () => {
    setAuthErr(null);
    setAuthBusy(true);
    try {
      setGid(await continueWithGoogle());
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setAuthErr(/popup|closed|cancel/i.test(m) ? "The Google window was closed before sign-in finished." : m);
    } finally {
      setAuthBusy(false);
    }
  };
  const signOut = async () => {
    await signOutGoogle();
    setGid(null);
  };

  return (
    <div className="wrap pb-28">
      <div className="max-w-[880px] pb-16 pt-20">
        <Label>For heirs</Label>
        <h1 className="display fade-in mt-6 text-[56px] leading-[0.95] md:text-[88px]">Something was left to you.</h1>
        <p className="mt-8 max-w-[54ch] text-[20px] leading-relaxed text-text-2">
          {who ? (
            count > 0 ? (
              <>
                <AccountName id={who} /> is named in {count === 1 ? "one vault" : `${count} vaults`}. What arrives, and when, is set out below.
              </>
            ) : res.loaded ? (
              <>
                <AccountName id={who} /> is not named as an heir in any vault yet.
              </>
            ) : (
              "Reading the register…"
            )
          ) : (
            "Sign in with Google, or with the NEAR account you were named under. Nothing is asked of you beyond that."
          )}
        </p>

        {!accountId && gid && <GoogleIdentity id={gid} onSignOut={signOut} />}

        {!accountId && !gid && (
          <div className="mt-10">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
              <button className="pill gap-3" onClick={google} disabled={!googleOk || authBusy}>
                <GoogleMark />
                {authBusy ? "Waiting for Google…" : "Continue with Google"}
              </button>
              <button className="tl" onClick={connect} disabled={!ready}>Use a NEAR wallet</button>
            </div>
            <p className="mt-4 max-w-[60ch] text-[14px] leading-relaxed text-text-2">
              {googleOk ? (
                <>Google sign-in runs through NEAR Auth. Your Google identity controls one NEAR account, derived by the NEAR MPC network. No wallet, no seed phrase.</>
              ) : (
                <>
                  <span className="sc mr-2">NEAR Auth (coming)</span>
                  Google sign-in needs this site’s address registered with NEAR Auth. The shared testnet credentials only accept {NEAR_AUTH.origins.join(", ") || "no origin"}; production credentials are on request.
                </>
              )}
            </p>
            {authErr && <div className="mt-4"><ErrorNote>{authErr}</ErrorNote></div>}
          </div>
        )}
      </div>

      <div className="space-y-3 empty:hidden">
        <ReconnectHint show={res.reconnecting} />
        {who && res.error && <ErrorNote>{res.error}</ErrorNote>}
      </div>

      {res.data?.map(({ v, me }) => <Bequest key={v.token_id} v={v} me={me} />)}
    </div>
  );
}

function AccountName({ id }: { id: string }) {
  return <span className="mono !text-[17px] text-text" title={id}>{isImplicitAccount(id) ? `${id.slice(0, 10)}…${id.slice(-6)}` : id}</span>;
}

function GoogleIdentity({ id, onSignOut }: { id: HeirIdentity; onSignOut: () => void }) {
  return (
    <div className="mt-10 max-w-[720px] border-l-2 border-accent pl-6">
      <div className="text-[15px] text-text-2">
        Signed in with Google{id.email ? <> as <span className="text-text">{id.email}</span></> : null}. NEAR Auth gives this identity the account
      </div>
      <div className="mt-3">
        <CopyBox value={id.implicitId} />
      </div>
      {id.named.length > 0 && (
        <p className="mt-3 text-[14px] text-text-2">
          The same key also signs for <span className="mono !text-[13px] text-text">{id.named.join(", ")}</span>; those are searched too.
        </p>
      )}
      <p className="mt-3 max-w-[60ch] text-[14px] leading-relaxed text-text-2">
        Give this account id to whoever is naming you as an heir. It is the same every time you sign in with this Google account.
      </p>
      <button className="tl mt-4 !text-[14px]" onClick={onSignOut}>Sign out</button>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path fill="currentColor" d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z" />
    </svg>
  );
}

function Bequest({ v, me }: { v: VaultView; me: string }) {
  const mine = v.heirs.find((h) => h.account_id === me)!;
  const settled = v.state === "Settled";
  const step1 = v.log.find((l) => l.event === "step_1");
  const paid = v.step > 1 || settled; // step 1 (NEAR to heirs) is done once the cursor has moved on
  // After step 1 the vault balance only holds the reserve, so the paid amount comes from the step_1 log line.
  const paidAmount = step1AmountFor(step1?.detail, me);
  const allPaid = parseStep1Detail(step1?.detail);
  const expected = yoctoToNear(expectedShare(v.balance, mine.bps, !!v.dao_id));
  const status = settled ? "Arrived" : v.state === "Triggered" ? `Settling, step ${Math.min(v.step, 5)} of 5` : v.state === "Warning" ? "A heartbeat was missed" : "Waiting";

  return (
    <article className="rule grid gap-10 py-14 md:grid-cols-12">
      <div className="md:col-span-3">
        {/* The seal sits on the paper like a stamp. */}
        <img src={sealOf(v)} alt={`Seal of vault ${v.token_id}: ${v.state}`} width={200} height={200} className="block h-[200px] w-[200px] rounded-full" />
        <Link className="tl mt-6" to={`/vault/${v.token_id}`}>Vault {v.token_id}</Link>
      </div>

      <div className="min-w-0 md:col-span-9">
        {v.owner_id === me ? (
          // Step 5 moves the Will NFT (vault ownership) to the primary heir, so the original owner is no longer on the view.
          <>
            <Label>Vault {v.token_id}</Label>
            <div className="mt-2 text-[16px] text-text">The Will NFT for this vault is now held by you.</div>
          </>
        ) : (
          <>
            <Label>From</Label>
            <div className="mono mt-2 !text-[16px] text-text">{v.owner_id}</div>
          </>
        )}

        <p className="display mt-8 text-[40px] leading-[1.02] md:text-[56px]">
          {paid ? (
            paidAmount ? (
              <>
                <span className="num">{paidAmount} NEAR</span> <span className="italic">has arrived.</span>
              </>
            ) : (
              <span className="italic">Your share has been sent.</span>
            )
          ) : (
            <>
              <span className="italic">About</span> <span className="num">{expected} NEAR</span> <span className="italic">is set aside for you.</span>
            </>
          )}
        </p>
        <p className="mt-4 max-w-[58ch] text-[17px] leading-relaxed text-text-2">
          {paid
            ? "Sent to your account at settlement. The figure comes from the settlement record on chain."
            : `If the owner stops checking in for ${fmtInterval(v.heartbeat_interval_s * (v.grace_missed + 1))}, this is paid to you automatically. The amount follows the vault balance, after the settlement reserve.`}
        </p>

        <dl className="mt-10 grid grid-cols-1 gap-8 border-t border-rule pt-8 sm:grid-cols-3">
          <Figure label="Your share" value={bpsToPct(mine.bps)} />
          <Figure label="Status" value={status} />
          <Figure label="Heirs in this vault" value={String(v.heirs.length)} />
        </dl>

        {v.foreign.length > 0 && (
          <div className="mt-10">
            <Label>Also in this vault, on other chains</Label>
            <ul className="mt-3">
              {v.foreign.map((p, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-5 gap-y-1 border-t border-rule py-3 text-[15px]">
                  <span className="w-16 text-text-2">{chainMeta(p.chain).short}</span>
                  <span className="num">{unitsFor(p.chain, p.amount)}</span>
                  <span className="mono !text-[13px] text-text-2">to {p.to}</span>
                  <span className="display text-[18px] italic">{p.status}</span>
                  {p.tx_hash && <ExtLink href={chainMeta(p.chain).tx(p.tx_hash)}>tx</ExtLink>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {allPaid.length > 0 && (
          <p className="mt-8 text-[15px] text-text-2">
            Settlement paid {allPaid.map((p) => `${p.account} ${p.amount} NEAR`).join(", ")}.
          </p>
        )}
        <div className="mt-8 flex flex-wrap items-baseline gap-x-8 gap-y-2">
          <ExtLink href={links.nearAddress(me)}>Your account on nearblocks</ExtLink>
          <span className="text-[13px] text-text-2">contract {CONTRACT}</span>
        </div>
      </div>
    </article>
  );
}

/** The heir list carries no NFT metadata, so the seal is drawn locally with the contract's own drawing. */
function sealOf(v: VaultView): string {
  return sealDataUri(v.token_id, v.state, v.state === "Settled" ? "settled" : "", v.heirs.length);
}
