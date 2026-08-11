# Public public testnet demo

The public zkAPI v2 deployment is available at
`https://d33l4w2z2nh4cg.cloudfront.net`. Its published client parameters are
available at `/config.json` on that endpoint.

## One-command client

Install Rust, Git with GitHub SSH access, and Foundry's `cast` command. Then:

```bash
git clone git@github.com:OpenAnonymity/zkapi-ef.git
cd zkapi-ef
git submodule update --init --recursive
cargo build --release --bin zkapi

./target/release/zkapi client
```

That one command:

1. fetches the public public testnet deployment manifest;
2. uses the exact Groth16 setup, vault address, server URL, and pinned public
   signing keys from that manifest;
3. stores private wallet state in a deployment-specific directory under the
   user's local state directory;
4. reuses the existing active note, if one exists; otherwise it uses `cast` to
   derive an address and securely prompt for the same wallet key while it mints,
   approves, and deposits 5 demo credits; and
5. starts a local gateway on `127.0.0.1:11434`.

`cast` owns the private-key prompts; zkAPI does not write the key into its
configuration or wallet state. Use the same wallet key for the funding prompts.

To choose the funded address explicitly:

```bash
./target/release/zkapi client \
  --address 0xYOUR_PUBLIC_TESTNET_ADDRESS
```

If `--address` is omitted, `cast wallet address --interactive` derives it from
the private key entered at the terminal. Use a different public v2 deployment
manifest with `--deployment <URL_OR_PATH>`. The public public testnet manifest is the
default, so no deployment argument is normally needed.

`--no-fund` starts the local service without creating a note, and `--skip-mint`
is useful when the selected wallet already has enough demo credits:

```bash
./target/release/zkapi client --no-fund
./target/release/zkapi client --skip-mint --initial-credits 10000000
```

The public vault accepts its configured test ERC-20 billing token, not native
ETH. Native ETH payments require a separate native-asset vault deployment and
are deliberately not silently substituted by this client.

## Use standard local LLM APIs

Keep `zkapi client` running and point applications at `http://127.0.0.1:11434`.
No API key is required locally.

OpenAI Chat Completions:

```bash
curl -fsS http://127.0.0.1:11434/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "openai/gpt-4o-mini",
    "messages": [{"role": "user", "content": "Explain HTTPS briefly."}]
  }' | jq .
```

OpenAI Responses:

```bash
curl -fsS http://127.0.0.1:11434/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-4o-mini","input":"Say hello."}' | jq .
```

Ollama chat:

```bash
curl -fsS http://127.0.0.1:11434/api/chat \
  -H 'content-type: application/json' \
  -d '{
    "model": "openai/gpt-4o-mini",
    "messages": [{"role": "user", "content": "Say hello."}]
  }' | jq .
```

The gateway also provides `/v1/models`, `/api/tags`, `/health`, and
`/wallet/status`. Requests that arrive before funding receive a local 402 with
a funding hint rather than reaching the paid upstream.

## Security and limits

The deployment is public testnet-only. Each request uses a Groth16 BN254 proof; the
server verifies it before it calls the OpenRouter-backed upstream. Withdrawal
settlement uses the real immutable Groth16 adapter in the public testnet vault.
Stwo-Cairo, XMSS, and `dev_witness_envelope` are not part of the v2 runtime.

The demo token is freely mintable and has no value. The operator-funded
OpenRouter child key has a USD 5 monthly limit, so shared inference can be
temporarily unavailable after that budget is used.

The circuit, contracts, Rust implementation, and one-party Groth16 setup are
unaudited proof-of-concept software. Do not use this deployment or setup with
production funds.
