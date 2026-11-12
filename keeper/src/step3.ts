// Step III operator window (contract v2, finding C; lib.rs run_step case 3 and is_operator): during the first
// hour of step 3, and of each payout in it, only an operator may supply a signature's chain params. Operators are the
// contract owner (unless it is the locked contract itself), the contract keeper, the vault keeper, the vault owner and
// every heir. After `step3_open_after_ms` (get_config) anyone may.
import type { VaultView } from './types.js';

/** The part of `get_config` the keeper reads. */
export interface ContractConfig {
  owner_id?: string | null;
  keeper?: string | null;
  step3_open_after_ms?: number;
}

/** The contract's panic for a non-operator inside the window. */
export const STEP3_WINDOW_PANIC = /during the first hour only the keeper/;
/** Park length when the window start cannot be read from the vault log (it is then retried, and the contract decides). */
export const STEP3_UNKNOWN_PARK_MS = 5 * 60_000;
/** Added to the computed opening time to absorb keeper/chain clock skew. */
export const STEP3_MARGIN_MS = 5_000;

/** Mirrors `Contract::is_operator`. */
export function isOperator(me: string, v: Pick<VaultView, 'owner_id' | 'keeper_id' | 'heirs'>, cfg: ContractConfig, contractId: string): boolean {
  if (me === contractId) return false;
  return (
    (!!cfg.owner_id && me === cfg.owner_id) ||
    (!!cfg.keeper && me === cfg.keeper) ||
    (!!v.keeper_id && me === v.keeper_id) ||
    me === v.owner_id ||
    v.heirs.some((h) => h.account_id === me)
  );
}

/** Events that set `step3_progress_ms` on the contract: step 2 (step 3 starts) and the end of each payout's signature. */
const PROGRESS_EVENTS = new Set(['step_2', 'foreign_signed', 'foreign_failed']);

/**
 * The contract's `step3_progress_ms` is not in the view; it is the time of the latest step_2 / foreign_signed /
 * foreign_failed log entry. Null when none is in the log (it is not lost in practice: these entries are kept in the
 * 40-entry history ring, which routine events do not evict).
 */
export function step3ProgressMs(v: Pick<VaultView, 'log'>): number | null {
  let last: number | null = null;
  for (const e of v.log) if (PROGRESS_EVENTS.has(e.event) && (last === null || e.ms > last)) last = e.ms;
  return last;
}

/** When the current payout's signing opens to everyone (ms), or null when unknown. */
export function step3OpensAt(v: Pick<VaultView, 'log'>, cfg: ContractConfig): number | null {
  const start = step3ProgressMs(v);
  if (start === null) return null;
  return start + (cfg.step3_open_after_ms ?? 0);
}
