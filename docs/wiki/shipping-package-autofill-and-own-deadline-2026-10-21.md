# Shipping Labels: package autofill, Buy after Save, our ship-by deadline (2026-10-21)

Owner report (Telegram topic 135), three issues on `/shipping`.

## 1. Package (weight/box) sometimes doesn't fill in

**Cause.** The plan reads weight + box from `SkuShippingData` (single item) or
`PackingProfile` (multi-item). In July the COGS identify script created ~6k
`SkuShippingData` rows with `source = "cogs-identify"` and **no weight, no
dimensions**. Any SKU with such an empty row stopped with
`SKU …: missing weight/dimensions`. SKUs whose row had been filled synced fine,
which is why it looked random. Over the last 10 days, 121 stopped plan items
(8 orders) had this cause.

**Fix.** `src/lib/shipping/package-history.ts`. Before stopping, the plan looks
up a label we already bought for:

1. the same SKU and the same quantity, or
2. the exact same listing title (the same listing sold under another SKU) and
   the same quantity.

A match is used for the quote and **written back** to `SkuShippingData` (only
the empty fields are filled, `source = "history"`) or to a new
`PackingProfile`. After that, the next order of that SKU skips the lookup.
Amazon only: other channels quote from the package that is already set in
Veeqo. Quantities never cross-match.

Indexes `ShippingPlanItem(sku)` and `ShippingPlanItem(product)` were applied to
Turso with `scripts/turso-migrate-shipping-package-history-indexes.mjs`. A
lookup takes about 50–70 ms.

A SKU that has never been shipped in this quantity still needs one manual
entry. After that entry, it is remembered.

## 2. Buy label returned zeros after a package Save

**Cause.** After the Save, the page re-quotes only that one order through
`/api/shipping/plan?orderIds=…`. The server answers with a **new** plan, and
the page merged that new item into its batch list. Buy then sent the **batch**
`planId` with the **new** item id. `/api/shipping/buy` filters the plan's items
by id, found nothing, and returned `total 0 / bought 0 / errors 0`. A full
refresh fixed it because it builds one plan that contains every item.

**Fix.**
- Each re-quoted item now carries its own `planId`.
- Buys are grouped by plan (`src/lib/shipping/buy-targets.ts`). This covers both
  the single-row Buy and the bulk Buy. A bulk buy sends one `/buy` call per
  plan, and each item is still bought exactly once.
- Server-side, `/buy` now returns an explicit error for any requested item id
  that is not a buyable item of the plan it was given, instead of silent zeros.

## 3. Our ship-by deadline for orders without one

Orders whose marketplace gives no ship-by (no Veeqo `dispatch_date` /
`due_date`, e.g. NAN health / Shopify) had no time bucket, so they never
appeared in Overdue / Today / Tomorrow.

The rule now is: **ship-by = order date (Pacific) + 2 days**. It is computed in
`src/lib/shipping/own-deadline.ts` and set in `/api/shipping/dashboard`, which
sends `shipByEstimated: true`. The row shows an "our deadline" chip, and its
tooltip says the date is ours, not the marketplace's. The default filter is
unchanged.

Tests: `npm run test:shipping`.

## 4. Buy refused a "(Saturday)" frozen rate — "no rate match, remote_shipment_id=null" (2026-10-22)

Order 111-5099040-5027461 was planned with "Fedex 2Day® One Rate (Saturday)"
for shipping that day. The quote came from the Rate Shopping API, so it has
no `remote_shipment_id` and its `rate_id` never exists in the allocation pool.
Both of those are normal.

At buy time, the re-quote (`GET /shipping/rates/{allocation}`) is anchored to
the order's Veeqo `dispatch_date`, which is the later Amazon ship-by. From that
date, 2Day doesn't land on a Saturday, so the "(Saturday)" variant wasn't in the
23 live rates. The exact title compare failed and the buy was refused.

**Fix.**
- `src/lib/shipping/requote-match.ts` matches the live rate in tiers:
  1. same quote id;
  2. same carrier + title (ignoring case, ® and spacing);
  3. same carrier + base title with the "(…)" suffix dropped, but only if it
     arrives no later than the planned EDD.
- Tiers 2 and 3 must pass a price guard: at most max($1, 5%) above the plan.
- If the service is missing, the buy route re-anchors `dispatch_date` to the
  physical ship day once and re-quotes. If nothing is bought, it restores the
  original `dispatch_date`.
- If the service is still missing, or it is now pricier, nothing is bought. The
  error names the reason and up to 3 closest live options.

Test: `requote-match.test.ts`.

## 5. FedEx 2Day from Monday showed "EDD 10/29 · 3 days" instead of 10/28 (2026-10-25)

Orders 111-0144634-8326602, 111-9725021-4213819 and 112-5846764-0961066 were
planned on Sunday 10/25 for shipping Monday 10/26.

**How the Monday quote is checked.** For a later ship day,
`getRatesForLaterShipDay` (`src/lib/veeqo/client.ts`) compares the "ship
today" quote with the quote for that later day. If no EDD moved, it decides
Veeqo ignored `preferred_shipment_date` and projects every EDD forward by the
gap between the two days. The rule came from the 2026-10-06 incident and is
kept.

**What went wrong.** Carriers don't pick up on Sunday, so the Sunday quote
already counted transit from Monday. Both quotes therefore gave the correct
10/28. The gap was measured in calendar days (Sun→Mon = 1), so the identical
dates were read as "ignored" and every EDD was pushed one day, to 10/29 ·
3 days.

**Fix.**
- `pickupGapBusinessDays` measures the gap in carrier pickup days. Sat→Mon and
  Sun→Mon give 0, so identical EDDs stand.
- When the gap is real, `addBusinessDaysYmd` shifts EDDs by business days.
- Both functions are in `src/lib/shipping/dates.ts`; tests are in
  `pickup-gap.test.ts`.

**Result.** After re-planning on production, all three orders show FedEx 2Day
One Rate, EDD 10/28 · 2 days, at the same prices.

The "N days" on the card is our own calculation: EDD minus
`plan.actualShipDay`, in `page.tsx`. It was right; only the EDD was wrong.

### 5b. Owner rule: carrier EDDs are never moved (2026-10-25, commit 706bad877)

**Rule.** The card shows the carrier's EDD exactly as quoted, and "N days" is
EDD − SHIP DAY. Our projection, which shifted EDDs when Veeqo ignored
`preferred_shipment_date`, is removed.

**When Veeqo ignores the ship day** (a real gap in pickup days and no EDD
moved), `getRatesForLaterShipDay` returns the EDDs unchanged together with
`quoteAnchorYmd`, the pickup day those EDDs really count from.
- **Plan.** The plan stores it as `quoteAnchorDay` and adds the note "QUOTE NOT
  FOR SHIP DAY".
- **Frozen gate.** Transit is measured from that day, which is the carrier's
  real transit, and the marketplace deadline is pulled in by the gap. That
  keeps the 2026-10-06 food-safety protection.
- **Card.** It reads "EDD X · N days from pickup Y · quote not for ship day".

**Plan response.** The response now also carries `tempClass`,
`tempClassSource`, `walmartColdConflict` and `shadow`. Before this,
`enrichedItems` dropped them, so the temperature engine line and the shadow
block never reached the card.

**Live check.** All 19 frozen orders from the Sunday 10/25 plan were re-planned
after deploy:
- every EDD is back to the carrier date: 2Day = 10/28 · 2 days;
- 6 orders switched to a cheaper honest 3-day rate (−$90.14 in total), because
  the +1 day had pushed those rates past the 3-day frozen cap;
- no order was flagged (Sun→Mon is the same pickup day).

**Note on Dry and non-Amazon orders.** They still quote through the allocation
pool (`GET /shipping/rates`), which takes no date parameter. Their EDDs come
from Veeqo as-is and are never shifted by us.
