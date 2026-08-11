# Public public testnet demo

The public zkAPI v2 endpoint is:

```text
https://d33l4w2z2nh4cg.cloudfront.net
```

Its machine-readable deployment manifest is:

```text
https://d33l4w2z2nh4cg.cloudfront.net/config.json
```

This deployment uses the v2 runtime described in [the design note](design-note.md):

- request and withdrawal proofs use Groth16 over BN254;
- the client proves private note membership, balance, expiry, state continuity,
  and authorization of the exact request payload;
- the public server verifies each request proof before calling OpenRouter;
- the public testnet vault uses the real, immutable Groth16 proof adapter for
  withdrawal settlement; and
- Stwo-Cairo, XMSS, and `dev_witness_envelope` are not in the v2 path.

The implementation and one-party Groth16 setup are unaudited. The billing token
is a freely mintable test token. This deployment is for public testnet testing only.

## Prerequisites

Install:

- Git with working SSH authentication for GitHub;
- Rust and Cargo;
- Foundry's `cast` command;
- `curl`, `jq`, `awk`, `openssl`, and `xxd`; and
- a public testnet wallet with enough public testnet ETH for gas.

No browser, Scarb, Cairo installation, OpenRouter key, or local server is
required. The public demo token can be minted from the terminal.

## Clone and build the exact client

Clone over SSH and initialize the submodules as a separate step:

```bash
export ZKAPI_BASE='https://d33l4w2z2nh4cg.cloudfront.net'

git clone git@github.com:OpenAnonymity/zkapi-ef.git
cd zkapi-ef
git submodule update --init --recursive
```

Create a private state directory outside the repository and download the
deployment manifest:

```bash
export ZKAPI_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/zkapi/public-testnet-groth16-v2"
install -d -m 700 "$ZKAPI_STATE_DIR"
export ZKAPI_CONFIG="$ZKAPI_STATE_DIR/deployment.json"
curl -fsS "$ZKAPI_BASE/config.json" > "$ZKAPI_CONFIG"
```

Check out the exact client revision published by the deployment and verify the
protocol submodule revision:

```bash
git checkout --detach "$(jq -r '.client.base_commit' "$ZKAPI_CONFIG")"
git submodule update --init --recursive
test "$(git -C protocol rev-parse HEAD)" = \
  "$(jq -r '.client.protocol_commit' "$ZKAPI_CONFIG")"
test "$(jq -r '.proof_backend' "$ZKAPI_CONFIG")" = 'groth16_bn254'

cargo build --release --bin zkapi
```

The proving keys under `protocol/setup/v2` are part of the selected protocol
revision. Do not run `zkapi setup`: that creates a different, incompatible
Groth16 setup.

## Configure the client

Load the public deployment values directly from the manifest:

```bash
export ZKAPI_VAULT="$(jq -r '.contract_address' "$ZKAPI_CONFIG")"
export ZKAPI_TOKEN="$(jq -r '.billing_token_address' "$ZKAPI_CONFIG")"
export PUBLIC_TESTNET_RPC_URL="$(jq -r '.rpc_url' "$ZKAPI_CONFIG")"
export ZKAPI_PROTOCOL_VERSION="$(jq -r '.protocol_version' "$ZKAPI_CONFIG")"
export ZKAPI_CHAIN_ID="$(jq -r '.chain_id' "$ZKAPI_CONFIG")"
export ZKAPI_REQUEST_CHARGE_CAP="$(jq -r '.request_charge_cap' "$ZKAPI_CONFIG")"
export ZKAPI_STATE_SIGNING_KEY_X="$(jq -r '.state_signing_key.x' "$ZKAPI_CONFIG")"
export ZKAPI_STATE_SIGNING_KEY_Y="$(jq -r '.state_signing_key.y' "$ZKAPI_CONFIG")"
export ZKAPI_CLEARANCE_SIGNING_KEY_X="$(jq -r '.clearance_signing_key.x' "$ZKAPI_CONFIG")"
export ZKAPI_CLEARANCE_SIGNING_KEY_Y="$(jq -r '.clearance_signing_key.y' "$ZKAPI_CONFIG")"
```

Define the common client arguments once. Global flags must appear before the
subcommand:

```bash
ZKAPI_ARGS=(
  --state-dir "$ZKAPI_STATE_DIR"
  --protocol-server-url "$ZKAPI_BASE"
  --indexer-url "$ZKAPI_BASE"
  --protocol-version "$ZKAPI_PROTOCOL_VERSION"
  --chain-id "$ZKAPI_CHAIN_ID"
  --contract-address "$ZKAPI_VAULT"
  --proof-setup-dir "$PWD/protocol/setup/v2"
  --state-signing-key-x "$ZKAPI_STATE_SIGNING_KEY_X"
  --state-signing-key-y "$ZKAPI_STATE_SIGNING_KEY_Y"
  --clearance-signing-key-x "$ZKAPI_CLEARANCE_SIGNING_KEY_X"
  --clearance-signing-key-y "$ZKAPI_CLEARANCE_SIGNING_KEY_Y"
  --request-charge-cap "$ZKAPI_REQUEST_CHARGE_CAP"
  --model openai/gpt-4o-mini
)
```

## Fund a private note from the terminal

Derive the depositor address by entering the public testnet private key interactively.
The private key is not placed in shell history:

```bash
export ZKAPI_DEPOSITOR="$(cast wallet address --interactive)"
```

Prepare a 5,000,000-credit note locally. The plan contains the note secret, so
keep it inside the owner-only state directory and do not print the full JSON:

```bash
umask 077
export ZKAPI_PLAN="$ZKAPI_STATE_DIR/deposit-plan.json"

./target/release/zkapi "${ZKAPI_ARGS[@]}" prepare-deposit \
  --amount 5000000 > "$ZKAPI_PLAN"

export ZKAPI_NOTE_ID="$(jq -r '.next_note_id' "$ZKAPI_PLAN")"
export ZKAPI_NOTE_AMOUNT="$(jq -r '.amount' "$ZKAPI_PLAN")"
export ZKAPI_NOTE_COMMITMENT="$(jq -r '.commitment' "$ZKAPI_PLAN")"
export ZKAPI_NOTE_COMMITMENT_BYTES32="$(
  printf '0x%064s' "${ZKAPI_NOTE_COMMITMENT#0x}" | tr ' ' '0'
)"
export ZKAPI_NOTE_ZERO_PATH="$(
  jq -jr '"[" + (.zero_path | join(",")) + "]"' "$ZKAPI_PLAN"
)"

jq 'del(.secret)' "$ZKAPI_PLAN"
```

The public demo token uses 6 decimals and exposes a faucet-style `mint` method.
Mint 5 demo units, approve the vault, and deposit the commitment. Each
transaction prompts for the same public testnet private key:

```bash
cast send --rpc-url "$PUBLIC_TESTNET_RPC_URL" --interactive \
  "$ZKAPI_TOKEN" 'mint(address,uint256)' \
  "$ZKAPI_DEPOSITOR" "$ZKAPI_NOTE_AMOUNT"

cast send --rpc-url "$PUBLIC_TESTNET_RPC_URL" --interactive \
  "$ZKAPI_TOKEN" 'approve(address,uint256)' \
  "$ZKAPI_VAULT" "$ZKAPI_NOTE_AMOUNT"

cast send --rpc-url "$PUBLIC_TESTNET_RPC_URL" --interactive \
  "$ZKAPI_VAULT" 'deposit(bytes32,uint128,uint256[32])' \
  "$ZKAPI_NOTE_COMMITMENT_BYTES32" \
  "$ZKAPI_NOTE_AMOUNT" \
  "$ZKAPI_NOTE_ZERO_PATH"
```

`cast send` waits for a receipt. Wait for the public indexer to ingest the
deposit, read the vault's bucketed expiry, and confirm the note locally:

```bash
until [ "$(curl -fsS "$ZKAPI_BASE/v1/tree/next-note-id" | \
  jq -r '.next_note_id')" -gt "$ZKAPI_NOTE_ID" ]; do
  sleep 3
done

export ZKAPI_NOTE_EXPIRY="$(
  cast call --rpc-url "$PUBLIC_TESTNET_RPC_URL" --json \
    "$ZKAPI_VAULT" \
    'notes(uint32)(bytes32,uint128,uint64,uint8)' \
    "$ZKAPI_NOTE_ID" | jq -r '.[2]'
)"

./target/release/zkapi "${ZKAPI_ARGS[@]}" confirm-deposit \
  --secret "$(jq -r '.secret' "$ZKAPI_PLAN")" \
  --note-id "$ZKAPI_NOTE_ID" \
  --amount "$ZKAPI_NOTE_AMOUNT" \
  --expiry-ts "$ZKAPI_NOTE_EXPIRY"

./target/release/zkapi "${ZKAPI_ARGS[@]}" status | jq .
rm "$ZKAPI_PLAN"
```

Do not delete or reset `ZKAPI_STATE_DIR` while its note has a balance. The note
secret and evolving private state live there.

## Send sequential chats

No proof-mode or Cairo environment variables are needed. Send one chat with:

```bash
./target/release/zkapi "${ZKAPI_ARGS[@]}" request \
  --path /v1/chat/completions \
  --json '{
    "model": "openai/gpt-4o-mini",
    "messages": [{"role": "user", "content": "Explain HTTPS briefly."}]
  }' | jq '{
    response_code,
    content: .payload.choices[0].message.content,
    model: .payload.model,
    provider: .payload.provider,
    charge_applied,
    remaining_balance,
    next_anchor
  }'
```

The wallet serializes access and advances its private balance and state anchor
after every successful response. This loop tests three sequential transitions:

```bash
for n in 1 2 3; do
  REQUEST_JSON="$(jq -nc --arg n "$n" '{
    model: "openai/gpt-4o-mini",
    messages: [{
      role: "user",
      content: ("Reply with exactly these two words: sequential " + $n)
    }]
  }')"

  ./target/release/zkapi "${ZKAPI_ARGS[@]}" request \
    --path /v1/chat/completions \
    --json "$REQUEST_JSON" | jq '{
      response_code,
      content: .payload.choices[0].message.content,
      charge_applied,
      remaining_balance,
      next_anchor
    }'
done
```

The balance must decrease and `next_anchor` must change after each successful
request. If a request is interrupted after submission, recover its finalized
result and state transition with:

```bash
./target/release/zkapi "${ZKAPI_ARGS[@]}" recover | jq .
```

## Optional: run an OpenAI-compatible local endpoint

Start the local compatibility daemon:

```bash
./target/release/zkapi "${ZKAPI_ARGS[@]}" clientd \
  --listen 127.0.0.1:11434
```

In another terminal, send requests to it like an OpenAI client:

```bash
curl -fsS http://127.0.0.1:11434/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "openai/gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello from zkAPI."}]
  }' | jq .
```

## Optional: generate and settle a mutual withdrawal

Generate a server-cleared withdrawal proof for the wallet's current private
balance:

```bash
export ZKAPI_WITHDRAW_PLAN="$ZKAPI_STATE_DIR/withdraw-plan.json"

./target/release/zkapi "${ZKAPI_ARGS[@]}" withdraw \
  --destination "$ZKAPI_DEPOSITOR" \
  --mode mutual > "$ZKAPI_WITHDRAW_PLAN"
```

Encode the returned tuple, proof, and Merkle path for the vault:

```bash
export ZKAPI_WITHDRAW_INPUTS="($(
  jq -jr '[
    .public_inputs.protocol_version,
    .public_inputs.chain_id,
    .public_inputs.contract_address,
    .public_inputs.active_root,
    .public_inputs.state_signing_key_x,
    .public_inputs.state_signing_key_y,
    .public_inputs.clearance_signing_key_x,
    .public_inputs.clearance_signing_key_y,
    .public_inputs.note_id,
    .public_inputs.final_balance
  ] | join(",")' "$ZKAPI_WITHDRAW_PLAN"
),$ZKAPI_DEPOSITOR,$(
  jq -jr '[
    .public_inputs.withdrawal_nullifier,
    .public_inputs.has_clearance,
    .public_inputs.withdrawal_tag
  ] | join(",")' "$ZKAPI_WITHDRAW_PLAN"
))"

export ZKAPI_WITHDRAW_PROOF="0x$(
  jq -r '.proof.proof' "$ZKAPI_WITHDRAW_PLAN" | \
  openssl base64 -d -A | xxd -p -c 1000
)"

export ZKAPI_WITHDRAW_SIBLINGS="$(
  jq -jr '"[" + (.siblings | join(",")) + "]"' "$ZKAPI_WITHDRAW_PLAN"
)"
```

Submit the real Groth16 withdrawal proof on public testnet:

```bash
cast send --rpc-url "$PUBLIC_TESTNET_RPC_URL" --interactive \
  "$ZKAPI_VAULT" \
  'mutualClose((uint16,uint64,address,uint256,uint256,uint256,uint256,uint256,uint32,uint128,address,uint256,bool,uint256),bytes,uint256[32])' \
  "$ZKAPI_WITHDRAW_INPUTS" \
  "$ZKAPI_WITHDRAW_PROOF" \
  "$ZKAPI_WITHDRAW_SIBLINGS"
```

After the receipt succeeds, the note is closed on-chain and its final balance
has been transferred to `ZKAPI_DEPOSITOR`.

## Health, limits, and observed performance

The public health, attestation, and deployment endpoints require no wallet:

```bash
curl -fsS "$ZKAPI_BASE/health" | jq .
curl -fsS "$ZKAPI_BASE/v1/attestation" | jq .
curl -fsS "$ZKAPI_BASE/config.json" | jq .
```

The deployment was validated from a clean SSH clone with a deposit, three
sequential OpenRouter chats, recovery lookups, a mutual-withdrawal proof, and a
successful public testnet close. The three complete chat calls took 3.14, 2.66, and
2.49 seconds on the test client. Standalone release-mode request proving is
roughly 0.35 seconds and about 184 MB peak memory on the development machine;
exact results vary by CPU.

The operator-funded OpenRouter child key is capped at USD 5 per month. The
shared chat demo can become temporarily unavailable after that monthly budget
is exhausted.

The current Groth16 parameters were generated by one party, and the circuit,
Rust, and Solidity implementations have not been audited. Arkworks describes
its Groth16 implementation as academic proof-of-concept software. Do not use
this deployment or setup for production funds.
