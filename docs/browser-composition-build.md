# Composed browser and daemon assets

OA Chat is a pinned `oa-chat` submodule. The zkAPI entry point lives in
`funding-page/zkapi-entry.js` and imports `oa-chat/chat/publicApi.js`. Shared chat
source files are not overlaid, copied back, or rewritten during a build.

## Local builds

Node.js 24+ is required for the JavaScript build. Initialize the committed
submodule revisions and install the exact build dependency lockfile:

```sh
git submodule update --init --recursive
npm ci
npm run test:build
npm run build:browser
npm run build:mainnet
```

Outputs are `dist/browser/funding/` and `dist/browser-mainnet/funding/`. The
existing `scripts/package-browser-client*.sh` commands call this same composer.
`scripts/build-browser-client.sh` first regenerates the Rust/WASM module and then
runs the composer. The UX proposal wrapper supplies a build-time configuration
choice; it does not mutate the generated configuration after its hash is taken.

`cargo build -p zkapi-clientd` invokes this same composer from `build.rs` and
embeds its output from Cargo's `OUT_DIR`. It requires the Node/npm prerequisites
above, and never falls back to embedding a separate vendored application. The
Docker build installs Node only in its build stage; the final image contains the
Rust executables and their embedded assets, not Node or npm.

## Source pins and uploaded archives

The Git submodule pointers are authoritative. `browser-sources.lock.json` records
the same revisions for Vercel/source archives, where `.git` metadata is absent.
After deliberately updating and committing a submodule revision, run:

```sh
npm run lock:sources
```

Review and commit this lock together with the updated submodule pointer. Builds
inside a checkout reject a mismatch instead of reporting the wrong source
revision. Builds do not pull a floating branch or automatically update pins.

## Asset and persistence boundaries

The composer bundles the public entry, shared prelude, and zkAPI worker, and
copies an explicit set of static runtime assets. It excludes source trees, test
fixtures, dotfiles, dependency directories, and source maps. The two proof keys
must match the SHA-256 hashes in the selected deployment configuration.

`build.json` records the pinned sources, bundled input graph, selected network,
and SHA-256 hashes of every published asset. Its hash is content-derived with no
timestamp, so repeated builds of the same inputs are reproducible.

All deployments continue to use `/funding/`. Browser configuration remains at
`/funding/browser-config.json`, proof keys at `/funding/proofs/`, and WASM at
`/funding/wasm/`. App bundles and the worker are one level below that root under
`assets/`, preserving the wallet runtime's relative `import.meta.url` paths.
The composer does not change IndexedDB names, browser storage, wallet journals,
or deployed origins. The daemon keeps the legacy `/funding/app.js` endpoint as
a loader for the same composed app, not another copy of ChatApp.

Existing Vercel configurations use `npm ci` and their corresponding packaging
wrapper. Git deployments must include the pinned public submodules; source
uploads must include their initialized contents. No private wallet or account
state is a build input.

## Isolated release deployments

The 2026-09-05 composition release uses new Vercel projects. Do not relink or
deploy from an existing project's `.vercel` directory. The docs site's Git
integration honors `[preserve-deployments]` in a commit message through
`ignoreCommand`; the shared OA app has the same opt-in guard. Use this marker
for the initial clean-history merge so existing Git-connected sites remain on
their previous deployments. Ordinary later commits are not skipped. Browser
release builds use their explicit browser/mainnet configuration, not these
upstream-site configurations.

The new production projects are `oa-zkapi-composed-sepolia` and
`oa-zkapi-composed-mainnet` in the `mingyech1` team:

- https://oa-zkapi-composed-sepolia.vercel.app/funding/
- https://oa-zkapi-composed-mainnet.vercel.app/funding/

They are explicitly deployed static artifacts, not Git-linked copies of the old
projects. Build both networks from the committed source pins. For each release,
use a fresh staging directory, copy that network's `dist` output into `public/`,
and copy its `vercel.browser.json` or `vercel.mainnet.json` configuration with
`installCommand` and `buildCommand` empty and `outputDirectory` set to `public`.
Keep the network-specific rewrites, redirects and headers unchanged. Explicitly
link the matching **new** project, run `vercel pull --environment=production`,
`vercel build --prod`, then `vercel deploy --prebuilt --prod`. Do not copy a
working checkout's `.vercel` link or environment files into published assets.

Verify `/funding/build.json`, every asset digest, network/contract configuration,
same-origin API rewrites and the browser UI after deployment. The new origins
have independent browser storage; existing notes and chat history remain on the
old origins and are not automatically migrated.

## OA commercial compatibility check (2026-09-05)

The standalone OA production build succeeds with the composition changes and
Node 24.20.0. The ordinary ticket/account defaults remain enabled, and the
commercial extension API remains version 2.

A disposable checkout of `oa-commercial` at
`9c95a09d5be1bfb6fb8ec4f714260f97d1efd1a8` was built with both the modified OA
source and an independent unmodified worktree of OA main
`feb7ad9735816224196909cfe2ec367044f9243c`. Both commercial builds succeeded and
both produced exactly the same test results: 283/287 unit tests and 10/12
artifact tests passed. The identical failures cover account-footer spacing,
username/Google identity handoff, the username account surface, and a
content-derived CSS cache version. Those changes are present in the commercial
project's pinned OA fork (`7874936e0004f54111f768171cfd4422d4406cea`) but not in
the chosen main baseline; they are not introduced by this composition diff.

Do not repoint the commercial project to this OA main revision without first
reconciling its existing fork-only changes. The check confirms build and
extension-boundary compatibility, not a live billing, OAuth, or passkey test.
It made no deployment, authentication, or payment changes.

## Verification

`npm test` runs the downstream wallet/recovery, runtime, UI, transport and build
tests. The controller migration gate executes behavioral tests against the
actual `oa-chat` controller, rather than regex-checking an unused copied app.
Run `npm --prefix oa-chat ci && npm --prefix oa-chat test` for the complete
standalone OA suite and `cargo test -p zkapi-clientd --lib` for embedded routes.

For a browser smoke test, serve `dist/browser` on localhost and use an isolated
browser profile without MetaMask. The optional
`scripts/browser-composition-fixture.js` can be evaluated through browser
automation after startup. It refuses non-localhost origins and wallet-enabled
profiles. It replaces only the wallet/provider boundaries with simulated
responses; the composed controller, product runtime, request construction, SSE
parser, IndexedDB and UI remain real. It is excluded from published assets.

Verify streamed chunks, simultaneous title/response requests, New Chat during
settlement, accepted queued prompt + Stop, revisiting a chat with full context,
and a progress disclosure staying open across clock updates. The fixture's
`holdSettlement` flag provides a deterministic waiting state. These are not
on-chain deposit/withdrawal tests; never treat the simulated note or token as
real payment evidence. Existing wallet journals, withdrawal state machines and
contracts are unchanged by this composition refactor.

For composer accessibility/layout regressions, evaluate
`scripts/browser-composer-style-check.js` after the local fixture, then send a
one-line prompt through the UI. Once the streamed response completes, evaluate
`window.composerStyleCheck.verify()`. It checks the actual acceptance/completion
announcements, their screen-reader semantics, clipping, and unchanged composer
height. Repeat after reloading in light/dark themes and a narrow viewport. This
test helper is not a production asset and does not use a real wallet or model.

### Set-aside mutual-close recovery

A mutual-close authorization reserves the old balance for withdrawal even if
the user rejects MetaMask. **Set aside** retains that note and its authorization
atomically in the withdrawal store; a new deposit occupies a separate selected
wallet slot. **Withdraw** in history now reproves the old note against the
current vault root and pays its original destination, without restoring it into
the selected slot or settling the new chat key.

An Active on-chain note with no broadcast or ambiguous wallet evidence remains
**Ready to withdraw**. Polling must not invent an escape challenge or require
block finality for a transaction that never existed. The same check repairs
older incorrectly labeled records. Unknown wallet responses retain their
claims and exact nonce across reloads; only canonical finalized resolution of
every attempt permits a fresh proof. Successful returns retain private recovery
material until finality, then remove it while preserving a metadata-only audit.
If a page closes during the new driver's preflight, before any wallet nonce has
been saved, history exposes **Cancel preparation**. That action atomically
invalidates the original claim, so its delayed nonce callback cannot broadcast.
It is never offered for a nonce-journaled request or an older driver that could
have submitted without journaling its nonce first.

For deterministic browser verification of these transitions, run:

```sh
npm run build:browser
node scripts/browser-withdrawal-recovery-server.mjs dist/browser 8878
```

Open `http://127.0.0.1:8878/funding/?zkapiMode=browser` in a fresh isolated browser
profile **without MetaMask**. This localhost-only harness installs synthetic
EIP-1193 and proof-worker boundaries before the real app loads; it keeps the
real IndexedDB, wallet state machine, transaction encoder, receipt decoder and
UI. It refuses real wallet providers and non-fixture notes, blocks external
connections, and is excluded from deployment artifacts.

Test mutual close → wallet rejection → Set aside → new balance → historical
withdrawal; hold/cancel the wallet request, close the modal and type, reload
during the request, and retry with the original nonce. Compare the current
note, pending deposit, chat lease and journal before/after every transition.
The history row must advance in place from preparing to waiting for MetaMask
to confirming, then show Returned. Repeat in light/dark themes. These tests
exercise recovery and UX with simulated transactions, not real-chain payments
or cryptographic proof verification.
