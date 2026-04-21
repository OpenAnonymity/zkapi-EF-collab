# zkAPI Grant — Deliverables Status

Snapshot of every deliverable in both milestones, with concrete evidence
and an honest statement of gaps. Intended as a grant-reporting document.

## Summary

| Milestone | Status |
| --------- | ------ |
| M1 Interfaces, Design Note & Cryptography Module | 6 of 7 fully delivered; 1 partial (alternate-backend extension points). |
| M2 Client Daemon, Server Daemon & End-to-End Demo | 5 of 9 fully delivered; 4 partial (funding-page MetaMask flow, TEE attestation integration, slashing path in the E2E demo, roadmap depth). |

Test totals across the full stack:

- 115 Rust tests passing in the `protocol/` workspace (crypto, proof, client, server, indexer).
- 13 tests passing in the `ef-collaboration/` workspace (auth daemon, CLI).
- 7 integration tests covering the full wallet-to-server flow.
- 68 Solidity tests passing (`forge test`).
- Cairo circuit tests passing (`scarb test`).

---

## Milestone 1

### M1.1 Finalized architecture and standard interfaces for all three modules — ✅

Delivered:

- Three modules split cleanly into crates: crypto library
  (`zkapi-types`, `zkapi-core`, `zkapi-crypto`, `zkapi-proof`), client
  daemon (`zkapi-clientd` wrapping `zkapi-client`), server daemon
  (`zkapi-serverd`). Plus settlement contract (`ZkApiVault.sol`) and chain
  indexer (`zkapi-indexerd`).
- Architecture doc: `docs/architecture.md` (C4 context + container view,
  trust boundaries, deployment topology, dependency graph).
- API spec: `docs/api-spec.md` (HTTP surfaces + Rust SDK).
- Machine-readable spec: `docs/openapi.yaml` (OpenAPI 3.0.3, 34 endpoints,
  35 schemas, valid per `swagger-cli`).

Gaps: none.

### M1.2 Technical design note — ✅

Delivered: `docs/design-note.md` covering threat model, issuance,
authentication, refunds, and slashing. Slashing section documents the
present escape-hatch challenge rule and sketches three future slashing
hook directions (double-spend algebraic slashing, operator-misbehavior
slashing with bond, burn-only policy slashing).

Gaps: none.

### M1.3 Stable methods-level spec for implementation — ✅

Delivered:

- `protocol/SPEC.md` — normative implementation spec (~1100 lines).
- `docs/api-spec.md` — method signatures, preconditions, error codes.
- `docs/openapi.yaml` — machine-readable HTTP spec.

Public interfaces: `Wallet` (5 methods), `RequestProcessor` (2 methods),
`ApiProvider` async trait, wire types, `ZkApiVault` contract ABI (7
methods plus owner-only config setters).

Gaps: none.

### M1.4 Open-source cryptography library — ✅ with caveat

Delivered:

- Poseidon over Stark field with 16 domain tags.
- Merkle tree, depth 32.
- Nullifier, note-leaf, registration-commitment, state/clearance message,
  next-anchor, blind-delta, and payload-hash helpers.
- Pedersen commitment on the Stark curve with independent generators,
  supporting commit/verify, rerandomization, and homomorphic update.
- XMSS (tree height 20) and WOTS+ (w=16, 65 chains).
- Cairo STARK circuits for request and withdrawal proofs.
- 54 passing unit tests across `zkapi-core` (20), `zkapi-crypto` (14),
  `zkapi-proof` (20). Cairo circuits pass `scarb test`.
- Dual-licensed MIT OR Apache-2.0.

Caveat: the Rust stack uses a mock proof envelope (JSON witness +
constraint replay) for end-to-end tests. The Cairo circuits are real; the
runtime Cairo↔Rust prover bridge is not part of M1. This is an explicit
scope decision documented in `design-note.md` §7.

### M1.5 Thin standard interface for issuance, authentication, refund — ✅

Delivered, as four Rust SDK methods:

- `confirm_deposit(secret, note_id, amount, expiry_ts)` — issuance
- `request_flow(payload, payload_hash, active_root, merkle_siblings)` —
  authentication
- `withdrawal_mutual_close(destination, active_root, merkle_siblings)` —
  refund (happy path)
- `withdrawal_escape_hatch(destination, active_root, merkle_siblings)` —
  refund (unilateral)

HTTP surfaces for all three daemons in `docs/openapi.yaml`.

Gaps: none.

### M1.6 Reference backend with unlinkability and variable-size refunds — ✅

Delivered: the state-anchor chain backend.

Unlinkability: nullifier `Poseidon("zkapi.null", s, τ)` with server-issued
fresh `τ` per response; Pedersen commitment rerandomized by both client
and server on every request; public inputs exclude the user's secret,
note ID, plaintext balance, blinding, and previous anchor.

Variable-size refund: per-request `charge_applied` is arbitrary up to a
configured cap; homomorphic deduction updates the commitment with the
exact charge, not the cap; unused balance accumulates inside the
commitment; net settlement at withdrawal.

Tests: `pedersen::test_rerandomization`,
`pedersen::test_server_update_algebra`,
`commitment::test_next_anchor_not_trivial`,
`http_wallet::wallet_request_flow_updates_note_state_against_live_server`
(verifies balance decreases by exactly the charge amount).

Gaps: none.

### M1.7 Extension points for alternate backends (RLN, ARC) — ⚠️ Partial

Delivered:

- Documented rationale in `protocol/PROTOCOL.md` for why state-anchor
  chain replaces the original RLN-based design.
- Roadmap entry flagging RLN and ARC as future backends
  (`docs/roadmap.md`).

Not delivered:

- A `CredentialScheme` trait abstracting per-request nullifier derivation,
  proof generation, and verification. The reference state-anchor chain is
  currently hard-wired in `zkapi-proof`, `zkapi-client::Wallet`, and
  `zkapi-serverdd::RequestProcessor`.
- Stub implementations for RLN and ARC.

Plan: introduce the trait with associated types for `ClientState`,
request and withdrawal public inputs, and proof envelope. Move the
existing code behind a `StateAnchorChain` impl. Write a short doc
(`docs/backends.md`) sketching how RLN and ARC would fit. Estimated 4–6
days of focused work. This is the one remaining M1 item.

---

## Milestone 2

### M2.1 Ollama/OpenResponses-compatible local daemon — ✅

Delivered: `zkapi-clientd` daemon exposing

- `POST /v1/chat/completions` — OpenAI-compatible chat
- `POST /v1/responses` — OpenAI Responses API
- `POST /api/chat` — Ollama-native chat
- `GET /v1/models` — OpenAI-format model listing
- `GET /api/tags` — Ollama-format model listing

Plus the opaque core endpoint `POST /request` for API-agnostic use.
Format translation lives in `crates/zkapi-clientd/src/compat.rs` with unit
tests for passthrough and synthesis shapes.

Default port `127.0.0.1:11434` (Ollama's default) so existing clients
work without configuration changes.

Gaps: none.

### M2.2 Local credit-state management and proof generation — ✅

Delivered:

- `NoteState` persisted to `<state_dir>/note_state.json`.
- `PendingRequestJournal` for crash recovery at
  `<state_dir>/pending_journal.json`.
- Serialization via `tokio::sync::Mutex` (in-process) and `fs2::FileExt`
  exclusive lock (cross-process).
- Stale-root auto-retry with fresh indexer fetch (up to 2 attempts).
- Proof generation via `RequestProofBuilder` (mock envelope).

Tested by `service::tests::status_fails_when_lockfile_is_held_elsewhere`
(cross-process locking), `service::tests::payload_hash_is_stable`
(payload hash correctness), and the `http_wallet` integration suite.

Gaps: none.

### M2.3 Localhost funding page — ⚠️ Partial

Delivered:

- HTML/CSS/JS funding page served at `/funding` by the auth daemon.
- Three-step flow: generate commitment → run deposit commands → confirm
  note locally.
- OA design language (soft green-gray background, Fira Code body, EB
  Garamond headings, centered 640px column).
- Backend endpoints wired: `/funding/api/deposit/prepare`,
  `/funding/api/deposit/confirm`, `/funding/config`,
  `/funding/api/demo`.

Not delivered:

- No MetaMask / ethers.js one-click flow. The page currently generates
  `cast send` shell commands the user runs in a terminal. Functional but
  not the smoothest UX.
- The vault uses ERC20 tokens (deployed as `ERC20Mock` in the demo), not
  native ETH. The proposal said "ETH deposit"; our implementation is
  token-agnostic with a configurable billing token.

Plan: add ethers.js integration that calls `token.approve` and
`vault.deposit` directly from the page, parses the `NoteDeposited` event
from the tx receipt, and auto-submits the confirmation. 1–2 days.

### M2.4 End-to-end flow forwarding requests plus proofs — ✅

Delivered: `zkapi-clientd::execute_request` path. Incoming compat request is
translated to an opaque payload, `payload_hash` is computed via the spec
helper, fresh `active_root` and `merkle_siblings` are fetched from the
indexer, `Wallet::request_flow` builds the proof and POSTs to
`zkapi-serverd`, response is verified and translated back to the
requesting dialect.

Tested end-to-end via the `http_wallet` integration suite. The
`execute_request_round_trips_through_protocol_server` unit test is
marked `#[ignore]` due to proof generation cost — a known testing gap
flagged in `design-note.md`.

Gaps: none in functionality. Testing gap: the ignored slow test should
be unignored or replaced by a faster equivalent so CI covers this path.

### M2.5 Server daemon (verification, spending, refund) — ✅

Delivered: `zkapi-serverd`.

- Proof verification (mock envelope — consistent with M1.4 scope).
- SQLite nullifier store with `response_payload` persistence for
  recovery.
- Cap enforcement on `charge_applied` before signing the next state.
- Homomorphic balance update via `PedersenCommitment::server_update`.
- XMSS signing of the next state message, guarded by a Mutex around the
  predict-compute-sign sequence (fix for the signer race condition).
- Provider selection via `ApiProvider` trait with two implementations.
- Background root-polling from the indexer to keep the accepted
  `active_root` in sync with chain state.
- Health and attestation endpoints.

MIT/Apache dual-licensed.

Gaps: none.

### M2.6 Thin integration interface for arbitrary gated API backends — ✅

Delivered: `ApiProvider` async trait in `zkapi-serverdd::provider`.

Two implementations:

- `EchoProvider` — deterministic test provider.
- `HttpProxyProvider` — forwards any payload to any upstream HTTP URL.
  Works with Ollama, OpenAI, web search APIs, Ethereum RPC, or any other
  HTTP backend.

Selection is configurable via `ServerConfig::provider_kind` and the CLI
flags `--provider {echo,http-proxy}`, `--upstream-url <URL>`,
`--flat-charge <u128>`.

Gaps: none.

### M2.7 Containerized deployment with TEE attestation hooks — ⚠️ Partial

Delivered:

- Multi-stage Dockerfile (`docker/Dockerfile`) producing `zkapi-cli` and
  `zkapi-clientd` binaries on `debian:bookworm-slim`.
- Production compose (`docker/docker-compose.yml`) with server, indexer,
  auth daemon.
- Dev compose (`docker/docker-compose.dev.yml`) adding Anvil and Ollama
  profiles for local development.
- `docker/tee/attestation-hook.sh` reference script template.
- `GET /health` and `GET /v1/attestation` endpoints on the server. The
  attestation endpoint returns binary hash, config hash, and XMSS roots;
  the `platform` field is null when not running in a TEE.

Not delivered:

- No real TEE integration. The attestation endpoint does not embed a
  platform-signed report (Nitro, TDX, SGX, SEV-SNP). The hook script is
  a template, not a working integration with any attestation client.

Plan: deliver one reference integration (likely AWS Nitro Enclaves, the
lowest-friction option) as a follow-on PR. 2–3 days. For the current
milestone, the hook point is in place; operators deploying to TEE can
plug in their platform's attestation client.

### M2.8 Full end-to-end demo — ⚠️ Partial

Delivered: `scripts/e2e-demo.sh` (298 lines). Sequence:

1. Start Anvil.
2. Deploy `ZkApiVault` + `ERC20Mock` via Foundry script.
3. Start indexer, server, auth daemon.
4. `zkapi keygen` → generate secret + commitment.
5. On-chain deposit via `cast send`.
6. `zkapi confirm-deposit` → activate note locally.
7. Send three requests through the auth daemon (balance decreases each
   time).
8. `zkapi withdraw` → mutual-close withdrawal.
9. Verify on-chain settlement: user receives `B_final`, treasury
   receives `D − B_final`.

Not delivered:

- The escape-hatch / slashing path is implemented in the contract and
  the wallet but is not demonstrated in the E2E script. A client
  walking this path (server refuses clearance → user escapes → server
  challenges with prior transcript → contract rejects stale withdrawal)
  would exercise the full trust model.
- The demo uses ERC20Mock, not native ETH, as noted in M2.3.

Plan: extend the demo script with a second scenario: server refuses
clearance → user initiates escape → after 24h (via `evm_increaseTime`),
user finalizes and receives funds. Also add a negative-case scenario
where the server successfully challenges a stale withdrawal. 1 day.

### M2.9 Final documentation and roadmap — ⚠️ Partial

Delivered:

- `docs/deployment.md` (86 lines) — operational guide covering contract
  deployment, server/indexer startup, Docker, TEE considerations, XMSS
  capacity planning.
- `docs/roadmap.md` — 33 lines. Lists future directions.
- `docs/architecture.md`, `docs/design-note.md`, `docs/api-spec.md`,
  `docs/openapi.yaml`, `docs/milestone-1.md` — the M1 document set.

Not delivered:

- The roadmap is too thin (33 lines). A grant-quality roadmap should
  cover in depth: stronger slashing (additive homomorphic operations,
  operator bonds, burn-only policy slashing), parallel child-anchor
  spending, real Cairo prover runtime bridge, follow-on API targets
  (web search, Ethereum RPC, generic metered HTTP), alternate crypto
  backends (RLN, ARC), multi-token vault support, note renewal.

Plan: expand `docs/roadmap.md` to a 200–300 line document with one
section per direction, each estimating scope and dependencies. Half a
day.

---

## Summary of Remaining Work

Five concrete remaining items to close both milestones fully:

1. **M1.7 — Alternate-backend trait.** Introduce `CredentialScheme`
   trait and move the state-anchor chain behind it. Sketch RLN and ARC
   impls in docs. ~1 week.
2. **M2.3 — MetaMask funding flow.** Add ethers.js direct-deposit path
   to the funding page. ~1–2 days.
3. **M2.7 — Reference TEE attestation.** Wire one real attestation
   backend (recommend Nitro Enclaves). ~2–3 days.
4. **M2.8 — Slashing scenarios in E2E.** Extend demo script to exercise
   escape-hatch and challenge paths. ~1 day.
5. **M2.9 — Roadmap expansion.** Flesh out `docs/roadmap.md`. Half a
   day.

Total remaining: approximately 2 focused weeks of work to close every
gap. Everything else is delivered.
