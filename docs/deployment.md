# Deployment

## Components

- `protocol/contracts`: reusable on-chain vault and proof-adapter contracts
- `demo/contracts`: EF-owned demo token and local deployment harness
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
mkdir -p .demo
cd demo/contracts
OUTPUT_PATH=../../.demo/deployment.json \
PRIVATE_KEY="$PRIVATE_KEY" \
TREASURY="$TREASURY" \
MINT_AMOUNT="$MINT_AMOUNT" \
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url http://127.0.0.1:8545 \
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

6. After verifying that the transaction succeeded and the values registered by
   the vault match the server's published roots, write the trusted registry:

```json
[
  {
    "epoch": 1,
    "state_root": "0x<verified-state-root>",
    "clear_root": "0x<verified-clear-root>"
  }
]
```

The attestation endpoint is a source of candidate values, not a trust anchor.
Only put roots in this file after verifying them against the configured vault
on chain.

7. Start the auth daemon with that registry:

```bash
cargo run -p zkapi-cli -- \
  --trusted-epoch-roots ./trusted-epoch-roots.json \
  auth --listen 127.0.0.1:11434
```

8. Run the scripted local demo if you want the entire flow in one shot:

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
2. **Deploy the vault.** From `demo/contracts`, `forge script
   script/Deploy.s.sol:DeployScript` provides the EF demo deployment: it deploys
   the billing token, permissive proof adapter, and `ZkApiVault`, writing
   `{vault, billingToken, treasury, noteTtl}` to `$OUTPUT_PATH`. Set `TREASURY`
   to the operator payout address. Production deployments should substitute
   their production token and proof adapter.
3. **Register signing roots on chain.** Call `vault.rotateServerRoots(epoch,
   stateRoot, clearRoot)` so withdrawals can verify the operator's signatures.
   (Automating this rotation is a roadmap item.)
4. **Start the stack.** `zkapi-serverd --auth-scheme <scheme> --epoch <e>
   --initial-root <root> --indexer-url ...` and `zkapi-indexerd --rpc-url ...
   --contract-address <vault>`.
5. **Publish the config bundle.** Clients need: `chain_id`, `contract_address`,
   `protocol_version`, the charge caps, the indexer URL, `auth_scheme`, and an
   epoch-root registry independently verified against the vault. Pass the
   registry to clientd with `--trusted-epoch-roots`. Pass it to serverd as well
   when prior epochs should remain valid after a signing-root rotation.

## Public Testnet (public testnet)

The contracts and daemons are network-agnostic; deploying to public testnet is the same
flow as local with a real RPC and a funded key:

```bash
# 1. Deploy the EF demo token, mock adapter, and vault to public testnet.
cd demo/contracts
OUTPUT_PATH=../../.demo/public-testnet.json \
PRIVATE_KEY=$PUBLIC_TESTNET_DEPLOYER_KEY \
TREASURY=$PUBLIC_TESTNET_TREASURY \
MINT_AMOUNT=$PUBLIC_TESTNET_MINT_AMOUNT \
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url https://public-testnet.infura.io/v3/$INFURA_KEY \
  --broadcast --verify

# 2. Point the indexer at public testnet.
zkapi-indexerd --rpc-url https://public-testnet.infura.io/v3/$INFURA_KEY \
  --contract-address $(jq -r .vault ../../.demo/public-testnet.json) \
  --from-block <deploy-block> --cursor-path /data/indexer.cursor

# 3. Run serverd/clientd with --chain-id 11155111 and the deployed vault.
```

Notes:
- Fund the deployer from a public testnet faucet; the indexer must start at the vault's
  deploy block (`--from-block`) so it does not rescan all of history.
- For a real LLM upstream, run `zkapi-serverd --provider http-proxy --upstream-url
  <provider>` (e.g. an Ollama or OpenAI-compatible endpoint) instead of the echo
  provider used by `scripts/e2e-demo.sh`.
- Stress the deployment with `scripts/stress-test.sh` (concurrent load,
  throughput + latency percentiles + failure rate).

A scripted public testnet deploy depends on network access and a funded key, so it is
documented here rather than run in CI.

## Security Notes

- The auth daemon serializes wallet access with both an in-process mutex and a filesystem lock file.
- The server and client both use the canonical payload hash helper from `zkapi-types`.
- Signing roots fetched from the server are not trusted automatically. Configure
  only roots verified against the intended on-chain vault.
- `zkapi-serverd` now persists `response_payload` so recovery returns the real upstream response body.
- The indexer is untrusted. Bad paths cause proof/transaction failure rather than silent state corruption.

## Proof Backends

Production builds default to `stwo_scarb`, which generates and verifies opaque
Stwo-Cairo artifacts through Scarb. The private-witness replay backend is
excluded from default builds; compile with `--features dev-witness-envelope`
and explicitly set `ZKAPI_PROOF_MODE=dev_witness_envelope` only for local
integration work.
