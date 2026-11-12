// Re-sign planning for hardened `resign_foreign` (SPEC 2.3 / 2.7, docs/SECURITY_REVIEW.md C-1, H-2).
import { evmTxHash } from './chains/evm.js';
import { solanaTxSignature } from './chains/solana.js';
import type { EvmStepArgs, ForeignPayout, SignTrack } from './types.js';

export const MIN_GAS_LIMIT = 21_000n;
export const MAX_GAS_LIMIT = 100_000n;
export const MAX_FEE_CAP = 100_000_000_000n; // 100 gwei (Base)
/** Contract-side max_fee_per_gas cap per EVM chain (foreign.rs registry): Base 100 gwei, Monad 1000 gwei (its base fee floor is 100 gwei). */
export const maxFeeCap = (chain?: string): bigint => (chain === 'monad' ? 1_000_000_000_000n : MAX_FEE_CAP);
export const BUMP_PCT = 110n;
/** Margin added to `resign_allowed_after_ms` to absorb keeper/chain clock skew. */
export const RESIGN_MARGIN_MS = 3_000;

/** ceil(x * 1.1): the contract checks `new * 100 >= last * 110`. */
export const bump = (x: bigint) => (x * BUMP_PCT + 99n) / 100n;

/** Clamp fresh fees into the contract's accepted window. The contract ignores `nonce` but we keep sending it. */
export function clampEvm(a: EvmStepArgs, chain?: string): EvmStepArgs {
  const cap = maxFeeCap(chain);
  let gas = BigInt(a.gas_limit);
  if (gas < MIN_GAS_LIMIT) gas = MIN_GAS_LIMIT;
  if (gas > MAX_GAS_LIMIT) gas = MAX_GAS_LIMIT;
  let max = BigInt(a.max_fee_per_gas);
  if (max < 1n) max = 1n;
  if (max > cap) max = cap;
  let prio = BigInt(a.max_priority_fee_per_gas);
  if (prio > max) prio = max;
  return { nonce: a.nonce, max_fee_per_gas: max.toString(), max_priority_fee_per_gas: prio.toString(), gas_limit: gas.toString() };
}

/**
 * Args for re-signing an EVM payout that already has a signature: max(fresh, 1.1 x last) for BOTH fee fields, but never
 * above the chain's fee cap (100 gwei Base, 1000 gwei Monad). Contract v2 (second review F4) accepts a fee AT the cap as
 * a valid bump, so a payout signed at the cap stays re-signable.
 */
export function bumpedEvmArgs(fresh: EvmStepArgs, last: Pick<SignTrack, 'max_fee_per_gas' | 'max_priority_fee_per_gas'>, chain?: string): EvmStepArgs {
  const f = clampEvm(fresh, chain);
  const cap = maxFeeCap(chain);
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  const bmax = min(bump(BigInt(last.max_fee_per_gas)), cap);
  const bprio = min(bump(BigInt(last.max_priority_fee_per_gas)), cap);
  let max = BigInt(f.max_fee_per_gas) > bmax ? BigInt(f.max_fee_per_gas) : bmax;
  const prio = BigInt(f.max_priority_fee_per_gas) > bprio ? BigInt(f.max_priority_fee_per_gas) : bprio;
  if (prio > max) max = prio;
  return { ...f, max_fee_per_gas: max.toString(), max_priority_fee_per_gas: prio.toString() };
}

/** ms to wait before a re-sign is legal (0 when allowed now). */
export const msUntilResign = (t: Pick<SignTrack, 'resign_allowed_after_ms'>, now: number) =>
  Math.max(0, t.resign_allowed_after_ms + RESIGN_MARGIN_MS - now);

/** Chain tx id of the stored signed_tx (EVM keccak hash, Solana first signature); null if it cannot be derived. */
export function payoutTxId(p: Pick<ForeignPayout, 'chain' | 'signed_tx' | 'tx_hash'>): string | null {
  try {
    if (p.signed_tx) return p.chain !== 'solana' ? evmTxHash(p.signed_tx) : solanaTxSignature(p.signed_tx);
  } catch {
    /* fall through */
  }
  return p.tx_hash;
}
