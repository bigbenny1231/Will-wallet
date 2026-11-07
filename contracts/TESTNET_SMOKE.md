# dmw testnet smoke test

Real run against NEAR testnet on 2026-11-07 (contract redeployed from this tree right before the run).

| | |
| --- | --- |
| Contract | [`dmw-x8cx.testnet`](https://testnet.nearblocks.io/address/dmw-x8cx.testnet) |
| Vault owner | [`dmw-owner-cdeb.testnet`](https://testnet.nearblocks.io/address/dmw-owner-cdeb.testnet) (faucet account) |
| Heirs | `dmw-heir-cdeb.testnet` 6000 bps (primary), `heir-kvo.testnet` 4000 bps |
| Vault | token `4`, 6 NEAR + 0.1 NEAR storage, policy per_tx 0.5 / daily 0.8 NEAR, allowlist `[heir-kvo.testnet]`, bounty 0.05 NEAR |

Reproduce: `contracts/smoke.sh dmw-x8cx.testnet <owner> <heir1> <heir2>` (accounts from
`node scripts/near-admin.mjs create <name>.testnet`; tx helper: `contracts/tools/tx.mjs`).

Why 120 s first: testnet txs take 5-10 s each, so key setup plus five agent calls overrun a 20 s
interval. The vault is created at 120 s, then `set_timing(20, 1)` runs and a final pulse-key
heartbeat lands before the owner goes silent. With 20 s and grace 1 the vault triggers 40 s after
that last beat.

## What it shows

1. `create_vault` mints Will NFT #4 (NEP-171 `nft_mint` event). Balance = 6 NEAR.
2. `add_pulse_key` / `add_agent_key` add **function-call keys to the contract account**
   (scoped to `heartbeat` / `agent_pay`, allowance 1 NEAR each, reserved from the vault balance: 6 -> 4 NEAR).
3. `heartbeat` signed by the pulse key, with signer = the contract account (`by: "pulse_key"`).
4. Access-key scope: the pulse key cannot call `agent_pay`. The RPC rejects it before execution.
5. `agent_pay`: allowed 0.3, denied `over_per_tx_max` (0.9), denied `receiver_not_allowlisted`,
   allowed 0.4, denied `over_daily_max` (0.7 + 0.4 > 0.8). Denials **succeed** as txs and return
   `{allowed:false, reason}`, so the log entry persists.
6. `poke` before the deadline panics `not_due`. After it, the heir pokes, gets the 0.05 NEAR bounty, and state goes to `Triggered`.
7. Heartbeat after trigger panics `vault_triggered`.
8. `execute_step` x5 returns 2, 3, 4, 5, 6. Step 1 pays 1.29 / 0.86 NEAR (60/40 of 2.25 - 0.1 reserve),
   step 2 deletes both keys from the contract account (verified with the key list), step 3 has no foreign
   payouts and goes to 4, step 4 has no DAO and is skipped, step 5 moves the NFT to the primary heir and sets `Settled`. A 6th call panics `already_settled`.
9. `claim` by the new NFT owner withdraws the 0.1 NEAR reserve.
10. Final `get_vault` / `nft_token` show the vault `Settled`, owned by `dmw-heir-cdeb.testnet`, with a grey SVG.

Private keys of the generated pulse/agent keys were never written to disk or to this log.

## Full output

```text
## create vault (interval 120 s while we set it up, grace 1, 6 NEAR + 0.1 storage)
## (testnet txs take ~5-10 s each, so the alive phase runs at 120 s and set_timing drops it to 20 s before the owner goes silent)
$ node contracts/tools/tx.mjs call dmw-owner-cdeb.testnet dmw-x8cx.testnet create_vault {...} 100 6.1
tx https://testnet.nearblocks.io/txns/J7PMUfXwQfmgRQ6X6K37z5jhhVpF6HoaWMESB9fwno5P
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"vault_created","data":{"token_id":"4","owner_id":"dmw-owner-cdeb.testnet","balance":"5000000000000000000000000","heartbeat_interval_s":120,"grace_missed":1}}
  log: EVENT_JSON:{"standard":"nep171","version":"1.0.0","event":"nft_mint","data":[{"owner_id":"dmw-owner-cdeb.testnet","token_ids":["4"]}]}
  result: "4"
TOKEN=4
pulse key ed25519:GvJMaRQJAYFvdPH91PqiHThKJcVehVf1vFtLG3bHHWXm, agent key ed25519:GFNSAWdKnaTMcie5WrUhkeY2aKPmxm6tbaHJi4gniwB1 (private keys not recorded)

## add pulse + agent keys (function-call keys on dmw-x8cx.testnet)

$ node contracts/tools/tx.mjs call dmw-owner-cdeb.testnet dmw-x8cx.testnet add_pulse_key {"token_id":"4","public_key":"ed25519:GvJMaRQJAYFvdPH91PqiHThKJcVehVf1vFtLG3bHHWXm"} 50
tx https://testnet.nearblocks.io/txns/Bft63urbikMfSorsRmKGLKPHJXsyvQdF4RYCDdicB3eR
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"key_add_requested","data":{"token_id":"4","public_key":"ed25519:GvJMaRQJAYFvdPH91PqiHThKJcVehVf1vFtLG3bHHWXm","kind":"Pulse"}}
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"key_added","data":{"token_id":"4","public_key":"ed25519:GvJMaRQJAYFvdPH91PqiHThKJcVehVf1vFtLG3bHHWXm","kind":"Pulse","method":"heartbeat"}}
  result: true

$ node contracts/tools/tx.mjs call dmw-owner-cdeb.testnet dmw-x8cx.testnet add_agent_key {"token_id":"4","public_key":"ed25519:GFNSAWdKnaTMcie5WrUhkeY2aKPmxm6tbaHJi4gniwB1"} 50
tx https://testnet.nearblocks.io/txns/289ud2A5pXABWSPcMCigf4z8CPihJCDTrPw5uumh3qQR
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"key_add_requested","data":{"token_id":"4","public_key":"ed25519:GFNSAWdKnaTMcie5WrUhkeY2aKPmxm6tbaHJi4gniwB1","kind":"Agent"}}
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"key_added","data":{"token_id":"4","public_key":"ed25519:GFNSAWdKnaTMcie5WrUhkeY2aKPmxm6tbaHJi4gniwB1","kind":"Agent","method":"agent_pay"}}
  result: true

$ node scripts/near-admin.mjs keys dmw-x8cx.testnet   # filtered to the two new keys
{"access_key": {"nonce": 276614943000000, "permission": {"FunctionCall": {"allowance": "1000000000000000000000000", "method_names": ["agent_pay"], "receiver_id": "dmw-x8cx.testnet"}}}, "public_key": "ed25519:GFNSAWdKnaTMcie5WrUhkeY2aKPmxm6tbaHJi4gniwB1"}
{"access_key": {"nonce": 276614921000000, "permission": {"FunctionCall": {"allowance": "1000000000000000000000000", "method_names": ["heartbeat"], "receiver_id": "dmw-x8cx.testnet"}}}, "public_key": "ed25519:GvJMaRQJAYFvdPH91PqiHThKJcVehVf1vFtLG3bHHWXm"}

## heartbeat signed by the pulse key (signer = contract account)
$ node contracts/tools/tx.mjs call-with-key dmw-x8cx.testnet <pulse-private-key> dmw-x8cx.testnet heartbeat '{"token_id":"4"}' 10
tx https://testnet.nearblocks.io/txns/J79hrJxogez1gySre1W5wWmjWJJbb7uTgqJMbVvTrtkn
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"heartbeat","data":{"token_id":"4","by":"pulse_key","was":"Alive","next_due_ms":1794045258484}}
  result: 1794045138484

## pulse key cannot call agent_pay (access-key scope, rejected before execution)
$ node contracts/tools/tx.mjs call-with-key dmw-x8cx.testnet <pulse-private-key> dmw-x8cx.testnet agent_pay '{...}' 30
  error: Transaction method name agent_pay isn't allowed by the access key
(rejected as expected)

## agent_pay: allowed, then denied x3
$ node contracts/tools/tx.mjs call-with-key dmw-x8cx.testnet <agent-private-key> dmw-x8cx.testnet agent_pay '{"token_id":"4","receiver_id":"heir-kvo.testnet","amount":"300000000000000000000000","memo":"api credits"}' 30
tx https://testnet.nearblocks.io/txns/D4o7gCrPPtPvKW598akGXK4vVAjrxWcFu8PbqhqoPo8Q
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"agent_pay_allowed","data":{"token_id":"4","receiver_id":"heir-kvo.testnet","amount":"300000000000000000000000","daily_spent":"300000000000000000000000","memo":"api credits"}}
  result: {"allowed":true,"reason":null,"receiver_id":"heir-kvo.testnet","amount":"300000000000000000000000","daily_spent":"300000000000000000000000","balance":"2700000000000000000000000"}
$ node contracts/tools/tx.mjs call-with-key dmw-x8cx.testnet <agent-private-key> dmw-x8cx.testnet agent_pay '{"token_id":"4","receiver_id":"heir-kvo.testnet","amount":"900000000000000000000000"}' 30
tx https://testnet.nearblocks.io/txns/3yVVDGHthbqGvbVN9nvK6s7fH81bmwFZJVfMFKkHNPXn
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"agent_pay_denied","data":{"token_id":"4","receiver_id":"heir-kvo.testnet","amount":"900000000000000000000000","reason":"over_per_tx_max","memo":""}}
  result: {"allowed":false,"reason":"over_per_tx_max","receiver_id":"heir-kvo.testnet","amount":"900000000000000000000000","daily_spent":"300000000000000000000000","balance":"2700000000000000000000000"}
$ node contracts/tools/tx.mjs call-with-key dmw-x8cx.testnet <agent-private-key> dmw-x8cx.testnet agent_pay '{"token_id":"4","receiver_id":"dmw-owner-cdeb.testnet","amount":"100000000000000000000000"}' 30
tx https://testnet.nearblocks.io/txns/2ExyziBSP9fgv738gFMaEb76xmnjA2i11RaUTFWYJEYz
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"agent_pay_denied","data":{"token_id":"4","receiver_id":"dmw-owner-cdeb.testnet","amount":"100000000000000000000000","reason":"receiver_not_allowlisted","memo":""}}
  result: {"allowed":false,"reason":"receiver_not_allowlisted","receiver_id":"dmw-owner-cdeb.testnet","amount":"100000000000000000000000","daily_spent":"300000000000000000000000","balance":"2700000000000000000000000"}
$ node contracts/tools/tx.mjs call-with-key dmw-x8cx.testnet <agent-private-key> dmw-x8cx.testnet agent_pay '{"token_id":"4","receiver_id":"heir-kvo.testnet","amount":"400000000000000000000000"}' 30
tx https://testnet.nearblocks.io/txns/CqUnKHppvJfayesKod8Q7Bw1MV6Xe3aBeU1XYTghWUYX
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"agent_pay_allowed","data":{"token_id":"4","receiver_id":"heir-kvo.testnet","amount":"400000000000000000000000","daily_spent":"700000000000000000000000","memo":""}}
  result: {"allowed":true,"reason":null,"receiver_id":"heir-kvo.testnet","amount":"400000000000000000000000","daily_spent":"700000000000000000000000","balance":"2300000000000000000000000"}
$ node contracts/tools/tx.mjs call-with-key dmw-x8cx.testnet <agent-private-key> dmw-x8cx.testnet agent_pay '{"token_id":"4","receiver_id":"heir-kvo.testnet","amount":"400000000000000000000000"}' 30
tx https://testnet.nearblocks.io/txns/BmxkKS8sStfbTzbdxhSWZTFa757fLskRysRh5N2fGUEV
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"agent_pay_denied","data":{"token_id":"4","receiver_id":"heir-kvo.testnet","amount":"400000000000000000000000","reason":"over_daily_max","memo":""}}
  result: {"allowed":false,"reason":"over_daily_max","receiver_id":"heir-kvo.testnet","amount":"400000000000000000000000","daily_spent":"700000000000000000000000","balance":"2300000000000000000000000"}

## set_timing to 20 s / grace 1, then one last pulse-key heartbeat

$ node contracts/tools/tx.mjs call dmw-owner-cdeb.testnet dmw-x8cx.testnet set_timing {"token_id":"4","heartbeat_interval_s":20,"grace_missed":1} 30
tx https://testnet.nearblocks.io/txns/8xDsKo5Eo3dnyqjWCHYsWT9KZufeKfButdbgraHZoxiV
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"timing_set","data":{"token_id":"4","heartbeat_interval_s":20,"grace_missed":1}}
  result: (empty)
$ node contracts/tools/tx.mjs call-with-key dmw-x8cx.testnet <pulse-private-key> dmw-x8cx.testnet heartbeat '{"token_id":"4"}' 10
tx https://testnet.nearblocks.io/txns/FXgJr7H1zaBMtxCidkGuyixasZBRzbATjTcYsgi8mna1
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"heartbeat","data":{"token_id":"4","by":"pulse_key","was":"Warning","next_due_ms":1794045248959}}
  result: 1794045228959

## poke too early

$ node contracts/tools/tx.mjs call dmw-heir-cdeb.testnet dmw-x8cx.testnet poke {"token_id":"4"} 30
tx https://testnet.nearblocks.io/txns/BYnVcVYKG848AK3RhB5sZci3T6GZ1mA69mYXqCseRhmX
  error: {"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: not_due"}}}}
(not_due as expected)

## owner goes silent; wait until trigger_at_ms
state=Alive
state=Warning
state=Warning
state=Warning

## poke (heir earns the bounty)

$ node contracts/tools/tx.mjs call dmw-heir-cdeb.testnet dmw-x8cx.testnet poke {"token_id":"4"} 30
tx https://testnet.nearblocks.io/txns/9wE4XYjF9fu8YgFeyeQFeL9WmWtTkDKapYUCyve9U6qg
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"triggered","data":{"token_id":"4","by":"dmw-heir-cdeb.testnet","bounty":"50000000000000000000000","trigger_at_ms":1794045268959}}
  result: "50000000000000000000000"

## heartbeat after trigger is rejected
tx https://testnet.nearblocks.io/txns/8MYopu8bCz7TYMfPm7h1J4biEPim4EqH3TawFTg8aGV5
  error: {"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: vault_triggered"}}}}
(vault_triggered as expected)

## execute_step until Settled

$ node contracts/tools/tx.mjs call dmw-heir-cdeb.testnet dmw-x8cx.testnet execute_step {"token_id":"4"} 300
tx https://testnet.nearblocks.io/txns/Evr7ZBmNVsvZUAh9eKshpRsWcwoH6ZYVPUWvZ5zgMTdk
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"step_1","data":{"token_id":"4","payouts":[{"account_id":"dmw-heir-cdeb.testnet","amount":"1290000000000000000000000"},{"account_id":"heir-kvo.testnet","amount":"860000000000000000000000"}],"reserve":"100000000000000000000000"}}
  result: 2

$ node contracts/tools/tx.mjs call dmw-heir-cdeb.testnet dmw-x8cx.testnet execute_step {"token_id":"4"} 300
tx https://testnet.nearblocks.io/txns/J2mLZtAdLMB7Epd5yyrkvhDPofbTJwYBY1v5W4tQAWyJ
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"step_2","data":{"token_id":"4","deleted_keys":["ed25519:GvJMaRQJAYFvdPH91PqiHThKJcVehVf1vFtLG3bHHWXm","ed25519:GFNSAWdKnaTMcie5WrUhkeY2aKPmxm6tbaHJi4gniwB1"]}}
  result: 3

$ node contracts/tools/tx.mjs call dmw-heir-cdeb.testnet dmw-x8cx.testnet execute_step {"token_id":"4"} 300
tx https://testnet.nearblocks.io/txns/BEgBcAsr4jECWmkVjAJgTaFAnCyvhq9Zg3vVRVWiLxKn
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"step_3","data":{"token_id":"4","foreign":0}}
  result: 4

$ node contracts/tools/tx.mjs call dmw-heir-cdeb.testnet dmw-x8cx.testnet execute_step {"token_id":"4"} 300
tx https://testnet.nearblocks.io/txns/5vBTDasgGpx4wVXmoc32ZFoXfnmtJaaWPR749tCJX4GB
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"step_4","data":{"token_id":"4","dao_id":null}}
  result: 5

$ node contracts/tools/tx.mjs call dmw-heir-cdeb.testnet dmw-x8cx.testnet execute_step {"token_id":"4"} 300
tx https://testnet.nearblocks.io/txns/BsxxcSGZCrF6UDgy9qp41fmRw6LRmg6wSc2xyZW4CYHM
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"step_5","data":{"token_id":"4","old_owner_id":"dmw-owner-cdeb.testnet","new_owner_id":"dmw-heir-cdeb.testnet","remaining":"100000000000000000000000"}}
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"settled","data":{"token_id":"4","old_owner_id":"dmw-owner-cdeb.testnet","new_owner_id":"dmw-heir-cdeb.testnet","remaining":"100000000000000000000000"}}
  log: EVENT_JSON:{"standard":"nep171","version":"1.0.0","event":"nft_transfer","data":[{"old_owner_id":"dmw-owner-cdeb.testnet","new_owner_id":"dmw-heir-cdeb.testnet","token_ids":["4"],"memo":"settlement"}]}
  result: 6

$ node contracts/tools/tx.mjs call dmw-heir-cdeb.testnet dmw-x8cx.testnet execute_step {"token_id":"4"} 300
tx https://testnet.nearblocks.io/txns/7ja6krLL5G2Pi2u4TDKJoyEMPKJaxoF1zK4k9FJvhegE
  error: {"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: already_settled"}}}}
(already_settled as expected)

## pulse/agent keys gone from the contract account?
pulse present: False  agent present: False

## claim reserve as new Will NFT owner (dmw-heir-cdeb.testnet)

$ node contracts/tools/tx.mjs call dmw-heir-cdeb.testnet dmw-x8cx.testnet claim {"token_id":"4"} 30
tx https://testnet.nearblocks.io/txns/DNfc4sjxRXfRy9KxjNYBw9LvqPikT4Nxsg96SQ5Y3GMw
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"claim","data":{"token_id":"4","account_id":"dmw-heir-cdeb.testnet","amount":"100000000000000000000000"}}
  result: "100000000000000000000000"

## final get_vault

$ node scripts/near-admin.mjs view dmw-x8cx.testnet get_vault {"token_id":"4"}
{
  "token_id": "4",
  "owner_id": "dmw-heir-cdeb.testnet",
  "state": "Settled",
  "heartbeat_interval_s": 20,
  "grace_missed": 1,
  "last_beat_ms": 1794045228959,
  "warning_at_ms": 1794045248959,
  "trigger_at_ms": 1794045268959,
  "balance": "0",
  "bounty": "50000000000000000000000",
  "heirs": [
    {
      "account_id": "dmw-heir-cdeb.testnet",
      "bps": 6000
    },
    {
      "account_id": "heir-kvo.testnet",
      "bps": 4000
    }
  ],
  "foreign": [],
  "pulse_keys": [],
  "agent_keys": [],
  "policy": {
    "per_tx_max": "500000000000000000000000",
    "daily_max": "800000000000000000000000",
    "allowlist": [
      "heir-kvo.testnet"
    ]
  },
  "daily_spent": "700000000000000000000000",
  "daily_window_start_ms": 1794045096634,
  "dao_id": null,
  "dao_proposal_id": null,
  "step": 6,
  "foreign_index": 0,
  "foreign_inflight": false,
  "created_ms": 1794045096634,
  "log": [
    {
      "ms": 1794045096634,
      "event": "vault_created",
      "detail": ""
    },
    {
      "ms": 1794045108818,
      "event": "key_add_requested",
      "detail": "heartbeat ed25519:GvJMaRQJAYFvdPH91PqiHThKJcVehVf1vFtLG3bHHWXm"
    },
    {
      "ms": 1794045109969,
      "event": "key_added",
      "detail": "heartbeat ed25519:GvJMaRQJAYFvdPH91PqiHThKJcVehVf1vFtLG3bHHWXm"
    },
    {
      "ms": 1794045122091,
      "event": "key_add_requested",
      "detail": "agent_pay ed25519:GFNSAWdKnaTMcie5WrUhkeY2aKPmxm6tbaHJi4gniwB1"
    },
    {
      "ms": 1794045123313,
      "event": "key_added",
      "detail": "agent_pay ed25519:GFNSAWdKnaTMcie5WrUhkeY2aKPmxm6tbaHJi4gniwB1"
    },
    {
      "ms": 1794045138484,
      "event": "heartbeat",
      "detail": "pulse_key"
    },
    {
      "ms": 1794045159752,
      "event": "agent_pay_allowed",
      "detail": "heir-kvo.testnet 300000000000000000000000"
    },
    {
      "ms": 1794045171753,
      "event": "agent_pay_denied",
      "detail": "over_per_tx_max heir-kvo.testnet 900000000000000000000000"
    },
    {
      "ms": 1794045182683,
      "event": "agent_pay_denied",
      "detail": "receiver_not_allowlisted dmw-owner-cdeb.testnet 100000000000000000000000"
    },
    {
      "ms": 1794045193700,
      "event": "agent_pay_allowed",
      "detail": "heir-kvo.testnet 400000000000000000000000"
    },
    {
      "ms": 1794045205751,
      "event": "agent_pay_denied",
      "detail": "over_daily_max heir-kvo.testnet 400000000000000000000000"
    },
    {
      "ms": 1794045217786,
      "event": "timing_set",
      "detail": "20s x1"
    },
    {
      "ms": 1794045228959,
      "event": "heartbeat",
      "detail": "pulse_key"
    },
    {
      "ms": 1794045295606,
      "event": "triggered",
      "detail": "by dmw-heir-cdeb.testnet, bounty 50000000000000000000000"
    },
    {
      "ms": 1794045319128,
      "event": "step_1",
      "detail": "dmw-heir-cdeb.testnet 1.29 NEAR, heir-kvo.testnet 0.86 NEAR"
    },
    {
      "ms": 1794045334229,
      "event": "step_2",
      "detail": "2 keys deleted"
    },
    {
      "ms": 1794045348195,
      "event": "step_3",
      "detail": "foreign payouts done"
    },
    {
      "ms": 1794045362130,
      "event": "step_4",
      "detail": "no dao; skipped"
    },
    {
      "ms": 1794045376093,
      "event": "step_5",
      "detail": "will nft -> dmw-heir-cdeb.testnet"
    },
    {
      "ms": 1794045376093,
      "event": "settled",
      "detail": "dmw-heir-cdeb.testnet"
    },
    {
      "ms": 1794045405109,
      "event": "claim",
      "detail": "dmw-heir-cdeb.testnet 100000000000000000000000"
    }
  ]
}

## nft_token owner + media prefix
dmw-heir-cdeb.testnet data:image/svg+xml;base64,PHN2ZyB4bWxucz... {"state":"Settled","trigger_at_ms":1794045268959,"heirs":2}
```

## Heartbeat with a function-call key via near-cli-rs (0.31.1)

Checked on vault 2 right after the run above. Output: `The "heartbeat" call to <dmw-x8cx.testnet> on behalf of <dmw-x8cx.testnet> succeeded.`

```bash
near contract call-function as-transaction dmw-x8cx.testnet heartbeat \
  json-args '{"token_id":"2"}' prepaid-gas '10 Tgas' attached-deposit '0 NEAR' \
  sign-as dmw-x8cx.testnet network-config testnet \
  sign-with-plaintext-private-key "ed25519:<pulse secret key>" send
```

Same shape for `agent_pay` with an agent key (`json-args '{"token_id":"N","receiver_id":"...","amount":"<yocto>"}'`, 30 Tgas).
The private key is passed positionally. near-cli-rs 0.31 does not accept `--signer-public-key`.
