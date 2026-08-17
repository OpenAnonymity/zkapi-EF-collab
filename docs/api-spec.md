# HTTP API

## Local client daemon

Applications talk to the local wallet daemon. These routes do not expose proof
details to application code:

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI-compatible chat |
| POST | `/v1/responses` | OpenAI-compatible responses |
| GET | `/v1/models` | OpenAI-compatible model list |
| POST | `/api/chat` | Ollama-compatible chat |
| GET | `/health` | daemon and wallet status |
| GET | `/` or `/funding` | bundled chat and MetaMask funding UI |
| POST | `/wallet/withdraw` | prepare an idempotent `mutual` or `escape` withdrawal proof |
| POST | `/wallet/withdraw/confirm` | reconcile the prepared withdrawal with canonical vault state |

The withdrawal routes are also available under `/funding/api/withdraw` and
`/funding/api/withdraw/confirm`. Preparing either mode persists the proof and
blocks inference with `409 withdrawal_pending`. Confirmation archives the local
note only after the vault reports it closed; a pending escape instead returns
its challenge deadline while retaining the note secret for finalization.

Applications may send `X-ZkAPI-Session-Id` on the three inference routes. In
direct OpenRouter mode, the daemon binds the active ephemeral key to that ID,
allows same-ID calls to run in parallel, and returns `409
lease_session_conflict` for a different ID until the lease expires. Omitting the
header uses the compatibility ID `default`.

The CLI `request --path ... --json ...` operation invokes the same wallet flow
without running a long-lived local daemon.

## Private v2 protocol

The local wallet talks to `zkapi-serverd` through:

| Method | Path | Purpose |
|---|---|---|
| POST | `/v2/requests` | verify proof, execute provider, sign next state |
| POST | `/v2/openrouter/leases` | reserve one prompt-free lease and return a bounded runtime key once |
| GET | `/v2/openrouter/leases/{client_request_id}` | recover non-secret lease timing/status metadata |
| POST | `/v2/openrouter/leases/{client_request_id}` | retire a runtime key and finalize its reserved lease |
| POST | `/v2/withdraw/clearance` | sign a mutual-close nullifier |
| GET | `/v2/requests/{client_request_id}` | recover a finalized request |
| GET | `/v2/nullifiers/{nullifier}` | recover by nullifier |
| GET | `/v1/attestation` | deployment identity and public signing keys |

`POST /v2/requests` receives `ApiRequestV2`:

```json
{
  "client_request_id": "uuid",
  "payload": "canonical CoreRequest JSON",
  "payload_hash": "0x...",
  "public_inputs": {
    "protocol_version": 2,
    "chain_id": 1,
    "contract_address": "0x...",
    "active_root": "0x...",
    "state_signing_key_x": "0x...",
    "state_signing_key_y": "0x...",
    "request_time": 0,
    "solvency_bound": 1000000,
    "request_nullifier": "0x...",
    "authorization_tag": "0x...",
    "anonymous_commitment_x": "0x...",
    "anonymous_commitment_y": "0x..."
  },
  "proof": {"backend":"groth16_bn254","proof":"base64..."}
}
```

The server recomputes `payload_hash`, canonical request context, and
authorization tag before proof verification. A successful response contains
the provider response, charge, next anonymous commitment, next anchor, fresh
blind delta, and next Schnorr state signature.

The base64 proof decodes to exactly 256 bytes: `A.x, A.y, B.x.c0, B.x.c1,
B.y.c0, B.y.c1, C.x, C.y`, each as a canonical 32-byte big-endian BN254
base-field coordinate.

### Prompt-private OpenRouter lease

`POST /v2/openrouter/leases` receives the same `ApiRequestV2`, but its exact
payload is only:

```json
{"mode":"openrouter_ephemeral_lease","version":1}
```

Unknown fields are rejected, so a prompt cannot accidentally enter this
protocol message. After verifying the proof and reserving its nullifier, the
server creates an OpenRouter child key whose cumulative USD limit equals the
request proof's public `solvency_bound`. That bound must be at least the
deployment's minimum request charge cap, and the proof shows the private note
can cover it. Browser clients choose a coarse balance tier so they do not
reveal the note's exact balance. The key's `expires_at` equals the returned
UNIX expiry. A
successful `201` response contains `api_key`, `openrouter_api_base`,
`issued_at`, `expires_at`, `valid_for_seconds`, `settle_after`, and
`spending_limit_usd`, plus `key_source`. An OA-org lease also contains a
`verification` object with `verifier_url`, `station_id`,
`station_recently_attested`, `key_valid_till`, `station_signature`, and
`org_signature`. The client requires that URL to match its independently
configured OA verifier, requires the signed validity window to cover the whole
lease with at most 60 seconds of later-expiry skew, and submits the same
`/submit_key` payload as oa-chat before using the key. Signature encoding and
cryptographic validity are decided by that pinned verifier. The plaintext key
is returned once and is not persisted.

The client may send parallel title and completion calls plus follow-ups through
the same chat lease. There is no request-count or small token quota; the child
key's cumulative USD limit is the boundary. Calls sharing a key are linkable to
OpenRouter. At dollar-limit exhaustion, provider rejection, explicit close, or
expiry, the client posts a retirement. For a directly managed key, the server
disables the key, reads
aggregate `usage` through OpenRouter's Management API, converts USD to credits,
finalizes the original lease, and deletes the key. Expiry plus the configured
usage-propagation grace period remains a crash-recovery fallback. The existing
`GET /v2/requests/{client_request_id}` recovery response then supplies the
signed next state. Thus key issuance, multiple direct inference calls, usage
polling, and state recovery are several HTTP operations but one zkAPI request
and one nullifier. The lease-status GET never returns the plaintext key.

For `key_source = "oa_org"`, authenticated retirement asks the station to
disable the key immediately. Once provider usage is stable, the station signs
the measured aggregate usage, the org verifies and countersigns it, and zkAPI
finalizes the actual credit charge. The proof-bound spending limit remains a
hard maximum and is never substituted for unavailable measured usage.

This mode is disabled when server-side prompt policy is enabled: a server
cannot enforce a prompt policy while also being excluded from the prompt path.

## Indexer

The indexer currently exposes `/v1/tree/root`, `/v1/tree/next-note-id`,
`/v1/tree/notes/{id}/path`, and `/v1/tree/notes/{id}/zero-path`. These are
indexer API versions, not the proof-protocol version.
