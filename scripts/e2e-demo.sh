#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${RUN_DIR:-$ROOT_DIR/.demo}"
STATE_DIR="${STATE_DIR:-$RUN_DIR/state}"
LOG_DIR="$RUN_DIR/logs"
DEPLOYMENT_JSON="$RUN_DIR/deployment.json"

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
CHAIN_ID="${CHAIN_ID:-31337}"
PRIVATE_KEY="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
DEPOSIT_AMOUNT="${DEPOSIT_AMOUNT:-1000}"
MODEL_ID="${MODEL_ID:-zkapi-echo}"
XMSS_HEIGHT="${XMSS_HEIGHT:-4}"
REQUEST_CHARGE_CAP="${REQUEST_CHARGE_CAP:-100}"
POLICY_CHARGE_CAP="${POLICY_CHARGE_CAP:-1000}"
ANVIL_HOST="${ANVIL_HOST:-127.0.0.1}"
ANVIL_PORT="${ANVIL_PORT:-8545}"
INDEXER_ADDR="${INDEXER_ADDR:-127.0.0.1:43001}"
SERVER_ADDR="${SERVER_ADDR:-127.0.0.1:43000}"
AUTH_ADDR="${AUTH_ADDR:-127.0.0.1:43134}"

INDEXER_URL="http://${INDEXER_ADDR}"
SERVER_URL="http://${SERVER_ADDR}"
AUTH_URL="http://${AUTH_ADDR}"

ANVIL_PID=""
INDEXER_PID=""
SERVER_PID=""
AUTH_PID=""

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

cleanup() {
  local code=$?
  for pid in "$AUTH_PID" "$SERVER_PID" "$INDEXER_PID" "$ANVIL_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done
  exit "$code"
}

wait_http() {
  local url="$1"
  local label="$2"
  for _ in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "timed out waiting for ${label}: ${url}" >&2
  return 1
}

wait_rpc() {
  local rpc_url="$1"
  local label="$2"
  for _ in $(seq 1 60); do
    if cast block-number --rpc-url "$rpc_url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "timed out waiting for ${label}: ${rpc_url}" >&2
  return 1
}

wait_json_value() {
  local url="$1"
  local jq_filter="$2"
  local expected="$3"
  local label="$4"
  local value
  for _ in $(seq 1 60); do
    if value="$(curl -fsS "$url" 2>/dev/null | jq -r "$jq_filter" 2>/dev/null)" && [[ "$value" == "$expected" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "timed out waiting for ${label}: expected ${expected}" >&2
  return 1
}

wait_json_not_value() {
  local url="$1"
  local jq_filter="$2"
  local unexpected="$3"
  local label="$4"
  local value
  for _ in $(seq 1 60); do
    if value="$(curl -fsS "$url" 2>/dev/null | jq -r "$jq_filter" 2>/dev/null)" && [[ -n "$value" ]] && [[ "$value" != "$unexpected" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "timed out waiting for ${label}: value stayed ${unexpected}" >&2
  return 1
}

wait_status_ok() {
  local url="$1"
  local label="$2"
  wait_json_value "$url" '.status' "ok" "$label"
}

pad_hex_32() {
  local value="${1#0x}"
  printf '0x%064s\n' "$value" | tr ' ' '0'
}

trap cleanup EXIT

require_cmd cargo
require_cmd jq
require_cmd curl
require_cmd anvil
require_cmd forge
require_cmd cast

mkdir -p "$RUN_DIR" "$STATE_DIR" "$LOG_DIR"
rm -rf "$STATE_DIR"
rm -f "$RUN_DIR/indexer.cursor" "$RUN_DIR/zkapi-server.db" "$RUN_DIR/attestation.json" \
  "$RUN_DIR/prepare-deposit.json" "$RUN_DIR/confirm-deposit.json" "$RUN_DIR/core-request.json" \
  "$RUN_DIR/chat-completions.json" "$RUN_DIR/responses.json" "$RUN_DIR/ollama-chat.json" \
  "$RUN_DIR/wallet-status.json" "$RUN_DIR/models.json" "$RUN_DIR/tags.json" \
  "$RUN_DIR/indexer-note-path.json" "$RUN_DIR/server.sample.txt"
mkdir -p "$STATE_DIR" "$LOG_DIR"
rm -f "$DEPLOYMENT_JSON"

echo "Building workspace binaries..."
cargo build --workspace --exclude zkapi-integration-tests >/dev/null

echo "Starting Anvil..."
anvil --host "$ANVIL_HOST" --port "$ANVIL_PORT" >"$LOG_DIR/anvil.log" 2>&1 &
ANVIL_PID=$!
wait_rpc "${RPC_URL}" "anvil rpc"

echo "Deploying demo contracts..."
(
  cd "$ROOT_DIR/protocol/contracts"
  OUTPUT_PATH="$DEPLOYMENT_JSON" \
  PRIVATE_KEY="$PRIVATE_KEY" \
  MINT_AMOUNT="$((DEPOSIT_AMOUNT * 100))" \
  forge script script/Deploy.s.sol:DeployScript \
    --rpc-url "$RPC_URL" \
    --broadcast >"$LOG_DIR/deploy.log" 2>&1
)

VAULT_ADDRESS="$(jq -r '.vault' "$DEPLOYMENT_JSON")"
TOKEN_ADDRESS="$(jq -r '.billingToken' "$DEPLOYMENT_JSON")"
NOTE_TTL="$(jq -r '.noteTtl' "$DEPLOYMENT_JSON")"

if [[ -z "$VAULT_ADDRESS" || "$VAULT_ADDRESS" == "null" ]]; then
  echo "deployment output is missing vault address" >&2
  exit 1
fi

echo "Starting protocol indexer..."
"$ROOT_DIR/target/debug/zkapi" \
  --contract-address "$VAULT_ADDRESS" \
  indexer \
  --listen "$INDEXER_ADDR" \
  --rpc-url "$RPC_URL" \
  --contract-address "$VAULT_ADDRESS" \
  --cursor-path "$RUN_DIR/indexer.cursor" >"$LOG_DIR/indexer.log" 2>&1 &
INDEXER_PID=$!
wait_status_ok "${INDEXER_URL}/health" "indexer"

echo "Starting zkapi-serverd..."
"$ROOT_DIR/target/debug/zkapi" \
  --chain-id "$CHAIN_ID" \
  --contract-address "$VAULT_ADDRESS" \
  --request-charge-cap "$REQUEST_CHARGE_CAP" \
  --policy-charge-cap "$POLICY_CHARGE_CAP" \
  serverd \
  --listen "$SERVER_ADDR" \
  --provider echo \
  --flat-charge 1 \
  --xmss-height "$XMSS_HEIGHT" \
  --db-path "$RUN_DIR/zkapi-server.db" \
  --indexer-url "$INDEXER_URL" \
  --root-poll-interval-ms 250 >"$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
wait_status_ok "${SERVER_URL}/health" "zkapi-serverd"

echo "Publishing attested server roots on-chain..."
attestation_payload="$(curl -fsSL "${SERVER_URL}/v1/attestation")"
printf '%s\n' "$attestation_payload" >"$RUN_DIR/attestation.json"
STATE_SIG_EPOCH="$(jq -r '.state_sig_epoch' <<<"$attestation_payload")"
STATE_SIG_ROOT="$(jq -r '.state_sig_root' <<<"$attestation_payload")"
CLEAR_SIG_ROOT="$(jq -r '.clear_sig_root' <<<"$attestation_payload")"
cast send "$VAULT_ADDRESS" \
  "rotateServerRoots(uint32,uint256,uint256)" \
  "$STATE_SIG_EPOCH" "$STATE_SIG_ROOT" "$CLEAR_SIG_ROOT" \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" >"$LOG_DIR/rotate-roots.log" 2>&1

echo "Starting client daemon..."
"$ROOT_DIR/target/debug/zkapi-clientd" \
  --listen "$AUTH_ADDR" \
  --state-dir "$STATE_DIR" \
  --protocol-server-url "$SERVER_URL" \
  --indexer-url "$INDEXER_URL" \
  --protocol-version 1 \
  --chain-id "$CHAIN_ID" \
  --contract-address "$VAULT_ADDRESS" \
  --request-charge-cap "$REQUEST_CHARGE_CAP" \
  --policy-charge-cap "$POLICY_CHARGE_CAP" \
  --demo-rpc-url "$RPC_URL" \
  --demo-billing-token-address "$TOKEN_ADDRESS" \
  --demo-private-key "$PRIVATE_KEY" \
  --demo-note-ttl-seconds "$NOTE_TTL" \
  --model "$MODEL_ID" >"$LOG_DIR/auth.log" 2>&1 &
AUTH_PID=$!
wait_status_ok "${AUTH_URL}/health" "auth daemon"

echo "Preparing deposit..."
prepare_payload="$(curl -fsSL \
  -X POST "${AUTH_URL}/funding/api/deposit/prepare" \
  -H "content-type: application/json" \
  -d "{\"amount\":${DEPOSIT_AMOUNT}}")"
printf '%s\n' "$prepare_payload" >"$RUN_DIR/prepare-deposit.json"

SECRET="$(jq -r '.secret' <<<"$prepare_payload")"
COMMITMENT="$(jq -r '.commitment' <<<"$prepare_payload")"
COMMITMENT_BYTES32="$(pad_hex_32 "$COMMITMENT")"
NOTE_ID="$(jq -r '.next_note_id' <<<"$prepare_payload")"
ACTIVE_ROOT_BEFORE_DEPOSIT="$(jq -r '.active_root' <<<"$prepare_payload")"
ZERO_PATH="$(jq -r '"[" + (.zero_path | join(",")) + "]"' <<<"$prepare_payload")"

echo "Submitting on-chain deposit..."
cast send "$TOKEN_ADDRESS" \
  "approve(address,uint256)" \
  "$VAULT_ADDRESS" "$DEPOSIT_AMOUNT" \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" >"$LOG_DIR/approve.log" 2>&1

cast send "$VAULT_ADDRESS" \
  "deposit(bytes32,uint128,uint256[32])" \
  "$COMMITMENT_BYTES32" "$DEPOSIT_AMOUNT" "$ZERO_PATH" \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" >"$LOG_DIR/deposit.log" 2>&1

wait_json_value "${INDEXER_URL}/v1/tree/next-note-id" '.next_note_id | tostring' "1" "indexer next note id"
wait_json_not_value "${INDEXER_URL}/v1/tree/root" '.root' "$ACTIVE_ROOT_BEFORE_DEPOSIT" "indexer root update"
curl -fsSL "${INDEXER_URL}/v1/tree/notes/${NOTE_ID}/path" >"$RUN_DIR/indexer-note-path.json"

deposit_block_timestamp="$(cast block latest --field timestamp --rpc-url "$RPC_URL")"
expiry_ts=$((deposit_block_timestamp + NOTE_TTL))

echo "Confirming deposit locally..."
confirm_payload="$(curl -fsSL \
  -X POST "${AUTH_URL}/funding/api/deposit/confirm" \
  -H "content-type: application/json" \
  -d "{\"secret\":\"${SECRET}\",\"note_id\":${NOTE_ID},\"amount\":${DEPOSIT_AMOUNT},\"expiry_ts\":${expiry_ts}}")"
printf '%s\n' "$confirm_payload" >"$RUN_DIR/confirm-deposit.json"

echo "Executing authenticated request..."
core_response="$(curl -fsSL \
  -X POST "${AUTH_URL}/request" \
  -H "content-type: application/json" \
  -d "{\"method\":\"POST\",\"path\":\"/v1/chat/completions\",\"body\":{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"hello from e2e demo\"}]}}")"
printf '%s\n' "$core_response" >"$RUN_DIR/core-request.json"

echo "Running a burst of authenticated requests (multi-request state chain)..."
for i in $(seq 2 7); do
  curl -fsSL \
    -X POST "${AUTH_URL}/request" \
    -H "content-type: application/json" \
    -d "{\"method\":\"POST\",\"path\":\"/v1/chat/completions\",\"body\":{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"request ${i}\"}]}}" \
    >/dev/null
  balance="$(curl -fsSL "${AUTH_URL}/wallet/status" | jq -r '[.. | .current_balance? // empty] | first // "?"')"
  echo "  request ${i}: ok, balance now ${balance}"
done

echo "Exercising compatibility shims..."
curl -fsSL \
  -X POST "${AUTH_URL}/v1/chat/completions" \
  -H "content-type: application/json" \
  -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"hello via chat completions\"}]}" \
  >"$RUN_DIR/chat-completions.json"

curl -fsSL \
  -X POST "${AUTH_URL}/v1/responses" \
  -H "content-type: application/json" \
  -d "{\"model\":\"${MODEL_ID}\",\"input\":\"hello via responses\"}" \
  >"$RUN_DIR/responses.json"

curl -fsSL \
  -X POST "${AUTH_URL}/api/chat" \
  -H "content-type: application/json" \
  -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"hello via ollama\"}]}" \
  >"$RUN_DIR/ollama-chat.json"

curl -fsSL "${AUTH_URL}/wallet/status" >"$RUN_DIR/wallet-status.json"
curl -fsSL "${AUTH_URL}/v1/models" >"$RUN_DIR/models.json"
curl -fsSL "${AUTH_URL}/api/tags" >"$RUN_DIR/tags.json"

# ---- Withdrawal proofs (both paths) -----------------------------------------
WITHDRAW_DEST="0x1111111111111111111111111111111111111111"

echo "Building mutual-close withdrawal proof (asks serverd for a clearance signature)..."
mutual_plan="$(curl -fsSL \
  -X POST "${AUTH_URL}/wallet/withdraw" \
  -H "content-type: application/json" \
  -d "{\"mode\":\"mutual\",\"destination\":\"${WITHDRAW_DEST}\"}")"
printf '%s\n' "$mutual_plan" >"$RUN_DIR/withdraw-mutual.json"
echo "  mutual-close proof ready (has_clearance=$(jq -r '.public_inputs.has_clearance' <<<"$mutual_plan"))"

echo "Building escape-hatch withdrawal proof (unilateral, no server clearance)..."
escape_plan="$(curl -fsSL \
  -X POST "${AUTH_URL}/wallet/withdraw" \
  -H "content-type: application/json" \
  -d "{\"mode\":\"escape\",\"destination\":\"${WITHDRAW_DEST}\"}")"
printf '%s\n' "$escape_plan" >"$RUN_DIR/withdraw-escape.json"
echo "  escape-hatch proof ready (has_clearance=$(jq -r '.public_inputs.has_clearance' <<<"$escape_plan"))"

echo
echo "Both withdrawal proofs generated off-chain (proof + public inputs in"
echo "$RUN_DIR/withdraw-*.json). On-chain settlement of both paths —"
echo "mutualClose, and initiateEscapeWithdrawal -> challengeEscapeWithdrawal /"
echo "finalizeEscapeWithdrawal — is verified end-to-end by the contract suite:"
echo "    (cd protocol/contracts && forge test)"
echo
echo "Policy slash reuses the same homomorphic charge with a higher cap"
echo "(serverd --policy-enabled --policy-charge-cap N). Triggering one requires an"
echo "upstream returning x-zkapi-policy-* headers via --provider http-proxy."

# Pretty-print every JSON artifact so they are easy to read afterwards.
echo
echo "Formatting JSON artifacts in $RUN_DIR ..."
for f in "$RUN_DIR"/*.json; do
  [ -f "$f" ] || continue
  if formatted="$(jq . "$f" 2>/dev/null)"; then
    printf '%s\n' "$formatted" >"$f"
  fi
done

echo
echo "Final wallet state:"
jq . "$RUN_DIR/wallet-status.json"

echo
echo "Demo complete."
echo "Vault:         $VAULT_ADDRESS"
echo "Billing token: $TOKEN_ADDRESS"
echo "Artifacts:     $RUN_DIR  (formatted JSON)"
echo "Logs:          $LOG_DIR"
