// One place for per-chain labels, units and explorer links (Base Sepolia, Monad testnet, Solana devnet).
import { links } from "../config";
import type { ForeignChain } from "../types";

export interface ChainMeta {
  chain: ForeignChain;
  /** Network name as shown in the picker. */
  name: string;
  /** Short name in lists. */
  short: string;
  unit: string;
  decimals: number;
  evm: boolean;
  /** Explorer label for small-caps links. */
  explorer: string;
  tx: (hash: string) => string;
  address: (a: string) => string;
  faucet: string;
  /** MPC derivation path for vault `id`. */
  path: (id: string) => string;
}

export const CHAINS: Record<ForeignChain, ChainMeta> = {
  base: { chain: "base", name: "Base Sepolia", short: "Base", unit: "ETH", decimals: 18, evm: true, explorer: "basescan", tx: links.baseTx, address: links.baseAddress, faucet: links.baseFaucet, path: (id) => `base-${id}` },
  monad: { chain: "monad", name: "Monad testnet", short: "Monad", unit: "MON", decimals: 18, evm: true, explorer: "monad explorer", tx: links.monadTx, address: links.monadAddress, faucet: links.monadFaucet, path: (id) => `monad-${id}` },
  solana: { chain: "solana", name: "Solana devnet", short: "Solana", unit: "SOL", decimals: 9, evm: false, explorer: "solana", tx: links.solTx, address: links.solAddress, faucet: links.solFaucet, path: (id) => `sol-${id}` },
};

/** Picker order. */
export const CHAIN_ORDER: ForeignChain[] = ["base", "monad", "solana"];

export const chainMeta = (c: ForeignChain): ChainMeta => CHAINS[c] ?? CHAINS.base;
