# Roadmap

Version 2 replaces the Stwo/XMSS prototype with compact Groth16 request and
withdrawal proofs, proof-friendly signatures, immutable on-chain verification,
and exact payload binding.

Before any production-money deployment:

- commission independent circuit, Rust, and Solidity audits;
- replace the one-party setup with a reproducible multi-party ceremony, or
  choose an audited proof system with an acceptable setup model;
- benchmark proving on representative client hardware and add proof-worker
  cancellation/resource limits;
- make privacy-preserving full-tree snapshots the standard indexer interface;
- put signing seeds in a hardware-backed or TEE-backed key service and define a
  safe fresh-vault migration procedure;
- add formal cross-implementation vectors for every Poseidon domain and state
  transition;
- add continuous end-to-end lifecycle tests for deposit, several sequential
  requests, recovery, mutual close, escape challenge, and expiry.

Operational improvements include structured latency/resource telemetry,
provider failure budgets, deterministic deployment manifests, setup artifact
checksums, and automated client revision/setup verification.
