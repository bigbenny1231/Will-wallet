// The wallet wrapper. Defence in depth, two layers that both have to say yes:
//
//   layer 1  this file: local pre-checks that mirror the on-chain policy. If one fails the wrapper REFUSES TO SIGN:
//            no transaction exists, nothing reaches the network, the agent sees `refused_locally: <reason>`.
//   layer 2  the dmw contract: agent_pay re-runs the same policy against the real state and answers
//            `allowed` or `denied: <reason>` (a denied call is a successful tx that logs agent_pay_denied).
//
// The wrapper holds exactly one secret: the agent function-call key (see near.ts). It has no method that moves
// NEAR except agent_pay. See agent/README.md for why the key makes any other transfer impossible at protocol level.
import { fmtNear, isAccountId, nearTxLink, parseEvents, parseNear, errMsg } from './util.js';
import type { AccessKeyInfo, TxResult, VaultChain, VaultView } from './types.js';

export const DAY_MS = 86_400_000;

/** Same reasons, same order as the contract's policy_check (SPEC 2.3 / 2.7), plus local-only input checks. */
export type DenyReason =
  | 'vault_not_alive'
  | 'receiver_not_allowlisted'
  | 'over_per_tx_max'
  | 'over_daily_max'
  | 'insufficient_balance';
export type LocalOnlyReason = 'invalid_receiver' | 'invalid_amount' | 'receiver_is_vault_contract';

/** Pure mirror of the on-chain policy. Returns EVERY failing reason, contract order first. */
/**
 * What the contract will count against the daily cap at `nowMs`.
 * v2 views carry `spends` (rolling 24 h window: each spend counts until a day after it was made);
 * v1 views only have a fixed window that resets a day after `daily_window_start_ms`.
 */
export function spentInWindow(v: VaultView, nowMs: number): bigint {
  if (v.spends) return v.spends.reduce((a, s) => (s.ms + DAY_MS > nowMs ? a + BigInt(s.amount) : a), 0n);
  return nowMs < v.daily_window_start_ms + DAY_MS ? BigInt(v.daily_spent) : 0n;
}

export function localPolicyCheck(
  v: VaultView,
  receiver: string,
  amount: bigint,
  nowMs: number,
  sessionSpent = 0n,
): DenyReason[] {
  const out: DenyReason[] = [];
  const warned = v.warning_at_ms !== undefined && nowMs >= v.warning_at_ms;
  if (v.state !== 'Alive' || warned) out.push('vault_not_alive');
  const list = v.policy.allowlist;
  if (list.length > 0 && !list.includes(receiver)) out.push('receiver_not_allowlisted');
  if (amount > BigInt(v.policy.per_tx_max)) out.push('over_per_tx_max');
  const spent = spentInWindow(v, nowMs);
  const effective = spent > sessionSpent ? spent : sessionSpent;
  if (effective + amount > BigInt(v.policy.daily_max)) out.push('over_daily_max');
  if (amount > BigInt(v.balance)) out.push('insufficient_balance');
  return out;
}

export interface KeyAudit {
  ok: boolean;
  problems: string[];
  /** Plain-language limits of the key, for the transcript and the README. */
  explain: string[];
  info: AccessKeyInfo;
}

export function auditKey(info: AccessKeyInfo, contractId: string): KeyAudit {
  const problems: string[] = [];
  const explain: string[] = [];
  if (info.kind === 'FullAccess') {
    problems.push('the key is a FULL-ACCESS key: it could sign a Transfer. Refusing to run with it.');
    return { ok: false, problems, explain, info };
  }
  if (info.receiver_id !== contractId) problems.push(`key is scoped to ${info.receiver_id}, not the vault contract ${contractId}`);
  if (info.method_names.length !== 1 || info.method_names[0] !== 'agent_pay') {
    problems.push(`key may call [${info.method_names.join(', ') || 'ANY method'}], expected exactly [agent_pay]`);
  }
  explain.push(`Scope: it can only sign transactions whose receiver is \`${info.receiver_id}\`.`);
  explain.push(`Methods: only \`${info.method_names.join(', ') || '*'}\`. No other method, no \`Transfer\`, \`AddKey\`, \`DeleteKey\`, \`DeployContract\` or \`Stake\` action.`);
  explain.push('Deposit: NEAR forbids attaching any deposit with a function-call key, so it cannot carry value with a call.');
  explain.push(
    info.allowance === null
      ? 'Allowance: unlimited gas budget (a Vault key normally has one).'
      : `Allowance: ${fmtNear(info.allowance)} NEAR of gas budget left. It pays for gas only; it is never spendable as money.`,
  );
  explain.push('Policy: whatever the key signs, the contract still applies per-tx cap, daily cap, allowlist and vault state.');
  return { ok: problems.length === 0, problems, explain, info };
}

export interface PayRequest {
  receiver: string;
  amountNear: string;
  memo?: string;
}

export type Verdict =
  | { status: 'refused_locally'; reason: string; reasons: string[]; text: string }
  | { status: 'allowed'; text: string; tx: TxResult; link: string; dailySpent?: string; balance?: string }
  | { status: 'denied'; reason: string; text: string; tx: TxResult; link: string }
  | { status: 'error'; text: string; tx?: TxResult; link?: string };

export interface WalletOpts {
  chain: VaultChain;
  tokenId: string;
  /** Demo switch: skip layer 1 so the contract (layer 2) is the only guard. Never use it for real money. */
  localChecks?: boolean;
}

export class Wallet {
  /** Daily spend seen at the first read, plus what this session paid since: a floor in case the view lags. */
  private baselineSpent = 0n;
  private baselineSet = false;
  private paid = 0n;
  readonly localChecks: boolean;
  readonly chain: VaultChain;
  readonly tokenId: string;

  constructor(o: WalletOpts) {
    this.chain = o.chain;
    this.tokenId = o.tokenId;
    this.localChecks = o.localChecks ?? true;
  }

  async snapshot(): Promise<VaultView> {
    return this.chain.getVault(this.tokenId);
  }

  async audit(): Promise<KeyAudit> {
    return auditKey(await this.chain.viewAccessKey(), this.chain.contractId);
  }

  async pay(req: PayRequest): Promise<Verdict> {
    const refuse = (reason: string, reasons = [reason]): Verdict => ({
      status: 'refused_locally',
      reason,
      reasons,
      text: `refused_locally: ${reason}`,
    });

    // Input sanity first: these never reach the chain in any mode.
    if (!isAccountId(req.receiver)) return refuse('invalid_receiver');
    let amount: bigint;
    try {
      amount = parseNear(req.amountNear);
    } catch {
      return refuse('invalid_amount');
    }
    if (amount <= 0n) return refuse('invalid_amount');
    if (req.receiver === this.chain.contractId) return refuse('receiver_is_vault_contract');

    // Layer 1: fresh view of the vault, then the mirrored policy.
    let vault: VaultView;
    try {
      vault = await this.snapshot();
    } catch (e) {
      // Fail closed: if the wrapper cannot see the vault it does not sign.
      return { status: 'refused_locally', reason: 'cannot_read_vault', reasons: ['cannot_read_vault'], text: `refused_locally: cannot_read_vault (${errMsg(e)})` };
    }
    if (!this.baselineSet) {
      this.baselineSpent = BigInt(vault.daily_spent);
      this.baselineSet = true;
    }
    if (this.localChecks) {
      const reasons = localPolicyCheck(vault, req.receiver, amount, this.chain.nowMs(), this.baselineSpent + this.paid);
      if (reasons.length) return refuse(reasons[0], reasons);
    }

    // Layer 2: sign agent_pay with the scoped key; report the contract's own verdict.
    let tx: TxResult;
    try {
      tx = await this.chain.agentPay({
        token_id: this.tokenId,
        receiver_id: req.receiver,
        amount: amount.toString(),
        ...(req.memo ? { memo: req.memo.slice(0, 64) } : {}),
      });
    } catch (e) {
      const link = (e as { context?: { transactionHash?: string } })?.context?.transactionHash;
      return { status: 'error', text: `error: ${errMsg(e)}`, ...(link ? { link: nearTxLink(link) } : {}) };
    }
    const link = nearTxLink(tx.hash);
    if (tx.failure) return { status: 'error', text: `error: transaction failed ${tx.failure.slice(0, 160)}`, tx, link };

    const rv = tx.returnValue as { allowed?: boolean; reason?: string | null; daily_spent?: string; balance?: string } | null;
    const ev = parseEvents(tx.logs).find((e) => e.event === 'agent_pay_allowed' || e.event === 'agent_pay_denied');
    const allowed = rv && typeof rv.allowed === 'boolean' ? rv.allowed : ev ? ev.event === 'agent_pay_allowed' : undefined;
    if (allowed === undefined) return { status: 'error', text: 'error: no agent_pay verdict in the receipt', tx, link };
    if (allowed) {
      this.paid += amount;
      return { status: 'allowed', text: 'allowed', tx, link, dailySpent: rv?.daily_spent, balance: rv?.balance };
    }
    const reason = String(rv?.reason ?? ev?.data.reason ?? 'unknown');
    return { status: 'denied', reason, text: `denied: ${reason}`, tx, link };
  }
}
