#!/usr/bin/env bash
# Stop the pulse daemon: the owner disappears. Then follow the keeper log until the vault is Settled.
#
#   make kill   (or ./scripts/kill.sh)
#
# Expect: "owner is gone", then about 2-3 minutes later (poke is legal 120 s after the last beat,
# each settlement step takes ~15 s) the keeper log shows poke, steps 1-5 and "Settled".
set -uo pipefail
cd "$(dirname "$0")/.."
D=.demo
[ -f $D/pulse.pid ] || { echo "no $D/pulse.pid: run 'make demo' first" >&2; exit 1; }
PID=$(cat $D/pulse.pid)
# the recorded pid is the tsx wrapper; pkill by command line also reaches its node child
if pkill -f "src/cli.ts pulse"; then sleep 1; else echo "(pulse $PID was already stopped)"; fi
rm -f $D/pulse.pid
echo "owner is gone — watch the keeper"
echo "vault $(cat $D/vault_id 2>/dev/null || echo '?'): last beat just landed; poke becomes legal after 2 missed intervals (~2 min)"
echo

LOG=$D/keeper.log
[ -f $LOG ] || { echo "no keeper log at $LOG" >&2; exit 1; }
( tail -n 0 -f "$LOG" & echo $! > $D/tail.pid; wait ) &
TAILER=$!
DEADLINE=$((SECONDS + 600))
while ! grep -q -e '→ Settled' "$LOG"; do
  [ $SECONDS -lt $DEADLINE ] || { echo "timed out waiting for Settled; keeper log: $LOG" >&2; kill $(cat $D/tail.pid) 2>/dev/null; exit 1; }
  sleep 2
done
sleep 4   # let the relay lines for the foreign payouts print
kill $(cat $D/tail.pid) 2>/dev/null; wait $TAILER 2>/dev/null
rm -f $D/tail.pid
echo
echo "Settled. The keeper keeps running to retry any unfunded relay: stop it with  pkill -f 'src/cli.ts keeper'"
(cd keeper && npx tsx src/cli.ts status --token "$(cat ../$D/vault_id)") 2>/dev/null || true
