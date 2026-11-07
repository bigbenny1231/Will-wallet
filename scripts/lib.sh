# Shared helpers for scripts/*.sh (sourced, not run). Expects the cwd to be the repo root.

say() { printf '\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

load_env() { if [ -f .env ]; then set -a; . ./.env; set +a; fi; }

# set_env KEY VALUE: replace KEY=... in .env, or append it. Creates .env (mode 600) if missing.
set_env() {
  [ -f .env ] || { umask 077; : > .env; }
  if grep -q "^$1=" .env; then
    local tmp; tmp=$(mktemp)
    awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' .env > "$tmp" && cat "$tmp" > .env && rm -f "$tmp"
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
  export "$1=$2"
}

# npm ci in a package dir if its node_modules is missing or older than package-lock.json.
ensure_deps() {
  local d=$1
  if [ ! -f "$d/node_modules/.package-lock.json" ] || [ "$d/package-lock.json" -nt "$d/node_modules/.package-lock.json" ]; then
    say "installing $d dependencies (npm ci)"
    (cd "$d" && npm ci --no-audit --no-fund --loglevel=error) || die "npm ci failed in $d"
  fi
}

rand_hex() { openssl rand -hex "$1"; }

# private key of an account created by near-admin.mjs (keys/<acct>.json)
key_of() { node -e "console.log(JSON.parse(require('fs').readFileSync('keys/$1.json','utf8')).private_key)"; }

account_exists() {
  curl -s "${NEAR_RPC:-https://rpc.testnet.near.org}" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" | grep -q '"amount"'
}

# Make sure .env has a funded keeper account (KEEPER_ACCOUNT_ID / KEEPER_PRIVATE_KEY); create one via the faucet if not.
ensure_keeper() {
  if [ -n "${KEEPER_ACCOUNT_ID:-}" ] && [ -n "${KEEPER_PRIVATE_KEY:-}" ]; then return 0; fi
  local k="dmw-keeper-$(rand_hex 3).testnet"
  say "keeper account $k (testnet faucet)"
  node scripts/near-admin.mjs create "$k" || die "faucet could not create $k"
  set_env KEEPER_ACCOUNT_ID "$k"
  set_env KEEPER_PRIVATE_KEY "$(key_of "$k")"
  KEEPER_CREATED=1
}

# set_keeper on the contract (only the contract owner may call it; here owner = contract account).
register_keeper() {
  local c=$1
  [ -f "keys/$c.json" ] || { echo "  (no keys/$c.json: ask the contract owner to call set_keeper {\"account_id\":\"$KEEPER_ACCOUNT_ID\"})"; return 0; }
  node scripts/near-admin.mjs call "$c" "$c" set_keeper "{\"account_id\":\"$KEEPER_ACCOUNT_ID\"}" 30 | grep -E '^tx ' || true
}
