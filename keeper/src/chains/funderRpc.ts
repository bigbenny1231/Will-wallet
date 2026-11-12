// The chain reads and writes the funder needs, behind one interface so tests can replace every RPC call.
import { broadcastEvm, chainConfig, getEvmStepArgs, rpc as evmRpc, type EvmChainName } from './evm.js';
import { broadcastSolana, rpc as solRpc, SOLANA_DEVNET_RPC } from './solana.js';

export interface EvmQuote {
  /** pending nonce of the sender */
  nonce: number;
  /** 2 x base fee + priority fee, held at the contract's per-chain cap: exactly what the keeper signs payouts with */
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface EvmReceipt {
  /** false: included but reverted (it still used the nonce and paid gas) */
  ok: boolean;
  blockNumber: bigint;
}

export interface SolStatus {
  /** `confirmed` or `finalized` */
  confirmed: boolean;
  err: unknown;
}

export interface FundingRpc {
  evmBalance(chain: EvmChainName, address: string): Promise<bigint>;
  evmQuote(chain: EvmChainName, from: string): Promise<EvmQuote>;
  /** nonce of the next tx to be mined (eth_getTransactionCount at `latest`) */
  evmMinedNonce(chain: EvmChainName, address: string): Promise<number>;
  evmSend(chain: EvmChainName, rawHex: string): Promise<string>;
  evmReceipt(chain: EvmChainName, hash: string): Promise<EvmReceipt | null>;
  evmBlockNumber(chain: EvmChainName): Promise<bigint>;
  solBalance(address: string): Promise<bigint>;
  solBlockhash(): Promise<string>;
  /** getMinimumBalanceForRentExemption(0) */
  solRentMin(): Promise<bigint>;
  solSend(rawBase64: string): Promise<string>;
  solStatus(signature: string): Promise<SolStatus | null>;
}

/** The real RPCs: BASE_RPC / MONAD_RPC (via chainConfig) and SOLANA_RPC. */
export function realFundingRpc(o: { solanaRpc?: string } = {}): FundingRpc {
  const url = (c: EvmChainName) => chainConfig(c).rpc;
  const sol = o.solanaRpc || SOLANA_DEVNET_RPC;
  return {
    async evmBalance(c, a) {
      return BigInt(await evmRpc<string>(url(c), 'eth_getBalance', [a, 'latest']));
    },
    async evmQuote(c, from) {
      // the same pricing as the payout's step-3 args (chains/evm.ts getEvmStepArgs)
      const a = await getEvmStepArgs(from, c);
      return { nonce: a.nonce, maxFeePerGas: BigInt(a.max_fee_per_gas), maxPriorityFeePerGas: BigInt(a.max_priority_fee_per_gas) };
    },
    async evmMinedNonce(c, a) {
      return Number(BigInt(await evmRpc<string>(url(c), 'eth_getTransactionCount', [a, 'latest'])));
    },
    evmSend: (c, raw) => broadcastEvm(raw, url(c)),
    async evmReceipt(c, hash) {
      const r = await evmRpc<{ status?: string; blockNumber?: string } | null>(url(c), 'eth_getTransactionReceipt', [hash]);
      if (!r || !r.blockNumber) return null;
      return { ok: r.status === '0x1', blockNumber: BigInt(r.blockNumber) };
    },
    async evmBlockNumber(c) {
      return BigInt(await evmRpc<string>(url(c), 'eth_blockNumber', []));
    },
    async solBalance(a) {
      return BigInt((await solRpc<{ value: number }>(sol, 'getBalance', [a, { commitment: 'confirmed' }])).value);
    },
    async solBlockhash() {
      return (await solRpc<{ value: { blockhash: string } }>(sol, 'getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
    },
    async solRentMin() {
      return BigInt(await solRpc<number>(sol, 'getMinimumBalanceForRentExemption', [0]));
    },
    solSend: (raw) => broadcastSolana(raw, sol),
    async solStatus(sig) {
      const r = await solRpc<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>(sol, 'getSignatureStatuses', [[sig]]);
      const s = r.value?.[0];
      if (!s) return null;
      return { confirmed: s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized', err: s.err ?? null };
    },
  };
}
