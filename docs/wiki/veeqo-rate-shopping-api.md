# 🎯 Veeqo Rate Shopping API — НАСТОЯЩИЙ левер даты отгрузки (2026-06-12)

> **TL;DR:** Чтобы получить рейты с EDD, пересчитанными под конкретную дату
> отгрузки (как это делает веб-UI Veeqo, когда меняешь «Ship Date»), нужен
> **`POST /shipping/api/v1/rates`** с полем **`preferred_shipment_date`**.
> Старый `GET /shipping/rates/{allocation_id}` параметра даты НЕ имеет и всегда
> отдаёт один фиксированный набор EDD — поэтому Ship Date Trick через
> `PUT dispatch_date → re-quote` никогда по-настоящему не работал.

---

## История проблемы

Несколько недель Frozen Monday-shift «врал»: карточка показывала рейт
(напр. USPS Ground Advantage) с подписью «3 дня», хотя физически из
понедельника он вёз ~6 дней и привозил еду размороженной.

**Корень (диагностировано 2026-06-12):** механизм трюка делал
`PUT order.dispatch_date = понедельник` → `GET /shipping/rates/{alloc}` →
считал `calDays` от понедельника. Но:

1. `order.dispatch_date` для Amazon — это **«Ship by»** (дедлайн), read-only;
   PUT возвращает 200, но значение не меняется.
2. Главное: **старый `GET /shipping/rates` вообще не принимает дату.** EDD в
   его ответе — всегда оценка «если отгрузить сейчас». Сдвиг любого поля даты
   (проверено 8 способов: order/allocation × dispatch_date/preferred_shipment_date,
   + query-параметры `?ship_date`/`?dispatch_date`/`?date`) EDD НЕ менял.

Поэтому `selectBestRate(mondayRates, shipDay=понедельник)` мерил
**пятничный** EDD от понедельника → заниженный транзит → мусорный выбор.

Память `project_veeqo_rates_fixed_by_date` (старое расследование) тоже это
зафиксировала — но вывод «Veeqo не умеет котировать по дате» был **неверен**:
не умеет старый эндпоинт, новый умеет.

---

## Решение: новый Rate Shopping API

Официальная дока: <https://developers.veeqo.com/rate-shopping-api/operations/get-rates/>

```
POST https://api.veeqo.com/shipping/api/v1/rates
Headers: x-api-key: <ключ>   Content-Type: application/json
```

> ⚠️ В `MASTER_PROMPT_v3.1 §12` `POST /shipping/api/v1/*` помечен «УСТАРЕВШИЙ».
> Это **ОШИБКА** в спеке — `/shipping/api/v1/rates` это ТЕКУЩИЙ Rate Shopping
> API. Из-за этой пометки к нему годами не притрагивались.

### Тело запроса (рабочее, проверено живьём)

```jsonc
{
  "to_address":   { "name", "phone", "line1", "line2?", "town", "postcode", "country_code": "US", "county": "<state>" },
  "from_address": { "name", "phone", "line1", "town", "postcode", "country_code": "US", "county": "<state>" },
  "parcels": [ { "weight": 160, "weight_unit": "oz", "length": 10, "width": 8, "height": 8, "dimension_unit": "in" } ],
  "customer_reference": "113-3947294-3827449",   // Amazon order number (обязателен при is_amazon_order)
  "is_amazon_order": true,
  "due_date": "2026-06-23T06:59:59.000Z",        // order.due_date — даёт meets_delivery_promise
  "preferred_shipment_date": "2026-06-15T16:00:00Z", // ← ЭТО двигает EDD
  "channel_items": [ { "remote_id": "161992288639721", "quantity": 1 } ], // remote_id = Amazon OrderItemId (line_item.remote_id)
  "include_unavailable_quotes": false
}
```

**Откуда брать поля** (всё в объекте заказа из `/orders`):
- `to_address` ← `order.deliver_to` (first_name+last_name, address1, city, zip, country, state→county).
- `from_address` ← `order.allocations[0].warehouse` — поля: `address_line_1`, `city`,
  **`post_code`** (не `zip`!), `region` (= state), `country`.
- `parcels` ← `allocation.total_weight`(oz) + `allocation.allocation_package`
  (`depth`=length, `width`, `height`).
- `channel_items[].remote_id` ← `order.line_items[].remote_id` (Amazon OrderItemId).
- `customer_reference` ← `order.number`. `due_date` ← `order.due_date`.

### Ответ (поля ОТЛИЧАЮТСЯ от старого эндпоинта!)

```jsonc
{ "quotes": [ {
  "rate_id": "amazon_shipping_v2-caa202f7-...",  // = старый `name`, уникален per-rate, нужен для покупки
  "service_name": "UPS® Ground",                  // = старый `title`
  "carrier_id": "UPS",                            // = старый `sub_carrier_id`
  "service_carrier": "ups",
  "delivery_estimate": "2026-06-19T07:59:59+01:00", // = старый `delivery_promise_date` (EDD)
  "total_charge": "15.78",                         // = старый `total_net_charge`
  "base_rate": "15.78",
  "shipping_service_options": [ /* VAS — та же форма, см. veeqo-api-quirks §7 */ ]
} ] }
```

| Смысл | Старый GET | Новый POST v1 |
|---|---|---|
| EDD | `delivery_promise_date` | **`delivery_estimate`** |
| Цена | `total_net_charge` | **`total_charge`** |
| Название сервиса | `title` | **`service_name`** |
| Перевозчик | `sub_carrier_id` | **`carrier_id`** |
| Уникальный id рейта (для покупки) | `name` | **`rate_id`** |
| VAS | `shipping_service_options` | `shipping_service_options` (та же форма) |

EDD конвертируем в Pacific через `veeqoDateToLocal` (как и раньше) — совпадает
с тем, что показывает веб-UI.

---

## Доказательство (живой прогон 2026-06-12, заказ 113-3947294-3827449)

Сверка нашего POST-вызова со скриншотами веб-UI Владимира — **точное совпадение**:

| Сервис | `preferred_shipment_date` = Today (6/12) | = Mon 6/15 |
|---|---|---|
| UPS Ground | EDD **6/18** (веб: Thu Jun 18 ✅) | EDD **6/19** (веб: Fri Jun 19 ✅) |
| FedEx 2Day One Rate | EDD **6/16** (веб: Tue Jun 16 ✅) | EDD **6/17** (веб: Wed Jun 17 ✅) |
| USPS Ground Adv (1-70) | EDD 6/20 | EDD 6/23 |

EDD реально двигаются по дате. Диагностический скрипт-образец:
`ss-control-center/scripts/diag-rate-shopping-v1.ts` (read-only, POST /rates —
это quote, не мутация).

---

## Что это значит для Ship Date Trick

Трюк теперь делается ЧЕСТНО, без мутации заказа:
1. Quote `preferred_shipment_date = сегодня` → лучший годный Frozen-рейт «на сегодня».
2. Quote `preferred_shipment_date = след. понедельник` → лучший годный «из понедельника».
3. `labelDate` = сегодня (Amazon доволен), `physicalShipDate` = выбранный день.

Больше **не нужно**: `PUT dispatch_date` туда-обратно, паузы 800мс, восстановление
в finally. Старый `GET /shipping/rates` для Frozen-выбора заменяется на POST v1.

**Статус:** левер найден и подтверждён 2026-06-12. Внедрение в `plan/route.ts` +
покупка (Book Shipment нового API) — отдельная задача, см. SESSION-HANDOFF.

---

## Связанные
- `MASTER_PROMPT_v3.4 §5/§7` — логика выбора Frozen-рейта + трюк (механизм там описан через старый PUT — **устарел**, см. этот док).
- `ship-date-trick.md` — старое описание трюка (механизм устарел).
- `veeqo-api-quirks.md §7` — VAS из `shipping_service_options`.
- `veeqo-api-quirks.md §13` — `rate_id`/`name` уникален per-rate, `remote_shipment_id` — нет.
- Память: `project_veeqo_rates_fixed_by_date` (нужно ОБНОВИТЬ — вывод был неверен).
