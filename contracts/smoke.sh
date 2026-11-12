#!/usr/bin/env bash
# Real testnet smoke test for the dmw contract (SPEC §2.6 / item 7).
#   contracts/smoke.sh <contract> <owner> <heir1> <heir2>
# Keys for owner/heir1 must be in keys/<acct>.json (scripts/near-admin.mjs create).
# Contract v2: the owner's own heartbeat attaches 1 yocto; pulse-key heartbeats attach nothing. heir1 runs the steps,
# so it is an operator for step 3 and mark_broadcast (findings C/E).
set -euo pipefail
cd "$(dirname "$0")/.."
C=$1 OWNER=$2 H1=$3 H2=$4
NA="node scripts/near-admin.mjs"
TX="node contracts/tools/tx.mjs"
run() { echo; echo "\$ $*"; "$@"; }
vault_field() { $NA view "$C" get_vault "{\"token_id\":\"$TOKEN\"}" | python3 -c "import json,sys;v=json.load(sys.stdin);print($1)"; }

echo "## create vault (interval 120 s while we set it up, grace 1, 5 NEAR + 0.1 storage)"
echo "## (testnet txs take ~5-10 s each, so the alive phase runs at 120 s and set_timing drops it to 20 s before the owner goes silent)"
out=$($TX call "$OWNER" "$C" create_vault "{\"heartbeat_interval_s\":120,\"grace_missed\":1,\"heirs\":[{\"account_id\":\"$H1\",\"bps\":6000},{\"account_id\":\"$H2\",\"bps\":4000}],\"policy\":{\"per_tx_max\":\"500000000000000000000000\",\"daily_max\":\"800000000000000000000000\",\"allowlist\":[\"$H2\"]},\"bounty\":\"50000000000000000000000\"}" 100 5.1)
echo "\$ $TX call $OWNER $C create_vault {...} 100 5.1"; echo "$out"
TOKEN=$(echo "$out" | sed -n 's/.*result: "\([0-9]*\)".*/\1/p')
echo "TOKEN=$TOKEN"

PULSE=$($NA genkey); AGENT=$($NA genkey)
PULSE_PK=$(echo "$PULSE" | python3 -c "import json,sys;print(json.load(sys.stdin)['public_key'])")
PULSE_SK=$(echo "$PULSE" | python3 -c "import json,sys;print(json.load(sys.stdin)['private_key'])")
AGENT_PK=$(echo "$AGENT" | python3 -c "import json,sys;print(json.load(sys.stdin)['public_key'])")
AGENT_SK=$(echo "$AGENT" | python3 -c "import json,sys;print(json.load(sys.stdin)['private_key'])")
echo "pulse key $PULSE_PK, agent key $AGENT_PK (private keys not recorded)"

echo; echo "## add pulse + agent keys (function-call keys on $C)"
run $TX call "$OWNER" "$C" add_pulse_key "{\"token_id\":\"$TOKEN\",\"public_key\":\"$PULSE_PK\"}" 50 1y
run $TX call "$OWNER" "$C" add_agent_key "{\"token_id\":\"$TOKEN\",\"public_key\":\"$AGENT_PK\"}" 50 1y
echo; echo "\$ $NA keys $C   # filtered to the two new keys"
$NA keys "$C" | python3 -c "
import json,sys
for k in json.load(sys.stdin)['keys']:
    if k['public_key'] in ('$PULSE_PK','$AGENT_PK'): print(json.dumps(k))"

echo; echo "## heartbeat signed by the pulse key (signer = contract account)"
echo "\$ $TX call-with-key $C <pulse-private-key> $C heartbeat '{\"token_id\":\"$TOKEN\"}' 10"
$TX call-with-key "$C" "$PULSE_SK" "$C" heartbeat "{\"token_id\":\"$TOKEN\"}" 10

echo; echo "## owner heartbeat: contract v2 requires exactly 1 yoctoNEAR on the owner's path (finding F)"
$TX call "$OWNER" "$C" heartbeat "{\"token_id\":\"$TOKEN\"}" 10 || echo "(rejected without the yocto, as expected)"
run $TX call "$OWNER" "$C" heartbeat "{\"token_id\":\"$TOKEN\"}" 10 1y

echo; echo "## pulse key cannot call agent_pay (access-key scope, rejected before execution)"
echo "\$ $TX call-with-key $C <pulse-private-key> $C agent_pay '{...}' 30"
$TX call-with-key "$C" "$PULSE_SK" "$C" agent_pay "{\"token_id\":\"$TOKEN\",\"receiver_id\":\"$H2\",\"amount\":\"1\"}" 30 || echo "(rejected as expected)"

echo; echo "## agent_pay: allowed, then denied x3"
for args in \
  "{\"token_id\":\"$TOKEN\",\"receiver_id\":\"$H2\",\"amount\":\"300000000000000000000000\",\"memo\":\"api credits\"}" \
  "{\"token_id\":\"$TOKEN\",\"receiver_id\":\"$H2\",\"amount\":\"900000000000000000000000\"}" \
  "{\"token_id\":\"$TOKEN\",\"receiver_id\":\"$OWNER\",\"amount\":\"100000000000000000000000\"}" \
  "{\"token_id\":\"$TOKEN\",\"receiver_id\":\"$H2\",\"amount\":\"400000000000000000000000\"}" \
  "{\"token_id\":\"$TOKEN\",\"receiver_id\":\"$H2\",\"amount\":\"400000000000000000000000\"}"; do
  echo "\$ $TX call-with-key $C <agent-private-key> $C agent_pay '$args' 30"
  $TX call-with-key "$C" "$AGENT_SK" "$C" agent_pay "$args" 30
done

echo; echo "## set_timing to 20 s / grace 1, then one last pulse-key heartbeat"
run $TX call "$OWNER" "$C" set_timing "{\"token_id\":\"$TOKEN\",\"heartbeat_interval_s\":20,\"grace_missed\":1}" 30 1y
echo "\$ $TX call-with-key $C <pulse-private-key> $C heartbeat '{\"token_id\":\"$TOKEN\"}' 10"
$TX call-with-key "$C" "$PULSE_SK" "$C" heartbeat "{\"token_id\":\"$TOKEN\"}" 10

echo; echo "## poke too early"
run $TX call "$H1" "$C" poke "{\"token_id\":\"$TOKEN\"}" 30 || echo "(not_due as expected)"

echo; echo "## owner goes silent; wait until trigger_at_ms"
while :; do
  st=$(vault_field "v['state']"); echo "state=$st"
  now=$(($(date +%s%3N))); trig=$(vault_field "v['trigger_at_ms']")
  [ "$now" -gt "$((trig + 2000))" ] && break; sleep 5
done

echo; echo "## poke (heir earns the bounty)"
run $TX call "$H1" "$C" poke "{\"token_id\":\"$TOKEN\"}" 30
echo; echo "## heartbeat after trigger is rejected"
$TX call-with-key "$C" "$PULSE_SK" "$C" heartbeat "{\"token_id\":\"$TOKEN\"}" 10 || echo "(vault_triggered as expected)"

echo; echo "## execute_step until Settled"
for i in 1 2 3 4 5; do
  run $TX call "$H1" "$C" execute_step "{\"token_id\":\"$TOKEN\"}" 300
  sleep 2
done
run $TX call "$H1" "$C" execute_step "{\"token_id\":\"$TOKEN\"}" 300 || echo "(already_settled as expected)"

echo; echo "## pulse/agent keys gone from the contract account?"
$NA keys "$C" | python3 -c "
import json,sys
ks=[k['public_key'] for k in json.load(sys.stdin)['keys']]
print('pulse present:', '$PULSE_PK' in ks, ' agent present:', '$AGENT_PK' in ks)"

echo; echo "## claim reserve as new Will NFT owner ($H1)"
run $TX call "$H1" "$C" claim "{\"token_id\":\"$TOKEN\"}" 30

echo; echo "## final get_vault"
run $NA view "$C" get_vault "{\"token_id\":\"$TOKEN\"}"
echo; echo "## nft_token owner + media prefix"
$NA view "$C" nft_token "{\"token_id\":\"$TOKEN\"}" | python3 -c "import json,sys;t=json.load(sys.stdin);print(t['owner_id'], t['metadata']['media'][:40]+'...', t['metadata']['extra'])"
