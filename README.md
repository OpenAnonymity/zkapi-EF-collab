# zkAPI — Ethereum Foundation Collaboration

This repository is the **Ethereum Foundation grant collaboration** for the
zkAPI project — the grant-delivery workspace for the zkAPI stack, developed
under an Ethereum Foundation grant awarded to OpenAnonymity.

zkAPI is an anonymous authentication and payment layer for gated APIs: a user
deposits tokens on chain once, receives off-chain credits, and then makes
request-by-request **unlinkable** authenticated calls. The server verifies each
request, deducts a variable charge, and signs a fresh state; net settlement
happens at withdrawal.

The protocol implementation lives in the [`protocol/`](./protocol) submodule.
This outer repo adds the app-facing pieces:

- `zkapi-cli`: operator and local-user CLI (`zkapi`)
- `zkapi-clientd`: local client daemon — `/request` plus OpenAI-, OpenResponses-,
  and Ollama-compatible endpoints, and the browser funding UI
- `zkapi-serverd`: server daemon — proof verification, nullifier storage, API
  execution, state signing
- `zkapi-indexerd`: indexer daemon — mirrors on-chain events into a local
  Merkle tree view (also a standalone binary)
- `zkapi-auth`: swappable authentication methods — state-anchor (reference) and
  blind Schnorr signatures
- `funding-page/`: localhost deposit UI with MetaMask support
- `zkapi-integration-tests`: end-to-end Rust test harness
- CI, deployment docs, Docker packaging, and demo scripts

## Run the PoC end to end

The fastest path is the scripted demo. It stands up a local Ethereum chain
(Anvil), deploys the vault + a mock billing token, registers the server's
signing roots on chain, starts all three daemons, and then drives the full
lifecycle: **deposit → a burst of authenticated requests → both withdrawal
paths.**

### Prerequisites

- Rust toolchain (`cargo`)
- [Foundry](https://book.getfoundry.sh/) — `anvil`, `forge`, `cast`
- `jq` and `curl`

No Cairo/Scarb toolchain is needed for the PoC: it runs the development
mock-proof runtime against an accept-all on-chain proof adapter, so it exercises
the full system plumbing rather than STARK soundness (see
[Proof scope](#proof-scope)).

### One command

```bash
git submodule update --init --recursive
./scripts/e2e-demo.sh
```

Expected output (abridged) — the deposit is confirmed, several requests each
succeed with a decrementing balance (the multi-request state chain), and both
withdrawal proofs are built:

```
Submitting on-chain deposit...
Confirming deposit locally...
Executing authenticated request...
Running a burst of authenticated requests (multi-request state chain)...
  request 2: ok, balance now 998
  request 3: ok, balance now 997
  ...
  request 7: ok, balance now 993
Building mutual-close withdrawal proof (asks serverd for a clearance signature)...
  mutual-close proof ready (has_clearance=true)
Building escape-hatch withdrawal proof (unilateral, no server clearance)...
  escape-hatch proof ready (has_clearance=false)
Demo complete.
```

Per-daemon logs and artifacts (deposit/request/withdrawal payloads) land under
`.demo/`.

### What it demonstrates

- **Deposit**: an on-chain deposit through the `ZkApiVault`, mirrored by the
  indexer rebuilding the Merkle tree from events.
- **Requests**: request-by-request authenticated, metered calls
  (OpenAI/OpenResponses/Ollama compatible) with homomorphic balance refunds.
  Each request advances the signed state — the burst proves the multi-request
  chain holds.
- **Withdrawal**: both paths — mutual close (with a server clearance signature)
  and the unilateral escape hatch. On-chain settlement of both (`mutualClose`,
  `initiateEscapeWithdrawal` → `challenge`/`finalize`) is covered by the
  contract test suite (`cd protocol/contracts && forge test`).

### Drive each function by hand

To demo the client functions interactively instead of running the scripted
flow, bring the stack up with a funded account and leave it running:

```bash
KEEP_UP=1 ./scripts/e2e-demo.sh
```

It deploys the stack, funds a note, then prints a per-function cheat sheet and
waits (Ctrl-C tears down). From there you drive each function yourself — via the
funding UI at <http://127.0.0.1:11434/funding>, or by curl against the client
daemon:

```bash
curl -s    $AUTH/wallet/status | jq                       # status: balance / expiry
curl -s    $AUTH/v1/chat/completions -d '{"model":"zkapi-echo","messages":[{"role":"user","content":"hi"}]}' | jq  # send a request (echo response)
curl -s -X POST $AUTH/wallet/recover  | jq                # crash recovery
curl -s -X POST $AUTH/wallet/withdraw -d '{"mode":"mutual","destination":"0x1111111111111111111111111111111111111111"}' | jq   # refund: mutual close
curl -s -X POST $AUTH/wallet/withdraw -d '{"mode":"escape","destination":"0x1111111111111111111111111111111111111111"}' | jq   # refund: escape hatch
```

(`$AUTH` is the client daemon URL the script prints; responses use the echo
provider, so they don't require a real LLM.)

While the stack is up, `./scripts/balances.sh` prints the authoritative on-chain
billing-token balances for every party (depositor, operator treasury, vault
escrow) — the ground truth that wallets only cache a view of.

### Deposit from the browser (MetaMask)

With the stack running, open <http://127.0.0.1:11434/funding>. The funding UI
lets you deposit through MetaMask instead of the CLI: connect wallet → approve →
deposit → the note activates automatically once the `NoteDeposited` event lands.
Your secret never leaves the machine — only the public commitment and on-chain
values cross. The page also shows a live balance/expiry panel and request log.

The deposit step is shown only while there is **no active note** (the wallet
holds one note at a time), so after a deposit the page switches to the request
view. To demo the MetaMask deposit itself, start the stack **unfunded**:

```bash
KEEP_UP=1 SKIP_DEPOSIT=1 ./scripts/e2e-demo.sh
```

Once a note is active, the request view also shows **"Withdraw (mutual close) via
MetaMask"** — clientd builds the proof and fetches a server clearance signature,
then MetaMask submits `vault.mutualClose`, which pays the remaining balance to
your account and the consumed amount to the operator, and closes the note. The
scripted `e2e-demo.sh` settles the same mutual-close path on chain via `cast`.

### Swap the authentication method

Both daemons accept `--auth-scheme {state-anchor,blind-signature}` (client and
server must agree; clientd refuses a mismatched server). `state-anchor` is the
wired runtime path; the blind Schnorr scheme is implemented and tested in
`zkapi-auth` (`cargo test -p zkapi-auth`). See
[docs/auth-schemes.md](./docs/auth-schemes.md).

### Load test

With the stack already running:

```bash
TOTAL=100 CONCURRENCY=10 ./scripts/stress-test.sh
```

Reports throughput, p50/p90/p99 latency, and failure rate.

## Layout

```text
zkapi-EF-collab/
├── protocol/                     # git submodule (relative URL ../zkapi.git)
├── crates/
│   ├── zkapi-cli/
│   ├── zkapi-clientd/
│   ├── zkapi-serverd/
│   ├── zkapi-indexerd/
│   ├── zkapi-auth/
│   └── zkapi-integration-tests/
├── funding-page/
├── docs/
├── docker/
├── scripts/                      # e2e-demo.sh, stress-test.sh
└── .github/workflows/
```

The `protocol` submodule uses a **relative** URL (`../zkapi.git`) so it resolves
against whichever owner hosts this superproject (e.g. `OpenAnonymity/zkapi`).

## Build and test

```bash
git submodule update --init --recursive
cargo build
cargo test --workspace --exclude zkapi-integration-tests
cargo test -p zkapi-integration-tests --all-features -- --test-threads=1
cargo test --manifest-path protocol/rust/Cargo.toml --features dev-witness-envelope --workspace
```

`protocol/` is excluded from the outer Cargo workspace; the outer crates consume
protocol crates through direct path dependencies, so `workspace = true` metadata
inside `protocol/rust/` resolves against the protocol sub-workspace.

## Run the stack manually

The demo automates all of this; these are the underlying pieces. Global flags
(`--contract-address`, `--chain-id`, `--auth-scheme`, …) precede the subcommand.

```bash
# 1. Indexer (or the standalone `zkapi-indexerd` binary)
cargo run -p zkapi-cli -- indexer \
  --rpc-url http://127.0.0.1:8545 --contract-address 0xYourVault

# 2. Server
cargo run -p zkapi-cli -- --contract-address 0xYourVault serverd \
  --provider echo --indexer-url http://127.0.0.1:3001

# 3. Client daemon
cargo run -p zkapi-cli -- --contract-address 0xYourVault clientd \
  --listen 127.0.0.1:11434

# Inspect the server
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/v1/attestation

# Deposit (prepare locally, deposit on chain via cast / MetaMask, confirm locally)
cargo run -p zkapi-cli -- prepare-deposit --amount 1000
cargo run -p zkapi-cli -- confirm-deposit \
  --secret 0x... --note-id 0 --amount 1000 --expiry-ts 4102444800

# Authenticated request
cargo run -p zkapi-cli -- request \
  --path /v1/chat/completions \
  --json '{"model":"zkapi-echo","messages":[{"role":"user","content":"hello"}]}'

# Withdraw (mutual close or escape hatch)
cargo run -p zkapi-cli -- withdraw --mode mutual --destination 0xYourAddress
```

## Ops assets

- Docker image (builds `zkapi`, `zkapi-clientd`, `zkapi-indexerd`):
  `docker build -f docker/Dockerfile .`
- Full local dev stack (anvil + indexer + server + client + ollama):
  `docker compose -f docker/docker-compose.dev.yml up --build`
- End-to-end demo: `./scripts/e2e-demo.sh`
- Concurrency load test: `./scripts/stress-test.sh`
- Operator and Sepolia deployment guide: [docs/deployment.md](./docs/deployment.md)

## Proof scope

The current Rust runtime uses development mock-proof envelopes for
request/withdrawal roundtrips, verified against an accept-all on-chain adapter.
The Cairo circuits in `protocol/cairo/` are the real proving logic and are
tested independently with `scarb test`. Wiring the Cairo prover into the live
Rust path is the next production milestone — see
[docs/roadmap.md](./docs/roadmap.md).

## Verification matrix

- Outer app crates: `cargo test --workspace --exclude zkapi-integration-tests`
- Outer integration tests: `cargo test -p zkapi-integration-tests --all-features -- --test-threads=1`
- Protocol Rust crates: `cargo test --manifest-path protocol/rust/Cargo.toml --features dev-witness-envelope --workspace`
- Protocol Solidity: `cd protocol/contracts && forge test -vvv`
- Protocol Cairo: `cd protocol/cairo && scarb test`
</content>
