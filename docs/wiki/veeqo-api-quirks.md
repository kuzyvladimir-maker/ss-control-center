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
