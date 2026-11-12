# On-chain state audit: `dmw-x8cx.testnet`

Audit of the **live** testnet state before the hackathon submission, Nov 7 2026, 20:05 to 20:35 UTC.
Read with `scripts/near-admin.mjs`, `contracts/tools/tx.mjs`, JSON-RPC (`rpc.testnet.near.org`), the NearBlocks
v3 API, Base Sepolia / Monad testnet / Solana devnet RPCs, and `keeper` (`npm run derive`).

A second review (the final contract audit, `docs/AUDIT_FINAL_CONTRACT.md`) was working on the same contract at the
same time: it **redeployed the contract at 20:18 UTC** and ran a stress vault (#18). Where this report says "before"
and "after", the redeploy is the dividing line. Nothing in this audit changed contract code.

## Summary

| Area | Result |
| --- | --- |
| Access keys | Clean. Snapshot: 1 FullAccess (deployer) + 1 function-call key (vault 13, Alive). No stray keys, no keys of Settled vaults |
| Solvency | Liquid 54.92 NEAR ≥ storage 5.06 NEAR + vault balances 9.30 NEAR + key allowances 1.00 NEAR. Surplus 39.57 NEAR |
| Code hash | Live `5H5vWiKF…Ydux` is **not any commit**. It is the uncommitted working tree (the H-5 gas-floor fix). HEAD source builds `13ug5kLS…fsqU`, which README/SUBMISSION still quote. **Must be reconciled before submitting** (F-1) |
| NEP-330 | `version 0.1.0`, `link https://github.com/agarretson/deadmans-wallet`, `build_info: null` (not a reproducible build) |
| Vaults | 18 total: 2 Alive (6 showcase, 13), 16 Settled. Nothing stuck in Triggered, no pending signatures, no failed transfers outside the deliberate stress test |
| Overdue vault | Vault 15 was Warning and 3 h past its deadline. Poked and settled (6 tx) |
| Showcase vault 6 | Heartbeat sent. A single heartbeat **does not** keep it Alive through Nov 14 (F-2) |
| Today's txs | 317 transactions (09:37 to 19:19 UTC) + 30 after: 13 failed, all expected guards or caller mistakes. No unexpected callers, no unexpected panics, all 23 MPC sign requests succeeded |
| MPC signatures | All 22 stored signed payouts (vaults 5, 7, 9 to 12, 14, 16 to 18) decode and verify. The signature recovers to the MPC-derived address, and chain id, recipient and amount match |
| Foreign delivery | None of the signed payouts has landed on Base, Monad or Solana (source addresses unfunded). Expected, documented in `keeper/SHOWCASE.md` |
| Keeper | 4.48 NEAR. Today's 87 keeper tx cost 0.072 NEAR in gas. Polling is view-only. No top-up needed; the default RPC is the risk (F-4) |

## 1. Account and access keys

`view_account` (final snapshot at 20:29 UTC):

| Field | Value |
| --- | --- |
| amount (liquid) | 54.924806 NEAR |
| locked | 0 |
| storage_usage | 506,212 B → 5.062 NEAR at 10^19 yocto/B |
| code_hash | `5H5vWiKFX1tF13ujkmozuke1DcdNExqeLTg8jAbRYdux` (was `13ug5kLS5oCUSHBjJ7P5sEJ7gANxaATHtHtfdDUZfsqU` until 20:18) |

Access keys:

| When | Key | Permission | Belongs to |
| --- | --- | --- | --- |
| start (20:05) | `ed25519:6fBT4G1E…GtC2` | FullAccess | deployer (`.env`) |
| start | `ed25519:Cb5hreCK…m3VP` | FC `heartbeat`, allowance 0.998 NEAR | vault 15 pulse key (vault overdue) |
| start | `ed25519:HE74dhQ8…sg28s` | FC `agent_pay`, allowance 0.998 NEAR | vault 13 agent key (Alive) |
| 20:26 | + 10 FC keys | 5 `heartbeat`, 5 `agent_pay` | vault 18 (other review's stress vault, then Alive) |
| **final (20:29)** | `6fBT4G1E…GtC2`, `HE74dhQ8…sg28s` | FullAccess, FC `agent_pay` | deployer, vault 13 |

Every function-call key on the account was in the `pulse_keys` or `agent_keys` list of a Live vault, so there were no
stray keys. The one key of a vault that should not have had one (vault 15, past its deadline) was removed by settlement step 2
([tx](https://testnet.nearblocks.io/txns/HmN8TFCAN1xSvE79xBk7kgbbzwc1mdKC4gTxAM6ZUQiy)). `remove_key` by the owner was not
usable for it: `remove_key` needs `stored == Live`, and the right action for an overdue vault is to settle it. Vault 18's
10 keys were deleted by its own step 2 (other review).

Balance reconciliation (final snapshot):

| | NEAR |
| --- | --- |
| Liquid balance | 54.9248 |
| − storage staked | 5.0621 |
| − sum of vault balances (owed to owners/heirs) | 9.3000 |
| − outstanding key allowances (vault 13) | 0.9976 |
| = contract surplus (deployer funds) | **39.5650** |

The contract can pay for its state and every vault obligation with about 39.6 NEAR to spare. Before the redeploy the same sum was
46.128 − 4.984 − 10.600 = 30.54 NEAR surplus. The surplus grew by about 10 NEAR because vault 18's 10 key allowances (1 NEAR each,
taken from its balance) stayed with the contract when the keys were deleted (F-5).

## 2. Contract metadata and code hash

`contract_source_metadata`:

```json
{"version":"0.1.0","link":"https://github.com/agarretson/deadmans-wallet",
 "standards":[nep171 1.2.0, nep177 2.0.0, nep181 1.0.0, nep297 1.0.0, dmw 1.0.0, nep330 1.3.0],
 "build_info":null}
```

Builds (rustc 1.97.0, cargo-near 0.23.0, `contracts/dmw/build.sh`, i.e. `cargo near build non-reproducible-wasm --locked`):

| Source | Code hash | Size |
| --- | --- | --- |
| `git archive HEAD contracts/dmw` (clean, built in `/tmp`) | `13ug5kLS5oCUSHBjJ7P5sEJ7gANxaATHtHtfdDUZfsqU` | 460,419 B |
| Working tree, uncommitted diff of `foreign.rs`/`lib.rs`/`nft.rs`/`tests.rs` (diff sha256 `2d3a2f67…7fad`) | `5H5vWiKFX1tF13ujkmozuke1DcdNExqeLTg8jAbRYdux` | 461,245 B |
| **On chain** before 20:18 / after 20:18 | `13ug5kLS…fsqU` / **`5H5vWiKF…Ydux`** | |

The redeploy is [4Dgg8tyK…](https://testnet.nearblocks.io/txns/4Dgg8tyKC2byYWwBUCD1i8eEBbFixtWkX1X8S8UcbWuk) (signed by
`dmw-x8cx.testnet`, 20:18:16 UTC). The new code adds `min_gas_limit: 50000` to the EVM chain registry (final audit H-5), and
vault 18's EVM signatures use gas limit 50,000. The state layout is compatible: every view and all 18 vaults still read.

`cargo near build reproducible-wasm` could not be run: there is no Docker daemon in this environment (`docker info` fails).
The README already says it is not a reproducible build, which is correct.

`get_config`: owner `dmw-x8cx.testnet`, keeper `dmw-keeper-a92b.testnet`, MPC `v1.signer-prod.testnet`, `next_id` 19,
storage fee 0.1, key allowance 1, reserve 0.1 (1.5 with DAO), DAO bond 1, pause 10 s to 90 days. Chains: Base Sepolia (84532,
max fee 100 gwei, 4 payouts), Monad testnet (10143, max fee 1000 gwei, 1 payout), Solana devnet. After the redeploy both EVM
chains have `min_gas_limit` 50000.

## 3. Vaults (final snapshot, 20:29 UTC)

| # | State | Step | NFT owner (now) | Balance (NEAR) | Interval / grace | Last beat | Trigger at (UTC) | Keys p/a | DAO | Guardian | Foreign payouts | Log entries | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Settled | 6 | `heir-kvo.testnet` | 0.1 | 30s / 1 | 11-07 09:38 | 11-07 09:39 | 0/0 | - | - | - | 10 | reserve unclaimed |
| 2 | Settled | 6 | `dmw-heir-cdeb.testnet` | 0.1 | 20s / 1 | 11-07 09:58 | 11-07 09:59 | 0/0 | - | - | - | 14 | reserve unclaimed |
| 3 | Settled | 6 | `dmw-heir-cdeb.testnet` | 0.1 | 20s / 1 | 11-07 09:48 | 11-07 09:49 | 0/0 | - | - | - | 18 | reserve unclaimed |
| 4 | Settled | 6 | `dmw-heir-cdeb.testnet` | 0 | 20s / 1 | 11-07 09:53 | 11-07 09:54 | 0/0 | - | - | - | 21 | reserve claimed |
| 5 | Settled | 6 | `dmw-live-heir1-fbcc.testnet` | 0.1 | 60s / 1 | 11-07 10:07 | 11-07 10:09 | 0/0 | - | - | base:signed, solana:signed | 22 | reserve unclaimed |
| **6** | **Alive** | 0 | `dmw-andrew-8d2e.testnet` | 5 | 86400s / 1 | 11-07 20:20 | **11-09 20:20** | 0/0 | - | - | base, monad, solana: pending | 6 | showcase; Warning from 11-08 20:20 |
| 7 | Settled | 6 | `dmw-demo-sarah-3b15.testnet` | 0.1 | 60s / 1 | 11-07 10:17 | 11-07 10:19 | 0/0 | - | - | base:signed, solana:signed | 20 | reserve unclaimed |
| 8 | Settled | 6 | `dmw-heir-cdeb.testnet` | 0 | 20s / 1 | 11-07 10:21 | 11-07 10:22 | 0/0 | - | - | - | 21 | reserve claimed |
| 9 | Settled | 6 | `dmw-demo-sarah-3b15.testnet` | 0.1 | 60s / 1 | 11-07 10:36 | 11-07 10:38 | 0/0 | - | - | base:signed, solana:signed | 20 | reserve unclaimed |
| 10 | Settled | 6 | `dmw-dao-heir-391f.testnet` | 0.5 | 30s / 1 | 11-07 11:32 | 11-07 11:33 | 0/0 | yes | - | base:signed | 13 | reserve unclaimed; DAO proposal 0 |
| 11 | Settled | 6 | `dmw-demo-sarah-3b15.testnet` | 0.1 | 60s / 1 | 11-07 15:20 | 11-07 15:22 | 0/0 | - | - | base:signed, solana:signed | 25 | reserve unclaimed |
| 12 | Settled | 6 | `dmw-demo-sarah-3b15.testnet` | 0.1 | 60s / 1 | 11-07 16:20 | 11-07 16:22 | 0/0 | - | - | base:signed, solana:signed | 23 | reserve unclaimed |
| 13 | Alive | 0 | `dmw-agent-owner-96af.testnet` | 2.6 | 86400s / 2 | 11-07 16:56 | 11-10 16:56 | 0/1 | - | - | - | 8 | agent demo vault; triggers Nov 10 |
| 14 | Settled | 6 | `dmw-gd-heir-7d5ea4.testnet` | 0.1 | 30s / 1 | 11-07 16:59 | 11-07 17:02 | 0/0 | - | yes | monad:signed | 12 | reserve unclaimed; paused 1x |
| 15 | Settled | 6 | `dmw-demo-ben-3b15.testnet` | 0.1 | 60s / 1 | 11-07 17:12 | 11-07 17:14 | 0/0 | - | yes | - | 20 | **settled by this audit** |
| 16 | Settled | 6 | `dmw-demo-sarah-3b15.testnet` | 0.1 | 60s / 1 | 11-07 18:27 | 11-07 18:29 | 0/0 | - | yes | base, monad, solana: signed | 40 | reserve unclaimed; paused 1x |
| 17 | Settled | 6 | `dmw-demo-sarah-3b15.testnet` | 0.1 | 60s / 1 | 11-07 18:39 | 11-07 18:41 | 0/0 | - | yes | base, monad, solana: signed | 40 | reserve unclaimed; paused 1x |
| 18 | Settled | 6 | `dmw-audit-b-c437bd.testnet` | 0 | 10s / 0 | 11-07 20:21 | 11-07 20:21 | 0/0 | yes | yes | 4 signed (base ×2, monad, solana) | 40 | other review's stress vault: 9 missing-account heirs → 9 `transfer_failed`, re-credited and then claimed (intended) |

`log` keeps the last 40 entries, so vaults 16 to 18 show 40. "Reserve unclaimed" is the 0.1 NEAR (0.5 for the DAO vault) that
the heir can `claim`. It is not an anomaly, and those reserves make up the 9.30 NEAR of owed balances (1.7 of it in Settled vaults).

Anomaly checks:

| Check | Result |
| --- | --- |
| Triggered with pending steps | none |
| Warning past deadline | **vault 15** (deadline 17:14, 3 h overdue) → poked and settled |
| Signature in flight > 10 min (`foreign_inflight`) | none |
| Failed payouts (`foreign` status `failed`) | none |
| `transfer_failed` events | only vault 18's nine deliberate missing-heir transfers, all re-credited (balance went to the claim) |
| Balance accounting | consistent (section 1) |

## 4. Transactions today

NearBlocks v1 has been retired (HTTP 410, "Use /v3"), so the audit used `GET /v3/accounts/dmw-x8cx.testnet/txns` with cursor
paging. That gave 317 transactions from 09:37:31 (account creation) to 19:19:40 UTC, which is the contract's entire history, plus
about 30 after 19:19 (the redeploy, this audit's 7 tx and the other review's vault 18). The full outcome of each of the 317 was
fetched with `EXPERIMENTAL_tx_status`.

By method: execute_step 81, heartbeat 81, agent_pay 40, poke 18, add_pulse_key 17, create_vault 17, set_foreign_payouts 13,
add_agent_key 11, DEPLOY_CONTRACT 10, resign_foreign 6, set_timing 5, pause 5, set_guardian 4, deposit 2, claim 2, set_dao 1,
mark_broadcast 1, set_keeper 1, new 1.

Callers: all are project test accounts (`dmw-*`), the keeper, or the contract itself through its own function-call keys (175 receipts with
predecessor `dmw-x8cx.testnet`). The 172 `system` receipts are gas refunds. There were no unknown callers.

Events: 23 `sign` requests to `v1.signer-prod.testnet` → 23 `foreign_signed`, with 0 foreign failures. 27 `key_add_requested` →
27 `key_added`, with 0 `key_add_failed`/`key_add_revoked`. There were 0 `transfer_failed` before vault 18. `agent_pay`: 19 allowed and 21 denied
(12 `receiver_not_allowlisted`, 5 `vault_not_alive`, 2 `over_daily_max`, 2 `over_per_tx_max`). These are the policy demos.

The 13 failed transactions all failed on contract guards working as designed, or on a caller mistake:

| Tx | Signer | Method | Panic | Assessment |
| --- | --- | --- | --- | --- |
| [3A4edrJd](https://testnet.nearblocks.io/txns/3A4edrJdxE2r5LEY6yJnXc5C1JYkUtsv1osUr3CnjNBD), [BYnVcVYK](https://testnet.nearblocks.io/txns/BYnVcVYKG848AK3RhB5sZci3T6GZ1mA69mYXqCseRhmX), [31xYgVNd](https://testnet.nearblocks.io/txns/31xYgVNdcpY2sqaT369SVVFDf5oohmry8ifjzN23qEDn) | heir-cdeb ×2, keeper | poke | `not_due` | guard (early poke tests / keeper race) |
| [R7F4s5FR](https://testnet.nearblocks.io/txns/R7F4s5FRS3zhyS8kf6rVtuoFUb98U69koRj8JAa7THw) | heir-cdeb | poke | `already_triggered` | guard (double poke) |
| [7ja6krLL](https://testnet.nearblocks.io/txns/7ja6krLL5G2Pi2u4TDKJoyEMPKJaxoF1zK4k9FJvhegE), [BnsRhAxZ](https://testnet.nearblocks.io/txns/BnsRhAxZCTow2d1tCpcwtS54EQrWXYVYMEoVELpiUdHs) | heir-cdeb | execute_step | `already_settled` | guard (step 6 re-entry) |
| [7vbyNTSZ](https://testnet.nearblocks.io/txns/7vbyNTSZoNkAncKAcyPrnATuBfQCwqpaZnfe5yCnHVah), [8MYopu8b](https://testnet.nearblocks.io/txns/8MYopu8bCz7TYMfPm7h1J4biEPim4EqH3TawFTg8aGV5) | contract (pulse key) | heartbeat | `vault_triggered` | guard (pulse daemon after the trigger, the demo's point) |
| [Chnrufz6](https://testnet.nearblocks.io/txns/Chnrufz6tF2Z6qrSijL9xPgRuoukz8oNDfKMxqddY7Ub) | gd-guard | pause | `already_paused…` | guard (one pause per cycle) |
| [1RdwkjuN](https://testnet.nearblocks.io/txns/1RdwkjuNvi6m2kKUQnnn4pgBSZFfhEYncxvwDZvfJNY) | keeper | resign_foreign | `resign cooldown…` | guard (5 min cooldown) |
| [51iB47XS](https://testnet.nearblocks.io/txns/51iB47XSPCn3DQEfHZPXXfhj54mse6PtDWCPacwyzCbN) | heir-cdeb | mark_broadcast | `tx_hash does not match the signed tx` | guard (H-1: fake hash rejected) |
| [G4iRKxcv](https://testnet.nearblocks.io/txns/G4iRKxcv5NuUT7SSVmjhwJttZ6GmavyHBwTLkWi7WKe) | andrew | set_timing | `Requires attached deposit of exactly 1 yoctoNEAR` | caller (called without the M-6 1 yocto; retried successfully) |
| [EDmCMs8c](https://testnet.nearblocks.io/txns/EDmCMs8cXfTNopJ4uiXSy6NkPoRt1dmMMerGoiPAzByf) | owner-cdeb | add_pulse_key | `…untagged enum TokenRef` | caller (malformed token_id) |

## 5. MPC signatures

Every stored `signed_tx` was decoded and checked offline (`@noble/curves` secp256k1/ed25519 and `@noble/hashes` keccak from
`keeper/node_modules`; the script was kept outside the repo):

- **EVM (Base, Monad):** EIP-1559 type-2 RLP is decoded and the sighash is `keccak256(0x02 ‖ rlp(fields[0..9]))`. The public key is recovered from
  (r, s, yParity) and the address is compared with the stored `from_address`. Chain id, `to` and `value` are compared with the payout.
- **Solana:** the legacy message is parsed. The ed25519 signature is verified over the message with the fee payer key. The fee payer is
  compared with `from_address`, and the instruction must be a System Program `Transfer` (index 2) with the stored recipient and lamports.
- The `from_address` values were checked independently with `npm run derive -- --token N` for vaults 5, 7, 9 to 12, 14, 16, 17 and 18.
  This derives the address from the MPC root key with path `base-N` / `monad-N` / `sol-N`.

| Vault | Chain | Recovered signer = derived address | Chain id | Nonce | Gas | Recipient / amount match | Tx id |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | base | `0x6bF36F4A…96Cc` ✔ | 84532 ✔ | 0 | 21000 | ✔ | `0xf4bc7dca…b3ed` |
| 5 | solana | `DY9R9j9C…aDsZ` ✔ (sig valid) | devnet | | | ✔ | `2Skzd…uKtx` |
| 7, 9, 11, 12 | base + solana | ✔ all | 84532 ✔ | 0 | 21000 | ✔ | |
| 10 | base | `0xD2276794…650b` ✔ | 84532 ✔ | 0 | 21000 | ✔ | `0x5a88b81e…321e` |
| 14 | monad | `0x360D0232…0e13` ✔ | 10143 ✔ | 0 | 21000 | ✔ (to `0x…dEaD`) | `0xbb3d639b…df19` |
| 16 | base / monad / solana | ✔ / ✔ / ✔ | 84532 / 10143 ✔ | 0 / 0 | 21000 | ✔ | |
| 17 | base | `0x0D138Cc8…a488` ✔ | 84532 ✔ | 0 | 21000 | ✔ | `0xbd61cadf…ba54` |
| 17 | monad | `0x99D55748…97EA` ✔ | 10143 ✔ | 0 | 21000 | ✔ | `0x3cdf7780…dd4b` |
| 17 | solana | `BEpQthc2…QMAu` ✔ (sig valid) | devnet | | | ✔ | `m1Zie…zdw9` |
| 18 | base ×2 / monad / solana | signatures recover to the derived `0x6E997b91…7A84` / `0x2eF2b6e0…b686` / `8VtpzWGv…aXXjq` ✔. **Stored `from_address` is a junk placeholder** (`ffff…`, F-6) | 84532 / 10143 ✔ | 0, 1 / 0 | **50000** (new floor) | ✔ | |

22 of 22 signatures are valid, signed by the correct per-vault MPC key, on the correct chain, for the stored recipient and amount.
All the signed payouts were checked on chain (`eth_getTransactionReceipt` on Base Sepolia / Monad testnet, `getSignatureStatuses` on
Solana devnet with history). **None has landed**, because the derived source addresses were never funded. The EVM signatures (nonce 0, pinned) stay
relayable if funded. The Solana ones are past their blockhash and need `resign_foreign`.

## 6. Keeper

`dmw-keeper-a92b.testnet`: 4.4809 NEAR, 1 FullAccess key. Today it sent 87 tx (69 execute_step, 12 poke, 6 resign_foreign) for
0.072 NEAR of gas in total, and its bounties (0.01 to 0.1 NEAR per poke) more than cover that. Polling is `view` RPC calls, which are free.
A week of polling plus settling every vault on the contract several times over costs well under 1 NEAR. **No top-up was made.**

## 7. Actions taken

| # | Action | Signer | Tx |
| --- | --- | --- | --- |
| 1 | `heartbeat {"token_id":"6"}`: showcase stays Alive; trigger moved 11-09 10:13 → 11-09 20:20 UTC | `dmw-andrew-8d2e.testnet` (owner) | [C8wCCyXw](https://testnet.nearblocks.io/txns/C8wCCyXw1hoLiNuMAxYFLzGmJDD55MY2e2w1WwuARdH3) |
| 2 | `poke {"token_id":"15"}`: Warning, 3 h overdue → Triggered, bounty 0.01 NEAR to keeper | keeper | [H7dftsTL](https://testnet.nearblocks.io/txns/H7dftsTLuSHLsjwTj2Xp187vRVudxUzQ34bwVyXZJQhu) |
| 3 | `execute_step` 1: 1.29 NEAR to `dmw-demo-ben-3b15.testnet`, reserve 0.1 | keeper | [7ZT63uhC](https://testnet.nearblocks.io/txns/7ZT63uhCzDu3YytWAXi6ugF4AUUiYjThCKY1q3czhD3K) |
| 4 | `execute_step` 2: deleted pulse key `Cb5hreCK…m3VP` | keeper | [HmN8TFCA](https://testnet.nearblocks.io/txns/HmN8TFCAN1xSvE79xBk7kgbbzwc1mdKC4gTxAM6ZUQiy) |
| 5 | `execute_step` 3: no foreign payouts | keeper | [2rD5wW9L](https://testnet.nearblocks.io/txns/2rD5wW9LvutJFhg1kD4GDDG7iM7jx3vg9fym5e8WgaY1) |
| 6 | `execute_step` 4: no DAO | keeper | [nPXrwrXv](https://testnet.nearblocks.io/txns/nPXrwrXvAHW1qdZHpJYvNim1VB6ydGfHrRG2W9prny8) |
| 7 | `execute_step` 5: Will NFT 15 → `dmw-demo-ben-3b15.testnet`, Settled | keeper | [H9k3d2uw](https://testnet.nearblocks.io/txns/H9k3d2uwaZRuGycM9ZsA6HPnFk3Z5Y6bWWbZv4aQNo5F) |

Note: action 1 and actions 2 to 7 ran on the redeployed code (`5H5v…`, from 20:18:16), not on `13ug…`.

## 8. Findings

| ID | Severity | Finding | Recommendation |
| --- | --- | --- | --- |
| F-1 | **High (submission)** | The live code hash `5H5vWiKF…Ydux` does not match any commit. It is the uncommitted H-5 working tree, redeployed at 20:18 by the parallel final-audit work. README (line 180), `docs/SUBMISSION.md` (line 156), `docs/AUDIT_CLAIMS.md` and `docs/JUDGE_DRY_RUN_4.md` still say the live code is `13ug5kLS…fsqU` from `f0178de`. A judge running `make build` on the submitted commit will get a different hash than `view_account` | Commit the contract change, then rebuild at that commit and update the hash, deploy tx and commit id in README/SUBMISSION. Suggested README wording: "The live contract is this source: `view_account dmw-x8cx.testnet` → code hash `<hash>`, deployed in [tx](…) from commit `<sha>`, built with `cargo near build non-reproducible-wasm` (rustc 1.97.0, cargo-near 0.23.0). `make build` at that commit with the same toolchain prints the same hash; a different toolchain gives a different one. It is not a reproducible build: `contract_source_metadata` returns `link` and `version` but `build_info: null`. The earlier Docker build of `88cd83b` (`G6eiYJj6…25hM`) has since been replaced." |
| F-2 | **Medium (demo)** | Vault 6 (86400 s, grace 1) only stays Alive for 24 h after each beat and triggers 48 h after it. After today's heartbeat it goes **Warning at 11-08 20:20 UTC** and is **pokeable at 11-09 20:20 UTC**. Any running keeper (or anyone, for the 0.05 NEAR bounty) would settle the showcase then. One heartbeat cannot keep it Alive through Nov 14 | Either heartbeat it as the owner at least every 24 h until judging ends, or (owner, 1 yocto) `set_timing {"token_id":"6","heartbeat_interval_s":604800,"grace_missed":1}`, which gives Alive until 11-14 20:20 and trigger at 11-21 20:20 with no further action. Note `set_timing` keeps `last_beat_ms`. Not done here because the brief said to leave vault 6 otherwise untouched |
| F-3 | Medium (demo) | The showcase Monad payout recipient `0x360d0232…0e13` (also used by vaults 16 and 17) is **vault 14's MPC-derived `monad-14` address**: keyless, and only movable by the contract signing for vault 14 (whose one Monad payout goes to `0x…dEaD`). Any MON "inherited" there is effectively burned | Point vault 6's Monad payout at an address an heir controls (`set_foreign_payouts`, owner, 1 yocto) before recording/judging |
| F-4 | Low (ops) | `rpc.testnet.near.org` (the keeper's default, `keeper/src/config.ts:36`) returned `-429 … THIS ENDPOINT IS DEPRECATED … Switch to https://fastnear.com` during this audit (`npm run derive` failed until it was rerun with `NEAR_RPC=https://rpc.testnet.fastnear.com`) | Run the keeper with `NEAR_RPC=https://rpc.testnet.fastnear.com` (or change the default) for the judging week |
| F-5 | Low (design) | Unspent key allowance is never returned to the vault. `add_*_key` takes 1 NEAR from the vault balance, but `remove_key` and settlement step 2 delete the key without crediting the unused allowance, so it becomes contract surplus. Vault 15 lost ~1 NEAR to it and vault 18 lost 10 NEAR. SPEC §2.7 only covers the AddKey-failure refund | Refund `KEY_ALLOWANCE − used` on delete (read it with `view_access_key` beforehand, or track a per-key reservation), or document it as a fee |
| F-6 | Low (UX) | `from_address` in `set_foreign_payouts` is free text set by the owner and checked only for length (≤ 64). Vault 18 stores `ffff…`, while its signatures come from the real derived addresses. A dashboard that shows `from_address` as "fund this address" could send heirs' or owners' funds to a wrong address | Derive the address in the dashboard/keeper (as `npm run derive` does) and ignore or validate the stored value |
| F-7 | Info | Vault 13 (agent demo, Alive) triggers on 11-10 16:56 UTC unless its owner beats | Beat it, or accept that it settles |
| F-8 | Info | 13 settled vaults hold 1.7 NEAR of unclaimed reserves, and no signed foreign payout has been delivered (sources unfunded, as documented) | None required. Fund the vault 6 sources before the demo if delivery is to be shown |

## 9. State at submission (snapshot 2026-11-07 20:29:03 UTC)

```
account     dmw-x8cx.testnet   liquid 54.924806 NEAR   locked 0   storage 506,212 B (5.062 NEAR)
code_hash   5H5vWiKFX1tF13ujkmozuke1DcdNExqeLTg8jAbRYdux   (working tree, NOT a commit; HEAD builds 13ug5kLS…fsqU)
nep330      version 0.1.0  link github.com/agarretson/deadmans-wallet  build_info null
keys        ed25519:6fBT4G1ECAsbjSuFCFyGop2cwNv3jDdXzQJGwG3gGtC2  FullAccess (deployer)
            ed25519:HE74dhQ8ipHWwqzx23MYRLauuconmTw8RXPqYMdsg28s  FC agent_pay  (vault 13)
config      keeper dmw-keeper-a92b.testnet  mpc v1.signer-prod.testnet  next_id 19
vaults      18 = 2 Alive (6, 13) + 16 Settled; 0 Warning, 0 Triggered
owed        9.30 NEAR in vault balances (6: 5.0, 13: 2.6, reserves 1.7)
surplus     39.57 NEAR after storage, balances and key allowances
vault 6     Alive, owner dmw-andrew-8d2e.testnet, 5 NEAR, last beat 11-07 20:20:24,
            Warning 11-08 20:20, trigger 11-09 20:20 UTC, payouts base/monad/solana pending
keeper      dmw-keeper-a92b.testnet 4.4809 NEAR
```
