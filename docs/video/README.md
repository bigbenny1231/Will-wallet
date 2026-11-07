# Demo video

## v3 (current)

`dmw-demo-v3.mp4` (1920x1080, 30 fps, 2:50, H.264 crf 18 + silent AAC, 51 MB) and `dmw-demo-v3-720p.mp4` (1280x720,
13 MB, for X). The mp4s are not committed (`docs/video/*.mp4` is in `.gitignore`); the stills in
[`stills-v3/`](stills-v3/) are. Captions carry the narration (Instrument Serif italic 48 on the hairline lower third, one
Inter Tight 20 technical line under each).

What is new against v2: the owner's **phone** (the real `/pulse` page, paired to the vault) keeps it alive and is
switched off with hold to stop; the **agent** is the real `make agent` loop with a poisoned inbox; a **guardian**
pauses the vault; and step III signs on **Base, Monad and Solana**. The `make demo` setup transcript is gone (tighter).

Structure:

- 0:00 cold open (5 s): the seal breathing, "Dead Man's Wallet", "If you die tonight, your agent keeps spending."
- 0:05 "I. Alive". 0:07 vault 17 Alive on the left; on the right a 390x844 phone frame (status bar, island, home
  bar) running `/pulse#c=dmw-x8cx.testnet&t=17&k=…`. The phone beats for real every 20 s and the dashboard seal pulses
  when each beat lands. 0:28 the right column crossfades to a typeset agent ledger while the dashboard scrolls to its
  Agent section: two invoices allowed, the planted "URGENT from the CEO" message, the brain's "Doing as asked.",
  **refused by the wallet** (run 1), then **denied by the contract** (run 2, wrapper switched off). 0:57 back to the
  console: the guardian pauses, the console reads "Paused." in amber and the deadline moves to the pause end.
- 1:09 "II. Silence". 1:10 a 2 s pointer hold on the phone's Hold to stop: "Stopped.", the phone's flatline, held.
  1:29 Warning ("A beat was missed."), 1:39 the keeper pokes, 1:40 Triggered ("This executes.").
- 1:47 "III. Settlement". The right column becomes the keeper ledger; steps I–V land as ticks on the flatline.
  Step III: Base, Monad and Solana payouts each "signed by MPC", each "relay pending funding of the source".
- 2:36 Settled, grey. 2:44 end card (6 s): the vault's on-chain Settled seal, "Left to Sarah" in the serif with
  `dmw-demo-sarah-3b15.testnet` in JetBrains Mono under it, the tagline ("One NEAR contract. Four chains. No seed phrase
  for your heirs.") and the repo line.

### The run (vault 17, nothing mocked)

Setup, before the recording started: `make demo` created vault 17 (owner `dmw-demo-owner-a452f9.testnet`, 60 s,
grace 1, heirs Sarah 60 % / Ben 40 %, Base and Solana payouts, CLI pulse key and agent key, the agent-demo
allowed/denied pair), then, as the owner with `contracts/tools/tx.mjs`: a 1.5 NEAR deposit (each key reserves 1 NEAR
and the phone key is a third key), `add_pulse_key` for a phone key from `scripts/near-admin.mjs genkey`,
`set_foreign_payouts` with Base + Monad + Solana (the Monad payout is 0.01 MON to
`0x360d02320ebff8439fe0d804e68dfc6976230e13`, one Monad payout as the contract allows), and `set_guardian`
(`dmw-demo-guardian-3b15.testnet`, max pause 600 s). The pairing link was built as in `dashboard/src/lib/pairing.ts`.

When the recording started, the script stopped the CLI pulse daemon and opened the phone page, so from then on the
phone was the vault's only heartbeat. The dashboard was `vite build` + `vite preview` on 5173
(`VITE_DMW_CONTRACT=dmw-x8cx.testnet`, `VITE_PUBLIC_ORIGIN=http://localhost:5173`).

| Video time | What happens | Proof |
| --- | --- | --- |
| setup | create_vault (vault 17), pulse + agent keys, agent-demo allowed and denied | [create_vault](https://testnet.nearblocks.io/txns/J2E9yRJSLjF8zGcaDFCCniEkWoRCGyTTh6CTAX4WxCy), [allowed](https://testnet.nearblocks.io/txns/Cj9BwC1Hjz9FjbNcNvHCYtVF3osYBeuU2tRdEDM4A39o), [denied](https://testnet.nearblocks.io/txns/2vMNfEKBuBgMhQjfJtPUMw2nxSdHspcGwZyq38vBjhgj) |
| setup | deposit, phone pulse key, Base + Monad + Solana payouts, guardian | [deposit](https://testnet.nearblocks.io/txns/CXyp74aUmeYRPmX8XbAnnwJXupZNj4P3pAMcvYBQ6WbA), [add_pulse_key](https://testnet.nearblocks.io/txns/A5sxMR68wRDEyKoGhb6rfFmL2FiYJpGn1Ds8tzEGWwxS), [set_foreign_payouts](https://testnet.nearblocks.io/txns/Q9Ec8f9q2JCfHX1JvjDKfPhkm25VydC1ZGfCQaBvPLD), [set_guardian](https://testnet.nearblocks.io/txns/3ShaRNZJWUoPaBVCts2DjwsBVZ5cK4Txq7SQkvHUGYVa) |
| 0:07 | The phone beats (heartbeat signed in the browser with the phone key); the seal pulses | phone page, dashboard "by a pulse key" |
| 0:35 | `make agent TOKEN=17` (scripted brain): key audit, inbox with the injection | agent ledger |
| 0:40 | Invoices INV-2041 (0.12 NEAR) and INV-2042 (0.08 NEAR) allowed | [allowed 1](https://testnet.nearblocks.io/txns/3FyRb85VknzhTEoNRdeysuQa2BQQGKQZgLiwnAjZtrbm), [allowed 2](https://testnet.nearblocks.io/txns/FJHcivh3Yzevb8TnFUVoRqb2rrZJ27FYyfThgaPaxGkA) |
| 0:46 | The brain obeys the injection (2.45 NEAR to `stranger.testnet`); the wallet wrapper refuses, nothing signed | agent ledger (no tx exists) |
| 0:54 | Run 2, `--no-local-checks --scenario scenarios/attack-only.json`: the contract denies, `receiver_not_allowlisted`, logged | [denied](https://testnet.nearblocks.io/txns/2QZrgvr7TmrZ8ZGLnUVxsgRe7RTMo5wG8qUxwfhP22gh) |
| 1:03 | The guardian pauses: Paused, deadline moved to 18:48:20 (the phone's next beat ended the pause, not shown) | [pause](https://testnet.nearblocks.io/txns/J46Do8QBcVqBfw6Ch2TBNyWGfndYNHu4iamp4mVAkAQY) |
| 1:13 | Hold to stop on the phone (18:39:14 UTC) | phone page |
| 1:29 | Alive → Warning (18:40:11) | keeper ledger, dashboard |
| 1:39 | The keeper pokes: Triggered, 0.05 NEAR bounty | [poke](https://testnet.nearblocks.io/txns/2ueZr6HYJysX5mC7Sue41qiH5BYms95pKkvhW3B4F17M) |
| 1:51 | Step I: heirs paid on NEAR | [step 1](https://testnet.nearblocks.io/txns/JDrdzwBT3geAV9LLeK87MUhQqXU94SakUkkcfMdxnwwr) |
| 1:57 | Step II: both pulse keys and the agent key deleted | [step 2](https://testnet.nearblocks.io/txns/85NiR7xyLDGyUnqvVzQgMv3Jpwr29r1S4evQ9cq3q5sZ) |
| 2:04 | Step III: Chain Signatures sign the Base payout | [step 3 base](https://testnet.nearblocks.io/txns/2mkJionfqdUHzCKgmxGJu5SscfG2cEfRugd8YyovkB2i) |
| 2:10 | Step III: the Monad payout | [step 3 monad](https://testnet.nearblocks.io/txns/B28MrsJjQZSWurNYEUdohS61Jc7Vwyav6XUXVFGVgmXk) |
| 2:19 | Step III: the Solana payout | [step 3 solana](https://testnet.nearblocks.io/txns/4aKAE3y9Gp8qpeMLQXdC4oHb93DXy6CVGaRNBqyU6uJr) |
| 2:28 | Step IV: no estate DAO on vault 17, skipped (the caption says so) | [step 4](https://testnet.nearblocks.io/txns/FzuDJq23u1Fyr8U1N11AJV3TE7dozvEqvtwJgKFCVjJM) |
| 2:36 | Step V: Will NFT to `dmw-demo-sarah-3b15.testnet`; Settled (18:44:01) | [step 5](https://testnet.nearblocks.io/txns/7QKzJUBoPKJLFJ3fJmqgLrYVyhw98UiuFJ6V5EkChEhm) |

After the run, `make status TOKEN=17`: Settled, owner `dmw-demo-sarah-3b15.testnet`, 0.1 NEAR left, 0 pulse and 0
agent keys, all three foreign payouts `signed`. As in v1 and v2 they are not broadcast: the derived source addresses
are unfunded.

### How it was made

Same mechanics as v2 (scripts in `/tmp/v3`, not committed): a 1920x1080 stage page frames the real dashboard at 1:1 in
a 1200 px iframe; the right column holds three crossfading layers (the phone frame with the `/pulse` page in a
390x797 iframe scaled to 0.885 under a drawn status bar, the agent ledger that typesets `make agent`'s Markdown
transcript, and the keeper ledger that typesets `.demo/keeper.log`). A Playwright script drove the whole run with no
manual steps: open the phone, wait for beats, run both agent runs, send the guardian's `pause`, press and hold the
phone's button for 2.4 s with the mouse, then follow the keeper to Settled. The dashboard code was not changed and
nothing was injected into it. One change from v2: screencast frames were piped straight into ffmpeg as a constant
30 fps stream (the disk was too full for JPEG frames), 8:47 of raw footage. Editing in ffmpeg: idle stretches at 3x
to 12x (marked on screen), events at 1x. Cards and captions are HTML rendered with the self-hosted fonts.

Cuts and patches beyond the speed changes, all disclosed:

- The dashboard showed "Could not refresh: Request timed out after 8 s" (and once "Reconnecting") three times while
  testnet RPC requests hung: 6:35–6:42, 7:50–7:57 and 8:08–8:36 of raw footage. Those
  stretches are cut. The last one covers step V and the keeper's Settled line, so at 2:36 the dashboard goes from
  "step 5 of 5" straight to "It is settled." and the keeper ledger gains rows V and Settled at the cut.
- From 2:36 to 2:44 the keeper ledger is a still of itself from 3 s after Settled: the stage's parser rendered the
  keeper's next line ("errors in a row: 1") as a bogus "watching" row. Nothing else in that pane changed.
- The act label in the lower third (I./II./III.) was switched by the stage a few seconds after the act cards; for
  those seconds (1:10–1:13 and 1:47–1:51) the label is patched with the label from a later frame.
- The guardian beat ends while the pause is active; the phone's next beat ended it on chain 17 s later (not shown).
- During the agent beat the dashboard Agent table shows the two invoices but the run-2 contract denial reached it
  only after the cut; the ledger and the tx link above show it.

| Still | Content |
| --- | --- |
| `stills-v3/01-cold-open.png` | Cold open: seal, title, the line |
| `stills-v3/02-alive-phone.png` | Vault 17 Alive, the paired phone counting down to its next beat |
| `stills-v3/03-agent-refused.png` | Agent ledger: two invoices allowed, refused by the wallet, denied by the contract |
| `stills-v3/04-guardian-paused.png` | Paused by the guardian, amber, deadline moved |
| `stills-v3/05-phone-stopped.png` | The phone after hold to stop: "Stopped.", flatline; dashboard still Alive |
| `stills-v3/06-triggered.png` | Triggered after the poke, step I under way, the phone flatlined |
| `stills-v3/07-three-chains.png` | Step III: Base, Monad and Solana signed by MPC in the keeper ledger and on the flatline |
| `stills-v3/08-end-card.png` | End card: Settled seal, "Left to Sarah", the heir account, tagline, repo |

## v2

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
