// DMW_MOCK=1: an in-memory (file-persisted) vault that follows SPEC §2.2 / §2.4 so pulse + keeper
// can be demoed and unit-tested before any contract exists. State is shared between processes via a JSON file.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Backend } from './backend.js';
import type { Chains } from './chainsApi.js';
import { KEEPER_DIR } from './config.js';
import { bpsShare, deriveState, isDue, triggerAtMs } from './machine.js';
import { isOperator, step3ProgressMs, type ContractConfig } from './step3.js';
import type { AgentPayArgs, ChainName, SignTrack, StepArgs, TxResult, VaultView } from './types.js';

const NEAR = 10n ** 24n;
export const MOCK_RESERVE = NEAR / 20n; // 0.05 NEAR kept for later steps

export interface MockOpts {
  token_id?: string;
  owner_id?: string;
  heartbeat_interval_s?: number;
  grace_missed?: number;
  balance?: bigint;
  bounty?: bigint;
  withDao?: boolean;
  foreign?: 'both' | 'none' | 'base' | 'monad' | 'solana';
}

/** Contract v3 limits (foreign.rs): per-chain payout caps, Solana keeper re-signs, fee caps and non-keeper clamps. */
export const MOCK_LIMITS = {
  maxForeign: 4,
  maxPayouts: { base: 4, monad: 1, solana: 1 } as Record<ChainName, number>,
  maxKeeperSolanaResigns: 3,
  feeCap: { base: 100_000_000_000n, monad: 1_000_000_000_000n } as Record<'base' | 'monad', bigint>,
  nonKeeperClamp: { base: 10_000_000_000n, monad: 200_000_000_000n } as Record<'base' | 'monad', bigint>,
  minGasLimit: 50_000n,
  maxGasLimit: 100_000n,
};

/** Contract v3 (M-1) detail of a Solana payout a non-operator's step 3 skipped after the operator hour. */
export const MOCK_SKIPPED_DETAIL = 'skipped: no operator signed within 1 h; an operator may re-sign it';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Length in bytes of a base58 string, or -1 when it is not base58. */
function b58Len(s: string): number {
  let bytes: number[] = [];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return -1;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  bytes = bytes.reverse();
  return zeros + bytes.length;
}

/** `set_foreign_payouts` validation of contract v3 (lib.rs): throws the contract's messages. */
export function mockValidatePayouts(payouts: Pick<VaultView['foreign'][number], 'chain' | 'to' | 'amount'>[]): void {
  if (payouts.length > MOCK_LIMITS.maxForeign) throw new Error(`too many foreign payouts (max ${MOCK_LIMITS.maxForeign})`);
  for (const p of payouts) {
    if (!(BigInt(p.amount) > 0n)) throw new Error('foreign amount must be > 0');
    if (p.chain === 'solana') {
      if (!(p.to.length <= 44 && b58Len(p.to) === 32)) throw new Error('solana `to` must be a base58 32-byte public key');
      if (BigInt(p.amount) > 18_446_744_073_709_551_615n) throw new Error('solana amount must fit in u64 lamports');
    } else if (!/^0x[0-9a-fA-F]{40}$/.test(p.to)) throw new Error('evm `to` must be 0x + 40 hex');
  }
  for (const c of ['base', 'monad', 'solana'] as ChainName[]) {
    const max = MOCK_LIMITS.maxPayouts[c];
    if (payouts.filter((p) => p.chain === c).length > max) throw new Error(`too many ${c} payouts (max ${max} per vault)`);
  }
}

/** `set_foreign_payouts` on a mock vault: validates like contract v3, then stores the payouts as pending. */
export function mockSetForeignPayouts(v: VaultView, payouts: Pick<VaultView['foreign'][number], 'chain' | 'to' | 'amount' | 'from_address'>[], now: number): void {
  if (v.state === 'Triggered' || v.state === 'Settled') throw new Error(`set_foreign_payouts: vault is ${v.state}`);
  mockValidatePayouts(payouts);
  v.foreign = payouts.map((p) => ({ chain: p.chain, to: p.to, amount: p.amount, from_address: p.from_address, status: 'pending', signed_tx: null, tx_hash: null }));
  push(v, now, 'foreign_set', `${v.foreign.length} payouts`);
}

export function mockCreate(now: number, o: MockOpts = {}): VaultView {
  const foreign: VaultView['foreign'] = [];
  const f = o.foreign ?? 'both';
  if (f === 'both' || f === 'base')
    foreign.push({
      chain: 'base',
      to: '0x000000000000000000000000000000000000dEaD',
      amount: '1000000000000000',
      from_address: '0x00000000000000000000000000000000000ba5e0',
      status: 'pending',
      signed_tx: null,
      tx_hash: null,
    });
  if (f === 'monad')
    foreign.push({
      chain: 'monad',
      to: '0x000000000000000000000000000000000000dEaD',
      amount: '1000000000000000',
      from_address: '0x000000000000000000000000000000000000d0ad',
      status: 'pending',
      signed_tx: null,
      tx_hash: null,
    });
  if (f === 'both' || f === 'solana')
    foreign.push({
      chain: 'solana',
      to: '11111111111111111111111111111112',
      amount: '1000000',
      from_address: 'MOCKfromSolana',
      status: 'pending',
      signed_tx: null,
      tx_hash: null,
    });
  mockValidatePayouts(foreign);
  return {
    token_id: o.token_id ?? '1',
    owner_id: o.owner_id ?? 'mock-owner.testnet',
    state: 'Alive',
    heartbeat_interval_s: o.heartbeat_interval_s ?? 20,
    grace_missed: o.grace_missed ?? 1,
    last_beat_ms: now,
    balance: String(o.balance ?? 5n * NEAR),
    bounty: String(o.bounty ?? NEAR / 10n),
    heirs: [
      { account_id: 'sarah.testnet', bps: 6000 },
      { account_id: 'tom.testnet', bps: 4000 },
    ],
    foreign,
    pulse_keys: ['ed25519:MockPulseKey'],
    agent_keys: ['ed25519:MockAgentKey'],
    policy: { per_tx_max: String(NEAR), daily_max: String(5n * NEAR), allowlist: ['api.provider.testnet'] },
    daily_spent: '0',
    daily_window_start_ms: 0,
    spends: [],
    derivation_paths: mockPaths(o.token_id ?? '1'),
    keeper_id: null,
    dao_id: o.withDao ? 'estate-1.sputnik-v2.testnet' : null,
    dao_proposal_id: null,
    step: 0,
    foreign_index: 0,
    log: [],
  };
}

const event = (name: string, data: Record<string, unknown>) =>
  `EVENT_JSON:${JSON.stringify({ standard: 'dmw', version: '1.0.0', event: name, data })}`;

const push = (v: VaultView, now: number, ev: string, detail: string) => v.log.push({ ms: now, event: ev, detail });

export function mockHeartbeat(v: VaultView, now: number): string[] {
  if (v.state === 'Triggered' || v.state === 'Settled') throw new Error(`heartbeat rejected: vault is ${v.state}`);
  v.last_beat_ms = now;
  push(v, now, 'heartbeat', '');
  return [event('heartbeat', { token_id: v.token_id, ms: now })];
}

export function mockPoke(v: VaultView, now: number): string[] {
  if (!isDue(v, now)) throw new Error('not_due');
  v.state = 'Triggered';
  v.step = 1;
  v.balance = String(BigInt(v.balance) - BigInt(v.bounty));
  push(v, now, 'triggered', `bounty ${v.bounty}`);
  return [event('triggered', { token_id: v.token_id, bounty: v.bounty })];
}

export function mockExecuteStep(v: VaultView, now: number, args?: StepArgs): { logs: string[]; step: number } {
  if (v.state !== 'Triggered') throw new Error(`execute_step: vault is ${v.state}`);
  const logs: string[] = [];
  switch (v.step) {
    case 1: {
      const bal = BigInt(v.balance);
      const distributable = bal > MOCK_RESERVE ? bal - MOCK_RESERVE : 0n;
      let paid = 0n;
      for (const h of v.heirs) paid += bpsShare(distributable, h.bps);
      v.balance = String(bal - paid);
      v.step = 2;
      push(v, now, 'step_1', `paid ${paid} to ${v.heirs.length} heirs`);
      break;
    }
    case 2: {
      const n = v.pulse_keys.length + v.agent_keys.length;
      v.pulse_keys = [];
      v.agent_keys = [];
      v.step = 3;
      v.foreign_index = 0;
      push(v, now, 'step_2', `deleted ${n} keys`);
      break;
    }
    case 3: {
      if (v.foreign_index < v.foreign.length) {
        const p = v.foreign[v.foreign_index];
        if (p.chain !== 'solana' && !args?.evm) throw new Error('execute_step: missing args.evm');
        if (p.chain === 'solana' && !args?.solana?.recent_blockhash) throw new Error('execute_step: missing args.solana');
        p.status = 'signed';
        p.signed_tx = p.chain !== 'solana' ? `0xmocksigned${v.foreign_index}` : Buffer.from(`mocksigned${v.foreign_index}`).toString('base64');
        v.foreign_index += 1;
        push(v, now, 'foreign_signed', `#${v.foreign_index - 1} signed (${p.chain})`);
      }
      if (v.foreign_index >= v.foreign.length) {
        v.step = 4;
        push(v, now, 'step_3', 'foreign payouts done');
      }
      break;
    }
    case 4: {
      if (v.dao_id) {
        v.dao_proposal_id = 1;
        push(v, now, 'step_4', `proposal ${v.dao_proposal_id} on ${v.dao_id}`);
      } else push(v, now, 'step_4', 'no dao, skipped');
      v.step = 5;
      break;
    }
    case 5: {
      const top = [...v.heirs].sort((a, b) => b.bps - a.bps)[0];
      v.owner_id = top.account_id;
      v.state = 'Settled';
      push(v, now, 'settled', `nft -> ${top.account_id}`);
      logs.push(event('settled', { token_id: v.token_id, owner_id: top.account_id }));
      break;
    }
    default:
      throw new Error(`execute_step: bad step ${v.step}`);
  }
  return { logs, step: v.step };
}

export function mockMarkBroadcast(v: VaultView, index: number, txHash: string, now: number): void {
  const p = v.foreign[index];
  if (!p) throw new Error('mark_broadcast: bad index');
  p.status = 'broadcast';
  p.tx_hash = txHash;
  push(v, now, 'broadcast', `${index} ${txHash}`);
}

/** Salted paths like contract v2 (fixed salt in the mock). */
export const mockPaths = (tokenId: string) => ({
  base: `base-${tokenId}-00000000000000a1`,
  monad: `monad-${tokenId}-00000000000000a1`,
  solana: `sol-${tokenId}-00000000000000a1`,
});

const DAY_MS = 86_400_000;

/** Rolling 24 h window like contract v2: drop spends older than a day, refresh the derived view fields. */
function rollWindow(v: VaultView, now: number): bigint {
  v.spends = (v.spends ?? []).filter((s) => s.ms + DAY_MS > now);
  const spent = v.spends.reduce((a, s) => a + BigInt(s.amount), 0n);
  v.daily_spent = String(spent);
  v.daily_window_start_ms = v.spends.length ? Math.min(...v.spends.map((s) => s.ms)) : 0;
  return spent;
}

export function mockAgentPay(
  v: VaultView,
  now: number,
  receiver: string,
  amount: bigint,
): { allowed: boolean; reason?: string; logs: string[] } {
  const spent = rollWindow(v, now);
  const deny = (reason: string) => {
    push(v, now, 'agent_pay_denied', reason);
    return { allowed: false, reason, logs: [event('agent_pay_denied', { token_id: v.token_id, receiver_id: receiver, amount: String(amount), reason })] };
  };
  if (v.state === 'Triggered' || v.state === 'Settled') return deny('vault_not_alive');
  if (amount > BigInt(v.policy.per_tx_max)) return deny('over_per_tx_max');
  if (spent + amount > BigInt(v.policy.daily_max)) return deny('over_daily_max');
  if (v.policy.allowlist.length && !v.policy.allowlist.includes(receiver)) return deny('receiver_not_allowlisted');
  if (amount > BigInt(v.balance)) return deny('insufficient_balance');
  v.balance = String(BigInt(v.balance) - amount);
  v.spends!.push({ ms: now, amount: String(amount) });
  rollWindow(v, now);
  push(v, now, 'agent_pay_allowed', `${amount} -> ${receiver}`);
  return {
    allowed: true,
    logs: [event('agent_pay_allowed', { token_id: v.token_id, receiver_id: receiver, amount: String(amount) })],
  };
}

/** Fill the derived view fields like the contract's get_vault does. */
export function decorate(v: VaultView, now: number): VaultView {
  return {
    ...JSON.parse(JSON.stringify(v)),
    state: deriveState(v, now),
    warning_at_ms: v.last_beat_ms + v.heartbeat_interval_s * 1000,
    trigger_at_ms: triggerAtMs(v),
  };
}

// ------------------------------------------------------------------- store + backend

interface Store {
  vaults: Record<string, VaultView>;
  txCounter: number;
}

export const defaultMockFile = () => process.env.DMW_MOCK_FILE || resolve(KEEPER_DIR, '.mock-state.json');

export class MockBackend implements Backend {
  readonly label = 'mock';
  constructor(
    private file = defaultMockFile(),
    private clock: () => number = Date.now,
    private seed: MockOpts = {
      heartbeat_interval_s: Number(process.env.DMW_MOCK_INTERVAL || 20),
      grace_missed: Number(process.env.DMW_MOCK_GRACE || 1),
    },
  ) {}

  private load(): Store {
    if (existsSync(this.file)) return JSON.parse(readFileSync(this.file, 'utf8')) as Store;
    const v = mockCreate(this.clock(), this.seed);
    const s: Store = { vaults: { [v.token_id]: v }, txCounter: 0 };
    this.save(s);
    return s;
  }
  private save(s: Store) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(s, null, 2));
  }
  reset(opts: MockOpts = this.seed): VaultView {
    if (existsSync(this.file)) rmSync(this.file);
    const v = mockCreate(this.clock(), opts);
    this.save({ vaults: { [v.token_id]: v }, txCounter: 0 });
    return v;
  }
  private mutate<R>(tokenId: string, fn: (v: VaultView, now: number) => R): { result: R; hash: string } {
    const s = this.load();
    const v = s.vaults[tokenId];
    if (!v) throw new Error(`vault ${tokenId} not found (mock)`);
    const result = fn(v, this.clock());
    s.txCounter += 1;
    this.save(s);
    return { result, hash: `mock${String(s.txCounter).padStart(4, '0')}${Math.random().toString(36).slice(2, 6)}` };
  }

  async getVaults() {
    const s = this.load();
    const now = this.clock();
    return Object.values(s.vaults).map((v) => decorate(v, now));
  }
  async getVault(tokenId: string) {
    const v = this.load().vaults[tokenId];
    if (!v) throw new Error(`vault ${tokenId} not found (mock)`);
    return decorate(v, this.clock());
  }
  async heartbeat(tokenId: string): Promise<TxResult> {
    const { result, hash } = this.mutate(tokenId, (v, now) => mockHeartbeat(v, now));
    return { hash, logs: result, returnValue: null };
  }
  async poke(tokenId: string): Promise<TxResult> {
    const { result, hash } = this.mutate(tokenId, (v, now) => mockPoke(v, now));
    return { hash, logs: result, returnValue: null };
  }
  /** in-memory sign tracks ("token:index"), like the contract's get_sign_track (the fees are the last SIGNED ones, v3 L-3) */
  tracks = new Map<string, SignTrack>();
  /** v3: keeper re-signs of a signed Solana payout, with the keeper epoch they were counted in ("token:index"). */
  keeperResigns = new Map<string, { used: number; epoch: number }>();
  /** v3: the contract's keeper epoch (a keeper change bumps it and resets the Solana re-sign counters). */
  keeperEpoch = 0;
  /** tests flip this to emulate a non-keeper caller on a signed Solana payout */
  callerIsKeeper = true;
  private track(tokenId: string, index: number, evm: StepArgs['evm'] | undefined, chain: string, now: number) {
    this.tracks.set(`${tokenId}:${index}`, {
      last_request_ms: now,
      inflight: false,
      max_fee_per_gas: chain !== 'solana' ? (evm?.max_fee_per_gas ?? '0') : '0',
      max_priority_fee_per_gas: chain !== 'solana' ? (evm?.max_priority_fee_per_gas ?? '0') : '0',
      resign_allowed_after_ms: now + 300_000,
    });
  }
  private keeperResignsUsed(tokenId: string, index: number): number {
    const k = this.keeperResigns.get(`${tokenId}:${index}`);
    return k && k.epoch === this.keeperEpoch ? k.used : 0;
  }
  async isKeeperFor(): Promise<boolean> {
    return this.callerIsKeeper;
  }
  /**
   * Tests set this to the caller's account id. Then the mock enforces the contract's step III window (only an
   * operator signs during the first `config.step3_open_after_ms` of each payout) and the keeper checks it too.
   * Unset (the default): no window, as before.
   */
  accountId?: string;
  config: ContractConfig & { contract: string } = {
    contract: 'dmw-mock.testnet',
    owner_id: 'dmw-mock.testnet',
    keeper: null,
    step3_open_after_ms: 3_600_000,
    pending_keeper: null,
    keeper_admin: null,
    admin_timelock_ms: 172_800_000,
    admin_proposal: null,
    keeper_epoch: 0,
    max_keeper_solana_resigns: MOCK_LIMITS.maxKeeperSolanaResigns,
    sale_min_interval_s: 86_400,
    sale_min_grace: 1,
    chains: [
      { chain: 'base', kind: 'evm', max_fee_per_gas: String(MOCK_LIMITS.feeCap.base), non_keeper_max_fee_per_gas: String(MOCK_LIMITS.nonKeeperClamp.base), max_payouts: 4, min_gas_limit: String(MOCK_LIMITS.minGasLimit) },
      { chain: 'monad', kind: 'evm', max_fee_per_gas: String(MOCK_LIMITS.feeCap.monad), non_keeper_max_fee_per_gas: String(MOCK_LIMITS.nonKeeperClamp.monad), max_payouts: 1, min_gas_limit: String(MOCK_LIMITS.minGasLimit) },
      { chain: 'solana', kind: 'solana', max_payouts: 1, max_keeper_resigns: MOCK_LIMITS.maxKeeperSolanaResigns },
    ],
  };
  async getConfig(): Promise<ContractConfig> {
    const { contract: _c, ...c } = this.config;
    return { ...c, keeper_epoch: this.keeperEpoch };
  }
  async getSignTrack(tokenId: string, index: number): Promise<SignTrack> {
    const t = this.tracks.get(`${tokenId}:${index}`) ?? { last_request_ms: 0, inflight: false, max_fee_per_gas: '0', max_priority_fee_per_gas: '0', resign_allowed_after_ms: 300_000 };
    const used = this.keeperResignsUsed(tokenId, index);
    return { ...t, keeper_resigns: used, keeper_resigns_left: Math.max(0, MOCK_LIMITS.maxKeeperSolanaResigns - used) };
  }
  /** `set_foreign_payouts` (owner, 1 yocto on chain): validates like contract v3. */
  async setForeignPayouts(tokenId: string, payouts: Pick<VaultView['foreign'][number], 'chain' | 'to' | 'amount' | 'from_address'>[]): Promise<TxResult> {
    const { hash } = this.mutate(tokenId, (v, now) => mockSetForeignPayouts(v, payouts, now));
    return { hash, logs: [], returnValue: null };
  }
  async executeStep(tokenId: string, args?: StepArgs): Promise<TxResult> {
    const before = this.load().vaults[tokenId];
    const idx = before && before.step === 3 ? before.foreign_index : -1;
    const chain = before?.foreign[idx]?.chain;
    let skipped = false;
    const { result, hash } = this.mutate(tokenId, (v, now) => {
      if (this.accountId !== undefined && v.state === 'Triggered' && v.step === 3 && v.foreign_index < v.foreign.length) {
        const start = step3ProgressMs(v) ?? 0;
        const operator = isOperator(this.accountId, v, this.config, this.config.contract);
        if (!operator && now < start + (this.config.step3_open_after_ms ?? 0))
          throw new Error('Smart contract panicked: step 3: during the first hour only the keeper, the vault owner or an heir may sign a payout');
        if (!operator && v.foreign[v.foreign_index].chain === 'solana') {
          // v3 (M-1): a Solana blockhash only ever comes from an operator. After the hour a stranger's step 3 records
          // the payout failed without a signature (no sign track is written), so settlement moves on.
          skipped = true;
          const i = v.foreign_index;
          const p = v.foreign[i];
          p.status = 'failed';
          p.signed_tx = null;
          v.foreign_index += 1;
          push(v, now, 'foreign_failed', `#${i} ${MOCK_SKIPPED_DETAIL}`);
          if (v.foreign_index >= v.foreign.length) {
            v.step = 4;
            push(v, now, 'step_3', 'foreign payouts done');
          }
          return { logs: [], step: v.step };
        }
      }
      return mockExecuteStep(v, now, args);
    });
    if (chain && !skipped) this.track(tokenId, idx, args?.evm, chain, this.clock());
    return { hash, logs: result.logs, returnValue: result.step };
  }
  async markBroadcast(tokenId: string, index: number, txHash: string): Promise<TxResult> {
    const { hash } = this.mutate(tokenId, (v, now) => mockMarkBroadcast(v, index, txHash, now));
    return { hash, logs: [], returnValue: null };
  }
  /**
   * Contract v3 `resign_foreign` (foreign.rs): cooldown for every payout; a signed/broadcast Solana payout only by a
   * keeper, at most 3 times per keeper epoch (a failed one, e.g. skipped by M-1, costs no allowance); EVM fees within
   * the chain cap, a non-keeper's clamped to the chain's non-keeper limit and then checked: above-clamp last fees may
   * only be replaced at exactly the clamp (H-1(3)), otherwise both fees +10% (or at the cap).
   */
  async resignForeign(tokenId: string, index: number, args: StepArgs): Promise<TxResult> {
    const { hash } = this.mutate(tokenId, (v, now) => {
      const p = v.foreign[index];
      if (!p || p.status === 'pending') throw new Error('payout is pending');
      if (this.accountId !== undefined && !this.callerIsKeeper && !isOperator(this.accountId, v, this.config, this.config.contract))
        throw new Error('Smart contract panicked: only the keeper, the vault owner or an heir may re-sign a payout');
      const key = `${tokenId}:${index}`;
      const t = this.tracks.get(key);
      const hasSig = p.status === 'signed' || p.status === 'broadcast';
      if (t && now < t.resign_allowed_after_ms) throw new Error('resign cooldown: wait 5 min after the last request');
      let evm = args.evm;
      if (p.chain === 'solana') {
        if (!args.solana?.recent_blockhash) throw new Error('args.solana is required for a solana payout');
        if (hasSig && !this.callerIsKeeper) throw new Error('only the keeper may re-sign a signed or broadcast solana payout (no nonce: a new signature is a second payment)');
        if (hasSig) {
          const used = this.keeperResignsUsed(tokenId, index);
          if (used >= MOCK_LIMITS.maxKeeperSolanaResigns)
            throw new Error(`Smart contract panicked: keeper re-sign limit reached for this solana payout (${MOCK_LIMITS.maxKeeperSolanaResigns} per keeper)`);
          this.keeperResigns.set(key, { used: used + 1, epoch: this.keeperEpoch });
        }
      } else {
        const chain = p.chain;
        if (!evm) throw new Error(`args.evm is required for an evm payout`);
        const cap = MOCK_LIMITS.feeCap[chain];
        if (BigInt(evm.gas_limit) < 21000n || BigInt(evm.gas_limit) > MOCK_LIMITS.maxGasLimit) throw new Error('gas_limit out of range');
        if (BigInt(evm.max_fee_per_gas) > cap) throw new Error('max_fee_per_gas above cap');
        if (!this.callerIsKeeper) {
          const clamp = MOCK_LIMITS.nonKeeperClamp[chain];
          const max = BigInt(evm.max_fee_per_gas) < clamp ? BigInt(evm.max_fee_per_gas) : clamp;
          const prio = BigInt(evm.max_priority_fee_per_gas) < max ? BigInt(evm.max_priority_fee_per_gas) : max;
          evm = { ...evm, max_fee_per_gas: String(max), max_priority_fee_per_gas: String(prio), gas_limit: String(MOCK_LIMITS.minGasLimit) };
          if (hasSig && t) {
            const lastMax = BigInt(t.max_fee_per_gas);
            const lastPrio = BigInt(t.max_priority_fee_per_gas);
            if (lastMax > clamp || lastPrio > clamp) {
              if (!(max === clamp && prio >= (lastPrio < clamp ? lastPrio : clamp)))
                throw new Error("Smart contract panicked: re-sign below a keeper's fee: max_fee_per_gas must be the non-keeper limit and the priority fee may not drop");
            } else {
              // second review F4: a fee at the cap counts as a bump
              const bumped = (n: bigint, last: bigint) => n >= cap || n * 100n >= last * 110n;
              if (!(bumped(max, lastMax) && bumped(prio, lastPrio))) throw new Error('re-sign of a signed evm payout must raise both fees by >= 10% (or to the chain cap)');
            }
          }
        }
      }
      p.status = 'signed';
      p.tx_hash = null;
      p.signed_tx = `${p.signed_tx ?? 'mock'}r`;
      // L-3: the track takes the new fees only once the signature exists (always, in the mock).
      this.track(tokenId, index, evm, p.chain, now);
    });
    return { hash, logs: [], returnValue: 'signed' };
  }
  async agentPay(a: AgentPayArgs): Promise<TxResult> {
    const { result, hash } = this.mutate(a.token_id, (v, now) => mockAgentPay(v, now, a.receiver_id, BigInt(a.amount)));
    return { hash, logs: result.logs, returnValue: result.allowed ? { allowed: true } : { allowed: false, reason: result.reason } };
  }
}

export function mockChains(): Chains {
  let nonce = 0;
  const sent = new Set<string>();
  return {
    async deriveAddresses(_c, paths) {
      const tokenId = paths.base.split('-')[1] ?? '0';
      return { base: `0xMOCK${tokenId.padStart(36, '0')}`, monad: `0xMONAD${tokenId.padStart(35, '0')}`, solana: `MOCKsol${tokenId}` };
    },
    async evmParams() {
      return { nonce: nonce++, max_fee_per_gas: '1500000000', max_priority_fee_per_gas: '1000000', gas_limit: '21000' };
    },
    async solanaParams() {
      return { recent_blockhash: `MOCKblockhash${Date.now()}` };
    },
    async broadcastEvm(raw) {
      const h = `mock0xevm${raw.slice(-6)}`;
      sent.add(h);
      return h;
    },
    async broadcastSolana(raw) {
      const h = `mocksolsig${raw.slice(-6)}`;
      sent.add(h);
      return h;
    },
    async txLanded(_chain, id) {
      return sent.has(id);
    },
  };
}
