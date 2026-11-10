# Teaser (10.5 s, for X)

A heartbeat that speeds up, flatlines, and becomes the five settlement steps, under one deep voice:

> If you die tonight… your agent keeps spending.
> Not anymore.
> Your crypto shouldn't die with you.

Every frame is drawn by code (`teaser.html` exposes `renderFrame(i)`, a pure function of the frame index) in the
site's own type and colours. Nothing in it is footage, and vault 0042 is the same example vault as the site's hero.
The voice is recorded first and the picture is cut to it: `build.py` asks ElevenLabs for each line with character
timings and writes the timeline (`vo/timeline.json`, and the `const TL = ...` line of `teaser.html`) from them.

| Time | Picture | Sound |
| --- | --- | --- |
| 0:00 | The trace and the seal, alive | music and heartbeat, no voice yet |
| 0:01 to 0:04 | "If you die tonight," then "your agent keeps spending.", each on its words; the beats close in | line 1 |
| 0:04.1 | Flatline: the trace and the seal turn red | the cue's hit, the monitor tone |
| 0:04.7 | "Not anymore." | line 2 |
| 0:05.7 to 0:07.3 | Steps I to V as ticks on the flat line | a stamp for each |
| 0:07.3 | "Settled." | the tone stops; a short silence |
| 0:07.8 to 0:10.5 | End card: seal, name, tagline | line 3, a chord, then one heartbeat as the seal turns green |

The claims are the ones the README makes: heirs paid on NEAR, the agent key deleted, Base, Monad and Solana payouts
**signed** (not relayed), a DAO proposal filed when a DAO is named, the Will NFT to the heir.

## Files

| File | What | Made with |
| --- | --- | --- |
| `vo/a.mp3`, `b.mp3`, `c.mp3` | the three lines, voice "Declan Sage" from the ElevenLabs voice library | `eleven_multilingual_v2`, stability 0.8, speed 0.92 |
| `vo/align.json`, `vo/timeline.json` | where each phrase starts and ends; the cut points derived from that | `build.py` |
| `el/cueA.mp3` | 24 s cue: a rising build, an orchestral hit, a decaying drone | ElevenLabs Music API, `music_v1`, from `el/planA.json` |
| `el/sfx_riser.mp3`, `sfx_hit.mp3`, `sfx_chord.mp3` | riser into the flatline, the impact, the chord under the end card | ElevenLabs sound-generation API |
| `synth.py` | the mix: places the cue so its own hit lands on the flatline, synthesises the heart, monitor tone and stamps (they must land on exact frames), keeps the voice on a clean path of its own | numpy, ffmpeg |
| `render.cjs` | captures the frames | Playwright |

The voice was chosen by measurement, because nobody listened during the build: of nine candidates reading the tagline,
this one had the lowest median pitch (about 74 Hz) and the narrowest pitch range. The words and their timing in the
finished file were checked by transcribing it.

## Build

```bash
cd docs/video/tools/teaser
mkdir -p frames && node render.cjs 1920 1080 frames        # 314 PNG frames, about 5 min; 1080 1080 for square
python3 synth.py vo teaser.wav                             # the mix
ffmpeg -framerate 30 -i frames/f%04d.png -i teaser.wav -c:v libx264 -preset slow -crf 15 -pix_fmt yuv420p \
       -c:a aac -b:a 192k -shortest -movflags +faststart dmw-teaser.mp4
```

To change the words or the voice, run `build.py` (usage at its top; it needs `ELEVENLABS_API_KEY`), then the three
commands above. The mp4 is not committed.

One frame at the flatline is a full-screen light flash. There is one, not a series.
