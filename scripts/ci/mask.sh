#!/usr/bin/env bash
# GitHub Actions only: register every private key this repo has on disk as a log mask, so no later step can print
# one. Covers keys/*.json, .demo/*.key.json and KEEPER_PRIVATE_KEY in .env. Prints nothing else.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -n "${GITHUB_ACTIONS:-}" ] || exit 0
emit() { [ -n "$1" ] || return 0; echo "::add-mask::$1"; echo "::add-mask::${1#ed25519:}"; }
for f in keys/*.json .demo/*.key.json; do
  [ -f "$f" ] || continue
  emit "$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).private_key||"")}catch{}' "$f")"
done
if [ -f .env ]; then emit "$(sed -n 's/^KEEPER_PRIVATE_KEY=//p' .env)"; fi
