# Roadmap

## Delivered In This Workspace

- Outer Cargo workspace that cleanly excludes the nested `protocol/` workspace while consuming protocol crates through direct path dependencies.
- `zkapi-authd` with native `/request`, OpenAI `/v1/chat/completions`, OpenResponses `/v1/responses`, Ollama `/api/chat`, wallet funding endpoints, and embedded funding-page assets.
- `zkapi` app-layer CLI covering wallet funding flows plus protocol `server` and `indexer` process management.
- Protocol-side fixes for stale-root retry semantics, signer serialization, persisted `response_payload` recovery, indexer HTTP service, JSON-RPC log polling, and server root synchronization.
- CI coverage for outer crates, protocol Rust crates, integration tests, Foundry, and Scarb.

## Remaining Gaps

### Runtime Prover Bridge

The live Rust request and withdrawal flows still serialize mock proof envelopes while the Cairo circuits remain the authoritative proving implementation. The next production milestone is replacing the mock envelope path with a prover bridge that emits real Cairo proofs for the same public inputs already exercised by the Rust and Cairo test suites.

### Rich Upstream Provider Envelope

The current app-layer daemon sends a structured `CoreRequest` payload through the protocol, and the protocol server supports either the deterministic echo provider or a single-URL HTTP proxy provider. If the deployment target requires transparent multi-endpoint upstream HTTP execution, the protocol request envelope must grow beyond a plain payload string.

### Production Hardening

- Publish server-root rotation through an automated operator workflow instead of manual `cast send`.
- Replace demo-token deployment with a real billing token and vault configuration.
- Add production observability around request latency, provider failures, root lag, and XMSS capacity.

## Verification Baseline

- `cargo test --workspace --exclude zkapi-integration-tests`
- `cargo test -p zkapi-integration-tests --all-features -- --test-threads=1`
- `cargo test --manifest-path protocol/rust/Cargo.toml --workspace`
- `cd protocol/contracts && forge test -vvv`
- `cd protocol/cairo && scarb test`
