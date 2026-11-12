#!/usr/bin/env bash
# Agent evidence on a vault of its own: the agent with the requested brain (wallet checks on, then contract only) and
# the on-chain attack suite, all signed with a real agent key against the live contract. Writes evidence/agent/.
#
#   scripts/ci/agent-evidence.sh <contract> <out dir>     env: ANTHROPIC_API_KEY (optional; without it the
#                                                         transcripts say the scripted brain ran, not a model)
# The vault is separate from the demo vault so the recording's allowed and denied payments keep their daily cap.
# Its owner is paid for by the demo funder through the testnet registrar (no faucet call): run after `make demo`.
set -euo pipefail
cd "$(dirname "$0")/../.."
C="$1"; OUT="$2"
ADMIN="node scripts/near-admin.mjs"; TX="node contracts/tools/tx.mjs"
D=.demo; S=$(cat $D/suffix)
FUNDER=dmw-demo-funder-$S.testnet; API=dmw-demo-api-$S.testnet; HEIR1=dmw-demo-sarah-$S.testnet
[ -f keys/$FUNDER.json ] || { echo "no demo funder key (run make demo first)"; exit 2; }
OWNER=dmw-evid-owner-$(openssl rand -hex 3).testnet
$ADMIN fund $FUNDER $OWNER 3.2 || $ADMIN create $OWNER
[ -n "${GITHUB_ACTIONS:-}" ] && ./scripts/ci/mask.sh
for _ in $(seq 15); do $ADMIN keys $OWNER >/dev/null 2>&1 && break; sleep 2; done

# a day between beats, so the vault stays Alive for the whole run; same agent policy as the demo vault
R=$($TX call $OWNER $C create_vault "{\"heartbeat_interval_s\":86400,\"grace_missed\":1,\"heirs\":[{\"account_id\":\"$HEIR1\",\"bps\":10000}],\"policy\":{\"per_tx_max\":\"500000000000000000000000\",\"daily_max\":\"1000000000000000000000000\",\"allowlist\":[\"$API\"]}}" 100 2.6)
echo "$R" | grep -E '^tx |result'
T=$(echo "$R" | sed -n 's/.*result: "\([0-9]*\)".*/\1/p' | tail -1)
[ -n "$T" ] || { echo "$R"; echo "create_vault did not return a token id"; exit 2; }
( umask 077; $ADMIN genkey > $D/evidence-agent.key.json )
KEY=$(node -e 'process.stdout.write(require(process.argv[1]).private_key)' "$PWD/$D/evidence-agent.key.json")
PUB=$(node -e 'process.stdout.write(require(process.argv[1]).public_key)' "$PWD/$D/evidence-agent.key.json")
[ -n "${GITHUB_ACTIONS:-}" ] && { echo "::add-mask::$KEY"; echo "::add-mask::${KEY#ed25519:}"; }
$TX call $OWNER $C add_agent_key "{\"token_id\":\"$T\",\"public_key\":\"$PUB\"}" 50 1y | grep -E '^tx |result'
sleep 3

BRAIN=anthropic; [ -n "${ANTHROPIC_API_KEY:-}" ] || echo "::warning::ANTHROPIC_API_KEY is not set: the agent transcripts will show the scripted brain, not a model"
mkdir -p "$OUT"
set +e
(cd agent && DMW_CONTRACT="$C" DMW_AGENT_KEY="$KEY" npx tsx src/cli.ts evidence --token "$T" --brain $BRAIN --out "$OUT")
RC=$?
set -e
echo "evidence vault $T owner $OWNER exit $RC"
exit $RC
