#!/usr/bin/env bash
# One-command testnet demo (about 1 minute of setup, then you kill the owner).
#
#   make demo   (or ./scripts/demo.sh)
#
# What happens: checks .env, makes faucet accounts if missing, creates a vault (60 s interval, grace 1,
# two heirs, agent policy, one Base and one Solana payout), adds a pulse key and an agent key, runs the
# agent guard-rail demo (one allowed, one denied), then starts the pulse daemon and the keeper in the
# background (logs in .demo/). Finish with `make kill`.
# Expect: a vault id, a dashboard URL, and a hint to run `make kill`.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
[ -f .env ] && set -a && . ./.env && set +a
D=.demo; mkdir -p $D
ADMIN="node scripts/near-admin.mjs"; TX="node contracts/tools/tx.mjs"

say() { printf '\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

# 1. env checks
for v in DMW_CONTRACT KEEPER_ACCOUNT_ID KEEPER_PRIVATE_KEY; do
  [ -n "${!v:-}" ] || die "$v is not set in .env (see keeper/.env.example; create a keeper with: node scripts/near-admin.mjs create dmw-keeper-<rand>.testnet)"
done
[ -d keeper/node_modules ] || die "run: cd keeper && npm install"
C=$DMW_CONTRACT

# a previous demo still running? stop it so two pulses/keepers do not fight
pkill -f "src/cli.ts pulse" 2>/dev/null || true
pkill -f "src/cli.ts keeper" 2>/dev/null || true
rm -f $D/pulse.pid $D/keeper.pid

# 2. accounts: heirs and api are reused between runs, the owner is fresh each time (the vault takes 4.1 NEAR)
SUFFIX_FILE=$D/suffix
[ -f $SUFFIX_FILE ] || openssl rand -hex 2 > $SUFFIX_FILE
S=$(cat $SUFFIX_FILE)
HEIR1=dmw-demo-sarah-$S.testnet; HEIR2=dmw-demo-ben-$S.testnet; API=dmw-demo-api-$S.testnet
OWNER=dmw-demo-owner-$(openssl rand -hex 3).testnet
say "accounts"
for a in $HEIR1 $HEIR2 $API; do
  if [ -f keys/$a.json ]; then echo "have $a"; else $ADMIN create $a; fi
done
$ADMIN create $OWNER

# 3. vault: 60 s interval, grace 1 (poke becomes legal 120 s after the last beat)
say "create vault (4 NEAR, 60 s interval, grace 1)"
OUT=$($TX call $OWNER $C create_vault "{\"heartbeat_interval_s\":60,\"grace_missed\":1,\"heirs\":[{\"account_id\":\"$HEIR1\",\"bps\":6000},{\"account_id\":\"$HEIR2\",\"bps\":4000}],\"policy\":{\"per_tx_max\":\"500000000000000000000000\",\"daily_max\":\"1000000000000000000000000\",\"allowlist\":[\"$API\"]},\"bounty\":\"50000000000000000000000\"}" 100 4.1)
echo "$OUT" | grep -E '^tx |result' 
TOKEN=$(echo "$OUT" | sed -n 's/.*result: "\([0-9]*\)".*/\1/p' | tail -1)
[ -n "$TOKEN" ] || { echo "$OUT"; die "create_vault did not return a token id"; }
echo $TOKEN > $D/vault_id

# 4. keys (secrets stay in .demo/, which is gitignored)
say "keys"
$ADMIN genkey > $D/pulse.key.json; $ADMIN genkey > $D/agent.key.json; chmod 600 $D/*.key.json
jqk() { node -e "console.log(JSON.parse(require('fs').readFileSync('$1','utf8')).$2)"; }
PULSE_PUB=$(jqk $D/pulse.key.json public_key); AGENT_PUB=$(jqk $D/agent.key.json public_key)
$TX call $OWNER $C add_pulse_key "{\"token_id\":\"$TOKEN\",\"public_key\":\"$PULSE_PUB\"}" 50 | grep -E '^tx |result'
$TX call $OWNER $C add_agent_key "{\"token_id\":\"$TOKEN\",\"public_key\":\"$AGENT_PUB\"}" 50 | grep -E '^tx |result'

# 5. start the pulse now (keeps the vault Alive while we set up payouts and show the agent)
(cd keeper; DMW_PULSE_KEY=$(jqk ../$D/pulse.key.json private_key) nohup ./node_modules/.bin/tsx src/cli.ts pulse --token $TOKEN --interval 20 > ../$D/pulse.log 2>&1 & echo $! > ../$D/pulse.pid)
say "pulse started (pid $(cat $D/pulse.pid), beats every 20 s) -> $D/pulse.log"

# 6. foreign payouts with their derived source addresses
say "foreign payouts (Base 0.0005 ETH, Solana 0.01 SOL)"
DER=$(cd keeper && npx tsx src/cli.ts derive --token $TOKEN --json)
BASE_FROM=$(echo "$DER" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).base.address)")
SOL_FROM=$(echo "$DER" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).solana.address)")
$TX call $OWNER $C set_foreign_payouts "{\"token_id\":\"$TOKEN\",\"payouts\":[{\"chain\":\"base\",\"to\":\"0xcA024adC7cac111339Fe077C739F8085aE705F2F\",\"amount\":\"500000000000000\",\"from_address\":\"$BASE_FROM\"},{\"chain\":\"solana\",\"to\":\"CFdWXa1ean7bBoewSv2SZESrDpWSxeoN1hfLrqaqZQUr\",\"amount\":\"10000000\",\"from_address\":\"$SOL_FROM\"}]}" 50 | grep -E '^tx |result'
echo "  base source   $BASE_FROM"; echo "  solana source $SOL_FROM"

# 7. the agent guard rails: one allowed, one denied
say "agent-demo: one allowed, one denied"
(cd keeper && DMW_AGENT_KEY=$(jqk ../$D/agent.key.json private_key) npx tsx src/cli.ts agent-demo --token $TOKEN)

# 8. keeper in the background, only for this vault
(cd keeper; nohup ./node_modules/.bin/tsx src/cli.ts keeper --poll 5 --token $TOKEN > ../$D/keeper.log 2>&1 & echo $! > ../$D/keeper.pid)
say "keeper started (pid $(cat $D/keeper.pid)) -> $D/keeper.log"

cat <<MSG

  vault id      $TOKEN   (owner $OWNER, heirs $HEIR1 / $HEIR2)
  dashboard     http://localhost:5173/vault/$TOKEN   (cd dashboard && npm run dev)
  explorer      https://testnet.nearblocks.io/address/$C
  watch         tail -f $D/pulse.log   |   tail -f $D/keeper.log   |   make status

  Vault is alive and beating. When you are ready:   make kill
MSG
