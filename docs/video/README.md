# Demo video

## v4

`site/assets/demo-v4-720p.mp4` (1280x720, 2:48, 167.9 s, 5.9 MB) and the 1920x1080 master, plus
`site/assets/demo-v4-x-720p.mp4` (2:16, 135.7 s, 5.0 MB, for X, whose standard accounts take up to 2:20). Filmed on the live contract `dmw-26a506.testnet` (contract v3, `docs/LIVE_CONTRACT.md`).
Recorded and cut by the `testnet` workflow (run 43629928841, Nov 14 2026, 19:06 to 19:18 UTC) from the raw footage; logs,
EDLs (`edl.txt`, `edl-x.txt`), captions, events and stills are on the `ci/testnet-results` branch under
`results/43629928841/`. Earlier cuts are described in [`docs/history/VIDEO_V1_V3.md`](../history/VIDEO_V1_V3.md).

Nothing is mocked and nothing is patched. Idle stretches play at 3x to 16x and are marked on screen; the dashboard showed
no RPC banner during this run, so no stretch is cut. The cut is computed from the run's own events (`autoedl.mjs`). The
nine minutes between Warning and the poke (the guardian's pause held the deadline to 19:17:56) play at 16x.

### The run (vault 4)

Owner `dmw-demo-owner-13231b.testnet`, heirs Sarah (`dmw-demo-sarah-67d7.testnet`) 60 % and Ben (`dmw-demo-ben-67d7.testnet`)
40 %, agent allowlist `dmw-demo-api-67d7.testnet`, guardian `dmw-demo-guardian-67d7.testnet` (max pause 600 s), 60 s
interval, grace 1. The contract's standing keeper `dmw-keeper-89d05f3b.testnet` (derived from the `KEEPER_SEED`
secret) watched the vault; it poked it, ran the steps and relayed the three foreign payouts.

| Time (UTC) | What happens | Proof |
| --- | --- | --- |
| setup | `make demo`: create_vault (4 NEAR), CLI pulse key and agent key, Base + Solana payouts, the agent-demo allowed/denied pair; then `tools/v4/setup.sh`: a 1.5 NEAR deposit, the phone's pulse key, Base + Monad + Solana payouts and the guardian | [create_vault](https://testnet.nearblocks.io/txns/GqdXSnubGYbxVzXdyjbXsVX7pbupLFjamuMBqCq6BEEr), [pulse key](https://testnet.nearblocks.io/txns/E5LfkKt3FcHa5TXLR3DEMGo9XmoUz8pL7y35abzNSmG6), [agent key](https://testnet.nearblocks.io/txns/688tg8RQoPNBRjz5tyhwV9zUAWXQnQGFZ2u7TE3AYQqc), [Base + Solana payouts](https://testnet.nearblocks.io/txns/8WuZ6BQSJjKWXTC6bSxtF2kymVKJnfakWZQqHnKBJoFe), [allowed](https://testnet.nearblocks.io/txns/BW99W8RtYcoWvX822gBfMw7RAjerrpnozPdzUhPorUGM), [denied](https://testnet.nearblocks.io/txns/8fWtfjC6q7xPhcqePSzvEvnN81MWWwtpH4jpqUeAHiRh), [deposit](https://testnet.nearblocks.io/txns/CVgBqt9XdY6x5asSFfsDuzz6rvwfGJEPaZVKUPh6fF6G), [phone key](https://testnet.nearblocks.io/txns/FS1Ryqe8AHH5aFoSshTtmUvmPV4CnmFjqcgrbvCW8SYo), [three payouts](https://testnet.nearblocks.io/txns/9oVUyUVgSZY9tkTHDeddc8MjjHiVq8XJHtD7phrXFr34), [guardian](https://testnet.nearblocks.io/txns/HLTkG8WFNGJEyPnxAAL2QjtDBJPU3o3MYz4byZdTApVW) |
| 19:06:25 to 19:08:35 | the phone beats about every 20 s (heartbeats signed in the browser with the phone key) | phone page, dashboard |
| 19:07:20 | `make agent` (scripted brain): INV-2041, 0.12 NEAR, allowed | [tx](https://testnet.nearblocks.io/txns/7hk3xW55WPHuFNKVVDuSRqLMvxLsHwahM87iUqdGpYtX) |
| 19:07:24 | INV-2042, 0.08 NEAR, allowed | [tx](https://testnet.nearblocks.io/txns/BMPMnGP2HChx1bPMC3qwZFSTfmuKGHo3mzBUmMCNcM6A) |
| 19:07:24 | the brain obeys the planted injection (2.45 NEAR to `stranger.testnet`); the wallet wrapper refuses, nothing signed | agent ledger (no tx exists) |
| 19:07:30 | run 2, wrapper checks off: the contract denies 2.25 NEAR, `receiver_not_allowlisted`, logged | [tx](https://testnet.nearblocks.io/txns/4HAMVHkzUb2QvgEP2zSZyH8vqBD9KvhtmtyJrrBUpSta) |
| 19:07:57 | the guardian pauses: the deadline moves from 19:09:51 to 19:17:56 (`paused` event, `paused_until_ms` 1794683876585) | [pause](https://testnet.nearblocks.io/txns/FpCMPsJUGuuhccHhg2UmKvfd2LbhFiMDDr2QBCEGUD46) |
| 19:08:38 | hold to stop on the phone; last beat 19:08:35 | phone page |
| 19:09:38 | the keeper sees Warning | keeper ledger |
| 19:18:00 | the contract's keeper pokes: Triggered, 0.05 NEAR bounty | [poke](https://testnet.nearblocks.io/txns/HLycj9dmZqUxYAp2kJsuSr1oHR7gwZShaNYvJ947PtwB) |
| 19:18:03 | step I: heirs paid on NEAR, 60 / 40 | [step 1](https://testnet.nearblocks.io/txns/5zsdXzzkGMo1Uk4uGGrn9cMRy5JDJiXxACWNtw5e6SBN) |
| 19:18:07 | step II: pulse and agent keys deleted | [step 2](https://testnet.nearblocks.io/txns/2r8LFJZ6Lcjui5mGC25tpQHaoSUipkQrtdeEHXD1zGYn) |
| 19:18:22 / 19:18:33 / 19:18:46 | step III: Base, Monad, Solana payouts signed by MPC, relayed by the keeper and confirmed on each chain | signed: [Base](https://testnet.nearblocks.io/txns/Bzj6tt6WMXLqixgeG8XRUyNbgoLuNrKE56p5qFaZCKia), [Monad](https://testnet.nearblocks.io/txns/eZgHL8eizvMSy71NEuc4jnqjVEYU9FXare3FspMyu9f), [Solana](https://testnet.nearblocks.io/txns/2fTnjFas56ncoAvGhLYW99jqtmF6NCuTB5YNwnVu2ZPJ); landed: [Base](https://sepolia.basescan.org/tx/0x9eef8be2d052c2bcb8b0d369cc878bc3fae65b05bec500722f6365157e352ea0), [Monad](https://testnet.monadexplorer.com/tx/0x49485735526a6ea2e18991f1478ca86ad80c42c984024654b4cf4e44df2c9f94), [Solana](https://explorer.solana.com/tx/Qbkw2phdwUtmGBmyvEa2srcUGgfZHAB6gzw9wfwSieJbkjCmBXhKdBfQDRBT6pvYnuo87kKEXCwwiRtN99Mk1jH?cluster=devnet) |
| 19:18:52 | step IV: no estate DAO on vault 4, skipped | [step 4](https://testnet.nearblocks.io/txns/DiYmMdA9bREw3fkcq5fYrtmbmZiSwZaKRkKcW1yZpCKR) |
| 19:18:56 | step V: Will NFT to `dmw-demo-sarah-67d7.testnet`; Settled | [step 5](https://testnet.nearblocks.io/txns/uGLuiJ7rNBzaDBqvfenHRXYWsZkHSfoQkAmzebPRMDP) |

Step III's three transactions are the MPC signatures. Relaying a signed payout to its chain is the keeper's next action:
it sends the stored transaction from the vault's derived source address and records the hash on the vault with
`mark_broadcast`.

### How it was made

`tools/v4`, run by `.github/workflows/testnet.yml` (task `record`/`finish` films, task `edit` re-cuts from the raw-footage
artifact): `setup.sh` builds the vault, `record.sh` serves a production dashboard build and the stage, `run.mjs` drives the
run with no manual steps and logs every story moment to `events.json`, `autoedl.mjs` builds the cut from those events
(beats at 1x, fast stretches marked, RPC-banner stretches cut, captions held long enough to read), `assets.mjs` renders the
cards and captions from HTML with the self-hosted fonts, and `cut.mjs` cuts and overlays in ffmpeg. The X cut is the same
footage cut shorter (window scale 0.65, 135.7 s).
