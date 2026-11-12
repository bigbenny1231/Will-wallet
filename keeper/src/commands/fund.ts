// `funder` (addresses and balances of the funder wallet) and `fund-sources` (top up one vault's payout sources).
import type { Backend } from '../backend.js';
import type { Chains } from '../chainsApi.js';
import { vaultPaths } from '../chains/derive.js';
import { chainConfig } from '../chains/evm.js';
import { solanaExplorerAddress } from '../chains/solana.js';
import { type FundCaps, type Funder, type TopUp, formatAmount, guestRefusal } from '../funder.js';
import type { ChainName } from '../types.js';
import { errMsg, termSafe } from '../util.js';

type Out = { write(s: string): unknown };

const CHAINS: { chain: ChainName; name: string }[] = [
  { chain: 'base', name: 'Base Sepolia' },
  { chain: 'monad', name: 'Monad testnet' },
  { chain: 'solana', name: 'Solana devnet' },
];

export interface FunderReport {
  evm_address: string;
  solana_address: string;
  balances: Record<ChainName, { address: string; balance?: string; display?: string; error?: string; explorer: string }>;
  caps: { per_top_up: Record<ChainName, string>; per_run: Record<ChainName, string> };
}

const capStrings = (c: FundCaps['perTopUp']) => ({ base: formatAmount(c.base, 'base'), monad: formatAmount(c.monad, 'monad'), solana: formatAmount(c.solana, 'solana') });

export async function funderCommand(o: { funder: Funder; rpc: { evmBalance(c: 'base' | 'monad', a: string): Promise<bigint>; solBalance(a: string): Promise<bigint> }; caps: FundCaps; json?: boolean; out?: Out }): Promise<FunderReport> {
  const out = o.out ?? process.stdout;
  const f = o.funder;
  const read = async (chain: ChainName) => {
    const address = chain === 'solana' ? f.solanaAddress : f.evmAddress;
    const explorer = chain === 'solana' ? solanaExplorerAddress(address) : chainConfig(chain).explorerAddress(address);
    try {
      const b = chain === 'solana' ? await o.rpc.solBalance(address) : await o.rpc.evmBalance(chain, address);
      return { address, balance: b.toString(), display: formatAmount(b, chain), explorer };
    } catch (e) {
      return { address, error: errMsg(e), explorer };
    }
  };
  const [base, monad, solana] = await Promise.all([read('base'), read('monad'), read('solana')]);
  const report: FunderReport = {
    evm_address: f.evmAddress,
    solana_address: f.solanaAddress,
    balances: { base, monad, solana },
    caps: { per_top_up: capStrings(o.caps.perTopUp), per_run: capStrings(o.caps.perRun) },
  };
  if (o.json) {
    out.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
  out.write('funder wallet (derived from KEEPER_SEED; fund these addresses, the keys are never printed)\n');
  for (const { chain, name } of CHAINS) {
    const b = report.balances[chain];
    out.write(termSafe(`  ${name.padEnd(14)} ${b.address}  ${b.display ?? `balance unavailable (${b.error})`}  ${b.explorer}`) + '\n');
  }
  const c = report.caps;
  out.write(`  caps: per top-up ${c.per_top_up.base} / ${c.per_top_up.monad} / ${c.per_top_up.solana}; per run ${c.per_run.base} / ${c.per_run.monad} / ${c.per_run.solana}\n`);
  return report;
}

export interface FundReport {
  contract: string;
  token_id: string;
  dry_run: boolean;
  refused: string | null;
  sources: { chain: ChainName; source: string; payouts: number[]; balance: string; need: string; shortfall: string; status: TopUp['status'] | 'would_fund'; reason?: string; tx?: string; link?: string }[];
  /** true when every source holds enough (or was topped up) */
  ok: boolean;
}

export async function fundSourcesCommand(o: {
  backend: Pick<Backend, 'getVault'>;
  chains: Pick<Chains, 'deriveAddresses'>;
  contract: string;
  tokenId: string;
  funder: Funder;
  dryRun?: boolean;
  json?: boolean;
  out?: Out;
}): Promise<FundReport> {
  const out = o.out ?? process.stdout;
  const v = await o.backend.getVault(o.tokenId);
  const sources = await o.chains.deriveAddresses(o.contract, vaultPaths(v));
  const refused = guestRefusal(v);
  let tops: TopUp[] = [];
  if (!refused) {
    if (o.dryRun) {
      tops = await o.funder.plan(v, sources);
      for (const t of tops) {
        if (t.status === 'enough') continue;
        const r = o.funder.capRefusal(t.chain, t.shortfall);
        t.reason = r ?? undefined;
      }
    } else {
      tops = await o.funder.fundVault(v, sources);
    }
  }
  const report: FundReport = {
    contract: o.contract,
    token_id: v.token_id,
    dry_run: !!o.dryRun,
    refused,
    sources: tops.map((t) => ({
      chain: t.chain,
      source: t.source,
      payouts: t.indexes,
      balance: t.balance.toString(),
      need: t.need.toString(),
      shortfall: t.shortfall.toString(),
      status: o.dryRun && t.status !== 'enough' ? (t.reason ? 'skipped' : 'would_fund') : t.status,
      ...(t.reason ? { reason: t.reason } : {}),
      ...(t.hash ? { tx: t.hash, link: t.link } : {}),
    })),
    ok: !refused && tops.every((t) => t.status === 'enough' || t.status === 'funded' || (!!o.dryRun && !t.reason)),
  };
  if (o.json) {
    out.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
  if (refused) {
    out.write(termSafe(`vault ${v.token_id}: not funded (${refused})`) + '\n');
    return report;
  }
  if (report.sources.length === 0) out.write(`vault ${v.token_id}: no payout needs funding (none, or all broadcast)\n`);
  for (const s of report.sources) {
    const c = s.chain;
    const head = `vault ${v.token_id} ${c.padEnd(6)} ${s.source}  holds ${formatAmount(BigInt(s.balance), c)}, needs ${formatAmount(BigInt(s.need), c)}`;
    const tail =
      s.status === 'enough'
        ? 'enough'
        : s.status === 'funded'
          ? `funded +${formatAmount(BigInt(s.shortfall), c)}  ${s.link}`
          : s.status === 'would_fund'
            ? `would send ${formatAmount(BigInt(s.shortfall), c)} (dry run)`
            : `${s.status}: ${s.reason}`;
    out.write(termSafe(`${head}: ${tail}`) + '\n');
  }
  return report;
}
