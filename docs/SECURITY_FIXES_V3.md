# Contract v3: security fixes (Nov 12 2026)

These fixes cover the third adversarial review (contract + deploy setup, review of commit `dfd66e5`). This is the source
of contract v3, on branch `claude/v3-contract`.

**Status.** Not deployed yet. v3 changes the state layout (new `Contract` fields, a longer `SignTrack`), so it goes to a
new account, like v2 did. The planned deploy is locked: `owner_id` is the contract account itself and every full-access
key is deleted. The keeper passed to `new` is the long-lived `dmw-keeper-<tag>.testnet` account, which fixes H-2 in
operations; the contract change for H-1 below is the recovery path if that keeper is ever compromised.

**Tests.** `cargo test --locked` ran 148 contract tests before this pass and runs **174** after it: 26 new ones in
`contracts/dmw/src/tests_v3.rs`. Five of them are the reviewer's proof-of-concept tests turned around (`v3_poc_*`):
each one shows that the attack it reproduced is now refused. Existing tests that encoded the old behaviour were updated
(list at the end).

**How the tests were checked.** The mock blockchain of near-sdk 5.30.1 (`testing_env!`). It meters host gas (storage,
logs, receipts and attached gas) with the protocol's fee table (`RuntimeFeesConfig::test()`, the mainnet values), but not
wasm instructions, so every gas figure below leaves room for the wasm work. No sandbox run: `near-workspaces`, cargo-near
and the sandbox binary are not installed on the build machine.

## Findings, fixes and tests

Function names below are the Rust ones. `lib.rs`, `foreign.rs`, `nft.rs` and `types.rs` are in `contracts/dmw/src/`.
All tests are in `tests_v3.rs`.

| Finding | Fix | Tests |
| --- | --- | --- |
| **H-1 (4).** A compromised contract keeper could never be removed on a locked contract: only the keeper itself could call `set_keeper`. | Optional **keeper admin**, set in `new(.., keeper_admin)`. It may not be the contract or the keeper (`require_separate_roles`). Its only powers: `propose_keeper(account_id?)`, `propose_mpc_signer(account_id)`, `set_keeper_admin(account_id?)` and `cancel_admin_proposal()`, each exactly 1 yocto and each with an event (`admin_proposal`, `admin_proposal_cancelled`). There is one proposal at a time (`Contract.admin_proposal`, `types.rs AdminProposal`); a new one replaces it (`replaced` in the event). **Anyone** runs `execute_admin_proposal()` once `ADMIN_TIMELOCK_MS` (48 h) has passed (`admin_proposal_executed`). A keeper change drops any pending hand-over and starts a new keeper epoch. The admin is never an operator or a keeper (`is_operator` / `is_keeper` do not know it). `get_config` shows the admin, the proposal and its `eta_ms`. | `v3_h1_admin_replaces_keeper_after_timelock`, `v3_h1_admin_methods_need_the_admin_and_one_yocto`, `v3_h1_admin_cancels_and_replaces_proposals`, `v3_h1_admin_replaces_mpc_signer`, `v3_h1_set_keeper_admin_is_timelocked`, `v3_h1_admin_is_not_an_operator`, `v3_h1_init_checks_keeper_admin` |
| **H-1 (4), hand-over.** `set_keeper` moved the role at once, so a typo or an account nobody controls ended the role for good on a locked contract. | Two steps. `set_keeper(account_id)` (contract owner while it is a separate account, or the current keeper; 1 yocto) only sets `pending_keeper` (`keeper_proposed`). The named account takes the role with `accept_keeper()` (1 yocto, `keeper_set`). Naming the current keeper cancels the proposal (`keeper_proposal_cancelled`). `null` still clears the role at once, but not on a locked contract. The owner path is two-step too. | `v3_poc_locked_keeper_handover_needs_acceptance`, `v3_owner_set_keeper_is_two_step_and_clear_is_immediate`; updated `v2_c_keeper_rotates_itself_on_locked_contract` |
| **H-1 (1), L-4.** A Solana transfer has no nonce. The keeper could re-sign a signed Solana payout every 5 minutes, and every signature is a second payment. All Solana payouts of a vault share one derived address, so this moved one heir's SOL to another recipient. The Solana `to` was not validated. | `set_foreign_payouts`: at most **1 Solana payout per vault** (`SOLANA_MAX_PAYOUTS`, `ForeignChain::max_payouts`; the per-chain loop also keeps Monad's existing cap of 1). A Solana `to` must be base58 that decodes to exactly 32 bytes (`foreign::is_solana_address`) and its amount must fit a u64 of lamports. An EVM `to` must be `0x` + 40 hex. `resign_foreign`: a keeper re-sign of a `signed`/`broadcast` Solana payout is capped at **3 per keeper epoch** (`MAX_KEEPER_SOLANA_RESIGNS`). The counter is in the payout's `SignTrack` (`keeper_resigns`, `keeper_epoch`) and counts every request, also one whose MPC call fails. Re-signing a `failed` payout (no signature exists) does not count. `get_sign_track` shows `keeper_resigns` and `keeper_resigns_left`. | `v3_l4_at_most_one_solana_payout_per_vault`, `v3_l4_foreign_to_and_amount_are_validated`, `v3_poc_keeper_solana_resigns_capped_at_three`, `v3_h1_failed_solana_resign_does_not_use_keeper_allowance` |
| **M-1, H-1 (2).** After the operator hour anyone could supply the Solana blockhash for step 3. A junk or stale one left a `signed` payout that only a keeper could re-sign. | `run_step` step 3: a Solana payout is signed only with an operator's blockhash. After the hour, a stranger's `execute_step` records the current Solana payout `failed`, with no signature, so settlement moves on. Every operator (heirs included) may then re-sign it at once with `resign_foreign` (a failed payout is not keeper-only). EVM keeps the 1 h opening: its nonce is pinned and a non-keeper's fees are clamped, so a stranger's signature can only be replaced, not doubled. | `v3_poc_stranger_cannot_sign_solana_after_the_hour`; updated `v2_c_step3_open_to_anyone_after_an_hour` (now an EVM payout) |
| **H-1 (3).** A keeper that signed an EVM payout above the non-keeper clamp locked heirs out: the 110% rule asked them for fees above what they may ever pick. | `resign_foreign`: when the last signed fees are above the chain's `non_keeper_max_fee_per_gas`, a non-keeper may replace the tx **at the clamp** without the 110% rule: `max_fee_per_gas` exactly the clamp and the priority fee not below min(last priority fee, clamp). After that the last fees are the clamp, so the normal rule applies again (no repeated flips). The nonce is pinned, so this only replaces the tx. | `v3_h1_heir_replaces_keeper_cap_fee_at_clamp`, `v3_h1_clamp_replacement_keeps_priority_fee` |
| **L-3.** A re-sign stored the new fees before the signature existed. After one failed MPC call, heirs had to beat fees that were never signed. | `resign_foreign` writes only the request time and the in-flight flag (`SignTrack { last_request_ms, inflight, ..track }`). `on_foreign_resigned` copies the pending tx's fees into the track only when it stores the signature. A failed re-sign never changes the payout's status. | `v3_l3_failed_resign_keeps_previous_fees_and_heirs_can_retry`; updated `c1_evm_resign_reuses_nonce_and_requires_fee_bump`, `r2_f1_heir_may_still_bump_signed_evm_payout`, `r2_g1_keeper_may_resign_evm_at_any_fee_and_gas` |
| **M-2.** `on_transfer_done` had a static 5 TGas, and v2 writes the vault twice on the failure path. If the callback runs out of gas, a failed transfer's NEAR lands in the pool and the vault is never credited. | Measured, then fixed both ways. (1) **One vault write:** `save_vault_once` predicts the change in the vault's borsh length, folds the storage charge into the single write and asserts in tests that the prediction equals the real storage delta. It is used by `on_transfer_done` (failure path), `on_key_added` and `on_dao_proposal`. (2) **More gas:** `GAS_ON_TRANSFER` 5 → 10 TGas; `GAS_ON_DAO` and `GAS_ON_KEY` 10 → 15 TGas; `GAS_FOREIGN_FAIL` 10 → 20 TGas. The review suggested 20 TGas for the transfer callback; that does not fit 10 heirs in one 300 TGas step (arithmetic below). | `v3_m2_on_transfer_done_failure_path_fits_budget`, `v3_m2_single_write_saves_a_vault_write`, `v3_m2_single_write_storage_accounting_is_exact`, `v3_m2_step1_and_step5_fit_300_tgas_with_10_heirs`, `v3_m2_poke_and_claim_fit_50_tgas` |
| **L-2.** Operators (300 keeper re-signs) and the owner-chosen DAO (repeated `dao_ratified` marks) could push the trigger and the settlement steps out of the 40-entry history ring. | `vault_created`, `triggered`, `step_1`..`step_5` and `settled` are pinned (`is_pinned`): a full history ring evicts the oldest **unpinned** entry (`record_to`). A repeated `dao_ratified` mark and `foreign_resign_failed` go to the routine log. | `v3_l2_resigns_and_dao_marks_do_not_evict_settlement_history` |
| **L-5.** `get_vaults_for_owner` returned every vault in the owner's index, and anyone can add to a victim's index by sending Will NFTs. | `get_vaults_for_owner(account_id, from_index?, limit?)`: paged, default 50 (`OWNER_PAGE_DEFAULT`), max 100 (`OWNER_PAGE_MAX`). A call with `account_id` only still works and returns the first 50. | `v3_l5_get_vaults_for_owner_is_paged` |
| **L-6.** A sale kept the seller's timing. With a 10 s interval and grace 0 the buyer's vault was due 10 s later, and the foreign balances were stranded. | `move_owner` (a transfer while Live) raises the interval to at least 86 400 s (`SALE_MIN_INTERVAL_S`) and grace to at least 1 (`SALE_MIN_GRACE`) when either is lower. `owner_changed` reports `timing_raised`, `heartbeat_interval_s` and `grace_missed`. | `v3_l6_sale_raises_timing_so_buyer_cannot_be_poked`; updated `nft_transfer_by_owner_while_alive_not_warning` |
| **L-1 (contract side).** A function-call key on the contract account that reaches a `#[private]` method could call `nft_resolve_transfer` with no promise result and move a Will NFT back. | `nft_resolve_transfer` with anything but exactly one promise result logs `nft_resolve_transfer: not a transfer resolution; nothing changed` and returns `true` (keeps the transfer). With exactly one failed result it reverts as before. The real fix is in the lock check (`scripts/near-admin.mjs`), which is outside this pass. | `v3_poc_resolve_without_result_cannot_move_a_vault`; updated `v2_callbacks_require_exactly_one_result` |
| **I-1.** The MPC signer could never change after lock. | `propose_mpc_signer` through the keeper admin, behind the same 48 h timelock. | `v3_h1_admin_replaces_mpc_signer` |

## Gas budget (M-2)

Numbers from the mock (host gas only, attached gas included), on the maximal vault of the tests: both 40-entry rings
full of 400-byte details, 10 heirs and 10 allowlist entries with 64-character names, 5 pulse and 5 agent keys,
24 spends and 4 payouts with a signed tx and a hash: **40 345 bytes** of borsh.

| Path | v2 | v3 |
| --- | --- | --- |
| `on_transfer_done` failure path, write part (insert + `charge_storage` vs. `save_vault_once`) | 4.96 TGas | 2.51 TGas |
| `on_transfer_done` failure path, whole callback | > 5 TGas before any wasm | 2.56 TGas |
| Transfer callback budget | 5 TGas | 10 TGas |

v2's 5 TGas was already exceeded on a maximal vault before any wasm work. v3 needs about 2.6 TGas of host gas plus
2 to 3 TGas of wasm (borsh of 40 KB; the final audit's I-11 measured 3.17 TGas in all on a v1 vault), so about 5.5 TGas,
and 10 TGas leaves about 2x on the worst case.

**Callers.** Each heir transfer costs the caller 14.8 TGas of receipt fees plus the attached callback gas:

- the transfer receipt: `new_action_receipt` + `transfer`, send and exec: 0.45 TGas;
- the callback receipt: `new_action_receipt` + `function_call_base` + argument bytes, send and exec: 4.86 TGas;
- the callback's data dependency: `new_data_receipt_base`, send and exec: 9.39 TGas.

Measured step 1: 1 heir 29.67 TGas, 3 heirs 79.28 TGas, 10 heirs 252.88 TGas, so 24.80 TGas per heir and 4.9 TGas for
the step itself.

| Caller | Formula | Host gas | Callers attach |
| --- | --- | --- | --- |
| Step 1, 10 heirs | 4.9 + 10 × (14.8 + 10) | **252.9 TGas** | 300 TGas (keeper and dashboard already do) |
| Step 5, 10 heirs | same shape | **251.9 TGas** | 300 TGas |
| Step 1 with a 15 TGas callback | 4.9 + 10 × (14.8 + 15) | 302.9 TGas: does not fit | |
| Step 1 with the suggested 20 TGas | 4.9 + 10 × (14.8 + 20) | 352.9 TGas: does not fit | |
| `poke`, `claim` (one transfer) | | 29.7 TGas | **≥ 50 TGas** (keeper `poke` uses 60; the v2 dashboard's 30 is too little) |
| `agent_pay` (one transfer) | | about 30 TGas | the keeper backend uses 60 |
| Step 4: `add_proposal` 100 + `on_dao_proposal` 15 | + about 30 TGas of fees | < 150 TGas | 300 TGas |
| `add_pulse_key` / `add_agent_key`: AddKey + `on_key_added` 15 | + about 15 TGas of fees | < 40 TGas | 50 to 100 TGas |

Step 1 and step 5 leave 47 TGas of the 300 for their wasm work (one read and one write of the vault, the event JSON).
Splitting step 1 across several calls would have bought more callback gas, but it changes the settlement state machine
two days before the deadline; 10 TGas with a single write is enough for the measured worst case.

## Interface changes for the callers

None of these files changed in this pass (other agents own them). Each row is what they need.

| Change | Exact shape | Who needs it |
| --- | --- | --- |
| `new` takes `keeper_admin` | `{"owner_id": "<contract>", "keeper_id": "dmw-keeper-<tag>.testnet", "mpc_signer": "v1.signer-prod.testnet", "keeper_admin": "<cold account>"}`; `mpc_signer` and `keeper_admin` may be left out (serde treats a missing `Option` as `null`). `keeper_admin` must differ from the contract and from `keeper_id`, or `new` panics. | `scripts/deploy.sh` (`INIT`), `scripts/near-admin.mjs deploy` |
| Keeper hand-over is two steps | `set_keeper {"account_id": "<new>"}` with 1 yocto from the owner or the current keeper, then `accept_keeper {}` with 1 yocto **signed by the new keeper**. `{"account_id": null}` still clears at once on an unlocked contract. | `scripts/lib.sh register_keeper` |
| Admin methods | `propose_keeper {"account_id": "<acc>" \| null}`, `propose_mpc_signer {"account_id": "<acc>"}`, `set_keeper_admin {"account_id": "<acc>" \| null}`, `cancel_admin_proposal {}`: keeper admin, 1 yocto each. `execute_admin_proposal {}`: anyone, no deposit, after `eta_ms`. | ops runbook; optionally a dashboard/admin view |
| `get_config` fields | `pending_keeper` (account or `null`), `keeper_admin` (account or `null`), `admin_timelock_ms` (172800000), `admin_proposal` (`{"action": "keeper" \| "mpc_signer" \| "keeper_admin", "account_id": "<acc>" \| null, "proposed_ms": <u64>, "eta_ms": <u64>}` or `null`), `keeper_epoch` (u32), `max_keeper_solana_resigns` (3), `sale_min_interval_s` (86400), `sale_min_grace` (1). `chains[]` Solana entry: `max_payouts` (1), `max_keeper_resigns` (3). | keeper, dashboard (version sniffing: `keeper_admin` key present ⇒ v3) |
| `get_sign_track` fields | adds `keeper_resigns` (u32, in the current epoch) and `keeper_resigns_left` (u32). Fees in the track are now the last **signed** fees, not the last requested ones. | keeper `resign.ts` (stop re-signing a Solana payout at 0 left, instead of failing the call), dashboard |
| `get_vaults_for_owner` | `{"account_id": "<acc>", "from_index": <u64>?, "limit": <u64>?}`; default 50, max 100. | dashboard "my vaults" (page beyond 100 if needed) |
| `set_foreign_payouts` validation | at most 1 Solana payout per vault; Solana `to` base58 of 32 bytes, amount ≤ 18446744073709551615; EVM `to` `0x` + 40 hex. Errors: `too many solana payouts (max 1 per vault)`, `solana \`to\` must be a base58 32-byte public key`, `solana amount must fit in u64 lamports`. | dashboard Create / payouts form (validate before sending), agent, demo scripts |
| Step 3 Solana by a stranger | after the operator hour a non-operator `execute_step` records the Solana payout `failed` with detail `skipped: no operator signed within 1 h; an operator may re-sign it`. | keeper (it is an operator, unchanged), dashboard texts for guests |
| Solana keeper re-sign cap | error `keeper re-sign limit reached for this solana payout (3 per keeper)` | keeper `resign.ts` / `keeperLoop.ts` |
| Non-keeper EVM re-sign above a keeper's fees | `max_fee_per_gas` exactly the chain's `non_keeper_max_fee_per_gas`, priority ≥ min(last, clamp); error `re-sign below a keeper's fee: max_fee_per_gas must be the non-keeper limit and the priority fee may not drop`. | dashboard heir re-sign button |
| `poke` / `claim` gas | attach ≥ 50 TGas (host gas 29.7 TGas on a maximal vault). | **dashboard `calls.ts` (`GAS.other` is 30 TGas)** |
| Sale raises timing | `owner_changed` event data adds `timing_raised` (bool), `heartbeat_interval_s`, `grace_missed`. | dashboard FundTransfer / Vault texts |
| New events | `keeper_proposed`, `keeper_proposal_cancelled`, `keeper_set` (now with `previous`), `admin_proposal`, `admin_proposal_cancelled`, `admin_proposal_executed`. | indexers, dashboard log |
| State layout | new `Contract` fields and a longer `SignTrack`: deploy to a new account (`NEW=1 make deploy`). | `scripts/deploy.sh` (refuse v3 code on a v2 account) |

## Changed existing tests

Each change records an intended behaviour change, not a weaker check.

- Every `Contract::new` call takes a fourth argument (`keeper_admin: None`); `get_vaults_for_owner` takes
  `(account_id, None, None)`.
- `nft_transfer_by_owner_while_alive_not_warning` (L-6): the sale raises the interval to 1 day, so the Warning check
  moves to `T0 + 86_400_000 + 1`.
- `c1_evm_resign_reuses_nonce_and_requires_fee_bump` (L-3): the track keeps the signed fee (1.5 gwei) while the re-sign is
  in flight.
- `r2_f1_heir_may_still_bump_signed_evm_payout` (L-3): the track stays at 1.5 gwei; the pending tx carries 1.65 gwei.
- `r2_f4_cap_signature_can_be_resigned_at_the_cap`: the heir half moved to `v3_h1_heir_replaces_keeper_cap_fee_at_clamp`
  (the rule changed: at the clamp, not at the cap); the keeper half stays.
- `r2_g1_keeper_may_resign_evm_at_any_fee_and_gas` (L-3): completes `on_foreign_resigned` before it reads the track.
- `step3_unbuildable_payout_fails_via_self_call`: `set_foreign_payouts` now refuses a Solana amount above u64, so the test
  writes that payout into storage directly to reach the step-3 self-call.
- `v2_c_keeper_rotates_itself_on_locked_contract`: the hand-over completes with `accept_keeper`.
- `v2_c_step3_open_to_anyone_after_an_hour` (M-1): uses an EVM payout; the Solana case is
  `v3_poc_stranger_cannot_sign_solana_after_the_hour`.
- `v2_callbacks_require_exactly_one_result`: `nft_resolve_transfer` with no result keeps the transfer; one failed result
  still reverts it.

## Not changed in the contract, and why

| Item | Why |
| --- | --- |
| **H-2** (deploy orphans the keeper, then locks) | Deploy workflow, not contract code. Fixed in operations: the keeper in `new` is the long-lived `dmw-keeper-<tag>.testnet`, run by the scheduled keeper workflow; with v3 a `keeper_admin` adds a recovery path. |
| **L-1** (lock check misses function-call keys) | `scripts/near-admin.mjs lock` and `testnet.yml` are owned by others. The contract side (`nft_resolve_transfer`) is hardened above; the lock check must refuse any key other than none (or a key with an explicit safe method list). |
| **H-1**, front-running the operator hour, burning EVM gas within the caps | A keeper is still trusted for liveness: it can sign first with bad but bounded parameters and burn up to the per-chain cap. v3 removes the fund-moving power (Solana cap, 1 payout), the heir lock-out and the "never removable" part. A durable nonce or a per-payout Solana address would remove even the 3 re-signs, but needs a new derivation scheme. |
| **I-2** (leftover foreign balances have no exit) | Documentation only; a sweep would be a new signing path after settlement. |
| **I-3** (in-flight AddKey across A→B→A) | Harmless: the key belongs to A, who owns the vault again. |
| **I-4**, **I-5** (CI supply chain, key from a repo secret) | CI and repository settings, outside the contract. |
| **I-6** (guardian griefing) | Known and accepted since v2; the owner can `unpause` or remove the guardian. |
| MPC sign deposit (1 yocto, hard-coded) | Matches the live signer. A signer that changes the deposit needs a code change; `propose_mpc_signer` covers only a migration to a compatible signer. |
| New MPC signer root key | A signer with a different root key derives different foreign addresses, so funds at the old addresses stay there. `propose_mpc_signer` is documented as a migration path for the same signer. |
| `foreign` callbacks (`on_foreign_signed`, `on_foreign_resigned`, `foreign_fail`) and `nft_resolve_transfer` still write the vault twice | They run on 30 TGas (`on_foreign_*`), 20 TGas (`foreign_fail`) and 15 TGas (`nft_resolve_transfer`, `GAS_NFT_RESOLVE`), above the ~6.5 TGas a double write of a maximal vault needs. |
| Owner index (`index_add`) is still a `Vec` per owner | Paging (L-5) bounds the view. The spam cost is the sender's (each Will NFT costs a vault); a `Vector`-backed index would change the state layout further for no security gain. |
