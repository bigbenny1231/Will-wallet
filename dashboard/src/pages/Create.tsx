import { CHAINS, CHAIN_ORDER, chainMeta } from "../lib/chainmeta";
import type { ForeignChain } from "../types";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/near";
import { useWallet } from "../lib/wallet";
import { missingHeirsNote, useContractRecipients, useMissingAccounts } from "../lib/accounts";
import { contractRecipientsNote } from "../lib/chains";
import { MAX_BOUNTY_YOCTO, createVaultCall, type CreateDraft, type ForeignDraft } from "../lib/calls";
import { PENDING_KEY, type Pending } from "../components/PendingCreate";
import { bpsToPct, fmtInterval, nearToYocto, toSmallest, unitsFor } from "../lib/format";
import { CONTRACT, MOCK } from "../config";
import { ErrorNote, Field, Label, ROMAN } from "../components/ui";

const STEPS = ["Timing", "Heirs", "Agent policy", "Foreign payouts", "DAO", "Deposit"] as const;
const INTRO = [
  "How often you check in, and how much silence is allowed before the vault settles.",
  "Who receives what. Shares must add up to 100%.",
  "What an AI agent may spend from this vault while you are alive. In Warning it is disarmed.",
  "Payouts on Base Sepolia, Monad testnet and Solana devnet, signed by NEAR Chain Signatures at settlement.",
  "An optional Sputnik DAO that receives a proposal at step four of settlement.",
  "Fund the vault and read it through once before you sign.",
];
const UNITS = { seconds: 1, minutes: 60, hours: 3600, days: 86400 } as const;
type Unit = keyof typeof UNITS;

interface HeirRow { account_id: string; pct: string }
interface ForeignRow { chain: ForeignChain; to: string; amount: string }

export default function Create() {
  const { accountId, connect, call } = useWallet();
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // timing
  const [intervalN, setIntervalN] = useState(MOCK ? "20" : "30");
  const [unit, setUnit] = useState<Unit>(MOCK ? "seconds" : "days");
  const [grace, setGrace] = useState("2");
  // heirs
  const [heirs, setHeirs] = useState<HeirRow[]>([{ account_id: "", pct: "100" }]);
  // policy
  const [perTx, setPerTx] = useState("5");
  const [daily, setDaily] = useState("5");
  const [allow, setAllow] = useState("");
  // foreign
  const [foreign, setForeign] = useState<ForeignRow[]>([]);
  // EVM recipients that are contracts: a warning, not a block (contract v2 second review G1, lib/chains.ts).
  const contractNote = contractRecipientsNote(useContractRecipients(foreign));
  // dao + deposit
  const [dao, setDao] = useState("");
  const [bounty, setBounty] = useState("0.05");
  const [deposit, setDeposit] = useState("5");

  // Heirs whose account does not exist yet: a warning, not a block (see lib/accounts.ts).
  const missingHeirs = useMissingAccounts(heirs.map((h) => h.account_id));
  const missingNote = missingHeirsNote(missingHeirs);

  const intervalS = Math.round(Number(intervalN) * UNITS[unit]);
  const graceN = Number(grace);
  const bpsRows = heirs.map((h) => Math.round(Number(h.pct) * 100));
  const bpsSum = bpsRows.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

  const problems: string[][] = useMemo(() => {
    const p: string[][] = STEPS.map(() => []);
    if (!Number.isInteger(intervalS) || intervalS < 1) p[0].push("Interval must be at least 1 second.");
    if (!Number.isInteger(graceN) || graceN < 0) p[0].push("Missed beats allowed must be 0 or more.");
    if (bpsSum !== 10000) p[1].push(`Shares add up to ${bpsToPct(bpsSum)}, they must add up to 100%.`);
    heirs.forEach((h, i) => {
      if (!/^[a-z0-9._-]{2,64}$/.test(h.account_id.trim())) p[1].push(`Heir ${i + 1}: enter a NEAR account id.`);
      if (!(bpsRows[i] > 0)) p[1].push(`Heir ${i + 1}: share must be above 0.`);
    });
    try { nearToYocto(perTx); nearToYocto(daily); } catch { p[2].push("Caps must be NEAR amounts."); }
    foreign.forEach((f, i) => {
      if (chainMeta(f.chain).evm && !/^0x[0-9a-fA-F]{40}$/.test(f.to.trim())) p[3].push(`Payout ${i + 1}: ${chainMeta(f.chain).short} address must be 0x plus 40 hex characters.`);
      if (f.chain === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(f.to.trim())) p[3].push(`Payout ${i + 1}: enter a Solana base58 address.`);
      try { if (BigInt(toSmallest(f.chain, f.amount)) <= 0n) throw new Error(); } catch { p[3].push(`Payout ${i + 1}: enter an amount.`); }
    });
    if (dao.trim() && !/^[a-z0-9._-]+\.[a-z0-9._-]+$/.test(dao.trim())) p[4].push("DAO id should look like estate.sputnik-v2.testnet.");
    try {
      if (BigInt(nearToYocto(deposit)) < BigInt(nearToYocto("0.1"))) p[5].push("Deposit must be at least 0.1 NEAR (storage).");
      if (BigInt(nearToYocto(bounty)) > MAX_BOUNTY_YOCTO) p[5].push("The keeper bounty is capped at 1 NEAR.");
    } catch { p[5].push("Deposit and bounty must be NEAR amounts."); }
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalS, graceN, bpsSum, heirs, perTx, daily, foreign, dao, deposit, bounty]);

  const stepOk = (i: number) => problems[i].length === 0;
  const allOk = problems.every((p) => p.length === 0);

  const submit = async () => {
    if (!accountId) return connect();
    setErr(null);
    setBusy(true);
    try {
      const fd: ForeignDraft[] = foreign.map((f) => ({
        chain: f.chain,
        to: f.to.trim(),
        amount: toSmallest(f.chain, f.amount),
        // The source address only exists once the vault does (v2 salts the derivation path at create_vault).
        // PendingCreate fills it in from the new vault's view before set_foreign_payouts; the contract itself always
        // signs for the derived address and overwrites from_address at signing.
        from_address: "",
      }));
      const draft: CreateDraft = {
        heartbeat_interval_s: intervalS,
        grace_missed: graceN,
        heirs: heirs.map((h, i) => ({ account_id: h.account_id.trim(), bps: bpsRows[i] })),
        policy: {
          per_tx_max: nearToYocto(perTx),
          daily_max: nearToYocto(daily),
          allowlist: allow.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
        },
        bounty: nearToYocto(bounty),
        depositYocto: nearToYocto(deposit),
        foreign: fd,
        dao_id: dao.trim() || null,
      };
      const known = (await api.getVaultsForOwner(accountId)).map((v) => v.token_id);
      const pending: Pending = { owner: accountId, knownIds: known, foreign: fd, dao_id: draft.dao_id, startedMs: Date.now() };
      // Saved first: redirect wallets leave the page, PendingCreate finishes the job when we come back.
      localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
      window.dispatchEvent(new Event("dmw-pending"));
      try {
        await call(createVaultCall(draft));
      } catch (e) {
        localStorage.removeItem(PENDING_KEY);
        window.dispatchEvent(new Event("dmw-pending"));
        throw e;
      }
      nav("/");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const summary = [
    Number.isFinite(intervalS) && intervalS > 0 ? `Every ${fmtInterval(intervalS)}, ${graceN} missed allowed` : "Not set",
    heirs.some((h) => h.account_id.trim()) ? heirs.map((h, i) => `${h.account_id || "?"} ${bpsToPct(bpsRows[i] || 0)}`).join(", ") : "No heirs named yet",
    `${perTx} NEAR a payment, ${daily} NEAR a day`,
    foreign.length ? `${foreign.length} payout${foreign.length === 1 ? "" : "s"}` : "None",
    dao.trim() || "None",
    `${deposit} NEAR, bounty ${bounty}`,
  ];

  return (
    <div className="wrap pb-24">
      <div className="pb-14 pt-14">
        <Label>New vault on {CONTRACT}</Label>
        <h1 className="display mt-4 text-[48px] md:text-[72px]">A vault, in six parts.</h1>
      </div>

      <div className="grid gap-12 border-t border-rule pt-10 lg:grid-cols-12 lg:gap-10">
        <nav className="lg:col-span-4" aria-label="Sections">
          <ol className="lg:sticky lg:top-8">
            {STEPS.map((s, i) => {
              const bad = !stepOk(i);
              return (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => setStep(i)}
                    aria-current={i === step ? "step" : undefined}
                    className={`group grid w-full grid-cols-[2.75rem_1fr] gap-x-2 border-b border-rule py-4 text-left transition-colors duration-700 ${i === step ? "text-text" : "text-text-2 hover:text-text"}`}
                  >
                    <span className={`display text-[22px] italic leading-tight ${i === step ? "text-brass" : bad ? "text-warn" : "text-brass-2"}`}>{ROMAN[i + 1]}.</span>
                    <span>
                      <span className="display block text-[24px] leading-tight">{s}</span>
                      <span className={`mt-1 block truncate text-[13px] ${bad && i !== step ? "text-warn" : "text-text-2"}`}>{bad && i < step ? "Needs attention" : summary[i]}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="min-w-0 space-y-8 lg:col-span-8">
          <header>
            <div className="display text-[44px] leading-none md:text-[56px]">
              <span className="italic text-brass">{ROMAN[step + 1]}.</span> {STEPS[step]}
            </div>
            <p className="mt-4 max-w-[56ch] text-[17px] leading-relaxed text-text-2">{INTRO[step]}</p>
          </header>
        {step === 0 && (
          <>
            <div className="grid gap-10 sm:grid-cols-2">
              <Field label="Heartbeat interval">
                <div className="flex gap-6">
                  <input className="field num" inputMode="numeric" value={intervalN} onChange={(e) => setIntervalN(e.target.value)} />
                  <select className="field !w-36" value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
                    {Object.keys(UNITS).map((u) => <option key={u}>{u}</option>)}
                  </select>
                </div>
              </Field>
              <Field label="Missed beats allowed (grace)" hint={`Triggers after ${graceN + 1} intervals without a heartbeat.`}>
                <input className="field num" inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value)} />
              </Field>
            </div>
            <p className="display max-w-[30ch] text-[28px] leading-snug">
              Warning after {Number.isFinite(intervalS) ? fmtInterval(intervalS) : "?"}, settlement after {Number.isFinite(intervalS) ? fmtInterval(intervalS * (graceN + 1)) : "?"} of silence.
            </p>
          </>
        )}

        {step === 1 && (
          <>
            <div>
              {heirs.map((h, i) => (
                <div key={i} className="grid grid-cols-[2rem_1fr_7rem_auto] items-end gap-6 py-2">
                  <span className="display pb-2 text-[20px] italic text-brass-2">{i + 1}.</span>
                  <input className="field mono" aria-label={`Heir ${i + 1} account`} placeholder="sarah.testnet" value={h.account_id} onChange={(e) => setHeirs(heirs.map((x, j) => (j === i ? { ...x, account_id: e.target.value } : x)))} />
                  <div className="relative">
                    <input className="field num pr-6 text-right" aria-label={`Heir ${i + 1} share`} inputMode="decimal" value={h.pct} onChange={(e) => setHeirs(heirs.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} />
                    <span className="absolute bottom-2.5 right-0 text-text-2">%</span>
                  </div>
                  <button className="tl !text-[14px]" disabled={heirs.length === 1} onClick={() => setHeirs(heirs.filter((_, j) => j !== i))} aria-label="Remove heir">Remove</button>
                </div>
              ))}
            </div>
            <div className="flex items-baseline justify-between border-t border-rule pt-4">
              <button className="tl" onClick={() => setHeirs([...heirs, { account_id: "", pct: "0" }])}>Add heir</button>
              <span className={`num text-[17px] ${bpsSum === 10000 ? "text-text" : "text-warn"}`}>Total {bpsToPct(bpsSum)}</span>
            </div>
            <p className="text-[15px] text-text-2">The heir with the largest share also receives the Will NFT.</p>
            {missingNote && <p className="border-l border-warn pl-4 text-[15px] text-warn">{missingNote}</p>}
          </>
        )}

        {step === 2 && (
          <>
            <div className="grid gap-10 sm:grid-cols-2">
              <Field label="Per payment, at most (NEAR)"><input className="field num" value={perTx} onChange={(e) => setPerTx(e.target.value)} /></Field>
              <Field label="Per day, at most (NEAR)"><input className="field num" value={daily} onChange={(e) => setDaily(e.target.value)} /></Field>
            </div>
            <Field label="Allowlist" hint="Receiver accounts, separated by commas or spaces. Empty allows any receiver.">
              <textarea className="field mono min-h-20 resize-y" value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="api.provider.testnet" />
            </Field>
          </>
        )}

        {step === 3 && (
          <>
            {foreign.length === 0 && <p className="text-[15px] text-text-2">No foreign payouts. Add one to send Base Sepolia ETH, Monad testnet MON or Solana devnet SOL at settlement.</p>}
            {foreign.map((f, i) => {
              const m = chainMeta(f.chain);
              return (
                <div key={i} className="space-y-4 border-t border-rule pt-5">
                  <div className="grid gap-6 sm:grid-cols-[10rem_1fr_9rem]">
                    <select className="field" aria-label={`Payout ${i + 1} chain`} value={f.chain} onChange={(e) => setForeign(foreign.map((x, j) => (j === i ? { ...x, chain: e.target.value as ForeignChain, to: "" } : x)))}>
                      {CHAIN_ORDER.map((c) => <option key={c} value={c}>{CHAINS[c].name}</option>)}
                    </select>
                    <input className="field mono" placeholder={m.evm ? "0x…" : "base58 address"} value={f.to} onChange={(e) => setForeign(foreign.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
                    <div className="relative">
                      <input className="field num pr-12" inputMode="decimal" placeholder="0.01" value={f.amount} onChange={(e) => setForeign(foreign.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                      <span className="absolute bottom-2.5 right-0 text-[14px] text-text-2">{m.unit}</span>
                    </div>
                  </div>
                  <div className="text-[14px] text-text-2">
                    Funded from the {m.name} address derived for{" "}
                    <span className="mono !text-[13px] text-text">{m.pathShape}</span>. The salt is drawn when the vault is created, so the address appears only then. Do not send anything before then.
                  </div>
                  <button className="tl !text-[14px]" onClick={() => setForeign(foreign.filter((_, j) => j !== i))}>Remove</button>
                </div>
              );
            })}
            <button className="tl" onClick={() => setForeign([...foreign, { chain: "base", to: "", amount: "" }])}>Add foreign payout</button>
            {contractNote && <p className="border-l border-warn pl-4 text-[15px] text-warn">{contractNote}</p>}
            <p className="max-w-[62ch] text-[14px] text-text-2">
              The source address depends on the vault id and a random salt the contract draws when it creates the vault, so nobody can know it, fund it or sign for it before the vault exists. It is shown on the vault page after creation. Fund it then, while you are alive; nobody holds its key.
            </p>
          </>
        )}

        {step === 4 && (
          <Field label="Sputnik DAO account (optional)" hint="At step 4 of settlement a proposal is added here. Create one with `npm run dao -- create` in keeper/.">
            <input className="field mono" placeholder="estate-1.sputnik-v2.testnet" value={dao} onChange={(e) => setDao(e.target.value)} />
          </Field>
        )}

        {step === 5 && (
          <>
            <div className="grid gap-10 sm:grid-cols-2">
              <Field label="Initial deposit (NEAR)" hint="0.1 NEAR is kept for storage; the rest is the vault balance. Each pulse or agent key later reserves 1 NEAR of it as gas allowance (not refunded when the key is removed).">
                <input className="field num" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
              </Field>
              <Field label="Keeper bounty (NEAR)" hint="Paid to whoever pokes the vault: at most 1 NEAR, and never more than 10% of the balance.">
                <input className="field num" value={bounty} onChange={(e) => setBounty(e.target.value)} />
              </Field>
            </div>
            <Review
              rows={[
                ["Contract", CONTRACT],
                ["Heartbeat", `${fmtInterval(intervalS || 0)}, ${graceN} missed allowed`],
                ["Heirs", heirs.map((h, i) => `${h.account_id || "?"} ${bpsToPct(bpsRows[i] || 0)}`).join(", ") + (missingHeirs.length ? ` (not found: ${missingHeirs.join(", ")})` : "")],
                ["Agent caps", `${perTx} NEAR per tx, ${daily} NEAR per day`],
                ["Foreign", foreign.length ? foreign.map((f) => `${unitsFor(f.chain, safeSmallest(f))} on ${chainMeta(f.chain).short}`).join(", ") : "none"],
                ["DAO", dao.trim() || "none"],
              ]}
            />
          </>
        )}

        {problems[step].length > 0 && (
          <ul className="space-y-1 border-l border-warn pl-4 text-[15px] text-warn">{problems[step].map((m) => <li key={m}>{m}</li>)}</ul>
        )}
        {err && <ErrorNote>{err}</ErrorNote>}

        <div className="flex items-center justify-between border-t border-rule pt-8">
          <button className="tl" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
          {step < STEPS.length - 1 ? (
            <button className="pill" onClick={() => setStep(step + 1)}>Next: {STEPS[step + 1]}</button>
          ) : accountId ? (
            <button className="pill" disabled={!allOk || busy} onClick={submit}>{busy ? "Waiting for wallet…" : "Create vault"}</button>
          ) : (
            <button className="pill" onClick={connect}>Connect wallet</button>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}

function safeSmallest(f: ForeignRow): string {
  try { return toSmallest(f.chain, f.amount); } catch { return "0"; }
}

function Review({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="border-t border-rule">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[9rem_1fr] gap-6 border-b border-rule py-3">
          <dt className="sc pt-1">{k}</dt>
          <dd className="break-all text-[15px]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
