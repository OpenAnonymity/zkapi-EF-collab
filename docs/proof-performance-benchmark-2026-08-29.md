# zkAPI proof and chat-settlement performance benchmark

Date: 2026-08-29

## Executive summary

Release status (2026-09-01): the measured decoded request-prover cache and its
background preload have been promoted into the browser worker. Existing funded
wallets start decoding only after their lightweight initial status returns; new
wallets start after deposit preparation so decoding overlaps MetaMask approval
and confirmation. A first Send that arrives early joins the same in-flight
decode instead of starting another. Withdrawal-prover caching remains future
work.

The slow browser path was not primarily Groth16 arithmetic. Before this
release, the worker cached the raw proving-key bytes, but every proof copied
and checked-deserialized the complete key again inside WASM. That repeated
decode consumed about three quarters of total proof latency.

| Path | Current median/component total | Key decode/load | Actual proof | Decoded-key cache projection |
|---|---:|---:|---:|---:|
| Native request, 2 Rayon threads | 2.81 s | 2.136 s | 0.672 s | 0.67 s; 76% faster, 4.2x |
| Native withdrawal, 2 Rayon threads | 3.47 s | 2.731 s | 0.734 s | 0.73 s; 79% faster, 4.7x |
| Packaged WASM request | 12.346 s warm p50 | about 10.04 s | about 3.09 s | 3.027 s measured; 75.5% faster, 4.08x |
| Packaged WASM withdrawal | 16.97 s profiled | 12.32 s | 4.49 s | about 4.5 s; 74% faster, 3.8x |

The WASM request-cache result was measured from an isolated prototype in headless Chrome and cryptographically verified; that exact WASM cache design has now been promoted into the browser worker. Native and withdrawal cache results are projections obtained by removing a separately measured phase. Two consecutive baseline calls in one WASM process remained 12.416 s and 12.307 s: the old JavaScript byte cache did not warm the decoded Rust prover.

“New Chat” and “settle chat” need to be separated from proof generation:

- Clicking New Chat starts retirement of the old lease in the background; it does not prove.
- Retirement resubmits the journaled request that was already proved. It does not generate or verify a new Groth16 proof.
- The first Send waits for retirement, then generates the next request proof. In the UI this can look like one long operation.
- Retirement latency is stream cancellation, provider/OA usage finalization, retries, receipt installation, and persistence. Server-wide mutexes currently serialize lease issuance and settlement across all users.

Decoded request-prover retention and browser preloading are now shipped. The next settlement release step is to replace global lease locks with per-request idempotency/CAS plus bounded provider concurrency. That server-side redesign is not implemented by this release. These changes require no circuit or trusted-setup change.

## Scope and revisions

The native benchmark used application commit `5a341cef2cf3341c620a8c23dffbddb5f1b18ab7` and protocol commit `e4efda23e6d416ee132938e4e67924fb0f7d4fe2`.

The browser trace and packaged-WASM benchmark used `origin/codex/zkapi-browser-wasm` at application commit `a9e2dcb` and protocol commit `c55d604`, because that branch contains the browser worker and exact New Chat flow described in the request.

Host:

- macOS 26.5.2, arm64
- virtual Apple M5 Max, 6 logical CPUs, 16 GiB RAM
- Rust 1.97.1
- Node 26.6.0 / V8 14.6.202.34
- release builds; native latency tables set `RAYON_NUM_THREADS` explicitly

The native harness creates valid genesis/state and escape/mutual fixtures, checks constraint satisfaction, warms the prover, and verifies every resulting proof. It reports every raw sample plus min, median, mean, p95, and max. The packaged-WASM CPU profiles use the exact shipped JS glue, WASM, and deployment keys. Their generated Merkle witness has valid shape but an intentionally synthetic, unsatisfied root; it exercises the same synthesis/FFT/MSM path but should not replace an indexer-valid browser correctness suite.

Local key fetch and WASM initialization were deliberately excluded from the compute comparison: on localhost they were only hundreds of milliseconds and do not represent production network/cache conditions.

## What the user-visible flow actually does

The browser path is:

1. New Chat clears the selected session and begins retiring the old lease.
2. Retirement waits for in-flight streams, submits the exact journaled `prepared_request`, obtains provider usage, and installs a signed next wallet state.
3. If Send happens quickly, it waits on that settlement barrier.
4. The browser synchronizes the note tree and creates a fresh request proof.
5. The server verifies the proof and obtains a new provider key/lease.

The server retirement handler byte/value-compares the submitted request with the stored issuance request. It does not call Groth16 verification again. Locally, response-completion work is a commitment update, one signature verification, and state persistence; the unbounded part is remote-provider finalization.

Three implementation details amplify perceived latency:

- the UI permits up to 15 seconds for active streams to stop;
- provider/OA calls and recovery have 30–45 second timeout/retry budgets;
- `lease_issue_lock` and `lease_settlement_lock` are global mutexes held across network calls (`crates/zkapi-serverd/src/processor_v2.rs`).

No live production credential or production trace was available, so this report does not invent a settlement p50/p95. A mock-provider number would mostly measure localhost and configured artificial delays. The instrumentation plan below defines how to obtain the meaningful value.

## Browser proof results

### In-app Chromium runs

The exact packaged module and keys were executed in a local Chromium page.

| Case | Samples | Median | Mean |
|---|---|---:|---:|
| Request | 17.326, 12.237, 13.991 s | 13.991 s | 14.518 s |
| Withdrawal | 17.592, 16.790, 15.899 s | 16.790 s | 16.761 s |

The sample count is intentionally small because each run is slow. These runs establish user-visible scale; the longer controlled Node/V8 phase profile below establishes attribution.

### V8 phase profiles

| Case | Total | `from_bytes` inclusive | `prove` inclusive | Other |
|---|---:|---:|---:|---:|
| Request | 13.284 s | 10.039 s, 75.57% | 3.091 s, 23.27% | about 0.154 s |
| Withdrawal | 16.967 s | 12.318 s, 72.60% | 4.492 s, 26.47% | about 0.157 s |

The pre-release worker retained a `Uint8Array`, not a decoded `RequestProver`/`WithdrawalProver`. Every invocation transferred/copied 5.65 or 7.50 MB into WASM and performed checked Arkworks deserialization and curve validation.

Memory observations:

| Item | Request | Withdrawal |
|---|---:|---:|
| Proving-key file | 5,654,800 B | 7,502,736 B |
| Verifying-key file | 648 B | 712 B |
| WASM linear-memory high-water | 100,139,008 B | 132,448,256 B |
| Node process max RSS | about 178 MB | about 209 MB |

The shipped WASM binary is 2,336,582 bytes. The wire proof is only 256 decoded bytes (344 base64 characters; the Ark canonical proof is 128 bytes), so proof serialization and transport are not bottlenecks.

The current WASM build is single-threaded for proof arithmetic. Ark/Rayon falls back to the current thread on `wasm32-unknown-unknown`; there is no shared-memory thread-pool initialization or COOP/COEP deployment policy.

### Decoded-prover cache prototype

An isolated prototype against browser application commit `a9e2dcb` and protocol commit `c55d604` added a WASM `BrowserRequestProver` handle. Its constructor copied and checked-deserialized the key once; later calls passed only the request inputs and reused the resident Rust `RequestProver`. The worker coalesced concurrent initialization promises and keyed handles by deployment key URL and pinned SHA-256.

| Implementation | Samples | p50 | p95 |
|---|---|---:|---:|
| Current copy + checked decode + prove | 13.133, 12.346, 11.683, 13.672, 12.111, 15.319, 12.720 s | 12.346 s | 15.319 s |
| Cached handle, proof only | 3.177, 2.980, 3.480, 3.327, 3.142, 3.008, 3.027 s | 3.027 s | 3.480 s |

Warm p50 improved 4.08x (75.5%) and p95 improved 4.40x (77.3%). One-time checked decode was 9.658 s, so a cold decode followed by the first proof was 12.834 s versus a 13.133 s baseline first call. The first visible proof becomes fast only after preloading/idle decoding; every later proof in the worker is immediately faster.

The regenerated WASM grew by 9,187 bytes (0.39%). After seven proofs its linear-memory capacity was 94,437,376 bytes versus 100,139,008 bytes for baseline. This is capacity rather than live heap/RSS, but it shows that retaining the decoded handle did not increase the observed high-water; avoiding repeat decode actually lowered it by 5.7 MB.

Correctness checks passed a production-key request proof against the production verifying key, seven Chrome proofs were unique and 256 bytes each, the worker passed `node --check`, and the rebuilt WASM/test suite passed. The promoted implementation intentionally covers the high-frequency request key only; eagerly retaining the rare withdrawal key needs a separate memory/product tradeoff.

## Native results

### Checked key loading

Twenty checked-deserialization samples with two Rayon threads:

| Key | Min | Median | Mean | p95 | Max |
|---|---:|---:|---:|---:|---:|
| Request | 2.011 s | 2.136 s | 2.277 s | 2.586 s | 4.162 s |
| Withdrawal | 2.288 s | 2.731 s | 2.955 s | 3.801 s | 4.674 s |

With the six-core default, checked-load medians were 1.627 s request and 1.862 s withdrawal. After independently checking a deployment-pinned SHA-256, unchecked canonical decoding measured 1.545 to 1.030 s for request (33.3% faster) and 1.863 to 1.326 s for withdrawal (28.8% faster). Unchecked decoding is only appropriate for independently integrity-pinned public key bytes and remains less valuable than avoiding repeat decode entirely.

### Proof and verification

| Case | Constraints | Instance vars including constant | Witness vars | Domain | 2-thread prove median | Verify |
|---|---:|---:|---:|---:|---:|---:|
| Request | 28,910 | 13 | 28,774 | 32,768 | about 0.672 s | about 1.6–2.4 ms |
| Withdrawal | 34,058 | 15 | 33,768 | 65,536 | 0.734 s stable run | about 1.7–2.4 ms |

Request genesis and state cases have identical topology. Withdrawal genesis/state and escape/mutual cases also have identical topology: `is_genesis` and `has_clearance` condition enforcement, but the gated gadgets are still built. Timing differences among those logical cases were noise, not different circuits.

Peak native RSS observed in repeated setup/prove round trips was about 181 MB request and 286 MB withdrawal. The harness retains measured proof values until the verification phase, so this is a conservative process high-water rather than the steady retained-prover size.

### Thread scaling

Request medians after warmup:

| Rayon threads | Prove | Relative to one thread |
|---:|---:|---:|
| 1 | 1,194.8 ms | 1.00x |
| 2 | about 672–687 ms | about 1.76x |
| 3 | 579.7 ms | 2.06x |
| 4 | 489.9 ms | 2.44x |
| 6 | 373.4 ms | 3.20x |

Withdrawal’s preliminary one/six-thread medians were 1,588/518 ms. Its two-thread sweep was noisy (734–934 ms), so request is the cleaner scaling result. On this host, going from two to six threads reduces request proof-only latency about 44%. The CLI currently defaults one command path to two Rayon threads; direct service paths may use the machine default.

`-C target-cpu=native` did not produce a repeatable improvement over the standard release build on this arm64 host.

## Circuit cost attribution

Exact incremental constraint counts from temporary instrumentation (the instrumentation was reverted):

| Request stage | Constraints | Share |
|---|---:|---:|
| Ranges/base allocations | 751 | 2.6% |
| Registration and leaf | 1,203 | 4.2% |
| 32-level Merkle path | 15,425 | 53.4% |
| Genesis gate | 3 | 0.0% |
| Balance commitment | 2,142 | 7.4% |
| State message | 966 | 3.3% |
| State signature | 5,949 | 20.6% |
| Rerandomization | 1,509 | 5.2% |
| Nullifier | 481 | 1.7% |
| Authorization tag | 481 | 1.7% |

| Withdrawal stage | Constraints | Share |
|---|---:|---:|
| Ranges/base allocations | 493 | 1.4% |
| Registration and leaf | 1,203 | 3.5% |
| 32-level Merkle path | 15,425 | 45.3% |
| Genesis gate | 3 | 0.0% |
| Balance commitment | 2,142 | 6.3% |
| State message | 966 | 2.8% |
| State signature | 5,949 | 17.5% |
| Nullifier | 481 | 1.4% |
| Withdrawal tag | 724 | 2.1% |
| Clearance message | 723 | 2.1% |
| Clearance signature | 5,949 | 17.5% |

The Merkle path is expensive because every domain-separated node hash absorbs `[domain, left, right]` into a rate-two Poseidon sponge, requiring two permutations per level. Temporary micro-instrumentation measured roughly 240 constraints for one rate-sized absorption and 483 for three/four inputs.

Withdrawal sits just 1,305 constraints beyond the 32,768 evaluation-domain limit (`constraints + instance variables = 34,073`). Removing at least 1,306 constraints halves its FFT domain. This makes an escape-specific withdrawal circuit unusually attractive.

## Improvement inventory

“Measured” means the relevant phase or prototype was actually timed/counted. “Projected” means it is derived from those measurements. Circuit changes require new proving/verifying keys and verifier/deployment migration unless noted.

| Priority | Change | Expected result | Evidence | Setup/protocol impact |
|---:|---|---|---|---|
| P0 | Cache decoded prover in WASM worker and long-lived native service | Request: 12.346 to 3.027 s WASM; 2.81 to 0.67 s native. Withdrawal: 16.97 to about 4.5 s WASM; 3.47 to 0.73 s native | WASM request measured prototype; others projected from phase split; 3.8–4.7x | None |
| P0 | Decode/preload request prover after initial wallet status or during deposit | Removes cold decode from first Send when warm-up completes; can hide most remaining latency (browser shipped 2026-09-01) | Flow trace plus phase timing | None |
| P0 | Replace global issue/settlement locks with per-request claims and bounded provider concurrency | Little single-user change; up to roughly N-fold throughput under N independent users and removes unrelated head-of-line waits | Source-level contention proof; needs load test | None |
| P1 | Use 4–6 native Rayon threads when latency matters | Cached native request about 0.49/0.37 s on this host | Measured | None; higher CPU contention |
| P1 | WASM threads/shared memory with single-thread fallback | Cached request plausibly 1–1.5 s on four desktop cores | Projection from native scaling | Hosting headers and compatibility work; no circuit change |
| P1 | Precompute the next constant lease authorization after settlement | Can move the remaining proof behind typing time | Request is not prompt/session-bound; must expire/invalidate on root/state change | None |
| P1 | Split escape withdrawal from mutual clearance | Removes 6,672 constraints (19.6%) and crosses 65,536 to 32,768 domain; estimated 25–45% proof-only gain | Exact constraint count; speed needs benchmark | New circuit/key/verifier variant |
| P2 | Separate genesis variants | Request removes 6,915 constraints (23.9%); withdrawal removes 6,915 (20.3%); genesis+escape withdrawal removes 13,587 (39.9%) | Exact constraint count | New variants; genesis status selects verifier |
| P2 | Fixed-base scalar-multiplication gadgets | Generic fixed G/H prototype: request -870 constraints (3.0%), withdrawal -870 (2.6%) | Measured prototype count | New setup; probably not worthwhile alone |
| P2 | Bake deployment signing keys into fixed-base circuit paths | Prototype totals: request -3,156 constraints (10.9%), withdrawal -5,442 (16.0%) | Measured prototype count | Setup coupled to operational signing keys |
| P2 | Cache Ark constraint matrices | Likely avoids repeated matrix construction; estimate 5–20% proof-only | Ark API/source analysis; unmeasured | No protocol change; memory tradeoff |
| P3 | Put Poseidon domain separation in capacity/initial state rather than absorbing a field | Calculated roughly 9k fewer constraints (about 31% request, 27% withdrawal); withdrawal crosses domain cliff | Constraint/permutation calculation | Cryptographic review; hash, roots, setup, contracts and vectors all migrate |
| P3 | Reduce Merkle depth 32 to 24 | About 3.85k fewer constraints (13.3% request, 11.3% withdrawal), still 16.7M note slots | Exact per-level cost projection | Protocol/storage/deployment migration |
| Avoid | Rely on proof serialization or `target-cpu=native` tuning | Negligible/no repeatable gain | Measured | None |

Decoded caching and prewarming now ship ahead of any circuit redesign. They are larger, lower-risk wins, and they make it possible to judge whether a trusted-setup migration is still justified.

## Tree synchronization risk

At larger deployments, browser tree synchronization can become another critical path. Every lease currently fetches a full JSON snapshot and reconstructs it in WASM by calling `set_leaf` for every position; each call recomputes 32 hashes. This is O(32N), copies data through JSON/structured-clone boundaries, and processes zero leaves.

Before note counts grow, benchmark 1k/10k/100k leaves and add:

- an O(N) bottom-up tree constructor;
- zero-leaf elision and a compact binary snapshot;
- a persistent worker-side tree with authenticated deltas rather than a full rebuild per lease.

## Production benchmark and telemetry plan

Add one correlation ID and structured duration fields spanning browser, server, and provider:

- browser: `new_chat_to_interactive`, `stream_cancel_wait`, `settlement_barrier_wait`, tree fetch/decode/rebuild, worker creation, WASM fetch/compile/init, key fetch/cache state/SHA, JS-to-WASM copy, key decode, proof, lease POST, and IndexedDB commit;
- server issue: lock wait, request lookup/idempotency claim, proof verification, provider key creation, verifier/OA call, and DB commit;
- server settle: lock wait, key disable, usage propagation/poll, receipt creation/signature, state finalization, and DB commit;
- end-to-end: New Chat to old settlement complete, first Send to barrier release, barrier to proof, proof to lease, and Send to first upstream byte.

Benchmark these cache states separately: cold process and HTTP cache, warm HTTP cache/new worker, raw bytes cached, decoded prover cached, same-worker repeat, and prewarmed prover. Use at least three warmups and 30 paired randomized A/B samples where practical (10 minimum for slow browser/device matrices). Report median, p90/p95, MAD/IQR, bootstrap confidence interval, all raw samples, CPU/throttling state, and peak/retained memory.

Run Chrome, Safari, and Firefox on desktop and representative mobile hardware. Add separate 1/2/8/32-concurrent-user settlement/issuance tests to expose global-lock head-of-line blocking. Correctness gates must verify every proof, pinned key digest, Solidity public-input encoding, cancellation, retries, worker crash/restart, and repeated-proof memory growth.

## Reproduction

The native benchmark harness is `protocol/rust/crates/zkapi-proof/examples/proof_bench.rs`.

```bash
cd protocol/rust
cargo build --release -p zkapi-proof -p zkapi-client --example proof_bench

RAYON_NUM_THREADS=2 target/release/examples/proof_bench \
  ../setup/v2 request_state 30 3 20 > request-state.json

RAYON_NUM_THREADS=2 target/release/examples/proof_bench \
  ../setup/v2 withdrawal_state_mutual 30 3 20 > withdrawal-state-mutual.json
```

Cases are `request_genesis`, `request_state`, `withdrawal_genesis_escape`, `withdrawal_genesis_mutual`, `withdrawal_state_escape`, and `withdrawal_state_mutual`.

`zkapi-client` is selected during the build because this workspace currently relies on dependency feature unification for `rand/getrandom`; compiling `zkapi-proof` alone does not enable `OsRng`.

For thread sweeps, keep the fixture and build fixed and run with `RAYON_NUM_THREADS=1`, `2`, `3`, `4`, and `6`. The JSON output includes raw samples, environment thread setting, key/proof sizes, circuit counts, and distribution summaries.

Temporary exact-WASM CPU profiles from this investigation were written to `/tmp/codex-zkapi-wasm-request.cpuprofile` and `/tmp/codex-zkapi-wasm-withdrawal.cpuprofile`. They are machine-local analysis artifacts, not repository fixtures.
