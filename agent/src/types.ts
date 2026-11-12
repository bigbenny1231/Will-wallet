// Shared types: the vault wire format (SPEC.md 2.1), the chain port, and the brain/tool protocol.

export interface Policy {
  per_tx_max: string;
  daily_max: string;
  allowlist: string[];
}

export interface VaultView {
  token_id: string;
  owner_id: string;
  state: 'Alive' | 'Warning' | 'Triggered' | 'Settled';
  heartbeat_interval_s: number;
  grace_missed: number;
  last_beat_ms: number;
  warning_at_ms?: number;
  trigger_at_ms?: number;
  balance: string;
  policy: Policy;
  /** Spent in the agent window when the view was read. v2: a rolling 24 h sum of `spends`. */
  daily_spent: string;
  /** v1: start of the fixed window. v2: oldest spend still counted (0 when none). */
  daily_window_start_ms: number;
  /** v2 only: the agent spends inside the rolling 24 h window. */
  spends?: { ms: number; amount: string }[];
  /** v2 only: the salted MPC derivation paths of this vault's foreign source addresses. */
  derivation_paths?: { base: string; monad: string; solana: string; salt: string };
  agent_keys: string[];
  log: { ms: number; event: string; detail: string }[];
}

export interface TxResult {
  hash: string;
  logs: string[];
  returnValue: unknown;
  failure?: string;
}

/** What the NEAR node says about the agent's key (view_access_key). */
export type AccessKeyInfo =
  | { kind: 'FullAccess' }
  | { kind: 'FunctionCall'; receiver_id: string; method_names: string[]; allowance: string | null };

/** The only things the wallet wrapper may do with the chain. There is deliberately no transfer. */
export interface VaultChain {
  readonly label: string;
  readonly contractId: string;
  readonly publicKey: string;
  getVault(tokenId: string): Promise<VaultView>;
  viewAccessKey(): Promise<AccessKeyInfo>;
  agentPay(args: { token_id: string; receiver_id: string; amount: string; memo?: string }): Promise<TxResult>;
  nowMs(): number;
}

// ------------------------------------------------------------------ brain / tool protocol

export type ToolName = 'read_inbox' | 'pay' | 'done';
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Message =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text?: string; calls: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; content: string };

export interface BrainStep {
  thought?: string;
  calls: ToolCall[];
}

export interface Brain {
  readonly name: string;
  readonly label: string;
  step(history: Message[]): Promise<BrainStep>;
}

export interface InboxItem {
  id: string;
  from: string;
  subject: string;
  body: string;
}

/** Optional block that puts a scenario into the offline attack suite (src/attack-suite.ts, `npm run attacks`). */
export interface AttackMeta {
  /** Position in the scoreboard. */
  order: number;
  title: string;
  /** The technique, in one or two sentences. */
  technique: string;
  /** What the attacker wanted, short enough for a table cell. */
  wants: string;
  /** Simulated vault state for the run. Default: alive. */
  vault?: 'alive' | 'warning';
  /** What the run shows and where it stops showing it. */
  note: string;
}

export interface Scenario {
  name: string;
  description: string;
  inbox: InboxItem[];
  attack?: AttackMeta;
}
