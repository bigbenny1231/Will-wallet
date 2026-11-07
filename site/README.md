# Dead Man's Wallet: landing page

Static, build-free site: `index.html`, `styles.css`, `app.js`, `fonts/`, `assets/`. No CDN, no runtime
dependencies; it renders fully offline. Design rules are in [`../DESIGN.md`](../DESIGN.md) (binding).

## Run locally

    cd site && python3 -m http.server 8080

## Shared design assets

The seal, the pulse motif and the tokens live in [`../design/`](../design/) so the dashboard, NFT art and
video can use the same source:

- `design/seal.svg`: the Will seal (inlined into `index.html` between `<!-- seal -->` markers)
- `design/pulse.js`: ECG geometry, the pulse strip, flatline-on-scroll, `beat()` for real heartbeat events
- `design/tokens.css`: colour, type and motion tokens

After editing any of them run `python3 design/build_site.py` from the repo root. It copies tokens and pulse
into `site/assets/`, re-inlines the seal, re-renders the strip, and copies the demo video. Commit the result.

`node design/shoot.cjs` re-renders `assets/poster.jpg` and the screenshots in `screenshots/` (Playwright,
Chromium, local server only).

Fonts are the `@fontsource` builds of Instrument Serif, Inter Tight (400/500/600) and JetBrains Mono, Latin
subset, OFL (licences in `fonts/`).

## Demo video

`assets/demo-720p.mp4` is referenced by the page but not committed (`site/assets/*.mp4` is gitignored, like
`docs/video/*.mp4`). `design/build_site.py` copies it from `docs/video/dead-mans-wallet-demo-720p.mp4`.
Deploy from a local checkout that has the file (`python3 design/build_site.py && cd site && vercel deploy`);
a git-triggered Vercel build will not have it, and the player then shows only the poster. Hosting the mp4 on
a CDN or object store and changing the `<source>` is the alternative.

## Configure

Placeholders live in the `CONFIG` constant at the top of `app.js` (dashboard URL, docs, one-pager,
GitHub, contact, waitlist endpoint). `index.html` carries the same defaults so links work without JS.
Replace `https://formspree.io/f/PLACEHOLDER` with a real Formspree-style endpoint.

## Deploy

Point Vercel at `site/` (see `vercel.json`) or serve it from any static host.

## Copy rules

Say: "executes the distribution your will or trust specifies", "works with your estate attorney",
"non-custodial", "proof of life". Never imply legal force, guarantees, replacing a will, detecting death,
or recovering wallets that were not set up. The sample trust clause must stay labelled "review with counsel".
Voice per DESIGN.md: calm, declarative, short; no exclamation marks, emoji or hype adjectives.
