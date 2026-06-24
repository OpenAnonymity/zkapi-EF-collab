# Swappable Authentication Methods

zkAPI's authentication method is pluggable. The `zkapi-auth` crate defines a
single interface, [`CredentialScheme`], and ships two implementations selected
by configuration (`--auth-scheme`). The daemons negotiate the active scheme:
`zkapi-serverd` publishes it in `/v1/attestation` and `/health`, and
`zkapi-clientd` refuses to issue requests if its configured scheme does not
match the server's.

## The abstraction

`CredentialScheme` captures the five operations the daemons need under either
method:

| Operation                     | Trait method                          |
| ----------------------------- | ------------------------------------- |
| Build the per-request proof   | `authenticate` (client)               |
| Verify it                     | `verify` (server)                     |
| Derive the spend token        | returned by `authenticate` / `verify` |
| Compute the next state        | `apply_charge` (server)               |
| Build the withdrawal proof    | `build_withdrawal` (client)           |

A scheme also exposes `issue` (registration / genesis) and `verify_withdrawal`
(settlement). The reference implementations hold both client and server state
so the full `issue → authenticate → verify → apply_charge → withdraw` flow is
unit-testable in one place (see `cargo test -p zkapi-auth`); the daemons split
the same calls across the HTTP boundary.

## `state-anchor` (reference)

The existing zkAPI scheme behind the abstraction:

- credential = Pedersen balance commitment `E(balance, blinding)`
- spend token = nullifier `Poseidon(secret, anchor)`
- next state = homomorphic update `E(balance−charge, blinding+δ)` plus a fresh
  anchor, signed forward with XMSS
- withdrawal = the final commitment opening + the carried state signature

`StateAnchorScheme` delegates to the `protocol` crypto module (it does **not**
reimplement primitives): `PedersenCommitment`, `compute_nullifier`,
`compute_next_anchor`, `compute_blind_delta`, `compute_state_message`,
`XmssKeypair`/`XmssVerifier`. This is the path the daemons run end to end today.

## `blind-signature`

An alternate method built on **blind Schnorr signatures** over the Stark curve
(`zkapi-auth::blind_schnorr`):

- A credential is a server blind signature over `H(balance, serial)`. The
  signature binds the balance (a client cannot present a different balance), and
  *blindness* makes the issuance run unlinkable to the later presentation —
  request-by-request unlinkability.
- The `serial` is the spend token / replay key; the server reserves spent
  serials exactly as it tracks nullifiers.
- A charge is a **refund**: the server re-issues a fresh blind credential for
  `balance − charge` under a new serial. Variable-size refunds fall out for
  free — any next balance can be signed.
- Withdrawal reveals the final credential.

The blind-signature primitive and the full scheme flow are implemented and
tested in `zkapi-auth`. `state-anchor` is the runtime path wired through the
daemon HTTP routes; routing `blind-signature` requests through those same routes
(blind issuance + presentation endpoints) is the remaining integration step.

## Selecting a scheme

```bash
# Both daemons must agree.
zkapi serverd --auth-scheme blind-signature ...
zkapi clientd --auth-scheme blind-signature ...
```

A mismatch is rejected by the client before any request is sent.
