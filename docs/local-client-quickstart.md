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
  --mode direct-openrouter --initial-credits 100000
```

Omit `--address` to let `cast` derive the address and prompt securely for the
private key, or add `--address 0x...`. Keep the client running, then call its
local OpenAI-compatible API:

```bash
curl -fsS http://127.0.0.1:11434/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"Explain HTTPS briefly."}]}' | jq .
```
