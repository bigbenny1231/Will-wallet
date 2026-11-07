# Live end-to-end run (testnet, 2026-11-07)

Everything below ran for real against `dmw-x8cx.testnet` with the keeper in this tree. Times are UTC.

| | |
| --- | --- |
| Contract | [`dmw-x8cx.testnet`](https://testnet.nearblocks.io/address/dmw-x8cx.testnet) |
| Vault | token **5**, owner `dmw-live-owner-fbcc.testnet`, interval 60 s, grace 1, bounty 0.05 NEAR |
| Heirs | `dmw-live-heir1-fbcc.testnet` 6000 bps (primary), `dmw-live-heir2-fbcc.testnet` 4000 bps |
| Policy | per_tx 0.5 / daily 1 NEAR, allowlist `[dmw-live-api-fbcc.testnet]` |
| Keeper | `dmw-keeper-a92b.testnet` (earned the 0.05 NEAR bounty) |
| Foreign payouts | Base Sepolia 0.0005 ETH to `0xcA024adC7cac111339Fe077C739F8085aE705F2F`; Solana devnet 0.01 SOL to `CFdWXa1ean7bBoewSv2SZESrDpWSxeoN1hfLrqaqZQUr` |
| Source addresses (derived, unfunded) | Base `0x6bF36F4AD61bD9Ee58f732e16C10b9079BB896Cc`, Solana `DY9R9j9CRBNCUBoo7xm4shP3ySMhcFFguH7ESQtmaDsZ` |

Result: poke, five steps, **Settled**; both payouts signed by the MPC (`status = signed`); the Will NFT moved to the primary heir.
The relays failed with insufficient funds because the derived source addresses have no money. That is expected: the keeper
logged it, left both payouts `signed` (not `failed`), and kept retrying every 60 s. For Solana it also hit the
expired-blockhash path and called `resign_foreign` (see below).

Private keys for the pulse and agent keys were generated in `/tmp`, never committed or recorded here.

## 1. Setup (owner transactions)

```text
$ create_vault (60 s interval, grace 1, 4 NEAR + 0.1 storage)
tx https://testnet.nearblocks.io/txns/8mt1J4PCr3SqzEUSGCJHKiCd7UwxCsVSjnTsBWxG9tzn
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"vault_created","data":{"token_id":"5","owner_id":"dmw-live-owner-fbcc.testnet","balance":"4000000000000000…
  log: EVENT_JSON:{"standard":"nep171","version":"1.0.0","event":"nft_mint","data":[{"owner_id":"dmw-live-owner-fbcc.testnet","token_ids":["5"]}]}…
  result: "5"

$ add_pulse_key
tx https://testnet.nearblocks.io/txns/7fwASyYtwC7UrhrvzsTdZXpRytxU9NJ5ErPwZoVa8zox
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"key_add_requested","data":{"token_id":"5","public_key":"ed25519:8HjBSeJs6S3BrXEhbzPT6pmHe5oqv19jgQFJTxmA2B…
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"key_added","data":{"token_id":"5","public_key":"ed25519:8HjBSeJs6S3BrXEhbzPT6pmHe5oqv19jgQFJTxmA2BJu","kin…
  result: true
$ add_agent_key
tx https://testnet.nearblocks.io/txns/A5hdGdSb3KahfyjJwKkBjnfEXsrPuDxiH4GeYeRzaPxA
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"key_add_requested","data":{"token_id":"5","public_key":"ed25519:5HQ1fGsoe2rJJcrGFeNq7cz7JccX6PMmHKrrWijXMt…
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"key_added","data":{"token_id":"5","public_key":"ed25519:5HQ1fGsoe2rJJcrGFeNq7cz7JccX6PMmHKrrWijXMtJ7","kin…
  result: true

$ set_foreign_payouts
tx https://testnet.nearblocks.io/txns/HC2y7YDusqqpe1e5cbeJBjfQCqBZHsTnaZ1SJm9Ar6ew
  log: EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"foreign_set","data":{"token_id":"5","foreign":[{"chain":"base","to":"0xcA024adC7cac111339Fe077C739F8085aE7…
  result: (empty)
```

## 2. Pulse for about 2 minutes (10 TGas heartbeats signed by the pulse key, beat every 30 s)

```text
♥ heartbeat sent  https://testnet.nearblocks.io/txns/HSNvPQsehWB8KrUqLdnpC6f8vvsAXw9B1Mj1Sxyprm3R
♥ heartbeat sent  https://testnet.nearblocks.io/txns/BmyPKzY3paaTcYtueKfEPoe3cijUhFMXdkDMjYhxQsfw
♥ heartbeat sent  https://testnet.nearblocks.io/txns/EXxvAhBxAbK5BjtxtfxrdPf4nvzpfJ2gXVBGW39dQ47N
♥ heartbeat sent  https://testnet.nearblocks.io/txns/CnEEoP9iyDmKhW7Fcm5q8KgdqcFsRrtsmCP54jp3xG5M
```

First heartbeat landed within seconds of `set_foreign_payouts`; 10 TGas prepaid gas was enough (allowance is charged on prepaid gas).

## 3. agent-demo (one allowed, one denied)

```text
policy: per_tx_max 0.5000 NEAR · daily_max 1.0000 NEAR · allowlist [dmw-live-api-fbcc.testnet]

agent_pay ALLOWED  (small, allowlisted)  0.0500 NEAR → dmw-live-api-fbcc.testnet
  result {"allowed":true,"reason":null,"receiver_id":"dmw-live-api-fbcc.testnet","amount":"50000000000000000000000","daily_spent":"50000000000000000000000","balance":"1950000000000000000000000"}  https://testnet.nearblocks.io/txns/6Qp9HKovYn3qtowAfNQ1u2cJMdEQLE4k2YXvQdrf5WSS
  event agent_pay_allowed  to dmw-live-api-fbcc.testnet · 0.0500 NEAR

agent_pay DENIED   (over per_tx_max, unknown receiver)  1.0000 NEAR → stranger-799d7c0e.testnet
  result {"allowed":false,"reason":"receiver_not_allowlisted","receiver_id":"stranger-799d7c0e.testnet","amount":"1000000000000000000000000","daily_spent":"50000000000000000000000","balance":"1950000000000000000000000"}  https://testnet.nearblocks.io/txns/AyJdcozQTDSYJ1QityGBHcaJ23pUGdKYFmPR42xrSvA6
  event agent_pay_denied  to stranger-799d7c0e.testnet · 1.0000 NEAR · reason=receiver_not_allowlisted
```

## 4. Pulse stopped, keeper started (`npm run keeper -- --poll 5 --token 5`)

The pulse was stopped at 10:07:21 (`pulse stopped — this is the moment the owner disappears`).

```text
10:07:22 keeper    watching dmw-x8cx.testnet via near:dmw-keeper-a92b.testnet→dmw-x8cx.testnet, poll every 5s
10:08:07 state     vault 5: Alive → Warning
10:09:26 poke      vault 5 → Triggered  https://testnet.nearblocks.io/txns/AutUKEYbQ1iXa5WQWbkdorm7XN5h6kN2oNb2wGwa3QnQ
10:09:30 state     vault 5: Warning → Triggered
10:09:42 step      vault 5 step 1/5  https://testnet.nearblocks.io/txns/DjmREeSpEYZDU1VPx2SYFrzpWzhmhTBmn8ynNDSVgYjL
10:09:57 step      vault 5 step 2/5  https://testnet.nearblocks.io/txns/CnwVzfbG2c1Toge3oFbmfhJhDkuLV71Gb7um9YwhMxE
10:10:17 step      vault 5 step 3/5 (base #0)  https://testnet.nearblocks.io/txns/AeGA3CXXkHLM8Xe7U96E5WQfeF8PDRuyuD8yVtpndtur
10:10:20 relay     vault 5 payout #0 base NOT broadcast: source 0x6bF36F4AD61bD9Ee58f732e16C10b9079BB896Cc is unfunded (eth_sendRawTransaction: insufficient funds for gas * price + value: have 0 want 500231000000000 (-32003)). Status stays signed; fund it and the keeper will relay. Retry in 60s
10:10:38 step      vault 5 step 3/5 (solana #1)  https://testnet.nearblocks.io/txns/C5jDoBKufX79rgos5wR1wasqbzwTUxD6GygXgLkoKdAT
10:10:44 relay     vault 5 payout #1 solana NOT broadcast: source DY9R9j9CRBNCUBoo7xm4shP3ySMhcFFguH7ESQtmaDsZ is unfunded (sendTransaction: Transaction simulation failed: Attempt to debit an account but found no record of a prior credit. "AccountNotFound"). Status stays signed; fund it and the keeper will relay. Retry in 60s
10:10:56 step      vault 5 step 4/5  https://testnet.nearblocks.io/txns/2eGDRKJ9Q8iQPy9jx2HCXzvMwR3LvWLZChewmcngDCRx
10:11:11 step      vault 5 step 5/5  https://testnet.nearblocks.io/txns/29TPx7prm5oV6A2ooSrk2pDrw8So3gMp9W2Gso6VfP3G
10:11:14 state     vault 5: Triggered → Settled
10:11:23 relay     vault 5 payout #0 base still unfunded; status stays signed, retry in 60s
10:11:48 resign    vault 5 payout #1 solana signed tx is stale (sendTransaction: Transaction simulation failed: Blockhash not found "BlockhashNotFound"); resign_foreign with fresh params
10:12:06 resign    vault 5 payout #1 solana resign_foreign  https://testnet.nearblocks.io/txns/9BwPW8bVUbXExj96LQBDBuQgJ3aKn1C4HEF3Gm3HyLcA
10:12:09 relay     vault 5 payout #1 solana still unfunded; status stays signed, retry in 60s
10:12:26 relay     vault 5 payout #0 base still unfunded; status stays signed, retry in 60s
```

Notes on the log:
- `poke` fired 2 intervals (120 s) after the last beat, the keeper earned the bounty, then steps 1-5 ran with 300 TGas each (about 15 s per step because the call waits for every receipt).
- Step 3 ran once per payout, sending `args.evm` for the Base payout and `args.solana` for the Solana payout (fetched right before the call).
- Both relays were rejected for lack of funds (`insufficient funds ... have 0` on Base, `AccountNotFound` on Solana). The payouts stay `signed`; settlement was not blocked.
- The Solana retry a minute later found the old blockhash expired, so the keeper called `resign_foreign(5, 1, args)` with a fresh blockhash ([tx](https://testnet.nearblocks.io/txns/9BwPW8bVUbXExj96LQBDBuQgJ3aKn1C4HEF3Gm3HyLcA)) and relayed the new signature, which again hit the unfunded source. The number of resigns per payout is capped (2, then a 5 min pause) so an unfunded Solana payout cannot drain the keeper.

## 5. Final on-chain state (`get_vault 5`)

```text
state Settled   step 6   NFT owner dmw-live-heir1-fbcc.testnet   vault balance 0.09999999999999999 NEAR (claimable reserve)
payout #0 base   status=signed  signed_tx=0x02f87283014a3480830f424083a7d8c0825208...  tx_hash=None
payout #1 solana status=signed  signed_tx=AUg668CJybl1/Ns7e1hoL0UAnopxjch0MNF1BH3E...  tx_hash=None

log:
  vault_created          
  key_add_requested      heartbeat ed25519:8HjBSeJs6S3BrXEhbzPT6pmHe5oqv19jgQFJTxmA2BJu
  key_added              heartbeat ed25519:8HjBSeJs6S3BrXEhbzPT6pmHe5oqv19jgQFJTxmA2BJu
  key_add_requested      agent_pay ed25519:5HQ1fGsoe2rJJcrGFeNq7cz7JccX6PMmHKrrWijXMtJ7
  key_added              agent_pay ed25519:5HQ1fGsoe2rJJcrGFeNq7cz7JccX6PMmHKrrWijXMtJ7
  heartbeat              pulse_key
  foreign_set            2 payouts
  heartbeat              pulse_key
  agent_pay_allowed      dmw-live-api-fbcc.testnet 50000000000000000000000
  agent_pay_denied       receiver_not_allowlisted stranger-799d7c0e.testnet 1000000000000000000000000
  heartbeat              pulse_key
  heartbeat              pulse_key
  triggered              by dmw-keeper-a92b.testnet, bounty 50000000000000000000000
  step_1                 dmw-live-heir1-fbcc.testnet 1.08 NEAR, dmw-live-heir2-fbcc.testnet 0.72 NEAR
  step_2                 2 keys deleted
  foreign_signed         #0 signed 0xf4bc7dca6606d8f655f66e0ff82dd85bd0a2c0a65cd54deb91b300c2c828b3ed
  foreign_signed         #1 signed 4yyfC49voP6VZYLSApiDEBjT6tTbSfUiou7QvRag4b3QE3vyaezBDXtCSKcf4cHp2bGNXcbKzsa9wBJobTT5ukNV
  step_3                 foreign payouts done
  step_4                 no dao; skipped
  step_5                 will nft -> dmw-live-heir1-fbcc.testnet
  settled                dmw-live-heir1-fbcc.testnet
  foreign_signed         #1 resigned 2SkzdSLFMFEzemp2n5wDZCxZWWuCbeLHkAnWf3uDd8jCvRdvnAnAu7dSFFFHmYdNEf58HYF7ES8jtNz5ghc5uKtx
```

Explorers: [source on Base](https://sepolia.basescan.org/address/0x6bF36F4AD61bD9Ee58f732e16C10b9079BB896Cc),
[source on Solana](https://explorer.solana.com/address/DY9R9j9CRBNCUBoo7xm4shP3ySMhcFFguH7ESQtmaDsZ?cluster=devnet).
To see the relay succeed, fund those two addresses and run `cd keeper && npm run keeper -- --poll 5 --token 5`:
the parked payouts are retried and `mark_broadcast` records the hashes.

## 6. `make demo` + `make kill`

Same flow through the one-command scripts (vault 7, interval 60 s, pulse every 20 s). `make kill` stopped the pulse and followed the keeper log until Settled:

```text
./scripts/kill.sh
owner is gone — watch the keeper
vault 7: last beat just landed; poke becomes legal after 2 missed intervals (~2 min)

10:18:38 state     vault 7: Alive → Warning
10:19:49 poke      vault 7 → Triggered  https://testnet.nearblocks.io/txns/A3rdDCi71o6DgVmeADDqP6TbaxL7bFtcrXm5GaBdc23o
10:19:52 state     vault 7: Warning → Triggered
10:20:04 step      vault 7 step 1/5  https://testnet.nearblocks.io/txns/FsdxzpGc8U2uZe7AyKR7EEa72EoTWM8Jqe6HwWS3Ngem
10:20:20 step      vault 7 step 2/5  https://testnet.nearblocks.io/txns/CGtzq3war8BDqYt4HymdKUDp82CGDxgqHcZ3sYTunVcR
10:20:38 step      vault 7 step 3/5 (base #0)  https://testnet.nearblocks.io/txns/ENu7z5CjbAbiAcuzmF7VWdqo8nJMmVxeYkNfoH7Sfdyh
10:20:42 relay     vault 7 payout #0 base NOT broadcast: source 0x297dCa057b815f6a629eF0Ac93aA31a87b7cCE49 is unfunded (eth_sendRawTransaction: insufficient funds for gas * price + value: have 0 want 500231000000000 (-32003)). Status stays signed; fund it and the keeper will relay. Retry in 60s
10:20:59 step      vault 7 step 3/5 (solana #1)  https://testnet.nearblocks.io/txns/FtAFvNf6oVf1onaf7GKiLm771cnEiaqvRG1gHqLATyLE
10:21:05 relay     vault 7 payout #1 solana NOT broadcast: source DdigGz32QjusAzYBUDRq4EoNFjaV9QtMcPCvDJDHzZjV is unfunded (sendTransaction: Transaction simulation failed: Attempt to debit an account but found no record of a prior credit. "AccountNotFound"). Status stays signed; fund it and the keeper will relay. Retry in 60s
10:21:18 step      vault 7 step 4/5  https://testnet.nearblocks.io/txns/JDBMjBRA4JfuxacBXstXgpBc4Hzd3qeYqSDCTyUtAEwN
10:21:33 step      vault 7 step 5/5  https://testnet.nearblocks.io/txns/HiM5YGXQ8PjfZ6xMFGW6EWrJy1MjEHDgNusWd1u3WWjV
10:21:36 state     vault 7: Triggered → Settled

Settled. The keeper keeps running to retry any unfunded relay: stop it with  pkill -f 'src/cli.ts keeper'
vault 7  Settled
  owner dmw-demo-sarah-3b15.testnet · interval 60s grace 1 · balance 0.1000 NEAR · step 5/5 · keys 0 pulse, 0 agent
  heirs dmw-demo-sarah-3b15.testnet 60%, dmw-demo-ben-3b15.testnet 40%
  payout #0 base 500000000000000 → 0xcA024adC7cac111339Fe077C739F8085aE705F2F · signed
  payout #1 solana 10000000 → CFdWXa1ean7bBoewSv2SZESrDpWSxeoN1hfLrqaqZQUr · signed
  10:20:58 foreign_signed #1 signed 3idRRH5L2vyDSCQbYCVnt69rH8KsNnwnSTEFzPAyU4NMtSCg2gNijiaf5iSs374EudFbLRWiYFPG3judbzBTH7t7
  10:20:58 step_3 foreign payouts done
  10:21:16 step_4 no dao; skipped
  10:21:31 step_5 will nft -> dmw-demo-sarah-3b15.testnet
  10:21:31 settled dmw-demo-sarah-3b15.testnet
```

## 7. Run 2 (post-hardening, 2026-11-07)

Same `make demo` + `make kill` against `dmw-x8cx.testnet` after the hardened contract (commit 7a12c23) was deployed, with the updated keeper
(nonce no longer relied on, `get_sign_track`-based re-sign planning, no immediate Solana retry, `broadcast`-but-missing relay).

| | |
| --- | --- |
| Vault | token **9**, owner `dmw-demo-owner-4822cb.testnet`, interval 60 s, grace 1, bounty 0.05 NEAR |
| Heirs | `dmw-demo-sarah-3b15.testnet` 60%, `dmw-demo-ben-3b15.testnet` 40% |
| Source addresses (derived, unfunded) | Base `0x20A7A32A5Dc59537d9AdcA889C196c9888FF0c9a`, Solana `HvyAXu3dZZMBDwuTZuTXmQaBpj9rDTJyb8JEnrjjFaB5` |

Result: clean **Settled**, both payouts `signed` (MPC signatures stored, the Will NFT moved to `dmw-demo-sarah-3b15.testnet`).
The sources are unfunded again, so the relays were parked as `signed` and retried every 60 s. That is expected. No re-sign was needed, so the
cooldown and fee-bump paths were covered by unit tests only; the live `get_sign_track` view was read for both payouts
(`last_request_ms` set, Base fees 11000000 / 1000000, `resign_allowed_after_ms` = last request + 300000).

- create_vault: https://testnet.nearblocks.io/txns/Bv9ZyVb3oHMJUxKCWhGLgqsvz4JGRRvkoE1vag8bAE2r
- add_pulse_key: https://testnet.nearblocks.io/txns/Aq58nRAcMUXGyizq8nG9TwFSfdnc1nfBaEEYZEd9gzEY
- add_agent_key: https://testnet.nearblocks.io/txns/Hkg7YikZTZKJ8WyUvPbru8sZGEbQZHG3jrNg5AWx9NXB
- set_foreign_payouts: https://testnet.nearblocks.io/txns/Hs2StWN8rBdgevWm9BnELpqf8ZdsQbdJf3x2dBSEpfWc
- agent_pay allowed: https://testnet.nearblocks.io/txns/E5sfmnZcGJKFvDRcCHsckd4x26htsUNzkJ5LemQtwGtw
- agent_pay denied: https://testnet.nearblocks.io/txns/7nk9n3Rp1kmLbi9BbZEkAXwhK1YLNGX1GfxRwTM5NBUk

```text
10:38:45 poke      vault 9 → Triggered  https://testnet.nearblocks.io/txns/25EzCVZkkL4Ntkzq34M4mn3YeRDJUn6EnBW8ebA5aNpw
10:39:01 step      vault 9 step 1/5  https://testnet.nearblocks.io/txns/5MLoJTpt6xPR5TaBvyFTwkgtpDdjZ36EHKtaGP9uHzQQ
10:39:16 step      vault 9 step 2/5  https://testnet.nearblocks.io/txns/9iKizdXGVFewNRQRyZom9GzJ2pduGo63kdYiuv5RYDpV
10:39:36 step      vault 9 step 3/5 (base #0)  https://testnet.nearblocks.io/txns/DBh1ZR1D9or4J7LeavfNxEnXnihq7NemqABSK6TGz5sS
10:39:56 step      vault 9 step 3/5 (solana #1)  https://testnet.nearblocks.io/txns/G8ixNTuLT2zoYS3mC4LWTLVRMn7SyYvns43oSHdbR6pV
10:40:15 step      vault 9 step 4/5  https://testnet.nearblocks.io/txns/8DYqUdAi2gp6R4oxaGcAbrvbbymPFoyiFbso852LJjk4
10:40:30 step      vault 9 step 5/5  https://testnet.nearblocks.io/txns/FYfBB4aL4VzZtPbTUyVKZXz4mwYL1NAGWHxj46xuAjBw
10:40:33 state     vault 9: Triggered → Settled
  payout #0 base ... · signed
  payout #1 solana ... · signed
```
