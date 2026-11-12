#!/usr/bin/env bash
# v4 demo vault on the .env contract: make demo, then +1.5 NEAR, a phone pulse key, Base + Monad + Solana payouts and a
# guardian (10 min max pause). Same vault as v3. Env: REPO, S.
set -euo pipefail
cd "$REPO"
TERM=dumb NO_COLOR=1 make demo 2>&1 | tee "$S/demo.out"
. scripts/lib.sh; load_env
T=$(cat .demo/vault_id); C=$DMW_CONTRACT; SFX=$(cat .demo/suffix)
O=$(grep -o 'created dmw-demo-owner-[0-9a-f]*\.testnet' "$S/demo.out" | awk '{print $2}')
TX="node contracts/tools/tx.mjs"
echo "== setup v4: vault $T owner $O on $C" | tee "$S/setup.out"
$TX call "$O" "$C" deposit "{\"token_id\":\"$T\"}" 30 1.5 | tee -a "$S/setup.out"
( umask 077; node scripts/near-admin.mjs genkey > "$S/phone.key.json" )
[ -n "${GITHUB_ACTIONS:-}" ] && ./scripts/ci/mask.sh && node -e 'const k=require(process.argv[1]).private_key;console.log("::add-mask::"+k);console.log("::add-mask::"+k.replace(/^ed25519:/,""))' "$S/phone.key.json"
PUB=$(node -e 'console.log(require(process.argv[1]).public_key)' "$S/phone.key.json")
SEC=$(node -e 'console.log(require(process.argv[1]).private_key)' "$S/phone.key.json")
$TX call "$O" "$C" add_pulse_key "{\"token_id\":\"$T\",\"public_key\":\"$PUB\"}" 50 1y | tee -a "$S/setup.out"
DER=$(cd keeper && npx tsx src/cli.ts derive --token "$T" --json)
j() { echo "$DER" | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).$1.address)"; }
B=$(j base); M=$(j monad); SO=$(j solana)
$TX call "$O" "$C" set_foreign_payouts "{\"token_id\":\"$T\",\"payouts\":[{\"chain\":\"base\",\"to\":\"0xfd151ad02f573689f235f56059ce6e2f3b64dd89\",\"amount\":\"500000000000000\",\"from_address\":\"$B\"},{\"chain\":\"monad\",\"to\":\"0xfd151ad02f573689f235f56059ce6e2f3b64dd89\",\"amount\":\"10000000000000000\",\"from_address\":\"$M\"},{\"chain\":\"solana\",\"to\":\"HpEHvLpa9pMNiDCQDnVMSomCx4bmJuXX8sKqtKGg2uWr\",\"amount\":\"10000000\",\"from_address\":\"$SO\"}]}" 50 1y | tee -a "$S/setup.out"
echo "  base $B  monad $M  solana $SO" | tee -a "$S/setup.out"
G=dmw-demo-guardian-$SFX.testnet
FUNDER=$(ls keys/dmw-demo-funder-*.testnet.json 2>/dev/null | head -1 | xargs -r basename | sed 's/\.json$//')
if [ ! -f "keys/$G.json" ]; then
  # paid for by the demo funder through the testnet registrar (no faucet call); faucet only as a fallback
  { [ -n "$FUNDER" ] && node scripts/near-admin.mjs fund "$FUNDER" "$G" 0.3; } || node scripts/near-admin.mjs create "$G"
fi
[ -n "${GITHUB_ACTIONS:-}" ] && ./scripts/ci/mask.sh
$TX call "$O" "$C" set_guardian "{\"token_id\":\"$T\",\"guardian_id\":\"$G\",\"max_pause_s\":600}" 50 1y | tee -a "$S/setup.out"
( umask 077; echo "http://localhost:5173/pulse#c=$C&t=$T&k=$SEC" > "$S/pairing.url" )
echo "== ready: vault $T"
