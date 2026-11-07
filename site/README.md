# Dead Man's Wallet: landing page

Static, build-free site: `index.html`, `styles.css`, `app.js`. No dependencies.

## Run locally

    cd site && python3 -m http.server 8080

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
