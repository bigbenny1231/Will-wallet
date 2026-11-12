// Wire types from SPEC.md §2.1 (JSON form returned by the contract).

export type VaultState = 'Alive' | 'Warning' | 'Triggered' | 'Settled';
export type ChainName = 'base' | 'monad' | 'solana';
export type PayoutStatus = 'pending' | 'signed' | 'broadcast' | 'failed';

export interface Heir {
  account_id: string;
  bps: number;
}

export interface ForeignPayout {
  chain: ChainName;
  to: string;
  amount: string;
  from_address?: string;
  status: PayoutStatus;
  signed_tx: string | null;
  tx_hash: string | null;
}

export interface Policy {
  per_tx_max: string;
  daily_max: string;
  allowlist: string[];
}

export interface EvmStepArgs {
  nonce: number;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  gas_limit: string;
}

/** `get_sign_track` view: last signature request for a payout (SPEC 2.7). */
export interface SignTrack {
  last_request_ms: number;
  inflight: boolean;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  resign_allowed_after_ms: number;
}

export interface StepArgs {
  evm?: EvmStepArgs;
  solana?: { recent_blockhash: string };
}

export interface LogEntry {
  /** Write order across both log rings (v2; absent on a v1 contract). */
  seq?: number;
  ms: number;
  event: string;
  detail: string;
}

export interface DerivationPaths {
  base: string;
  monad: string;
  solana: string;
}

export interface VaultView {
  token_id: string;
  owner_id: string;
  state: VaultState;
  heartbeat_interval_s: number;
  grace_missed: number;
  last_beat_ms: number;
  warning_at_ms?: number;
  trigger_at_ms?: number;
  balance: string;
  bounty: string;
  heirs: Heir[];
  foreign: ForeignPayout[];
  pulse_keys: string[];
  agent_keys: string[];
  policy: Policy;
  /** Agent spend in the rolling 24 h window ending now (v2; a calendar-day bucket on v1). */
  daily_spent: string;
  /** Oldest spend still counted in the rolling window (0 when none). */
  daily_window_start_ms: number;
  /** v2: the spends inside the rolling window. */
  spends?: { ms: number; amount: string }[];
  /** v2: salted derivation paths of the vault's foreign source addresses (read these, never rebuild them). */
  derivation_paths?: DerivationPaths;
  /** v2: per-vault keeper set by the owner. */
  keeper_id?: string | null;
  /** v2: measured storage of the vault and the deposit that covers it. */
  storage_bytes?: number;
  storage_deposit?: string;
  dao_id: string | null;
  dao_proposal_id: number | null;
  step: number;
  foreign_index: number;
  log: LogEntry[];
}

/** Result of one signed NEAR call (or a mock call). */
export interface TxResult {
  hash: string;
  logs: string[];
  returnValue: unknown;
  /** Present when the transaction (or one of its receipts) failed. */
  failure?: string;
}

export type AgentPayArgs = { token_id: string; receiver_id: string; amount: string; memo?: string };
