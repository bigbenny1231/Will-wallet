// Foreign-chain helpers for step 3: the chain-environment args execute_step needs, and relaying signed txs.
// Mirrors keeper/src/chains/{evm,solana}.ts. Public RPCs, called straight from the browser.
import { BASE_RPC, SOLANA_RPC } from "../config";
import type { EvmStepArgs, ForeignPayout, StepArgs, VaultView } from "../types";

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

/** Pending nonce and EIP-1559 fees (max_fee = 2 * baseFee + priority), 21000 gas for a native transfer. */
export async function getEvmStepArgs(from: string): Promise<EvmStepArgs> {
  const [nonceHex, block, prioHex] = await Promise.all([
    rpc<string>(BASE_RPC, "eth_getTransactionCount", [from, "pending"]),
    rpc<{ baseFeePerGas: string }>(BASE_RPC, "eth_getBlockByNumber", ["latest", false]),
    rpc<string>(BASE_RPC, "eth_maxPriorityFeePerGas", []).catch(() => "0xf4240"),
  ]);
  const prio = BigInt(prioHex) > 0n ? BigInt(prioHex) : 1_000_000n;
  return {
    nonce: Number(BigInt(nonceHex)),
    max_fee_per_gas: (BigInt(block.baseFeePerGas) * 2n + prio).toString(),
    max_priority_fee_per_gas: prio.toString(),
    gas_limit: "21000",
  };
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
  if (p.chain === "base") {
    const from = p.from_address || fromAddressFallback;
    if (!from) throw new Error("No source address recorded for this Base payout");
    return { evm: await getEvmStepArgs(from) };
  }
  return { solana: { recent_blockhash: await getSolanaBlockhash() } };
}

export async function broadcastForeign(p: ForeignPayout): Promise<string> {
  if (!p.signed_tx) throw new Error("Payout has no signed tx");
  if (p.chain === "base") {
    const raw = p.signed_tx.startsWith("0x") ? p.signed_tx : `0x${p.signed_tx}`;
    return rpc<string>(BASE_RPC, "eth_sendRawTransaction", [raw]);
  }
  return rpc<string>(SOLANA_RPC, "sendTransaction", [p.signed_tx, { encoding: "base64", preflightCommitment: "confirmed" }]);
}
