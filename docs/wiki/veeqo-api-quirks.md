# Veeqo API — quirks и подводные камни

Все, что мы узнали про Veeqo REST API на собственной шкуре. Документируется здесь, чтобы не наступать на грабли повторно.

База: `https://api.veeqo.com`. Аутентификация через заголовок `x-api-key`.

---

## 1. Order tags нельзя ставить через `PUT /orders/{id}` (2026-05-04)

**Проблема:** Vladimir пометил заказ `113-5805021-2730651` как "Купил всё" в нашей системе. В Veeqo тег `Placed` так и не появился, хотя `[PROCUREMENT]` блок в employee notes записался корректно.

**Что не работает (все возвращают 200, но молча игнорируют тег):**

```http
PUT /orders/{id}
{ "order": { "tags_attributes": [{ "name": "Placed" }] } }
{ "order": { "tags_attributes": [{ "name": "Placed", "colour": "blue" }] } }
{ "order": { "tags_attributes": [{ "id": 13274001 }] } }
{ "order": { "tag_list": ["Placed"] } }
{ "order": { "tag_list": "Placed" } }
{ "order": { "tags": [{ "name": "Placed" }] } }
{ "order": { "tags": ["Placed"] } }
{ "order": { "tags": [{ "id": 13274001 }] } }
{ "order": { "tag_ids": [13274001] } }
```

**Что не работает (404 Not Found):**

```http
POST  /orders/{id}/tags   (любые тела)
PUT   /orders/{id}/tags
```

**Что РАБОТАЕТ:**

```http
POST /bulk_tagging
{
  "order_ids": [1668694461],
  "tag_ids":   [13274001]
}
```

И симметричный для удаления:

```http
DELETE /bulk_tagging
{
  "order_ids": [1668694461],
  "tag_ids":   [13274001]
}
```

Возвращают пустой body (204), `res.json()` ломается с `Unexpected end of JSON input` — поэтому в [client.ts](../../ss-control-center/src/lib/veeqo/client.ts) `veeqoFetch` теперь толерантен к пустым ответам.

**Где задокументировано:** https://developers.veeqo.com/api/operations/untagging-orders/ (только DELETE explicitly показан, POST с тем же телом для tag-add нашли empirically).

**Гнусная деталь:** `GET /tags` возвращает у каждого тега `taggings_count: 0`, даже когда заказы реально ими помечены. Этот counter не работает / stale. Чтобы проверить что заказ реально с тегом — `GET /orders?tags=<name>` или `GET /orders/{id}` и смотреть поле `tags`.

**Файлы где эта правда теперь живёт:**
- [src/lib/veeqo/tags.ts](../../ss-control-center/src/lib/veeqo/tags.ts) — `bulkTagOrders`, `bulkUntagOrders`, `getTagId` с кэшем
- [src/lib/procurement/order-state-update.ts](../../ss-control-center/src/lib/procurement/order-state-update.ts) — Phases 4 и 5: notes отдельно, теги отдельно

---

## 2. Product tags РАБОТАЮТ через `PUT /products/{id}` с `tags_attributes`

В отличие от orders, для products Rails-style nested attributes работают:

```http
PUT /products/{id}
{ "product": { "tags_attributes": [{ "name": "Frozen", "colour": "blue" }] } }
```

Поэтому `setProductTag` в [client.ts](../../ss-control-center/src/lib/veeqo/client.ts) написан в этой форме и работает. Это и сбило с толку — мы скопировали паттерн на orders, и он молча перестал работать.

---

## 3. Employee notes можно добавлять через `tags_attributes` brother — `employee_notes_attributes`

Это работает:

```http
PUT /orders/{id}
{ "order": { "employee_notes_attributes": [{ "text": "Hello" }] } }
```

Notes append-only — каждый PUT добавляет новую запись в список employee_notes. Старые не перезаписываются. Парсер `[PROCUREMENT]` блока берёт **последний** найденный блок в склеенных notes.

---

## 4. Pagination

`GET /orders?status=awaiting_fulfillment&page_size=100&page=N` — стандартный.
- Max page_size: 100.
- Когда страница вернула < 100 — это последняя.
- В коде стоит safety cap 50 страниц (5000 заказов) на случай runaway loop.

---

## 5. Rate limiting

Эмпирически словили `Veeqo API error 429: ` (пустое тело) когда дёргали 14+ запросов подряд в одном Vercel function call. Решение: разбить тяжёлые отладочные операции на несколько вызовов, держать кэш для статических данных (теги, products) на time-of-process.

---

## 6. Order ID типы

В разных endpoints id возвращается то как `number` (`order.id = 1668694461`), то как `string` (`"1668694461"`). В нашем коде всегда нормализуем через `String(order.id)` для хранения и `Number(orderId)` когда отправляем в `bulk_tagging` (которому нужны числа в `order_ids`).

---

## 7. VAS (Value-Added-Services) — динамические, READ из рейта (2026-05-14)

**Проблема:** При покупке этикетки через `POST /shipping/shipments` Veeqo может вернуть `400 INVALID_VALUE_ADDED_SERVICES, errorMessage: "The requested value added services are invalid. Please check the value added services offered in the GetRates response."`.

**Корень:** [MASTER_PROMPT_v3.1 §12](../MASTER_PROMPT_v3.1.md) говорил жёстко слать `value_added_service__VAS_GROUP_ID_CONFIRMATION: "NO_CONFIRMATION"` для UPS/USPS. Это **устаревшая** информация — Veeqo обновил API:

| Carrier / Service | Что РЕАЛЬНО принимает |
|---|---|
| UPS (все services) | `NO_CONFIRMATION` (как было) |
| **USPS Ground Advantage** | **`DELIVERY_CONFIRMATION`** (NO_CONFIRMATION отвергается) |
| FedEx | VAS поле вообще не нужно (как было) |

**Где это лежит в Veeqo:** не в плоском поле рейта, а в массиве `rate.shipping_service_options`:

```json
{
  "carrier": "amazon_shipping_v2",
  "name": "USPS_PTP_GAH",
  "title": "USPS Ground Advantage (1 - 70 lb)",
  "sub_carrier_id": "USPS",
  ...
  "shipping_service_options": [
    {
      "key": "value_added_service__VAS_GROUP_ID_CONFIRMATION",
      "label": "Confirmation",
      "type": "select",
      "values": [
        {"value": "DELIVERY_CONFIRMATION", "label": "Delivery confirmation", "price": 0, "currency": "USD"}
      ]
    },
    {
      "key": "liability_amount",
      "label": "Insurance",
      "type": "number",
      "validation": {"min": 100, "max": 5000},
      "unit": "USD",
      "default": null
    }
  ]
}
```

**Правильный подход — НЕ хардкодить per-carrier**, а:
1. **Перед** каждой покупкой делать `GET /shipping/rates/{allocation_id}` (свежие рейты)
2. Найти rate по `remote_shipment_id` (то что выбрали при планировании)
3. Пройтись по `rate.shipping_service_options[]`
4. Для каждого entry с `key.startsWith("value_added_service__")` — взять `values[]`, выбрать значение (стратегия: `NO_*` если есть → иначе самый дешёвый)
5. Игнорировать non-VAS опции типа `liability_amount` (это не VAS, а отдельные insurance/etc.)

**Код:** [src/lib/veeqo/client.ts](../../ss-control-center/src/lib/veeqo/client.ts) — `extractVasFromRate()`, вызывается из [api/shipping/buy/route.ts](../../ss-control-center/src/app/api/shipping/buy/route.ts).

### 7.1 FedEx Ground Economy (SmartPost) — Veeqo bug, VAS требуется но не возвращается

**Проблема:** FedEx Ground Economy имеет `service_id = "FEDEX_PTP_SMARTPOST"`, и для этого рейта Veeqo возвращает `shipping_service_options: null`. Но при покупке без VAS — `400 INVALID_VALUE_ADDED_SERVICES`.

**Контекст:** SmartPost = FedEx передаёт пакет в USPS на последней миле. Всё остальные FedEx-сервисы (Home Delivery, Express Saver, 2Day) дают `NO_CONFIRMATION`. USPS-сервисы (Ground Advantage, Priority) дают только `DELIVERY_CONFIRMATION` (NO_CONFIRMATION у них вообще нет). Поскольку last-mile у SmartPost = USPS, поведение USPS-ное.

**Решение:** hardcode'ed fallback в [`extractVasFromRate`](../../ss-control-center/src/lib/veeqo/client.ts) — таблица `SERVICE_ID_VAS_FALLBACK` срабатывает когда rate-объект не дал ни одной VAS-опции:

```typescript
const SERVICE_ID_VAS_FALLBACK = {
  FEDEX_PTP_SMARTPOST: {
    value_added_service__VAS_GROUP_ID_CONFIRMATION: "DELIVERY_CONFIRMATION",
  },
};
```

Если в будущем другой сервис попадёт под этот же bug Veeqo — добавлять сюда.

**Как обнаружили:** буквально на следующий день после фикса USPS Ground Advantage — попытка купить FedEx Ground Economy для другого заказа выдала ту же ошибку, но DIAG показал `shipping_service_options: null`. Сравнили все 11 рейтов в одной allocation, и SmartPost оказался единственным с null'ом. Hardcoded values для остальных carriers получаются из самого рейта — fallback нужен только для SmartPost.

---

## 8. `tracking_number` может быть объектом, не строкой (2026-05-14)

**Проблема:** В employee note записалось `Tracking: [object Object]`. Причина — `String(shipment.tracking_number)` на JS-объекте даёт строку `"[object Object]"`.

**Что возвращает Veeqo:** в зависимости от carrier `tracking_number` может быть:
- Просто string: `"9334610990150179283949"` (USPS)
- Объект: `{value: "1Z...", carrier: "UPS"}` (FedEx Ground Economy, возможно другие)
- Лежит на nested поле: `shipment.shipment.tracking_number`

**Решение:** хелпер `pickTrackingString()` в [api/shipping/buy/route.ts](../../ss-control-center/src/app/api/shipping/buy/route.ts) — ходит по всем известным формам и достаёт строку:

```typescript
const candidates = [
  s.tracking_number,
  s.trackingNumber,
  s.shipment?.tracking_number,
  s.shipment?.trackingNumber,
];
// если значение объект — берёт obj.value || obj.number || obj.tracking_number
```

**Где наступили:** массовая покупка 2026-05-14, FedEx Ground Economy заказ показал `[object Object]` в модалке post-buy и в employee note Veeqo.

---

## 9. Buy endpoint возвращает 200 даже когда покупка провалилась (2026-05-14)

**Проблема:** Veeqo `POST /shipping/shipments` отдал 400 INVALID_VALUE_ADDED_SERVICES, но наш `/api/shipping/buy` возвращал HTTP 200 с непустым `results.errors[]`. Фронт смотрел только на `res.ok` и говорил "Bought!". Этикетки молча терялись.

**Решение:**
1. Фронт ([page.tsx#buyOne](../../ss-control-center/src/app/shipping/page.tsx)) теперь проверяет `buyJson.bought` и `buyJson.errors` после fetch — если ничего не купилось, throw'ит с реальным сообщением Veeqo.
2. **Post-buy modal** — обязательное окно после каждой покупки (одиночной или bulk), три счётчика: Bought / PDF saved / Failed, список покупок с трекингом, список ошибок с текстом. Закрывается явно.
3. **Audit-лог** `logs/shipping-buy.jsonl` — JSON line на каждый вызов /buy. Запасной канал на случай если модалку закроют слишком быстро.

---

## 10. Vercel serverless: `public/labels/...` writeFileSync эфемерный (2026-05-14)

**Проблема:** Код в `/api/shipping/buy` писал PDF в `process.cwd()/public/labels/...` через `writeFileSync`. На localhost работало, на Vercel — файл живёт ровно до конца HTTP-запроса, после возврата response container выкидывается. Модалка показывала `PDF saved 0/1` для каждой покупки.

**Решение:** трёхуровневая стратегия persistence в [api/shipping/buy/route.ts](../../ss-control-center/src/app/api/shipping/buy/route.ts):
1. **Google Drive** (preferred) — через service account, см. [google-drive-setup.md](google-drive-setup.md). Папочная структура `Shipping Labels/MM Month/DD/Channel/`.
2. **Local disk** (dev only) — на Vercel молча no-op'ит.
3. **Veeqo `label_url`** (fallback) — сохраняем URL из ответа покупки прямо в `ShippingPlanItem.labelPdfUrl`. Кнопка "Open PDF" в модалке открывает PDF у Veeqo. Работает всегда, даже без Drive.

---

---

## 11. `shipment.label_url` без `format=pdf` возвращает counter JSON, не PDF (2026-05-14)

**Проблема:** В ответе на покупку Veeqo даёт `shipment.label_url = "/shipping/labels?shipment_ids[]=1194231799"` (относительный путь). Наш код в `/api/shipping/buy` делал по нему `fetch(...)` и сохранял ответ как `.pdf`. На самом деле этот endpoint без параметра `format=pdf` возвращает:

```http
HTTP 200
Content-Type: application/json
{"labels_count": 1}
```

— то есть **счётчик**, не PDF. Это объясняет почему PDF-файлы никогда не сохранялись корректно даже когда disk-write/Drive были настроены: писали 18 байт JSON-а с расширением .pdf.

**Правильный endpoint:**

```http
GET /shipping/labels?shipment_ids[]=1194231799&format=pdf
Headers:
  x-api-key: <ключ>
  Accept: application/pdf
```

Возвращает реальный PDF (~60KB на одну этикетку). Также работает алиас `/shipping/labels.pdf?shipment_ids[]=X`.

**Ещё нюансы:**
- URL из `shipment.label_url` — **относительный**, надо prepend'ить `VEEQO_BASE_URL`.
- Endpoint **требует** `x-api-key` header. Линковать прямо из браузера нельзя.
- В нашем коде есть `/api/shipping/label-pdf?shipmentId=X` — серверный proxy. Запрашивает PDF у Veeqo с auth и стримит обратно браузеру. Это URL который сохраняется в `ShippingPlanItem.labelPdfUrl` как final fallback (когда Drive не настроен или upload провалился).

**Файлы:**
- [src/app/api/shipping/buy/route.ts](../../ss-control-center/src/app/api/shipping/buy/route.ts) — теперь делает `fetch` к `<base>/shipping/labels?...&format=pdf` с auth header
- [src/app/api/shipping/label-pdf/route.ts](../../ss-control-center/src/app/api/shipping/label-pdf/route.ts) — proxy для retrieval из браузера

**Как ловится в будущем:** если PDF получается <1KB или не начинается с `%PDF-` — это не PDF. Proxy endpoint валидирует это явно и отдаёт 502 вместо ложного PDF.

---

## 12. Отмена этикетки: order.status — единственный надёжный сигнал состояния заказа (2026-05-14)

**Проблема:** Оператор bulk-buy'ил два заказа, один прошёл (FedEx), один упал (USPS). Затем зашёл в Veeqo UI и **отменил** успешную этикетку. В Veeqo заказ снова показывается как `awaiting_fulfillment`/`Ready to ship`. Но в нашей панели Shipping Labels он **не появляется** — навсегда исчез.

**Корень:** Мы определяли "уже куплено" по employee note с текстом `"Label Purchased"`. Но Veeqo notes — **append-only** ([см. §3](#3-employee-notes-можно-добавлять-через-tags_attributes-brother--employee_notes_attributes)). Когда оператор отменяет этикетку в Veeqo:
- `order.status` → возвращается к `awaiting_fulfillment` ✓
- Employee note `✅ Label Purchased: ...` → **остаётся** ✗

Дашборд видел ноту, ставил `state = "bought"`, и заказ выпадал из списка `ready_to_buy`. Плановый эндпоинт делал `continue` и тоже игнорировал такой заказ.

**Правильный сигнал:**

```typescript
// ✅ Veeqo's authoritative status
const isBought = order.status?.toLowerCase() === "shipped";

// ❌ DON'T — note is append-only, never cleared on cancellation
const isBought = order.employee_notes.some(n => n.text.includes("Label Purchased"));
```

`order.status` flip'ается атомарно с операцией Veeqo (buy → shipped, cancel → awaiting_fulfillment), и это единственный сигнал который синхронизирован с реальностью.

**Где исправлено:**
- [src/app/api/shipping/dashboard/route.ts](../../ss-control-center/src/app/api/shipping/dashboard/route.ts) — функция `isBought()` теперь читает `o.status === "shipped"`
- [src/app/api/shipping/plan/route.ts](../../ss-control-center/src/app/api/shipping/plan/route.ts) — guard от duplicate-purchase тоже использует status

Поскольку `fetchAllOrders("awaiting_fulfillment")` уже фильтрует upstream, фактически после фикса в обоих эндпоинтах путь `state = "bought"` / `continue` достижим только если статус апдейтнется во время выполнения запроса. Это OK — заказы появляются и исчезают атомарно по Veeqo-стороне.

**Что НЕ переписывать обратно:** напрасное соблазн использовать employee notes для логики filter'ов. Notes хороши для **истории** (что произошло, когда), но не для **состояния** (что прямо сейчас актуально). Состояние — только `order.status`, всегда.

---

## История правок страницы
- 2026-05-04: §1-6 — оригинал (tags, notes, pagination, rate limit, id types)
- 2026-05-14: §7-12 добавлены после массовой отладки покупки этикеток.
  - §7 VAS из `shipping_service_options`
  - §8 `tracking_number` объект
  - §9 `/buy` 200 с errors[]
  - §10 Vercel ephemeral disk
  - §11 `label_url` нужен `format=pdf` + auth header
  - §12 employee note "Label Purchased" — не сигнал состояния, использовать `order.status`
  - MASTER_PROMPT_v3.1 §12 помечен как устаревший.
