# The live contract: `dmw-885364.testnet` (Nov 12 2026)

`dmw-885364.testnet` runs contract v2 and replaces `dmw-979268.testnet`. The contract was hardened after a fourth
review pass ([`SECURITY_FIXES_V2.md`](SECURITY_FIXES_V2.md)); `dmw-979268.testnet` runs v1, has no full-access key and
could not be upgraded, and v2 changes the storage layout, so v2 went to a new account. Older records stay as history:
the `dmw-979268.testnet` runs are summarised [at the end of this file](#before-this-dmw-979268testnet-v1), and every
older record in `docs/`, `contracts/TESTNET_SMOKE.md`, `keeper/LIVE_RUN.md` and `agent/LIVE_TRANSCRIPT.md` is from
`dmw-x8cx.testnet`, the contract before that.

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

## The contract keeper (an honest caveat)

`new` named `dmw-keeper-2f6dcb.testnet` as the contract keeper. Its key existed only on the CI runner and is gone, and on
a locked contract only the current keeper can hand the role over (`set_keeper`), so the global keeper of
`dmw-885364.testnet` can never act again. Vaults are not stuck because of it:

- a vault owner can name a per-vault keeper with `set_vault_keeper` (1 yoctoNEAR), who is an operator for that vault;
- the vault owner and every heir are operators too, and heirs can run the steps;
- step III is open to anyone once its 1-hour operator window has passed (`step3_open_after_ms` 3600000 in `get_config`).

The demo video run uses `set_vault_keeper` for exactly this reason.

## The demo video

Recording on this contract is in progress; this section is filled in when the run lands.

## Before this: `dmw-979268.testnet` (v1)

`dmw-979268.testnet` was the live contract from Nov 11 to Nov 12 2026: contract v1 with the C-2 fix, code hash
`6s9oqxvBZfhWncW6irGH6zXTebeYUKTHh1pk1WSDxjYH` (not a reproducible build), deployed by run 42943063178 and locked
([delete key](https://testnet.nearblocks.io/txns/Ft71mPBybxUGtPnuzjHxPbBpHMywvdvf3ZhkbLen4Yiq)). Its C-2 drain attempt
(vault 4, run 42958682328) ended `C-2 drain: BLOCKED`, and the 2:41 demo video (`site/assets/demo-v4-720p.mp4`, vault 5,
runs 42958682328 and 42972214388, every transaction in [`docs/video/README.md`](video/README.md)) was filmed on it. The
full tables are in this file's git history (commit `fe57cc9`) and the logs on `ci/testnet-results`. Its vaults stay
readable there; it cannot be changed.
