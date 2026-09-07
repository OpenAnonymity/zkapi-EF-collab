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
additional live Sepolia browser run below covers funding, private access,
provider responses, settlement, and transcript continuity. A positive live
ticket-redemption/provider run still needs an expendable valid OA ticket code.

## Sepolia trial deployment — 2026-09-06

- App: https://oa-chat-payment-modes.vercel.app/funding/
- Immutable deployment: https://oa-chat-payment-modes-ced0t1m4e-mingyech1.vercel.app/funding/
- Vercel project: `oa-chat-payment-modes` (`prj_WStqLQHKBCkuugdRkrJCT74PNoIi`)
- Deployment: `dpl_AuURfvrd34oWLYxci1qScURs6qw7` (READY).
- Deployed client commit: `fb46f36e7977d25d1a7cdf96785c1e4f6ac06aad`.
- Deployed shared OA commit: `121876ec774f0a5cac8ff078a8aeb622df11a773`.
- Both repositories: `codex/unified-chat-payment-modes`; main unchanged.
- Build fingerprint: `20b224bf9ff2707acf29228cbdea99e22c9bae21244022470c2397935b301342`.
- Validation: 555 OA tests, 258 client tests, 8 composition tests passed;
  fresh adversarial review approved; all 153 published asset digests matched.
- All six browser E2E scenarios passed on the deployed URL with zero uncaught
  application errors. Live unmodified browser startup loaded both catalogs,
  the browser wallet initialized on Sepolia, and deployment health/config/model
  rewrites returned HTTP 200. The Vercel runtime error scan returned no logs
  (the frontend is static).
- Additional live Chrome/MetaMask test: minted and deposited 5 Sepolia test
  billing tokens, obtained a private ephemeral key, and received a real
  GPT-4o-mini response containing the expected conversation marker. The
  verifier panel reported a verified JWT signature and matching hardware policy.
- Switched that chat to Tickets, observed successful key settlement, and
  preserved its transcript. With zero tickets, sending retained the draft and
  reported that one ticket was required. There was no automatic zkAPI fallback.
- Verified new-chat defaults in both modes, historical mode selection, and
  transcript persistence after reload. Switched back to zkAPI, obtained fresh
  access, and received the original marker from a real follow-up response.
- The live positive ticket-funded response remains unverified: this origin has
  no tickets, no expendable code was supplied, and public free issuance reports
  `FREE_ACCESS_DISABLED`. Named tester ticket inventory was left untouched.
- MetaMask displayed a malicious-site warning on the new Vercel origin. The
  user explicitly authorized acknowledgement for the Sepolia test. Token and
  spender matched the pinned test deployment; wallet protections were not
  disabled. No mainnet wallet transaction was performed.
- The funded flow ran on client `9b77b2e`; the final update changes shared
  verifier explanatory copy only. After updating, browser checks confirmed
  the revised copy, both saved responses, and the remaining test balance.
  The refreshed deployment's 153 asset digests and public routes passed;
  the new OA revision passed 555 tests and composition passed 8 tests.

This project is a separate explicit static deployment with no Git connection.
To redeploy, build the pinned browser sources, copy only `dist/browser` to a
fresh staging directory's `public` folder, use `vercel.browser.json` with empty
install/build commands and `outputDirectory: public`, link this exact project,
and run `vercel build --prod` followed by `vercel deploy --prebuilt --prod`.

## Mainnet trial deployment — 2026-09-06

- App: https://oa-chat-payment-modes-mainnet.vercel.app/funding/
- Immutable deployment: https://oa-chat-payment-modes-mainnet-ic4i7zoiu-mingyech1.vercel.app/funding/
- New project: `oa-chat-payment-modes-mainnet` (`prj_DtdCXeSJ9ZnGc0dYaso3CWTCCihm`).
- Deployment: `dpl_DWyR4fKviR35vt2sxG7onUgeTYnh` (READY).
- Source: the same client/OA commits as the refreshed Sepolia deployment above.
- Build fingerprint: `3b45312a0d309d7fc85d072f7ef7847b111290ec2b978b9a22179d7d1b5f7fec`.
- All 153 published assets matched. HTML, config, proxied deployment config,
  health, model catalog, root redirect, and security headers passed. Trusted
  pins match the existing chain 1 deployment. Vercel error scan found no logs.
- Actual Chrome UI checks passed: both payment controls, normal ticket
  management, zkAPI catalog, mode persistence across reload, and the mainnet
  funding screen identifying real USDC and Ethereum gas. The composer has no
  duplicate payment status. No mainnet wallet connection or transaction was
  requested during verification.

This is a new standalone static Vercel project with no Git connection. The
existing `oa-zkapi-composed-mainnet` app was not changed, and its prior build
fingerprint was verified unchanged. This frontend uses the existing
experimental, unaudited mainnet vault; deploying it adds no contracts. The live
ticket-funded verification limitation above applies to both network builds.
