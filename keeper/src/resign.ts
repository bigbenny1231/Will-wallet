// Re-sign planning for hardened `resign_foreign` (SPEC 2.3 / 2.7, docs/SECURITY_REVIEW.md C-1, H-2).
import { evmTxHash } from './chains/evm.js';
import { solanaTxSignature } from './chains/solana.js';
import type { ContractConfig } from './step3.js';
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

/** Fallback non-keeper fee clamp per EVM chain (foreign.rs `non_keeper_max_fee_per_gas`): Base 10 gwei, Monad 200 gwei. */
export const NON_KEEPER_CLAMP_FALLBACK = { base: 10_000_000_000n, monad: 200_000_000_000n } as const;

/** The chain's non-keeper fee clamp, from `get_config().chains` when known, else the registry value above. */
export function nonKeeperFeeClamp(chain: string, cfg?: Pick<ContractConfig, 'chains'> | null): bigint {
  const raw = cfg?.chains?.find((c) => c.chain === chain)?.non_keeper_max_fee_per_gas;
  if (raw) {
    try {
      const v = BigInt(raw);
      if (v > 0n) return v;
    } catch {
      /* fall through */
    }
  }
  return chain === 'monad' ? NON_KEEPER_CLAMP_FALLBACK.monad : NON_KEEPER_CLAMP_FALLBACK.base;
}

/** v3 (H-1(3)): the last SIGNED fees are above the non-keeper clamp, i.e. a keeper signed them. */
export const signedAboveClamp = (last: Pick<SignTrack, 'max_fee_per_gas' | 'max_priority_fee_per_gas'>, clamp: bigint) =>
  BigInt(last.max_fee_per_gas) > clamp || BigInt(last.max_priority_fee_per_gas) > clamp;

/**
 * Re-sign args for an operator that is NOT a keeper (vault owner, heir) on an EVM payout that already has a signature.
 * The contract clamps a non-keeper's fees to `non_keeper_max_fee_per_gas` and then checks them:
 *  - last signed fees above the clamp (a keeper's signature, contract v3 H-1(3)): the replacement must have
 *    `max_fee_per_gas` EXACTLY the clamp and a priority fee >= min(last priority, clamp). We send
 *    priority = max(min(last, clamp), min(fresh, clamp)), never above the clamp;
 *  - otherwise the 110% rule: max(fresh, 1.1 x last) for both fees. A bump that would have to go above the clamp
 *    cannot be signed by a non-keeper (the contract would clamp it and then refuse it): null, so nothing is sent.
 */
export function nonKeeperResignArgs(fresh: EvmStepArgs, last: Pick<SignTrack, 'max_fee_per_gas' | 'max_priority_fee_per_gas'>, chain: string, clamp: bigint): EvmStepArgs | null {
  const f = clampEvm(fresh, chain);
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  if (signedAboveClamp(last, clamp)) {
    const prio = max(min(BigInt(last.max_priority_fee_per_gas), clamp), min(BigInt(f.max_priority_fee_per_gas), clamp));
    return { ...f, max_fee_per_gas: clamp.toString(), max_priority_fee_per_gas: prio.toString() };
  }
  const b = bumpedEvmArgs(fresh, last, chain);
  if (BigInt(b.max_fee_per_gas) > clamp || BigInt(b.max_priority_fee_per_gas) > clamp) return null;
  return b;
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
