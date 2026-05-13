# Sales Cards on Dashboard

**Версия:** v1.0
**Введён:** 2026-05-12
**Phase:** 1 — Dashboard (превью будущего модуля Sales Analytics)
**Spec:** [SALES_CARDS_DASHBOARD_SPEC_v1_0.md](../SALES_CARDS_DASHBOARD_SPEC_v1_0.md)

---

## Цель
Ряд из 5 карточек продаж в верхней части Dashboard. Показывают gross revenue за разные периоды с фильтром по выбранным магазинам.

Этот ряд — превью полноценного модуля Sales Analytics (Phase 2 `/analytics`). API endpoint `/api/dashboard/sales` будет переиспользован той страницей.

---

## Периоды (все в America/New_York)

| Карточка | Окно | Сравнение |
|---|---|---|
| Sales today | 00:00 ET → сейчас | vs yesterday (полный) |
| Sales yesterday | весь предыдущий день ET | vs same day last week |
| Month to date | с 1-го числа текущего месяца → сейчас | vs last month same period (1-го → той же даты) |
| Last month | полный предыдущий месяц | — |
| Forecast | `MTD ÷ daysPassed × daysInMonth` (линейный) | vs last month |

`daysPassed` учитывает текущее время суток (часовая дробь), так что прогноз плавно «накатывается» в течение дня, а не скачет на полночь.

---

## Источники данных

- **AmazonOrder** (Prisma): `purchaseDate`, `orderTotal`, `status`, `storeIndex`
- **WalmartOrder** (Prisma): `orderDate`, `orderTotal`, `status`, `storeIndex`
- Исключаются записи со статусом из `["Canceled", "Cancelled"]` (US/UK spelling). Это **gross**, не net — возвраты не вычитаются.

Маппинг `Store.id → storeIndex` идёт через таблицу `Store` (см. [store-filter-system](store-filter-system.md)). Walmart-аккаунт в проекте один (`storeIndex = 1`) — фильтр строится бинарно «выбран Walmart или нет».

---

## API

`GET /api/dashboard/sales?storeIds=id1,id2,…`

Response (упрощённо):
```jsonc
{
  "today":     { "value": 0,        "comparison": { "vs": "yesterday",            "baseline": 0,         "percent": null } },
  "yesterday": { "value": 648.67,   "comparison": { "vs": "sameDayLastWeek",      "baseline": 412.50,    "percent": +57.3 } },
  "mtd":       { "value": 8374.29,  "comparison": { "vs": "lastMonthSamePeriod",  "baseline": 17655.34,  "percent": -52.6 } },
  "lastMonth": { "value": 42573.53, "comparison": null },
  "forecast":  {
    "value": 21920.27,
    "comparison": { "vs": "lastMonth", "baseline": 42573.53, "percent": -48.5 },
    "meta": { "daysPassed": 11.84, "daysInMonth": 31, "method": "linear" }
  },
  "breakdown": { "amazon": {…то же 5 метрик…}, "walmart": {…} },
  "meta": { "tz": "America/New_York", "asOf": "ISO", "storeIdsApplied": [...] }
}
```

Все суммы — числа в USD. `percent: null` если baseline == 0.

Aggregation strategy: один `findMany` за весь нужный диапазон (`lastMonthStart → now`), потом bucketed в памяти. Это дешевле, чем 5+5 раздельных запросов.

---

## UI

`src/components/dashboard/SalesCardsRow.tsx`:
- Подписан на `useStoreFilter()`. При смене выбора — live refetch.
- Скрывается полностью, если selection пуст (parent Dashboard рендерит EmptyState).
- Skeleton с `animate-pulse` на 96px высоту, пока fetch in-flight.
- Forecast-карточка отличается фоном (`bg-surface-tint`) — выделена как «расчётная».

Цветовая логика стрелок-сравнений:
- Up (`%change >= 0`) → зелёный (`text-green`).
- Down (`%change < 0`) → **янтарный** (`text-warn-strong`), **не красный** (правило Salutem design system: никакого красного для финансовых отрицательных чисел).
- Neutral (`percent === null`) → серый.

Формат сумм:
- `< $10k` → `$1,234.56`
- `≥ $10k` → `$12,345`
- `≥ $1M` → `$1.23M`

Все числа — `tabular-nums` (через класс `tabular`).

---

## Backfill

Скрипт: `scripts/backfill-orders.ts`. Идемпотентный upsert по натуральным ключам.

Запуск:
```bash
# Все каналы, 90 дней
npx tsx scripts/backfill-orders.ts --days=90

# Только Walmart
npx tsx scripts/backfill-orders.ts --days=30 --channel=walmart

# Один Amazon store
npx tsx scripts/backfill-orders.ts --days=45 --channel=amazon --store=2
```

Использует существующие библиотеки:
- `src/lib/amazon-sp-api/orders.ts` → `getOrders({ storeId, createdAfter })`
- `src/lib/walmart/orders.ts` → `WalmartOrdersApi.paginate({ createdStartDate, createdEndDate })`

Env-зависимости: тоже же что у `/api/cron/walmart` и `/api/sync` — SP-API refresh tokens на каждый Amazon store, WALMART_CLIENT_ID/_SECRET/_SELLER_ID на Walmart.

> ⚠️ Бэкфил **не запускается автоматически**. Запуск ручной — SP-API throttles агрессивно, и Vladimir хотел сам решать когда.

---

## Зависимости

- ← [Store Filter System](store-filter-system.md) — selection driver
- ← [Database Schema](database-schema.md) — `AmazonOrder` + `WalmartOrder`
- ← [Amazon SP-API](amazon-sp-api.md) (через backfill)
- ← [Walmart API](walmart-api.md) (через backfill)
- → [Dashboard](dashboard.md) (renders the row)
- Phase 2 planned → `sales-analytics-module` (полноценная страница `/analytics`)

---

## Phase 2 — расширение

1. **Sparklines** внутри каждой карточки (30-дневный trend).
2. **Click → breakdown drawer**: popover с детализацией Amazon/Walmart/Store + Best/worst SKU.
3. **Smart forecast**: учёт weekend-патернов, holiday calendar.
4. **Net revenue mode**: переключатель Gross/Net (с учётом возвратов).
5. **Currency selector** (мульти-валюта при экспансии за пределы US).
