# Ticket and zkAPI payment modes

The composed OA chat app offers **Tickets** and **zkAPI** in the top toolbar.
Balance and ticket counts appear in the System Panel, with its normal controls
for funding, balance details, and ticket management. The toolbar and composer
have no duplicate funding status. Detailed access preparation continues to
appear with the pending assistant response. The standard panel toggle keeps
these controls accessible when the panel is collapsed, including on mobile.
Selecting zkAPI checks the restored wallet and opens the funding dialog when
there is no private note, using the same funding/recovery check as Send.
Funded wallets stay in the chat. Closing the dialog keeps zkAPI selected;
it stays closed until another explicit funding action or send attempt.
The check runs after the payment choice is saved, and a late wallet result
cannot open it over another chat or a subsequent payment selection. Wallet
loading errors report that the mode changed but the balance could not be
checked, rather than treating an unknown wallet as unfunded. Panel actions and
send preflight also open the dialog and return focus to their initiating control.

Balance details has no manual settlement card or button. Withdrawing automatically
settles any active chat key and waits for an in-progress settlement before preparing
the wallet transaction.

Balance details links to **Payment history**, combining deposits, withdrawals, and expiry events
in one list with amounts, status, dates, and transaction links when known.
Pending deposits remain visibly unconfirmed and link to their existing recovery
flow. Withdrawal checks, finalization, and recovery actions remain available in
the same history view. The list is local to this browser and deployment.

The browser wallet stores confirmed deposit metadata separately from the active
note so closing, withdrawing, or replacing a balance does not erase the deposit.
Confirmation records and the confirmed wallet state are saved atomically.
Existing notes, withdrawal-held notes, and archived notes contribute recoverable
older deposits using their original deposit amount. Missing historical dates
and transaction hashes remain unknown; history does not infer them from a later
withdrawal. Private note
secrets, proofs, and recovery payloads are excluded from history records.

The question mark beside **Private balance** explains billing, matching the
ticket help pattern. The separate question mark beside the expiry countdown
explains the note deadline. Both controls support keyboard use and preserve
their open state across background balance updates; clock ticks update text
without replacing the controls.

Expiry does **not** automatically refund unused funds in the deployed protocol.
Both trial vaults report a 30-day `noteTtl`; the contract rounds the deadline up
to the next UTC day, so a deposit lasts 30–31 days. This is independent of the
five-minute temporary chat key. `ZkApiVault.claimExpired` requires an explicit
transaction after the deadline while the note is Active. It closes the note,
pays the **entire original deposit** to the service treasury, and emits
`ExpiredClaimed`. The note contains no original depositor/refund address.
The clock alone does not move funds. A mutual withdrawal or finalized escape
instead pays the proven remaining amount to its chosen, proof-bound destination
and the used amount to the treasury. An expired but unclaimed Active note can
still be withdrawn if that transaction wins before an expiry claim; an already
pending escape cannot be expiry-claimed. These semantics were checked in the
deployed-source contract revision and the current pin, plus public read-only
getters on both live vaults. No contract or treasury automation was changed.

Payment history records **Expiry deadline passed** locally without claiming a
transfer. A finalized, canonical `ExpiredClaimed` event changes that entry to
**Expiry claim**, with the original amount, actual block date, and transaction
link; it explicitly says no refund was made. The reader scans all expiry events
for the public vault and validates public event blocks before matching notes
locally. No private note IDs appear in RPC filters or determine block requests.
Wrong-network, malformed-event, and finality failures do not advance the cursor.
Bounded scans resume on the next background check or **Check expiry payments**.
The saved claim and expiry metadata survive reload and note archival. A generic
Closed vault status is not proof of a withdrawal: history labels a payment
Returned only after a matching payout event was verified, and an expiry claim
supersedes the abandoned withdrawal row. Legacy closure with missing payout
evidence remains explicitly unverified.

A confirmed expiry claim shows zero available balance and removes withdrawal
actions. **Start a new balance** explicitly archives the claimed note while
preserving its private recovery material and payment history. An expired note
without a confirmed claim retains its amount and withdrawal option. Neither
expired nor claimed notes can open a new private inference request; ticket
access remains independent.

The System Panel shows an extra status card only while the previous chat is
closing. Completion removes it; ready and other states use the existing balance
badge, response progress, and recovery controls. Balance details omits the
network, request-mode, and vault-address rows. Token-add buttons are removed
from all funding and balance views; the Sepolia test-token mint control remains.

Both modes use the ordinary OA OpenRouter model catalog, display names, pinned
and disabled models, and selection defaults. Tickets show the normal ticket
cost; zkAPI shows USD per million input/output tokens, with exact per-token
rates in the pricing tooltip. Models without published token prices say
`Pricing unavailable` in zkAPI mode.

Model tiers also select a cumulative temporary-key cap and the minimum private
balance to prove for a new key. The reviewed mapping reuses staging OA's existing
child-key dollar budgets, rather than converting ticket counts to money:

| OA ticket tier | zkAPI key cap / minimum proof balance |
| --- | --- |
| 1, 2 | $1 |
| 3, 8 | $2 |
| 5 | $3 |
| 25 | $4.50 |
| 100 | $6 |

Tier 8 currently has no assigned models. Unknown ticket counts require an explicit
budget review and fail closed. The browser uses the same live model assignments,
`:online` normalization, and reasoning fallback as Tickets. New-key acquisition
waits for live OA tier configuration; cached data is display-only during an outage.
The picker shows the required balance as a concise badge such as `≥ $2`, using
the same right-aligned position and style as ticket counts. Its accessible
tooltip explains the minimum private balance; token rates remain below the model
name without an additional cap/minimum line. A cap is not a fee: settlement
deducts actual cumulative key usage. The System Panel shows the owned active
key's real cap, or the selected model's cap when no key is active.

Requests capture their selected model and reasoning mode before async access.
Titles retain their cheap helper model but share the initiating chat model's cap.
Only the coarse dollar cap reaches the wallet/protocol; model IDs, titles, and
prompts do not enter lease authorization. Auto Router uses its configured $2 cap;
response-model attribution changes usage estimates, not an existing key's budget.
Same-cap model changes reuse a live key. Changing caps settles the old key before
proving the new cap; requests in flight cannot be rekeyed. Insufficient balance
blocks a new key with the required amount and a lower-cap/funding explanation.
The product currently replaces a note by withdrawing and funding a larger one;
it does not silently treat existing-note top-ups as supported.

Durable pending proofs are retried byte-identically at their original bound.
If that bound differs from the next requested tier, recovery closes the old key,
installs its signed receipt, and then proves the new bound. Concurrent callers
can share issuance only for the same session and cap. Cancellation of one waiter
does not cancel another waiter's proof job. Key lifetime remains five minutes. This policy applies to the hosted browser-wallet
lease path; the legacy local daemon retains its server-configured budget.

Both live zkAPI servers already derive and enforce the exact cumulative key cap
from the verified solvency bound; the advertised $0.05 remains the server floor.
No proof circuit, trusted manifest, protocol database, contract, or vault changed.
Both servers use the existing production OA issuer while Tickets use staging OA.
On 2026-09-09 00:00:35 UTC, the production OA issuer's existing release `14dfb55`
was gracefully restarted after changing only `ZKAPI_MAX_CREDIT_USD` from 5 to 6.
The five-minute maximum, 120 requests/minute and $25/hour issuance budget remain
unchanged. The hourly budget counts issued key caps, not eventual usage. Isolated
validation using deployed source accepts each supported cap through $6 and rejects
higher limits, mismatched credits and excessive duration for issuance and usage.
Rollback may revert the client while retaining the $6 server maximum; lowering it
before outstanding $6 leases settle would reject their usage reconciliation.

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
Switching from zkAPI starts settlement of the captured chat's owned lease in
background and saves Tickets without waiting for wallet hydration or settlement.
Ticket access and responses proceed independently, even if settlement fails.
The ticket System Panel shows only a compact closing notice while it runs;
updates preserve the ticket controls and key display. A private retry must never
cancel work in a conversation that has since changed to Tickets.

The private runtime registers its retirement barrier synchronously, before
wallet hydration. Returning to zkAPI waits for that barrier; a durable
`zkapiSettleBeforeAccess` marker preserves the same requirement after reload.
Recovery settlement is scoped to the captured session and rechecks ownership
under the wallet lock, preserving another tab's newer lease. Settlement failures
retain wallet recovery state and diagnostics without reverting Tickets. Only a
failed session save keeps the previous selected method and default. An unowned
interrupted proof journal remains in the wallet recovery store and the next
private request recovers it normally.

Tickets keep OA's verified ticket-redemption path. zkAPI keeps its private proof
and verified ephemeral-key path. Credentials are cleared at a successful mode
change; they are never interpreted as the other method's credentials. Neither
path falls back to the other payment method on failure. Old sessions without a
backend resolve independently of the new-chat preference: ordinary OA history
uses Tickets, and explicit legacy zkAPI binding metadata identifies zkAPI.

Normal OA account, ticket import, invite redemption, and shared chat controls
remain available. Tickets mode retains the complete OA composer: Memory
auto-attach and its context editor, Privacy Scrubber, Parallel, and Council
review. Availability follows the current chat without changing saved global
preferences or removing historical multi-model responses.

The same controls explain their unavailability in zkAPI mode.
The scrubber shortcut area in the input stays empty in zkAPI mode and restores
its normal hint when switching back to Tickets. Memory retrieval
and background extraction, like the Privacy Scrubber, acquire separate Tinfoil
keys through ticket redemption; they cannot currently be paid from the zkAPI
balance. Parallel/Council also require multiple independent ephemeral keys.
Switching to zkAPI prevents these operations from spending tickets implicitly;
switching back to Tickets restores the user's choices. The shared standalone
OA app retains its normal feature defaults, and the legacy standalone zkAPI
shell retains its prior restricted interface.

The new Vercel app uses the browser wallet. A local daemon's legacy settlement
endpoint cannot atomically check the expected chat owner. Tickets selection can
still proceed, but returning to private access requires closing its old key in
the daemon. Mode switching never uses the unqualified endpoint to retire a
possibly different chat's key.

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

The composer restoration passed 602 OA tests, 276 client tests, and 10
composition tests. A subsequent one-line System Panel capability correction
passed all 10 focused panel tests. Fresh adversarial review approved both
changes. Regression coverage includes captured feature ownership, draft and
navigation races, stale memory approvals, older-history backfill persistence,
mode-switch draining, and historical Parallel lane regeneration.

Live Chrome checks restored the Tickets Memory switch, context editor,
Scrubber settings and shortcut, Parallel model pickers, and Council settings.
A real Parallel request returned `parallel-copper-29` independently from
GPT-4o-mini and GPT-4.1 Mini; both station verifications succeeded and the
ticket count changed from 11 to 9. Switching that historical chat to zkAPI
retained both responses and disabled Memory and Parallel with explanations.
Double-Tab left the synthetic draft unchanged and displayed `Scrubber needs
Tickets`. Returning to Tickets restored the remembered Memory/Parallel choices
and both selected models. Reload preserved the transcript and mode. The final
System Panel correctly shows one pending key in zkAPI and restores the Parallel
key rows in Tickets. Both network frontends passed UI capability switching.

The initial Scrubber live attempt found staging has no `TINFOIL_ADMIN_KEY`;
the org returned its service-unavailable response and rolled back the ticket.
The user then explicitly excluded live Tinfoil testing. Memory retrieval and
Scrubber inference therefore remain unverified against a live provider; their
UI and deterministic capability/ownership tests passed. No staging Tinfoil or
production configuration was changed. The synthetic local memory file was
removed. One eight-ticket staging invite was redeemed for these checks, and
its raw handoff files were removed; nine staging tickets remain in the Sepolia
trial browser. No mainnet wallet transactions were performed.

The funding-on-selection correction passed all 281 client and 10 composition
tests, followed by 31 focused runtime tests after the review's slow-navigation
guard. Live Chrome reproduced the old missing dialog, then verified the new
deployment opens it immediately after selecting zkAPI in both an empty view
and the existing unfunded `cedar-lark-23` chat. No Send action was needed.
Escape and Close kept zkAPI selected; reload preserved the historical answer
and mode without reopening the dismissed dialog. The funded Sepolia wallet
($4.96) stayed in chat on selection. Both pages had zero browser errors, and
both deployments passed all 153 asset hashes with no Vercel error logs.
Wallet connection, deposit, and Tinfoil inference were not invoked.

The payment-history and balance-cleanup release passed all 296 client tests
and 10 composition tests, plus a fresh independent review of persistence,
transaction rollback, operation deduplication, deployment isolation, withdrawal
recovery, and UI rendering. Confirmed deposit metadata uses browser wallet
schema version 3 and saves atomically with the private note.

Live Chrome checks on the deployed Sepolia app showed the original $5.00
deposit in Payment history while the remaining balance stayed $4.96. Reload
and reopening history retained the single deposit; its historical date and
transaction link remain unavailable because the earlier client did not save
them. The funded balance dialog has no token-add control or network,
request-mode, and vault-address rows. The System Panel retains its ordinary
balance badge with no extra ready card; active-closing visibility is covered
by the focused state/render tests.

The deployed mainnet app still opens funding automatically when its unfunded
historical chat switches to zkAPI. Payment history shows the empty state and
returns to funding through Back to balance; Add USDC to MetaMask is absent.
Both browser tabs loaded `assets/app-RQ5ACPPM.js`, reported zero browser
errors, and returned to Tickets after verification. The existing mainnet
transcript remained intact. This release's browser verification performed no
wallet transactions, inference requests, or Tinfoil calls.
All 153 published asset hashes matched on each trial app; health, catalog,
redirects, security headers, and Vercel error-log checks passed.

The background-settlement release passed all 308 client and 10 composition
tests. A fresh adversarial reviewer independently passed 45 focused tests and
approved the diff. Coverage includes slow wallet hydration, pending/failed
settlement, immediate ticket access, a rapid return to private access, recovery
after reload, failed mode persistence, and protecting a new ticket response
from an old private-key retry. Backend tests exercise the actual scoped
settlement call and the wallet's check against another chat's newer lease.

Live Chrome on Sepolia resumed the `blue-heron-62` conversation with a real
GPT-4o-mini zkAPI response. While its bounded key was still active, selecting
Tickets immediately showed Tickets selected, enabled payment controls and Send,
and the compact closing notice. Sending then redeemed one staging ticket and
returned `blue-heron-62` through a verified station while the closing notice was
still visible. Background settlement subsequently completed and removed the
notice without changing the ticket mode, key display, or response. Reload kept
both new responses and Tickets; eight staging tickets remain. An automatic
confidential-key request encountered the previously known staging service
unavailability; Tinfoil testing remains excluded and no credential was configured.

Both browser tabs loaded `assets/app-4N3VBW5W.js`. The mainnet UI retained its
existing transcript, opened funding when selecting zkAPI with no private note,
and switched back to Tickets normally; it reported no browser errors. Mainnet
wallet transactions were not performed. All 153 published assets on each trial
matched, both manifests and proof pins were verified, health/catalog and security
headers passed, and both Vercel error-log scans were empty.

## Billing help and expiry history verification — 2026-09-08

The expiry update passed 350 client tests and 10 composition tests, plus fresh
independent review and re-review of all fixes. Tests cover clock-only deadlines,
verified claim events, generic closure without payout evidence, preserved
recovery data, idempotent persistence, failed-storage retries, cursor resets,
wrong-network and finality failures, malformed events, and public RPC selection
independent of note ownership. Selected and replacement withdrawals reject a
saved claim before wallet prompts or replacement-plan mutations. No expiry
transaction was executed on either live vault; claim outcomes were tested with
deterministic RPC and storage fixtures.

Live Chrome loaded `assets/app-5V2N6KT5.js` on both final trial deployments.
On funded Sepolia, both System Panel question marks opened, expiry help worked
with Tab/Enter, and help stayed open through clock and semantic refreshes.
Balance details showed the same explanations and retained open state after
Refresh. Escape returned focus to the remounted Balance details button, including
a regression fixed after the initial browser check. The existing $5 deposit
history and conversation remained intact; no false expiry entry appeared for
the unexpired note. Mainnet selection with no balance opened funding, its
billing question mark worked, and switching back to Tickets preserved the
conversation. Both browser error scans were empty. No inference or wallet
transaction was needed for these help/history checks; live Tinfoil tests remain
skipped as requested.

All 153 published asset digests matched for each deployment. Both immutable
manifests, staging OA selection, deployment/proof pins, health/catalog endpoints,
security headers and root redirects passed. Both Vercel error scans were empty.
Only the two existing trial project aliases were updated; main and contracts
remain unchanged.

The subsequent scrubber hint cleanup passed 603 OA tests, 10 composition tests,
and independent review. Live Chrome verified `assets/app-VXHEVZ5C.js` on both
trial apps. zkAPI has empty hint text, a hidden hint, and no extra input spacing;
a short draft stays unchanged when switching to Tickets, which restores the
normal “tab tab to scrub” hint. The temporary test draft was cleared, and both
browser error scans were empty. No prompt or wallet transaction was submitted.

## Shared staging OA services

Both current trial builds explicitly pin `https://org-staging.openanonymity.ai`
with the composer's `--oa-org-origin` option. Their `build.json` records this
`oaOrgOrigin`; published runtime bundles contain the staging org origin and no
production OA org origin. The pinned client commit is
`fd1b0aee7ac7a930a2b5329413cec9361a427aa7`, and the shared OA commit is
`8e13e432fe6719e5cb9fe2bf2528b1da247f5189`. Both repositories remain on
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

## Sepolia trial deployment — 2026-09-08

- App: https://oa-chat-payment-modes.vercel.app/funding/
- Immutable deployment: https://oa-chat-payment-modes-3aa3nawy2-mingyech1.vercel.app/funding/
- Vercel project: `oa-chat-payment-modes` (`prj_WStqLQHKBCkuugdRkrJCT74PNoIi`)
- Deployment: `dpl_6J1h2KGUzcxAnBwejCxagXeNm7FA` (READY).
- Source and OA org: the shared staging pins above.
- Build fingerprint: `0035e57c7347b1f01c25d11744685be0793bf1dc24b1e686219ffe8c7de7f001`.
- Validation: model-tier, compact balance badge, and settlement UI checks are recorded below;
  fresh adversarial reviews approved both the access policy and panel refresh;
  all 153 published asset digests and immutable manifests matched.
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

## Mainnet trial deployment — 2026-09-08

- App: https://oa-chat-payment-modes-mainnet.vercel.app/funding/
- Immutable deployment: https://oa-chat-payment-modes-mainnet-m7dznikdn-mingyech1.vercel.app/funding/
- New project: `oa-chat-payment-modes-mainnet` (`prj_DtdCXeSJ9ZnGc0dYaso3CWTCCihm`).
- Deployment: `dpl_CdhmKvYVdkRp1W5hCs7Yw2hN3Lna` (READY).
- Source and OA org: the shared staging pins above.
- Build fingerprint: `58abc01e97108f8e8953b217f20810a628ee39b4c2a75af91707568df95d223f`.
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


## Model-tier cap verification — 2026-09-08

The model-tier release used `assets/app-BGU762LY.js`, parent commit
`abe7218a1d9253025ab759aabcb37c0a89c159ec`, and OA commit
`17547e02b3a78a828733efb8b6aaa60ee33a94c5`. Its final full suites passed:
363 client tests, 607 OA tests, and 10
composition tests. Fresh adversarial review approved the proof/issuance/recovery/checkout
changes, then independently approved the model-selection panel refresh fix.
The checkout regression covers retirement starting between lease resolution and
credential checkout; the UI regression drives a real picker selection and verifies
the existing panel label refreshes without remounting controls.

Live Chrome computer-use tests on Sepolia used the existing private balance:

- Selecting GPT-6 Astra Pro showed the $6 cap/minimum and blocked Send against
  a $4.95 balance, preserving the draft and transcript and issuing no key.
- An Auto Router $2 key returned the existing `blue-heron-62` marker. Its
  response was attributed to DeepSeek V4 Flash 0731 and estimated at that rate.
- The same chat upgraded to GPT-6 Astra ($4.50), then downgraded to GPT-4o-mini
  ($1). Each old key settled before the new cap was proved; both responses
  returned the original marker and history remained in the same conversation.
- A new Claude Opus 5 chat ($3) returned `cedar-tier-37` and generated its title,
  proving title and main response share the initiating model's budget.
- Switching that chat to Tickets returned immediately during settlement; its
  composer could send and normal memory controls were available. No Tinfoil
  request was performed. Eight staging tickets remain.
- Read-only station database checks confirmed all four keys were actually
  issued at $2/$4.50/$1/$3 with five-minute lifetimes, then finalized with the
  same caps. Signed actual usage was 7,323/61,293/7,475/15,704 credits respectively
  at 1,000,000 credits per dollar. The test balance finished at about $4.86;
  no new deposit or withdrawal transaction was needed.
- The final deployed UI immediately changed the historical chat's panel from
  $1 to $6 before Send. At 390×844, cap/minimum and token-rate rows were readable
  without clipping; the temporary viewport was reset. The original Mini model
  and `explain https` draft were restored after testing.

Mainnet Chrome loaded the same final app bundle. Switching to zkAPI on its
unfunded wallet opened the mainnet funding popup. The model picker showed all
five dollar caps and their minimums; switching back restored normal ticket
counts, with no dollar-budget rows. The existing transcript and one staging
ticket remain. Mainnet was checked without connecting a wallet or transacting.
Both browser error scans and both Vercel error scans were empty. Both published
builds passed all 153 asset hashes, immutable manifests, health/config/catalog,
security headers and trusted network/proof pins. Temporary Vercel environment
files were removed from final and superseded deployment stages.

## Compact minimum balance badges — 2026-09-08

The compact badge release used `assets/app-PJK33ZRW.js`. The model picker places the
private minimum in the same position and CSS classes as the ticket badge,
showing `≥ $1`, `≥ $2`, `≥ $3`, `≥ $4.50`, or `≥ $6`. The extra cap/minimum
line was removed; token pricing remains beneath the model name. Hover and
accessible labels explain that this is the balance required for a new key
and only actual usage is deducted. Proof, issuance, and settlement behavior
are unchanged by this presentation update.

All 65 focused picker, UX-render, and payment-catalog tests passed. A fresh
review approved the final badge rendering, escaping, and preserved ticket
behavior. Chrome computer-use checks on both deployed trials confirmed all
five badge values, no former budget rows, and no browser errors. Sepolia was
also inspected at 390×844, then its viewport, Mini selection, and `explain https`
draft were restored. Mainnet's unfunded zkAPI selection opened funding;
switching back to Tickets restored numeric ticket badges and preserved the
existing transcript, Mini selection, and empty draft. These checks performed
no new inference or wallet transactions.

Both deployments passed all 153 asset hashes, protected immutable manifests,
config/health/catalog checks, security headers, and network/proof pins. Both
Vercel error scans were empty. Temporary deployment environment handoffs
were removed.


## Automatic withdrawal settlement UI — 2026-09-08

Both current trials use `assets/app-W3GZG7IX.js`. Balance details no longer
shows the manual settlement card, countdown, or button. Its unused click
handler and countdown updater were removed. Withdrawal still awaits the
active lease settlement (including retirement already in progress) before
opening the wallet or preparing the withdrawal proof; no runtime or server
change was needed.

All 73 focused wallet and UX-render checks passed, and an independent review
approved the removal and confirmed the existing settlement ordering. Chrome
computer-use checks on Sepolia verified the simplified funded balance dialog
and its working Withdraw navigation. Mainnet loaded the same bundle and its
unfunded zkAPI selection opened funding normally. Browser errors were empty;
original modes, models, transcripts, and drafts were preserved. No new
inference, withdrawal, or wallet transaction was performed for this UI change.

Both deployments passed all 153 published asset hashes, protected immutable
manifests, config/health/catalog checks, security headers, and network/proof
pins. Both Vercel error scans were empty and temporary environment handoffs
were removed. All changes remain on the feature branch; main is unchanged.
