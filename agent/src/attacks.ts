#!/usr/bin/env node
// npm run attacks [-- --record] [-- --full]
// Runs every attack scenario offline in the simulator with the naive scripted brain, prints the scoreboard, saves the
// full report to .demo/attack-suite.md, and exits non-zero if any attack moved NEAR outside the policy.
// No key, no network, no LLM.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_DIR, renderFinalLine, renderReport, renderSummary, runSuite, suiteExitCode } from './attack-suite.js';
import { errMsg } from './util.js';

const USAGE = `usage: npm run attacks [-- --record] [-- --full]
  --record    also rewrite agent/ATTACK_SUITE.md, the committed copy of the report
  --full      print the per-attack sections too (they are always in the saved report)`;

async function main() {
  const { values: a } = parseArgs({ options: { record: { type: 'boolean' }, full: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (a.help) return void console.log(USAGE);

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
