import { Command } from 'commander';
import pc from 'picocolors';
import { agentDemo } from './commands/agentDemo.js';
import { daoCreate } from './commands/dao.js';
import { deriveCommand } from './commands/derive.js';
import { dueCommand } from './commands/due.js';
import { pulseCommand } from './commands/pulse.js';
import { loadConfig, need } from './config.js';
import { agentBackend, funderFromEnv, getChains, keeperBackend, pulseBackend } from './factory.js';
import { funderCommand, fundSourcesCommand } from './commands/fund.js';
import { consoleLogger, makeDeps, runKeeper } from './keeperLoop.js';
import { countdown, formatDuration } from './machine.js';
import { MockBackend } from './mock.js';
import { notifierFromEnv } from './notify.js';
import { errMsg, formatYocto, foreignTxLink, termSafe } from './util.js';
import { viewBackend } from './factory.js';

const program = new Command('dmw').description("Lastword keeper and demo CLI (DMW_MOCK=1 for an offline mock vault)");

const run = (fn: () => Promise<void>) =>
  fn().catch((e) => {
    console.error(pc.red(`error: ${termSafe(errMsg(e))}`));
    process.exit(1);
  });

/** `--token` given but empty (`--token ""`, `--token ,`) is refused: read as "no filter" it would drive every vault. */
function tokenSet(ids: unknown): Set<string> | undefined {
  if (ids === undefined) return undefined;
  const set = new Set<string>(String(ids).split(',').map((x) => x.trim()).filter(Boolean));
  if (set.size === 0) throw new Error('--token needs at least one vault token id');
  for (const id of set) if (!/^\d+$/.test(id)) throw new Error(`--token: "${id}" is not a vault token id`);
  return set;
}

/** An empty prefix would match every vault on the contract, so it is refused instead of being read as "no filter". */
function ownerPrefixOf(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const p = String(raw).trim();
  if (!/^[a-z0-9._-]+$/.test(p)) throw new Error('--owner-prefix must be a non-empty run of NEAR account id characters (a-z, 0-9, ".", "_", "-")');
  return p;
}

const positive = (raw: unknown, flag: string): number => {
  const n = Number(raw);
  if (!(n > 0) || !Number.isFinite(n)) throw new Error(`${flag} must be a positive number of seconds`);
  return n;
};

program
  .command('derive')
  .description('print the derived Base, Monad and Solana source addresses for a vault')
  .requiredOption('--token <id>', 'vault token id')
  .option('--json', 'machine-readable output')
  .action((o) =>
    run(async () => {
      const cfg = loadConfig();
      const vault = await viewBackend(cfg).getVault(o.token);
      const r = await deriveCommand(getChains(cfg), need(cfg.contract, 'DMW_CONTRACT'), vault).catch((e) => {
        if (/not wired/.test(errMsg(e))) {
          console.error(pc.yellow(errMsg(e)));
          process.exit(2);
        }
        throw e;
      });
      if (o.json) return void console.log(JSON.stringify(r, null, 2));
      console.log(`${pc.bold('Base Sepolia')}  ${r.base.address}\n  path ${r.base.path} · fund: ${r.base.faucet}\n  ${r.base.explorer}`);
      console.log(`${pc.bold('Monad testnet')} ${r.monad.address}\n  path ${r.monad.path} · fund: ${r.monad.faucet}\n  ${r.monad.explorer}`);
      console.log(`${pc.bold('Solana devnet')} ${r.solana.address}\n  path ${r.solana.path} · fund: ${r.solana.faucet}\n  ${r.solana.explorer}`);
    }),
  );

program
  .command('status')
  .description('print a vault: state, countdown, settlement step, heirs and foreign payouts')
  .requiredOption('--token <id>', 'vault token id')
  .option('--json', 'raw VaultView JSON')
  .action((o) =>
    run(async () => {
      const cfg = loadConfig();
      const v = await viewBackend(cfg).getVault(o.token);
      if (o.json) return void console.log(JSON.stringify(v, null, 2));
      const c = countdown(v, Date.now());
      const when = c.state === 'Settled' || c.state === 'Triggered' ? '' : c.due ? ' · poke is legal now' : ` · warning in ${formatDuration(c.msToWarning)}, poke legal in ${formatDuration(c.msToTrigger)}`;
      console.log(`${pc.bold(`vault ${v.token_id}`)}  ${c.state}${when}`);
      console.log(`  owner ${v.owner_id} · interval ${v.heartbeat_interval_s}s grace ${v.grace_missed} · balance ${formatYocto(v.balance)} · step ${Math.min(v.step, 5)}/5 · keys ${v.pulse_keys.length} pulse, ${v.agent_keys.length} agent`);
      // Everything below is chain data (heirs, payout addresses, log details): printed through termSafe.
      console.log(termSafe(`  heirs ${v.heirs.map((h) => `${h.account_id} ${h.bps / 100}%`).join(', ')}`));
      for (const [i, p] of v.foreign.entries())
        console.log(termSafe(`  payout #${i} ${p.chain} ${p.amount} → ${p.to} · ${p.status}${p.tx_hash ? ' ' + foreignTxLink(p.chain, p.tx_hash) : ''}`));
      for (const l of v.log.slice(-5)) console.log(pc.dim(termSafe(`  ${new Date(l.ms).toISOString().slice(11, 19)} ${l.event} ${l.detail}`).slice(0, 140)));
    }),
  );

program
  .command('pulse')
  .description('heartbeat daemon: signs heartbeat as the contract account with the pulse key; Ctrl-C = the owner disappears')
  .requiredOption('--token <id>', 'vault token id')
  .option('--key <ed25519:...>', 'pulse function-call private key (or env DMW_PULSE_KEY)')
  .option('--interval <seconds>', 'seconds between beats', '60')
  .action((o) =>
    run(async () => {
      const cfg = loadConfig();
      const key = o.key || process.env.DMW_PULSE_KEY || (cfg.mock ? 'ed25519:mock' : '');
      const intervalS = Number(o.interval);
      if (!(intervalS > 0)) throw new Error('--interval must be a positive number of seconds');
      await pulseCommand({ backend: pulseBackend(cfg, need(key, '--key / DMW_PULSE_KEY')), tokenId: o.token, intervalS });
    }),
  );

program
  .command('keeper')
  .description('poll loop: poke overdue vaults, drive execute_step, relay signed foreign txs, mark_broadcast')
  .option('--poll <seconds>', 'poll interval', '5')
  .option('--once', 'run a single pass and exit')
  .option('--until-idle', 'sweep: keep polling until no matching vault is past its deadline or Triggered, then exit 0')
  .option('--max-seconds <n>', 'stop cleanly after this many seconds (exit 0; the next run continues)')
  .option('--token <ids>', 'only drive these vault token ids (comma separated); default: every vault')
  .option('--owner-prefix <prefix>', 'only drive vaults whose owner_id starts with this prefix (with --token, both must match)')
  .option('--fund-sources', 'top up foreign payout sources from the KEEPER_SEED funder before step III and on an unfunded relay (or DMW_FUND_SOURCES=1)')
  .action((o) =>
    run(async () => {
      const cfg = loadConfig();
      const pollS = positive(o.poll, '--poll');
      const maxSeconds = o.maxSeconds !== undefined ? positive(o.maxSeconds, '--max-seconds') : undefined;
      const ownerPrefix = ownerPrefixOf(o.ownerPrefix);
      const ac = new AbortController();
      process.once('SIGINT', () => ac.abort());
      process.once('SIGTERM', () => ac.abort());
      const funder = o.fundSources || process.env.DMW_FUND_SOURCES === '1' ? funderFromEnv(cfg, consoleLogger).funder : undefined;
      if (funder) consoleLogger.info('fund', `funding payout sources from ${funder.evmAddress} (Base, Monad) and ${funder.solanaAddress} (Solana), capped by FUND_CAP_* and FUND_RUN_CAP_*`);
      const deps = makeDeps({
        backend: keeperBackend(cfg),
        chains: getChains(cfg),
        contractId: cfg.contract,
        only: tokenSet(o.token),
        ownerPrefix,
        notifier: notifierFromEnv(process.env, cfg.contract, consoleLogger),
        funder,
      });
      const r = await runKeeper(deps, { pollS, once: !!o.once, untilIdle: !!o.untilIdle, maxSeconds, signal: ac.signal });
      // A run that hit the time limit without ever reading the vault list did no sweeping at all: say so with exit 1.
      if (r.reason === 'time_limit' && r.listed === 0) throw new Error(`could not read the vault list from ${cfg.contract} within ${maxSeconds}s`);
    }),
  );

program
  .command('due')
  .description('read-only check: is any (matching) vault past its deadline or Triggered? Prints work=true or work=false; sends nothing')
  .option('--token <ids>', 'only look at these vault token ids (comma separated)')
  .option('--owner-prefix <prefix>', 'only look at vaults whose owner_id starts with this prefix')
  .option('--json', 'machine-readable output')
  .option('--github-output', 'also append work=<true|false> and count=<n> to the file named by $GITHUB_OUTPUT')
  .action((o) =>
    run(async () => {
      const cfg = loadConfig();
      const githubOutput = o.githubOutput ? process.env.GITHUB_OUTPUT : undefined;
      if (o.githubOutput && !githubOutput) throw new Error('--github-output needs the GITHUB_OUTPUT environment variable (GitHub Actions sets it)');
      await dueCommand({
        backend: viewBackend(cfg),
        contract: need(cfg.contract, 'DMW_CONTRACT'),
        filter: { only: tokenSet(o.token), ownerPrefix: ownerPrefixOf(o.ownerPrefix) },
        json: !!o.json,
        githubOutput,
      });
    }),
  );

/** Progress lines of a command whose summary goes to stdout: on stderr, so `--json` output stays clean. */
const stderrLogger = {
  ok: (t: string, m: string) => process.stderr.write(`${t.padEnd(9)} ${termSafe(m)}\n`),
  warn: (t: string, m: string) => process.stderr.write(`${t.padEnd(9)} ${termSafe(m)}\n`),
  err: (t: string, m: string) => process.stderr.write(`${t.padEnd(9)} ${termSafe(m)}\n`),
  info: (t: string, m: string) => process.stderr.write(`${t.padEnd(9)} ${termSafe(m)}\n`),
};

program
  .command('funder')
  .description('print the funder wallet derived from KEEPER_SEED: its Base/Monad EVM address and Solana address with balances (never the keys)')
  .option('--json', 'machine-readable output')
  .action((o) =>
    run(async () => {
      const cfg = loadConfig();
      const { funder, rpc, caps } = funderFromEnv(cfg, stderrLogger);
      await funderCommand({ funder, rpc, caps, json: !!o.json });
    }),
  );

program
  .command('fund-sources')
  .description("top up a vault's foreign payout source addresses from the funder: exactly the shortfall, capped; exit 1 if any source is left short")
  .requiredOption('--token <id>', 'vault token id')
  .option('--dry-run', 'only print what would be sent')
  .option('--json', 'machine-readable output')
  .action((o) =>
    run(async () => {
      const cfg = loadConfig();
      const [tokenId] = [...(tokenSet(o.token) ?? [])];
      if (!tokenId || String(o.token).includes(',')) throw new Error('--token takes one vault token id');
      const { funder } = funderFromEnv(cfg, stderrLogger);
      const r = await fundSourcesCommand({ backend: viewBackend(cfg), chains: getChains(cfg), contract: need(cfg.contract, 'DMW_CONTRACT'), tokenId, funder, dryRun: !!o.dryRun, json: !!o.json });
      if (!r.ok) process.exitCode = 1;
    }),
  );

program
  .command('agent-demo')
  .description('two agent_pay calls signed with the agent key: one allowed, one denied; prints the on-chain events')
  .requiredOption('--token <id>', 'vault token id')
  .option('--key <ed25519:...>', 'agent function-call private key (or env DMW_AGENT_KEY)')
  .option('--receiver <account>', 'override the allowlisted receiver for the allowed call')
  .action((o) =>
    run(async () => {
      const cfg = loadConfig();
      const key = o.key || process.env.DMW_AGENT_KEY || (cfg.mock ? 'ed25519:mock' : '');
      await agentDemo({ backend: agentBackend(cfg, need(key, '--key / DMW_AGENT_KEY')), tokenId: o.token, receiver: o.receiver });
    }),
  );

const dao = program.command('dao').description('Sputnik DAO helpers');
dao
  .command('create')
  .description('create a Sputnik v2 DAO on testnet with the owner as council')
  .requiredOption('--name <name>', 'DAO name, e.g. estate-1')
  .option('--owner <account>', 'council member (default: the signing account)')
  .option('--account <account>', 'paying/signing account (default KEEPER_ACCOUNT_ID)')
  .option('--key <ed25519:...>', 'private key for --account (default KEEPER_PRIVATE_KEY)')
  .option('--purpose <text>', 'DAO purpose')
  .action((o) =>
    run(async () => {
      const r = await daoCreate(loadConfig(), o);
      if (r.ok) return void console.log(pc.green(`DAO created: ${r.daoId}`) + `\n  https://testnet-v2.sputnik.fund/#/${r.daoId}`);
      console.error(pc.red(`DAO creation failed for ${r.daoId}: ${r.hint}`));
      process.exit(1);
    }),
  );

const mock = program.command('mock').description('manage the local mock vault (DMW_MOCK=1)');
mock
  .command('init')
  .description('reset the mock vault: fresh state, token 1')
  .option('--interval <s>', 'heartbeat interval seconds', '20')
  .option('--grace <n>', 'grace_missed', '1')
  .option('--dao', 'attach a mock DAO id')
  .action((o) =>
    run(async () => {
      const v = new MockBackend().reset({ heartbeat_interval_s: Number(o.interval), grace_missed: Number(o.grace), withDao: !!o.dao });
      console.log(`mock vault ${v.token_id}: interval ${v.heartbeat_interval_s}s, grace ${v.grace_missed}, trigger after ${v.heartbeat_interval_s * (v.grace_missed + 1)}s without a beat`);
    }),
  );
mock
  .command('show')
  .description('print the mock vault')
  .action(() => run(async () => console.log(JSON.stringify(await new MockBackend().getVaults(), null, 2))));

program.parseAsync(process.argv);
