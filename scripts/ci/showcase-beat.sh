#!/usr/bin/env bash
# CI only (keeper.yml): keep the site's showcase vault Alive. Its owner is the long-lived account derived from
# KEEPER_SEED (role "showcase", scripts/showcase.sh). Every Live vault of that owner on $DMW_CONTRACT whose last
# heartbeat is older than 20 hours gets one owner heartbeat (1 yoctoNEAR). Prints one line per vault.
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/lib.sh
ADMIN="node scripts/near-admin.mjs"
[ "${#KEEPER_SEED}" -ge 32 ] || { echo "showcase heartbeat: KEEPER_SEED is not set; skipped"; exit 0; }
O=$($ADMIN derive-account showcase)
node -e 'const k=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).private_key;console.log("::add-mask::"+k);console.log("::add-mask::"+k.replace(/^ed25519:/,""))' "keys/$O.json"
account_exists "$O" || { echo "showcase heartbeat: $O does not exist yet"; exit 0; }
DUE=$($ADMIN view "$DMW_CONTRACT" get_vaults_for_owner "{\"account_id\":\"$O\"}" | node -e '
  const vs = JSON.parse(require("fs").readFileSync(0, "utf8")) || []; const now = Date.now();
  for (const v of vs) if (v.state === "Alive" || v.state === "Warning") if (now - Number(v.last_beat_ms) > 20 * 3600e3) console.log(v.token_id);')
[ -n "$DUE" ] || { echo "showcase heartbeat: nothing due for $O"; exit 0; }
for t in $DUE; do
  echo "showcase heartbeat: vault $t (owner $O)"
  $ADMIN call "$O" "$DMW_CONTRACT" heartbeat "{\"token_id\":\"$t\"}" 30 1y | grep -E '^tx |rror' || true
done
