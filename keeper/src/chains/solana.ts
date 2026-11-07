// Solana devnet helpers for step 3: recent blockhash for execute_step, and relay.
import { base58Decode } from './codec.js';

export const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com';
export const solscanTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const solanaExplorerAddress = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: T; error?: { code: number; message: string; data?: { err?: unknown } } };
  if (j.error) throw new Error(`${method}: ${j.error.message}${j.error.data?.err ? ` ${JSON.stringify(j.error.data.err)}` : ''}`);
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
  try {
    return await rpc<string>(solanaRpc, 'sendTransaction', [rawBase64, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  } catch (e) {
    const msg = String((e as Error).message);
    if (/already been processed/i.test(msg)) return solanaTxSignature(rawBase64);
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

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = '1' + s; }
  return s;
}
