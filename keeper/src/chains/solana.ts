// Solana devnet helpers for step 3: recent blockhash for execute_step, and relay.
import { base58Decode, base58Encode } from './codec.js';

export const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com';
export const solscanTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const solanaExplorerAddress = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

/** No RPC call may hold a bounded run (`--max-seconds`) open: every request gives up after this long. */
const RPC_TIMEOUT_MS = 15_000;

export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  // A rate limit or gateway page is not an answer. Without this check a body with neither `result` nor `error`
  // read as success, and a broadcast nobody accepted was marked on NEAR (SECURITY_REVIEW_3 K-3).
  let j: { result?: T; error?: { code: number; message: string; data?: { err?: unknown } } };
  try {
    j = (await r.json()) as typeof j;
  } catch {
    throw new Error(`${method}: HTTP ${r.status}, not a JSON-RPC answer`);
  }
  if (j === null || typeof j !== 'object') throw new Error(`${method}: HTTP ${r.status}, not a JSON-RPC answer`);
  if (j.error) throw new Error(`${method}: ${j.error.message}${j.error.data?.err ? ` ${JSON.stringify(j.error.data.err)}` : ''}`);
  if (!r.ok || !('result' in j)) throw new Error(`${method}: HTTP ${r.status}, no result in the answer`);
  return j.result as T;
}

/**
 * Fresh blockhash (commitment `confirmed`). It is valid for ~150 blocks (~60–90 s); the MPC
 * round trip takes ~18 s, so fetch right before execute_step and relay right after signing.
 */
export async function getSolanaStepArgs(solanaRpc: string = SOLANA_DEVNET_RPC): Promise<{ recent_blockhash: string }> {
  const r = await rpc<{ value: { blockhash: string } }>(solanaRpc, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  return { recent_blockhash: r.value.blockhash };
}

/** The tx id of a signed tx is the base58 of its first signature. */
export function solanaTxSignature(rawBase64: string): string {
  const raw = Buffer.from(rawBase64, 'base64');
  if (raw[0] < 1) throw new Error('unsigned transaction');
  return base58Encode(raw.subarray(1, 65));
}

/** sendTransaction (base64). Returns the signature. Throws on simulation failure / expired blockhash. */
export async function broadcastSolana(rawBase64: string, solanaRpc: string = SOLANA_DEVNET_RPC): Promise<string> {
  const expected = solanaTxSignature(rawBase64);
  try {
    // The signature is in the raw tx; return the local one, not whatever the node says (AUDIT_FINAL_OFFCHAIN F-07).
    await rpc<string>(solanaRpc, 'sendTransaction', [rawBase64, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
    return expected;
  } catch (e) {
    const msg = String((e as Error).message);
    if (/already been processed/i.test(msg)) return expected;
    throw e;
  }
}

/** True when the error means "blockhash expired": call dmw.resign_foreign with a fresh one. */
export const isBlockhashExpired = (e: unknown) => /BlockhashNotFound|blockhash not found/i.test(String((e as Error)?.message ?? e));

/**
 * getSignatureStatuses with full history search. True when the signature landed at all (even with an
 * execution error: the blockhash is consumed and the tx can never be replayed).
 */
export async function solanaSignatureLanded(signature: string, solanaRpc: string = SOLANA_DEVNET_RPC): Promise<boolean> {
  const r = await rpc<{ value: ({ slot: number } | null)[] }>(solanaRpc, 'getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
  return r.value?.[0] != null;
}

export async function getSolanaBalance(address: string, solanaRpc: string = SOLANA_DEVNET_RPC): Promise<number> {
  base58Decode(address);
  return (await rpc<{ value: number }>(solanaRpc, 'getBalance', [address])).value;
}


