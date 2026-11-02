# Customer Hub — buyer cancellation requests (2026-11-02)

Owner, topic 42, 2026-11-02 (Jackie's spec): «дыра синка по уведомлениям об
отмене».

## Incident

brenda, 114-2471869-1927461 (store 1):

| When (ET) | What |
|---|---|
| 16.10 09:46 | Order placed, Ship by 21.10 |
| 17.10 11:46 | Amazon emailed amazon@salutem.solutions: "Order cancelation request for Order ID: 114-2471869-1927461" |
| 20.10 | We bought the UPS label and shipped |
| 23.10 | Amazon CS on her behalf: cancellation requested 16–17.10, wrong address, refund |
| 26.10, 01.11 | Our replies: delivered per UPS, file A-to-Z (01.11 = refusal, sent manually from the VPS 22:09 ET) |

Every hub card said "no cancellation request on record". The buyer-message
sync reads only `from:marketplace.amazon.com`. Cancellation notices come from
`donotreply@amazon.com`, so they never entered the hub. The shipment happened
after the request, so the fault is ours, yet the engine proposed a refusal.

## What changed

- **Ingest.** `syncCancelNotices` (`cancel-requests.ts`) runs inside every hub
  Gmail sync for all 5 store mailboxes. It handles two subjects:
  - "Order cancelation request for Order ID: …", stored as `REQUEST`;
  - "Your order … has been cancelled as per customer's request", stored as `CANCELLED`.

  Each notice becomes one `AmazonCancelRequest` row, deduped by Gmail id, with
  the time from the email Date header.
- **Before shipment?** The request time is compared with the label purchase
  time, taken as the earliest Veeqo `shipment.created_at` on the order. Without
  Veeqo, the stored ship date is used as a date-only value: an earlier calendar
  day (ET) proves "before" and the same day stays unknown. The result is cached
  on the row. A verdict that is unknown or rests on a bare date is re-checked
  every 6 h (`cancel-rules.ts` `requestedBeforeLabel`).
- **Case data.** `CaseDataSnapshot.cancelRequest` holds
  `{requestedAt, source:'amazon-notification', kind, labelPurchasedAt,
  labelSource, beforeShipment, orderTotal}`. The notice also appears in the
  order thread (as Amazon), in the prompt facts, and as an «Отмена» row on the
  card.
- **Rule (decision matrix §3c, T10c).** When the request came before
  shipment:
  - Refusing a refund or redirecting to A-to-Z is forbidden. The validator
    (`REFUND_REFUSAL_RE`, `ATOZ_REDIRECT_RE`) rewrites such text, and the
    decision is forced to `full_refund` (≤ $50) or `investigate` (> $50 or
    unknown).
  - There is no replacement-first and no autosend.
  - The card gets the red line «🔴 Отмена была запрошена до отгрузки …, вина
    наша. Нужно решение по возврату: сумма … — решите вы».
  - The buyer text never admits fault.
- **Information cards.** `infoCard()` / `cs_case_info_card` builds a card with
  `kind: "info"`: no buttons, no draft, and the message's caseStage is
  untouched. It is for a case that is already answered. `cardAction` refuses
  such cards, so approving one can never re-send.
- **Jackie tools.**
  - `cs_cancel_requests {days, sync_days, before_shipment_only}` lists every
    order with a notice: status, total, label time and verdict. `sync_days`
    backfills from Gmail.
  - `cs_case_info_card {message_id | amazon_order_id, decision_ru}`.

## Limits

- Only stores 1 and 3 received cancellation notices in the last 45 days.
  Stores 2, 4 and 5 had none.
- The label time needs the production Veeqo key. The local `.env` key is
  rejected (401), so local runs fall back to ship dates.
- A request filed after the label is not our fault. The old T10 rule ("already
  shipped, cannot cancel") still applies.

Related: [[customer-hub-inbox-watch]], [[customer-hub-vps-send]].
