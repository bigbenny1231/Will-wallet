# Dead Man's Wallet: landing page (v4)

Static, build-free site: `index.html`, `styles.css`, `js/`, `fonts/`, `assets/`. No CDN, no runtime
dependencies. Design rules are in [`../DESIGN.md`](../DESIGN.md) (binding); every sentence is held to
[`../docs/AUDIT_CLAIMS.md`](../docs/AUDIT_CLAIMS.md).

| File | What it does |
|---|---|
| `js/main.js` | fills `[data-link]` anchors, starts the hero, the pointer light, the sound toggle, loads the WebGL seal on first interaction, lazy-loads the rest near the viewport, demo player |
| `js/hero.js` | "Hold to stop your heartbeat": 1.5 s press-and-hold (pointer, touch, Space; Enter starts at once), then an 11 s client-side simulation of example vault 0042 with invented, labelled hashes. "Who should it arrive to?" names the heir (localStorage key `dmw-heir`; never sent); the seal rim, the ledger and the last line use it. `?sim=run`, `?sim=settled`, `?heir=Maria` for screenshots |
| `js/sealhost.js` | the hero seal: the SVG seal always (the accessible image and the fallback), the WebGL seal from `js/seal3d.bundle.js` over it when `<html data-seal3d="on">` and WebGL works. Pointer tilt on desktop; DeviceOrientation on phones after "Tilt the seal" (iOS permission). Both seals tilt |
| `js/seal3d.bundle.js` | built by `node design/seal3d/build.mjs` from `design/seal3d/` (three.js, MIT). Contract: `createSeal3D(canvas, opts)` and `supportsWebGL()`. Loaded only after the first pointer, touch, key or scroll, so it never costs first paint (`?seal3d` loads it at once) |
| `js/story.js` | "Vault 17, as it happened": the real run of vault 17 (7 Nov 2026, 18:35 to 18:44 UTC) as one vertical ECG line drawn by scroll. Events are vault 17's on-chain log entries, spaced by the time between them; the heartbeats are the beats on the trace; the clock shows the time at the pen; minute marks along the line. Silence thins the trace, the trigger flatlines it, the five steps tick onto it. The page background shifts life-green, amber, red, ash. Reduced motion: the line is drawn, nothing scrubs |
| `js/graph.js` | "One estate, read live": vault 6 as a node graph (vault, chains, recipients) from read-only `get_vault` 6 calls, polled every 30 s on screen; edges pulse on load and when `last_beat_ms` changes. Select a node for its detail. Also the vault count, vault 6's last beat and vault 17's five steps, read now |
| `js/sound.js` | opt-in sound (nav "Sound: off"), WebAudio only: a two-burst thump per beat, one 220 Hz tone with a slow decay at flatline, silence after settlement. Hidden with reduced motion |
| `js/quiz.js` | "Would your crypto arrive?": four single-tap questions scored in the page; the verdict is drawn as a 1200x630 card on a canvas ("Download card", PNG) and can be copied as text |
| `js/seal.js` | SVG seal helpers (state, word, rim inscription with the heir, title), reduced-motion check, `dmw:*` events |

Events between modules: `dmw:beat`, `dmw:flatline`, `dmw:settled` on `window` (the hero seal's beat loop, the
story's crossings, a new heartbeat on chain). The sound module listens to them.

The whole page works without the RPC: the estate section then says the chain did not answer.

## Run locally

    node design/serve.cjs site 8091      # applies every vercel.json header block (CSP, caching)

## Shared design assets

The seal, the pulse motif and the tokens live in [`../design/`](../design/):

- `design/seal.svg`: the Will seal (inlined into `index.html` between `<!-- seal -->` markers, and again, aria-hidden, as the story clock's seal)
- `design/pulse.js`: ECG geometry (`complex()` is also the story line's beat), `beat()`, `setState()`
- `design/tokens.css`: colour, type and motion tokens
- `design/seal3d/`: the WebGL seal source and its build

After editing any of them run `python3 design/build_site.py` from the repo root (copies tokens and pulse,
re-inlines both seals, renders the phone-pulse QR code with `design/qr.js`). Commit the result.

## Checks

- `node design/shoot-v4.cjs http://127.0.0.1:8091` writes `screenshots/v4-*.png` at 390 and 1440: hero idle,
  mid-simulation and settled with the heir "Maria"; the story at three scroll positions; the graph and a node's
  detail; the quiz card (and `v4-quiz-card.png`, the canvas itself). Add `full` as the third argument for full pages.
- `node design/tour-v4.cjs` records `screenshots/v4-tour.mp4` (19 s scroll through the page).
- `node design/shoot.cjs og` renders `assets/og.png` (the WebGL seal, else the SVG); `poster` renders `assets/poster.jpg`.
- Lighthouse and axe were run against `serve.cjs` (production headers); see the commit message for the numbers.

Fonts are the `@fontsource` builds of Instrument Serif, Inter Tight (400/500/600) and JetBrains Mono, Latin
subset, OFL (licences in `fonts/`).

## Demo video

`assets/demo-720p.mp4` is the v3 cut (2:50, vault 17), re-encoded to about 2.8 MB so it can be committed and
served by a git-triggered deploy. The command is in the docstring of `design/build_site.py`.

## Configure

`CONFIG` at the top of `js/main.js` holds the dashboard, site and GitHub links (plain links; the site has no
backend and collects nothing). `index.html` carries the same defaults so links work without JS.
Canonical and Open Graph URLs point at the Vercel deployment until `deadmanswallet.dev` is registered.

## Content Security Policy

`vercel.json` sets `script-src 'self'` with no hashes: the page has no inline scripts. Keep it that way. The
estate graph needs `connect-src https://rpc.testnet.fastnear.com https://rpc.testnet.near.org`. Inline styles
are allowed (`style-src 'unsafe-inline'`) for the seal's embedded `<style>` and the `<noscript>` rule. Fonts are
cached for a year (immutable); `js/`, `assets/` and `styles.css` for an hour with revalidation.
