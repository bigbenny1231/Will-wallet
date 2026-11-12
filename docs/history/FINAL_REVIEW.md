# Final review and live tests (2026-11-10)

What was run against the public testnet and the two public deployments four days before the deadline, what it
found, and what is left to do. Everything here was run on commit `0348a3e` (master and both Vercel deployments at
the time) unless a line says otherwise. Explorer: `https://testnet.nearblocks.io/txns/<hash>`.

## Result

| # | Check | Result |
| --- | --- | --- |
| 1 | Guest run on the production dashboard, desktop (1280 px), from Begin to the heir's claim | PASS, 160 s, no console error. [Vault 22](https://will-wallet.vercel.app/vault/22) |
| 2 | Same run, iPhone 13 emulation | PASS, 158 s, no console error. [Vault 23](https://will-wallet.vercel.app/vault/23), 12 transactions below |
| 3 | `make demo` and `make kill` against the live contract `dmw-x8cx.testnet` | PASS. Vault 21: created, two keys, two payouts, one agent payment allowed and one denied, poke, five steps, claim |
| 4 | The MPC-signed Base transaction of vault 21, checked without the project's code | PASS. Recovered signer `0x94997c1b…9e63` equals the derived address; chain id 84532, nonce 0, recipient and amount equal the plan |
| 5 | Judge dry run: fresh clone, `make check build test attacks deploy demo kill` | PASS, every step exit 0. Build 52 s, tests 311 s (first `npm ci` and cargo fetch included), deploy 18 s, demo 35 s, kill 155 s |
| 6 | Code hash: fresh clone of `0348a3e`, rustc 1.97.0, cargo-near 0.23.0 | PASS. `make build` prints `HAxzQkJdB9fdJtVANeCrLr46ZZzy88VdLBD3pFE87pqZ`, the hash of `dmw-x8cx.testnet` |
| 7 | Hosted guest sweep (`.github/workflows/keeper.yml`) on a vault left alone on purpose | PASS. Vault 24 was settled by a scheduled run with a one-off account |
| 8 | Both deployments, 9 pages each at 1440 px and iPhone 13: console errors, failed requests, horizontal overflow | PASS, none |
| 9 | Every link on those pages | 4 fail: the GitHub links, because the repository is still private. Explorer links could not be checked from the test machine (403 to automated clients) |
| 10 | Security and bug review | 1 Critical, 3 Medium, 14 Low: [`SECURITY_REVIEW_3.md`](SECURITY_REVIEW_3.md) |
| 11 | Claims: every checkable statement in the README, SPEC, submission kit, component docs and site copy (818 checked) | 39 were wrong or stale and are corrected in the same commits as this file |
| 12 | After the fixes: fixed contract build on a private copy, all tests, `make demo`, `make kill`, and a guest run on the fixed dashboard | PASS (details below) |

Not done: no foreign payout has been relayed. The Solana devnet RPC faucet is closed (`requestAirdrop` answers 410),
and the Base and Monad faucets need a person. The signed transactions of vault 21 are on chain and stay valid for
Base until its fee cap is exceeded.

## Live contract runs

**Vault 21, `make demo` and `make kill`** (owner `dmw-demo-owner-ee54a7.testnet`):

| Step | Transaction |
| --- | --- |
| `create_vault` | `BWjUiYuCpsGgUkQP8oeRydx6rjDTUbXtkhgQJRwpDfFN` |
| `add_pulse_key`, `add_agent_key` | `2FSSRGYAS8aUeCYLo3rv49TkCDEjZpeXj8yU7WYZurJP`, `H8yBSYWfZnDiGMWbWf18KtnCtt4hhTSck8ww8Li3rkKc` |
| `set_foreign_payouts` | `6Rx2Py6gaHDPgrYNPo6iUjueeTNDbKCoRLX3hLm9AoKZ` |
| `agent_pay` allowed, 0.05 NEAR | `DAqC8rv3LYNVGjPbcbomgaQBbJuZM9eTEaFxG9da7tRs` |
| `agent_pay` denied, `receiver_not_allowlisted` | `F5REaV3kbHEDpd8jJ5bs4vxW7zFSHaL1Xhg8Vg34Zi8r` |
| `poke` | `4U6jtUuuc1LsP3Q3rGcwG13TAVpGqHbDPG7n6hGf4rGv` |
| Step 1, heirs paid 1.08 and 0.72 NEAR | `9PtycV4P8w9LyTbaCwbzZkrA3eeuQ5XGHYg8TyiC7xUZ` |
| Step 2, keys deleted | `5Zi6bxmtmagmaw5ocbemeE9DiHC9x5cF4pwvZBKor6rQ` |
| Step 3, Base signed by the MPC network | `JD64kzxBKKTNw7JregoHtasAQFTyxm5LmibDfpYgNTFA` |
| Step 3, Solana signed | `8fgVSFaT45qowhqStUKCLcvpgJbVfEWmh5fh4iJL7E7D` |
| Step 4, no DAO | `HZSY5sYxGWpNrdkjVA7L6zVBoWkHr7hAfTJT69xBKcFw` |
| Step 5, Will NFT to the primary heir | `7ZaVi1hCvrFLeuYuAHkU7QnZc9VL4speqNh1p3dm7KgY` |
| `claim`, 0.1 NEAR | `2HDmT5hJS7a9PdidYNAPAHzG2TED79zca7uDzukme2DV` |

Alive to Settled took 2 min 36 s from the last heartbeat (04:24:01 to 04:26:37 UTC). The heirs' accounts went from
10 to 11.08 and 10.72 NEAR. Both foreign payouts are `signed`; the relay was refused for lack of funds at
`0x94997c1B276F481dF08B7d194B25aD19069B9E63` (Base) and `73z73k5XtZtEqXJnytrWfSaY7JpSpcbUP1Tiy2HD1m28` (Solana).

**Vault 23, guest run on a phone-sized browser** (owner `dmw-guest-*`, every transaction signed in the browser):

| Step | Transaction |
| --- | --- |
| `create_vault` | `8N1qEPyFYaP47WXiWqdN2YKE148auSVNiWzncGZY7Ybk` |
| Pulse key, agent key, two payouts | `5uwd6RsLZqrNBTMYqGvBZLsi8vWqLkZF4Zkhv9eXhUvM` |
| `agent_pay` allowed | `CMeLpZK95FDkpgqS84X9dowdFjyKnS3wjd7hBF3Nk5B1` |
| `agent_pay` denied | `Ba97Bns24QCRGtXdsRTBvzJMwAYMhuz48oEECYGBnQdq` |
| `poke` | `54hc9J9s56AHuoVSmgk11NWfAPJZ1TXQZgz9csvr38Rv` |
| Step 1 | `9sssoy8ReCj2BDMMSY9uha9Ksmqcan4bcfBGAfxs8DYK` |
| Step 2 | `CCAMGiDRVJgXj5QxD4kpcqfiSDWPiJvp9cZYdRDp7hkv` |
| Step 3, Base | `9ACtzodSWx3vFRkAdXoxLT1HJjjTKHRefUbrpH9shXh4` |
| Step 3, Solana | `FE8gbw35AAUnzFC9UD1uo9iZisYSdHvu53e9yw62fNBr` |
| Step 4 | `96BDRraGWDepJryFnoiZDwjj4aBuVmrvw9HLUjfbonpB` |
| Step 5 | `DfJZW9t1RxsP2YumqQgnkdkpDQA6fVsuty7p57bdSgvb` |
| `claim`, signed by the heir's key | `FBX4KHZwmK6XfVDSvHsEo6jnYeKk5zgHaBWBsfDfcDxY` |

The plain transfer signed with the agent key was refused by the node (`InvalidAccessKeyError`), so it has no hash.

**Vault 24, the hosted sweep.** A guest account (`dmw-guest-54067bfb.testnet`) opened a vault with a 30-second
heartbeat at 04:56 UTC ([`48d7JVut…`](https://testnet.nearblocks.io/txns/48d7JVut6Fb6LZ3GxK4ziVGQUisRCsaQNnNrQcQ9qL67))
and never touched it again. The next scheduled `guest-sweep` run created `dmw-sweep-d8d431e9f8.testnet`, poked the
vault and ran the five steps; the vault's own log reads `triggered by dmw-sweep-d8d431e9f8.testnet` and `settled`.
The three runs before it found no guest vault due and sent nothing.

## Judge dry run

A fresh clone of the branch at `0348a3e`, no `.env`, no keys, no cargo-near (so the build took the plain-cargo
path that CI takes):

- `make check`: "All good."
- `make build`: 52 s, `target/wasm32-unknown-unknown/release/dmw.wasm`.
- `make test`: contract 104, keeper 81, dashboard 88, agent 60, all passed.
- `make attacks`: "7 attacks, 0 escaped policy, worst bounded loss 1 NEAR."
- `make deploy`: created and initialised `dmw-b1b7c2.testnet` and a keeper account.
- `make demo`, `make kill`: vault 1 from Alive to Settled, poke
  `fpCc6B6KXfdScZWp75jhHFuRKi9SV9pML6bLQAawGkg`, step 5 `6uuSTLonzFHp6sFGXR3t3M7jMwFKvs5cZtQPkzY9Qjmn`.

Two things a judge on a clean Linux machine would meet, neither a failure of the documented path:
`cargo install cargo-near` needs the `libudev` headers (`apt-get install libudev-dev`); cargo-near is optional and
`make build` falls back without it. And one `near-admin.mjs call` out of roughly sixty answered
"Transaction has expired" from the public RPC and worked on the second try.

## After the fixes

On the private copy `dmw-b1b7c2.testnet`, with the source at `9c21010`:

- The exploit in `SECURITY_REVIEW_3.md` C-2 was run before and after an in-place upgrade; it pays the attacker
  before and costs them after.
- The cargo-near build of the fixed source (`6s9oqxvBZfhWncW6irGH6zXTebeYUKTHh1pk1WSDxjYH`, now
  `contracts/release/dmw.wasm`) was deployed over the existing state
  ([`65CcqCvS…`](https://testnet.nearblocks.io/txns/65CcqCvSvq1GEszTpC7E8XfR1fAL8Psi7ANDGmsqNb2V)); `view_account`
  returned that hash.
- `make test`: contract 105, keeper 90, dashboard 99, agent 61.
- `make demo`, `make kill` with the new keeper and scripts: vault 5 from Alive to Settled.
- A guest run in a phone-sized browser on a local production build of the fixed dashboard, against that contract:
  PASS in 150 s (vault 6 there), no console error.

## What is left

In this order. Steps 1 to 3 must come before the repository is made public: the commit history describes C-2, and
the live contract has it until step 1 is done.

1. **Deploy the fixed contract over the live one.** From the machine that holds `keys/dmw-x8cx.testnet.json`,
   on this branch:

   ```bash
   node scripts/near-admin.mjs deploy dmw-x8cx.testnet contracts/release/dmw.wasm
   ```

   No init argument: the state is kept. Then `view_account dmw-x8cx.testnet` must show code hash
   `6s9oqxvBZfhWncW6irGH6zXTebeYUKTHh1pk1WSDxjYH`, and `/vault/6` must still read Alive.
2. **Merge this branch into `master`.** Vercel deploys the dashboard and site from `master`, and the scheduled
   guest sweep runs the keeper from `master`.
3. **Update the README row "The live contract is this source"** to the new hash and deploy transaction (one line).
4. **Make the repository public**, then tag and push `hackathon-submission` (`SUBMISSION.md` §4).
5. **Fund the derived addresses of the showcase vault** if a relayed foreign payout is wanted as proof
   (`keeper/SHOWCASE.md` has the addresses and faucets). Optional; the submission says plainly that none is relayed.
6. **Post the demo on X**, put its URL in `demoUrl`, fill the email and the mainnet payout account, submit
   (`SUBMISSION.md`). The deadline is 2026-11-14 23:59 UTC.

Vault 13, the vault of the live agent transcript, passes its deadline on Nov 10 2026 at 16:56 UTC. Nobody holds
its heartbeat but its owner key; once it is poked it settles and its `agent_pay` key is deleted. The README says so.
