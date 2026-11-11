#!/usr/bin/env bash
# v4 edit: events -> EDL (autoedl.mjs), cards and captions (assets.mjs), cut and overlay (cut.mjs), then the 720p copy
# and one still per caption.   docs/video/tools/v4/edit.sh <out dir>     env: S, FF, PW_MODULE
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export REPO="$(cd "$HERE/../../../.." && pwd)" S="${S:-/tmp/v4}" FF="${FF:-ffmpeg}"
OUTDIR="${1:?out dir}"; mkdir -p "$OUTDIR/stills"
[ -f "$S/raw.mp4" ] || { echo "no $S/raw.mp4"; exit 1; }
pgrep -f "v4/serve.mjs" >/dev/null || (node "$HERE/serve.mjs" > "$S/serve.log" 2>&1 &)
for _ in $(seq 30); do curl -sf http://localhost:5057/caption.html >/dev/null && break; sleep 1; done
node "$HERE/autoedl.mjs" | tee "$OUTDIR/edl.txt"
node "$HERE/assets.mjs"
node "$HERE/cut.mjs" "$S/dmw-demo-v4.mp4"
"$FF" -y -v error -i "$S/dmw-demo-v4.mp4" -vf scale=1280:720:flags=lanczos -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart "$S/dmw-demo-v4-720p.mp4"
cp "$S/dmw-demo-v4.mp4" "$S/dmw-demo-v4-720p.mp4" "$OUTDIR/"
cp "$S/events.json" "$S/edl.json" "$S/captions.json" "$S/endinfo.json" "$OUTDIR/" 2>/dev/null || true
for f in setup.out agent.out keeper.log demo.out; do
  if [ -f "$S/raw-pack/$f" ]; then cp "$S/raw-pack/$f" "$OUTDIR/"; elif [ -f "$S/$f" ]; then cp "$S/$f" "$OUTDIR/"; fi
done
# one still per caption (its midpoint) plus the end card, for review without downloading the video
node -e 'const e=require(process.argv[1]);const ts=e.capT.map(c=>(c.s+c.e)/2);ts.push(e.TOTAL-2);console.log(ts.map(t=>t.toFixed(2)).join(" "))' "$S/edl.json" | tr ' ' '\n' | nl -nrz -w2 | while read -r i t; do
  "$FF" -y -v error -ss "$t" -i "$S/dmw-demo-v4.mp4" -frames:v 1 -vf scale=1280:-2 "$OUTDIR/stills/$i.jpg"
done
ls -la "$OUTDIR"
