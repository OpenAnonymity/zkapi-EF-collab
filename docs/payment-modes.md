# Ticket and zkAPI payment modes

The composed OA chat app offers **Tickets** and **zkAPI** in the top toolbar.
The adjacent control opens ticket management or the private balance. The
composer has no duplicate funding/progress status. Detailed access preparation
continues to appear with the pending assistant response.

A selection changes the current chat and the default for subsequent new chats.
Historical sessions retain their own `inferenceBackend`. Both methods use the
same OA IndexedDB database, session records, messages, imports, and account sync;
there is no payment-specific transcript store or transcript migration. A new
Vercel origin has separate browser storage, so it cannot automatically read
history or wallets from an older deployment's origin. Existing OA chat import
and export remain available.

Switching is disabled while the selected chat has a response, access request,
title, or timeline mutation in progress. Stop or finish that operation first.
Switching from zkAPI settles the captured chat's owned lease before the backend
change is saved. The wallet checks ownership again under its lock to preserve
another tab's newer lease. A failed settlement or save retains the current mode
and history. An unowned interrupted proof journal remains in the existing
wallet recovery store. The next private request recovers it normally.

Tickets keep OA's verified ticket-redemption path. zkAPI keeps its private proof
and verified ephemeral-key path. Credentials are cleared at a successful mode
change; they are never interpreted as the other method's credentials. Neither
path falls back to the other payment method on failure. Old sessions without a
backend resolve independently of the new-chat preference: ordinary OA history
uses Tickets, and explicit legacy zkAPI binding metadata identifies zkAPI.

Normal OA account, ticket import, invite redemption, and shared chat controls
remain available. This composed trial retains the existing zkAPI feature scope:
Memory, Scrubber, and Council are disabled in both modes. The standalone OA app
retains its normal feature defaults.

The new Vercel app uses the browser wallet. A local daemon with an active key
must close that key before switching methods, because its legacy settlement
endpoint cannot atomically check the expected chat owner. Mode switching never
uses that unqualified endpoint to retire a possibly different chat's key.

## Verification

- `npm test`: wallet, runtime, UI behavior, and deterministic composition checks.
- `(cd oa-chat && npm test)`: shared chat lifecycle, storage ownership, ticket
  access, catalog selection, and backend-switch regression tests.
- `node scripts/payment-modes.e2e.mjs`: actual composed browser app, controller,
  IndexedDB, SSE parser and UI, with explicitly simulated external ticket,
  verifier, wallet, and provider boundaries. Use `--url` to run the same test
  against a deployed app in a fresh isolated browser context.

The browser matrix covers both switch directions on the same transcript,
remembered new-chat choice, historical resume, reload, busy-state prevention,
mobile layout, and absence of duplicate composer status. Test fixtures are not
published and do not reuse a person's browser profile, wallet, or tickets.
The simulated run does not certify a live payment or provider response. The
additional live Sepolia browser runs below cover funding, private access,
ticket redemption, verified provider responses in both modes, settlement, and
transcript continuity. Mainnet funding and wallet transactions remain untested.

## Shared staging OA services

Both current trial builds explicitly pin `https://org-staging.openanonymity.ai`
with the composer's `--oa-org-origin` option. Their `build.json` records this
`oaOrgOrigin`; published runtime bundles contain the staging org origin and no
production OA org origin. The pinned client commit is
`02c7d8580b3554562911dced062bbfd91a2df605`, and the shared OA commit is
`121876ec774f0a5cac8ff078a8aeb622df11a773`. Both repositories remain on
`codex/unified-chat-payment-modes`; main is unchanged.

The existing staging services run oa-org
`7e867ae28ed2e01cd31a0fcb8ed30fe2334b63ba` and station
`67d9d3afeec4d48a19fbcdfe1f2f40924b9334e1`. The only added origins in
`WEBAUTHN_ORIGIN` and `GOOGLE_OAUTH_RETURN_ORIGINS` are:

- `https://oa-chat-payment-modes.vercel.app`
- `https://oa-chat-payment-modes-mainnet.vercel.app`

Existing entries are preserved; immutable Vercel deployment origins were not
added. `RP_ID` remains `staging.openanonymity.ai`. Passkey related-origin
compatibility is untested, and no OAuth client or consent configuration was
changed. Public staging model and ticket-issuer endpoints allow the trial
origins through CORS. No invite codes or other credentials are recorded here.

The OA org selection does not change the network-specific zkAPI vault,
deployment manifest, proof keys, or verifier pins. The mainnet configuration
and proof assets retain their prior digests.

## Sepolia trial deployment — 2026-09-06

- App: https://oa-chat-payment-modes.vercel.app/funding/
- Immutable deployment: https://oa-chat-payment-modes-7c4rvb7ea-mingyech1.vercel.app/funding/
- Vercel project: `oa-chat-payment-modes` (`prj_WStqLQHKBCkuugdRkrJCT74PNoIi`)
- Deployment: `dpl_BptW9RG3MDfLMY9pkhHBxGZGr14q` (READY).
- Source and OA org: the shared staging pins above.
- Build fingerprint: `4a1ddc4ea0a6a48386ab75285b55091fcedaf8ac7b4c60997d49f3611608c06b`.
- Validation: 555 OA tests, 258 client tests, 10 composition tests passed;
  fresh adversarial review approved; all 153 published asset digests matched.
- The earlier six-scenario browser E2E run passed with simulated external
  ticket, verifier, wallet, and provider boundaries and zero uncaught
  application errors. These results are separate from the live tests below.
- Live Chrome/MetaMask test: minted and deposited 5 Sepolia test
  billing tokens, obtained a private ephemeral key, and received a real
  GPT-4o-mini response containing the expected conversation marker. The
  verifier panel reported a verified JWT signature and matching hardware policy.
- Switched that chat to Tickets, observed successful key settlement, and
  preserved its transcript. With zero tickets, sending retained the draft and
  reported that one ticket was required. There was no automatic zkAPI fallback.
- Verified new-chat defaults in both modes, historical mode selection, and
  transcript persistence after reload. Switched back to zkAPI, obtained fresh
  access, and received the original marker from a real follow-up response.
- On the current staging-OA deployment, redeemed one fresh staging invite
  through the normal UI and resumed that same historical chat in Tickets mode.
  Its ticket count changed from 1 to 0, the real station verified, and
  GPT-4o-mini returned the original marker `amber-otter-47`. Switching the chat
  back to zkAPI succeeded with `amber-otter-47` and its transcript intact.
- MetaMask displayed a malicious-site warning on the new Vercel origin. The
  user explicitly authorized acknowledgement for the Sepolia test. Token and
  spender matched the pinned test deployment; wallet protections were not
  disabled. No mainnet wallet transaction was performed.
- The initial funded flow ran on client `9b77b2e`. Subsequent updates corrected
  shared verifier explanatory copy and pinned the staging OA org. Browser
  checks retained the saved responses and test balance across those updates.
- A fresh chat inherited Tickets mode and received the exact marker
  `blue-heron-62` from a real GPT-4o-mini response, consuming one staging
  ticket. Switched that chat to zkAPI, reloaded, and sent a follow-up asking
  for the earlier marker without repeating it. The real zkAPI response
  returned `blue-heron-62`; both messages and the selected mode persisted.
  Starting another chat inherited zkAPI and settled the completed key.
  Reopening the two historical chats restored Tickets and zkAPI respectively,
  with both transcripts intact. Three staging tickets and about 4.97 test
  billing tokens remain in this browser's Sepolia trial storage.

This project is a separate explicit static deployment with no Git connection.
To redeploy, compose the pinned browser sources with
`--oa-org-origin https://org-staging.openanonymity.ai`, copy only `dist/browser`
to a fresh staging directory's `public` folder, use `vercel.browser.json` with
empty install/build commands and `outputDirectory: public`, link this exact
project, and run `vercel build --prod` followed by
`vercel deploy --prebuilt --prod`. A default build without the explicit org
selection would restore the production OA org and is not this trial's artifact.

## Mainnet trial deployment — 2026-09-06

- App: https://oa-chat-payment-modes-mainnet.vercel.app/funding/
- Immutable deployment: https://oa-chat-payment-modes-mainnet-q5url0dgq-mingyech1.vercel.app/funding/
- New project: `oa-chat-payment-modes-mainnet` (`prj_DtdCXeSJ9ZnGc0dYaso3CWTCCihm`).
- Deployment: `dpl_9UoobVMU5rQugVNLRovo9gAYZABt` (READY).
- Source and OA org: the shared staging pins above.
- Build fingerprint: `2902c6e5cf8da654300a2ca464448e1563d6639953b99b43af1435b98e539466`.
- All 153 published assets matched. HTML, config, proxied deployment config,
  health, model catalog, root redirect, and security headers passed. Trusted
  pins match the existing chain 1 deployment. Vercel error scan found no logs.
- Staging `/chat/pinned-models` and `/api/ticket/issue/public-key` returned HTTP
  200 and allowed the exact mainnet trial origin through CORS.
- Earlier Chrome UI checks passed: both payment controls, normal ticket
  management, zkAPI catalog, mode persistence across reload, and the mainnet
  funding screen identifying real USDC and Ethereum gas. The composer has no
  duplicate payment status.
- Live ticket-only test on the current mainnet frontend passed: redeemed a
  fresh two-ticket staging invite, obtained a verified ephemeral key, and
  received `13` from a real GPT-4o-mini response to `9 + 4`. The ticket count
  changed from 2 to 1, and the timeline reported verified station integrity.
  Reload preserved the transcript, Tickets selection, the same key, and the
  remaining ticket. This test performed no Ethereum or wallet action.
- All three task-created staging invites were confirmed redeemed. Temporary
  local and remote raw invite handoff files were removed; the staging ledger
  and remaining browser tickets were preserved.
- Mainnet funding and wallet transactions remain untested; no mainnet wallet
  connection or transaction was requested during verification.

This is a new standalone static Vercel project with no Git connection. The
existing `oa-zkapi-composed-mainnet` app was not changed, and its prior build
fingerprint was verified unchanged. This frontend uses the existing
experimental, unaudited mainnet vault; deploying it adds no contracts. Redeploy
its explicitly selected mainnet/staging-OA artifact from `dist/browser-mainnet`
using `vercel.mainnet.json` and the same isolated static deployment procedure.
