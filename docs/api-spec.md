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

## Indexer

The indexer currently exposes `/v1/tree/root`, `/v1/tree/next-note-id`,
`/v1/tree/notes/{id}/path`, and `/v1/tree/notes/{id}/zero-path`. These are
indexer API versions, not the proof-protocol version.
