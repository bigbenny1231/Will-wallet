# Contract v2: security fixes (Nov 12 2026)

These fixes cover the Nov 12 security pass on `claude/pre-public-hardening` (commit 10eb479). This is the source of
contract v2.

**Status.** v2 is **not deployed**. The live contract `dmw-979268.testnet` still runs v1
(`contracts/release/dmw.wasm`). Its full-access key was deleted, so it cannot be upgraded. v2 also changes the
storage layout. Going live therefore means a new account: `NEW=1 make deploy`. `deploy.sh` refuses to put v2 code on
a v1 account.

**Tests.** Every row below has at least one regression test. After the first pass `cargo test` ran 134 contract tests:
the 105 from v1 plus 29 new ones. The second review (below) brings it to 148: the reviewer's 4 tests in `audit_v2.rs`
and 1 in `audit_v2b.rs`, and 9 more in `tests.rs`.

**How the tests were checked.** The tests target behaviour that v1 lacks. Most of them would not even compile against
10eb479, because the interface changed. They were not run against the old wasm. Attacks B and D were reproduced on
the old code by the PoC from the security pass.

## Findings, fixes and tests

Function names below are the Rust ones. `lib.rs`, `foreign.rs`, `nft.rs` and `types.rs` are in `contracts/dmw/src/`.

| Finding | Fix | Tests (`contracts/dmw/src/tests.rs` unless noted) |
| --- | --- | --- |
| **B.** An overdue Will NFT could be sold. The seller then poked it and took an uncapped bounty. | `nft.rs internal_nft_transfer`: transfer only while the vault is Alive by the clock (`state_at == Alive`: not overdue, not paused, not triggered). `lib.rs move_owner` resets the vault for the buyer: `last_beat = now`; heirs become the buyer alone (100%); foreign payouts, DAO, guardian, pause, agent spends and vault keeper cleared; policy and bounty back to defaults; pulse/agent keys revoked (first pass: unspent allowance refunded; the second review dropped that refund, F2). The bounty is capped at 1 NEAR (`validate_bounty`). The `poke` payout is `min(bounty, 1 NEAR, 10% of balance)` (`bounty_payout`). New owner-only `set_bounty`, Alive only. | `v2_b_overdue_vault_cannot_be_sold_then_poked`, `v2_b_sale_resets_vault_for_buyer`, `v2_b_bounty_is_capped_and_only_set_while_alive` |
| **C.** On a locked contract the keeper could not be replaced, and anyone could run step 3 with a junk blockhash. | `set_keeper`: the current keeper may hand the role over. That works after lock, when `owner_id` is the contract itself. On a locked contract the role cannot be cleared. A separate contract owner may still set it. `new` takes `keeper_id`. Per-vault keeper: `set_vault_keeper` (owner, live, 1 yocto). Operators are the contract keeper, the vault keeper, the vault owner and any heir (`is_operator`). Only operators may sign a step-3 payout during its first hour (`STEP3_OPEN_AFTER_MS`); after that anyone may, so settlement never stalls. A bad blockhash is recoverable by `resign_foreign` (row E). | `v2_c_keeper_rotates_itself_on_locked_contract`, `v2_c_step3_params_operator_only_for_first_hour`, `v2_c_step3_open_to_anyone_after_an_hour`, `v2_c_vault_keeper_is_an_operator` |
| **D.** Anyone could deposit 1 yocto and flood the 40-entry log. | `deposit`: anyone but the owner must send at least 0.01 NEAR (`MIN_DEPOSIT`). The log is now two rings (`types.rs Vault.log` / `history`, `record`). Routine events (heartbeats, deposits, agent spends, key changes) cannot evict key events (creation, configuration, trigger, steps, payouts, claims, owner changes). `vault_created` is pinned. The view merges both rings by `seq`. | `v2_d_dust_deposits_rejected_and_history_survives_spam`, `v2_d_history_ring_keeps_vault_created` |
| **E.** The EVM re-sign fee ratchet had no rate limit, and `mark_broadcast` had no auth. | `foreign.rs resign_foreign` and `lib.rs mark_broadcast` are operator-only. Every re-sign waits 5 min after the last request (`RESIGN_COOLDOWN_MS`). A signed EVM payout needs both fees at least 110% of the last request, within the per-chain cap (saturating math). An idempotent re-report of the same hash is accepted before the auth check. **Correction (second review):** this was a restriction for strangers and for EVM, but not for Solana. v1 let only the contract owner and the keeper re-sign a `signed`/`broadcast` Solana payout; the first pass widened that to every operator (heirs, vault owner, vault keeper). Since Solana has no nonce, that let any heir create a second payment every 5 minutes. The second review restores the keeper-only rule (F1). | `v2_e_resign_and_mark_broadcast_need_operator_and_cooldown`; updated: `c1_*`, `h1_*` |
| **F.** The owner's heartbeat needed no yocto, so a wallet's function-call key could beat silently. Any beat cleared a guardian pause. | `heartbeat` is `#[payable]`. The owner path calls `assert_one_yocto`. The pulse-key path stays deposit-free (function-call keys cannot attach a deposit). A pulse-key beat cannot end a running pause; only the owner's (1 yocto) can. A pulse-key beat still clears a pause that has run out, which re-arms the guardian. | `v2_f_owner_heartbeat_needs_one_yocto`, `v2_f_pulse_beat_cannot_end_running_pause` |
| **G.** `new` was only `#[init]`, and deploy and init were separate transactions. | `new` is `#[init] #[private]`. `scripts/near-admin.mjs deploy` sends DeployContract + `new` as one transaction. | `v2_g_init_is_private_and_deploy_is_batched` |
| **L-4.** The owner had no way to end a guardian pause. | `unpause` (owner, 1 yocto, `not_paused` otherwise). It sets `paused_until_ms = now`, so the pause reads as used. It does **not** re-arm the guardian; only the next heartbeat does. | `v2_l4_owner_unpause` |
| **L-8.** The MPC signer was hard-coded. | `new(.., mpc_signer: Option<AccountId>)`, defaulting to `v1.signer-prod.testnet`, shown in `get_config`. Used by every `sign` / `derived_public_key` call. The payload format is unchanged. | `v2_l8_mpc_signer_is_configurable` |
| **L-9.** The storage fee was a fixed guess. | `charge_storage` measures each call's `storage_usage` delta per vault. It tops up `storage_deposit` from the vault balance when the vault grows: strictly (panics) for owner changes, leniently for callbacks and keeper steps. Step 5 releases the excess above the measured bytes + 2,000 bytes of headroom back to the balance (`release_storage`). The view shows `storage_bytes` and `storage_deposit`. | `v2_l9_storage_is_measured_topped_up_and_released`; updated: `step4_failed_dao_call_never_recredits_the_bond` |
| **Callbacks** credited funds with no promise result. | Every callback requires `promise_results_count() == 1` and treats anything else as a failure: `on_key_added`, `on_transfer_done`, `on_dao_proposal`, `nft_resolve_transfer`, `on_foreign_signed` / `on_foreign_resigned` / `on_foreign_evm_key` (`single_result`). The C-2 rule stands: the DAO bond is never credited back. | `v2_callbacks_require_exactly_one_result`, `v2_callbacks_dao_needs_one_result`, `v2_callbacks_foreign_signed_needs_one_result` |
| **remove_key** kept the unspent allowance. | **Withdrawn in the second review (F2).** The first pass tracked an estimate of each key's burn and credited `1 NEAR − estimate − 0.01 NEAR` back to the vault. Key calls that panic burn allowance gas but their accounting is reverted, so the refund paid vaults out of other vaults' NEAR. Now, as in v1, the allowance is the cost of the key and is never refunded; `key_index` only maps a key to its vault (`KeyRecord { token_id }`). | `v2_remove_key_does_not_refund_allowance`, `audit_v2.rs audit_key_refund_ignores_reverted_key_calls` |
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
| `attack-c2.sh` pass rule | allows the step-5 storage release (since the second review step 5 pays it to the heirs, so `b5 == b4`) |
| Second review: `set_keeper` needs 1 yocto | `scripts/lib.sh register_keeper` attaches `1y` when `get_config` is v2 (has `step3_open_after_ms`); dashboard calls.test checks it |
| Second review: re-sign at the cap counts as a bump | `keeper/src/resign.ts bumpedEvmArgs` holds a bump at the cap instead of giving up; `keeperLoop.ts`, keeper mock |
| Second review: unpause restarts the clock; no key refund | dashboard mock, GuardianPanel and KeysPanel / Create texts |

## Existing tests whose intended behaviour changed

- `heartbeat_by_owner_resets_clock`, `heartbeat_rejected_once_triggered`, `m6_heartbeat_and_claim_need_no_deposit`: the owner now attaches 1 yocto.
- `nft_transfer_by_owner_while_alive_and_warning` is now `..._alive_not_warning`. `nft_transfer_clears_guardian_but_keeps_running_pause` is now `nft_transfer_rejected_while_paused_and_clears_guardian`.
- `second_pause_rejected_until_heartbeat`, `paused_vault_reads_warning_and_denies_agent_pay`: pause rules (F).
- `agent_pay_allowed`, `failed_agent_transfer_is_recredited`, `agent_pay_daily_window_resets`: rolling window.
- `log_is_bounded`, `step_ordering_1_to_6_with_stub`: two log rings.
- `step4_failed_dao_call_never_recredits_the_bond`: the step-5 storage release is added (the bond is still not credited). Second review: the release goes to the heirs by bps, so the claim is exactly the step-4 balance.
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
- **Storage.** Charged from the vault balance as measured, and released at settlement. Since the second review the release is paid to the heirs by bps at step 5.
- **Owner unpause.** The owner can end a guardian pause with `unpause`. Since the second review it also restarts the heartbeat clock.
- **Deploy.** `new` needs the keeper, and deploy and init are one transaction.

## Known residual issues

- A late MPC signature for a timed-out step-3 request (over 10 minutes) is still visible in the signer's receipt. The contract ignores it, and the EVM nonce stays pinned per payout, so at most one transaction per payout can land. This is unchanged from v1.
- The derivation salt comes from the block's random seed, which the block producer knows. It stops anyone from predicting an address before the vault exists. It does not hide the address afterwards.
- The dashboard derives addresses with the default signer's root keys. A v2 deploy with another `mpc_signer` needs that changed in `dashboard/src/lib/derive.ts`. The keeper takes it from `MPC_SIGNER`; `deploy.sh` passes `DMW_MPC_SIGNER` to `new`.

## Second review (Nov 12 2026)

An independent adversarial review of `claude/contract-v2` found four issues and two info items. Its tests are kept as
regression tests in `contracts/dmw/src/audit_v2.rs` (`cargo test --locked audit_`); all four failed before the fixes
and pass now. `cargo fmt` reflowed that file; no test logic changed.

| Finding | Fix | Tests |
| --- | --- | --- |
| **F1 (high).** Any operator (every heir, the vault owner, the vault keeper) could re-sign a Solana payout that was already `signed` or `broadcast`. Solana has no nonce, so each new blockhash gave a second valid payment from the shared `sol-<id>-<salt>` address, every 5 minutes. | `foreign.rs resign_foreign`: a `signed`/`broadcast` Solana payout may only be re-signed by a keeper, `lib.rs is_keeper` (the contract owner while it is not the contract itself, the contract keeper, the vault keeper). Heirs and the vault owner may re-sign a `failed` Solana payout. EVM is unchanged: the nonce is pinned per payout, so a re-sign only replaces the transaction, and at most one can land. `mark_broadcast` was checked for the same class: it only labels a `signed` payout whose hash matches, and since both `signed` and `broadcast` are keeper-only for a Solana re-sign, it opens nothing. A failed re-sign never flips a payout to `failed`. | `audit_heir_can_resign_broadcast_solana_payout`, `r2_f1_signed_solana_resign_is_keeper_only`, `r2_f1_vault_keeper_may_resign_signed_solana`, `r2_f1_heir_may_still_bump_signed_evm_payout`; `h1_mark_broadcast_rejects_fake_hash_and_resign_still_possible` |
| **F2 (medium).** The key-allowance refund only counted key calls that succeeded. Panicked calls and padded arguments burn allowance gas from the contract balance without being counted, so `remove_key`, step 2 and a sale refunded about 0.99 NEAR of other vaults' money per cycle. | The refund is gone (v1 behaviour): `lib.rs release_key` only drops the key from `key_index` and its access-key bytes from `storage_bytes`. `note_key_gas`, `KeyRecord.spent`, `KEY_CALL_OVERHEAD_GAS` and `KEY_REFUND_MARGIN` are removed; `take_keys`, `move_owner`, step 2 and `remove_key` credit nothing, and their events no longer carry `allowance_refund` (the `key_add_failed` / `key_add_revoked` events now do: 1 NEAR or 0). The same applies to `on_key_added`'s revoke paths (final audit L-11 and L-12: a key that lands after a trigger or a sale, or over the cap of 5): the key existed until its delete landed, and an owner can time that window and burn the allowance with failing calls, so those paths no longer refund either. Only a failed AddKey (no key ever existed) still returns the allowance. | `audit_key_refund_ignores_reverted_key_calls`, `v2_remove_key_does_not_refund_allowance`, `v2_b_sale_resets_vault_for_buyer`; updated: `l11_revoked_key_add_keeps_allowance_once_the_key_existed` (was `l11_revoked_key_add_refunds_allowance`), `l12_key_cap_enforced_when_add_lands` |
| **F3 (low).** Credits that landed after step 1's bps split (the step-5 storage release, key refunds, late refunds and deposits) went 100% to the primary heir through `claim`. | Key refunds no longer exist (F2). A new `Vault.unsplit` counts deposits and refunded agent spends or bounties that land while Triggered after step 1 (`lib.rs credit`, used by `deposit` and `on_transfer_done`). Step 5 pays the released storage deposit plus `unsplit` to the heirs by bps (`heir_shares`, shared with step 1), with the usual failed-transfer callback. The NFT owner still claims the unspent reserve, a failed heir transfer (the heir cannot receive it) and anything credited after settlement. | `audit_post_step1_credits_skip_the_heir_split`, `r2_f3_post_step1_credits_split_by_bps`, `step4_failed_dao_call_never_recredits_the_bond` |
| **F4 (low).** After the 1-hour window a stranger (or any heir) could sign an EVM payout at the fee cap with a 100k gas limit. A re-sign needed 110% of the cap, so nobody could ever re-sign it. | `foreign.rs is_fee_bump`: a fee at the chain cap counts as a valid bump, so a cap signature can be replaced (for example with a lower gas limit). `limit_non_keeper_evm_args`: in step 3 and in `resign_foreign`, a non-keeper's `max_fee_per_gas` is clamped to 50% of the cap, its priority fee to 10% of the cap, and its gas limit to the chain floor (50 000). Clamped, not rejected, so settlement never stalls on it. Honest fees are far below (Base about 0.001 gwei of 100; Monad about 202 gwei of 1000). **Tightened by G1 below:** the clamp is now per chain (Base 10 gwei, Monad 200 gwei) and a keeper is no longer bound by the bump rule. | `audit_stranger_cap_fee_signature_blocks_every_resign`, `r2_f4_non_keeper_step3_fees_are_clamped`, `r2_f4_cap_signature_can_be_resigned_at_the_cap` |
| **Info.** `set_keeper` took no deposit, so a function-call key of the keeper account could hand the global role over. | `set_keeper` is `#[payable]` and calls `assert_one_yocto`. | `r2_set_keeper_needs_one_yocto`, `v2_c_keeper_rotates_itself_on_locked_contract`, `set_keeper_is_owner_only` |
| **Info.** An owner `unpause` (1 yocto, a signed owner call) did not count as proof of life, so it could make the vault due at once. | `unpause` also sets `last_beat_ms = now`. SPEC had no rule against it. The guardian is still not re-armed until the next heartbeat. | `r2_unpause_restarts_the_heartbeat_clock`, `v2_l4_owner_unpause` |

**G1 (low), found on the reviewer's second pass.** F4 was only partly closed. The re-sign fee ratchet still only went
up. An heir (inside the operator window, racing the keeper right after step 2) or anyone (after the hour) could sign
first at the clamped 50% of the cap: 50 gwei max fee and 10 gwei priority on Base with the 50 000 gas floor, so a node
demands value + 0.0025 ETH (Monad: value + 0.025 MON against an honest buffer of about 0.01 MON). The keeper could
then only re-sign at 110% of that or at the cap, never at an honest fee, so the payout could not be mined unless
someone topped up the derived address.

| Fix | Tests |
| --- | --- |
| `foreign.rs resign_foreign`: a keeper (`is_keeper`) may re-sign a `signed`/`broadcast` EVM payout at any fee and gas limit within the caps. The nonce is pinned per payout, so the new tx can only replace the old one, never pay twice. The 110% (or at-the-cap) bump rule now applies only to non-keepers. `limit_non_keeper_evm_args` clamps a non-keeper's max fee, and its priority fee (never above the max fee), to the new per-chain `EvmChain::non_keeper_max_fee_per_gas` (published in `get_config().chains[]`): **Base 10 gwei** (10% of the cap; 50 000 gas x 10 gwei = 0.0005 ETH above the value) and **Monad 200 gwei** (20% of the cap). On Monad, 10% would be 100 gwei, exactly Monad's base-fee floor, with no headroom at all. 200 gwei x the 50 000 gas floor = 0.01 MON, the honest buffer: an honest keeper signs 2 x base fee + priority, about 202 gwei. The keeper backend (`keeperLoop.ts handleStale`, `NearBackend.isKeeperFor`) now re-signs at the fresh honest fees when it is the contract or vault keeper, and bumps only otherwise. | `audit_v2b.rs audit2_heir_preempts_keeper_and_keeper_cannot_lower_fees`, `r2_g1_keeper_may_resign_evm_at_any_fee_and_gas`, `r2_f4_non_keeper_step3_fees_are_clamped`; updated: `c1_evm_resign_reuses_nonce_and_requires_fee_bump` (the same-fee refusal is now shown for an heir); keeper "EVM re-sign as the keeper sends the fresh honest fees" and "... as a non-keeper operator ... 1.1 x last" |

One line of `audit_v2b.rs` was changed: it asserted the old 50% clamp (`cap / 2`) for the heir's signature, and now
asserts the new 10% (`cap / 10`). The finding's assertion (the keeper's honest re-sign is accepted) is unchanged.

**Non-keeper gas limit (info, with G1).** A non-keeper still signs with the chain's 50 000 gas floor. That covers a plain
transfer to an EOA and to the usual contract recipients: a Safe or smart-wallet `receive` takes about 26-30k gas, a
WETH-like deposit about 45k (final audit H-5). A higher non-keeper limit was not chosen. Monad bills the full gas limit,
so 100 000 gas would double the balance a node demands, above the honest buffer. On Base, 100 000 gas at 10 gwei would
need 0.001 ETH on top of the value, where honest fees need almost nothing. **Residual:** if a recipient needs more than
50 000 gas, a non-keeper's signature that gets relayed reverts on chain, burns the payout's pinned nonce and strands its
funds in the source address. Since G1, a keeper can re-sign with a higher gas limit at any time before something is
mined. The dashboard now warns, on Create and on the vault page, when an EVM payout recipient has code (`eth_getCode`,
`dashboard/src/lib/chains.ts contractRecipients`, tested in `accounts.test.ts`).

**Documented, not changed.**

- **A vault keeper can re-sign a Solana payout.** The vault keeper is chosen by the vault owner (`set_vault_keeper`)
  and counts as a keeper, so it can re-sign a `signed` or `broadcast` Solana payout. Each re-sign is a potential second
  payment, as in v1 for the contract keeper. Owners should name only a vault keeper they trust as much as the
  contract keeper, and the keeper must check that the old signature never landed before re-signing.

- **Foreign balances go with the vault on a sale.** A Will NFT sale resets the vault for the buyer but keeps its salt,
  so `base-`, `monad-` and `sol-<id>-<salt>` stay the same addresses. Whatever the seller left there now funds the
  buyer's payouts. Re-salting would strand those funds, so the seller should empty them before selling.
- **Solana signatures are cluster-agnostic.** A Solana signature does not commit to a cluster, and the derived address is
  the same on devnet, testnet and mainnet. A transfer signed over a blockhash from another cluster is valid there. A
  testnet vault must never hold mainnet SOL at its `sol-` address.

**Residual issues after the second review.**

- Solana liveness depends on a keeper. If a non-keeper signs a Solana payout with a bad blockhash once step 3 is open,
  only a keeper can re-sign it. The contract keeper can be rotated on a locked contract, and the owner can name a
  vault keeper while the vault is Live.
- An heir may re-sign a `failed` Solana payout. A payout marked `failed` because its step-3 request timed out could, in
  theory, have a signature in the signer's receipt if the contract's callback itself failed, and that signature could
  have been relayed while its blockhash was valid. Before re-signing a failed Solana payout, check the source address's
  history for a transfer to the payout's recipient.
- A keeper can still re-sign a `signed`/`broadcast` Solana payout (needed when a blockhash expired before relay). It
  must first check that the old signature never landed, as in v1.

**Behaviour changes users will see (second review).**

- Removing a key, selling the Will NFT and settlement no longer return any of the 1 NEAR key allowance.
- At step 5, each heir receives their bps share of the released storage deposit and of anything credited after step 1.
- Only the keeper relays a fresh Solana signature for a payout that already has one.
- The keeper can re-sign an EVM payout at an honest fee even after an heir or a stranger signed it at a higher one;
  an heir's or a stranger's EVM fees are clamped to 10 gwei on Base and 200 gwei on Monad.
- The dashboard warns when an EVM payout recipient is a contract.
- `set_keeper` needs a wallet confirmation (1 yoctoNEAR).
- `unpause` also counts as a heartbeat.
