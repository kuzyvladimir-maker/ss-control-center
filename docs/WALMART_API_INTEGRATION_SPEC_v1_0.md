# Walmart Marketplace API Integration — SPEC v1.0

> **Status:** v1.0 implemented (2026-04-18)
> **Owner:** Vladimir (kuzy.vladimir@gmail.com)
> **Source code:** `src/lib/walmart/*`, `src/app/api/*/walmart/*`
> **Related wiki:** [`docs/wiki/walmart-api.md`](wiki/walmart-api.md),
> [`docs/wiki/walmart-restrictions.md`](wiki/walmart-restrictions.md),
> [`docs/wiki/CONNECTIONS.md`](wiki/CONNECTIONS.md)

This is the source of truth for the Walmart Marketplace API layer in SS
Control Center. Future versions (v1.1, v2.0) edit this file; the
short-lived prompt that seeded v1.0 lives at
[`CLAUDE_CODE_PROMPT_WALMART_API_INTEGRATION.md`](CLAUDE_CODE_PROMPT_WALMART_API_INTEGRATION.md).

---

## 1. Accounts & credentials

| Store | Legal entity | Seller ID | Env vars |
|---|---|---|---|
| 1 | SIRIUS TRADING INTERNATIONAL LLC | `10001624309` | `WALMART_CLIENT_ID_STORE1`, `WALMART_CLIENT_SECRET_STORE1`, `WALMART_STORE1_NAME`, `WALMART_STORE1_SELLER_ID` |

**Shared env vars:**
- `WALMART_API_BASE_URL=https://marketplace.walmartapis.com`
- `WALMART_API_VERSION=v3`
- `CRON_SECRET` — bearer token used by Vercel cron → `/api/cron/walmart`

> ⚠️ There is a **second** key pair in the Developer Portal owned by Veeqo
> (`ClientId: c479b706-...`). Do NOT touch it — resetting it would break
> Veeqo's Shipping Labels flow.

## 2. Authentication

OAuth 2.0 Client Credentials, `POST /v3/token` with `Authorization: Basic
{base64(clientId:clientSecret)}`. Tokens live ~15 min; `WalmartClient`
caches them and refreshes 60 s before expiry.

**Required headers on every request** (added automatically by
`WalmartClient.request()`):
- `Authorization: Bearer {token}`
- `WM_SEC.ACCESS_TOKEN: {token}`   (dupe, some endpoints need it)
- `WM_QOS.CORRELATION_ID: {new UUID per request}`
- `WM_SVC.NAME: Walmart Marketplace`
- `Accept: application/json` (unless overridden)

## 3. Rate limits

Walmart uses a token-bucket scheme, per-seller per-endpoint. The client:
1. Reads `x-current-token-count` and `x-next-replenish-time` from every
   response.
2. If `<2` tokens remain, schedules a sleep until `x-next-replenish-time`
   before the next request (applies across subsequent calls on the same
   client instance).
3. On `429` / `5xx`, exponential backoff with jitter (base 1 s, max 60 s,
   max 4 retries); honours `Retry-After` if present.

## 4. Library layout

```
src/lib/walmart/
├── client.ts              — WalmartClient (auth + rate limit)
├── types.ts               — domain shapes (Order, Return, ReconTx, Perf)
├── mappers.ts             — wire→domain normalizers
├── orders.ts              — WalmartOrdersApi
├── returns.ts             — WalmartReturnsApi
├── reports.ts             — WalmartReportsApi (reconciliation)
├── seller-performance.ts  — WalmartSellerPerformanceApi
└── index.ts               — barrel re-exports
```

**Import convention:** inside the repo, prefer the named exports from the
barrel: `import { WalmartClient, WalmartOrdersApi } from "@/lib/walmart"`.

## 5. Endpoints matrix

### Orders — `WalmartOrdersApi`

| Method | Walmart endpoint | Purpose |
|---|---|---|
| `getAllOrders(params)` | `GET /v3/orders` | List orders with filters + pagination |
| `getReleasedOrders(params)` | `GET /v3/orders/released` | Created-status orders ready to ship |
| `getOrderById(po)` | `GET /v3/orders/{po}` | Full order detail |
| `paginate(params)` | — | Async generator over all pages |
| `acknowledgeOrder(po)` | `POST /v3/orders/{po}/acknowledge` | Mark order acknowledged |
| `cancelOrderLines(po, lines)` | `POST /v3/orders/{po}/cancel` | Cancel one or more line items |
| `shipOrderLines(po, lines)` | `POST /v3/orders/{po}/shipping` | Mark shipped + tracking (normally done by Veeqo) |
| `refundOrderLines(po, lines)` | `POST /v3/orders/{po}/refund` | Issue refund on shipped order |

**Pagination note:** once Walmart returns `nextCursor`, subsequent calls
must send ONLY the cursor. The wrapper handles this automatically —
don't mix `createdStartDate` with `nextCursor`.

### Returns — `WalmartReturnsApi`

| Method | Walmart endpoint | Purpose |
|---|---|---|
| `getAllReturns(params)` | `GET /v3/returns` | List returns + paginate |
| `paginate(params)` | — | Async generator |
| `issueReturnRefund(returnId, lines)` | `POST /v3/returns/{id}/refund` | Issue refund on a return |

**Required params:** `returnCreationStartDate` AND `returnCreationEndDate`
(Walmart rejects start-only).

### Reports — `WalmartReportsApi`

| Method | Walmart endpoint | Purpose |
|---|---|---|
| `getAvailableReconReportDates()` | `GET /v3/report/reconreport/availableReconFiles` | List settlement dates (returned as `MMDDYYYY`, we normalize to `YYYY-MM-DD`) |
| `getReconReport({reportDate, pageNo, limit})` | `GET /v3/report/reconreport/reconFile` | Fetch one page |
| `getFullReconReport(date)` | — | Walk all pages, return all rows |

### Seller Performance — `WalmartSellerPerformanceApi`

| Method | Walmart endpoint | Purpose |
|---|---|---|
| `getSummary(windowDays)` | `GET /v3/sellerPerformance/summary` | Aggregated metric percentages |
| `getMetricReport(metric, windowDays)` | `GET /v3/sellerPerformance/report` | XLSX drill-down |
| `getSimplifiedShippingSettingsReport()` | `GET /v3/sellerPerformance/simplifiedShippingSettings` | Settings compliance |

**Windows:** `14 | 30 | 60 | 90`.

**Metrics & thresholds** (from Walmart Seller Performance Standards;
confirm against current docs when thresholds change):

| Metric | Threshold |
|---|---|
| `onTimeDelivery` | ≥ 95 % |
| `validTrackingRate` | ≥ 99 % |
| `responseRate` | ≥ 95 % |
| `cancellationRate` | ≤ 2 % |
| `refundRate` | — (monitored only) |
| `carrierMethodAccuracy` | ≥ 95 % |
| `onTimeShipment` | ≥ 99 % |
| `shipFromLocationAccuracy` | ≥ 99 % |

## 6. Prisma models

- `WalmartOrder` — keyed on `purchaseOrderId`, full `rawData` JSON
  preserves unmodeled fields.
- `WalmartReconTransaction` — per-row settlement entries. Dedup compound
  unique key: `(transactionPostedTimestamp, purchaseOrderId, transactionType, amount)`.
- `WalmartPerformanceSnapshot` — time-series of metric values for trend
  plotting (no upsert — we keep history).
- `BuyerMessage.walmartOrderId` + `walmartReturnId` — links messages to
  source Walmart data when `channel = 'Walmart'`.

## 7. Integration routes

| Route | Purpose |
|---|---|
| `POST /api/customer-hub/walmart/orders/sync` | Pull orders (30 d) → upsert `WalmartOrder` + create `BuyerMessage` on triggers |
| `POST /api/customer-hub/walmart/returns/sync` | Pull returns (30 d) → create `BuyerMessage` |
| `GET /api/customer-hub/walmart/orders/{id}` | Fetch single order from Walmart |
| `PATCH /api/customer-hub/walmart/orders/{id}` | Acknowledge / cancel / refund lines |
| `GET /api/shipping-labels/walmart/verify/{id}` | Pre-buy safety check (cancelled/shipped?) |
| `POST /api/shipment-monitor/walmart/sync` | Drift detection for Shipped/Delivered (7 d) |
| `POST /api/adjustments/walmart/sync` | Walk all recon dates → insert transactions |
| `POST /api/account-health/walmart/sync` | Seller Performance snapshots (30 + 90 d) |
| `GET  /api/account-health/walmart/sync` | Latest snapshot per (window, metric) |
| `GET /api/cron/walmart` | Cron entry — runs all of the above nightly |

## 8. Scheduling

`vercel.json` declares a daily cron at `0 6 * * *` UTC (~01:00 ET) →
`/api/cron/walmart`. The handler runs all sub-jobs in parallel, each
returning its own ok/error block so one failure doesn't abort the rest.

Cron auth: Vercel sends `Authorization: Bearer $CRON_SECRET`; the route
rejects anything else.

## 9. Triggers for BuyerMessage creation

The Customer Hub sync only surfaces orders that need attention:

- `Cancelled` (not by us) → category **C7**, priority MEDIUM
- `Shipped` and past `estimatedDeliveryDate` + 1 day → category **C2**, priority HIGH
- Any `Return` from Returns API → category **C5**, priority MEDIUM

Screenshot upload (`WalmartCaseModal`) remains available as a fallback for
edge cases the API doesn't cover (seller-center disputes, bespoke
buyer→seller contact).

## 10. Out of scope for v1.0

- **Inventory API** / **Price API** / **Items API** — deferred to Phase 2.
- **Multi-store Walmart** — only one account exists today. The client is
  already per-store (`new WalmartClient(n)`); add env vars when a second
  account is onboarded.
- **Walmart messaging** — Walmart has no buyer-seller chat equivalent of
  Amazon's messaging API; all customer contact for Walmart flows through
  return/refund/cancel workflows or the seller-center Contact Us form.

## 11. Smoke test

`npx tsx scripts/walmart-smoke-test.ts` exercises:
1. `/v3/token` (auth)
2. `/v3/orders` (last 30 d, limit 5)
3. `/v3/returns` (last 30 d, limit 5)
4. `/v3/report/reconreport/availableReconFiles`

Expected on a healthy account: ≥1 orders, some returns, ≥1 recon date.
The script also prints `tokens: N` per response so rate-limiter behaviour
is observable.

## 12. Change log

| Version | Date | Notes |
|---|---|---|
| v1.0 | 2026-04-18 | Initial integration: client + all five API wrappers, Prisma models, 9 integration routes, cron, UI surfaces in Dashboard / Customer Hub / Account Health / Frozen Analytics baseline card. |
