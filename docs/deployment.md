# Deployment

## Components

- `protocol/contracts`: on-chain vault, proof adapter, token
- `zkapi-indexerd`: mirrors vault events into a local Merkle tree view
- `zkapi-serverd`: verifies proofs, charges requests, signs next state
- `zkapi-clientd`: local daemon used by apps and UIs
- `funding-page/`: static deposit UI served by `zkapi-clientd`

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

- `docker/Dockerfile` builds `zkapi`, `zkapi-clientd`, and the standalone `zkapi-indexerd`
- `docker/docker-compose.yml` runs `zkapi-clientd`
- `docker/docker-compose.dev.yml` brings up the whole stack: `anvil`, `zkapi-indexerd`, `zkapi-serverd`, `zkapi-clientd`, and an example `ollama` upstream
- `docker/tee/attestation-hook.sh` snapshots `/v1/attestation` into JSON and `.env` formats

Bring the full dev stack up on one host with:

```bash
docker compose -f docker/docker-compose.dev.yml up
```

## Operator Deployment Guide

An operator runs `zkapi-serverd` (in a TEE in production) plus a `zkapi-indexerd`,
deploys the `ZkApiVault`, and publishes a config bundle clients consume.

1. **Generate signing seeds.** The server signs forward state with two XMSS
   trees (state + clearance). Generate two random seeds and keep them secret;
   pass them as `--state-seed` / `--clear-seed`. The published *roots* (not the
   seeds) go in the client bundle.
2. **Deploy the vault.** `forge script script/Deploy.s.sol:DeployScript` deploys
   the billing token, proof adapter, and `ZkApiVault`, writing
   `{vault, billingToken, noteTtl}` to `$OUTPUT_PATH`. Set `treasury` to the
   operator payout address.
3. **Register signing roots on chain.** Call `vault.rotateServerRoots(epoch,
   stateRoot, clearRoot)` so withdrawals can verify the operator's signatures.
   (Automating this rotation is a roadmap item.)
4. **Start the stack.** `zkapi-serverd --auth-scheme <scheme> --epoch <e>
   --initial-root <root> --indexer-url ...` and `zkapi-indexerd --rpc-url ...
   --contract-address <vault>`.
5. **Publish the config bundle.** Clients need: `chain_id`, `contract_address`,
   `protocol_version`, the charge caps, the indexer URL, and the server's
   `/v1/attestation` (which reports the signing roots and `auth_scheme`).

## Public Testnet (Sepolia)

The contracts and daemons are network-agnostic; deploying to Sepolia is the same
flow as local with a real RPC and a funded key:

```bash
# 1. Deploy the vault + (mock or real) billing token to Sepolia.
cd protocol/contracts
OUTPUT_PATH=../../.demo/sepolia.json \
PRIVATE_KEY=$SEPOLIA_DEPLOYER_KEY \
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url https://sepolia.infura.io/v3/$INFURA_KEY \
  --broadcast --verify

# 2. Point the indexer at Sepolia.
zkapi-indexerd --rpc-url https://sepolia.infura.io/v3/$INFURA_KEY \
  --contract-address $(jq -r .vault ../../.demo/sepolia.json) \
  --from-block <deploy-block> --cursor-path /data/indexer.cursor

# 3. Run serverd/clientd with --chain-id 11155111 and the deployed vault.
```

Notes:
- Fund the deployer from a Sepolia faucet; the indexer must start at the vault's
  deploy block (`--from-block`) so it does not rescan all of history.
- For a real LLM upstream, run `zkapi-serverd --provider http-proxy --upstream-url
  <provider>` (e.g. an Ollama or OpenAI-compatible endpoint) instead of the echo
  provider used by `scripts/e2e-demo.sh`.
- Stress the deployment with `scripts/stress-test.sh` (concurrent load,
  throughput + latency percentiles + failure rate).

A scripted Sepolia deploy depends on network access and a funded key, so it is
documented here rather than run in CI.

## Security Notes

- The auth daemon serializes wallet access with both an in-process mutex and a filesystem lock file.
- The server and client both use the canonical payload hash helper from `zkapi-core`.
- `zkapi-serverd` now persists `response_payload` so recovery returns the real upstream response body.
- The indexer is untrusted. Bad paths cause proof/transaction failure rather than silent state corruption.

## Mock-Proof Caveat

The Rust request/withdrawal runtime still uses mock envelopes. For deployments that require cryptographically binding proofs in the live request path, a Cairo prover bridge must replace that mock layer.
