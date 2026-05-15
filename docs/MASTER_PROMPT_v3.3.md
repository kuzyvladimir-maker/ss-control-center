# 📦 Логика покупки Shipping Labels (MASTER PROMPT v3.3)

*Источник: Notion (Джеки) + голосовые уточнения Владимира — 2026-04-05*
*v3.3 (2026-05-14): per-order модель двух дат (labelDate / physicalShipDate). Cutoff применяется только когда есть запас по Ship by. Ship Date Trick переписан в новых терминах.*

---

## 🎯 ОБЩАЯ ЗАДАЧА АГЕНТА

Jackie автоматически покупает shipping labels в Veeqo для заказов Amazon и Walmart.

Каждый день (утром и вечером в будни) агент:
1. Получает список заказов `awaiting_fulfillment`
2. Анализирует каждый заказ (определяет `labelDate` и `physicalShipDate` — см. §0.1)
3. Создаёт план покупки
4. Ждёт одобрения Владимира
5. Покупает этикетки строго по плану (через Ship Date Trick если нужно)
6. Сохраняет PDF в Google Drive

---

## 0. ⏰ TIMEZONE — ЖЕЛЕЗНОЕ ПРАВИЛО

**"Сегодня"** = текущая дата по **America/New_York**.

ВСЕ даты из Veeqo API конвертировать в **UTC-7** (Pacific Time):
- `dispatch_date` → UTC-7 → реальный **Ship by**
- `due_date` → UTC-7 → реальный **Deliver by**
- `delivery_promise_date` → UTC-7 → **EDD** из рейта

---

## 0.1. 🕒 ДВЕ ДАТЫ НА КАЖДЫЙ ЗАКАЗ *(v3.3 — концептуальный апдейт)*

> 🆕 **Это правило в v3.3 переписано полностью.** v3.2 использовала **глобальную** `effectiveShipDate`, что ломало случаи когда Ship by = today (статистика Amazon портилась если работа после cutoff). Новая модель — **per-order две даты**.

### Концепция

Каждый заказ имеет **две даты**:

1. **`labelDate`** — дата на этикетке (что видит Amazon).
   - Влияет на Amazon Late Shipment Rate.
   - В большинстве случаев = today (минимизировать риск штрафа).
   - Записывается в Veeqo через `dispatch_date` перед `POST /shipping/shipments`.

2. **`physicalShipDate`** — когда фактически передаём перевозчику.
   - Влияет на выбор carrier/rate (EDD считается от этой даты).
   - Влияет на имя папки в Google Drive и на дату в employee note.
   - Может **отличаться** от labelDate (Ship Date Trick).

### Бизнес-обоснование

Amazon следит за **датой на этикетке**, не за фактической физической отгрузкой. Можно купить этикетку «вчерашним» числом и физически отдать перевозчику завтра — Amazon не пожалуется. Это используем чтобы:

- Спасать статистику для заказов с Ship by = today (даже если работаешь вечером после 15:00)
- Обходить ограничения Frozen (≤3 кал. дня EDD): этикетку купить today, физическую отгрузку отложить до понедельника

### Алгоритм определения `labelDate`

```
для каждого order:
  shipBy = order.dispatch_date (Amazon Ship by) в локальной TZ
  
  if shipBy < today:
    labelDate = today      # overdue — минимизировать урон
  elif shipBy == today:
    labelDate = today      # дедлайн сегодня — нет выбора
  elif shipBy == tomorrow:
    labelDate = today if now < 15:00 ET else tomorrow
  else:  # shipBy ≥ +2 дня
    labelDate = today if now < 15:00 ET else nextBusinessDay(today)
```

**Cutoff 15:00 ET применяется только когда `shipBy > today`** (есть запас). Для `shipBy = today` алгоритм всегда ставит labelDate = today, чтобы не сломать Amazon-статистику.

### Алгоритм определения `physicalShipDate`

```
candidate = labelDate

if isFrozen and isAmazon:
  # Можно ли отгрузить в candidate с рейтом ≤3 кал. дня EDD ≤ Delivery by?
  rates = getRates(physicalDate=candidate)
  best = selectFrozenRate(rates, candidate, deliverBy)
  
  if best found:
    physicalShipDate = candidate
  else:
    # Ship Date Trick — см. §7
    monday = nextMondayFrom(candidate)
    rates = getRates(physicalDate=monday)
    best = selectFrozenRate(rates, monday, deliverBy)
    
    if best found:
      physicalShipDate = monday
      # При покупке в Veeqo: PUT dispatch_date=labelDate (вернуть на labelDate),
      # rate уже зафиксирован для monday
    else:
      need_attention: 'no_service' — нет даже с пн
else:
  # Dry, или Walmart (всегда Dry)
  physicalShipDate = candidate
  best = selectDryRate(rates)
```

### `isBusinessDay` и `nextBusinessDay`

`isBusinessDay(date)` = понедельник-пятница И НЕ US federal holiday.

US federal holidays через npm `date-holidays` (`new Holidays('US')`).

`nextBusinessDay(date)` = добавлять день пока не business day.

### Примеры (четверг 14 мая 2026, 21:12 ET)

| Заказ | Ship by | Frozen? | labelDate | physicalShipDate | Комментарий |
|-------|---------|---------|-----------|------------------|-------------|
| A | 5/14 (Thu) | Frozen | **Thu 5/14** | **Thu 5/14** | EDD ≤ 5/17 есть → обычный кейс |
| B | 5/14 (Thu) | Frozen | **Thu 5/14** | **Mon 5/18** | EDD ≤ 5/17 НЕТ → Ship Date Trick |
| C | 5/16 (Sat) | Frozen | **Fri 5/15** | **Mon 5/18** | Есть запас → cutoff сдвинул на пт, Frozen rule → пн |
| D | 5/14 (Thu) | Dry | **Thu 5/14** | **Thu 5/14** | Обычный |
| E | 5/16 (Sat) | Dry | **Fri 5/15** | **Fri 5/15** | Cutoff применяется |
| F | 5/13 (Wed, прошедшая) | Frozen | **Thu 5/14** | **Thu 5/14** или **Mon 5/18** | Overdue! Warning в UI |

### UI-индикация на странице `/shipping`

На каждой карточке заказа сверху:
```
Order #001-...  Ship by: Thu 5/14  →  Label: Thu 5/14  •  Physical: Mon 5/18 (Ship Date Trick)
```

С цветовой подсветкой:
- 🟢 labelDate == physicalShipDate (обычный кейс)
- 🟡 labelDate ≠ physicalShipDate (Ship Date Trick применён — Vladimir должен видеть и подтвердить)
- 🔴 Overdue (Ship by < today)

### Editable Ship Date в UI (как в Veeqo)

Дополнительно к computed значениям — каждая карточка имеет дропдауны:
- `labelDate` selector — Today / Tomorrow / Custom date
- `physicalShipDate` selector — Today / Tomorrow / Monday / Custom date

Дефолты — computed по алгоритму выше. Vladimir может вручную переопределить (например в edge cases). После override — пересчитываются rate и budget validation.

---

## 1. 📋 КАКИЕ ЗАКАЗЫ ОБРАБАТЫВАТЬ

Обрабатывать только если **ВСЕ три условия**:
- ✅ Статус = `awaiting_fulfillment`
- ✅ Ship By (`dispatch_date`) **попадает в окно**: overdue + today + tomorrow + dayafter — то есть всё что может быть актуально для сегодняшней покупки (см. также time bucket фильтр в UI)
- ✅ Тег **"Placed"** стоит на заказе

Если тега "Placed" нет → **пропустить молча**.

> **ПОЧЕМУ тег Placed:** Vladimir сначала закупает у поставщика, ставит тег. Без тега товара физически нет.

**ПАГИНАЦИЯ:** `page_size=100`, перебирать пока не пустой массив.

---

## 2. 🛒 ТОЛЬКО AMAZON И WALMART

eBay, TikTok, Website — **пропускать**.

---

## 3. ❄️ ОПРЕДЕЛЕНИЕ ТИПА ТОВАРА (Frozen / Dry)

### Правило по каналу

| Канал | Frozen возможен? |
|-------|-----------------|
| Amazon | Да |
| Walmart | **Нет — всегда Dry** |

### Источник данных (порядок приоритета)

1. **`ProductTypeOverride`** (наша БД) — manual или confirmed AI
2. **Тег в Veeqo** на продукте
3. **Нет** → на UI: кнопки «Classify with AI» / «Set manually». В n8n-историческом флоу: STOP + employee note.

### Mixed-заказы
Frozen + Dry в одном заказе → STOP + note.

---

## 4. 📦 ВЕС И РАЗМЕР КОРОБКИ

### Источник

> С 2026-05-12 SKU данные в БД (`SkuShippingData`). См. [`sku-database-migration.md`](wiki/sku-database-migration.md).

### Шаг 1 — Single item, qty = 1 → таблица `SkuShippingData`

| Carrier / Service | Поле |
|---------|---------|
| UPS, USPS, FedEx без One Rate | `weight` |
| FedEx ONE RATE | `weightFedex` |

### Шаг 2 — Multi-item / qty > 1 → таблица `PackingProfile`

Сигнатура `SKU1:QTY1|SKU2:QTY2|...` (отсортирована по SKU). Self-learning — Vladimir вводит вручную первый раз, дальше алгоритм использует автоматически.

### Шаг 3 — Нет в БД и нет в истории Veeqo

→ STOP + need_attention `no_sku` (на UI Vladimir добавит через popup).

### Размеры коробок

| Название | Dimensions |
|----------|-----------|
| XL | 24×13×16 |
| L | 18×13×14 |
| M | 13×13×15 |
| S | 12×12×10 |
| XS | 11×6×8 |
| 12-12-8 | 12×12×8 |
| 12*12*6 | 12×12×6 |
| 7-7-6 | 7×7×6 |
| 7-5-14 | 7×5×14 |
| xxxs | 8×5×2 |

> Для **Frozen** допустимы только: XS, S, M, L, XL

---

## 5. 🚚 ВЫБОР ПЕРЕВОЗЧИКА И СЕРВИСА

> Rate calculation использует `physicalShipDate` (когда отгружаем). EDD validation тоже от `physicalShipDate`.

### DRY

1. Самый дешёвый рейт где **EDD ≤ Delivery By**
2. Нет — need_attention `no_service`
3. ≤10% разница → UPS > FedEx > USPS
4. После ~12:00 ET → избегать USPS
5. ≤$0.50 разница → более ранний EDD

### FROZEN (только Amazon)

EDD ≤ **3 кал. дня от `physicalShipDate`** И ≤ Amazon Delivery By.

| Дней | Статус |
|------|--------|
| 1–2 | Идеально |
| 3 | Допустимо |
| 4 | Только с явного согласия Vladimir + `+` в имени файла |
| 5+ | АБСОЛЮТНЫЙ ЗАПРЕТ |

При близкой цене — приоритет более раннему EDD.

---

## 6. 💰 БЮДЖЕТ

### Абсолютный лимит 50%
`max_absolute = 0.50 × (order_total + shipping_charged)`

### Формулы

| Канал / Тип | Формула |
|-------------|---------|
| Walmart Dry | `max(10% × (total − ship) + ship, $10)` |
| Amazon Dry | `max(15% × (total − ship) + ship, $10)` |
| Amazon Frozen | `max(15% × (total − ship) + ship, $15)` |

Если `Shipping Charged = $0` — `Max = max(15% × total, $10/$15)`.

Превышен → need_attention `budget`.

---

## 7. 📅 SHIP DATE TRICK — ОСНОВНОЙ МЕХАНИЗМ ДЛЯ FROZEN

> *В v3.3 переписано в терминах `labelDate` / `physicalShipDate`.*

### Концепция

Когда физическая отгрузка в `labelDate` невозможна по Frozen-правилам (EDD > 3 кал. дня) — **сдвигаем `physicalShipDate` на ближайший понедельник**, но **`labelDate` оставляем today** чтобы спасти Amazon-статистику.

### Алгоритм

```
1. candidate = labelDate (определён в §0.1)
2. rates = Veeqo /shipping/rates (с dispatch_date = candidate)
3. best = selectFrozenRate(rates, candidate, deliverBy)
4. Если best найден:
     physicalShipDate = candidate
     rate = best
     Продолжаем к §6 (бюджет) и §10 (покупка)
5. Если best НЕ найден:
     monday = ближайший понедельник от candidate (либо след. business day если в monday holiday)
     PUT /orders/{id} с dispatch_date = monday
     rates = getRates() — теперь от monday
     best = selectFrozenRate(rates, monday, deliverBy)
     Если best найден:
       physicalShipDate = monday
       rate = best
       PUT /orders/{id} с dispatch_date = labelDate (вернуть!)
       POST /shipping/shipments — этикетка с labelDate, rate для monday
     Иначе:
       need_attention: 'no_service'
       (Vladimir эскалирует вручную)
```

### Конкретные кейсы по дням недели

> День недели = day-of-week от `physicalShipDate`.

**Понедельник / Вторник / Среда (physical):**
Покупаем как обычно. EDD от physical + 3 кал. дня.

> Среда особенная: ground даёт пн (5 кал. дней) → не годится. Нужны express тарифы или Sat delivery.

**Четверг (physical):**
- Есть Sat delivery в бюджет → physicalShipDate=Thu ✅
- Нет → Ship Date Trick на Monday → physicalShipDate=Mon
- labelDate всегда = today (по правилам §0.1)

**Пятница (physical):**
- EDD ≤ Sat/Sun/Mon в бюджет → physicalShipDate=Fri ✅
- Нет → Ship Date Trick на Monday → physicalShipDate=Mon
- FedEx Express в пятницу для Frozen — НИКОГДА

**Сб / Вс (physical):**
По §0.1 `nextBusinessDay()` автоматически пропускает выходные — physicalShipDate никогда не равен Сб/Вс в новой модели.

### Walmart в weekend

В Walmart покупка этикетки = Veeqo шлёт Mark as Shipped в маркетплейс. **НЕ покупать Walmart этикетки в выходные** — статистика Walmart сломается. По §0.1 это автоматически: если today = Sat/Sun, `labelDate = nextBusinessDay()` = Mon. Для Walmart мы всегда покупаем только в день фактической отгрузки.

---

## 8. ☁️ СОХРАНЕНИЕ PDF (Google Drive)

```
Shipping Labels/
    MM Month/           (берётся от physicalShipDate)
        DD/             (день physicalShipDate, не labelDate!)
            Amazon/
                (EDD May 18 | DL May 20) Product Name -- Qty.pdf
                Printed/
```

> Имя папки = `physicalShipDate`, **не** `labelDate`. Это критично для Ship Date Trick: этикетка с labelDate=Thu, но папка = Mon (когда физически отгрузим).

---

## 9. 🏷️ ИМЯ ФАЙЛА PDF

```
(EDD Mmm DD | DL Mmm DD) Product Title -- Quantity.pdf
```

EDD и DL — из rate, конвертированы UTC-7.
EDD рассчитан от `physicalShipDate`.

---

## 10. ✅ ПОСЛЕ ПОКУПКИ

1. Сохранить PDF в Drive (структура §8 — папка = physicalShipDate)
2. Employee note на заказ:
```
✅ Label Purchased: UPS Ground Saver $9.09 | Tracking: 1Z999... | Ship date on label: 2026-05-14 | Physical: 2026-05-18
```

При обычном кейсе (labelDate == physicalShipDate) — только одна дата в ноте.
При Ship Date Trick — обе даты явно указаны.

---

## 11. 🚨 СТОП-CONDITIONS

| Проблема | Reason | Employee Note |
|----------|--------|---------------|
| Нет типа Frozen/Dry | `no_type` | `⚠️ Нужна информация: не проставлен тег Frozen/Dry` |
| Mixed Frozen+Dry | `mixed_order` | `⚠️ Mixed order: Frozen и Dry в одном` |
| Frozen на Walmart | `frozen_walmart` | `⚠️ Ошибка: Frozen на Walmart-заказе` |
| Нет SKU в БД и истории | `no_sku` | `⚠️ Нужна информация: нет данных по SKU [XXX]` |
| Multi-item без profile | `no_packing` | `⚠️ Нужна информация: задай PackingProfile` |
| Превышен бюджет | `budget` | `⚠️ На ревью: бюджет превышен` |
| Превышен 50% лимит | `budget_50` | `⚠️ На ревью: >50% от суммы заказа` |
| Нет рейта (даже с пн) | `no_service` | `⚠️ Нужна информация: нет сервиса в бюджете/дедлайне` |
| Overdue (Ship by < today) | `overdue` | UI warning, статистика уже задета |

---

## 12. 🔌 VEEQO API — КЛЮЧЕВЫЕ ЭНДПОИНТЫ

> ⚠️ **VAS поле:** USPS Ground Advantage требует `DELIVERY_CONFIRMATION`. Не хардкодить — читать `rate.shipping_service_options[]` из ответа `/shipping/rates`. См. [`veeqo-api-quirks.md §7`](wiki/veeqo-api-quirks.md).

**Auth:** `x-api-key: ...` (env var)
**Base URL:** `https://api.veeqo.com`

### Эндпоинты

```
GET  /orders?status=awaiting_fulfillment&page_size=100&page={n}
GET  /products/{product_id}   # для tags, image, description
PUT  /orders/{id}             # обновить dispatch_date (Ship Date Trick) / employee_notes
GET  /shipping/rates/{allocation_id}?from_allocation_package=true
POST /shipping/shipments      # купить этикетку
```

### Ship Date Trick — последовательность

```
1. originalDispatchDate = order.dispatch_date  (запомнить!)
2. PUT /orders/{id}  { order: { dispatch_date: monday } }
3. GET /shipping/rates/{allocation_id}  → rates от monday
4. selectFrozenRate(rates, monday, deliverBy) → best
5. PUT /orders/{id}  { order: { dispatch_date: labelDate } }  ← вернуть!
6. POST /shipping/shipments  с rate от шага 4
7. (Этикетка получает labelDate, rate был рассчитан для monday)
```

> ⚠️ Шаг 5 **обязателен**. Если забыть — Veeqo пометит заказ как «отгружен в понедельник», Amazon увидит позднюю отгрузку, статистика просядет.

### УСТАРЕВШИЕ

- ❌ `POST /shipping/api/v1/*`
- ❌ `POST /orders/{id}/tags`

---

## 13. ❌ ЧТО НИКОГДА НЕ ДЕЛАТЬ

- ❌ Использовать `physicalShipDate` для записи в `dispatch_date` Veeqo на момент покупки (используется только для расчёта rate; в Veeqo записывается `labelDate`)
- ❌ Применять cutoff к заказам с Ship by = today (это сломает статистику Amazon)
- ❌ Забыть вернуть `dispatch_date` после Ship Date Trick перед `POST /shipping/shipments`
- ❌ Использовать `labelDate` для имени папки в Drive (нужен `physicalShipDate`)
- ❌ Угадывать тип товара, вес, размер
- ❌ Покупать Walmart этикетки в weekend
- ❌ Продавать/отправлять Frozen через Walmart
- ❌ Брать FedEx Express в пятницу (Frozen)
- ❌ Игнорировать бюджет или 50% лимит
- ❌ Использовать устаревшие `/api/v1/*`
- ❌ Ставить теги на заказы (не работает — только employee notes)

---

## 🧩 ИТОГОВАЯ ЛОГИКА (v3.3)

```
Заказ получен (awaiting_fulfillment)
    ↓
Тег "Placed"? → Нет → ПРОПУСТИТЬ молча
    ↓
Amazon или Walmart? → Нет → ПРОПУСТИТЬ
    ↓
Определить labelDate (§0.1):
  - shipBy < today      → today (overdue)
  - shipBy == today     → today
  - shipBy == tomorrow  → today if now<15:00 else tomorrow
  - shipBy ≥ +2 дня     → today if now<15:00 else nextBusinessDay
    ↓
Классификация: Frozen / Dry (ProductTypeOverride → Veeqo tag → AI/manual)
    ↓
Упаковка: SkuShippingData (single) / PackingProfile (multi)
    ↓
Определить physicalShipDate:
  - Dry → physicalShipDate = labelDate, выбрать Dry rate
  - Frozen → попытка labelDate, если нет рейта → Ship Date Trick → Monday
    ↓
Бюджет (§6) — если превышен → need_attention
    ↓
План готов → Vladimir подтверждает → Покупка:
  - Если labelDate ≠ physicalShipDate → Ship Date Trick (PUT dispatch=monday, get rates, PUT dispatch=labelDate, BUY)
  - Иначе обычная покупка
    ↓
PDF в Drive (папка = physicalShipDate) → Employee note (обе даты если различаются)
```

---

*Версия: v3.3 — 2026-05-14*

**Изменения v3.2 → v3.3 (одного дня hotfix):**
- 🆕 Концепция двух дат на заказ: `labelDate` (для этикетки/Amazon) и `physicalShipDate` (для физ. отгрузки/rate)
- 🆕 Cutoff применяется только когда `shipBy > today` (есть запас); для `shipBy = today` всегда labelDate=today чтобы спасти статистику
- 🆕 Ship Date Trick переписан в новых терминах — labelDate=today, physicalShipDate=monday
- 🆕 §10 employee note: обе даты явно если различаются
- 🆕 §13 «никогда»: новые пункты про порядок Ship Date Trick

**Изменения v3.1 → v3.2 (исторические):**
- Введён глобальный cutoff 15:00 ET (заменён в v3.3 на per-order)
- Учёт US Federal Holidays через `date-holidays`
- Приоритет источников типа: `ProductTypeOverride` → Veeqo tag → AI/manual
- `PackingProfile` для multi-item

**Изменения v3.0 → v3.1 (исторические):**
- Убрана формула ice weight (80%)
- Walmart weekend: запрет покупки
- Frozen на Walmart = ошибка

**Комплект документов (актуально на 2026-05-14):**
1. `MASTER_PROMPT_v3.3.md` — этот файл (АКТУАЛЬНЫЙ)
2. `MASTER_PROMPT_v3.2.md`, `v3.1.md` — история
3. `CLAUDE_CODE_PROMPT_SHIPPING_LABELS_PAGE_V1.md` — реализация UI `/shipping`
4. `wiki/sku-database-migration.md` — справочник SKU в БД
5. `wiki/shipping-labels-page-v1.md` — спека страницы
6. `wiki/cutoff-time-rule.md` — детали §0.1 (per-order)
7. `wiki/ship-date-trick.md` — детали §7
