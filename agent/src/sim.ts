// In-memory vault that applies the contract's agent_pay policy (same checks, same order). Used by `--sim`
// (a fully offline run for people without testnet keys) and by the tests. Not a substitute for the real contract:
// the live transcript in LIVE_TRANSCRIPT.md is the real thing.
import { DAY_MS, localPolicyCheck } from './wallet.js';
import type { AccessKeyInfo, TxResult, VaultChain, VaultView } from './types.js';

export class SimChain implements VaultChain {
  readonly label = 'sim (in-memory vault, no network)';
  readonly publicKey = 'ed25519:SIMULATEDAGENTKEY';
  calls: { receiver_id: string; amount: string }[] = [];
  /** Ledger of what the simulated contract let out: one entry per allowed payment. */
  transfers: { receiver_id: string; amount: string }[] = [];
  private n = 0;
  constructor(
    public vault: VaultView,
    readonly contractId = 'dmw-sim.testnet',
    public key: AccessKeyInfo = { kind: 'FunctionCall', receiver_id: contractId, method_names: ['agent_pay'], allowance: '1000000000000000000000000' },
    public clock: () => number = () => Date.now(),
  ) {}
  nowMs() {
    return this.clock();
  }
  async getVault() {
    return structuredClone(this.vault);
  }
  async viewAccessKey() {
    return this.key;
  }
  async agentPay(a: { token_id: string; receiver_id: string; amount: string }): Promise<TxResult> {
    this.calls.push({ receiver_id: a.receiver_id, amount: a.amount });
    const v = this.vault;
    const now = this.nowMs();
    const hash = `sim-${++this.n}`;
    const amount = BigInt(a.amount);
    // The contract's two require! guards run before the policy. They panic, so the transaction fails and no state changes.
    if (amount <= 0n) return { hash, logs: [], returnValue: null, failure: simPanic('amount must be > 0') };
    if (a.receiver_id === this.contractId) return { hash, logs: [], returnValue: null, failure: simPanic('receiver cannot be the dmw contract') };
    rollWindow(v, now);
    const reason = localPolicyCheck(v, a.receiver_id, amount, now)[0];
    if (reason) {
      const data = { token_id: v.token_id, receiver_id: a.receiver_id, amount: a.amount, reason };
      return { hash, logs: [`EVENT_JSON:${JSON.stringify({ standard: 'dmw', version: '1.0.0', event: 'agent_pay_denied', data })}`], returnValue: { allowed: false, reason, receiver_id: a.receiver_id, amount: a.amount, daily_spent: v.daily_spent, balance: v.balance } };
    }
    v.balance = (BigInt(v.balance) - amount).toString();
    v.spends!.push({ ms: now, amount: a.amount });
    rollWindow(v, now);
    this.transfers.push({ receiver_id: a.receiver_id, amount: a.amount });
    const data = { token_id: v.token_id, receiver_id: a.receiver_id, amount: a.amount, daily_spent: v.daily_spent };
    return { hash, logs: [`EVENT_JSON:${JSON.stringify({ standard: 'dmw', version: '1.0.0', event: 'agent_pay_allowed', data })}`], returnValue: { allowed: true, reason: null, receiver_id: a.receiver_id, amount: a.amount, daily_spent: v.daily_spent, balance: v.balance } };
  }
}

/** Contract v2's rolling 24 h agent window: drop spends older than a day and refresh the derived view fields. */
function rollWindow(v: VaultView, now: number) {
  v.spends = (v.spends ?? []).filter((s) => s.ms + DAY_MS > now);
  v.daily_spent = v.spends.reduce((a, s) => a + BigInt(s.amount), 0n).toString();
  v.daily_window_start_ms = v.spends.length ? Math.min(...v.spends.map((s) => s.ms)) : 0;
}

/** Same shape as a failed receipt from the node (near.ts toTxResult): the JSON of status.Failure. */
const simPanic = (msg: string) => JSON.stringify({ ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${msg}` } } } });

export type SimPreset = 'alive' | 'warning';

/** Overrides for simVault. `warning`: the owner missed one beat a minute ago; the trigger deadline is still ahead. */
export function simPreset(preset: SimPreset, now: number): Partial<VaultView> {
  if (preset === 'alive') return {};
  const lastBeat = now - 3_600_000 - 60_000;
  return { state: 'Warning', last_beat_ms: lastBeat, warning_at_ms: lastBeat + 3_600_000, trigger_at_ms: lastBeat + 3 * 3_600_000 };
}

export function simVault(now = Date.now(), over: Partial<VaultView> = {}): VaultView {
  const N = 10n ** 24n;
  return {
    token_id: '1',
    owner_id: 'owner.testnet',
    state: 'Alive',
    heartbeat_interval_s: 3600,
    grace_missed: 2,
    last_beat_ms: now,
    warning_at_ms: now + 3_600_000,
    trigger_at_ms: now + 3 * 3_600_000,
    balance: (3n * N).toString(),
    policy: { per_tx_max: (N / 2n).toString(), daily_max: N.toString(), allowlist: ['dmw-api-sim.testnet'] },
    daily_spent: '0',
    daily_window_start_ms: 0,
    spends: [],
    derivation_paths: { base: 'base-1-00000000000000a1', monad: 'monad-1-00000000000000a1', solana: 'sol-1-00000000000000a1' },
    agent_keys: ['ed25519:SIMULATEDAGENTKEY'],
    log: [],
    ...over,
  };
}
