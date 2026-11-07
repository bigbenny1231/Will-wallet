// Argument shapes for contract calls, kept in one place (SPEC 2.3 leaves some of them implicit).
import type { CallArgs, ForeignPayout, Heir, Policy } from "../types";

export interface ForeignDraft {
  chain: "base" | "solana";
  to: string;
  amount: string; // smallest unit
  from_address: string;
}

export interface CreateDraft {
  heartbeat_interval_s: number;
  grace_missed: number;
  heirs: Heir[];
  policy: Policy;
  bounty?: string; // yocto
  depositYocto: string;
  foreign: ForeignDraft[];
  dao_id: string | null;
}

export const GAS = {
  create: "100000000000000",
  set: "50000000000000",
};

export function createVaultCall(d: CreateDraft): CallArgs {
  const args: Record<string, unknown> = {
    heartbeat_interval_s: d.heartbeat_interval_s,
    grace_missed: d.grace_missed,
    heirs: d.heirs,
    policy: d.policy,
  };
  if (d.bounty && d.bounty !== "0") args.bounty = d.bounty;
  return { method: "create_vault", args, deposit: d.depositYocto, gas: GAS.create };
}

export function toPayouts(f: ForeignDraft[], fromAddresses?: (string | undefined)[]): ForeignPayout[] {
  return f.map((p, i) => ({
    chain: p.chain,
    to: p.to,
    amount: p.amount,
    from_address: fromAddresses?.[i] ?? p.from_address,
    status: "pending",
    signed_tx: null,
    tx_hash: null,
  }));
}

export function followUpCalls(tokenId: string, foreign: ForeignPayout[], daoId: string | null): CallArgs[] {
  const out: CallArgs[] = [];
  if (foreign.length) out.push({ method: "set_foreign_payouts", args: { token_id: tokenId, payouts: foreign }, gas: GAS.set });
  if (daoId) out.push({ method: "set_dao", args: { token_id: tokenId, dao_id: daoId }, gas: GAS.set });
  return out;
}
