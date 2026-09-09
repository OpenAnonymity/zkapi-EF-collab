# Local client quickstart

Prerequisite: Rust. Foundry's `cast` is required for the terminal funding flow below.
Clone and build:

```bash
git clone https://github.com/OpenAnonymity/zkapi-EF-collab.git
cd zkapi-EF-collab
git submodule update --init --recursive
cargo build --release --bin zkapi
```

Start the prompt-private local API on Ethereum Mainnet (real USDC and ETH for gas):

```bash
./target/release/zkapi --require-oa-org-key-source client \
  --mode direct-openrouter --initial-credits 2000000 --fund-with-cast
```

The suggested deposit is 2,000,000 base units (`2 USDC`). The selected wallet must
already hold at least that much USDC plus Mainnet ETH for approve, deposit,
and withdrawal gas. For a small test, `0.003 ETH` provides reasonable
headroom at low gas prices; check the current gas price before funding.

Or use Sepolia (free test token, but Sepolia ETH is needed for gas):

```bash
./target/release/zkapi --require-oa-org-key-source client \
  --deployment https://d33l4w2z2nh4cg.cloudfront.net/config.json \
  --mode direct-openrouter --initial-credits 5000000 --fund-with-cast
```

Follow the terminal funding prompts. The default `http://127.0.0.1:11434/`
page contains local-client help and links to status; OA Chat is a separate app.
The CLI securely prompts for the funding signer rather than accepting a key in
its arguments or saving it in daemon state. On the public Sepolia deployment,
the funding flow can mint free test credits when needed; the address still needs
Sepolia ETH for gas. Preserve the deployment and state-directory settings when
restarting an existing wallet.

The larger Sepolia test-token deposit supports proof-backed, cumulative
dollar-budget lease windows. A child key belongs to one chat session. Its
answer, title generation, and follow-up requests reuse that key and may run in
parallel. The client replaces it only on expiry, explicit settlement, provider
rejection, or dollar-cap exhaustion. Requests sharing a key are linkable to
OpenRouter. Start prompt-private mode with:

```bash
./target/release/zkapi --require-oa-org-key-source \
  client --mode direct-openrouter
```

Add the same `--deployment ...` argument shown above after `client` when using
Sepolia.

Keep the client running, then connect a compatible application or call its local
OpenAI-compatible API. Supply a stable session ID when an application can
identify a conversation:

```bash
curl -fsS http://127.0.0.1:11434/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-zkapi-session-id: my-private-chat' \
  -d '{"model":"openai/gpt-4o-mini","max_tokens":256,"messages":[{"role":"user","content":"Explain HTTPS briefly."}]}' | jq .
```

Streaming works with both OpenWebUI connection types: `/v1/chat/completions`
passes `"stream": true` through as unbuffered OpenAI-compatible SSE, while
`/api/chat` converts that stream into Ollama-compatible NDJSON (and follows
Ollama's default of streaming when the field is omitted).

## Withdraw

Keep the local client running and withdraw the active note from another
terminal. The command retires any active ephemeral key, settles its measured
usage, builds the proof, securely prompts for a gas-payer private key, submits
the transaction, verifies that the note closed, and clears the local note:

```bash
./target/release/zkapi withdraw --destination 0xYourPayoutAddress
```

For a client running against Sepolia, select the same manifest:

```bash
./target/release/zkapi withdraw \
  --deployment https://d33l4w2z2nh4cg.cloudfront.net/config.json \
  --destination 0xYourPayoutAddress
```

The prompted account only pays ETH gas; it does not need to be the depositor or
the payout address.

If the zkAPI server is unavailable, initiate the escape hatch instead:

```bash
./target/release/zkapi withdraw --mode escape \
  --destination 0xYourPayoutAddress
```

The result prints the note ID and challenge deadline. After the deadline,
finalize it (repeat `--deployment ...` for Sepolia):

```bash
./target/release/zkapi withdraw --mode finalize-escape --note-id NOTE_ID
```

In direct mode, calls with the same session ID share one bounded ephemeral key
and may execute concurrently. Until that key expires and settles, a different
session receives `409 lease_session_conflict` instead of being linkable to it.

## Optional browser application

A downstream app may embed a separately built frontend in the daemon using
`ZKAPI_FRONTEND_DIST`. See [Local daemon frontend](daemon-frontend.md) for the
build contract. Browser funding and withdrawal controls are provided by that
application; the default daemon page does not initiate transactions. OA Chat
now owns its chat UI and consumes the zkAPI browser SDK independently.
