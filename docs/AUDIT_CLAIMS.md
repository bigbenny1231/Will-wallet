# Claims audit (2026-11-07)

A skeptical-judge pass over every factual claim in `README.md`, `SPEC.md`, `docs/SUBMISSION.md`, `site/index.html`,
`docs/video/README.md`, `keeper/README.md`, `agent/README.md` and `dashboard/README.md`. Each claim was checked
against the code, the test suites (run), the live chain and the hackathon rules (`nearhackathon.com/HACKATHON.md`).

**Results:** TRUE = verified. OVERSTATED = true core, wording claims more than the evidence. FALSE = contradicted by
the evidence. UNVERIFIABLE = could not be checked from here. "Fixed" means `README.md`, `docs/SUBMISSION.md` or
`site/index.html` was changed in the same commit as this file. Rows marked *out of scope* name a fix for a file this
pass was not allowed to edit.

## How it was checked

- **Tests:** `make test` at `d1d3637`: contract `99 passed`, keeper `46 passed`, dashboard `68 passed`, agent
  `37 passed`, exit 0.
- **Build:** `make build` at HEAD (contract source unchanged since `f0178de`): 460,419 B, code hash
  `13ug5kLS5oCUSHBjJ7P5sEJ7gANxaATHtHtfdDUZfsqU`, with rustc 1.97.0 and cargo-near 0.23.0.
- **Live state:** `view_account`, `view_access_key_list`, `contract_source_metadata`, `get_vaults` (all 17),
  `get_config`, `nft_token 4` on `dmw-x8cx.testnet`; `get_proposal 0` on `estate-82bd1f.sputnik-v2.testnet`.
- **Transactions:** all 20 hashes linked in `README.md` and all 45 in `docs/video/README.md`, plus the 7 in
  `agent/LIVE_TRANSCRIPT.md` and the probe tx `5kt1qV…SR3e`, fetched with `EXPERIMENTAL_tx_status` from
  `archival-rpc.testnet.near.org` (signer, receiver, method, status, logs). All 73 exist. All succeed except the two
  meant to fail (`31xYgV…` poke → `not_due`, `Chnruf…` pause → `already_paused`), which fail with those exact panics.
- **Foreign chains:** `eth_getBalance` / `eth_getTransactionCount` on Base Sepolia and Monad testnet and `getBalance`
  on Solana devnet for every derived source address of vaults 6, 10, 14, 16 and 17: all balances 0, all nonces 0.
- **Links:** `deadmanswallet.dev` and `app.deadmanswallet.dev`: NXDOMAIN (dns.google, Status 3). The GitHub repo was
  not reachable from this session and the checkout has no git remote.

## README.md

| # | Claim | Verification | Result | Fix |
| --- | --- | --- | --- | --- |
| R1 | Contract pays heirs on NEAR, deletes the agent key, MPC signs Base/Monad/Solana payouts, files a DAO proposal, hands over the Will NFT | step txs for vaults 1 (`dmw-c17cf5`), 10, 14, 17: `step_1` payouts, `step_2`, `sign` logs with paths `base-1`/`sol-1`/`monad-14`, `dao_proposal`, `nft_transfer` | TRUE | none |
| R2 | "(signed; relay pending funding of the derived addresses)" | all `foreign[].status` are `signed`/`pending`; all source balances 0, nonces 0 | TRUE | sharpened: "nothing has arrived on Base, Monad or Solana yet" |
| R3 | "the Will NFT (which holds the funds)" | step 1 pays heirs; afterwards the vault keeps only the 0.1 / 1.5 NEAR reserve, claimable by the NFT holder | OVERSTATED | Fixed: "whose holder can claim what is left in the vault" |
| R4 | "Heirs never touch a seed phrase" | heirs are NEAR account ids typed by the owner (wallet needed to create one); foreign payouts go to the heirs' own EVM/Solana addresses; `claim` needs a signature; Google sign-in is read-only and localhost-only | OVERSTATED | Fixed: "Heirs do not sign anything to receive their NEAR" |
| R5 | Phone pulse PWA: `/pulse`, QR pairing, key can only call `heartbeat` | `dashboard/src/pages/Pulse.tsx`, `App.tsx`; live key list shows a `["heartbeat"]` FunctionCall key; screenshots `dashboard/shots/v3-pulse-*` | TRUE | none |
| R6 | Live transcript "shows a prompt-injected agent" refused by wrapper, then contract | 7 txs in `LIVE_TRANSCRIPT.md` verified (allowed ×4, denied `receiver_not_allowlisted`); all three runs use `--brain scripted`, which is coded to obey the inbox; agent/README says LLM brains were not run live | OVERSTATED | Fixed: says the recorded runs use the scripted brain |
| R7 | Guardian pauses once per cycle, bounded by owner's max (SPEC §2.8), closes M-1 | `HqomRL…` set_guardian OK; `FNZntg…` pause OK, returns 1794070965882; `Chnruf…` `already_paused`; `31xYgV…` `not_due`; review lists M-1 "Mitigated" | TRUE | none |
| R8 | "Four chains … The keeper relays Monad payouts like Base ones" | Monad/Base relay code exists (`keeper/src/chains/evm.ts`); no relay has ever succeeded on any foreign chain (balances 0) | OVERSTATED | Fixed: "NEAR plus three signing targets", relay never exercised |
| R9 | Heir sign-in with Google: identity resolves to implicit account, page lists what was left | `dashboard/docs/near-auth.md`: popup verified only up to Google's sign-in page; `sub`→key step tested with a known `sub` and in mock mode; read-only (no claim/sign); owner must be given the implicit id first | OVERSTATED | Fixed: states read-only, not completed end to end, heir must send id |
| R10 | Built Nov 1–14 2026; tracks `security` (06), `nfts` (10), `open` (13) | track ids and order match HACKATHON.md (`defi`…`open`, 13 ids) | TRUE | none |
| R11 | "Testnet only. Not a will, not a custodian, not audited. MIT" | `LICENSE` MIT; reviews are AI reviews, no audit | TRUE | none |
| R12 | Live keeper run, both foreign payouts signed | vault 5: Settled, Base + Solana `signed` | TRUE | added "none relayed" |
| R13 | "Smoke run with 21 transaction links" | 21 unique `txns/` links before the "Later on Nov 7" heading of `TESTNET_SMOKE.md` | TRUE | none |
| R14 | "The problem": existing switches; "None can disarm an agent or settle … across chains" | market-wide negative, not checkable | UNVERIFIABLE | Fixed: "The dead-man's switches we looked at …; we found none" |
| R15 | Run in about 10 minutes; `make build` ~1 min; `make demo` ~1.5 min; `make kill` ~4 min | `JUDGE_DRY_RUN_4.md` (53 s, 95 s, 246 s, ~10 min total); my `make build` ~1 min | TRUE | none |
| R16 | `make test` → 99 / 46 / 68 / 37 passed | ran it: identical | TRUE | none |
| R17 | `make demo` "real output from a fresh clone": create_vault "1", add keys, foreign payouts, ALLOWED 0.05, DENIED `receiver_not_allowlisted` | 8 txs on `dmw-c17cf5.testnet` verified, results match the printed lines | TRUE | none |
| R18 | `make kill` output: poke, steps 1–5, base/solana signed, Settled; step 1 = 1.08 / 0.72 NEAR | 8 txs verified; `step_1` log `1080000…` / `720000…`; `step_5` remaining 0.1 NEAR | TRUE | none |
| R19 | Pulse key only `heartbeat`, agent key only `agent_pay` | live `view_access_key_list`: `["heartbeat"]`, `["agent_pay"]` FunctionCall keys | TRUE | none |
| R20 | "On `dmw-x8cx.testnet` every vault is settled or keyless now, so it holds only the deployer's FullAccess key" | live key list: FullAccess + `agent_pay` key (vault 13, Alive) + `heartbeat` key (vault 15, Warning) | FALSE | Fixed: lists the three keys |
| R21 | Monad step 3: signer signs `monad-14`, tx decodes to chain id 10143 from `0x360D…0e13`, relay pending | `DFmmyr…` log `path: "monad-14"`, `foreign_signed`; `get_config` Monad chain id 10143; balance of `0x360D…` is 0 | TRUE | none |
| R22 | Denied agent payments are logged, not reverted | `2HaoNG…`, `2QZrgv…` etc. succeed with `{"allowed":false,…}` and an `agent_pay_denied` event | TRUE | none |
| R23 | Settlement deletes the keys | vault 17 after step 2: 0 pulse / 0 agent keys; key lists in TESTNET_SMOKE | TRUE | none |
| R24 | "The probe contract `ecrecover`s the Base signature on-chain to the derived address; for `dmw` the signed Base tx recovers off-chain (viem)" | `chainsig-probe/src/lib.rs` calls `env::ecrecover`; probe tx `5kt1qV…` returns `recovered_signer` `0xca02…5f2f` = derived `base-1`; `dmw` has no ecrecover | TRUE | none (wording already precise) |
| R25 | Step 4 files and ratifies a Sputnik proposal (vault 10, proposal 0) | `FAzezv…` `dao_proposal` id 0; `get_proposal 0`: proposer `dmw-x8cx.testnet`, Approved; `5y9hsp…` emits `dao_ratified` | TRUE | none |
| R26 | "`contract_source_metadata` returns `link` and `build_info`; `git checkout 88cd83b && make build-reproducible` prints `G6eiYJ…25hM`, the same as `view_account`" | live `code_hash` = `13ug5kLS…fsqU`; `build_info: null`; TESTNET_SMOKE records three redeploys after `88cd83b`, the last a `non-reproducible-wasm` build of `f0178de`; my `make build` reproduces `13ug5kLS…` with rustc 1.97.0 / cargo-near 0.23.0 | FALSE | Fixed: real hash, commit, toolchain, and "not a reproducible build" |
| R27 | Will NFT holds funds and redraws itself; `nft_token 4` media is an on-chain SVG, grey, Settled | media is a base64 SVG data URI containing `#7A7F87` and "Settled" | TRUE (image); see R3 for "holds funds" | none |
| R28 | Heading "why this can't be built elsewhere" | other stacks (account abstraction, threshold signing networks) can approximate it; not demonstrated | OVERSTATED | Fixed: heading "How NEAR fits" |
| R29 | "A stolen phone can only say alive … neither can touch the plan" | true for funds and plan; heartbeats from a stolen key postpone settlement indefinitely until the owner removes the key | OVERSTATED | Fixed: adds the postponement |
| R30 | Chain Signatures: secp256k1 domain 0, ed25519 domain 1, `omni-transaction` in-contract | sign logs show `Ecdsa` / `Eddsa`; `Cargo.toml` `omni-transaction 0.5` `evm`,`solana` | TRUE | none |
| R31 | "no key for them exists anywhere, and no signature exists until the trigger fires" | MPC nodes hold shares of the root key, so a derived key exists in threshold form; the deployed code requests signatures only after `Triggered`, but the deployer FullAccess key could deploy code that asks earlier | OVERSTATED | Fixed: "No single party holds a private key …" with the deployer caveat |
| R32 | NEP-171 + on-chain SVG computed from state (green/amber/red/grey) | `nft.rs`; SPEC note (DESIGN.md colours) | TRUE | none |
| R33 | Sputnik: run live once; ratifying only records an event | see R25; `mark_broadcast` with `dao-ratified` only logs | TRUE | none |
| R34 | "`poke` and `execute_step` … pay a bounty" | `lib.rs`: only `poke` pays `v.bounty`; `execute_step` pays nothing | FALSE | Fixed |
| R35 | "keeper only supplies nonce/gas/blockhash" | SPEC 2.7: contract sets the EVM nonce and ignores `args.evm.nonce` | OVERSTATED (stale) | Fixed: fees, gas limit, blockhash; contract sets the nonce |
| R36 | Security model table (pulse ≤ 1 NEAR gas; agent within caps; owner; keeper cannot change destinations; DAO; contract cannot sign before `Triggered`; deployer key can redeploy) | `get_config` key_allowance 1 NEAR; SPEC 2.7/2.8; code paths; deployer key in key list | TRUE | none |
| R37 | "An independent review (a separate agent that had not seen the code) found 1 C, 3 H, 4 M, 6 L … All Critical/High fixed with regression tests" | counts match SECURITY_REVIEW.md (plus 5 Info); the review says "the reviewer did not write the code" (it read every source file); the reviewer is an AI agent; round 2 (1 H, 2 M, 3 L, 4 I; H-4 and M-6 fixed) not mentioned; `c1_*`/`h1_*`…`h4_*`/`m6_*` tests pass | OVERSTATED | Fixed: "two review rounds by a separate AI agent that did not write the code (not a third-party audit)", both rounds |
| R38 | Libraries list (near-sdk-rs 5 … vitest); "No template was used" | `package.json`/`Cargo.toml`: missing @auth0/auth0-spa-js, react-router-dom, qrcode, @noble/hashes, bs58, buffer, @fontsource fonts, commander, dotenv, picocolors, tsx, TypeScript, serde_json, hex; tools Playwright/ffmpeg; HACKATHON.md Q-005 requires listing libraries | OVERSTATED (incomplete) | Fixed: full list per component, external services, link to THIRD_PARTY_NOTICES |
| R39 | "Most of the code was written by Claude" | commit trailers, SPEC "agents code against this file", per-directory agent notes; HACKATHON.md requires AI code to be listed | OVERSTATED (understates AI share; vague) | Fixed: "Almost all … in every directory … treat the whole repository as AI-generated"; reviews were AI too |
| R40 | "all of it was written in the hackathon window"; scratch workspace; baseline none | every commit dated 2026-11-07; earlier work not inspectable; window opened 2026-10-19 (Q-001) | UNVERIFIABLE | kept as the author's statement, window date added |
| R41 | "We will mark the submitted tree with the tag `hackathon-submission`" | no tags yet (future action) | UNVERIFIABLE | none |
| R42 | "The author leads no other hackathon project" | Q-015 requires naming a second project if any; nothing contradicts it | UNVERIFIABLE | none |
| R43 | Security contact `security@deadmanswallet.dev` | domain NXDOMAIN | FALSE | Fixed: GitHub issues; says the domain does not resolve |
| R44 | Repository table: judge dry runs `_2`, `_3` | `JUDGE_DRY_RUN_4.md` also exists | OVERSTATED (stale) | Fixed |
| R45 | `git clone https://github.com/agarretson/deadmans-wallet` | not reachable from this session; no git remote in the checkout | UNVERIFIABLE | must be public by 2026-11-14 23:59 UTC (rules) |
| R46 | "Monad testnet is a live signing target" (diagrams) | R21 | TRUE | none |

## docs/SUBMISSION.md

| # | Claim | Verification | Result | Fix |
| --- | --- | --- | --- | --- |
| S1 | "Everything needed to submit"; form payload fields | HACKATHON.md API takes exactly `requestId, projectName, leadName, email, size, tracks, nearAddress, projectUrl, demoUrl, idea, consent`; the payload used other keys (`project_name`, `team_lead`, `description`, …) and had no `requestId` | FALSE | Fixed: payload uses the API keys, `size: "1"`, `{{REQUEST_ID}}`; checklist asserts the key set |
| S2 | Description "1558" characters | was 1558 | TRUE | new text is 1698 and the doc says so |
| S3 | Description: "Heirs never touch a seed phrase" | R4 | OVERSTATED | Fixed |
| S4 | Description: "the Will NFT, which holds the funds" | R3 | OVERSTATED | Fixed |
| S5 | Description: "Chain Signatures, so no key exists for the foreign addresses until the trigger fires" | keys are derived and exist (in threshold form) from day one; what waits for the trigger is the signature request | FALSE | Fixed: "no single party holds a key … the contract requests signatures only after the trigger" |
| S6 | Description: "a prompt-injected agent refused by its wallet, then by the contract" | R6 | OVERSTATED | Fixed: "an agent scripted to obey a planted prompt injection" |
| S7 | Description: "an independent review whose Critical and High findings are fixed" | R37 | OVERSTATED | Fixed |
| S8 | Description: "Built at NEAR Hackathon with Claude under the direction of the author" | R39 | OVERSTATED (vague on AI share) | Fixed: "mostly AI-generated with Claude" |
| S9 | Posts A/B/C include `deadmanswallet.dev` | NXDOMAIN | FALSE | Fixed: `{{SITE_URL}}` placeholder, explained in the intro |
| S10 | Post B: "No seed phrase for heirs" | R4 | OVERSTATED | Fixed: "They sign nothing to receive it" |
| S11 | Post C: "A prompt injection told our agent …" | R6 | OVERSTATED | Fixed: "Our scripted agent obeyed a prompt injection" |
| S12 | Post/tweet lengths (271, 268, 277; 264 … 273) and "each is under 280" | recounted with links as 23 chars: matched | TRUE | recounted after edits: 271, 275, 277; 250, 263, 258, 266, 260, 266 |
| S13 | Video 2:50; X standard limit 2:20 | `ffprobe docs/video/dmw-demo-v3-720p.mp4` 170.41 s, 13.5 MB; X limit is X's policy | TRUE / UNVERIFIABLE (X policy) | none |
| S14 | Tweet 1: "five steps, three chains, one trigger" | four chains including NEAR, three of them only signed | OVERSTATED (inconsistent) | Fixed: "five steps, one trigger" |
| S15 | Tweet 4: "no private key exists for them and no signature exists before the trigger" | R31 | OVERSTATED | Fixed |
| S16 | Tweet 5: "We planted a prompt injection … The wallet refused" | R6 | OVERSTATED | Fixed: "scripted the agent to obey" |
| S17 | Tweet 6: "The live contract exposes NEP-330 metadata, so the code hash can be rebuilt from the tagged commit" | R26: `build_info` null, non-reproducible build | FALSE | Fixed: same-toolchain `make build` match only |
| S18 | Checklist: `make test` "contract 95+, keeper 46, dashboard 67+, agent 37 (about 5 min)" | ran: 99/46/68/37 in under 2 min (dry run 4: 104 s) | OVERSTATED (stale) | Fixed |
| S19 | Checklist #4: `build_info` names the commit | null | FALSE | Fixed |
| S20 | Checklist #6: derive token 6 → Base `0x2cC6…28f4`, Monad `0x07BF…ba5b`, Solana `5iue…zvzc`; vault 6 Alive, three payouts pending | `npm run derive -- --token 6` and `get_vault 6` | TRUE | none |
| S21 | Checklist #3: the site mp4 "must be the v3 cut" | `design/build_site.py` copies `docs/video/dead-mans-wallet-demo-720p.mp4` (v1, 159.4 s, vault 11) to `site/assets/demo-720p.mp4`; the site captions say 2:50 / vault 17 | FALSE (as built) | Fixed in the checklist (ffprobe check, copy v3 after building); the local gitignored mp4 was replaced with v3. *Out of scope:* change the source path in `design/build_site.py` |
| S22 | Rules summary: post says built at NEAR Hackathon, tags @NEARProtocol and #NEARHackathon, attaches video | matches HACKATHON.md | TRUE | none |

## site/index.html

| # | Claim | Verification | Result | Fix |
| --- | --- | --- | --- | --- |
| W1 | Meta: "A non-custodial NEAR contract … Heirs sign in with an email, not a seed phrase" | deployer key can upgrade (I-1); Google sign-in is localhost-only and read-only; no email sign-in exists | FALSE | Fixed (all three meta descriptions) |
| W2 | Hero: "your vault pays each heir on every chain you hold" | NEAR + Base/Monad/Solana only, fixed amounts, ≤ 4 foreign payouts, 1 Monad payout; none relayed | FALSE | Fixed |
| W3 | Hero: "They sign in with an email. No seed phrase. Nobody locked out." | R4, R9 | FALSE | Fixed: "Heirs sign nothing to receive their NEAR" |
| W4 | "Set up a vault" → `app.deadmanswallet.dev` | NXDOMAIN | FALSE (dead link) | Fixed: "Run it on testnet" → README run section |
| W5 | Hero fine print: "Non-custodial" | deployer key (I-1) | OVERSTATED | Fixed: "Open source. Testnet only. Not a will; meant to sit alongside one." |
| W6 | Step I: "About ten minutes" to set the plan | wizard exists; timing not measured | UNVERIFIABLE | none |
| W7 | Step II: daemon or QR-paired phone; guardian pause once per cycle; reminders coming soon | R5, R7; no reminder code | TRUE | none |
| W8 | Step III: "pays each heir on every chain and disarms any agent you ran. Your heirs sign in." | R2, R8; only agents that use the vault's agent key are disarmed | OVERSTATED | Fixed |
| W9 | Demo: "Every frame is a real run on NEAR testnet. Nothing is mocked." | `docs/video/README.md` discloses speed-ups, three cut stretches, an 8 s still of the ledger, patched act labels, rendered cards | OVERSTATED | Fixed: "Recorded from one real run … sped up … cut" |
| W10 | Caption: 2:50, silent, captions burned in, vault 17 on `dmw-x8cx.testnet` | v3 is 170.4 s; vault 17 txs verified; but see S21 for the file actually served | TRUE (v3) | see S21 |
| W11 | Heirs: "Got an email … Sign in with the address it was sent to. The assets are already in your name. You do not need a wallet, a seed phrase …" | no email is ever sent; no email sign-in; Google sign-in localhost-only, read-only; heirs need a NEAR account named by the owner; link to `app.deadmanswallet.dev/heir` is dead | FALSE | Fixed: rewritten to what works today, links `near-auth.md` |
| W12 | Security: "None of them can change who gets what" | true for pulse/agent/keeper; deployer key can | OVERSTATED | Fixed: names the exception, adds a deployer-key row |
| W13 | Contract row: "pay heirs, request an MPC signature …, then delete the pulse and agent keys" | step 2 deletes keys, step 3 signs | FALSE (order) | Fixed |
| W14 | Keeper row: "Supply the nonce and gas" | R35 | OVERSTATED | Fixed |
| W15 | Thief row: "Cannot: Anything useful" | heartbeats postpone settlement | OVERSTATED | Fixed |
| W16 | Attorneys: "a RUFADAA-style online tool" | a legal characterization; no counsel opinion in the repo | OVERSTATED (reads as legal advice) | Fixed: "a question for counsel; we make no such claim" |
| W17 | Attorneys: "non-custodial: no party, including us, … can move assets outside the configured plan" | deployer key can upgrade and move funds (README table, SECURITY_REVIEW I-1) | FALSE | Fixed |
| W18 | Attorneys: a fiduciary can read "when it last changed" | the vault `log` keeps the last 40 entries; full history is in chain transactions | OVERSTATED | Fixed: "what was configured and the transactions that changed it" |
| W19 | "Counsel can reference the tool in the instrument" + sample trust clause "Review with counsel" | legal drafting on a product page | OVERSTATED (legal advice risk) | Fixed: "Nothing on this page is legal advice … an illustration, not language to use"; tag "Illustration only. Not legal advice."; footer adds "Not legal advice" |
| W20 | FAQ: up to ten years between beats plus grace; guardian; reminders not in the build | `get_config`/SPEC 2.7: 10 s..10 y, grace ≤ 1000 | TRUE | none |
| W21 | FAQ: "Can my heirs see my balance? Not through the app. They see nothing until settlement." | `dashboard/src/pages/Heir.tsx` shows "About X NEAR is set aside for you" while the vault is Alive | FALSE | Fixed |
| W22 | FAQ: chains; "Assets must be held at the derived addresses" | R2 | TRUE but incomplete | Fixed: adds fixed amounts and "signed, none relayed" |
| W23 | FAQ: testnet version free | testnet | TRUE | none |
| W24 | Docs links `#docs` | no element with `id="docs"` on the page; `app.js` keeps `#docs` | FALSE (dead anchor) | Fixed: links to the repo README (no `data-link`, so `app.js` cannot reset them) |
| W25 | Footer Contact `mailto:hello@deadmanswallet.dev` | NXDOMAIN | FALSE | Fixed: GitHub issues |
| W26 | Waitlist: "One email when mainnet opens" | form posts to `https://formspree.io/f/PLACEHOLDER` (`app.js` CONFIG) | FALSE (non-functional) | *Out of scope:* set `WAITLIST_ENDPOINT` in `site/app.js` before deploy |
| W27 | `canonical`, `og:url`, `og:image`, `twitter:image` on `deadmanswallet.dev` | NXDOMAIN, so link previews break | FALSE (until the domain exists) | *Out of scope for copy:* point them at the deployed URL or register the domain |
| W28 | Colophon: built on Chain Signatures for the NEAR Hackathon, Nov 2026, testnet only | R1, R10 | TRUE | none |

## SPEC.md, docs/video/README.md, keeper/, agent/, dashboard/ READMEs (out of scope for edits)

| # | Claim | Verification | Result | Fix (for the owners of these files) |
| --- | --- | --- | --- | --- |
| P1 | SPEC §2.6: integration `scripts/e2e.sh` "must pass before submission" | no such file; `make demo` + `make kill` play that role | FALSE | point §2.6 at `demo.sh`/`kill.sh` and the dry runs |
| P2 | SPEC §5: site uses "Tailwind CDN" | site has no CDN or runtime deps (`site/README.md`) | FALSE (stale) | update §5 |
| P3 | SPEC §1: derived addresses computed with chainsig.js | keeper uses the live `derived_public_key` view (checked equal to chainsig.js); dashboard uses chainsig.js | OVERSTATED | say both |
| P4 | SPEC §6: everything runs "with … near-cli-rs" | scripts use `scripts/near-admin.mjs`; near-cli-rs optional | FALSE (stale) | update §6 |
| P5 | SPEC §6: `gitleaks` in CI | `.github/workflows/ci.yml` uses `gitleaks/gitleaks-action@v2` | TRUE | none |
| P6 | SPEC §2.3–2.8 behaviour (1-yocto mutators, guardian, chain registry, limits) | unit tests pass; `get_config` limits; live txs | TRUE | none |
| V1 | video README: v3 1920×1080 2:50 51 MB; 720p 13 MB | ffprobe 170.41 s; 51.2 MB; 13.5 MB | TRUE | none |
| V2 | video README: every tx in the v1, v2, v3 tables | 45/45 found, all succeed, methods and results match the rows (vaults 11, 12, 17) | TRUE | none |
| V3 | video README: "Nothing is mocked", cuts and patches disclosed | disclosures are specific | TRUE | none |
| V4 | v3 end card tagline "One NEAR contract. Four chains. No seed phrase for your heirs." | R4, R8 | OVERSTATED | next cut: "NEAR plus three signing targets" / "Heirs sign nothing to receive NEAR" |
| K1 | keeper README: `npm test # 44 unit tests` | 46 | FALSE (stale) | 46 |
| K2 | keeper README: `derive` prints "Base Sepolia and Solana devnet" addresses; env table lists `BASE_RPC, SOLANA_RPC` | derive prints Monad too; `MONAD_RPC` exists | OVERSTATED (stale) | add Monad |
| K3 | keeper README: agent-demo shows `agent_pay_denied reason=over_per_tx_max` | contract checks the allowlist first; every recorded denial is `receiver_not_allowlisted` | FALSE | change the reason |
| A1 | agent README: wrapper layers, key audit, node-level rejections (`RequiresFullAccess`, `DepositWithFunctionCall`, …), probe output at the end of LIVE_TRANSCRIPT | code; LIVE_TRANSCRIPT lines 317–318; 37 tests pass | TRUE | none |
| A2 | agent README: LLM brains unit-tested, not run live | stated plainly | TRUE | none |
| D1 | dashboard README: `/pulse` PWA verified on vault 15 with iPhone 13 / Pixel 7 emulation | vault 15 has a pulse key; `shots/v3-pulse-*.png` exist | TRUE | none |
| D2 | dashboard README: step 3 fees "capped at the contract's 100 gwei" | the contract caps Monad at 1000 gwei; `dashboard/src/lib/chains.ts` caps every chain at 100 gwei, which is Monad's base-fee floor, so a dashboard-driven Monad step 3 signs at the floor with no headroom; vault 6's Monad payout has no `from_address`, so the dashboard throws "No source address recorded" without a fallback | OVERSTATED, and a code bug | per-chain cap from `get_config().chains`; fill `from_address` for Monad |
| D3 | dashboard README: Google sign-in on `localhost:3000` only, "NEAR Auth (coming)" elsewhere | `near-auth.md`, `nearAuth.ts` | TRUE | none |

## FALSE and OVERSTATED, in one list

FALSE: R20, R26, R34, R43, S1, S5, S9, S17, S19, S21, W1, W2, W3, W4, W11, W13, W17, W21, W24, W25, W26, W27, P1, P2,
P4, K1, K3.

OVERSTATED: R3, R4, R6, R8, R9, R28, R29, R31, R35, R37, R38, R39, R44, S3, S4, S6, S7, S8, S10, S11, S14, S15, S16,
S18, W5, W8, W9, W12, W14, W15, W16, W18, W19, W22, P3, V4, K2, D2.

Not fixed here (files outside this pass): W26, W27, S21's script, P1–P4, V4, K1–K3, D2.

## Note for later readers

Other agents were editing `contracts/dmw/src` and the keeper while this audit ran (uncommitted). If the contract is
changed and redeployed, R26's hash and commit go stale: re-run `make build`, compare with `view_account`, and update
the README row "The live contract is this source".
