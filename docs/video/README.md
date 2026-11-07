# Demo video

## v2 (current)

`dmw-demo-v2.mp4` (1920x1080, 30 fps, 2:26, H.264 crf 18 + silent AAC, 46 MB) and `dmw-demo-v2-720p.mp4`
(1280x720, 13 MB, for X). Like v1, the mp4s are not committed (`docs/video/*.mp4` is in `.gitignore`). The
stills in [`stills-v2/`](stills-v2/) are committed.

Structure, following the Video section of `DESIGN.md`:

- 0:00 cold open (5 s): the seal breathing on grain, "Dead Man's Wallet", then "If you die tonight, your
  agent keeps spending."
- Act cards (1.5 s each): "I. Alive", "II. Silence", "III. Settlement", each with a small trace in the
  state colour (a beating line, then a beat that goes flat, then the flat line with five ticks).
- Live footage of one `make demo` + `make kill` run on `dmw-x8cx.testnet`, **vault 12**. Nothing is mocked.
- 2:20 end card (6 s): the vault's real on-chain Will NFT image in the grey Settled state (taken from the
  dashboard after settlement), "Left to dmw-demo-sarah-3b15.testnet", the tagline and the repo line.

### The stage

A 1920x1080 page served from `/tmp` (not committed) frames the real dashboard at 1:1 in a 1200 px column
(an iframe on `/vault/12`, scrolled to the Agent and Keys sections while the keys and the agent payments
happen, and to the estate console for the rest). The dashboard code was not changed and nothing was injected
into it. On the right, two ledger panes typeset with the DESIGN tokens: "PULSE · owner's phone" tails
`.demo/pulse.log`; the lower pane first shows the `make demo` transcript ("SETUP · make demo": accounts,
create_vault, add_pulse_key, add_agent_key, foreign payouts, the agent's ALLOWED and DENIED payments) and
crossfades to "KEEPER · anyone" (`.demo/keeper.log`) when the keeper starts. Log text is reformatted, not
edited: hashes are shortened to `tx 2JUNj6…`, each step gets its roman numeral, and the repeated "still
unfunded, retry" relay lines are left out after the first one. Pulse and setup lines have no timestamps of
their own, so the time column shows when the stage first saw each line. All clocks are UTC, the same as the
keeper log. The lower third carries a live clock and, during sped-up stretches, a "6× speed" mark.

The dashboard was served with `vite build` + `vite preview` on port 5173 (`VITE_DMW_CONTRACT=dmw-x8cx.testnet`)
instead of `npm run dev`. The reason: `make demo` rewrites `dashboard/.env.local` at the end, and the dev
server then reloads the page (that is the 6 s cut in v1). The preview server does not watch files.

### Recording and editing

A Playwright script ran `make demo` then `make kill` with no manual steps and captured the stage with the
Chromium DevTools screencast (JPEG q92), 7:00 of raw footage. Editing in ffmpeg: idle stretches play at 4x to
10x (marked on screen), each event plays at 1x. Captions (Instrument Serif italic 48, one Inter Tight 20 line
for the technical note) were rendered from HTML with the same font files as transparent PNGs and overlaid with
fades. Cards were rendered frame by frame from HTML with a time-driven animation.

One cut beyond the speed changes: at 1:56 (16:23:59 to 16:24:17 UTC) the dashboard showed "Could not refresh:
Request timed out after 8 s" for about 18 s while one RPC request hung. The poll recovered without a reload
(this is the 8 s per-request timeout added after v1). Those 18 s were removed rather than shown at 6x. The
keeper pane jumps by one line (the Base relay note) at that cut.

The dashboard polled through the whole run, from Alive to Settled, with no reload and no splice (v1 needed a
second recording for its last 17 s).

| Video time | What happens | Proof |
| --- | --- | --- |
| 0:09 | `make demo` created vault 12 (owner `dmw-demo-owner-004044.testnet`, 4 NEAR, 60 s interval, grace 1) | [create_vault](https://testnet.nearblocks.io/txns/87GYJHWAGfWfEg67PnpXwpBMS8gB73kiS2eDemqCFw1g) |
| 0:17 | A pulse key (heartbeat only) and an agent key (agent_pay only); Base and Solana payouts set | [add_pulse_key](https://testnet.nearblocks.io/txns/GNR4XQf9sPeXECMCrf3hqUVL5A9e8L8wJFETMjhkKEnM), [add_agent_key](https://testnet.nearblocks.io/txns/7kDWikF1CYEYzKhZV1RhWHcim8Gcm3ADGyoSfVV5A2KX), [set_foreign_payouts](https://testnet.nearblocks.io/txns/8YnHRzJoBoaFPrchPaRaSihRD87DAFayUC3iajVk9MSd) |
| 0:35 | The agent pays 0.05 NEAR to the allowlisted API account: allowed | [allowed](https://testnet.nearblocks.io/txns/C4heEM2s6HaHhKvVXBZ9wgAvEgBJXyraaD53HFF8wUvB) |
| 0:39 | The agent tries 1 NEAR to `stranger-1fe0ce73.testnet`: denied, `receiver_not_allowlisted`, logged | [denied](https://testnet.nearblocks.io/txns/FWAP3baysiMFQR2Xpwfjn2CfiAqNsFTJVVArW1QmoYQP) |
| 0:52 | A heartbeat lands; the seal pulses | pulse pane |
| 1:04 | `make kill` (16:20:54): pulse stopped | pulse pane |
| 1:17 | Alive → Warning (16:21:54) | keeper pane |
| 1:29 | The keeper pokes: Warning → Triggered (16:23:06), 0.05 NEAR bounty | [poke](https://testnet.nearblocks.io/txns/BprZoZmgKp24WCPhG32iZ43nzywMiENXzcnQ2LhuNhLx) |
| 1:41 | Step I: heirs paid (1.08 / 0.72 NEAR) | [step 1](https://testnet.nearblocks.io/txns/2JUNj6PqXsTPtBFavckXJtN6a89QrxxPTsNiVyMmitRp) |
| 1:47 | Step II: pulse and agent keys deleted | [step 2](https://testnet.nearblocks.io/txns/BEwbC9CVKzMwmFDdXrxyXH5RY1c916yAY66rcgCzShjD) |
| 1:54 | Step III: Chain Signatures sign the Base and the Solana payout | [step 3 base](https://testnet.nearblocks.io/txns/5YrJqaWoUj6Kp4Lcy1C7LXhJxmnvHA6dBpq4WxLfvq2K), [step 3 solana](https://testnet.nearblocks.io/txns/97wyJ39fe2eCsNkkqaThWYyYKRKDXipdGtaY1P3eorRh) |
| 2:04 | Step IV: no estate DAO on vault 12, skipped (the caption says so) | [step 4](https://testnet.nearblocks.io/txns/DJzC8UhtNjk2s7yrh6ta5ZqQPMSfusbikva5yYASKChd) |
| 2:10 | Step V: the Will NFT to `dmw-demo-sarah-3b15.testnet`; Triggered → Settled (16:24:54) | [step 5](https://testnet.nearblocks.io/txns/FPwJHbTZesFBhmQYkau4Dex4GRtKhSPj4LWBFAPRyaYZ) |

After the run, `make status`: vault 12 Settled, owner `dmw-demo-sarah-3b15.testnet`, 0.1 NEAR left, 0 pulse
and 0 agent keys, both foreign payouts `signed`. As in v1, the payouts are signed but not broadcast because
their derived source addresses are unfunded.

| Still | Content |
| --- | --- |
| `stills-v2/01-cold-open.png` | Cold open: seal, title, the line |
| `stills-v2/02-alive.png` | Vault 12 Alive, setup ledger, first caption |
| `stills-v2/03-agent-denied.png` | Agent ledger with the allowed and denied rows |
| `stills-v2/04-flatline.png` | Triggered, the red flatline, step I in progress |
| `stills-v2/05-settlement.png` | Settled, steps I–V on the line, keeper ledger |
| `stills-v2/06-end-card.png` | End card with the on-chain Settled seal and the heir |

## v1

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
