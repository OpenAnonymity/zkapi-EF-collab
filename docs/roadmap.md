# Roadmap

## Delivered In This Workspace

- Outer Cargo workspace that cleanly excludes the nested `protocol/` workspace while consuming protocol crates through direct path dependencies.
- `zkapi-clientd` with native `/request`, OpenAI `/v1/chat/completions`, OpenResponses `/v1/responses`, Ollama `/api/chat`, wallet funding endpoints, and embedded funding-page assets.
- `zkapi` app-layer CLI covering wallet funding flows plus protocol `server` and `indexer` process management.
- Protocol-side fixes for stale-root retry semantics, signer serialization, persisted `response_payload` recovery, indexer HTTP service, JSON-RPC log polling, and server root synchronization.
- Multi-request correctness: Pedersen blinding is now accumulated modulo the curve order (it was wrapping at the base-field prime, which broke state-signature verification on the 2nd+ request), and XMSS validation honors the configured tree height instead of a hard-coded maximum.
- Swappable authentication method (`zkapi-auth::CredentialScheme`): the state-anchor chain as the reference implementation plus a blind Schnorr signature backend, selectable with `--auth-scheme` and negotiated over `/v1/attestation`. See [`auth-schemes.md`](./auth-schemes.md).
- CI coverage for outer crates, protocol Rust crates, integration tests, Foundry, and Scarb.

## Remaining Gaps

### Runtime Prover Bridge

The live Rust request and withdrawal flows still serialize mock proof envelopes while the Cairo circuits remain the authoritative proving implementation. The next production milestone is replacing the mock envelope path with a prover bridge that emits real Cairo proofs for the same public inputs already exercised by the Rust and Cairo test suites. The `ClientProofMode::StwoScarb` / `ServerProofMode::StwoScarb` config variants already select the real prover; what remains is hardening the Scarb/Stwo runner and shipping it as the default in production deployments.

### On-chain Operator Slashing

Today a policy violation is handled off chain as a larger homomorphic charge bounded by `policyChargeCap`. A future extension lets a user (or watchtower) prove operator misbehavior on chain — e.g. signing two conflicting next-states for the same nullifier, or charging above the published cap — and slash the operator's bonded stake. This needs an operator bond in `ZkApiVault`, an equivocation/over-charge proof format, and a `slashOperator` settlement path. (User-side slashing for spend-token reuse already exists via the nullifier store + escape-hatch challenge.)

### Parallel Spending

The wallet serializes requests behind a per-note mutex and file lock, so a single note cannot have multiple requests in flight. A parallel-spending extension would shard a note into independent sub-balances (e.g. a small set of per-lane anchors/commitments under one deposit), letting a client fan out concurrent requests without contention while keeping each lane's nullifier chain and homomorphic refund intact. This touches the note-state representation, the proof statement (per-lane membership), and the server's nullifier accounting.

### Non-LLM Upstreams

The provider abstraction (`ApiProvider`) and the OpenAI/OpenResponses/Ollama compatibility shims are LLM-shaped today. The same authenticated-metered-request machinery applies to any gated HTTP API — web search, RPC/data oracles, paid REST endpoints. Generalizing means a content-type-agnostic request envelope (see below) plus provider adapters and charge metadata for non-chat responses.

### Rich Upstream Provider Envelope

The current app-layer daemon sends a structured `CoreRequest` payload through the protocol, and the protocol server supports either the deterministic echo provider or a single-URL HTTP proxy provider. If the deployment target requires transparent multi-endpoint upstream HTTP execution (a prerequisite for the non-LLM upstreams above), the protocol request envelope must grow beyond a plain payload string.

### Blind-signature Runtime Integration

`zkapi-auth` implements and tests the blind-signature credential scheme, and both daemons accept `--auth-scheme blind-signature`, but the HTTP request path is currently wired for `state-anchor`. Completing the alternate backend means adding the blind-issuance and presentation endpoints to `zkapi-serverd` and the corresponding client state to `zkapi-clientd`.

### Indexer Snapshot Client Routing

The indexer exposes a privacy-safe `/v1/tree/snapshot` endpoint (the whole leaf vector), from which a client can rebuild the tree and derive any sibling path locally without revealing which note it cares about. The bundled `zkapi-clientd` still fetches per-slot paths (`/v1/tree/notes/{id}/path`), which leaks the `note_id` to the untrusted indexer. Routing clientd through the snapshot endpoint (and removing the per-slot paths, or keeping them only for power users running their own indexer) closes that deanonymization vector.

### Production Hardening

- Publish server-root rotation through an automated operator workflow instead of manual `cast send`.
- Replace demo-token deployment with a real billing token and vault configuration.
- Add production observability around request latency, provider failures, root lag, and XMSS capacity.
- Wire the `/v1/attestation` hook to a real TEE backend (Nitro/TDX) so the report is platform-signed rather than plain JSON.

## Verification Baseline

- `cargo test --workspace --exclude zkapi-integration-tests`
- `cargo test -p zkapi-integration-tests --all-features -- --test-threads=1`
- `cargo test --manifest-path protocol/rust/Cargo.toml --workspace`
- `cd protocol/contracts && forge test -vvv`
- `cd protocol/cairo && scarb test`
