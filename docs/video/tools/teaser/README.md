# Teaser (10.6 s, for X)

A heartbeat that speeds up, flatlines, and becomes the five settlement steps. Every frame is drawn by code:
`teaser.html` exposes `renderFrame(i)`, a pure function of the frame index, in the site's own type and colours.
Nothing in it is footage, and vault 0042 is the same example vault as the site's hero.

| Time | What |
| --- | --- |
| 0:00 to 0:04 | Ten beats, each closer than the last: "If you die tonight, your agent keeps spending." then "Your crypto dies with you.", one word a beat. A counter shows the time since the last beat |
| 0:04 | Flatline: the trace and the seal turn red, the monitor tone starts |
| 0:04.5 to 0:07.2 | "Triggered.", then steps I to V as ticks on the flat line |
| 0:07.2 | "Settled." The tone stops |
| 0:07.6 to 0:10.6 | End card. The line "Your crypto shouldn't die with you." is spoken, then the seal beats once, alive |

The claims are the ones the README makes: heirs paid on NEAR, the agent key deleted, Base, Monad and Solana payouts
**signed** (not relayed), a DAO proposal filed when a DAO is named, the Will NFT to the heir.

## Build

```bash
cd docs/video/tools/teaser
mkdir -p frames && node render.cjs 1920 1080 frames        # 318 PNG frames (Playwright, about 5 min); 1080 1080 for square
ffmpeg -i vo.mp3 -af silenceremove=start_periods=1:start_threshold=-45dB -ar 48000 -ac 1 vo.wav
python3 synth.py                                           # teaser.wav (numpy): heart, riser, tone, stamps, the line
ffmpeg -framerate 30 -i frames/f%04d.png -i teaser.wav -c:v libx264 -preset slow -crf 15 -pix_fmt yuv420p \
       -c:a aac -b:a 192k -shortest -movflags +faststart dmw-teaser.mp4
```

`vo.mp3` is one line from a stock ElevenLabs voice ("Daniel", `eleven_multilingual_v2`). Everything else in the sound
is synthesised in `synth.py`. The mp4 is not committed.

One frame at the flatline is a full-screen light flash. There is one, not a series.
