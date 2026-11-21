# Shipping Labels: FedEx rates missing from Pick rate on ship-today (2026-11-20)

Owner report (Telegram topic 135, 19:45 ET): Veeqo offered "FedEx 2Day® One
Rate" $17.52 (Amazon rates, delivery Tue Nov 24) for 114-2900934-1081853, the
command center's Pick rate dialog did not.

**Cause.** For ship date = today the dialog (`/api/shipping/rates?shipDate=`)
quotes the Rate Shopping API with `preferred_shipment_date = today 16:00Z`
(11:00 ET). Once that moment is past, Veeqo answers without any FedEx
service: 12 rates, 0 FedEx — while the allocation pool
(`GET /shipping/rates/{allocation}`, what Veeqo's own screen shows) had 22,
11 of them FedEx. Later ship days were not affected (22 rates incl. One Rate).
No client-side filter was involved — the dialog renders the API list as is.

**Fix** (commit `52fa372f4`). On the ship-today path the route also fetches
the allocation pool and appends services the quote lacks
(`src/lib/shipping/rate-pool-merge.ts`, key = carrier + normalized title;
the quote's row wins when both have it; appended rows carry
`source: "allocation"`). A pool failure falls back to the quote only. The buy
re-quotes against that same pool, so an appended rate is buyable; together
with the manual-override fix ([manual override requote price](shipping-manual-override-requote-price-2026-11-20.md))
the picked price/EDD is what the guard checks.

Tests: `src/lib/shipping/__tests__/rate-pool-merge.test.ts`.

**Prod check (read-only).** `GET /api/shipping/rates?orderId=2286919292&shipDate=2026-11-20`:
23 rates, 11 FedEx, "FedEx 2Day® One Rate" $17.52, EDD Tue Nov 24.
`scripts/diag-override-requote.ts` against the pool: match → One Rate $17.52.

**Not changed.** The plan algorithm's own ship-today quote uses the same
16:00Z anchor and may likewise miss FedEx late in the day; untouched here.
