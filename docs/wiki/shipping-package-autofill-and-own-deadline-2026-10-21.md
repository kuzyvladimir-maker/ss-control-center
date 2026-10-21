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
