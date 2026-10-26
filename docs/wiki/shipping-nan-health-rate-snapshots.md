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

## Live collector (2026-10-26, 02:10 ET)

**Script.** `scripts/server/nan_rates_http.py` in the repo. It runs from
`/root/.openclaw/workspace/scripts/` on the server and uses only HTTP: no
browser and no iMac.

**How it works.**
1. It reads the open, unfulfilled NAN orders through the official Admin API,
   using the NAN app's client credentials. It gets each order's address and
   total weight.
2. For each order it replays the admin's internal `FetchShippingRates` call.
   Jackie captured the template once and stored it with the cookies and the
   csrf token in `.secrets/nan_shopify_session.json`. The template keeps the
   captured label id and swaps in the order's destination and weight. Shopify
   returns that order's rates; a test with a different address and weight gave
   a different, correct set.
3. It posts the rates to `/api/shipping/nan-rates`.

**Auth.** The `JACKIE_API_TOKEN` bearer, the same one the other server scripts
use. It also sends `x-nan-rates-secret` once that secret exists in Vercel.

**Schedule (server crontab).**

| Tag | When | What |
|---|---|---|
| `NAN_RATES_PENDING` | every 2 min | Only the orders where "Обновить" was pressed |
| `NAN_RATES_ALL` | :03, :18, :33 and :48 | All open NAN orders, so snapshots stay under 30 min |

The log is `/var/log/nan-rates.log`.

**Session expiry.** If Shopify answers 401 or 403, the script posts a single
alert to Telegram topic 135, guarded by a flag file. Rates then stop
refreshing until the session is renewed by logging into the NAN admin again
and updating `.secrets/nan_shopify_session.json`.

**Known limits.**
- The package is the captured 12x10x6 box; the weight is the order weight
  plus 0.5 lb.
- For international orders, the customs HS code and origin come from the
  template, because the app has no `read_products` scope.

## Buying NAN labels from the Command Center (2026-10-26, evening)

Since API 2026-07 Shopify has an official `shippingLabelPurchase` mutation
([guide](https://shopify.dev/docs/apps/build/orders-fulfillment/order-management-apps/purchase-shipping-labels)).
It replaces the old "no purchase API" note at the top of this page.

**What it needs.**
- Inputs: `fulfillmentOrderId`, `shippingDatetime` (must be in the future),
  `totalWeight`, `packageInfo.customPackage {weight, dimensions, type}`,
  `preferredRateSelection {carrierCode, serviceCode}` and `notifyCustomer`.
- Shopify answers asynchronously, `PENDING_PURCHASE` → `PURCHASED` /
  `PURCHASE_FAILED`. The result's `shippingLabels` carry `trackingInfo` and
  the `shippingDocuments` LABEL PDF url.
- **FedEx is not supported** by the mutation. Of the 7 NAN orders
  #1372–#1378, 3 went FedEx; those stay a Shopify-admin buy.

**Probed without buying.**
- The NAN app has `write_orders` and `write_merchant_managed_fulfillment_orders`.
- A call on a CLOSED fulfillment order (#1378) with a past date returned the
  business error `FULFILLMENT_ORDER_INVALID`, not an access error. So the
  app-only token may use the mutation.
- Whether the shop's Shopify Shipping terms and billing let it actually buy
  is unknown until the first real purchase. That purchase happens only on
  the owner's word.

**Rate codes.** The admin's internal `FetchShippingRates` returns
`carrierCode`/`serviceCode` for every rate (e.g. `ups_shipping`/`93` UPS
Ground Saver, `usps`/`GroundAdvantage`, `fedex`/`fedex_ground_economy`). The
collector now forwards them as `carrier_code`/`service_code`, and
`normalizeNanRates` keeps them.

**Code.**
- `src/lib/shipping/nan-shopify-buy.ts` (+ test): token, find order, purchase
  once, poll.
- `src/app/api/shipping/nan-buy/route.ts`: `POST` buys, `GET ?order=` reads
  the state of the last purchase, `GET ?config=1` reports whether the
  credentials are set.
- Card: when the rate can be bought this way, "Buy label" buys here after a
  confirm, and tracking and PDF come back like any other order (Drive,
  auto-print, a bought `ShippingPlanItem`). FedEx, or a rate without codes,
  shows "Buy in Shopify" and opens Shopify admin.
- The card always shows "In Shopify pick: carrier · price · box · weight"
  with a Copy button.

**Duplicate guard.**
1. Shopify first: an OPEN fulfillment order and no tracking number, so a
   label bought anywhere blocks.
2. A per-order lock row, `Setting nan_label_buy:<order>`, is written BEFORE
   the mutation. If that write fails, nothing is bought.
3. The mutation is sent once. An unknown outcome is recorded as `unknown`
   and never re-sent. Only a synchronous refusal or `PURCHASE_FAILED`
   (nothing bought) frees the order.

**Deep link to the Shopify label page.** None exists. The working page is
`/shipping_labels/purchase/<uuid>`, a session the "Create shipping label"
button creates. Order-id routes redirect to /orders. Checked in the server
browser, read-only.

**Not active yet.** Vercel needs `NANHEALTH_SHOP`, `NANHEALTH_CLIENT_ID` and
`NANHEALTH_CLIENT_SECRET`, the same values as the server's
`.secrets/shopify_nanhealth_app.env`. The Claude Code guard refused writing
them, so the owner or Jackie sets them. Until then the page keeps opening
Shopify admin.
