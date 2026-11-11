# The live contract: `dmw-979268.testnet` (Nov 11 2026)

`dmw-979268.testnet` replaces `dmw-x8cx.testnet`. The old account runs code with finding C-2
([`SECURITY_REVIEW_3.md`](SECURITY_REVIEW_3.md)) and its deploy key was lost, so it could not be upgraded in place. Every
older record in `docs/`, `contracts/TESTNET_SMOKE.md`, `keeper/LIVE_RUN.md` and `agent/LIVE_TRANSCRIPT.md` is from
`dmw-x8cx.testnet` and stays as history; the features they show are the same in this build.

Everything below was done by the repository's own `testnet` workflow ([`.github/workflows/testnet.yml`](../.github/workflows/testnet.yml)),
run by the author from the Actions tab. Every account is a throwaway testnet faucet account whose key existed only on the
GitHub runner; the logs are on the `ci/testnet-results` branch (`results/<run id>/`).

## Deploy (run 42943063178)

| What | Proof |
| --- | --- |
| Code: `contracts/release/dmw.wasm`, sha256 `57236f16…8a36`, the reviewed release build with the C-2 fix | on-chain `code_hash` **`6s9oqxvBZfhWncW6irGH6zXTebeYUKTHh1pk1WSDxjYH`**, the hash the README gives for the fixed build |
| Deploy and `new({owner_id: dmw-979268.testnet})` | [deploy](https://testnet.nearblocks.io/txns/BVz6Aq7ggJv9yG4gPzaawJktkAzH8XaHHQHTnfctneWC), [init](https://testnet.nearblocks.io/txns/B6wkXXrihNPw21SuSaxQgSM7QngS6yqJ6cPrHXUdwge5) |
| Keeper `dmw-keeper-e78af9.testnet` registered | [set_keeper](https://testnet.nearblocks.io/txns/25EZL4PnbCWPmD4yR6ZLKkiaGbxzPswCd7hYbX79n6AV) |
| Showcase vault 1 (owner `dmw-andrew-edbc.testnet`, heirs `dmw-sarah-edbc.testnet` 60 % and `dmw-ben-edbc.testnet` 40 %, 60-day interval, grace 1, 5 NEAR, Base / Monad / Solana payouts) | [create_vault](https://testnet.nearblocks.io/txns/2vG3BFANPxySTqpmmERViuytftNPQ74cjge9xWgRHNqr), [set_foreign_payouts](https://testnet.nearblocks.io/txns/9nrbAsnHDHYNPr6cBvTs6mKgfEgnjrkhbuK2h7k4D4eW) |
| **Locked:** the contract account's only full-access key deleted. Nobody, the author included, can deploy new code to it or call owner-only methods; a fix means a fresh account | [delete key](https://testnet.nearblocks.io/txns/Ft71mPBybxUGtPnuzjHxPbBpHMywvdvf3ZhkbLen4Yiq); `view_access_key_list dmw-979268.testnet` returned `[]` right after (function-call keys of live vaults appear there while those vaults run) |

Check it yourself:

```bash
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"dmw-979268.testnet"}}'   # code_hash
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"dmw-979268.testnet"}}'   # no FullAccess key
```

## Smoke test, vault 2 (`contracts/smoke.sh`, same run)

| Step | Transaction | Result |
| --- | --- | --- |
| create_vault, 5 NEAR, heirs 60 / 40, agent policy | [tx](https://testnet.nearblocks.io/txns/6jYq4r5cSDRRkM4NHSrtQcTNe4wABVCu5URAE6m5hAji) | vault 2 |
| add_pulse_key, add_agent_key | [pulse](https://testnet.nearblocks.io/txns/FyLHs8L4riHq75H3oxYriqSbTKwQ3FehAJUEvPTGRLhA), [agent](https://testnet.nearblocks.io/txns/8tT8UDhGGYhjgLMyXxDzdSmvcJih2N84dXnyFFTB56Zf) | two function-call keys on the contract |
| heartbeat signed by the pulse key | [tx](https://testnet.nearblocks.io/txns/CpLsgZssFUsQsXZxaeygEkg6wSKJko2RqhuHUtipMDhn) | beat recorded |
| pulse key calls agent_pay | none | rejected by NEAR before execution (key scope) |
| agent_pay 0.3 NEAR to the allowlisted receiver | [tx](https://testnet.nearblocks.io/txns/FkM9ZcF4QXDQ4TYtz4iRxZPmHso79Py6o5awvyKE5peU) | allowed |
| agent_pay 0.9 NEAR | [tx](https://testnet.nearblocks.io/txns/12oV8xSm9T5ZyKQ32qJjbwxQDzgRQPTcPrWALjPWmNnT) | denied, `over_per_tx_max` |
| agent_pay to a receiver not on the allowlist | [tx](https://testnet.nearblocks.io/txns/FBgmCpwpcXzHpWyGJiGhA3JodNAT1YWKBkpyZLr6edMB) | denied, `receiver_not_allowlisted` |
| agent_pay 0.4 NEAR, then 0.4 NEAR again | [allowed](https://testnet.nearblocks.io/txns/7NswdBpHMjBz4StsHUwG5VHYVemR1m1p7M2K7W4CbxTF), [denied](https://testnet.nearblocks.io/txns/6sSm5rHtZkuW4j8EjYWEZUsLJihruKFxXUiZeAo8e2Px) | second one denied, `over_daily_max` |
| set_timing 20 s / grace 1, last heartbeat | [set_timing](https://testnet.nearblocks.io/txns/6ccbW1MwLtWn7MhFXcct75JysvGDnjkVYH6LnCqJz6a2), [beat](https://testnet.nearblocks.io/txns/645bB2v33Yhgz8jWrDXnev9iXeEXnxUc9VTdkn7DqH6E) | |
| poke too early | [tx](https://testnet.nearblocks.io/txns/w7aSxXDrezeY2d3vwCGhPqqr2iG5HJuGustdYRzJ2eA) | rejected, `not_due` |
| poke after the deadline (heir earns the bounty) | [tx](https://testnet.nearblocks.io/txns/D1T29YHAcRTwHCzvCePjSGM7jTynixB4TWnpeLgcg9TL) | Triggered, 0.05 NEAR bounty |
| heartbeat after the trigger | [tx](https://testnet.nearblocks.io/txns/DdzW2KkGKjsXK9HsGLjDgTBWKLYJxfHLdjaZH5tEUsqJ) | rejected, `vault_triggered` |
| steps I to V | [I](https://testnet.nearblocks.io/txns/24dh4iBh3U53CiscJxPVcVEZt33pVyHg8nnYKkjnWxGT) heirs paid 1.29 / 0.86 NEAR, [II](https://testnet.nearblocks.io/txns/76txFLDVPuW4f5y9Tsz8LCmud43g7PfyKPxpPj49yESj) 2 keys deleted, [III](https://testnet.nearblocks.io/txns/462otyHStkegYUfrDPtUX6aYfveAXHn8G8Xo6KyuGDzm), [IV](https://testnet.nearblocks.io/txns/9qxqbt542RmPMxGS79bguqaTZWCv2DKqs6hgkZRXUHDr) no DAO, skipped, [V](https://testnet.nearblocks.io/txns/EV8aNiQ1Uc9uzo2ouzToA2tenBFmu4BskEh772qWcUmy) Will NFT to the primary heir | Settled; a sixth call is [rejected](https://testnet.nearblocks.io/txns/66YLykkQ46oSaCHrHr84SPbTPXJAicqFJd64JJihxWC) `already_settled` |
| pulse and agent keys on the contract after settlement | none | both gone |
| claim by the Will NFT's new owner | [tx](https://testnet.nearblocks.io/txns/9Mdffv8wP5tCdQJQMQopTWvjZZAsUhj95dyPb9cJZnke) | 0.1 NEAR reserve paid |

## C-2 drain attempt, vault 4 (`contracts/attack-c2.sh`, run 42958682328)

The attack from [`SECURITY_REVIEW_3.md`](SECURITY_REVIEW_3.md), run live against `dmw-979268.testnet`. The attacker
`dmw-att-fee7.testnet` deploys [`contracts/tools/evil-dao`](../contracts/tools/evil-dao) to its sub-account
`dao.dmw-att-fee7.testnet`: its `add_proposal` keeps the 1 NEAR bond and returns a promise that fails. On the old code
the vault got the bond back as well and `claim` paid 1 NEAR more than the vault held, out of other vaults' NEAR.

| Step | Transaction | Result |
| --- | --- | --- |
| sub-accounts for the heir and the "DAO" | [heir](https://testnet.nearblocks.io/txns/3HKgk1jLSBX1Jtt4UtBxP6aUmmw3LxQrJSETbgS2WwDt), [dao](https://testnet.nearblocks.io/txns/7hYjeAqLvyXF7QYmKHV4cFnodHZFyQK1d1Fq2wf3q4HV) | 0.5 and 1.5 NEAR from the attacker |
| deploy the evil DAO | [tx](https://testnet.nearblocks.io/txns/Ed1U4yZoHAUb7NWu8oPckp715G8ykRQgXL7kE9pZ1mcx) | |
| create_vault, 10 s interval, grace 0, 1.7 NEAR, heir 100 % | [tx](https://testnet.nearblocks.io/txns/Ezx9LfNgXvrL4fDEDUpM74rQtyGff3YqoyBDwghcavWG) | vault 4, balance 1.6 NEAR |
| set_dao to the evil DAO | [tx](https://testnet.nearblocks.io/txns/4PCp11mP1jxaEayqq55nutHtsXuySSbPZMNcbwxyvUNY) | |
| poke | [tx](https://testnet.nearblocks.io/txns/G75S6j5LjnenBaLzmnvzyqYvELWgFtCMH2fSX18ux1ks) | Triggered, 0.01 NEAR bounty |
| steps I to III | [I](https://testnet.nearblocks.io/txns/Dp9HZuZBwLMCCmk4pppFb6w77rZHfndQvtitHW2HWJjD), [II](https://testnet.nearblocks.io/txns/3hAHytCtMRRosELy5gCa8mLb2xKqBxGvbuPqaiasMqkE), [III](https://testnet.nearblocks.io/txns/HqfWBsYBj3qXYxZvQDAAfucEVAkZqLddTJn9EtUfamVS) | vault balance 1.5 NEAR (the reserve with a DAO) |
| **step IV: the "DAO" keeps the bond** | [tx](https://testnet.nearblocks.io/txns/N6vuV6nXZE2bGWHXJNhiK9oD5UxZemVAQzBgXenxfsw) | `dao_proposal_failed` logged; **vault balance 0.5 NEAR**, the bond is not credited back |
| step V | [tx](https://testnet.nearblocks.io/txns/5zNq7UbK6Ea1V1hDnUDk35nPQT3wpmMf1peEaLhzY31P) | Settled, 0.5 NEAR |
| claim by the heir | [tx](https://testnet.nearblocks.io/txns/H7nYwBkVczBesDvBiWM2hsswgqZvQa56ibVxKstdVp6F) | **0.5 NEAR**, exactly what the vault held |

Result: attacker, heir and "DAO" together **-0.104 NEAR** (storage fee and gas); the contract account went from 18.8836
to 18.9836 NEAR (+0.1, the storage fee), so no other vault paid for anything. The same numbers as the fixed column of
the private-copy test in `SECURITY_REVIEW_3.md` (claim 0.5 NEAR, attacker -0.104 NEAR). The script ends with
`C-2 drain: BLOCKED`, and fails the workflow otherwise.

An earlier attempt (vault 3, run 42945032121) stopped at step I because the heir account was given too little NEAR for
gas; nothing ran past the trigger and nothing was paid out. Anyone can still push that vault through its steps.


<!-- VIDEO -->
