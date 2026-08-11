# Architecture

```text
OpenAI/Ollama client
        |
        v
local zkapi-clientd ----> zkapi-indexerd ----> public testnet ZkApiVault
        |                       ^                     |
        | compact Groth16       | deposit events      | Groth16 verifier
        v                       |                     |
zkapi-serverd -----------------+---------------------+
        |
        v
OpenRouter / OpenAI upstream
```

`zkapi-clientd` is the user's trust boundary. It stores the note secret,
balance blinding, current anchor, and server state signature. It obtains a tree
path, creates a request proof locally, checks the signed response transition,
and persists the next state atomically.

`zkapi-serverd` checks deployment binding, request freshness, payload binding,
the active root, Groth16 proof, and nullifier before calling the paid upstream.
It stores request transcripts for idempotency and crash recovery, updates the
anonymous balance commitment, and signs the next state with the deployment's
pinned Baby-JubJub key.

`zkapi-indexerd` reconstructs the depth-32 active-note tree from vault events.
It exposes the current root, next note ID, and paths. A future privacy hardening
should make full snapshots the normal client path so a third-party indexer does
not learn which note ID a client queried.

`ZkApiVault` escrows the billing token, maintains the active root, and handles
mutual close, challengeable escape close, and expiry claims. Its proof adapter
and state/clearance public keys are immutable. The real adapter verifies the
same Groth16 statements checked off-chain.

The user-facing compatibility routes remain `/v1/chat/completions`,
`/v1/responses`, `/v1/models`, and `/api/chat` because they follow existing API
ecosystems. The private client-to-server protocol is versioned independently
and uses `/v2/*` routes.

See [design-note.md](design-note.md) for the statement and cryptographic
reasoning, and [deployment.md](deployment.md) for operations.
