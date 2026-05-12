# STORE FILTER SYSTEM — Reference Spec v1.0

> **Date:** 2026-05-12
> **Status:** Phase 1 (Dashboard) implemented
> **Author:** реализация по `docs/CLAUDE_CODE_PROMPT_DASHBOARD_STORE_SELECTOR.md`

Reference spec для глобального мульти-селектора магазинов.

---

## 1. Объект Store

```prisma
model Store {
  id        String   @id @default(cuid())
  name      String
  channel   String   // Amazon | Walmart
  signature String   @default("")
  active    Boolean  @default(true)
  storeIndex Int?    // bridge to AmazonOrder.storeIndex / WalmartOrder.storeIndex
  sellerId  String?  // Walmart Marketplace Seller ID
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

`storeIndex` — `1..5` для Amazon-магазинов. У Walmart не используется (NULL), Walmart-данные идентифицируются через `sellerId` + общий `storeIndex` дефолт `1` в Walmart-таблицах (исторически — Walmart-аккаунт всегда один).

---

## 2. Канонический поток данных

```
                    ┌──────────────────────────────┐
                    │   prisma.store (6 rows)      │
                    └──────────────┬───────────────┘
                                   │ GET /api/stores
                                   ▼
                    ┌──────────────────────────────┐
                    │  StoreFilterProvider (ctx)   │
                    │  selectedStoreIds: string[]  │
                    └─────┬──────────────────┬─────┘
                          │                  │
            useStoreFilter│                  │useStoreFilter
                          ▼                  ▼
               ┌─────────────┐     ┌─────────────────────┐
               │ Sidebar     │     │ Header live badge   │
               │ Selector    │     │ "All 6 stores live" │
               └─────────────┘     └─────────────────────┘
                          │
                          │ selectedStoreIds → ?storeIds=
                          ▼
                    ┌──────────────────────────────┐
                    │ GET /api/dashboard/summary   │
                    │   resolveStoreFilter() →     │
                    │   storeIndex IN (…)          │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                            Dashboard render
```

---

## 3. API contract

### `GET /api/stores`

Response:
```json
{
  "stores": [
    { "id": "cuid…", "name": "Salutem Solutions", "channel": "Amazon",
      "storeIndex": 1, "sellerId": null, "active": true },
    …
    { "id": "cuid…", "name": "SIRIUS TRADING INTERNATIONAL LLC",
      "channel": "Walmart", "storeIndex": null,
      "sellerId": "10001624309", "active": true }
  ]
}
```

Сортировка: Amazon (по `storeIndex` возрастающе) → Walmart.

### `GET /api/dashboard/summary?storeIds=id1,id2,…`

- Параметр опциональный. Отсутствие или selection == all → фильтр игнорируется.
- Явный пустой набор → API возвращает `zeroedPayload` без запросов к БД.
- Запрос внутри: `resolveStoreFilter(searchParams)` строит:
  - `amazonStoreIndexes: number[] | null`
  - `walmartStoreIndexes: number[] | null`
  - `walmartSellerIds: string[] | null`
  - флаги `noneSelected`, `total`
- Walmart-payload в ответе = `null`, если не выбран ни один Walmart-магазин.

Все остальные query endpoints, которые будут подключаться в Phase 2, должны принимать тот же `storeIds=` параметр и использовать ту же helper-функцию (когда её вынесут в общий модуль `src/lib/store-filter/server.ts`).

---

## 4. React Context

`src/lib/store-filter/StoreFilterContext.tsx` — single source of truth на клиенте.

API:
```ts
type StoreEntry = {
  id: string;
  name: string;
  channel: "Amazon" | "Walmart";
  storeIndex: number | null;
  sellerId: string | null;
  active: boolean;
};

const {
  allStores,           // StoreEntry[]
  selectedStoreIds,    // string[]
  selectedStores,      // derived: allStores ∩ selectedStoreIds
  hasAmazon,           // derived: selectedStores has any Amazon
  hasWalmart,          // derived: selectedStores has any Walmart
  isAllSelected,       // derived
  toggleStore,         // (id: string) => void
  selectAll, clearAll,
  setSelected,         // (ids: string[]) => void
  isLoading, error,
  toQueryString,       // () => "" | "storeIds=…"
} = useStoreFilter();
```

Decisions:
- **No persistence.** Каждая сессия = All stores. Vladimir хочет «свежий» Dashboard каждый раз.
- **Live filtering.** Любой toggle сразу триггерит refetch. Никакого Apply.
- **Derived `hasAmazon` / `hasWalmart`** позволяет странице прятать целые секции (Walmart-ряд карточек) без отдельных стейтов.

---

## 5. UI компоненты

### `<StoreFilterSelector />` (в Sidebar)

- Popover (base-ui via shadcn) + master-чекбокс `All stores` (с indeterminate) + секции AMAZON / WALMART.
- Trigger: рамка `border-rule`, фон `bg-surface-tint`, текст `--ink`, зелёная live-точка слева. Радиус 6px (matches design tokens).
- Hover/open: `bg-bg-elev` + `border-silver-line`.
- Open animation: base-ui's default `data-open:animate-in`.

### `<StoresLiveBadge />` (в Header)

- `All N stores live` (зелёный фон, зелёная точка) — selection == all.
- `K of N stores` (тот же стиль).
- `No stores selected` (серый фон, дим-точка) — selection пуст.
- Скрывается, если `allStores.length === 0` (БД пуста) или `isLoading` (избегаем flicker до первого fetch).

### Dashboard (`src/app/page.tsx`)

- Refetch при изменении `selectedStoreIds` (cache key — отсортированный join).
- Empty state Panel, если selection пуст.
- Walmart-ряд карточек: `{data?.walmart && hasWalmart && <…/>}` — никаких прочерков.
- Awaiting fulfilment table: после fetch из Veeqo делается клиентское matching по `selectedStores[].name` (Veeqo не отдаёт стабильный per-store фильтр).
- Customer queue: фильтр по `channel.includes("walmart") ? hasWalmart : hasAmazon`.

---

## 6. Edge cases & ограничения (Phase 1)

| Случай | Поведение |
|---|---|
| Selection == all | `toQueryString()` → пустая строка → API быстро отдаёт «как раньше». |
| Selection == [] | Empty state. API возвращает zeroes. |
| Selection == [Walmart] | Verхний ряд карточек показывает Walmart 30D как «Orders 30d». Нижний ряд (Walmart-карточки) виден. |
| Selection == [1 Amazon-store] | Заголовок селектора: имя магазина. Header: `1 of 6 stores`. |
| Refresh страницы | Возврат к All stores (нет localStorage). |
| Procurement counter | Не фильтруется (Veeqo не маппится 1:1 на `Store.id`). Future work. |
| AccountHealthSnapshot | Не фильтруется (использует SP-API marketplace `storeId`, не наш `Store.id`). Требует таблицу соответствия. |

---

## 7. Phase 2 roadmap

В порядке приоритета:

1. **Customer Hub** (`/customer-hub`) — заменить локальный store dropdown на глобальный. API: `/api/customer-hub/messages?storeIds=…`.
2. **Adjustments** (`/adjustments`) — то же. API: `/api/adjustments?storeIds=…`.
3. **Shipping Labels** (`/shipping`) — Awaiting fulfilment table уже фильтруется client-side в Dashboard, но в самом Shipping всё ещё нет. Подключить.
4. **Account Health** — нужна таблица соответствия `AccountHealthSnapshot.storeId` ↔ `Store.id` (`marketplace_participation_id`).
5. Вынести `resolveStoreFilter()` в `src/lib/store-filter/server.ts` и использовать во всех endpoints.

---

## 8. Файлы (Phase 1)

```
src/
├── app/
│   ├── api/
│   │   ├── stores/route.ts              [NEW]   GET /api/stores
│   │   └── dashboard/summary/route.ts   [MOD]   accepts ?storeIds=
│   ├── layout.tsx                       [MOD]   wraps app in StoreFilterProvider
│   └── page.tsx                         [MOD]   Dashboard consumes filter
├── components/
│   ├── layout/
│   │   ├── Header.tsx                   [MOD]   StoresLiveBadge
│   │   ├── SidebarContent.tsx           [MOD]   StoreFilterSelector slot
│   │   └── StoreFilterSelector.tsx      [NEW]
│   └── ui/
│       ├── popover.tsx                  [NEW]   shadcn add popover
│       └── checkbox.tsx                 [NEW]   shadcn add checkbox
├── lib/
│   └── store-filter/
│       └── StoreFilterContext.tsx       [NEW]

prisma/
└── schema.prisma                        [MOD]   Store.storeIndex + Store.sellerId

scripts/
└── seed-stores.mjs                      [NEW]   idempotent dual-target seed

docs/
├── STORE_FILTER_SYSTEM_SPEC_v1_0.md     [NEW]
└── wiki/
    ├── index.md                         [MOD]   link added
    ├── CONNECTIONS.md                   [MOD]   relations added
    └── store-filter-system.md           [NEW]
```
