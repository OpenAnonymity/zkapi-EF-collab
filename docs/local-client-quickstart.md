# Local client quickstart

Prerequisite: Rust. Foundry's `cast` is optional for the headless funding flow.
Clone and build:

```bash
git clone https://github.com/OpenAnonymity/zkapi-EF-collab.git
cd zkapi-EF-collab
git submodule update --init --recursive
cargo build --release --bin zkapi
```

Start the prompt-private local API on Ethereum Mainnet (real USDC and ETH for gas):

```bash
./target/release/zkapi --require-oa-org-key-source client \
  --mode direct-openrouter --initial-credits 2000000
```

The suggested deposit is 2,000,000 base units (`2 USDC`). The selected wallet must
already hold at least that much USDC plus Mainnet ETH for approve, deposit,
and withdrawal gas. For a small test, `0.003 ETH` provides reasonable
headroom at low gas prices; check the current gas price before funding.

Or use Sepolia (free test token, but Sepolia ETH is needed for gas):

```bash
./target/release/zkapi --require-oa-org-key-source client \
  --deployment https://d33l4w2z2nh4cg.cloudfront.net/config.json \
  --mode direct-openrouter --initial-credits 5000000
```

Open `http://127.0.0.1:11434/`, connect MetaMask, switch to the deployment's
network when prompted, and deposit the suggested amount. The page shows the
remaining and spent portions of the current note, its expiry, and a low-balance
warning. It never asks for or stores a private key. For a headless environment,
add `--fund-with-cast` to use the interactive terminal flow instead.
On the public Sepolia deployment, the same button mints free ZKAPI test credits
when the connected address needs them; the address still needs Sepolia ETH for
transaction gas. About `0.02 Sepolia ETH` provides reasonable headroom for a
complete mint, approve, deposit, chat, and mutual-withdrawal test at typical
testnet gas prices.

The larger Sepolia test-token deposit reserves enough for about 100
maximum-cost lease windows at the demo's $0.05 cap. By default a child key
serves at most five requests for one chat session; those requests may run in
parallel. Before serving request six, the client disables that key, settles its
measured aggregate usage, and opens the next lease. Requests sharing a key are
linkable to OpenRouter. To use one key per request, put
`--openrouter-requests-per-key 1` before `client`:

```bash
./target/release/zkapi --require-oa-org-key-source \
  --openrouter-requests-per-key 1 client --mode direct-openrouter
```

Add the same `--deployment ...` argument shown above after `client` when using
Sepolia.

Keep the client running, then use the bundled chat or call its local
OpenAI-compatible API. Supply a stable session ID when an application can
identify a conversation:

```bash
curl -fsS http://127.0.0.1:11434/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-zkapi-session-id: my-private-chat' \
  -d '{"model":"openai/gpt-4o-mini","max_tokens":256,"messages":[{"role":"user","content":"Explain HTTPS briefly."}]}' | jq .
```

Streaming works with both OpenWebUI connection types: `/v1/chat/completions`
passes `"stream": true` through as unbuffered OpenAI-compatible SSE, while
`/api/chat` converts that stream into Ollama-compatible NDJSON (and follows
Ollama's default of streaming when the field is omitted).

## Withdraw

Keep the local client running and withdraw the active note from another
terminal. The command retires any active ephemeral key, settles its measured
usage, builds the proof, securely prompts for a gas-payer private key, submits
the transaction, verifies that the note closed, and clears the local note:

```bash
./target/release/zkapi withdraw --destination 0xYourPayoutAddress
```

For a client running against Sepolia, select the same manifest:

```bash
./target/release/zkapi withdraw \
  --deployment https://d33l4w2z2nh4cg.cloudfront.net/config.json \
  --destination 0xYourPayoutAddress
```

The prompted account only pays ETH gas; it does not need to be the depositor or
the payout address.

If the zkAPI server is unavailable, initiate the escape hatch instead:

```bash
./target/release/zkapi withdraw --mode escape \
  --destination 0xYourPayoutAddress
```

The result prints the note ID and challenge deadline. After the deadline,
finalize it (repeat `--deployment ...` for Sepolia):

```bash
./target/release/zkapi withdraw --mode finalize-escape --note-id NOTE_ID
```

In direct mode, calls with the same session ID share one bounded ephemeral key
and may execute concurrently. Until that key expires and settles, a different
session receives `409 lease_session_conflict` instead of being linkable to it.

## Withdraw in the browser

Open the system panel and choose **Withdraw balance**. The recommended mutual
close obtains server clearance and returns the note's remaining billing tokens
in one MetaMask transaction. The UI verifies the vault event before archiving
the local note.

The escape hatch is the unilateral recovery path. Its first transaction freezes
the note and starts the vault's configured safety window (24 hours by default).
The UI reads that duration from the vault and shows the exact deadline. Keep the
daemon state directory: the note secret remains there until finalization, and
the pending screen is restored after a browser or daemon restart. After the
displayed deadline, reconnect the same destination account and choose
**Finalize in MetaMask**. Anyone can submit that final transaction, but the
tokens always go to the destination committed by the withdrawal proof. If the
server challenges the escape during the window, **Check on-chain status**
restores the active note. Chat requests are rejected while either withdrawal
path is prepared or pending so the proven balance cannot be spent twice.
