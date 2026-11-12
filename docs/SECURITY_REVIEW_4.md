# Dead Man's Wallet: security review 4 (contract v2 + deploy setup)

> Fixed in contract v3: every finding below is either fixed with a named regression test or explained, in
> [`SECURITY_FIXES_V3.md`](SECURITY_FIXES_V3.md). This file is the review as written, against commit `dfd66e5`.

Scope: `contracts/dmw/src/{lib.rs,types.rs,foreign.rs,nft.rs}` at `dfd66e5`, its tests, SPEC/DESIGN/SECURITY, `Makefile`,
`scripts/{lib.sh,deploy.sh,near-admin.mjs,showcase.sh}`, `.github/workflows/{testnet,keeper,reproducible,ci}.yml`,
`contracts/dmw/Cargo.toml`. I formed the findings below before I read `docs/AUDIT_*.md` / `SECURITY_*.md`. The section
"Prior fixes" covers those documents afterwards.

**Build and tests.** `cargo test --locked` (rustc 1.97, offline cache, target dir outside the checkout): **148 passed,
0 failed**. I wrote five proof-of-concept tests. They were written in a scratch copy of the crate and are now in the repository, reversed to assert the
fix, as the `v3_poc_*` tests in `contracts/dmw/src/tests_v3.rs`. **All 5 pass**, which confirms the behaviour described below. I edited nothing in the checkout,
ran no script that sends transactions, and called no faucet.

## Summary

| ID | Severity | Title |
| --- | --- | --- |
| H-1 | High | A compromised contract keeper can over-pay or redirect a vault's SOL, brick Solana payouts, lock heirs out of EVM payouts, and can never be removed on a locked contract |
| H-2 | High (deploy) | `testnet.yml task=all` sets a throwaway keeper as `keeper_id` and then locks the contract. The keeper role is dead forever, so with M-1 anyone can permanently strand the SOL of every vault that has no vault keeper |
| M-1 | Medium | After the 1 h window, anyone may supply the Solana blockhash for step 3. A junk or stale one gives a `signed` payout that only a keeper can ever re-sign |
| M-2 | Medium (needs confirmation) | `on_transfer_done` has a static 5 TGas budget that v2's larger vault and double write may exceed. A refund then lands in the pool instead of the vault |
| L-1 | Low (impact critical) | `near-admin.mjs lock` checks only that no FullAccess key remains. Any function-call key whose method list reaches a `#[private]` callback steals every live Will NFT |
| L-2 | Low | Operators (heirs) and the owner-chosen DAO can evict the "key events" history ring |
| L-3 | Low | Re-sign stores the new fees before the signature exists (prior L-17, still open). After one MPC failure, heirs can be locked out of an EVM re-sign |
| L-4 | Low | Several Solana payouts share one derived address, there is no per-chain cap and the Solana `to` is not validated (prior L-19, still open), so one double payment drains the other heirs' SOL |
| L-5 | Low | `get_vaults_for_owner` is unbounded and anyone can spam a victim's index (prior L-13, still open) |
| L-6 | Low | A Will NFT sale resets heirs and payouts but not the timing. The buyer's vault can be due 10 s later, and the foreign balances are then stranded for good |
| I-1..I-6 | Info | MPC signer is immutable after lock; leftover foreign balances have no exit; an in-flight AddKey survives an A→B→A transfer; CI supply-chain notes; "key derived from a repo secret" is no stronger than a stored key; guardian griefing |

---

## High

### H-1: A compromised contract keeper cannot be removed on a locked contract, and it holds fund-moving power over Solana

**Where.** `lib.rs:951-972` (`set_keeper`), `lib.rs:1198-1206` (`is_keeper`), `foreign.rs:961-969` (a signed Solana
re-sign is keeper-only), `foreign.rs:981-1000` (only non-keepers are bound by the fee bump), `foreign.rs:415-429`
(non-keeper clamp), `foreign.rs:637-646` (the keeper's step-3 EVM fees are not clamped).

**What a keeper can do.** This covers the contract keeper for every vault, and a vault keeper for its own vault.

1. **Repeated Solana payments (over-pay or redirect).** A Solana transfer has no nonce. The keeper signs step 3 with a
   real blockhash and relays it, so payment 1 lands. It skips `mark_broadcast`, waits the 5-minute cooldown and calls
   `resign_foreign` with a fresh blockhash, so payment 2 lands. It repeats every 5 minutes until the vault's
   `sol-<id>-<salt>` address is empty. PoC `poc_keeper_resigns_signed_solana_unboundedly` runs five back-to-back
   keeper re-signs of an already signed payout, and every one is accepted. All Solana payouts of a vault share that one
   address (L-4), so this moves SOL meant for heir B to the recipient of payout #0. The keeper cannot send to itself,
   because `to` is fixed. If it colludes with a recipient, though, the result is theft from the other heirs. An
   *honest* keeper whose "did it land?" RPC check is wrong does the same thing by accident.
2. **Brick Solana.** The keeper re-signs (or signs first, during the operator hour) with a junk but well-formed
   blockhash. The payout is `signed` with a transaction that can never land. From then on only a keeper may re-sign
   it (`foreign.rs:966-969`). Heirs and the vault owner cannot (PoC `poc_stranger_solana_blockhash_then_heir_cannot_resign`).
3. **Lock heirs out of an EVM payout.** The keeper signs at the cap (Base 100 gwei, Monad 1000 gwei) with a 100 000
   gas limit. A non-keeper re-sign must raise both fees by at least 10%, but non-keepers are clamped to 10 or 200 gwei.
   A non-keeper can therefore never re-sign it (PoC `poc_keeper_cap_fee_locks_out_heirs`). A node will not mine that
   transaction until the derived address holds value + 100 000 × cap: +0.01 ETH on Base, or +0.1 MON on Monad, all of
   it burned because Monad bills the gas limit. That is a ransom-style top-up. An honest keeper that reads a fee spike
   causes the same lock-out.
4. **Hand the role to a black hole.** `set_keeper(Some(<any valid id nobody controls>))` is accepted. On a locked
   contract (`owner_id == contract`) only the current keeper may call `set_keeper`, so the role is gone for good
   (PoC `poc_locked_keeper_handover_is_irreversible`). An attacker can just as easily hand the role to itself on a
   fresh account, and the team can then never take it back.

**What it cannot do (verified).** It cannot move vault NEAR or change heirs, timing, recipients, amounts or the NFT.
It cannot stall NEAR settlement: steps 1, 2, 4 and 5 are permissionless, and step 3 opens to everyone after 1 h per
payout. It cannot double-pay EVM, because the nonce is pinned per payout (`foreign.rs:373-376,411`). It cannot change
`mpc_signer`. Re-signs at the cap cost the pool 1 yocto each, which is negligible.

**Why this is High for the planned redesign.** The redesign keeps the keeper key in GitHub Actions. Anyone with write
access can push a workflow to a branch, and that workflow receives repository secrets. Any keeper npm dependency also
runs with the key in its environment (`keeper.yml:50-74`). Once the contract is locked, a leak is permanent: the
contract offers no path to replace a compromised keeper.

**Minimal fixes.** These are listed cheapest first. The ones that need contract changes must land before the lock.

- No contract change: give CI only a **function-call access key** on the keeper account, with receiver `dmw` and
  methods `poke`, `execute_step`, `mark_broadcast`, `resign_foreign` (all four are non-payable). Keep the keeper
  account's full-access key offline. `set_keeper` needs exactly 1 yocto (`lib.rs:953`) and function-call keys cannot
  attach a deposit, so a leaked CI key cannot hand over the role. The team can delete the leaked key with the cold key
  and add a new one, which rotates CI access without touching the contract. A window between the leak and the
  revocation remains, and for that window item 1 still applies.
- Contract: add a `keeper_admin` (a DAO or multisig) whose **only** power is a timelocked `set_keeper` (propose, then
  execute after N days, with events). Do not reuse `owner_id` for this: `is_operator` and `is_keeper` treat
  `owner_id` as a keeper for every vault (`lib.rs:1186,1203`).
- Contract: make the handover two-step (`propose_keeper` then `accept_keeper` from the new account) so nobody can send
  the role to an account that cannot act.
- Contract: remove the double-pay power itself. Options are a durable nonce account per `sol-` address, or one derived
  address per Solana payout funded with exactly that payout (prior M-3). The cheapest version: `max_payouts: 1` for
  Solana, as for Monad, plus a per-payout cap on keeper Solana re-signs (for example 3).
- Contract: when the last EVM fees are above the non-keeper clamp, let a non-keeper re-sign at the clamp without the
  110% rule. The nonce is pinned, so this only replaces the transaction, and older signatures stay relayable anyway.
  The keeper then cannot lock heirs out.

### H-2: The deploy workflow orphans the contract keeper and then locks the contract

**Where.** `testnet.yml:104` runs `NEW=1 ... deploy.sh` on a fresh runner with no `.env`. `deploy.sh:61` calls
`ensure_keeper` (`lib.sh:44-53`), which creates `dmw-keeper-<rand>.testnet` from the faucet, keeps its key only in the
runner's `keys/` and `.env`, and passes it to `new` as `keeper_id` (`deploy.sh:69`). Then `testnet.yml:119-126` locks
the contract (`owner_id` defaults to the contract itself, `deploy.sh:33`). The runner, and with it the keeper key, is
discarded when the job ends.

**Result.** On every `task=all` deploy, nobody can ever act as the contract keeper or rotate it (`lib.rs:956-959`).
`docs/LIVE_CONTRACT.md` already says this for `dmw-885364.testnet` (keeper `dmw-keeper-2f6dcb.testnet`). Combined with
M-1:

1. Pick any triggered vault that has a Solana payout and no vault keeper. `showcase.sh` creates exactly such a vault,
   and its owner key is also discarded.
2. Wait until step 3 has been open for 1 h on that payout, then call
   `execute_step({token_id, args:{solana:{recent_blockhash:"<any 32-byte base58>"}}})` as any account.
3. The payout becomes `signed`. Heirs and the owner cannot re-sign it, and no keeper exists to do so. The SOL in
   `sol-<id>-<salt>` is stranded permanently, at near-zero cost to the attacker.

The guest sweep (`keeper.yml`) either uses a secret account that is not the contract keeper or makes a one-off faucet
account. Neither can `mark_broadcast` or re-sign for vaults where it is not an operator.

**Fix.** Create the long-lived keeper account (the planned CI keeper, as an FC-key account per H-1) *before* the deploy
and pass it as `keeper_id` in the `new` call that is batched with the deploy. Before `lock`, assert that
`get_config().keeper` equals the expected account and that this account holds a key the team can still use, and fail
the job otherwise. Better still, ship the contract-side recovery path from H-1 first.

---

## Medium

### M-1: Anyone can fix a Solana payout's blockhash after 1 h, and only a keeper can undo it

**Where.** `lib.rs:1405-1417` (step 3 opens to anyone once `step3_progress_ms + 1 h` has passed), `foreign.rs:607-611`
(only the format of the blockhash is checked; the contract cannot check recency), `foreign.rs:966-969`.

**Scenario.** At step 3, with no operator acting for an hour (the keeper is down, or H-2 applies), `mallory` calls
`execute_step` with a stale or random blockhash. The MPC signs and the payout becomes `signed`. `sarah` (heir) and
`alice` (owner) both get the error "only the keeper may re-sign a signed or broadcast solana payout" (PoC
`poc_stranger_solana_blockhash_then_heir_cannot_resign`). Even with a live keeper, recovery means the keeper must
re-sign a payout that already has a signature, which is exactly the double-pay-risky operation in H-1(1). The prior
review lists this as a residual ("Solana liveness depends on a keeper"). Its premise, that the keeper can be rotated
on a locked contract, does not hold for contracts deployed by the workflow (H-2).

**Minimal fix.** Never open Solana step-3 parameters to non-operators. Heirs are operators and have the incentive, so
settlement does not depend on strangers. Keep the 1 h opening for EVM only, where any signature only replaces the
transaction. The structural fix is a durable nonce or per-payout addresses (H-1).

### M-2: `on_transfer_done` gas budget (needs confirmation)

**Where.** `lib.rs:88` (`GAS_ON_TRANSFER = 5 TGas`), `lib.rs:1065-1099`, `lib.rs:1212-1244`.

On the failure path, the callback loads the full vault (plus the guard slot), appends a history entry, writes the
vault, and then `charge_storage` reads it again and usually writes it again. `docs/AUDIT_FINAL_CONTRACT.md` I-11
measured 3.17 TGas against 5 TGas on a *v1* vault. v2 roughly doubled the log capacity (40 routine + 40 history
entries of up to 400 bytes each) and added the second read and write. Host storage-write costs alone are about
63 Mgas per byte per write. On a 12-20 KB vault, two writes are about 1.5-2.5 TGas before any borsh or JSON work.

If the callback runs out of gas, a failed transfer's NEAR is refunded to the contract pool and the vault is never
credited. The cases are a share for an heir whose named account does not exist (steps 1 and 5) and a failed agent or
bounty transfer. That heir value is lost to the pool, the same failure mode I-11 warned about.

**To confirm.** In near-workspaces, run step 1 on a vault with full rings and 10 heirs, several of them nonexistent
accounts, and read the callback's `gas_burnt`. **Fix:** 20 TGas, and skip the second write in `charge_storage` when
nothing changed. The vault is already written once just before.

---

## Low

### L-1: The lock check misses dangerous function-call keys (impact critical, likelihood low)

**Where.** `near-admin.mjs:116-125`, `testnet.yml:119-126`.

The script only checks that no FullAccess key is left. Any key on the contract account has predecessor == contract,
so a function-call key whose method list includes a `#[private]` method, or is empty (any method), passes the
private check. `nft_resolve_transfer(owner_id=attacker, receiver_id=<current owner>, token_id)` with zero promise
results always takes the revert path (`nft.rs:253-273`) and moves a live vault, balance included, to the attacker
(PoC `poc_private_callback_from_contract_key_steals_nft`). `on_key_added`, `foreign_fail` and the other callbacks are
reachable the same way. Today nothing adds such a key, but a lock is irreversible.

**Fix.** Before and after `lock`, assert that every remaining key is a function-call key with receiver = the
contract, a method list of exactly `["heartbeat"]` or `["agent_pay"]`, and a registered vault.

### L-2: The history ring can still be evicted by non-strangers

**Where.** `lib.rs:1792-1816`, `foreign.rs:1108-1125`, `lib.rs:810-821`.

Every `resign_foreign` outcome (`foreign_signed` / `foreign_resign_failed`) goes to the 40-entry history ring. An heir
can re-sign an EVM payout every 5 minutes, ratcheting 1 wei ×1.1 up to the clamp: about 240 re-signs, about 20 h.
Each keeper re-sign at the cap adds one more entry, with no limit. The owner-chosen `dao_id` can call
`mark_broadcast(..., "dao-ratified")` any number of times, and each call adds a history entry. After 40 entries,
`step_1` (the per-heir payout detail the dashboard parses) and `settled` are evicted. Only `vault_created` is pinned.

**Fix.** Route re-sign outcomes and repeated `dao_ratified` entries to the routine ring, or pin `triggered`, `step_*`
and `settled` as well.

### L-3: Re-sign fees are stored before the signature exists (prior L-17, still open)

**Where.** `foreign.rs:1002-1011`.

`write_track` records the new fees with `inflight: true` before the MPC call. If the MPC or the callback fails, the
track keeps fees that were never signed. When an heir's re-sign at the non-keeper clamp fails this way, every later
non-keeper re-sign needs at least 110% of the clamp, and the clamp makes that impossible. Only a keeper can then act
(compare H-1(3)).

**Fix.** Write the fees in `on_foreign_resigned` on success. Keep only `last_request_ms` and `inflight` up front.

### L-4: Solana payouts share one address, with no per-chain cap and no `to` validation (prior L-19, still open)

**Where.** `lib.rs:509-541`.

Up to 4 Solana payouts can draw on one `sol-<id>-<salt>` address. Any extra landed signature (H-1(1), or the
"failed then re-signed" residual the prior review documents) pays one recipient out of the others' funding. A bad
base58 `to` or an amount above `u64::MAX` is only discovered at step 3, where the payout fails permanently.

**Fix.** `max_payouts: 1` for Solana. Validate the base58 32-byte `to` and `amount <= u64::MAX` in
`set_foreign_payouts`.

### L-5: `get_vaults_for_owner` is unbounded (prior L-13, still open)

**Where.** `lib.rs:912-919`.

Anyone can grow a victim's index: `nft_transfer` to the victim, or settle vaults that name the victim as primary heir,
at 0.1 NEAR each. The view then exceeds the view gas limit. `index_add` also rewrites the whole `Vec<u64>` on every
add (`lib.rs:1588-1594`). Funds are unaffected.

**Fix.** Add optional `from_index` / `limit`.

### L-6: A sale keeps the seller's timing, while foreign payouts are cleared

**Where.** `lib.rs:1613-1652`.

`move_owner` resets heirs, payouts, DAO, keys and bounty, and sets `last_beat_ms = now`, but keeps
`heartbeat_interval_s` / `grace_missed`. A seller with a 10 s interval and grace 0 hands over a vault that is due 10 s
later. The seller (or anyone) pokes it for the default bounty. It settles with no foreign payouts, because they were
cleared, and the SOL, ETH and MON the seller left in the derived addresses become unspendable forever: nothing can
sign for those paths after settlement.

**Fix.** On a sale, raise the timing to a safe minimum (for example 1 day × grace 1), or refuse a transfer while the
derived addresses' payouts are cleared and the vault is due within N minutes.

---

## Info

- **I-1 MPC signer is fixed forever.** It is set in `new` (`lib.rs:153,199`) with no setter. If
  `v1.signer-prod.testnet` is migrated or changes its `sign` deposit or format, every future step 3 on the locked
  contract fails, and foreign funds are stranded. Accept this knowingly, or let a timelocked `keeper_admin` (H-1)
  change it.
- **I-2 Leftover foreign balances have no exit.** Surplus in a derived address, a payout to a reverting recipient that
  burned its nonce, or funds left after settlement can never be swept (prior I-16 / H-4 family). Document it for users.
- **I-3 In-flight AddKey across a sale and back.** `on_key_added` compares against the *current* owner. If the NFT
  goes A→B→A before the callback lands, A's key is confirmed after the reset. It belongs to A, so this is harmless,
  but it is an exception to "nothing survives a sale".
- **I-4 CI supply chain.** `testnet.yml:77` pipes the cargo-near installer through `curl | sh` with no checksum. The
  actions are pinned by tag, not SHA. `npm ci` runs install scripts in the same job that later creates keys. The
  reproducible build itself is well pinned: image by digest (`Cargo.toml`), `--locked`, `Cargo.lock` committed.
- **I-5 "Key derived from a repository secret"** gives exactly the security of the secret. Put the secret in a GitHub
  Environment restricted to the default branch, with required reviewers, so that branch pushes and other workflows
  cannot read it. Expose it only to the step that calls the contract. Use an FC key (H-1), never the account's
  full-access key. Scheduled workflows on public repositories are disabled after 60 days without activity, and the
  keeper then stops silently (see M-1 and H-2).
- **I-6 Guardian griefing (known, prior L-8).** A guardian can pause after every heartbeat, which disarms the agent for
  up to `max_pause_s` each cycle. The owner can `unpause` or remove the guardian.

---

## Keeper role: direct answers

| Question | Answer |
| --- | --- |
| What can a compromised contract keeper do? | Everything in H-1: repeated Solana payments from any vault's `sol-` address to a payout recipient (over-pay or redirect between heirs); brick Solana payouts; lock heirs out of an EVM payout until someone tops up the source address (and burn up to 0.1 MON per Monad payout); front-run the 1-hour operator window with bad parameters; record correct-hash `mark_broadcast`s; hand the role to anyone. This applies to every vault, because the contract keeper is a keeper for all of them (`is_keeper`). |
| Can it steal or redirect funds? | It cannot steal NEAR or change recipients. It **can redirect SOL between recipients of the same vault and over-pay one recipient**, which is theft if it colludes with that recipient. On EVM it can only burn gas within the caps. |
| Can it stall settlement? | NEAR: no. Foreign: it can delay each payout by about 1 h 10 min (operator window plus in-flight timeout). It can stall Solana payouts permanently and EVM payouts until a top-up. |
| Can it be rotated away if compromised on a locked contract? | **No.** Only the current keeper can call `set_keeper` when `owner_id == contract` (`lib.rs:956-959`). The team and the attacker race with the same key, and whoever moves first keeps the role. A per-vault keeper does not override the contract keeper, and a dead owner cannot add one. |
| Should the contract offer a recovery path before lock? | **Yes.** At minimum: (1) hold the keeper as an FC key on an account whose full-access key is cold, which needs no contract change and gives you key rotation; (2) add a `keeper_admin` with a timelocked `set_keeper` that has no operator powers, plus a two-step handover; (3) remove the Solana double-pay power (durable nonce, per-payout address, or at least 1 Solana payout per vault plus a re-sign cap), so a future keeper compromise is only a liveness problem. Also fix H-2 in the deploy so that the keeper in `new` is the long-lived account. |

---

## Prior fixes: do they hold?

| Prior item | Status |
| --- | --- |
| B (sale of an overdue vault, uncapped bounty) | Holds (`nft.rs:361-364`, `lib.rs:1613-1652`, `bounty_payout`). New side effect: L-6. |
| C (keeper rotation, step-3 junk args) | The code holds as written, but rotation only works while the keeper key exists. The deploy workflow defeats it (H-2), and Solana junk is not recoverable without a keeper (M-1). |
| D (dust deposits, log flooding) | Holds for strangers. Operators and the DAO can still evict history (L-2). |
| E (re-sign and `mark_broadcast` auth, cooldown) | Holds. |
| F (owner heartbeat yocto, pulse beat vs. pause) | Holds (`lib.rs:322-341`). |
| G (private `new`, batched deploy) | Holds (`lib.rs:180-201`, `near-admin.mjs` deploy). |
| L-4, L-8, L-9 | Hold. L-9: storage is never funded from other vaults (deposit only grows from the vault's own balance; release is at most the deposit). |
| Callbacks need exactly one result | Holds for every `.then` callback. `foreign_fail` is a direct self-call with no result to check. That is fine, but it is reachable via L-1. |
| F1 (Solana signed re-sign keeper-only) | Holds. It concentrates power in the keeper (H-1). |
| F2 (no allowance refunds) | Holds (`release_key`, `on_key_added` refunds only when AddKey failed). |
| F3 (`unsplit`) | Holds (`credit`, step 5). |
| F4 / G1 (clamp, keeper free of the bump rule) | Holds against strangers. The flip side, keeper lock-out of heirs, is H-1(3). |
| C-2 (DAO bond never re-credited) | Holds (`lib.rs:1127-1143`). |
| H-1 / H-2 / H-4 / H-5 (hash match, fee caps, Monad 1 payout, 50k gas floor) | Hold. |
| L-13, L-17, L-19 | **Still open** (L-5, L-3, L-4 here). |
| I-11 callback gas | Re-check for v2 (M-2). |

## Checked and found sound

- **Auth.** Every owner mutator (`set_*`, `add_*_key`, `remove_key`, `unpause`, `set_bounty`, `set_vault_keeper`,
  `nft_transfer*`) requires predecessor == owner, exactly 1 yocto, and Live state. `pause` needs 1 yocto from the
  guardian or the owner. Pulse and agent auth requires predecessor == signer == contract *and* the signing public key
  listed in that vault. The global `key_index` makes a key belong to one vault and is required before delete. Keys
  added by the contract are scoped to `heartbeat` / `agent_pay` only. A pre-existing key cannot be deleted through a
  failed AddKey.
- **Yocto and deposits.** Non-payable methods reject deposits. The only unaccounted inflows are 1-yocto confirmations
  and the pool absorbing refunded DAO bonds and unused allowances, all of which favour the pool.
- **Pool solvency.** Every outflow is debited from the vault before the promise. Failed transfers are credited back
  only on exactly one failed result. Storage top-ups come from the vault's own balance. There is no path that credits
  a vault without NEAR arriving (C-2 and F2 hold).
- **Arithmetic.** `heir_shares` uses checked multiplication and floor division (sum ≤ amount). `add_yocto` is checked.
  Balance subtractions are guarded. Time math saturates. `bounty_payout` is at most 10% of the balance and 1 NEAR.
  `overflow-checks = true` in release.
- **State machine.** Triggered and Settled are terminal for owner actions. `poke` uses the pause-extended deadline.
  `pause` is refused once due, once per cycle, and a pulse beat cannot end a running pause. Steps are sequential and
  idempotent. The step-3 in-flight guard has a 10-minute timeout, and stale callbacks (step 3 and re-sign) are
  ignored. No step can panic deterministically and brick settlement: missing args revert only that call, an
  unbuildable payout fails through `foreign_fail`, a DAO failure continues, and a low balance skips the bond.
- **Chain Signatures.** The EVM chain id comes from the registry. The nonce is pinned per chain index. Gas floor and
  caps are enforced. Every EVM signature is ecrecovered against `derived_public_key` with low-s enforced, and every
  Solana signature is verified with ed25519 against the derived key. `mark_broadcast` accepts only the stored tx id.
  Paths are salted per vault.
- **NFT.** No approvals. Transfers only while Alive. The receiver cannot be the contract. The revert resets the vault
  again and is skipped once Settled.
- **Agent window.** Rolling 24 h. Merging only over-counts. The refund-newest-first under-count lasts only a block or
  two (negligible).
- **Deploy.** `new` is `#[private]` and batched with DeployContract (no init front-run). The reproducible-build image
  is pinned by digest. Keys are masked in the workflow logs and files are 0600.

## Needs confirmation

1. M-2: callback gas on a maximal v2 vault, measured in a sandbox.
2. H-2: whether the key of `dmw-keeper-2f6dcb.testnet` (or the next deploy's keeper) was saved anywhere outside the
   runner. `LIVE_CONTRACT.md` says it was not. If it was not, the keeper role of the live contract is permanently dead.
3. I-1: the current `sign` deposit and format of `v1.signer-prod.testnet` at the time of the next deploy (1 yocto is
   hard-coded, `foreign.rs:99`).
