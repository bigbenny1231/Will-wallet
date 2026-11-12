// The funder wallet: one EVM key (Base Sepolia and Monad testnet) and one Solana key, derived from the KEEPER_SEED
// secret with the same HKDF construction as the long-lived keeper's NEAR key (scripts/near-admin.mjs derive-keeper):
//
//   ikm  = KEEPER_SEED as UTF-8 bytes (at least 32 characters)
//   salt = "dmw-keeper"
//   EVM  : k = HKDF-SHA256(ikm, salt, info = "evm funder key v1", 32 bytes), read big-endian. It must be a valid
//          secp256k1 scalar, 1 <= k < n. If it is not (probability about 2^-128), the derivation is repeated with
//          info = "evm funder key v1#1", "evm funder key v1#2", ... and the first valid one is the key. No reduction
//          mod n is applied, so the key is uniformly distributed.
//   Solana: seed = HKDF-SHA256(ikm, salt, info = "solana funder key v1", 32 bytes): the ed25519 private seed
//          (RFC 8032); the address is the base58 of its public key.
//
// The keys never leave this module's callers: nothing here prints or returns them in a printable form.
import { hkdfSync } from 'node:crypto';
import { evmAddressOfKey } from './evmTx.js';
import { solanaAddressOfSeed } from './solanaTx.js';

export const FUNDER_SALT = 'dmw-keeper';
export const EVM_FUNDER_INFO = 'evm funder key v1';
export const SOLANA_FUNDER_INFO = 'solana funder key v1';
/** secp256k1 group order */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export type Hkdf = (ikm: Uint8Array, salt: string, info: string, len: number) => Uint8Array;
const nodeHkdf: Hkdf = (ikm, salt, info, len) => new Uint8Array(hkdfSync('sha256', ikm, salt, info, len));

export interface FunderKeys {
  evmKey: Uint8Array;
  evmAddress: string;
  solanaSeed: Uint8Array;
  solanaAddress: string;
}

export function checkSeed(seed: string | undefined): string {
  if (!seed || seed.length < 32) throw new Error('KEEPER_SEED must be set and at least 32 characters long (the funder keys are derived from it)');
  return seed;
}

/** The EVM funder key. `hkdf` is injectable so the out-of-range retry can be tested. */
export function deriveEvmFunderKey(seed: string, hkdf: Hkdf = nodeHkdf): Uint8Array {
  const ikm = new TextEncoder().encode(checkSeed(seed));
  for (let counter = 0; counter < 256; counter++) {
    const info = counter === 0 ? EVM_FUNDER_INFO : `${EVM_FUNDER_INFO}#${counter}`;
    const k = hkdf(ikm, FUNDER_SALT, info, 32);
    const n = BigInt('0x' + Buffer.from(k).toString('hex'));
    if (n >= 1n && n < SECP256K1_N) return k;
  }
  throw new Error('could not derive a valid secp256k1 key (this cannot happen with a real HKDF)');
}

export function deriveSolanaFunderSeed(seed: string, hkdf: Hkdf = nodeHkdf): Uint8Array {
  return hkdf(new TextEncoder().encode(checkSeed(seed)), FUNDER_SALT, SOLANA_FUNDER_INFO, 32);
}

export function deriveFunderKeys(seed: string): FunderKeys {
  const evmKey = deriveEvmFunderKey(seed);
  const solanaSeed = deriveSolanaFunderSeed(seed);
  return { evmKey, evmAddress: evmAddressOfKey(evmKey), solanaSeed, solanaAddress: solanaAddressOfSeed(solanaSeed) };
}
