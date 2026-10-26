# NAN Health (Shopify): live rates on /shipping (2026-10-26)

**Problem.** Shopify's `shippingLabelPurchase` API returns no list of rates and
cannot buy FedEx. The Shopify admin "Buy shipping label" page shows all of
them. For order #1374 the cheapest was FedEx Ground Economy at $6.98.

## Owner rules

- **No iMac.** The collector must not use the owner's browser on the iMac and
  must not poll it. It runs on our server, with its own session in the NAN
  Shopify admin.
- **On demand only.** It runs when the owner presses "Обновить" on the card,
  or once when a new NAN order appears.
- **Nothing is bought here.** The owner buys in Shopify.

## API

All paths are under `/api/shipping/nan-rates`.

| Call | Who | What it does |
|---|---|---|
| `POST /api/shipping/nan-rates` | collector | Sends `{captured_at, orders:[{order_name:"#1374", shopify_order_id, dest:{city,state,country}, package:{l,w,h,in,weight_lb}, rates:[{carrier,service,price_usd,eta_text,cheapest,fastest}]}]}`. Keeps the **latest** snapshot per order, so an older capture never overwrites a newer one. A snapshot newer than the refresh request clears that request. |
| `GET /api/shipping/nan-rates?orders=1374,…` | card | Returns the latest snapshot per order. |
| `POST /api/shipping/nan-rates/refresh {order}` | "Обновить" button | Sets `refreshRequestedAt`. |
| `GET /api/shipping/nan-rates/pending` | collector | Lists `{order_name, shopify_order_id, refresh_requested_at}`, oldest request first. |

**Collector auth.** The collector sends the header `x-nan-rates-secret`, whose
value is the env `NAN_RATES_SECRET` (at least 16 characters, set in Vercel).
The proxy lets that secret through for the two collector calls only, the POST
and the pending read. Every other call needs the normal login or API token.

**Storage.** One row per order in the `NanRateSnapshot` table. It was created
by `scripts/turso-migrate-nan-rate-snapshot.mjs`. The older one-off
`ShippingRateSnapshot` table is kept but unused.

## Card ("Тарифы", NAN orders only)

- Rates from cheapest to dearest, with Media Mail last.
- Carrier filter: FedEx, UPS, USPS, DHL.
- The cheapest rate is highlighted green, the fastest in blue.
- Snapshot age, e.g. "3 мин назад". After 30 minutes the block turns grey and
  is marked "устарел".
- "Обновить" queues a refresh.
- "Купить в Shopify" opens `admin.shopify.com/store/1bndby-p8/orders/<id>`. When
  the Shopify order id is unknown, it opens the order search instead.

## Code

- `src/lib/shipping/nan-rates.ts` and its test
- `src/lib/shipping/nan-rates-auth.ts`
- `src/app/api/shipping/nan-rates/**`
- `src/proxy.ts`
- `src/app/shipping/page.tsx`
