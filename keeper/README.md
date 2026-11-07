# keeper

Off-chain half of Dead Man's Wallet: the heartbeat daemon, the settlement keeper, and the demo helpers.
Node 22, TypeScript, run through `tsx` (no build step). Spec: [`SPEC.md`](../SPEC.md) section 3.

```bash
cd keeper && npm install
cp .env.example .env        # then fill it in; see the table below
npm test                    # 44 unit tests, no network
```

## Do X, see Y

| I want to... | Run | You will see |
| --- | --- | --- |
| try everything with no contract | `DMW_MOCK=1 npm run mock -- init --interval 20 --grace 1` | a local vault 1 that is Triggered after 40 s without a beat |
| keep a vault alive | `npm run pulse -- --token 1 --key ed25519:<pulse key> --interval 10` | in a terminal, a live `alive · next beat in 7s` countdown; `♥ heartbeat sent <nearblocks link>` on each beat (redirected to a file: only the beat lines, each with the next-beat time) |
| make the owner disappear | press Ctrl-C in the pulse terminal | `pulse stopped — this is the moment the owner disappears` |
| run the keeper | `npm run keeper -- --poll 5 [--token 5,6]` | one line per action: `poke`, `step 1/5` ... `step 5/5`, `relay`, `mark`, each with an explorer link |
| look at a vault | `npm run dmw -- status --token 1` | state, countdown, step, heirs, payouts and the last log lines |
| see where to fund the vault | `npm run derive -- --token 1` | Base Sepolia and Solana devnet source addresses plus faucet links |
| show the agent guard rails | `npm run agent-demo -- --token 1 --key ed25519:<agent key>` | one green `agent_pay_allowed` and one red `agent_pay_denied reason=over_per_tx_max` |
| create the estate DAO | `npm run dao -- create --name estate-1 --owner andrew.testnet` | `DAO created: estate-1.sputnik-v2.testnet`, or the exact `near` command to run by hand (exit 1) |

`npx dmw <command>` works too (same commands, same flags). Keys can come from `--key` or from `DMW_PULSE_KEY` / `DMW_AGENT_KEY`.

## Configuration

Read from the process environment, then `keeper/.env`, then the repo-root `.env`. Every variable is in [`.env.example`](.env.example).

| Variable | Used by | Notes |
| --- | --- | --- |
| `DMW_CONTRACT` | all | contract account id; the pulse and agent keys sign **as this account** |
| `KEEPER_ACCOUNT_ID`, `KEEPER_PRIVATE_KEY` | keeper, dao create | any funded testnet account; the keeper earns the poke bounty |
| `NEAR_NETWORK`, `NEAR_RPC` | all | default testnet, `https://rpc.testnet.near.org` |
| `BASE_RPC`, `SOLANA_RPC` | keeper, derive | defaults from SPEC section 1 |
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
- **keeper** polls `get_vaults`. Per vault it relays any `signed` payout first (Solana blockhashes expire in about 60-90 s), then `poke`s if the deadline passed, then calls `execute_step` until the vault is Settled. Before each step-3 call it fetches Base nonce and fees, or a Solana blockhash, from `src/chains/`. If a Solana sign does not advance the payout the keeper does not retry right away (a second signature over a live blockhash could double-pay); it waits for `resign_allowed_after_ms`. RPC errors are retried with exponential backoff and the loop never exits; use `--once` for a single pass. `--token 5,6` restricts the keeper to those vaults (without it every vault on the contract is driven).
- **relay failures never fail a payout.** An unfunded source (`insufficient funds` / `AccountNotFound`) is logged once, the payout stays `signed`, and the keeper retries every 60 s while it carries on with the remaining steps. A stale signed tx (expired Solana blockhash, EVM price/nonce problem) is handled under the hardened contract rules (SPEC 2.7): read `get_sign_track`, wait until `resign_allowed_after_ms` (5 min after the last request), check the old tx never landed (`getSignatureStatuses` / `eth_getTransactionByHash`; if it did, record it with `mark_broadcast` instead), then `resign_foreign`. EVM re-signs send max(fresh fees, 1.1 x last fees) for both fee fields with gas 21000..100000 and max fee at most 100 gwei (the contract ignores the nonce we send). Solana re-signs of a signed payout must come from the keeper account (`set_keeper`). At most 2 re-signs per payout, then a 5 min pause. A payout that is `broadcast` but whose hash is not on chain gets its stored `signed_tx` relayed again (no new `mark_broadcast`). `mark_broadcast` is only called after a successful broadcast.
- **gas:** `heartbeat` 10 TGas (the key allowance is charged on prepaid gas), `poke` 60, `execute_step` and `resign_foreign` 300, `mark_broadcast` 30.
- **agent-demo** reads the vault policy, sends an allowed payment (a tenth of `per_tx_max` to the first allowlisted receiver) and a denied one (twice `per_tx_max` to a random account), then prints the result and the NEP-297 `dmw` events from the receipt logs.

## Layout

- `src/machine.ts` pure state derivation, countdown math, step scheduling (unit tested)
- `src/keeperLoop.ts` the poll loop; `src/backend.ts` NEAR calls with retry; `src/mock.ts` the mock vault
- `src/chainsApi.ts` the interface to `src/chains/` (derive / evm / solana); `src/relay.ts` classifies relay errors
- `LIVE_RUN.md` a real testnet run with every tx link; `SHOWCASE.md` the demo-video vault and the addresses to fund
- `src/commands/` one file per CLI command; `test/` vitest
