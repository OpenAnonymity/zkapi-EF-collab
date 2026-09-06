# OA Chat upstream UI

The browser and daemon compose the open-source [OA Chat](https://github.com/OpenAnonymity/oa-chat) client through the pinned `oa-chat` Git submodule.

- Upstream commit: the parent repository's `oa-chat` gitlink. The matching
  `browser-sources.lock.json` records provenance in source archives without Git.
- License: MIT; see `OA_CHAT_LICENSE`
- Shared source: `oa-chat/chat/`, including the controller, components, local
  chat database, fonts, vendor assets, styles, shell and streaming transport.
  No copies of those implementations remain in this directory.
- Composition entry: `zkapi-entry.js`, using public OA entry/runtime/UI APIs.
- zkAPI adapter surfaces:
  - `services/zkapiClient.js` for daemon state, MetaMask note lifecycle, and
    session-bound ephemeral-key checkout
  - `services/inference/backends/zkapiBackend.js` for zkAPI access binding;
    `api.js` specializes model policy/access acquisition while inheriting OA's
    direct streaming transport through `publicInferenceApi.js`
  - `components/AccountModal.js`, `components/WelcomePanel.js`, and
    `components/RightPanel.js` where OA ticket/account UI becomes private balance UI
  - `zkapi.css` for the small set of payment-only styles built from OA design tokens
  - `wallet.js` for contract calldata and receipt codecs

The adapter replaces OA inference tickets and API-key acquisition with zkAPI's
client runtime (browser WASM on the hosted build, or the local daemon). MetaMask
is used only for deposits and withdrawals; note secrets and chat history remain
local. Optional OA services that require the separate
ticket system (memory and confidential scrubbing) stay disabled in this build.
OA passkey accounts and account sync are not initialized or exposed; the only
account-like surface is the replacement **Private balance** payment panel.
