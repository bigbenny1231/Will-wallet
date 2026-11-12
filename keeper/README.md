# keeper

Off-chain half of Dead Man's Wallet: the heartbeat daemon, the settlement keeper, and the demo helpers.
Node 22, TypeScript, run through `tsx` (no build step). Spec: [`SPEC.md`](../SPEC.md) section 3.

```bash
cd keeper && npm install
cp .env.example .env        # then fill it in; see the table below
npm test                    # 124 unit tests, no network
```

## Do X, see Y

| I want to... | Run | You will see |
| --- | --- | --- |
| try everything with no contract | `DMW_MOCK=1 npm run mock -- init --interval 20 --grace 1` | a local vault 1 that is Triggered after 40 s without a beat |
| keep a vault alive | `npm run pulse -- --token 1 --key ed25519:<pulse key> --interval 10` | in a terminal, a live `alive · next beat in 7s` countdown; `♥ heartbeat sent <nearblocks link>` on each beat (redirected to a file: only the beat lines, each with the next-beat time) |
| make the owner disappear | press Ctrl-C in the pulse terminal | `pulse stopped — this is the moment the owner disappears` |
| run the keeper | `npm run keeper -- --poll 5 [--token 5,6]` | one line per action: `poke`, `step 1/5` ... `step 5/5`, `relay`, `mark`, each with an explorer link |
| settle only some owners' vaults, then exit | `npm run keeper -- --until-idle --max-seconds 240 --owner-prefix dmw-guest-` | the same action lines for matching vaults only, then `nothing left to settle` and exit 0 |
| ask whether a sweep has work, without sending anything | `npm run dmw -- due --owner-prefix dmw-guest-` | `work=true  2 to settle (...)` or `work=false  no matching vault is past its deadline or Triggered` |
| look at a vault | `npm run dmw -- status --token 1` | state, countdown, step, heirs, payouts and the last log lines |
| see where to fund the vault | `npm run derive -- --token 1` | Base Sepolia, Monad testnet and Solana devnet source addresses (the vault's `derivation_paths`: `base-<id>-<salt>` etc. on contract v2, `base-<id>` on v1) plus faucet links |
| see the funder wallet that pays for payout sources | `KEEPER_SEED=... npm run dmw -- funder` | its EVM address (Base Sepolia and Monad testnet) and Solana address with balances; never a key |
| fund one vault's payout sources | `KEEPER_SEED=... npm run dmw -- fund-sources --token 7 [--dry-run]` | one line per source: `holds …, needs …: funded +0.0005002 ETH <basescan link>` or `enough` |
| run the keeper and fund sources as it goes | `KEEPER_SEED=... npm run keeper -- --fund-sources` | a `fund` line with a funding tx link before each step-III signature; relays that land |
| show the agent guard rails | `npm run agent-demo -- --token 1 --key ed25519:<agent key>` | one green `agent_pay_allowed` and one red `agent_pay_denied reason=receiver_not_allowlisted` (the denied call goes to an unknown receiver and is also over `per_tx_max`; the contract checks the receiver first) |
| create the estate DAO | `npm run dao -- create --name estate-1 --owner andrew.testnet` | `DAO created: estate-1.sputnik-v2.testnet`, or the exact `near` command to run by hand (exit 1) |

`npx dmw <command>` works too (same commands, same flags). Keys can come from `--key` or from `DMW_PULSE_KEY` / `DMW_AGENT_KEY`.

## Configuration

Read from the process environment, then `keeper/.env`, then the repo-root `.env`. Every variable is in [`.env.example`](.env.example).

| Variable | Used by | Notes |
| --- | --- | --- |
| `DMW_CONTRACT` | all | contract account id; the pulse and agent keys sign **as this account** |
| `KEEPER_ACCOUNT_ID`, `KEEPER_PRIVATE_KEY` | keeper, dao create | any funded testnet account; the keeper earns the poke bounty |
| `NEAR_NETWORK`, `NEAR_RPC` | all | default testnet, `https://rpc.testnet.fastnear.com` |
| `BASE_RPC`, `MONAD_RPC`, `SOLANA_RPC` | keeper, derive | defaults from SPEC section 1 (Base Sepolia, Monad testnet `https://testnet-rpc.monad.xyz`, Solana devnet) |
| `DMW_NOTIFY_WEBHOOK` | keeper | optional; webhook URL for owner notifications (see below). It is a secret and is never printed |
| `DMW_DASHBOARD_URL` | keeper | optional; base URL for the vault link in notifications, default `https://will-wallet.vercel.app` |
| `DMW_NOTIFY_NTFY_TOPIC`, `DMW_NOTIFY_NTFY_SERVER` | keeper | optional; phone push through [ntfy](https://ntfy.sh) (see below). The topic is a secret and is never printed |
| `KEEPER_SEED` | funder, fund-sources, keeper `--fund-sources` | at least 32 characters; the funder keys are derived from it (see below). The same secret the long-lived keeper's NEAR key comes from |
| `DMW_FUND_SOURCES=1` | keeper | same as `--fund-sources` |
| `FUND_CAP_ETH`, `FUND_CAP_MON`, `FUND_CAP_SOL` | funder | largest single top-up, default 0.002 ETH, 0.05 MON, 0.02 SOL |
| `FUND_RUN_CAP_ETH`, `FUND_RUN_CAP_MON`, `FUND_RUN_CAP_SOL` | funder | most one process sends in total, default 0.01 ETH, 0.25 MON, 0.1 SOL |
| `DMW_MOCK=1` | all | offline mock vault, state in `keeper/.mock-state.json` |

## Mock mode: demo before the contract exists

```bash
export DMW_MOCK=1
npm run mock -- init --interval 10 --grace 1     # token 1
npm run keeper -- --poll 1                        # terminal A
npm run pulse -- --token 1 --interval 4           # terminal B: vault stays Alive
# Ctrl-C terminal B: ~20 s later the keeper pokes, steps 1-5, relays, marks, and the vault is Settled
```

`npm run mock -- show` prints the vault JSON. Mock transaction hashes print as `(mock tx mock0007...)`, not links.

## How it behaves

- **pulse** signs `heartbeat({token_id})` with the pulse function-call key, with the contract account as the signer. It beats once on start, then every `--interval` seconds, and never exits on an RPC error.
- **keeper** polls `get_vaults`. Per vault it relays any `signed` payout first (Solana blockhashes expire in about 60-90 s), then `poke`s if the deadline passed, then calls `execute_step` until the vault is Settled. Before each step-3 call it fetches Base nonce and fees, or a Solana blockhash, from `src/chains/`. If a Solana sign does not advance the payout the keeper does not retry right away (a second signature over a live blockhash could double-pay); it waits for `resign_allowed_after_ms`. RPC errors are retried with exponential backoff and the loop never exits; use `--once` for a single pass. `--token 5,6` restricts the keeper to those vaults (without it every vault on the contract is driven). `--owner-prefix`, `--until-idle` and `--max-seconds` are described in the next section.
- **relay failures never fail a payout.** An unfunded source (`insufficient funds` / `AccountNotFound`) is logged once, the payout stays `signed`, and the keeper retries every 60 s while it carries on with the remaining steps. A stale signed tx (expired Solana blockhash, EVM price/nonce problem) is handled under the hardened contract rules (SPEC 2.7): read `get_sign_track`, wait until `resign_allowed_after_ms` (5 min after the last request), check the old tx never landed (`getSignatureStatuses` / `eth_getTransactionByHash`; if it did, record it with `mark_broadcast` instead), then `resign_foreign`. EVM re-signs send max(fresh fees, 1.1 x last fees) for both fee fields with gas 21000..100000 (we send 21000; the contract raises the EVM gas it signs with to its 50,000 floor, final audit H-5) and max fee within the chain's cap (Base 100 gwei, Monad 1000 gwei, read from `get_config().chains`) (the contract ignores the nonce we send). Solana re-signs of a signed payout must come from the keeper account (`set_keeper`). Contract v2: every re-sign and `mark_broadcast` must come from an operator (contract keeper, vault keeper, owner or heir), and the keeper's owner heartbeat path attaches 1 yoctoNEAR. Second v2 review: a `signed`/`broadcast` Solana payout is re-signed only by a keeper (contract keeper or vault keeper), never by an heir; a fee bump that would pass the chain cap is held at the cap (the contract accepts a fee at the cap as a bump); and EVM fees from an account that is not a keeper are clamped by the contract (max fee and priority fee at most 10 gwei on Base, 200 gwei on Monad; gas limit 50,000). A keeper may re-sign a signed EVM payout at any fee (G1), so when this backend's account is the contract or vault keeper (`isKeeperFor`) it re-signs at the fresh honest fees instead of a 1.1x bump. At most 2 re-signs per payout, then a 5 min pause. A payout that is `broadcast` but whose hash is not on chain gets its stored `signed_tx` relayed again (no new `mark_broadcast`). `mark_broadcast` is only called after a successful broadcast.
- **step III window:** during the first hour of step 3, and of each payout in it, the contract lets only an operator sign a payout (contract keeper, vault keeper, vault owner, heir; `step3_open_after_ms` in `get_config`). A keeper account that is not an operator does not call `execute_step` then: it reads the window start from the vault log (the latest `step_2` / `foreign_signed` / `foreign_failed` entry), parks the vault until the window opens, and logs once: `vault 9 step III: dmw-sweep-….testnet is not an operator of this vault …; the contract opens signing to anyone at 2026-11-12T13:00:05Z, retrying then (in 51 min)`. If the contract still refuses (the window start could not be read), the refusal parks the vault for 5 minutes and is not counted as a failed action.
- **gas:** `heartbeat` 10 TGas (the key allowance is charged on prepaid gas), `poke` 60, `execute_step` and `resign_foreign` 300, `mark_broadcast` 30.
- **agent-demo** reads the vault policy, sends an allowed payment (a tenth of `per_tx_max` to the first allowlisted receiver) and a denied one (twice `per_tx_max` to a random account), then prints the result and the NEP-297 `dmw` events from the receipt logs.

## Filters and the bounded sweep

**`--owner-prefix <prefix>`** restricts the keeper to vaults whose `owner_id` starts with the prefix. With `--token` as well, a vault must pass both.

- The filter is checked on the vault list and again before every action, against the view that action is based on. It covers `poke`, `execute_step`, relay, `mark_broadcast`, re-broadcast and `resign_foreign`. A vault outside the filter gets no transaction and no chain lookup.
- `owner_id` is the current holder of the Will NFT. It is the creator while the vault is Alive, Warning or Triggered, so the filter follows a vault through settlement. Step 5 hands the NFT to the primary heir. From then on the vault no longer matches and the keeper leaves it alone.
- One consequence: a signed payout that was not relayed before step 5 is not retried by a filtered keeper. It stays `signed`. Each signed payout gets one relay attempt as soon as it is signed, because relaying comes before the next step.
- One caveat: if the primary heir's account also starts with the prefix, the settled vault still matches, and the keeper may relay or re-sign its payouts.
- An empty prefix is refused. It would match every vault.

**`--once`** is exactly one pass. One pass does everything that is possible right now, but it does not wait. A vault whose signature is still in flight, or whose step failed, is left as it is.

**`--until-idle`** turns the loop into a sweep. After each pass it looks at the matching vaults. If none is past its deadline and none is Triggered, it prints `nothing left to settle` and exits 0. Otherwise it sleeps `--poll` seconds and runs another pass. With nothing to do it exits after one read and sends nothing.

- Work is still one unit per contract call: `poke`, then each `execute_step`. Waiting for an MPC signature happens between passes.
- Signed payouts that could not be relayed do not count as work. An unfunded source address keeps its payout `signed` and does not keep the sweep running.
- A failed read of the vault list is never treated as idle.

**`--max-seconds <n>`** stops the run after `n` seconds. The limit is checked before every action and between passes, and the last sleep is cut short to end on it. A transaction that is already in flight is awaited, so the process can end a little after the limit. The exit code is 0 and the log names the vaults still to settle; the next run continues from the contract state. The exit code is 1 only when the vault list could not be read even once.

**`due`** is the read-only pre-check. It calls `get_vaults`, applies the same `--owner-prefix` and `--token` filters, and prints `work=true` or `work=false`. It needs `DMW_CONTRACT` and no keeper account. `--json` prints the full report. `--github-output` also appends `work=<true|false>` and `count=<n>` to the file named by `$GITHUB_OUTPUT`. The exit code is 0 for both answers and 1 when the contract could not be read.

The keeper and `due` use the contract's `trigger_at_ms` when it is later than `last_beat + interval * (grace + 1)`, so a vault under a guardian pause (SPEC 2.8) is not poked early.

## Owner notifications

Set `DMW_NOTIFY_WEBHOOK` to a webhook URL and the keeper posts one JSON message when a vault it watches:

- goes from Alive to Warning (`event: "vault_warning"`), or
- becomes Triggered (`event: "vault_triggered"`).

There is one message per transition per vault. A heartbeat that brings the vault back to Alive sends nothing; if it later misses again, that is a new transition and a new message. Settled sends nothing.

```json
{
  "text": "Vault 12 missed a heartbeat. Settlement becomes possible at 2026-11-09 17:00:00 UTC unless a heartbeat arrives first. https://will-wallet.vercel.app/vault/12",
  "content": "Vault 12 missed a heartbeat. Settlement becomes possible at 2026-11-09 17:00:00 UTC unless a heartbeat arrives first. https://will-wallet.vercel.app/vault/12",
  "event": "vault_warning",
  "token_id": "12",
  "owner_id": "andrew.testnet",
  "warning_at_ms": 1794236400000,
  "trigger_at_ms": 1794243600000,
  "contract": "dmw-x8cx.testnet"
}
```

`text` is the field Slack incoming webhooks read and `content` is the field Discord webhooks read; both hold the same line. Other receivers can use the structured fields. `DMW_DASHBOARD_URL` replaces the base of the link.

- Only transitions the running process saw are reported. A vault that is already in Warning when the keeper starts gets no warning message, so a restart never repeats one. This means notifications need the long-running keeper. A sweep is a new process each time and never sees Alive turn into Warning.
- With `--token` or `--owner-prefix`, only matching vaults are reported.
- The POST has a 5 second timeout. It is sent in the background and awaited at the end of the pass, so it does not hold up a settlement action. A failure is logged as `notify ... was not delivered (HTTP 404)` and the loop carries on. Nothing is retried.
- The webhook URL is a secret. It is never written to the log; error text is stripped of the URL, its host and its path before it is printed.
- Tested with an injected `fetch` in `test/notify.test.ts`. No message has been posted to a real Slack or Discord webhook from this code yet.

## Funding payout sources

Each vault's foreign payouts are signed by NEAR Chain Signatures for per-vault derived source addresses (`derive`). Nothing else funds those addresses, so without a top-up the relay finds them unfunded and no payout lands. The funder wallet pays exactly what each source is short.

**The funder wallet** is derived from `KEEPER_SEED` with the same HKDF construction as the long-lived keeper's NEAR key (`scripts/near-admin.mjs derive-keeper`): HKDF-SHA256 with ikm = the seed as UTF-8, salt = `dmw-keeper`, 32 bytes.

- EVM key (one key for Base Sepolia and Monad testnet): info `evm funder key v1`, read big-endian. It must be a valid secp256k1 scalar (1 ≤ k < n). If not (probability about 2⁻¹²⁸), the info becomes `evm funder key v1#1`, `#2`, … and the first valid output is the key. No mod-n reduction.
- Solana key: info `solana funder key v1`, used as the ed25519 seed.

Fund the funder once by hand from the faucets (`dmw funder` prints the addresses and explorer links). After that, every top-up is unattended.

```text
$ KEEPER_SEED=… npm run dmw -- funder
funder wallet (derived from KEEPER_SEED; fund these addresses, the keys are never printed)
  Base Sepolia   0x0B5F…f1C2  0.05 ETH  https://sepolia.basescan.org/address/0x0B5F…f1C2
  Monad testnet  0x0B5F…f1C2  2 MON  https://testnet.monadexplorer.com/address/0x0B5F…f1C2
  Solana devnet  8xY5…jnHL  1.5 SOL  https://explorer.solana.com/address/8xY5…jnHL?cluster=devnet
  caps: per top-up 0.002 ETH / 0.05 MON / 0.02 SOL; per run 0.01 ETH / 0.25 MON / 0.1 SOL

$ KEEPER_SEED=… npm run dmw -- fund-sources --token 7
vault 7 base   0x7F98…5f3b  holds 0 ETH, needs 0.0005002 ETH: funded +0.0005002 ETH  https://sepolia.basescan.org/tx/0x…
vault 7 monad  0xa8fd…4b91  holds 0 MON, needs 0.0302 MON: funded +0.0302 MON  https://testnet.monadexplorer.com/tx/0x…
vault 7 solana CPRM…hZdc  holds 0 SOL, needs 0.010005 SOL: funded +0.010005 SOL  https://explorer.solana.com/tx/…?cluster=devnet
```

`--dry-run` prints `would send …` and sends nothing; `--json` prints the report; progress lines go to stderr. The exit code is 1 when a source is left short (cap, guest rule, failed send).

**What a source must hold** (only payouts that are not `broadcast` count):

- Base Sepolia and Monad testnet: a signed payout needs exactly value + gas limit × max fee of its signed tx (a node checks that before it accepts the tx). An unsigned payout needs amount + 2 × 50,000 gas × the current max fee, where max fee = 2 × base fee + priority fee: the price the keeper signs payouts with (`getEvmStepArgs`). 50,000 is the gas limit the contract signs with (its floor, final audit H-5); Monad bills the full limit. A signed payout whose nonce is already mined is skipped; a broadcast one that is not mined yet still counts against the balance.
- Monad reserve rule ([docs](https://docs.monad.xyz/developer-essentials/reserve-balance)): a tx may leave its sender below 10 MON only if the sender sent nothing in the last 3 blocks, and consensus checks a sender against its balance as of 3 blocks back. A source address sends one tx in its life (one Monad payout per vault, nonce 0), so the payout always qualifies, and amount + gas is enough; no 10 MON reserve is needed. After a Monad top-up the funder waits until 3 blocks have passed: the payout is then checked against the funded balance, and the funder's own next Monad tx keeps the same exception (so the funder may itself hold less than 10 MON). A top-up that is included but reverted is reported as failed.
- Solana devnet: amount + 5000 lamports. With one payout the source is funded to exactly that and ends at 0. If something is already there, the top-up leaves at least the rent-exempt minimum (890,880 lamports) behind instead of a smaller remainder; a fresh account that would get less than that minimum gets need + minimum.

**Caps:** a top-up above `FUND_CAP_*` is refused, and a process stops sending once `FUND_RUN_CAP_*` would be passed (counted when a top-up is sent). Guest vaults (owner `dmw-guest-…`) are funded only when every payout is within the amounts the dashboard's guest mode creates (`dashboard/src/pages/Try.tsx`: 0.0001 ETH on Base, 0.001 SOL on Solana, no Monad), so strangers' guest vaults cannot drain the funder.

**In the keeper:** `--fund-sources` (or `DMW_FUND_SOURCES=1`) tops a vault's sources up right before each step-III signature, so a Solana signature is never made for an empty source and does not go stale waiting for funds. When a relay still reports `unfunded`, the keeper tops up once for that signed tx and relays again at once; a second `unfunded` result parks the payout for 60 s as before. A stale signature still goes through the `resign_foreign` rules above (5 minute cooldown).

Tested with an in-memory chain (`test/funder.test.ts`): derivation vectors cross-checked with `node:crypto`, the decoder against the contract-signed vectors in `src/chains/selfcheck.ts`, shortfall math, caps, guest rule, skips, and the keeper-loop paths. No top-up has been sent to a real chain from this code yet.

## Phone push with ntfy

[ntfy](https://ntfy.sh) is a free push service with phone apps and no account. Install the app, subscribe to a long, hard-to-guess topic, and set:

```bash
DMW_NOTIFY_NTFY_TOPIC=dmw-pick-a-long-random-topic   # letters, digits, - and _, at most 64
# DMW_NOTIFY_NTFY_SERVER=https://ntfy.sh             # default; a self-hosted server works too
```

The keeper then sends the same notices as the webhook (Warning, Triggered; same rules, same text) as a plain POST to `<server>/<topic>` with headers `Title` (`Vault 12 missed a heartbeat` / `Vault 12 triggered: settlement started`), `Tags` (`warning` / `rotating_light`), `Priority` (`default` / `high`) and `Click` (the vault page, so a tap opens the dashboard). It works next to `DMW_NOTIFY_WEBHOOK` or alone. Anyone who knows the topic can read the pushes, so the topic is treated as a secret and never logged. Tested with an injected `fetch` in `test/notify.test.ts`; no push has been sent to ntfy.sh from this code yet.

## Hosted guest sweep (GitHub Actions)

The dashboard's guest mode creates throwaway accounts named `dmw-guest-<random>.testnet`, each with a short-interval vault on the public contract. A visitor who leaves would otherwise leave that vault overdue with nobody to settle it. [`.github/workflows/keeper.yml`](../.github/workflows/keeper.yml) (`guest-sweep`) settles those vaults and no others.

It runs every 10 minutes and on manual dispatch, one run at a time:

1. Checkout, Node 22, `npm ci` in `keeper/`.
2. Pre-check, read-only: `npx tsx src/cli.ts due --owner-prefix dmw-guest- --github-output`. With `work=false` the job ends here. No account is created and nothing is sent.
3. With `work=true` it picks a keeper account. If the repository secrets `KEEPER_ACCOUNT_ID` and `KEEPER_PRIVATE_KEY` are both set it uses them. Otherwise it creates a one-off account `dmw-sweep-<random>.testnet` from the testnet faucet with `node scripts/near-admin.mjs create`, masks the new key in the log, and passes it to the keeper through the environment. The keeper earns the poke bounty, so the account pays for its own gas.
4. Sweep: `npx tsx src/cli.ts keeper --until-idle --max-seconds 240 --owner-prefix dmw-guest- --poll 5`.

The contract and RPC come from the repository variables `DMW_CONTRACT` (default `dmw-885364.testnet`; `dmw-979268.testnet` on Nov 11 and 12 2026, `dmw-x8cx.testnet` before that) and `NEAR_RPC` (default `https://rpc.testnet.fastnear.com`). The workflow passes them as environment variables; there is no `.env` on the runner.

Setup: none is required. One optional step: add the repository secrets `KEEPER_ACCOUNT_ID` and `KEEPER_PRIVATE_KEY` (Settings, Secrets and variables, Actions) for a funded testnet account. Then the sweep does not depend on the faucet, and that account can be registered with `set_keeper` so it may re-sign stale Solana payouts. Use a testnet account that holds nothing else.

What to expect:

- Foreign payouts of guest vaults are signed and stay `signed`. Their derived source addresses are unfunded, so the relay fails and is not retried after settlement. The keeper can fund them (`--fund-sources` with a `KEEPER_SEED` secret; guest amounts only), but the workflow does not pass that flag yet.
- A one-off faucet account is not the contract's registered keeper. It cannot re-sign a signed Solana payout. That only matters for a funded source with an expired blockhash.
- Each run that finds work without the secrets leaves one faucet account behind with its remaining testnet NEAR. If the faucet refuses, that run fails and the next one tries again.
- `DMW_NOTIFY_WEBHOOK` is not passed to the workflow. Guest vaults have no owner to notify.
- GitHub may start scheduled runs late, and it disables schedules in a repository with no activity for 60 days.

What has been tested: the filter, the sweep and the pre-check are unit-tested against the mock backend (`test/sweep.test.ts`). The pre-check was run read-only against `dmw-x8cx.testnet` on 2026-11-09, before the first guest run on the live contract, and reported 19 vaults, none of them a guest vault, `work=false`. The sweep step's shell script was dry-run locally with a stub in place of the faucet and the mock backend. The same command settled an abandoned guest vault on a private testnet copy on 2026-11-09 (see `dashboard/README.md`). The workflow has run on GitHub on its schedule since 2026-11-10 04:31 UTC. Its first live sweep was vault 24 on `dmw-x8cx.testnet`, a guest vault created at 04:56 UTC and left alone on purpose: the next scheduled run made a one-off account (`dmw-sweep-d8d431e9f8.testnet`), poked the vault and ran all five steps to Settled (`docs/FINAL_REVIEW.md`).

## Layout

- `src/machine.ts` pure state derivation, countdown math, step scheduling (unit tested)
- `src/keeperLoop.ts` the poll loop; `src/backend.ts` NEAR calls with retry; `src/mock.ts` the mock vault
- `src/chainsApi.ts` the interface to `src/chains/` (derive / evm / solana); `src/relay.ts` classifies relay errors
- `src/notify.ts` owner notifications (webhook, ntfy); `src/commands/due.ts` the read-only sweep pre-check
- `src/funder.ts` source top-ups and caps; `src/commands/fund.ts` the `funder` and `fund-sources` commands; `src/step3.ts` the step III operator window
- `LIVE_RUN.md` a real testnet run with every tx link; `SHOWCASE.md` the demo-video vault and the addresses to fund
- `src/commands/` one file per CLI command; `test/` vitest
