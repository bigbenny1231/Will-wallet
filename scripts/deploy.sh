#!/usr/bin/env bash
# Build, deploy and initialise the dmw contract on testnet. Needs no near-cli and no prior state.
#
#   make deploy                     (or ./scripts/deploy.sh)
#   ./scripts/deploy.sh <acct.testnet> [owner.testnet]
#   NEW=1 make deploy               ignore DMW_CONTRACT in .env and deploy to a fresh account
#
# Target account: the argument, else DMW_CONTRACT from .env, else a new dmw-<rand>.testnet.
# Accounts that do not exist yet are created through the testnet faucet (scripts/near-admin.mjs;
# the key is saved to keys/<acct>.json, which is gitignored). A keeper account dmw-keeper-<rand>.testnet
# is created too if .env has none, and registered on the contract with set_keeper.
#
# Writes .env: NEAR_NETWORK, DMW_CONTRACT, DMW_CONTRACT_KEY, DMW_CONTRACT_KEYFILE, KEEPER_ACCOUNT_ID,
# KEEPER_PRIVATE_KEY, BASE_RPC, SOLANA_RPC.
#
# Expect (~1-2 min with a warm cargo cache): build, faucet lines, a deploy tx link, an init tx link,
# get_config, and finally "deployed dmw-xxxxxx.testnet". Re-running on an initialised account redeploys
# the code and keeps the state.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh
load_env
ensure_deps keeper          # near-admin.mjs uses keeper/node_modules/near-api-js

if [ "${NEW:-0}" = 1 ]; then unset DMW_CONTRACT DMW_CONTRACT_KEY DMW_CONTRACT_KEYFILE; fi
ACCOUNT="${1:-${DMW_CONTRACT:-}}"
[ -n "$ACCOUNT" ] || ACCOUNT="dmw-$(rand_hex 3).testnet"
OWNER="${2:-$ACCOUNT}"
ADMIN="node scripts/near-admin.mjs"

if account_exists "$ACCOUNT"; then
  echo "account $ACCOUNT exists"
else
  say "creating $ACCOUNT (testnet faucet)"
  $ADMIN create "$ACCOUNT" || die "faucet could not create $ACCOUNT"
  sleep 2
fi
if [ ! -f "keys/$ACCOUNT.json" ] && [ ! -f "$HOME/.near-credentials/testnet/$ACCOUNT.json" ]; then
  die "no full-access key for $ACCOUNT in keys/ or ~/.near-credentials/testnet/"
fi

say "building"
./contracts/dmw/build.sh
WASM=contracts/dmw/target/near/dmw.wasm
[ -f "$WASM" ] || WASM=contracts/dmw/target/wasm32-unknown-unknown/release/dmw.wasm

if $ADMIN view "$ACCOUNT" get_config '{}' >/dev/null 2>&1; then
  say "redeploying code to $ACCOUNT (already initialised, state is kept)"
  $ADMIN deploy "$ACCOUNT" "$WASM"
else
  say "deploying to $ACCOUNT and calling new({owner_id: $OWNER})"
  $ADMIN deploy "$ACCOUNT" "$WASM" "{\"owner_id\":\"$OWNER\"}"
fi

set_env NEAR_NETWORK testnet
set_env DMW_CONTRACT "$ACCOUNT"
if [ -f "keys/$ACCOUNT.json" ]; then
  set_env DMW_CONTRACT_KEYFILE "keys/$ACCOUNT.json"
  set_env DMW_CONTRACT_KEY "$(key_of "$ACCOUNT")"
fi
set_env BASE_RPC "${BASE_RPC:-https://sepolia.base.org}"
set_env SOLANA_RPC "${SOLANA_RPC:-https://api.devnet.solana.com}"

ensure_keeper
say "set_keeper $KEEPER_ACCOUNT_ID"
register_keeper "$ACCOUNT"

say "get_config"
$ADMIN view "$ACCOUNT" get_config '{}'
echo
echo "deployed $ACCOUNT   https://testnet.nearblocks.io/address/$ACCOUNT"
echo "written to .env: DMW_CONTRACT=$ACCOUNT, KEEPER_ACCOUNT_ID=$KEEPER_ACCOUNT_ID (keys in keys/, gitignored)"
echo "next: make demo"
