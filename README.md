# zkAPI EF

zkAPI is a private, prepaid API client. A user deposits billing credits into an
Ethereum vault, then proves locally that an unlinkable private note can pay for
each request. It supports the existing server-proxy mode and a prompt-private
OpenRouter mode in which the server issues a short-lived, spending-limited key,
and never receives prompts or responses. Keys can be minted directly with an
OpenRouter management credential or relayed through an OA org/station so the
client can verify the provider account's privacy settings before inference.

The current protocol uses:

- Groth16 over BN254 for request and withdrawal proofs;
- Poseidon over the BN254 scalar field;
- Baby-JubJub Pedersen commitments and Poseidon-challenged Schnorr signatures;
- a 32-level active-note Merkle tree and state-derived nullifiers;
- OpenAI-compatible chat and responses endpoints on the local client daemon.

## Build and test

```bash
git clone git@github.com:OpenAnonymity/zkapi-ef.git
cd zkapi-ef
git submodule update --init --recursive
cargo build --release --bin zkapi
cargo test --workspace
(cd protocol/contracts && forge test)
```

The selected proving keys are stored in `protocol/setup/v2`. Do not run the
`setup` command merely to use an existing deployment: it creates a new,
incompatible setup. For an intentionally fresh deployment:

```bash
./target/release/zkapi setup --output-dir protocol/setup/new-deployment
```

## Local client

For prompt-private Mainnet and Sepolia setup, see the
[local client quickstart](docs/local-client-quickstart.md).

After building, start a ready-to-use local gateway with one command:

```bash
./target/release/zkapi client
```

It loads the experimental Ethereum Mainnet manifest, stores private state
outside the repository, reuses an existing note, and otherwise asks `cast` to
securely derive the wallet address and sign the real-USDC approval and deposit.
The default deposit is 2 USDC. The address must already hold that USDC and
enough ETH for gas. It then serves standard APIs on `127.0.0.1:11434`:

- OpenAI Chat Completions: `/v1/chat/completions`
- OpenAI Responses: `/v1/responses`
- Ollama chat: `/api/chat`

Choose an address with `--address` (the first key prompt verifies it), use a
different deployment manifest with `--deployment`, or start without funding via
`--no-fund`. The configured vault accepts its configured ERC-20 billing token.
The default Mainnet vault uses real USDC; native ETH is used for transaction
gas, not request credits.

The default `--mode proxy` sends each request through `zkapi-serverd`. On a
deployment that advertises `direct_openrouter`, opt into the prompt-private
mode with:

```bash
./target/release/zkapi client --mode direct-openrouter
```

Every local LLM call creates one Groth16 authorization and receives a new,
short-lived OpenRouter runtime key. The local daemon uses that key for exactly
one inference, retires it after the buffered response or final streaming chunk,
and recovers the resulting zkAPI state before opening the next lease. OpenRouter
still sees the LLM traffic; the zkAPI server does not. Runtime keys are held only
in local process memory, are never stored by the server, and are never reused by
a later inference.

When the server is configured with `--oa-org-url`, the response also contains
the station ID, expiry, station signature, org signature, and verifier URL used
by oa-chat. The local daemon submits that evidence to its independently
configured `--oa-verifier-url` and refuses to send a prompt unless the verifier
accepts the key. Because the station owns the OpenRouter management account,
zkAPI cannot read actual child-key usage in this mode; each request-scoped lease
settles at its proof-bound hard spending limit rather than aggregate usage.

Clients that require this protection must set `--require-oa-org-key-source`
(or `ZKAPI_REQUIRE_OA_ORG_KEY_SOURCE=true`). This independent policy rejects a
server downgrade to a direct or legacy, unverifiable key.

For example, with `zkapi client` running:

```bash
curl -fsS http://127.0.0.1:11434/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-4o-mini","max_tokens":256,"messages":[{"role":"user","content":"explain HTTPS briefly"}]}' | jq .
```

The local gateway also exposes equivalent OpenAI Responses and Ollama routes.
OpenAI chat streams use SSE. Ollama `/api/chat` streams use newline-delimited
JSON and stream by default, so either OpenWebUI connection type receives tokens
as OpenRouter produces them.

## Components

- `zkapi-clientd`: local wallet, proof generation, recovery, and OpenAI/Ollama compatibility.
- `zkapi-serverd`: proof verification, nullifier/lease DB, proxy execution or aggregate lease billing, and next-state signing.
- `zkapi-indexerd`: Ethereum event indexer and Merkle-path service.
- `protocol/rust`: shared protocol primitives, circuits, proof code, and wallet SDK.
- `protocol/contracts`: the real Groth16 adapter and Ethereum settlement vault.
- `demo/contracts`: deploys the demo token, real adapter, and vault.
