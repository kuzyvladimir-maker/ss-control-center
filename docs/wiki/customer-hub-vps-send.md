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
Status: **approved by the owner 2026-10-20** (M8 stays in the minimum; the hub must fetch missing data itself). Built 2026-10-20 — see "Built" below.

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


## Built 2026-10-20

### Data: source chains (hub fetches; owner sees only exhausted gaps)

| Item | Chain (first → fallback) |
|---|---|
| M1 buyer text | Gmail ingest → Seller Central (VPS LOOKUP) |
| M2 thread | hub DB → owner replies from Amazon confirmations → Seller Central (VPS) |
| M3 order | SP-API Orders + items → DB copy (AmazonOrder) → Seller Central (VPS) |
| M4 Ship by / Deliver by | SP-API → DB copy → Seller Central (VPS) |
| M5 shipment | Veeqo → Seller Central (VPS) |
| M6 carrier tracking | stored carrier API events → fresh carrier API call → Seller Central (VPS) |
| M7 Frozen/Dry | Veeqo tags of line 1 → Veeqo tags of all lines (never guessed; not in Seller Central) |
| M8 already done | SP-API Finances refunds + A-to-Z/chargeback table + our replies → Seller Central (VPS) |

Gate (`case-data-gate.ts`): complete → analysis + card; missing and Seller
Central can help → LOOKUP task, no decision yet; still missing after the
lookup → card with "⚠️ Не нашли: … Искали: …" in Russian.

Code: `case-data.ts` (collector), `case-data-gate.ts` (pure gate),
`cs-pipeline.ts` (processCase), `cs-tasks.ts`, `cs-cards.ts`; ingest cron
calls `processCase` for every new message.

### Telegram card exchange with Jackie (MCP tools on /api/mcp)

1. `cs_cards_pending` → cards: `{cardId, version, store, orderId, textRu,
   buttons:[{action, label, callbackData:"cs:<cardId>:<action>"}], draftEn, …}`.
   Jackie posts `textRu` to topic 42 with the three inline buttons
   (Утвердить и отправить / Не так / Доработать), then
   `cs_card_published {card_id, telegram_message_id}`.
2. Button press → `cs_card_action {card_id, action, comment?}`:
   - `approve` → SEND task queued for that account's VPS; the approved text is
     also saved as an owner example in the KB.
   - `wrong` / `rework` without comment → returns `askOwnerRu`; Jackie asks
     the owner (reply to the card, voice or text) and calls again with
     `comment`. With comment → saved as an owner rule; a new card version
     appears in `cs_cards_pending` within ~1 minute.
3. VPS agent (on the account's own VPS only):
   `cs_tasks_list {store_index}` → `cs_task_claim {task_id, vps}` → act →
   `cs_task_complete {task_id, outcome DONE|FAILED|UNKNOWN, screenshot_url |
   result{M6:"…"}}`.

### Learning — where the owner's corrections live

- `CsOwnerRule` (append-only table): every "Не так"/"Доработать" comment,
  with the case type and card id. The newest 40 are injected into EVERY
  analysis prompt as "OWNER CORRECTIONS"; they add to the playbook, nothing
  is overwritten or deleted.
- `KnowledgeBaseEntry` `source=owner_edit`: every approved reply (tag
  `card:<id>`), next to the 175 Seller Central replies and the seeds; ranked
  above seeds by `kb-retrieval.ts`.
- Unchanged and still in force: the playbook in the system prompt
  ([[customer-hub-owner-playbook]], from the ChatGPT export) and the voice
  guide (`Setting customer_hub_voice_guide`).
