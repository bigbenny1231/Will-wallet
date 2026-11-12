// Funding of foreign payout sources. Each vault's foreign payouts leave per-vault MPC-derived source addresses
// (Base Sepolia, Monad testnet, Solana devnet) that nobody else funds. The funder wallet (derived from KEEPER_SEED,
// chains/funderKeys.ts) tops each source up to exactly what its unbroadcast payouts need, under hard caps.
import { inspect } from 'node:util';
import { decodeEip1559, evmTxMaxCost, signEip1559 } from './chains/evmTx.js';
import { chainConfig, type EvmChainName } from './chains/evm.js';
import { deriveFunderKeys, type FunderKeys } from './chains/funderKeys.js';
import type { FundingRpc } from './chains/funderRpc.js';
import { LAMPORTS_PER_SIGNATURE, parseSolTransfer, signSolTransfer } from './chains/solanaTx.js';
import type { ChainName, VaultView } from './types.js';
import { errMsg, foreignTxLink, sleep } from './util.js';

export const UNIT: Record<ChainName, { decimals: number; symbol: string }> = {
  base: { decimals: 18, symbol: 'ETH' },
  monad: { decimals: 18, symbol: 'MON' },
  solana: { decimals: 9, symbol: 'SOL' },
};

/** Exact decimal string ("0.002") to base units (wei / lamports). Refuses more decimals than the unit has. */
export function parseAmount(s: string, decimals: number): bigint {
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`"${s}" is not a decimal amount`);
  const [w, f = ''] = t.split('.');
  if (f.length > decimals) throw new Error(`"${s}" has more than ${decimals} decimals`);
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Base units to a trimmed decimal string with the symbol: 2000000000000000n, base -> "0.002 ETH". */
export function formatAmount(n: bigint, chain: ChainName): string {
  const { decimals, symbol } = UNIT[chain];
  const neg = n < 0n;
  const a = neg ? -n : n;
  const w = a / 10n ** BigInt(decimals);
  const f = (a % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${w}${f ? '.' + f : ''} ${symbol}`;
}

export type PerChain = Record<ChainName, bigint>;

export interface FundCaps {
  /** largest single top-up per chain (FUND_CAP_ETH / FUND_CAP_MON / FUND_CAP_SOL) */
  perTopUp: PerChain;
  /** most this process sends per chain in total (FUND_RUN_CAP_ETH / FUND_RUN_CAP_MON / FUND_RUN_CAP_SOL) */
  perRun: PerChain;
}

export const DEFAULT_CAPS = {
  perTopUp: { base: '0.002', monad: '0.05', solana: '0.02' },
  perRun: { base: '0.01', monad: '0.25', solana: '0.1' },
} as const;

const ENV_SUFFIX: Record<ChainName, string> = { base: 'ETH', monad: 'MON', solana: 'SOL' };

export function capsFromEnv(env: Record<string, string | undefined> = process.env): FundCaps {
  const read = (prefix: string, defaults: Record<ChainName, string>): PerChain => {
    const out = {} as PerChain;
    for (const c of ['base', 'monad', 'solana'] as ChainName[]) {
      const name = `${prefix}_${ENV_SUFFIX[c]}`;
      const raw = (env[name] ?? '').trim() || defaults[c];
      try {
        out[c] = parseAmount(raw, UNIT[c].decimals);
      } catch (e) {
        throw new Error(`${name}: ${errMsg(e)}`);
      }
    }
    return out;
  };
  return { perTopUp: read('FUND_CAP', DEFAULT_CAPS.perTopUp), perRun: read('FUND_RUN_CAP', DEFAULT_CAPS.perRun) };
}

/** Owner prefix of the dashboard's throwaway guest accounts (dashboard/src/pages/Try.tsx). */
export const GUEST_PREFIX = 'dmw-guest-';
/**
 * The payouts the dashboard's guest mode creates (dashboard/src/pages/Try.tsx): 0.0001 ETH on Base Sepolia and
 * 0.001 SOL on Solana devnet, no Monad payout. A guest vault is funded only when every payout is within these.
 */
export const GUEST_MAX: PerChain = { base: 100_000_000_000_000n, monad: 0n, solana: 1_000_000n };

/** Gas limit the contract signs EVM payouts with (foreign.rs EVM_GAS_LIMIT_FLOOR, final audit H-5). */
export const PAYOUT_GAS_LIMIT = 50_000n;
/** Gas of the funder's own native transfer. */
export const TRANSFER_GAS = 21_000n;
/**
 * Monad reserve-balance rule (docs.monad.xyz/developer-essentials/reserve-balance): consensus checks a sender against
 * its balance as of block n - k, and a tx may only dip below 10 MON when the sender sent nothing in the last k blocks.
 * k = 3.
 */
export const MONAD_RESERVE_K = 3n;

export interface SourceSet {
  base: string;
  monad: string;
  solana: string;
}

export interface TopUp {
  chain: ChainName;
  source: string;
  /** payout indexes this source pays */
  indexes: number[];
  balance: bigint;
  /** what the source must hold for its payouts */
  need: bigint;
  /** what the funder sends (0 = enough already) */
  shortfall: bigint;
  status: 'enough' | 'funded' | 'skipped' | 'failed';
  reason?: string;
  hash?: string;
  link?: string;
}

/**
 * The top-up of a Solana source that pays `count` payouts needing `need` lamports in total (amounts + 5000 lamport
 * fee each). Every balance the source passes through must be 0 or at least the rent-exempt minimum, so:
 *  - one payout, empty or short source: fund to exactly `need`, the payout empties it (a fresh account must itself
 *    receive at least the rent-exempt minimum; if `need` is smaller, fund need + rent and leave rent behind);
 *  - otherwise leave at least `rentMin` behind after the last payout.
 */
export function solanaShortfall(balance: bigint, need: bigint, rentMin: bigint, count: number): bigint {
  if (count <= 0) return 0n;
  if (count === 1) {
    if (balance >= need) {
      const rest = balance - need;
      return rest === 0n || rest >= rentMin ? 0n : rentMin - rest;
    }
    const t = need - balance;
    // A fresh (or pre-rent) account cannot be created with less than the rent-exempt minimum.
    if (balance + t < rentMin) return need + rentMin - balance;
    return t;
  }
  const target = need + rentMin;
  return balance >= target ? 0n : target - balance;
}

export interface FundLog {
  ok(tag: string, msg: string): void;
  warn(tag: string, msg: string): void;
  err(tag: string, msg: string): void;
  info(tag: string, msg: string): void;
}

export interface FunderOpts {
  keys: FunderKeys;
  rpc: FundingRpc;
  caps: FundCaps;
  log: FundLog;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => number;
  /** confirmation timeouts */
  evmTimeoutMs?: number;
  solTimeoutMs?: number;
  pollMs?: number;
}

/** Why a vault's sources are not funded at all (guest rules), or null. */
export function guestRefusal(v: Pick<VaultView, 'owner_id' | 'foreign'>): string | null {
  if (!v.owner_id.startsWith(GUEST_PREFIX)) return null;
  for (const [i, p] of v.foreign.entries()) {
    let amount: bigint;
    try {
      amount = BigInt(p.amount);
    } catch {
      return `payout #${i} has an unreadable amount`;
    }
    if (amount > GUEST_MAX[p.chain]) {
      return GUEST_MAX[p.chain] === 0n
        ? `guest vault with a ${p.chain} payout (guest mode creates none)`
        : `guest vault payout #${i} of ${formatAmount(amount, p.chain)} is above the guest amount ${formatAmount(GUEST_MAX[p.chain], p.chain)}`;
    }
  }
  return null;
}

/**
 * The funder: one per process, so the per-run caps hold across every vault the process funds. The keys stay inside
 * this object; it prints as its addresses only.
 */
export class Funder {
  readonly evmAddress: string;
  readonly solanaAddress: string;
  /** sent so far by this process, per chain (counted when a top-up is sent, even if its confirmation times out) */
  readonly spent: PerChain = { base: 0n, monad: 0n, solana: 0n };
  #keys: FunderKeys;
  private rpc: FundingRpc;
  private caps: FundCaps;
  private log: FundLog;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private o: FunderOpts;

  constructor(o: FunderOpts) {
    this.#keys = o.keys;
    this.evmAddress = o.keys.evmAddress;
    this.solanaAddress = o.keys.solanaAddress;
    this.rpc = o.rpc;
    this.caps = o.caps;
    this.log = o.log;
    this.sleep = o.sleepFn ?? sleep;
    this.now = o.now ?? Date.now;
    this.o = o;
  }

  static fromSeed(seed: string, o: Omit<FunderOpts, 'keys'>): Funder {
    return new Funder({ ...o, keys: deriveFunderKeys(seed) });
  }

  toJSON() {
    return { evmAddress: this.evmAddress, solanaAddress: this.solanaAddress };
  }
  [inspect.custom]() {
    return `Funder(${this.evmAddress}, ${this.solanaAddress})`;
  }

  async balances(): Promise<PerChain> {
    const [base, monad, solana] = await Promise.all([
      this.rpc.evmBalance('base', this.evmAddress),
      this.rpc.evmBalance('monad', this.evmAddress),
      this.rpc.solBalance(this.solanaAddress),
    ]);
    return { base, monad, solana };
  }

  /**
   * What each source of `v` must hold, grouped by (chain, source). `broadcast` payouts are skipped (already relayed).
   * A signed EVM payout needs exactly value + gasLimit x maxFee of its signed tx; an unsigned one needs amount +
   * 2 x 50 000 gas x the current max fee (2 x base fee + priority, the price the keeper signs with).
   */
  async plan(v: VaultView, sources: SourceSet, only?: Set<number>): Promise<TopUp[]> {
    const groups = new Map<string, { chain: ChainName; source: string; indexes: number[]; need: bigint }>();
    const group = (chain: ChainName, source: string) => {
      const key = `${chain}:${source}`;
      const g = groups.get(key) ?? { chain, source, indexes: [], need: 0n };
      groups.set(key, g);
      return g;
    };
    const quotes = new Map<EvmChainName, { mined: number; maxFeePerGas: bigint }>();
    for (const [i, p] of v.foreign.entries()) {
      if (only && !only.has(i)) continue;
      const source = p.chain === 'solana' ? sources.solana : sources[p.chain];
      if (p.chain === 'solana') {
        if (p.status === 'broadcast') continue;
        let need = BigInt(p.amount) + LAMPORTS_PER_SIGNATURE;
        if (p.signed_tx) {
          let t: ReturnType<typeof parseSolTransfer> | undefined;
          try {
            t = parseSolTransfer(p.signed_tx);
          } catch {
            /* keep the amount-based need */
          }
          if (t && t.from === source) {
            // Relayed by someone else but not marked yet: it already took its lamports.
            if (await this.rpc.solStatus(t.signature).catch(() => null)) continue;
            need = t.lamports + LAMPORTS_PER_SIGNATURE;
          }
        }
        const g = group('solana', source);
        g.indexes.push(i);
        g.need += need;
        continue;
      }
      let q = quotes.get(p.chain);
      if (q === undefined) {
        const [quote, mined] = await Promise.all([this.rpc.evmQuote(p.chain, source), this.rpc.evmMinedNonce(p.chain, source)]);
        q = { mined, maxFeePerGas: quote.maxFeePerGas };
        quotes.set(p.chain, q);
      }
      let need = 0n;
      if (p.signed_tx) {
        let t: ReturnType<typeof decodeEip1559> | undefined;
        try {
          t = decodeEip1559(p.signed_tx);
        } catch {
          /* fall through to the estimate */
        }
        if (t && t.from.toLowerCase() === source.toLowerCase()) {
          // Mined: it already took its funds.
          if (t.nonce < q.mined) continue;
          need = evmTxMaxCost(t);
        }
      }
      if (p.status === 'broadcast') {
        // Relayed but not mined yet: never topped up for, but what it will take is still in the balance, so the
        // other payouts of this source must not count on it.
        if (need > 0n) group(p.chain, source).need += need;
        continue;
      }
      if (need === 0n) need = BigInt(p.amount) + 2n * PAYOUT_GAS_LIMIT * q.maxFeePerGas;
      const g = group(p.chain, source);
      g.indexes.push(i);
      g.need += need;
    }
    const out: TopUp[] = [];
    let rentMin: bigint | undefined;
    for (const g of groups.values()) {
      if (g.indexes.length === 0) continue; // only broadcast payouts: nothing to fund
      const balance = g.chain === 'solana' ? await this.rpc.solBalance(g.source) : await this.rpc.evmBalance(g.chain, g.source);
      let shortfall: bigint;
      if (g.chain === 'solana') {
        rentMin ??= await this.rpc.solRentMin();
        shortfall = solanaShortfall(balance, g.need, rentMin, g.indexes.length);
      } else {
        shortfall = g.need > balance ? g.need - balance : 0n;
      }
      out.push({ chain: g.chain, source: g.source, indexes: g.indexes, balance, need: g.need, shortfall, status: shortfall === 0n ? 'enough' : 'skipped' });
    }
    return out;
  }

  /** Cap check for one top-up; null when it may be sent. */
  capRefusal(chain: ChainName, amount: bigint): string | null {
    if (amount > this.caps.perTopUp[chain])
      return `top-up ${formatAmount(amount, chain)} is above the per-top-up cap ${formatAmount(this.caps.perTopUp[chain], chain)} (FUND_CAP_${ENV_SUFFIX[chain]})`;
    if (this.spent[chain] + amount > this.caps.perRun[chain])
      return `top-up ${formatAmount(amount, chain)} would pass the per-run cap ${formatAmount(this.caps.perRun[chain], chain)} (FUND_RUN_CAP_${ENV_SUFFIX[chain]}; ${formatAmount(this.spent[chain], chain)} sent so far)`;
    return null;
  }

  /**
   * Top up every source of `v` that holds less than its payouts need (or only the payouts in `only`). Sends exactly
   * the shortfall, waits for confirmation, and never throws: each source's outcome is in the result.
   */
  async fundVault(v: VaultView, sources: SourceSet, only?: Set<number>): Promise<TopUp[]> {
    const tag = 'fund';
    const refused = guestRefusal(v);
    if (refused) {
      this.log.warn(tag, `vault ${v.token_id}: not funding (${refused})`);
      return [];
    }
    let plan: TopUp[];
    try {
      plan = await this.plan(v, sources, only);
    } catch (e) {
      this.log.err(tag, `vault ${v.token_id}: could not read the sources (${errMsg(e)})`);
      return [];
    }
    for (const t of plan) {
      const label = `vault ${v.token_id} ${t.chain} source ${t.source} (payout ${t.indexes.map((i) => `#${i}`).join(', ')})`;
      if (t.status === 'enough') {
        this.log.info(tag, `${label} holds ${formatAmount(t.balance, t.chain)}, needs ${formatAmount(t.need, t.chain)}: enough`);
        continue;
      }
      const refusal = this.capRefusal(t.chain, t.shortfall);
      if (refusal) {
        t.status = 'skipped';
        t.reason = refusal;
        this.log.warn(tag, `${label}: not funded, ${refusal}`);
        continue;
      }
      try {
        t.hash = t.chain === 'solana' ? await this.sendSol(t.source, t.shortfall) : await this.sendEvm(t.chain, t.source, t.shortfall);
        t.link = foreignTxLink(t.chain, t.hash);
        t.status = 'funded';
        this.log.ok(tag, `${label} topped up by ${formatAmount(t.shortfall, t.chain)} to ${formatAmount(t.balance + t.shortfall, t.chain)}  ${t.link}`);
      } catch (e) {
        t.status = 'failed';
        t.reason = errMsg(e);
        this.log.err(tag, `${label}: top-up of ${formatAmount(t.shortfall, t.chain)} failed (${t.reason})`);
      }
    }
    return plan;
  }

  private async sendEvm(chain: EvmChainName, to: string, value: bigint): Promise<string> {
    const q = await this.rpc.evmQuote(chain, this.evmAddress);
    const have = await this.rpc.evmBalance(chain, this.evmAddress);
    const cost = value + TRANSFER_GAS * q.maxFeePerGas;
    if (have < cost) throw new Error(`the funder ${this.evmAddress} holds ${formatAmount(have, chain)} on ${chain}, needs ${formatAmount(cost, chain)}`);
    const { raw, hash } = signEip1559(
      { chainId: chainConfig(chain).chainId, nonce: q.nonce, maxFeePerGas: q.maxFeePerGas, maxPriorityFeePerGas: q.maxPriorityFeePerGas, gasLimit: TRANSFER_GAS, to, value },
      this.#keys.evmKey,
    );
    // Counted as spent once it may be on the wire: a timeout below does not make the money come back.
    this.spent[chain] += value;
    const sent = await this.rpc.evmSend(chain, raw);
    if (sent.toLowerCase() !== hash) throw new Error(`node returned ${sent}, expected ${hash}`);
    const deadline = this.now() + (this.o.evmTimeoutMs ?? 120_000);
    for (;;) {
      const r = await this.rpc.evmReceipt(chain, hash).catch(() => null);
      if (r) {
        // Included but reverted (Monad's reserve rule can do this): it paid gas and moved nothing.
        if (!r.ok) throw new Error(`top-up ${hash} was included but reverted`);
        if (chain === 'monad') await this.waitMonadBlocks(r.blockNumber);
        return hash;
      }
      if (this.now() >= deadline) throw new Error(`top-up ${hash} not confirmed in time; check ${foreignTxLink(chain, hash)}`);
      await this.sleep(this.o.pollMs ?? 1_500);
    }
  }

  /**
   * After a Monad top-up, wait until k = 3 blocks have passed. Consensus checks the source against its balance as of
   * block n - 3, so a payout relayed sooner could be refused for a balance it already has, and the funder's next tx
   * must come more than 3 blocks after this one to keep the reserve-rule exception (it may then dip below 10 MON).
   */
  private async waitMonadBlocks(included: bigint): Promise<void> {
    const deadline = this.now() + 30_000;
    while (this.now() < deadline) {
      const n = await this.rpc.evmBlockNumber('monad').catch(() => included);
      if (n >= included + MONAD_RESERVE_K) return;
      await this.sleep(400);
    }
  }

  private async sendSol(to: string, lamports: bigint): Promise<string> {
    const have = await this.rpc.solBalance(this.solanaAddress);
    const cost = lamports + LAMPORTS_PER_SIGNATURE;
    if (have < cost) throw new Error(`the funder ${this.solanaAddress} holds ${formatAmount(have, 'solana')}, needs ${formatAmount(cost, 'solana')}`);
    const rest = have - cost;
    const rentMin = await this.rpc.solRentMin();
    if (rest !== 0n && rest < rentMin) throw new Error(`the funder would be left with ${formatAmount(rest, 'solana')}, below the rent-exempt minimum`);
    const { raw, signature } = signSolTransfer({ from: this.solanaAddress, to, lamports, recentBlockhash: await this.rpc.solBlockhash() }, this.#keys.solanaSeed);
    this.spent.solana += lamports;
    const sent = await this.rpc.solSend(raw);
    if (sent !== signature) throw new Error(`node returned ${sent}, expected ${signature}`);
    const deadline = this.now() + (this.o.solTimeoutMs ?? 60_000);
    for (;;) {
      const s = await this.rpc.solStatus(signature).catch(() => null);
      if (s?.err) throw new Error(`top-up ${signature} failed on chain: ${JSON.stringify(s.err)}`);
      if (s?.confirmed) return signature;
      if (this.now() >= deadline) throw new Error(`top-up ${signature} not confirmed in time; check ${foreignTxLink('solana', signature)}`);
      await this.sleep(this.o.pollMs ?? 1_500);
    }
  }
}
