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

`CONFIG` at the top of `app.js` holds the dashboard, docs, one-pager, GitHub and contact links (all plain links;
the site has no backend and collects nothing). `index.html` carries the same defaults so links work without JS.
The canonical and Open Graph URLs assume `deadmanswallet.dev`, the intended production domain (not yet
registered); change them if the domain differs. There is no waitlist form: the page points to GitHub releases
until a mailing list exists.

## Content Security Policy hash

`vercel.json` allows exactly one inline script, the `<script>document.documentElement.classList.add('js')</script>`
in `index.html`, by SHA-256 hash (`script-src 'self' 'sha256-...'`). Any edit to that script, even whitespace,
breaks the page under the CSP until the hash is updated. After editing it, run from the repo root:

    python3 design/build_site.py
    python3 - <<'EOF'
    import re, hashlib, base64
    h = open('site/index.html').read()
    for m in re.finditer(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', h, re.S):
        print('sha256-' + base64.b64encode(hashlib.sha256(m.group(1).encode()).digest()).decode())
    EOF

and paste the printed value into `site/vercel.json`. The same applies to `dashboard/index.html` and
`dashboard/vercel.json`. Edits outside that one script (seal, copy, links) do not change the hash.
