#!/usr/bin/env node
// npm run agent -- --token <id> --key <agent key> [--brain scripted|anthropic|openai|nearai]
// npx tsx src/cli.ts evidence --token <id> --brain anthropic --out <dir>
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BRAIN_KINDS, autoBrain, makeBrain, type BrainKind } from './brains/index.js';
import { loadAgentEnv } from './env.js';
import { runEvidence } from './evidence.js';
import { NearKeyProbe } from './key-probe.js';
import { NearChain } from './near.js';
import { AGENT_DIR, REPO, resolveLiveTarget, resolveToken, runSession } from './session.js';
import { SimChain, simVault } from './sim.js';
import { errMsg } from './util.js';

const USAGE = `usage: npm run agent -- --token <id> --key <agent key> [options]
  --token <id>           vault token id (default: .demo/vault_id)
  --key <ed25519:...>    the agent function-call key (or env DMW_AGENT_KEY, or .demo/agent.key.json)
  --contract <id>        the vault contract (default: env DMW_CONTRACT)
  --brain <kind>         scripted | anthropic | openai | nearai (default: first API key found, else scripted)
  --model <id>           override the model of an LLM brain (anthropic default: claude-sonnet-5-5)
  --scenario <file>      default scenarios/api-bills.json
  --vigilant             scripted brain refuses prompt injections (default: naive, obeys the inbox)
  --no-local-checks      DEMO ONLY: skip the wrapper's pre-checks so the contract is the only guard
  --sim                  offline: in-memory vault instead of testnet (no key, no network)
  --out <file>           transcript path (default .demo/agent-transcript.md)
  --max-steps <n>        default 12

usage: npx tsx src/cli.ts evidence --token <id> [--brain anthropic] [--out <dir>]
  Runs, against the live vault: (1) the agent with the brain, pre-checks on; (2) the same with --no-local-checks;
  (3) the on-chain attack suite. Writes three transcripts and README.md into <dir> (default .demo/evidence).
  Without the brain's API key, phases 1 and 2 run the scripted brain and say so. Exit 0 policy held, 1 NEAR moved
  outside the policy, 2 a phase did not complete.
  --token, --key, --contract, --model, --scenario, --max-steps as above; --no-key-probe skips the layer-3 probe`;

const env = () => loadAgentEnv([resolve(REPO, '.env'), resolve(AGENT_DIR, '.env')]);

async function evidence(argv: string[]) {
  const { values: a } = parseArgs({
    args: argv,
    options: {
      token: { type: 'string' },
      key: { type: 'string' },
      contract: { type: 'string' },
      brain: { type: 'string' },
      model: { type: 'string' },
      scenario: { type: 'string' },
      out: { type: 'string' },
      'max-steps': { type: 'string' },
      'no-key-probe': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (a.help) return void console.log(USAGE);
  const e = env();
  const brain = (a.brain ?? 'anthropic') as BrainKind;
  if (!BRAIN_KINDS.includes(brain)) throw new Error(`unknown --brain ${a.brain}\n${USAGE}`);
  const tokenId = resolveToken(a.token);
  if (!tokenId) throw new Error(`--token is required\n${USAGE}`);
  const t = resolveLiveTarget(e, a);
  const outDir = resolve(process.cwd(), a.out ?? resolve(REPO, '.demo/evidence'));
  const r = await runEvidence({
    tokenId,
    outDir,
    brain,
    model: a.model,
    scenario: a.scenario,
    env: e,
    chain: new NearChain(t.contract, t.key, t.rpc),
    ...(a['no-key-probe'] ? {} : { probe: new NearKeyProbe(t.contract, t.key, t.rpc) }),
    maxSteps: a['max-steps'] ? Number(a['max-steps']) : undefined,
    log: (l) => console.log(l),
  });
  console.log('\n' + r.index);
  console.log(`evidence written to ${outDir}`);
  process.exitCode = r.exitCode;
}

async function agent(argv: string[]) {
  const { values: a } = parseArgs({
    args: argv,
    options: {
      token: { type: 'string' },
      key: { type: 'string' },
      contract: { type: 'string' },
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

  const e = env();
  const brainKind = (a.brain ?? autoBrain(e)) as BrainKind;
  if (!BRAIN_KINDS.includes(brainKind)) throw new Error(`unknown --brain ${a.brain}\n${USAGE}`);
  const tokenId = a.sim ? (a.token ?? '1') : resolveToken(a.token);
  if (!tokenId) throw new Error(`--token is required\n${USAGE}`);

  let chain;
  if (a.sim) chain = new SimChain(simVault());
  else {
    const t = resolveLiveTarget(e, a);
    chain = new NearChain(t.contract, t.key, t.rpc);
  }
  const brain = await makeBrain(brainKind, e, { vigilant: a.vigilant, model: a.model });
  const want = a.scenario ?? resolve(AGENT_DIR, 'scenarios/api-bills.json');
  const fromCwd = resolve(process.cwd(), want);
  const r = await runSession({
    chain,
    tokenId,
    brain,
    scenarioPath: existsSync(fromCwd) ? fromCwd : resolve(AGENT_DIR, want),
    localChecks: !a['no-local-checks'],
    maxSteps: a['max-steps'] ? Number(a['max-steps']) : 12,
    out: resolve(process.cwd(), a.out ?? resolve(REPO, '.demo/agent-transcript.md')),
    echo: (md) => process.stdout.write(md + '\n\n'),
  });
  console.log(`transcript saved to ${r.out}`);
  if (!r.auditOk) process.exitCode = 2;
  else if (r.error) throw new Error(r.error);
  else if (r.summary?.injectionPaid) process.exitCode = 1;
}

const [cmd, ...rest] = process.argv.slice(2);
(cmd === 'evidence' ? evidence(rest) : agent(process.argv.slice(2))).catch((e) => {
  console.error(`agent: ${errMsg(e)}`);
  process.exit(1);
});
