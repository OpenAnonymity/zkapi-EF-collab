# zkAPI EF Collaboration

`ef-collaboration` is the grant-delivery workspace for the zkAPI stack.

The protocol implementation lives in the [`protocol/`](./protocol) submodule. This outer repo adds the app-facing pieces that were missing from the protocol-only repository:

- `zkapi-cli`: operator and local-user CLI
- `zkapi-clientd`: local auth daemon with `/request`, OpenAI-compatible, OpenResponses-compatible, and Ollama-compatible endpoints
- `funding-page/`: static local deposit UI
- `zkapi-integration-tests`: end-to-end Rust test harness
- CI, deployment docs, Docker packaging, and demo scripts

## Layout

```text
ef-collaboration/
├── protocol/                     # git submodule: curryrasul/zkAPI
├── crates/
│   ├── zkapi-cli/
│   ├── zkapi-clientd/
│   └── zkapi-integration-tests/
├── funding-page/
├── docs/
├── docker/
├── scripts/
└── .github/workflows/
```

## Bootstrap

```bash
git submodule update --init --recursive
cargo build
cargo test --workspace --exclude zkapi-integration-tests
cargo test -p zkapi-integration-tests --all-features -- --test-threads=1
cargo test --manifest-path protocol/rust/Cargo.toml --workspace
```

`protocol/` is explicitly excluded from the outer Cargo workspace. The outer crates consume protocol crates through direct path dependencies, so `workspace = true` metadata inside `protocol/rust/` still resolves against the protocol sub-workspace rather than the outer one.

## Common Flows

Generate a deposit secret/commitment:

```bash
cargo run -p zkapi-cli -- keygen
```

Run the protocol indexer:

```bash
cargo run -p zkapi-cli -- \
  --contract-address 0xdeadbeef \
  indexer \
  --contract-address 0xYourVault \
  --rpc-url http://127.0.0.1:8545
```

Run the protocol server:

```bash
cargo run -p zkapi-cli -- \
  --contract-address 0xdeadbeef \
  server \
  --provider echo \
  --indexer-url http://127.0.0.1:3001
```

Run the local auth daemon:

```bash
cargo run -p zkapi-cli -- \
  --contract-address 0xdeadbeef \
  auth \
  --listen 127.0.0.1:11434
```

Inspect server health and published roots:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/v1/attestation
```

Prepare and confirm a deposit:

```bash
cargo run -p zkapi-cli -- prepare-deposit --amount 1000000
cargo run -p zkapi-cli -- confirm-deposit \
  --secret 0x... \
  --note-id 0 \
  --amount 1000000 \
  --expiry-ts 4102444800
```

Send an authenticated request through the daemon:

```bash
cargo run -p zkapi-cli -- request \
  --path /v1/chat/completions \
  --json '{"model":"zkapi-echo","messages":[{"role":"user","content":"hello"}]}'
```

## Ops Assets

- Docker image: `docker build -f docker/Dockerfile .`
- Compose auth daemon: `docker compose -f docker/docker-compose.yml up --build`
- Compose local dev stack: `docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml up --build`
- End-to-end demo: `./scripts/e2e-demo.sh`

## Proof Scope

The current Rust runtime still uses mock proof envelopes for request/withdrawal roundtrips. The Cairo circuits in `protocol/cairo/` are the real proving logic and are tested independently with `scarb test`. See [docs/roadmap.md](./docs/roadmap.md) for the runtime prover bridge gap.

## Verification Matrix

- Outer app crates: `cargo test --workspace --exclude zkapi-integration-tests`
- Outer integration tests: `cargo test -p zkapi-integration-tests --all-features -- --test-threads=1`
- Protocol Rust crates: `cargo test --manifest-path protocol/rust/Cargo.toml --workspace`
- Protocol Solidity: `cd protocol/contracts && forge test -vvv`
- Protocol Cairo: `cd protocol/cairo && scarb test`
