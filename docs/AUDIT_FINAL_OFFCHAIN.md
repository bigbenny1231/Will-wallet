# Final off-chain security review

Scope: `keeper/`, `agent/`, `dashboard/`, `scripts/`, `site/` (TypeScript, JavaScript, shell). `contracts/dmw` is out of scope (separate review) and was only read, to check what the contract enforces on behalf of the off-chain code.

Date: 2026-11-07. Reviewer: an independent pass by someone who did not write the code.

Threat model:

- The keeper and the agent run on the user's machine with real keys in `.env`, `keys/` and `.demo/`.
- The dashboard runs in browsers with wallet-selector (MyNearWallet, Meteor).
- The phone page `/pulse` keeps a pulse private key in `localStorage`. It is paired through a URL whose fragment carries the secret.
- The landing site is public.

Method:

- Manual read of every source file in scope.
- `npm audit --omit=dev` in each package.
- QR decoding (OpenCV) of every tracked image, `dashboard/shots/`, and every frame of the demo videos, including the one the site serves.
- Headless Chrome against `dist/` with the `vercel.json` headers applied, to catch CSP violations.
- On-chain lookups to check whether any leaked key is still live.
- Before and after every change: all test suites, plus the dashboard `npm run build`.

## Result

| Suite | Before | After |
|---|---|---|
| keeper typecheck + vitest | 46 passed | 51 passed (+5 audit tests) |
| agent typecheck + vitest | 37 passed | 41 passed (+4 audit tests) |
| dashboard vitest | 68 passed | 70 passed (+2 audit tests) |
| dashboard `npm run build` | green | green |

No Critical findings. One High finding, fixed. Every Medium finding is fixed. The remaining Low and Info findings are fixed where cheap and documented otherwise.

## Severity table

| ID | Severity | Area | Finding | Status |
|---|---|---|---|---|
| F-01 | **High** | scripts, keeper | Full-access private keys written world-readable: `keys/*.json` (0644), root `.env` (0644, holds `KEEPER_PRIVATE_KEY` and the contract's full-access `DMW_CONTRACT_KEY`), and a short window on `.demo/*.key.json` | Fixed |
| F-02 | Medium | dashboard | No CSP or security headers on the dashboard. That origin holds the pulse key (localStorage), fresh agent/pulse keys (sessionStorage) and the wallet session | Fixed |
| F-03 | Medium | keeper | `NearBackend.agentPay` went through `withRetry`. A transport timeout after the tx executed would send a second `agent_pay`, a double payment within policy | Fixed |
| F-04 | Medium | agent | Markdown and HTML smuggled into `.demo/agent-transcript.md`, and control sequences sent to the console, from inbox content and LLM output | Fixed |
| F-05 | Medium | dashboard | `/pulse` evaluated the whole wallet-selector SDK (and, before this pass, the 7 MB chainsig bundle) in the same document as the pulse private key | Fixed |
| F-06 | Low | dashboard | Pairing secret lifecycle: plaintext in localStorage; the URL may persist in global browser history or camera-app logs; a dev screenshot holds a full pairing link | Documented; key in screenshot verified dead |
| F-07 | Low | keeper | Broadcast trusted the RPC's returned tx id. A wrong id makes `mark_broadcast` fail (the contract checks it), which stalls the payout | Fixed |
| F-08 | Low | keeper | Re-signing a stale Solana payout trusts one RPC's `getSignatureStatuses`. A lying node could cause a second payment from the derived source | Documented |
| F-09 | Low | keeper | Chain-sourced strings (log details, payout addresses, node errors) printed raw to the terminal | Fixed |
| F-10 | Low | dashboard, keeper, scripts | Private keys passed as argv (`--key`, `call-with-key`), which any local user can see in `ps` for the life of the daemon | Fixed for the suggested commands; flag kept |
| F-11 | Low | dashboard | TxBanner: `decodeURIComponent` of an attacker-chosen query param could throw and blank the page; unbounded spoofed text | Fixed |
| F-12 | Low | dashboard | NFT `media` accepted any URL in `<img src>` | Fixed (only `data:image/svg+xml`) |
| F-13 | Low | all | `npm audit`: 5 high, 5 moderate, 14 low in the dashboard; 11 low in keeper and agent | Assessed, not exploitable here |
| F-14 | Info | scripts | `key_of` and `jqk` spliced a path into `node -e` source | Fixed |
| F-15 | Info | dashboard | Service worker: scope `/`, caching behaviour | No secret is cached; no change |
| F-16 | Info | keeper | Other state-changing calls are still retried | Accepted: the contract makes duplicates harmless |
| F-17 | Info | site | Landing page had no CSP | Fixed |
| F-18 | Info | keeper | Hardcoded throwaway key in `viewBackend` | Harmless (views only) |

## Findings

### F-01 High: private keys world-readable on disk

`scripts/near-admin.mjs create` wrote `keys/<acct>.json` with the default umask, so the files came out 0644. These files hold full-access keys for:

- the contract account itself (`dmw-xxxx.testnet`), which can redeploy the contract;
- the keeper account;
- every demo account.

The root `.env` on the review machine was also 0644. `set_env` only applied `umask 077` when it created the file itself, not when the file came from `cp .env.example .env` or an earlier tool. On a shared machine, or under any other local account or service, those keys can be read.

`scripts/demo.sh` also created `.demo/{pulse,agent}.key.json` with the default umask and only ran `chmod 600` afterwards, leaving a short window.

Repro (before):

```
$ ls -la keys .env
-rw-r--r-- 1 root root 447 .env
-rw-r--r-- 1 root root 238 keys/dmw-agent-owner-96af.testnet.json   # every file 0644
$ sudo -u nobody cat keys/dmw-agent-owner-96af.testnet.json          # readable
```

Fixes:

- `near-admin.mjs`: `keys/` is created 0700 and every key file 0600, with `mode:` plus an explicit `chmodSync`.
- `scripts/lib.sh`: `set_env` and `load_env` run `chmod 600 .env` every time.
- `scripts/demo.sh`: `genkey` runs in a `umask 077` subshell, so there is no window.
- `keeper/src/config.ts`: `warnIfShared` prints a warning when a loaded `.env` is group or world readable.
- On the review machine, the existing `keys/*.json` and `.env` were set to 0600 and `keys/` to 0700. Users who ran an earlier version should run the same commands: `chmod 700 keys; chmod 600 keys/*.json .env`.

`.gitignore` was checked: `.env`, `.env.*` (except `.env.example`), `keys/`, `.demo/`, `*.key`, `.near-credentials/`, `dashboard/shots`. It is complete. No private key exists in the tracked tree or anywhere in git history (searched for `ed25519:` secrets, 64-hex values, `sk-` API keys, and added `.env` or key files).

### F-02 Medium: dashboard had no CSP or security headers

`dashboard/vercel.json` set only service-worker headers. This origin holds three secrets:

- the paired phone's pulse key (localStorage, F-06);
- the private half of a freshly added pulse or agent key (sessionStorage, until it is dismissed);
- the wallet-selector session.

A stolen pulse key matters here more than its "heartbeat only" scope suggests. Whoever holds it can keep a dead owner's vault Alive and block the inheritance, for as long as the key's 1 NEAR gas allowance lasts. With no CSP, any XSS or injected script on the origin can read all three secrets. No headers also meant the vault page could be framed (clickjacking of owner actions).

The XSS review itself found no sink:

- There is no `dangerouslySetInnerHTML` except the QR code. That SVG is produced by the `qrcode` library from a pairing that `validatePairing` has already checked against strict regexes.
- Every chain string (heir ids, vault log details, payout addresses, tx hashes, DAO id) is rendered as React text.
- Every `href` built from chain data has a fixed `https://<explorer>/…` prefix, so the scheme and host cannot be changed.
- The seal SVG is shown through `<img>`, where scripts never run.
- No open redirect exists. The only query parameters read are `transactionHashes` and `errorMessage`/`errorCode` (F-11).

The CSP is defence in depth for the next bug and for supply-chain code.

Fix: `dashboard/vercel.json` now sends these headers on every path:

- `Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-…' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https: wss:; frame-src https:; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- a `Permissions-Policy` that turns off camera, microphone, geolocation, payment and usb.

Choices in that policy:

- The only inline script (the `window.process` shim in `index.html`) is allowed by its hash. A comment next to it says the hash must change if the script does.
- `connect-src` stays `https:`, because the NEAR, Base, Solana and Monad RPCs are configurable through `VITE_*_RPC`.
- Google Fonts is allowed because the wallet-selector modal CSS `@import`s Inter.

Verification: headless Chrome against `dist/` served with these headers. `/`, `/create`, `/vault/1`, `/heir`, `/pulse` and `/pulse#…` all render, and the wallet-selector modal opens. The one remaining report is `script-src eval` from zod v4's JIT probe (`try { Function('') } catch {}` inside the wallet-selector chunk). It falls back to non-JIT parsing and is harmless.

While testing, I found that a blocked or unreachable `@import` made Vite's CSS preload reject the page's dynamic import, which left a blank screen. This could also happen to users with an ad blocker or behind a firewall. `src/main.tsx` now calls `preventDefault()` on `vite:preloadError` for CSS only. I verified that a CSP blocking Google Fonts still renders the dashboard.

### F-03 Medium: keeper retried `agent_pay`

`keeper/src/backend.ts` wrapped every call in `withRetry`, whose `isTransient` matches `timeout`, `TimeoutError`, `50x` and similar. A NEAR RPC timeout often means "submitted, result unknown". Retrying builds a new transaction with a fresh nonce, so `agent_pay` (used by `dmw agent-demo`) could pay twice, within the vault's policy. `agent/src/near.ts` already documents and avoids this ("No retry: a signed transaction is sent once"); the keeper did not.

Fix: a new `send()` method does the raw call. `agentPay` uses `send()` and is never retried. The other calls keep the retry, which is safe for the reasons in F-16. Test: `keeper/test/audit.test.ts` "a timeout on agent_pay is not retried".

### F-04 Medium: untrusted text in the agent transcript and console

`agent/src/transcript.ts` pasted untrusted text verbatim into Markdown that is saved to `.demo/agent-transcript.md`, committed as `agent/LIVE_TRANSCRIPT.md`, rendered by GitHub and editors, and streamed to the terminal. The untrusted text:

- inbox `from`, `subject` and `id`;
- the LLM's `thought`, tool arguments, `receiver` (even when the wrapper refused it as an invalid account id) and `done` summary;
- node error text.

Repro (before): an inbox message with subject `[Invoice paid](https://evil.example) <img src=https://t.example/p.gif> | forged | cells` produced a live link, a remote image (a tracking beacon when the transcript is previewed) and forged table cells in the transcript. A receiver containing a backtick broke out of its code span. A thought containing the bytes `ESC ]0;… BEL ESC [2J` retitled and cleared the terminal of the person running the agent. Escaping the transcript does not change what the brain sees: the inbox is still delivered to the brain unchanged, by design (`agent/src/agent.ts`).

Fix: the transcript now neutralises every untrusted field:

- `stripControl` drops C0 and C1 control characters, so nothing can drive the terminal.
- `inline` escapes `` \ ` * [ ] < > | ~ `` and folds newlines, so the text cannot open a link, image, HTML tag or table cell.
- `code` wraps text in a code span whose backtick fence is longer than any backtick run inside it.

The changes are in `agent/src/transcript.ts`, `agent/src/agent.ts` and `agent/src/cli.ts`. Tests: `agent/test/transcript-safety.test.ts`.

The wrapper itself was reviewed and holds:

- The brain only proposes tool calls. The harness executes them, and the only money path is `Wallet.pay`.
- `receiver` must pass `isAccountId`. The amount must pass `parseNear`, an exact decimal with at most 24 fraction digits; floats and negatives are rejected.
- Paying the vault contract itself is refused locally. The memo is truncated to 64 characters.
- If the wrapper cannot read the vault, it fails closed.
- The key audit refuses a full-access key, or a key not scoped exactly to `[agent_pay]` on the vault contract.
- An unknown tool name is reported back to the brain and never executed.
- A malicious model can emit many `pay` calls in one step. Each one is still checked locally and then by the contract's per-tx and daily caps.
- `loadAgentEnv` reads only the listed variable names from the root `.env`, so the keeper key and contract key never enter the agent process from files.
- LLM API keys go only to fixed API hosts, and error messages include the response body, never the request headers.

### F-05 Medium: wallet SDK code ran next to the pulse key

`main.tsx` mounted `<WalletProvider>` around every route, `/pulse` included. Worse, the build's entry chunk statically imported both the `wallet-selector` chunk (Meteor SDK, MyNearWallet, modal) and the 7 MB `chainsig` chunk. So on the phone, every module of those SDKs and their dependency trees was evaluated in the same document whose localStorage holds the pulse key. That is a large supply-chain surface for a page that only needs `near-api-js`. The `dashboard` `npm audit` highs (F-13) all sit in this tree.

Fix:

- `main.tsx` now renders `/pulse` on its own through a dynamic import of `pages/Pulse`, with no router and no wallet provider. The dashboard routes load `App`, `WalletProvider` and the router dynamically.
- `vite.config.ts` lists the `polyfills` (buffer) and `near-api-js` chunk groups before `wallet-selector`. Rolldown groups capture their dependencies recursively, so the earlier order let the wallet-selector chunk absorb buffer and near-api-js, and anything needing those then had to load it.

Result, read from the built chunk graph:

- The entry imports only `rolldown-runtime`, `react` and `polyfills`.
- `/pulse` loads `Pulse`, `mock`, `near-api-js`, `react` and `polyfills`. None of these contains any wallet-selector or Meteor code.
- The entry chunk went from 120 KB to 4 KB, and dashboard pages no longer evaluate chainsig until the Create page needs it.

### F-06 Low: pairing secret lifecycle (documented)

What holds:

- The pairing link carries the secret in the URL fragment, which is never sent to a server or in a `Referer`.
- `/pulse` stores the secret and immediately calls `history.replaceState`, so it leaves the address bar and the session history entry.
- The service worker caches only the `/pulse` HTML shell and hashed assets, never anything containing the secret.
- `validatePairing` rejects anything that is not a NEAR account, a numeric token and a 64–90 character base58 secret.

What remains:

1. The key sits in plaintext localStorage. Any same-origin script can read it, so the CSP (F-02) and `/pulse` isolation (F-05) are the controls. Recommended next step: generate the key on the phone as a non-extractable WebCrypto Ed25519 key in IndexedDB, and send only the public key back to the owner's browser for `add_pulse_key`. The secret then never travels at all.
2. Global browser history, sync, camera apps and QR-scanner apps may keep the full URL, fragment included. Treat a pairing link as single-use: pair, then remove and re-pair if the link may have leaked. Removing a key needs the owner (`remove_key`).
3. `dashboard/shots/v3-keys-pairing-qr.png` shows a complete pairing link and QR for `dmw-x8cx.testnet` vault 1 (`ed25519:4ByLVC…V8B`, public key `FY2XaQ9sNeWW…kfdR`). The file is gitignored (`dashboard/.gitignore: shots`), so it was never committed. An RPC query confirms `access key ed25519:FY2XaQ9sNeWWcsjRHSE7KkS45yR4teX7VKfSqyNYkfdR does not exist`, so the key is dead. Do not publish that screenshot.
4. OpenCV decoding found no QR code in any tracked image, in `site/screenshots/`, or in any frame (sampled twice per second) of `site/assets/demo-720p.mp4` or `docs/video/*.mp4`. Text on screen was not checked by OCR. Before publishing new footage, check that no "Private key, shown once" panel or `--key ed25519:` command is visible.

### F-07 Low: broadcast trusted the RPC's tx id

`broadcastEvm` returned whatever `eth_sendRawTransaction` answered, and `broadcastSolana` whatever `sendTransaction` answered. The contract checks `mark_broadcast`'s hash against the stored signed tx (H-1, `lib.rs`), so a wrong answer cannot record a fake payout. It does make `mark_broadcast` fail on every tick, stalling that payout.

Fix: both functions return the id computed locally (`keccak256(raw)` for EVM, the first signature for Solana). If the EVM node's answer differs, the keeper prints a warning. Tests: `keeper/test/audit.test.ts`.

Wrong-chain broadcast was also checked. Every signed tx commits to its chain (an EIP-155 chain id in the EVM tx; a recent blockhash for Solana), so relaying through a misconfigured RPC is rejected by that node. The keeper classifies the rejection as `other`, retries after 30 s, and the payout status never changes. Nonces are set by the contract (SPEC 2.7); the keeper's nonce is ignored. Fees are clamped to the per-chain contract caps. The re-sign fee bump is `max(fresh, ceil(1.1 × last))` on both fee fields, and a bump that would exceed the cap is refused.

### F-08 Low: Solana re-sign trusts one RPC (documented)

When a Solana relay fails as stale (`BlockhashNotFound`), `handleStale` waits out the contract cooldown (`resign_allowed_after_ms` plus a 3 s margin). It then asks `getSignatureStatuses(…, searchTransactionHistory: true)` whether the old signature landed, and only re-signs if it did not.

Unlike EVM, where the contract-fixed nonce makes the old and new tx mutually exclusive, two Solana txs with different blockhashes can both land. A malicious or broken `SOLANA_RPC` that says "not landed" for a tx that did land would make the keeper request a second signature, and the second transfer pays the same heir again from the vault's derived source. This drains funds meant for later payouts from that address.

The contract cannot see Solana, so the keeper's RPC is the trust point. A lookup that throws is also treated as "not landed" (`txLanded(...).catch(() => false)` in `keeperLoop.ts`), so a flaky RPC leads to a re-sign too.

Recommendation, not applied because it changes settlement behaviour days before submission:

- require two independent RPCs to agree on "not landed" before calling `resign_foreign` for Solana;
- treat a lookup error as "unknown, wait" rather than "not landed".

Exposure is limited: the keeper operator chooses the RPC, `MAX_RESIGNS` is 2 per park cycle, and there is a 5-minute contract cooldown.

The other keeper races were reviewed and hold:

- Re-sign is never immediate after a Solana sign (the C-1 guard in `driveVault`).
- `failed` payouts wait for the cooldown.
- A re-sign that fails is parked for 30 s.
- A resign count that reaches the cap resets and parks for 300 s, so there is no tight loop.

### F-09 Low: control characters from chain data (keeper)

`dmw status` printed vault log details, heir ids and payout `to` addresses raw. The keeper log lines included raw node error text. Account ids are charset-restricted by the contract, but log details and foreign addresses are free-form strings set by the vault owner, and an operator running `status` or a public keeper may be looking at someone else's vault.

Fix: a new `termSafe()` in `keeper/src/util.ts` strips C0 and C1 control characters. It is applied in `logLine` (every keeper log line), in `status`, in agent-demo event lines, in pulse error lines, and in the top-level error print. Test: `keeper/test/audit.test.ts`.

### F-10 Low: keys in argv

The dashboard's "Run in keeper/" box suggested `npm run pulse -- --token N --key ed25519:…`. The pulse daemon runs for hours, and its argv is readable by every local user via `ps` and `/proc/<pid>/cmdline`. It also lands in shell history.

Fix: `KeysPanel.cliCommand` now produces ` DMW_PULSE_KEY=… npm run pulse -- --token N` (or `DMW_AGENT_KEY` for the agent demo). The CLI already reads that variable, and `/proc/<pid>/environ` is owner-only. The leading space keeps the line out of history under bash's `ignorespace`. `scripts/demo.sh` already passes keys through the environment.

The `--key` flags and `near-admin.mjs call-with-key` still exist for compatibility. Prefer the environment variables.

### F-11 Low: TxBanner on crafted links

`?errorMessage=` is attacker-controlled. `URLSearchParams` already decodes it, and the extra `decodeURIComponent` throws on a stray `%`. A link to `/vault/1?errorMessage=100%25` therefore crashed the React tree. The text was also unbounded, which helps phishing copy ("Wallet reported: …").

Fix: `walletMessage()` in `dashboard/src/components/TxBanner.tsx` decodes inside `try`, strips control characters, and caps the text at 160 characters. `transactionHashes` entries must also look like base58 hashes, and at most 10 are shown. Test: `dashboard/src/lib/audit.test.ts`.

### F-12 Low: NFT media URL

`<Seal media>` passed `nft_token.metadata.media` straight to `<img src>`. An SVG inside `<img>` cannot run script. A remote URL, though, would make every viewer's browser contact a host chosen by chain data (a tracking or IP beacon). The contract currently always writes an inline SVG.

Fix: only `data:image/svg+xml` URIs are shown; anything else falls back to the locally drawn seal.

### F-13 Low: npm audit

- keeper and agent: 11 low. All come from `elliptic` (GHSA-848j-6mx2-7j84) via `near-api-js` → `@near-js/crypto` → `secp256k1`. The keeper and agent never sign secp256k1 locally; MPC does that. Only ed25519 keys are used. Not exploitable here.
- dashboard: 5 high, 5 moderate, 14 low.
  - **High:** `decode-uri-component` (via `query-string`) and `nanoid` sit under `@meteorwallet/sdk` → `@near-wallet-selector/meteor-wallet`. Both are denial of service on crafted input inside the user's own tab, with no data exposure. Since F-05 this code no longer loads on `/pulse`.
  - **Moderate:** `jayson`, `stream-json` and `uuid` (via `@solana/web3.js` inside `chainsig.js`). These are server or stream parsers that are not reachable with attacker input in the browser.
  - Fixing them means major-version downgrades of wallet-selector and Meteor (`npm audit fix --force`). That was not done this close to submission. Revisit after the hackathon: drop Meteor or pin a fixed SDK.

### F-14 Info: shell quoting

`key_of` (`scripts/lib.sh`) and `jqk` (`scripts/demo.sh`) built JavaScript source by splicing in an account name or path, for example `readFileSync('keys/$1.json')`. `deploy.sh` takes the account name as a CLI argument. Both now pass the value as `process.argv`.

The rest of the scripts hold up:

- `deploy.sh` and `demo.sh` use `set -euo pipefail`. `kill.sh` uses `set -uo pipefail` on purpose, because grep loops are expected to fail. `check.sh` uses `set -u`.
- `set_env` uses `mktemp` (0600) and copies back with `cat`, so the target keeps its mode.
- The faucet and RPC JSON in `account_exists` interpolates only generated or argument account names; this was noted, not changed.
- `pkill -f "src/cli.ts (pulse|keeper)"` also stops other checkouts' daemons run by the same user. That is a convenience trade-off.

### F-15 Info: service worker

`/sw.js` is registered only from `/pulse`, with scope `/`. Navigations are network first, with the cached `/pulse` shell as the offline fallback. `/assets/` (hashed names) and `/icons/` are cache first. Cross-origin requests and non-GET requests pass through. Nothing that holds a secret is cached: the fragment is not part of the request, and localStorage is not in Cache Storage.

Because the scope is `/`, the worker also answers dashboard navigations once installed. That is harmless (network first), but scope `/pulse` would be tighter, if the manifest's `scope` is changed to match.

### F-16 Info: other retried calls

`heartbeat`, `poke`, `execute_step`, `mark_broadcast` and `resign_foreign` keep `withRetry`. A duplicate is rejected or ignored by the contract:

- poke: `not_due` or already triggered;
- mark_broadcast: idempotent for the same hash;
- resign_foreign: 5-minute cooldown;
- heartbeat: just a beat;
- execute_step: it advances only one legal step, with chain parameters re-checked by the contract.

A NEAR RPC that lies on views can only make the keeper waste gas or stall, because every state transition is validated on chain.

### F-17 Info: landing site

The site is static. `app.js` sets only fixed `href`s and posts to the waitlist endpoint, which is still a placeholder (`formspree.io/f/PLACEHOLDER`), so a real form would send emails to whoever owns that id. Replace it before the form goes live.

`site/vercel.json` now adds a CSP: `default-src 'self'`, the one inline script by hash, `connect-src` and `form-action` limited to formspree, `frame-ancestors 'none'`. It also adds a `Permissions-Policy`. Verified in headless Chrome with no violations. If `design/build_site.py` changes the inline `<script>` in `site/index.html`, update the hash.

### F-18 Info: throwaway view key

`keeper/src/factory.ts` `viewBackend` falls back to a hardcoded `ed25519:` key for `view.testnet`, used only for view calls. It is not a secret of this project.

## Files changed

- scripts: `scripts/near-admin.mjs`, `scripts/lib.sh`, `scripts/demo.sh`
- keeper: `src/config.ts`, `src/backend.ts`, `src/util.ts`, `src/cli.ts`, `src/chains/evm.ts`, `src/chains/solana.ts`, `src/commands/pulse.ts`, `src/commands/agentDemo.ts`, `test/audit.test.ts` (new)
- agent: `src/transcript.ts`, `src/agent.ts`, `src/cli.ts`, `test/transcript-safety.test.ts` (new)
- dashboard: `vercel.json`, `index.html`, `vite.config.ts`, `src/main.tsx`, `src/components/TxBanner.tsx`, `src/components/Seal.tsx`, `src/components/KeysPanel.tsx`, `src/lib/audit.test.ts` (new)
- site: `vercel.json`
