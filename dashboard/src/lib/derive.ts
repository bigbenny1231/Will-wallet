// Client-side derivation of the foreign source addresses (SPEC section 1).
// Uses chainsig.js' pure key-derivation helpers plus the MPC root keys of the default signer
// (v1.signer-prod.testnet / v1.signer); no RPC needed.
// Contract v2 salts each vault's paths (`base-<id>-<salt>`, `monad-<id>-<salt>`, `sol-<id>-<salt>`) and publishes
// them in the vault view as `derivation_paths`. Always derive from those: the salt is drawn at create_vault, so the
// address cannot be known (or pre-funded) before the vault exists. A v1 contract has no salt: `vaultPaths` falls back
// to `<prefix>-<id>` for it.
import * as chainsig from "chainsig.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";
import { CONTRACT, NETWORK } from "../config";
import type { DerivationPaths } from "../types";

export interface DerivedAddresses {
  base: string;
  monad: string;
  solana: string;
}

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

function eip55(addr: string): string {
  const lower = addr.toLowerCase();
  const h = hex(keccak_256(new TextEncoder().encode(lower)));
  return "0x" + [...lower].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}

/** Unsalted v1 paths, only for a vault on a contract that predates `derivation_paths`. */
export const legacyPaths = (tokenId: string): DerivationPaths => ({ base: `base-${tokenId}`, monad: `monad-${tokenId}`, solana: `sol-${tokenId}` });

/** The vault's paths: `derivation_paths` from its view (v2), or the v1 form for an older contract. */
export function vaultPaths(v: { token_id: string; derivation_paths?: DerivationPaths | null }): DerivationPaths {
  return v.derivation_paths ?? legacyPaths(v.token_id);
}

/** The source addresses of a vault, from the paths in its view. */
export const deriveForVault = (v: { token_id: string; derivation_paths?: DerivationPaths | null }, contractId = CONTRACT): DerivedAddresses =>
  deriveFor(vaultPaths(v), contractId);

/**
 * The address the MPC signs for, for one payout chain of a vault: always derived, never the payout's stored
 * `from_address` (owner-typed text until the contract overwrites it at signing). "" when derivation fails.
 */
export function sourceAddressFor(v: { token_id: string; derivation_paths?: DerivationPaths | null }, chain: keyof DerivedAddresses, contractId = CONTRACT): string {
  try {
    return deriveForVault(v, contractId)[chain];
  } catch {
    return "";
  }
}

export function deriveFor(paths: DerivationPaths, contractId = CONTRACT): DerivedAddresses {
  const roots = chainsig.constants.ROOT_PUBLIC_KEYS[NETWORK === "mainnet" ? "MAINNET" : "TESTNET"];
  const { cryptography: c } = chainsig.utils;

  const rootSec = c.najToUncompressedPubKeySEC1(roots.secp256k1);
  // Each EVM chain has its own path, so its own address.
  const evm = (path: string) => eip55(hex(keccak_256(unhex(c.deriveChildPublicKey(rootSec, contractId, path).slice(2))).slice(12)));

  const ed = c.deriveChildPublicKeyEd25519(roots.ed25519, contractId, paths.solana);
  const sol = ed.replace(/^ed25519:/, "");
  // validate it is a 32-byte key
  if (bs58.decode(sol).length !== 32) throw new Error("bad ed25519 derived key");

  return { base: evm(paths.base), monad: evm(paths.monad), solana: sol };
}
