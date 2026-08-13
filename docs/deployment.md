# Deployment

This is the v2 deployment sequence. It deploys the real Groth16 adapter; there
is no mock adapter or Stwo process in the public path.

## 1. Build and choose server keys

```bash
cargo build --release --bin zkapi
export ZKAPI_STATE_SEED='0x...'
export ZKAPI_CLEAR_SEED='0x...'
./target/release/zkapi signing-keys
```

Keep the seeds in a secret manager. Put only the returned public coordinates in
the contract deployment and client manifest. Replacing either seed requires a
fresh vault deployment because the keys are immutable security parameters.

## 2. Deploy contracts

The selected setup is `protocol/setup/v2`; its generated verifier is already in
the contract tree. Poseidon is a linked Solidity library, so deploy it first.
From `demo/contracts`:

```bash
export PRIVATE_KEY='0x...'
export TREASURY='0x...'
export STATE_SIGNING_KEY_X='0x...'
export STATE_SIGNING_KEY_Y='0x...'
export CLEARANCE_SIGNING_KEY_X='0x...'
export CLEARANCE_SIGNING_KEY_Y='0x...'
export MINT_AMOUNT='1000000000'
export OUTPUT_PATH="$PWD/../../.demo/public-testnet-v2.json"

export POSEIDON_ADDRESS=$(forge create \
  ../../protocol/contracts/src/libraries/Bn254Poseidon.sol:Bn254Poseidon \
  --rpc-url "$PUBLIC_TESTNET_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast \
  --json | jq -r .deployedTo)

forge script script/Deploy.s.sol:DeployScript \
  --rpc-url "$PUBLIC_TESTNET_RPC_URL" --broadcast --private-key "$PRIVATE_KEY" \
  --libraries "zkapi-contracts/libraries/Bn254Poseidon.sol:Bn254Poseidon:$POSEIDON_ADDRESS"
```

The script deploys the 6-decimal demo billing token, circuit-specific
`Groth16ProofAdapter`, and immutable-key `ZkApiVault`, then writes their
addresses and client parameters to `OUTPUT_PATH`. The demo token has a public
`mint` and has no value.

For Ethereum Mainnet, set `BILLING_TOKEN` to an existing 6-decimal production
token and leave `MINT_AMOUNT=0`. The script refuses to create the freely
mintable demo token on chain ID 1. For USDC, independently verify
[Circle's published Ethereum address](https://developers.circle.com/stablecoins/usdc-contract-addresses)
before deployment:

```bash
export BILLING_TOKEN='0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
export MINT_AMOUNT=0
```

The client manifest for a faucet-style test token must explicitly set
`"demo_mint_enabled": true`. Omit it or set it to `false` for a real token;
the one-command client will then approve and deposit existing tokens without
attempting the test-only `mint(address,uint256)` call.

## 3. Run indexer and server

Start the indexer from the vault deployment block:

```bash
./target/release/zkapi indexer \
  --listen 0.0.0.0:3001 \
  --rpc-url "$PUBLIC_TESTNET_RPC_URL" \
  --contract-address "$VAULT" \
  --from-block "$DEPLOY_BLOCK" \
  --cursor-path /data/indexer.cursor
```

Start the protocol server with the exact setup and the secret seeds whose
public keys are pinned in the vault:

```bash
export ZKAPI_OPENROUTER_INFERENCE_KEY='...'
# Separate OpenRouter Management API key; required only for direct leases.
export ZKAPI_OPENROUTER_MANAGEMENT_KEY='...'
export ZKAPI_STATE_SEED='0x...'
export ZKAPI_CLEAR_SEED='0x...'

./target/release/zkapi \
  --protocol-version 2 \
  --chain-id 11155111 \
  --contract-address "$VAULT" \
  --request-charge-cap 1000000 \
  --proof-setup-dir "$PWD/protocol/setup/v2" \
  serverd --listen 0.0.0.0:3000 --provider metered \
  --indexer-url http://127.0.0.1:3001 \
  --openrouter-lease-ttl-seconds 300 \
  --openrouter-settlement-grace-seconds 5 \
  --db-path /data/zkapi-server.db
```

The inference and management keys are different credentials. OpenRouter
management keys cannot perform completions; they create, inspect, and revoke
the short-lived runtime keys used by direct mode. Omitting
`ZKAPI_OPENROUTER_MANAGEMENT_KEY` disables only direct leases: the configured
proxy provider continues to run. Both `/v2/requests` and
`/v2/openrouter/leases` are served by the same process when it is present.

Put TLS/reverse-proxy routing in front of the services. Route `/v2/*`,
`/health`, `/v1/attestation`, and dashboard requests to serverd; route
`/v1/tree/*` to indexerd. Do not expose the OpenRouter key or signing seeds in
the client manifest, image, shell history, or repository. The management key
must have permission to create, list, inspect, and delete OpenRouter API keys.

As a verifier-backed alternative, configure a dedicated credential on an OA
org and start serverd with the org source instead of
`ZKAPI_OPENROUTER_MANAGEMENT_KEY`:

```bash
export ZKAPI_OA_ORG_SHARED_SECRET='...'

./target/release/zkapi \
  --protocol-version 2 \
  --chain-id 11155111 \
  --contract-address "$VAULT" \
  --request-charge-cap 1000000 \
  --proof-setup-dir "$PWD/protocol/setup/v2" \
  serverd --listen 0.0.0.0:3000 \
  --oa-org-url https://org.example \
  --openrouter-lease-ttl-seconds 300 \
  --openrouter-settlement-grace-seconds 5 \
  --db-path /data/zkapi-server.db
```

The OA org must expose `POST /api/zkapi/request_key`, set the same dedicated
`ZKAPI_SHARED_SECRET`, configure `VERIFIER_URL`, and cap credit/duration at
least as tightly as the zkAPI deployment. OA-org TTLs are whole minutes. The
client trusts `https://verifier2.openanonymity.ai` by default; override
`--oa-verifier-url` only when the independently audited verifier endpoint is
different. The server reads the service credential only from
`ZKAPI_OA_ORG_SHARED_SECRET`, not a command-line flag. Never reuse the org
admin secret as the zkAPI service credential.

Protected clients must also set `--require-oa-org-key-source`. The verifier URL
and OpenRouter inference base are independently pinned client settings; the
daemon rejects redirects and any lease that attempts to substitute either
origin or downgrade to a direct key.

## 4. Publish client parameters

Publish the vault address, chain ID, request cap, the four public signing-key
coordinates, public base URL, exact Git revision, and exact setup files. Client
instructions are in the repository [README](../README.md).

## Security qualification

This setup was generated by one party and the implementation is unaudited. It
is suitable for public testing, not a production-money deployment. Publishing
the same code on Ethereum Mainnet does not change that qualification: a real
launch requires a reviewed setup ceremony and audited circuit, Rust, and
Solidity implementations.
