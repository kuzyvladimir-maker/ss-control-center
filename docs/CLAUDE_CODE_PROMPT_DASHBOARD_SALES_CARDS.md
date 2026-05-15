# CLAUDE CODE PROMPT — Dashboard Sales Cards (5 periods) v1.0

> **Target repo:** `kuzyvladimir-maker/ss-control-center`
> **Date:** 2026-05-12
> **Prepared by:** Vladimir (via Claude chat)
> **Branch:** `feature/dashboard-sales-cards`
> **Execution mode:** поэтапно, коммит после каждого этапа
> **DEPENDS ON:** `feature/dashboard-store-selector` (must be merged to main first)

---

## 🎯 КОНТЕКСТ

После реализации глобального селектора магазинов (`CLAUDE_CODE_PROMPT_DASHBOARD_STORE_SELECTOR.md`) на Dashboard нужно добавить **новый ряд из 5 карточек продаж** (Sales), который фильтруется по выбранным магазинам:

1. **Sales Today** — продажи за сегодня (00:00 ET → сейчас)
2. **Sales Yesterday** — продажи за вчера (полные сутки)
3. **MTD** (Month-to-Date) — с 1-го числа текущего месяца до сейчас
4. **Last Month** — полный прошлый месяц
5. **Forecast** — прогноз на текущий месяц (простой линейный)

Каждая карточка показывает большую сумму **gross revenue (брутто без вычетов)** и под ней индикатор сравнения с предыдущим периодом (% change).

Этот ряд — превью будущего модуля **Sales Analytics** (Phase 2). API endpoint, который мы создаём, будет переиспользован той полноценной страницей.

### ⚠️ Принципы (не нарушать)

- **Gross revenue** — сумма `orderTotal` для всех заказов кроме `Cancelled`. **Возвраты НЕ вычитаем** (это net, не gross).
- **Timezone — America/New_York** — все периоды считаются в ET, как везде в проекте.
- **Зависит от Store Filter** — карточки читают `selectedStoreIds` из `useStoreFilter()` (создан в предыдущем промпте). Live filtering.
- **Прогноз — простой линейный**: `MTD ÷ daysPassed × daysInMonth`.
- **Никакого красного для отрицательных финансовых чисел** (правило design system). Используем janтарный (`--accent-amber` или `#B57614`) для падения, зелёный для роста.
- **camelCase Prisma fields** — никаких snake_case.
- **shadcn/ui** для всех компонентов.
- **tabular-nums** на всех денежных значениях.
- **Никакого `localStorage`** для sales state — данные тянутся с бэка при каждом изменении фильтра.

### ⚠️ Источники данных

- **Amazon orders:** таблица `AmazonOrder` в Prisma. Поля минимум: `id`, `amazonOrderId`, `purchaseDate` (DateTime UTC), `orderTotal` (Float), `orderStatus` (String), `storeId` (String).
- **Walmart orders:** таблица `WalmartOrder` (добавлена с Walmart API integration v1.0). Поля: `id`, `purchaseOrderId`, `orderDate` (DateTime UTC), `orderTotal` (Float), `status`, `storeId`.

Если таблиц нет или поля называются иначе — использовать существующие имена, не переименовывать.

### ⚠️ Backfill требование (важно)

Для нормальной работы карточки **Last Month** в БД должны быть orders за прошлый месяц (минимум 60 дней назад). Для **Forecast** — текущий месяц.

**Первое действие при запуске промпта** — проверить через `npx prisma studio`:
- `AmazonOrder.findFirst()` отсортирован по `purchaseDate ASC` → дата самого старого заказа.
- `WalmartOrder.findFirst()` отсортирован по `orderDate ASC` → дата самого старого заказа.

Если самые старые orders младше **60 дней** — запустить бэкфил (см. Этап 1).

---

## 📐 АРХИТЕКТУРА

### 1. Бэкфил orders (если нужно)

Создать (или обновить если есть) `scripts/backfill-orders.ts`:

```typescript
// Запуск: npx tsx scripts/backfill-orders.ts --days=90
//
// Что делает:
// 1. Для каждого активного Amazon store — getOrders за N дней через SP-API.
//    Использовать существующий `src/lib/amazon-sp-api/orders.ts`.
//    Upsert в AmazonOrder по amazonOrderId (уникальное поле).
// 2. Для Walmart store — Walmart Orders API за N дней.
//    Использовать существующий `src/lib/walmart/orders.ts`.
//    Upsert в WalmartOrder по purchaseOrderId.
// 3. Логировать прогресс: "Salutem Solutions: synced 234 orders, 12 new..."

import { PrismaClient } from "@/generated/prisma";
import { getAmazonSpApiClient } from "@/lib/amazon-sp-api/client";
import { WalmartOrdersApi, WalmartClient } from "@/lib/walmart";
// ... импорты

const args = process.argv.slice(2);
const daysArg = args.find((a) => a.startsWith("--days="));
const days = daysArg ? parseInt(daysArg.split("=")[1]) : 90;

async function main() {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const prisma = new PrismaClient();
  const stores = await prisma.store.findMany({ where: { isActive: true } });

  for (const store of stores) {
    if (store.channel === "Amazon") {
      // ... call SP-API getOrders + upsert
    } else if (store.channel === "Walmart") {
      // ... call Walmart Orders API + upsert
    }
  }

  await prisma.$disconnect();
}

main().catch(console.error);
```

> Если функции `getOrders` в существующих библиотеках ещё нет — добавь её. Использовать pagination, retry, rate-limit-aware клиент.

Запустить: `npx tsx scripts/backfill-orders.ts --days=90`

Проверить: в `AmazonOrder` и `WalmartOrder` появились записи за апрель-март 2026.

---

### 2. Endpoint Sales

**`src/app/api/dashboard/sales/route.ts`** (новый):

```typescript
// GET /api/dashboard/sales?storeIds=id1,id2,id3
//
// Response:
// {
//   today:     { value, comparison: { vs: "yesterday", percent, baseline } },
//   yesterday: { value, comparison: { vs: "sameDayLastWeek", percent, baseline } },
//   mtd:       { value, comparison: { vs: "lastMonthSamePeriod", percent, baseline } },
//   lastMonth: { value, comparison: null },
//   forecast:  { value, comparison: { vs: "lastMonth", percent, baseline }, meta: { daysPassed, daysInMonth, method: "linear" } },
//   breakdown: { amazon: {...same 5 metrics...}, walmart: {...} },
//   meta:      { tz: "America/New_York", asOf: ISO-string, storeIdsApplied: [...] }
// }

import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@/generated/prisma";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { startOfDay, endOfDay, startOfMonth, endOfMonth, subDays, subMonths, getDaysInMonth } from "date-fns";

const TZ = "America/New_York";
const prisma = new PrismaClient();

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const storeIdsParam = url.searchParams.get("storeIds");
    const storeIds = storeIdsParam ? storeIdsParam.split(",").filter(Boolean) : null;

    // Если фильтр пуст — вернуть нули
    if (storeIds && storeIds.length === 0) {
      return NextResponse.json(emptyResponse());
    }

    // Получить выбранные магазины с их channel
    const stores = storeIds
      ? await prisma.store.findMany({ where: { id: { in: storeIds } } })
      : await prisma.store.findMany({ where: { isActive: true } });

    const amazonStoreIds = stores.filter((s) => s.channel === "Amazon").map((s) => s.id);
    const walmartStoreIds = stores.filter((s) => s.channel === "Walmart").map((s) => s.id);

    // Periods (в ET)
    const nowEt = toZonedTime(new Date(), TZ);
    const todayStart = startOfDay(nowEt);
    const yesterdayStart = startOfDay(subDays(nowEt, 1));
    const yesterdayEnd = endOfDay(subDays(nowEt, 1));
    const sameDayLastWeekStart = startOfDay(subDays(nowEt, 7));
    const sameDayLastWeekEnd = endOfDay(subDays(nowEt, 7));
    const monthStart = startOfMonth(nowEt);
    const lastMonthStart = startOfMonth(subMonths(nowEt, 1));
    const lastMonthEnd = endOfMonth(subMonths(nowEt, 1));
    
    // MTD сравнение: с 1-го по сегодняшнюю дату прошлого месяца
    const lastMonthSamePeriodEnd = new Date(lastMonthStart);
    lastMonthSamePeriodEnd.setDate(nowEt.getDate());
    lastMonthSamePeriodEnd.setHours(23, 59, 59, 999);
    
    // Считаем все 7 бакетов одним sweep по orders
    const earliestDate = lastMonthStart; // самая ранняя из всех нужных
    
    // Параллельно для Amazon и Walmart
    const [amazonOrders, walmartOrders] = await Promise.all([
      amazonStoreIds.length > 0
        ? prisma.amazonOrder.findMany({
            where: {
              storeId: { in: amazonStoreIds },
              purchaseDate: { gte: earliestDate, lte: nowEt },
              orderStatus: { notIn: ["Canceled", "Cancelled"] },
            },
            select: { purchaseDate: true, orderTotal: true },
          })
        : Promise.resolve([]),
      walmartStoreIds.length > 0
        ? prisma.walmartOrder.findMany({
            where: {
              storeId: { in: walmartStoreIds },
              orderDate: { gte: earliestDate, lte: nowEt },
              status: { notIn: ["Cancelled"] },
            },
            select: { orderDate: true, orderTotal: true },
          })
        : Promise.resolve([]),
    ]);

    // Bucket function
    const sumInRange = (orders: { date: Date; total: number }[], from: Date, to: Date) =>
      orders
        .filter((o) => o.date >= from && o.date <= to)
        .reduce((sum, o) => sum + (o.total || 0), 0);

    const amzOrders = amazonOrders.map((o) => ({ date: o.purchaseDate, total: o.orderTotal || 0 }));
    const wmtOrders = walmartOrders.map((o) => ({ date: o.orderDate, total: o.orderTotal || 0 }));
    const allOrders = [...amzOrders, ...wmtOrders];

    const todayValue = sumInRange(allOrders, todayStart, nowEt);
    const yesterdayValue = sumInRange(allOrders, yesterdayStart, yesterdayEnd);
    const sameDayLastWeekValue = sumInRange(allOrders, sameDayLastWeekStart, sameDayLastWeekEnd);
    const mtdValue = sumInRange(allOrders, monthStart, nowEt);
    const lastMonthValue = sumInRange(allOrders, lastMonthStart, lastMonthEnd);
    const lastMonthSamePeriodValue = sumInRange(allOrders, lastMonthStart, lastMonthSamePeriodEnd);

    // Forecast
    const dayOfMonth = nowEt.getDate();
    const hourFraction = (nowEt.getHours() + nowEt.getMinutes() / 60) / 24;
    const daysPassed = dayOfMonth - 1 + hourFraction;
    const daysInMonth = getDaysInMonth(nowEt);
    const forecastValue =
      daysPassed >= 1 ? (mtdValue / daysPassed) * daysInMonth : null;

    // Helper для % change
    const pct = (current: number, baseline: number): number | null =>
      baseline === 0 ? null : ((current - baseline) / baseline) * 100;

    const response = {
      today: {
        value: todayValue,
        comparison: {
          vs: "yesterday",
          baseline: yesterdayValue,
          percent: pct(todayValue, yesterdayValue),
        },
      },
      yesterday: {
        value: yesterdayValue,
        comparison: {
          vs: "sameDayLastWeek",
          baseline: sameDayLastWeekValue,
          percent: pct(yesterdayValue, sameDayLastWeekValue),
        },
      },
      mtd: {
        value: mtdValue,
        comparison: {
          vs: "lastMonthSamePeriod",
          baseline: lastMonthSamePeriodValue,
          percent: pct(mtdValue, lastMonthSamePeriodValue),
        },
      },
      lastMonth: {
        value: lastMonthValue,
        comparison: null,
      },
      forecast: forecastValue !== null
        ? {
            value: forecastValue,
            comparison: {
              vs: "lastMonth",
              baseline: lastMonthValue,
              percent: pct(forecastValue, lastMonthValue),
            },
            meta: { daysPassed: Number(daysPassed.toFixed(2)), daysInMonth, method: "linear" },
          }
        : { value: null, comparison: null, meta: { daysPassed: 0, daysInMonth, method: "linear", reason: "Insufficient data (less than 1 day passed)" } },
      breakdown: {
        amazon: buildBreakdown(amzOrders, /* periods */),
        walmart: buildBreakdown(wmtOrders, /* periods */),
      },
      meta: {
        tz: TZ,
        asOf: new Date().toISOString(),
        storeIdsApplied: stores.map((s) => s.id),
      },
    };

    return NextResponse.json(response);
  } catch (e) {
    console.error("[/api/dashboard/sales]", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function emptyResponse() {
  return {
    today: { value: 0, comparison: null },
    yesterday: { value: 0, comparison: null },
    mtd: { value: 0, comparison: null },
    lastMonth: { value: 0, comparison: null },
    forecast: { value: 0, comparison: null, meta: null },
    breakdown: { amazon: null, walmart: null },
    meta: { tz: "America/New_York", asOf: new Date().toISOString(), storeIdsApplied: [] },
  };
}

function buildBreakdown(/* orders, periods */) {
  // ... та же логика, но для одного канала
  return { /* 5 metrics */ };
}
```

> ⚠️ Установить если нет: `npm i date-fns date-fns-tz`. Используется для timezone-aware работы с датами.

> ⚠️ **Проверь точные имена полей** в моделях `AmazonOrder` и `WalmartOrder` через `prisma/schema.prisma`. Если поле называется `orderTotal` — используй его, если `total` — используй его. Не переименовывай.

> ⚠️ **Статус заказа** — проверь в БД какие реальные значения статусов используются. У Amazon бывают "Canceled" (US spelling), у Walmart "Cancelled" (UK). Учти оба варианта в `notIn`.

---

### 3. UI компонент Sales Cards Row

**`src/components/dashboard/SalesCardsRow.tsx`** (новый):

```tsx
"use client";

import { useEffect, useState } from "react";
import { useStoreFilter } from "@/lib/store-filter/StoreFilterContext";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

type SalesPeriod = {
  value: number | null;
  comparison: {
    vs: string;
    baseline: number;
    percent: number | null;
  } | null;
  meta?: any;
};

type SalesResponse = {
  today: SalesPeriod;
  yesterday: SalesPeriod;
  mtd: SalesPeriod;
  lastMonth: SalesPeriod;
  forecast: SalesPeriod;
};

export function SalesCardsRow() {
  const { selectedStoreIds, isLoading: storeLoading } = useStoreFilter();
  const [data, setData] = useState<SalesResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (storeLoading) return;

    setLoading(true);
    const qs = selectedStoreIds.length > 0
      ? `?storeIds=${selectedStoreIds.join(",")}`
      : "";

    fetch(`/api/dashboard/sales${qs}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { console.error(e); setLoading(false); });
  }, [selectedStoreIds, storeLoading]);

  if (loading || !data) return <SalesCardsSkeleton />;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      <SalesCard
        title="SALES TODAY"
        value={data.today.value}
        comparison={data.today.comparison}
        comparisonLabel="vs yesterday"
      />
      <SalesCard
        title="SALES YESTERDAY"
        value={data.yesterday.value}
        comparison={data.yesterday.comparison}
        comparisonLabel="vs last week"
      />
      <SalesCard
        title="MONTH TO DATE"
        value={data.mtd.value}
        comparison={data.mtd.comparison}
        comparisonLabel="vs last mo. same period"
      />
      <SalesCard
        title="LAST MONTH"
        value={data.lastMonth.value}
        comparison={null}
      />
      <SalesCard
        title="FORECAST"
        value={data.forecast.value}
        comparison={data.forecast.comparison}
        comparisonLabel="vs last month"
        isForecast={true}
      />
    </div>
  );
}

function SalesCard({
  title,
  value,
  comparison,
  comparisonLabel,
  isForecast,
}: {
  title: string;
  value: number | null;
  comparison: SalesPeriod["comparison"] | null;
  comparisonLabel?: string;
  isForecast?: boolean;
}) {
  const formatted = value === null ? "—" : formatMoney(value);
  const percent = comparison?.percent ?? null;

  // Цвета согласно design system: НЕ красный для отрицательных financial
  const direction = percent === null ? "neutral" : percent >= 0 ? "up" : "down";
  const TrendIcon = direction === "up" ? TrendingUp : direction === "down" ? TrendingDown : Minus;

  return (
    <div
      className={cn(
        "rounded-[14px] p-4 bg-[var(--surface-1)] border border-[var(--border)]",
        // Forecast карточка — слегка выделена
        isForecast && "bg-[var(--surface-2)]"
      )}
    >
      <div className="text-[11px] uppercase tracking-wider text-[var(--muted)] font-mono">
        {title}
      </div>
      <div className="mt-2 text-[24px] font-semibold text-[var(--ink)] tabular-nums">
        {formatted}
      </div>
      {comparison && percent !== null && (
        <div className="mt-1 flex items-center gap-1 text-[12px]">
          <TrendIcon
            className={cn(
              "h-3 w-3",
              direction === "up" && "text-[var(--accent-green)]",
              direction === "down" && "text-[var(--accent-amber)]",
              direction === "neutral" && "text-[var(--muted)]"
            )}
          />
          <span
            className={cn(
              "tabular-nums",
              direction === "up" && "text-[var(--accent-green)]",
              direction === "down" && "text-[var(--accent-amber)]",
              direction === "neutral" && "text-[var(--muted)]"
            )}
          >
            {percent >= 0 ? "+" : ""}{percent.toFixed(1)}%
          </span>
          <span className="text-[var(--muted)]">{comparisonLabel}</span>
        </div>
      )}
      {comparison && percent === null && (
        <div className="mt-1 text-[12px] text-[var(--muted)]">
          {comparisonLabel} (no data)
        </div>
      )}
    </div>
  );
}

function formatMoney(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 10_000) {
    return `$${Math.round(value).toLocaleString("en-US")}`;
  }
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function SalesCardsSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="rounded-[14px] p-4 bg-[var(--surface-1)] border border-[var(--border)] h-[100px] animate-pulse" />
      ))}
    </div>
  );
}
```

---

### 4. Размещение на Dashboard

Открой `src/app/page.tsx`. Найди структуру с карточками. Вставь `SalesCardsRow` как **первый ряд** под заголовком, ПЕРЕД ОСТАЛЬНЫМИ карточками:

```tsx
import { SalesCardsRow } from "@/components/dashboard/SalesCardsRow";

export default function DashboardPage() {
  const { hasWalmart, selectedStoreIds, isLoading } = useStoreFilter();

  return (
    <div className="space-y-6">
      {/* Header строка */}
      <DashboardHeader />

      {/* ←  НОВЫЙ Sales row */}
      <SalesCardsRow />

      {/* Existing: Operations row (Orders / Awaiting Ship / Cases / Health) */}
      <OperationsCardsRow storeIds={selectedStoreIds} />

      {/* Existing: Walmart row — скрывается если не выбран Walmart */}
      {hasWalmart && <WalmartCardsRow storeIds={selectedStoreIds} />}

      {/* Existing: Awaiting fulfilment + side panels */}
      <DashboardBottomGrid storeIds={selectedStoreIds} />
    </div>
  );
}
```

> Не трогай существующие компоненты — только **вставь** SalesCardsRow в нужном месте.

---

### 5. Edge cases — как обрабатывать

| Кейс | Поведение |
|------|-----------|
| Выбрано 0 магазинов | Все карточки показывают `$0.00`, без сравнений. Или (лучше) — родительский Dashboard уже показал EmptyState, и SalesCardsRow не рендерится. Реализовано через `if (selectedStoreIds.length === 0) return null;` |
| `daysPassed < 1` (начало 1-го числа месяца) | Forecast показывает `—` с подсказкой "Need more data" в tooltip |
| `baseline == 0` для сравнения | Показать `—` вместо процента |
| Нет orders за прошлый месяц в БД | Last Month = `$0.00`. Не показывать предупреждение здесь — пользователь увидит и поймёт что нужен backfill |
| `value` для Today = 0 | Показать `$0.00` (валидное значение, не `—`) |
| Outdated orders (sync устарел) | Меточка `asOf: ISO-string` в response — может в будущем показывать "Last sync: 3 min ago" |
| DST переход в марте/ноябре | `date-fns-tz` сам обрабатывает переход. Просто следить что используем `toZonedTime` правильно |

---

## 🗂️ СТРУКТУРА ФАЙЛОВ

```
src/
├── app/
│   ├── page.tsx                                  # обновить — вставить <SalesCardsRow />
│   └── api/
│       └── dashboard/
│           └── sales/
│               └── route.ts                       # ← НОВЫЙ
├── components/
│   └── dashboard/
│       └── SalesCardsRow.tsx                      # ← НОВЫЙ

scripts/
└── backfill-orders.ts                             # ← НОВЫЙ (или обновить если есть)

docs/
├── SALES_CARDS_DASHBOARD_SPEC_v1_0.md             # ← НОВЫЙ
└── wiki/
    ├── sales-cards-dashboard.md                   # ← НОВЫЙ
    ├── CONNECTIONS.md                             # обновить
    └── index.md                                   # обновить
```

---

## 🧪 ACCEPTANCE CRITERIA (Vladimir проверит вручную)

После реализации убедись что **ВСЕ** пункты работают:

- [ ] При открытии Dashboard виден новый ряд из 5 карточек: SALES TODAY / SALES YESTERDAY / MONTH TO DATE / LAST MONTH / FORECAST.
- [ ] Карточки расположены **над** существующим рядом (Orders 30D / Awaiting Ship / Cases / Health), сразу под заголовком "Dashboard".
- [ ] Каждая карточка показывает сумму в формате `$1,234.56` (для маленьких) или `$12,345` (для крупных) или `$1.23M` (для миллионов).
- [ ] Под каждой карточкой (кроме LAST MONTH) видна сравнительная метрика с %: например "↑ +12.3% vs yesterday".
- [ ] Зелёные стрелки/проценты для роста, **янтарные** для падения (НЕ красные — это правило design system).
- [ ] Если выбрать в селекторе только Amazon-магазины — суммы пересчитываются мгновенно (без перезагрузки).
- [ ] Если выбрать только Walmart — суммы Walmart-only.
- [ ] При снятии всех магазинов — Dashboard показывает EmptyState (как уже сделано в Store Selector промпте).
- [ ] **Forecast** — рассчитан корректно: при today = 12 May, MTD = $X, прогноз ≈ X × (31 / 11.8). Проверить через калькулятор.
- [ ] При F5 — карточки перезагружаются с актуальными данными.
- [ ] Карточки фильтруют только заказы с `status != Cancelled / Canceled`.
- [ ] Орёл-карточка показывает gross revenue (`SUM(orderTotal)`), а не net.
- [ ] **Backfill orders** запущен. В `AmazonOrder` есть данные за апрель 2026 (или прошлый месяц). В `WalmartOrder` тоже. Last Month card показывает не нули.
- [ ] `npm run build` без warnings и errors.
- [ ] Wiki обновлено (3 файла + reference spec).

---

## 📋 ЭТАПЫ И КОММИТЫ

1. `chore(scripts): add backfill-orders script (90 days)` — скрипт + запуск + проверка БД
2. `feat(api): GET /api/dashboard/sales endpoint (5 periods)` — endpoint с агрегацией
3. `feat(ui): SalesCardsRow component` — компонент карточек
4. `feat(dashboard): add Sales row above Operations row` — вставка в page.tsx
5. `style(dashboard): sales card colors per design system (green/amber, no red)` — стилизация
6. `fix(api): handle edge cases (zero baseline, insufficient days, missing data)` — edge cases
7. `docs(wiki): document Sales Cards system` — wiki + spec

---

## 📚 WIKI + ДОКУМЕНТАЦИЯ (обязательно)

### `docs/wiki/sales-cards-dashboard.md` (новый)

```markdown
# Sales Cards on Dashboard — System Notes

## Цель
Ряд из 5 карточек продаж на главной странице Dashboard. Показывают gross revenue за разные периоды с фильтром по выбранным магазинам.

## Периоды (все в America/New_York)
1. **Sales Today** — 00:00 ET → now
2. **Sales Yesterday** — весь предыдущий день ET
3. **MTD** — с 1-го числа текущего месяца → now
4. **Last Month** — полный предыдущий месяц
5. **Forecast** — линейный прогноз: `MTD / daysPassed × daysInMonth`

## Сравнения (% change под каждой карточкой)
| Карточка | Сравнение с |
|----------|-------------|
| Today | Yesterday |
| Yesterday | Same day last week |
| MTD | Last month same period (1-st → same date) |
| Last Month | — (no comparison) |
| Forecast | Last Month total |

## Источники данных
- `AmazonOrder` (Prisma) — `purchaseDate`, `orderTotal`, `orderStatus`
- `WalmartOrder` (Prisma) — `orderDate`, `orderTotal`, `status`
- Filter: `status NOT IN ('Cancelled', 'Canceled')` — gross revenue, не net.

## API
- `GET /api/dashboard/sales?storeIds=id1,id2,id3`
- Response: 5 периодов + breakdown по каналам + meta.
- Aggregation: одним fetch за весь период (lastMonthStart → now), потом bucketed в памяти.

## Зависимости
- ← Global Store Filter (`useStoreFilter()`)
- ← Backfill orders скрипт (`scripts/backfill-orders.ts`)
- → Phase 2 модуль `/analytics` (Sales Analytics) переиспользует этот endpoint

## Design rules
- Никакого красного для отрицательных финансовых чисел (правило Salutem v1.0).
- Down arrow → янтарный (`--accent-amber`), не красный.
- Up arrow → зелёный (`--accent-green`).
- Все числа — `tabular-nums`.
- Формат: `$1,234.56` < $10k; `$12,345` ≥ $10k; `$1.23M` ≥ $1M.

## Backfill orders
Скрипт: `npx tsx scripts/backfill-orders.ts --days=90`
Запускать вручную или раз в день через cron. SP-API ограничивает 90 дней; Walmart до 180 дней.

## Phase 2 — расширение
- Charts: спарклайн внутри каждой карточки (30 дней trend).
- Breakdown drawer: клик на карточку → popover с разбивкой Amazon/Walmart/Store.
- Best/worst SKU за период.
- Поправка прогноза на weekend patterns.
```

### `docs/wiki/CONNECTIONS.md` — добавить

```markdown
## Sales Cards on Dashboard

sales-cards-dashboard.md → dashboard (page.tsx)
sales-cards-dashboard.md ← store-filter-system.md
sales-cards-dashboard.md ← prisma.AmazonOrder
sales-cards-dashboard.md ← prisma.WalmartOrder
sales-cards-dashboard.md → /api/dashboard/sales
sales-cards-dashboard.md ← scripts/backfill-orders.ts

## Phase 2 (planned)
sales-cards-dashboard.md → sales-analytics-module (Phase 2 module /analytics)
```

### `docs/wiki/index.md` — добавить

```markdown
- [Sales Cards on Dashboard](sales-cards-dashboard.md) — 5-period gross revenue (Dashboard) — 2026-05-12
```

### `docs/SALES_CARDS_DASHBOARD_SPEC_v1_0.md`

Reference-level spec на основе этого промпта — детали API contract, edge cases, forecast formula, расширение на Phase 2.

---

## ❓ ЕСЛИ ВОЗНИКНЕТ НЕОПРЕДЕЛЁННОСТЬ

1. **Если `AmazonOrder` или `WalmartOrder` модели отсутствуют** — создать их минимально (id, orderId, date, total, status, storeId, timestamps). Но скорее всего они уже есть из предыдущих этапов проекта.

2. **Если SP-API getOrders ещё не реализован** — добавь в `src/lib/amazon-sp-api/orders.ts`. Используй существующий auth/client. Endpoint: `GET /orders/v0/orders` с `LastUpdatedAfter` или `CreatedAfter`.

3. **Если Walmart Orders API не реализован** — он должен быть после Walmart API integration. Если нет — добавь `WalmartOrdersApi.getAllOrders({ since, until })` в `src/lib/walmart/orders.ts`.

4. **Если timezone library не используется** — установи `date-fns date-fns-tz`. Альтернативно `luxon`, но в проекте уже может быть выбор.

5. **Если карточки занимают слишком много места на узких экранах** — wrap-логика в `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5` уже это решает. На 1280px+ — 5 в ряд, на 768px — 3 в ряд, на mobile — 2 в ряд.

6. **Forecast меньше нуля** (невозможно, но всё же) — показать `—`. Невалидное значение.

7. **Если `orderStatus` поле в `AmazonOrder` называется иначе** — например `status` — использовать существующее. Проверить через `npx prisma studio`.

**НЕ делать:**
- Не использовать `localStorage` / `sessionStorage` для Sales данных — каждый раз fetch.
- Не считать **net** revenue (с вычетом возвратов) — только **gross**.
- Не выводить **красный** для падения — только янтарный.
- Не считать прогноз умным (с weekend-патернами) — простой линейный.
- Не вычислять forecast если `daysPassed < 1` — показать "—".
- Не трогать существующие 4+4 карточки Dashboard — только **добавить** новый ряд сверху.
- Не объединять Sales-карточки с Operations-карточками в один ряд — отдельные секции.

---

## 🏁 FINISH CRITERIA

Этап считается завершённым когда:

1. Все 15 пунктов ACCEPTANCE CRITERIA выполнены.
2. Backfill запущен — в БД есть orders за последние 90 дней (по обоим channel).
3. `npm run build` без warnings и errors.
4. Endpoint `/api/dashboard/sales` возвращает валидный JSON со всеми 5 периодами.
5. Wiki обновлено (4 файла).
6. Все 7 коммитов на ветке `feature/dashboard-sales-cards`.
7. Pull Request открыт.

После — дать знать Vladimir для приёмки.
