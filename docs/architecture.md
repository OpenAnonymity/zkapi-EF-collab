# zkAPI Architecture

This document describes the zkAPI system at two levels: **context** (what it
is and who interacts with it) and **container** (what processes run and how
they talk). For protocol-level details, see
[`protocol/PROTOCOL.md`](../protocol/PROTOCOL.md) and
[`protocol/SPEC.md`](../protocol/SPEC.md). For concrete APIs, see
[`api-spec.md`](./api-spec.md).

## 1. Context

zkAPI is an anonymous authentication and payment layer for gated APIs. A user
deposits tokens on chain once, receives off-chain credits, and then makes
unlinkable authenticated requests. The server authenticates each request via a
zero-knowledge proof, deducts a variable charge, and signs a fresh state for
the client. Net settlement happens at withdrawal.

The system has two distinct planes:

- **On-chain plane** — Ethereum (ZkApiVault contract). Touched twice per note:
  once to deposit, once to withdraw. Not involved in regular requests.
- **Off-chain plane** — the three daemons (zkapi-clientd, zkapi-serverdd,
  zkapi-indexerdd) plus the upstream API. This is the request hot path.

```
              OFF-CHAIN REQUEST PATH (every request)
              ========================================
   +---------+       HTTP        +-------------+
   |  User   | ================> |  zkapi-clientd | (local daemon,
   | (curl,  | <================ |             |  holds wallet state)
   |  agent) |                   +------+------+
   +---------+                          |
                                        | HTTP (proof + payload)
                                        v
                                 +------+------+       +---------+
                                 | zkapi-serverdd| ====> | Upstream|
                                 |   (in TEE)  | <==== |   API   |
                                 +------+------+       |(LLM etc)|
                                        ^              +---------+
                                        | HTTP (fresh root + siblings)
                                        |
                                 +------+------+
                                 | zkapi-indexerdd|
                                 +------+------+
                                        ^
                                        | JSON-RPC eth_getLogs
                                        |
              ON-CHAIN SETTLEMENT (once per note lifecycle)
              ============================================
                                        |
              +---------+  deposit(C,D)  |
              | User's  | -------------> v
              | wallet  |           +----+---------------------+
              |(MetaMask| <-------- | Ethereum (ZkApiVault)    |
              | / cast) |  withdraw |  - Merkle root           |
              +---------+           |  - escrowed tokens       |
                                    |  - pending withdrawals   |
                                    |  - XMSS public roots     |
                                    +--------------------------+
```

Read the top half as the **request path** (happens every time the user
sends an API request). Read the bottom half as the **settlement path**
(happens once at deposit, once at withdrawal). The only link between the
two planes is the indexer, which watches the chain and gives the server +
user a fresh Merkle root so off-chain proofs stay consistent with on-chain
state.

Actors and trust boundaries:

| Actor                | Trusted by     | Responsibilities                                        |
| -------------------- | -------------- | ------------------------------------------------------- |
| **User**             | itself only    | holds the secret `s`, drives requests via local daemon  |
| **zkapi-clientd**       | the user       | generates proofs, maintains off-chain credit state      |
| **zkapi-serverdd**     | nobody         | verifies proofs, charges, signs next state              |
| **zkapi-indexerdd**    | nobody         | watches chain, serves Merkle siblings                   |
| **ZkApiVault**       | everyone       | neutral arbiter for deposit, settlement, escape hatch   |
| **Upstream API**     | separate       | does the actual work being paid for                     |

The server is the main adversary in the threat model. The protocol's
unlinkability, replay resistance, and settlement integrity must all survive a
malicious server. See [`design-note.md`](./design-note.md) for the full threat
model.

## 2. Containers

Five runnable processes plus one smart contract.

### 2.1 `zkapi-clientd` — local user daemon

Lives in `ef-collaboration/crates/zkapi-clientd`. Built on Axum. Default port
`127.0.0.1:11434` (Ollama-compatible). Wraps the protocol `Wallet` under a
`tokio::sync::Mutex` and a cross-process `fs2` file lock. Speaks four API
dialects: opaque `/request`, OpenAI `/v1/chat/completions`, OpenResponses
`/v1/responses`, Ollama `/api/chat`. Serves the funding UI at `/funding`.

Input: HTTP from user apps.
Output: HTTP to `zkapi-serverd` (requests) and `zkapi-indexerd` (tree data).
State: `<state_dir>/note_state.json` and `<state_dir>/pending_journal.json`.

### 2.2 `zkapi-serverd` — operator daemon

Lives in `crates/zkapi-serverd`. Built on Axum. Default port
`:3000`. Holds two XMSS keypairs (state-signing and clearance-signing).
SQLite-backed nullifier store. Calls a pluggable `ApiProvider` to execute
upstream API requests. Background task polls the indexer for fresh Merkle
roots.

Runs in a TEE / confidential container in production; standalone for the demo.

Input: HTTP from `zkapi-clientd`.
Output: HTTP to upstream API (via `HttpProxyProvider`).
State: SQLite DB (nullifiers + transcripts), XMSS signer indices.

### 2.3 `zkapi-indexerd` — chain watcher

Lives in `crates/zkapi-indexerd`. Built on Axum. Default port
`:3001`. Polls the Ethereum chain via JSON-RPC `eth_getLogs`, parses
`NoteDeposited` / `MutualClose` / `EscapeWithdrawalInitiated` / ... events,
and mirrors the active-note Merkle tree in memory. Serves tree root, next
note ID, and sibling paths.

Untrusted: returning wrong siblings only causes proof rejection, not fund loss.

Input: Ethereum JSON-RPC.
Output: HTTP to `zkapi-clientd` and `zkapi-serverd`.
State: in-memory Merkle tree + persisted last-processed-block cursor.

### 2.4 `zkapi-cli` — operator / developer CLI

Lives in `ef-collaboration/crates/zkapi-cli`. Thin command wrapper that can
launch the auth daemon, the server, or the indexer, and run wallet operations
(keygen, prepare-deposit, confirm-deposit, request, withdraw, recover).

### 2.5 `ZkApiVault` — Solidity contract

Lives in `protocol/contracts/src/ZkApiVault.sol`. Stores:
- `currentRoot` — active-note Merkle root
- per-note data: commitment, deposit, expiry, status
- pending-withdrawal data during escape-hatch
- XMSS public roots per epoch
- operator treasury address
- the proof adapter address (pluggable verifier)

Methods: `deposit`, `mutualClose`, `initiateEscapeWithdrawal`,
`challengeEscapeWithdrawal`, `finalizeEscapeWithdrawal`, `claimExpired`,
`rotateServerRoots`.

## 3. Module / Crate Dependencies

Protocol layer (black box, from `curryrasul/zkAPI`):

```
zkapi-types  ← shared types, wire formats, constants
zkapi-core   ← Poseidon, Merkle, nullifier, leaf, commitment, payload_hash
zkapi-crypto ← Pedersen, XMSS, WOTS+
zkapi-proof  ← RequestProofBuilder, WithdrawalProofBuilder, verifiers
zkapi-client ← Wallet (state machine) + NoteState + journal
zkapi-serverdd ← RequestProcessor + NullifierStore + ServerSigner + ApiProvider
zkapi-indexerdd ← TreeMirror + poller + http service
```

Application layer (this repo):

```
zkapi-clientd               ← depends on zkapi-client, zkapi-core, zkapi-types
zkapi-cli                ← depends on zkapi-clientd, zkapi-serverdd, zkapi-client
zkapi-integration-tests  ← depends on the whole stack
```

Dependency direction is strictly downward: application layer → protocol layer.
The protocol layer never depends on our code.

## 4. Key Flows

Deposit, request, and withdrawal flows are described in detail in
[`design-note.md`](./design-note.md) §4. At the architecture level:

- **Deposit**: user → `zkapi-clientd.prepare_deposit` → indexer for siblings →
  on-chain `vault.deposit` → indexer sees event → user runs
  `confirm_deposit`.
- **Request**: user → `zkapi-clientd` → fetch root+siblings from indexer →
  `Wallet::request_flow` builds proof → HTTP to `zkapi-serverd` →
  `RequestProcessor.process_request` → `ApiProvider.execute` → sign next
  state → response → auth daemon updates wallet.
- **Withdrawal**: either (a) mutual close through `zkapi-serverd` for instant
  settlement, or (b) escape hatch on chain with 24-hour challenge window.

## 5. Deployment Topology

For the demo (`docker-compose --profile dev`):

```
anvil        :8545    local Ethereum
zkapi-indexerdd :3001   mirrors anvil's chain
zkapi-serverdd  :3000   EchoProvider or HttpProxyProvider→ollama
zkapi-clientd    :11434  user-facing
ollama       :11434    optional upstream (on a different host/port)
```

For production:

- `zkapi-serverd` runs in a TEE (Nitro Enclaves, Intel TDX, AMD SEV-SNP, etc.)
  with `/v1/attestation` exposed as the hook point for attestation clients.
- `zkapi-indexerd` runs anywhere; operators and power users can run their own.
- `zkapi-clientd` runs locally on the user's machine.
- `ZkApiVault` deploys once per chain; operators register their XMSS roots via
  `rotateServerRoots`.

See [`deployment.md`](./deployment.md) for ops details.

## 6. Architectural Invariants

These must hold at runtime:

1. **Wallet access is serialized.** At most one mutation in flight per wallet.
   Enforced by `tokio::sync::Mutex` + `fs2` file lock in `zkapi-clientd`.
2. **Nullifiers are globally unique per server.** Enforced by SQLite unique
   constraint and transactional `reserve` in `zkapi-serverd`.
3. **XMSS leaf indices never repeat.** Enforced by signing Mutex around the
   predict→compute→sign sequence in `RequestProcessor`.
4. **The Merkle root the server validates against is consistent with the
   chain.** Enforced by the indexer polling the chain and the server polling
   the indexer; bounded staleness is observable and causes `STALE_ROOT` on
   mismatch, followed by client retry.
5. **User secrets never cross a process boundary.** Enforced by keeping `s`
   only in local `NoteState` on the user's machine.
6. **Downstream crypto primitives are trusted.** We rely on the correctness
   of the `protocol/` submodule (Poseidon, Pedersen, XMSS, Merkle tree,
   proof system). Bugs there are out of scope for the application layer.

## 7. Extension Points

Existing:

| Extension point                | Location                                              |
| ------------------------------ | ----------------------------------------------------- |
| Upstream API backend           | `zkapi-serverdd::ApiProvider` trait (`provider.rs`)     |
| Proof verifier                 | `contracts/src/interfaces/IZkApiProofAdapter.sol`     |
| API compatibility shim         | `zkapi-clientd::compat` (OpenAI, OpenResponses, Ollama)  |

Absent but desirable (see [`roadmap.md`](./roadmap.md)):

- Credential scheme abstraction (for alternate backends like RLN, ARC)
- TEE attestation backends (Nitro, TDX, SGX, SEV-SNP)
- Real Cairo prover runtime bridge in the Rust stack
