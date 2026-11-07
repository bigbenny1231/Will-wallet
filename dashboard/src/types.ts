export type VaultState = "Alive" | "Warning" | "Triggered" | "Settled";

export interface Heir {
  account_id: string;
  bps: number;
}

export type PayoutStatus = "pending" | "signed" | "broadcast" | "failed";

export interface ForeignPayout {
  chain: "base" | "solana";
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
  daily_spent: string;
  daily_window_start_ms: number;
  dao_id: string | null;
  dao_proposal_id: number | null;
  step: number;
  foreign_index: number;
  log: LogEntry[];
}

export interface NftToken {
  token_id: string;
  owner_id: string;
  metadata?: { title?: string; description?: string; media?: string; extra?: string | null } | null;
}

export interface CallArgs {
  method: string;
  args: Record<string, unknown>;
  /** yoctoNEAR string */
  deposit?: string;
  /** gas as string of raw gas units */
  gas?: string;
}
