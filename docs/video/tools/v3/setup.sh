#!/usr/bin/env bash
# v3 demo vault: make demo, then +1.5 NEAR, a phone pulse key, Base+Monad+Solana payouts, a guardian (10 min max pause)
set -euo pipefail
cd /home/claude/deadmans-wallet
TERM=dumb NO_COLOR=1 make demo 2>&1 | tee /tmp/v3/demo.out
T=$(cat .demo/vault_id); C=dmw-x8cx.testnet; S=$(cat .demo/suffix)
O=$(grep -o 'created dmw-demo-owner-[0-9a-f]*\.testnet' /tmp/v3/demo.out | awk '{print $2}')
TX="node contracts/tools/tx.mjs"
echo "== setup v3: vault $T owner $O" | tee /tmp/v3/setup.out
$TX call $O $C deposit "{\"token_id\":\"$T\"}" 30 1.5 | tee -a /tmp/v3/setup.out
node scripts/near-admin.mjs genkey > /tmp/v3/phone.key.json; chmod 600 /tmp/v3/phone.key.json
PUB=$(node -e 'console.log(require("/tmp/v3/phone.key.json").public_key)')
SEC=$(node -e 'console.log(require("/tmp/v3/phone.key.json").private_key)')
$TX call $O $C add_pulse_key "{\"token_id\":\"$T\",\"public_key\":\"$PUB\"}" 50 | tee -a /tmp/v3/setup.out
DER=$(cd keeper && npx tsx src/cli.ts derive --token $T --json)
j() { echo "$DER" | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).$1.address)"; }
B=$(j base); M=$(j monad); SO=$(j solana)
$TX call $O $C set_foreign_payouts "{\"token_id\":\"$T\",\"payouts\":[{\"chain\":\"base\",\"to\":\"0xcA024adC7cac111339Fe077C739F8085aE705F2F\",\"amount\":\"500000000000000\",\"from_address\":\"$B\"},{\"chain\":\"monad\",\"to\":\"0x360d02320ebff8439fe0d804e68dfc6976230e13\",\"amount\":\"10000000000000000\",\"from_address\":\"$M\"},{\"chain\":\"solana\",\"to\":\"CFdWXa1ean7bBoewSv2SZESrDpWSxeoN1hfLrqaqZQUr\",\"amount\":\"10000000\",\"from_address\":\"$SO\"}]}" 50 | tee -a /tmp/v3/setup.out
echo "  base $B  monad $M  solana $SO" | tee -a /tmp/v3/setup.out
G=dmw-demo-guardian-$S.testnet
$TX call $O $C set_guardian "{\"token_id\":\"$T\",\"guardian_id\":\"$G\",\"max_pause_s\":600}" 50 | tee -a /tmp/v3/setup.out
( umask 077; echo "http://localhost:5173/pulse#c=$C&t=$T&k=$SEC" > /tmp/v3/pairing.url )
echo "== ready: vault $T"
