#!/usr/bin/env bash
#
# Print the authoritative on-chain billing-token (ZKAPI) balances for every
# party in the local demo. This is the ground truth that wallets like MetaMask
# only cache a (sometimes stale) view of.
#
# Run it while the demo stack is up, e.g. in another terminal during:
#     KEEP_UP=1 ./scripts/e2e-demo.sh
#
# Contract addresses are read from the deployment manifest, so this stays
# correct across runs. Overridable via env: RPC_URL, RUN_DIR, PRIVATE_KEY
# (the depositor/deployer key), WITHDRAW_DEST.
#
# Invariant: client + treasury + vault + (distinct) dest == total supply.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${RUN_DIR:-$ROOT_DIR/.demo}"
RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
MANIFEST="$RUN_DIR/deployment.json"
# Depositor = deployer; defaults to the demo's anvil account #0 key.
PRIVATE_KEY="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
WITHDRAW_DEST="${WITHDRAW_DEST:-0x1111111111111111111111111111111111111111}"

command -v cast >/dev/null || { echo "ERROR: 'cast' (foundry) not on PATH." >&2; exit 1; }
command -v jq   >/dev/null || { echo "ERROR: 'jq' not on PATH." >&2; exit 1; }
[ -f "$MANIFEST" ] || {
  echo "ERROR: no deployment manifest at $MANIFEST." >&2
  echo "       Start the stack first, e.g. KEEP_UP=1 ./scripts/e2e-demo.sh" >&2
  exit 1
}
cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 || {
  echo "ERROR: no chain reachable at $RPC_URL — is the demo's anvil running?" >&2
  exit 1
}

TOKEN="$(jq -r '.billingToken' "$MANIFEST")"
VAULT="$(jq -r '.vault' "$MANIFEST")"
TREASURY="$(jq -r '.treasury // empty' "$MANIFEST")"
CLIENT="$(cast wallet address --private-key "$PRIVATE_KEY")"
DECIMALS="$(cast call "$TOKEN" 'decimals()(uint8)' --rpc-url "$RPC_URL" | awk '{print $1}')"
SYMBOL="$(cast call "$TOKEN" 'symbol()(string)' --rpc-url "$RPC_URL" 2>/dev/null | tr -d '"')"

# raw <addr> -> integer base-unit balance
raw() { cast call "$TOKEN" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC_URL" | awk '{print $1}'; }
# row <label> <addr>: print a formatted balance line
row() {
  local label="$1" addr="$2"
  [ -n "$addr" ] || return 0
  awk -v d="$DECIMALS" -v s="${SYMBOL:-token}" -v l="$label" -v a="$addr" \
    '{printf "  %-18s %s : %12s base = %.*f %s\n", l, a, $1, d, $1/(10^d), s}' <<<"$(raw "$addr")"
}

echo "chain $RPC_URL"
echo "token $TOKEN ($SYMBOL, $DECIMALS decimals)"
echo
row "client/depositor" "$CLIENT"
row "operator treasury" "$TREASURY"
row "vault (escrow)" "$VAULT"
# Only show the withdrawal destination if it differs from the depositor (in the
# funding-UI flow you withdraw back to yourself, so they're the same account).
[ "${WITHDRAW_DEST,,}" != "${CLIENT,,}" ] && row "withdraw dest" "$WITHDRAW_DEST"
echo
awk -v d="$DECIMALS" -v s="${SYMBOL:-token}" \
  '{printf "  %-18s %s : %12s base = %.*f %s\n", "total supply", "", $1, d, $1/(10^d), s}' \
  <<<"$(cast call "$TOKEN" 'totalSupply()(uint256)' --rpc-url "$RPC_URL" | awk '{print $1}')"
