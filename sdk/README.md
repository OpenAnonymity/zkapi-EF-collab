# zkAPI browser SDK

`@openanonymity/zkapi-browser-sdk` owns the browser wallet, local proof worker,
private-note journal, short-lived key issuance and settlement, deposit/withdrawal
recovery, and public payment-history reconciliation. It has no OA Chat, UI,
model-catalog, or chat-storage dependency. The host owns chat and payment UI.

Install a reviewed immutable Git revision, or install its `npm pack` tarball.
No submodules, Rust compiler, setup ceremony, or npm publish step are needed to
consume this package. The public proving keys and WASM are included and hashed
in `sdk/assets/manifest.json`; these are public artifacts, not wallet secrets.

```js
import { configureBrowserSdk } from '@openanonymity/zkapi-browser-sdk';
import client from '@openanonymity/zkapi-browser-sdk/client';

configureBrowserSdk({
  configUrl: '/zkapi/browser-config.json',
  workerUrl: '/zkapi/assets/zkapiWasmWorker.js',
  // Optional: the host may preserve its explicit opt-in privacy proxy policy.
  transport: (url, init, hints) => hostTransport.fetch(url, init, hints)
});

// Initialize only when private payments are enabled. Importing creates no
// proof worker, network request, wallet connection, or wallet popup.
await client.init();
const unsubscribe = client.subscribe(snapshot => renderBalance(snapshot));
```

Configuration must precede the first initialization. Browser mode is the
default. An explicit `mode: 'auto'` preserves the former same-origin daemon
probe and `?zkapiMode=` override; `mode: 'daemon'` selects only the daemon.
The host config URL supplies the pinned network, vault, server signing keys,
proof hashes, and approved deployment manifest URLs. Runtime URL overrides
remain restricted to that allowlist. Configure the same-origin
`/zkapi-deployment/` rewrite for the chosen trusted deployment, as declared by
the bundled browser config. Private protocol and public manifest/config requests omit account credentials,
including through the same-origin deployment rewrite and optional daemon API. An injected transport
receives `credentials: 'omit'` and the existing `{ preferProxy: true }` hint and
must preserve that credential policy. Chat account cookies must never accompany
private proof or key issuance requests.
Never include note secrets, key values, proof bodies, or wallet transactions
in host logs.

In the host build:

```js
import { build } from 'esbuild';
import { buildBrowserSdkAssets } from '@openanonymity/zkapi-browser-sdk/build';

await buildBrowserSdkAssets({
  outDir: 'dist/zkapi',
  publicPath: '/zkapi/',
  network: 'sepolia', // or 'mainnet'
  build
});
```

The helper emits `browser-config.json`, `assets/zkapiWasmWorker.js`,
`wasm/zkapi_browser_bg.wasm`, `proofs/request.pk`, `proofs/withdrawal.pk`, and
`sdk-assets.json`. It verifies all source artifact hashes and both proving-key
pins before returning. The host supplies its esbuild implementation, controls
its CSP/rewrites, and hashes these emitted assets in its deployment manifest.
Proof downloads are verified again inside the worker. No private credentials
are required to build either network.

The SDK preserves the existing IndexedDB database, local/session storage keys,
Web Locks names, BroadcastChannel names, revision checks, journal migration,
and signed receipt handling. Hosting the same SDK on a different origin does
not transfer browser wallet data. A model adapter must select one of
`CHAT_SPENDING_TIER_USD` (`1`, `2`, `3`, `4.5`, `6`) without disclosing the user's
exact balance. The SDK settles/rekeys when a selected cap changes; only actual
usage is charged. Expiry and withdrawal contract behavior are unchanged.

Run `npm run test:sdk` in this checkout. For an installed package, run
`node --test node_modules/@openanonymity/zkapi-browser-sdk/sdk/test/*.test.mjs`
from a host that provides esbuild as a development dependency. The tests use
local fixtures and do not connect a wallet or broadcast transactions.
