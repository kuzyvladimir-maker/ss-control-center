# Customer Hub — case data sets and VPS send flow (proposal 2026-10-20)

Owner decisions, 2026-10-20 (topic 42, case 114-1631599-6877866):

1. Every case decision rests on a **mandatory minimum data set**; a case
   without it gets no final decision, only "missing data: X".
2. **Sending is never through Gmail** (nor SP-API messaging). A reply goes out
   only from Seller Central, opened on **that account's VPS**, in the order's
   Buyer-Seller Messaging window, with attachments when they support our
   position. Never from the iMac or the server browser (related accounts).

Supersedes the "email relay" recommendation in
[[customer-hub-diagnosis-2026-10-18]]. Rules: [[customer-hub-owner-playbook]].
Status: **proposal — awaiting owner approval** of the lists and the flow.

## 1. Data sets (proposal)

### Minimum — blocks a final decision when missing

| # | Data | Source today | Gap |
|---|---|---|---|
| M1 | Buyer message text | Gmail ingest | — |
| M2 | Full thread on this order (buyer + our replies, Amazon CS relays) | BuyerMessage rows + Gmail thread | our Seller Central replies only via confirmations |
| M3 | Order: status (Unshipped/Shipped/…), items (ASIN, SKU, qty, pack), total, purchase date | SP-API Orders + AmazonOrder | items list not passed to the prompt yet |
| M4 | Ship-by and Deliver-by dates | SP-API Orders | Deliver-by sometimes missing |
| M5 | Shipment: carrier, service bought, tracking no., label date, Buy Shipping yes/no | Veeqo | — |
| M6 | **Live carrier tracking: carrier acceptance scan yes/no** (+ first scan time, last scan, delivered time, POD wording) | UPS/FedEx/USPS APIs | must be fresh at decision time |
| M7 | Product type Frozen / Dry / Chilled | Veeqo tags only (no guessing) | untagged products → "missing data" |
| M8 | What was already done on the order: refunds, replacements, open A-to-Z / chargeback / return | SP-API Finances, AtozzClaim, returns | not checked today |

### Recommended — used when present, never blocks

| # | Data |
|---|---|
| R1 | Our-side cause (missed pickup, packing error, stock-out) — ops note / Veeqo notes |
| R2 | Buyer history with us: earlier orders, claims, refunds |
| R3 | Account health: ODR, late-shipment rate, open A-to-Z count |
| R4 | Photos: buyer's photos, carrier POD photo |
| R5 | Ability and cost to reship (sourcing availability, landed cost) |
| R6 | Destination weather/heat during transit (frozen/chilled) |
| R7 | Seller Central case / claim status for the order |

Gate: the analyzer still drafts, but `decisionStatus = MISSING_DATA` with the
list of missing items; the autopilot never acts on such a case, and the hub
shows "Missing data: …" above the draft.

## 2. Send flow (proposal)

```
Hub (draft + decision + attachments)
  └─ owner presses "Approve & queue"  (later: autopilot for allowed types)
       └─ CsSendTask  status QUEUED
            storeIndex · amazonOrderId · buyerMessageId · body · attachments (R2 keys)
            approvedBy · approvedAt · idempotencyKey (messageId + body hash)
Jackie on the account's VPS (Chrome, already logged in to that account)
  ├─ MCP cs_send_tasks_list(store)            → QUEUED tasks for this account only
  ├─ MCP cs_send_task_claim(id, vps)          → CLAIMED (lock, one owner)
  ├─ opens Seller Central → Buyer-Seller Messaging → search order ID
  ├─ checks: order ID and buyer name match the task; no reply from us after
  │          the buyer's message already in the thread
  ├─ pastes body, attaches files, presses Send
  └─ MCP cs_send_task_complete(id, result, screenshot)
       SENT    → BuyerMessage SENT, responseSentVia = VPS_AGENT, proof stored
       FAILED  → reason shown in hub, task back to owner (no automatic retry)
       UNKNOWN → never re-sent; next run only READS the thread to confirm
Amazon "Your e-mail to …" confirmation email → existing sweep double-confirms
```

Safety: one task = one send attempt; an unknown result is verified by reading
the thread, never by sending again (AGENTS.md §7). Tasks for store N are only
visible to the VPS of store N (store1 Salutem = its own VPS). Nothing is
queued without the owner's approval until he switches the autopilot on.

## Done on 2026-10-20 (no approval needed)

- `response-sender.ts`: Gmail and SP-API send paths removed; "Send" now says
  the reply goes through Seller Central from the account's VPS.
- Gmail `gmail.send` reconnect for Store 1 is no longer needed.
- NOT HANDED OVER rule: apologise and resend within 1–2 business days,
  standard shipping, no refund offer unless asked, never A-to-Z.
