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
node --test funding-page/wallet.test.cjs
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
outside the repository, reuses an existing note, and serves the chat and
MetaMask funding UI at `http://127.0.0.1:11434/`. No wallet key is pasted into
the daemon or browser page. A new note defaults to 2 USDC and the selected
MetaMask account needs that USDC plus ETH for gas. The same process serves
standard APIs on `127.0.0.1:11434`:

- OpenAI Chat Completions: `/v1/chat/completions`
- OpenAI Responses: `/v1/responses`
- Ollama chat: `/api/chat`

Use a different deployment manifest with `--deployment`. The configured vault
accepts its configured ERC-20 billing token. The default Mainnet vault uses real
USDC; native ETH is used for transaction gas, not request credits. The former
terminal flow remains available as `--fund-with-cast` for headless setups.

The default `--mode proxy` sends each request through `zkapi-serverd`. On a
deployment that advertises `direct_openrouter`, opt into the prompt-private
mode with:

```bash
./target/release/zkapi client --mode direct-openrouter
```

The first local LLM call creates one Groth16 authorization and receives a
short-lived OpenRouter runtime key. The bundled UI assigns a stable local
session ID to each conversation. Requests with that ID—including concurrent
answer and title generation and later follow-ups—reuse that key and can run in
parallel. By default the daemon sends at most five LLM requests through a key,
then disables it, settles its aggregate usage, and obtains the next key for the
session. A different conversation cannot silently inherit an active key. Set
`--openrouter-requests-per-key 1` before the `client` subcommand for one key per
request, or choose another positive limit to trade fewer proofs and settlement
pauses for greater cross-request linkability. OpenRouter still sees the LLM
traffic; the zkAPI server does not. Runtime keys are held only in local process
memory and are never stored by the server.

When the server is configured with `--oa-org-url`, the response also contains
the station ID, expiry, station signature, org signature, and verifier URL used
by oa-chat. The local daemon submits that evidence to its independently
configured `--oa-verifier-url` and refuses to send a prompt unless the verifier
accepts the key. Because the station owns the OpenRouter management account,
the station disables each key when zkAPI retires it after the configured
request count (or at its provider-enforced expiry), waits for usage to
stabilize, and persists a signed aggregate-usage receipt before deleting the
key. The org verifies and
countersigns that receipt, and zkAPI charges the reported micro-dollar usage
rather than the reserved hard limit.

Clients that require this protection must set `--require-oa-org-key-source`
(or `ZKAPI_REQUIRE_OA_ORG_KEY_SOURCE=true`). This independent policy rejects a
server downgrade to a direct or legacy, unverifiable key.

For example, with `zkapi client` running:

```bash
curl -fsS http://127.0.0.1:11434/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-zkapi-session-id: chat-example' \
  -d '{"model":"openai/gpt-4o-mini","max_tokens":256,"messages":[{"role":"user","content":"explain HTTPS briefly"}]}' | jq .
```

The local gateway also exposes equivalent OpenAI Responses and Ollama routes.
Clients that omit `X-ZkAPI-Session-Id` use the compatibility session named
`default`. OpenAI chat streams use SSE. Ollama `/api/chat` streams use
newline-delimited JSON and stream by default, so either OpenWebUI connection
type receives tokens as OpenRouter produces them.

The bundled balance panel also closes notes without exposing the note secret.
Mutual close returns the remaining token balance in one MetaMask transaction.
If server clearance is unavailable, the escape hatch starts a challengeable
withdrawal using the vault's configured safety window (24 hours by default),
preserves the local note across daemon restarts, and
enables finalization after the on-chain deadline. Inference is blocked while a
withdrawal proof is prepared or an escape is pending.

## Components

- `zkapi-clientd`: local wallet, proof generation, recovery, and OpenAI/Ollama compatibility.
- `zkapi-serverd`: proof verification, nullifier/lease DB, proxy execution or aggregate lease billing, and next-state signing.
- `zkapi-indexerd`: Ethereum event indexer and Merkle-path service.
- `protocol/rust`: shared protocol primitives, circuits, proof code, and wallet SDK.
- `protocol/contracts`: the real Groth16 adapter and Ethereum settlement vault.
- `demo/contracts`: deploys the demo token, real adapter, and vault.
