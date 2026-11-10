// DMW_MOCK=1: an in-memory (file-persisted) vault that follows SPEC §2.2 / §2.4 so pulse + keeper
// can be demoed and unit-tested before any contract exists. State is shared between processes via a JSON file.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Backend } from './backend.js';
import type { Chains } from './chainsApi.js';
import { KEEPER_DIR } from './config.js';
import { bpsShare, deriveState, isDue, triggerAtMs } from './machine.js';
import type { AgentPayArgs, SignTrack, StepArgs, TxResult, VaultView } from './types.js';

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
    daily_window_start_ms: now,
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
        push(v, now, 'step_3', `signed payout ${v.foreign_index - 1} (${p.chain})`);
      }
      if (v.foreign_index >= v.foreign.length) v.step = 4;
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

export function mockAgentPay(
  v: VaultView,
  now: number,
  receiver: string,
  amount: bigint,
): { allowed: boolean; reason?: string; logs: string[] } {
  if (now - v.daily_window_start_ms >= 86_400_000) {
    v.daily_window_start_ms = now;
    v.daily_spent = '0';
  }
  const deny = (reason: string) => {
    push(v, now, 'agent_pay_denied', reason);
    return { allowed: false, reason, logs: [event('agent_pay_denied', { token_id: v.token_id, receiver_id: receiver, amount: String(amount), reason })] };
  };
  if (v.state === 'Triggered' || v.state === 'Settled') return deny('vault_not_alive');
  if (amount > BigInt(v.policy.per_tx_max)) return deny('over_per_tx_max');
  if (BigInt(v.daily_spent) + amount > BigInt(v.policy.daily_max)) return deny('over_daily_max');
  if (v.policy.allowlist.length && !v.policy.allowlist.includes(receiver)) return deny('receiver_not_allowlisted');
  if (amount > BigInt(v.balance)) return deny('insufficient_balance');
  v.balance = String(BigInt(v.balance) - amount);
  v.daily_spent = String(BigInt(v.daily_spent) + amount);
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
  /** in-memory sign tracks ("token:index"), like the contract's get_sign_track */
  tracks = new Map<string, SignTrack>();
  /** tests flip this to emulate a non-keeper caller on a signed Solana payout */
  callerIsKeeper = true;
  private track(tokenId: string, index: number, args: StepArgs | undefined, chain: string, now: number) {
    this.tracks.set(`${tokenId}:${index}`, {
      last_request_ms: now,
      inflight: false,
      max_fee_per_gas: chain !== 'solana' ? (args?.evm?.max_fee_per_gas ?? '0') : '0',
      max_priority_fee_per_gas: chain !== 'solana' ? (args?.evm?.max_priority_fee_per_gas ?? '0') : '0',
      resign_allowed_after_ms: now + 300_000,
    });
  }
  async getSignTrack(tokenId: string, index: number): Promise<SignTrack> {
    return this.tracks.get(`${tokenId}:${index}`) ?? { last_request_ms: 0, inflight: false, max_fee_per_gas: '0', max_priority_fee_per_gas: '0', resign_allowed_after_ms: 300_000 };
  }
  async executeStep(tokenId: string, args?: StepArgs): Promise<TxResult> {
    const before = this.load().vaults[tokenId];
    const idx = before && before.step === 3 ? before.foreign_index : -1;
    const chain = before?.foreign[idx]?.chain;
    const { result, hash } = this.mutate(tokenId, (v, now) => mockExecuteStep(v, now, args));
    if (chain) this.track(tokenId, idx, args, chain, this.clock());
    return { hash, logs: result.logs, returnValue: result.step };
  }
  async markBroadcast(tokenId: string, index: number, txHash: string): Promise<TxResult> {
    const { hash } = this.mutate(tokenId, (v, now) => mockMarkBroadcast(v, index, txHash, now));
    return { hash, logs: [], returnValue: null };
  }
  async resignForeign(tokenId: string, index: number, args: StepArgs): Promise<TxResult> {
    const { hash } = this.mutate(tokenId, (v, now) => {
      const p = v.foreign[index];
      if (!p || p.status === 'pending') throw new Error('payout is pending');
      const t = this.tracks.get(`${tokenId}:${index}`);
      const hasSig = p.status === 'signed' || p.status === 'broadcast';
      const cooled = !t || now >= t.resign_allowed_after_ms;
      if (p.chain === 'solana') {
        if (!cooled) throw new Error('resign cooldown: wait 5 min after the last request');
        if (hasSig && !this.callerIsKeeper) throw new Error('only the contract owner or keeper may re-sign a signed solana payout');
      } else {
        const e = args.evm;
        if (!e) throw new Error('args.evm is required for a base payout');
        if (BigInt(e.gas_limit) < 21000n || BigInt(e.gas_limit) > 100000n) throw new Error('gas_limit out of range');
        if (BigInt(e.max_fee_per_gas) > 100_000_000_000n) throw new Error('max_fee_per_gas above cap');
        if (hasSig && t && (BigInt(e.max_fee_per_gas) * 100n < BigInt(t.max_fee_per_gas) * 110n || BigInt(e.max_priority_fee_per_gas) * 100n < BigInt(t.max_priority_fee_per_gas) * 110n))
          throw new Error('re-sign of a signed evm payout must raise both fees by >= 10%');
        if (p.status === 'broadcast' && !cooled) throw new Error('resign cooldown: wait 5 min after the last request');
      }
      p.status = 'signed';
      p.tx_hash = null;
      p.signed_tx = `${p.signed_tx ?? 'mock'}r`;
      this.track(tokenId, index, args, p.chain, now);
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
    async deriveAddresses(_c, tokenId) {
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
