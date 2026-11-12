// Solana legacy transactions with one SystemProgram::Transfer: build, sign (funder key), parse.
// Layout: compact-u16 signature count, 64-byte signatures, then the message:
//   header [num_required_signatures=1, num_readonly_signed=0, num_readonly_unsigned=1]
//   account keys [from, to, SystemProgram (32 zero bytes)], recent blockhash (32 bytes)
//   one instruction: program index 2, accounts [0, 1], data = u32 LE 2 (Transfer) || u64 LE lamports
import { ed25519 } from '@noble/curves/ed25519';
import { base58Decode, base58Encode } from './codec.js';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
/** Fee per signature on Solana (no priority fee is set). */
export const LAMPORTS_PER_SIGNATURE = 5_000n;
/** Rent-exempt minimum of a 0-data system account (getMinimumBalanceForRentExemption(0) on devnet and mainnet). */
export const RENT_EXEMPT_MIN_0 = 890_880n;

const key32 = (b58: string, what: string): Uint8Array => {
  const k = base58Decode(b58);
  if (k.length !== 32) throw new Error(`${what}: not a 32-byte Solana address`);
  return k;
};

const u64le = (n: bigint) => {
  if (n < 0n || n >= 1n << 64n) throw new Error('lamports out of u64 range');
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return b;
};

export interface SolTransfer {
  from: string;
  to: string;
  lamports: bigint;
  recentBlockhash: string;
}

/** The message bytes that are signed. */
export function transferMessage(t: SolTransfer): Uint8Array {
  const from = key32(t.from, 'from');
  const to = key32(t.to, 'to');
  if (Buffer.from(from).equals(Buffer.from(to))) throw new Error('transfer to itself');
  const bh = key32(t.recentBlockhash, 'recent blockhash');
  const data = Uint8Array.from([2, 0, 0, 0, ...u64le(t.lamports)]);
  return Uint8Array.from([
    1, 0, 1,
    3, ...from, ...to, ...new Uint8Array(32),
    ...bh,
    1, 2, 2, 0, 1, data.length, ...data,
  ]);
}

/** Solana address (base58 public key) of a 32-byte ed25519 seed. */
export const solanaAddressOfSeed = (seed: Uint8Array): string => base58Encode(ed25519.getPublicKey(seed));

/** Signed transfer as base64 (what `sendTransaction` takes) and its signature (the tx id). */
export function signSolTransfer(t: SolTransfer, seed: Uint8Array): { raw: string; signature: string } {
  if (solanaAddressOfSeed(seed) !== t.from) throw new Error('signing key does not match the from address');
  const msg = transferMessage(t);
  const sig = ed25519.sign(msg, seed);
  return { raw: Buffer.from(Uint8Array.from([1, ...sig, ...msg])).toString('base64'), signature: base58Encode(sig) };
}

/** Parse a signed single-transfer tx (ours or the contract's MPC one) and check its signature. */
export function parseSolTransfer(rawBase64: string): SolTransfer & { signature: string; valid: boolean } {
  const raw = Uint8Array.from(Buffer.from(rawBase64, 'base64'));
  if (raw[0] !== 1) throw new Error('expected exactly one signature');
  const sig = raw.subarray(1, 65);
  const msg = raw.subarray(65);
  if (msg[0] !== 1 || msg[3] !== 3) throw new Error('not a one-signer, three-account message');
  const keys = [0, 1, 2].map((i) => msg.subarray(4 + 32 * i, 4 + 32 * (i + 1)));
  if (keys[2].some((x) => x !== 0)) throw new Error('third account is not the System Program');
  const bh = msg.subarray(100, 132);
  const ix = msg.subarray(132);
  if (ix[0] !== 1 || ix[1] !== 2 || ix[2] !== 2 || ix[3] !== 0 || ix[4] !== 1 || ix[5] !== 12) throw new Error('not one System transfer');
  const data = ix.subarray(6, 18);
  if (data[0] !== 2 || data[1] || data[2] || data[3]) throw new Error('not a System transfer');
  let lamports = 0n;
  for (let i = 7; i >= 0; i--) lamports = (lamports << 8n) | BigInt(data[4 + i]);
  const from = base58Encode(keys[0]);
  let valid = false;
  try {
    valid = ed25519.verify(sig, msg, keys[0]);
  } catch {
    valid = false;
  }
  return { from, to: base58Encode(keys[1]), lamports, recentBlockhash: base58Encode(bh), signature: base58Encode(sig), valid };
}
