# Demo video

`dead-mans-wallet-demo.mp4` (1920x1080) and `dead-mans-wallet-demo-720p.mp4` (1280x720, for X) are not
committed because of their size (`docs/video/*.mp4` is in `.gitignore`). The stills in [`stills/`](stills/) are
committed.

- Length 2:39 (4 s title card, 2:30 of screen recording, 5 s end card), 30 fps, H.264 + AAC (silent track)
- No voice-over. The narration is burned in as captions.
- Everything on screen is a real run on NEAR testnet against `dmw-x8cx.testnet`. Nothing is mocked.

## What is on screen

The left side is the dashboard (`dashboard/`, `npm run dev`) on `/vault/11`, zoomed to 115%. The right side
shows two terminal panes that tail `.demo/pulse.log` (the heartbeat daemon, "owner's phone") and
`.demo/keeper.log` (the permissionless keeper). The terminal text is unedited apart from ANSI codes being
removed, hashes and addresses being shortened (`tx 4HHcHA…`) and repeated spaces being collapsed.

| Video time | What happens | Proof |
| --- | --- | --- |
| 0:04 | `make demo`: vault 11 is created and gets a pulse key and an agent key | [create_vault](https://testnet.nearblocks.io/txns/6cpyJymXDCrTDeTnCayYLcZqYf1k8RXNjap4XpzQ1xmx), [add_pulse_key](https://testnet.nearblocks.io/txns/2M7Td3MB2szb2giEkmqWsiJYg2ef9bM1ruWi5jqYT64w), [add_agent_key](https://testnet.nearblocks.io/txns/5s9mjrfZqtkS8QDkCiJbddySd1bfEA87vUirU7SQDV7M), [set_foreign_payouts](https://testnet.nearblocks.io/txns/59ahj3g2T1TQsN12yzqFt3qAanLYhAiUM8YqpFnDHPSp) |
| 0:21 | The agent pays 0.05 NEAR to the allowlisted API account (allowed), then tries to send 1 NEAR to `stranger-1243f92d.testnet` (denied, `receiver_not_allowlisted`) | [allowed](https://testnet.nearblocks.io/txns/5bxfzW8TsGtcxTL1rqTq6LdvPJmFrcCnVcU65tMn3m4y), [denied](https://testnet.nearblocks.io/txns/DjgaRD5xfMitcbCQkrXyXAsRZ9znkD2zAjSuUNmd2CGo) |
| 0:43 | Heartbeats every 20 s, then `make kill` stops the pulse daemon | pulse pane |
| 1:06 | Alive → Warning, then the keeper pokes: Warning → Triggered | [poke](https://testnet.nearblocks.io/txns/FFN6w9j1FgV4ywMDoTRbHcqq7FVQYvzhd4xPb68RK1tL) |
| 1:33 | Step 1 (heirs paid, 1.08 / 0.72 NEAR), step 2 (pulse and agent keys deleted) | [step 1](https://testnet.nearblocks.io/txns/4HHcHAxNHitTKJbUyrymffm39AZdvGwCAuzGsV5Bn81m), [step 2](https://testnet.nearblocks.io/txns/91CMzaMP3WoLy2Uf9zZXYPJAVocDNmGrH5uagwaUvZ5Z) |
| 1:47 | Step 3: Chain Signatures sign the Base and the Solana payout | [step 3 base](https://testnet.nearblocks.io/txns/5kCp3ASd1rfqo6AVxY15kzDNjyGfuYAePvsPCdoZPs7Z), [step 3 solana](https://testnet.nearblocks.io/txns/9AMWdptQvaYBhm6DMgVuao6QypDoh6GsfNQ3fMo42fNd) |
| 2:05 | Step 4 (vault 11 has no estate DAO, so it is skipped, and the caption says so; the live Sputnik proposal ran on vault 10, see the main README), step 5 (Will NFT to the primary heir) | [step 4](https://testnet.nearblocks.io/txns/5yRgLkEkGhAKLh9hLn3j5jLxw1Z9UtjtB1Sh2T2RPUkV), [step 5](https://testnet.nearblocks.io/txns/EBdfmpdEoQGtQ1kZir3QRoaFM82JapnNvKFSqHZWtoNP) |
| 2:17 | Triggered → Settled, then `make status`: owner = heir sarah, 0.1 NEAR reserve, 0 keys, both foreign payouts `signed` | contract [dmw-x8cx.testnet](https://testnet.nearblocks.io/address/dmw-x8cx.testnet) |

The foreign payouts are signed but not broadcast. Their derived source addresses are unfunded, so the
keeper logs "not broadcast … unfunded" and retries. This is the same state the main README describes.

Accounts: owner `dmw-demo-owner-bafeb2.testnet`, heirs `dmw-demo-sarah-3b15.testnet` (60%) and
`dmw-demo-ben-3b15.testnet` (40%), API `dmw-demo-api-3b15.testnet`, keeper `dmw-keeper-a92b.testnet`.
Interval 60 s, grace 1, pulse every 20 s, which are the `make demo` defaults.

## How it was made

1. A 1920x1080 "stage" page (served from `/tmp`, not committed) has a top bar, the dashboard in an iframe on
   the left (62%), the two log panes on the right, and a dark 150 px band at the bottom for captions. The
   panes poll the log files every 500 ms. For the recording, CSS was injected into the dashboard page so that
   the ring/status column and one panel (keys + agent, then the settlement timeline) fit on one screen. The
   dashboard code was not changed.
2. A Playwright script ran `make demo` and then `make kill` with no manual steps. It pointed the iframe at
   the new vault as soon as `.demo/vault_id` appeared, switched the dashboard panel at each phase, and saved
   the stills. Frames were captured with the Chromium DevTools screencast (JPEG q92, about 50 fps on change),
   which is the same mechanism Playwright's `recordVideo` uses, but with much sharper text. The frames were
   turned into a 30 fps master with ffmpeg (7:09 raw).
3. Editing in ffmpeg: waits with no new log lines play at 6x, and each state change and keeper step plays at
   1x. A 6 s stretch where the dashboard reloaded itself was cut (`make demo` rewrites `dashboard/.env.local`
   at the end, and Vite then reloads the page). Captions are an ASS file (Inter 44 px, white, bottom
   centre, at most 2 lines). Title and end cards are HTML rendered by Playwright.
4. Output: `libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart`, AAC silent track; the 720p
   version is a lanczos downscale at crf 22.

### One splice at the end

During the recording the dashboard's 3 s poll stopped updating after step 4. The vault page kept showing
"Triggered · step 5/5" while the chain and the keeper were already Settled. A fresh page load showed Settled.
This looks like a fetch that never returns: `usePoll` has no timeout, so one hung RPC request stops its loop.
So the last 17 s of footage (the grey "Settled" ring and the `make status` pane) were recorded about 20
minutes later from a fresh load of the same vault 11. During that clip the log panes showed the logs exactly
as they were at settlement (cut after the 15:24:16 relay line). The cut comes right after the keeper prints
`Triggered → Settled`.

## Stills (1920x1080)

| File | State |
| --- | --- |
| `stills/01-alive.png` | Alive, pulse and agent keys listed, heartbeats in the pulse pane |
| `stills/02-agent-denied.png` | Agent panel with the Allowed row and the Denied `receiver_not_allowlisted` row |
| `stills/03-warning.png` | Amber ring, Warning |
| `stills/04-triggered.png` | Red ring, Triggered after the keeper's poke |
| `stills/05-settled.png` | Grey ring, Settled, all five steps done (from the end clip) |
| `stills/06-final-status.png` | Settled with the `make status` output |
