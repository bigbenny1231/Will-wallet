#!/usr/bin/env node
// npm run agent -- --token <id> --key <agent key> [--brain scripted|anthropic|openai|nearai]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runAgent } from './agent.js';
import { BRAIN_KINDS, autoBrain, makeBrain, type BrainKind } from './brains/index.js';
import { loadAgentEnv } from './env.js';
import { loadScenario } from './inbox.js';
import { NearChain } from './near.js';
import { SimChain, simVault } from './sim.js';
import { Transcript, formatHeader } from './transcript.js';
import { Wallet } from './wallet.js';
import { errMsg } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(here, '..');
const REPO = resolve(AGENT_DIR, '..');

const USAGE = `usage: npm run agent -- --token <id> --key <agent key> [options]
  --token <id>           vault token id (default: .demo/vault_id)
  --key <ed25519:...>    the agent function-call key (or env DMW_AGENT_KEY, or .demo/agent.key.json)
  --brain <kind>         scripted | anthropic | openai | nearai (default: first API key found, else scripted)
  --model <id>           override the model of an LLM brain
  --scenario <file>      default scenarios/api-bills.json
  --vigilant             scripted brain refuses prompt injections (default: naive, obeys the inbox)
  --no-local-checks      DEMO ONLY: skip the wrapper's pre-checks so the contract is the only guard
  --sim                  offline: in-memory vault instead of testnet (no key, no network)
  --out <file>           transcript path (default .demo/agent-transcript.md)
  --max-steps <n>        default 12`;

async function main() {
  const { values: a } = parseArgs({
    options: {
      token: { type: 'string' },
      key: { type: 'string' },
      brain: { type: 'string' },
      model: { type: 'string' },
      scenario: { type: 'string' },
      out: { type: 'string' },
      'max-steps': { type: 'string' },
      vigilant: { type: 'boolean' },
      'no-local-checks': { type: 'boolean' },
      sim: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (a.help) return void console.log(USAGE);

  const env = loadAgentEnv([resolve(REPO, '.env'), resolve(AGENT_DIR, '.env')]);
  const brainKind = (a.brain ?? autoBrain(env)) as BrainKind;
  if (!BRAIN_KINDS.includes(brainKind)) throw new Error(`unknown --brain ${a.brain}\n${USAGE}`);

  const demoFile = (n: string) => resolve(REPO, '.demo', n);
  const tokenId = a.token ?? (a.sim ? '1' : existsSync(demoFile('vault_id')) ? readFileSync(demoFile('vault_id'), 'utf8').trim() : '');
  if (!tokenId) throw new Error(`--token is required\n${USAGE}`);

  let chain;
  if (a.sim) {
    chain = new SimChain(simVault());
  } else {
    const contract = env.DMW_CONTRACT;
    if (!contract) throw new Error('DMW_CONTRACT is not set (repo-root .env)');
    let key = a.key ?? env.DMW_AGENT_KEY;
    if (!key && existsSync(demoFile('agent.key.json'))) key = JSON.parse(readFileSync(demoFile('agent.key.json'), 'utf8')).private_key;
    if (!key) throw new Error(`no agent key: pass --key, set DMW_AGENT_KEY, or run make demo\n${USAGE}`);
    chain = new NearChain(contract, key, env.NEAR_RPC);
  }

  const wallet = new Wallet({ chain, tokenId, localChecks: !a['no-local-checks'] });
  const audit = await wallet.audit();
  const vault = await wallet.snapshot();
  const scenarioFile = resolve(process.cwd(), a.scenario ?? resolve(AGENT_DIR, 'scenarios/api-bills.json'));
  const scenario = loadScenario(existsSync(scenarioFile) ? scenarioFile : resolve(AGENT_DIR, a.scenario!), { PROVIDER: vault.policy.allowlist[0] ?? 'provider.testnet' });
  const brain = await makeBrain(brainKind, env, { vigilant: a.vigilant, model: a.model });

  const transcript = new Transcript((md) => process.stdout.write(md + '\n\n'));
  transcript.add(
    formatHeader(
      { scenario: scenario.name, brain: brain.label, contract: chain.contractId, tokenId, agentKey: chain.publicKey, localChecks: wallet.localChecks, startedAt: new Date().toISOString() },
      vault,
      audit,
    ),
  );
  if (!audit.ok) {
    transcript.add('*Refusing to run: the key is not scoped to `agent_pay` on this vault contract.*');
    save(transcript, a.out);
    process.exitCode = 2;
    return;
  }
  transcript.add(`*Scenario:* ${scenario.description}`);
  const summary = await runAgent({ brain, wallet, scenario, transcript, maxSteps: a['max-steps'] ? Number(a['max-steps']) : 12 });
  const out = save(transcript, a.out);
  console.log(`transcript saved to ${out}`);
  if (summary.injectionPaid) process.exitCode = 1;
}

function save(t: Transcript, out?: string): string {
  const p = resolve(process.cwd(), out ?? resolve(REPO, '.demo/agent-transcript.md'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, t.toMarkdown());
  return p;
}

main().catch((e) => {
  console.error(`agent: ${errMsg(e)}`);
  process.exit(1);
});
