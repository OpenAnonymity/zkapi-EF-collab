# zkAPI Technical Design Note

Covers issuance, authentication, refunds, and future slashing hooks. For full
protocol derivations see [`protocol/PROTOCOL.md`](../protocol/PROTOCOL.md);
this note is implementation-facing.

## 1. Threat Model

The server is the primary adversary. We assume it:

- Sees every request, signs every response, holds state (nullifier DB, XMSS
  keys).
- May try to deanonymize users by correlating requests.
- May try to overcharge or refuse service.
- May try to block or censor withdrawals.

We do **not** assume it can:

- Break STARK soundness, Poseidon preimage resistance, Pedersen hiding, or
  XMSS signature unforgeability at their claimed security levels.
- Control the Ethereum chain, the indexer, or the user's machine.

User protections rely on:

- **Cryptographic unlinkability** of per-request nullifiers and rerandomized
  Pedersen commitments.
- **Smart-contract enforcement** of net settlement rules and the escape-hatch
  challenge window.

## 2. Issuance (Deposit → Credit Note)

### 2.1 Goal

Convert a public on-chain token deposit into a private off-chain credit note
that is unlinkable to the depositing address in subsequent off-chain requests.

### 2.2 Mechanism

1. Client samples a random 248-bit secret `s`.
2. Client computes the registration commitment
   `C = Poseidon(DOMAIN_REG, s, 0)`.
3. Client queries the indexer for the next empty tree slot `note_id` and the
   zero-path siblings for that slot.
4. Client (or a wallet on their behalf) calls
   `ZkApiVault.deposit(C, D, siblings)`. The contract:
   - Computes `newLeaf = Poseidon(DOMAIN_LEAF, note_id, C, D, expiry_ts)`.
   - Verifies `siblings` are consistent with the current root at the zero
     leaf.
   - Atomically updates the root with `newLeaf`.
   - Escrows `D` tokens via `transferFrom`.
   - Emits `NoteDeposited(note_id, C, D, expiry_ts, newRoot)`.
5. Indexer observes the event and updates its mirror.
6. Client calls `Wallet::confirm_deposit(s, note_id, D, expiry_ts)` locally.
   This materializes the initial `NoteState` with `B = D`, `r = 0`, `τ = 1`
   (the genesis anchor), `is_genesis = true`.

### 2.3 Trust Properties

- **Chain sees:** commitment `C`, deposit amount `D`, expiry, depositor address.
- **Chain does not see:** secret `s`.
- **Unlinkability to future requests:** `C` is a one-way function of `s`, and
  future requests reveal neither `C` nor any function of `note_id` that
  correlates with it. The Merkle proof is a zero-knowledge membership witness.

### 2.4 Code References

- `protocol/rust/crates/zkapi-core/src/leaf.rs::compute_registration_commitment`
- `protocol/rust/crates/zkapi-client/src/wallet.rs::generate_deposit_params`
- `protocol/rust/crates/zkapi-client/src/wallet.rs::confirm_deposit`
- `protocol/contracts/src/ZkApiVault.sol::deposit`
- `ef-collaboration/crates/zkapi-clientd/src/service.rs::prepare_deposit`
- `ef-collaboration/crates/zkapi-clientd/src/service.rs::confirm_deposit`

## 3. Authentication (Request → Authorized Charge)

### 3.1 Goal

Prove to the server that the requestor:

- Is a depositor of record (membership in the tree).
- Knows the secret behind their registration commitment.
- Has an unused spend authorization (fresh nullifier).
- Possesses a valid prior server-signed state (or is genesis).
- Has enough balance to cover the maximum possible charge.

All without revealing which depositor they are, what their current balance is,
or what their prior anchor was.

### 3.2 Proof Statement

The request proof is a STARK over a Cairo circuit that enforces nine
constraints simultaneously:

1. `C = Poseidon(DOMAIN_REG, s, 0)` for some secret `s`.
2. `leaf = Poseidon(DOMAIN_LEAF, note_id, C, D, expiry_ts)`.
3. `compute_merkle_root(note_id, leaf, siblings) == active_root`.
4. `request_nullifier = Poseidon(DOMAIN_NULL, s, τ)` — revealed as public
   input.
5. If `is_genesis == 1`: `τ == 1`, `state_sig_epoch == 0`,
   `state_sig_root == 0`.
6. If `is_genesis == 0`: a valid XMSS signature on
   `Poseidon(DOMAIN_STATE, version, chain_id, contract, E_x, E_y, τ)` under
   `state_sig_root`.
7. `current_commitment = B·G + r·H` — the prover knows an opening.
8. `anon_commitment = current_commitment + ε·H` for some fresh `ε` — revealed
   as public input.
9. `B >= solvency_bound`.

### 3.3 What Is Public vs Private

| Public inputs (on the wire)                         | Private witnesses (prover only)           |
| --------------------------------------------------- | ----------------------------------------- |
| `protocol_version`, `chain_id`, `contract_address`  | secret `s`                                |
| `active_root`                                        | `note_id`                                 |
| `state_sig_epoch`, `state_sig_root` (0 if genesis)  | `D`, `expiry_ts`                           |
| `request_nullifier`                                  | Merkle siblings                           |
| `anon_commitment` (x, y)                             | balance `B`, blinding `r`                 |
| `expiry_ts`                                          | rerandomization `ε`                       |
| `solvency_bound`                                     | anchor `τ`, `is_genesis` flag              |
|                                                      | XMSS state signature (non-genesis)        |

### 3.4 Server Verification

In `RequestProcessor::process_request`:

1. Validate `protocol_version`, `chain_id`, `contract_address` match local
   config.
2. Check `active_root` matches the server's current root (else `STALE_ROOT`).
3. Verify the proof envelope.
4. Check `request_nullifier` is not already in `nullifiers` table (else
   `REPLAY`).
5. Idempotency: if `(client_request_id, payload_hash)` already finalized,
   return the cached response.
6. Reserve the nullifier.
7. Enter the signing mutex (guards predict → compute → sign).
8. Call `ApiProvider::execute(client_request_id, payload, payload_hash)`
   asynchronously.
9. Enforce `charge_applied <= request_charge_cap` (or `policy_charge_cap` if
   policy triggered).
10. Compute `next_commitment`, `next_anchor`, XMSS-sign state message.
11. Finalize transcript in nullifier store.

### 3.5 Client Verification of Response

In `Wallet::request_flow` after receiving `RequestResponse`:

1. Verify the XMSS signature against the epoch's XMSS public root.
2. Verify the homomorphic update:
   `next_commitment = anon_commitment - charge·G + blind_delta·H`.
3. Update `NoteState` atomically: `B_new = B - charge`,
   `r_new = r + ε + blind_delta`, `τ_new = next_anchor`, `is_genesis = false`.
4. Clear the pending journal.

### 3.6 Code References

- `protocol/rust/crates/zkapi-core/src/nullifier.rs`
- `protocol/rust/crates/zkapi-core/src/commitment.rs`
- `protocol/rust/crates/zkapi-proof/src/request.rs`
- `protocol/cairo/src/request/program.cairo`
- `protocol/rust/crates/zkapi-client/src/wallet.rs::request_flow`
- `protocol/rust/crates/zkapi-server/src/processor.rs::process_request`
- `protocol/rust/crates/zkapi-server/src/signer.rs`

## 4. Refunds (Variable Charge → Net Settlement)

### 4.1 Variable Per-Request Charge

The upstream API backend dictates the per-request cost through
`ProviderResponse::charge_applied`. Typical examples:

- Echo provider: fixed charge (testing).
- HTTP proxy to LLM: charge is proportional to input + output token count.
- Web-search / RPC provider: charge per query, potentially based on response
  bytes.

The protocol requires only that:

- `charge_applied <= request_charge_cap` (enforced by server).
- `charge_applied <= solvency_bound` (enforced by proof).
- `charge_applied` is in `u128` base units.

Pedersen commitments make any amount work without protocol changes:

```
next_commitment = anon_commitment - charge·G + blind_delta·H
                = (B - charge)·G + (r + ε + blind_delta)·H
```

### 4.2 Refund Semantics

Refunds are **implicit and aggregate**. The server never sends tokens back
per request — it only deducts the actual charge from the commitment. The
"refund" is the difference between the pessimistic `solvency_bound` that the
client must prove and the real `charge_applied` that the server applies.

That difference stays inside the commitment as part of `B_new`, and is
ultimately paid out at withdrawal:

- User receives `B_final` (remaining balance).
- Treasury receives `D - B_final` (total lifetime usage).

### 4.3 Withdrawal Paths

**Mutual close (happy path):**

1. Client derives `x_w = Poseidon(DOMAIN_NULL, s, τ_current)`.
2. Client `POST /v1/withdraw/clearance { withdrawal_nullifier: x_w }`.
3. Server checks `x_w` unused, XMSS-signs
   `clear_msg = Poseidon(DOMAIN_CLEAR, version, chain, contract, x_w)`,
   marks `x_w` as `ClearanceReserved`.
4. Client builds withdrawal proof with `has_clearance = true`, revealing
   `B_final` as public.
5. Client submits `vault.mutualClose(public_inputs, proof)`.
6. Contract verifies and settles: `B_final` to destination, `D - B_final` to
   treasury.

**Escape hatch (fallback):**

1. Client builds withdrawal proof with `has_clearance = false`.
2. Client submits `vault.initiateEscapeWithdrawal(public_inputs, proof)`.
3. Contract verifies, zeroes the leaf immediately, stores
   `challengeDeadline = now + 24h`.
4. During 24h the server may challenge (see §5.1 on slashing).
5. After 24h with no challenge:
   `vault.finalizeEscapeWithdrawal(note_id, destination, finalBalance)`.

### 4.4 Code References

- `protocol/rust/crates/zkapi-server/src/provider.rs` — `ApiProvider` trait
  + `ProviderResponse::charge_applied`
- `protocol/rust/crates/zkapi-crypto/src/pedersen.rs::server_update`
- `protocol/rust/crates/zkapi-server/src/processor.rs` — cap enforcement
- `protocol/rust/crates/zkapi-client/src/wallet.rs::withdrawal_mutual_close`
- `protocol/rust/crates/zkapi-client/src/wallet.rs::withdrawal_escape_hatch`
- `protocol/contracts/src/ZkApiVault.sol::{mutualClose, initiateEscapeWithdrawal, finalizeEscapeWithdrawal}`

## 5. Slashing Hooks

### 5.1 Present: Stale-State Slashing via Escape Challenge

The protocol has one operational slashing mechanism today: the escape-hatch
challenge.

If a client tries to escape-withdraw using an old state (claiming a higher
`B_final` than their actual current balance), the server can challenge within
24 hours by submitting any transcript showing the client spent past that
state. The contract verifies the challenge and restores the leaf, making the
user's escape attempt invalid. The user can only escape from their *current*
state — they cannot rewind.

The server's incentive to challenge is direct: every dollar the user
over-withdraws is a dollar the treasury (server) loses.

**Implementation:**
- `ZkApiVault.challengeEscapeWithdrawal(noteId, requestProof, publicInputs)`.
- Server retains transcripts in its nullifier store (including
  `response_payload` after the Phase 1c fix).

### 5.2 Present: In-Protocol Policy Penalty (`S_max`)

The protocol supports an optional higher charge cap for policy violations.
When `policy_enabled = true`, clients must prove
`B >= max(request_charge_cap, policy_charge_cap)`, and the server may charge
up to `policy_charge_cap` if the provider returns a `policy_reason_code`.
Excess deductions flow through the normal net settlement — there is no
separate on-chain `slashPolicyStake` function.

This is a bounded, auditable slashing: the server cannot arbitrarily drain
the user, and every deduction is externally reconstructible from the
transcript.

**Implementation:**
- `protocol/rust/crates/zkapi-server/src/config.rs::{policy_enabled, policy_charge_cap}`
- `ProviderResponse::{policy_reason_code, policy_evidence_hash}`

### 5.3 Future Slashing Hooks (Open Design)

Three categories of future slashing, each a hook point that is not yet
implemented:

**(a) Stronger double-spend slashing.**
In the current state-anchor-chain design, double-spending a nullifier is
prevented by the server's DB; the economic consequence is that the offending
request is rejected. Alternative backends (RLN) use algebraic slashing: a
double-signal reveals the user's secret key to the server, enabling on-chain
stake burn. If we wanted this, we'd add a `slashDoubleSpend(proof)` method
to the contract and a corresponding secret-recovery witness in the proof.

**(b) Operator-misbehavior slashing.**
The server holds no user-owed stake today. If the server produces an
invalid state signature or a signature with a reused XMSS leaf, the user can
detect it locally but has no on-chain recourse beyond the escape hatch. A
future extension: have the server escrow a bond in the contract and define
`slashOperator(evidence)` that burns the bond on proven misbehavior.

**(c) Policy-violation slashing with burn.**
Davide's feedback suggested a burn-only slashing for policy violations so
that the server cannot profit from false accusations. This would require a
separate policy stake (not the per-note deposit), a `slashPolicyStake(nullifier,
evidence)` method that burns rather than transfers, and an auditable
evidence hash.

**Extension points for these:**
- Contract method additions (requires redeployment).
- New `ApiProvider` response fields (`slash_evidence`).
- New fields in `TranscriptRecord`.
- New CLI / daemon commands for dispute flow.

None of these require changes to the core state-anchor-chain mechanism. They
layer on top.

### 5.4 Code References

- `protocol/contracts/src/ZkApiVault.sol::challengeEscapeWithdrawal`
- `protocol/rust/crates/zkapi-server/src/nullifier_store.rs::TranscriptRecord`
- `protocol/rust/crates/zkapi-server/src/provider.rs::ProviderResponse`
- `ef-collaboration/docs/roadmap.md` — future slashing directions

## 6. Security Properties Summary

| Property                    | Mechanism                                           | Broken if...                                     |
| --------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| Unlinkability               | fresh nullifier + rerandomized commitment per req   | Poseidon is not one-way, or Pedersen not hiding  |
| Soundness (no fake request) | STARK proof system + constraint correctness         | prover or circuits have a bug                    |
| Replay resistance           | SQLite nullifier table + unique constraint          | server DB is corrupted                           |
| Balance integrity           | homomorphic update in processor + verified at close | signer misbehaves within a request               |
| Server accountability       | charge cap enforced before next-state signing       | operator sets a trivially large cap              |
| Withdrawal liveness         | escape hatch + 24h challenge window                 | contract upgraded or paused by owner             |
| Challenge validity          | server has archived transcripts                     | server DB loss                                   |

## 7. Implementation Caveat

The Rust proof layer currently uses mock proof envelopes (JSON witness
serialization + constraint replay). The Cairo circuits exist and pass their
own test suite, but a runtime Cairo prover/verifier bridge is not wired into
the Rust stack. This is an explicit grant-scope decision: the protocol
correctness story is the Cairo circuits; the Rust stack validates the
protocol logic and integration.

For production deployment, either:
- Integrate a Cairo prover (e.g., `stone-prover`) into `zkapi-client`, OR
- Move proof generation to a dedicated service that outputs serialized
  STARK proofs consumable by the on-chain fact registry adapter.
