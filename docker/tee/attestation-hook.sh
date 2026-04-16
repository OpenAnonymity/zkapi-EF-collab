#!/usr/bin/env bash
set -euo pipefail

ATTESTATION_URL="${ATTESTATION_URL:-http://127.0.0.1:3000/v1/attestation}"
OUTPUT_JSON="${OUTPUT_JSON:-/tmp/zkapi-attestation.json}"
OUTPUT_ENV="${OUTPUT_ENV:-/tmp/zkapi-attestation.env}"

payload="$(curl -fsSL "$ATTESTATION_URL")"
printf '%s\n' "$payload" | tee "$OUTPUT_JSON"

if command -v jq >/dev/null 2>&1; then
  jq -r '
    "STATE_SIG_ROOT=\(.state_sig_root)\n" +
    "CLEAR_SIG_ROOT=\(.clear_sig_root)\n" +
    "STATE_SIG_EPOCH=\(.state_sig_epoch)\n" +
    "CLEAR_SIG_EPOCH=\(.clear_sig_epoch)\n" +
    "CONTRACT_ADDRESS=\(.contract_address)\n" +
    "CHAIN_ID=\(.chain_id)"
  ' "$OUTPUT_JSON" > "$OUTPUT_ENV"
  cat "$OUTPUT_ENV"
fi
