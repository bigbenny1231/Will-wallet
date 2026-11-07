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
  daily_spent: string;
  daily_window_start_ms: number;
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

export interface Scenario {
  name: string;
  description: string;
  inbox: InboxItem[];
}
