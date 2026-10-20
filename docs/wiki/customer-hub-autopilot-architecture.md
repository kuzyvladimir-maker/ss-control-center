# Customer Hub autopilot — architecture (2026-10-18)

Goal (owner, Telegram topic 8): for the last 2–4 months Vladimir answered
Amazon buyers by hand in ChatGPT instead of the Command Center. Use that
history as knowledge so the hub drafts answers his way, and sends routine
ones on its own. Money and claims stay drafts.

Jackie exports the ChatGPT history (Chrome on the iMac) as text into
`/root/.openclaw/workspace/wiki/business/`. Everything below is the part
that lives in SS-CC.

## What exists today (verified in code)

| Piece | Where | State |
|---|---|---|
| Ingest Gmail → BuyerMessage | `src/lib/customer-hub/sync-messages.ts`, cron `/api/cron/customer-hub-sync` every 30 min | Live since 2026-10-18 |
| AI analysis + draft | `src/lib/customer-hub/message-analyzer.ts` (`analyzeMessage`, subscription worker, no paid keys) | Works; writes `suggestedResponse`, `problemType` T1–T21, `riskLevel`, `action`, `factCheckJson` |
| Knowledge base | `KnowledgeBaseEntry` (problemType, scenario, customerSaid, correctAction, correctResponse, reasoning, source, tags, channel) | 41 hand-seeded rows |
| KB retrieval | `findSimilarCases()` in `knowledge-base.ts` | **Effectively dead**: called before classification, filters by problemType only for T21, otherwise `scenario contains <first 100 chars of the message>` — almost never matches |
| Fact check | `factCheckResponse()` → confidence HIGH/MEDIUM/LOW | Works |
| Send | `sendResponse()` in `response-sender.ts` → SP-API Messaging, preflight of allowed actions | Works, manual click only |

## Design

### 1. Example store — reuse `KnowledgeBaseEntry`, no new table

Each pair "buyer wrote → what Vladimir actually sent" from ChatGPT becomes one row:

- `source = "owner_chatgpt"` (new value next to `manual` / `auto_from_resolved_case`)
- `problemType` T1–T21, `productType` Frozen/Dry, `correctAction` (info / replacement / partial_refund / full_refund / redirect_amazon …)
- `customerSaid` = buyer text, `correctResponse` = Vladimir's final text, `reasoning` = why (from the chat)
- `tags` = `orderId:<…>,date:<…>,hash:<sha1 of buyer+answer>` — the hash makes re-imports idempotent

Plus one **voice guide**: tone, greeting/sign-off, phrases he always or never uses, distilled once from the whole export. Stored as `Setting` key `customer_hub_voice_guide`.

### 2. Importer — `scripts/import-chatgpt-cs-history.ts`

1. Read Jackie's export (plain text / markdown / JSON — whatever comes).
2. A subscription LLM pass splits it into conversations and extracts, per case: buyer message, order id if present, final answer Vladimir sent (not the drafts he rejected), outcome.
3. It classifies each case to T1–T21 + action using the same decision table as the analyzer.
4. Brand-voice gate (`compliance/banned-words.ts` style checks) — reject examples that would teach banned claims.
5. Upsert to `KnowledgeBaseEntry` by hash; a second pass writes the voice guide.
6. Dry-run mode prints the extracted cases for the owner to spot-check before writing.

### 3. Retrieval fix — make the KB actually reach the prompt

- A cheap keyword pre-classifier (the trigger-phrase table in `CUSTOMER_HUB_ALGORITHM_v3.0.md §5`) predicts likely T-types before the LLM call.
- Load KB rows for those types (the table is small — hundreds of rows), rank in memory by token overlap with the buyer message + same productType, take the top 3–5.
- Prefer `owner_chatgpt` rows over seeds; inject them with the voice guide into `buildContextMessage` as "this is how the owner answered similar cases — match the decision and tone".

### 4. Auto-send policy — `src/lib/customer-hub/autosend-policy.ts`

A pure function over the analyzed message returns `{ eligible, reasons[] }`. **All** of these must hold:

- Global switch `Setting customer_hub_autosend` = `on` (default **shadow**: compute and log only, never send).
- problemType in the allow-list: **T1** (in transit / where is it), **T3** (late, already delivered or arriving, info only), **T18** (pre-sale question), **T16** acknowledgement — informational answers only.
- `action` is informational — never REPLACEMENT / REFUND / partial / A2Z / ESCALATE.
- Hard blocks:
  - T4 spoiled, T5 damaged, T6 wrong item, T7 missing, T11 refund, T12 unauthorized, T13 A-to-Z, T14 review threat, T15 health, T19 refund issued, T20 repeat, T21 mismatch;
  - `foodSafetyRisk`, `atozRisk`, riskLevel ≠ LOW, factCheck confidence ≠ HIGH;
  - no KB example with similarity above a threshold;
  - non-English;
  - buyer already got any reply on this order;
  - brand-voice violation.
- Volume guard: max N auto-sends per day (start 10), with an emergency stop if Amazon messaging returns errors.
- Everything else stays a draft for one-click approval — refunds, money and claims are **always** drafts.

Wiring: after `analyzeMessage` in `sync-messages.ts` → `evaluateAutosend` → if `on` and eligible → `sendResponse()` → `responseSentVia = "AUTOPILOT"`. Every decision (sent / would-send / blocked + reasons) is written to the message row, so the hub can show "sent automatically" or "draft — why not auto".

### 5. Rollout

1. Import the history → owner spot-checks 10 extracted cases.
2. Shadow mode for ~1 week: the hub marks "would auto-send" on real messages; owner compares against what he would have sent.
3. Owner flips `customer_hub_autosend = on` (his explicit go — sending to buyers is outward-facing).
4. Weekly: drafts the owner edited before sending are fed back into the KB as new examples, so the voice keeps improving.

## Open inputs

- The ChatGPT export (Jackie).
- Owner go for step 3.

## Implemented 2026-10-19 (topic 42)

| Piece | Where | State |
|---|---|---|
| KB retrieval fix | `kb-retrieval.ts` (pre-classifier + in-memory ranking), `findRelevantCases()` in `knowledge-base.ts` | Live. On the 27 real Amazon messages, 23 now get examples (before: almost none). Owner rows (`owner_chatgpt`, `owner_edit`) get +0.15 |
| Voice guide | Setting `customer_hub_voice_guide`, injected into the prompt | Empty until the ChatGPT history is imported |
| Auto-send policy | `autosend-policy.ts` (pure) + `autosend-runner.ts` | **Shadow mode** by default. Verdict JSON stored in `BuyerMessage.autosendDecision` (Turso column added via `scripts/turso-migrate-customer-hub-autosend.mjs`), shown in MessageDetail as "Autopilot: …" |
| Send path | `response-sender.ts` → email reply from the store mailbox to the buyer's `@marketplace.amazon.com` relay, in the same Gmail thread | Code live; **needs store1 Gmail re-connected** (scope already includes `gmail.send`) and one owner test send |
| RESOLVED rule | `thread-state.ts` `answeredAfter()` | Only a reply from us (SENT label / seller From / Seller Central confirmation) after the buyer email closes a case; buyer follow-ups no longer do |
| Safety | `sendResponse` refuses a second send (`responseSentAt` set); a failed autopilot send flips the mode back to `shadow`; daily cap Setting `customer_hub_autosend_daily_cap` (default 10); re-analyze never sends | Tests: `src/lib/customer-hub/__tests__/autopilot.test.ts` (12) |

Threshold note: with only hand seeds, informational messages score 0.4–0.5,
below `AUTOSEND_MIN_KB_SCORE = 0.6`, so shadow mode will mostly say "no close
owner example" until owner examples are imported. That is intended.

## Owner examples imported from Gmail (2026-10-19, round 2)

The ChatGPT export is blocked (no ChatGPT login on the iMac / server — Jackie,
2026-10-19). A better source was already in the mailbox: every reply the owner
sends from Seller Central produces an Amazon "Your e-mail to …" confirmation
with a copy of the text.

- `scripts/import-owner-replies-from-gmail.ts` (read-only on Gmail):
  199 confirmations in 365 days → **175 buyer→owner pairs**, each AI-labeled
  (type, action, one-line scenario) on the subscription worker, stored as
  `KnowledgeBaseEntry` `source = owner_edit`, idempotent by hash tag.
  Flags: `--dry-run`, `--apply`, `--reuse` (relabel from
  `data/customer-hub-owner-replies.json` without Gmail), `--voice`.
- **Voice guide** distilled from the replies → Setting
  `customer_hub_voice_guide`. Learned "ask for a review" lines are stripped;
  hard limits appended (no review asks, no links/contacts, no cancel of
  shipped orders, no food-safety arguments).
- **House style changed in the analyzer**: greeting `Hello {first name},`
  (or `Hello,`) and sign-off `Best regards, / Customer Support Team` — the
  owner uses these in 171 / 163 of 175 real replies. Was `Dear …` + store name.
- Policy rule added: **no order or product context → draft only** (a
  pre-sale "16 boxes × 8?" with no ASIN got a useless "send us the order ID"
  draft that the policy would otherwise have let through).
- Re-run after new replies accumulate:
  `npx tsx scripts/import-owner-replies-from-gmail.ts --apply` (new pairs only).

## Owner playbook from the ChatGPT history (2026-10-19)

Seven months of owner-approved answers distilled into prompt rules — see [[customer-hub-owner-playbook]].
