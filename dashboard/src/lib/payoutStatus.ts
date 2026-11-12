// What the page says about a vault's foreign payouts, read from each payout's own status and tx_hash, never assumed.
// pending: not signed yet. signed: NEAR's MPC network signed it; a keeper has not recorded a broadcast. broadcast: a
// keeper relayed it and recorded the hash with mark_broadcast. failed: the signature request timed out (re-signable).
import { chainMeta } from "./chainmeta";
import type { ForeignPayout } from "../types";

type PayoutLike = Pick<ForeignPayout, "chain" | "status" | "tx_hash">;

const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const SOL_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** Explorer link of a relayed payout, or null when there is no broadcast hash that looks like one for its chain. */
export function payoutTxUrl(p: PayoutLike): string | null {
  if (p.status !== "broadcast" || !p.tx_hash) return null;
  const m = chainMeta(p.chain);
  if (!(m.evm ? EVM_HASH : SOL_SIG).test(p.tx_hash)) return null;
  return m.tx(p.tx_hash);
}

export interface PayoutGroups<P extends PayoutLike = PayoutLike> {
  pending: P[];
  signed: P[];
  relayed: P[];
  failed: P[];
}

export function groupPayouts<P extends PayoutLike>(ps: P[]): PayoutGroups<P> {
  const g: PayoutGroups<P> = { pending: [], signed: [], relayed: [], failed: [] };
  for (const p of ps) {
    if (p.status === "broadcast") g.relayed.push(p);
    else if (p.status === "signed") g.signed.push(p);
    else if (p.status === "failed") g.failed.push(p);
    else g.pending.push(p);
  }
  return g;
}

/** "Base", "Base and Solana", "Base, Monad and Solana". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const payoutNames = (ps: PayoutLike[]): string => listNames(ps.map((p) => chainMeta(p.chain).short));
