# Judge dry run: reproducibility screen (2026-11-07)

A simulated AI judge that had never seen the project cloned it into an empty directory
(`git clone /home/claude/deadmans-wallet /tmp/judge/deadmans-wallet`, HEAD `bebbd22`) and followed
**only README.md** and the docs it links to. To mimic a stranger's machine it used a clean `$HOME`
(`/tmp/judge/home`), so there was no `~/.near-credentials`, no `.env` and no keys. Toolchain: rustc 1.97.0
with the wasm32 target, cargo-near 0.23.0, near-cli-rs 0.31.1, Node 22.23.4. The cargo registry cache was
warm, so the build times below are better than a cold machine would get.

Accounts created in this run: contract `dmw-judge-f950ee.testnet`, keeper `dmw-keeper-f4ee5c.testnet`,
owner `dmw-demo-owner-660edb.testnet`, heirs `dmw-demo-sarah-6328.testnet` / `dmw-demo-ben-6328.testnet`,
API `dmw-demo-api-6328.testnet`. Vault: token 1 on `dmw-judge-f950ee.testnet`.

## Verdict in one paragraph

Once the setup gaps were worked around, the core product is real. On fresh accounts it created a vault,
scoped the keys, allowed one agent payment and denied another, triggered, paid the heirs, deleted both keys,
had `v1.signer-prod.testnet` sign a Base Sepolia transaction and a Solana devnet transaction, and handed over
the Will NFT. I checked both signatures independently: the Base tx recovers to the derived source address,
and the Solana signature verifies against its derived key. My build of the contract has **the same code hash
as the live `dmw-x8cx.testnet`** (`6vhBR6hX…brnT`). **The documented path does not run, though.** On a fresh
clone `make test` fails, and `make deploy` exits at once with a usage error. It does not create a faucet
account and never writes `.env`. `make demo` then refuses to start until you write `.env` by hand and create
a keeper account yourself. Much of the demo and keeper output the README shows does not match what the
scripts print. Two of the four CI jobs fail when run locally. No foreign payout has ever landed on Base or
Solana, and the Sputnik step has never run live. An automated judge that stops at the first failed command
would mark this "does not run".

## Step-by-step log

| # | Command | README says | Actual | Time | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | `git clone <repo> deadmans-wallet` | clone | README gives a placeholder `<repo>` and no URL anywhere in the repo. I used the local path. | 1 s | PASS (but no URL) |
| 2 | `make check` | "All good." | Printed "All good." but also `.env MISSING -> cp .env.example .env` (there is no root `.env.example`). It never checks `keeper/node_modules`, `dashboard/node_modules`, `openssl` or the Node major version. | 0.6 s | PASS, misleading |
| 3 | `make build` | wasm at `contracts/dmw/target/wasm32-unknown-unknown/release/dmw.wasm` | cargo-near built `contracts/dmw/target/near/dmw.wasm` (442,789 B, sha256 bs58 `6vhBR6hX…brnT`). The README path also exists but is the 549 KB unoptimised intermediate. No warnings. | 65 s (warm cache) | PASS |
| 4 | `make test` | "76 passed" (contract) and "38 passed" (keeper) | Contract: **76 passed**. Keeper: **`sh: 1: vitest: not found`, make Error 127**, because `keeper/node_modules` does not exist and nothing installs it. | 97 s | **FAIL** |
| 4b | `cd keeper && npm ci` (my workaround, not in README) | — | 96 packages, 11 low-severity audit findings | 2 s | — |
| 4c | `make test` (re-run) | 76 / 38 | Contract 76 passed. Keeper **44 passed** (README says 38). `tsc --noEmit` clean. | 6 s | PASS (count stale) |
| 5 | `make deploy` | "faucet account + deploy -> deployed dmw-xxxx.testnet, written to .env" | `usage: ./scripts/deploy.sh <contract-account.testnet> [owner]`, make Error 1. No account was created and nothing was written. | 0 s | **FAIL** |
| 5b | `CREATE=1 ./scripts/deploy.sh dmw-judge-f950ee.testnet` (found by reading the script header) | — | The faucet account was created and the contract deployed with `new` called. `get_config` printed. It still did **not** write `.env`, and it printed no `deployed dmw-xxxx.testnet` line. The near-cli output links the old `explorer.testnet.near.org`. | 19 s | PASS (workaround) |
| 6 | `make demo` (no `.env`) | full live demo | `error: DMW_CONTRACT is not set in .env (see keeper/.env.example; create a keeper with: node scripts/near-admin.mjs create …)` | 0 s | **FAIL** |
| 6b | `node scripts/near-admin.mjs create dmw-keeper-f4ee5c.testnet` plus a hand-written `.env` (DMW_CONTRACT, KEEPER_ACCOUNT_ID, KEEPER_PRIVATE_KEY) | — | worked | ~10 s + reading | workaround |
| 7 | `make demo` | `vault #N created`, `agent_pay ALLOWED 0.3 NEAR`, `agent_pay DENIED over_per_tx_max`, `pulse: alive · next beat in 60s`, dashboard URL | Created 4 faucet accounts and vault 1 ([tx](https://testnet.nearblocks.io/txns/25526cTUpEQxTuW8Eu43afYH1xXRKe3QhVDvFGTW35MC)), both keys, foreign payouts, then **ALLOWED 0.05 NEAR** and **DENIED `receiver_not_allowlisted`** (not 0.3 / `over_per_tx_max`). The pulse beats every **20 s**, not 60 s. Pulse and keeper start in the background. Output lines differ from the README block (`== create vault …`, `result: "1"`, `result: true`). | 92 s | PASS (output differs) |
| 8 | wait ~30 s, read `.demo/pulse.log`, `.demo/keeper.log` | — | Heartbeats land every 20 s. The pulse log writes a countdown line **every second** (94 lines in 90 s). The keeper log has a single "watching" line. | 30 s | PASS |
| 9 | `make kill` | keeper log goes poke → steps 1–5 → Settled, "about 2–3 minutes" | Alive→Warning, poke ([tx](https://testnet.nearblocks.io/txns/CabwfWKzEhwB3PM7zaHNUHVcdmriLVpfDpGqnX1sgEtM)), steps 1–5, `Triggered → Settled`. The Base and Solana relays both report **NOT broadcast: source unfunded** (as the README warns). Log lines are `step vault 1 step 1/5 <link>` with no amounts, no "bounty paid", no "keys deleted" and no "signed by v1.signer-prod.testnet", so they do not match the README block. The keeper **keeps running** after Settled (`kill.sh` prints how to stop it; README does not). | **254 s** | PASS (slower, output differs) |
| 10 | `make status TOKEN=1` | prints vault | `Settled`, owner = heir sarah, balance 0.1 NEAR reserve, keys 0/0, both payouts `signed`. `TOKEN=99` gives a clean "vault 99 not found". | 4 s | PASS |
| 11 | `cd dashboard && npm ci && npm run build` | (dashboard README) | 401 packages, **24 audit findings (5 high)**. Build OK, but it produces **one 9.8 MB JS chunk** (2.34 MB gzip) and passes the warning limit even after `vite.config.ts` raised it to 2500 kB. There are direct-`eval` warnings from js-sha256. | 10 s + 7 s | PASS |
| 12 | `cd dashboard && npx vitest run` | — | 32 passed. (`make test` does not run these.) | 2 s | PASS |
| 13 | keeper offline mock (`DMW_MOCK=1 npm run mock -- init …`, `status`) | keeper/README | works | 2 s | PASS |
| 14 | CI jobs reproduced locally (`.github/workflows/ci.yml`) | — | keeper: **`npm error Missing script: "build"`**. contract: **`cargo fmt --check` gives 150 diffs**, and **`cargo clippy -- -D warnings` stops on near-sdk's `compile_error!("Use cargo near build…")`**. dashboard: OK. Gitleaks was not run. | 14 s | **FAIL (2 of 4 jobs)** |

**Wall-clock:** about 13 minutes of machine time (check 1 s, build 65 s, test 97+6 s, deploy 19 s, demo 92 s,
kill 254 s, plus status, dashboard and CI checks). A stranger also spends 5–10 minutes reading scripts to get
past steps 4, 5 and 6. The README's "Run it in 5 minutes" does not hold even on a warm cache.

## On-chain verification of the "check without running anything" table

All of these used raw testnet RPC calls (`view_access_key_list`, `call_function`, `EXPERIMENTAL_tx_status`).

| Claim | Check | Result |
| --- | --- | --- |
| Pulse key can only call `heartbeat`, agent key only `agent_pay` | `view_access_key_list dmw-x8cx.testnet` | **TRUE.** 1 FullAccess, 4 `FunctionCall{method_names:["heartbeat"]}`, 1 `["agent_pay"]`, all with receiver `dmw-x8cx.testnet`. **But** these are leftovers: vault 3 is stuck in `Triggered` at step 1 with 2.95 NEAR, and its pulse and agent keys are still live. Vaults 1 and 2 sit in `Warning`. One heartbeat key has a 0.00025 NEAR allowance left. A judge reading this key list sees un-settled vaults on the showcase contract. |
| Denied agent payments are logged, not reverted | my run, tx [HMaw3To…](https://testnet.nearblocks.io/txns/HMaw3ToCYND8jCXoU6A4YNFspuz7Fr9nyu7etViixoAz) | **TRUE.** The tx succeeded and returned `{"allowed":false,"reason":"receiver_not_allowlisted"}` with an `agent_pay_denied` event. |
| Settlement deletes the keys | my run, step 2 [Ar5fmTw…](https://testnet.nearblocks.io/txns/Ar5fmTwZFMKqLhgiKkMHoQ6sCFx39ebDE6Ash8D8StU) | **TRUE.** Two `DeleteKey` receipts from contract to itself. Afterwards `dmw-judge-f950ee.testnet` holds only its FullAccess key. |
| The contract itself requests MPC signatures | my run, step 3 [Aqxw9RB…](https://testnet.nearblocks.io/txns/Aqxw9RBGEVaUge1j8nzcavXucxuyrVSnhkgW1t6SK5T4) | **TRUE.** Receipt `dmw-judge-f950ee.testnet -> v1.signer-prod.testnet sign`, path `base-1`. I recovered the signed EIP-1559 tx (chain 84532, nonce 0, 0.0005 ETH to `0xcA02…5F2F`) to **`0x3c06f1b6…946e6d` = the derived source**. The Solana signature verifies (ed25519) against derived `Cp8acpry…pAM`. The README wording overstates one point: the *on-chain* `ecrecover` in `docs/chainsig-notes.md` is in the **probe** contract (`dmw-sig-4e3b1c65`). For `dmw` the recovery is off-chain (viem). |
| Will NFT holds funds and redraws itself | `nft_token {"token_id":"4"}` on dmw-x8cx | **TRUE.** `media` is a base64 SVG data URI (970 B) in grey `#7f8c8d`, text "Settled", owner `dmw-heir-cdeb.testnet`. |
| Smoke run with 22 explorer links | `contracts/TESTNET_SMOKE.md` | Present. It has 21 unique nearblocks tx links and 23 URLs in total, so "22" is wrong either way. Items 5 and 8 are there as cited. |
| Chain Signatures proof | `docs/chainsig-notes.md` | Present, detailed, and the tx links resolve. |
| Live run / showcase | `keeper/LIVE_RUN.md`, `keeper/SHOWCASE.md` | Present. Both say the foreign payouts were *signed, not broadcast*. |
| Foreign payouts ever landed | Base Sepolia `eth_getBalance` / `eth_getTransactionCount`, Solana `getBalance` on every derived source (`0x2cC6…28f4`, `0xcA02…5F2F`, `0x3C06…6e6d`, `5iue…pzc`, `CFdW…ZQUr`) | **No.** Every balance is 0 and every nonce is 0. No Base or Solana transfer has ever been relayed. |
| Sputnik step | grep of all docs | **Never run live.** No proposal tx exists anywhere. Every run logs `step_4 no dao; skipped`. |
| Live contract = this source | `view_account.code_hash` | **MATCH.** `dmw-x8cx.testnet` and my fresh deploy are both `6vhBR6hXfSWPAca9ZJ96sjyopt1pgvDQRhEBNam1brnT`. `contract_source_metadata` has `link:null` and `build_info:null`, so explorers cannot verify it. |

## Rough edges (harsh)

### Blockers: an automated judge fails the run here

1. **`make test` fails on a fresh clone.** `Makefile:19` runs `cd keeper && npm test` with no install, and
   README:29 says "Everything else is installed by the scripts". Nothing installs it.
2. **`make deploy` cannot create a new account and never writes `.env`.** README:37 promises "faucet account +
   deploy … written to .env". In fact `scripts/deploy.sh:23` exits with a usage error when there is no
   argument or `DMW_CONTRACT`. Creation is gated behind an undocumented `CREATE=1` (`scripts/deploy.sh:31`).
   No line of the script writes `.env`, and the `Makefile:21` help text says "to the account in .env". The
   brief's test, "must not require any pre-existing .env", fails.
3. **`make demo` needs a keeper account and `.env` that no documented step creates.** `scripts/demo.sh:22-24`
   dies on a missing `KEEPER_ACCOUNT_ID`/`KEEPER_PRIVATE_KEY`, and `scripts/demo.sh:25` dies on a missing
   `keeper/node_modules`.
4. **CI is red.** `.github/workflows/ci.yml` keeper job runs `npm run build`, but `keeper/package.json:13-24`
   has no `build` script. The contract job runs `cargo fmt --check` (150 diffs) and plain `cargo clippy`,
   which near-sdk 5.30 refuses to compile on the host. Judges who open the Actions tab will see red X's next
   to "Tests: 76 passed".

### README says one thing, the scripts do another

5. README:28-30 says cargo-near is not needed at all and near-cli-rs is optional ("or nothing at all").
   `scripts/check.sh:13-14` treats both as hard requirements and exits 1. Separately, the no-near-cli path of
   `scripts/deploy.sh:33` still calls `near account create-account`. `openssl` (used by `scripts/demo.sh:35,38`)
   is not listed.
6. README:35 build path: with cargo-near the deployed artefact is `target/near/dmw.wasm`. The path printed in
   the README is the unoptimised intermediate.
7. README:36 says "38 passed" for the keeper; the actual count is 44. `keeper/README.md:9` also says 38. The 32
   dashboard tests are not mentioned and not run by `make test`.
8. README:46-53 demo output: it shows `0.3 NEAR` and `over_per_tx_max`, a `vault #N created` line and
   `next beat in 60s`. The script sends 0.05 NEAR, gets denied with `receiver_not_allowlisted`, prints
   `result: "1"`, and beats every 20 s (`scripts/demo.sh:62` `--interval 20`).
9. README:63-71 keeper log: it shows heir amounts, "bounty paid", "keys deleted" and "signed by
   v1.signer-prod.testnet". The real lines are `step vault 1 step N/5 <link>`. The amounts (1.29/0.86) come
   from the 5 NEAR smoke run; this demo pays 1.08/0.72.
10. README:52 and `scripts/demo.sh:84` print `http://localhost:5173/vault/N`, but the dashboard defaults to
    `dmw-x8cx.testnet` (`dashboard/src/config.ts:5`, `dashboard/.env.example:2`). A judge who follows the hint
    sees **a different vault** (x8cx vault 1, stuck in Warning), not the one they just created. The root
    README never mentions `VITE_DMW_CONTRACT`.
11. README:58-61: `make kill` blocks for about 4 minutes (254 s here, README says 2–3) and leaves the keeper
    running. No `make stop`/`make clean-demo` target exists.
12. README:15: "22 explorer links" is wrong (21 tx links / 23 URLs).
13. README:82: "ecrecover matching the derived Base address" refers to the probe contract, not `dmw`.
14. README:137: "Tag `hackathon-submission` marks the submitted tree", but **no tags exist**.
15. README:5-6 headline: "has NEAR's MPC network sign payouts on Base and Solana" is true as worded, but no
    foreign payout has ever been broadcast. The proof is "the node said insufficient funds". One funded relay
    on each chain would remove the caveat.
16. README:98 lists Sputnik as a NEAR integration, but step 4 has never run on testnet. Its "ratification" is a
    `mark_broadcast("dao-ratified")` no-op (SPEC.md:172).
17. README:104-111 security model: the table leaves out the most powerful party, **the contract account's
    FullAccess key**, which can redeploy and drain every vault. `docs/SECURITY_REVIEW.md:294` flags this as
    I-1. A security-track judge will treat "neither can touch the plan" as overstated unless that row is there.
18. README:4 / `site/index.html:102`: "a key on your phone", "Miss one and we text you. A guardian can pause it."
    There is no phone client (the pulse is a Node daemon). Notifications and guardian pause are listed as
    **Next** in README:144. The landing page presents unbuilt features as current.
19. `SECURITY.md:5`: "Report … to the maintainer (see README)", but the README has no contact. The reference
    is circular.
20. `scripts/check.sh:16`: points to `.env.example` at the repo root, which does not exist (only
    `keeper/.env.example`), and claims "make deploy does this for you" (it does not).

### Things that make a judge trust it less

21. **Commit history:** 20 commits, about 25,000 inserted lines, all between 03:59 and 05:41 on Nov 7
    (`git log`). The dashboard (7,596 lines) landed 4 minutes after the keeper (4,583 lines). An
    originality/"built during the hackathon" screen will read this as a bulk import. README:136-137 asserts
    the window but offers no evidence such as a work log, earlier scratch history or design-doc dates.
22. Live showcase contract hygiene: vault 3 is stuck in `Triggered` at step 1 with 2.95 NEAR and live keys, and
    vaults 1 and 2 are in `Warning`. The README tells judges to inspect exactly this account. Anyone can finish
    vault 3 by calling `execute_step`. The project should do it, or explain it.
23. Non-verifiable build: `cargo near build non-reproducible-wasm` (`contracts/dmw/build.sh:8`) leaves
    `contract_source_metadata.link` and `build_info` null. The code hash *does* match, but that is only
    visible by rebuilding locally.
24. The pulse log writes a countdown line every second to a file (`keeper/src/machine.ts:62`, as used by the
    pulse loop). In non-TTY mode it should print only on each beat.
25. The dashboard is a single 9.8 MB bundle and `vite.config.ts:7` silences the warning instead of splitting.
    npm audit reports 5 high-severity findings in the dashboard tree.
26. `Makefile:3-4` `-include .env` + `export` pushes `KEEPER_PRIVATE_KEY` into the environment of every make
    target, including `cargo`. This is minor, but a security-track reviewer notices it.
27. Keeper timestamps are UTC (`10:52:10`) while nearblocks and the local clock are in local time. Cosmetic.

## What is genuinely strong (keep it prominent)

- After the workarounds, the end-to-end flow on brand-new faucet accounts **worked first time**, and every
  claim on the NEAR side checked out on-chain.
- The contract builds to the **same code hash** as the live deployment.
- Both MPC signatures from a fresh run verify independently against the derived addresses.
- The keeper ended with more NEAR than it started with (10.04 NEAR afterwards), because the bounty covered its
  gas. That shows the permissionless keeper model working.
- `git status` was clean after the full run: `.env`, `keys/` and `.demo/` are all ignored.
- 76 contract tests, 44 keeper tests and 32 dashboard tests pass, and the offline mock mode works.

## Fixes needed (in priority order)

| # | File:line | Fix |
| --- | --- | --- |
| 1 | `Makefile:17-19` | Add an `install` step (`cd keeper && npm ci`) as a prerequisite of `test`, `demo` and `status`. Or have `check.sh` install it. |
| 2 | `scripts/deploy.sh:19-39` | With no argument and no `.env`: generate `dmw-<rand>.testnet`, create it through the faucet (near-cli if present, else `near-admin.mjs create`), create `dmw-keeper-<rand>.testnet` too, and **write `.env`** with DMW_CONTRACT, KEEPER_ACCOUNT_ID and KEEPER_PRIVATE_KEY. Print `deployed <acct>` at the end, as README:37 promises. |
| 3 | `scripts/deploy.sh:33` | In the no-near-cli branch, use `node scripts/near-admin.mjs create` and sign deploys with `keys/` rather than the legacy keychain. |
| 4 | `scripts/demo.sh:22-25` | If the keeper vars are missing, create the keeper and append to `.env` instead of dying. If `keeper/node_modules` is missing, run `npm ci`. |
| 5 | `.github/workflows/ci.yml` (keeper job) | Use `npm run typecheck` or add a `build` script to `keeper/package.json:13-24`. |
| 6 | `.github/workflows/ci.yml` (contract job), `contracts/dmw/src/*` | Run `cargo fmt` and commit. Run clippy as `cargo clippy --target wasm32-unknown-unknown` (or with `--features near-sdk/non-contract-usage` / `RUSTFLAGS=--cfg near`), and build with `cargo near build` instead of plain `cargo build`. |
| 7 | `README.md:28-30` | List the real prerequisites: cargo-near (or say it is optional and make `check.sh:13` a warning), near-cli-rs (same, `check.sh:14`), and openssl. Remove "everything else is installed". |
| 8 | `README.md:33` | Put the real repo URL in place of `<repo>`. |
| 9 | `README.md:35-36`, `keeper/README.md:9` | Change the path to `target/near/dmw.wasm`, the keeper count to 44, and mention the 32 dashboard tests. |
| 10 | `README.md:46-53`, `README.md:63-71` | Paste the **real** output of `make demo` / `make kill` (e.g. from this run). Or change `scripts/demo.sh:47,75` and the keeper log format to match what the README promises. The amounts and the denial reason must match. |
| 11 | `scripts/demo.sh:84`, `README.md:52` | Print `cd dashboard && VITE_DMW_CONTRACT=$C npm run dev`, or have demo.sh write `dashboard/.env.local`. |
| 12 | `README.md:15` | Change to "21 transaction links". |
| 13 | `README.md:82` | Say "the probe contract `ecrecover`s on-chain; for `dmw` the Base signature recovers off-chain to the derived address (viem)". Or add an on-chain check to `dmw`. |
| 14 | `README.md:137` | Create and push the `hackathon-submission` tag, or delete the sentence. |
| 15 | `README.md:5-6, 142` | Fund one Base and one Solana derived source and link a confirmed transfer on basescan/solana explorer. Until then, say "signs (relay pending funding)" in the headline. |
| 16 | `README.md:98` | Run step 4 once against a real `sputnik-v2.testnet` DAO and link the proposal. Or move Sputnik to "Next". |
| 17 | `README.md:104-111` | Add a row: "Contract FullAccess key (deployer): can redeploy code — testnet trust assumption, see SECURITY_REVIEW I-1; mainnet: remove key / DAO-gated upgrades". |
| 18 | `site/index.html:102` | Remove "we text you" and "guardian can pause", or mark them "coming". |
| 19 | `SECURITY.md:5` | Give an actual contact (email/handle). |
| 20 | `scripts/check.sh:16` | Point to `keeper/.env.example`, or add a root `.env.example`. Add checks for `keeper/node_modules`, `openssl`, `node --version` ≥ 22, and `cargo near --version`. |
| 21 | dmw-x8cx.testnet live state | Call `execute_step` on vault 3 until it is Settled, and `poke` vaults 1 and 2 (or explain them in TESTNET_SMOKE.md). This lets the key list judges inspect show only intended keys. |
| 22 | `contracts/dmw/build.sh:8`, `contracts/dmw/Cargo.toml` | Add `[package.metadata.near.reproducible_build]` and build with `reproducible-wasm` so NEP-330 `build_info`/`link` are populated and explorers can verify the code. |
| 23 | `README.md:136-137` | Add one line on how the work was done (e.g. "developed in a scratch workspace Nov 1–7 and committed in sequence on Nov 7") so the 1h42m history doesn't look like an import. |
| 24 | `keeper/src/machine.ts:62` (pulse loop) | When stdout is not a TTY, log only on beats. |
| 25 | `Makefile` | Add a `stop` target (`pkill -f 'src/cli.ts (pulse\|keeper)'`) and mention it after `make kill`. |
| 26 | `dashboard/vite.config.ts:7` | Code-split (manual chunks for wallet-selector / near-api-js) and run `npm audit fix` where it doesn't break anything. |

## Preliminary scores

| Criterion | Score | Why |
| --- | --- | --- |
| Runs as documented | **4 / 10** | Three of the seven documented commands fail on a fresh clone (`test`, `deploy`, `demo`) and CI is red. Everything works after about 10 minutes of reading scripts, but a reproducibility screen scores the documented path. |
| Does what README says | **7 / 10** | The core lifecycle is real and verified on-chain: scoped keys, the agent policy, trigger, heir payout, key deletion, in-contract MPC signing on two curves, NFT handover, and a matching code hash. Points off because no foreign transfer has ever landed, Sputnik never ran, and the shown output does not match. |
| Originality | **8 / 10** | Disarming an agent through its own scoped access keys, combined with cross-chain estate settlement from one contract, is a fresh angle. The bulk-commit history will cost credibility unless explained. |
| NEAR integration depth | **8 / 10** | The contract adds and deletes function-call keys on its own account, calls `v1.signer-prod.testnet` for secp256k1 and ed25519 with in-contract tx building, and implements NEP-171/177/181/297/330, a permissionless keeper with a bounty, and a cross-contract `derived_public_key`. Off for the unexercised DAO step and the unverifiable build metadata. |
| README clarity | **5 / 10** | The structure, the problem statement, the security table and the NEAR rationale are good. But the quick-start promises behaviour the scripts lack, the sample output is from a different run, test counts and link counts are stale, there is a placeholder clone URL and a missing tag, and the dashboard hint shows the wrong contract. |
| **Overall (unweighted)** | **6.4 / 10** | Fixing items 1–11 above (mostly scripts and README text, no contract changes) would probably lift "runs as documented" to 8–9 and README clarity to 8. |
