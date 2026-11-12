// What set_foreign_payouts accepts on contract v3 (contracts/dmw/src/lib.rs set_foreign_payouts, foreign.rs
// is_solana_address, docs/SECURITY_FIXES_V3.md L-4). Checked in the browser before the call is built, so the owner reads
// a plain message instead of a contract panic after a wallet prompt.
import bs58 from "bs58";
import type { ForeignChain, ForeignPayout } from "../types";

/** lib.rs MAX_FOREIGN. */
export const MAX_FOREIGN = 4;
/** Most payouts of one chain per vault (foreign.rs `max_payouts`): every payout of a chain leaves one derived address. */
export const MAX_PAYOUTS_PER_CHAIN: Record<ForeignChain, number> = { base: MAX_FOREIGN, monad: 1, solana: 1 };
export const U64_MAX = 18_446_744_073_709_551_615n;
/** u128::MAX: the contract's `U128` amount. */
const U128_MAX = (1n << 128n) - 1n;

const CHAIN_NAME: Record<ForeignChain, string> = { base: "Base", monad: "Monad", solana: "Solana" };
const EVM_TO = /^0x[0-9a-fA-F]{40}$/;

/** foreign.rs `is_solana_address`: base58 (at most 44 characters) that decodes to exactly 32 bytes. */
export function isSolanaAddress(s: string): boolean {
  if (s.length === 0 || s.length > 44) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export const isEvmAddress = (s: string) => EVM_TO.test(s);

type PayoutInput = Pick<ForeignPayout, "chain" | "to" | "amount">;

/**
 * Every reason set_foreign_payouts would refuse these payouts, one message each ("Payout 2: ..."), in the order the
 * owner reads the form. Empty when the contract will take them. Amounts are in the chain's smallest unit.
 */
export function payoutProblems(payouts: PayoutInput[]): string[] {
  const out: string[] = [];
  if (payouts.length > MAX_FOREIGN) out.push(`At most ${MAX_FOREIGN} foreign payouts per vault (this has ${payouts.length}).`);
  payouts.forEach((p, i) => {
    const n = `Payout ${i + 1}`;
    const to = p.to.trim();
    if (p.chain === "solana") {
      if (!isSolanaAddress(to)) out.push(`${n}: a Solana address is a base58 public key of 32 bytes (32 to 44 characters, no 0, O, I or l).`);
    } else if (p.chain === "base" || p.chain === "monad") {
      if (!isEvmAddress(to)) out.push(`${n}: a ${CHAIN_NAME[p.chain]} address is 0x followed by 40 hex characters.`);
    } else {
      out.push(`${n}: unknown chain.`);
      return;
    }
    let amount: bigint | null = null;
    try {
      if (/^\d+$/.test(String(p.amount).trim())) amount = BigInt(String(p.amount).trim());
    } catch {
      amount = null;
    }
    if (amount === null || amount <= 0n) out.push(`${n}: enter an amount above 0.`);
    else if (p.chain === "solana" && amount > U64_MAX) out.push(`${n}: a Solana amount must fit in 64 bits of lamports (at most about 18.4 billion SOL).`);
    else if (amount > U128_MAX) out.push(`${n}: the amount is too large.`);
  });
  for (const c of ["base", "monad", "solana"] as ForeignChain[]) {
    const count = payouts.filter((p) => p.chain === c).length;
    const max = MAX_PAYOUTS_PER_CHAIN[c];
    if (count > max)
      out.push(
        c === "solana"
          ? `Only one Solana payout per vault: every Solana payout would leave the same derived address, and a Solana transfer has no nonce (contract v3). This has ${count}.`
          : `At most ${max} ${CHAIN_NAME[c]} payout${max === 1 ? "" : "s"} per vault (this has ${count}).`,
      );
  }
  return out;
}

/** Throws one Error listing every problem; used right before a set_foreign_payouts call is built. */
export function assertValidPayouts(payouts: PayoutInput[]): void {
  const p = payoutProblems(payouts);
  if (p.length) throw new Error(`These foreign payouts would be refused by the contract: ${p.join(" ")}`);
}
