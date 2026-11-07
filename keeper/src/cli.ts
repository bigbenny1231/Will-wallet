import { Command } from 'commander';
import pc from 'picocolors';
import { agentDemo } from './commands/agentDemo.js';
import { daoCreate } from './commands/dao.js';
import { deriveCommand } from './commands/derive.js';
import { pulseCommand } from './commands/pulse.js';
import { loadConfig, need } from './config.js';
import { agentBackend, getChains, keeperBackend, pulseBackend } from './factory.js';
import { makeDeps, runKeeper } from './keeperLoop.js';
import { countdown, formatDuration } from './machine.js';
import { MockBackend } from './mock.js';
import { errMsg, formatYocto, foreignTxLink } from './util.js';
import { viewBackend } from './factory.js';

const program = new Command('dmw').description("Dead Man's Wallet keeper and demo CLI (DMW_MOCK=1 for an offline mock vault)");

const run = (fn: () => Promise<void>) =>
  fn().catch((e) => {
    console.error(pc.red(`error: ${errMsg(e)}`));
    process.exit(1);
  });

program
  .command('derive')
  .description('print the derived Base and Solana source addresses for a vault')
  .requiredOption('--token <id>', 'vault token id')
  .option('--json', 'machine-readable output')
  .action((o) =>
    run(async () => {
      const cfg = loadConfig();
      const r = await deriveCommand(getChains(cfg), need(cfg.contract, 'DMW_CONTRACT'), o.token).catch((e) => {
        if (/not wired/.test(errMsg(e))) {
          console.error(pc.yellow(errMsg(e)));
          process.exit(2);
        }
        throw e;
      });
      if (o.json) return void console.log(JSON.stringify(r, null, 2));
      console.log(`${pc.bold('Base Sepolia')}  ${r.base.address}\n  path ${r.base.path} · fund: ${r.base.faucet}\n  ${r.base.explorer}`);
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
      console.log(`  heirs ${v.heirs.map((h) => `${h.account_id} ${h.bps / 100}%`).join(', ')}`);
      for (const [i, p] of v.foreign.entries())
        console.log(`  payout #${i} ${p.chain} ${p.amount} → ${p.to} · ${p.status}${p.tx_hash ? ' ' + foreignTxLink(p.chain, p.tx_hash) : ''}`);
      for (const l of v.log.slice(-5)) console.log(pc.dim(`  ${new Date(l.ms).toISOString().slice(11, 19)} ${l.event} ${l.detail}`.slice(0, 140)));
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
  .option('--token <ids>', 'only drive these vault token ids (comma separated); default: every vault')
  .action((o) =>
    run(async () => {
      const cfg = loadConfig();
      const ac = new AbortController();
      process.once('SIGINT', () => ac.abort());
      process.once('SIGTERM', () => ac.abort());
      const deps = makeDeps({ backend: keeperBackend(cfg), chains: getChains(cfg), contractId: cfg.contract, only: o.token ? new Set<string>(String(o.token).split(',').map((x) => x.trim()).filter(Boolean)) : undefined });
      await runKeeper(deps, { pollS: Number(o.poll), once: !!o.once, signal: ac.signal });
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
