# Customer Hub — owner playbook (from the ChatGPT history, Mar–Oct 2026)

Source: the owner's ChatGPT chat "AMAZON - Клиентская поддержка", 19.03–19.10.2026,
475 screenshots, exported by Jackie to the owner's iMac
(`~/Documents/gpt-amazon-support-export/`, **not in git — contains buyer data**).
Read in 8 parts on 2026-10-19 (topic 42). The owner says he almost never edited
GPT's answers, so this is the target behaviour. Companion docs:
[[customer-hub-autopilot-architecture]], [[customer-hub-diagnosis-2026-10-18]].

## What the owner gave GPT

- Mostly screenshots + "Это новый кейс": the Seller Central buyer thread, the
  order page (shipping service bought, Amazon delivery window, **Claims
  Protected** badge, Ship by / Deliver by), carrier tracking (pickup and
  delivery times, delay scans, "Left at …", "Received by …", delivery photo).
- About a third to a half of cases: his intent or facts in Russian voice
  dictation — "we already refunded", "offer a replacement, confirm the
  address", "don't refund, send to A-to-Z", packing facts (−20 °C, gel packs
  1.5× product weight, outer retail carton removed to fit more ice,
  lab-tested 48 h for chilled), "look at the shipping service we bought".
- Relayed Amazon CS messages, return requests, feedback, Seller Support threads.

## How GPT answered (stable from April)

1. One-line verdict (RU).
2. Facts as bullets (RU): service, pickup → delivery, **transit hours**,
   window, protection badge, proof of delivery, what is claimed vs proven.
3. Recommendation (RU): usually "I would not refund now" + the next step.
4. Ready English text: `Hello {Name},` … `Best regards, / Customer Support Team`,
   80–200 words, one ask per message.
5. Afterword (RU): what was deliberately NOT written and why; evidence to keep.

## Decision rules (latest form wins)

| Situation | Rule |
|---|---|
| Shipped on time, Buy Shipping / Claims Protected, carrier late or lost | Don't refund/replace ourselves (Amazon won't reimburse a seller who paid first). Facts + "please do not consume" + ask the buyer to request an **A-to-Z Guarantee review** from Amazon CS. Never promise Amazon's outcome. |
| Delivered on time, buyer says thawed/spoiled | Photos first (outer box, insulated container, gel packs, product), ask whether packaging was damaged; "do not consume or refreeze if it arrived warm". No refund yet. Buy Shipping protection does **not** automatically cover condition/damage claims (GPT's October correction). |
| Arrived "too frozen" / "all frozen" | Not a defect: ships with frozen cooling packs, may arrive frozen; photos only if damaged/leaking. |
| Discarded on Amazon's advice, no photos | Don't refund automatically, don't close: ask whether there was actual damage beyond the frozen condition. |
| Chilled product, gel packs thawed | "Shipped chilled, not frozen; thawed gel packs alone do not indicate a temperature breach; lab-tested up to 48 h when intact" (only if transit < 48 h). |
| In transit, window open | No refund, no A-to-Z yet; latest scan + window end; "contact us if not delivered by …". Mention the expedited service we paid for. Ship by = deadline, not plan. |
| Delivered, not received — 1st contact | Quote date/time and scan wording/photo; check list tailored to house / apartment / business; "if still unable, contact Amazon CS". Suspicious photo → only ask "do you recognise this location?" |
| Delivered, not received — follow-up | Firm and short: "unable to issue a replacement or refund from our side for a package confirmed as delivered" → A-to-Z review. Don't repeat the check list. |
| Our fulfilment error (wrong item, no cooler) | Admit plainly; free expedited replacement (confirm full address — hidden after shipment) or full refund. "Not eligible for a standard return." We don't pay return shipping. |
| Buyer claims wrong/missing, we're not sure | Photos of package fronts/labels and everything received together; neither accuse nor admit. |
| 1×2 lb shipped for 2×1 lb | Same total; only the packaging differs; no refund. |
| Cancel before shipment | Ask the buyer to submit an official cancellation request in Amazon; we approve it (seller-initiated cancel hurts metrics). |
| Cancel after shipment | Cannot cancel; food is not returnable; contact us after delivery if there is an issue. |
| Illness | Never dispute; verify only checkable facts (photo of printed date); refund, never replacement. |
| Price / shipping cost | Pack size, insulated packaging, gel packs, expedited, summer; never our costs. |
| Postage due (UPS→USPS) | Buyer must not pay; options: pay and we reimburse, or refuse and we refund after return. |
| Unauthorized purchase | Amazon CS; no refund from us. |
| Already refunded | Confirm, a few business days; nothing about fault. |
| Ingredients | Never yes/no without the label; refer to packaging/manufacturer. |

Never write: "you are wrong", "impossible", "physically could not", "not our
problem", "safe to eat", "arrived frozen" (unproven), "guaranteed", accusations
of lying, carrier-bashing, a categorical "this is Amazon's responsibility",
review requests.

## Where GPT was unreliable (not adopted)

- Recommended SAFE-T for a carrier delay (against our canon) and quoted fixed
  outcome percentages.
- Under owner pressure once wrote "safe for consumption" for raw beef — the
  hard rule against food-safety claims stays.
- Inferred a piece count from a nutrition number on a photo — never infer
  counts from images.
- Soft review asks after resolution — dropped (Amazon restricts them).

## Applied in code (2026-10-19)

- `message-analyzer.ts` SYSTEM_PROMPT: new **OWNER PLAYBOOK** section; Table
  A DNR rows, Table B C1 (on-time thaw → photos first), Table D cancel-before-
  ship (official request) rewritten; internal contradiction "frozen + delay →
  immediate replacement" removed; safe templates and the auto-fix prompt no
  longer send in-window WISMO to Amazon CS; greeting forced onto its own line.
- `transit.ts`: TRANSIT FACTS block (first carrier scan → delivery, hours,
  delivery scan wording) in every prompt.
- New output `ownerBriefRu` → `BuyerMessage.ownerBrief` (Turso column added),
  shown as **AI brief** in MessageDetail: Факты / Решение / Чего не пишем.
- Checked on real messages against what the owner actually sent: pack-size
  and "all frozen" cases match his replies; "discarded, no photos" now asks
  for details instead of refunding.

## Fix 2026-10-20 — "label created" is not "shipped"

Order 114-1631599-6877866 (frozen, $204.98): tracking had a single event
"Shipper created a label, UPS has not received the package yet" for 16 days.
The enricher took the label date as the ship date → `shippedOnTime = true`,
`claimsProtected = true`, and the draft sent the buyer to A-to-Z — a claim
Amazon would charge to us, because Amazon judges on-time shipment by the
carrier's first scan. Now:

- `message-enricher.ts` 8b: no carrier scan → `carrierAccepted = false`,
  `shippedOnTime = false`, `claimsProtected = false`; first scan after Ship by
  → `shippedOnTime = false`.
- Prompt: TRANSIT FACTS prints `CARRIER ACCEPTANCE: NONE`; new **NOT HANDED
  OVER** rule — our side, apologise, replacement (expedited, confirm address)
  or full refund, never A-to-Z; brief tells the owner to check the box and
  void the unused label.
- `transit.ts` recognises UPS/FedEx/USPS label-only wording.
