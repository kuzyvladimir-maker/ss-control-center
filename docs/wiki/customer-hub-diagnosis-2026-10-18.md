# Customer Hub — live diagnosis (2026-10-18, topic 42)

Companion to [[customer-hub-autopilot-architecture]]. Numbers are read from
the live Turso DB and SP-API on 2026-10-18; nothing was sent to buyers.

## Live state

| Fact | Value |
|---|---|
| BuyerMessage rows | 356 — Amazon 27 (store1 26, store5 1), Walmart 329 (CANCEL/RETURN API events, all `NEW`) |
| Amazon messages range | 2026-04-11 → 2026-10-18; only 12 in the last 14 days, 11 with an AI draft |
| Status (all) | NEW 329, ANALYZED 9, SENT 15, RESOLVED 3 |
| How "SENT" happened | all 15 = `SELLER_CENTRAL` (owner pasted by hand, marked in hub); 0 via SP-API |
| KnowledgeBaseEntry | 40 rows, all `manual` seeds; 0 owner examples |
| Seller feedback rows | 0 |
| store1 Gmail token (amazon@salutem.solutions) | scope = `gmail.readonly` only — **cannot send** |

## Why the hub "Send" button does not work

`response-sender.ts` sends through SP-API Messaging `createUnexpectedProblem`.
Read-only preflight (`getMessagingActionsForOrder`) on the 4 newest store1
orders returned only `updateFeedback, sendInvoice` or nothing. So
`unexpectedProblem` is not offered and every send falls back to MANUAL.
It is also the wrong tool: it opens a new seller-initiated message for a
fulfilment problem, not a reply in the buyer's thread.

## Sending options compared

| Option | How | Verdict |
|---|---|---|
| Email relay reply | Reply from amazon@salutem.solutions to the buyer's `…@marketplace.amazon.com` address in the same Gmail thread; Amazon posts it into the Buyer-Seller Messages thread | **Recommended.** Official Amazon path, no browser, no Seller Central login, fits the existing Gmail ingest. Needs store1 Gmail re-connected with `gmail.send` (owner OAuth click) and one test message verified in Seller Central |
| Jackie via account VPS | Hub queues the text, Jackie opens the message on the Salutem VPS and pastes | Fallback only: slow, fragile (login/2FA/captcha, DOM changes), adds browser sessions on the account |
| In-hub browser agent via VPS | Same as above, but our own CDP script | Same risks as Jackie plus a new tool to maintain; only worth it if email relay is refused |
| SP-API unexpectedProblem | current code | Dead for replies (not offered) and policy-risky |

## Other gaps

- `findSimilarCases()` effectively returns nothing (see architecture doc §3).
- No `autosend-policy.ts`, no shadow-mode fields yet.
- Gmail thread with >1 message is auto-marked RESOLVED in `sync-messages.ts`;
  once we reply by email that rule must key on *our* outgoing message, not
  thread length.
- ChatGPT history not imported yet (Jackie blocked on the logged-in browser).
