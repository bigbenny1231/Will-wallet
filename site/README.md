# Dead Man's Wallet: landing page

Static, build-free site: `index.html`, `styles.css`, `js/`, `fonts/`, `assets/`. No CDN, no runtime
dependencies. Design rules are in [`../DESIGN.md`](../DESIGN.md) (binding); every sentence is held to
[`../docs/AUDIT_CLAIMS.md`](../docs/AUDIT_CLAIMS.md).

| File | What it does |
|---|---|
| `js/main.js` | fills `[data-link]` anchors, starts the hero, lazy-loads the rest when it nears the viewport, demo player |
| `js/hero.js` | "Hold to stop your heartbeat": 1.5 s press-and-hold (pointer, touch, Space; Enter starts at once), then an 11 s client-side simulation of example vault 0042 with invented, labelled hashes. Nothing is sent. `?sim=run` / `?sim=settled` for screenshots |
| `js/story.js` | the three acts: the pinned seal follows the act in the middle of the screen; act III's strip flatlines into the five steps |
| `js/live.js` | "Live from NEAR testnet": read-only JSON-RPC `query` / `call_function` to `dmw-x8cx.testnet` (`nft_total_supply`, `get_vault` 6 and 17), fastnear first, then near.org; a fallback line if both fail |
| `js/quiz.js` | "Would your crypto arrive?": four single-tap questions scored in the page, "Copy result" copies a text summary and the site link |
| `js/seal.js` | sets a seal's state, word, inscription and title |

The whole page works without the RPC: the live strip then says the chain did not answer.

## Run locally

    cd site && python3 -m http.server 8080

## Shared design assets

The seal, the pulse motif and the tokens live in [`../design/`](../design/) so the dashboard, NFT art and
video can use the same source:

- `design/seal.svg`: the Will seal (inlined into `index.html` between `<!-- seal -->` markers)
- `design/pulse.js`: ECG geometry, the pulse strip, flatline-on-scroll, `beat()` for real heartbeat events
- `design/tokens.css`: colour, type and motion tokens

After editing any of them run `python3 design/build_site.py` from the repo root. It copies tokens and pulse
into `site/assets/`, re-inlines the seal (twice: the hero, and the story's pinned copy with suffixed ids),
re-renders the strip, and renders the phone-pulse QR code as inline SVG with `design/qr.js` (a small byte-mode
encoder; `node design/qr.test.cjs` checks it module for module against npm `qrcode`). Commit the result.

Check it with the real headers: `node design/serve.cjs site 8091` serves `site/` with the `vercel.json` headers
(CSP included), and `node design/shoot-v3.cjs http://127.0.0.1:8091` writes `screenshots/v3-*.png` at 390 and
1440 (hero idle, holding, mid-simulation, settled; acts II and III; live strip; quiz; builders).
`screenshots/hero-sim.mp4` is a 12 s recording of the hero interaction.

`node design/shoot.cjs` re-renders `assets/poster.jpg` and the screenshots in `screenshots/` (Playwright,
Chromium, local server only).

Fonts are the `@fontsource` builds of Instrument Serif, Inter Tight (400/500/600) and JetBrains Mono, Latin
subset, OFL (licences in `fonts/`).

## Demo video

`assets/demo-720p.mp4` is the v3 cut (2:50, vault 17), re-encoded to about 2.8 MB so it can be committed and
served by a git-triggered deploy. The command is in the docstring of `design/build_site.py`, which no longer
copies a video.

## Configure

`CONFIG` at the top of `js/main.js` holds the dashboard, site and GitHub links (plain links; the site has no
backend and collects nothing). `index.html` carries the same defaults so links work without JS.
The canonical and Open Graph URLs assume `deadmanswallet.dev`, the intended production domain (not yet
registered); change them if the domain differs. There is no waitlist form: the page points to GitHub releases
until a mailing list exists.

## Content Security Policy

`vercel.json` sets `script-src 'self'` with no hashes: the page has no inline scripts, only `assets/pulse.js` and
the modules in `js/`. Keep it that way; an inline `<script>` would be blocked until its SHA-256 is added. The live
strip needs `connect-src https://rpc.testnet.fastnear.com https://rpc.testnet.near.org`; add any other RPC there
too. Inline styles are allowed (`style-src 'unsafe-inline'`), which the seal's embedded `<style>` and the
`<noscript>` rule rely on. `dashboard/vercel.json` still uses the hash procedure for its own inline script.
