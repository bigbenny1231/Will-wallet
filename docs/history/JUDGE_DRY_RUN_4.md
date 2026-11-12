# Judge dry run 4: fresh clone after the 1-yocto change (review 2 M-6, 2026-11-07)

Re-runs the sequence from [`JUDGE_DRY_RUN_3.md`](JUDGE_DRY_RUN_3.md) after owner mutators and `pause` started requiring
exactly 1 yoctoNEAR (every caller in `scripts/` and `contracts/` now attaches it). Setup: `git clone
/home/claude/deadmans-wallet /tmp/judge4` at HEAD `f0178de`, no `.env`, `keys/` or `.demo/`. Warm cargo registry and
npm cache, normal `$HOME`. Commands ran one after another, unattended. `/tmp/judge4` was deleted afterwards.

Accounts created by this run: contract `dmw-82e1da.testnet`, keeper `dmw-keeper-9ba539.testnet`, owner
`dmw-demo-owner-d7a951.testnet`, heirs `dmw-demo-sarah-55cc.testnet` / `dmw-demo-ben-55cc.testnet`. Vault: token 1.

## Result: every step passed

| # | Command | Actual | Time | Result |
| --- | --- | --- | --- | --- |
| 1 | `git clone` | ok | 1 s | PASS |
| 2 | `make check` | "All good." | 2 s | PASS |
| 3 | `make build` | 460,419 B, code hash `13ug5kLS5oCUSHBjJ7P5sEJ7gANxaATHtHtfdDUZfsqU`, the same as the `dmw-x8cx.testnet` redeploy in [TESTNET_SMOKE.md](../contracts/TESTNET_SMOKE.md) | 53 s | PASS |
| 4 | `make test` | contract **99 passed**, keeper **46**, dashboard **68**, agent **37** (typechecks clean) | 104 s | PASS |
| 5 | `make deploy` | `deployed dmw-82e1da.testnet`, `.env` written | 55 s | PASS |
| 6 | `make demo` | `add_pulse_key`, `add_agent_key` and `set_foreign_payouts` with 1 yocto succeed; **ALLOWED 0.0500 NEAR**, **DENIED `receiver_not_allowlisted`**; pulse and keeper started | 95 s | PASS |
| 7 | `make agent TOKEN=1` | 5 steps, 2 payments allowed (0.2 NEAR), 1 refused by the wallet wrapper, 0 errors, "No funds moved" | 44 s | PASS |
| 8 | `make kill` | Alive → Warning → Triggered (poke), steps 1 to 5 (base and solana signed at step 3; relays "NOT broadcast: source … is unfunded", as documented), Settled, keys 0 pulse / 0 agent | 246 s | PASS |
| 9 | `make stop` | `stopped pulse/keeper` | 0 s | PASS |
| 10 | `git status --porcelain` | empty | n/a | PASS |

About 10 minutes of machine time. No manual step and no fix was needed. As in run 3, `make agent` runs before `make
kill` (settlement deletes the agent key).

Not covered here: `pause` and `set_guardian` are not part of `make demo`; their 1-yocto requirement is covered by the
unit test `m6_owner_mutators_and_pause_require_one_yocto` and the dashboard call tests. The live 0-deposit rejection was
checked on `dmw-x8cx.testnet` vault 6 (`set_timing`, see TESTNET_SMOKE.md).
