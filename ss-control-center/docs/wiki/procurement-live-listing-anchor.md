# Procurement card: anchor Amazon title/image on the live listing

**Date:** 2026-07-12
**Files:**
- `src/lib/veeqo/orders-procurement.ts` — `anchorAmazonCardsOnLiveListing`, `veeqoAmazonStoreIndex`, `fetchLiveListing`
- `src/lib/procurement/pack-size.ts` — `N_UNIT_PATTERNS` (removed count/ct as a multiplier)
- `src/lib/procurement/__tests__/pack-size.test.ts` — new cases

## The bug

Amazon order `#111-1256607-0654651`, SKU `N6-GCAP-ZPKH` (ASIN `B099LN28D3`) showed
in the Procurement card as a **completely different product**:

| | Card (from Veeqo) | Real listing (Amazon) |
|---|---|---|
| Title | White Castle Beef Hamburgers… **16 count**, 25.28 oz | Gourmet Kitchn Cheese Sliders… **2 Boxes… 64** |
| Image | wrong product | real |
| "Купить" | **16 шт** | should be **2** (2 boxes), order qty = 1 |

## Root cause

The card read title/image from Veeqo's cached `sellable` record
(`orders-procurement.ts` → `productTitle` / `pickImageUrl`). Veeqo's sellable for
this SKU had drifted to a stale/wrong product. Then `parsePackSize` read
`"16 count"` from that wrong title and treated the count as a **buy multiplier**
(`1 × 16 = 16`) — violating the owner rule "count = pieces inside one unit, never
a signal to change the pack" (see memory `packCount is source of truth`).

## The fix (two parts)

1. **Source of truth = the live marketplace listing.** For Amazon orders the card
   now overrides title + image from the Listings API (`getListing` → `flattenListing`),
   keyed by `veeqoAmazonStoreIndex(order)` → `getMerchantToken`. Best-effort: any
   failure (suspended account, no US marketplace, 404, rate limit, network) silently
   keeps the Veeqo values. Deduped by store+SKU, concurrency 5, 6h hit / 20m miss
   cache per serverless instance.
2. **`count`/`ct` is never a buy multiplier.** Removed the `count|ct` entry from
   `N_UNIT_PATTERNS`. A count only narrows the buy quantity via an explicit
   "Pack of N" (first pass). So `"…16 count"` → `null` (buy 1), and
   `"…2 Boxes (32 ct. Each) Total 64"` → `2 Boxes` (32/64 are contents).

Both are needed: even with the correct title, the old parser picked the **largest**
unit number, so `"32 ct"` would have out-voted `"2 Boxes"` → wrong `32`.

Verified live on the reported SKU: title/image/ASIN correct, `parsePackSize` → `{size: 2, "2 Boxes"}`.
