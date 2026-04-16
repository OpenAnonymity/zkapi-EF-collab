# Deployment

## Components

- `protocol/contracts`: on-chain vault, proof adapter, token
- `zkapi-indexer`: mirrors vault events into a local Merkle tree view
- `zkapi-server`: verifies proofs, charges requests, signs next state
- `zkapi-auth`: local daemon used by apps and UIs
- `funding-page/`: static deposit UI served by `zkapi-auth`

## Minimal Local Stack

1. Start Anvil:

```bash
anvil --host 127.0.0.1 --port 8545
```

2. Deploy contracts:

```bash
cd protocol/contracts
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url http://127.0.0.1:8545 \
  --private-key "$PRIVATE_KEY" \
  --broadcast
```

3. Start the indexer:

```bash
cargo run -p zkapi-cli -- indexer \
  --contract-address "$VAULT_ADDRESS" \
  --rpc-url http://127.0.0.1:8545
```

4. Start the server:

```bash
cargo run -p zkapi-cli -- \
  --contract-address "$VAULT_FELT" \
  server \
  --provider echo \
  --indexer-url http://127.0.0.1:3001
```

5. Publish the server signing roots on-chain:

```bash
curl http://127.0.0.1:3000/v1/attestation
cast send "$VAULT_ADDRESS" \
  "rotateServerRoots(uint32,uint256,uint256)" \
  "$EPOCH" "$STATE_ROOT" "$CLEAR_ROOT" \
  --rpc-url http://127.0.0.1:8545 \
  --private-key "$PRIVATE_KEY"
```

6. Start the auth daemon:

```bash
cargo run -p zkapi-cli -- auth --listen 127.0.0.1:11434
```

7. Run the scripted local demo if you want the entire flow in one shot:

```bash
./scripts/e2e-demo.sh
```

## Docker

- `docker/Dockerfile` builds `zkapi` and `zkapi-authd`
- `docker/docker-compose.yml` runs `zkapi-authd`
- `docker/docker-compose.dev.yml` adds `anvil` and an example `ollama` service
- `docker/tee/attestation-hook.sh` snapshots `/v1/attestation` into JSON and `.env` formats

## Security Notes

- The auth daemon serializes wallet access with both an in-process mutex and a filesystem lock file.
- The server and client both use the canonical payload hash helper from `zkapi-core`.
- `zkapi-server` now persists `response_payload` so recovery returns the real upstream response body.
- The indexer is untrusted. Bad paths cause proof/transaction failure rather than silent state corruption.

## Mock-Proof Caveat

The Rust request/withdrawal runtime still uses mock envelopes. For deployments that require cryptographically binding proofs in the live request path, a Cairo prover bridge must replace that mock layer.
