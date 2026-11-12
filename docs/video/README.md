# Demo video

## v4

`site/assets/demo-v4-720p.mp4` (1280x720, 2:50, 170.2 s, 5.7 MB) and the 1920x1080 master, plus
`site/assets/demo-v4-x-720p.mp4` (2:14, 134.3 s, 4.8 MB, for X, whose standard accounts take up to 2:20). Filmed on the live contract `dmw-885364.testnet` (contract v2, `docs/LIVE_CONTRACT.md`).
Recorded and cut by the `testnet` workflow (run 43290509255, Nov 12 2026, 19:31 to 19:43 UTC) from the raw footage; logs,
EDLs (`edl.txt`, `edl-x.txt`), captions, events and stills are on the `ci/testnet-results` branch under
`results/43290509255/`. Earlier cuts are described in [`docs/history/VIDEO_V1_V3.md`](../history/VIDEO_V1_V3.md).

Nothing is mocked and nothing is patched. Idle stretches play at 3x to 16x and are marked on screen; the dashboard showed
no RPC banner during this run, so no stretch is cut. The cut is computed from the run's own events (`autoedl.mjs`). The
nine minutes between Warning and the poke (the guardian's pause held the deadline to 19:42:33) play at 16x.

### The run (vault 4)

Owner `dmw-demo-owner-0d86db.testnet`, heirs Sarah (`dmw-demo-sarah-2667.testnet`) 60 % and Ben (`dmw-demo-ben-2667.testnet`)
40 %, agent allowlist `dmw-demo-api-2667.testnet`, guardian `dmw-demo-guardian-2667.testnet` (max pause 600 s), 60 s
interval, grace 1. The owner named the demo keeper `dmw-keeper-bc6af4.testnet` as vault 4's keeper with
`set_vault_keeper`, which makes it an operator for that vault; it poked the vault and ran the steps.

| Time (UTC) | What happens | Proof |
| --- | --- | --- |
| setup | `make demo`: create_vault (4 NEAR), set_vault_keeper, CLI pulse key and agent key, Base + Solana payouts, the agent-demo allowed/denied pair; then `tools/v4/setup.sh`: a 1.5 NEAR deposit, the phone's pulse key, Base + Monad + Solana payouts and the guardian | [create_vault](https://testnet.nearblocks.io/txns/BKgEmaqNg4b2QVVCpSF2C7ZemJbZsUzAPfYJhyqaTEMu), [set_vault_keeper](https://testnet.nearblocks.io/txns/2AKYGnZBwr1tvWJJ8KwHxRVDVzDthyVLeFAGHcoRZsmU), [pulse key](https://testnet.nearblocks.io/txns/4SsAFHFWrRPe3i9jSzGfFoe9tQpRmZ2FTLGoqRtX17sg), [agent key](https://testnet.nearblocks.io/txns/GVaT54JAQ7FXRbUcK95DNYUZkfEznyGWS8c5vAxEvHAy), [Base + Solana payouts](https://testnet.nearblocks.io/txns/2SDNtH9zD7GhmbPAfVsSruvKEkwMzXgzFkBwCojDSKaJ), [allowed](https://testnet.nearblocks.io/txns/9zuCxuiz1akKL2aaj6XASCxw2jkWdqa4oSidEW8orRk5), [denied](https://testnet.nearblocks.io/txns/C2hsbdtzBLx6VWmk66J5XQRrnsCthBMf7ZfgQsXZkZTg), [deposit](https://testnet.nearblocks.io/txns/567LbmF1VceBGK1nD8dYyZ4N1pdu7LaL7J9oaExYqY17), [phone key](https://testnet.nearblocks.io/txns/GCAueShuBtGYELg2zUXKLuh8j2kQxa1u33N2nD9Nh58V), [three payouts](https://testnet.nearblocks.io/txns/E1csn16ctFAaLnMdfGpbjH6fa1hmbgF3Gmf34a6bqmY4), [guardian](https://testnet.nearblocks.io/txns/7yacvH79n9JwWT27gk1hNriHTPooGbaqBA7waYbYmiHf) |
| 19:31:00 to 19:33:12 | the phone beats about every 20 s (heartbeats signed in the browser with the phone key) | phone page, dashboard |
| 19:31:57 | `make agent` (scripted brain): INV-2041, 0.12 NEAR, allowed | [tx](https://testnet.nearblocks.io/txns/GiBg2hTapA1uMu39Wv9YJoCKHqqHXKiGtEio8PMwTLEA) |
| 19:32:00 | INV-2042, 0.08 NEAR, allowed | [tx](https://testnet.nearblocks.io/txns/FZj6GKDAcnzL4AkWfA8bzWjvuvnfw87oNmKo7KyinsPj) |
| 19:32:00 | the brain obeys the planted injection (2.45 NEAR to `stranger.testnet`); the wallet wrapper refuses, nothing signed | agent ledger (no tx exists) |
| 19:32:08 | run 2, wrapper checks off: the contract denies 2.25 NEAR, `receiver_not_allowlisted`, logged | [tx](https://testnet.nearblocks.io/txns/BdAe16wBKJdoiNWZVntmusJjEckiyFvatwzsBZBdybRJ) |
| 19:32:34 | the guardian pauses: the deadline moves from 19:34:27 to 19:42:33 (`paused` event, `paused_until_ms` 1794512553117) | event in the run's `events.json`; the logs keep only the tail of this tx hash, so no link |
| 19:33:15 | hold to stop on the phone; last beat 19:33:12 | phone page |
| 19:34:15 | the keeper sees Warning | keeper ledger |
| 19:42:38 | the vault keeper pokes: Triggered, 0.05 NEAR bounty | [poke](https://testnet.nearblocks.io/txns/4aobfntQWvsB4FUhSaQtvxNFvNMKNCcuCod9n8mPXHAE) |
| 19:42:42 | step I: heirs paid on NEAR, 60 / 40 | [step 1](https://testnet.nearblocks.io/txns/GfRYEWBSYKTgWwqjPFEXykxFvPvPzBb9dAXH6fe7KTiw) |
| 19:42:46 | step II: pulse and agent keys deleted | [step 2](https://testnet.nearblocks.io/txns/2pUzmF1psUBL1FZAdkvqMaSAZkwuYHhfNcQLynTE1Qfi) |
| 19:42:55 / 19:43:05 / 19:43:14 | step III: Base, Monad, Solana payouts signed by MPC | [Base](https://testnet.nearblocks.io/txns/2C5g8gQDjYkfvjHy9S9dtM6YnQneSNXBTHyDwS3vf2nh), [Monad](https://testnet.nearblocks.io/txns/3VrfD3FMJiRvFC6JUyh7JvkXERDxY1yJxH339z2RBCW8), [Solana](https://testnet.nearblocks.io/txns/FRz14Qnf78CCUXKaqXRRuZittY6JinV5FxDS8Eo6ULzA) |
| 19:43:18 | step IV: no estate DAO on vault 4, skipped | [step 4](https://testnet.nearblocks.io/txns/8YjhLkVxGmXy1wfHDeu9hT31fDAZp246c1eyDPivtsGi) |
| 19:43:33 | step V: Will NFT to `dmw-demo-sarah-2667.testnet`; Settled | [step 5](https://testnet.nearblocks.io/txns/4KtyRoV1yMQMkEBQFPWUVjaFaf3BiQHUken68jAFWLJ7) |

Step III's three transactions are the MPC signatures. Relaying a signed payout to its chain is the keeper's next action:
it sends the stored transaction from the vault's derived source address and records the hash on the vault with
`mark_broadcast`.

### How it was made

`tools/v4`, run by `.github/workflows/testnet.yml` (task `record`/`finish` films, task `edit` re-cuts from the raw-footage
artifact): `setup.sh` builds the vault, `record.sh` serves a production dashboard build and the stage, `run.mjs` drives the
run with no manual steps and logs every story moment to `events.json`, `autoedl.mjs` builds the cut from those events
(beats at 1x, fast stretches marked, RPC-banner stretches cut, captions held long enough to read), `assets.mjs` renders the
cards and captions from HTML with the self-hosted fonts, and `cut.mjs` cuts and overlays in ffmpeg. The X cut is the same
footage cut shorter (window scale 0.65, 134.3 s).
