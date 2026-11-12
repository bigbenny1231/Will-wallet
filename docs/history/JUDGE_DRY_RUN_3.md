# Judge dry run 3: fresh clone after Monad, guardian pause, agent and PWA (2026-11-07)

Re-runs the sequence from [`JUDGE_DRY_RUN_2.md`](JUDGE_DRY_RUN_2.md) on the tree that adds the Monad payout path in
the keeper loop, the agent job in CI, and the doc refresh. Setup: `git clone /home/claude/deadmans-wallet /tmp/judge3`
at HEAD `4b3e926`, no `.env`, `keys/` or `.demo/`. The cargo registry and npm cache were warm and `$HOME` was the
normal one (not a clean one as in run 2). The commands ran one after another, unattended.

Accounts created by this run: contract `dmw-404e3c.testnet`, keeper `dmw-keeper-297a90.testnet`, owner
`dmw-demo-owner-a86400.testnet`, heirs `dmw-demo-sarah-54a4.testnet` / `dmw-demo-ben-54a4.testnet`. Vault: token 1.

## Result: every step passed

| # | Command | Expected | Actual | Time | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | `git clone` | clone | ok | 1 s | PASS |
| 2 | `make check` | "All good." | All required tools ok; `wasm-opt` warned only | 2 s | PASS |
| 3 | `make build` | wasm + code hash | 460,484 B, code hash `BE7ZZrGs…Jkfyr` (the hash of the redeploy recorded in TESTNET_SMOKE.md for this source) | 56 s | PASS |
| 4 | `make test` | contract 95, keeper 46, dashboard 67, agent 37 | **95 passed**; keeper typecheck clean, **46 passed**; dashboard **67 passed**; agent typecheck clean, **37 passed** | 119 s | PASS |
| 5 | `make deploy` | accounts, deploy, init, `set_keeper`, `.env` | `deployed dmw-404e3c.testnet`, `.env` written | 56 s | PASS |
| 6 | `make demo` | allowed + denied agent payment, pulse and keeper in the background | **ALLOWED 0.0500 NEAR**, **DENIED `receiver_not_allowlisted`**, pulse and keeper started | 95 s | PASS |
| 7 | `make agent TOKEN=1` (run here, while the vault is Alive; see note) | scripted brain: two invoices paid, injection refused | 5 steps, 2 payments allowed by the contract (0.2 NEAR), 1 refused by the wallet wrapper (`receiver_not_allowlisted`), 0 errors, "No funds moved". Transcript saved to `.demo/agent-transcript.md` | 44 s | PASS |
| 8 | `make kill` | poke, steps 1 to 5, Settled | Warning → Triggered, steps 1 to 5 (base and solana signed at step 3, both relays "NOT broadcast: source … is unfunded", as documented), `Triggered → Settled`, keys 0 pulse / 0 agent | 244 s | PASS |
| 9 | `make agent TOKEN=1` after `make kill` | clear failure | exit 2: `access key … doesn't exist` (settlement deleted the agent key) | 3 s | PASS (expected failure) |
| 10 | `make stop` | stops pulse/keeper | `stopped pulse/keeper` | 0 s | PASS |
| 11 | `git status --porcelain` | clean | empty | n/a | PASS |

Note on step 7: the task listed `make agent` after `make kill`. After settlement the agent key no longer exists (step 2
deletes it), so the agent can only run while the vault is Alive. It was run before the kill (7) and, to document the
other order, again after it (9). The README's instructions run `make agent` after `make demo`.

**Wall-clock:** about 11 minutes of machine time (build 56 s, test 119 s, deploy 56 s, demo 95 s, agent 44 s,
kill 244 s). Nothing needed fixing and no manual step was needed between the commands.

## Not covered by this run

- `make demo` creates one Base and one Solana payout. The Monad path in the keeper loop is covered by unit tests
  (mock vault with a `monad` payout: `evmParams(from, 'monad')`, `broadcastEvm(raw, 'monad')`, 1000 gwei cap,
  explorer link) and by the live contract run in [`contracts/TESTNET_SMOKE.md`](TESTNET_SMOKE.md) (vault 14, step 3
  signed on `monad-14`). A live keeper relay of a Monad payout needs the derived address funded, and was not done.
- Docker reproducible build, dashboard dev server and the phone PWA were not part of this sequence.
