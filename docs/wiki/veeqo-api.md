# 📦 Veeqo API — Интеграция

## Суть
Основной сервис для управления заказами и покупки shipping labels. Все заказы Amazon и Walmart проходят через Veeqo.

## Используемые endpoints
- `GET /orders` — список заказов (status, page_size, page)
- `GET /products/{id}` — теги продукта (Frozen/Dry)
- `GET /shipping/rates/{allocation_id}` — доступные ставки
- `POST /shipping/shipments` — покупка label
- `PUT /orders/{id}` — обновление employee_notes, dispatch_date

## Ключевые особенности
- Даты в UTC — конвертировать в UTC-7 (Pacific) для сравнения с UI
- Employee notes = хранилище метаданных (tracking, "Label Purchased", "✅")
- Тег `Placed` = товар физически в наличии
- PDF label доступен по URL из response

## Auth
Header: `x-api-key: <VEEQO_API_KEY>`

## Связанные файлы
- `src/lib/veeqo.ts` — API клиент
- `src/app/api/veeqo/orders/` — API route

## 🔗 Связи
- **Используется в:** [Shipping Labels](shipping-labels.md), [Frozen Analytics](frozen-analytics.md), [Customer Hub](customer-hub.md) (tracking enrichment), [n8n Автоматизация](n8n-automation.md)
- **Связан с:** [Timezone правила](timezone-rules.md), [Frozen/Dry классификация](frozen-dry-classification.md) (теги)
- **См. также:** [SKU Database](google-sheets-sku-db.md) (веса/размеры)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
