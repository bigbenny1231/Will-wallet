import { config as loadDotenv } from 'dotenv';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const KEEPER_DIR = resolve(here, '..');
export const REPO_ROOT = resolve(KEEPER_DIR, '..');

// process env wins, then keeper/.env, then the repo-root .env (where the deploy agent writes DMW_CONTRACT).
for (const p of [resolve(KEEPER_DIR, '.env'), resolve(REPO_ROOT, '.env')]) {
  if (!existsSync(p)) continue;
  warnIfShared(p);
  loadDotenv({ path: p, quiet: true });
}

/** .env holds KEEPER_PRIVATE_KEY (and the contract's full-access key): warn when other local users can read it. */
export function warnIfShared(p: string, mode = statSync(p).mode, platform = process.platform): boolean {
  if (platform === 'win32' || (mode & 0o077) === 0) return false;
  process.stderr.write(`warning: ${p} is readable by other users (mode ${(mode & 0o777).toString(8)}); it holds private keys. Run: chmod 600 ${p}\n`);
  return true;
}

export interface Config {
  network: string;
  rpcUrl: string;
  contract: string;
  keeperAccountId: string;
  keeperPrivateKey: string;
  baseRpc: string;
  solanaRpc: string;
  mock: boolean;
}

const RPC_BY_NETWORK: Record<string, string> = {
  testnet: 'https://rpc.testnet.fastnear.com',
  mainnet: 'https://rpc.mainnet.near.org',
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const network = env.NEAR_NETWORK || 'testnet';
  const mock = env.DMW_MOCK === '1' || env.DMW_MOCK === 'true';
  return {
    network,
    rpcUrl: env.NEAR_RPC || RPC_BY_NETWORK[network] || RPC_BY_NETWORK.testnet,
    contract: env.DMW_CONTRACT || (mock ? 'dmw-mock.testnet' : ''),
    keeperAccountId: env.KEEPER_ACCOUNT_ID || '',
    keeperPrivateKey: env.KEEPER_PRIVATE_KEY || '',
    baseRpc: env.BASE_RPC || 'https://sepolia.base.org',
    solanaRpc: env.SOLANA_RPC || 'https://api.devnet.solana.com',
    mock,
  };
}

export function need(value: string, name: string): string {
  if (!value) throw new Error(`${name} is not set (see keeper/.env.example)`);
  return value;
}
