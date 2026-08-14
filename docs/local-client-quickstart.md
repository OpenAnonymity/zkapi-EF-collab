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
  --mode direct-openrouter --initial-credits 500000
```

The larger Sepolia test-token deposit supports several $0.05 frontier-model
leases. Each lease can cover a typical 1,024-token completion from the models
advertised by the deployment.

Omit `--address` to let `cast` derive the address and prompt securely for the
private key, or add `--address 0x...`. Funding prompts for the private key once,
uses a temporary encrypted `cast` keystore for mint/approve/deposit, and removes
that keystore as soon as funding finishes. The key is never stored in zkAPI's
state directory.

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
