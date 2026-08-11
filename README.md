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
git clone git@github.com:OpenAnonymity/zkapi-ef.git
cd zkapi-ef
git submodule update --init --recursive
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

## Local client

After building, start a ready-to-use local gateway with one command:

```bash
./target/release/zkapi client
```

It loads the public public testnet manifest, stores private state outside the
repository, reuses an existing note, and otherwise asks `cast` to securely
derive the wallet address and sign the demo-token mint, approval, and deposit.
It then serves standard APIs on `127.0.0.1:11434`:

- OpenAI Chat Completions: `/v1/chat/completions`
- OpenAI Responses: `/v1/responses`
- Ollama chat: `/api/chat`

Choose an address with `--address`, use a different deployment manifest with
`--deployment`, or start without funding via `--no-fund`. The public public testnet
vault accepts its configured demo ERC-20; native-ETH funding requires a
separate native-asset vault deployment.

For example, with `zkapi client` running:

```bash
curl -fsS http://127.0.0.1:11434/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"explain HTTPS briefly"}]}' | jq .
```

See [the public public testnet guide](docs/public-testnet-demo.md) for prerequisites,
options, and equivalent OpenAI Responses and Ollama examples.

## Components

- `zkapi-clientd`: local wallet, proof generation, recovery, and OpenAI/Ollama compatibility.
- `zkapi-serverd`: proof verification, nullifier DB, provider execution, billing, and next-state signing.
- `zkapi-indexerd`: Ethereum event indexer and Merkle-path service.
- `protocol/rust`: shared v2 primitives, circuits, proof code, and wallet SDK.
- `protocol/contracts`: the real Groth16 adapter and public testnet settlement vault.
- `demo/contracts`: deploys the demo token, real adapter, and vault.

This code and its current one-party Groth16 setup are unaudited. Use the public
deployment for testnet experimentation only.
