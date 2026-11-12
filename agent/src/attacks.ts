#!/usr/bin/env node
// npm run attacks [-- --record] [-- --full]
//   Runs every attack scenario offline in the simulator with the naive scripted brain, prints the scoreboard, saves the
//   full report to .demo/attack-suite.md, and exits non-zero if any attack moved NEAR outside the policy.
//   No key, no network, no LLM.
// npm run attacks -- --onchain --token <id> [--contract <id>] [--key <agent key>] [--out <file>]
//   The same seven attacks against a LIVE vault: the deployed contract is layer 2. Sends real testnet transactions
//   with the agent's function-call key (gas from its allowance; bounded attacks move real NEAR within the policy).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { onchainExitCode, renderOnchainFinalLine, renderOnchainReport, renderOnchainScoreboard, runOnchainSuite } from './attack-onchain.js';
import { AGENT_DIR, renderFinalLine, renderReport, renderSummary, runSuite, suiteExitCode } from './attack-suite.js';
import { loadAgentEnv } from './env.js';
import { NearKeyProbe } from './key-probe.js';
import { NearChain } from './near.js';
import { REPO, resolveLiveTarget, resolveToken } from './session.js';
import { errMsg } from './util.js';

const USAGE = `usage: npm run attacks [-- --record] [-- --full]
  --record    also rewrite agent/ATTACK_SUITE.md, the committed copy of the report
  --full      print the per-attack sections too (they are always in the saved report)

usage: npm run attacks -- --onchain --token <id> [--contract <id>] [--key <agent key>] [--out <file>]
  --onchain       run against the live vault (DMW_CONTRACT, DMW_AGENT_KEY or .demo/agent.key.json, NEAR_RPC)
  --out <file>    report path (default .demo/attack-suite-onchain.md)
  --no-direct     do not send the requests the wrapper refuses on input straight to the contract
  --no-key-probe  do not sign the non-payment requests with the agent key to show the node rejecting them`;

async function onchain(a: { token?: string; contract?: string; key?: string; out?: string; 'no-direct'?: boolean; 'no-key-probe'?: boolean }) {
  const env = loadAgentEnv([resolve(REPO, '.env'), resolve(AGENT_DIR, '.env')]);
  const tokenId = resolveToken(a.token);
  if (!tokenId) throw new Error(`--token is required with --onchain\n${USAGE}`);
  const t = resolveLiveTarget(env, a);
  const result = await runOnchainSuite({
    chain: new NearChain(t.contract, t.key, t.rpc),
    tokenId,
    direct: !a['no-direct'],
    ...(a['no-key-probe'] ? {} : { probe: new NearKeyProbe(t.contract, t.key, t.rpc) }),
    log: (l) => console.log(l),
  });
  const out = resolve(process.cwd(), a.out ?? resolve(REPO, '.demo/attack-suite-onchain.md'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderOnchainReport(result));
  if (!result.refused) process.stdout.write('\n' + renderOnchainScoreboard(result) + '\n\n');
  console.log(renderOnchainFinalLine(result));
  console.log(`full report, with every transaction, saved to ${out}`);
  process.exitCode = onchainExitCode(result);
}

async function main() {
  const { values: a } = parseArgs({
    options: {
      record: { type: 'boolean' },
      full: { type: 'boolean' },
      onchain: { type: 'boolean' },
      token: { type: 'string' },
      contract: { type: 'string' },
      key: { type: 'string' },
      out: { type: 'string' },
      'no-direct': { type: 'boolean' },
      'no-key-probe': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (a.help) return void console.log(USAGE);
  if (a.onchain) {
    if (a.record) throw new Error('--record rewrites the simulated ATTACK_SUITE.md; it does not apply to --onchain (use --out)');
    return onchain(a);
  }

  const result = await runSuite();
  process.stdout.write((a.full ? renderReport(result) : renderSummary(result)) + '\n');

  const out = resolve(AGENT_DIR, '..', '.demo/attack-suite.md');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderReport(result, { linkBase: '../agent/' }));
  console.log('full report, with every call of every attack, saved to .demo/attack-suite.md');
  if (a.record) {
    writeFileSync(resolve(AGENT_DIR, 'ATTACK_SUITE.md'), renderReport(result));
    console.log('recorded copy written to agent/ATTACK_SUITE.md');
  }

  console.log(renderFinalLine(result));
  if (result.escaped > 0) console.error(`attacks: ${result.escaped} attack${result.escaped === 1 ? '' : 's'} moved NEAR outside the policy`);
  else if (result.incomplete > 0) console.error(`attacks: ${result.incomplete} attack${result.incomplete === 1 ? '' : 's'} did not run to the end`);
  process.exitCode = suiteExitCode(result);
}

main().catch((e) => {
  console.error(`attacks: ${errMsg(e)}`);
  process.exit(1);
});
