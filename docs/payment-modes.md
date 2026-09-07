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
A live funded cryptographic end-to-end run additionally needs a dedicated
Sepolia wallet and expendable valid OA tickets; the simulated run does not
certify a live payment or provider response.

## Sepolia trial deployment — 2026-09-06

- App: https://oa-chat-payment-modes.vercel.app/funding/
- Immutable deployment: https://oa-chat-payment-modes-4tf3kad08-mingyech1.vercel.app/funding/
- Vercel project: `oa-chat-payment-modes` (`prj_WStqLQHKBCkuugdRkrJCT74PNoIi`)
- Deployed client commit: `9b77b2e` in zkapi-EF-collab.
- Deployed shared OA commit: `a230c64e613392a1b7bfab37e7ec1abc060d7c6e`.
- Both repositories: `codex/unified-chat-payment-modes`; main unchanged.
- Build fingerprint: `dd39102cd53d5e330a5a8c548bd63b6cb98577a30c499d0085899f0952832e56`.
- Validation: 555 OA tests, 258 client tests, 8 composition tests passed;
  fresh adversarial review approved; all 153 published asset digests matched.
- All six browser E2E scenarios passed on the deployed URL with zero uncaught
  application errors. Live unmodified browser startup loaded both catalogs,
  the browser wallet initialized on Sepolia, and deployment health/config/model
  rewrites returned HTTP 200. The Vercel runtime error scan returned no logs
  (the frontend is static).
- Full funded live payment/provider completion remains unverified pending a
  dedicated Sepolia test wallet and expendable valid OA tickets. Existing user
  notes and named tester ticket inventory were left untouched.

This project is a separate explicit static deployment with no Git connection.
To redeploy, build the pinned browser sources, copy only `dist/browser` to a
fresh staging directory's `public` folder, use `vercel.browser.json` with empty
install/build commands and `outputDirectory: public`, link this exact project,
and run `vercel build --prod` followed by `vercel deploy --prebuilt --prod`.
