# Store Filter System

**Версия:** v1.0
**Введён:** 2026-05-12
**Phase:** 1 — Dashboard
**Spec:** [STORE_FILTER_SYSTEM_SPEC_v1_0.md](../STORE_FILTER_SYSTEM_SPEC_v1_0.md)

---

## Цель
Глобальный мульти-селект магазинов в SS Control Center. Один источник правды, из которого читают и сайдбар (селектор), и шапка (live-плашка), и сам Dashboard (карточки + блок Awaiting fulfilment + Customer queue).

В Phase 1 фильтр применяется только на Dashboard. Customer Hub, Adjustments, Account Health, Shipping Labels будут подключены отдельными промптами в Phase 2.

---

## Источник правды
Таблица `Store` в Prisma — 6 активных записей:

| # | name | channel | storeIndex | sellerId |
|---|------|---------|------------|----------|
| 1 | Salutem Solutions | Amazon | 1 | — |
| 2 | Vladimir Personal | Amazon | 2 | — |
| 3 | AMZ Commerce | Amazon | 3 | — |
| 4 | Sirius International | Amazon | 4 | — |
| 5 | Retailer Distributor | Amazon | 5 | — |
| 6 | SIRIUS TRADING INTERNATIONAL LLC | Walmart | — | 10001624309 |

Поля `storeIndex` и `sellerId` добавлены в этой фиче как «мостики» — `Store.id` (cuid) — каноническая ссылка, а `storeIndex` / `sellerId` нужны для перевода selection → фильтра в нативных таблицах (`AmazonOrder.storeIndex`, `WalmartOrder.storeIndex` / `WalmartReconTransaction.storeIndex`, etc.).

Скрипт `scripts/seed-stores.mjs` идемпотентен и работает как с локальной SQLite, так и с Turso prod (определяет цель по env). Колонки `storeIndex` / `sellerId` добавляются через `ALTER TABLE ADD COLUMN` под `PRAGMA table_info` проверкой, так что повторные запуски — no-op.

---

## State (React)
`src/lib/store-filter/StoreFilterContext.tsx`:
- `StoreFilterProvider` обёртывает всё приложение в `src/app/layout.tsx`.
- `useStoreFilter()` отдаёт: `allStores`, `selectedStoreIds`, `selectedStores`, `hasAmazon`, `hasWalmart`, `isAllSelected`, `toggleStore`, `selectAll`, `clearAll`, `setSelected`, `toQueryString`, `isLoading`, `error`.
- **Не персистится** в localStorage. Каждая сессия начинается с `All stores`. Это намеренно — Vladimir не хочет «забытых» фильтров между визитами.
- При маунте провайдер делает `fetch("/api/stores")` и проставляет всё.

---

## API
- `GET /api/stores` → `{ stores: StoreEntry[] }`. Только `active = true`, отсортированы Amazon (по `storeIndex`) → Walmart.
- `GET /api/dashboard/summary?storeIds=id1,id2,...` — каждое подзапрос-сэлектор резолвится через `Store.findMany` → нативный фильтр:
  - Amazon-side (`AmazonOrder`, `AtozzClaim`) → `storeIndex IN (…)`.
  - Walmart-side (`WalmartOrder`, `WalmartReconTransaction`, `WalmartPerformanceSnapshot`) → `storeIndex IN (…)` (по выбранным Walmart-магазинам). Если в selection нет ни одного Walmart — `walmart: null` в ответе.
  - `storeIds` пуст или совпадает со всеми `Store.id` → фильтр пропускается (быстрее).
  - `storeIds=` явный пустой набор (selection cleared) → API возвращает «zeroed» payload без походов в БД.

---

## UI
- `src/components/layout/StoreFilterSelector.tsx` — Popover (base-ui via shadcn) с master-чекбоксом `All stores` (поддержка indeterminate) + секциями `AMAZON` / `WALMART`. Все клики применяются live, кнопки `Apply` нет.
- `src/components/layout/Header.tsx` → внутренний `StoresLiveBadge` показывает `All N stores live` / `K of N stores` / `No stores selected` (тогда плашка серая, не зелёная).
- `src/app/page.tsx` (Dashboard):
  - Перетягивает данные при изменении `selectedStoreIds`.
  - Рендерит EmptyState («Select at least one store…»), если selection пуст.
  - Walmart-ряд карточек прячется целиком, пока `hasWalmart === false` — без прочерков.
  - Veeqo orders и Customer queue фильтруются клиентским matching'ом (Veeqo не отдаёт стабильный per-store фильтр).

---

## Связи

См. также: [CONNECTIONS.md](CONNECTIONS.md#store-filter-system).

- store-filter-system → [dashboard](dashboard.md)
- store-filter-system ← [database-schema](database-schema.md) (`Store` модель + `channel` / `storeIndex` / `sellerId`)
- store-filter-system ↔ `src/components/layout/Sidebar.tsx` (StoreFilterSelector)
- store-filter-system ↔ `src/components/layout/Header.tsx` (StoresLiveBadge)
- Phase 2 planned →
  - [customer-hub](customer-hub.md)
  - [adjustments-monitor](adjustments-monitor.md)
  - [account-health](account-health.md)
  - [shipping-labels](shipping-labels.md)

---

## Phase 2 расширение

Что нужно сделать, чтобы подключить остальные страницы:
1. Каждая страница, у которой есть локальный «store dropdown», должна избавиться от него в пользу глобального и просто читать `useStoreFilter()`.
2. Каждый соответствующий API endpoint принимает `?storeIds=…` и резолвит через ту же helper-функцию (см. `resolveStoreFilter` в `src/app/api/dashboard/summary/route.ts` — можно вынести в `src/lib/store-filter/server.ts` когда понадобится).
3. На страницах, где есть Walmart-only блоки, использовать `hasWalmart` / `hasAmazon` чтобы прятать ненужное.

---

## Известные ограничения

- Procurement (`/api/procurement/items`) опирается на Veeqo API, который не отдаёт SS-Store-id. Подключение к фильтру требует mapping Veeqo store-name → `Store.id`, который пока не строится. На Dashboard счётчик procurement остаётся «глобальным».
- AccountHealthSnapshot использует SP-API marketplace-participation `storeId`, а не наш `Store.id`. Подключение требует отдельной таблицы соответствия. В Phase 1 health-issues не фильтруются.
