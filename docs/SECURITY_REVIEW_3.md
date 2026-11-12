# Security review 3: whole repository, final pass before submission

> **Update, contract v2 (Nov 12 2026, not deployed yet).** Several statements here describe v1 and changed in v2:
> test counts are now contract 134, keeper 91, dashboard 108, agent 62; the C-2 rule (the step-4 bond is never credited back) is unchanged, and `contracts/attack-c2.sh` now also allows the step-5 storage release; the keeper is passed to `new` and can hand itself over on a locked contract; the K-1 rule (only a derived source address goes to the RPC) now prefers the derived address over any stored one. See [`SECURITY_FIXES_V2.md`](SECURITY_FIXES_V2.md). The live contract `dmw-979268.testnet` still runs v1.

Done 2026-11-10 on commit `0348a3e` (the tree that was live on both Vercel deployments and, for the contract,
code hash `HAxzQkJdB9fdJtVANeCrLr46ZZzy88VdLBD3pFE87pqZ` on `dmw-x8cx.testnet`). Three AI reviewers that did not
write the code each read one area from scratch (contract; keeper, agent, scripts and workflows; dashboard and site),
and only then read the earlier reviews. A second set of reviewers was asked to refute each new finding. This is
not a third-party audit.

- **Result:** 1 Critical (new, in the contract), 3 Medium, 14 Low. Nothing was found in the site.
- **Fixed in this pass:** the Critical, all three Mediums and 11 of the Lows, each with a regression test where the
  code allows one. Three contract Lows are documented and left for after the hackathon.
- **Tests after the fixes:** contract 105 (was 104), keeper 90 (81), dashboard 99 (88), agent 61 (60).
  `cargo clippy --target wasm32-unknown-unknown -- -D warnings` and `cargo fmt --check` are clean.
- **Deployment:** the contract fix changes no stored layout, so the live contract can be upgraded in place. The
  fixed build is committed as `contracts/release/dmw.wasm`, code hash
  `6s9oqxvBZfhWncW6irGH6zXTebeYUKTHh1pk1WSDxjYH` (rustc 1.97.0, cargo-near 0.23.0; two separate clones gave the same
  hash). **Until it is deployed over `dmw-x8cx.testnet`, the live contract still has C-2.** The status line in the
  README row "The live contract is this source" says which code is live.

## Summary

| ID | Severity | Where | Title | Status |
| --- | --- | --- | --- | --- |
| C-2 | Critical | contract | A vault's "DAO" can keep the step-4 bond and still have it credited back; `claim` then pays it out of other vaults' NEAR | Fixed in source and release build; live deploy pending |
| K-1 | Medium | keeper, dashboard | A malformed `from_address` stops settlement at step 3 for good; the hosted sweep then finds the same work on every run | Fixed |
| K-2 | Medium | keeper | A failed "did the old transaction land" lookup was read as "no", and the keeper re-signed (F-08 from the off-chain audit, still open then) | Fixed |
| D-1 | Medium | dashboard | A pairing link silently replaced the pulse key already on a paired phone, for any contract | Fixed |
| K-3 | Low | keeper | An RPC reply with neither `result` nor `error` counted as a successful broadcast | Fixed |
| K-4 | Low | keeper | `--max-seconds` was a soft bound: no RPC call had a time limit | Fixed |
| K-5 | Low | keeper | `--token ""` meant every vault | Fixed |
| K-6 | Low | scripts | Keys from `.env` were exported to `npm ci` and `cargo`; the contract's full-access key was copied into `.env` | Fixed |
| K-7 | Low | workflows | `ci.yml` has no `permissions:` block and pins third-party actions by tag | Documented |
| A-1 | Low | agent | Tool arguments that are valid JSON but not an object crashed the loop, and the transcript was lost | Fixed |
| D-2 | Low | dashboard | The bundle contained the whole `import.meta.env`, including Vercel's system variables | Fixed |
| D-3 | Low | dashboard | The guest heartbeat stopped in a hidden tab, and the vault only waits a minute | Fixed |
| D-4 | Low | dashboard | A failed RPC read showed "No vault N" | Fixed |
| D-5 | Low | dashboard | near-api-js 6 error wording was not recognised; long errors overflowed a phone screen | Fixed |
| D-6 | Low | dashboard | A refresh during guest setup left a run that could never continue | Fixed |
| D-7 | Low | dashboard | The faucet call had no time limit; "Refused by the node" was shown for any error | Fixed |
| D-8 | Low | dashboard | Every route except `/pulse` loads the 7 MB chain-signature chunk before first paint | Mitigated (loading line); lazy import left for later |
| L-17 | Low | contract | A failed re-sign still raises the fee bar | Documented |
| L-18 | Low | contract | The agent's daily cap can be exceeded across a window boundary | Documented |
| L-19 | Low | contract | A Solana `to` address and amount are not validated when set | Documented |

## C-2: a failed DAO call credited the bond back although the "DAO" had kept it

**Where.** `contracts/dmw/src/lib.rs`, `on_dao_proposal`, `Err` branch (line 1067 at `0348a3e`). Step 4 debits
`DAO_BOND` (1 NEAR) from the vault, calls `add_proposal` on `dao_id` with that 1 NEAR attached, and chains
`on_dao_proposal`. On `Err` the callback did `v.balance += DAO_BOND`, on the assumption that a failed call means
NEAR refunded the deposit. `set_dao` accepts any account id.

**The flaw.** The callback sees the result of the promise that `add_proposal` *returns*, not of the `add_proposal`
receipt itself. A contract can accept the deposit (its receipt succeeds, so NEAR refunds nothing) and return a
promise that panics. The callback then gets `Err`, and the vault was credited 1 NEAR that never came back.

**Attack.** Anyone could do this, with no special access:

1. Deploy a contract whose `add_proposal` keeps the deposit and returns a promise that fails.
2. Create a vault with a 10-second interval, grace 0, 1.7 NEAR, and `set_dao` to that contract.
3. Wait, `poke`, run the five steps, and `claim` as the heir.

The vault pays the bond once and gets it back twice: once in the "DAO" account, once in the `claim`. The extra
1 NEAR comes out of the contract account's shared balance, which holds every vault's NEAR.

**Measured on testnet** (a private copy of the contract, `dmw-b1b7c2.testnet`, deployed from `0348a3e`; the live
contract was not attacked). An honest vault with 3 NEAR was open on the same contract during the run.

| | Before the fix (vault 3) | After the fix (vault 4) |
| --- | --- | --- |
| Step 4 | [`dao_proposal_failed`](https://testnet.nearblocks.io/txns/CL1HB936rns732oyhVK4HG12bxzuXJ4V4XHKt1eJGzjG), vault balance back to 1.5 NEAR | [`dao_proposal_failed`](https://testnet.nearblocks.io/txns/4db5tJdLyzoDLgXJVxgqL64pDpRz6bRC2nmgpZr5XFnc), vault balance stays 0.5 NEAR |
| `claim` | [1.5 NEAR](https://testnet.nearblocks.io/txns/AVXk7eFp43BVT333NxUUHf3yD8GT1L3KZiF73wPgBrhp) | [0.5 NEAR](https://testnet.nearblocks.io/txns/7Yh9RNvFzUFur6cztWPXGr1rXZsZi7ygc2nQKWw1jMf2) |
| Attacker and its "DAO", net | +0.896 NEAR | -0.104 NEAR (storage fee and gas) |
| Contract balance not owed to any vault | 12.19 to 11.29 NEAR (-0.90) | 11.29 to 11.39 NEAR (+0.10, the storage fee) |

The fixed code was put on that contract by an in-place redeploy
([tx](https://testnet.nearblocks.io/txns/BRgV6DK6eHbvhhyuYZ8SsAexHCDK97sCNPDEaD3yhWYq)); the honest vault read back
unchanged afterwards (Alive, 3 NEAR, same owner). Three independent reviewers reproduced the loss on a local
near-sandbox node as well.

**Why earlier reviews missed it.** They traced refunds for plain `Transfer` and `AddKey` actions, where no
third-party code runs and a failure does mean a refund. The DAO call is the only place where a balance was
re-credited after a call into a contract the vault owner chooses. `docs/AUDIT_FINAL_CONTRACT.md` §6 ("No path
credits a vault twice") was wrong on this point.

**Fix.** The `Err` branch only logs `dao_proposal_failed`; nothing is credited. Regression test:
`step4_failed_dao_call_never_recredits_the_bond` (fails on the old code with 1.5 NEAR against 0.5). SPEC §2.7 and
the dashboard's record line were changed to match.

**Cost of the fix for honest owners.** When `add_proposal` really fails (a mistyped DAO account, a DAO whose policy
rejects the proposal), NEAR refunds the bond to the contract account and the vault no longer gets it, so the primary
heir's claim is 1 NEAR smaller. The refund sits in the contract's free balance, as a bond that Sputnik refunds
already does (M-4). A callback cannot tell a real refund from a staged failure, so this is the safe side.

**Other variants checked.** A "DAO" that returns something that is not a `u64` makes the callback panic; the vault
stays at step 5 with the bond debited, settlement continues, nothing is stolen. No other callback re-credits a
balance after a call into third-party code.

## Keeper, agent, scripts

- **K-1.** `from_address` is free text the owner writes (the contract only caps its length and never signs with it).
  The keeper passed it to `eth_getTransactionCount`; a value such as `yyyy` made the RPC answer `-32602`, the step-3
  arguments could not be built and `execute_step` was never sent. Anyone could park a `dmw-guest-*` vault that way and
  make the hosted sweep spend four minutes on it every ten. Now only `0x` plus 40 hex digits is used; anything else
  falls back to the derived address. The dashboard's in-browser keeper had the same line and has the same fix.
- **K-2.** `handleStale` did `txLanded(...).catch(() => false)`. For Solana, signing again while the old transaction
  may be on chain can pay an heir twice. A lookup error now parks the payout and the keeper looks again later.
- **K-3, K-4.** `rpc()` in `chains/evm.ts` and `chains/solana.ts` checked neither the HTTP status nor that the body
  had a `result`. A 429 with `{"message": ...}` made `broadcastEvm` return the locally computed hash and the keeper
  call `mark_broadcast` for a transaction no node had accepted. Non-OK status, a body that is not JSON-RPC and a
  missing `result` are now errors (a `null` result is still an answer). Every request has a 15-second limit.
- **K-5.** `--token ""` is refused, as `--owner-prefix ""` already was.
- **K-6.** `scripts/lib.sh` exports all of `.env` to what the scripts start. `npm ci` and the contract build now run
  with the key variables unset, and `deploy.sh` no longer writes `DMW_CONTRACT_KEY` (nothing read it; the key is in
  `keys/`, mode 0600). If you deployed with an earlier version, delete that line from your `.env`.
- **K-7 (open).** `ci.yml` relies on the repository's default token permissions and pins `gitleaks-action`,
  `rust-toolchain` and `rust-cache` by tag. Recommended after the hackathon: `permissions: contents: read` and
  commit SHAs. `keeper.yml` already has `contents: read` and uses first-party actions only.
- **A-1.** Both brain adapters turn non-object tool arguments into `{}`; `cli.ts` saves the transcript in a
  `finally` block.

Checked and found sound: the key masking in `keeper.yml` (the key is masked before it is exported and never
printed), the owner-prefix filter (checked against a fresh view before every action), the bounded sweep, the
webhook (URL from the environment only, redacted in logs, a failure never stops the keeper), and the agent wallet
(one money tool, policy pre-checks, the key never reaches a tool result or the transcript).

## Dashboard

- **D-1.** `/pulse#c=<contract>&t=<vault>&k=<key>` was stored on sight. A link sent to the owner replaced the key on
  their phone with one for any contract; the page said "Paired" and the real vault stopped receiving heartbeats.
  Now a link for another contract is refused, and one that would replace a different stored key asks first and
  names the vault that would go quiet. The address bar is cleared before the link is read.
- **D-2.** `config.ts` aliased `import.meta.env`, so Vite inlined the whole object: on Vercel that includes the last
  commit message, repository ids and deployment URLs. No secret was exposed. Each variable is now read statically.
- **D-3, D-6, D-7.** Guest run: the heartbeat fires as soon as a hidden tab is visible again (one send at a time)
  and the page says to keep the tab in front; an interrupted setup adopts the vault that `create_vault` made or
  starts a new vault or account; the faucet call has a 30-second limit; "Refused by the node" is shown only when
  the node refused.
- **D-4, D-5.** A failed RPC read says "could not be read" and retries; near-api-js 6 wording for a deleted key is
  recognised; long errors wrap.
- **D-8 (partly open).** The chain-signature library is in the first load of every route except `/pulse`. A loading
  line now shows until the script has loaded. Moving `lib/derive` behind a dynamic import is left for later.

Checked and found sound: no XSS from chain data (every chain string is rendered as text; the Will NFT image accepts
only `data:image/svg+xml`), no open redirect, the pairing secret travels only in the URL fragment with
`Referrer-Policy: no-referrer`, guest keys are testnet-only, amounts use BigInt throughout, and the live CSP on both
deployments matches what the pages load. `npm audit`: no critical; the highs are in the wallet-selector's
dependencies and are not reachable from this code (F-13).

## Contract Lows, documented

- **L-17.** `resign_foreign` stores the new fees before the MPC signature exists and does not restore them if the
  signature fails. After a failed re-sign at the fee cap no later re-sign can pass the 110% rule. No way was found
  for an attacker to force the MPC failure. Extends M-5.
- **L-18.** The agent's daily cap is a fixed 24-hour window. A full cap at the end of one window and another at the
  start of the next is twice the cap within seconds, and a transfer that fails in one window is refunded against
  the next window's counter. "Bounded by the daily cap" in the README means per window.
- **L-19.** `set_foreign_payouts` validates an EVM `to` address but not a Solana one, nor that a Solana amount fits
  in a `u64`. A typo is found only at step 3, where the payout is marked `failed` and cannot be re-signed. The
  dashboard's create form checks that the address has the base58 form (32 to 44 characters) before sending.

These need contract changes and were left out of this deploy to keep it to the one line that C-2 needs.

## Dependencies and secrets

- Rust: 286 crates in `Cargo.lock` checked against OSV. Three advisories, none in the contract build:
  `crypto-bigint` (timing, RUSTSEC-2026-0387) and `unsafe-libyaml` (unmaintained) are host-side only;
  `wee_alloc` (unmaintained, RUSTSEC-2022-0054) is pulled in by `near-sdk`.
- npm: keeper and agent 11 low (all `elliptic` through `near-api-js`; only ed25519 keys are used here); dashboard
  5 high, 5 moderate, 14 low, none reachable (F-13).
- Secrets: no key, token or webhook URL in any tracked file or in the history of all 50 commits. The one
  `ed25519:` private key in history is the well-known throwaway used for view calls (S-1 in
  `AUDIT_REPO_HYGIENE.md`), removed in `aa36d91`.

## What was not verified

The second-opinion pass ran out of budget before it reached the dashboard findings, A-1 and the three contract Lows.
Those were confirmed by the reviewer who reported them and, for everything marked Fixed, by the regression tests;
they did not get an independent refutation attempt. C-2, K-1, K-2, K-3, K-4, K-5 and K-6 did.
