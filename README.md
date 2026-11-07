# Dead Man's Wallet

**A NEAR contract that executes your estate plan — for humans and for AI agents.**
While you're alive, a key on your phone sends a heartbeat. If the heartbeats stop, the contract
pays your heirs on NEAR, deletes your AI agent's spending key, has NEAR's MPC network sign payouts
on Base and Solana, files a proposal in your estate DAO, and hands the Will NFT (which holds the
funds) to your primary heir. Heirs never touch a seed phrase.

Built at NEAR Hackathon, Nov 1–14 2026. Tracks: `security` (06 AI Security & Defense), `nfts` (10), `open` (13).
Testnet only. Not a will, not a custodian, not audited. MIT license.

Live contract: [`dmw-x8cx.testnet`](https://testnet.nearblocks.io/address/dmw-x8cx.testnet) ·
Smoke run with 22 explorer links: [`contracts/TESTNET_SMOKE.md`](contracts/TESTNET_SMOKE.md) ·
Chain Signatures proof: [`docs/chainsig-notes.md`](docs/chainsig-notes.md) ·
Security review: [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md)

## The problem

Agents hold wallets, API budgets and treasuries. When their operator dies, loses access or is
incapacitated, the agent keeps spending until it runs dry and anything it held on other chains is gone.
Existing dead-man's switches move a key or a file on one chain. None can disarm an agent or settle an
estate across chains from one contract.

## Run it in 5 minutes (testnet)

Prerequisites: Rust (stable) with the `wasm32-unknown-unknown` target, Node 22, and either
`near-cli-rs` or nothing at all (the scripts fall back to a bundled Node tool). Everything else is
installed by the scripts. `make check` prints the exact fix for anything missing.

```bash
git clone <repo> deadmans-wallet && cd deadmans-wallet
make check          # do: verify toolchain       -> see: "All good."
make build          # do: build the contract      -> see: contracts/dmw/target/wasm32-unknown-unknown/release/dmw.wasm
make test           # do: run unit tests          -> see: "test result: ok. 6x passed" and "35 passed" (keeper)
make deploy         # do: faucet account + deploy -> see: "deployed dmw-xxxx.testnet", written to .env
make demo           # do: full live demo          -> see below
```

`make demo` creates faucet accounts (owner, two heirs, an API provider), creates a vault with a 60-second
heartbeat and grace of 1, adds a **pulse key** (can only call `heartbeat`) and an **agent key** (can only
call `agent_pay`), runs the agent demo (one payment allowed, one denied with its reason), then starts the
pulse daemon and the keeper in the background. You will see:

```
vault #N created   https://testnet.nearblocks.io/txns/...
pulse key added    (scoped to heartbeat)    agent key added (scoped to agent_pay)
agent_pay ALLOWED  0.3 NEAR -> dmw-api-....testnet
agent_pay DENIED   over_per_tx_max
pulse: alive · next beat in 60s
dashboard: http://localhost:5173/vault/N      (cd dashboard && npm run dev)
```

Then:

```bash
make kill           # do: stop the pulse = the owner disappears
```

and watch the keeper log (`.demo/keeper.log`) go:

```
poke        vault N -> Triggered, bounty paid      https://testnet.nearblocks.io/txns/...
step 1      heirs paid: dmw-sarah 1.29 NEAR, dmw-ben 0.86 NEAR
step 2      pulse + agent keys deleted from dmw-xxxx.testnet
step 3      Base Sepolia tx signed by v1.signer-prod.testnet  (relay needs the derived address funded)
step 3      Solana devnet tx signed by v1.signer-prod.testnet
step 4      Sputnik proposal #id   (skipped if no DAO set)
step 5      Will NFT -> primary heir, state Settled
```

`make status TOKEN=N` prints the vault at any time. No wallet extension is needed for any of this.

## What you can check without running anything

| Claim | Where to look |
| --- | --- |
| The pulse key can only call `heartbeat`, the agent key only `agent_pay` | `view_access_key_list dmw-x8cx.testnet` — `FunctionCall` permission, `method_names` |
| Denied agent payments are logged, not reverted | `agent_pay` returns `{allowed:false, reason}`; the tx succeeds; see TESTNET_SMOKE.md item 5 |
| Settlement deletes the keys | TESTNET_SMOKE.md item 8, key list before/after |
| The contract itself requests MPC signatures | `docs/chainsig-notes.md`: NEAR txs where `dmw` calls `v1.signer-prod.testnet.sign`, with `ecrecover` matching the derived Base address |
| The Will NFT holds funds and redraws itself | `nft_token {"token_id":"4"}` → `media` is an on-chain SVG data URI (grey, Settled) |

## How NEAR fits (and why this can't be built elsewhere)

- **Function-call access keys.** NEAR accounts hold many keys, each scoped to one contract and a list of
  methods. The contract adds the pulse and agent keys to *its own* account, scoped to `heartbeat` /
  `agent_pay`, and deletes them at settlement. A stolen phone can only say "alive"; a compromised agent can
  only spend inside its policy; neither can touch the plan.
- **Chain Signatures.** The contract calls `v1.signer-prod.testnet.sign` with the hash of an EIP-1559
  Base transaction (secp256k1, domain 0) and the bytes of a Solana transfer (ed25519, domain 1). The
  foreign source addresses are derived from the contract account + a per-vault path, so no key for them
  exists anywhere, and no signature exists until the trigger fires. Transactions are built in-contract
  with `omni-transaction`.
- **NEP-171 + on-chain SVG.** The will is a token the contract owns the balance of; its image is
  computed from state (green / amber / red / grey) at read time.
- **Sputnik DAO.** Step 4 files a `FunctionCall` proposal in the estate's DAO so a council can ratify.
- **Permissionless keepers.** `poke` and `execute_step` are callable by anyone and pay a bounty; the
  keeper only supplies nonce/gas/blockhash for foreign chains, never destinations or amounts.

## Security model

| Party | Can | Cannot |
| --- | --- | --- |
| Pulse key (phone / agent loop) | call `heartbeat` on this contract, ≤ 1 NEAR of gas | move funds, add keys, change the plan |
| Agent key | call `agent_pay` within per-tx cap, daily cap and allowlist while the vault is `Alive` | exceed policy, pay once the vault is in `Warning`, extend the owner's life |
| Owner (NFT holder) | edit plan, add/remove keys, heartbeat, transfer the NFT while alive | act after `Triggered` |
| Anyone / keeper | `poke` after the deadline, `execute_step`, relay signed foreign txs, `mark_broadcast` | change heirs, amounts, destinations; block settlement |
| Estate DAO | execute the ratification call the proposal names | anything else on the vault |
| Contract | hold the plan, request MPC signatures, delete its own keys | sign for a foreign chain before `Triggered` |

Full findings and what was fixed: [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md).

## Repository

| Path | What |
| --- | --- |
| `contracts/dmw` | the contract (Rust, near-sdk 5), unit tests, `build.sh` |
| `contracts/chainsig-probe` | minimal contract used to prove the MPC round trip first |
| `keeper/` | TypeScript CLI: `pulse`, `keeper`, `agent-demo`, `derive`, `dao create`; `src/chains/` for Base/Solana |
| `dashboard/` | Vite + React app: create vault, live Will NFT, agent log, keys, settlement timeline, heir view |
| `site/` | public landing page |
| `scripts/` | `near-admin.mjs` (faucet/deploy/call without near-cli), `demo.sh`, `kill.sh`, `deploy.sh` |
| `docs/` | Chain Signatures notes, security review |
| `SPEC.md` | the interface every component was built against |

## Libraries, templates and AI-generated code

near-sdk-rs 5, near-contract-standards, omni-transaction 0.5, near-api-js 6, chainsig.js (derivation
reference), wallet-selector 10, Vite, React, Tailwind, vitest. No template was used.
Most of the code was written by Claude (Anthropic) under the direction of Andrew Garretson, who set the
product, architecture decisions and reviews; all of it was written in the hackathon window
(repo created Nov 7 2026). Baseline code: none. Tag `hackathon-submission` marks the submitted tree.
The author leads no other hackathon project.

## Limits and what's next

- Testnet only; two foreign chains; relaying needs the derived addresses funded (faucets require a human).
- Not a legal instrument. The product configures alongside a will or trust; see the FAQ on the site.
- Next: guardian pause, owner notifications at `Warning`, trust-owned vaults, heir sign-in with NEAR Auth
  (Google), Shade Agent attestation for the heartbeat, audit, mainnet.

## License

MIT — see `LICENSE`. Security contact: see `SECURITY.md`.
