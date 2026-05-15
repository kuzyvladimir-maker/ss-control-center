# 🏪 Walmart Marketplace API — Интеграция

## Суть
Walmart Marketplace API v3 — прямой доступ к заказам, возвратам, reconciliation reports и метрикам Seller Performance для аккаунта SIRIUS TRADING INTERNATIONAL LLC. Получен 2026-04-18, полная интеграция описана в [CLAUDE_CODE_PROMPT_WALMART_API_INTEGRATION.md](../CLAUDE_CODE_PROMPT_WALMART_API_INTEGRATION.md).

## Аккаунт
| Store | Название | Seller ID | ClientId |
|-------|----------|-----------|----------|
| STORE1 | SIRIUS TRADING INTERNATIONAL LLC | 10001624309 | `0595b090-82f9-4f56-9216-5aa68a5d3cc5` |

Status: Active. Full seller access (без Solution Provider delegation).

## Auth (OAuth 2.0 Client Credentials)
- Token endpoint: `POST https://marketplace.walmartapis.com/v3/token` с Basic Auth
- Token lifetime: ~900 сек (15 мин)
- Refresh strategy: кеш в памяти, refresh за 60 сек до expiry
- Required headers на каждом вызове: `Authorization: Bearer`, `WM_SEC.ACCESS_TOKEN`, `WM_QOS.CORRELATION_ID` (новый uuid per request), `WM_SVC.NAME: Walmart Marketplace`, `Accept: application/json`

## Rate Limits
- Token bucket per seller per endpoint
- Response headers: `x-current-token-count`, `x-next-replenish-time`
- На 429 → exponential backoff с jitter (base 1s, max 60s)
- Если `x-current-token-count` < 2 → sleep до `x-next-replenish-time`

## Используемые модули
| Модуль | Walmart API endpoints | Назначение |
|--------|------------------------|------------|
| Auth | `/v3/token` | OAuth 2.0 Client Credentials |
| Client | `lib/walmart/client.ts` | Базовый HTTP клиент с rate-limit логикой |
| Orders | `/v3/orders`, `/v3/orders/released`, `/v3/orders/{id}` | Заказы, cancel, refund, acknowledge |
| Returns | `/v3/returns`, `/v3/returns/{id}/refund` | Возвраты и refund по ним |
| Reports | `/v3/report/reconreport/*` | Reconciliation reports → Adjustments |
| Seller Performance | `/v3/insights/performance/{metric}/summary` | Метрики → Account Health (см. ниже) |

## Используется модулями SS Control Center
- **Customer Hub** — orders + returns sync (заменяет screenshot-only схему)
- **Shipping Labels** — verification endpoint перед покупкой через Veeqo
- **Shipment Monitor** — Level 1.5 tracking verification
- **Adjustments Monitor** — primary source для Walmart recon (аналог Amazon Finances API)
- **Account Health** — новая секция Walmart Performance
- **Dashboard** — карточка со сводкой

## НЕ используется в Phase 1
- Inventory API (Phase 2 — Product Listings)
- Price API (Phase 2 — Buy Box)
- Items API (Phase 2 — Product Listings)

## ⚠️ Отличия от Amazon SP-API
- **Нет Messaging API** — нет отдельного buyer-seller chat; коммуникация через cancel/refund/return workflows + Walmart Contact Us form
- **Нет отдельного Chargebacks API** — chargebacks попадают в recon report как adjustments
- **Нет отдельного Feedback API** — частично доступно через Seller Performance
- **1 аккаунт** (STORE1) vs 5 Amazon аккаунтов

## ⚠️ Два ключа в Walmart Developer Portal
В портале разработчика существуют ДВЕ пары production keys:
1. **Veeqo** (ClientId: `c479b706-cb19-4f72-bc96-ca15b4b20e4f`) — delegated access для Veeqo. **НЕ ТРОГАТЬ.** Через него Veeqo покупает shipping labels.
2. **My API Key** (ClientId: `0595b090-...`) — наш ключ для SS Control Center.

Никогда не путать. Сброс Veeqo-ключа сломает Shipping Labels.

## Связанные файлы
- `lib/walmart/client.ts` — auth + rate-limit aware client
- `lib/walmart/orders.ts` — Orders API wrapper
- `lib/walmart/returns.ts` — Returns API wrapper
- `lib/walmart/reports.ts` — Reconciliation reports
- `lib/walmart/seller-performance.ts` — Performance metrics
- `lib/walmart/types.ts`, `lib/walmart/mappers.ts`
- `src/app/api/{customer-hub,shipment-monitor,adjustments,account-health,shipping-labels}/walmart/` — API routes

## Переменные окружения
```
WALMART_CLIENT_ID_STORE1=0595b090-82f9-4f56-9216-5aa68a5d3cc5
WALMART_CLIENT_SECRET_STORE1=<из Developer Portal>
WALMART_STORE1_NAME="SIRIUS TRADING INTERNATIONAL LLC"
WALMART_STORE1_SELLER_ID=10001624309
WALMART_API_BASE_URL=https://marketplace.walmartapis.com
WALMART_API_VERSION=v3
```

## Prisma модели
- `WalmartOrder` — snapshot заказов
- `WalmartReconTransaction` — recon report rows
- `WalmartPerformanceSnapshot` — история метрик Account Health
- `BuyerMessage.marketplace` + `.walmartOrderId` / `.walmartReturnId` — унификация с Amazon

## 🔗 Связи
- **Используется в:** [Customer Hub](customer-hub.md), [Account Health](account-health.md), [Adjustments Monitor](adjustments-monitor.md), [Shipment Monitor](shipment-monitor.md), [Shipping Labels](shipping-labels.md), [Dashboard](dashboard.md)
- **Связан с:** [Veeqo API](veeqo-api.md) (Veeqo использует delegated Walmart key), [External API Auth](external-api-auth.md)
- **Заменяет:** screenshot-only схему для Walmart в [Customer Hub](customer-hub.md) (v2.1)
- **Обновляет:** [Walmart ограничения](walmart-restrictions.md) — убирает "API ключ отсутствует"
- **См. также:** [Database Schema](database-schema.md) (`WalmartOrder`, `WalmartReconTransaction`, `WalmartPerformanceSnapshot`), [Amazon SP-API](amazon-sp-api.md) (паттерны reused)

## Seller Performance API (Insights category)

**Status:** ✅ Working as of 2026-05-15 (v2)
**Base URL:** `https://marketplace.walmartapis.com/v3/insights/performance/{metric}/summary`
**Parameters:** `reportDuration={14|30|60|90}`, optional `shippingMethod={ALL_METHODS|TwoDay|OneDay}` (only on shipping-flavoured metrics)
**Previous shape:** `/v3/sellerPerformance/summary?windowDays=...` — gone, returns 404. Don't re-introduce.

### Metric paths

| Metric                       | URL segment        | Default window | shippingMethod | Rate field         |
|------------------------------|--------------------|----------------|----------------|--------------------|
| On-time delivery             | `otd`              | 30             | yes            | `overallRate`      |
| Cancellations                | `cancellations`    | 30             | no             | `cumulativeRate`   |
| Valid tracking               | `vtr`              | 30             | yes            | `cumulativeRate`   |
| Seller response              | `srr`              | 30             | no             | `overallRate`      |
| On-time shipment             | `ots`              | 30             | yes            | `overallRate`      |
| Negative feedback            | `negativeFeedback` | 60             | no             | `cumulativeRate`   |
| Returns                      | `returns`          | 60             | no             | `cumulativeRate`   |
| Item not received            | `inr`              | 60             | no             | `cumulativeRate`   |
| Ship-from accuracy           | `sfla`             | 30             | no             | `overallRate`      |
| Carrier method accuracy      | `cma`              | 30             | no             | `overallRate`      |
| ~~Refunds~~                  | ~~`refunds`~~      | —              | —              | DEPRECATED — skip  |

The response splits into two shapes — "overall-style" carries
`overallRate` + `overallTrend`; "cumulative-style" carries
`cumulativeRate` + `cumulativeRateTrend`. The mapping above tells the
parser which key to read per metric. See `src/lib/walmart/seller-performance.ts`.

### HTTP statuses

| Status | Meaning | Action |
|---|---|---|
| 200 | Data returned | Parse, write WalmartPerformanceSnapshot |
| 204 | No data yet (new account / insufficient orders) | Surface as "No data yet" in UI, NOT an error |
| 400 | Bad parameter | Check `reportDuration` |
| 401 | Auth | Client refreshes token + retries once |
| 403 | Scope missing | Hit `/v3/token/detail` to inspect scopes |
| 404 | Wrong URL | Should not happen with paths above |
| 429 | Rate limit | Exponential backoff w/ jitter |

### Code path
- `fetchAllPerformanceMetrics(client)` — fans out the 10 endpoints via `Promise.allSettled`. Per-metric failures don't kill the rest.
- `persistPerformanceSnapshots(prisma, storeIndex, data)` — writes one `WalmartPerformanceSnapshot` row per metric, computes `isHealthy` against the published Walmart thresholds, buckets `status` (GOOD/MONITOR/URGENT/NO_DATA/ERROR), emits the flat `{onTimeDelivery30d: 91.2, ...}` map for the critical alerts evaluator.
- Owned by `/api/cron/account-health-walmart` (daily 03:00 UTC). Walmart refreshes datasets ~24h on their side, so daily is the right cadence.
- Diagnostics: admin-only `POST /api/settings/walmart-diagnose` probes `/v3/token/detail` + the legacy paths to confirm scopes when something breaks.

### Headers (every call)
```
WM_SEC.ACCESS_TOKEN: <access_token>
WM_QOS.CORRELATION_ID: <UUID — unique PER request, otherwise Walmart silently dedupes>
WM_SVC.NAME: Walmart Marketplace
Accept: application/json
```

## История
- 2026-04-18: Wiki-статья создана. API ключ получен, начата интеграция. Промпт для Claude Code — `docs/CLAUDE_CODE_PROMPT_WALMART_API_INTEGRATION.md`
- 2026-05-15: Seller Performance v2 — переход с `/v3/sellerPerformance/*` на `/v3/insights/performance/{metric}/summary`. 10 параллельных endpoints, поддержка 204 = "No data yet", late-shipment = 100 − on-time-shipment в UI слое. Промпт — `docs/CLAUDE_CODE_PROMPT_WALMART_PERFORMANCE_FIX.md`.
