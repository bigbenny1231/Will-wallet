#!/usr/bin/env bash
# CI only (testnet.yml, task=all): leave one real vault on the new contract for the scheduled keeper
# (.github/workflows/keeper.yml) to settle on its own. Nothing in this job drives it: its owner stops beating at once,
# the poke becomes legal 240 s after creation (120 s interval, grace 1), and the keeper workflow, which runs every
# 10 minutes as the contract keeper, pokes it and runs the five steps. Its token id goes to $OUT/sentinel.txt; the
# keeper workflow's log then shows each transaction.
#   ./scripts/ci/sentinel.sh <contract>
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/lib.sh
C=$1; ADMIN="node scripts/near-admin.mjs"
O="dmw-sentinel-$(rand_hex 3).testnet"
$ADMIN create "$O" >/dev/null || die "faucet could not create $O"
./scripts/ci/mask.sh
for _ in $(seq 15); do account_exists "$O" && break; sleep 2; done
$ADMIN sub "$O" heir1 0.2 >/dev/null; $ADMIN sub "$O" heir2 0.2 >/dev/null; ./scripts/ci/mask.sh; sleep 3
OUTP=$($ADMIN call "$O" "$C" create_vault "{\"heartbeat_interval_s\":120,\"grace_missed\":1,\"heirs\":[{\"account_id\":\"heir1.$O\",\"bps\":5000},{\"account_id\":\"heir2.$O\",\"bps\":5000}],\"policy\":{\"per_tx_max\":\"100000000000000000000000\",\"daily_max\":\"100000000000000000000000\",\"allowlist\":[\"heir1.$O\"]},\"bounty\":\"10000000000000000000000\"}" 100 2.1)
echo "$OUTP" | grep -E '^tx |result'
TOKEN=$(echo "$OUTP" | sed -n 's/.*result: "\([0-9]*\)".*/\1/p' | tail -1)
[ -n "$TOKEN" ] || die "create_vault did not return a token id"
echo "sentinel vault $TOKEN owned by $O, created $(date -u +%FT%TZ); left for the scheduled keeper" | tee "${OUT:-.}/sentinel.txt"
