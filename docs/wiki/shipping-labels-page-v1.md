# 📦 Shipping Labels Page v1.0 — Spec

## Суть
Полноценная страница `/shipping` в SS Control Center: live dashboard по всем магазинам, AI-классификация Frozen/Dry, ручной override, packing profiles для multi-item заказов, пакетная покупка этикеток.

**Дата:** 2026-05-12 (дополнено 2026-05-14: cutoff time §0.1)
**Промпт реализации:** `docs/CLAUDE_CODE_PROMPT_SHIPPING_LABELS_PAGE_V1.md`
**Базовый алгоритм покупки:** [`docs/MASTER_PROMPT_v3.2.md`](../MASTER_PROMPT_v3.2.md) (включает cutoff правило)
**Cutoff:** [cutoff-time-rule.md](cutoff-time-rule.md) — детали

---

## Структура страницы

```
┌─────────────────────────────────────────────────────────┐
│ TOP: Заголовок + дата + кнопка Refresh                  │
├─────────────────────────────────────────────────────────┤
│ STORE BREAKDOWN: горизонтальный ряд карточек            │
│ Per-store: всего ордеров / готовы к покупке / ⚠         │
├─────────────────────────────────────────────────────────┤
│ TIME BUCKETS chips: Просрочено / Сегодня /              │
│ Завтра / Послезавтра / Позже (как в Procurement)        │
├─────────────────────────────────────────────────────────┤
│ ACTION BAR: ☐ Select all / Buy Selected / Export        │
├─────────────────────────────────────────────────────────┤
│ ORDER LIST: карточки заказов с разными состояниями      │
└─────────────────────────────────────────────────────────┘
```

---

## Фильтр по каналу — Amazon / Walmart (2026-05-30)

Над карточками KPI — две **фирменные кнопки-переключателя**: **amazon** (оранжевый smile-underline, цвет `#ff9900`) и **Walmart** (синий `#0071dc` + жёлтая искра `#ffc220`). Нажатие переключает весь дашборд на выбранный маркетплейс; повторный клик по активной кнопке (или ссылка «show all») возвращает оба канала.

**Что пересчитывается под выбранный канал:**
- 4 карточки KPI (Awaiting / Ready to buy / Need attention / Waiting for procurement);
- разбивка **By store** (показываются только магазины этого канала);
- табы по срокам (Overdue/Today/…) и по типу (Frozen/Dry) — счётчики локальные;
- сам список заказов (а значит и «Select all ready» / «Buy selected»).

**Как определяется канал заказа:** по флагу `isWalmart` (его проставляет `dashboard/route.ts`, сопоставляя Veeqo `order.number` с таблицей `WalmartOrder`) — **не** по имени магазина, т.к. Walmart-магазин в Veeqo называется «SIRIUS TRADING INTERNATIONAL LLC». Всё, что не Walmart, считается Amazon. Реализация: state `channelFilter` + derived `channelOrders`/`walmartStoreIds`/`bucketCounts` в `src/app/shipping/page.tsx`; кнопки — компонент `ChannelToggle`. Смена канала сбрасывает выбранный store-фильтр.

---

## Дата отгрузки — глобальная + по каждому заказу (2026-05-30, Walmart)

Справа в строке Channel — поле **Ship date** (по умолчанию **сегодня по времени Майами/ET**). Это «день, когда я планирую отдать посылки перевозчику». Оно управляет **всеми котировками Walmart**: смена даты пере-котирует тарифы для всех ready-Walmart заказов (какой сервис/цена/EDD вернётся, зависит от дня отгрузки), а кнопка Buy покупает от этой даты, и PDF в Drive кладётся в папку этого дня.

**По каждому заказу** (Walmart, ready) дата редактируется прямо в шапке строки (`· Ship [date]`): меняешь — пере-котируется только этот заказ; ручная дата подсвечивается синим (фирменный Walmart-цвет). Override живёт в `shipDateByOrder`; глобальная дата применяется к заказам без override. Полный refresh страницы сбрасывает overrides к глобальной дате.

**Подсветка дедлайна в выборе тарифа** (и Walmart, и Veeqo-пикеры): каждый тариф помечается **«on time»** (зелёный) или **«misses deadline»** (красный, плюс красный фон строки и EDD) — сравнивается EDD тарифа с marketplace deliver-by (для Walmart сначала берётся флаг `deliveryPromiseFulfilled` от самого Walmart, иначе сравнение дат). Хелперы `daysLate`/`deadlineRiskNote`/`deadlineRiskClass`.

### Amazon — плавающая дата как ПРЕВЬЮ (2026-05-30, поправка)

Раньше тут было написано, что «Veeqo не умеет котировать на будущую дату» — **это неверно.** Veeqo умеет: наш Frozen Ship Date Trick (`plan/route.ts`) уже делает это — `updateOrderDispatchDate` (**PUT даты отгрузки**) → пауза ~0.8с → `getShippingRates` → **возврат даты обратно**. Тот же приём вынесен в эндпоинт **`POST /api/shipping/veeqo-rates`** (`{ orderId, shipDate }`): временно пере-датирует заказ в Veeqo, забирает тарифы, возвращает дату — **view-only**, покупку не трогает.

На Amazon-строках дата теперь тоже редактируемая. Смена → `quoteVeeqoOrder` → выбирает рейт по алгоритму (cheapest-meets-deadline; Frozen ≤3 кал. дня) → накладывает **только поля тарифа** поверх plan-строки (`veeqoPreview`, мерджится в `planByOrderNumber`, package/вес сохраняются) + бейдж **preview**. **Покупка Amazon остаётся на ship-by** (правило владельца) — buyOne для Amazon берёт `plan`+`rateOverrides`, не превью. Глобальная дата Amazon-строки массово НЕ пере-котирует (это был бы Veeqo-write на каждый заказ) — только сбрасывает превью и показывает новую дату по умолчанию.

Для Walmart остаётся как было: пере-котировка через свой API (drives и показ, и покупку). Реализация: `quoteWalmartOrder`/`quoteVeeqoOrder`, `effectiveShipDate`, `shipDateGlobal`/`shipDateGlobalRef`. SWW `createLabel` поля даты не принимает — лейбл датируется моментом покупки; дата используется для папки Drive и выбора тарифа.

### Плюшки из интерфейса Veeqo (2026-05-30)
- **Пресеты даты** в глобальном поле Ship date: Today / +1 / +2 (хелпер `addDaysISO`).
- **Сумма в кнопке** «Buy selected (N): $XX.XX» (`selectedTotal` = сумма plan.price по выбранным).
- **Время доставки** «· N days» рядом с EDD в строке (кал. дни от даты отгрузки до EDD).
- **Сортировка списка** (`sortBy` + `displayedOrders`): Urgency (по умолч.) / Label cost / Delivery (EDD) / Deadline.
- **Отложено на след. итерацию:** bulk-действия над выделенными (массово задать дату/коробку/сервис) — как «Edit ship date / Edit packages / Edit services» в Veeqo.

---

## Состояния заказов (state machine)

| State | Описание | Действие |
|-------|----------|----------|
| `ready_to_buy` | Всё определено, можно покупать | Чекбокс + Buy Selected |
| `need_attention` `no_type` | Нет тега Frozen/Dry | Кнопки: AI Classify / Set Manually |
| `need_attention` `no_packing` | Multi-item/qty без профиля | Кнопка Set Packing Profile |
| `need_attention` `mixed_order` | Frozen+Dry в одном | Серая карточка с причиной |
| `need_attention` `frozen_walmart` | Frozen на Walmart запрещён | Серая карточка |
| `need_attention` `no_sku` | Нет данных в SKU Database | Серая карточка |
| `need_attention` `budget` | Превышен бюджет | Серая карточка |
| `need_attention` `no_service` | Нет carrier service в бюджет/дедлайн | Серая карточка |
| `waiting_placed` | Нет тега `Placed` (товар ещё не закуплен) | Мутная карточка |
| `bought` | Уже куплено | Зелёная карточка |

---

## Новые модели БД

### `ProductTypeOverride` (расширение)
Связывает Veeqo `productId` с типом (Frozen/Dry). Источник: manual (Vladimir выбрал в UI) или AI (Claude с vision).

Поля: `productId`, `type`, `source`, `aiConfidence`, `aiReasoning`, `syncedToVeeqo`, `veeqoSyncError`.

Синхронизация в Veeqo (тег на продукте) — async после записи в БД, с retry при failure.

### `PackingProfile` (новая)
Для заказов с qty > 1 или multi-item.

Ключ — детерминированная сигнатура: `SKU1:QTY1|SKU2:QTY2|...` (отсортировано по SKU).

Поля: `signature`, `description`, `boxSize`, `weight`, `weightFedex`, `itemCount`, `totalQty`, `usedCount`, `lastUsedAt`, `productEmbedding` (Phase 2 hook), `source`.

Self-learning: Vladimir вводит профиль первый раз вручную → последующие заказы с такой же сигнатурой используют его автоматически.

---

## API endpoints

| Endpoint | Метод | Назначение |
|----------|-------|-----------|
| `/api/shipping/dashboard` | GET | Live данные при заходе. Per-store breakdown + time buckets + список заказов |
| `/api/shipping/plan` | GET | Расширен: фильтр по `orderIds`, lookup через `ProductTypeOverride` и `PackingProfile` |
| `/api/shipping/classify-ai` | POST | AI classification preview (НЕ сохраняет) |
| `/api/shipping/product-type` | POST | Сохранить type + async sync в Veeqo |
| `/api/shipping/product-type/retry-sync` | POST | Retry для не-засинхренных |
| `/api/shipping/packing-profile` | POST/GET | CRUD профиля по сигнатуре |
| `/api/shipping/buy` | POST | (без изменений) — покупает этикетки и выгружает PDF |

---

## AI Classification flow

1. Юзер жмёт `Classify with AI` на карточке заказа без типа.
2. POST `/api/shipping/classify-ai` с `productId`.
3. Backend: `getProduct(productId)` → title + description + main_image → Claude vision.
4. Claude возвращает JSON: `{ type, confidence, reasoning }`.
5. UI показывает preview в модалке с тремя кнопками: Cancel / Override / Confirm.
6. Confirm → POST `/api/shipping/product-type` с `source: "ai"`.
7. Backend: upsert в `ProductTypeOverride` → async sync в Veeqo через `setProductTag`.

Подсказки для AI: title и description (полное, через Veeqo product endpoint), плюс главное изображение (на frozen-товарах часто пенопластовый кулер).

Пока что preview + confirm. После того как алгоритм покажет стабильность — переключить на auto-apply при `confidence >= 0.85` (изменение одной настройки в коде).

---

## Packing Profile flow

1. Order приходит с qty > 1 или multi-item.
2. Backend в `/api/shipping/plan`: формирует сигнатуру через `buildPackingSignature(items)`.
3. Lookup `PackingProfile.findUnique({ signature })`.
   - **Найден** → используем `boxSize`, `weight`, `weightFedex`. `usedCount++` при покупке.
   - **Не найден** → заказ → `need_attention` / `no_packing`.
4. В UI: кнопка `Set Packing Profile` → модалка с полями box+weight.
5. Save → POST `/api/shipping/packing-profile` → re-fetch.

---

## Time Buckets (как в Procurement)

| Bucket | Условие | Цвет |
|--------|---------|------|
| `overdue` | Ship By < сегодня | danger |
| `today` | Ship By = сегодня | warn-strong |
| `tomorrow` | Ship By = завтра | info |
| `dayafter` | Ship By = +2 дня | green |
| `later` | Ship By > +2 дня | neutral |

Реализация — копируем `shipByBucket()` и `SHIP_BY_OPTIONS` из `src/app/procurement/page.tsx`.

---

## Future Phase 2: Self-Learning Enhancements

- **Semantic similarity для PackingProfile.** Если точная сигнатура не найдена — semantic search по `productEmbedding` (заложено в схему) + предложение похожих профилей с confidence. Пример: для `Croissant Sandwich × 2` предложить профиль `Biscuit Sandwich × 2` если он есть.
- **Auto-apply AI classification** при `confidence ≥ 0.85` без preview.
- **Bulk operations** на `need_attention` заказы.
- **Notifications** в Telegram когда появляются заказы требующие внимания.

---

## 🔗 Связи

- **Реализует:** [MASTER_PROMPT_v3.1.md](shipping-labels.md) (базовая логика покупки)
- **Зависит от:**
  - [Veeqo API](veeqo-api.md) — orders, products, tags, rates, buy labels
  - [SKU Database (Internal DB)](sku-database-migration.md) — для single-item lookup
  - [Claude AI](claude-ai.md) — для AI classification (vision-enabled)
  - [Procurement Module](procurement-module.md) — паттерн time buckets
  - [Cutoff Time Rule](cutoff-time-rule.md) — §0.1 MASTER_PROMPT v3.2
  - [MASTER_PROMPT v3.2](../MASTER_PROMPT_v3.2.md) — базовый алгоритм
- **Связи в БД:** `ProductTypeOverride`, `PackingProfile` (новые), `SkuShippingData`
- **Алгоритмы:** [Frozen/Dry классификация](frozen-dry-classification.md), [Carrier Selection](carrier-selection-rules.md), [Budget Check](budget-check-algorithm.md), [Weekend Distribution](weekend-distribution.md)

---

## История
- 2026-05-12: v1.0 спецификация. Полная переделка страницы Shipping Labels.
- 2026-05-13: v1.0 реализовано и задеплоено на main.

## Implementation status (2026-05-13)

| Компонент | Статус | Файл |
|---|---|---|
| Prisma: `ProductTypeOverride` расширен (source / aiConfidence / aiReasoning / syncedToVeeqo / veeqoSyncError) | ✅ | `prisma/schema.prisma` |
| Prisma: `PackingProfile` модель | ✅ | `prisma/schema.prisma` |
| Turso migration script | ✅ применён | `scripts/turso-migrate-shipping-page-v1.mjs` |
| Packing signature utility | ✅ | `src/lib/shipping/packing-signature.ts` |
| `GET /api/shipping/dashboard` | ✅ | `src/app/api/shipping/dashboard/route.ts` |
| `GET /api/shipping/plan?orderIds=…` + PackingProfile lookup | ✅ | `src/app/api/shipping/plan/route.ts` |
| `POST /api/shipping/classify-ai` (Claude vision) | ✅ | `src/app/api/shipping/classify-ai/route.ts` |
| `POST /api/shipping/product-type` + async Veeqo sync | ✅ | `src/app/api/shipping/product-type/route.ts` |
| `POST /api/shipping/product-type/retry-sync` | ✅ | `src/app/api/shipping/product-type/retry-sync/route.ts` |
| `GET/POST /api/shipping/packing-profile` | ✅ | `src/app/api/shipping/packing-profile/route.ts` |
| UI rebuild — store cards, time buckets, classify/manual/packing modals | ✅ | `src/app/shipping/page.tsx` |
| Phase 2 hook: `productEmbedding` field on `PackingProfile` | ✅ зарезервировано, не используется | — |

`MASTER_PROMPT_v3.1.md`, `/api/shipping/buy/route.ts`, и алгоритм выбора rate (`selectBestRate`) — не трогали, как и оговорено.
