// Each variable is read as `import.meta.import.meta.env.VITE_X`, never through an alias of `import.meta.env`: Vite replaces
// the static form with the one value, but an alias makes it inline the WHOLE env object into the bundle, which on
// Vercel includes the system variables (commit message, repo and deployment ids). SECURITY_REVIEW_3 D-2.

export const MOCK = import.meta.env.VITE_DMW_MOCK === "1" || import.meta.env.VITE_DMW_MOCK === "true";
export const NETWORK: "testnet" | "mainnet" = import.meta.env.VITE_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
export const CONTRACT: string = import.meta.env.VITE_DMW_CONTRACT || "dmw-979268.testnet";
export const RPC: string =
  import.meta.env.VITE_NEAR_RPC || (NETWORK === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.fastnear.com");
export const SIGNER_CONTRACT = NETWORK === "mainnet" ? "v1.signer" : "v1.signer-prod.testnet";
export const SPUTNIK_UI: string = import.meta.env.VITE_SPUTNIK_UI || "";

export const NEARBLOCKS = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
export const POLL_MS = 3000;
/** The vault the project keeps alive as a living example (labelled as such on its page). Empty: none. */
export const SHOWCASE_VAULT: string = import.meta.env.VITE_SHOWCASE_VAULT ?? (CONTRACT === "dmw-979268.testnet" ? "1" : "");

export const links = {
  nearAddress: (account: string) => `${NEARBLOCKS}/address/${account}`,
  nearTx: (hash: string) => `${NEARBLOCKS}/txns/${hash}`,
  baseTx: (hash: string) => `https://sepolia.basescan.org/tx/${hash}`,
  baseAddress: (a: string) => `https://sepolia.basescan.org/address/${a}`,
  monadTx: (hash: string) => `https://testnet.monadexplorer.com/tx/${hash}`,
  monadAddress: (a: string) => `https://testnet.monadexplorer.com/address/${a}`,
  solTx: (hash: string) => `https://explorer.solana.com/tx/${hash}?cluster=devnet`,
  solAddress: (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`,
  // The Astro UI has no confirmed testnet URL; fall back to the DAO account on nearblocks.
  dao: (daoId: string) => (SPUTNIK_UI ? `${SPUTNIK_UI.replace(/\/$/, "")}/dao/${daoId}` : `${NEARBLOCKS}/address/${daoId}`),
  baseFaucet: "https://www.alchemy.com/faucets/base-sepolia",
  solFaucet: "https://faucet.solana.com",
  monadFaucet: "https://faucet.monad.xyz",
};

export const BASE_RPC: string = import.meta.env.VITE_BASE_RPC || "https://sepolia.base.org";
export const SOLANA_RPC: string = import.meta.env.VITE_SOLANA_RPC || "https://api.devnet.solana.com";
export const MONAD_RPC: string = import.meta.env.VITE_MONAD_RPC || "https://testnet-rpc.monad.xyz";
export const MONAD_CHAIN_ID = 10143;

/** Origin the phone opens for pairing. Defaults to this page's origin; set it when the dashboard runs on localhost. */
export const PUBLIC_ORIGIN: string = (import.meta.env.VITE_PUBLIC_ORIGIN || "").replace(/\/$/, "");

/** NEAR Auth (FastAuth) for heir sign-in. The shared testnet Auth0 client only accepts http://localhost:3000. */
export const NEAR_AUTH = {
  domain: import.meta.env.VITE_NEAR_AUTH_DOMAIN || (NETWORK === "mainnet" ? "login.auth.near.org" : "login.testnet.fast-auth.com"),
  clientId: import.meta.env.VITE_NEAR_AUTH_CLIENT_ID || (NETWORK === "mainnet" ? "" : "np8paqIpMWmNbzT4xAvOOapZBjsOpptl"),
  fastAuthContract: NETWORK === "mainnet" ? "fast-auth.near" : "fast-auth.testnet",
  /** Origins registered as callback URLs on the Auth0 client. */
  origins: (import.meta.env.VITE_NEAR_AUTH_ORIGINS || (NETWORK === "mainnet" ? "" : "http://localhost:3000")).split(",").map((s: string) => s.trim()).filter(Boolean),
};
