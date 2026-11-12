export type VaultState = "Alive" | "Warning" | "Triggered" | "Settled";

export interface Heir {
  account_id: string;
  bps: number;
}

export type PayoutStatus = "pending" | "signed" | "broadcast" | "failed";

export type ForeignChain = "base" | "solana" | "monad";
export const EVM_CHAINS: ForeignChain[] = ["base", "monad"];

export interface ForeignPayout {
  chain: ForeignChain;
  to: string;
  amount: string;
  from_address?: string | null;
  status: PayoutStatus;
  signed_tx?: string | null;
  tx_hash?: string | null;
}

export interface Policy {
  per_tx_max: string;
  daily_max: string;
  allowlist: string[];
}

export interface LogEntry {
  ms: number;
  event: string;
  detail?: string | null;
  /** v2: write order across the routine and key-event rings. */
  seq?: number;
}

export interface VaultView {
  token_id: string;
  owner_id: string;
  state: VaultState;
  heartbeat_interval_s: number;
  grace_missed: number;
  last_beat_ms: number;
  warning_at_ms: number;
  trigger_at_ms: number;
  balance: string;
  bounty: string;
  heirs: Heir[];
  foreign: ForeignPayout[];
  pulse_keys: string[];
  agent_keys: string[];
  policy: Policy;
  /** Agent spend counted against the daily cap when the view was read (v2: rolling 24 h window). */
  daily_spent: string;
  /** v1: start of the fixed window. v2: oldest spend still counted (0 when none). */
  daily_window_start_ms: number;
  /** v2: the agent spends inside the rolling 24 h window. */
  spends?: { ms: number; amount: string }[];
  dao_id: string | null;
  /** Guardian who may pause the trigger once per heartbeat cycle (SPEC 2.8). Absent on older deployments. */
  guardian_id?: string | null;
  max_pause_s?: number;
  /** 0 when no pause is running. While now < paused_until_ms the vault reads Warning. */
  paused_until_ms?: number;
  dao_proposal_id: number | null;
  step: number;
  foreign_index: number;
  foreign_inflight?: boolean;
  created_ms?: number;
  log: LogEntry[];
  /** v2: salted MPC derivation paths of the vault's foreign source addresses. Derive from these, never from the id. */
  derivation_paths?: DerivationPaths;
  /** v2: per-vault keeper the owner named (null when none). */
  keeper_id?: string | null;
  /** v2: measured storage of this vault and the NEAR held for it. */
  storage_bytes?: number;
  storage_deposit?: string;
}

export interface DerivationPaths {
  base: string;
  monad: string;
  solana: string;
}

export interface NftToken {
  token_id: string;
  owner_id: string;
  metadata?: { title?: string; description?: string; media?: string; extra?: string | null } | null;
}

export interface EvmStepArgs {
  nonce: number;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  gas_limit: string;
}

export interface StepArgs {
  evm?: EvmStepArgs;
  solana?: { recent_blockhash: string };
}

export interface CallArgs {
  method: string;
  args: Record<string, unknown>;
  /** yoctoNEAR string */
  deposit?: string;
  /** gas as string of raw gas units */
  gas?: string;
}

/** One entry of `get_config().chains` (contracts/dmw/src/foreign.rs chain_registry). */
export interface ChainConfig {
  chain: ForeignChain;
  kind: "evm" | "solana";
  chain_id?: number;
  path?: string;
  rpc?: string;
  explorer_tx?: string;
  /** EVM: cap on any caller's max_fee_per_gas (wei). */
  max_fee_per_gas?: string;
  /** EVM: a non-keeper's fees are clamped to this (wei). */
  non_keeper_max_fee_per_gas?: string;
  min_gas_limit?: string;
  /** Most payouts of this chain per vault (v3 adds it for Solana: 1). */
  max_payouts?: number;
  /** v3, Solana: keeper re-signs of a signed payout per keeper epoch (3). */
  max_keeper_resigns?: number;
}

/** v3: the keeper admin's pending, timelocked proposal. Anyone may execute it once `eta_ms` has passed. */
export interface AdminProposal {
  action: "keeper" | "mpc_signer" | "keeper_admin";
  account_id: string | null;
  proposed_ms: number;
  eta_ms: number;
}

/** `get_config()`: the fields the dashboard reads. Every v3 field is optional (absent on a v2 contract). */
export interface ContractConfig {
  owner_id: string;
  next_id: number | string;
  keeper?: string | null;
  mpc_signer?: string;
  step3_open_after_ms?: number;
  resign_cooldown_ms?: number;
  chains: ChainConfig[];
  /** v3: named by set_keeper, not a keeper until it calls accept_keeper. */
  pending_keeper?: string | null;
  /** v3: may only propose a new keeper, MPC signer or admin, behind a 48 h timelock. */
  keeper_admin?: string | null;
  admin_timelock_ms?: number;
  admin_proposal?: AdminProposal | null;
  keeper_epoch?: number;
  max_keeper_solana_resigns?: number;
  sale_min_interval_s?: number;
  sale_min_grace?: number;
}
