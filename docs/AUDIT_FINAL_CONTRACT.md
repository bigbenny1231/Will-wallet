# Final pre-submission review: `contracts/dmw`

> The live contract (contract v2, `docs/LIVE_CONTRACT.md`) has no full-access key, so its code cannot change; the code-only
> redeploy below was made on the earlier `dmw-x8cx.testnet`, which kept its deployer key.

Review of the Dead Man's Wallet vault contract (near-sdk 5.30, Rust), done 2026-11-07 on
`master` HEAD `d1d3637`. The reviewer had not seen the code before. Earlier reviews were read first
(docs/SECURITY_REVIEW.md, docs/SECURITY_REVIEW_2.md), then the **whole** final code was audited, not
just the diffs: `lib.rs`, `foreign.rs`, `nft.rs`, `types.rs` and `tests.rs`.

- **Result:** 0 Critical, 1 High, 0 new Medium, 7 Low, 8 Info. The High and three Lows are fixed,
  and each fix has a regression test. Two Mediums from earlier rounds stay open (M-4, M-5), and the
  live run below confirms M-4 with real numbers.
- **Tooling:** `cargo test`: **104 pass** (99 before). `cargo clippy --all-targets -- -D warnings`
  is clean, and so is `cargo fmt --check`. `contracts/dmw/build.sh` built with cargo-near:
  `target/near/dmw.wasm`, 461 245 bytes.
- **Deployed:** code-only redeploy of `dmw-x8cx.testnet`, with no re-init and no stored-layout
  change. Code hash `5H5vWiKFX1tF13ujkmozuke1DcdNExqeLTg8jAbRYdux`, tx
  [4Dgg8tyK…](https://testnet.nearblocks.io/txns/4Dgg8tyKC2byYWwBUCD1i8eEBbFixtWkX1X8S8UcbWuk).
  Vaults 6, 12 and 17 read correctly afterwards. Vault 6 was not called.
- **Live worst-case run:** vault 18 had 10 heirs (nine of them nonexistent 64-character accounts, so
  every refund path ran), 5 + 5 keys, 10 allowlist entries, 4 foreign payouts
  (Base, Monad, Solana, Base), a DAO, a guardian and a full 40-entry log. It was triggered and
  settled through all steps against the real MPC signer and a real Sputnik DAO. The measured gas is
  in §5.
- Regression tests are at the end of `src/tests.rs` (`h5_*`, `l10_*`, `l11_*`, `l12_*`).

## Severity table

| ID | Severity | Title | Status |
| --- | --- | --- | --- |
| H-5 | High | EVM payouts are signed with `gas_limit` 21 000. A transfer to any address that has code reverts out of gas but still uses the payout's pinned nonce, so the funds are stuck for good | **Fixed** (gas floor of 50 000) |
| L-10 | Low | The contract can be named as an heir or used as an `nft_transfer` receiver: the NEAR goes to the unallocated pool, or any pulse key can keep the vault alive | **Fixed** |
| L-11 | Low | A key whose AddKey lands after a trigger or an owner change is deleted, but its 1 NEAR allowance was not refunded to the vault | **Fixed** |
| L-12 | Low | The limit of 5 keys per kind can be exceeded with concurrent `add_*_key` requests | **Fixed** |
| L-13 | Low | `get_vaults_for_owner` has no pagination, and anyone can grow a victim's owner index | Documented |
| L-14 | Low | An overdue vault that nobody has poked can still be transferred, and anyone can poke it right after the transfer | Documented |
| L-15 | Low | Owner `heartbeat` takes no deposit, so a leaked dApp function-call key can keep a dead owner's vault alive | Documented (deliberate, M-6) |
| L-16 | Low | Two identical Solana payouts signed over the same blockhash produce one transaction | Documented |
| I-10..I-17 | Info | EVM signature checks, callback gas margins, NEP version strings, receiver gas, bounty/bond, `set_keeper`, reverting recipients, view gas | Notes |
| M-4 (r1) | Medium | Unused key allowances and DAO bonds go to the free pool, not back to the vault. Live: **10 NEAR** of vault 18's heir value went to the pool | Open (documented) |
| M-5 (r2) | Medium | Front-running with fees at the cap blocks EVM re-signs | Open (documented) |

---

## 1. High

### H-5: a 21 000-gas transfer to a recipient with code burns the pinned nonce

**Location:** `foreign.rs` `validate_evm_args`, the step-3 EVM branch of `request_foreign_signature`,
and the EVM branch of `resign_foreign`. Before the fix, the caller's `gas_limit` (21 000..100 000)
was signed as given. The keeper (`keeper/src/chains/evm.ts`) and the dashboard
(`dashboard/src/lib/chains.ts`) always send `"21000"`.

**Impact.** 21 000 is exactly the intrinsic cost of a value transfer, which leaves no gas to run any
code at the recipient. That covers a Safe, an ERC-4337 smart wallet such as Coinbase Smart Wallet,
an EIP-7702-delegated EOA (for example a MetaMask smart account), WETH and exchange deposit
contracts. In every one of these cases the transaction is **mined and reverts out of gas**. An
included transaction uses its nonce. Since round-1 C-1, payout `i` is pinned for life to nonce
(number of same-chain payouts before it). `resign_foreign` can only sign that same nonce again,
and it is already used. Only this contract can sign for `base-N` / `monad-N`. So the heir's ETH or
MON stays in the derived address **forever**. On top of that, step 3 is permissionless (round-1
M-2), so even a fixed keeper can be front-run by anyone sending `gas_limit: 21000`.

This is the same class as round-2 H-4 (a reverted transaction burns the pinned nonce) and round-1
H-1 (a public action bricks a foreign payout), so it is rated High. It is likely in practice:
smart wallets and 7702 accounts are common on Base, and nothing in `set_foreign_payouts` can tell
an EOA from a contract.

**Proof.**
1. Live, Base Sepolia: `eth_call {to: WETH 0x4200…0006, gas: 21000}` returns `out of gas: gas
   required exceeds: 21000`. The same call with 50 000 gas succeeds. `eth_estimateGas` gives 25 824
   gas for value 0 and 27 947 for value 1.
2. Call sequence (old code): vault N has a Base payout `#0 -> 0x4200…0006` (any contract wallet).
   The keeper runs `execute_step(N, {evm:{gas_limit:"21000",…}})`, the payout is signed at nonce 0,
   and the keeper relays it. The tx is mined, reverts out of gas, and the nonce of `base-N` becomes 1.
   `resign_foreign(N, 0, …)` signs nonce 0 again, which can never be mined. The value is lost.
3. Unit test (fails on the old code, where the signed tx carries `825208`):
   `h5_step3_raises_evm_gas_limit_to_floor`.

**Fix.** `EvmChain::min_gas_limit` was added, and set to `EVM_GAS_LIMIT_FLOOR` = 50 000 on Base and
Monad. The new helper `foreign::effective_evm_args` does three things:
- validates the caller's arguments with the unchanged rules (21 000..=100 000, the fee caps);
- **raises** `gas_limit` to the floor;
- pins the nonce.

Step 3 and `resign_foreign` both use it.

- Callers still send 21 000 and it is accepted, so the keeper and dashboard keep working without
  any change. A caller value above the floor is kept, up to the existing 100 000 cap.
- 50 000 covers a Safe or smart-wallet `receive` (about 26k to 30k) and a fresh WETH deposit
  (about 45k).
- **Cost.** Base bills gas *used*, so a transfer to an EOA still costs 21 000. Monad bills the gas
  *limit*, so an honest Monad payout at 202 gwei now costs about 0.0101 MON instead of 0.0042. The
  worst case per payout is unchanged (100 000 × cap, round-2 M-5).
- **Effect on funding.** An underfunded source address means the node rejects the tx. It is never
  included, so the nonce is safe, and the keeper already parks such a relay as `unfunded`. The
  0.05 MON that keeper/SHOWCASE.md tells people to put in `monad-6` still covers 0.01 MON + 0.0101 MON.
- `get_config().chains[*].min_gas_limit` shows the floor.

**Residual risk.** A recipient that reverts on *any* incoming value, or that needs more than
100 000 gas, still loses the payout (I-16). That is a wrong heir address, and the contract cannot
detect it.

**Live confirmation.** In vault 18, payout #0 to WETH was signed with `gas_limit` 50 000 even
though the caller sent 21 000. The stored raw tx is `0x02f86d83014a3480…82c350…`. The Monad payout
`0x02f86f82279f80…82c350…` shows the same.

**Tests:** `h5_step3_raises_evm_gas_limit_to_floor`, `h5_resign_and_monad_use_the_gas_floor`.

## 2. Low

### L-10: the contract as heir or as NFT receiver (fixed)

- **Contract as heir.** `validate_heirs` accepted the contract's own account. Its step-1 share
  would then be a transfer to itself, which lands in the unallocated pool. If the contract were also
  the primary heir, step 5 would make it the NFT owner, and `claim` could never run.
- **Contract as NFT receiver.** `nft_transfer(receiver = dmw contract)` was accepted. `heartbeat`
  accepts `predecessor == owner`, and every pulse key on the contract account signs with
  predecessor = contract. So **any** pulse-key holder could heartbeat that vault forever, and it
  would never settle. Anyone can get a pulse key for 0.1 + 1 NEAR.
- **Fix:** both cases are now rejected ("heir cannot be the dmw contract", "receiver cannot be the
  dmw contract"). Test: `l10_contract_cannot_be_heir_or_nft_receiver`.

### L-11: the revoked-key path kept the allowance (fixed)

`on_key_added` deletes a key at once when the vault was triggered, or changed owner, while the
AddKey was in flight (round-1 H-3). The 1 NEAR taken from the vault in `add_key` was not given
back, even though the key never served the vault. It is now credited back.

The key exists for a block or two before the callback deletes it, and a few TGas of the allowance
could be spent in that window. The pool absorbs that tiny difference, and nobody gains from it.
Test: `l11_revoked_key_add_refunds_allowance`. (Contract v2, second review F2: narrowed. A key that existed is
deleted without a refund, since it could burn allowance gas until the delete landed; only a failed AddKey refunds.
The test is now `l11_revoked_key_add_keeps_allowance_once_the_key_existed`. See `SECURITY_FIXES_V2.md`.)

### L-12: key cap bypass with concurrent requests (fixed)

`add_key` checks `list.len() < 5` against *confirmed* keys only. If an owner sends several
`add_pulse_key` calls in one block, all of them pass, and `on_key_added` pushed every key that
landed. Each extra key costs 1 NEAR, so this is not free storage. But it breaks a DoS bound that
step 2, `move_owner` and the vault size all rely on. The callback now enforces the cap again: an
extra key is deleted, its allowance refunded, and `key_add_revoked` logged with reason
`too many keys of this kind`. Test: `l12_key_cap_enforced_when_add_lands`.

### L-13: unbounded `get_vaults_for_owner` and owner-index spam

`get_vaults_for_owner` loads and renders every vault in the account's index, with no limit. Anyone
can add ids to a victim's index in two ways: by `nft_transfer` to the victim, or by creating
10-second vaults that name the victim as primary heir and settling them. Each costs 0.1 NEAR plus
gas. A few hundred ids push the view past the RPC view gas limit, and the dashboard can no longer
list that account's vaults. Funds are unaffected: `claim` and the paginated
`nft_tokens_for_owner` still work.

**Recommendation:** add optional `from_index`/`limit` (backward compatible), and have the
dashboard page through them.

### L-14: transfer of an overdue vault that nobody has poked

`internal_nft_transfer` allows `Alive | Warning`, and an overdue vault nobody has poked still reads
as `Warning`. After the transfer, `is_due` is still true (the transfer does not touch
`last_beat_ms`). Anyone can poke in the next block, and the vault then settles to the *seller's*
heirs. Keys are revoked (H-3), so the buyer can only race with a heartbeat. NEP-178 approvals are
not supported, so no marketplace can sell a Will. The risk is limited to peer-to-peer deals.

**Recommendation:** reject transfers when `is_due(now)`, or have the dashboard warn about it.

### L-15: owner heartbeat works with function-call keys

`heartbeat` stays deposit-free on purpose (round-2 M-6), because pulse keys need that. The same
call by the owner account accepts any function-call key the owner has scoped to this contract. If
such a key ever leaks (for example from a dApp sign-in stored in a browser), whoever holds it can
keep a dead owner's vault alive forever. The guardian can only delay, not force a trigger. No
funds can be moved this way. Today's dashboard does not create such keys.

**Recommendation:** document it. A future version could require 1 yocto for an owner heartbeat and
leave pulse keys as the only deposit-free path.

### L-16: identical Solana payouts dedupe

If the owner lists the same Solana `to` and `amount` twice, step 3 signs payout #0 and payout #1
over the same message whenever the caller passes the same blockhash. That gives the same signature
and the same transaction, so Solana executes it once. Payout #1 then shows `signed` and later
`broadcast` with #0's tx id. It is recoverable: after 5 minutes the keeper re-signs #1 with a fresh
blockhash. EVM is not affected, because each payout has its own nonce.

**Recommendation:** have the keeper fetch a fresh blockhash for each payout, or have
`set_foreign_payouts` reject duplicate `(chain, to, amount)` entries.

## 3. Info

- **I-10 EVM signature checks.** `evm_rsv` checks the lengths and that `recovery_id ≤ 1`. It does
  not check low-S or that `(r, s, v)` recovers to the derived address. A bad MPC signature would
  only give a tx that nodes reject, so it is never included and the nonce is safe, and a re-sign
  fixes it. An `env::ecrecover` check before storing would catch this earlier.
- **I-11 Callback gas margins (measured, §5).** `on_transfer_done` burns up to 3.17 TGas on a full
  vault with 9 refunds in one step. Its static budget is 5 TGas, a 37% margin. On a settled vault
  with 4 signed txs (about 1 kB more) the burn is a little higher. If a caller attached only the
  static minimum and the refund callback then ran out of gas, the NEAR would land in the pool
  instead of the vault. All the other callbacks have at least 2x headroom.
- **I-12 Version strings.** `contract_source_metadata` declares nep171 1.2.0 and nep177 2.0.0.
  `nft_metadata().spec` is `nft-1.0.0` (the near-contract-standards constant), and the NEP-171
  events say version 1.0.0. These are harmless, but they are inconsistent.
- **I-13 `nft_on_transfer` gets a fixed 40 TGas.** The reference implementation passes all unused
  gas to the receiver. A receiver that needs more than 40 TGas fails, and the token comes back.
- **I-14 Owner-chosen values.** `bounty` is not bounded: `poke` pays `min(bounty, balance)`, so an
  owner can give the whole balance to the poker. The DAO bond is a fixed 1 NEAR. If the DAO's
  `proposal_bond` is lower, Sputnik refunds only the policy bond, and the rest stays in the DAO.
- **I-15 `set_keeper`** takes no deposit. Only a full-access key of the contract account can call
  it, because every function-call key on that account is limited to `heartbeat`/`agent_pay`.
  Adding `assert_one_yocto` would be defense in depth.
- **I-16 Recipients that always revert, or need more than 100 000 gas,** still lose their EVM payout
  for good (see H-5). This needs a correct heir address.
- **I-17 View gas.** `get_vaults`/`nft_tokens` with `limit = 100` render 100 full vaults. With
  maxed vaults and SVG media, use smaller pages.

## 4. Access control and the 1-yocto rule

| Method | Who | Deposit | State gate |
| --- | --- | --- | --- |
| `create_vault` | anyone (becomes owner) | ≥ 0.1 NEAR | none |
| `deposit` | anyone | > 0 | vault exists |
| `heartbeat` | owner, or a pulse key of **this** vault (pred = signer = contract) | none (FC keys, L-15) | `Live` |
| `agent_pay` | an agent key of **this** vault (pred = signer = contract) | none | denials returned; panics only on auth, `amount == 0`, receiver = contract |
| `set_heirs`/`set_policy`/`set_foreign_payouts`/`set_dao`/`set_timing`/`set_guardian`/`add_pulse_key`/`add_agent_key`/`remove_key` | owner | exactly 1 yocto (`require_owner_mutable`) | `Live` |
| `pause` | guardian or owner | exactly 1 yocto | `Live`, not due, one per cycle |
| `nft_transfer`/`nft_transfer_call` | NFT owner | exactly 1 yocto | `Alive`/`Warning`, receiver ≠ owner, receiver ≠ contract |
| `poke` | anyone | none | `Live` and due |
| `execute_step` | anyone | none | `Triggered`; step 3 needs chain args |
| `mark_broadcast` | anyone (hash checked on-chain); the vault's DAO for `dao-ratified` | none | payout `signed` |
| `resign_foreign` | anyone (EVM; Solana `failed`); contract owner or keeper (Solana `signed`/`broadcast`) | none | not `Live`, payout processed, cooldown/bump rules |
| `claim` | NFT owner | none | `Settled`, balance > 0 |
| `set_keeper` | contract owner (= the contract account) | none (I-15) | none |
| `on_key_added`, `on_transfer_done`, `on_dao_proposal`, `on_foreign_signed`, `on_foreign_sol_key`, `on_foreign_resigned`, `foreign_fail`, `nft_resolve_transfer` | `#[private]` (contract only) | none | stale checks per callback |

Every function-call key on the contract account is limited to `heartbeat` or `agent_pay`. So no
key can reach a private callback, `set_keeper`, or the owner-only Solana re-sign. The live account
has exactly one full-access key (the deployer, I-1 from round 1) and function-call keys for those
two methods.

## 5. Gas: measured worst case (live, vault 18, final code)

Every step was called with 300 TGas. "Burnt" is the receipt's real `gas_burnt`. The callbacks also
got their share of unused gas, so the attached amounts shown are larger than the static minimums.

| Step / call | Tx total burnt | Main receipt | Largest callback (burnt / static) |
| --- | --- | --- | --- |
| `add_*_key` (10th key) | 7.9 TGas | 3.7 | `on_key_added` 2.9 / 10 |
| `poke` (bounty) | 6.7 | 3.8 | `on_transfer_done` 1.6 / 5 |
| step 1: 10 heirs, 9 transfers fail and are refunded | **50.0** | 10.6 | `on_transfer_done` **3.17 / 5** |
| step 2: 10 DeleteKey | 11.7 | 6.9 | n/a (0.2 per DeleteKey) |
| step 3 Base / Monad (MPC `sign`) | 17.0 to 17.4 | 4.7 | `on_foreign_signed` 3.7 / 30; `sign` got ~264 attached |
| step 3 Solana (derived key + sign) | 26.9 | 4.6 | `on_foreign_sol_key` 3.3 / 100; `on_foreign_signed` 4.0 / 30 |
| step 4 DAO `add_proposal` | 10.8 | 4.4 | `add_proposal` 2.2 / 100; `on_dao_proposal` 3.2 / 10 |
| step 5 | 4.4 | 3.9 | none |

**Minimum prepaid gas per step.** Each step needs its static allocations plus the main receipt.
- Step 1: about 10.6 + 10 × (5 + about 2.4 receipt creation), roughly 85 TGas.
- Step 3 EVM: about 5 + 50 + 30 + about 5 of creation, roughly 90 TGas.
- Step 3 Solana: 10 + 100 + creation, and that 100 must itself cover 50 + 30. The keeper sends 300.
- Step 4: about 120 TGas.

**No step comes near 300 TGas.** The worst one measured (step 1, 10 heirs) burns 50 TGas in total.
`nft_resolve_transfer` was not run live. Its body is `move_owner`, which costs about the same as
step 2's main receipt (6.9 TGas), and its static budget is 15 TGas.

The full run: [create](https://testnet.nearblocks.io/txns/AazqZZhUtu5MLwwRya1uFyX7GbMbhfjSSTQ6cj464GFF),
[step 1](https://testnet.nearblocks.io/txns/GHUtH2RGAD3ZCjrnpgJUgfRXSP8kiadnaD9eXtK5PWGk),
[step 2](https://testnet.nearblocks.io/txns/DYCuxH2ZLqzgTufUBiP7igtZfeDvUj9gxMYX3Bw5oXTR),
[step 3 #0](https://testnet.nearblocks.io/txns/By1MshaiRerbhjvZDe2e8cWPfAwS9rxCwT9y3vR2HfZ4),
[#1 Monad](https://testnet.nearblocks.io/txns/Gt2dsEe5LdqcFUfW4F5DAW1QCisnmLMRoyBKN1yY52za),
[#2 Solana](https://testnet.nearblocks.io/txns/BhTBcFBmHZzip2owd8u2vYAnsLtqciSGeWkZqMredoqD),
[#3](https://testnet.nearblocks.io/txns/8ud2vtpHECNPDM22rqpUFbqzVYUTLcjJdYPZXwqNSFEC),
[step 4](https://testnet.nearblocks.io/txns/7rZEhHy6ADHCCibgzneeW4wixqBmhvgW4qSynfgbeHX4) (Sputnik
proposal 1), [step 5](https://testnet.nearblocks.io/txns/9EQt63q9BZwgPsp1gGr6qEryBSYPupZpQAbT5UJzg4f),
then `claim` of 6.4049 NEAR (the nine refunded shares plus the reserve) by the primary heir
([tx](https://testnet.nearblocks.io/txns/3qmobTNXCRmCHXeAyN5Hpe4LmqhkjTtUJK7vdQ6Hqa5D)).

## 6. Accounting across vaults (one shared account balance)

Let `B` be the contract account balance, `L` = Σ `vault.balance` (what the vaults are owed), and
`S` the storage stake. Solvency means `B − L ≥ S`.

- **Money into the free pool `B − L − S`:** the 0.1 NEAR fee per vault, unused key allowances (M-4),
  DAO bonds that Sputnik refunds to the proposer (M-4), and transfers to the contract that no
  longer happen (L-5, L-10).
- **Money out of the free pool:** none in steady state.
  - Key gas is drawn against an allowance that was already taken from the vault, so a key spends
    vault money, not pool money.
  - Callbacks run on gas the caller prepaid.
  - Every debit is on `self.vault(id)`, after that vault's own checks, and it happens *before* the
    outgoing promise.
  - Every failed promise is credited back to the same vault: heir, agent, bounty and claim
    transfers (`on_transfer_done`), AddKey (`on_key_added`), and the DAO bond (`on_dao_proposal`
    `Err`). The revoked and over-cap key paths now refund too (L-11, L-12).
  - No path credits a vault twice: each callback is `#[private]` and runs once per promise.
- **Can the contract fail to pay its storage?** Only in theory. A vault filled to every limit
  stores about 12 to 13 kB once the raw slots are counted (round-1 L-1 measured 11.8 kB for the
  vault itself). That is 0.12 to 0.13 NEAR of stake against a 0.1 NEAR fee, so about 0.03 NEAR
  under. Filling a vault to that size also needs 10 keys, which costs 10 NEAR of allowance, and
  that allowance ends up in the pool unless the key holder burns it as gas. The stake is checked
  against the *whole* balance, `L` included. So a shortfall could only show up at the very end:
  the last withdrawal would fail with LackBalanceForState, and the vault would keep its balance
  (the state reverts). Nothing is lost.
- **Live numbers after the run:** `B` = 54.92 NEAR, `L` = 9.30 NEAR, `S` = 5.06 NEAR
  (506 212 bytes). The free pool is **40.56 NEAR**. It grew by about 10 NEAR in the run, because
  vault 18's 10 key allowances were almost unused when step 2 deleted the keys. That is M-4: those
  10 NEAR were heir value.
- **Overflow:** the largest products are bps × balance (at most 1e33 × 1e4, well below u128 max)
  and the fee bump (at most 1e12 × 110, after the cap check). Everything else uses
  `saturating_*`. Release builds have `overflow-checks = true`. The truncating casts are `index as
  usize` (u32), `count() as u64`, and `from_index as u64` in `nft_tokens` (a U128 above u64 wraps
  to the first page; harmless).

## 7. Step machine: idempotence, ordering, timeouts

- **Steps 1, 2, 4 and 5** advance `step` and write the vault before they schedule any promise. A
  second caller in the same block runs the next step, never the same one again
  (`execute_step_twice_does_not_double_pay`).
  - If step 4 is re-entered before `on_dao_proposal` lands, the vault moves on to step 5.
  - The callback then credits or records on a vault that may already be settled. A refunded bond
    becomes claimable by the heir.
- **Step 3.**
  - `foreign_inflight_since_ms` lets one request run at a time.
  - Re-entry while a request is in flight is a no-op that returns 3.
  - After `FOREIGN_INFLIGHT_TIMEOUT_MS` (10 min) the payout is marked `failed` and the vault moves
    on.
  - A late callback is ignored, by `(step, foreign_index)`.
  - A panic on missing or invalid arguments reverts the guard, so a payout cannot be burned that way.
  - `resign_foreign` only touches payouts below `foreign_index`, so it never runs on the index
    step 3 is working on.
- **Re-sign.**
  - One re-sign per payout can be in flight (`SignTrack.inflight`, with a 10-min timeout).
  - A superseded result is ignored by `req_ms`.
  - No path moves a payout from `signed` to `failed`, so a payout that may have a live signature
    never becomes re-signable by anyone.
- **Timeout safety does not depend on clocks.** For EVM, every signature for a payout uses one
  nonce, so a late or duplicate signature cannot pay twice. For Solana, the blockhash the caller
  supplies is at most about 90 s old when it reaches the contract, and every re-sign waits 5 min
  after the last request. The MPC yield/resume timeout (about 200 blocks) is shorter than the
  10-min in-flight timeout at today's block times. Even if blocks slowed down, a late Solana
  signature would be over an expired blockhash.
- **Timestamps.** All deadlines use `block_timestamp_ms`, which validators can skew by a few
  seconds. The shortest interval is 10 s, and a pause lasts at least 10 s.

## 8. NFT standards checklist

| Standard | Item | Result |
| --- | --- | --- |
| NEP-171 | `nft_transfer(receiver_id, token_id, approval_id?, memo?)`, 1 yocto, owner only | ✔ (approvals rejected: "approvals not supported") |
| NEP-171 | `nft_transfer_call` → `nft_on_transfer(sender_id, previous_owner_id, token_id, msg)` → `nft_resolve_transfer` | ✔ (40 TGas static to the receiver, I-13) |
| NEP-171 | resolve: revert on `true`, on a failed promise or on a non-bool reply; keep if the receiver already moved it on | ✔ (also keeps it if settled) |
| NEP-171 | `nft_resolve_transfer` returns `true` if transferred | ✔ |
| NEP-171 | `nft_token` returns `Token{token_id, owner_id, metadata, approved_account_ids}` | ✔ (`approved_account_ids: {}`) |
| NEP-171 | receiver ≠ owner | ✔ (and receiver ≠ contract, L-10) |
| NEP-177 | `nft_metadata` with spec, name, symbol, icon | ✔ (spec `nft-1.0.0`, I-12) |
| NEP-177 | `TokenMetadata`: title, description, media (data URI, no hash needed), `copies` 1, `issued_at`/`updated_at` as ms strings, `extra` JSON | ✔ |
| NEP-181 | `nft_total_supply`, `nft_tokens(from_index: U128, limit)`, `nft_supply_for_owner`, `nft_tokens_for_owner` | ✔ (limit capped at 100) |
| NEP-297 | `EVENT_JSON:` with standard, version, event, data | ✔ (`nep171` mint/transfer through near-contract-standards; `dmw` 1.0.0 for every vault event) |
| NEP-297 | `nft_mint` on create; `nft_transfer` on transfer, on revert (memo "nft_transfer_call reverted") and on settlement (memo "settlement") | ✔ |
| NEP-330 | `contract_source_metadata` (version, link, standards) | ✔ (build info only with `REPRODUCIBLE=1`) |
| NEP-178/199 | approvals and royalties | not implemented (intended, so no marketplace sales, see L-14) |

**Event correctness.** Every state change calls `record`, which appends to the bounded log and
emits the matching `dmw` event. `agent_pay_allowed`, `step_1` and `triggered` are emitted before
their transfer settles; a failure afterwards emits `transfer_failed`. A successful re-sign emits
`foreign_signed` (detail `resigned …`), and a failed one emits `foreign_resign_failed`. No event is
emitted for a state change that then reverts, because a panic drops the logs.

## 9. `foreign.rs` payload construction

- **Base and Monad (EIP-1559 type 2).**
  - The transaction fields are `chain_id` (from the registry, never the caller), the pinned
    `nonce`, `max_priority_fee`, `max_fee`, `gas_limit` (raised to the floor, H-5), `to` (owner
    set, 0x + 40 hex checked), `value` = payout amount, empty `input` and an empty access list.
  - The signing payload is `keccak256(0x02 ‖ rlp(...))`, and it matches the viem vectors.
  - `r` and `s` are stripped of leading zeros before RLP (the vector with a 31-byte `r` passes).
  - `v` is the y-parity from the MPC (0 or 1 only).
  - The tx id is `keccak256(raw)`, which `mark_broadcast` recomputes.
  - Live Monad tx: `0x02f86f82279f80…`, chain id 10143 and nonce 0.
- **Solana (legacy message).**
  - The header is (1, 0, 1). The accounts are [from, to, system program].
  - The blockhash comes from the caller and is checked to be a 32-byte base58 hash.
  - The instruction is SystemProgram transfer (index 2, data `02000000 ‖ u64 LE`), and it matches
    web3.js.
  - `from` is the contract's own `derived_public_key(sol-N, domain 1)`, never the caller's.
  - The MPC Ed25519 signature is checked with `ed25519_verify` before it is stored.
  - The tx id is the base58 of the first signature (`raw[0] == 1`).
- **Isolation.**
  - Paths are `base-N`, `monad-N` and `sol-N`. EVM uses domain 0 and Solana domain 1.
  - Token ids are never reused, because vaults are never deleted.
  - Only this contract signs for these paths, and only from vault state.
  - Cross-chain replay is impossible: the chain id is signed into the tx, and each chain has its
    own address.

## 10. Panics and returns

Policy denials in `agent_pay` are returned and logged. Everything else that is invalid panics, and
the panic reverts all state:
- authorization failures, bad arguments and wrong states;
- missing step-3 arguments, which is deliberate, so a payout cannot be burned.

Callbacks never panic on the result of a promise. They use `promise_ok()` or `#[callback_result]`.
The one exception is a DAO that answers `add_proposal` with something other than a u64. The
callback then panics, but the step has already moved on and the DAO has accepted the bond, so the
state stays consistent.

## 11. Verified sound

These were checked on the final code and found correct:

- **Round-1 and round-2 fixes still hold.**
  - C-1: the nonce is pinned per chain; re-signs need a fee bump and a cooldown; a Solana re-sign
    of a signed payout needs the operator.
  - H-1: `mark_broadcast` recomputes the tx id.
  - H-2: fee and gas caps per chain.
  - H-3: `move_owner` revokes keys and the guardian; a late AddKey is revoked.
  - H-4: at most one Monad payout.
  - M-6: 1 yocto on every owner mutator, on `pause` and on NFT transfers.
  - All their regression tests pass unchanged.
- **Access control** as in the §4 matrix. Every callback is `#[private]`. Function-call keys on the
  contract are limited to two methods. Key auth checks predecessor = signer = contract, and that
  the key belongs to *this* vault.
- **Key registry.**
  - The global `key_index` means a key can belong to only one vault.
  - AddKey of an existing key (the deployer's key or another vault's key) fails and is refunded.
  - Only keys from the vault's own confirmed lists are ever deleted.
- **Accounting** as in §6: per-vault debits before promises, refunds to the same vault, and no
  double credit. The live free pool is 40.56 NEAR, against about 0.03 NEAR of worst-case
  under-collection per vault.
- **The step machine** is idempotent under concurrent callers and out-of-order callbacks (§7).
  Settlement can never be blocked: every step-3 failure advances, step 4 is skipped without a DAO
  or without enough balance, and step 5 always completes.
- **Gas.** Every step fits easily in 300 TGas. The live worst case is 50 TGas (§5).
- **Storage caps.**
  - 10 heirs, 5 + 5 keys (now also enforced in the callback), 4 foreign payouts (1 Monad) and 10
    allowlist entries.
  - The log is capped at 40 entries, details at 400 bytes and memos at 64 bytes.
  - `to`/`from_address` are at most 64 bytes and `tx_hash` at most 128.
  - The raw slots are bounded per vault: `guard`, and `chainsig:track`/`pending` per payout index.
- **Pause** (round 2): one pause per heartbeat cycle; it is bounded by `max_pause_s` of at most
  90 days; only a heartbeat clears it.
- **Upgrade compatibility.**
  - No stored struct changed. `EvmChain` is a compile-time constant, and the new field is not
    stored.
  - Callback argument lists are unchanged.
  - After the redeploy, vaults 6, 12 and 17 read correctly through `get_vault`, and vault 6 through
    `nft_token`. `get_config().keeper` is still `dmw-keeper-a92b.testnet`.

## 12. Live verification after the redeploy

- **Redeploy.** Tx [4Dgg8tyK…](https://testnet.nearblocks.io/txns/4Dgg8tyKC2byYWwBUCD1i8eEBbFixtWkX1X8S8UcbWuk).
  `view_account.code_hash` = `5H5vWiKFX1tF13ujkmozuke1DcdNExqeLTg8jAbRYdux`, the same as the local
  build.
- **Vault 6** is `Alive`, step 0, balance 5 NEAR, with Base, Monad and Solana payouts `pending`. It
  was not called. Its source addresses `base-6` and `monad-6` hold 0 today. When they are funded,
  the 0.05 MON recommended for `monad-6` covers the new 50 000 gas floor.
- **Vault 12** is `Settled`, step 6, with Base and Solana payouts `signed`.
- **Vault 17** is `Settled`, step 6, with Base, Monad and Solana payouts `signed`, and a 40-entry log.
- **`get_config().chains`** shows `min_gas_limit` 50000 for Base and Monad, and `max_payouts` 4 and 1.
- **Vault 18** (the audit run): settled end to end on the new code. Its EVM payouts were signed
  with a gas limit of 50 000.

## Remaining recommendations (not fixed here)

1. **M-4.** Lower `KEY_ALLOWANCE` (0.25 NEAR covers about 20 heartbeats), or add `rotate_key`. Also
   write down a policy for the free pool. The live run moved 10 NEAR of heir value into it.
2. **M-5.** Relax the fee-bump rule to `new ≥ min(1.1 × old, cap)`, so a payout signed at the cap
   can still be re-signed.
3. **L-13.** Paginate `get_vaults_for_owner`.
4. **L-14.** Reject `nft_transfer` once the vault is due.
5. **I-10.** Check low-S and ecrecover before storing an EVM signature.
6. **Docs.** SPEC §2.7 (gas 21 000..=100 000) and the keeper/dashboard comments say "21000 gas".
   The contract now signs with at least 50 000. Those files are outside this audit's write scope.
