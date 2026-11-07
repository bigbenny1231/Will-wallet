# Security review: `contracts/dmw`

Independent review of the Dead Man's Wallet vault contract (near-sdk 5.30, Rust), done 2026-11-07
against SPEC.md (including §2.7) and every file in `contracts/dmw/src` (`lib.rs`, `foreign.rs`,
`nft.rs`, `types.rs`, `tests.rs`). The reviewer did not write the code.

- **Deployed:** `dmw-x8cx.testnet`, upgraded in place (no re-init, stored layout unchanged).
- **Result:** 1 Critical, 3 High, 4 Medium, 6 Low, 5 Info. All Critical and High findings are
  fixed, and each fix has a regression test (`cargo test`: 76 pass, up from 62;
  `cargo clippy --all-targets -- -D warnings` is clean).
- Regression tests are at the end of `contracts/dmw/src/tests.rs`. Each one is named after its
  finding id (`c1_*`, `h1_*`, `h2_*`, `h3_*`, `l4_*`, `l5_*`, `m1_*`).

## Summary

| ID | Severity | Title | Status |
| --- | --- | --- | --- |
| C-1 | Critical | Anyone can get several valid signed txs for one foreign payout (double payout from the shared derived address) | Fixed |
| H-1 | High | `mark_broadcast` accepts any hash: a front-run fake hash stops the keeper relay and permanently bricks Solana payouts | Fixed |
| H-2 | High | Caller-chosen EVM fees and gas let anyone burn the derived address's ETH | Fixed |
| H-3 | High | Transferring the Will NFT leaves the seller's pulse/agent keys active on the buyer's vault | Fixed |
| M-1 | Medium | Pulse-key gas allowance runs out after about 90 beats, and the vault then triggers even though the owner is alive | Mitigated: guardian pause (`set_guardian`/`pause`), see SPEC §2.8 |
| M-2 | Medium | Permissionless step 3 can be front-run with useless chain params (bad blockhash, low fees) | Mitigated |
| M-3 | Medium | Residual trust: re-signing a signed Solana payout needs the contract owner or keeper | By design, documented |
| M-4 | Medium | Unused key allowances and refunded DAO bonds go to the contract's free balance, not back to the vault | Documented |
| L-1 | Low | Flat 0.1 NEAR storage fee under-collects for a maxed-out vault (about 11.8 kB measured) | Documented |
| L-2 | Low | During `nft_transfer_call` the receiver can change heirs/policy/DAO and then "revert" | Documented |
| L-3 | Low | 1-yocto `deposit` spam pushes agent allow/deny history out of the 40-entry on-chain log | Documented |
| L-4 | Low | Key auth did not check that the signer account is the contract | Fixed |
| L-5 | Low | `agent_pay` to the contract itself moved vault NEAR into the unallocated pool | Fixed |
| L-6 | Low | Ordinal EVM nonces: one unpayable Base payout blocks the Base payouts after it | Documented |
| I-1..I-5 | Info | Deployer key trust, failed heir transfers, late deposits, pending-slot leak, timestamps | Notes |

---

## Critical

### C-1: Multiple valid signatures per foreign payout (double payout)

**Location:** `foreign.rs` `request_foreign_signature` and `resign_foreign` (before the fix);
`execute_step` step 3 in `lib.rs`.

**Impact.** Every Base payout of vault `N` is paid from one derived address (`base-N`), and every
Solana payout from another (`sol-N`). A signed transaction is public as soon as the MPC returns
it: it is in the callback receipt and in `get_vault`. Before the fix:

- **EVM:** the nonce came from the caller (`args.evm.nonce`). `resign_foreign` was
  permissionless and accepted any nonce. Anyone could collect signatures for the *same payout* at
  nonces `n`, `n+1`, `n+2`, ... Every one of them is a valid, different transaction.
- **Solana:** `resign_foreign` accepted any fresh blockhash for a `signed` payout. Two signatures
  over two live blockhashes are two transactions, and both execute.

A recipient (or anyone) could therefore be paid several times from the shared source address,
draining the funds meant for the vault's other foreign heirs. The recipient has a direct
incentive to do this, and it needed no privileges.

**Proof (call sequence, old code).** Vault 7 has Base payouts `#0 -> A, 0.5 ETH` and
`#1 -> B, 0.5 ETH`. `base-7` holds 1.01 ETH.
1. Keeper: `execute_step(7, {evm:{nonce:0,...}})`. Payout #0 is signed with nonce 0.
2. A: `resign_foreign(7, 0, {evm:{nonce:1,...}})`. The callback stores a second signed tx for
   #0 with nonce 1. A copies the first tx from the step-1 receipt.
3. A broadcasts both. A receives 1.0 ETH. B's payout #1 then fails for lack of funds.

The Solana version is the same with two blockhashes inside the ~60-90 s validity window. Or: A
broadcasts the stored tx without calling `mark_broadcast`, waits, then calls `resign_foreign`.

**Fix.**
- **EVM nonce pinned by the contract.** Base payout `i` always signs with nonce = the number of
  Base payouts before it (`foreign::evm_nonce_for`). Only this contract can sign for `base-N`, and
  only during settlement, so the address's nonce starts at 0. The caller's `nonce` is ignored and
  kept only for wire compatibility. Every signature ever produced for a payout uses the same
  nonce, so at most one can be mined, however many re-signs happen.
- **EVM re-sign of a `signed`/`broadcast` payout** must raise *both* fee fields by at least 10%
  over the last request. A griefer therefore cannot overwrite a good tx with an underpriced one,
  and the fee caps (H-2) limit how many bumps are possible.
- **Solana:** every re-sign waits `RESIGN_COOLDOWN_MS` (5 min) after the last signature request,
  so the previous blockhash has expired. A `failed` payout may then be re-signed by anyone. A
  `signed`/`broadcast` payout may be re-signed only by the contract owner or the configured
  keeper (`set_keeper`), who must first check off-chain (`getSignatureStatuses`) that the old
  signature never landed. See M-3 for why some trust is unavoidable here.
- **One re-sign in flight per payout.** A late callback from a superseded request is ignored. It
  is matched by `req_ms`, and a request counts as lost after 10 min.
- The signing record (last request time, in-flight flag, last EVM fees) lives in a raw storage
  slot `chainsig:track:<id>:<index>`, so the stored `Vault` layout did not change. View:
  `get_sign_track({token_id, index})`.

**Tests:** `c1_evm_nonce_is_pinned_per_payout_not_caller_chosen`,
`c1_evm_resign_reuses_nonce_and_requires_fee_bump`,
`c1_solana_signed_resign_only_by_operator_after_cooldown`,
`c1_solana_failed_resign_waits_for_cooldown_then_anyone`,
`c1_inflight_resign_blocks_second_and_stale_callback_ignored`, `set_keeper_is_owner_only`.

## High

### H-1: `mark_broadcast` accepted any hash

**Location:** `lib.rs` `mark_broadcast`.

**Impact.** `mark_broadcast` was callable by anyone. It only required `status == signed` and
accepted any string up to 128 bytes. The keeper relays only `signed` payouts, and
`resign_foreign` refused `broadcast` ones. So an attacker who watches for a payout to become
`signed` and immediately calls `mark_broadcast(id, i, "0xdead")`:
- stops the keeper from relaying it,
- puts a false explorer link in the heir's dashboard and the on-chain record,
- for Solana, bricks the payout for good. The stored tx's blockhash expires in about a minute,
  and no re-sign is allowed from `broadcast`. Only this contract can ever sign for `sol-N`, so
  the lamports are stuck forever.

**Proof (old code).** After `on_foreign_signed` stores a Solana tx:
`mark_broadcast({token_id, index:0, tx_hash:"fake"})` from any account succeeds. Status becomes
`broadcast`, and `resign_foreign` now panics "payout is not failed/signed". The old test
`mark_broadcast_requires_signed` recorded `"0xhash"` successfully.

**Fix (chosen option, and why).** The hash is now checked on-chain instead of trusting the
caller. `mark_broadcast` recomputes the transaction id from the stored `signed_tx`
(`foreign::expected_tx_id`): EVM `0x` + keccak256(raw), compared case-insensitively; Solana
base58 of the first signature. It rejects anything else. Re-reporting the same hash is a no-op.

The method stays permissionless. A correct id comes from a tx that is already public, so anyone
can relay that tx anyway, and the keeper needs no special role. "broadcast" means "relayed,
landing not confirmed". The keeper should still relay a `broadcast` payout whose hash it cannot
find on chain.

So that a payout can never be stuck in `broadcast`, `resign_foreign` now accepts `broadcast`
after the 5-min cooldown, under the C-1 rules (EVM: anyone, with the fee bump; Solana: owner or
keeper).

Two alternatives were rejected:
- A keeper-only `mark_broadcast` adds a trusted role for no safety gain.
- Recording the hash without changing status would still let a fake hash reach the dashboard.

**Tests:** `mark_broadcast_requires_signed` (updated),
`h1_mark_broadcast_rejects_fake_hash_and_resign_still_possible`,
`h1_evm_broadcast_resign_needs_cooldown_and_clears_hash`.

### H-2: Unbounded caller-chosen EVM fees and gas

**Location:** `foreign.rs` `request_foreign_signature`, `resign_foreign`.

**Impact.** `max_fee_per_gas`, `max_priority_fee_per_gas` and `gas_limit` came straight from the
permissionless caller. With `priority = max_fee = (balance - value) / 21000` the payout tx pays
the whole rest of `base-N` to the sequencer as gas. The other Base heirs lose their funds. The
attacker gains nothing, but the money is destroyed. A `gas_limit` below 21000 produces a tx that
can never be mined.

**Fix.** `validate_evm_args` panics unless all of these hold:
- 21 000 <= `gas_limit` <= 100 000
- 0 < `max_fee_per_gas` <= 100 gwei
- `max_priority_fee_per_gas` <= `max_fee_per_gas`

The panic reverts the step-3 in-flight guard, so the payout is not burned. The worst-case gas
spend for a plain transfer is now 21 000 x 100 gwei = 0.0021 ETH. Today's Base Sepolia fees are
far below the cap.

**Test:** `h2_evm_fee_and_gas_caps`.

### H-3: Will NFT transfer kept the previous owner's keys

**Location:** `lib.rs` `move_owner` and `on_key_added`; `nft.rs` `internal_nft_transfer` and
`nft_resolve_transfer`.

**Impact.** SPEC says `nft_transfer` while Alive/Warning "transfers ownership of the vault". That
is intended, and the transfer itself is safe: owner-only, 1 yocto, locked once Triggered. But the
pulse and agent keys belong to whoever set them up, and they survived the transfer. After selling
the NFT, the seller (or their AI agent):
- could keep spending the buyer's vault through `agent_pay`, up to `daily_max` per day, until the
  buyer noticed and called `remove_key`;
- could keep the vault alive forever with a pulse key, defeating the buyer's switch.

There was also a race. If the seller called `add_agent_key` and then `nft_transfer` before the
AddKey callback landed, `on_key_added` added the seller's key to the buyer's vault.

**Proof (old code).** Alice adds agent key K, then `nft_transfer(bob, "1")`. Then
`agent_pay(1, provider, 0.1 NEAR)` signed with K on the contract account still succeeds.

**Fix.** Any ownership change while `Live` drains both key lists, frees them in `key_index`, and
deletes them from the contract account. This covers `nft_transfer`, `nft_transfer_call`, and the
reverted-transfer path in `nft_resolve_transfer`. The keys are listed in the `owner_changed`
event. `on_key_added` now gets the requesting owner. If the vault changed hands meanwhile, the
new key is deleted and the event `key_add_revoked` is logged. The new argument is an `Option`, so
callbacks already in flight from the old code still deserialize. Heirs, policy, timing and DAO
carry over by design. The buyer should review them (see L-2).

**Tests:** `h3_nft_transfer_revokes_previous_owner_keys`,
`h3_key_add_landing_after_transfer_is_revoked`.

## Medium

### M-1: Pulse-key allowance runs out and the vault triggers falsely

Each function-call key gets a 1 NEAR gas allowance, and the allowance is charged for *prepaid*
gas at the pessimistic gas price. SPEC §2.7 says one key covers about 90 heartbeats at 10 TGas.
With a 60 s interval, that is about 90 minutes of daemon time. After that, every pulse-key
heartbeat fails with `NotEnoughAllowance`, and the vault triggers after `grace_missed + 1`
intervals while the owner is alive. Settlement cannot be undone.

There is no on-chain top-up. Rotating a key means `remove_key` plus `add_pulse_key`, and costs
another 1 NEAR (see M-4).

**Status: Mitigated: guardian pause (`set_guardian`/`pause`), see SPEC §2.8.** A guardian (or the owner) can
pause once per heartbeat cycle, moving the deadline to `pause time + max_pause_s`, so a dead pulse key no longer
triggers a live owner's vault straight away. The allowance itself still runs out; the recommendation below stands
for the keeper and for a future `rotate_key`.

**Recommendation:** the keeper `pulse` command should read the remaining allowance with RPC
`view_access_key` and warn or rotate below about 10%. Recommend intervals of hours or days, not
seconds, outside demos. A later contract version could add `rotate_key`, which would delete and
re-add the key with a fresh allowance in one batch.

### M-2: Step-3 front-running with useless chain params

`execute_step` is permissionless, and the caller supplies the chain environment. A griefer can
win the race against the keeper with a valid-looking but never-recent Solana blockhash, or with
EVM fees below the base fee. The payout becomes `signed` with a tx that never lands.

- **EVM** is now recoverable by anyone immediately: re-sign with a fee bump, and the nonce is
  pinned.
- **Solana** needs the keeper (or the contract owner) after the 5-min cooldown.

Funds are not at risk, only time. A stricter design is possible but out of scope: let only the
keeper supply step-3 args, with a permissionless fallback after a timeout.

### M-3: Residual trust in the keeper for Solana re-signs

Solana has no account nonce in this design, and the contract cannot prove on-chain that a
signature did *not* land. So *any* second signature for a payout that already has one is a
possible second payment. C-1 limits that power to the contract owner or keeper, after the old
blockhash has expired.

A malicious keeper working with a recipient could still double-pay one Solana payout from the
vault's shared `sol-N` address. Two trustless fixes exist, and both change the derivation and
funding model the dashboard and keeper use:
1. A durable nonce account owned by `sol-N`.
2. One derived address per payout (`sol-N-i`), funded with exactly that payout, so a double pay
   can only drain that payout's own address.

### M-4: Unused allowances and DAO bond refunds leave vault accounting

- **Key allowance.** `add_*_key` takes 1 NEAR from the vault balance as the key's gas allowance.
  When the key is deleted (`remove_key`, step 2, or H-3 revocation), the unused part of that
  1 NEAR stays in the contract account but belongs to no vault. A vault with 5 + 5 keys can lose
  up to 10 NEAR of heir value this way. The contract cannot read a key's remaining allowance.
- **DAO bond.** The step-4 1 NEAR proposal bond is refunded by Sputnik to the *proposer*, which is
  the contract, so it also lands in the free pool.

Neither is theft, but heirs lose value. **Recommendation:** lower `KEY_ALLOWANCE` for agent keys,
document the cost in the dashboard, and give the free balance a written policy. The deployer's
full-access key can currently withdraw it (I-1).

## Low

### L-1: Flat storage fee vs real storage

`m1_storage_of_a_full_vault_vs_flat_fee` measures 11 780 bytes for a maxed-out vault: 10 heirs
with 64-char ids, 10 allowlist entries, 4 signed foreign payouts, 10 keys, and a 40-entry log.
That is about 0.118 NEAR of storage stake, plus key-index and chainsig slots. The flat fee is
0.1 NEAR. The gap is paid from the pooled balance that backs other vaults.

The gap is bounded: about 0.03 NEAR per vault, and the attacker pays 0.1 NEAR to create it. So
this is griefing, not theft. **Recommendation:** measure the `env::storage_usage()` change in
mutators and charge it to the vault balance, or raise the fee to 0.15 NEAR.

### L-2: `nft_transfer_call` receiver can change the vault and then revert

The receiver owns the vault while `nft_on_transfer` runs. It can call `set_heirs`, `set_policy`,
`set_dao` or `set_timing`, then return `true` to give the NFT back. Keys are revoked on both moves
(H-3), but the other changes stay. This is standard NEP-171 trust in the receiver.
**Recommendation:** warn about it in the dashboard, or reject `nft_transfer_call` for vaults.

### L-3: Log flushing with 1-yocto deposits

`deposit` takes any amount over 0 and writes a log entry, so 40 deposits of 1 yocto push the
agent allow/deny history out of `get_vault().log`. NEP-297 events stay in the receipts, so an
indexer still has the full history. **Recommendation:** set a minimum deposit (for example 0.01
NEAR), or do not log deposits into the bounded log.

### L-4: Key auth did not check the signer account (fixed)

`heartbeat` and `agent_pay` checked `predecessor == contract && signer_pk ∈ keys`, but not
`signer_account_id == contract`. No current code path makes the contract call itself with a
foreign signer, so this was not exploitable. It is now checked as defense in depth
(`signed_by_own_key`). **Test:** `l4_pulse_key_must_be_signed_by_contract_account`.

### L-5: `agent_pay` to the contract itself (fixed)

With an empty allowlist, an agent could pay `receiver_id = dmw contract`. The NEAR left the
vault's balance and joined the unallocated pool. This is now rejected with a panic: it is an
invalid receiver, not a policy denial. **Test:** `l5_agent_pay_to_contract_rejected`.

### L-6: Ordinal EVM nonces block on an unpayable payout

Because of the C-1 fix, Base payout `k+1` cannot be mined until nonce `k` is used. If payout `k`
can never be paid (the source address is underfunded), the later Base payouts wait. Anyone can
unblock them by topping up `base-N` and re-signing `k` with a fee bump. This trade-off is
deliberate: a stuck payout can be recovered, while a double payment cannot.

## Info

- **I-1 Deployer trust.** The account's full-access key can redeploy code and move every vault's
  NEAR. `owner_id` is the contract account itself. For production, lock the account (remove the
  full-access key) or put upgrades behind a DAO.
- **I-2 Failed heir transfers.** If a heir account does not exist, its step-1 share returns to the
  vault through `on_transfer_done`. It can then only be withdrawn by the NFT owner (the primary
  heir) through `claim`. It is not redistributed by bps.
- **I-3 Deposits after step 1** stay in the reserve and go to the primary heir only.
- **I-4 Pending-slot leak.** `chainsig:pending:<id>:<i>` stays in storage if an MPC callback never
  arrives. This costs a few hundred bytes per lost request.
- **I-5 Timestamps.** All deadlines use `block_timestamp_ms`. Validator skew is seconds, and the
  smallest interval is 10 s with at least 1 interval of warning. Acceptable.

## What is sound

These were checked and found correct, or correct after the fixes above:

- **Access control.** Every owner mutator requires `predecessor == vault.owner_id` and `Live`.
  `heartbeat` is owner or pulse key. `agent_pay` requires an agent key of *that* vault.
  `poke`/`execute_step`/`mark_broadcast` are intentionally permissionless and state-gated. `claim`
  requires the NFT owner and `Settled`. All callbacks (`on_key_added`, `on_transfer_done`,
  `on_dao_proposal`, `on_foreign_signed`, `on_foreign_sol_key`, `on_foreign_resigned`,
  `foreign_fail`, `nft_resolve_transfer`) are `#[private]`. `set_keeper` is contract-owner-only.
- **Key handling.** A vault cannot register the contract's full-access key or another vault's key:
  the global `key_index` rejects duplicates, and AddKey fails for a key already on the account, in
  which case `on_key_added` refunds the allowance. Lists only hold keys whose AddKey succeeded.
  Step 2 and `remove_key` delete only keys from the vault's own lists. There is no
  remove-then-add race that deletes someone else's key, because AddKey of a key that still exists
  fails. Function-call keys can call only `heartbeat`/`agent_pay` on this contract, and the RPC
  enforces that scope (smoke test, step 4).
- **Accounting.** Per-vault `balance` is debited before any outgoing promise. Failed transfers
  (heir, agent, bounty, claim), failed AddKey and a failed DAO proposal re-credit the vault. One
  vault cannot spend another's balance: every debit is on `self.vault(id)` after that vault's own
  checks.
- **bps math.** Floor division: `Σ floor(d·bps/10000) <= d`, and the dust stays in the reserve.
  `u128` cannot overflow (`d <= 1e33`, times 1e4, is below 3.4e38). Overflow checks are on in
  release.
- **Agent policy.** Denials return `AgentPayResult{allowed:false}` and persist the log; they never
  panic. Only authorization, `amount == 0` and the self-receiver panic. The daily window and the
  refund of a failed transfer (`daily_spent` restored) are correct.
- **Step machine.** Steps 1, 2 and 5 advance `step` before scheduling promises, so a second
  `execute_step` cannot pay twice (test `execute_step_twice_does_not_double_pay`). Step 3 has an
  in-flight guard with a 10-min timeout, and stale callbacks are ignored by `(step, index)`. If
  step 4 is re-entered before its callback lands, it moves on safely, and a failed bond refund
  still credits the (possibly settled) vault. A missing chain argument panics, which reverts the
  guard, so a caller cannot burn a payout by omitting args.
- **foreign.rs.** EVM payload = keccak256 of the EIP-1559 signing payload, matching viem test
  vectors. r/s leading zeros are stripped before RLP: the nonce-204 vector covers a 31-byte `r`,
  which is canonical. Recovery id is limited to 0/1, and `big_r` must be 33 bytes. Solana:
  legacy transfer message matches web3.js. The MPC Ed25519 signature is verified with
  `ed25519_verify` against the *derived* key before it is stored, and a mismatched scheme is
  rejected. The derived key comes from the signer's `derived_public_key` for `(this contract,
  sol-N, domain 1)`, so a caller cannot supply it. `to`/`amount`/`chain` come only from vault
  state.
- **Gas.** Step 1 is at most 10 transfers with 5 TGas callbacks, about 70 TGas. Step 3 attaches
  at least 50 TGas to `sign` plus all unused gas, with a 30 TGas callback. Step 4 attaches 100
  TGas to `add_proposal` plus a 10 TGas callback. All fit in 300 TGas, and step 3 was exercised
  live (docs/chainsig-notes.md).
- **Storage/DoS limits.** At most 10 heirs, 5 keys per kind, 4 foreign payouts and 10 allowlist
  entries. Log is limited to 40 entries with details cut to 400 bytes and memos to 64. `to` and
  `from_address` are at most 64 bytes, `tx_hash` at most 128. Views are paginated (limit 100).
- **Upgrade compatibility.** No stored struct changed. New state lives in raw slots (`cfg:keeper`,
  `chainsig:track:*`). New callback arguments are `Option`. After the redeploy, vaults 1-6 read
  correctly (`get_vault`, `nft_token`).

## Testnet verification (after the upgrade)

- **Redeploy.** Code-only redeploy of `dmw-x8cx.testnet`:
  [2eU1jMev…](https://testnet.nearblocks.io/txns/2eU1jMev6Q81vdnZMP2tJ2QhaEZG5fRBJJatobKtG7Po).
- **Keeper.** `set_keeper("dmw-keeper-a92b.testnet")` was called by the contract owner.
  `get_config().keeper` confirms it.
- **Existing state reads correctly.** `get_vault` for vaults 1, 4, 5 and 6 still deserializes.
  Vault 1 is Warning, vault 4 is Settled with owner `dmw-heir-cdeb.testnet`, vault 5 is Settled
  with 2 signed payouts, and vault 6 is Alive with 2 pending payouts.
- **H-1 live.** `mark_broadcast({token_id:5, index:1, tx_hash:"fakeSig"})` now fails with
  `tx_hash does not match the signed tx`, and vault 5 is unchanged.
- **`contracts/smoke.sh` re-run in full** on the upgraded contract, as vault 8 with owner
  `dmw-sec-8fe619.testnet`. Results:
  - key setup succeeds;
  - a pulse-key heartbeat succeeds (signer = contract);
  - `agent_pay` gives 2 allowed and 3 denied, with the denials returned rather than panicking;
  - an early `poke` returns `not_due`, then `poke` pays the bounty;
  - `execute_step` returns 2, 3, 4, 5, 6, then `already_settled`;
  - both keys are deleted from the account;
  - `claim` pays the 0.1 NEAR reserve.

  The first tx is
  [D2LMFuE8…](https://testnet.nearblocks.io/txns/D2LMFuE8wQmDjPXCJZ3cNTitKoGcMv3mCmFSz66Sd64).
