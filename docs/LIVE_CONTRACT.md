# The live contract: `dmw-885364.testnet` (Nov 12 2026)

`dmw-885364.testnet` runs contract v2 and replaces `dmw-979268.testnet`. The contract was hardened after a fourth
review pass ([`SECURITY_FIXES_V2.md`](SECURITY_FIXES_V2.md)); `dmw-979268.testnet` runs v1, has no full-access key and
could not be upgraded, and v2 changes the storage layout, so v2 went to a new account. The records of earlier
contracts are in [`docs/history/`](history/README.md).

Everything below was done by the repository's own `testnet` workflow ([`.github/workflows/testnet.yml`](../.github/workflows/testnet.yml)),
run by the author from the Actions tab. Every account is a throwaway testnet faucet account whose key existed only on the
GitHub runner; the logs are on the `ci/testnet-results` branch (`results/<run id>/`).

## Deploy (run 43288158721)

| What | Proof |
| --- | --- |
| Code: `contracts/release/dmw.wasm`, 497,329 bytes, sha256 `7229e044…4247`, the reproducible build of source commit [`6c58110`](https://github.com/bigbenny1231/Will-wallet/tree/6c581107017ad53414a2970a1b85497c35d4c57d) (see [Reproducible build](#reproducible-build)) | on-chain `code_hash` **`8geWkWLte1vsnVStUZtoNkNoL2b6sgLh5wPuSH9n4tna`**, the same hash the build printed |
| Deploy and `new({"owner_id":"dmw-885364.testnet","keeper_id":"dmw-keeper-2f6dcb.testnet"})` in **one** transaction (`new` is private in v2) | [deploy + init](https://testnet.nearblocks.io/txns/B4h939RafZ3c7z24aJ9U6FyG7JwCypwGjjKQX4VsRTr2) |
| Showcase vault 1 (owner `dmw-andrew-13bf.testnet`, heirs `dmw-sarah-13bf.testnet` 60 % and `dmw-ben-13bf.testnet` 40 %, 60-day interval, grace 1, 5 NEAR, Base / Monad / Solana payouts) | [create_vault](https://testnet.nearblocks.io/txns/2LDbKGY6tV3PWuKNNUtUhYodVofyUFo9TMtxmbJN9tLf), [set_foreign_payouts](https://testnet.nearblocks.io/txns/3M5rJw47q9zRghyZPQSJTLr2LekjtWKs1CYjkotwNY3i) |
| **Locked:** the contract account's only full-access key deleted. Nobody, the author included, can deploy new code to it; a fix means a fresh account | [delete key](https://testnet.nearblocks.io/txns/GAQEFX9eiRxtqkJjdKFyvEUzJBFkkN1qe3gZSWCmncm4); the workflow then printed `full-access keys left on dmw-885364.testnet: 0`, and `view_access_key_list` returned `[]` at block 277405086 (function-call keys of running vaults appear there while those vaults run) |

Check it yourself:

```bash
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"dmw-885364.testnet"}}'   # code_hash
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"dmw-885364.testnet"}}'   # no FullAccess key
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"dmw-885364.testnet","method_name":"contract_source_metadata","args_base64":"e30="}}' \
  | python3 -c 'import sys,json;print(bytes(json.load(sys.stdin)["result"]["result"]).decode())'                                              # NEP-330 link + build_info
```

## Reproducible build

| | |
| --- | --- |
| Code hash | **`8geWkWLte1vsnVStUZtoNkNoL2b6sgLh5wPuSH9n4tna`** (sha256 hex `7229e0449924c5da231091e7427ca717943efdfcd5088d4fc789232bde624247`), 497,329 bytes |
| Source | commit [`6c581107017ad53414a2970a1b85497c35d4c57d`](https://github.com/bigbenny1231/Will-wallet/tree/6c581107017ad53414a2970a1b85497c35d4c57d), `contracts/dmw` |
| Toolchain | `cargo near build reproducible-wasm` (cargo-near 0.23.0) in `sourcescan/cargo-near:0.23.0-rust-1.99.1`, pinned by digest `sha256:8013f039e8005627f10ae66b5519d1a6eeeed7d7aef4b5067d5e9a86c4302fcc` in `contracts/dmw/Cargo.toml` |
| On chain | `view_account dmw-885364.testnet` returns that `code_hash`. `contract_source_metadata` carries the NEP-330 `build_info`: the image with its digest, the build command, `contracts/dmw`, and `source_code_snapshot` `git+https://github.com/bigbenny1231/will-wallet?rev=6c581107017ad53414a2970a1b85497c35d4c57d`; its `link` points to the same commit |
| In the repo | `contracts/release/dmw.wasm` on master is this build, committed by the CI bot in `219c7aa` (log: `release-build.log` of run 43288158721) |

Verify it (needs Docker and cargo-near 0.23.0). The commit id is part of the embedded NEP-330 metadata, so build that
commit, not a later one:

```bash
git clone https://github.com/bigbenny1231/Will-wallet && cd Will-wallet
git checkout 6c581107017ad53414a2970a1b85497c35d4c57d
cd contracts/dmw && cargo near build reproducible-wasm    # or `make build-reproducible` from the root
# prints "SHA-256 checksum bs58: 8geWkWLte1vsnVStUZtoNkNoL2b6sgLh5wPuSH9n4tna", the code_hash from view_account above
```

## Smoke test, vault 2 (`contracts/smoke.sh`, same run)

| Step | Transaction | Result |
| --- | --- | --- |
| create_vault, 5 NEAR, heirs 60 / 40, agent policy | [tx](https://testnet.nearblocks.io/txns/G3RQyqTrfopxTRuVumhUct4eGYi7hERT8fnjaPURqgN9) | vault 2 |
| add_pulse_key, add_agent_key | [pulse](https://testnet.nearblocks.io/txns/4sUmigjx4dYz7gXLzhedY7RFFpzcgNe4sP5o59CG5ReC), [agent](https://testnet.nearblocks.io/txns/75jCa4tsuvHjhHpa1LQbHdMhGWoni65Zv14M9soLKG8T) | two function-call keys on the contract, `["heartbeat"]` and `["agent_pay"]` |
| heartbeat signed by the pulse key | [tx](https://testnet.nearblocks.io/txns/8BtTTTGQsFnLiDdtZew5KZEA2QkFx1vvMSAng7tyq2nw) | beat recorded |
| owner heartbeat without a deposit, then with 1 yoctoNEAR (v2, finding F) | [rejected](https://testnet.nearblocks.io/txns/6iTFkyK2xvq5J7hXCLkAp2r72TCDmVoLLQFN4cMg6cb8), [accepted](https://testnet.nearblocks.io/txns/4y2tt6kdJ4ZDG8gKTgYZH4ne31tcCiwBpgWq1XUmaXvZ) | the first panics `Requires attached deposit of exactly 1 yoctoNEAR`; the second records the beat |
| pulse key calls agent_pay | none | rejected by NEAR before execution (key scope) |
| agent_pay 0.3 NEAR to the allowlisted receiver | [tx](https://testnet.nearblocks.io/txns/CwFpQeNW7YrkryKdqDXSXKEiuEQKjw6PC2FwhMdGM8bL) | allowed |
| agent_pay 0.9 NEAR | [tx](https://testnet.nearblocks.io/txns/ASrki5NJ5BLikdxfnEa9WtvSShg6pGZHCEGhrVpCzNTq) | denied, `over_per_tx_max` |
| agent_pay to a receiver not on the allowlist | [tx](https://testnet.nearblocks.io/txns/HmeECQHy6giraJiFguxnftqxqDpEV6GcAFLf7cfGZNzs) | denied, `receiver_not_allowlisted` |
| agent_pay 0.4 NEAR, then 0.4 NEAR again | [allowed](https://testnet.nearblocks.io/txns/DF8Mvhaqx1t376HNer8uLdL8ZfZMWwaAorY7BhUuwJzX), [denied](https://testnet.nearblocks.io/txns/9EPGiBR2BRdjyKJnf57FTL1zudCr57a2mkRhPDMKPD82) | second one denied, `over_daily_max` |
| set_timing 20 s / grace 1, last heartbeat | [set_timing](https://testnet.nearblocks.io/txns/49p8Ci7zAMPDF3vHJnkGEdRNqUNtUXUsKEm9f1LkDqtq), [beat](https://testnet.nearblocks.io/txns/Enr7319HBF9y4UZXFC59p34k8LTDwEtLE6jNGW2pX7fx) | |
| poke too early | [tx](https://testnet.nearblocks.io/txns/Fg9QpkQrDmN9KFDhqMA7tHE1mMh4cQLZpgE3JfVHqiih) | rejected, `not_due` |
| poke after the deadline (heir earns the bounty) | [tx](https://testnet.nearblocks.io/txns/CvhmAuNdsJEvxXoFb6YGdhKfG6aquDsu4EHzKGkSnozu) | Triggered, 0.05 NEAR bounty |
| heartbeat after the trigger | [tx](https://testnet.nearblocks.io/txns/97742PnNaJGybKdpUBSydsnPuWbNVLMvCU71THcvKA6U) | rejected, `vault_triggered` |
| steps I to V | [I](https://testnet.nearblocks.io/txns/qrqCXfPpoAtEnN4vAi7zmSsJFsQi8EfmtxJ4mDJrBnS) heirs paid 1.29 / 0.86 NEAR, [II](https://testnet.nearblocks.io/txns/3NDBBzh9CjKWB8fRJoTYGyVSELMQKLYm6GkbDL2CNTp7) 2 keys deleted, [III](https://testnet.nearblocks.io/txns/G8RqKSYnL5UkdVjGHfVLxM2Uq394cuQUH3LTBAs6Pipw), [IV](https://testnet.nearblocks.io/txns/Hmvb4kh2R3ha3bv5raT6Kq2DFzxG1tNA7UGMGc8EzgUi) no DAO, skipped, [V](https://testnet.nearblocks.io/txns/6NVKxvsCEHZ1kCeWXLbb8MLVcmzuhDB9xxH1CCxXbwn) Will NFT to the primary heir, released storage split 60 / 40 | Settled; a sixth call is [rejected](https://testnet.nearblocks.io/txns/91XqRnu4Q3QTFjcbVAqZdkLtc5cDwrC86zxHLWvy21qz) `already_settled` |
| pulse and agent keys on the contract after settlement | none | both gone |
| claim by the Will NFT's new owner | [tx](https://testnet.nearblocks.io/txns/9VM2X6vAvuzA6NLGsETeEGsavjBwz3mnza5tvsQjrFEo) | 0.1 NEAR reserve paid |

## C-2 drain attempt, vault 3 (`contracts/attack-c2.sh`, same run)

The attack from [`SECURITY_REVIEW_3.md`](SECURITY_REVIEW_3.md), run live against `dmw-885364.testnet`. The attacker
`dmw-att-36c7.testnet` deploys [`contracts/tools/evil-dao`](../contracts/tools/evil-dao) to its sub-account
`dao.dmw-att-36c7.testnet`: its `add_proposal` keeps the 1 NEAR bond and returns a promise that fails. On the code
before the C-2 fix the vault got the bond back as well and `claim` paid 1 NEAR more than the vault held, out of other
vaults' NEAR. At the start: attacker 7.9858, heir 0.5000, "DAO" 1.5000, contract account 17.1341 NEAR.

| Step | Transaction | Result |
| --- | --- | --- |
| deploy the evil DAO | [tx](https://testnet.nearblocks.io/txns/Eogi5JhnoFYFmnUiGPZFChxLDk4YtMRa6KxvnjQS9Q4c) | |
| create_vault, 10 s interval, grace 0, 1.7 NEAR, heir 100 % | [tx](https://testnet.nearblocks.io/txns/3MbrsAeamBT48QcPayvEvv7VtcHENo6ic4LFjCQcadHA) | vault 3, balance 1.6 NEAR |
| set_dao to the evil DAO | [tx](https://testnet.nearblocks.io/txns/E4FLSmUnBFhJ1USWa4x8ZHfZHScyLLdCn4zndDso4ni2) | |
| poke | [tx](https://testnet.nearblocks.io/txns/74df83nys7KPkLpDGDwsAvHGJ31UnWt5cjGiPxy4m1tf) | Triggered, 0.01 NEAR bounty |
| steps I to III | [I](https://testnet.nearblocks.io/txns/9LfB8f2wXAS4xeTYVdy9mJg3X6itTdicRYKVzMvuPYzv), [II](https://testnet.nearblocks.io/txns/GedXFVdrLkp2TeBTEwtu4qtj8Mz62po4mdHZ7DacipCn), [III](https://testnet.nearblocks.io/txns/77jUVabhhdRRhEKQUdvkKFeHQZnLD2zyS2FhEPCgBzkn) | vault balance 1.5 NEAR (the reserve with a DAO) |
| **step IV: the "DAO" keeps the bond** | [tx](https://testnet.nearblocks.io/txns/BbynLc57Cz6iUiqTgr2vacBkAgWbhsdywWLVJ5zc7X6N) | `staged failure: the bond was kept`, `dao_proposal_failed` logged; **vault balance 0.5 NEAR**, the bond is not credited back |
| step V | [tx](https://testnet.nearblocks.io/txns/HYWrqrksuRkyhXwFUBNFZ1GUrwYmWox3AELmi66YBZn4) | Settled, 0.5 NEAR; the released storage (0.0696 NEAR) goes to the heir |
| claim by the heir | [tx](https://testnet.nearblocks.io/txns/9XnasVLjouNA5C8VKqykqzsa4YTQZRje3FDKRjtD2Dif) | **0.5 NEAR**, exactly what the vault held |

Result: attacker, heir and "DAO" together **-0.0355 NEAR**; the contract account went from 17.1341 to 17.1644 NEAR, so
no other vault paid for anything. The script ends with
`C-2 drain: BLOCKED (bond not credited back, attacker lost money)`, and fails the workflow otherwise.

## The hosted keeper

The repository's `keeper` workflow ([`.github/workflows/keeper.yml`](../.github/workflows/keeper.yml)) runs every 10
minutes. A read-only view call checks for vaults that are past their deadline or Triggered; when there is one, the
keeper pokes it and runs its steps until nothing is due, relays any signed foreign payout and records its hash with
`mark_broadcast`. It signs as the contract keeper: a long-lived `dmw-keeper-<8 hex>.testnet` account whose key is
derived on the runner from the repository secret `KEEPER_SEED` (`node scripts/near-admin.mjs derive-keeper`), and it
tops itself up from the faucet. Details: [`keeper/README.md`](../keeper/README.md#hosted-keeper).

Vaults do not depend on any one keeper: a vault owner can also name a per-vault keeper with `set_vault_keeper`
(1 yoctoNEAR), the vault owner and every heir are operators and can run the steps, `poke` and `execute_step` are open
to any account, and step III is open to anyone once its 1-hour operator window has passed (`step3_open_after_ms`
3600000 in `get_config`).

## The demo video, vault 4 (run 43290509255)

The 2:50 demo on the site (`site/assets/demo-v4-720p.mp4`, and the 2:14 X cut `site/assets/demo-v4-x-720p.mp4`) is one real
run of vault 4 on this contract, Nov 12 2026, from the phone's first beat at 19:31:00 UTC to Settled at 19:43:33. Owner
`dmw-demo-owner-0d86db.testnet`; heirs `dmw-demo-sarah-2667.testnet` 60 % (primary) and `dmw-demo-ben-2667.testnet`
40 %; agent allowlist `dmw-demo-api-2667.testnet`; guardian `dmw-demo-guardian-2667.testnet` (max pause 600 s); 60 s
interval, grace 1. How it was filmed and cut: [`docs/video/README.md`](video/README.md) (v4).

**Vault keeper.** The owner named the demo keeper `dmw-keeper-bc6af4.testnet` as vault 4's keeper with
`set_vault_keeper`. That keeper poked the vault and ran the five steps.

| Time (UTC) | What happens | Proof |
| --- | --- | --- |
| setup | `make demo`: create_vault (4 NEAR), set_vault_keeper, CLI pulse key and agent key, Base + Solana payouts, the agent-demo allowed/denied pair; then `tools/v4/setup.sh`: a 1.5 NEAR deposit, the phone's pulse key, Base + Monad + Solana payouts and the guardian | [create_vault](https://testnet.nearblocks.io/txns/BKgEmaqNg4b2QVVCpSF2C7ZemJbZsUzAPfYJhyqaTEMu), [set_vault_keeper](https://testnet.nearblocks.io/txns/2AKYGnZBwr1tvWJJ8KwHxRVDVzDthyVLeFAGHcoRZsmU), [pulse key](https://testnet.nearblocks.io/txns/4SsAFHFWrRPe3i9jSzGfFoe9tQpRmZ2FTLGoqRtX17sg), [agent key](https://testnet.nearblocks.io/txns/GVaT54JAQ7FXRbUcK95DNYUZkfEznyGWS8c5vAxEvHAy), [Base + Solana payouts](https://testnet.nearblocks.io/txns/2SDNtH9zD7GhmbPAfVsSruvKEkwMzXgzFkBwCojDSKaJ), [allowed](https://testnet.nearblocks.io/txns/9zuCxuiz1akKL2aaj6XASCxw2jkWdqa4oSidEW8orRk5), [denied](https://testnet.nearblocks.io/txns/C2hsbdtzBLx6VWmk66J5XQRrnsCthBMf7ZfgQsXZkZTg), [deposit](https://testnet.nearblocks.io/txns/567LbmF1VceBGK1nD8dYyZ4N1pdu7LaL7J9oaExYqY17), [phone key](https://testnet.nearblocks.io/txns/GCAueShuBtGYELg2zUXKLuh8j2kQxa1u33N2nD9Nh58V), [three payouts](https://testnet.nearblocks.io/txns/E1csn16ctFAaLnMdfGpbjH6fa1hmbgF3Gmf34a6bqmY4), [guardian](https://testnet.nearblocks.io/txns/7yacvH79n9JwWT27gk1hNriHTPooGbaqBA7waYbYmiHf) |
| 19:31:00 to 19:33:12 | the phone beats about every 20 s (heartbeats signed in the browser with the phone key) | phone page, dashboard |
| 19:31:57 | `make agent` (scripted brain): INV-2041, 0.12 NEAR, allowed | [tx](https://testnet.nearblocks.io/txns/GiBg2hTapA1uMu39Wv9YJoCKHqqHXKiGtEio8PMwTLEA) |
| 19:32:00 | INV-2042, 0.08 NEAR, allowed | [tx](https://testnet.nearblocks.io/txns/FZj6GKDAcnzL4AkWfA8bzWjvuvnfw87oNmKo7KyinsPj) |
| 19:32:00 | the brain obeys the planted injection (2.45 NEAR to `stranger.testnet`); the wallet wrapper refuses, nothing signed | agent ledger (no tx exists) |
| 19:32:08 | run 2, wrapper checks off: the contract denies 2.25 NEAR, `receiver_not_allowlisted`, logged | [tx](https://testnet.nearblocks.io/txns/BdAe16wBKJdoiNWZVntmusJjEckiyFvatwzsBZBdybRJ) |
| 19:32:34 | the guardian pauses: the deadline moves from 19:34:27 to 19:42:33 (`paused` event, `paused_until_ms` 1794512553117) | event in the run's `events.json`; the logs keep only the tail of this tx hash, so no link |
| 19:33:15 | hold to stop on the phone; last beat 19:33:12 | phone page |
| 19:34:15 | the keeper sees Warning | keeper ledger |
| 19:42:38 | the vault keeper pokes: Triggered, 0.05 NEAR bounty | [poke](https://testnet.nearblocks.io/txns/4aobfntQWvsB4FUhSaQtvxNFvNMKNCcuCod9n8mPXHAE) |
| 19:42:42 | step I: heirs paid on NEAR, 60 / 40 | [step 1](https://testnet.nearblocks.io/txns/GfRYEWBSYKTgWwqjPFEXykxFvPvPzBb9dAXH6fe7KTiw) |
| 19:42:46 | step II: pulse and agent keys deleted | [step 2](https://testnet.nearblocks.io/txns/2pUzmF1psUBL1FZAdkvqMaSAZkwuYHhfNcQLynTE1Qfi) |
| 19:42:55 / 19:43:05 / 19:43:14 | step III: Base, Monad, Solana payouts signed by MPC | [Base](https://testnet.nearblocks.io/txns/2C5g8gQDjYkfvjHy9S9dtM6YnQneSNXBTHyDwS3vf2nh), [Monad](https://testnet.nearblocks.io/txns/3VrfD3FMJiRvFC6JUyh7JvkXERDxY1yJxH339z2RBCW8), [Solana](https://testnet.nearblocks.io/txns/FRz14Qnf78CCUXKaqXRRuZittY6JinV5FxDS8Eo6ULzA) |
| 19:43:18 | step IV: no estate DAO on vault 4, skipped | [step 4](https://testnet.nearblocks.io/txns/8YjhLkVxGmXy1wfHDeu9hT31fDAZp246c1eyDPivtsGi) |
| 19:43:33 | step V: Will NFT to `dmw-demo-sarah-2667.testnet`; Settled | [step 5](https://testnet.nearblocks.io/txns/4KtyRoV1yMQMkEBQFPWUVjaFaf3BiQHUken68jAFWLJ7) |

**Relay.** The three foreign payouts are signed by NEAR's MPC network in step III. A keeper relays each signed
transaction from its derived source address (Base `0xe2DA1a2b7CF1EdB54b9234E270B0F24B26905c06`, Monad
`0x708301D9e44e23ea9B11BE8558E4B4F638B4E457`, Solana `7PCGhe8EusakbHbdSREM7RAkDfRJLUvpqC8548qhUQg7`) once the address
holds the value and the fee, and records the hash on the vault with `mark_broadcast`; the vault page then links each
payout to its explorer.
