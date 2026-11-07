// Foreign-chain helpers for step 3: the chain-environment args execute_step needs, and relaying signed txs.
// Mirrors keeper/src/chains/{evm,solana}.ts. Public RPCs, called straight from the browser.
import { BASE_RPC, MONAD_RPC, SOLANA_RPC } from "../config";
import type { EvmStepArgs, ForeignChain, ForeignPayout, StepArgs, VaultView } from "../types";

const EVM_RPC: Partial<Record<ForeignChain, string>> = { base: BASE_RPC, monad: MONAD_RPC };
/** The contract rejects max_fee_per_gas above 100 gwei (foreign.rs MAX_EVM_FEE_PER_GAS). */
export const MAX_EVM_FEE = 100_000_000_000n;

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: T; error?: { code: number; message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

/** EIP-1559 fees within the contract's cap: max_fee = min(2 * baseFee + priority, 100 gwei), priority <= max_fee. */
export function capFees(baseFee: bigint, prio: bigint): { max_fee_per_gas: string; max_priority_fee_per_gas: string } {
  const p = prio > 0n ? prio : 1_000_000n;
  let max = baseFee * 2n + p;
  if (max > MAX_EVM_FEE) max = MAX_EVM_FEE;
  return { max_fee_per_gas: max.toString(), max_priority_fee_per_gas: (p > max ? max : p).toString() };
}

/** Pending nonce and capped EIP-1559 fees, 21000 gas for a native transfer. The contract pins the nonce itself. */
export async function getEvmStepArgs(from: string, chain: ForeignChain = "base"): Promise<EvmStepArgs> {
  const url = EVM_RPC[chain] ?? BASE_RPC;
  const [nonceHex, block, prioHex] = await Promise.all([
    rpc<string>(url, "eth_getTransactionCount", [from, "pending"]),
    rpc<{ baseFeePerGas: string }>(url, "eth_getBlockByNumber", ["latest", false]),
    rpc<string>(url, "eth_maxPriorityFeePerGas", []).catch(() => "0xf4240"),
  ]);
  return { nonce: Number(BigInt(nonceHex)), ...capFees(BigInt(block.baseFeePerGas), BigInt(prioHex)), gas_limit: "21000" };
}

export async function getSolanaBlockhash(): Promise<string> {
  const r = await rpc<{ value: { blockhash: string } }>(SOLANA_RPC, "getLatestBlockhash", [{ commitment: "finalized" }]);
  return r.value.blockhash;
}

/** The payout step 3 will handle next (foreign_index), if any. */
export function currentForeign(v: VaultView): ForeignPayout | null {
  return v.step === 3 && v.foreign_index < v.foreign.length ? v.foreign[v.foreign_index] : null;
}

/** Args for the next execute_step; undefined when the step needs none. */
export async function stepArgsFor(v: VaultView, fromAddressFallback?: string): Promise<StepArgs | undefined> {
  const p = currentForeign(v);
  if (!p) return undefined;
  if (p.chain === "base" || p.chain === "monad") {
    const from = p.from_address || fromAddressFallback;
    if (!from) throw new Error(`No source address recorded for this ${p.chain === "base" ? "Base" : "Monad"} payout`);
    return { evm: await getEvmStepArgs(from, p.chain) };
  }
  return { solana: { recent_blockhash: await getSolanaBlockhash() } };
}

export async function broadcastForeign(p: ForeignPayout): Promise<string> {
  if (!p.signed_tx) throw new Error("Payout has no signed tx");
  const evmUrl = EVM_RPC[p.chain];
  if (evmUrl) {
    const raw = p.signed_tx.startsWith("0x") ? p.signed_tx : `0x${p.signed_tx}`;
    return rpc<string>(evmUrl, "eth_sendRawTransaction", [raw]);
  }
  return rpc<string>(SOLANA_RPC, "sendTransaction", [p.signed_tx, { encoding: "base64", preflightCommitment: "confirmed" }]);
}
