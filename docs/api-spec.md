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
| GET | `/funding` | bundled testnet funding UI |

The CLI `request --path ... --json ...` operation invokes the same wallet flow
without running a long-lived local daemon.

## Private v2 protocol

The local wallet talks to `zkapi-serverd` through:

| Method | Path | Purpose |
|---|---|---|
| POST | `/v2/requests` | verify proof, execute provider, sign next state |
| POST | `/v2/openrouter/leases` | reserve one prompt-free request and return a bounded runtime key once |
| GET | `/v2/openrouter/leases/{client_request_id}` | recover non-secret lease timing/status metadata |
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
    "chain_id": 11155111,
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
server creates an OpenRouter child key whose USD limit equals the deployment's
request charge cap and whose `expires_at` equals the returned UNIX expiry. A
successful `201` response contains `api_key`, `openrouter_api_base`,
`issued_at`, `expires_at`, `valid_for_seconds`, `settle_after`, and
`spending_limit_usd`, plus `key_source`. An OA-org lease also contains a
`verification` object with `verifier_url`, `station_id`,
`station_recently_attested`, `key_valid_till`, `station_signature`, and
`org_signature`. The client requires that URL to match its independently
configured OA verifier and submits the same `/submit_key` payload as oa-chat
before using the key. The plaintext key is returned once and is not persisted.

The nullifier remains `reserved` for the whole lease. After expiry plus the
configured usage-propagation grace period, the server reads aggregate `usage`
through OpenRouter's Management API, converts USD to credits, finalizes the
original request, and deletes the expired key. The existing
`GET /v2/requests/{client_request_id}` recovery response then supplies the
signed next state. Thus key issuance, direct inference calls, usage polling,
and state recovery are several HTTP operations but one zkAPI request and one
nullifier. The lease-status GET never returns the plaintext key.

For `key_source = "oa_org"`, the station owns provider management and deletes
the expired key. The zkAPI server cannot inspect account usage, so it finalizes
the proof-bound hard spending limit after expiry instead of claiming
usage-based billing.

This mode is disabled when server-side prompt policy is enabled: a server
cannot enforce a prompt policy while also being excluded from the prompt path.

## Indexer

The indexer currently exposes `/v1/tree/root`, `/v1/tree/next-note-id`,
`/v1/tree/notes/{id}/path`, and `/v1/tree/notes/{id}/zero-path`. These are
indexer API versions, not the proof-protocol version.
