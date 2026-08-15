# Architecture

```text
OpenAI/Ollama app -> local zkapi-clientd -> zkapi-indexerd -> ZkApiVault
                           |
               compact Groth16 authorization
                           |
                           v
                    zkapi-serverd
                    /             \
          proxy mode               direct-openrouter mode
       prompt + response          prompt-free key request
              |                    + aggregate usage later
              v                             |
       OpenRouter/OpenAI          local daemon -> OpenRouter
```

`zkapi-clientd` is the user's trust boundary. It stores the note secret,
balance blinding, current anchor, and server state signature. It obtains a tree
path, creates a request proof locally, checks the signed response transition,
and persists the next state atomically.

`zkapi-serverd` checks deployment binding, request freshness, payload binding,
the active root, Groth16 proof, and nullifier. In proxy mode it calls the paid
upstream and therefore sees LLM traffic. In direct OpenRouter mode it sees only
a fixed lease authorization, creates an expiring child key, and later reads the
key's aggregate dollar usage. It stores durable reservations and non-secret
lease metadata for crash recovery, updates the anonymous balance commitment,
and signs the next state with the deployment's pinned Baby-JubJub key.

One direct lease can cover several OpenRouter calls. `zkapi-clientd` binds its
in-memory key to an application-supplied chat session ID. Calls in that session
share the key and run concurrently; another session is rejected rather than
being silently linked. The wallet cannot spend again while that lease's
nullifier is reserved; it advances only after expiry and authoritative usage
settlement. The key's provider-enforced limit bounds the interval's spend by
the amount authorized in that single proof.

`zkapi-indexerd` reconstructs the depth-32 active-note tree from vault events.
It exposes the current root, next note ID, and paths. A future privacy hardening
should make full snapshots the normal client path so a third-party indexer does
not learn which note ID a client queried.

`ZkApiVault` escrows the billing token, maintains the active root, and handles
mutual close, challengeable escape close, and expiry claims. Its proof adapter
and state/clearance public keys are immutable. The real adapter verifies the
same Groth16 statements checked off-chain.

Withdrawal preparation is restart-safe client state. `zkapi-clientd` persists
one idempotent proof plan, refuses new inference while it exists, and reconciles
it against the vault before clearing any secret. Mutual close can complete
immediately with server clearance. An escape initiation moves the vault note to
`PendingWithdrawal`; the client retains the secret and destination through the
deployment-configured challenge window (24 hours by default), then archives
the note only after finalization is confirmed on-chain. A successful server
challenge returns the note to active use and clears the escape plan.

The user-facing compatibility routes remain `/v1/chat/completions`,
`/v1/responses`, `/v1/models`, and `/api/chat` because they follow existing API
ecosystems. The private client-to-server protocol is versioned independently
and uses `/v2/*` routes.

See [deployment.md](deployment.md) for operations.
