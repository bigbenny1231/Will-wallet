#!/usr/bin/env bash
# Build, deploy and initialise the dmw contract on testnet.
#
#   scripts/deploy.sh [contract-account.testnet] [owner-account.testnet]
#
# Account defaults to $DMW_CONTRACT from .env. The account's full-access key must
# be in the near-cli legacy keychain (~/.near-credentials/testnet/<account>.json),
# which is where `near account create-account sponsor-by-faucet-service ...
# save-to-legacy-keychain` puts it. If the account does not exist yet and
# CREATE=1 is set, it is created through the testnet faucet first.
#
# Expect: build (~2 min first time), a deploy tx link, an init tx link, and the
# output of `get_config`. Re-running on an initialised account redeploys the code
# and skips `new` (state is kept).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

ACCOUNT="${1:-${DMW_CONTRACT:-}}"
OWNER="${2:-$ACCOUNT}"
NET=testnet
RPC="${NEAR_RPC:-https://rpc.testnet.near.org}"
[ -n "$ACCOUNT" ] || { echo "usage: $0 <contract-account.testnet> [owner]"; exit 1; }

rpc() { curl -s "$RPC" -H 'content-type: application/json' -d "$1"; }
account_exists() {
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" | grep -q '"amount"'
}

if ! account_exists "$ACCOUNT"; then
  if [ "${CREATE:-0}" = 1 ]; then
    echo "==> creating $ACCOUNT via faucet"
    near account create-account sponsor-by-faucet-service "$ACCOUNT" \
      autogenerate-new-keypair save-to-legacy-keychain network-config $NET create
    sleep 3
  else
    echo "account $ACCOUNT does not exist (set CREATE=1 to create it via the faucet)"; exit 1
  fi
fi

echo "==> building"
./contracts/dmw/build.sh
WASM=contracts/dmw/target/near/dmw.wasm
[ -f "$WASM" ] || WASM=contracts/dmw/target/wasm32-unknown-unknown/release/dmw.wasm
ls -la "$WASM"

if ! command -v near >/dev/null 2>&1; then
  # No near-cli-rs: use the node helper (key from keys/<acct>.json or the legacy keychain).
  if node scripts/near-admin.mjs view "$ACCOUNT" get_config '{}' >/dev/null 2>&1; then
    echo "==> redeploying code to $ACCOUNT via near-admin.mjs (keeping state)"
    node scripts/near-admin.mjs deploy "$ACCOUNT" "$WASM"
  else
    echo "==> deploying + new({owner_id: $OWNER}) via near-admin.mjs"
    node scripts/near-admin.mjs deploy "$ACCOUNT" "$WASM" "{\"owner_id\":\"$OWNER\"}"
  fi
  node scripts/near-admin.mjs view "$ACCOUNT" get_config '{}'
  echo "Explorer: https://testnet.nearblocks.io/address/$ACCOUNT"
  exit 0
fi

# Is the contract already initialised? (get_config only works after `new`)
initialised=0
if near contract call-function as-read-only "$ACCOUNT" get_config json-args '{}' \
     network-config $NET now >/dev/null 2>&1; then
  initialised=1
fi

if [ $initialised = 1 ]; then
  echo "==> redeploying code to $ACCOUNT (already initialised, keeping state)"
  near contract deploy "$ACCOUNT" use-file "$WASM" without-init-call \
    network-config $NET sign-with-legacy-keychain send
else
  echo "==> deploying to $ACCOUNT and calling new({owner_id: $OWNER})"
  near contract deploy "$ACCOUNT" use-file "$WASM" \
    with-init-call new json-args "{\"owner_id\":\"$OWNER\"}" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
    network-config $NET sign-with-legacy-keychain send
fi

echo "==> get_config"
near contract call-function as-read-only "$ACCOUNT" get_config json-args '{}' network-config $NET now
echo "Explorer: https://testnet.nearblocks.io/address/$ACCOUNT"
