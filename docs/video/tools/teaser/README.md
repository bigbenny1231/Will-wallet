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

## Sound, second mix (`synth2.py`)

The first mix (`synth.py`, `vo.mp3`) was synthesised apart from one spoken line. The second replaces the music and
the voice with ElevenLabs output and keeps only the sounds that must land on a frame (the heart, the monitor tone, the
stamps) synthesised:

| File in `el/` | What | Made with |
| --- | --- | --- |
| `cueA.mp3` | 24 s cue: a rising build, an orchestral hit, a decaying drone | Music API, `music_v1`, from `planA.json` |
| `sfx_riser.mp3`, `sfx_hit.mp3`, `sfx_chord.mp3` | riser into the flatline, the impact, the chord under the end card | sound-generation API |
| `vo_brian_l1.mp3`, `vo_brian_l2.mp3` | "If you die tonight... your agent keeps spending." and the tagline, stock voice "Brian" | `eleven_multilingual_v2` |
| `vo_cinematic_l2.mp3` | the tagline in a slower trailer voice from the account's library (the alternate cut) | `eleven_multilingual_v2` |

`synth2.py` finds the cue's own hit (10.5 s into the cue) and places the cue so that hit lands on the flatline at
4.08 s, ends the riser on the same frame, and cuts everything to silence at "Settled.".

```bash
for f in el/vo_*.mp3; do ffmpeg -i $f -af silenceremove=start_periods=1:start_threshold=-45dB -ar 48000 -ac 1 ${f%.mp3}.wav; done
python3 synth2.py brian teaser-brian.wav          # or: cinematic teaser-cinematic.wav
```

The words in the finished mix were checked by transcribing it; nobody has listened to it by ear in the build.

One frame at the flatline is a full-screen light flash. There is one, not a series.
