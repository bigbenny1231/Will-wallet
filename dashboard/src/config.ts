const env = import.meta.env;

export const MOCK = env.VITE_DMW_MOCK === "1" || env.VITE_DMW_MOCK === "true";
export const NETWORK: "testnet" | "mainnet" = env.VITE_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
export const CONTRACT: string = env.VITE_DMW_CONTRACT || "dmw-1.testnet";
export const RPC: string =
  env.VITE_NEAR_RPC || (NETWORK === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org");
export const SIGNER_CONTRACT = NETWORK === "mainnet" ? "v1.signer" : "v1.signer-prod.testnet";
export const SPUTNIK_UI: string = env.VITE_SPUTNIK_UI || "";

export const NEARBLOCKS = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
export const POLL_MS = 3000;

export const links = {
  nearAddress: (account: string) => `${NEARBLOCKS}/address/${account}`,
  nearTx: (hash: string) => `${NEARBLOCKS}/txns/${hash}`,
  baseTx: (hash: string) => `https://sepolia.basescan.org/tx/${hash}`,
  baseAddress: (a: string) => `https://sepolia.basescan.org/address/${a}`,
  solTx: (hash: string) => `https://explorer.solana.com/tx/${hash}?cluster=devnet`,
  solAddress: (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`,
  // The Astro UI has no confirmed testnet URL; fall back to the DAO account on nearblocks.
  dao: (daoId: string) => (SPUTNIK_UI ? `${SPUTNIK_UI.replace(/\/$/, "")}/dao/${daoId}` : `${NEARBLOCKS}/address/${daoId}`),
  baseFaucet: "https://www.alchemy.com/faucets/base-sepolia",
  solFaucet: "https://faucet.solana.com",
};
