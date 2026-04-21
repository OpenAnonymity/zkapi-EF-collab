# zkAPI API Specification

Concrete interfaces for the three zkAPI daemons plus the Rust SDK surface.
For protocol rationale see [`design-note.md`](./design-note.md). For
architecture see [`architecture.md`](./architecture.md).

## 1. Interface Map

| Surface                   | Transport           | Primary consumer        |
| ------------------------- | ------------------- | ----------------------- |
| `zkapi-clientd` HTTP API     | REST + JSON         | user apps, UI           |
| `zkapi-serverd` HTTP API   | REST + JSON         | `zkapi-clientd`            |
| `zkapi-indexerd` HTTP API  | REST + JSON         | `zkapi-clientd`, server    |
| Rust SDK (`zkapi-client`) | Rust crate          | `zkapi-clientd`, CLI       |
| `ApiProvider` trait       | Rust trait (server) | operator integrations   |
| `ZkApiVault` contract ABI | Solidity            | on-chain, MetaMask      |

## 2. `zkapi-clientd` HTTP API

Default bind: `127.0.0.1:11434`. All responses `application/json` unless
noted.

### 2.1 Health

| Method | Path                     | Description                 |
| ------ | ------------------------ | --------------------------- |
| GET    | `/health` / `/healthz`   | liveness check              |

Response: `{"status": "ok"}` with 200.

### 2.2 Core Request

| Method | Path         | Description                                   |
| ------ | ------------ | --------------------------------------------- |
| POST   | `/request`   | core opaque payload → authenticated dispatch  |

Request body:
```json
{
  "method": "POST",
  "path": "/v1/chat/completions",
  "headers": { "content-type": "application/json" },
  "body": { ... arbitrary JSON ... }
}
```

Response body:
```json
{
  "client_request_id": "uuid",
  "response_code": 200,
  "raw_payload": "<upstream response as string>",
  "payload": { ... parsed JSON if parseable ... },
  "charge_applied": 1,
  "next_anchor": "0x<felt>",
  "remaining_balance": 99
}
```

Error responses: see §6.

### 2.3 Compat Dialects

| Method | Path                     | Behavior                                             |
| ------ | ------------------------ | ---------------------------------------------------- |
| POST   | `/v1/chat/completions`   | OpenAI `ChatCompletion`; translates to `/request`    |
| POST   | `/v1/responses`          | OpenAI `Responses`; translates to `/request`         |
| POST   | `/api/chat`              | Ollama native chat; translates to `/request`         |
| GET    | `/v1/models`             | OpenAI-format model list                             |
| GET    | `/api/tags`              | Ollama-format model list                             |

Each compat endpoint translates between the public API shape and the opaque
`/request` envelope transparently. Bodies match the respective upstream API
specs.

### 2.4 Wallet Status

| Method | Path                           | Description                                 |
| ------ | ------------------------------ | ------------------------------------------- |
| GET    | `/status` / `/wallet/status`   | current credit + note state                 |
| POST   | `/wallet/recover`              | recover from crash (reads pending journal)  |

`/status` response:
```json
{
  "has_note": true,
  "pending_request": false,
  "funding_url": "/funding",
  "note": {
    "note_id": 7,
    "deposit_amount": 1000,
    "current_balance": 997,
    "expiry_ts": 1795000000,
    "is_genesis": false,
    "current_anchor": "0x<felt>",
    "current_commitment_x": "0x<felt>",
    "current_commitment_y": "0x<felt>"
  }
}
```

### 2.5 Deposit Lifecycle

| Method | Path                          | Description                                         |
| ------ | ----------------------------- | --------------------------------------------------- |
| POST   | `/deposit/prepare`            | generate secret + commitment + indexer snapshot     |
| POST   | `/deposit/confirm`            | activate note locally after on-chain confirmation   |

`/deposit/prepare` request: `{ "amount": 1000 }`.
Response:
```json
{
  "amount": 1000,
  "secret": "0x<felt>",
  "commitment": "0x<felt>",
  "next_note_id": 7,
  "active_root": "0x<felt>",
  "zero_path": ["0x<felt>", ...32 items...]
}
```

`/deposit/confirm` request:
```json
{
  "secret": "0x<felt>",
  "note_id": 7,
  "amount": 1000,
  "expiry_ts": 1795000000
}
```
Response: same shape as `/status`.

### 2.6 Funding UI

| Method | Path                                | Description                      |
| ------ | ----------------------------------- | -------------------------------- |
| GET    | `/` / `/funding`                    | funding page HTML                |
| GET    | `/funding/styles.css`               | stylesheet                       |
| GET    | `/funding/app.js`                   | client-side JS                   |
| GET    | `/funding/config`                   | page config (vault addr, chain)  |
| GET    | `/funding/api/status`               | alias of `/status`               |
| GET    | `/funding/api/demo`                 | rolled-up service/wallet overview|
| POST   | `/funding/api/deposit/prepare`      | alias of `/deposit/prepare`      |
| POST   | `/funding/api/deposit/confirm`      | alias of `/deposit/confirm`      |
| POST   | `/funding/api/request/preview`      | preview proof fields             |
| POST   | `/funding/api/request/submit`       | submit a request (debug flow)    |
| POST   | `/funding/api/recover`              | alias of `/wallet/recover`       |

## 3. `zkapi-serverd` HTTP API

Default bind: `0.0.0.0:3000` (in production, behind a TEE-terminated TLS
tunnel). Consumed by `zkapi-clientd`.

| Method | Path                                        | Description                                 |
| ------ | ------------------------------------------- | ------------------------------------------- |
| POST   | `/v1/requests`                              | submit authenticated request + ZK proof     |
| POST   | `/v1/withdraw/clearance`                    | request mutual-close clearance signature    |
| GET    | `/v1/requests/{client_request_id}`          | recover transcript by client request id     |
| GET    | `/v1/nullifiers/{nullifier_hex}`            | recover transcript by nullifier             |
| GET    | `/health`                                   | liveness                                    |
| GET    | `/v1/attestation`                           | attestation metadata (TEE hook)             |

### 3.1 POST /v1/requests

Request body: `ApiRequest` (see `zkapi-types::wire`):
```json
{
  "client_request_id": "uuid",
  "payload": "<opaque string>",
  "payload_hash": "0x<felt>",
  "public_inputs": { /* RequestPublicInputs */ },
  "proof_envelope": "<base64>"
}
```

Response: `RequestResponse`:
```json
{
  "status": "ok",
  "client_request_id": "uuid",
  "request_nullifier": "0x<felt>",
  "response_code": 200,
  "response_payload": "<upstream response>",
  "response_hash": "0x<felt>",
  "charge_applied": 1,
  "next_commitment": { "x": "0x<felt>", "y": "0x<felt>" },
  "next_anchor": "0x<felt>",
  "blind_delta_srv": "0x<felt>",
  "next_state_sig": { "epoch": 1, "leaf_index": 17, "wots_sig": [...], "auth_path": [...] },
  "policy_reason_code": null,
  "policy_evidence_hash": null
}
```

### 3.2 POST /v1/withdraw/clearance

Request: `{ "withdrawal_nullifier": "0x<felt>" }`.
Response:
```json
{
  "clear_sig": { "epoch": 1, "leaf_index": 3, "wots_sig": [...], "auth_path": [...] },
  "clear_sig_epoch": 1,
  "clear_sig_root": "0x<felt>"
}
```

### 3.3 Recovery Endpoints

Either endpoint returns:
```json
{
  "nullifier_status": "Reserved|Finalized|ClearanceReserved|NotFound",
  "request_response": { /* RequestResponse or null */ }
}
```

## 4. `zkapi-indexerd` HTTP API

Default bind: `0.0.0.0:3001`. Read-only.

| Method | Path                                       | Description                         |
| ------ | ------------------------------------------ | ----------------------------------- |
| GET    | `/v1/tree/root`                            | current Merkle root                 |
| GET    | `/v1/tree/next-note-id`                    | next empty slot index               |
| GET    | `/v1/tree/notes/{note_id}/path`            | sibling path for an existing note   |
| GET    | `/v1/tree/notes/{note_id}/zero-path`       | sibling path for a zero leaf at slot|

Responses:
```json
{ "root": "0x<felt>" }
{ "next_note_id": 7 }
{ "note_id": 7, "leaf": "0x<felt>", "siblings": [..32 felts..] }
```

## 5. Rust SDK: `zkapi-client::Wallet`

Canonical client-side interface. All credit-state changes go through these
methods.

### 5.1 Constructor

```rust
Wallet::new(config: ClientConfig) -> Result<Self, ClientError>
```

Loads existing state from `<state_dir>/note_state.json` if present.

### 5.2 Issuance

```rust
Wallet::generate_deposit_params(&self) -> (Felt252, Felt252)
// returns (secret, registration_commitment)

Wallet::confirm_deposit(
    &mut self,
    secret: Felt252,
    note_id: u32,
    amount: u128,
    expiry_ts: u64,
) -> Result<(), ClientError>
```

### 5.3 Authentication

```rust
Wallet::request_flow(
    &mut self,
    payload: &str,
    payload_hash: Felt252,
    active_root: Felt252,
    merkle_siblings: Vec<Felt252>,
) -> Result<RequestResponse, ClientError>  // async
```

Preconditions:
- `confirm_deposit` has run.
- No pending journal (or call `recover` first).
- `active_root` and `merkle_siblings` fetched fresh from indexer.
- `payload_hash` computed via `zkapi_core::compute_payload_hash(payload.as_bytes())`.

### 5.4 Refund / Withdrawal

```rust
Wallet::withdrawal_mutual_close(
    &mut self,
    destination: [u8; 20],
    active_root: Felt252,
    merkle_siblings: Vec<Felt252>,
) -> Result<(WithdrawalPublicInputs, Vec<u8>), ClientError>  // async

Wallet::withdrawal_escape_hatch(
    &self,
    destination: [u8; 20],
    active_root: Felt252,
    merkle_siblings: Vec<Felt252>,
) -> Result<(WithdrawalPublicInputs, Vec<u8>), ClientError>  // sync
```

Both return `(public_inputs, proof_bytes)` ready for on-chain submission.

### 5.5 Recovery and Status

```rust
Wallet::recover(&mut self) -> Result<Option<RequestResponse>, ClientError>  // async
Wallet::state(&self) -> Option<&NoteState>
Wallet::has_pending_request(&self) -> bool
```

### 5.6 ClientConfig

```rust
pub struct ClientConfig {
    pub protocol_version: u16,
    pub chain_id: u64,
    pub contract_address: Felt252,
    pub request_charge_cap: u128,
    pub policy_charge_cap: u128,
    pub policy_enabled: bool,
    pub server_url: String,
    pub state_dir: String,
}
```

## 6. `ApiProvider` Trait (Server-Side)

The pluggable interface operators implement to expose a metered API through
the zkAPI authentication layer.

```rust
#[async_trait]
pub trait ApiProvider: Send + Sync {
    async fn execute(
        &self,
        client_request_id: &str,
        payload: &str,
        payload_hash: &Felt252,
    ) -> Result<ProviderResponse, ServerError>;
}

pub struct ProviderResponse {
    pub status_code: u16,
    pub payload: String,
    pub response_hash: Felt252,
    pub charge_applied: u128,
    pub policy_reason_code: Option<u32>,
    pub policy_evidence_hash: Option<Felt252>,
}
```

Existing implementations: `EchoProvider` (test), `HttpProxyProvider` (forwards
to any URL — used for Ollama, OpenAI, or any HTTP backend).

## 7. Wire Types (`zkapi-types::wire`)

All JSON over HTTP on the server surface. Types:

- `ApiRequest` — the inbound request envelope (see §3.1).
- `RequestResponse` — outbound response (§3.1).
- `ClearanceRequest` / `ClearanceResponse` — mutual-close clearance (§3.2).
- `RecoveryResponse` — recovery (§3.3).
- `ErrorResponse`:
  ```json
  {
    "error_code": "STALE_ROOT",
    "message": "latest root is ...",
    "latest_root": "0x<felt>"
  }
  ```

## 8. Error Codes

Server-side (`zkapi-serverd`):

| Code                | HTTP | Meaning                                    |
| ------------------- | ---- | ------------------------------------------ |
| `INVALID_PROOF`     | 400  | proof envelope fails verification          |
| `INVALID_REQUEST`   | 400  | malformed request                          |
| `PROTOCOL_MISMATCH` | 400  | version/chain/contract mismatch            |
| `STALE_ROOT`        | 409  | active_root doesn't match server's current |
| `REPLAY`            | 409  | nullifier already seen                     |
| `NULLIFIER_USED`    | 409  | withdrawal nullifier already consumed      |
| `NOTE_EXPIRED`      | 410  | expiry_ts passed                           |
| `CAPACITY_EXHAUSTED`| 500  | XMSS capacity exhausted for epoch          |
| `DATABASE_ERROR`    | 500  | SQLite failure                             |
| `INTERNAL`          | 500  | unspecified                                |

Auth-daemon-specific (`zkapi-clientd`):

| Code             | HTTP | Meaning                                    |
| ---------------- | ---- | ------------------------------------------ |
| `NO_ACTIVE_NOTE` | 402  | no note; visit `/funding`                  |
| `WALLET_BUSY`    | 429  | another request is holding the wallet lock |
| `INVALID_INPUT`  | 400  | input failed validation                    |
| `WALLET`         | 500  | wallet-layer error                         |
| `SERIALIZATION`  | 500  | JSON shape error                           |

## 9. Contract ABI Summary

All methods in `protocol/contracts/src/ZkApiVault.sol`:

| Method                                                                                   | Access            |
| ---------------------------------------------------------------------------------------- | ----------------- |
| `deposit(bytes32 commitment, uint128 amount, uint256[32] siblings)`                       | public            |
| `mutualClose(WithdrawalPublicInputs inputs, bytes proofEnvelope)`                         | public            |
| `initiateEscapeWithdrawal(WithdrawalPublicInputs inputs, bytes proofEnvelope)`            | public            |
| `challengeEscapeWithdrawal(uint32 noteId, RequestPublicInputs inputs, bytes proofEnv)`    | public            |
| `finalizeEscapeWithdrawal(uint32 noteId, address destination, uint128 finalBalance)`      | public            |
| `claimExpired(uint32 noteId, uint256[32] siblings)`                                       | treasury          |
| `rotateServerRoots(uint32 epoch, bytes32 stateSigRoot, bytes32 clearSigRoot)`             | owner             |
| `setProofAdapter(address newAdapter)`                                                     | owner             |
| `setTreasury(address newTreasury)`                                                        | owner             |
| `setPaused(bool flag)`                                                                    | owner             |

## 10. Stability Notes

- **SemVer expectation:** all HTTP response fields marked required are stable
  within a major release. Adding fields is non-breaking; removing or
  renaming is breaking.
- **Wire types:** `zkapi-types::wire` types are `#[serde(deny_unknown_fields
  = false)]` on the server side (tolerant), strict on the client parser.
- **Protocol version:** any change to public inputs, domain tags, or
  primitive parameters bumps `PROTOCOL_VERSION`. The contract enforces match
  at settlement time.
