# Local client quickstart

Prerequisites: Rust and Foundry (`cast`). Clone and build:

```bash
git clone https://github.com/OpenAnonymity/zkapi-EF-collab.git
cd zkapi-EF-collab
git submodule update --init --recursive
cargo build --release --bin zkapi
```

Start the prompt-private local API on Ethereum Mainnet (real USDC and ETH for gas):

```bash
./target/release/zkapi --require-oa-org-key-source client \
  --mode direct-openrouter --initial-credits 100000
```

Or use Sepolia (free test token, but Sepolia ETH is needed for gas):

```bash
./target/release/zkapi --require-oa-org-key-source client \
  --deployment https://d33l4w2z2nh4cg.cloudfront.net/config.json \
  --mode direct-openrouter --initial-credits 5000000
```

The larger Sepolia test-token deposit reserves enough for about 100
maximum-cost lease windows at the demo's $0.05 cap. By default a child key
serves at most five sequential LLM
requests before the client disables it, settles measured aggregate usage, and
opens the next lease. Requests sharing a key are linkable to OpenRouter. To use
one key per request, put `--openrouter-requests-per-key 1` before `client`:

```bash
./target/release/zkapi --require-oa-org-key-source \
  --openrouter-requests-per-key 1 client --mode direct-openrouter
```

Omit `--address` to let `cast` derive the address and prompt securely for the
private key, or add `--address 0x...`. Funding prompts for the private key once,
uses a temporary encrypted `cast` keystore for mint/approve/deposit, and removes
that keystore as soon as funding finishes. The key is never stored in zkAPI's
state directory.

The client manages that directory as a stable active-wallet slot. When an
existing note no longer has enough reserve for another maximum-cost request,
normal startup preserves it under `retired/note_<id>` (where it remains
available for withdrawal), funds a fresh note, and continues using the same
client command. `--no-fund` disables both automatic funding and this rotation.

Keep the client running, then call its local OpenAI-compatible API:

```bash
curl -fsS http://127.0.0.1:11434/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-4o-mini","max_tokens":256,"messages":[{"role":"user","content":"Explain HTTPS briefly."}]}' | jq .
```

Streaming works with both OpenWebUI connection types: `/v1/chat/completions`
passes `"stream": true` through as unbuffered OpenAI-compatible SSE, while
`/api/chat` converts that stream into Ollama-compatible NDJSON (and follows
Ollama's default of streaming when the field is omitted).

## Withdraw

Keep the local client running, stop sending LLM requests, and wait for any
active ephemeral-key lease to settle. This can take the remainder of its
five-minute lifetime if it has not reached the configured request limit:

```bash
until curl -fsS http://127.0.0.1:11434/wallet/status \
  | jq -e '.pending_request == false' >/dev/null; do sleep 5; done
```

Set the payout address and the deployment manifest used to start the client.
The default below is Ethereum Mainnet; replace it with the Sepolia manifest
from above when using Sepolia.

```bash
DESTINATION=0xYourPayoutAddress
DEPLOYMENT=${DEPLOYMENT:-https://d27v1dvkaxfc09.cloudfront.net/config.json}
DEPLOYMENT_JSON=$(curl -fsS "$DEPLOYMENT")
RPC_URL=$(jq -r .rpc_url <<<"$DEPLOYMENT_JSON")
VAULT=$(jq -r .contract_address <<<"$DEPLOYMENT_JSON")
PLAN=$(mktemp)
trap 'rm -f "$PLAN"' EXIT

curl -fsS http://127.0.0.1:11434/wallet/withdraw \
  -H 'content-type: application/json' \
  -d "{\"mode\":\"mutual\",\"destination\":\"$DESTINATION\"}" >"$PLAN"
```

Encode the returned Groth16 proof and submit the mutual close. `cast send
--interactive` prompts for a private key; this account only pays transaction
gas and does not need to match the note owner or payout address.

```bash
p() { jq -r ".public_inputs.$1" "$PLAN"; }
INPUTS="($(p protocol_version),$(p chain_id),$(p contract_address),$(p active_root),$(p state_signing_key_x),$(p state_signing_key_y),$(p clearance_signing_key_x),$(p clearance_signing_key_y),$(p note_id),$(p final_balance),$DESTINATION,$(p withdrawal_nullifier),$(p has_clearance),$(p withdrawal_tag))"
PROOF_HEX="0x$(jq -r .proof.proof "$PLAN" | openssl base64 -d -A | xxd -p -c 9999)"
SIBLINGS=$(jq -r '"[" + (.siblings | join(",")) + "]"' "$PLAN")

cast send "$VAULT" \
  'mutualClose((uint16,uint64,address,uint256,uint256,uint256,uint256,uint256,uint32,uint128,address,uint256,bool,uint256),bytes,uint256[32])' \
  "$INPUTS" "$PROOF_HEX" "$SIBLINGS" \
  --rpc-url "$RPC_URL" --interactive
```

If the transaction reports a stale root, regenerate the plan and retry. Only
after `cast` reports a successful receipt, archive and clear the closed local
note so the next client start can fund a new one:

```bash
curl -fsS -X POST http://127.0.0.1:11434/wallet/reset | jq .
```

If the zkAPI server is unavailable, generate a plan with `"mode":"escape"`
instead and replace `mutualClose` above with
`initiateEscapeWithdrawal` using the same argument types and values. Stop the
client after initiation. After the contract's 24-hour challenge period, finish
the withdrawal with:

```bash
cast send "$VAULT" 'finalizeEscapeWithdrawal(uint32)' "$(p note_id)" \
  --rpc-url "$RPC_URL" --interactive
```

Do not reset the local note until that finalization transaction succeeds.
