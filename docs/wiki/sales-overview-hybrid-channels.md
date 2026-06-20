# Sales Overview — hybrid source, multi-select channels, NAN-health exclusion

**Date:** 2026-06-12 · **Scope:** `/analytics` (Sales Overview) page + its two API routes + shared channel brand kit.

## Why

The Sales Overview page showed **inconsistent numbers**: the top period tiles
(Today / MTD / Last month) read our local DB cache and were correct (MTD ≈ $40k),
while everything below them (Daily revenue chart, By channel, By store, Orders
list) was pulled **live from Veeqo for every channel including Amazon + Walmart**.
Veeqo under-reports marketplace orders (its `created_at` windowing + sync gaps drop
most of them), so the bottom of the page summed to ≈ $15k / 200 orders for the same
window — visibly wrong and not reconciling with the tiles.

Two other asks from Vladimir:
- **NAN health** is a Shopify client whose orders we only *fulfil* — the revenue is
  theirs, not ours. It must never appear in our sales numbers.
- **Direct** channel was confusing — it's Veeqo's "Merged Orders" bucket.

## What changed

### 1. Hybrid data source (numbers now reconcile)
Both `/api/sales-overview` and `/api/sales-overview/periods` now use the **same
hybrid source**:
- **Amazon + Walmart** → our local cache (`AmazonOrder` / `WalmartOrder`), kept
  fresh by the orders-* crons. Authoritative.
- **All other channels** (eBay / Merged / etc.) → live from Veeqo (the only place
  they exist; also brings line-item thumbnails).

The main route previously used `loadAllVeeqoOrders` for the whole current window;
it now loads Amazon/Walmart from cache and only the non-cached channels from Veeqo
(`loadOtherChannelOrders`). Top SKUs switched back to the `AmazonOrderShipment`
cache aggregator (`buildTopSkus`) since cached order rows carry no line items.

**Trade-off:** cached Amazon/Walmart order rows have no line items, so those rows in
the Orders list show the item count instead of product thumbnails. Accepted in
exchange for numbers that match the dashboard + tiles.

### 2. NAN health excluded everywhere
New helper `isFulfillmentOnlyStoreName()` in
`src/lib/procurement/excluded-stores.ts` (reuses the existing NAN-health name set).
Both analytics routes skip any Veeqo order whose `channel.name` matches — same rule
Procurement already uses.

### 3. Multi-select channel filter
`channel=` (single) is replaced by `channels=` (comma list) on both routes; the
legacy single param still works. `all` / empty = every channel. The page sends the
selected set and **re-fetches** (server-side filtering keeps aggregates correct even
when the orders list is capped). The "All" chip clears the selection; any other chip
toggles in/out, so you can view e.g. Amazon + Walmart together.

### 4. Shared channel brand kit
`CHANNEL_BRANDS`, `ChannelToggle`, `CHANNEL_HEX`, `channelHex()`, `channelLabel()`
extracted from the Shipping Labels page into **`src/lib/channel-brands.tsx`**.
Shipping Labels now imports from there (single source of truth), and Sales Overview
uses the identical brand-styled chips + colours. "Direct" renders as **"Merged"**
(via `CHANNEL_BRANDS.direct.label`). Channel chips stay put while filtering via a
union-grown `knownChannels` list.

## Files
- `src/lib/channel-brands.tsx` — new shared kit
- `src/app/shipping/page.tsx` — imports the kit (removed local copies)
- `src/lib/procurement/excluded-stores.ts` — `isFulfillmentOnlyStoreName()`
- `src/app/api/sales-overview/route.ts` — hybrid source + `channels=` + NAN exclusion
- `src/app/api/sales-overview/periods/route.ts` — multi-channel set + NAN exclusion
- `src/app/analytics/page.tsx` — multi-select chips, channel labels/colours

## Note on the Dashboard
The Dashboard (`/`) already reads only Amazon + Walmart from our cache and never
included NAN health / Direct, with brand-colour dots (#ff9900 / #0071dc). No change
needed there — it was already correct and on-brand.

## Связано с
- [Dashboard](dashboard.md) — уже читает Amazon+Walmart из кеша без NAN/Direct
- [Sales cards dashboard](sales-cards-dashboard.md) — карточки продаж того же кеша
