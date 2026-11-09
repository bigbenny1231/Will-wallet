// Read-only pre-check for a sweep: is any matching vault past its deadline or Triggered? Sends nothing.
import { appendFileSync } from 'node:fs';
import type { Backend } from '../backend.js';
import { isDue, matchesFilter, type VaultFilter } from '../machine.js';
import type { VaultView } from '../types.js';
import { termSafe } from '../util.js';

export interface DueReport {
  contract: string;
  owner_prefix: string | null;
  tokens: string[] | null;
  /** vaults on the contract */
  checked: number;
  /** vaults that pass the filter */
  matching: number;
  /** matching vaults past their deadline and not poked yet */
  due: string[];
  /** matching vaults that are Triggered (settlement unfinished) */
  triggered: string[];
  /** true when `due` or `triggered` is not empty */
  work: boolean;
}

export function findWork(vaults: VaultView[], now: number, filter: VaultFilter): Pick<DueReport, 'checked' | 'matching' | 'due' | 'triggered' | 'work'> {
  const matching = vaults.filter((v) => matchesFilter(v, filter));
  const due = matching.filter((v) => isDue(v, now)).map((v) => v.token_id);
  const triggered = matching.filter((v) => v.state === 'Triggered').map((v) => v.token_id);
  return { checked: vaults.length, matching: matching.length, due, triggered, work: due.length + triggered.length > 0 };
}

export interface DueOpts {
  backend: Pick<Backend, 'getVaults'>;
  contract: string;
  filter: VaultFilter;
  now?: () => number;
  json?: boolean;
  /** When set, `work=<true|false>` and `count=<n>` are appended to this file (the path in $GITHUB_OUTPUT). */
  githubOutput?: string;
  out?: { write(s: string): unknown };
}

export async function dueCommand(o: DueOpts): Promise<DueReport> {
  const out = o.out ?? process.stdout;
  const vaults = await o.backend.getVaults();
  const report: DueReport = {
    contract: o.contract,
    owner_prefix: o.filter.ownerPrefix ?? null,
    tokens: o.filter.only ? [...o.filter.only] : null,
    ...findWork(vaults, (o.now ?? Date.now)(), o.filter),
  };
  const count = report.due.length + report.triggered.length;
  if (o.githubOutput) appendFileSync(o.githubOutput, `work=${report.work}\ncount=${count}\n`);
  if (o.json) {
    out.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
  const scope = [report.owner_prefix !== null ? `owner prefix "${report.owner_prefix}"` : '', report.tokens ? `token ${report.tokens.join(',')}` : ''].filter(Boolean).join(' and ');
  out.write(termSafe(`checked ${report.checked} vaults on ${report.contract}; ${report.matching} match ${scope || 'no filter (every vault)'}`) + '\n');
  if (report.work) {
    const parts = [report.due.length ? `past deadline: ${report.due.join(', ')}` : '', report.triggered.length ? `Triggered: ${report.triggered.join(', ')}` : ''].filter(Boolean).join('; ');
    out.write(termSafe(`work=true  ${count} to settle (${parts})`) + '\n');
  } else {
    out.write('work=false  no matching vault is past its deadline or Triggered\n');
  }
  return report;
}
