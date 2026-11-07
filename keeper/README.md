# keeper

Off-chain half of Dead Man's Wallet: the heartbeat daemon, the settlement keeper, and the demo helpers.
Node 22, TypeScript, run through `tsx` (no build step). Spec: [`SPEC.md`](../SPEC.md) section 3.

```bash
cd keeper && npm install
cp .env.example .env        # then fill it in; see the table below
npm test                    # 35 unit tests, no network
```

## Do X, see Y

| I want to... | Run | You will see |
| --- | --- | --- |
| try everything with no contract | `DMW_MOCK=1 npm run mock -- init --interval 20 --grace 1` | a local vault 1 that is Triggered after 40 s without a beat |
| keep a vault alive | `npm run pulse -- --token 1 --key ed25519:<pulse key> --interval 10` | `alive · next beat in 7s` every second, `♥ heartbeat sent <nearblocks link>` on each beat |
| make the owner disappear | press Ctrl-C in the pulse terminal | `pulse stopped — this is the moment the owner disappears` |
| run the keeper | `npm run keeper -- --poll 5` | one line per action: `poke`, `step 1/5` ... `step 5/5`, `relay`, `mark`, each with an explorer link |
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
- **keeper** polls `get_vaults`. Per vault it relays any `signed` payout first (Solana blockhashes expire in about 60-90 s), then `poke`s if the deadline passed, then calls `execute_step` until the vault is Settled. Before each step-3 call it fetches Base nonce and fees, or a Solana blockhash, from `src/chains/`. If a Solana sign does not advance the payout it retries once with a fresh blockhash. RPC errors are retried with exponential backoff and the loop never exits; use `--once` for a single pass.
- **agent-demo** reads the vault policy, sends an allowed payment (a tenth of `per_tx_max` to the first allowlisted receiver) and a denied one (twice `per_tx_max` to a random account), then prints the result and the NEP-297 `dmw` events from the receipt logs.

## Layout

- `src/machine.ts` pure state derivation, countdown math, step scheduling (unit tested)
- `src/keeperLoop.ts` the poll loop; `src/backend.ts` NEAR calls with retry; `src/mock.ts` the mock vault
- `src/chainsApi.ts` the interface to `src/chains/` (derive / evm / solana, written elsewhere). Until those modules exist the methods throw `not wired`.
- `src/commands/` one file per CLI command; `test/` vitest
