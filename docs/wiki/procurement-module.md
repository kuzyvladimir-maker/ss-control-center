# PROCUREMENT MODULE — Алгоритм и спецификация v1.0

> **Date:** 2026-05-03
> **Repo:** `kuzyvladimir-maker/ss-control-center`
> **Owner:** Vladimir
> **Status:** Spec finalized, Phase 1 ready for implementation

---

## 🎯 ЦЕЛЬ МОДУЛЯ

Procurement — мобильно-ориентированный раздел SS Control Center для физического закупа товара в магазинах (Publix, Walmart, BJ's, Sam's Club). Заменяет ручной workflow в Veeqo-приложении на телефоне и устраняет три главных боли:

1. **Ставить теги в Veeqo с телефона неудобно** → даём один-тап действия "куплено" / "купил частично".
2. **Нет сортировки по названию** → даём сортировку (важно когда несколько заказов одного и того же товара подряд).
3. **Зум фотографии и копирование названия в Veeqo неудобны** → даём fullscreen lightbox по тапу на фото и одну кнопку для копирования.

В будущем модуль станет основой для агента-автозакупщика через delivery (Phase 2 проекта).

---

## 🏛️ КОНТЕКСТ И СВЯЗИ

- **Источник данных:** только Veeqo API (orders + products + tags + internal notes).
- **БД проекта (Turso/Prisma):** хранит только `SKUStorePriority` (метаданные про "где какой SKU покупать") и `ProcurementSyncQueue` (для офлайн-режима).
- **Связь с Shipping Labels:** когда Procurement ставит тег `Placed` на заказ, модуль Shipping Labels (`MASTER_PROMPT_v3.1.md`) автоматически начинает видеть этот заказ как готовый к покупке этикетки. **Это и есть главный смысл интеграции** — раньше Vladimir вручную ставил `Placed` после закупа, теперь это делает Procurement по тапу.
- **Связь с Customer Hub:** прямой связи нет, но Order ID одинаковый — в будущем можно добавить cross-link.

---

## 📲 USER WORKFLOW (как Vladimir этим пользуется)

```
1. Vladimir едет в Publix.
2. Открывает с iPhone home screen иконку SS (PWA).
3. Логинится (один раз — Safari запоминает).
4. Видит список товаров, которые НУЖНО купить (отсортированы по Ship By).
5. Может переключить сортировку на "по названию" → товары одинакового
   вида группируются → удобно идти по магазину.
6. Идёт по магазину, находит товар:
   - Купил полностью → один тап на "Купил всё" → карточка помечается ✅
     (но НЕ исчезает из списка — это критично).
   - Купил частично → тап на "Купил частично" → ввод "осталось купить N штук"
     → карточка помечается ⚠️ (тоже не исчезает).
   - Случайно тапнул → ещё один тап → откат состояния.
7. Прошёл магазин — делает swipe-down (pull-to-refresh) ИЛИ кнопкой Refresh.
   - Все заказы со статусом "куплено всё" исчезают (т.к. на них
     поставился тег `Placed`).
   - Все заказы "куплено частично" остаются с обновлённым числом
     "осталось купить".
8. Едет в Walmart с обновлённым списком. Цикл повторяется.
```

---

## 🎯 ФИЛЬТРАЦИЯ ЗАКАЗОВ — что показывать в списке

### Источник: Veeqo API

```
GET /orders?status=awaiting_fulfillment&page_size=100&page=1
GET /orders?status=awaiting_fulfillment&page_size=100&page=2
... пагинировать пока не вернётся пустой массив
```

### Период

**Без фиксированного диапазона.** Показываем все `awaiting_fulfillment` заказы — фильтрация идёт по тегам, не по дате. Заказов со статусом `awaiting_fulfillment` не накапливается много (старые либо отгружаются, либо переходят в другие статусы), так что period filter не нужен.

### Каналы продаж

**Все каналы:** Amazon, Walmart, eBay, TikTok, Website, и любые другие. (В отличие от Shipping Labels модуля, который работает только с Amazon+Walmart.)

### Тег-фильтр

**ВКЛЮЧАТЬ заказ в список** только если у него:

| Тег | Действие |
|------|----------|
| `Placed` | ❌ ИСКЛЮЧИТЬ (уже куплено всё) |
| `Заказано у Майка` | ❌ ИСКЛЮЧИТЬ (агент уже заказал в Publix) |
| `canceled` | ❌ ИСКЛЮЧИТЬ (заказ отменён) |
| `need to adjast` | ❌ ИСКЛЮЧИТЬ (внутренний workflow Vladimir: товар не найден ни в одном магазине → нужно сделать adjustment на маркетплейсе: снять листинг с продаж, оформить частичный возврат или отменить заказ. К физическому закупу больше не относится) |
| `Need More` | ✅ ВКЛЮЧИТЬ (купили частично, нужно докупить) |
| Нет тегов вообще | ✅ ВКЛЮЧИТЬ (новый заказ, нужно купить) |

> **Важно:** теги в Veeqo чувствительны к регистру. Точные написания подтверждены скриншотом Vladimir:
> - `Placed` (с заглавной P)
> - `Need More` (два слова, обе с заглавной)
> - `Заказано у Майка` (русский, "З" заглавная)
> - `canceled` (всё строчные)
> - `need to adjast` (всё строчные, опечатка `adjast` вместо `adjust` — оставляем как есть в Veeqo)

### FBA — отдельно

Заказы Amazon FBA обычно не попадают в `awaiting_fulfillment` в Veeqo (Amazon отгружает сам). Если каким-то образом FBA-заказ туда попал — его всё равно стоит исключить (явно проверять `fulfillment_channel != "AFN"` если поле есть в Veeqo, иначе по тегу/каналу).

---

## 📋 СТРУКТУРА КАРТОЧКИ ТОВАРА

В одном Veeqo-заказе может быть несколько разных товаров (`line_items`). **Каждый line item = отдельная карточка** в нашем приложении. Но визуально карточки из одного заказа должны быть **сгруппированы** (например, тонкая полоска цвета или малозаметный header "Order #112-1234567 → 2 товара").

### Поля карточки

**Главные (крупно):**
- 📷 **Фото товара** (главное фото из Veeqo, тап → fullscreen lightbox с зумом)
- 📝 **Название товара** (крупным шрифтом, копируется одним тапом или иконкой 📋)
- 🔢 **Количество** ("Купить: 5 шт" или, если уже частичная закупка, "Осталось: 3 из 5")

**Второстепенные (мельче):**
- 🛒 **Канал продаж** (Amazon / Walmart / eBay / TikTok / Website)
- 🏪 **Магазин** (один из 5 Amazon-аккаунтов или другой канал)
- 📦 **Order ID** (для возможного cross-link)
- 📅 **Ship By** (дата отгрузки, иконка срочности если сегодня/завтра)
- 🏬 **Магазины для закупа** (теги "Publix → Walmart → BJ's" из таблицы `SKUStorePriority`, маленьким шрифтом)

**Действия (всегда видны):**
- ✅ **Кнопка "Купил всё"** (если тапнул — карточка маркируется как done, но остаётся в списке до refresh)
- ⚠️ **Кнопка "Купил частично"** (тап → инпут "Сколько осталось купить?" → save)
- 🔄 **Откат** (если на карточке стоит уже какой-то статус — повторный тап на ту же кнопку откатывает)
- 📋 **Копировать название** (одной иконкой)
- 🏪 **Редактировать магазины** (маленькая иконка-карандаш у тегов магазинов → попап)

---

## 🔄 ЛОГИКА ДЕЙСТВИЙ

### Сценарий A: одиночный товар в заказе

**Заказ:** 1 line item — Wings × 5

| Действие | Тег на заказе | Notes |
|----------|---------------|-------|
| Вначале | (нет) | (нет блока `[PROCUREMENT]`) |
| Тап "Купил всё" | `Placed` | `[PROCUREMENT]\nlineItem-{id} \| Wings \| bought\n[/PROCUREMENT]` |
| Refresh | `Placed` | (заказ исчезает из списка) |
| Тап "Купил частично", остаток 3 | `Need More` | `[PROCUREMENT]\nlineItem-{id} \| Wings \| remain:3\n[/PROCUREMENT]` |
| Refresh | `Need More` | (заказ остаётся, qty показано как 3) |

### Сценарий B: multi-item заказ (САМАЯ ВАЖНАЯ ЛОГИКА)

**Заказ:** 2 line items — Wings × 3 и Sausage × 5

| Действие | Тег на заказе | Notes |
|----------|---------------|-------|
| Вначале | (нет) | (нет) |
| Тап "Купил всё" на Wings | `Need More` | `[PROCUREMENT]\nlineItem-{wings} \| Wings \| bought\nlineItem-{sausage} \| Sausage \| remain:5\n[/PROCUREMENT]` |
| Тап "Купил частично" на Sausage, остаток 2 | `Need More` | `[PROCUREMENT]\nlineItem-{wings} \| Wings \| bought\nlineItem-{sausage} \| Sausage \| remain:2\n[/PROCUREMENT]` |
| Тап "Купил всё" на Sausage (докупил) | `Placed` (заменяет `Need More`!) | `[PROCUREMENT]\nlineItem-{wings} \| Wings \| bought\nlineItem-{sausage} \| Sausage \| bought\n[/PROCUREMENT]` |

> **Ключевое правило:** после каждого действия проверяем — **все ли line items в этом заказе помечены как `bought`**?
> - Если ДА → снимаем `Need More` с заказа, ставим `Placed`.
> - Если НЕТ → ставим `Need More` (если ещё не стоит).

### Сценарий C: откат (undo) в текущей сессии

После одного тапа изменения уходят в Veeqo (тег + notes обновляются). Но в UI карточка **не исчезает** — она просто меняет визуальный статус. Если повторно тапнуть на ту же кнопку — состояние откатывается в Veeqo обратно (тот же API-вызов, но в обратную сторону).

После refresh / pull-to-refresh — список перезагружается, и `Placed` карточки исчезают.

---

## 🏷️ ФОРМАТ EMPLOYEE NOTES (парсер)

Internal notes в Veeqo — общее поле для всех систем (Vladimir вручную, Shipping Labels модуль, Procurement). Чтобы не конфликтовать, Procurement использует обрамляющие маркеры:

```
[PROCUREMENT]
{line_item_id} | {product_short_name} | {status}
{line_item_id} | {product_short_name} | {status}
[/PROCUREMENT]
```

Где `{status}` ∈ `bought` | `remain:{N}`.

### Парсер должен:
1. **Читать:** найти блок между маркерами, разобрать строки, вернуть `Map<lineItemId, status>`.
2. **Писать:** заменить старый блок (если есть) на новый — НЕ удаляя ничего за пределами маркеров.
3. **Если блока нет** → дописать в конец.

```typescript
// Пример входа (Veeqo internal_note):
"
✅ Label Purchased: 2026-04-30 ID:12345

[PROCUREMENT]
li-9999 | Wings | bought
li-8888 | Sausage | remain:2
[/PROCUREMENT]
"

// После замены (Sausage докуплен):
"
✅ Label Purchased: 2026-04-30 ID:12345

[PROCUREMENT]
li-9999 | Wings | bought
li-8888 | Sausage | bought
[/PROCUREMENT]
"
```

---

## 🔍 СОРТИРОВКА И ПОИСК

### Сортировка (всегда видна, два таб-стиля)

- **По Ship By ↑** (по умолчанию, самые срочные сверху)
- **По названию A→Z** (для удобной навигации в магазине)

Переключатель в виде сегментированного контрола вверху списка.

### Поиск (Phase 5)

Маленькая иконка 🔎 → раскрывает поле. Один input, ищет по:
- название товара (substring, case-insensitive)
- order number
- имя клиента
- SKU

**Тогл рядом с поиском:** "Только нужно купить" / "Все" — переключает фильтр между текущей выборкой и всеми заказами.

---

## 🏪 МАГАЗИНЫ НА SKU (Phase 4)

### Структура данных (БД проекта, не Veeqo)

```prisma
model SKUStorePriority {
  id          String   @id @default(cuid())
  sku         String
  storeName   String   // "Publix" | "Walmart" | "BJ's" | "Sam's Club" | "Costco" | другое
  priority    Int      // 1 = первый, 2 = второй, и т.д.
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([sku, storeName])
  @@index([sku])
}
```

### UI

На карточке товара — маленькая иконка (например, 🏪 или карандаш) рядом со списком магазинов. Тап → попап:

```
┌────────────────────────────────────┐
│  Где покупать: SKU XM-A131-UXNC    │
│                                    │
│  1. ⋮⋮ Publix              [✕]    │
│  2. ⋮⋮ Walmart             [✕]    │
│  3. ⋮⋮ BJ's                [✕]    │
│                                    │
│  + Добавить магазин ▼              │
│                                    │
│  [Cancel]              [Save]      │
└────────────────────────────────────┘
```

Drag handles `⋮⋮` для перестановки (mobile-friendly drag-n-drop). Список магазинов в дропдауне фиксированный: `Publix, Walmart, BJ's, Sam's Club, Costco, Trader Joe's, Aldi, Whole Foods, Other`.

---

## 📡 PWA + ОФЛАЙН (Phase 6)

### Установка на iPhone home screen

- `manifest.json` с иконкой Salutem (зелёный фон, белый логотип)
- `<meta name="apple-mobile-web-app-capable" content="yes">`
- При открытии с home screen — fullscreen, без браузерной обвязки

### Service Worker — стратегия кеша

- **`/api/procurement/items`** → `stale-while-revalidate` (показываем кеш моментально, в фоне обновляем)
- **Фотографии товаров** → `cache-first` с TTL 7 дней
- **Статика приложения** → `cache-first`

### Sync Queue (для действий без интернета)

```prisma
model ProcurementSyncQueue {
  id           String   @id @default(cuid())
  lineItemId   String
  orderId      String
  action       String   // "bought" | "partial" | "undo"
  payload      Json     // например, { remaining: 3 }
  status       String   // "pending" | "synced" | "failed"
  createdAt    DateTime @default(now())
  syncedAt     DateTime?
  errorMessage String?

  @@index([status])
}
```

При тапе без интернета:
1. Действие моментально применяется к UI (optimistic).
2. Запись в `ProcurementSyncQueue` со статусом `pending`.
3. При появлении сети — фоновый job поднимает все `pending` записи и пушит в Veeqo по очереди.
4. После успеха → `status: synced`. При ошибке → `status: failed` + `errorMessage`, плюс уведомление Vladimir в Telegram.

---

## 🚨 УВЕДОМЛЕНИЯ О ПРИОРИТЕТНЫХ ЗАКАЗАХ (Phase 7)

### Детектор приоритета

Veeqo помечает приоритетные заказы несколькими способами (видно на скриншоте Vladimir):
- **Premium флаг** (оранжевая молния "Premium")
- **Shipping method** содержит `Next Day`, `One-Day`, `Two-Day`, `Same Day`, `Expedited`, `2nd Day Air`
- **Expected dispatch date** = сегодня или завтра

Заказ считаем приоритетным, если выполнено **любое** из условий выше.

### Cron job

Каждые 15 минут:
1. Тянем `awaiting_fulfillment` заказы из Veeqo за последние 24 часа.
2. Фильтруем по правилам Procurement (без `Placed` / `Заказано у Майка` / etc.).
3. Среди них находим приоритетные.
4. Сравниваем с таблицей `ProcurementNotificationLog` (id заказа + дата отправки) — чтобы не дублировать.
5. Шлём в Telegram новые.

### Telegram сообщение

```
🚨 Приоритетный заказ требует закупа
Tyson Wings 5oz — 3 шт
Order: 112-1234567 (Amazon)
Доставка: UPS Next Day Air
Ship by: сегодня до 17:00 ET

Открыть в Procurement: https://salutemsolutions.info/procurement?focus=112-1234567
```

### Целевой чат/топик

**TBD перед стартом Phase 7.** Опции:
- Личный чат `486456466` (текущий)
- Отдельная Telegram-группа "Procurement Alerts"
- Топик в существующей группе

---

## 🗄️ СХЕМА БД (Prisma)

Добавить в `prisma/schema.prisma`:

```prisma
model SKUStorePriority {
  id          String   @id @default(cuid())
  sku         String
  storeName   String
  priority    Int
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([sku, storeName])
  @@index([sku])
}

model ProcurementSyncQueue {
  id           String    @id @default(cuid())
  lineItemId   String
  orderId      String
  action       String
  payload      Json
  status       String    @default("pending")
  createdAt    DateTime  @default(now())
  syncedAt     DateTime?
  errorMessage String?

  @@index([status])
}

model ProcurementNotificationLog {
  id         String   @id @default(cuid())
  orderId    String   @unique
  notifiedAt DateTime @default(now())

  @@index([notifiedAt])
}
```

---

## 🔌 API ENDPOINTS (полный список)

| Метод | Путь | Назначение |
|-------|------|------------|
| GET | `/api/procurement/items` | Список карточек (с фильтрами) |
| POST | `/api/procurement/items/:lineItemId/bought` | Отметить как купленный полностью |
| POST | `/api/procurement/items/:lineItemId/partial` | Отметить частично (body: `{ remaining: N }`) |
| POST | `/api/procurement/items/:lineItemId/undo` | Откатить последнее действие |
| GET | `/api/procurement/sku-stores/:sku` | Получить список магазинов для SKU |
| PUT | `/api/procurement/sku-stores/:sku` | Сохранить список магазинов (body: `[{ storeName, priority }]`) |
| GET | `/api/procurement/search` | Smart search (Phase 5) |
| POST | `/api/procurement/sync-queue/process` | Триггер обработки очереди (Phase 6) |
| POST | `/api/procurement/notifications/check` | Cron endpoint для приоритетных (Phase 7) |

---

## 🧱 СТРУКТУРА ФАЙЛОВ В РЕПО

```
src/
├── app/
│   ├── procurement/
│   │   ├── page.tsx                    # Главная страница модуля
│   │   └── components/
│   │       ├── ProcurementCard.tsx     # Карточка товара
│   │       ├── ProcurementList.tsx     # Список с группировкой по заказам
│   │       ├── PhotoLightbox.tsx       # Fullscreen зум фото
│   │       ├── SortControls.tsx        # Переключатель сортировки
│   │       ├── PartialQtyInput.tsx     # Инпут "осталось купить"
│   │       ├── StorePriorityPopup.tsx  # Phase 4
│   │       └── SmartSearch.tsx         # Phase 5
│   └── api/
│       └── procurement/
│           ├── items/
│           │   ├── route.ts            # GET список
│           │   └── [lineItemId]/
│           │       ├── bought/route.ts
│           │       ├── partial/route.ts
│           │       └── undo/route.ts
│           ├── sku-stores/
│           │   └── [sku]/route.ts      # Phase 4
│           ├── search/route.ts          # Phase 5
│           └── notifications/
│               └── check/route.ts       # Phase 7
├── lib/
│   ├── veeqo/
│   │   ├── tags.ts                      # Read/write tags на заказе
│   │   ├── notes.ts                     # Read/write internal notes
│   │   ├── orders-procurement.ts        # Fetch + filter для Procurement
│   │   └── procurement-notes-parser.ts  # Парсер блока [PROCUREMENT]
│   └── procurement/
│       ├── filter-rules.ts              # Логика тег-фильтрации
│       ├── multi-item-status.ts         # Логика "все ли куплены"
│       └── priority-detector.ts         # Phase 7
public/
├── manifest.json                        # Phase 6
└── icons/                                # Phase 6
    ├── icon-192.png
    └── icon-512.png
```

---

## ✅ ЧТО НЕ ВХОДИТ В МОДУЛЬ (вне рамок)

- ❌ История закупок прошлых месяцев — отдельный feature на будущее, в desktop-версии.
- ❌ Цены закупа / маржа — это область Sellerboard, его подключим отдельным модулем.
- ❌ GPS-определение текущего магазина — пока не нужно.
- ❌ Multi-user / роли — будет когда подключим систему ролей в SS Control Center целиком.
- ❌ Дублирование данных между line items одного товара в разных заказах — каждый заказ показываем как есть.

---

## 🔗 СВЯЗИ

```
Procurement
    ↑ Veeqo API (orders, products, tags, notes)
    ↓ ставит тег `Placed` → Shipping Labels модуль автоматически видит заказ как готовый к покупке этикетки
    ⊂ SS Control Center (auth, design system, БД Turso)
    ⇔ SKUStorePriority (новая таблица)
    → Telegram (Phase 7)
```

---

## 📝 ФАЗИРОВАНИЕ РЕАЛИЗАЦИИ

| Фаза | Что | Промпт-файл |
|------|-----|-------------|
| 1 | Бэкенд + минимальная страница | `CLAUDE_CODE_PROMPT_PROCUREMENT_PHASE_1.md` |
| 2 | Мобильный UI (карточки, фото, сортировка) | TBD |
| 3 | Действия (купил/частично/откат) | TBD |
| 4 | Магазины на SKU | TBD |
| 5 | Умный поиск | TBD |
| 6 | PWA + офлайн | TBD |
| 7 | Уведомления о приоритетных заказах | TBD |

---

**End of spec v1.0** — 2026-05-03
