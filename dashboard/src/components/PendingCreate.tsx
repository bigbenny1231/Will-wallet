import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/near";
import { deriveFor } from "../lib/derive";
import { followUpCalls, toPayouts, type ForeignDraft } from "../lib/calls";
import { useWallet } from "../lib/wallet";
import { ErrorNote } from "./ui";

export interface Pending {
  owner: string;
  knownIds: string[];
  foreign: ForeignDraft[];
  dao_id: string | null;
  startedMs: number;
}

export const PENDING_KEY = "dmw-pending-create";

export function readPending(): Pending | null {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || "null") as Pending | null;
  } catch {
    return null;
  }
}

/**
 * After create_vault (popup wallets resolve; MyNearWallet redirects away and back) this waits for the new vault to show
 * up for the owner, then sends the follow-up set_* calls with the real token id, and finally opens the vault.
 */
export default function PendingCreate() {
  const { accountId, call } = useWallet();
  const nav = useNavigate();
  const [pending, setPending] = useState<Pending | null>(() => readPending());
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("Waiting for the vault to appear on chain…");
  const running = useRef(false);

  useEffect(() => {
    const onStore = () => setPending(readPending());
    window.addEventListener("dmw-pending", onStore);
    return () => window.removeEventListener("dmw-pending", onStore);
  }, []);

  useEffect(() => {
    if (!pending || !accountId || pending.owner !== accountId) return;
    if (Date.now() - pending.startedMs > 30 * 60_000) {
      localStorage.removeItem(PENDING_KEY);
      setPending(null);
      return;
    }
    let stop = false;
    const tick = async () => {
      if (stop || running.current) return;
      try {
        const mine = await api.getVaultsForOwner(accountId);
        const fresh = mine.filter((v) => !pending.knownIds.includes(v.token_id)).sort((a, b) => Number(BigInt(b.token_id) - BigInt(a.token_id)))[0];
        if (!fresh) return;
        running.current = true;
        localStorage.removeItem(PENDING_KEY);
        setPending(null);
        const id = fresh.token_id;
        let payouts = toPayouts(pending.foreign);
        if (pending.foreign.length) {
          try {
            const d = deriveFor(id);
            payouts = toPayouts(pending.foreign, pending.foreign.map((f) => d[f.chain]));
          } catch {
            /* keep the previewed addresses */
          }
        }
        const calls = followUpCalls(id, payouts, pending.dao_id);
        if (calls.length) {
          setStatus("Vault created. Approve the follow-up settings…");
          await call(calls);
        }
        nav(`/vault/${id}`);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        running.current = false;
      }
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [pending, accountId, call, nav]);

  if (!pending) return err ? <div className="wrap pt-6"><ErrorNote>{err}</ErrorNote></div> : null;
  return (
    <div className="wrap pt-6">
      <div className="flex items-baseline justify-between gap-6 border-l border-brass py-1 pl-4 text-[15px]">
        <div>{err ? <span className="text-dead">{err}</span> : status}</div>
        <button
          className="tl"
          onClick={() => {
            localStorage.removeItem(PENDING_KEY);
            setPending(null);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
