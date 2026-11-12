#!/usr/bin/env bash
# Create the long-lived showcase vault on the .env contract (the one the site's live estate graph reads).
#
#   ./scripts/showcase.sh
#
# Owner dmw-andrew-<s> (with KEEPER_SEED set: the derived long-lived dmw-showcase-<tag>, beaten daily by keeper.yml), heirs dmw-sarah-<s> 60 % (primary) and dmw-ben-<s> 40 %, agent allowlist dmw-api-<s>,
# 60-day interval with grace 1, 5 NEAR, bounty 0.05 NEAR, and Base / Monad / Solana payouts to the heir-held
# addresses in keeper/SHOWCASE.md. Writes .demo/showcase.json (token id, accounts, derived source addresses).
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh
load_env
ensure_deps keeper
[ -n "${DMW_CONTRACT:-}" ] || die "DMW_CONTRACT is not set: run 'make deploy' first"
C=$DMW_CONTRACT; D=.demo; mkdir -p $D
ADMIN="node scripts/near-admin.mjs"; TX="node contracts/tools/tx.mjs"
S=$(rand_hex 2)
OWNER=dmw-andrew-$S.testnet; SARAH=dmw-sarah-$S.testnet; BEN=dmw-ben-$S.testnet; API=dmw-api-$S.testnet
if [ -n "${KEEPER_SEED:-}" ]; then
  # v3: the owner is the long-lived account derived from KEEPER_SEED, so the hosted keeper (keeper.yml) can send its
  # heartbeat every day and the vault stays Alive.
  OWNER=$($ADMIN derive-account showcase) || die "could not derive the showcase owner"
fi
say "showcase accounts (suffix $S, owner $OWNER)"
for a in $OWNER $SARAH $BEN $API; do account_exists $a || $ADMIN create $a; done
sleep 3
say "create_vault (60 days, grace 1, 5 NEAR + 0.1 storage)"
OUT=$($TX call $OWNER $C create_vault "{\"heartbeat_interval_s\":5184000,\"grace_missed\":1,\"heirs\":[{\"account_id\":\"$SARAH\",\"bps\":6000},{\"account_id\":\"$BEN\",\"bps\":4000}],\"policy\":{\"per_tx_max\":\"500000000000000000000000\",\"daily_max\":\"1000000000000000000000000\",\"allowlist\":[\"$API\"]},\"bounty\":\"50000000000000000000000\"}" 100 5.1)
echo "$OUT" | grep -E '^tx |result'
TOKEN=$(echo "$OUT" | sed -n 's/.*result: "\([0-9]*\)".*/\1/p' | tail -1)
[ -n "$TOKEN" ] || { echo "$OUT"; die "create_vault did not return a token id"; }
DER=$(cd keeper && npx tsx src/cli.ts derive --token $TOKEN --json)
j() { echo "$DER" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).$1.address)"; }
B=$(j base); M=$(j monad); SO=$(j solana)
say "foreign payouts (Base 0.0005 ETH, Monad 0.01 MON, Solana 0.01 SOL)"
$TX call $OWNER $C set_foreign_payouts "{\"token_id\":\"$TOKEN\",\"payouts\":[{\"chain\":\"base\",\"to\":\"0xfd151ad02f573689f235f56059ce6e2f3b64dd89\",\"amount\":\"500000000000000\",\"from_address\":\"$B\"},{\"chain\":\"monad\",\"to\":\"0xfd151ad02f573689f235f56059ce6e2f3b64dd89\",\"amount\":\"10000000000000000\",\"from_address\":\"$M\"},{\"chain\":\"solana\",\"to\":\"HpEHvLpa9pMNiDCQDnVMSomCx4bmJuXX8sKqtKGg2uWr\",\"amount\":\"10000000\",\"from_address\":\"$SO\"}]}" 50 1y | grep -E '^tx |result'
node -e 'const [t,o,s,b,a,base,monad,sol]=process.argv.slice(1);require("fs").writeFileSync(".demo/showcase.json",JSON.stringify({token:t,owner:o,heirs:[s,b],api:a,sources:{base,monad,solana:sol}},null,1))' "$TOKEN" "$OWNER" "$SARAH" "$BEN" "$API" "$B" "$M" "$SO"
echo "showcase vault $TOKEN on $C (owner $OWNER); sources base $B monad $M solana $SO"
