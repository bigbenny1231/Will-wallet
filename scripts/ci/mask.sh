#!/usr/bin/env bash
# GitHub Actions only: register every private key this repo has on disk as a log mask, so no later step can print
# one. Covers keys/*.json, .demo/*.key.json and KEEPER_PRIVATE_KEY in .env. Each file is masked once (state in
# $RUNNER_TEMP); the workflow runs this in a loop while accounts are being made. Prints nothing else.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -n "${GITHUB_ACTIONS:-}" ] || exit 0
SEEN="${RUNNER_TEMP:-/tmp}/dmw-masked"; touch "$SEEN"
emit() { [ -n "$1" ] || return 0; echo "::add-mask::$1"; echo "::add-mask::${1#ed25519:}"; }
for f in keys/*.json .demo/*.key.json; do
  [ -f "$f" ] || continue
  id="$f $(stat -c %Y "$f")"; grep -qxF "$id" "$SEEN" && continue
  emit "$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).private_key||"")}catch{}' "$f")"
  echo "$id" >> "$SEEN"
done
if [ -f .env ]; then
  k="$(sed -n 's/^KEEPER_PRIVATE_KEY=//p' .env)"; id="env $(printf %s "$k" | sha256sum | cut -c1-16)"
  grep -qxF "$id" "$SEEN" || { emit "$k"; echo "$id" >> "$SEEN"; }
fi
