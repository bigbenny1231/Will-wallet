#!/usr/bin/env bash
# Build, deploy and initialise the dmw contract on testnet. Needs no near-cli and no prior state.
#
#   make deploy                     (or ./scripts/deploy.sh)
#   ./scripts/deploy.sh <acct.testnet> [owner.testnet]
#   NEW=1 make deploy               ignore DMW_CONTRACT in .env and deploy to a fresh account
#   DMW_WASM=contracts/release/dmw.wasm make deploy   deploy a prebuilt wasm instead of building
#
# Target account: the argument, else DMW_CONTRACT from .env, else a new dmw-<rand>.testnet.
# Accounts that do not exist yet are created through the testnet faucet (scripts/near-admin.mjs;
# the key is saved to keys/<acct>.json, which is gitignored). A keeper account dmw-keeper-<rand>.testnet
# is created too if .env has none and passed to `new` as keeper_id (contract v2). DMW_MPC_SIGNER overrides the
# Chain Signatures contract (default v1.signer-prod.testnet).
#
# Contract v2 deploys and initialises in ONE transaction (DeployContract + new; `new` is #[private], finding G).
#
# Writes .env: NEAR_NETWORK, DMW_CONTRACT, DMW_CONTRACT_KEYFILE (a path, not the key), KEEPER_ACCOUNT_ID,
# KEEPER_PRIVATE_KEY, BASE_RPC, SOLANA_RPC.
#
# Expect (~1-2 min with a warm cargo cache): build, faucet lines, a deploy tx link, an init tx link,
# get_config, and finally "deployed dmw-xxxxxx.testnet". Re-running on an account initialised by contract v2
# redeploys the code and keeps the state. A v1 account (its get_config has no mpc_signer) is refused: v2 changed the
# storage layout, so v2 code must go to a fresh account (NEW=1).
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
  # give the RPC node a moment to see the new account (up to 30 s)
  for _ in $(seq 15); do account_exists "$ACCOUNT" && break; sleep 2; done
fi
if [ ! -f "keys/$ACCOUNT.json" ] && [ ! -f "$HOME/.near-credentials/testnet/$ACCOUNT.json" ]; then
  die "no full-access key for $ACCOUNT in keys/ or ~/.near-credentials/testnet/"
fi

if [ -n "${DMW_WASM:-}" ]; then
  # A prebuilt wasm, e.g. DMW_WASM=contracts/release/dmw.wasm (the reviewed release build, docs/history/FINAL_REVIEW.md)
  [ -f "$DMW_WASM" ] || die "DMW_WASM=$DMW_WASM does not exist"
  WASM=$DMW_WASM
  say "using prebuilt $WASM"
else
  say "building"
  # cargo and its build scripts do not need the keys that load_env exported from .env
  env -u KEEPER_PRIVATE_KEY -u DMW_CONTRACT_KEY -u DMW_AGENT_KEY -u DMW_PULSE_KEY ./contracts/dmw/build.sh
  WASM=contracts/dmw/target/near/dmw.wasm
  [ -f "$WASM" ] || WASM=contracts/dmw/target/wasm32-unknown-unknown/release/dmw.wasm
fi

ensure_keeper
if CFG=$($ADMIN view "$ACCOUNT" get_config '{}' 2>/dev/null); then
  echo "$CFG" | grep -q '"mpc_signer"' || die "$ACCOUNT runs a v1 contract; v2 changed the storage layout. Deploy to a fresh account: NEW=1 make deploy"
  say "redeploying code to $ACCOUNT (already initialised, state is kept)"
  $ADMIN deploy "$ACCOUNT" "$WASM"
  say "keeper"
  register_keeper "$ACCOUNT"
else
  # v3: with KEEPER_SEED set, the keeper admin is the long-lived account derived from it (role "admin"). Its only
  # power is a 48 h timelocked proposal to replace the keeper or the MPC signer (testnet.yml task=admin).
  ADMIN_ID=""
  if [ -n "${KEEPER_SEED:-}" ]; then
    ADMIN_ID=$($ADMIN derive-account admin) || die "could not derive the keeper admin"
    account_exists "$ADMIN_ID" || { $ADMIN create "$ADMIN_ID" || die "faucet could not create $ADMIN_ID"; }
    say "keeper admin $ADMIN_ID (derived from KEEPER_SEED)"
  fi
  INIT="{\"owner_id\":\"$OWNER\",\"keeper_id\":\"$KEEPER_ACCOUNT_ID\"${ADMIN_ID:+,\"keeper_admin\":\"$ADMIN_ID\"}${DMW_MPC_SIGNER:+,\"mpc_signer\":\"$DMW_MPC_SIGNER\"}}"
  say "deploying to $ACCOUNT and calling new($INIT) in the same transaction"
  $ADMIN deploy "$ACCOUNT" "$WASM" "$INIT"
fi

set_env NEAR_NETWORK testnet
set_env DMW_CONTRACT "$ACCOUNT"
if [ -f "keys/$ACCOUNT.json" ]; then
  # Only the path: the contract account's full-access key stays in keys/ (0600) and is not copied into .env,
  # where every script that sources .env would export it to its child processes. Nothing reads it from there.
  set_env DMW_CONTRACT_KEYFILE "keys/$ACCOUNT.json"
fi
set_env BASE_RPC "${BASE_RPC:-https://sepolia.base.org}"
set_env SOLANA_RPC "${SOLANA_RPC:-https://api.devnet.solana.com}"

say "get_config"
$ADMIN view "$ACCOUNT" get_config '{}'
echo
echo "deployed $ACCOUNT   https://testnet.nearblocks.io/address/$ACCOUNT"
echo "written to .env: DMW_CONTRACT=$ACCOUNT, KEEPER_ACCOUNT_ID=$KEEPER_ACCOUNT_ID (keys in keys/, gitignored)"
echo "next: make demo"
