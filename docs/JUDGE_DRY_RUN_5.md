# Judge dry run 5: fresh clone after the fastnear RPC default and the leftover audit fixes (2026-11-07)

Re-runs the sequence from [`JUDGE_DRY_RUN_4.md`](JUDGE_DRY_RUN_4.md) with `NEAR_RPC` unset, so every script and the
keeper use the new default `https://rpc.testnet.fastnear.com` (the old `rpc.testnet.near.org` now answers `-429
DEPRECATED`). Setup: `git clone /home/claude/deadmans-wallet /tmp/judge5` at HEAD `e56fbf4`, no `.env`, `keys/` or
`.demo/`. Warm cargo registry and npm cache. Commands ran one after another, unattended. `/tmp/judge5` was deleted
afterwards.

Accounts created by this run: contract `dmw-9a7c76.testnet`, keeper `dmw-keeper-0c10e3.testnet`, owner
`dmw-demo-owner-a05dda.testnet`, heirs `dmw-demo-sarah-4ec6.testnet` / `dmw-demo-ben-4ec6.testnet`. Vault: token 1.

## Result: every step passed

| # | Command | Actual | Time | Result |
| --- | --- | --- | --- | --- |
| 1 | `git clone` | ok | 1 s | PASS |
| 2 | `make check` | "All good." | 1 s | PASS |
| 3 | `make build` | 461,245 B, code hash `5H5vWiKFX1tF13ujkmozuke1DcdNExqeLTg8jAbRYdux`, the same as the live `dmw-x8cx.testnet` | 50 s | PASS |
| 4 | `make test` | contract **104 passed**, keeper **51**, dashboard **70**, agent **41** (typechecks clean) | 107 s | PASS |
| 5 | `make deploy` | `deployed dmw-9a7c76.testnet`, `.env` written | 18 s | PASS |
| 6 | `make demo` | keys and foreign payouts set; **ALLOWED 0.0500 NEAR**, **DENIED `receiver_not_allowlisted`**; pulse and keeper started | 34 s | PASS |
| 7 | `make agent TOKEN=1` | 2 payments allowed (0.2 NEAR), 1 refused by the wallet wrapper, 0 errors, "No funds moved" | 8 s | PASS |
| 8 | `make kill` | Alive → Warning → Triggered, steps 1 to 5 (base and solana signed at step 3; relays "NOT broadcast: source … is unfunded", as documented), Settled, keys 0 pulse / 0 agent | 164 s | PASS |
| 9 | `make stop` | `stopped pulse/keeper` | 0 s | PASS |
| 10 | `git status --porcelain` | empty | n/a | PASS |

No manual step and no fix was needed. As in runs 3 and 4, `make agent` runs before `make kill` (settlement deletes the
agent key). Also run on the working tree: `cd dashboard && npm run build` passes; the inline-script hash in
`dashboard/vercel.json` still matches `dist/index.html`, and the one in `site/vercel.json` still matches
`site/index.html` (neither inline script changed).

Not covered here: a relay of a signed foreign tx (the derived source addresses are unfunded; faucets need a human
login), and the dashboard fallback source address for a payout with an empty `from_address` (covered by code and unit
tests of `capFees`, not by a live Execute click).
