// One agent run against a vault, from chain to saved transcript. Shared by `npm run agent` (cli.ts) and the evidence
// command (evidence.ts). The transcript is saved whatever happens: it is the record of what the agent did.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent.js';
import { loadScenario, scenarioVars } from './inbox.js';
import { SimChain, simPreset, simVault } from './sim.js';
import { Transcript, formatHeader, inline, type Summary } from './transcript.js';
import type { Brain, VaultChain } from './types.js';
import { errMsg } from './util.js';
import { Wallet } from './wallet.js';

const here = dirname(fileURLToPath(import.meta.url));
export const AGENT_DIR = resolve(here, '..');
export const REPO = resolve(AGENT_DIR, '..');
export const demoFile = (n: string, repo = REPO) => resolve(repo, '.demo', n);

export interface LiveTarget {
  contract: string;
  key: string;
  rpc?: string;
}

/**
 * Where the live vault is and which key signs for the agent. Same sources as `npm run agent`: --contract or
 * DMW_CONTRACT; --key, else DMW_AGENT_KEY, else .demo/agent.key.json. The key is never printed.
 */
export function resolveLiveTarget(env: Record<string, string | undefined>, a: { contract?: string; key?: string }, repo = REPO): LiveTarget {
  const contract = a.contract ?? env.DMW_CONTRACT;
  if (!contract) throw new Error('DMW_CONTRACT is not set (environment or the repo-root .env), and no --contract was given');
  let key = a.key ?? env.DMW_AGENT_KEY;
  if (!key && existsSync(demoFile('agent.key.json', repo))) key = JSON.parse(readFileSync(demoFile('agent.key.json', repo), 'utf8')).private_key;
  if (!key) throw new Error('no agent key: pass --key, set DMW_AGENT_KEY, or run make demo (writes .demo/agent.key.json)');
  return { contract, key, ...(env.NEAR_RPC ? { rpc: env.NEAR_RPC } : {}) };
}

/** --token, else .demo/vault_id. */
export function resolveToken(token: string | undefined, repo = REPO): string {
  if (token) return token;
  const f = demoFile('vault_id', repo);
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
}

export interface SessionOpts {
  chain: VaultChain;
  tokenId: string;
  brain: Brain;
  /** Set when the brain that runs is not the one asked for. Printed in the transcript header. */
  brainRequested?: string;
  brainNote?: string;
  phase?: string;
  scenarioPath: string;
  localChecks: boolean;
  maxSteps?: number;
  out: string;
  /** Echo each transcript block as it is added (the CLI streams to stdout). */
  echo?: (md: string) => void;
  now?: () => Date;
}

export interface SessionResult {
  out: string;
  auditOk: boolean;
  summary?: Summary;
  /** The run stopped on an error (brain, RPC). The transcript still holds everything up to it. */
  error?: string;
  markdown: string;
}

export async function runSession(o: SessionOpts): Promise<SessionResult> {
  const transcript = new Transcript(o.echo);
  const sim = o.chain instanceof SimChain ? o.chain : undefined;
  const wallet = new Wallet({ chain: o.chain, tokenId: o.tokenId, localChecks: o.localChecks });
  const finish = (r: Omit<SessionResult, 'out' | 'markdown'>): SessionResult => {
    mkdirSync(dirname(o.out), { recursive: true });
    const markdown = transcript.toMarkdown();
    writeFileSync(o.out, markdown);
    return { ...r, out: o.out, markdown };
  };
  let auditOk = false;
  try {
    const audit = await wallet.audit();
    auditOk = audit.ok;
    let vault = await wallet.snapshot();
    const scenario = loadScenario(o.scenarioPath, scenarioVars(vault.policy.allowlist, o.chain.contractId));
    if (sim && scenario.attack?.vault && scenario.attack.vault !== 'alive') {
      // An attack scenario may ask for a simulated vault state (the owner missed a beat).
      const now = Date.now();
      sim.vault = simVault(now, simPreset(scenario.attack.vault, now));
      vault = await wallet.snapshot();
    }
    transcript.add(
      formatHeader(
        {
          scenario: scenario.name,
          brain: o.brain.label,
          ...(o.brainRequested ? { brainRequested: o.brainRequested } : {}),
          ...(o.brainNote ? { brainNote: o.brainNote } : {}),
          ...(o.phase ? { phase: o.phase } : {}),
          contract: o.chain.contractId,
          tokenId: o.tokenId,
          agentKey: o.chain.publicKey,
          localChecks: wallet.localChecks,
          startedAt: (o.now ?? (() => new Date()))().toISOString(),
        },
        vault,
        audit,
      ),
    );
    if (!audit.ok) {
      transcript.add('*Refusing to run: the key is not scoped to `agent_pay` on this vault contract.*');
      return finish({ auditOk });
    }
    transcript.add(`*Scenario:* ${inline(String(scenario.description ?? ''))}`);
    const summary = await runAgent({ brain: o.brain, wallet, scenario, transcript, maxSteps: o.maxSteps ?? 12 });
    return finish({ auditOk, summary });
  } catch (e) {
    const error = errMsg(e);
    transcript.add(`*The run stopped on an error: ${inline(error)}*`);
    return finish({ auditOk, error });
  }
}
