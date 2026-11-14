# The live contract: `dmw-26a506.testnet` (Nov 14 2026)

`dmw-26a506.testnet` runs contract v3, the final hackathon build, and replaces `dmw-885364.testnet` (v2). v3 adds the
durable keeper: the contract keeper is a long-lived account derived from a repository secret, and a separate keeper admin
can rotate it, so the hosted keeper keeps working after the contract is locked. The contract was built reproducibly,
deployed, and locked in one workflow run on Nov 14 2026. Earlier contracts have no full-access key and could not be
upgraded, so each version went to a new account; their records are in [`docs/history/`](history/README.md).

Everything below was done by the repository's own `testnet` workflow ([`.github/workflows/testnet.yml`](../.github/workflows/testnet.yml)),
run by the author from the Actions tab. Every account is a throwaway testnet faucet account whose key existed only on the
GitHub runner; the logs are on the `ci/testnet-results` branch (`results/<run id>/`).

## Deploy (run 43624448768)

| What | Proof |
| --- | --- |
| Code: `contracts/release/dmw.wasm`, 512,938 bytes, sha256 `0eedbe4a…7972`, the reproducible build of source commit [`d8165c6`](https://github.com/bigbenny1231/Will-wallet/tree/d8165c6db676cdd66e248a113380a60bf8099fe8) (see [Reproducible build](#reproducible-build)) | on-chain `code_hash` **`21GyDHicz5Zn1nLnYsHnDLMEpdskNigr9jDtqufw6koK`**, the same hash the build printed |
| Deploy and `new({"owner_id":"dmw-26a506.testnet","keeper_id":"dmw-keeper-89d05f3b.testnet","keeper_admin":"dmw-admin-56911b44.testnet"})` in **one** transaction (`new` is private) | [deploy + init](https://testnet.nearblocks.io/txns/FixQpVPtTo3kDga7jMr3UR55nCjSsVxkWARszyZbFr8S) |
| Showcase vault 1 (owner `dmw-showcase-156ed802.testnet`, heirs `dmw-sarah-5498.testnet` 60 % and `dmw-ben-5498.testnet` 40 %, 60-day interval, grace 1, 5 NEAR, Base / Monad / Solana payouts) | [create_vault](https://testnet.nearblocks.io/txns/4osjuzNdDoabZich7tjRSfqd2LAD2hDfx8evF4xWknYK), [set_foreign_payouts](https://testnet.nearblocks.io/txns/B44WA46W2rgLeC43QLPKnxwvBPAXuE31RDfzsykhrgmb) |
| **Locked:** the contract account's only full-access key deleted. Nobody, the author included, can deploy new code to it; a fix means a fresh account | [delete key](https://testnet.nearblocks.io/txns/3B2naewYT8UbCJSXbHAAw1DqHWf7ZYz9nG8WTaXBVy2n); the workflow then printed `full-access keys left on dmw-26a506.testnet: 0`, and `view_access_key_list` returned `[]` at block 277691632 (function-call keys of running vaults appear there while those vaults run) |

Check it yourself:

```bash
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"dmw-26a506.testnet"}}'   # code_hash
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"dmw-26a506.testnet"}}'   # no FullAccess key
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"dmw-26a506.testnet","method_name":"contract_source_metadata","args_base64":"e30="}}' \
  | python3 -c 'import sys,json;print(bytes(json.load(sys.stdin)["result"]["result"]).decode())'                                              # NEP-330 link + build_info
```

## Reproducible build

| | |
| --- | --- |
| Code hash | **`21GyDHicz5Zn1nLnYsHnDLMEpdskNigr9jDtqufw6koK`** (sha256 hex `0eedbe4a849f01590d0c2c097c6c9871f1c6396a00cb4fdd7e6d71197aee7972`), 512,938 bytes |
| Source | commit [`d8165c6db676cdd66e248a113380a60bf8099fe8`](https://github.com/bigbenny1231/Will-wallet/tree/d8165c6db676cdd66e248a113380a60bf8099fe8), `contracts/dmw` |
| Toolchain | `cargo near build reproducible-wasm` (cargo-near 0.23.0) in `sourcescan/cargo-near:0.23.0-rust-1.99.1`, pinned by digest `sha256:8013f039e8005627f10ae66b5519d1a6eeeed7d7aef4b5067d5e9a86c4302fcc` in `contracts/dmw/Cargo.toml` |
| On chain | `view_account dmw-26a506.testnet` returns that `code_hash`. `contract_source_metadata` carries the NEP-330 `build_info`: the image with its digest, the build command, `contracts/dmw`, and `source_code_snapshot` `git+https://github.com/bigbenny1231/will-wallet?rev=d8165c6db676cdd66e248a113380a60bf8099fe8`; its `link` points to the same commit |
| In the repo | `contracts/release/dmw.wasm` on master is this build, committed by the CI bot in `5d9c760` (log: `release-build.log` of run 43624448768) |

Verify it (needs Docker and cargo-near 0.23.0). The commit id is part of the embedded NEP-330 metadata, so build that
commit, not a later one:

```bash
git clone https://github.com/bigbenny1231/Will-wallet && cd Will-wallet
git checkout d8165c6db676cdd66e248a113380a60bf8099fe8
cd contracts/dmw && cargo near build reproducible-wasm    # or `make build-reproducible` from the root
# prints "SHA-256 checksum bs58: 21GyDHicz5Zn1nLnYsHnDLMEpdskNigr9jDtqufw6koK", the code_hash from view_account above
```

## Smoke test, vault 2 (`contracts/smoke.sh`, same run)

| Step | Transaction | Result |
| --- | --- | --- |
| create_vault, 5 NEAR, heirs 60 / 40, agent policy | [tx](https://testnet.nearblocks.io/txns/98VSHzbVuBFtSWqb8T3xwSdKvjdgjD3TrBrx513BKSdA) | vault 2 |
| add_pulse_key, add_agent_key | [pulse](https://testnet.nearblocks.io/txns/CWraeU9vvRbgN5DqGiFNCnQcyhkRMZUzpDuAjcck6cGQ), [agent](https://testnet.nearblocks.io/txns/8E67tCoqydBAS228Y7o6Dda1vHGQLZUWxPfGfpg1oPJK) | two function-call keys on the contract, `["heartbeat"]` and `["agent_pay"]` |
| heartbeat signed by the pulse key | [tx](https://testnet.nearblocks.io/txns/2HiGvgWiuYcETm1L9A5hLTDS2XNC8jJm1QBDvAEZ6myV) | beat recorded |
| owner heartbeat without a deposit, then with 1 yoctoNEAR (finding F) | [rejected](https://testnet.nearblocks.io/txns/B86Cnr7zi2mWgbsZ3oMFHPaTD4XCshFwCJWATzxpas8f), [accepted](https://testnet.nearblocks.io/txns/Dpf9PWjLFcARE6bhHnHhz1tDdHkgq4FaupzpBPQNYjGp) | the first panics `Requires attached deposit of exactly 1 yoctoNEAR`; the second records the beat |
| pulse key calls agent_pay | none | rejected by NEAR before execution (key scope) |
| agent_pay 0.3 NEAR to the allowlisted receiver | [tx](https://testnet.nearblocks.io/txns/GrXJpBGZCD8er6SRwHA7inphs835fyqxTKeZmjiYTfXq) | allowed |
| agent_pay 0.9 NEAR | [tx](https://testnet.nearblocks.io/txns/FrsJ2M1rmEXk3qRYD6TaVtzth9wGCBG2dW5SJALnMFpr) | denied, `over_per_tx_max` |
| agent_pay to a receiver not on the allowlist | [tx](https://testnet.nearblocks.io/txns/6MDvpmpfX3TNuMFqj2qwkk8pPS7EPHN5y3qP1yFUsjQm) | denied, `receiver_not_allowlisted` |
| agent_pay 0.4 NEAR, then 0.4 NEAR again | [allowed](https://testnet.nearblocks.io/txns/5jPVinQueNZ9BfK7jfMBWZ9orMteF8HqRSiGqTppcN5Z), [denied](https://testnet.nearblocks.io/txns/67GaJKJ5SuR7138zf3beDMbHdPDHbht86LKVHWsgUBVv) | second one denied, `over_daily_max` |
| set_timing 20 s / grace 1, last heartbeat | [set_timing](https://testnet.nearblocks.io/txns/HkWHVb2dHGfi6BFy8jB6SG5UFyqLFCuz7WBWZZh23WLq), [beat](https://testnet.nearblocks.io/txns/DSk5uwt3JTgrkibwdzDvuse6viSLob1ucYdSXxCcmB1w) | |
| poke too early | [tx](https://testnet.nearblocks.io/txns/GMFuXt4JgBoHLUuCMsYgDcz6NqbaJrLtgZAfs5oYseZV) | rejected, `not_due` |
| poke after the deadline (heir earns the bounty) | [tx](https://testnet.nearblocks.io/txns/EvvGvxTEUa3ngGXBzVAydQqeMa1DrdRBV5vgXw8U2Zv9) | Triggered, 0.05 NEAR bounty |
| heartbeat after the trigger | [tx](https://testnet.nearblocks.io/txns/HcUrFWB3T1vcEu2FcEaD7YmjhrLbDEwHrNQCP3Q4YdV6) | rejected, `vault_triggered` |
| steps I to V | [I](https://testnet.nearblocks.io/txns/8z6wZiipb3wqQcpB26VXAD7Cdjvi1P4SuhRCKaXMfPj5) heirs paid 1.29 / 0.86 NEAR, [II](https://testnet.nearblocks.io/txns/Hr6nniVYBA6k1HCuttGUBRgEeNYi51xA6DQywkAjetVw) 2 keys deleted, [III](https://testnet.nearblocks.io/txns/4teDGhT8BCy53HyyrHh45LpDexuTxeptcnyyXqMw5SCM), [IV](https://testnet.nearblocks.io/txns/JBu3b9rnb1rZpN7gYCEMjwQEvG1qAPMFgifxYR88mzzc) no DAO, skipped, [V](https://testnet.nearblocks.io/txns/6NeBFJeUqGJAc319YJETBh3anNQyncN5HDpAddAcShhX) Will NFT to the primary heir, released storage split 60 / 40 | Settled; a sixth call is [rejected](https://testnet.nearblocks.io/txns/94KG3pRdHwwLNGnwjhwz7XoG96QmFc6zxFCxuktvCg9a) `already_settled` |
| pulse and agent keys on the contract after settlement | none | both gone |
| claim by the Will NFT's new owner | [tx](https://testnet.nearblocks.io/txns/3NmRR51orzJLpASujsE5qWB6scZF6L3ZSvwQkWkSVwFE) | 0.1 NEAR reserve paid |

## C-2 drain attempt, vault 3 (`contracts/attack-c2.sh`, run 43629928841)

The attack from [`SECURITY_REVIEW_3.md`](SECURITY_REVIEW_3.md), run live against `dmw-26a506.testnet`. The attacker
`dmw-att-249c.testnet` deploys [`contracts/tools/evil-dao`](../contracts/tools/evil-dao) to its sub-account
`dao.dmw-att-249c.testnet`: its `add_proposal` keeps the 1 NEAR bond and returns a promise that fails. On the code
before the C-2 fix the vault got the bond back as well and `claim` paid 1 NEAR more than the vault held, out of other
vaults' NEAR. At the start: attacker 7.9858, heir 0.5000, "DAO" 1.5000, contract account 17.1339 NEAR.

| Step | Transaction | Result |
| --- | --- | --- |
| deploy the evil DAO | [tx](https://testnet.nearblocks.io/txns/FHS3ZEYajfPbw6VRz6LYbitKJeZzwyt2G9Y7Rz4YRweq) | |
| create_vault, 10 s interval, grace 0, 1.7 NEAR, heir 100 % | [tx](https://testnet.nearblocks.io/txns/E7EJk555UFPnXJSo9PLJbr9vy4Dv9gmFZxbywM6naFk6) | vault 3, balance 1.6 NEAR |
| set_dao to the evil DAO | [tx](https://testnet.nearblocks.io/txns/2oahmBA7UC61gsSxcD1o5ttEJX1VeVTZRLekC8bEywZq) | |
| poke | [tx](https://testnet.nearblocks.io/txns/8NDJrafzm7YSPkRHscNGjyiJ9kb6VNc67uMH6BtAReyh) | Triggered, 0.01 NEAR bounty |
| steps I to III | [I](https://testnet.nearblocks.io/txns/HCqNPsef87jwP8Wd2BGvmfXxxpVTxByhh6wDcpCbshm4), [II](https://testnet.nearblocks.io/txns/A19SEK2E1u6Uj62rGVfzCh3TDpxQeh7i1fwqqQoQkiUu), [III](https://testnet.nearblocks.io/txns/FVEL7e5cFmAzrJ78dh3iL3n11wpPeTYxFzEGMoJhj4AV) | vault balance 1.5 NEAR (the reserve with a DAO) |
| **step IV: the "DAO" keeps the bond** | [tx](https://testnet.nearblocks.io/txns/3ZnKyXsAiMkUpMbz3JYkssrKRu6hyPht8FAS1fHwXDn5) | `staged failure: the bond was kept`, `dao_proposal_failed` logged; **vault balance 0.5 NEAR**, the bond is not credited back |
| step V | [tx](https://testnet.nearblocks.io/txns/8hV2o63XHozWKKLrJsyPt5XsVYrbQGvHrRvn3N4ZieBx) | Settled, 0.5 NEAR; the released storage (0.0696 NEAR) goes to the heir |
| claim by the heir | [tx](https://testnet.nearblocks.io/txns/CdLShwc2wMX8rVmBUPwAsGKAs2uzFCMbKZ5uifdTQJ2r) | **0.5 NEAR**, exactly what the vault held |

Result: attacker, heir and "DAO" together **-0.0355 NEAR**; the contract account went from 17.1339 to 17.1643 NEAR, so
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

## The demo video, vault 4 (run 43629928841)

The 2:48 demo on the site (`site/assets/demo-v4-720p.mp4`, and the 2:16 X cut `site/assets/demo-v4-x-720p.mp4`) is one real
run of vault 4 on this contract, Nov 14 2026, from the phone's first beat at 19:06:25 UTC to Settled at 19:18:56. Owner
`dmw-demo-owner-13231b.testnet`; heirs `dmw-demo-sarah-67d7.testnet` 60 % (primary) and `dmw-demo-ben-67d7.testnet`
40 %; agent allowlist `dmw-demo-api-67d7.testnet`; guardian `dmw-demo-guardian-67d7.testnet` (max pause 600 s); 60 s
interval, grace 1. How it was filmed and cut: [`docs/video/README.md`](video/README.md) (v4).

**Keeper.** The contract's standing keeper `dmw-keeper-89d05f3b.testnet` (derived from `KEEPER_SEED`) watched vault 4,
poked it, ran the five steps and relayed the three foreign payouts.

| Time (UTC) | What happens | Proof |
| --- | --- | --- |
| setup | `make demo`: create_vault (4 NEAR), CLI pulse key and agent key, Base + Solana payouts, the agent-demo allowed/denied pair; then `tools/v4/setup.sh`: a 1.5 NEAR deposit, the phone's pulse key, Base + Monad + Solana payouts and the guardian | [create_vault](https://testnet.nearblocks.io/txns/GqdXSnubGYbxVzXdyjbXsVX7pbupLFjamuMBqCq6BEEr), [pulse key](https://testnet.nearblocks.io/txns/E5LfkKt3FcHa5TXLR3DEMGo9XmoUz8pL7y35abzNSmG6), [agent key](https://testnet.nearblocks.io/txns/688tg8RQoPNBRjz5tyhwV9zUAWXQnQGFZ2u7TE3AYQqc), [Base + Solana payouts](https://testnet.nearblocks.io/txns/8WuZ6BQSJjKWXTC6bSxtF2kymVKJnfakWZQqHnKBJoFe), [allowed](https://testnet.nearblocks.io/txns/BW99W8RtYcoWvX822gBfMw7RAjerrpnozPdzUhPorUGM), [denied](https://testnet.nearblocks.io/txns/8fWtfjC6q7xPhcqePSzvEvnN81MWWwtpH4jpqUeAHiRh), [deposit](https://testnet.nearblocks.io/txns/CVgBqt9XdY6x5asSFfsDuzz6rvwfGJEPaZVKUPh6fF6G), [phone key](https://testnet.nearblocks.io/txns/FS1Ryqe8AHH5aFoSshTtmUvmPV4CnmFjqcgrbvCW8SYo), [three payouts](https://testnet.nearblocks.io/txns/9oVUyUVgSZY9tkTHDeddc8MjjHiVq8XJHtD7phrXFr34), [guardian](https://testnet.nearblocks.io/txns/HLTkG8WFNGJEyPnxAAL2QjtDBJPU3o3MYz4byZdTApVW) |
| 19:06:25 to 19:08:35 | the phone beats about every 20 s (heartbeats signed in the browser with the phone key) | phone page, dashboard |
| 19:07:20 | `make agent` (scripted brain): INV-2041, 0.12 NEAR, allowed | [tx](https://testnet.nearblocks.io/txns/7hk3xW55WPHuFNKVVDuSRqLMvxLsHwahM87iUqdGpYtX) |
| 19:07:24 | INV-2042, 0.08 NEAR, allowed | [tx](https://testnet.nearblocks.io/txns/BMPMnGP2HChx1bPMC3qwZFSTfmuKGHo3mzBUmMCNcM6A) |
| 19:07:24 | the brain obeys the planted injection (2.45 NEAR to `stranger.testnet`); the wallet wrapper refuses, nothing signed | agent ledger (no tx exists) |
| 19:07:30 | run 2, wrapper checks off: the contract denies 2.25 NEAR, `receiver_not_allowlisted`, logged | [tx](https://testnet.nearblocks.io/txns/4HAMVHkzUb2QvgEP2zSZyH8vqBD9KvhtmtyJrrBUpSta) |
| 19:07:57 | the guardian pauses: the deadline moves from 19:09:51 to 19:17:56 (`paused` event, `paused_until_ms` 1794683876585) | [pause](https://testnet.nearblocks.io/txns/FpCMPsJUGuuhccHhg2UmKvfd2LbhFiMDDr2QBCEGUD46) |
| 19:08:38 | hold to stop on the phone; last beat 19:08:35 | phone page |
| 19:09:38 | the keeper sees Warning | keeper ledger |
| 19:18:00 | the contract's keeper pokes: Triggered, 0.05 NEAR bounty | [poke](https://testnet.nearblocks.io/txns/HLycj9dmZqUxYAp2kJsuSr1oHR7gwZShaNYvJ947PtwB) |
| 19:18:03 | step I: heirs paid on NEAR, 60 / 40 | [step 1](https://testnet.nearblocks.io/txns/5zsdXzzkGMo1Uk4uGGrn9cMRy5JDJiXxACWNtw5e6SBN) |
| 19:18:07 | step II: pulse and agent keys deleted | [step 2](https://testnet.nearblocks.io/txns/2r8LFJZ6Lcjui5mGC25tpQHaoSUipkQrtdeEHXD1zGYn) |
| 19:18:22 / 19:18:33 / 19:18:46 | step III: Base, Monad, Solana payouts signed by MPC, relayed by the keeper and confirmed on each chain | signed: [Base](https://testnet.nearblocks.io/txns/Bzj6tt6WMXLqixgeG8XRUyNbgoLuNrKE56p5qFaZCKia), [Monad](https://testnet.nearblocks.io/txns/eZgHL8eizvMSy71NEuc4jnqjVEYU9FXare3FspMyu9f), [Solana](https://testnet.nearblocks.io/txns/2fTnjFas56ncoAvGhLYW99jqtmF6NCuTB5YNwnVu2ZPJ); landed: [Base](https://sepolia.basescan.org/tx/0x9eef8be2d052c2bcb8b0d369cc878bc3fae65b05bec500722f6365157e352ea0), [Monad](https://testnet.monadexplorer.com/tx/0x49485735526a6ea2e18991f1478ca86ad80c42c984024654b4cf4e44df2c9f94), [Solana](https://explorer.solana.com/tx/Qbkw2phdwUtmGBmyvEa2srcUGgfZHAB6gzw9wfwSieJbkjCmBXhKdBfQDRBT6pvYnuo87kKEXCwwiRtN99Mk1jH?cluster=devnet) |
| 19:18:52 | step IV: no estate DAO on vault 4, skipped | [step 4](https://testnet.nearblocks.io/txns/DiYmMdA9bREw3fkcq5fYrtmbmZiSwZaKRkKcW1yZpCKR) |
| 19:18:56 | step V: Will NFT to `dmw-demo-sarah-67d7.testnet`; Settled | [step 5](https://testnet.nearblocks.io/txns/uGLuiJ7rNBzaDBqvfenHRXYWsZkHSfoQkAmzebPRMDP) |

**Relay.** The three foreign payouts are signed by NEAR's MPC network in step III. A keeper relays each signed
transaction from its derived source address (Base `0x3a04fA8a96CB6EC643aD8e6771F0AEaf49F858Fa`, Monad
`0xBc20bDe46A526d7651B673823d9b7f6E073d76d4`, Solana `2WnHAi6eF8QTDAgkGFszsU7e68fzuRjgJyVpyGMeczya`) once the address
holds the value and the fee, and records the hash on the vault with `mark_broadcast`; the vault page then links each
payout to its explorer.
In this run the keeper's funder topped up each source from the project's test wallet just before relaying, and the
keeper checked all three on their chains after Settled: `mark_broadcast` [#0](https://testnet.nearblocks.io/txns/Gf8q2L2Rqfr6w5ULgabaZMMmynMn3BFJ2sLNCbqBVBJu),
[#1](https://testnet.nearblocks.io/txns/9heGgb1PRfDtbTzy5yiyjG2h11f7h43XEaPDkSdfT4ut), [#2](https://testnet.nearblocks.io/txns/EjDhDouUvTZb7LzmPvci8PBkwv6v2Y8KRYBL4Su72K8x)
(log: `keeper.log` of run 43629928841).
