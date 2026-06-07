# 🌱 Walmart Growth — Listing Quality (Phase A)

## Суть
Новый модуль **Walmart Growth** (вкладка в сайдбаре, `/walmart-growth`) —
это «движок роста продаж». Walmart ранжирует листинги в поиске и решает,
давать ли Buy Box / Pro Seller Badge, в основном по **Listing Quality
Score**. Модуль вытягивает этот скор через Insights API и превращает его в
конкретный **worklist по каждому SKU** — что именно чинить.

### Живой замер 2026-06-07 (store1 SIRIUS TRADING, seller 10001624309)
Общий **Listing Quality = 53.19 / 100**. Разбивка по 6 компонентам:

| Компонент | Балл | Статус |
|---|---|---|
| Content & Discoverability | 89.9 | 🟢 |
| Published & in stock (transactibility) | 93.0 | 🟢 |
| Price competitiveness | 69.0 | 🟡 |
| Offer | 35.9 | 🔴 |
| Ratings & Reviews | 19.8 | 🔴 |
| Shipping speed | 14.9 | 🔴 |

Каталог = **4017 товаров**. Главная находка: **419 из первых 600** товаров
получают трафик (page views), но **0 конверсии** — деньги на столе. Самые
большие системные рычаги: shipping speed (нет fast&free почти везде), нет
отзывов, out-of-stock, и price-конкурентоспособность.

## Что под капотом

### API (Insights, проверено живьём)
- `GET /v3/insights/items/listingQuality/score?wfsFlag=false` — seller-level
  скор + 6 компонентов. Мгновенно.
- `POST /v3/insights/items/listingQuality/items?limit=200[&nextCursor=…]`
  (body `{}`, **обязателен `Content-Type: application/json`** даже с пустым
  телом). Per-item: компоненты, Walmart-овский `priority`, конкретные
  проблемы (missing/invalid атрибуты, орфография, капитализация),
  `isInStock`, `isFastAndFreeShipping`, `ratingCount`, и встроенная
  30-дневная статистика (pageViews / conversionRate / GMV / units).

### ⚠️ Rate-bucket gotcha
У endpoint `listingQuality/items` **крошечный rate-bucket** (~1 запрос /
12-15с устойчиво; `limit` максимум 200 → ~21 страница на 4017 товаров;
`limit≥500` → 520). Walmart **не шлёт** `x-next-replenish-time` для него.
Полный свип не влезает в один прогон cron (лимит 300с), поэтому синк
сделан **возобновляемым по курсору**:
- На свежем свипе пишется seller-snapshot и ставится `sweepStartedAt`.
- Каждый прогон тянет страницы от сохранённого `cursor` с паузами ~13с,
  пока не упрётся в budget / maxPages / 429 / конец курсора.
- `cursor` сохраняется после каждой страницы (`WalmartLqSyncState`).
- Когда курсор кончился — свип завершён: прун товаров, не виденных в этом
  свипе (`syncedAt < sweepStartedAt`), `lastFullSweepAt`, сброс курсора.
- Прун **только** при чистом завершении — падение в середине ничего не
  удаляет (как catalog-cache).

## Связано с
- `src/lib/walmart/listing-quality.ts` — fetch score + `fetchListingQualityPage`
  + дистилляция per-item проблем (`distillItem`)
- `src/lib/walmart/persist-listing-quality.ts` — возобновляемый `syncListingQuality`
- `src/app/api/walmart/growth/listing-quality/route.ts` — GET (worklist + rollup)
- `src/app/api/walmart/growth/listing-quality/sync/route.ts` — POST (ручной свип)
- `src/app/api/cron/walmart-listing-quality/route.ts` — cron, каждые 2 часа
  (`vercel.json`: `15 */2 * * *`)
- `src/components/walmart-growth/ListingQualityDashboard.tsx` + `src/app/walmart-growth/page.tsx`
- Модели: `WalmartListingQualitySnapshot`, `WalmartListingQualityItem`,
  `WalmartLqSyncState` (миграция `20260607130000_walmart_listing_quality`;
  Turso — `scripts/turso-migrate-walmart-listing-quality.mjs`)
- Диагностика: `scripts/diag-walmart-growth.ts` (зонд всех ростовых endpoint),
  `scripts/diag-walmart-lq-*.ts`, ручной синк `scripts/sync-walmart-lq.ts`

## Дальше (не в Phase A)
- **Phase B**: Buy Box report (`POST /v3/reports/reportRequests?reportType=BUYBOX`)
  + Item Performance report — где теряем Buy Box и на сколько $, какие SKU
  «трафик есть, продаж нет». Тоже крошечный rate-bucket у `/reports`.
- **Phase C**: write-APIs — цены (`/v3/price`), промо (Reduced/Clearance),
  репрайсер. Только под guardrail маржи ≥20% и одобрение.
- Не отдаётся нам: `listingQuality/categories` (404), `unpublished/counts`
  (500 на стороне Walmart).
