# zkAPI EF

zkAPI is a private, prepaid API client. A user deposits demo credits into a
public testnet vault, then proves locally that an unlinkable private note can pay for
each request. The server verifies a compact proof, calls the configured API
provider, applies the charge, and signs the next private state.

Version 2 uses:

- Groth16 over BN254 for request and withdrawal proofs;
- Poseidon over the BN254 scalar field;
- Baby-JubJub Pedersen commitments and Poseidon-challenged Schnorr signatures;
- a 32-level active-note Merkle tree and state-derived nullifiers;
- OpenAI-compatible chat and responses endpoints on the local client daemon.

Stwo-Cairo and the development witness envelope are not part of the v2 runtime.
See [the design note](docs/design-note.md) for why a ZK proof is still needed
even though a STARK is not.

## Build and test

```bash
git clone --recurse-submodules git@github.com:OpenAnonymity/zkapi-ef.git
cd zkapi-ef
cargo build --release --bin zkapi
cargo test --workspace
(cd protocol/contracts && forge test)
```

The selected proving keys are versioned in `protocol/setup/v2`. Do not run the
`setup` command merely to use an existing deployment: it creates a new,
incompatible setup. For an intentionally fresh deployment:

```bash
./target/release/zkapi setup --output-dir protocol/setup/new-deployment
```

## Client flow

All global flags go before the subcommand. A deployment publishes the values
below in its client manifest:

```bash
export ZKAPI_BASE='https://DEPLOYMENT_HOST'
export ZKAPI_VAULT='0x...'
export ZKAPI_STATE_SIGNING_KEY_X='0x...'
export ZKAPI_STATE_SIGNING_KEY_Y='0x...'
export ZKAPI_CLEARANCE_SIGNING_KEY_X='0x...'
export ZKAPI_CLEARANCE_SIGNING_KEY_Y='0x...'

ZKAPI_ARGS=(
  --state-dir "$PWD/.zkapi-public-testnet"
  --protocol-server-url "$ZKAPI_BASE"
  --indexer-url "$ZKAPI_BASE"
  --protocol-version 2
  --chain-id 11155111
  --contract-address "$ZKAPI_VAULT"
  --proof-setup-dir "$PWD/protocol/setup/v2"
  --state-signing-key-x "$ZKAPI_STATE_SIGNING_KEY_X"
  --state-signing-key-y "$ZKAPI_STATE_SIGNING_KEY_Y"
  --clearance-signing-key-x "$ZKAPI_CLEARANCE_SIGNING_KEY_X"
  --clearance-signing-key-y "$ZKAPI_CLEARANCE_SIGNING_KEY_Y"
  --request-charge-cap 1000000
  --model openai/gpt-4o-mini
)
```

Generate deposit parameters, submit the returned commitment and Merkle path to
the vault, then confirm the mined note locally:

```bash
./target/release/zkapi "${ZKAPI_ARGS[@]}" prepare-deposit --amount 5000000

./target/release/zkapi "${ZKAPI_ARGS[@]}" confirm-deposit \
  --secret 0x... --note-id 0 --amount 5000000 \
  --expiry-ts <EXPIRY_TS_FROM_NOTE_DEPOSITED_EVENT>
```

Use the actual bucketed `expiryTs` from the `NoteDeposited` event in the confirm
step. Once confirmed, a chat request is entirely command-line driven:

```bash
./target/release/zkapi "${ZKAPI_ARGS[@]}" request \
  --path /v1/chat/completions \
  --json '{
    "model":"openai/gpt-4o-mini",
    "messages":[{"role":"user","content":"explain HTTPS briefly"}]
  }' | jq '{response_code, content:.payload.choices[0].message.content, charge_applied, remaining_balance}'
```

Run the same command repeatedly to advance the private balance and anchor. The
wallet serializes access with an on-disk lock and keeps a recovery journal. If a
request is interrupted after submission:

```bash
./target/release/zkapi "${ZKAPI_ARGS[@]}" recover
```

Alternatively, start the local compatibility daemon and point an OpenAI client
at it:

```bash
./target/release/zkapi "${ZKAPI_ARGS[@]}" clientd --listen 127.0.0.1:11434

curl -sS http://127.0.0.1:11434/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}' | jq .
```

## Components

- `zkapi-clientd`: local wallet, proof generation, recovery, and OpenAI/Ollama compatibility.
- `zkapi-serverd`: proof verification, nullifier DB, provider execution, billing, and next-state signing.
- `zkapi-indexerd`: Ethereum event indexer and Merkle-path service.
- `protocol/rust`: shared v2 primitives, circuits, proof code, and wallet SDK.
- `protocol/contracts`: the real Groth16 adapter and public testnet settlement vault.
- `demo/contracts`: deploys the demo token, real adapter, and vault.

This code and its current one-party Groth16 setup are unaudited. Use the public
deployment for testnet experimentation only.
