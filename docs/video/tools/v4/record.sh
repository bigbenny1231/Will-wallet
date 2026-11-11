#!/usr/bin/env bash
# v4 recording, end to end on the .env contract: demo vault (setup.sh), dashboard production build on :5173, stage on
# :5057, then run.mjs. Leaves raw.mp4, events.json, endinfo.json and the logs in $S/raw-pack (the edit's input).
#   docs/video/tools/v4/record.sh            env: S (default /tmp/v4), FF (default ffmpeg), PW_MODULE (playwright)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export REPO="$(cd "$HERE/../../../.." && pwd)" S="${S:-/tmp/v4}" FF="${FF:-ffmpeg}"
mkdir -p "$S"; cd "$REPO"
. scripts/lib.sh; load_env
[ -n "${DMW_CONTRACT:-}" ] || die "DMW_CONTRACT is not set"
export DMW_CONTRACT
"$HERE/setup.sh"
cd "$REPO/dashboard"
VITE_DMW_CONTRACT="$DMW_CONTRACT" VITE_NEAR_NETWORK=testnet VITE_PUBLIC_ORIGIN=http://localhost:5173 npx vite build --logLevel warn
(npx vite preview --port 5173 --strictPort > "$S/preview.log" 2>&1 &) ; cd "$REPO"
(node "$HERE/serve.mjs" > "$S/serve.log" 2>&1 &)
for _ in $(seq 60); do curl -sf http://localhost:5173/ >/dev/null && curl -sf http://localhost:5057/ >/dev/null && break; sleep 1; done
set +e; node "$HERE/run.mjs"; RC=$?; set -e
make stop >/dev/null 2>&1 || true
mkdir -p "$S/raw-pack"
cp "$S/raw.mp4" "$S/events.json" "$S/endinfo.json" "$S/agent.out" "$S/setup.out" "$S/demo.out" "$S/raw-pack/" 2>/dev/null || true
cp .demo/keeper.log "$S/raw-pack/keeper.log" 2>/dev/null || true
cp .demo/agent-transcript.md .demo/agent-transcript-b.md "$S/raw-pack/" 2>/dev/null || true
exit $RC
