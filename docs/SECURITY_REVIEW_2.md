# Security review 2: `contracts/dmw` (guardian pause, chain registry)

This is the second independent review of the Dead Man's Wallet vault contract, done 2026-11-07. It
covers what changed after round 1 (docs/SECURITY_REVIEW.md, commit `7a12c23`):

- `a8ece22`: the guardian pause (`set_guardian`/`pause`, raw slot `guard:<id>`), the EVM chain
  registry with Monad testnet, and `vault_created` owner logging;
- `3795de2`, `a771c31`, `a2b14f2`, `e56578e`: the NFT art, build config and fmt (checked for
  behaviour changes; none found).

The review was checked against SPEC.md §2.8. It also re-checks the round-1 fixes C-1, H-1, H-2 and
H-3. The reviewer did not write the code.

- **Deployed:** `dmw-x8cx.testnet`, upgraded in place (no re-init, stored layout unchanged), code
  hash `BLfSxCNTB7S4AT2fzwoPRzVgri7G9niTaReMuYUh5HeM`,
  tx [CaSMFjbs…](https://testnet.nearblocks.io/txns/CaSMFjbsuuzW1oPEcCZg9JqFDidkyxDHr95MRQbFRx9s).
- **Result:** 0 Critical, 1 High, 2 Medium, 3 Low, 4 Info. The High is fixed and has regression
  tests. `cargo test`: 97 pass (up from 95). `cargo clippy --all-targets -- -D warnings` is clean.
- Regression tests are at the end of `contracts/dmw/src/tests.rs` (`h4_*`).

## Summary

| ID | Severity | Title | Status |
| --- | --- | --- | --- |
| H-4 | High | A second Monad payout can be made to revert under Monad's reserve-balance rule. Its pinned nonce is then used, so the payout is stuck for good | Fixed |
| M-5 | Medium | Front-running step 3 with fees at the cap blocks every re-sign; on Monad, gas-limit billing makes the worst case 0.1 MON per payout, not 0.021 | Documented |
| M-6 | Medium | Owner mutators, including `set_guardian`, accept 0-deposit calls, so a function-call key on the owner's account can use them (from round 1) | Fixed |
| L-7 | Low | A running pause survives an NFT transfer and an `nft_transfer_call` revert | By design, documented |
| L-8 | Low | A guardian can keep the agent disarmed by re-pausing after every heartbeat; an early pause uses up the cycle's only pause | Documented |
| L-9 | Low | The `guard:<id>` slot is not charged and is never removed after Trigger/Settle (stale guardian shown on settled vaults) | Documented |
| I-6..I-9 | Info | EIP-1559 chain id binding, Monad cap sanity, `vault_created` detail, slot layout | Notes |

Answers to the questions in the brief, in short:

- **Can a guardian or owner block settlement indefinitely?** No. The guardian gets one pause per
  heartbeat cycle, and only the owner or a pulse key can heartbeat. Without a heartbeat the deadline
  moves once, by at most `max_pause_s` (90 days or less). The owner can always delay by
  heartbeating, but a living owner is the intended case.
- **Pause in a forbidden state?** It is rejected when Triggered or Settled (`stored != Live`), after
  the effective deadline even if nobody poked (`is_due`), and when a pause has already been taken
  this cycle. A pending signature exists only while Triggered, so a pause cannot happen then.
- **Cross-chain replay?** It is not possible. The chain id is inside the signed EIP-1559 payload
  (I-6), and each chain signs from a different derived address.
- **Round-1 regressions?** None (see "What is sound").

---

## High

### H-4: A Monad payout can be made to revert, and its pinned nonce makes it unrecoverable

**Location:** `lib.rs` `set_foreign_payouts`; `foreign.rs` `evm_nonce_for`, the step-3 and
`resign_foreign` EVM branch.

**Background.** Monad enforces a *reserve balance* of 10 MON per EOA
([docs](https://docs.monad.xyz/developer-essentials/reserve-balance)). Execution reverts a tx that
lowers the sender's balance and leaves it below the reserve. The one exception is an "emptying"
tx: the sender is undelegated and sent no other tx in the last k = 3 blocks (about 1.2 s). A
reverted tx is still included and still pays gas. On an EVM chain an included tx uses its nonce,
even when it reverts.

**Impact.** Every Monad payout of vault `N` is sent from one address, `monad-N`. Since C-1, payout
`i` is permanently pinned to nonce = (number of same-chain payouts before it). Take a vault with two
Monad payouts and a typical testnet balance below 10 MON:

1. Step 3 signs payout #0 (nonce 0) and payout #1 (nonce 1). Both raw txs are public in the
   callback receipts and in `get_vault`.
2. Anyone (no role needed) relays both txs back to back, in the same block or the next one.
3. #0 is the first tx from `monad-N`, so it is emptying and succeeds. #1 is not emptying (#0 came
   less than 3 blocks earlier), and it leaves the balance below the reserve, so it **reverts**.
   It is included, pays gas, and uses nonce 1. The MON stays in `monad-N`.
4. `resign_foreign` for #1 always re-signs with nonce 1, which is already used, so it can never be
   mined again. Only this contract can sign for `monad-N`, and it never signs another nonce for
   that payout. **The heir's MON is stuck in `monad-N` for good.**

The attacker gains nothing, but they pay only for relaying public txs. No attacker is even needed:
a keeper that broadcasts all signed payouts in one pass causes the same loss. This is the same
class as round-1 H-1 (a permissionless action bricks a foreign payout for good), so it is rated High.

**Fix.** Each registry chain now has a `max_payouts` (`EvmChain::max_payouts`, shown in
`get_config().chains`). For Monad it is **1**, and `set_foreign_payouts` rejects a second Monad
payout with `too many monad payouts (max 1 per vault)`. `monad-N` then sends exactly one tx in its
life, at nonce 0. That tx is always emptying (no earlier tx, never delegated), so the reserve rule
cannot revert it. Re-signs reuse nonce 0, so at most one of them lands (C-1 still holds). Base
keeps its limit of 4. Base and Solana payouts in the same vault are unaffected.

- **State compatibility.** Live state was checked before the redeploy: vault 14 is the only one
  with a Monad payout, and it has one. So no stored vault breaks the new rule.
- **Rejected alternatives.**
  - One derived address per payout (`monad-N-i`) is the trustless general fix, and the one round 1
    recommended for Solana (M-3). It changes the path the keeper and dashboard fund and derive, and
    another agent owns those files, so it is left as a follow-up. With it, several Monad payouts per
    vault could be allowed again.
  - A contract-side delay between signatures does not help: the attacker can hold back #0 until #1
    is signed.

**Tests:** `h4_at_most_one_monad_payout_per_vault`,
`h4_single_monad_payout_signs_nonce_zero_after_base`. The existing test
`step3_monad_signs_with_monad_path_chain_id_and_own_nonce` now uses `[base, monad, base]`.

## Medium

### M-5: Fees at the cap block re-signs (and Monad bills the gas limit)

**Location:** `foreign.rs` `validate_evm_args`, the `resign_foreign` fee-bump rule.

Step 3 is permissionless (round-1 M-2), so a griefer can win the race and sign an EVM payout with
`max_fee = max_priority = cap` and `gas_limit = 100 000`. A re-sign of a `signed`/`broadcast`
payout must raise *both* fees by at least 10%. That is above the cap, so **no re-sign is possible
for that payout**, which contradicts round-1 M-2 ("EVM is recoverable by anyone immediately").
The stored tx needs `value + gas_limit x cap` in the source address:

- **Base:** 100 000 x 100 gwei = 0.01 ETH of headroom. Base bills gas *used*, so a mined transfer
  to an EOA burns about 0.0021 ETH.
- **Monad:** 100 000 x 1000 gwei = 0.1 MON of headroom. Monad bills the full gas **limit**, so
  0.1 MON is burned when the tx lands. The code comment said 0.021 MON (it assumed 21 000 gas). The
  comment is now corrected.

No funds are taken, and anyone can unblock the payout by topping up the derived address. The cost
is bounded per payout: one nonce can land, and only one Monad payout exists (H-4).

**Recommendation:**
- Give each chain its own gas-limit cap. The keeper always sends 21 000. Something like
  21 000..=30 000 on Monad would cut the worst case to 0.03 MON.
- Relax the bump rule to `new >= min(old x 1.1, cap)`, together with a lower `gas_limit`, so that
  a capped tx can still be replaced by a cheaper-to-fund one.
- Or apply round-1 M-2: only the keeper supplies step-3 args, with a permissionless fallback after
  a timeout.

### M-6: Owner mutators accept calls without a deposit (function-call keys)

**Location:** `lib.rs` `set_heirs`, `set_policy`, `set_foreign_payouts`, `set_dao`, `set_timing`,
`set_guardian`, `add_*_key`, `remove_key`, `pause`. This predates this round, but `set_guardian`
and `pause` add to it.

Only `nft_transfer*` call `assert_one_yocto`. The NEAR convention is to require 1 yocto on
sensitive methods because function-call access keys cannot attach a deposit. A dApp "sign in"
creates such a key on the user's account, scoped to a contract and often to any method, and keeps
it in browser storage. If the owner ever has a function-call key scoped to `dmw-x8cx.testnet`
(today's dashboard does not create one), whoever holds that key can call `set_heirs` and redirect
the inheritance without a wallet prompt. With the new methods they can also appoint a guardian and
pause.

**Recommendation:** add `assert_one_yocto()` to every owner mutator and to `pause`. This changes
the interface (callers must attach 1 yocto), and the keeper, dashboard and agent are being edited
concurrently, so the change is left for a coordinated release.

**Status: Fixed.** Every owner mutator (`set_heirs`, `set_policy`, `set_foreign_payouts`,
`set_dao`, `set_timing`, `set_guardian`, `add_pulse_key`, `add_agent_key`, `remove_key`) is now
`#[payable]` and calls `assert_one_yocto()` through `require_owner_mutable`, and `pause` asserts it
first, for the guardian and the owner alike (a guardian with only a function-call key cannot
pause; that is intended, since a pause disarms the agent). `create_vault` and `deposit` already
need a non-zero deposit. `heartbeat`, `agent_pay`, `poke`, `execute_step`, `mark_broadcast` and
`resign_foreign` stay deposit-free (pulse keys, agent keys and keepers call them), and so does
`claim`, so an heir signed in with a function-call key can still collect after settlement.
Callers attach 1 yocto: dashboard `calls.ts` builders, `scripts/demo.sh`, `contracts/smoke.sh`
and the video tools (`tx.mjs` / `near-admin.mjs` take `1y` as the deposit). Unit test
`m6_owner_mutators_and_pause_require_one_yocto` checks that each method rejects 0 and 2 yocto and
accepts 1; SPEC §2.3 lists the deposit per method. Redeployed to `dmw-x8cx.testnet` (state
compatible: no storage layout change).

## Low

### L-7: A running pause survives ownership changes

`move_owner` clears `guardian_id`/`max_pause_s` but keeps `paused_until_ms`/`paused_at_ms`, as
SPEC §2.8 says. Consequences:

- A seller who pauses just before `nft_transfer` hands the buyer a vault that reads `Warning`
  (agent disarmed), with the deadline pushed out by up to 90 days.
- During `nft_transfer_call`, the receiver owns the vault (round-1 L-2). It can
  `set_guardian(self, 90 d)`, `pause`, and then return `true`. The revert clears the guardian, but
  the pause stays on the original owner's vault.

In both cases the vault owner removes the pause with one heartbeat, and heirs only gain time. The
dashboard should show `paused_until_ms` to a buyer.

### L-8: The guardian can keep the agent disarmed, and an early pause is wasted

A heartbeat clears the pause and re-arms it, so a hostile guardian can call `pause` right after
every heartbeat and keep `agent_pay` denied (`vault_not_alive`) almost all the time. The fix is in
the owner's hands: `set_guardian(null)`, then one heartbeat.

A related trap: a pause that does not reach past the heartbeat deadline still uses up the cycle's
one pause. Either it is taken early, or `max_pause_s` is shorter than the time left. If the owner
then really goes silent, the guardian cannot pause again when it matters.

The owner shares the same slot, so an owner pause also takes it from the guardian.

**Recommendation:** document both behaviours in the dashboard. Optionally reject a pause with
`paused_until <= base_trigger_at` unless the caller wants an "agent disarm" pause.

### L-9: The guard slot is unpaid and never removed after settlement

`set_guardian` takes no deposit. The `guard:<id>` slot (about 120 B with key and overhead) is paid
from the pooled balance, which adds to round-1 L-1. The slot is deleted only when it equals
`Guard::default()`. A pause cleared by a heartbeat with no guardian set does delete it. Nothing
deletes it on Trigger or Settle, though, so a settled vault keeps showing the previous owner's
guardian and `paused_until_ms`. Live example: vault 14 is Settled and still reports
`guardian_id = dmw-gd-guard-7d5ea4.testnet` and `trigger_at_ms = paused_until_ms`. This is
harmless (`pause` and `set_guardian` both need `Live`), but the dashboard should hide guardian
fields once a vault is Triggered.

## Info

- **I-6 Chain id binding (confirmed).** `chainsig::evm_tx` puts the registry's `chain_id` into the
  `EVMTransaction`. The MPC signs `keccak256(0x02 || rlp([chain_id, nonce, ...]))`
  (`build_for_signing`). The chain id always comes from `payout.chain`, never from the caller. A
  Base tx (84532, `0x014a34`) therefore cannot be replayed on Monad (10143, `0x82279f`; the test
  checks the RLP), and the reverse also fails. Replay is also blocked twice over by the different
  derived addresses (`base-N` and `monad-N`, both domain 0).
- **I-7 Monad cap sanity.** A live probe of `testnet-rpc.monad.xyz` showed `eth_chainId` = `0x279f`
  (10143), `baseFeePerGas` = 100 gwei and `eth_maxPriorityFeePerGas` = 2 gwei. The keeper sends
  `2 x base + prio` = 202 gwei, and the 1000 gwei cap gives about 5x headroom. That is reasonable,
  with the gas-limit caveat in M-5. Mainnet would be chain id 143 and needs its own registry entry.
- **I-8 `vault_created` detail** is now the original owner (at most 64 bytes, inside the 400-byte
  detail limit). Older vaults have an empty detail, and the event data always had `owner_id`. No
  security impact.
- **I-9 Slot layout.** The raw slots are `guard:<id>`, `cfg:keeper`, `chainsig:track:<id>:<i>`,
  `chainsig:pending:<id>:<i>` and `STATE`. The SDK collections use 1-byte borsh enum prefixes
  (`0x00..0x02`). The ASCII prefixes cannot collide with these, or with each other: `guard:1` and
  `guard:12` are distinct full keys. `Vault::guard` is `#[borsh(skip)]`, and every read goes through
  `load`/`hydrate`. No `vaults.get` remains outside `load`, and `nft_tokens`/`get_vaults` hydrate. A
  stored `vaults.insert` therefore never touches the guard. `write_guard` is called only from
  `heartbeat` (when a pause was set), `set_guardian`, `pause` and `move_owner` (when a guardian was
  set), each on a hydrated vault, so no path can wipe a running pause by accident.

## What is sound

These parts of the new code were checked and found correct:

- **Pause bounds.** `pause` requires a configured guardian, a caller who is the guardian or the
  owner, `stored == Live`, `!is_due(now)` on the *effective* deadline, and `paused_at_ms == 0`.
  - `paused_at_ms` and `paused_until_ms` are always set together and cleared together, so
    `is_due` at pause time uses the heartbeat deadline.
  - `trigger_at_ms = max(base, paused_until)` can only move later, and `poke` uses it.
  - `max_pause_s` is limited to 10 s..90 d. `now + 90 d` cannot overflow u64 ms (it uses
    saturating maths anyway).
  - Changing or clearing the guardian does not reset the cycle (`paused_at_ms` stays), so
    "set guardian, pause, set guardian, pause" does not work.
  - No `resume` exists, and nothing except a heartbeat clears the pause.
- **Pause and the rest of the state machine.**
  - While paused, `state_at` returns `Warning`, so `agent_pay` is denied.
  - `nft_transfer` stays allowed (Alive/Warning).
  - Key revocation on transfer (H-3) is unchanged and now also clears the guardian, both on the
    forward move and on the `nft_resolve_transfer` revert.
  - Settlement code never reads the guard.
  - `set_guardian` requires `Live`, and the guardian cannot be the contract.
- **Chain registry.**
  - `ForeignChain::Monad` is appended, so stored borsh discriminants are unchanged (tested).
  - `derivation_path` uses the registry prefix (`base-`, `monad-`, `sol-`), and EVM chains sign
    with domain 0 and Solana with domain 1.
  - `evm_nonce_for` counts only same-chain payouts before the index. Base results are identical to
    round 1 for every existing vault.
  - `validate_evm_args(a, payout.chain)` applies the per-chain fee cap in both step 3 and
    `resign_foreign`. The fee cap cannot be bypassed: the chain comes from stored state, not
    args, and `args.evm` cannot pick a chain. The validation runs before the u128 bump
    multiplication (which cannot overflow below the cap).
  - `set_foreign_payouts` now requires `0x` + 40 *hex* for every EVM chain, which is stricter than
    before.
  - `expected_tx_id`/`mark_broadcast` treat Monad like Base (keccak id, lower-cased).
- **Round-1 fixes still hold.**
  - **C-1:** the nonce is still pinned (now per chain), the fee bump and Solana operator-only
    re-sign are unchanged, and the in-flight/stale-callback guards are unchanged.
  - **H-1:** the hash is still recomputed from the stored tx, now for both EVM chains.
  - **H-2:** the Base cap is still 100 gwei and the gas limit is still 21 000..100 000; Monad has
    its own 1000 gwei cap.
  - **H-3:** `move_owner` still drains and deletes both key lists, and `on_key_added` still
    revokes on an owner change.
  - All round-1 regression tests (`c1_*`, `h1_*`, `h2_*`, `h3_*`, `l4_*`, `l5_*`, `m1_*`) pass
    unchanged.
- **Upgrade compatibility.** No stored struct changed: `Guard` is in a raw slot and `ForeignChain`
  is append-only.

## Testnet verification (after the upgrade)

- **Redeploy.** Code-only redeploy of `dmw-x8cx.testnet`:
  [CaSMFjbs…](https://testnet.nearblocks.io/txns/CaSMFjbsuuzW1oPEcCZg9JqFDidkyxDHr95MRQbFRx9s).
  `view_account.code_hash` = `BLfSxCNTB7S4AT2fzwoPRzVgri7G9niTaReMuYUh5HeM`, which matches the
  local build.
- **Existing state reads correctly.**
  - Vault 6 is Alive, with base and solana payouts pending and a balance of 5 NEAR. It was not
    touched.
  - Vault 12 is Settled (step 6), with base and solana payouts signed.
  - Vault 14 is Settled, with its monad payout signed. Its guard slot still reads (see L-9).
  - `get_config().chains` shows `max_payouts` (base 4, monad 1), and the keeper is still
    `dmw-keeper-a92b.testnet`.
- **Pre-deploy scan.** `get_vaults(0, 100)` lists vaults 1-15. Only vault 14 has a Monad payout,
  and it has exactly one, so the H-4 rule breaks no stored vault.
