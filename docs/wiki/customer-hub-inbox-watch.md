# Customer Hub — inbox watch (2026-11-01)

Owner, topic 42, 2026-11-01: «сначала починить дыру в алгоритме, чтобы не
оставалось неотвеченных и тем более просроченных писем».

## Incident

Seller Central (Salutem, US) showed 2 messages **Response Needed / Over SLA**
while `cs_cards_pending` and `cs_tasks_list` were empty.

| Case | What happened | Root cause |
|---|---|---|
| Michael, 113-8615743-9544212 (30.10) | Card v1 was posted to topic 42 on 30.10 at 19:44 ET (Telegram message 892) and got no decision. It was not auto-closed. | `cs_cards_pending` lists only unposted (`PENDING`) cards. Once posted, a card left every list, and nothing re-surfaced it before the 24 h deadline. |
| brenda, 114-2471869-1927461 (31.10) | The message reached the hub and a card was built. 3 s later the case was closed as "answered in Seller Central". | The confirmation sweep took any Amazon "Your e-mail to …" confirmation from the past 7 days for the order and closed the newest open message, without checking that the reply was sent **after** the message. Our 26.10 reply to her first message closed her 31.10 follow-up. |
| Rosemarie, 114-5272069-1115402 | Two messages were closed with a reply time from before they arrived. | Same bug. Both really were answered later (29.10 19:21 and 30.10 22:00 UTC); the times were corrected. |
| Stores 2–5 | Buyer emails were never ingested. | The sync cron took only stores with `Store.active` (store 1). All five mailboxes are connected. |

## Rules now in code

- **A reply answers a message only if it was sent after it**
  (`answered.ts`, `inbox-rules.ts` `replyAnswers`). One Seller Central reply
  answers every earlier open message of the order. Messages that arrive later
  stay open. This applies both to the confirmation sweep and to a VPS SEND
  that finishes as DONE.
- **Seller Central wins over inference.** If a fresh `INBOX_SCAN` taken after
  the reply still lists the order as Response Needed, the hub does not close
  it. Anything closed by inference (a confirmation email or our reply in the
  Gmail thread) is reopened. A case that the VPS agent itself reported as sent
  is never reopened (one send per message); it goes to the owner as a mismatch.
- **Reconcile every 15 min, all 5 stores**
  (`/api/cron/customer-hub-reconcile`, `inbox-watch.ts` `reconcileInbox`).
  Every unanswered incoming message from the last 7 days needs a live card
  (`PENDING`/`PUBLISHED`/`WRONG`/`REWORK`/`APPROVED`) or a live SEND/LOOKUP
  task. If there is none, the card is built now (`processCase` with
  `forceCard`). A LOOKUP task nobody picked up within 30 min is cancelled and
  the card is built without it.
- **Urgency** (24 h Amazon window from the oldest unanswered message):
  `overdue`, `due_soon` (< 6 h left), `no_card`, `send_stuck` (approved, not
  sent within 60 min), `card_stale` (card without decision > 2 h), `ok`.
- **Alerts** go out as alert cards: `CsCard.buyerMessageId = "cs-alert"`,
  `cardJson.kind = "alert"`, no buttons. They appear in `cs_cards_pending`
  ahead of other cards, and Jackie posts them to topic 42 like any card. The
  same case and level is repeated every 3 h while still open.
- **Metric:** `cs_inbox_status` gives unanswered and overdue counts per store,
  the latest Seller Central scan per store, and every open case with deadline,
  urgency, card state and Telegram link. `reconcile=true` also runs the
  reconciliation.
- **INBOX_SCAN** task for the account VPS, one per store every 30 min. It is
  read-only: the agent lists Buyer Messages filtered to "Response needed"
  (including Over SLA) and returns
  `{"items":[{orderId, buyerName, subject, receivedAt, overSla, text}]}`.
  A store with no VPS access ends as `FAILED`, retried after 6 h.

## Limits

- Without an `INBOX_SCAN` result the hub only infers the state from Gmail:
  buyer notification vs. reply confirmation. A message the owner marked
  "No response needed" in Seller Central still looks open to the hub until a
  scan says otherwise.
- The Seller Central inbox can be read only from each account's own VPS.
  Today only the Salutem VPS (`ss_hands.sh`) is wired for Jackie.

## Cancellation requests (2026-11-02)

Buyer cancellation notices and the before-shipment refund rule: [[customer-hub-cancel-requests]].
