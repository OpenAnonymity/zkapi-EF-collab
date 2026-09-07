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
