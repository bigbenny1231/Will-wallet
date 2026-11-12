// Derived foreign source addresses for a vault (SPEC §1). Contract v2 salts the paths per vault
// (`base-<id>-<salt>` / `monad-<id>-<salt>` / `sol-<id>-<salt>`) and publishes them in the vault view as
// `derivation_paths`: always read them from there, never rebuild them. A v1 contract has no salt, so
// `vaultPaths` falls back to `<prefix>-<id>` for it. Predecessor = the dmw contract account. Uses the live
// signer's `derived_public_key` view (authoritative; verified byte-identical to chainsig.js).
import { base58Decode, evmAddressFromPubkey64 } from './codec.js';
import { chainConfig, type EvmChainName } from './evm.js';
import type { DerivationPaths } from '../types.js';

export const MPC_SIGNER_TESTNET = 'v1.signer-prod.testnet';
const DEFAULT_NEAR_RPC = 'https://rpc.testnet.fastnear.com';

export interface DeriveOptions {
  rpcUrl?: string; // NEAR RPC
  mpcSigner?: string; // default v1.signer-prod.testnet
}

/** Unsalted v1 paths (`<prefix>-<id>`), only for a vault on a contract that predates `derivation_paths`. */
export const legacyPaths = (tokenId: string | number): DerivationPaths => ({
  base: `${chainConfig('base').pathPrefix}-${tokenId}`,
  monad: `${chainConfig('monad').pathPrefix}-${tokenId}`,
  solana: `sol-${tokenId}`,
});

/** The vault's paths: `derivation_paths` from its view (v2), or the v1 form for an older contract. */
export function vaultPaths(v: { token_id: string; derivation_paths?: DerivationPaths | null }): DerivationPaths {
  return v.derivation_paths ?? legacyPaths(v.token_id);
}

/** Derivation path of a vault's source address on one payout chain. */
export function derivationPath(chain: string, paths: DerivationPaths): string {
  if (chain === 'solana') return paths.solana;
  return chainConfig(chain).chain === 'monad' ? paths.monad : paths.base;
}

async function viewDerivedKey(
  rpcUrl: string, signer: string, path: string, predecessor: string, domainId: 0 | 1,
): Promise<string> {
  const args = Buffer.from(JSON.stringify({ path, predecessor, domain_id: domainId })).toString('base64');
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'dmw', method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: signer, method_name: 'derived_public_key', args_base64: args },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await r.json()) as { result?: { result?: number[]; error?: string }; error?: unknown };
  if (!j.result?.result) throw new Error(`derived_public_key failed: ${JSON.stringify(j.error ?? j.result?.error)}`);
  return JSON.parse(Buffer.from(j.result.result).toString()) as string;
}

/** EVM address from "secp256k1:<base58 64-byte x||y>". */
export function evmAddressFromNearKey(key: string): string {
  if (!key.startsWith('secp256k1:')) throw new Error(`expected secp256k1 key, got ${key}`);
  return evmAddressFromPubkey64(base58Decode(key.slice('secp256k1:'.length)));
}

/** Solana address (base58 pubkey) from "ed25519:<base58>". */
export function solanaAddressFromNearKey(key: string): string {
  if (!key.startsWith('ed25519:')) throw new Error(`expected ed25519 key, got ${key}`);
  const b58 = key.slice('ed25519:'.length);
  if (base58Decode(b58).length !== 32) throw new Error('ed25519 key must be 32 bytes');
  return b58;
}

/** EVM source address of `chain` (`base` | `monad`) for a vault, from its paths; domain 0. */
export async function deriveEvmAddress(chain: EvmChainName, contractId: string, paths: DerivationPaths, opts: DeriveOptions = {}) {
  const path = derivationPath(chain, paths);
  const key = await viewDerivedKey(opts.rpcUrl ?? DEFAULT_NEAR_RPC, opts.mpcSigner ?? MPC_SIGNER_TESTNET, path, contractId, 0);
  return { address: evmAddressFromNearKey(key), publicKey: key, path };
}

export const deriveBaseAddress = (contractId: string, paths: DerivationPaths, opts: DeriveOptions = {}) =>
  deriveEvmAddress('base', contractId, paths, opts);
export const deriveMonadAddress = (contractId: string, paths: DerivationPaths, opts: DeriveOptions = {}) =>
  deriveEvmAddress('monad', contractId, paths, opts);

export async function deriveSolanaAddress(contractId: string, paths: DerivationPaths, opts: DeriveOptions = {}) {
  const key = await viewDerivedKey(opts.rpcUrl ?? DEFAULT_NEAR_RPC, opts.mpcSigner ?? MPC_SIGNER_TESTNET, paths.solana, contractId, 1);
  return { address: solanaAddressFromNearKey(key), publicKey: key, path: paths.solana };
}

/** Keeper entry point: the vault's paths (from its view). Third arg may be the keeper Config (uses its `rpcUrl`). */
export async function deriveAddresses(
  contractId: string, paths: DerivationPaths, opts: DeriveOptions = {},
): Promise<{ base: string; monad: string; solana: string }> {
  const o = { rpcUrl: opts.rpcUrl, mpcSigner: opts.mpcSigner ?? process.env.MPC_SIGNER };
  const [b, m, s] = await Promise.all([
    deriveBaseAddress(contractId, paths, o), deriveMonadAddress(contractId, paths, o), deriveSolanaAddress(contractId, paths, o),
  ]);
  return { base: b.address, monad: m.address, solana: s.address };
}

/** Source address for one payout chain (`base` | `monad` | `solana`). */
export async function deriveAddressFor(
  chain: string, contractId: string, paths: DerivationPaths, opts: DeriveOptions = {},
): Promise<string> {
  if (chain === 'solana') return (await deriveSolanaAddress(contractId, paths, opts)).address;
  return (await deriveEvmAddress(chainConfig(chain).chain, contractId, paths, opts)).address;
}
