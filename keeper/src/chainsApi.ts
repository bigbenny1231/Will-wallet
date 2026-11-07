// Interface to the foreign-chain helpers in src/chains/ (owned by another agent).
//
// Expected modules (any of the listed export names is accepted):
//   chains/derive.ts   deriveAddresses(contractId, tokenId) -> { base | evm: string|{address}, solana: string|{address} }
//   chains/evm.ts      getEvmStepArgs(fromAddress) -> EvmStepArgs      broadcastEvm(rawHex) -> txHash
//   chains/solana.ts   getSolanaStepArgs() -> { recent_blockhash }     broadcastSolana(rawBase64) -> signature
//
// Until those land, every method throws "not wired".
import type { Config } from './config.js';
import type { ChainName, EvmStepArgs } from './types.js';

export interface Chains {
  deriveAddresses(contractId: string, tokenId: string): Promise<{ base: string; monad: string; solana: string }>;
  /** `chain` selects the EVM chain (default base): its RPC and fee cap. */
  evmParams(fromAddress: string, chain?: 'base' | 'monad'): Promise<EvmStepArgs>;
  solanaParams(): Promise<{ recent_blockhash: string }>;
  broadcastEvm(rawHex: string, chain?: 'base' | 'monad'): Promise<string>;
  broadcastSolana(rawBase64: string): Promise<string>;
  /** True when the tx id (EVM hash / Solana signature) is known to the chain (pending, mined or landed with an error). */
  txLanded(chain: ChainName, id: string): Promise<boolean>;
}

export class NotWiredError extends Error {
  constructor(what: string) {
    super(`not wired: ${what} (keeper/src/chains/ has not landed yet)`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mod = Record<string, any>;

async function tryImport(spec: string): Promise<Mod | null> {
  try {
    return (await import(/* @vite-ignore */ spec)) as Mod;
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    if (/Cannot find module|Failed to (load|resolve)|ERR_MODULE_NOT_FOUND|does not exist/i.test(m) && m.includes('chains')) {
      return null;
    }
    throw e;
  }
}

function pick(mod: Mod | null, ...names: string[]): ((...a: any[]) => any) | null {
  if (!mod) return null;
  for (const n of names) if (typeof mod[n] === 'function') return mod[n];
  if (mod.default) for (const n of names) if (typeof mod.default[n] === 'function') return mod.default[n];
  return null;
}

const addr = (x: unknown): string =>
  typeof x === 'string' ? x : ((x as { address?: string })?.address ?? String(x));

export function loadRealChains(cfg: Config): Chains {
  const mods: Record<string, Promise<Mod | null> | undefined> = {};
  const load = (name: string) => (mods[name] ??= tryImport(`./chains/${name}.js`));
  const need = async <T>(mod: string, what: string, names: string[]): Promise<(...a: any[]) => T> => {
    const fn = pick(await load(mod), ...names);
    if (!fn) throw new NotWiredError(what);
    return fn as (...a: any[]) => T;
  };
  // Base keeps the configured RPC; other EVM chains pass their name (chains/evm.ts resolves RPC + MONAD_RPC override).
  const rpcFor = (chain: ChainName) => (chain === 'base' ? cfg.baseRpc : chain);
  return {
    async deriveAddresses(contractId, tokenId) {
      const fn = await need<any>('derive', 'derive', ['deriveAddresses', 'deriveForVault', 'derive', 'deriveAll']);
      const r = await fn(contractId, tokenId, cfg);
      const base = addr(r.base ?? r.evm ?? r.baseAddress);
      return { base, monad: r.monad ? addr(r.monad) : base, solana: addr(r.solana ?? r.sol ?? r.solanaAddress) };
    },
    async evmParams(from, chain = 'base') {
      const fn = await need<any>('evm', 'evm params', ['getEvmStepArgs', 'getStepArgs', 'evmStepArgs', 'getEvmParams']);
      return fn(from, rpcFor(chain));
    },
    async solanaParams() {
      const fn = await need<any>('solana', 'solana params', ['getSolanaStepArgs', 'getStepArgs', 'solanaStepArgs', 'getSolanaParams']);
      return fn(cfg.solanaRpc);
    },
    async broadcastEvm(raw, chain = 'base') {
      const fn = await need<any>('evm', 'evm broadcast', ['broadcastEvm', 'broadcast', 'sendRawTransaction']);
      return fn(raw, rpcFor(chain));
    },
    async broadcastSolana(raw) {
      const fn = await need<any>('solana', 'solana broadcast', ['broadcastSolana', 'broadcast', 'sendTransaction']);
      return fn(raw, cfg.solanaRpc);
    },
    async txLanded(chain, id) {
      if (chain !== 'solana') {
        const fn = await need<any>('evm', 'evm tx lookup', ['evmTxKnown']);
        return fn(id, rpcFor(chain));
      }
      const fn = await need<any>('solana', 'solana status lookup', ['solanaSignatureLanded']);
      return fn(id, cfg.solanaRpc);
    },
  };
}
