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

./target/release/zkapi client \
  --deployment https://d33l4w2z2nh4cg.cloudfront.net/config.json \
  --mode direct-openrouter
```

That one command:

1. fetches the public public testnet deployment manifest;
2. uses the exact Groth16 setup, vault address, server URL, and pinned public
   signing keys from that manifest;
3. stores private wallet state in a deployment-specific directory under the
   user's local state directory;
4. reuses the existing active note, if one exists; otherwise it uses `cast` to
   derive an address and securely prompt for the same wallet key while it mints,
   approves, and deposits 2 demo credits; and
5. starts a local gateway on `127.0.0.1:11434`; and
6. in `direct-openrouter` mode, proves once to open an expiring runtime-key
   lease and sends subsequent LLM traffic from the local daemon straight to
   OpenRouter until that lease expires.

The gateway prints a progress line while it creates each local Groth16 proof
and another line with the total request time when the response arrives. Proof
generation uses two CPU workers by default. Set `RAYON_NUM_THREADS` before the
command only if you intentionally want a different local CPU limit.

Check that the selected deployment has direct mode enabled before starting:

```bash
curl -fsS https://d33l4w2z2nh4cg.cloudfront.net/health | jq .request_modes
```

The result must include `"direct_openrouter"`. Otherwise use the default
`--mode proxy`; enabling direct mode is an operator-side change requiring an
OpenRouter Management API key.

`cast` owns the private-key prompts; zkAPI does not write the key into its
configuration or wallet state. Use the same wallet key for the funding prompts.

To choose the funded address explicitly:

```bash
./target/release/zkapi client \
  --deployment https://d33l4w2z2nh4cg.cloudfront.net/config.json \
  --mode direct-openrouter \
  --address 0xYOUR_PUBLIC_TESTNET_ADDRESS
```

The first private-key prompt verifies that the supplied address belongs to that
key before any funding transaction is sent.

If `--address` is omitted, `cast wallet address --interactive` derives it from
the private key entered at the terminal. The default deployment is Ethereum
Mainnet, so always pass the public testnet manifest URL shown above when following
this testnet guide.

`--no-fund` starts the local service without creating a note, and `--skip-mint`
is useful when the selected wallet already has enough demo credits:

```bash
./target/release/zkapi client \
  --deployment https://d33l4w2z2nh4cg.cloudfront.net/config.json \
  --no-fund
./target/release/zkapi client \
  --deployment https://d33l4w2z2nh4cg.cloudfront.net/config.json \
  --skip-mint --initial-credits 10000000
```

An explicit `--initial-credits` value must be at least twice the deployment's
per-request proof bound. This keeps the note usable after a maximum-cost first
request; the public demo's 2,000,000-credit default is twice its bound.
If an existing note eventually falls to or below the bound, the launcher
reports its balance and asks for a fresh `--state-dir` instead of starting a
gateway that would become unusable after at most one more paid request. Keep
the old directory if you intend to withdraw that note's remaining balance.

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

The deployment is public testnet-only. In proxy mode each LLM call uses a Groth16
BN254 proof and passes through the server. In direct mode one proof authorizes
an expiring, spending-limited lease that can carry several sequential LLM
calls. The server never receives those prompts or responses; OpenRouter does.
At expiry the server reads aggregate key usage and finalizes that one zkAPI
request. Withdrawal settlement uses the real immutable Groth16 adapter in the
public testnet vault.
Stwo-Cairo, XMSS, and `dev_witness_envelope` are not part of the v2 runtime.

The demo token is freely mintable and has no value. The operator-funded
OpenRouter child key has a USD 5 monthly limit, so shared inference can be
temporarily unavailable after that budget is used.

The circuit, contracts, Rust implementation, and one-party Groth16 setup are
unaudited proof-of-concept software. Do not use this deployment or setup with
production funds.
