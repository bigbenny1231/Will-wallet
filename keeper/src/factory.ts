import { KeyPair } from 'near-api-js';
import { type Backend, NearBackend, makeAccount, makeProvider } from './backend.js';
import { type Chains, loadRealChains } from './chainsApi.js';
import { type Config, need } from './config.js';
import { MockBackend, mockChains } from './mock.js';
import { realFundingRpc, type FundingRpc } from './chains/funderRpc.js';
import { capsFromEnv, Funder, type FundCaps, type FundLog } from './funder.js';
import { checkSeed } from './chains/funderKeys.js';

/** Heartbeats are signed AS the contract account with the pulse function-call key. */
export function pulseBackend(cfg: Config, pulseKey: string): Backend {
  if (cfg.mock) return new MockBackend();
  const provider = makeProvider(cfg.rpcUrl);
  return new NearBackend(provider, need(cfg.contract, 'DMW_CONTRACT'), makeAccount(provider, cfg.contract, pulseKey));
}

/** agent_pay is signed AS the contract account with the agent function-call key. */
export const agentBackend = pulseBackend;

export function keeperBackend(cfg: Config): Backend {
  if (cfg.mock) return new MockBackend();
  const provider = makeProvider(cfg.rpcUrl);
  return new NearBackend(
    provider,
    need(cfg.contract, 'DMW_CONTRACT'),
    makeAccount(provider, need(cfg.keeperAccountId, 'KEEPER_ACCOUNT_ID'), need(cfg.keeperPrivateKey, 'KEEPER_PRIVATE_KEY')),
  );
}

/** Read-only backend (views only); uses a throwaway random signer (never signs anything). */
export function viewBackend(cfg: Config): Backend {
  if (cfg.mock) return new MockBackend();
  const provider = makeProvider(cfg.rpcUrl);
  const acct = cfg.keeperAccountId || 'view.testnet';
  const key = cfg.keeperPrivateKey || KeyPair.fromRandom('ed25519').toString();
  return new NearBackend(provider, need(cfg.contract, 'DMW_CONTRACT'), makeAccount(provider, acct, key));
}

export function getChains(cfg: Config): Chains {
  return cfg.mock ? mockChains() : loadRealChains(cfg);
}

/** The funder wallet from KEEPER_SEED, its caps from FUND_CAP_* / FUND_RUN_CAP_*, and the real chain RPCs. */
export function funderFromEnv(cfg: Config, log: FundLog, env: NodeJS.ProcessEnv = process.env): { funder: Funder; rpc: FundingRpc; caps: FundCaps } {
  if (cfg.mock) throw new Error('the funder sends real testnet transactions; it does not run with DMW_MOCK=1');
  const seed = checkSeed(env.KEEPER_SEED);
  const caps = capsFromEnv(env);
  const rpc = realFundingRpc({ solanaRpc: cfg.solanaRpc });
  return { funder: Funder.fromSeed(seed, { rpc, caps, log }), rpc, caps };
}
