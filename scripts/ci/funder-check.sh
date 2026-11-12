#!/usr/bin/env bash
# Before a demo run: the funder wallet derived from KEEPER_SEED must hold enough to pay the demo vault's Base, Monad
# and Solana payouts (amount + gas each, with headroom). Solana devnet is topped up by airdrop when low (best effort;
# the devnet faucet is rate-limited). Prints addresses and balances only; the keys are never printed.
#   scripts/ci/funder-check.sh            env: KEEPER_SEED; optional MIN_ETH (0.002) MIN_MON (0.05) MIN_SOL (0.03)
set -euo pipefail
cd "$(dirname "$0")/../../keeper"
MIN_ETH=${MIN_ETH:-0.002} MIN_MON=${MIN_MON:-0.05} MIN_SOL=${MIN_SOL:-0.03}
SOLANA_RPC=${SOLANA_RPC:-https://api.devnet.solana.com}
report() { npx tsx src/cli.ts funder --json 2>/dev/null; }
J=$(report)
field() { echo "$J" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); const b=j.balances[process.argv[1]]; console.log(process.argv[2]==="addr"?b.address:(b.balance||"0"))' "$1" "$2"; }
SOL_ADDR=$(field solana addr); SOL_BAL=$(field solana bal)
# lamports below MIN_SOL: ask the devnet faucet for 1 SOL, then wait for it to land
if [ "$(node -e 'console.log(BigInt(process.argv[1]) < BigInt(Math.round(+process.argv[2]*1e9)))' "$SOL_BAL" "$MIN_SOL")" = true ]; then
  echo "Solana funder below $MIN_SOL SOL: requesting a devnet airdrop"
  curl -sS "$SOLANA_RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"requestAirdrop\",\"params\":[\"$SOL_ADDR\",1000000000]}" | head -c 300; echo
  for _ in $(seq 20); do sleep 3; J=$(report); [ "$(field solana bal)" != "$SOL_BAL" ] && break; done
fi
echo "$J" | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const min = { base: [+process.argv[1], 1e18, "ETH"], monad: [+process.argv[2], 1e18, "MON"], solana: [+process.argv[3], 1e9, "SOL"] };
  let short = 0;
  for (const [c, [m, unit, sym]] of Object.entries(min)) {
    const b = j.balances[c]; const have = Number(BigInt(b.balance || "0")) / unit;
    const ok = have >= m; if (!ok) short++;
    console.log(`${ok ? "ok   " : "SHORT"} ${c.padEnd(6)} ${b.address}  holds ${have} ${sym}, needs ${m} ${sym}  ${b.explorer}${b.error ? "  (read failed: " + b.error + ")" : ""}`);
  }
  if (short) { console.log(`::error::the funder wallet is short on ${short} chain(s); fund the addresses above, then run again`); process.exit(1); }
' "$MIN_ETH" "$MIN_MON" "$MIN_SOL"
