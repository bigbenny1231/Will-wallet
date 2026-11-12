# Live deployment verification

Run 2026-11-08 (UTC) against the two public Vercel deployments, built from master at `fd4459f`/`1b8437a`.

> Status on 2026-11-10: F2, F3 and F4 below are fixed (the site links to the dashboard, `/try`, `/vault/6` and `/heir`;
> the dashboard serves `/robots.txt` and a meta description; the demo video is the 3.2 MB re-cut). F1 is still open
> until the GitHub repository is made public. Everything below is the 2026-11-08 snapshot; the later run is in
> `docs/FINAL_REVIEW.md`.

- Site: https://will-wallet-site.vercel.app
- Dashboard: https://will-wallet.vercel.app

Tools: Playwright (Chromium 1254, desktop 1440x900, iPhone 13 emulation, 390 px), Lighthouse (mobile and desktop presets), curl for headers.

## Result summary

| # | Check | Result |
|---|---|---|
| 1.1 | Site: all sections render at 1440 and 390 (`top, how, demo, heirs, security, attorneys, faq, waitlist`, footer), no horizontal scroll | PASS |
| 1.2 | Site: in-page anchors resolve (`#main #top #how #heirs #attorneys #security #waitlist #demo #clause`) | PASS |
| 1.3 | Site: one-pager PDF (200, application/pdf, 43,776 B), `og.png` (200), favicon.svg (200), poster.jpg (200), css/js (200) | PASS |
| 1.4 | Site: demo video `assets/demo-v4-720p.mp4` | PASS after fix. It returned 404 on the first deploy (the mp4 was gitignored). Commit `1b8437a` adds a `.gitignore` exception and the file (2.9 MB, not 13 MB). Now 200, `video/mp4`, Range requests return 206, `<video>` has no error. |
| 1.5 | Site: security headers (CSP, X-Content-Type-Options, Referrer-Policy, X-Frame-Options DENY, Permissions-Policy, HSTS) present | PASS |
| 1.6 | Site: console errors/warnings and failed requests at both widths | PASS (none) |
| 1.7 | Site: external links (GitHub repo, README anchors, releases, issues, near-auth.md) | **FAIL**. All 7 GitHub links return 404 to an anonymous client: the repo `bigbenny1231/Will-wallet` is **private**. See finding F1. |
| 1.8 | Site: link to the dashboard ("Set up a vault" / any `will-wallet.vercel.app` link) | **FAIL**. The page has no `data-link` anchors, so `app.js` fills nothing and the site never links to the dashboard (nor `/heir`). `DASHBOARD_URL` is correct in `app.js` but unused. See F2. |
| 1.9 | Site Lighthouse mobile / desktop | Perf 97 / 100, A11y 100 / 100, BP 100 / 100, SEO 100 / 100. Mobile LCP 1.0 s, TBT 190 ms, CLS 0. |
| 2.1 | Dashboard `/`, `/vault/6`, `/vault/17`, `/heir`, `/create`, `/pulse`: HTTP 200 and render | PASS |
| 2.2 | `/vault/6` Alive showcase: seal drawn from chain (SVG, "Alive"), countdown ticks (6d 16:18:36 to 16:18:33 over 3 s), 2 heirs (60/40), three foreign payouts incl. **Monad 0.01 MON** (plus Base 0.0005 ETH, Solana 0.01 SOL, all "pending"), agent policy, keys panel | PASS |
| 2.3 | `/vault/17` Settled: all five steps with timestamps and explorer links (NEARBLOCKS, KEYS, BASESCAN, MONAD EXPLORER, SOLANA), NFT held by heir | PASS |
| 2.4 | `/heir`, `/create`, `/pulse` (unpaired "Pair this phone" screen with paste box) | PASS |
| 2.5 | Console errors on all routes (the known rolldown/eval warning did not even appear) | PASS (none) |
| 2.6 | Dashboard headers: CSP, nosniff, Referrer-Policy no-referrer, X-Frame-Options DENY, Permissions-Policy on every route | PASS |
| 2.7 | Wallet-selector modal opens on Connect ("Connect Your Wallet": MyNearWallet, Meteor Wallet) | PASS |
| 2.8 | SPA rewrites on hard load of deep routes (`/vault/6`, `/vault/17`, `/heir`, `/create`, `/pulse`, unknown path gives a "Nothing here" page, status 200) | PASS |
| 2.9 | PWA: `/manifest.webmanifest` (200, `application/manifest+json`), `<link rel=manifest>`, `/sw.js` (200, `no-cache`) registered and **activated** with scope `https://will-wallet.vercel.app/`; `/icons/seal-192.png`, `seal-512.png`, `seal.svg` all 200 | PASS |
| 2.10 | Pairing link origin: built `App-*.js` uses `h \|\| window.location.origin`, where `h = (env.VITE_PUBLIC_ORIGIN \|\| "").replace(...)`. The bundled env object holds no `VITE_PUBLIC_ORIGIN`, so the link is `https://will-wallet.vercel.app/pulse#c=...`. The owner view (Pair a phone) needs a wallet and was not exercised. | PASS (by code) |
| 2.11 | Dashboard Lighthouse mobile / desktop | Perf 70 / 55, A11y 100 / 100, BP 96 / 96, SEO 82 / 82. See F3 to F5. |
| 3 | REAL phone pairing against the live `/pulse` | PASS, details below |

## 3. Real phone pairing

- Owner `dmw-live-owner-2ef19d.testnet` (faucet-created), vault **19** on `dmw-x8cx.testnet`, interval 120 s, grace 1, one heir, created and `add_pulse_key` called with `contracts/tools/tx.mjs` (1y attached).
  - create tx: `5H8yXSSebWPWFZjtTcbVJHzvRk7zbVfAfwAK3HBttAjk`
  - add_pulse_key tx: `8bamoH5S8rb2cT18GJp5qeQuKgjE6B3kAg2rJnvyYL1V`
- Key from `node scripts/near-admin.mjs genkey`. Opened `https://will-wallet.vercel.app/pulse#c=dmw-x8cx.testnet&t=19&k=<secret>` in iPhone 13 emulation.
- The live page showed "Vault 19 / Alive / beating from this phone / 1 beat sent" and sent a real heartbeat.
- On chain, `last_beat_ms` moved from `1794110229798` (creation) to `1794110245624`. The vault log has `{"event":"heartbeat","detail":"pulse_key"}`. Screenshot: `docs/live-shots/pulse-paired-live.png`.
- Cleanup: page closed, so beats stopped. After the vault went overdue it was poked, then `execute_step` ran to **Settled** (state Settled, step 6). The pulse key `CaMmYhEi...` is gone from `dmw-x8cx.testnet`'s access keys, and `pulse_keys` / `agent_keys` are empty. No stray keys remain.

## Findings a judge would hit

- **F1 (high). The GitHub repo is private.** Every Docs, "Run it on testnet", releases, issues, GitHub and `near-auth.md` link on the site 404s for an anonymous visitor. The README, SPEC and run instructions are unreachable too. Fix: make `bigbenny1231/Will-wallet` public before submission. The repo name casing differs from the links (`will-wallet`); GitHub is case-insensitive, so that is harmless.
- **F2 (high). The site has no path to the dashboard.** There is no "Set up a vault" button and no link to `/heir`. The `DASHBOARD_URL` constant is correct but nothing in `index.html` carries `data-link="dashboard"` or `data-link="heir"`. Fix: add a primary CTA and a heirs-section link with those attributes.
- **F3 (medium). Dashboard `/robots.txt` is served as the SPA HTML** (the rewrite catches it), so Lighthouse reports 19 robots errors. Fix: add `robots.txt` to the rewrite exclusion list.
- **F4 (low). Dashboard has no `<meta name="description">`** (SEO 82).
- **F5 (medium). Dashboard performance.** Desktop CLS is 0.91: the register list reflows when the chain data arrives, so reserve its height or render skeleton rows. Mobile TBT is 2.0 s and about 656 KiB of unused JS, so split the `near-api-js` and wallet-selector chunks.
- **F6 (medium). The vault register shows test clutter.** Vault 18 is listed with heirs named `zz-audit-missing-heir-*` and long dummy ids, and vault 19 is my test vault. Judges opening `/` will see these. Consider filtering by an allowlist or hiding vaults whose heirs do not exist.
- **F7 (low). Vercel build env is bundled into the dashboard JS**: `VITE_VERCEL_GIT_COMMIT_AUTHOR_NAME`, login, commit message, project and deployment ids. Public-ish info, but it shows the author's real name. Fix: set `VERCEL_PUBLIC` system env exposure off ("Automatically expose System Environment Variables" in project settings).
- **F8 (info).** Vault 6 payouts are all "pending" and its balance is 5 NEAR; the Alive view is a static showcase, which is fine, but nothing on the page tells a judge it is an example. The site's seal says "An example vault."
- **F9 (info).** The owner pairing panel (QR and link) cannot be verified without a wallet. Only the code path was checked (2.10), and the `/pulse` page itself was exercised end to end in section 3.

## Screenshots (`docs/live-shots/`, PNG, each under 400 KB, downscaled)

`site-1440.png`, `site-390.png`, `dashboard-vault-6.png`, `dashboard-vault-17.png`, `dashboard-connect-modal.png`, `pulse-paired-live.png`.
