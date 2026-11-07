import { useEffect, useState } from "react";
import { KeyPair } from "near-api-js";
import { useWallet } from "../lib/wallet";
import { shortKey } from "../lib/format";
import type { VaultView } from "../types";
import { CopyBox, ErrorNote } from "./ui";

type Kind = "pulse" | "agent";
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

export function cliCommand(f: Fresh): string {
  return f.kind === "pulse"
    ? `npm run pulse -- --token ${f.token} --key ${f.priv}`
    : `npm run agent-demo -- --token ${f.token} --key ${f.priv}`;
}

export default function KeysPanel({ v, isOwner }: { v: VaultView; isOwner: boolean }) {
  const { call } = useWallet();
  const [fresh, setFresh] = useState<Fresh | null>(() => load(v.token_id));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setFresh(load(v.token_id)), [v.token_id]);

  const locked = v.state === "Triggered" || v.state === "Settled";
  const registered = fresh ? (fresh.kind === "pulse" ? v.pulse_keys : v.agent_keys).includes(fresh.pub) : false;

  const add = async (kind: Kind) => {
    setErr(null);
    setBusy(true);
    const kp = KeyPair.fromRandom("ed25519");
    const f: Fresh = { token: v.token_id, kind, pub: kp.getPublicKey().toString(), priv: kp.toString() };
    // Persist before the wallet call: redirect wallets leave the page and we must not lose the private key.
    sessionStorage.setItem(STORE, JSON.stringify(f));
    setFresh(f);
    try {
      await call({
        method: kind === "pulse" ? "add_pulse_key" : "add_agent_key",
        args: { token_id: v.token_id, public_key: f.pub },
        gas: "60000000000000",
      });
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
      await call({ method: "remove_key", args: { token_id: v.token_id, public_key }, gas: "60000000000000" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3">
        <button className="btn btn-primary" disabled={!isOwner || locked || busy} onClick={() => add("pulse")}>
          Add pulse key
        </button>
        <button className="btn" disabled={!isOwner || locked || busy} onClick={() => add("agent")}>
          Add agent key
        </button>
        {!isOwner && <span className="self-center text-mute">Connect as the vault owner to add keys.</span>}
        {isOwner && locked && <span className="self-center text-mute">Keys are locked once the vault is triggered.</span>}
      </div>

      {err && <ErrorNote>{err}</ErrorNote>}

      {fresh && !registered && (
        <div className="rounded-xl border border-line bg-bg p-4 text-mute">
          Waiting for the {fresh.kind} key transaction to land. The private key will appear here once it has.
          <button className="btn ml-4 !py-1.5" onClick={dismiss}>Discard</button>
        </div>
      )}

      {fresh && registered && (
        <div className="space-y-4 rounded-xl border border-warn/50 bg-warn/5 p-5">
          <div className="text-lg font-semibold text-warn">Private key, shown once</div>
          <p className="text-mute">
            This key is only in this browser tab. It is removed when you press the button below, and it is never stored on the contract.
          </p>
          <CopyBox label="Private key" value={fresh.priv} />
          <CopyBox label={`Run in keeper/ (${fresh.kind === "pulse" ? "heartbeat daemon" : "agent demo"})`} value={cliCommand(fresh)} />
          <button className="btn btn-primary" onClick={dismiss}>I saved it, hide the key</button>
        </div>
      )}

      <KeyList title="Pulse keys (heartbeat only)" keys={v.pulse_keys} canRemove={isOwner && !locked} onRemove={remove} />
      <KeyList title="Agent keys (agent_pay only)" keys={v.agent_keys} canRemove={isOwner && !locked} onRemove={remove} />
    </div>
  );
}

function KeyList({ title, keys, canRemove, onRemove }: { title: string; keys: string[]; canRemove: boolean; onRemove: (k: string) => void }) {
  return (
    <div>
      <div className="h-section !mb-2">{title}</div>
      {keys.length === 0 ? (
        <p className="text-mute">None</p>
      ) : (
        <ul className="space-y-2">
          {keys.map((k) => (
            <li key={k} className="flex items-center justify-between gap-3 rounded-xl border border-line px-4 py-2">
              <span className="font-mono text-sm" title={k}>{shortKey(k, 14)}</span>
              {canRemove && <button className="btn !px-3 !py-1 text-sm" onClick={() => onRemove(k)}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
