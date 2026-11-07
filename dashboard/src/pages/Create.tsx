import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/near";
import { useWallet } from "../lib/wallet";
import { deriveFor, type DerivedAddresses } from "../lib/derive";
import { createVaultCall, type CreateDraft, type ForeignDraft } from "../lib/calls";
import { PENDING_KEY, type Pending } from "../components/PendingCreate";
import { bpsToPct, fmtInterval, nearToYocto, toSmallest, unitsFor } from "../lib/format";
import { CONTRACT, MOCK, links } from "../config";
import { ErrorNote, ExtLink, Field } from "../components/ui";

const STEPS = ["Timing", "Heirs", "Policy", "Foreign payouts", "DAO", "Deposit"] as const;
const UNITS = { seconds: 1, minutes: 60, hours: 3600, days: 86400 } as const;
type Unit = keyof typeof UNITS;

interface HeirRow { account_id: string; pct: string }
interface ForeignRow { chain: "base" | "solana"; to: string; amount: string }

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
  const [expectedId, setExpectedId] = useState<string | null>(null);
  const [derived, setDerived] = useState<DerivedAddresses | null>(null);
  const [deriveErr, setDeriveErr] = useState<string | null>(null);
  // dao + deposit
  const [dao, setDao] = useState("");
  const [bounty, setBounty] = useState("0.05");
  const [deposit, setDeposit] = useState("5");

  useEffect(() => {
    api.nextTokenId().then(setExpectedId).catch(() => setExpectedId(null));
  }, []);
  useEffect(() => {
    if (!expectedId) return;
    try {
      setDerived(deriveFor(expectedId));
      setDeriveErr(null);
    } catch (e) {
      setDerived(null);
      setDeriveErr(e instanceof Error ? e.message : String(e));
    }
  }, [expectedId]);

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
      if (f.chain === "base" && !/^0x[0-9a-fA-F]{40}$/.test(f.to.trim())) p[3].push(`Payout ${i + 1}: Base address must be 0x plus 40 hex characters.`);
      if (f.chain === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(f.to.trim())) p[3].push(`Payout ${i + 1}: enter a Solana base58 address.`);
      try { if (BigInt(toSmallest(f.chain, f.amount)) <= 0n) throw new Error(); } catch { p[3].push(`Payout ${i + 1}: enter an amount.`); }
    });
    if (dao.trim() && !/^[a-z0-9._-]+\.[a-z0-9._-]+$/.test(dao.trim())) p[4].push("DAO id should look like estate.sputnik-v2.testnet.");
    try {
      if (BigInt(nearToYocto(deposit)) < BigInt(nearToYocto("0.1"))) p[5].push("Deposit must be at least 0.1 NEAR (storage).");
      nearToYocto(bounty);
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
        from_address: (f.chain === "base" ? derived?.base : derived?.solana) ?? "",
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

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <h1 className="text-4xl font-semibold">Create vault</h1>

      <ol className="flex flex-wrap gap-2">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => setStep(i)}
              className={`rounded-full border px-4 py-1.5 text-base ${i === step ? "border-accent bg-accent/15 text-ink" : stepOk(i) ? "border-line text-mute hover:text-ink" : "border-dead/50 text-dead"}`}
            >
              {i + 1}. {s}
            </button>
          </li>
        ))}
      </ol>

      <div className="panel space-y-6">
        {step === 0 && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Heartbeat interval">
                <div className="flex gap-3">
                  <input className="input" inputMode="numeric" value={intervalN} onChange={(e) => setIntervalN(e.target.value)} />
                  <select className="input !w-40" value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
                    {Object.keys(UNITS).map((u) => <option key={u}>{u}</option>)}
                  </select>
                </div>
              </Field>
              <Field label="Missed beats allowed (grace)" hint={`Triggers after ${graceN + 1} intervals without a heartbeat.`}>
                <input className="input" inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value)} />
              </Field>
            </div>
            <p className="text-mute">
              Warning after {Number.isFinite(intervalS) ? fmtInterval(intervalS) : "?"}, triggered after {Number.isFinite(intervalS) ? fmtInterval(intervalS * (graceN + 1)) : "?"} of silence.
            </p>
          </>
        )}

        {step === 1 && (
          <>
            <div className="space-y-3">
              {heirs.map((h, i) => (
                <div key={i} className="flex gap-3">
                  <input className="input" placeholder="sarah.testnet" value={h.account_id} onChange={(e) => setHeirs(heirs.map((x, j) => (j === i ? { ...x, account_id: e.target.value } : x)))} />
                  <div className="relative w-36 shrink-0">
                    <input className="input pr-9" inputMode="decimal" value={h.pct} onChange={(e) => setHeirs(heirs.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-mute">%</span>
                  </div>
                  <button className="btn !px-4" disabled={heirs.length === 1} onClick={() => setHeirs(heirs.filter((_, j) => j !== i))} aria-label="Remove heir">✕</button>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between">
              <button className="btn" onClick={() => setHeirs([...heirs, { account_id: "", pct: "0" }])}>Add heir</button>
              <span className={`text-lg font-semibold ${bpsSum === 10000 ? "text-alive" : "text-warn"}`}>Total {bpsToPct(bpsSum)}</span>
            </div>
            <p className="text-mute">The heir with the largest share also receives the Will NFT.</p>
          </>
        )}

        {step === 2 && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Per transaction max (NEAR)"><input className="input" value={perTx} onChange={(e) => setPerTx(e.target.value)} /></Field>
              <Field label="Daily max (NEAR)"><input className="input" value={daily} onChange={(e) => setDaily(e.target.value)} /></Field>
            </div>
            <Field label="Allowlist" hint="Receiver accounts, separated by commas or spaces. Empty allows any receiver.">
              <textarea className="input min-h-24 font-mono" value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="api.provider.testnet" />
            </Field>
          </>
        )}

        {step === 3 && (
          <>
            {foreign.length === 0 && <p className="text-mute">No foreign payouts. Add one to send Base Sepolia ETH or Solana devnet SOL at settlement.</p>}
            {foreign.map((f, i) => {
              const src = f.chain === "base" ? derived?.base : derived?.solana;
              return (
                <div key={i} className="space-y-3 rounded-xl border border-line p-4">
                  <div className="grid gap-3 sm:grid-cols-[10rem_1fr_11rem]">
                    <select className="input" value={f.chain} onChange={(e) => setForeign(foreign.map((x, j) => (j === i ? { ...x, chain: e.target.value as "base" | "solana", to: "" } : x)))}>
                      <option value="base">Base Sepolia</option>
                      <option value="solana">Solana devnet</option>
                    </select>
                    <input className="input font-mono" placeholder={f.chain === "base" ? "0x…" : "base58 address"} value={f.to} onChange={(e) => setForeign(foreign.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
                    <div className="relative">
                      <input className="input pr-14" inputMode="decimal" placeholder="0.01" value={f.amount} onChange={(e) => setForeign(foreign.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                      <span className="absolute right-4 top-1/2 -translate-y-1/2 text-mute">{f.chain === "base" ? "ETH" : "SOL"}</span>
                    </div>
                  </div>
                  <div className="text-sm text-mute">
                    Funded from derived address{expectedId ? ` for vault #${expectedId}` : ""}:{" "}
                    {src ? <span className="mono text-ink">{src}</span> : <span>{deriveErr ? "derivation failed, run `npm run derive`" : "computing…"}</span>}
                    {src && (
                      <span className="ml-3">
                        <ExtLink href={f.chain === "base" ? links.baseFaucet : links.solFaucet}>faucet</ExtLink>
                      </span>
                    )}
                  </div>
                  <button className="btn !py-1.5 text-sm" onClick={() => setForeign(foreign.filter((_, j) => j !== i))}>Remove</button>
                </div>
              );
            })}
            <button className="btn" onClick={() => setForeign([...foreign, { chain: "base", to: "", amount: "" }])}>Add foreign payout</button>
            <p className="text-sm text-mute">
              The source address depends on the vault id. It is shown for the next expected id and recomputed with the real id after creation. Fund it while you are alive; nobody holds its key.
            </p>
          </>
        )}

        {step === 4 && (
          <Field label="Sputnik DAO account (optional)" hint="At step 4 of settlement a proposal is added here. Create one with `npm run dao -- create` in keeper/.">
            <input className="input font-mono" placeholder="estate-1.sputnik-v2.testnet" value={dao} onChange={(e) => setDao(e.target.value)} />
          </Field>
        )}

        {step === 5 && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Initial deposit (NEAR)" hint="0.1 NEAR is kept for storage; the rest is the vault balance. Each pulse or agent key later reserves 1 NEAR of it as gas allowance.">
                <input className="input" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
              </Field>
              <Field label="Keeper bounty (NEAR)" hint="Paid to whoever pokes the vault.">
                <input className="input" value={bounty} onChange={(e) => setBounty(e.target.value)} />
              </Field>
            </div>
            <Review
              rows={[
                ["Contract", CONTRACT],
                ["Heartbeat", `${fmtInterval(intervalS || 0)}, ${graceN} missed allowed`],
                ["Heirs", heirs.map((h, i) => `${h.account_id || "?"} ${bpsToPct(bpsRows[i] || 0)}`).join(", ")],
                ["Agent caps", `${perTx} NEAR per tx, ${daily} NEAR per day`],
                ["Foreign", foreign.length ? foreign.map((f) => `${unitsFor(f.chain, safeSmallest(f))} ${f.chain}`).join(", ") : "none"],
                ["DAO", dao.trim() || "none"],
              ]}
            />
          </>
        )}

        {problems[step].length > 0 && (
          <ul className="space-y-1 text-warn">{problems[step].map((m) => <li key={m}>{m}</li>)}</ul>
        )}
        {err && <ErrorNote>{err}</ErrorNote>}

        <div className="flex justify-between pt-2">
          <button className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
          {step < STEPS.length - 1 ? (
            <button className="btn btn-primary" onClick={() => setStep(step + 1)}>Next</button>
          ) : accountId ? (
            <button className="btn btn-primary" disabled={!allOk || busy} onClick={submit}>{busy ? "Waiting for wallet…" : "Create vault"}</button>
          ) : (
            <button className="btn btn-primary" onClick={connect}>Connect wallet</button>
          )}
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
    <dl className="divide-y divide-line rounded-xl border border-line">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-4 px-4 py-3">
          <dt className="w-32 shrink-0 text-mute">{k}</dt>
          <dd className="break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
