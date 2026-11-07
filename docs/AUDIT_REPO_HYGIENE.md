# Repo hygiene audit (pre-publication)

Date: 2026-11-07. Scope: whole git history (62 commits on `master`, plus branches `design/dashboard-v2` and
`docs/demo-video`, plus 3 dangling commits and every unreachable blob in `.git`), then supply chain, licences
and repo hygiene. History was not rewritten.

## 1. Secrets in history: none found

Result: no private key, token or credential is in history. Public keys and transaction hashes are the only
key-shaped strings.

How it was checked (457 blobs, every object in the object store, reachable or not):

1. Loaded all 37 private-key values and the two `.env` secrets (`DMW_CONTRACT_KEY`, `KEEPER_PRIVATE_KEY`) from
   the local, gitignored `keys/*.json`, `.demo/*.json` and `.env`, then searched every blob, every commit tree
   (`git grep` per commit), the full `git log --all -p` diff stream and all 3 dangling commits for those exact
   strings. Zero hits. That covers the contract full-access key and all testnet account keys.
2. Pattern scans over all blobs: `ed25519:` plus 80 or more base58 chars; `private_key`, `secret_key`,
   `PRIVATE_KEY=`; `sk-`, `ghp_`, `github_pat_`, `AKIA`, `xox[bp]-`, PEM headers; `0x` plus 64 hex; bare base58 of
   86 to 90 chars; 64-number JSON byte arrays. The only hits are listed below.
3. Path scan of all history: `.env`, `keys/`, `.demo/`, `*.key*`, `*credentials*` were never committed.
   `.env.example` files only ever held `ed25519:REPLACE_ME`. Working tree vs. index: nothing secret in the
   uncommitted diff either.
4. `gitleaks` is not installed and docker is down; `detect-secrets` installed but only scans the working tree,
   so the scripted scans above were used instead. CI already runs a secret scanner (`.gitleaksignore` exists).

What the pattern scans matched, and why each is fine:

| Match | Where | Verdict |
| --- | --- | --- |
| `private_key` field names / `KEEPER_PRIVATE_KEY=ed25519:REPLACE_ME` | `scripts/*`, `contracts/smoke.sh`, `contracts/tools/tx.mjs`, `agent/src/cli.ts`, `.env.example`, `keeper/.env.example`, `docs/video/tools/v3/setup.sh`, `agent/test/brains.test.ts` | Code that reads key files, and placeholders. No values. |
| 64-hex and 86 to 90 char base58 strings | `keeper/LIVE_RUN.md`, `contracts/TESTNET_SMOKE.md`, `docs/chainsig-notes.md`, `keeper/src/chains/selfcheck.ts` | EVM tx hashes, Solana tx signatures, a `secp256k1:` public key, a raw signed tx. Public chain data. |
| `.gitleaksignore` entry for `04e078f:contracts/TESTNET_SMOKE.md:51` | | Public `ed25519:` keys of pulse/agent keys. Fine. It is pinned to a commit hash, so it stops matching if history is ever rewritten. |
| **`keeper/src/factory.ts:31`, `ed25519:3D4Yud...` (88 chars)** | In every commit since `e83e027`, and in HEAD | See below. Not our key, but it will trip every scanner. |

### Finding S-1 (low, fix before publishing): hardcoded dummy signer key in `keeper/src/factory.ts`

`viewBackend()` falls back to a literal full-length `ed25519:` secret when `KEEPER_PRIVATE_KEY` is unset
("throwaway signer", views only). Checks:

- Its public key is `ed25519:7PGseFbWxvYVgZ89K1uTJKYoKetWs7BJtbyXDzfbAcqX`. It matches none of the 33 account keys
  in `keys/`, so it is not a Dead Man's Wallet key.
- On testnet that public key is a full-access key on two third-party accounts (`test-multisig3.insomn14.testnet`,
  `probe123456.testnet`; fastnear index lookup). The `3D4Yud...` prefix is consistent with the widely copied
  near-api-js documentation/test example key, but that origin is an inference, not verified.
- So nothing of ours is exposed, and the code only makes view calls with it. The risk is cosmetic and practical:
  secret scanners and reviewers will flag a real-looking private key, and it is a live key for someone else's
  accounts.

Proposed fix (source file outside this sweep's edit scope, so not applied): replace the literal with a fresh
ephemeral key, e.g. `const key = cfg.keeperPrivateKey || KeyPair.fromRandom('ed25519').toString();`
(import `KeyPair` from `near-api-js`). History rewrite is optional; if you want the string gone from history:

```sh
pip install git-filter-repo
cd "$(mktemp -d)" && git clone /home/claude/deadmans-wallet scrub && cd scrub
# expressions.txt must contain one line: the full literal key  ==>  ed25519:REDACTED_EXAMPLE_KEY
git filter-repo --replace-text ../expressions.txt
# then regenerate .gitleaksignore (its fingerprint contains a commit hash that will change)
```

Do the rewrite before the first push to the public remote, never after. Because the key is not ours and is likely
already public, skipping the rewrite and just fixing the code at HEAD is reasonable.

### If a private key is ever found: rotation steps (testnet)

None needed now. For reference, per account `X` with leaked key `K_old`:
`near account add-key X grant-full-access use-manually-provided-public-key <new_pub> network-config testnet`
(signing with `K_old` or any other full-access key), then
`near account delete-key X public-key <K_old_pub> network-config testnet`. Update `.env` / `keys/` and the
`DMW_CONTRACT_KEY`. For the contract account, do add-then-delete so there is always one valid key. For the
deployer/contract account also check `near account list-keys` for stray keys after.

### Other notes from the history scan

- Every one of the 62 commits has the single author/committer `Dead Man's Wallet Bot <bot@deadmanswallet.dev>`;
  no personal email in metadata.
- 3 dangling commits and some unreachable blobs exist locally (leftover from amended/rebased work). They contain
  no secrets and are not pushed by `git push`, but `git gc --prune=now` is cheap before publishing.
- Local branches `design/dashboard-v2` and `docs/demo-video` were scanned too. Push only the branches you want.
- The working tree has uncommitted edits (`keeper/src/*`, `scripts/*`) and an untracked `keeper/test/audit.test.ts`
  that belong to other work; this sweep did not touch or commit them.
- The real key material lives in untracked, ignored `keys/`, `.demo/`, `.env`, `dashboard/.env*`. Confirm the
  directory is never zipped or copied into the public clone.

## 2. Supply chain

Lockfiles committed: `keeper/package-lock.json`, `dashboard/package-lock.json`, `agent/package-lock.json`,
`contracts/dmw/Cargo.lock`, `contracts/chainsig-probe/Cargo.lock`. All npm lock entries resolve to
`registry.npmjs.org` (the only exceptions are 6 bundled wasm shims inside `@tailwindcss/oxide-wasm32-wasi`). No git or path dependencies in
either Cargo.lock; all crates carry checksums.

| Package | Prod deps (lock) | Total | `npm audit` (lockfile) |
| --- | --- | --- | --- |
| keeper | 4 direct (`commander`, `dotenv`, `near-api-js`, `picocolors`) | 163 | 11 low, 0 moderate/high/critical |
| agent | 1 direct (`near-api-js`) | 162 | 11 low, 0 moderate/high/critical |
| dashboard | 17 direct (React 18, react-router 7, near-api-js 6, wallet-selector 10, chainsig.js, auth0-spa-js, qrcode, bs58, noble hashes, 3 fontsource) | 452 | 14 low, 5 moderate, **5 high**, 0 critical |

Dev tool versions in `package.json` are caret ranges (`^`); the lockfiles pin exact versions. Use `npm ci`, not
`npm install`, in docs and CI.

### High findings (all in dashboard, all one chain)

All five hang off `@near-wallet-selector/meteor-wallet` (direct) -> `@meteorwallet/sdk` -> `nanoid`,
`query-string` -> `decode-uri-component`. `npm audit fix` offers only a downgrade to `meteor-wallet@9.3.0`
(a semver-major move backwards), which is not worth taking blindly.

- `decode-uri-component` (DoS via exponential/quadratic decoding of malformed percent-encoded input) and
  `query-string` (inherits it): exploitable only by feeding a malicious query string to the Meteor wallet flow in the
  victim's own browser tab. Client-side, self-DoS at worst, no secrets or funds. Not exploitable on the server.
- `nanoid` 4.0.0 to 5.1.15 (infinite loop on negative/zero custom size, integer overflow): triggers only if the
  caller passes attacker-controlled sizes. Our code does not call nanoid; the SDK uses fixed sizes. Not exploitable here.
- `@meteorwallet/sdk` and `@near-wallet-selector/meteor-wallet`: flagged transitively (they pull the above plus older
  `@near-js/*` and `near-api-js`). Used only in `dashboard/src/lib/wallet.tsx` via `setupMeteorWallet`.

Assessment: not exploitable in a way that endangers funds or the contract; browser-tab DoS at worst. Cheapest
real fix is to drop the Meteor Wallet adapter (one import and one `modules` entry in `wallet.tsx`); that removes
all five highs. Alternatively add an `overrides` block for `nanoid` and `decode-uri-component`.
Note: dev-only? No, these are production dependencies of the dashboard bundle.

### Moderate findings (dashboard)

`chainsig.js` -> `@solana/web3.js` -> `jayson` -> `stream-json` (DoS on deeply nested JSON), `uuid` (buffer bounds
check when `buf` is supplied). Server-side parsing paths; the dashboard is a browser app and does not run `jayson`'s
server. Low practical risk.

### Cargo

`cargo audit` (RustSec db fetched 2026-11-07) on both crates: 1 vulnerability, 2 unmaintained warnings.

- RUSTSEC-2026-0387, `crypto-bigint` 0.5.5 (timing variability): pulled in via `near-sdk` -> `near-vm-runner` -> `p256`.
  `cargo tree --target wasm32-unknown-unknown -e normal -i crypto-bigint` is empty, so it is not in the deployed wasm; it
  only affects off-chain unit-test builds. Not exploitable. Will clear with a `near-sdk` bump.
- `unsafe-libyaml` 0.2.11 (RUSTSEC-2024-0449, unmaintained): not in the wasm target either.
- `wee_alloc` 0.4.5 (RUSTSEC-2022-0054, unmaintained): in the wasm via `near-sdk`'s default allocator. No known
  vulnerability, inherited from `near-sdk`.

Pinning: `Cargo.toml` uses `near-sdk = "5.30.1"`, `omni-transaction = "0.5.0"`, `hex = "0.4"`, `serde_json = "1"`
(caret semantics) but both are built with `--locked` from committed lockfiles, so builds are reproducible.
`contracts/dmw` pins the cargo-near reproducible-build image by digest.

### Install scripts (npm)

Packages with `hasInstallScript` in the lockfiles: `esbuild` (dev, keeper and agent), `fsevents` (dev, macOS only),
`secp256k1` (prod, native build via `node-gyp-build`), and in dashboard also `browser-tabs-lock` (via
`@auth0/auth0-spa-js`), `bufferutil` and `utf-8-validate` (optional, `node-gyp-build`). All are well-known,
widely used packages; none are unknown. No package.json in the repo defines its own `install`, `preinstall`,
`postinstall` or `prepare` script.

## 3. Licences

- Repo: MIT, `LICENSE` reads "Copyright (c) 2026 Andrew Garretson". Cargo manifests declare `license = "MIT"`.
  No `license` field in the three `package.json` files (npm shows UNLICENSED); add `"license": "MIT"` there.
- Fonts: Instrument Serif, Inter Tight, JetBrains Mono, all SIL OFL 1.1. `@fontsource/*` packages declare OFL-1.1.
  `site/fonts/` ships the three licence texts with copyright lines, and `site/README.md` mentions them.
  Gaps: the same fonts are embedded as base64 in `docs/diagrams/*.svg` and the one-pager. OFL allows this; added
  `docs/THIRD_PARTY_NOTICES.md` to carry the attribution. Compatible.
- Third-party code copied in: none found. `git grep` for `copyright`, `SPDX`, `licensed under`, `all rights reserved`
  outside `LICENSE` and the font licence files returns nothing. The only copied assets are the fonts.
- `near-sdk`, `near-contract-standards`: MIT OR Apache-2.0. `omni-transaction` 0.5.0: Apache-2.0 only; compatible with an
  MIT project, noted in `docs/THIRD_PARTY_NOTICES.md`.
- Rust licence census (287 crates): all permissive except `wee_alloc` and `memory_units` (MPL-2.0, weak file-level
  copyleft, unmodified crates, fine) and `r-efi` (MIT OR Apache-2.0 OR LGPL; take the MIT option).
- npm production licences: keeper and agent are all MIT, ISC, BSD, Apache. Dashboard also has `rpc-websockets`
  (LGPL-3.0-only, via `@solana/web3.js`, bundled by Vite) and three packages with no license field
  (`@meteorwallet/sdk`, `eyes`, `text-encoding-utf-8`). Not blockers for publishing the source; noted in
  `docs/THIRD_PARTY_NOTICES.md`. Dropping the Meteor adapter also removes `@meteorwallet/sdk`.

## 4. Repo hygiene

- `.gitignore`: already covered `.env`, `.env.*` (not `.env.example`), `keys/`, `.demo/`, `docs/video/*.mp4`,
  `site/assets/*.mp4`, `target/`, `node_modules/`, `dist/`, `*.key`. `dashboard/.gitignore` covers `shots`. Fixed:
  added global `*.mp4`/`*.mov`, `shots/`, `*.key.json`, `*.testnet.json`, `*.pem`, `*.keystore`, `.near/`, `*.log`,
  `.vercel/`, `.env.local`, and removed the duplicate `keys/` line. No tracked file is matched by the new rules.
  `git ls-files` contains no `.env`, `keys/`, `.demo/` or `.mp4` files, and none was ever committed.
- Large files: no blob in history is over 2 MB except `site/screenshots/mobile-390-full.png` (2.72 MB at HEAD, and an
  earlier 2.70 MB revision). Next largest are `desktop-1440-full.png` (1.7 MB, two revisions) and `docs/video/stills-*`
  (about 1.0 to 1.2 MB each, 14 files). Repo `.git` is 39 MB including loose and unreachable objects. No videos, wasm
  or archives were ever committed. Two copies of `attorney-one-pager.pdf` (44 KB) exist: `docs/one-pager/` and
  `site/assets/`. Optional: shrink or drop `mobile-390-full.png` before the first public push.
- README links: 21 relative links plus all `src`/`href` and anchors across 23 tracked `.md` files checked. Broken links:
  none. 8 external links (testnet.nearblocks.io) not fetched from this sandbox.
- SECURITY.md contact: `security@deadmanswallet.dev` and issues at `agarretson/deadmans-wallet`. I could not verify
  from this sandbox that the domain has working mail (DNS and GitHub are unreachable here), so check that the mailbox
  receives mail, and enable GitHub private vulnerability reporting on the repo so reporters have a private channel.
  The file asks reporters to open a public issue "that only asks for a private channel", which is workable but weak.
  SECURITY.md is outside this sweep's edit scope, so it is untouched.
- CODE_OF_CONDUCT and CONTRIBUTING: absent, optional. A short CONTRIBUTING pointing to `make test` and the
  testnet-only caveat would help hackathon judges.
- Personal data: only example addresses (`*@example.com`, `*.example`), and `hello@`/`security@deadmanswallet.dev`. A few
  docs and `docs/video/tools/v3/*` hardcode `/home/claude/deadmans-wallet`; cosmetic.

### Placeholders still in tracked files

Intentional (leave):
- `.env.example`, `keeper/.env.example`: `ed25519:REPLACE_ME` (x3).
- Test fixtures: long zero runs in `contracts/dmw/src/foreign.rs:1175` and `contracts/chainsig-probe/src/tests.rs:95` are hex data.
- `example.com` / `you@example.com` / `sarah@example.com` in `site/`, `dashboard/src/lib/nearAuth.ts`, docs.

Resolved in this sweep:
- `site/index.html:321` GitHub footer link `https://github.com/PLACEHOLDER/deadmans-wallet` changed to
  `https://github.com/agarretson/deadmans-wallet` (the owner used in `SECURITY.md`, `README.md` clone URL and the
  NEP-330 `repository` field of the deployed contract). Assumption: that is the repo's final home. Confirm.

Still open (outside the allowed edit scope or needs a real value):
- `site/app.js:6` `GITHUB_URL: 'https://github.com/PLACEHOLDER/deadmans-wallet'`. Important: `app.js` rewrites every
  `[data-link]` href at runtime, so the footer GitHub link still points at PLACEHOLDER in the browser until this is
  changed to the same URL. One-line fix.
- `site/app.js:8` and `site/index.html:300` `https://formspree.io/f/PLACEHOLDER` waitlist endpoint. Needs a real Formspree
  form id (or remove the form). `site/README.md:40` documents it.
- `site/app.js:3-7` `DASHBOARD_URL` (`app.deadmanswallet.dev`), `DOCS_URL: '#docs'`, `ONE_PAGER_URL: '#'`,
  `CONTACT` are marked placeholder; `site/index.html` Docs link is `#docs`. Point `DOCS_URL` at the GitHub `docs/` folder
  and `ONE_PAGER_URL` at `assets/attorney-one-pager.pdf`.
- `contracts/chainsig-probe/Cargo.toml`: `image_digest = "sha256:000...0"` (placeholder, reproducible build would fail) and
  `repository = ".../deadmanswallet/deadmans-wallet"`, which differs from `contracts/dmw` (`agarretson/...`). Make the
  repository URLs agree.
- `keeper/src/factory.ts:31` dummy key (S-1).

## Summary of changes committed with this audit

- `.gitignore`: hardened as above.
- `site/index.html`: GitHub footer link placeholder resolved.
- `docs/THIRD_PARTY_NOTICES.md`: new, font and licence attributions.
- `docs/AUDIT_REPO_HYGIENE.md`: this file.

## Checklist before going public

1. Fix `keeper/src/factory.ts` dummy key (S-1); optionally scrub history with the filter-repo command above, before the first push.
2. `site/app.js`: replace `GITHUB_URL` and the Formspree endpoint (or remove the form).
3. Drop `@near-wallet-selector/meteor-wallet` from the dashboard (clears 5 high audit findings) or add overrides.
4. Add `"license": "MIT"` to the three `package.json` files; align `chainsig-probe/Cargo.toml` repo URL and image digest.
5. Confirm `security@deadmanswallet.dev` receives mail; enable GitHub private vulnerability reporting.
6. `git gc --prune=now`; push only `master` (and any branches you want public).
