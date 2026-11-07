// Base Sepolia helpers for step 3: chain params for execute_step, and relay.
import { fromHex, keccak256, toHex } from './codec.js';

export const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const basescanTx = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;
export const basescanAddress = (a: string) => `https://sepolia.basescan.org/address/${a}`;

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
export async function getEvmStepArgs(fromAddress: string, baseRpc: string = BASE_SEPOLIA_RPC): Promise<EvmStepArgs> {
  const [nonceHex, block, prioHex] = await Promise.all([
    rpc<string>(baseRpc, 'eth_getTransactionCount', [fromAddress, 'pending']),
    rpc<{ baseFeePerGas: string }>(baseRpc, 'eth_getBlockByNumber', ['latest', false]),
    rpc<string>(baseRpc, 'eth_maxPriorityFeePerGas', []).catch(() => '0xf4240'), // 0.001 gwei
  ]);
  const prio = BigInt(prioHex) > 0n ? BigInt(prioHex) : 1_000_000n;
  const maxFee = BigInt(block.baseFeePerGas) * 2n + prio;
  return {
    nonce: Number(BigInt(nonceHex)),
    max_fee_per_gas: maxFee.toString(),
    max_priority_fee_per_gas: prio.toString(),
    gas_limit: '21000',
  };
}

/** keccak256 of the raw signed tx: the tx hash, known before broadcast. */
export const evmTxHash = (rawHex: string) => '0x' + toHex(keccak256(fromHex(rawHex)));

/**
 * eth_sendRawTransaction. Returns the tx hash. Idempotent: "already known" /
 * "nonce too low" for the same tx are treated as already broadcast.
 */
export async function broadcastEvm(rawHex: string, baseRpc: string = BASE_SEPOLIA_RPC): Promise<string> {
  const raw = rawHex.startsWith('0x') ? rawHex : `0x${rawHex}`;
  const expected = evmTxHash(raw);
  try {
    return await rpc<string>(baseRpc, 'eth_sendRawTransaction', [raw]);
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
export async function evmTxKnown(hash: string, baseRpc: string = BASE_SEPOLIA_RPC): Promise<boolean> {
  return (await rpc<unknown>(baseRpc, 'eth_getTransactionByHash', [hash])) != null;
}

export async function getEvmBalance(address: string, baseRpc: string = BASE_SEPOLIA_RPC): Promise<bigint> {
  return BigInt(await rpc<string>(baseRpc, 'eth_getBalance', [address, 'latest']));
}
