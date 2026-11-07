# Third-party notices

The repository's own code is MIT (see `LICENSE`). It bundles or depends on the following third-party material.
Dependencies installed from npm or crates.io keep their own licenses; `npm ls` / `cargo metadata` list them.

## Fonts (SIL Open Font License 1.1)

Self-hosted Latin subsets of three fonts, used by the landing page (`site/fonts/`), the dashboard (via the
`@fontsource/*` npm packages) and embedded as base64 `@font-face` data in the diagrams under `docs/diagrams/`
and the one-pager (`docs/one-pager/`, `site/assets/attorney-one-pager.pdf`).

| Font | Copyright | Licence text |
| --- | --- | --- |
| Instrument Serif | Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif) | `site/fonts/LICENSE-instrument-serif.txt` |
| Inter Tight | Copyright 2022 The Inter Project Authors (https://github.com/rsms/inter-tight) | `site/fonts/LICENSE-inter-tight.txt` |
| JetBrains Mono | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) | `site/fonts/LICENSE-jetbrains-mono.txt` |

The OFL permits bundling and embedding with software of any licence, provided the copyright notice and licence
text travel with the font files (they do) and the fonts are not sold on their own.

## Rust crates linked into the contracts

- `near-sdk`, `near-contract-standards`: MIT OR Apache-2.0.
- `omni-transaction` 0.5.0: Apache-2.0 (permissive, compatible with an MIT project; keep its licence text when
  redistributing a built `.wasm` together with its sources).
- `wee_alloc` and `memory_units` (pulled in by `near-sdk`): MPL-2.0, file-level copyleft. Used unmodified as
  crates, so no obligation beyond making those crates' sources available, which crates.io already does.

## npm packages worth knowing about (dashboard)

- `rpc-websockets` (via `@solana/web3.js`, via `chainsig.js`): LGPL-3.0-only. Unmodified, pulled from npm and
  bundled into the dashboard build by Vite. Anyone redistributing the built bundle should keep the licence notice
  and allow replacing that library (the source repo satisfies this because `package-lock.json` pins it).
- `@meteorwallet/sdk`, `eyes`, `text-encoding-utf-8`: license field missing in package metadata.
