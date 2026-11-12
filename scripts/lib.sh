# Shared helpers for scripts/*.sh (sourced, not run). Expects the cwd to be the repo root.

if [ -t 1 ]; then B=$'\033[1m' R=$'\033[31m' N=$'\033[0m'; else B='' R='' N=''; fi
say() { printf '%s== %s%s\n' "$B" "$*" "$N"; }
die() { printf '%serror: %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

load_env() { if [ -f .env ]; then chmod 600 .env 2>/dev/null || true; set -a; . ./.env; set +a; fi; }

# set_env KEY VALUE: replace KEY=... in .env, or append it. Creates .env (mode 600) if missing.
set_env() {
  [ -f .env ] || { umask 077; : > .env; }
  if grep -q "^$1=" .env; then
    local tmp; tmp=$(mktemp)
    awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' .env > "$tmp" && cat "$tmp" > .env && rm -f "$tmp"
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
  chmod 600 .env   # holds KEEPER_PRIVATE_KEY; also tightens a .env made by hand (AUDIT_FINAL_OFFCHAIN F-01)
  export "$1=$2"
}

# npm ci in a package dir if its node_modules is missing or older than package-lock.json.
ensure_deps() {
  local d=$1
  if [ ! -f "$d/node_modules/.package-lock.json" ] || [ "$d/package-lock.json" -nt "$d/node_modules/.package-lock.json" ]; then
    say "installing $d dependencies (npm ci)"
    # load_env exports all of .env to child processes; package install scripts must not inherit the keys.
    (cd "$d" && env -u KEEPER_PRIVATE_KEY -u DMW_CONTRACT_KEY -u DMW_AGENT_KEY -u DMW_PULSE_KEY npm ci --no-audit --no-fund --loglevel=error) || die "npm ci failed in $d"
  fi
}

rand_hex() { openssl rand -hex "$1"; }

# private key of an account created by near-admin.mjs (keys/<acct>.json)
# (the path goes in as argv, never spliced into the JS source)
key_of() { node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).private_key)" "keys/$1.json"; }

account_exists() {
  curl -s "${NEAR_RPC:-https://rpc.testnet.fastnear.com}" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" | grep -q '"amount"'
}

# Make sure .env has a funded keeper account (KEEPER_ACCOUNT_ID / KEEPER_PRIVATE_KEY); create one via the faucet if not.
ensure_keeper() {
  # v3: with KEEPER_SEED set (the repository secret in CI), the keeper is the long-lived account derived from it
  # (scripts/near-admin.mjs derive-keeper). It is created through the faucet the first time and topped up after.
  if [ -n "${KEEPER_SEED:-}" ]; then
    local k
    k=$(node scripts/near-admin.mjs derive-keeper) || die "could not derive the keeper from KEEPER_SEED"
    if ! account_exists "$k"; then
      say "keeper account $k (derived from KEEPER_SEED; first use, testnet faucet)"
      node scripts/near-admin.mjs create "$k" || die "faucet could not create $k"
      for _ in $(seq 15); do account_exists "$k" && break; sleep 2; done
    else
      say "keeper account $k (derived from KEEPER_SEED)"
    fi
    # The account must hold the derived key: anything else means the name is not ours.
    local pub
    pub=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).public_key)" "keys/$k.json")
    node scripts/near-admin.mjs keys "$k" | grep -qF "\"$pub\"" || die "$k does not hold the key derived from KEEPER_SEED"
    set_env KEEPER_ACCOUNT_ID "$k"
    set_env KEEPER_PRIVATE_KEY "$(key_of "$k")"
    keeper_topup "$k"
    return 0
  fi
  [ "${REQUIRE_KEEPER_SEED:-0}" = 1 ] && die "KEEPER_SEED is not set: the live deploy needs the long-lived keeper (repository secret KEEPER_SEED)"
  if [ -n "${KEEPER_ACCOUNT_ID:-}" ] && [ -n "${KEEPER_PRIVATE_KEY:-}" ]; then return 0; fi
  local k="dmw-keeper-$(rand_hex 3).testnet"
  say "keeper account $k (testnet faucet)"
  node scripts/near-admin.mjs create "$k" || die "faucet could not create $k"
  set_env KEEPER_ACCOUNT_ID "$k"
  set_env KEEPER_PRIVATE_KEY "$(key_of "$k")"
  KEEPER_CREATED=1
}

# Keep the long-lived keeper able to pay gas: below KEEPER_MIN_NEAR (default 4) it gets a fresh faucet account's whole
# balance (`sweep` deletes that account into the keeper). Best effort: a faucet refusal is reported, not fatal.
keeper_topup() {
  local k=$1 bal t
  bal=$(node scripts/near-admin.mjs balance "$k" 2>/dev/null || echo 0)
  echo "  keeper balance: $bal NEAR"
  awk -v b="$bal" -v m="${KEEPER_MIN_NEAR:-4}" 'BEGIN{exit !(b+0 < m+0)}' || return 0
  t="dmw-topup-$(rand_hex 4).testnet"
  if node scripts/near-admin.mjs create "$t" >/dev/null 2>&1; then
    for _ in $(seq 15); do account_exists "$t" && break; sleep 2; done
    node scripts/near-admin.mjs sweep "$t" "$k" | grep -E '^tx ' || true
    echo "  keeper topped up: $(node scripts/near-admin.mjs balance "$k" 2>/dev/null || echo ?) NEAR"
  else
    echo "  keeper top-up skipped: the faucet refused a new account (it allows about 10 per IP per 12 h)"
  fi
}

# Make KEEPER_ACCOUNT_ID the contract keeper. Contract v2 takes the keeper in `new` (deploy.sh passes it), so this is
# only needed when the keeper changes later. Who may call set_keeper (v2, finding C): the contract owner when that is a
# separate account, or the current keeper (a hand-over). An owner that is the contract account itself cannot: that is
# the locked design, where only the keeper can pass the role on.
register_keeper() {
  local c=$1 cur owner yocto
  cur=$(node scripts/near-admin.mjs view "$c" get_config '{}' 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.keeper||"")+" "+(j.owner_id||j.owner||"")+" "+("step3_open_after_ms" in j?"1y":""))}catch{console.log("  ")}})')
  # v2 (second review): set_keeper takes exactly 1 yoctoNEAR, so a keeper function-call key cannot hand the role over.
  # A v1 contract (no step3_open_after_ms in get_config) rejects any deposit, so it gets none.
  yocto=${cur##* }; cur=${cur% *}
  owner=${cur#* }; cur=${cur%% *}
  if [ "$cur" = "$KEEPER_ACCOUNT_ID" ]; then echo "  keeper is already $KEEPER_ACCOUNT_ID"; return 0; fi
  if [ -n "$owner" ] && [ "$owner" != "$c" ] && [ -f "keys/$owner.json" ]; then
    node scripts/near-admin.mjs call "$owner" "$c" set_keeper "{\"account_id\":\"$KEEPER_ACCOUNT_ID\"}" 30 $yocto | grep -E '^tx ' || true
  elif [ -n "$cur" ] && [ -f "keys/$cur.json" ]; then
    # hand-over by the current keeper
    node scripts/near-admin.mjs call "$cur" "$c" set_keeper "{\"account_id\":\"$KEEPER_ACCOUNT_ID\"}" 30 $yocto | grep -E '^tx ' || true
  else
    echo "  (cannot set the keeper from here: the current keeper ${cur:-<none>} or a separate contract owner must call set_keeper {\"account_id\":\"$KEEPER_ACCOUNT_ID\"})"
  fi
}
