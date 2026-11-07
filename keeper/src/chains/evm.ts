// EVM helpers for step 3 (every EVM chain in the registry): chain params for execute_step,
// and relay. Mirrors the contract's registry (contracts/dmw/src/foreign.rs, SPEC §1).
import { fromHex, keccak256, toHex } from './codec.js';

export const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const MONAD_TESTNET_RPC = 'https://testnet-rpc.monad.xyz';
export const MONAD_TESTNET_CHAIN_ID = 10143;
export const basescanTx = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;
export const basescanAddress = (a: string) => `https://sepolia.basescan.org/address/${a}`;

export type EvmChainName = 'base' | 'monad';

export interface EvmChainConfig {
  chain: EvmChainName;
  chainId: number;
  /** RPC URL (env override: BASE_RPC / MONAD_RPC). */
  rpc: string;
  /** Derivation path prefix: `<prefix>-<token_id>` (secp256k1, domain 0). */
  pathPrefix: string;
  /** Contract-side cap on max_fee_per_gas, in wei. getEvmStepArgs clamps to it. */
  maxFeePerGas: bigint;
  explorerTx: (hash: string) => string;
  explorerAddress: (address: string) => string;
}

const EVM_CHAINS: Record<EvmChainName, Omit<EvmChainConfig, 'rpc'> & { defaultRpc: string; rpcEnv: string }> = {
  base: {
    chain: 'base', chainId: BASE_SEPOLIA_CHAIN_ID, defaultRpc: BASE_SEPOLIA_RPC, rpcEnv: 'BASE_RPC', pathPrefix: 'base',
    maxFeePerGas: 100_000_000_000n,
    explorerTx: basescanTx, explorerAddress: basescanAddress,
  },
  monad: {
    chain: 'monad', chainId: MONAD_TESTNET_CHAIN_ID, defaultRpc: MONAD_TESTNET_RPC, rpcEnv: 'MONAD_RPC', pathPrefix: 'monad',
    maxFeePerGas: 1_000_000_000_000n,
    explorerTx: (h) => `https://testnet.monadexplorer.com/tx/${h}`,
    explorerAddress: (a) => `https://testnet.monadexplorer.com/address/${a}`,
  },
};

export const EVM_CHAIN_NAMES = Object.keys(EVM_CHAINS) as EvmChainName[];
export const isEvmChain = (chain: string): chain is EvmChainName => chain in EVM_CHAINS;

/** Registry entry for an EVM payout chain (`"base"` | `"monad"`). Throws for anything else. */
export function chainConfig(chain: string, env: Record<string, string | undefined> = process.env): EvmChainConfig {
  if (!isEvmChain(chain)) throw new Error(`not an EVM chain: ${chain}`);
  const { defaultRpc, rpcEnv, ...c } = EVM_CHAINS[chain];
  return { ...c, rpc: env[rpcEnv] || defaultRpc };
}

/** Accepts an RPC URL or a chain name; chain names resolve through chainConfig. */
const rpcOf = (rpcOrChain: string) => (isEvmChain(rpcOrChain) ? chainConfig(rpcOrChain).rpc : rpcOrChain);

/** Explorer link for an EVM tx on `chain`. */
export const evmTxLink = (chain: string, hash: string) => chainConfig(chain).explorerTx(hash);

export interface EvmStepArgs {
  nonce: number;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  gas_limit: string;
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: T; error?: { code: number; message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message} (${j.error.code})`);
  return j.result as T;
}

/**
 * Chain params for a native transfer from `fromAddress`: pending nonce, and fees as
 * max_fee = 2 * baseFee + priority (EIP-1559 headroom for ~6 blocks of base-fee growth).
 */
export async function getEvmStepArgs(fromAddress: string, rpcOrChain: string = BASE_SEPOLIA_RPC): Promise<EvmStepArgs> {
  const baseRpc = rpcOf(rpcOrChain);
  const [nonceHex, block, prioHex] = await Promise.all([
    rpc<string>(baseRpc, 'eth_getTransactionCount', [fromAddress, 'pending']),
    rpc<{ baseFeePerGas: string }>(baseRpc, 'eth_getBlockByNumber', ['latest', false]),
    rpc<string>(baseRpc, 'eth_maxPriorityFeePerGas', []).catch(() => '0xf4240'), // 0.001 gwei
  ]);
  const prio = BigInt(prioHex) > 0n ? BigInt(prioHex) : 1_000_000n;
  let maxFee = BigInt(block.baseFeePerGas) * 2n + prio;
  // Stay inside the contract's per-chain cap (else execute_step panics).
  const cap = isEvmChain(rpcOrChain) ? chainConfig(rpcOrChain).maxFeePerGas
    : Object.values(EVM_CHAINS).find((c) => c.defaultRpc === baseRpc)?.maxFeePerGas;
  if (cap !== undefined && maxFee > cap) maxFee = cap;
  return {
    nonce: Number(BigInt(nonceHex)),
    max_fee_per_gas: maxFee.toString(),
    max_priority_fee_per_gas: (prio > maxFee ? maxFee : prio).toString(),
    gas_limit: '21000',
  };
}

/** keccak256 of the raw signed tx: the tx hash, known before broadcast. */
export const evmTxHash = (rawHex: string) => '0x' + toHex(keccak256(fromHex(rawHex)));

/**
 * eth_sendRawTransaction. Returns the tx hash. Idempotent: "already known" /
 * "nonce too low" for the same tx are treated as already broadcast.
 */
export async function broadcastEvm(rawHex: string, rpcOrChain: string = BASE_SEPOLIA_RPC): Promise<string> {
  const baseRpc = rpcOf(rpcOrChain);
  const raw = rawHex.startsWith('0x') ? rawHex : `0x${rawHex}`;
  const expected = evmTxHash(raw);
  try {
    // The tx id is keccak256(raw), known locally. Never trust the node's answer for it: a wrong hash would make
    // mark_broadcast fail (the contract checks it, H-1) and stall the payout (AUDIT_FINAL_OFFCHAIN F-07).
    const got = await rpc<string>(baseRpc, 'eth_sendRawTransaction', [raw]);
    if (typeof got === 'string' && got.toLowerCase() !== expected) {
      process.stderr.write(`warning: ${baseRpc} answered eth_sendRawTransaction with ${got}, expected ${expected}; using the local hash\n`);
    }
    return expected;
  } catch (e) {
    const msg = String((e as Error).message);
    if (/already known|known transaction/i.test(msg)) return expected;
    if (/nonce too low/i.test(msg)) {
      const rcpt = await rpc<unknown>(baseRpc, 'eth_getTransactionReceipt', [expected]).catch(() => null);
      if (rcpt) return expected;
    }
    throw e;
  }
}

/** True when the node knows this tx (mempool or mined). */
export async function evmTxKnown(hash: string, rpcOrChain: string = BASE_SEPOLIA_RPC): Promise<boolean> {
  return (await rpc<unknown>(rpcOf(rpcOrChain), 'eth_getTransactionByHash', [hash])) != null;
}

export async function getEvmBalance(address: string, rpcOrChain: string = BASE_SEPOLIA_RPC): Promise<bigint> {
  return BigInt(await rpc<string>(rpcOf(rpcOrChain), 'eth_getBalance', [address, 'latest']));
}

/** Chain-keyed wrappers for keeper code that has the payout's `chain` in hand. */
export const getEvmStepArgsFor = (chain: EvmChainName, fromAddress: string) => getEvmStepArgs(fromAddress, chain);
export const broadcastEvmFor = (chain: EvmChainName, rawHex: string) => broadcastEvm(rawHex, chain);
export const evmTxKnownFor = (chain: EvmChainName, hash: string) => evmTxKnown(hash, chain);
