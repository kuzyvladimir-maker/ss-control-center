# SALES CARDS DASHBOARD — Reference Spec v1.0

> **Date:** 2026-05-12
> **Status:** Phase 1 (Dashboard) implemented
> **Author:** реализация по `docs/CLAUDE_CODE_PROMPT_DASHBOARD_SALES_CARDS.md`
> **Depends on:** [STORE_FILTER_SYSTEM_SPEC_v1_0.md](STORE_FILTER_SYSTEM_SPEC_v1_0.md)

Reference spec для ряда из 5 карточек продаж на Dashboard.

---

## 1. Поток данных

```
                   ┌──────────────────────────────┐
                   │  AmazonOrder + WalmartOrder  │
                   │  (Prisma, status NOT IN      │
                   │   Canceled/Cancelled)        │
                   └──────────────┬───────────────┘
                                  │ findMany lastMonthStart..now
                                  ▼
                   ┌──────────────────────────────┐
                   │ GET /api/dashboard/sales     │
                   │   buildPeriods() in memory   │
                   │   → 5 metrics + comparisons  │
                   │   + per-channel breakdown    │
                   └──────────────┬───────────────┘
                                  │
useStoreFilter →                  │ ← storeIds=
                                  ▼
                   ┌──────────────────────────────┐
                   │  <SalesCardsRow />           │
                   │  (5 cards, live refetch)     │
                   └──────────────────────────────┘
```

---

## 2. API contract

### `GET /api/dashboard/sales?storeIds=…`

Query:
- `storeIds` (optional CSV of `Store.id`) — отсутствие = всё. Пустая строка = ничего (zero payload).

Response shape:
```ts
type Period = {
  value: number;
  comparison: { vs: string; baseline: number; percent: number | null } | null;
};

type ForecastPeriod = Period & {
  meta: {
    daysPassed: number;
    daysInMonth: number;
    method: "linear";
    reason?: string;     // present only when forecast couldn't be computed
  };
};

interface Response {
  today: Period;          // 00:00 ET → now;            vs yesterday
  yesterday: Period;      // full prev day ET;          vs sameDayLastWeek
  mtd: Period;            // 1st of month → now;        vs lastMonthSamePeriod
  lastMonth: Period;      // full previous month;       no comparison
  forecast: ForecastPeriod; // mtd / daysPassed * daysInMonth; vs lastMonth
  breakdown: {
    amazon: Periods | null;   // same 5 fields, Amazon-only
    walmart: Periods | null;  // same 5 fields, Walmart-only
  };
  meta: { tz: "America/New_York"; asOf: ISO; storeIdsApplied: string[] };
}
```

Edge cases:
- `baseline === 0` → `percent: null` (UI shows "—" / "(no data)")
- `daysPassed < 1` → forecast.value === 0, comparison === null, meta.reason set
- selectedStoreIds == [] → API returns `emptyResponse()` без походов в БД
- DST переходы → `date-fns-tz` resolves в локальное ET, никаких ручных смещений

---

## 3. Status filter

| Канал | Cancelled spelling |
|---|---|
| Amazon | `"Canceled"` (US) — но добавлен `"Cancelled"` в `notIn` на всякий |
| Walmart | `"Cancelled"` (UK) — плюс `"Canceled"` для симметрии |

Решение: `notIn: ["Canceled", "Cancelled"]` для обоих — лишняя строка-фильтр не дороже, чем риск пропуска.

---

## 4. Store resolution

`storeIds` (`Store.id`) → нативные ключи:
- Amazon: `Store.storeIndex` ∈ {1..5} → `AmazonOrder.storeIndex IN (…)`.
- Walmart: бинарный флаг `walmartSelected` (есть ли хоть один Walmart в selection) → `WalmartOrder` без `storeIndex` фильтра, т.к. сейчас Walmart-аккаунт один (storeIndex=1). При добавлении второго — заменить на `storeIndex IN (…)` как у Amazon.

Этот трюк держит API совместимым с одним и несколькими Walmart-аккаунтами без миграции, ценой одной строчки логики на бэке.

---

## 5. Forecast formula

Простой линейный:
```
forecast = MTD / daysPassed * daysInMonth
daysPassed = dayOfMonth - 1 + (hours + minutes/60) / 24
```

`daysPassed` дробный — учитывает часовой прогресс дня, чтобы прогноз не делал ступенек на полночь.

Не пытается учитывать weekend, holidays, sales spikes. Это намеренно — Phase 2 (Sales Analytics) может добавить умный forecast.

---

## 6. UI rules (design system)

- Цвета: up → `--green`, **down → `--warn-strong` (амбер, не красный!)**, neutral → ink-3.
- Формат сумм: `$1,234.56` < $10k, `$12,345` ≥ $10k, `$1.23M` ≥ $1M.
- `tabular` (tabular-nums) на всех числах.
- Forecast-карточка выделена `bg-surface-tint`.
- Skeleton: `animate-pulse`, фиксированная высота 96px.
- Grid: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5` — адаптивно от mobile до desktop.
- Ряд скрыт, если selection пуст (parent Dashboard уже показывает EmptyState).

---

## 7. Backfill script

`scripts/backfill-orders.ts` — идемпотентен, upserts по натуральным ключам.

CLI:
```
--days=N       (default 90)
--channel=amazon | walmart | both  (default both)
--store=N      (Amazon storeIndex 1..5; ignored for Walmart)
```

Используемые libs:
- `getOrders({ storeId, createdAfter })` из `src/lib/amazon-sp-api/orders.ts`
- `WalmartOrdersApi.paginate({ createdStartDate, createdEndDate })` из `src/lib/walmart`

NOT auto-run. Vladimir запускает руками (или future cron) когда нужен бэкфил. Заявленных в логе результатов покрытие можно проверить через финальный aggregate.

---

## 8. Файлы (Phase 1)

```
src/
├── app/
│   ├── api/dashboard/sales/route.ts        [NEW]
│   └── page.tsx                            [MOD] <SalesCardsRow /> above KPI row
├── components/
│   └── dashboard/
│       └── SalesCardsRow.tsx               [NEW]

scripts/
└── backfill-orders.ts                      [NEW]

docs/
├── SALES_CARDS_DASHBOARD_SPEC_v1_0.md      [NEW]
└── wiki/
    ├── index.md                            [MOD]
    ├── CONNECTIONS.md                      [MOD]
    └── sales-cards-dashboard.md            [NEW]

package.json + lock                          [MOD] +date-fns, +date-fns-tz
```

---

## 9. Известные ограничения

| # | Issue | Mitigation |
|---|---|---|
| 1 | AmazonOrder data в БД на сегодня устарел до 2026-04-11. Карточки `today`/`yesterday`/`mtd` показывают нули или неполные суммы. | Запустить `backfill-orders.ts --days=60 --channel=amazon`. SP-API ограничивает 90 днями. |
| 2 | Walmart-сторсов сейчас один — `walmartSelected` это бинарный флаг. | При добавлении второго Walmart-аккаунта: switch to `storeIndex IN (…)` filter, аналогично Amazon. |
| 3 | Forecast линейный — не учитывает weekend / праздники / сезон. | Phase 2 умный forecast. |
| 4 | Net vs Gross — сейчас только Gross. Возвраты не учитываются. | Phase 2 toggle с учётом `WalmartReconTransaction.transactionType = "Refunds"` + Amazon refunds (нужно добавить sync). |
| 5 | Cron автообновления заказов в реальном времени не настроен. | Vercel cron `/api/cron/orders` (TODO в Phase 2). |

---

## 10. Phase 2 — расширение

1. **`/analytics` page** — полноценный модуль Sales Analytics, переиспользует `/api/dashboard/sales`.
2. **Sparklines** в каждой карточке (30 точек).
3. **Drill-down drawer** на клик по карточке: per-store breakdown + top SKUs.
4. **Best/Worst day-of-week** виджет.
5. **Smart forecast** с учётом weekend / holiday calendar.
6. **Gross/Net toggle** на странице.
7. **Currency selector** (mult-currency support).
