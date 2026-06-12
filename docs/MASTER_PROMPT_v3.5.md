# 📦 Логика покупки Shipping Labels (MASTER PROMPT v3.5)

*Источник: Notion (Джеки) + голосовые уточнения Владимира.*
*v3.5 (2026-06-12): Frozen-логика **радикально упрощена** по прямому указанию Владимира + найден настоящий
левер даты (новый Veeqo Rate Shopping API). Разделы 0-4, 6, 8-11 без изменений — см. v3.4.*

> **Этот файл переопределяет §5 (выбор Frozen-рейта), §7 (Ship Date Trick) и §12 (Veeqo API) из v3.4.**
> Остальные разделы (TZ, две даты §0.1, классификация Frozen/Dry, вес/коробка, бюджет, сохранение PDF,
> стоп-условия) берутся из [MASTER_PROMPT_v3.4.md](MASTER_PROMPT_v3.4.md) без изменений.

---

## Что изменилось v3.4 → v3.5 (КРАТКО)

1. **Frozen-выбор рейта сведён к 2 условиям + 1 правилу цены.** Убраны все наслоения прошлых сессий:
   исключения Ground Saver / Ground Economy / SurePost / SmartPost, запрет FedEx Express в пятницу,
   процентная tolerance-полоса 5%. Владимир (2026-06-12): *«У нас только два параметра — чтобы
   удовлетворяло дедлайн и чтобы удовлетворяло frozen-окно. Всё.»*
2. **Найден настоящий механизм пересчёта EDD по дате отгрузки** — новый `POST /shipping/api/v1/rates`
   с `preferred_shipment_date`. Старый `GET /shipping/rates/{alloc}` даты не принимал, поэтому
   Ship Date Trick годами «врал». См. [wiki/veeqo-rate-shopping-api.md](wiki/veeqo-rate-shopping-api.md).
3. **Ship Date Trick переписан** на честное сравнение «сегодня vs понедельник» через реальные EDD.

---

## §5. 🚚 ВЫБОР ПЕРЕВОЗЧИКА И СЕРВИСА (переопределяет v3.4 §5)

> Rate calculation использует `physicalShipDate`. EDD и валидация — от `physicalShipDate`, через
> **новый Rate Shopping API** (`preferred_shipment_date = physicalShipDate`).

### DRY — без изменений
Самый дешёвый рейт где **EDD ≤ Delivery By**. Нет → need_attention `no_service`. (Детали v3.4 §5.)

### FROZEN (только Amazon) — НОВАЯ упрощённая логика

**Рейт ГОДЕН, если выполняются РОВНО ДВА условия:**

| # | Условие |
|---|---------|
| 1 | **EDD (delivery_estimate) ≤ дедлайн маркетплейса** (`order.due_date`) |
| 2 | **Frozen-окно:** `calDays(EDD − physicalShipDate) ≤ N`, где **N = 2 или 3** в зависимости от температуры в городе доставки (FrozenRiskAlert: `high`/`critical` → 2, иначе → 3 — отдельная логика, v3.4 §5) |

Больше **никаких** условий. Никаких исключений по перевозчикам, никаких запретов по дню недели.

**Выбор среди годных рейтов:**

1. База — **самый дешёвый** годный рейт.
2. **Доплата за скорость (абсолют, НЕ процент):** если есть годный рейт, который доставляет **быстрее**
   (меньше `calDays`), и он дороже самого дешёвого **не более чем на `FROZEN_SPEED_TOLERANCE_USD` = $3** —
   берём **быстрый**.
   - Считаем band = `минимальная_цена + $3`. Среди рейтов в band берём **наименьший calDays**, при равенстве — дешевле.
   - **Почему абсолют:** $3 на $13-рейте = 23% (по проценту «много»), но в долларах — копейки за день
     раньше → берём. А на $32-рейте те же 25% = +$8 — это уже дорого, не берём. Поэтому порог в **долларах**.
     (Владимир 2026-06-12.)

Эта логика применяется **ко всем Frozen-заказам, в любой день недели**.

---

## §7. 📅 SHIP DATE TRICK — переопределяет v3.4 §7

### Механизм (НОВЫЙ — честный)

`labelDate` = сегодня (что видит Amazon). `physicalShipDate` = день фактической отгрузки, который мы
подставляем в `preferred_shipment_date` запроса рейтов. EDD реально пересчитываются под эту дату.

### Алгоритм (для каждого Frozen-заказа, любой день)

```
1. bestToday  = лучший ГОДНЫЙ рейт при preferred_shipment_date = сегодня      (§5)
2. bestMonday = лучший ГОДНЫЙ рейт при preferred_shipment_date = след. понедельник (§5)
   (каждый — со своими двумя условиями: EDD ≤ дедлайн И calDays ≤ окно от СВОЕГО дня отгрузки)

3. Выбор дня отгрузки:
   - нет bestToday, есть bestMonday            → physicalShipDate = понедельник, rate = bestMonday
   - есть оба, и priceMonday < priceToday×0.85 → physicalShipDate = понедельник, rate = bestMonday  (>15% дешевле)
   - иначе                                     → physicalShipDate = сегодня,     rate = bestToday
   - нет ни того ни другого                    → need_attention: no_service

4. labelDate ВСЕГДА = сегодня (этикетка сегодняшним числом, физически отгружаем в выбранный день).
```

> **15% — порог выгоды понедельника.** Сдвигаем отгрузку на понедельник, только если это даёт
> существенную экономию (>15% от цены «сегодня»). Иначе не тянем — отгружаем сегодня.
> `MONDAY_SHIFT_MIN_SAVING_PCT = 0.15`.

### Чего БОЛЬШЕ НЕТ (удалено из старого механизма)
- ❌ `PUT order.dispatch_date = понедельник → re-quote → restore` — старый эндпоинт даты не принимал,
  это была no-op-мутация заказа. Новый API даёт EDD по дате напрямую, мутация не нужна.
- ❌ Триггеры «Saturday surcharge» / «calDays>=3» / «пятничный overnight» — заменены на чистое
  сравнение цен bestToday vs bestMonday.

---

## §12. 🔌 VEEQO API — переопределяет v3.4 §12 (rates)

**Рейты для Frozen теперь берём через НОВЫЙ Rate Shopping API:**

```
POST https://api.veeqo.com/shipping/api/v1/rates
  body: { to_address, from_address, parcels, customer_reference (order#),
          is_amazon_order: true, due_date, preferred_shipment_date, channel_items }
  ответ: quotes[].{ rate_id, service_name, carrier_id, service_carrier,
                    delivery_estimate (EDD), total_charge (цена), shipping_service_options (VAS) }
```

Полная схема запроса, откуда брать каждое поле, и карта старых↔новых имён —
[wiki/veeqo-rate-shopping-api.md](wiki/veeqo-rate-shopping-api.md).

> ⚠️ v3.4 §12 и v3.1 §12 помечали `POST /shipping/api/v1/*` как «устаревший» — **это ошибка**.
> Это текущий официальный Rate Shopping API. Старый `GET /shipping/rates/{alloc}` остаётся для Dry
> и как fallback, но **даты он не пересчитывает**.

Покупка этикетки (Book Shipment нового API vs старый `POST /shipping/shipments`) — см. реализацию;
`rate_id` нового quote имеет тот же формат `amazon_shipping_v2-<uuid>`, что и старый `name`.

---

## 🧩 ИТОГОВАЯ FROZEN-ЛОГИКА (v3.5, сухой остаток)

```
Для каждого Frozen Amazon-заказа (любой день):
  bestToday  = cheapest valid @ today      // valid = EDD≤дедлайн И calDays≤окно(2/3)
  bestMonday = cheapest valid @ next Monday //   среди valid: +$3 абсолют за день быстрее
  if  !bestToday && bestMonday              → ship Monday
  elif bestToday && bestMonday && monday<today*0.85 → ship Monday   // >15% дешевле
  elif bestToday                            → ship today
  else                                      → no_service
  labelDate = today всегда
```

*Версия: v3.5 — 2026-06-12. Автор изменений: Владимир (голосовая спецификация) + Claude (реализация).*

**Изменения v3.4 → v3.5:**
- 🔁 Frozen-выбор: только 2 условия (дедлайн + окно) + $3-абсолют за скорость. Убраны carrier-исключения,
  пятничный FedEx-запрет, 5% процентная полоса.
- 🆕 Реальный левер даты: `POST /shipping/api/v1/rates` + `preferred_shipment_date`.
- 🔁 Ship Date Trick: честное сравнение сегодня/понедельник, порог выгоды 15%, без PUT-мутаций.
