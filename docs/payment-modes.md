# Ticket and zkAPI payment modes

The composed OA chat app offers **Tickets** and **zkAPI** in the top toolbar.
Balance and ticket counts appear in the System Panel, with its normal controls
for funding, balance details, and ticket management. The toolbar and composer
have no duplicate funding status. Detailed access preparation continues to
appear with the pending assistant response. The standard panel toggle keeps
these controls accessible when the panel is collapsed, including on mobile.
The private-balance modal has no toolbar trigger; panel actions and send
preflight still open it and return focus to their initiating control.

Both modes use the ordinary OA OpenRouter model catalog, display names, pinned
and disabled models, and selection defaults. Tickets show the normal ticket
cost; zkAPI shows USD per million input/output tokens, with exact per-token
rates in the pricing tooltip. Models without published token prices say
`Pricing unavailable` in zkAPI mode.

Auto Router remains the chat's selected model, while each response displays
the concrete model returned by OpenRouter. The System Panel's usage estimate
uses that returned model's input/output rates, including exact priced variants.
Late model metadata reprices the existing preview without resetting tokens;
stopped partial responses retain the corrected estimate. An unknown returned
model has no local price instead of inheriting Auto Router's placeholder rate.
OpenRouter's reported `usage.cost`, including zero, takes precedence over the
token estimate. Saved usage retains its response-time price across reloads;
older estimates are not retroactively recalculated. Private balance settlement
still uses the authoritative key usage, independently of this display estimate.

The combined runtime injects the shared catalog into its zkAPI request adapter.
It reads the same OpenRouter cache immediately and uses the same refresh and
offline fallback as Tickets, without waiting for the wallet or narrowing the
list to the deployment manifest. Old zkAPI-only catalog caches do not govern
the combined picker. Shared pricing and provider output limits also inform
zkAPI's existing request budget, preserving exact model-variant prices.
Standalone/legacy zkAPI runtimes retain their configured catalog because they
may use a local echo or non-OpenRouter provider. The hosted direct lease binds
the spending limit and lifetime, not a model allowlist; this catalog change
does not alter contracts, proofs, key issuance, or verifier checks.

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

The Auto Router correction merges OA main `e8dad48` and adds response-pricing
regressions. All 586 OA tests, 275 client tests, and 10 composition tests pass.
A fresh adversarial review approved the final diff. Focused tests exercise the
actual zkAPI SSE adapter, shared controller, usage ledger, both final writes,
saved-session reload and recovery from message metadata. They cover missing
provider cost, explicit zero/positive cost, exact model variants, unknown
pricing, late attribution, cancellation, and sparse final metadata. These
deterministic tests simulate access and provider boundaries, with no wallet
transactions.

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

The shared-catalog correction adds six regression tests for common model
configuration, full live/cache parity, ignored stale single-model zkAPI cache,
wallet-independent catalog loading, exact variant pricing/budget metadata, and
the unchanged standalone catalog. A fresh adversarial review passed all 38
focused catalog, runtime, pricing, and lifecycle tests.

Live Chrome verification on both updated trial apps found 375 selectable model
rows with identical names and ordering across modes. Sepolia fetched the public
OpenRouter catalog with HTTP 200 and without a disk-cache hit; no browser or
catalog errors were recorded. GPT-4.1 Mini displayed 1 ticket in Tickets mode
and `$0.4/M input · $1.6/M output` in zkAPI mode. Selecting it in Tickets mode
and switching to zkAPI retained that selection. This model is absent from the
old eight-entry zkAPI manifest, and a real Sepolia zkAPI continuation returned
the earlier `blue-heron-62` marker. Its key subsequently settled successfully.
Mainnet catalog and price parity were checked without wallet transactions.

The subsequent toolbar cleanup removes the balance/ticket pill in both modes.
The existing 264 client and 10 composition tests passed, and a fresh review
confirmed the independent System Panel and send-preflight modal paths remain
available. Live Chrome checks verified the absent pill, retained mode switch,
panel collapse/reopen, balance-dialog opening, Escape dismissal, and focus
return to the panel's Balance details button. No inference or wallet mutation
was needed to validate this presentation change.

On the routed-pricing release, a live Sepolia zkAPI continuation selected
Auto Router and received the saved `blue-heron-62` marker from DeepSeek V4
Flash 0731. The composer retained Auto Router. The System Panel updated from
3,761 input / 12 output tokens and $0.007724 to 6,446 input / 52 output tokens
and $0.016 for the chat. Reload preserved the concrete response attribution,
selected router, transcript, and estimate. Deterministic tests above verify
exact fallback arithmetic when the provider omits cost; this live response
checks the provider path and rendered persistence. Both current trial apps
loaded the new bundle with no browser errors. All 153 asset digests matched
on each deployment, and neither Vercel error scan returned logs. Mainnet UI
verification retained the existing ticket-mode transcript; no mainnet wallet
connection or transaction was performed.

## Shared staging OA services

Both current trial builds explicitly pin `https://org-staging.openanonymity.ai`
with the composer's `--oa-org-origin` option. Their `build.json` records this
`oaOrgOrigin`; published runtime bundles contain the staging org origin and no
production OA org origin. The pinned client commit is
`b3cb9f2fff91877caed9168a712606f0aec4834d`, and the shared OA commit is
`faefd10157356955d90affda4215f6c4cbf93a8d`. Both repositories remain on
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
- Immutable deployment: https://oa-chat-payment-modes-q25gm1irx-mingyech1.vercel.app/funding/
- Vercel project: `oa-chat-payment-modes` (`prj_WStqLQHKBCkuugdRkrJCT74PNoIi`)
- Deployment: `dpl_GoaHxrbLKze8cKTYFiKi5MMhHED4` (READY).
- Source and OA org: the shared staging pins above.
- Build fingerprint: `a4a1082fcdbdff6c2af5a0f84105f853b947fac85f702fff09dfee5b62cc9938`.
- Validation: 586 OA tests, 275 client tests, 10 composition tests passed;
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
- Immutable deployment: https://oa-chat-payment-modes-mainnet-mf5ykwvye-mingyech1.vercel.app/funding/
- New project: `oa-chat-payment-modes-mainnet` (`prj_DtdCXeSJ9ZnGc0dYaso3CWTCCihm`).
- Deployment: `dpl_AAAUsh6zfdiqi2918jrvGjKBpM9j` (READY).
- Source and OA org: the shared staging pins above.
- Build fingerprint: `b39772c195a44bc6dbdc368af51083daadd79479f06bd52da4cb24ad7f134b12`.
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
