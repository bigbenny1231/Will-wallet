# Narrated cut for X (2:18)

X accepts 2:20 on a standard account; the v3 demo is 2:50 and silent. This cut plays the same footage 1.235 times
faster (170.46 s to 138.0 s, nothing removed) and adds a spoken narration. The captions burned into the footage are
unchanged, so the cut also works muted.

The mp4 is not committed (`*.mp4` is ignored). It was built on Nov 9 2026 from `site/assets/demo-v4-720p.mp4`, the only
copy in the repository; rebuild it from the 13 MB master for a sharper picture (recipe below).

## The script

Voice: "Daniel", a stock ElevenLabs voice (model `eleven_multilingual_v2`, stability 0.6, seed 4242), one request per
line. Times are in the 2:18 cut. Every sentence is held to `docs/AUDIT_CLAIMS.md`: the foreign payouts are "signed,
and not yet relayed", and the agent in the footage is the scripted one, so the narration does not call it an AI.

| At | Line |
| --- | --- |
| 0:00.2 | If you die tonight, your agent keeps spending. |
| 0:05.9 | This is a vault on NEAR. While its owner is alive, nothing happens. The phone holds a key that can do one thing: say, I am still here. |
| 0:23.2 | The vault's agent has a key too. It can only pay, inside limits the owner set. Two invoices go through. |
| 0:36.6 | Then a planted message tells it to send everything to a stranger. The wallet refuses. Without the wallet, the contract refuses. |
| 0:47.0 | A guardian can pause the vault once, for a length the owner chose. |
| 0:57.0 | Now the owner goes silent. One hold on the phone, and the heartbeats stop. The vault waits. |
| 1:12.5 | A beat is missed. The agent is disarmed. |
| 1:20.7 | When the grace runs out, anyone can trigger it. |
| 1:27.3 | Five steps, each a NEAR transaction. Heirs are paid, with nothing to sign. The phone and agent keys are deleted. |
| 1:40.9 | Then NEAR's network signs the payouts on Base, Monad and Solana. No single party holds a key for those addresses. On testnet they are signed, and not yet relayed. |
| 2:00.2 | This vault named no estate DAO, so that step is skipped. |
| 2:06.8 | The Will NFT passes to Sarah. Settled. |
| 2:13.0 | Dead Man's Wallet. Built at NEAR Hackathon. |

## The end card

The v3 end card printed an old repository address (`github.com/agarretson/deadmans-wallet`). Both this cut and the
committed `site/assets/demo-v4-720p.mp4` now cover that line and print `github.com/bigbenny1231/will-wallet` in the same
place, type and colour (JetBrains Mono 14, brass), from 2:47.0 of the original timeline. The site copy was re-encoded
once for this (libx264 crf 27, SSIM 0.998 against the previous file over the first 160 s, 3.2 MB). The 1080p and 13 MB
masters outside the repository still carry the old line: re-render the card, or apply the same filter.

The end card's tagline says "No seed phrase for your heirs." Heirs do need a NEAR account named in the plan; the
posts in `docs/SUBMISSION.md` avoid that phrase for this reason. It is burned into the footage and was left alone.

## Rebuild from the master

`narration-138s.mp3` is the 138 s narration track (the thirteen lines at the times above, loudness-normalised to -16 LUFS).

```bash
F=1.23520   # 170.458 / 138
ffmpeg -i docs/video/dmw-demo-v3-720p.mp4 -i narration-138s.mp3 \
  -filter_complex "[0:v]drawbox=x=320:y=548:w=640:h=32:color=0x0E0F14:t=fill:enable='between(t,167.0,171)',drawtext=fontfile=JetBrainsMono-Regular.ttf:text='github.com/bigbenny1231/will-wallet · built at NEAR Hackathon 2026':fontsize=14:fontcolor=0xC8A96A:x=(w-text_w)/2:y=557:alpha='if(lt(t,167.1),0,if(lt(t,167.45),(t-167.1)/0.35,if(lt(t,169.9),1,max(0,(170.05-t)/0.15))))',setpts=PTS/$F,fps=30[v]" \
  -map "[v]" -map 1:a -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -c:a aac -b:a 128k -t 138 -movflags +faststart dmw-demo-x-2m18.mp4
```

The box and text coordinates are for 1280x720. Check the last three seconds after rendering.
