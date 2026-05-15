# CLAUDE CODE PROMPT — Shipping Labels Page Overhaul v1.0

> **Target repo:** `kuzyvladimir-maker/ss-control-center`
> **Date:** 2026-05-12
> **Reference spec:** `docs/wiki/shipping-labels-page-v1.md`
> **Execution mode:** один цельный коммит в конце задачи

---

## 🎯 ЦЕЛЬ

Переделать страницу `/shipping` (Shipping Labels) в полноценный operations dashboard. Сейчас страница — каркас, который что-то делает только после нажатия «Generate plan». Должно стать: при заходе сразу видна актуальная картина по всем магазинам, с возможностью разрулить multi-item / multi-qty заказы вручную (с самообучением), классифицировать неизвестные товары через AI или вручную, и пакетно покупать этикетки.

Базовая логика покупки этикеток (выбор carrier/service, бюджет, weekend rules, frozen rules) — **не меняется**, она в `MASTER_PROMPT_v3.3.md` (ОБНОВЛЕН 2026-05-14 вечер: концепция двух дат на заказ — `labelDate` + `physicalShipDate` + Ship Date Trick переписан). Этот промпт добавляет надстройку: dashboard, AI classification, manual overrides, packing profiles, реализацию dual dates и Ship Date Trick.

**Что должно быть после реализации:**

1. На странице `/shipping` при заходе сразу видны live-данные из Veeqo (без нажатия Generate Plan).
2. Сверху — dashboard с per-store разбивкой (сколько ордеров в каждом магазине, сколько готовы к покупке, сколько требуют внимания).
3. Time bucket chips (как в Procurement): Overdue / Today / Tomorrow / Day After / Later — фильтруют список ниже.
4. Список Shipping Plan ниже: чекбоксы, выбранный rate/carrier/price/EDD, кнопка «Buy Selected».
5. Заказы без классификации Frozen/Dry помечены — две кнопки: «Classify with AI» (preview + confirm) и «Set manually».
6. Multi-item / multi-qty заказы без сохранённого packing profile помечены — модалка для ручного ввода box + weight, после Save профиль сохраняется в БД на будущее.
7. Manual override типа товара дублируется в Veeqo как тег на продукте (через `setProductTag`).
8. После покупки — PDF в Google Drive по структуре из MASTER_PROMPT, employee note в Veeqo.

---

## 📚 СПРАВОЧНЫЕ ДОКУМЕНТЫ — обязательно прочитать перед работой

1. **`docs/MASTER_PROMPT_v3.3.md`** — АКТУАЛЬНАЯ версия (per-order две даты labelDate + physicalShipDate, Ship Date Trick в новых терминах). v3.2/v3.1 — история, НЕ использовать.
2. **`docs/wiki/cutoff-time-rule.md`** — детали per-order cutoff + референсная реализация `computeLabelDate()`.
3. **`docs/wiki/ship-date-trick.md`** — механика Veeqo PUT trick для Frozen.
4. **`docs/wiki/shipping-labels-page-v1.md`** — wiki-страница этой задачи.
3. **`docs/wiki/procurement-module.md`** — паттерн time bucket chips (overdue/today/tomorrow/dayafter/later). Эту же UX идиому переносим на Shipping Labels.
4. **`src/app/procurement/page.tsx`** — конкретно посмотреть как реализованы `shipByBucket()`, `SHIP_BY_OPTIONS`, `FilterTabs`. Скопировать паттерн, не изобретать заново.
5. **`src/app/shipping/page.tsx`** — текущий код страницы. Часть UI и логика purchase сохраняются.
6. **`src/lib/veeqo/client.ts`** — уже есть `setProductTag(productId, "Frozen" | "Dry")`, `fetchAllOrders`, `getProduct`, `getShippingRates`, `buyShippingLabel`. Используем как есть.
7. **`src/lib/sku-database.ts`** — после миграции, читает из БД. Используем.
8. **`prisma/schema.prisma`** — уже есть `ProductTypeOverride` (productId → "Frozen"/"Dry"). Используем + расширяем.

---

## 🏗️ ШАГ 1 — Prisma: расширить `ProductTypeOverride` и добавить `PackingProfile`

### Файл: `prisma/schema.prisma`

#### A. Расширить существующую модель `ProductTypeOverride`

Сейчас:
```prisma
model ProductTypeOverride {
  id        String   @id @default(cuid())
  productId Int      @unique
  type      String
  createdAt DateTime @default(now())
}
```

Заменить на:
```prisma
model ProductTypeOverride {
  id        String   @id @default(cuid())
  productId Int      @unique // Veeqo product ID
  type      String   // "Frozen" | "Dry"
  source    String   @default("manual") // "manual" | "ai" — кто установил
  aiConfidence Float? // 0..1, только если source="ai"
  aiReasoning  String? // текст объяснения от AI, только если source="ai"
  syncedToVeeqo Boolean @default(false) // успешно ли проставили тег в Veeqo
  veeqoSyncError String? // последняя ошибка синхронизации (если есть)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

#### B. Добавить новую модель `PackingProfile`

Добавить в конец файла:
```prisma
// Packing profile for multi-item / multi-qty orders. Алгоритм по умолчанию
// использует SKU Database (один SKU, qty=1). Когда заказ состоит из нескольких
// единиц или нескольких листингов — нужны другие box+weight. Эта таблица
// заполняется Vladimir-ом вручную при первом таком заказе, дальше используется
// автоматически по сигнатуре состава.
model PackingProfile {
  id          String   @id @default(cuid())

  // Детерминированная сигнатура состава заказа.
  // Формат: "SKU1:QTY1|SKU2:QTY2|..." отсортировано по SKU (lexicographically).
  // Примеры:
  //   "T4-Y0G0-ZHII:2"                       — один листинг, 2 единицы
  //   "T4-Y0G0-ZHII:1|XM-A131-UXNC:2"        — два листинга, разные qty
  signature   String   @unique

  // Человекочитаемое описание (для UI). Например "Круассаны × 2 + Колбаса × 1"
  description String?

  // Параметры упаковки (введены вручную Vladimir-ом)
  boxSize     String   // "XS" | "S" | "M" | "L" | "XL" | "12-12-8" | "12*12*6" | "7-7-6" | "7-5-14" | "xxxs"
  weight      Float    // lbs — для UPS/USPS/FedEx standard
  weightFedex Float?   // lbs — для FedEx One Rate (если null — берём weight × 1.25)

  // Статистика и метаданные
  itemCount   Int      @default(1) // кол-во разных SKU в составе
  totalQty    Int      @default(1) // суммарное количество единиц
  usedCount   Int      @default(0) // сколько раз профиль использовался
  lastUsedAt  DateTime?

  // Phase 2 self-learning hook (не используется сейчас, но поле создаём заранее
  // чтобы не делать миграцию позже). Будет содержать embedding товаров для
  // semantic similarity matching между похожими комбинациями.
  productEmbedding String? // JSON array of floats, null до Phase 2

  source      String   @default("manual") // "manual" | "ai_suggested" (Phase 2)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([signature])
}
```

### Применить локально

```bash
cd ss-control-center
npx prisma db push
npx prisma generate
```

---

## 🏗️ ШАГ 2 — Миграция Turso (production)

### Файл: `scripts/turso-migrate-shipping-page-v1.mjs`

Создать по образцу `scripts/turso-migrate.mjs`. Содержит:

1. `ALTER TABLE ProductTypeOverride ADD COLUMN ...` для новых полей (`source`, `aiConfidence`, `aiReasoning`, `syncedToVeeqo`, `veeqoSyncError`, `updatedAt`). Использовать `ALTER TABLE ... ADD COLUMN` идемпотентно — обернуть в try/catch так как SQLite не поддерживает `ADD COLUMN IF NOT EXISTS`. При ошибке "duplicate column name" — логировать "уже есть, скип".

2. `CREATE TABLE IF NOT EXISTS PackingProfile` со всеми полями из шага 1.

3. `CREATE UNIQUE INDEX IF NOT EXISTS PackingProfile_signature_key ON PackingProfile(signature)`.
4. `CREATE INDEX IF NOT EXISTS PackingProfile_signature_idx ON PackingProfile(signature)`.

Запускается вручную один раз перед деплоем.

---

## 🏗️ ШАГ 3A — КРИТИЧНО: Per-order dates (labelDate + physicalShipDate)

### Файл: `src/lib/shipping/dates.ts` (новый)

Этот модуль — ядро §0.1 MASTER_PROMPT v3.3. Реализует **per-order** логику двух дат + cutoff 15:00 ET + skip weekends/US federal holidays.

**Без этого вся страница будет работать неправильно:**
- Для заказов с Ship by = today после 15:00 будет ставиться завтрашняя дата на этикетке → Amazon Late Shipment Rate просядет
- Для Frozen заказов с EDD > 3 дней не будет Ship Date Trick → либо не купятся этикетки вообще, либо будет frozen food safety risk

**Установить зависимость:**
```bash
npm install date-holidays
```

**Реализация:**

```typescript
import Holidays from "date-holidays";

const CUTOFF_HOUR_NY = 15; // 3 PM ET (§0.1 MASTER_PROMPT v3.3)
const hd = new Holidays("US");

function nyParts(): { y: string; m: string; d: string; hour: number } {
  const now = new Date();
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  }).formatToParts(now);
  return {
    y: p.find((x) => x.type === "year")!.value,
    m: p.find((x) => x.type === "month")!.value,
    d: p.find((x) => x.type === "day")!.value,
    hour: Number(p.find((x) => x.type === "hour")!.value),
  };
}

export function isBusinessDay(d: Date): boolean {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  const h = hd.isHoliday(d);
  if (h && Array.isArray(h)) {
    return !h.some((x) => x.type === "public" || x.type === "bank");
  }
  return true;
}

export function nextBusinessDay(d: Date): Date {
  const next = new Date(d);
  do { next.setDate(next.getDate() + 1); } while (!isBusinessDay(next));
  return next;
}

/** YYYY-MM-DD для сегодняшнего дня в America/New_York */
export function todayNY(): string {
  const p = nyParts();
  return `${p.y}-${p.m}-${p.d}`;
}

export function isAfterCutoff(): boolean {
  return nyParts().hour >= CUTOFF_HOUR_NY;
}

/**
 * Per-order labelDate. shipByYMD — YYYY-MM-DD в NY TZ.
 *
 * Правило (§0.1 MASTER_PROMPT v3.3):
 *   shipBy < today      → today (overdue)
 *   shipBy == today     → today (дедлайн сегодня, спасаем статистику)
 *   shipBy > today      → today если до cutoff, иначе nextBusinessDay
 */
export function computeLabelDate(shipByYMD: string): string {
  const today = todayNY();
  const todayDate = new Date(`${today}T12:00:00`);
  const shipByDate = new Date(`${shipByYMD}T12:00:00`);

  if (shipByDate <= todayDate) return today;
  if (!isAfterCutoff()) return today;
  return nextBusinessDay(todayDate).toISOString().split("T")[0];
}

/**
 * Ближайший понедельник от ymd (исключительно — если ymd само понедельник, возвращает следующий). С учётом holidays.
 * Используется для Ship Date Trick при Frozen.
 */
export function nextMondayFrom(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00`);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() !== 1);
  while (!isBusinessDay(d)) d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}
```

### `computePhysicalShipDate(order, labelDate)` — живёт в `/api/shipping/plan`

Эта функция требует запроса rates из Veeqo, поэтому не в utility, а в логике сборки плана:

```typescript
async function computePhysicalShipDate(
  order: VeeqoOrder,
  labelDate: string,
  isFrozen: boolean,
  isAmazon: boolean,
  deliverBy: string
): Promise<{
  physicalShipDate: string;
  rate: VeeqoRate | null;
  shipDateTrickApplied: boolean;
  reason?: string;
}> {
  // 1. Попытка отгрузить в labelDate
  let rates = await getRatesWithDispatch(order, labelDate);
  const isDryFlow = !isFrozen;

  if (isDryFlow) {
    const best = selectDryRate(rates, deliverBy);
    return {
      physicalShipDate: labelDate,
      rate: best,
      shipDateTrickApplied: false,
      reason: best ? undefined : "no_service",
    };
  }

  // Frozen flow
  let best = selectFrozenRate(rates, labelDate, deliverBy);
  if (best) {
    return { physicalShipDate: labelDate, rate: best, shipDateTrickApplied: false };
  }

  // Ship Date Trick — попытаться от ближайшего понедельника
  const monday = nextMondayFrom(labelDate);
  rates = await getRatesWithDispatch(order, monday);
  best = selectFrozenRate(rates, monday, deliverBy);

  if (best) {
    return {
      physicalShipDate: monday,
      rate: best,
      shipDateTrickApplied: true,
    };
  }

  return {
    physicalShipDate: labelDate,
    rate: null,
    shipDateTrickApplied: false,
    reason: "no_service",
  };
}
```

`getRatesWithDispatch(order, dispatchDate)`: PUT `/orders/{id}` с dispatch_date=dispatchDate → GET rates → возвращает их. После всех lookups (и перед покупкой) PUT возвращает dispatch_date = labelDate.

### Покупка этикетки (Ship Date Trick в `/api/shipping/buy`)

При покупке заказа где `shipDateTrickApplied = true`:

```typescript
// 1. Сохранить текущий dispatch_date на всякий случай
const orig = order.dispatch_date;

// 2. Ставим dispatch_date = physicalShipDate (для ревалидации rate)
await putOrderDispatch(orderId, physicalShipDate);

// 3. Проверяем что rate всё ещё валиден (рефреш rates)
const freshRates = await getShippingRates(allocationId);
const matchingRate = findRateByService(freshRates, rate.service_type);
if (!matchingRate) throw new Error("Rate expired during Ship Date Trick");

// 4. КРИТИЧНО: возвращаем dispatch_date на labelDate ПЕРЕД покупкой
await putOrderDispatch(orderId, labelDate);

// 5. Покупка — в Veeqo dispatch_date = labelDate, rate был выбран от physicalShipDate
await buyShippingLabel({ ...matchingRate, allocationId });

// 6. Необязательно — проверить что Veeqo не спутал dispatch обратно
// (иногда покупка сбрасывает dispatch — перепроверить GET /orders/{id})
```

> ⚠️ Шаг 4 (возврат dispatch_date на labelDate) — обязателен. Если забыть — Amazon увидит что «отгружено в понедельник» (вместо четверга) → Late Shipment Rate +1.

### Где в коде брать даты

| Поле | Источник |
|------|----------|
| Veeqo `dispatch_date` при `POST /shipping/shipments` | **labelDate** |
| Veeqo `dispatch_date` при `GET /shipping/rates` (для Frozen Ship Date Trick) | **physicalShipDate** (временно) |
| EDD validation (`EDD ≤ X + 3 days`) | X = **physicalShipDate** |
| Имя папки в Google Drive (`MM Month/DD/`) | **physicalShipDate** |
| Имя файла `(EDD ... | DL ...)` | EDD и DL из самого rate |
| Employee note «Label Purchased: ... | Ship: ДАТА» | **labelDate** (с пометкой «Physical: ДАТА» если разные) |
| UI заголовок «Today: ...» | `todayNY()` |

### UI на карточке заказа

```
Order #001-...   Ship by: Thu 5/14
  Label: Thu 5/14    Physical: Mon 5/18  (Ship Date Trick)
```

Цвет:
- 🟢 labelDate == physicalShipDate (обычный кейс)
- 🟡 labelDate ≠ physicalShipDate (Ship Date Trick — Vladimir видит пометку)
- 🔴 overdue (shipBy < today)

**Editable** (как в Veeqo): оба дропдауна позволяют Vladimir-у вручную переопределить (Today / Tomorrow / Monday / Custom). Дефолт — system computed.

---

## 🏗️ ШАГ 3B — Утилита: генерация сигнатуры заказа

### Файл: `src/lib/shipping/packing-signature.ts` (новый)

```typescript
// Генерация детерминированной сигнатуры состава заказа для lookup в
// PackingProfile. Сортировка по SKU обеспечивает что [A:2, B:1] и [B:1, A:2]
// дают одинаковую сигнатуру.

export interface OrderLineItem {
  sku: string;
  quantity: number;
}

export function buildPackingSignature(items: OrderLineItem[]): string {
  const filtered = items.filter((i) => i.sku && i.quantity > 0);
  const sorted = [...filtered].sort((a, b) => a.sku.localeCompare(b.sku));
  return sorted.map((i) => `${i.sku}:${i.quantity}`).join("|");
}

export function buildPackingDescription(
  items: Array<{ productTitle: string; quantity: number }>
): string {
  return items
    .map((i) => `${i.productTitle} × ${i.quantity}`)
    .join(" + ");
}

/**
 * Заказ требует PackingProfile lookup если суммарное количество единиц > 1
 * или количество разных листингов > 1.
 */
export function requiresPackingProfile(items: OrderLineItem[]): boolean {
  if (items.length > 1) return true;
  if (items.length === 1 && items[0].quantity > 1) return true;
  return false;
}
```

---

## 🏗️ ШАГ 4 — API endpoint `/api/shipping/dashboard` (новый)

### Файл: `src/app/api/shipping/dashboard/route.ts`

**Назначение:** при заходе на страницу `/shipping` UI вызывает этот endpoint и сразу получает live-данные для top-section дашборда. Без формирования полного shipping plan — это быстрая агрегация.

#### Логика

1. `fetchAllOrders("awaiting_fulfillment")` — все заказы со всех магазинов через Veeqo пагинацию.
2. Для каждого заказа собрать минимум:
   - Order ID, order number
   - Channel name (Amazon Salutem / Walmart / etc.) — берём из `channel.name`
   - Store identifier — мапить через таблицу `Store` (по `storeIndex` или `sellerId`)
   - Ship By (`dispatch_date` после `veeqoDateToLocal`)
   - Tags (есть ли `Placed`)
   - Already has `✅ Label Purchased` в employee_notes? (если да — не считаем как pending)
3. Классификация состояний (для каждого заказа):
   - `BOUGHT` — есть `Label Purchased` в employee_notes
   - `WAITING_PLACED` — нет тега `Placed` (товар ещё не закуплен у поставщика, ждём)
   - `NEED_ATTENTION` — есть `Placed`, но **что-то не так**:
     - Нет тега Frozen/Dry на продукте И нет `ProductTypeOverride` в нашей БД
     - Mixed order (один item Frozen, другой Dry)
     - Frozen на Walmart (запрещено)
     - Multi-item / multi-qty И нет `PackingProfile` для этой сигнатуры
     - Превышен бюджет
     - Нет подходящего carrier service
   - `READY_TO_BUY` — есть `Placed`, классификация определена, упаковка определена, всё в бюджете
4. Time bucket: `overdue` / `today` / `tomorrow` / `dayafter` / `later` (по `dispatch_date` в локальной TZ). Логика та же что в `procurement/page.tsx`.

#### Response shape

```typescript
{
  refreshedAt: "2026-05-12T15:30:00Z",
  storeBreakdown: [
    {
      storeId: "...",
      storeName: "Salutem Solutions",
      channel: "Amazon",
      totals: {
        all: 12,          // все awaiting_fulfillment
        readyToBuy: 5,
        needAttention: 4,
        waitingPlaced: 3,
        boughtToday: 2,   // эти НЕ входят в `all`, отдельно
      },
    },
    // ... по каждому магазину
  ],
  timeBuckets: {
    overdue: 1,
    today: 18,
    tomorrow: 6,
    dayafter: 4,
    later: 2,
  },
  // Список заказов с минимумом данных для отрисовки списка ниже.
  // Полные rates подгружаются отдельно (см. ШАГ 5).
  orders: [
    {
      orderId: "12345",
      orderNumber: "001-1234567",
      storeId: "...",
      storeName: "Salutem Solutions",
      channel: "Amazon",
      shipBy: "2026-05-12",  // в локальной TZ
      timeBucket: "today",
      deliverBy: "2026-05-14",
      state: "ready_to_buy" | "need_attention" | "waiting_placed" | "bought",
      needAttentionReason: "no_type" | "mixed_order" | "frozen_walmart" | "no_packing" | "no_sku" | "budget" | "no_service" | null,
      items: [
        { sku: "...", productId: 123, productTitle: "...", quantity: 1, knownType: "Frozen" | "Dry" | null }
      ],
      packingSignature: "...",  // если применимо
      packingProfileFound: true | false,
    },
    // ...
  ]
}
```

#### Производительность

- Кэшировать `Store` lookup в памяти на время request (одной таблицей `Map<storeIndex, storeName>`).
- `getProduct(productId)` для проверки тегов Frozen/Dry — делать **только для уникальных productId**, дедупликация. Этот вызов медленный (Veeqo rate limit 5 req/sec). Параллелить через `Promise.all` батчами по 5.
- Для `ProductTypeOverride` — один SELECT `findMany` по списку productId.
- Для `PackingProfile` — один SELECT `findMany` по списку сигнатур.
- Для `SkuShippingData` — один SELECT `findMany` по списку SKU.
- Не запрашивать `getShippingRates` здесь — он медленный и нужен только когда юзер хочет посмотреть детали. Rates подгружаются отдельным endpoint при необходимости.

#### Что НЕ делает этот endpoint

- Не вычисляет rates / carrier / price (это `/api/shipping/plan`).
- Не покупает ничего.
- Не вызывает AI.

---

## 🏗️ ШАГ 5 — API endpoint `/api/shipping/plan` (расширение существующего)

Сейчас этот endpoint собирает shipping plan для **сегодняшних** заказов с тегом Placed. Расширяем:

1. Принимает query parameter `orderIds=id1,id2,id3` — формирует план только для перечисленных заказов.
2. Если `orderIds` не передан — формируется по всем заказам с `state = ready_to_buy` (с учётом `labelDate` per-order).
3. **Для каждого заказа:**
   - Вычислить `labelDate = computeLabelDate(shipBy)` (из ШАГ 3A).
   - Определить `type` (Frozen/Dry) из `ProductTypeOverride` → Veeqo tag → если нет → need_attention `no_type`.
   - Определить упаковку: SkuShippingData / PackingProfile.
   - Вызвать `computePhysicalShipDate(order, labelDate, isFrozen, ...)` — это возвращает `{ physicalShipDate, rate, shipDateTrickApplied }`.
   - Проверить бюджет.
4. **Response расширен** — добавь поля:
   ```typescript
   {
     ...existing fields,
     labelDate: "2026-05-14",
     physicalShipDate: "2026-05-18",
     shipDateTrickApplied: true,
     datesMatch: false,  // labelDate == physicalShipDate?
   }
   ```
5. `usedCount` PackingProfile инкремент — **только при покупке** (`/api/shipping/buy`), не при plan.

> ⚠️ При расчёте `EDD validation` (§5 MASTER_PROMPT): `daysToDeliver = EDD - physicalShipDate`, **не** `EDD - today`. Для Frozen это критично — правило «≤3 кал. дня» применяется от physicalShipDate.

---

## 🏗️ ШАГ 6 — API endpoint `/api/shipping/classify-ai` (новый)

### Файл: `src/app/api/shipping/classify-ai/route.ts`

**POST** — принимает `{ productId: number }`, возвращает classification.

#### Логика

1. Получить product через `getProduct(productId)`.
2. Извлечь поля:
   - `title` — название
   - `description` — полное описание (через Veeqo product endpoint — оно полное, не усечённое)
   - `main_image` URL — главная картинка (или первое изображение из `images[]` если `main_image` нет)
3. Сформировать prompt для Claude (используем `src/lib/claude.ts` — он уже подключен в проекте):

```
Ты классифицируешь товар как FROZEN или DRY для логистики.

Контекст: Salutem Solutions продаёт продукты питания на Amazon. Frozen — это
замороженные товары которые требуют хладопакетов и быстрой доставки (≤3 дня).
Dry — обычные товары без температурного режима.

Подсказки:
- На картинках замороженных товаров часто изображён пенопластовый кулер
- В описании могут быть слова "frozen", "freezer", "thaw", "keep frozen"
- Title часто содержит явное указание (например "Frozen Pizza")

Товар:
Title: {title}
Description: {description}
Image: {prefilled image, передаётся через vision API}

Ответь СТРОГО в JSON формате:
{
  "type": "Frozen" | "Dry",
  "confidence": 0.0-1.0,
  "reasoning": "краткое объяснение на русском (1-2 предложения)"
}
```

4. Использовать Claude API с vision (если есть картинка) — модель `claude-sonnet-4-5` или последняя доступная. Если картинки нет — текстовый prompt без vision.
5. Распарсить ответ. Возвратить:
```typescript
{
  productId,
  productTitle: "...",
  productImage: "...",
  type: "Frozen" | "Dry",
  confidence: 0.92,
  reasoning: "..."
}
```

#### Замечания

- Этот endpoint **не сохраняет** результат в БД. Просто возвращает preview. Сохранение происходит после явного confirm в UI через endpoint из ШАГа 7.
- Не вызывает Veeqo API setProductTag — это тоже после confirm.
- Если у проекта нет ANTHROPIC_API_KEY — вернуть 503 "AI service not configured".
- Если Claude вернул невалидный JSON — пытаться парсить, при неудаче вернуть 502 с raw текстом ответа.

---

## 🏗️ ШАГ 7 — API endpoint `/api/shipping/product-type` (новый)

### Файл: `src/app/api/shipping/product-type/route.ts`

**POST** — сохраняет classification (manual или confirmed AI).

#### Body
```typescript
{
  productId: number,
  type: "Frozen" | "Dry",
  source: "manual" | "ai",       // откуда тип взят
  aiConfidence?: number,          // если source="ai"
  aiReasoning?: string,           // если source="ai"
}
```

#### Логика

1. `prisma.productTypeOverride.upsert({ where: { productId }, ... })` — записываем в нашу БД.
2. **Параллельно** (не await перед response) — запустить sync в Veeqo:
   ```typescript
   try {
     await setProductTag(productId, type);
     await prisma.productTypeOverride.update({
       where: { productId },
       data: { syncedToVeeqo: true, veeqoSyncError: null }
     });
   } catch (err) {
     await prisma.productTypeOverride.update({
       where: { productId },
       data: { syncedToVeeqo: false, veeqoSyncError: String(err) }
     });
   }
   ```
3. Возвращаем response сразу после записи в БД (не ждём Veeqo):
   ```typescript
   { success: true, productId, type, veeqoSyncing: true }
   ```

#### Retry для не-засинхренных

Создать отдельный API роут `POST /api/shipping/product-type/retry-sync` который пробежится по всем `ProductTypeOverride.syncedToVeeqo = false` и попробует записать заново. Вызывать его можно из cron или вручную с UI.

---

## 🏗️ ШАГ 8 — API endpoint `/api/shipping/packing-profile` (новый)

### Файл: `src/app/api/shipping/packing-profile/route.ts`

**POST** — создать или обновить профиль для сигнатуры.

#### Body
```typescript
{
  signature: string,
  description: string,
  boxSize: string,
  weight: number,
  weightFedex?: number,
  itemCount: number,
  totalQty: number,
}
```

Реализация: `prisma.packingProfile.upsert({ where: { signature }, ... })`.

**GET** — `?signature=...` — получить профиль (для отладки и для UI чтобы показать «уже есть профиль на эту сигнатуру»).

---

## 🏗️ ШАГ 9 — UI: переделка `src/app/shipping/page.tsx`

### Общая структура

```
┌─────────────────────────────────────────────────────────┐
│  PageHead "Shipping labels"                            │
│  Today: Tue May 12  •  Last refresh: 15:32  [↻ Refresh]│
├─────────────────────────────────────────────────────────┤
│  STORE BREAKDOWN (горизонтальный скролл если 6+)       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                │
│  │Salutem   │ │AMZ Comm. │ │Sirius    │ ...            │
│  │ 12 total │ │ 8 total  │ │ 5 total  │                │
│  │ 5 ready  │ │ 6 ready  │ │ 2 ready  │                │
│  │ 4 ⚠     │ │ 1 ⚠      │ │ 3 ⚠      │                │
│  └──────────┘ └──────────┘ └──────────┘                │
├─────────────────────────────────────────────────────────┤
│  TIME BUCKETS:                                          │
│  [Просрочено 1] [Сегодня 18] [Завтра 6] [Послезавтра 4]│
│  [Позже 2]                                              │
├─────────────────────────────────────────────────────────┤
│  ☐ Select all          [Buy Selected (3)] [Export]     │
│                                                          │
│  ORDER LIST                                              │
│  ┌──────────────────────────────────────────────────────┐│
│  │ ☑ #001-...  Salutem  Jimmy Dean × 1   🧊 Frozen      ││
│  │   1 unit  •  UPS 2DA $7.50  •  EDD 5/14 / DL 5/16   ││
│  ├──────────────────────────────────────────────────────┤│
│  │ ⚠ #001-...  AMZ Comm.  Unknown product               ││
│  │   [Classify with AI] [Set manually: Frozen / Dry]   ││
│  ├──────────────────────────────────────────────────────┤│
│  │ 📦 #001-...  Sirius  Multi-item order               ││
│  │   2 listings, 3 units total                          ││
│  │   [Set Packing Profile]                              ││
│  ├──────────────────────────────────────────────────────┤│
│  │ ⏳ #001-...  Salutem  No "Placed" tag yet           ││
│  │   Waiting for procurement                            ││
│  └──────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

### Конкретно

#### `useEffect(() => { void load(); }, [])` — при заходе делаем GET `/api/shipping/dashboard` и заполняем state.

#### Кнопка Refresh — повторный вызов того же endpoint.

#### Store cards

Используй существующий компонент `KpiCard` или `StoreAvatar` из `@/components/kit` если они подходят. Если нет — добавь новый `StoreBreakdownCard`. Все 3 числа (total / ready / attention) на карточку. Клик по карточке → фильтр списка ниже только по этому магазину (toggle).

#### Time bucket chips

Используй `FilterTabs` из `@/components/kit` — тот же что в `procurement/page.tsx`. Цвета:
- `overdue` — danger
- `today` — warn-strong
- `tomorrow` — info
- `dayafter` — green
- `later` — neutral

Клик → фильтр списка по этому bucket. Можно скомбинировать с фильтром по магазину.

#### Order list

Карточки заказов. Состояние карточки определяется полем `state`:

- **`ready_to_buy`** — чекбокс активен, видны carrier/service/price/EDD. Можно отметить и купить.
- **`need_attention` + `no_type`** — кнопки `[Classify with AI]` (открывает модалку AI) и `[Set manually]` (открывает модалку выбора).
- **`need_attention` + `no_packing`** — кнопка `[Set Packing Profile]` (открывает модалку с полями).
- **`need_attention` + другие причины** (mixed_order, frozen_walmart, no_sku, budget, no_service) — серая карточка с описанием причины. Кнопок действий нет (для разных причин — разные действия, разрулим в Phase 2).
- **`waiting_placed`** — мутная карточка «Waiting for procurement». Чекбокса нет.
- **`bought`** — зелёная карточка «Bought  tracking: XXX». Чекбокса нет.

#### Модалка AI Classify

Используй `Dialog` из `@/components/ui/dialog` (он уже импортирован в текущей странице).

UX:
1. Юзер жмёт `[Classify with AI]` на карточке.
2. Открывается модалка с loading spinner «AI is analyzing the product...».
3. На фоне идёт POST `/api/shipping/classify-ai` с `productId`.
4. Когда ответ пришёл — показываем:
   ```
   ┌─────────────────────────────────────────┐
   │ AI Classification — Jimmy Dean Sandwich │
   │                                         │
   │ [Product image preview]                 │
   │                                         │
   │ Result:  🧊 Frozen                       │
   │ Confidence: 94%                         │
   │ Reasoning: В title указано "Frozen      │
   │   Pizza", на картинке виден пенопластовый│
   │   кулер.                                │
   │                                         │
   │ [Cancel]  [Override to Dry]  [Confirm]  │
   └─────────────────────────────────────────┘
   ```
5. Клик `Confirm` → POST `/api/shipping/product-type` с `source: "ai"`, `aiConfidence`, `aiReasoning`. Закрываем модалку, перезагружаем дашборд (или хотя бы конкретный заказ через `/api/shipping/plan?orderIds=...`).
6. Клик `Override to Dry` (или наоборот, если AI сказал Dry — кнопка `Override to Frozen`) — то же самое но с обратным `type` и `source: "manual"` (поскольку юзер не согласился с AI).
7. Клик `Cancel` — закрываем без изменений.

#### Модалка Set Manually

Простая модалка с двумя большими кнопками `🧊 Frozen` и `📦 Dry`. По клику — POST `/api/shipping/product-type` с `source: "manual"`. Закрытие, перезагрузка.

#### Модалка Packing Profile

UX:
1. Юзер жмёт `[Set Packing Profile]`.
2. Открывается модалка:
   ```
   ┌─────────────────────────────────────────┐
   │ Packing Profile                          │
   │ Order #001-1234567                       │
   │                                         │
   │ Composition:                             │
   │  • Croissants × 2  (SKU: T4-Y0G0-ZHII)  │
   │  • Sausage × 1     (SKU: XM-A131-UXNC)  │
   │                                         │
   │ Signature: T4-Y0G0-ZHII:2|XM-A131-UXNC:1│
   │ (Will be saved for future orders with    │
   │  this exact composition)                 │
   │                                         │
   │ Box size:    [Select ▼ XS S M L XL ...] │
   │ Weight (lbs): [_____]                    │
   │ Weight FedEx One Rate (lbs):             │
   │   [_____]  (optional — if empty,         │
   │            auto-calculated as weight×1.25)│
   │                                         │
   │ [Cancel]                       [Save]   │
   └─────────────────────────────────────────┘
   ```
3. На Save → POST `/api/shipping/packing-profile` → закрытие → re-fetch dashboard.

#### Buy Selected

При клике:
1. Собрать список `orderId` тех заказов где чекбокс отмечен И `state === "ready_to_buy"`.
2. POST `/api/shipping/buy` с этим списком (текущая логика).
3. Показывать progress («Buying 1 of 5…», «Buying 2 of 5…», и т.д.).
4. По завершении — re-fetch dashboard.

### Что сохраняется из текущего кода

- Структура import-ов и общий каркас.
- Логика `/api/shipping/buy` flow — она работает.
- Компоненты из `@/components/kit` — используем максимально, не плодим новые без нужды.
- `getDayInfo`, `selectBestRate` и прочие хелперы в `/api/shipping/plan` — не трогаем, расширяем только то что описано в ШАГе 5.

### Что переделывается

- 4 KpiCard сверху (`IN PLAN`, `READY TO BUY`, `NEED ATTENTION`, `SELECTED`) → заменить на StoreBreakdown row.
- Empty state "No orders found for today" → нормальный empty state когда реально 0 заказов после refresh (по всем магазинам).
- Текущий `selected: Set<string>` сохраняется, расширяется логикой что отмечать можно только `ready_to_buy`.

---

## 🏗️ ШАГ 10 — Wiki

### Создать `docs/wiki/shipping-labels-page-v1.md`

Полная спецификация: dashboard structure, time buckets, AI classification flow, manual override flow, packing profile flow, связи с MASTER_PROMPT.

### Обновить `docs/wiki/shipping-labels.md`

Добавить ссылки на новую страницу-спецификацию + краткое описание новых возможностей.

### Обновить `docs/wiki/index.md` и `docs/wiki/CONNECTIONS.md`

Добавить новую страницу + связи (← AI Claude, ← Veeqo API, ⊂ MASTER_PROMPT_v3.1).

---

## ✅ ACCEPTANCE CRITERIA

1. При заходе на `/shipping` (без нажатия чего-либо) сверху появляются заполненные store cards и time bucket chips в течение 5-10 секунд (Veeqo медленный — это нормально).
2. Кнопка Refresh обновляет данные.
3. Кликнув на time bucket chip — список фильтруется. Повторный клик — снимает фильтр.
4. Кликнув на store card — список фильтруется. Повторный клик — снимает.
5. Заказ без типа Frozen/Dry показывает две кнопки. Classify with AI — открывает модалку с preview, Confirm записывает в нашу БД и пытается синхронизировать в Veeqo.
6. После classification в Veeqo тег появляется на продукте (может через 5-10 секунд из-за async sync).
7. Multi-item / multi-qty заказ без профиля показывает кнопку `Set Packing Profile`. После сохранения профиля заказ переходит в `ready_to_buy` (после re-fetch).
8. Повторный заказ с такой же сигнатурой автоматически использует сохранённый профиль (без модалки).
9. Buy Selected покупает этикетки, PDF выгружаются в Google Drive, employee notes ставятся.
10. На production (Vercel + Turso) после деплоя всё работает идентично dev.

---

## 🌱 Future Self-Learning Enhancements (Phase 2 — НЕ реализуем сейчас)

Vladimir в обсуждении упомянул что в будущем хочет видеть semantic similarity между похожими товарами — например когда `Croissant Sandwich` имеет packing profile, а заказали `Biscuit Sandwich` похожей упаковки — система могла бы предложить тот же профиль с пометкой «Possibly applicable — confirm?».

Чтобы заложить хук на будущее (без реализации сейчас):
- В `PackingProfile` создано поле `productEmbedding String?` — Phase 2 заполнит embedding-ом из Claude/OpenAI.
- В `ProductTypeOverride` — отдельный embedding не нужен, classification и так быстрая.
- При формировании плана в Phase 2 можно добавить шаг: если `PackingProfile.findUnique({ signature })` не нашёл точного совпадения — попробовать semantic search по embedding-ам и предложить ближайшие 1-2 профиля как suggestion (с confidence). Vladimir подтверждает один из них или создаёт новый.

В этом промпте — НЕ реализуем. Просто оставляем поле и заметку в wiki.

---

## 🚫 Что НЕ менять (regression scope)

- **MASTER_PROMPT_v3.3.md** — алгоритм агента не редактируется. Но всё что реализуешь — ДОЛЖНО соответствовать v3.3 (§0.1 dual dates + §7 Ship Date Trick).
- **`/api/shipping/buy/route.ts`** — логика покупки этикетки и записи employee notes остаётся как есть.
- **Структура папок Google Drive** для PDF — как в MASTER_PROMPT.
- **Логика выбора rate** (`selectBestRate` в `/api/shipping/plan`) — алгоритм Dry / Frozen / weekend не меняем.
- **`src/lib/sku-database.ts`** — только что мигрировали, не трогаем.
- **`src/lib/google-sheets.ts`** — DEPRECATED, не импортируем.
- **Существующие модели Prisma** кроме `ProductTypeOverride` — не трогаем.

---

## 📦 Финальный коммит

```
feat: shipping labels page overhaul v1 — dashboard, AI classify, packing profiles

- Extend ProductTypeOverride model (source, aiConfidence, aiReasoning, syncedToVeeqo)
- Add PackingProfile model with signature-based lookup for multi-item orders
- Add scripts/turso-migrate-shipping-page-v1.mjs for production schema
- Add src/lib/shipping/packing-signature.ts utility
- Add /api/shipping/dashboard — live per-store breakdown + time buckets
- Add /api/shipping/classify-ai — Claude vision classification preview
- Add /api/shipping/product-type — manual/AI confirm + async Veeqo sync
- Add /api/shipping/packing-profile — CRUD for packing profiles
- Extend /api/shipping/plan — supports orderIds filter + new lookups
- Rebuild src/app/shipping/page.tsx — store cards, time buckets, modals
- Add wiki: shipping-labels-page-v1.md, update CONNECTIONS and index

Future enhancement hook: productEmbedding field on PackingProfile for
semantic similarity matching (Phase 2, not implemented now).
```

---

**End of prompt** — 2026-05-12
