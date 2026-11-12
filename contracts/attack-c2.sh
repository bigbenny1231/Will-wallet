#!/usr/bin/env bash
# Live regression check for finding C-2 (docs/SECURITY_REVIEW_3.md) against a deployed contract.
#
#   contracts/attack-c2.sh <contract> <attacker> <heir> <evil-dao>
#
# The attacker deploys contracts/tools/evil-dao (keeps the 1 NEAR step-4 bond, returns a promise that fails),
# opens a vault with that "DAO", lets it trigger, runs the five steps and claims as the heir. On the old code the
# vault got the bond back as well, and claim paid 1 NEAR more than the vault held, out of other vaults' NEAR.
# Pass: after step 4 the vault balance is the step-3 balance minus the 1 NEAR bond, the claim pays no more than the
# vault's own balance after step 5, and the attacker's three accounts end below where they started. Contract v2
# (finding L-9) releases the vault's unused storage deposit at step 5, so the step-5 balance may be above the step-4
# balance by at most the 0.1 NEAR storage fee taken at create_vault. Since the second v2 review (F3) step 5 pays that
# release straight to the heirs by bps instead, so b5 == b4 is the expected value; the bound still holds.
# The attacker pokes and runs the steps (300 TGas each needs ~0.3 NEAR of balance); the heir only claims.
# Keys for all three accounts must be in keys/<acct>.json (scripts/near-admin.mjs create).
set -euo pipefail
cd "$(dirname "$0")/.."
C=$1 ATT=$2 HEIR=$3 EVIL=$4
NA="node scripts/near-admin.mjs"
TX="node contracts/tools/tx.mjs"
RPC="${NEAR_RPC:-https://rpc.testnet.fastnear.com}"
bal() { curl -s "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['amount'])"; }
near() { python3 -c "print(f'{int(\"$1\")/1e24:.4f}')"; }
vault() { $NA view "$C" get_vault "{\"token_id\":\"$TOKEN\"}"; }
field() { vault | python3 -c "import json,sys;v=json.load(sys.stdin);print($1)"; }

echo "## deploy the attacker's \"DAO\" ($EVIL, contracts/tools/evil-dao)"
$NA deploy "$EVIL" contracts/tools/evil-dao/evil_dao.wasm

A0=$(bal "$ATT"); H0=$(bal "$HEIR"); E0=$(bal "$EVIL"); C0=$(bal "$C")
echo "start: attacker $(near $A0)  heir $(near $H0)  dao $(near $E0)  contract $(near $C0) NEAR"

echo; echo "## create_vault: 10 s interval, grace 0, heir 100 %, 1.7 NEAR"
out=$($TX call "$ATT" "$C" create_vault "{\"heartbeat_interval_s\":10,\"grace_missed\":0,\"heirs\":[{\"account_id\":\"$HEIR\",\"bps\":10000}]}" 100 1.7)
echo "$out"
TOKEN=$(echo "$out" | sed -n 's/.*result: "\([0-9]*\)".*/\1/p'); echo "TOKEN=$TOKEN"
echo; echo "## set_dao -> $EVIL"
$TX call "$ATT" "$C" set_dao "{\"token_id\":\"$TOKEN\",\"dao_id\":\"$EVIL\"}" 30 1y

echo; echo "## wait for the deadline, then poke"
while :; do now=$(date +%s%3N); trig=$(field "v['trigger_at_ms']"); [ "$now" -gt "$((trig + 2000))" ] && break; sleep 3; done
$TX call "$ATT" "$C" poke "{\"token_id\":\"$TOKEN\"}" 30

declare -A B
for i in 1 2 3 4 5; do
  echo; echo "## execute_step (step $i)"
  $TX call "$ATT" "$C" execute_step "{\"token_id\":\"$TOKEN\"}" 300
  sleep 2
  B[$i]=$(field "v['balance']"); echo "vault balance after step $i: $(near ${B[$i]}) NEAR, step now $(field "v['step']"), state $(field "v['state']")"
done
echo; echo "## the vault's own log for step 4"
vault | python3 -c "
import json,sys
for e in json.load(sys.stdin)['log']:
    if 'dao' in e.get('kind','') or 'dao' in json.dumps(e): print(json.dumps(e))"

echo; echo "## claim as the heir"
CL=$($TX call "$HEIR" "$C" claim "{\"token_id\":\"$TOKEN\"}" 30); echo "$CL"
PAID=$(echo "$CL" | sed -n 's/.*result: "\([0-9]*\)".*/\1/p')

sleep 3
A1=$(bal "$ATT"); H1=$(bal "$HEIR"); E1=$(bal "$EVIL"); C1=$(bal "$C")
NET=$(python3 -c "print(($A1+$H1+$E1)-($A0+$H0+$E0))")
echo
echo "## result"
echo "vault balance after step 3: $(near ${B[3]})  after step 4: $(near ${B[4]})  (bond 1 NEAR)  after step 5: $(near ${B[5]})  (storage release goes to the heirs)"
echo "claim paid: $(near ${PAID:-0}) NEAR"
echo "attacker + heir + dao, net: $(near $NET) NEAR"
echo "contract account: $(near $C0) -> $(near $C1) NEAR"
python3 - "${B[3]}" "${B[4]}" "${B[5]}" "${PAID:-0}" "$NET" <<'PY'
import sys
b3, b4, b5, paid, net = (int(x) for x in sys.argv[1:])
ONE = 10**24
STORAGE_FEE = ONE // 10
ok = (b3 - b4 == ONE) and (0 <= b5 - b4 <= STORAGE_FEE) and (paid <= b5) and (net < 0)
print("C-2 drain: BLOCKED (bond not credited back, attacker lost money)" if ok else "C-2 drain: NOT BLOCKED or unexpected numbers")
sys.exit(0 if ok else 1)
PY
