import { useEffect, useState } from "react";
import { KeyPair } from "near-api-js";
import { useWallet } from "../lib/wallet";
import { CONTRACT } from "../config";
import { shortKey } from "../lib/format";
import { addAgentKeyCall, addPulseKeyCall, removeKeyCall, KEY_ALLOWANCE_YOCTO } from "../lib/calls";
import { yoctoToNear } from "../lib/format";
import type { VaultView } from "../types";
import { CopyBox, ErrorNote } from "./ui";
import PhonePairing from "./PhonePairing";

type Kind = "pulse" | "agent" | "phone";
interface Fresh {
  token: string;
  kind: Kind;
  pub: string;
  priv: string;
}

const STORE = "dmw-newkey";

function load(token: string): Fresh | null {
  try {
    const f = JSON.parse(sessionStorage.getItem(STORE) || "null") as Fresh | null;
    return f && f.token === token ? f : null;
  } catch {
    return null;
  }
}

/**
 * The key goes in through the environment, not `--key`: a process's argv is world-readable (`ps`), its environment is
 * not, and the pulse daemon runs for hours (AUDIT_FINAL_OFFCHAIN F-10). The leading space keeps it out of shell
 * history where HISTCONTROL=ignorespace (bash default on most distros).
 */
export function cliCommand(f: Fresh): string {
  return f.kind === "pulse"
    ? ` DMW_PULSE_KEY=${f.priv} npm run pulse -- --token ${f.token}`
    : ` DMW_AGENT_KEY=${f.priv} npm run agent-demo -- --token ${f.token}`;
}

export default function KeysPanel({ v, isOwner }: { v: VaultView; isOwner: boolean }) {
  const { call } = useWallet();
  const [fresh, setFresh] = useState<Fresh | null>(() => load(v.token_id));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setFresh(load(v.token_id)), [v.token_id]);

  const locked = v.state === "Triggered" || v.state === "Settled";
  const lowBalance = BigInt(v.balance) < KEY_ALLOWANCE_YOCTO;
  const registered = fresh ? (fresh.kind === "agent" ? v.agent_keys : v.pulse_keys).includes(fresh.pub) : false;

  const add = async (kind: Kind) => {
    setErr(null);
    setBusy(true);
    const kp = KeyPair.fromRandom("ed25519");
    const f: Fresh = { token: v.token_id, kind, pub: kp.getPublicKey().toString(), priv: kp.toString() };
    // Persist before the wallet call: redirect wallets leave the page and we must not lose the private key.
    sessionStorage.setItem(STORE, JSON.stringify(f));
    setFresh(f);
    try {
      await call(kind === "agent" ? addAgentKeyCall(v.token_id, f.pub) : addPulseKeyCall(v.token_id, f.pub));
    } catch (e) {
      sessionStorage.removeItem(STORE);
      setFresh(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    sessionStorage.removeItem(STORE);
    setFresh(null);
  };

  const remove = async (public_key: string) => {
    setErr(null);
    try {
      await call(removeKeyCall(v.token_id, public_key));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const lowWhy = lowBalance ? "The vault balance must cover the 1 NEAR key gas allowance" : undefined;
  return (
    <div className="space-y-10">
      <KeyList n="I" title="Pulse keys" what="May only call heartbeat." keys={v.pulse_keys} canRemove={isOwner && !locked} onRemove={remove} />
      <KeyList n="II" title="Agent keys" what="May only call agent_pay, within the policy above." keys={v.agent_keys} canRemove={isOwner && !locked} onRemove={remove} />

      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <button className={isOwner && !locked && !lowBalance && v.pulse_keys.length === 0 ? "pill" : "tl"} disabled={!isOwner || locked || busy || lowBalance} title={lowWhy} onClick={() => add("phone")}>
          Pair a phone
        </button>
        <button className="tl" disabled={!isOwner || locked || busy || lowBalance} title={lowWhy} onClick={() => add("pulse")}>
          Add pulse key
        </button>
        <button className="tl" disabled={!isOwner || locked || busy || lowBalance} title={lowWhy} onClick={() => add("agent")}>
          Add agent key
        </button>
        {!isOwner && <span className="text-[14px] text-text-2">Connect as the vault owner to add keys.</span>}
        {isOwner && !locked && lowBalance && (
          <span className="text-[14px] text-text-2">Each key reserves 1 NEAR of gas allowance from the vault balance ({yoctoToNear(v.balance)} NEAR now). The allowance is the cost of the key: it is not refunded when the key is removed. Deposit more first.</span>
        )}
        {isOwner && locked && <span className="text-[14px] text-text-2">Keys are locked once the vault is triggered.</span>}
      </div>

      {err && <ErrorNote>{err}</ErrorNote>}

      {fresh && !registered && (
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-l border-rule pl-4 text-[15px] text-text-2">
          {fresh.kind === "phone"
            ? "Waiting for the pulse key transaction to land. The pairing code will appear here once it has."
            : `Waiting for the ${fresh.kind} key transaction to land. The private key will appear here once it has.`}
          <button className="tl" onClick={dismiss}>Discard</button>
        </div>
      )}

      {fresh && registered && fresh.kind === "phone" && <PhonePairing contract={CONTRACT} token={v.token_id} secret={fresh.priv} publicKey={fresh.pub} onDone={dismiss} />}

      {fresh && registered && fresh.kind !== "phone" && (
        <div className="space-y-6 border-l-2 border-warn pl-6">
          <div>
            <div className="display text-[32px]">Private key, shown once.</div>
            <p className="mt-2 max-w-[60ch] text-[15px] text-text-2">
              This key is only in this browser tab. It is removed when you press the button below, and it is never stored on the contract.
            </p>
          </div>
          <CopyBox label="Private key" value={fresh.priv} />
          <CopyBox label={`Run in keeper/ (${fresh.kind === "pulse" ? "heartbeat daemon" : "agent demo"})`} value={cliCommand(fresh)} />
          <button className="pill" onClick={dismiss}>I saved it, hide the key</button>
        </div>
      )}
    </div>
  );
}

function KeyList({ n, title, what, keys, canRemove, onRemove }: { n: string; title: string; what: string; keys: string[]; canRemove: boolean; onRemove: (k: string) => void }) {
  return (
    <div className="grid grid-cols-[3rem_1fr] gap-x-4">
      <span className="display text-[26px] italic leading-none text-brass">{n}</span>
      <div className="min-w-0">
        <div className="text-[17px]">
          {title}<span className="ml-3 text-[15px] text-text-2">{what}</span>
        </div>
        {keys.length === 0 ? (
          <p className="mt-2 text-[15px] text-text-2">None registered.</p>
        ) : (
          <ol className="mt-3">
            {keys.map((k, i) => (
              <li key={k} className="flex items-baseline justify-between gap-4 border-t border-rule py-2.5">
                <span className="mono !text-[13px]" title={k}>
                  <span className="num mr-4 text-text-2">{String(i + 1).padStart(2, "0")}</span>
                  {shortKey(k, 14)}
                </span>
                {canRemove && <button className="tl !text-[14px]" onClick={() => onRemove(k)}>Remove</button>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
