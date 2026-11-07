# Judge dry run 2: fresh clone after the fixes (2026-11-07)

This re-runs the reproducibility screen from [`JUDGE_DRY_RUN.md`](JUDGE_DRY_RUN.md) after its fixes landed.
Setup: `git clone /home/claude/deadmans-wallet /tmp/judge2/deadmans-wallet` at HEAD `732de9f`, with a clean
`$HOME` (`/tmp/judge2/home`: no `~/.near-credentials`, no npm cache, no `.env`, no `keys/`). The cargo registry
was warm, as in run 1. Toolchain: rustc 1.97.0 + wasm32, cargo-near 0.23.0, near-cli-rs 0.31.1 (installed but
not used by any script), Node 22.23.4. The commands ran unattended from a script, one after another, exactly
as the README lists them.

Accounts created by this run: contract `dmw-929f0f.testnet`, keeper `dmw-keeper-5b0d92.testnet`, owner
`dmw-demo-owner-599c16.testnet`, heirs `dmw-demo-sarah-ce9d.testnet` / `dmw-demo-ben-ce9d.testnet`, API
`dmw-demo-api-ce9d.testnet`. Vault: token 1 on `dmw-929f0f.testnet`.

## Result: every documented command passed

| # | Command | Expected (README) | Actual | Time | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | `git clone … deadmans-wallet` | clone | ok | 0 s | PASS |
| 2 | `make check` | "All good." | All required tools ok; optional `wasm-opt` warned only. Reported `keeper deps` / `dashboard deps` "not installed yet (make test / make demo run npm ci for you)" and `.env` "not yet: make deploy … writes it" | 1 s | PASS |
| 3 | `make build` | `contracts/dmw/target/near/dmw.wasm` and its code hash | 442,829 B, code hash `7QtcNMuo…Qncy7` (local toolchain, see the note on hashes below) | 60 s | PASS |
| 4 | `make test` | contract 76, keeper 44, dashboard 32 | `npm ci` ran in keeper and dashboard by itself, then **76 passed**, keeper `tsc --noEmit` clean and **44 passed**, dashboard **32 passed** | 108 s | PASS |
| 5 | `make deploy` (no args, no `.env`) | creates `dmw-<rand>` + `dmw-keeper-<rand>`, deploy, init, `set_keeper`, writes `.env`, "deployed …" | Faucet created `dmw-929f0f.testnet`; [deploy](https://testnet.nearblocks.io/txns/9Ae2marnRES6RtucJeGB4emQxASQgG6f4wdmmLgdyJah), [`new`](https://testnet.nearblocks.io/txns/cfbFtS7GPkLkUdmGtLGEYuHgVRzZpJ2921dN5w8yUPd); faucet created `dmw-keeper-5b0d92.testnet`; [`set_keeper`](https://testnet.nearblocks.io/txns/HrqLkproRSt5WGpqg2t7PD8oVfBbUaLXWt59po2isJr); `get_config.keeper` = the keeper; printed `deployed dmw-929f0f.testnet`. `.env` held NEAR_NETWORK, DMW_CONTRACT, DMW_CONTRACT_KEYFILE, DMW_CONTRACT_KEY, BASE_RPC, SOLANA_RPC, KEEPER_ACCOUNT_ID, KEEPER_PRIVATE_KEY | 54 s | PASS |
| 6 | `make demo` | output block in the README | Same lines as the README block (account names and hashes differ): 4 faucet accounts, [create_vault](https://testnet.nearblocks.io/txns/DwByBzE1Ye4roLrYXSDDnLMwzAccjZE1EtihwJSHPFm2) `result: "1"`, both keys `true`, foreign payouts set, **ALLOWED 0.0500 NEAR**, **DENIED `receiver_not_allowlisted`**, pulse and keeper in the background, dashboard hint naming `dmw-929f0f.testnet` (written to `dashboard/.env.local`) | 94 s | PASS |
| 7 | wait 35 s, read `.demo/pulse.log` | one line per beat | header plus 4 beat lines in 35 s, each `♥ heartbeat sent <link> · alive · next beat in 8s`. No per-second countdown lines (the whole run wrote 6 lines) | 35 s | PASS |
| 8 | `make kill` | keeper log poke → steps 1–5 → Settled, about 4 min | Alive → Warning, [poke](https://testnet.nearblocks.io/txns/Bq8gvNkXnWgscnPARtTHKfYXFqagnWAAt11rU3L7GXAP), [step 1](https://testnet.nearblocks.io/txns/DYc9Nie2atgPcZfRAfdQJueQVZkwem5D1ayXKbSTPoE6), [2](https://testnet.nearblocks.io/txns/5gF45kTyeTbZNs5wpxkVXJGnCnCKPYoPU3XM6nVmfAv4), [3 base](https://testnet.nearblocks.io/txns/EPHH3pr5CuXKbQphmqvYhcyDZqK7Dp5xF7XttXUqGc68), [3 solana](https://testnet.nearblocks.io/txns/8UuwzVKVGES4y5Q8x3SmPtvza3Zr4A9SKQndmEESpF3Q), [4](https://testnet.nearblocks.io/txns/9fdPwmErZA3U9f5sFHL81yE5exWL2pGUmRVv28dhLczM), [5](https://testnet.nearblocks.io/txns/9cbFfqdkJWr6MNbvfe5FBK9SQL8TjDZMvdUHT6Dtff2N), `Triggered → Settled`. Both relays report "NOT broadcast: source … is unfunded", as the README says. Ends with "stop it with make stop" and the vault status | 248 s | PASS |
| 9 | `make status TOKEN=1` | prints the vault | `Settled`, owner = heir sarah, 0.1 NEAR reserve, keys 0/0, both payouts `signed` | 3 s | PASS |
| 9b | `make status TOKEN=99` | clean error | `error: vault 99 not found on dmw-929f0f.testnet` (make exits non-zero) | 4 s | PASS |
| 10 | `make stop` | stops pulse/keeper | `stopped pulse/keeper`; no `cli.ts` process left | 0 s | PASS |
| 11 | `git status --porcelain` | clean | empty: `.env`, `keys/`, `.demo/`, `dashboard/.env.local` are all ignored | — | PASS |

After settlement, `view_access_key_list dmw-929f0f.testnet` returns only the deployer's FullAccess key: step 2
deleted the pulse and agent keys.

**Wall-clock:** about 10 minutes of machine time (build 60 s, test 108 s, deploy 54 s, demo 94 s, kill 248 s).
Nothing had to be read or worked around: zero manual steps between the commands.

## CI, reproduced locally

On a separate fresh clone, with the same commands as `.github/workflows/ci.yml`:

| Job | Commands | Result |
| --- | --- | --- |
| contract | `cargo fmt --check`; `cargo clippy --locked --target wasm32-unknown-unknown --release -- -D warnings`; `cargo test --locked`; `./build.sh` (with cargo-near, and with cargo-near hidden from `PATH` to take the CI fallback) | PASS (fmt clean, no clippy warnings, 76 passed, both build paths produce a wasm) |
| keeper | `npm ci`; `npm run typecheck`; `npm test` | PASS (44 passed) |
| dashboard | `npm ci`; `npm test`; `npm run build` | PASS (32 passed; the large-bundle warning from run 1 item 25 remains, see below) |
| secrets | gitleaks (`zricethezav/gitleaks:latest git`) over all commits | PASS after adding `.gitleaksignore` for one false positive (two **public** keys printed in `contracts/TESTNET_SMOKE.md`) |

## Live contract and code hashes

- `dmw-x8cx.testnet` was redeployed (code only, state kept) from `cargo near build reproducible-wasm` at commit
  `88cd83b`: code hash `G6eiYJj6gkVt4QaJPHYBQz4eov4fU5ihwsUFqSog25hM`. A second reproducible build in a separate
  clone of `88cd83b` gave the same hash. `contract_source_metadata` now returns `link`
  (`https://github.com/agarretson/deadmans-wallet/tree/88cd83b…`) and `build_info` (image
  `sourcescan/cargo-near:0.23.0-rust-1.99.1@sha256:8013f0…`, command, path, snapshot).
- A plain `make build` uses the local toolchain and embeds no `build_info`, so it gives a different hash
  (`7QtcNMuo…` here). The README says so and gives the command that reproduces the live hash.
- Note for whoever repeats the Docker build in this sandbox: the sandbox reaches the internet only through a
  proxy on 127.0.0.1, so the container was started through a local `docker` shim that adds `--network host` and the
  proxy CA. That changes how crates are downloaded, not the build inputs. On a normal machine
  `make build-reproducible` needs no shim.
- `view_access_key_list dmw-x8cx.testnet` now returns only the FullAccess key. Vaults 1–3 are settled (links in
  TESTNET_SMOKE.md). Showcase vault 6 is untouched: Alive, no keys, payouts pending.
- Sputnik step 4 ran live on vault 10: proposal 0 on `estate-82bd1f.sputnik-v2.testnet`, filed by the contract and
  approved and executed by the council (links in TESTNET_SMOKE.md and the README).

## Status of the 26 fixes from run 1

| # | Fix | Status |
| --- | --- | --- |
| 1 | install deps before test/demo/status | done (Makefile dep targets + `ensure_deps` in scripts) |
| 2 | zero-state `make deploy` writes `.env` | done |
| 3 | no near-cli in the deploy path | done (near-admin.mjs for create, deploy, init and calls) |
| 4 | `make demo` creates a keeper / installs deps instead of dying | done |
| 5 | keeper CI job | done (typecheck + test) |
| 6 | contract CI job (fmt, clippy, build) | done |
| 7 | real prerequisites; optional tools only warn | done |
| 8 | real clone URL | done (`https://github.com/agarretson/deadmans-wallet`) |
| 9 | wasm path, test counts | done (target/near/dmw.wasm, 76/44/32) |
| 10 | real demo/kill output in the README | done (pasted from a fresh-clone run; this run prints the same lines; only names, hashes, pids and timestamps differ, and the README shortens the two result objects) |
| 11 | dashboard points at the demo contract | done (`dashboard/.env.local` + hint) |
| 12 | link count | done (21 transaction links) |
| 13 | ecrecover wording | done |
| 14 | `hackathon-submission` tag | sentence now says the tree **will** be tagged at submission (tag not created yet) |
| 15 | fund a Base and a Solana source and link a confirmed transfer | **not done, needs a human** (faucets require a login); headline says "signed; relay pending funding" |
| 16 | run Sputnik step 4 live | done (vault 10, proposal 0, approved and executed) |
| 17 | deployer FullAccess row in the security table | done |
| 18 | landing page marks unbuilt features | done ("coming soon" on reminders, guardian pause, phone app) |
| 19 | SECURITY.md contact | done (security@deadmanswallet.dev + GitHub issues) |
| 20 | check.sh `.env.example`, deps, openssl, node ≥ 22, cargo-near | done (root `.env.example` added) |
| 21 | showcase contract hygiene | done |
| 22 | reproducible build metadata | done, and x8cx redeployed with it |
| 23 | one line on how the work was done | done |
| 24 | pulse logs once per beat without a TTY | done |
| 25 | `make stop` | done |
| 26 | dashboard code-split / npm audit | **not done (optional)**: still one ~9.8 MB chunk |

Rough edges from run 1 that were not in the fix table: keeper timestamps are still UTC (the README now says so).
`make kill` still blocks for about 4 minutes, which the README states.

## Remaining for a human

- Fund one Base Sepolia and one Solana devnet derived source (for example vault 6's, listed in
  `keeper/SHOWCASE.md`) so a relayed transfer can be linked (fix 15).
- Push the repo to the URL in `Cargo.toml` `repository` (`github.com/agarretson/deadmans-wallet`). Explorers can only
  verify the live build once commit `88cd83b` is public there. If the URL changes, update `repository` and
  rebuild with `make build-reproducible`, then redeploy x8cx.
- Create the `hackathon-submission` tag at submission.
