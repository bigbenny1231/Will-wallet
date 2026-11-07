// Client-side derivation of the foreign source addresses (SPEC section 1).
// Uses chainsig.js' pure key-derivation helpers plus the MPC root keys; no RPC needed.
import * as chainsig from "chainsig.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";
import { CONTRACT, NETWORK } from "../config";

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

export function deriveFor(tokenId: string, contractId = CONTRACT): DerivedAddresses {
  const roots = chainsig.constants.ROOT_PUBLIC_KEYS[NETWORK === "mainnet" ? "MAINNET" : "TESTNET"];
  const { cryptography: c } = chainsig.utils;

  const rootSec = c.najToUncompressedPubKeySEC1(roots.secp256k1);
  // Each EVM chain has its own path (base-<id>, monad-<id>), so its own address.
  const evm = (path: string) => eip55(hex(keccak_256(unhex(c.deriveChildPublicKey(rootSec, contractId, path).slice(2))).slice(12)));

  const ed = c.deriveChildPublicKeyEd25519(roots.ed25519, contractId, `sol-${tokenId}`);
  const sol = ed.replace(/^ed25519:/, "");
  // validate it is a 32-byte key
  if (bs58.decode(sol).length !== 32) throw new Error("bad ed25519 derived key");

  return { base: evm(`base-${tokenId}`), monad: evm(`monad-${tokenId}`), solana: sol };
}
