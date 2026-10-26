# NAN Health (Shopify) rates on /shipping — admin-UI snapshots (2026-10-26)

**Problem.** Shopify's `shippingLabelPurchase` API returns no list of rates and
cannot buy FedEx. The Shopify admin "Buy shipping label" page shows all of
them. For order #1374 (12x10x6 in, 1.9 lb, Medina OH) it listed 20 rates; the
cheapest was FedEx Ground Economy at $6.98 (4–5 days).

**What exists.**
- **Table** `ShippingRateSnapshot` holds one row per capture: order number
  without "#", capture time, destination, package, and the rates as JSON. It
  was created by `scripts/turso-migrate-shipping-rate-snapshot.mjs` (additive).
- **`POST /api/shipping/rate-snapshots`** takes `{order, captured, rates, dest?,
  pkg?, source?}`. `rates` can use Jackie's compact form `[["FedEx Ground
  Economy", 6.98, "4-5d"], …]` or objects. Auth is the session, or the
  `SSCC_API_TOKEN` / `JACKIE_API_TOKEN` bearer.
- **`GET /api/shipping/rate-snapshots?orders=1374,…`** returns the latest
  snapshot per order.
- **Card.** NAN Health order cards show "Тарифы Shopify · снимок <time> ·
  <package>", cheapest first and highlighted. Media Mail is listed last. Six
  rates show by default, with a toggle for the rest.
- **Nothing is bought.** The owner buys these labels in Shopify.

**Refreshing (to decide with the owner).** A browser session with the NAN
admin login opens each ready NAN order's "Buy shipping label" page, reads the
rates without clicking buy, and POSTs them here.

Caveat: Shopify quotes the package that is set on that page, so the package
must match ours, or the snapshot records which package it used (`pkg`).

Code:
- `src/lib/shipping/rate-snapshot.ts` and its test
- `src/app/api/shipping/rate-snapshots/route.ts`
- `src/app/shipping/page.tsx`
