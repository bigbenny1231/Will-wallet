// Classifies relay (broadcast) failures so the keeper reacts correctly and never marks a payout failed.
import { isBlockhashExpired } from './chains/solana.js';
import type { ChainName } from './types.js';

export type RelayErrorKind = 'unfunded' | 'stale' | 'other';

const UNFUNDED = /insufficient funds|insufficient lamports|AccountNotFound|no record of a prior credit|InsufficientFundsForFee|InsufficientFundsForRent|insufficient balance/i;
const EVM_STALE = /nonce too low|nonce is too low|replacement transaction underpriced|max fee per gas less than block base fee/i;

export function classifyRelayError(chain: ChainName, e: unknown): RelayErrorKind {
  const msg = String((e as Error)?.message ?? e);
  if (chain === 'solana' && isBlockhashExpired(e)) return 'stale';
  if (chain !== 'solana' && EVM_STALE.test(msg)) return 'stale';
  if (UNFUNDED.test(msg)) return 'unfunded';
  return 'other';
}

/**
 * Cooldowns (ms) before a parked payout is retried. `parked`: a re-sign this account may not make (contract v3 keeper
 * allowance used up for a Solana payout, not an operator, no legal non-keeper fee): looked at again hourly, quietly,
 * because a keeper change (new keeper epoch) or a role change can lift it.
 */
export const RELAY_COOLDOWN = { unfunded: 60_000, other: 30_000, resignCap: 300_000, parked: 3_600_000 };
export const MAX_RESIGNS = 2;

/** Contract v3: a keeper may re-sign a signed/broadcast Solana payout at most 3 times per keeper epoch. Final, never retried. */
export const RESIGN_LIMIT_ERROR = /keeper re-sign limit reached for this solana payout/;
