# Contract v2: security fixes (Nov 12 2026)

These fixes cover the Nov 12 security pass on `claude/pre-public-hardening` (commit 10eb479). This is the source of
contract v2.

**Status.** v2 is **not deployed**. The live contract `dmw-979268.testnet` still runs v1
(`contracts/release/dmw.wasm`). Its full-access key was deleted, so it cannot be upgraded. v2 also changes the
storage layout. Going live therefore means a new account: `NEW=1 make deploy`. `deploy.sh` refuses to put v2 code on
a v1 account.

**Tests.** Every row below has at least one regression test. `cargo test` now runs 134 contract tests: the 105 from
v1 plus 29 new ones.

**How the tests were checked.** The tests target behaviour that v1 lacks. Most of them would not even compile against
10eb479, because the interface changed. They were not run against the old wasm. Attacks B and D were reproduced on
the old code by the PoC from the security pass.

## Findings, fixes and tests

Function names below are the Rust ones. `lib.rs`, `foreign.rs`, `nft.rs` and `types.rs` are in `contracts/dmw/src/`.

| Finding | Fix | Tests (`contracts/dmw/src/tests.rs` unless noted) |
| --- | --- | --- |
| **B.** An overdue Will NFT could be sold. The seller then poked it and took an uncapped bounty. | `nft.rs internal_nft_transfer`: transfer only while the vault is Alive by the clock (`state_at == Alive`: not overdue, not paused, not triggered). `lib.rs move_owner` resets the vault for the buyer: `last_beat = now`; heirs become the buyer alone (100%); foreign payouts, DAO, guardian, pause, agent spends and vault keeper cleared; policy and bounty back to defaults; pulse/agent keys revoked (unspent allowance refunded). The bounty is capped at 1 NEAR (`validate_bounty`). The `poke` payout is `min(bounty, 1 NEAR, 10% of balance)` (`bounty_payout`). New owner-only `set_bounty`, Alive only. | `v2_b_overdue_vault_cannot_be_sold_then_poked`, `v2_b_sale_resets_vault_for_buyer`, `v2_b_bounty_is_capped_and_only_set_while_alive` |
| **C.** On a locked contract the keeper could not be replaced, and anyone could run step 3 with a junk blockhash. | `set_keeper`: the current keeper may hand the role over. That works after lock, when `owner_id` is the contract itself. On a locked contract the role cannot be cleared. A separate contract owner may still set it. `new` takes `keeper_id`. Per-vault keeper: `set_vault_keeper` (owner, live, 1 yocto). Operators are the contract keeper, the vault keeper, the vault owner and any heir (`is_operator`). Only operators may sign a step-3 payout during its first hour (`STEP3_OPEN_AFTER_MS`); after that anyone may, so settlement never stalls. A bad blockhash is recoverable by `resign_foreign` (row E). | `v2_c_keeper_rotates_itself_on_locked_contract`, `v2_c_step3_params_operator_only_for_first_hour`, `v2_c_step3_open_to_anyone_after_an_hour`, `v2_c_vault_keeper_is_an_operator` |
| **D.** Anyone could deposit 1 yocto and flood the 40-entry log. | `deposit`: anyone but the owner must send at least 0.01 NEAR (`MIN_DEPOSIT`). The log is now two rings (`types.rs Vault.log` / `history`, `record`). Routine events (heartbeats, deposits, agent spends, key changes) cannot evict key events (creation, configuration, trigger, steps, payouts, claims, owner changes). `vault_created` is pinned. The view merges both rings by `seq`. | `v2_d_dust_deposits_rejected_and_history_survives_spam`, `v2_d_history_ring_keeps_vault_created` |
| **E.** The EVM re-sign fee ratchet had no rate limit, and `mark_broadcast` had no auth. | `foreign.rs resign_foreign` and `lib.rs mark_broadcast` are operator-only. Every re-sign waits 5 min after the last request (`RESIGN_COOLDOWN_MS`). A signed EVM payout needs both fees at least 110% of the last request, within the per-chain cap (saturating math). An idempotent re-report of the same hash is accepted before the auth check. | `v2_e_resign_and_mark_broadcast_need_operator_and_cooldown`; updated: `c1_*`, `h1_*` |
| **F.** The owner's heartbeat needed no yocto, so a wallet's function-call key could beat silently. Any beat cleared a guardian pause. | `heartbeat` is `#[payable]`. The owner path calls `assert_one_yocto`. The pulse-key path stays deposit-free (function-call keys cannot attach a deposit). A pulse-key beat cannot end a running pause; only the owner's (1 yocto) can. A pulse-key beat still clears a pause that has run out, which re-arms the guardian. | `v2_f_owner_heartbeat_needs_one_yocto`, `v2_f_pulse_beat_cannot_end_running_pause` |
| **G.** `new` was only `#[init]`, and deploy and init were separate transactions. | `new` is `#[init] #[private]`. `scripts/near-admin.mjs deploy` sends DeployContract + `new` as one transaction. | `v2_g_init_is_private_and_deploy_is_batched` |
| **L-4.** The owner had no way to end a guardian pause. | `unpause` (owner, 1 yocto, `not_paused` otherwise). It sets `paused_until_ms = now`, so the pause reads as used. It does **not** re-arm the guardian; only the next heartbeat does. | `v2_l4_owner_unpause` |
| **L-8.** The MPC signer was hard-coded. | `new(.., mpc_signer: Option<AccountId>)`, defaulting to `v1.signer-prod.testnet`, shown in `get_config`. Used by every `sign` / `derived_public_key` call. The payload format is unchanged. | `v2_l8_mpc_signer_is_configurable` |
| **L-9.** The storage fee was a fixed guess. | `charge_storage` measures each call's `storage_usage` delta per vault. It tops up `storage_deposit` from the vault balance when the vault grows: strictly (panics) for owner changes, leniently for callbacks and keeper steps. Step 5 releases the excess above the measured bytes + 2,000 bytes of headroom back to the balance (`release_storage`). The view shows `storage_bytes` and `storage_deposit`. | `v2_l9_storage_is_measured_topped_up_and_released`; updated: `step4_failed_dao_call_never_recredits_the_bond` |
| **Callbacks** credited funds with no promise result. | Every callback requires `promise_results_count() == 1` and treats anything else as a failure: `on_key_added`, `on_transfer_done`, `on_dao_proposal`, `nft_resolve_transfer`, `on_foreign_signed` / `on_foreign_resigned` / `on_foreign_evm_key` (`single_result`). The C-2 rule stands: the DAO bond is never credited back. | `v2_callbacks_require_exactly_one_result`, `v2_callbacks_dao_needs_one_result`, `v2_callbacks_foreign_signed_needs_one_result` |
| **remove_key** kept the unspent allowance. | A key registry (`key_index`) tracks each key's vault and an over-estimate of the gas it burned: (prepaid + 5 TGas) at the minimum gas price, per key-signed call. `remove_key` (and revocation on sale or settlement) credits `1 NEAR − estimate − 0.01 NEAR` back to the vault. | `v2_remove_key_refunds_unspent_allowance` |
| **Agent daily cap** was a fixed day bucket, so the cap could be spent twice around the reset. | A rolling 24 h window over `spends` (at most 24 entries). When the list is full, the two oldest merge under the newer time, so the window can only over-count. A failed transfer refunds the newest spends first. The view shows `daily_spent` (rolling), `daily_window_start_ms` (oldest counted spend) and `spends`. | `v2_agent_daily_cap_is_a_rolling_window`, `v2_agent_spends_are_bounded_and_conservative`; updated: `agent_pay_daily_window_resets` and others |
| **ecrecover.** An EVM signature was stored without checking whose it was. | Step 3 and re-sign for EVM first ask the signer for `derived_public_key(path, domain 0)` (`on_foreign_evm_key`), then sign. `assemble_signed` recovers the signature with the `ecrecover` host function (`chainsig::ecrecover64`; high-s / malleable signatures are rejected). The result must equal that key, otherwise the payout fails with "evm signature is not from the derived address". `from_address` is overwritten with the true derived address at signing. If the key lookup fails, the payout fails. | `v2_evm_signature_must_match_derived_address`, `v2_evm_key_lookup_failure_fails_payout`; `foreign.rs`: `ecrecover_matches_viem_address`, `evm_signature_must_recover_to_derived_key` |
| **Predictable derivation paths** (`base-<id>`). | Per-vault salt: 8 bytes of `sha256(random_seed ‖ creator ‖ id)`, drawn at `create_vault`. Paths are `base-<id>-<salt>`, `monad-<id>-<salt>`, `sol-<id>-<salt>`, published in the view as `derivation_paths`. Clients read them from the view and fall back to `<prefix>-<id>` only for a v1 view. The salt makes the address unknowable before creation; it is not a secret afterwards. | `v2_derivation_paths_are_salted_and_exposed`, `v2_solana_key_lookup_uses_salted_path`; updated: `step3_monad_signs_with_monad_path_chain_id_and_own_nonce`, `config_lists_chain_registry` |
| **validate_heirs** | v1 already refused the contract, duplicates, zero shares and wrong sums. The new test covers the remaining cases on both `create_vault` and `set_heirs`. The dashboard warns, without blocking, when an heir account does not exist (RPC `view_account`, `dashboard/src/lib/accounts.ts`), on Create and on the vault page. | `v2_validate_heirs_rejects_duplicates_and_zero_shares` (plus v1 `l10_contract_cannot_be_heir_or_nft_receiver`); `dashboard/src/lib/accounts.test.ts` |
| **Vault.tsx:68** showed the owner-typed `from_address`. | The vault page, pulse strip and step-3 nonce lookup use `sourceAddressFor(v, chain)`: the address derived from the view's paths. The keeper does the same (`keeperLoop.ts evmSourceAddress`). | `dashboard/src/lib/derive.test.ts` "source address shown and used for a payout"; keeper "v2: a well-formed but wrong owner-typed from_address is ignored" |

**wee_alloc: not added, on purpose.** It is unmaintained and has known memory leaks. The default allocator is fine at
this wasm size (612 KB unoptimised; no `wasm-opt` on the build machine). No new dependencies were added.

## Interface changes and the callers updated

| Change | Callers |
| --- | --- |
| `new(owner_id, keeper_id?, mpc_signer?)`, private, batched with the deploy | `scripts/near-admin.mjs deploy`, `scripts/deploy.sh` (keeper in `new`, optional `DMW_MPC_SIGNER`), `scripts/lib.sh register_keeper` (hand-over rule) |
| Owner `heartbeat` needs 1 yocto | `keeper/src/backend.ts` (1 yocto unless the signer is the contract), `dashboard` `ownerHeartbeatCall` (only when the view is v2), mock, `contracts/smoke.sh` |
| `derivation_paths`, `spends`, `keeper_id`, `storage_*` and `LogEntry.seq` in `VaultView` | keeper/agent/dashboard types; keeper `derive`, `deriveAddresses(contract, paths)`; dashboard `deriveFor(paths)`, `deriveForVault`, `vaultPaths`; `site/js/graph.js` |
| Rolling agent window | `agent/src/wallet.ts spentInWindow`, `sim.ts`, `attack-suite.ts`; keeper and dashboard mocks |
| New: `set_bounty`, `unpause`, `set_vault_keeper` | dashboard builders, plus an Unpause button in GuardianPanel |
| `resign_foreign` / `mark_broadcast` operator-only, step 3 operator-only for 1 h | keeper is an operator; dashboard shows the relay only to operators |
| NFT transfer only while Alive, with a reset | dashboard FundTransfer |
| Non-owner deposits ≥ 0.01 NEAR | dashboard FundTransfer |
| `attack-c2.sh` pass rule | allows the step-5 storage release |

## Existing tests whose intended behaviour changed

- `heartbeat_by_owner_resets_clock`, `heartbeat_rejected_once_triggered`, `m6_heartbeat_and_claim_need_no_deposit`: the owner now attaches 1 yocto.
- `nft_transfer_by_owner_while_alive_and_warning` is now `..._alive_not_warning`. `nft_transfer_clears_guardian_but_keeps_running_pause` is now `nft_transfer_rejected_while_paused_and_clears_guardian`.
- `second_pause_rejected_until_heartbeat`, `paused_vault_reads_warning_and_denies_agent_pay`: pause rules (F).
- `agent_pay_allowed`, `failed_agent_transfer_is_recredited`, `agent_pay_daily_window_resets`: rolling window.
- `log_is_bounded`, `step_ordering_1_to_6_with_stub`: two log rings.
- `step4_failed_dao_call_never_recredits_the_bond`: the step-5 storage release is added (the bond is still not credited).
- `resign_after_failure_stores_new_tx_without_moving_steps`, `c1_evm_resign_reuses_nonce_and_requires_fee_bump`, `c1_solana_signed_resign_only_by_operator_after_cooldown`, `c1_solana_failed_resign_waits_for_cooldown_then_anyone` (now `..._then_operator`), `c1_inflight_resign_blocks_second_and_stale_callback_ignored`, `h1_mark_broadcast_rejects_fake_hash_and_resign_still_possible`, `h1_evm_broadcast_resign_needs_cooldown_and_clears_hash`, `h5_resign_and_monad_use_the_gas_floor`, `monad_fee_cap_is_per_chain`, `step3_monad_signs_with_monad_path_chain_id_and_own_nonce`, `config_lists_chain_registry`: operator rule, cooldown, EVM key hop, salted paths.
- Other clients:
  - keeper "derives the monad address": it now expects the derived address.
  - dashboard calls.test "1 yocto exactly where lib.rs asserts it": `heartbeat` is now payable.
  - agent "resets the daily window" is now the v1-view case, with a new v2 rolling-window test.

## Behaviour changes users will see

- **Owner heartbeat.** The wallet asks the owner to confirm **1 yoctoNEAR** for each heartbeat from the dashboard. Pulse-key beats (phone, CLI) are unchanged.
- **Source addresses.** Foreign source addresses exist only after `create_vault` and are shown on the vault page. They are not predicted on the create form.
- **Will NFT transfer.** Only while Alive. The buyer receives a reset vault (they are the only heir until they set new ones).
- **Keeper actions.**
  - `resign_foreign` and `mark_broadcast` are for operators only.
  - For the first hour of each foreign payout, only operators may sign it.
  - A re-sign waits 5 minutes.
- **Deposits.** Deposits from anyone but the owner must be at least 0.01 NEAR.
- **Bounty.** At most 1 NEAR, and at most 10% of the balance. `set_bounty` changes it.
- **Storage.** Charged from the vault balance as measured, and released at settlement, so a claim may pay slightly more than the step-4 balance.
- **Owner unpause.** The owner can end a guardian pause with `unpause`.
- **Deploy.** `new` needs the keeper, and deploy and init are one transaction.

## Known residual issues

- A late MPC signature for a timed-out step-3 request (over 10 minutes) is still visible in the signer's receipt. The contract ignores it, and the EVM nonce stays pinned per payout, so at most one transaction per payout can land. This is unchanged from v1.
- The key refund is an estimate at the minimum gas price, with prepaid gas counted in full. If the network gas price rose far above the minimum (more than about 3x for a 10 TGas heartbeat), a refund could exceed what the key actually burned. The 0.01 NEAR margin covers small differences.
- The derivation salt comes from the block's random seed, which the block producer knows. It stops anyone from predicting an address before the vault exists. It does not hide the address afterwards.
- The dashboard derives addresses with the default signer's root keys. A v2 deploy with another `mpc_signer` needs that changed in `dashboard/src/lib/derive.ts`. The keeper takes it from `MPC_SIGNER`; `deploy.sh` passes `DMW_MPC_SIGNER` to `new`.
