# OA Chat upstream UI

The daemon UI vendors the open-source [OA Chat](https://github.com/OpenAnonymity/oa-chat) client so OA users get the same application, layout, and interaction patterns.

- Upstream commit: `420e4cb0e68cbd2dfe44fd7c93274fbc327a040e`
- License: MIT; see `OA_CHAT_LICENSE`
- Vendored source: the pinned upstream `chat/` tree, including its components,
  local chat database, fonts, Markdown/KaTeX/highlight assets, styles, and shell
- zkAPI adapter surfaces:
  - `services/zkapiClient.js` for daemon state and MetaMask note lifecycle
  - `services/inference/backends/zkapiBackend.js` and `api.js` for session-bound inference
  - `components/AccountModal.js`, `components/WelcomePanel.js`, and
    `components/RightPanel.js` where OA ticket/account UI becomes private balance UI
  - `zkapi.css` for the small set of payment-only styles built from OA design tokens
  - `wallet.js` for audited contract calldata and receipt codecs

The adapter replaces OA inference tickets and API-key acquisition with the local
zkAPI daemon. MetaMask is used only for deposits and withdrawals; note secrets
and chat history remain local. Optional OA services that require the separate
ticket system (memory and confidential scrubbing) stay disabled in this build.
