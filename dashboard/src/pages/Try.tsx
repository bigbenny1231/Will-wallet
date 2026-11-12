import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CONTRACT, links } from "../config";
import { api } from "../lib/near";
import { useWallet } from "../lib/wallet";
import { addAgentKeyCall, addPulseKeyCall, createVaultCall, setForeignPayoutsCall, toPayouts } from "../lib/calls";
import { yoctoToNear } from "../lib/format";
import {
  GUEST_GRACE,
  GUEST_INTERVAL_S,
  GUEST_PLAN,
  accountFor,
  createGuestAccount,
  guestAvailable,
  guestBalance,
  guestError,
  newGuestSession,
  planDeposit,
  publicKeyOf,
  resumeInterrupted,
  sendAs,
  type GuestSession,
} from "../lib/guest";
import { ErrorNote, ExtLink, Label, ROMAN } from "../components/ui";

/** Example recipients on the foreign chains (the same test addresses the showcase vault pays). */
const EXAMPLE_TO = { base: "0xfd151ad02f573689f235f56059ce6e2f3b64dd89", solana: "HpEHvLpa9pMNiDCQDnVMSomCx4bmJuXX8sKqtKGg2uWr" } as const;

type StepState = "todo" | "doing" | "done";
interface Line {
  title: string;
  state: StepState;
  detail?: string;
  hash?: string | null;
}

const ACTS = [
  { name: "Alive", text: "This browser beats with a pulse key. Your agent pays an invoice, then is told to drain the vault and is refused." },
  { name: "Silence", text: "You hold to stop. The vault waits two missed beats, about a minute, then anyone may poke it." },
  { name: "Settlement", text: "Five steps: heirs paid on NEAR, keys deleted, Base and Solana payouts signed by NEAR’s MPC network, the Will NFT handed over." },
];

export default function Try() {
  const { guest, setGuest, accountId, isGuest, disconnect } = useWallet();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[] | null>(null);
  const started = useRef(false);

  const walletConnected = !!accountId && !isGuest;
  const resumable = guest && guest.token && guest.armed ? guest.token : null;

  const begin = async () => {
    if (started.current) return;
    started.current = true;
    setBusy(true);
    setErr(null);
    const L: Line[] = [
      { title: "A throwaway account, from the testnet faucet", state: "todo" },
      { title: "A vault with two heirs", state: "todo" },
      { title: "A pulse key, an agent key and two foreign payouts", state: "todo" },
    ];
    const show = (i: number, patch: Partial<Line>) => {
      L[i] = { ...L[i], ...patch };
      setLines([...L]);
    };
    setLines([...L]);

    try {
      /* 1. the account: reuse an unfinished or still-funded one, else ask the faucet */
      show(0, { state: "doing" });
      let s: GuestSession | null = guest;
      let balance = s ? await guestBalance(s.accountId) : null;
      if (s && s.token && s.armed) {
        // A finished run: a second vault fits on the same account if enough test NEAR is left.
        s = balance !== null && planDeposit(balance) !== null ? { ...newGuestSession(), accountId: s.accountId, secret: s.secret } : null;
      }
      // An interrupted setup (a refresh or a dropped connection while a transaction was in flight). Without this the
      // run could never continue: the account no longer holds enough for a vault, so every retry ended in the same
      // error (SECURITY_REVIEW_3 D-6).
      if (s && balance !== null && !s.armed) {
        s = await resumeInterrupted(s, balance, api);
      }
      if (!s) {
        s = newGuestSession();
        balance = null;
      }
      setGuest(s);
      if (balance === null) {
        await createGuestAccount(s);
        balance = await guestBalance(s.accountId);
      }
      const deposit = balance === null ? null : planDeposit(balance);
      if (!s.token && deposit === null) throw new Error("The guest account does not hold enough test NEAR for a vault. Press Try again to get a new one.");
      show(0, { state: "done", detail: s.accountId });
      const owner = accountFor(s.accountId, s.secret);

      /* 2. the vault */
      show(1, { state: "doing" });
      if (!s.token && deposit !== null) {
        const sent = await sendAs(owner, [
          createVaultCall({
            heartbeat_interval_s: GUEST_INTERVAL_S,
            grace_missed: GUEST_GRACE,
            heirs: s.heirs.map((h) => ({ account_id: h.accountId, bps: h.bps })),
            policy: { per_tx_max: GUEST_PLAN.perTxMax.toString(), daily_max: GUEST_PLAN.dailyMax.toString(), allowlist: [s.provider] },
            bounty: GUEST_PLAN.bounty.toString(),
            depositYocto: deposit.toString(),
            foreign: [],
            dao_id: null,
          }),
        ]);
        let token = sent.value !== undefined && sent.value !== null ? String(sent.value) : "";
        if (!/^\d+$/.test(token)) {
          const mine = await api.getVaultsForOwner(s.accountId);
          token = mine.map((x) => x.token_id).sort((a, b) => Number(BigInt(b) - BigInt(a)))[0] ?? "";
        }
        if (!/^\d+$/.test(token)) throw new Error("The vault was created but its number could not be read. Open the register to find it.");
        s = { ...s, token, txs: [...s.txs, { ms: Date.now(), label: "create_vault", hash: sent.hash }] };
        setGuest(s);
        show(1, { state: "done", detail: `Vault ${token}, ${yoctoToNear(deposit)} NEAR`, hash: sent.hash });
      } else {
        show(1, { state: "done", detail: `Vault ${s.token}` });
      }
      const token = s.token!;

      /* 3. keys and payouts, one transaction */
      show(2, { state: "doing" });
      if (!s.armed) {
        // The source addresses come from the vault's own (salted) derivation paths in its view.
        const { deriveForVault } = await import("../lib/derive");
        const view = await api.getVault(token);
        if (!view) throw new Error(`Vault ${token} could not be read back to derive its source addresses.`);
        const from = deriveForVault(view);
        const payouts = toPayouts([
          { chain: "base", to: EXAMPLE_TO.base, amount: "100000000000000", from_address: from.base },
          { chain: "solana", to: EXAMPLE_TO.solana, amount: "1000000", from_address: from.solana },
        ]);
        const sent = await sendAs(owner, [addPulseKeyCall(token, publicKeyOf(s.pulseSecret)), addAgentKeyCall(token, publicKeyOf(s.agentSecret)), setForeignPayoutsCall(token, payouts)]);
        s = { ...s, armed: true, txs: [...s.txs, { ms: Date.now(), label: "add_pulse_key, add_agent_key, set_foreign_payouts", hash: sent.hash }] };
        setGuest(s);
        show(2, { state: "done", hash: sent.hash });
      } else {
        show(2, { state: "done" });
      }
      nav(`/vault/${token}`);
    } catch (e) {
      setErr(guestError(e));
      const i = L.findIndex((l) => l.state === "doing");
      if (i >= 0) show(i, { state: "todo" });
    } finally {
      setBusy(false);
      started.current = false;
    }
  };

  return (
    <div className="wrap pb-28">
      <div className="grid gap-x-10 gap-y-12 pb-16 pt-14 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-7">
          <Label>Try it · no wallet</Label>
          <h1 className="display fade-in mt-5 text-[48px] leading-[0.98] md:text-[76px]">A whole estate, in three minutes.</h1>
          <p className="mt-7 max-w-[56ch] text-[19px] leading-relaxed text-text-2">
            This browser makes a throwaway account on NEAR testnet, funds it from the public faucet, and opens a real vault on{" "}
            <ExtLink href={links.nearAddress(CONTRACT)}>{CONTRACT}</ExtLink>. Then you stop the heartbeat and watch it settle. Every step is a transaction you can open on the explorer.
          </p>

          {!guestAvailable() ? (
            <div className="mt-10"><ErrorNote>Guest runs exist on testnet only.</ErrorNote></div>
          ) : walletConnected ? (
            <div className="mt-10 max-w-[56ch] space-y-4 text-[16px] text-text-2">
              <p>
                A wallet is connected as <span className="mono !text-[14px] text-text">{accountId}</span>. Guest runs use their own throwaway account, so disconnect first, or create a vault with your wallet.
              </p>
              <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
                <button className="pill" onClick={() => void disconnect()}>Disconnect</button>
                <Link className="tl" to="/create">Create a vault with this wallet</Link>
              </div>
            </div>
          ) : (
            <div className="mt-10">
              <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
                {resumable && !busy && !lines ? (
                  <>
                    <Link className="pill" to={`/vault/${resumable}`}>Return to vault {resumable}</Link>
                    <button className="tl" onClick={begin}>Start a new run</button>
                  </>
                ) : (
                  <button className="pill" disabled={busy} onClick={begin}>
                    {busy ? "Setting up…" : err ? "Try again" : "Begin"}
                  </button>
                )}
              </div>
              <p className="mt-4 max-w-[56ch] text-[14px] leading-relaxed text-text-2">
                Testnet only: nothing here has value. The keys are generated and kept in this browser and can be forgotten at any time. Setup takes about fifteen seconds.
              </p>
            </div>
          )}

          {lines && (
            <ol className="mt-10 max-w-[640px]" aria-live="polite">
              {lines.map((l, i) => (
                <li key={i} className={`grid grid-cols-[2.5rem_1fr_auto] items-baseline gap-x-3 py-4 ${i ? "border-t border-rule" : ""}`}>
                  <span className={`display text-[22px] italic leading-none ${l.state === "done" ? "text-accent" : l.state === "doing" ? "text-life active-tick" : "text-text-2/50"}`}>{ROMAN[i + 1]}</span>
                  <div className="min-w-0">
                    <div className={`text-[16px] ${l.state === "todo" ? "text-text-2" : "text-text"}`}>{l.title}</div>
                    {l.detail && <div className="mono mt-1 !text-[13px] text-text-2">{l.detail}</div>}
                  </div>
                  <span className="text-right text-[13px] text-text-2">
                    {l.state === "doing" ? "now" : l.state === "done" ? (l.hash ? <ExtLink href={links.nearTx(l.hash)}>tx</ExtLink> : "done") : ""}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {err && <div className="mt-6 max-w-[640px]"><ErrorNote>{err}</ErrorNote></div>}
        </div>

        <aside className="min-w-0 lg:col-span-5 lg:pt-16">
          <div className="sc">What you will do</div>
          <ol className="mt-4">
            {ACTS.map((a, i) => (
              <li key={a.name} className={`grid grid-cols-[2.5rem_1fr] gap-x-3 py-5 ${i ? "border-t border-rule" : "border-t border-rule"}`}>
                <span className="display text-[26px] italic leading-none text-accent">{ROMAN[i + 1]}</span>
                <div>
                  <div className="display text-[26px] leading-none">{a.name}</div>
                  <p className="mt-2 text-[15px] leading-relaxed text-text-2">{a.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-4 border-t border-rule pt-4 text-[13px] leading-relaxed text-text-2">
            The vault is a real one on the public contract, with a {GUEST_INTERVAL_S}-second heartbeat so the whole life fits in minutes. The foreign payouts are signed but not relayed: their source addresses hold no funds.
          </p>
        </aside>
      </div>
    </div>
  );
}
