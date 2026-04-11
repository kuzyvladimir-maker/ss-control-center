# 💸 Adjustments Monitor — Модуль

## Суть
Мониторинг shipping adjustments — доп. чарджи от Amazon/Walmart за расхождение заявленных и фактических размеров/веса посылок. Выявление системных проблем по SKU, суммарные потери, предложения обновить SKU Database.

## Путь в приложении
`/adjustments` — **начат**

## Данные по каждому adjustment
- Adjustment ID, Order ID, дата, сумма (отрицательная), причина (Weight/DIM/Carrier)
- Declared vs Adjusted вес и размеры
- Original label cost, carrier, SKU, channel

## SKU Adjustment Profiles
Агрегация по SKU: кол-во adjustments, total потерь, нужно ли обновить SKU DB.

## Связанные файлы
- `src/app/adjustments/page.tsx` — UI
- `src/app/api/adjustments/` — API routes
- `src/components/adjustments/` — компоненты
- `docs/ADJUSTMENTS_MONITOR_v1.0.md` — полный алгоритм

## DB модели
- `ShippingAdjustment` — отдельные adjustments
- `SkuAdjustmentProfile` — профили по SKU

## 🔗 Связи
- **Зависит от:** [Amazon SP-API](amazon-sp-api.md), [SKU Database](google-sheets-sku-db.md)
- **Используется в:** [Dashboard](dashboard.md)
- **Связанные модули:** [Shipping Labels](shipping-labels.md) (label cost, carrier)
- **См. также:** [Database Schema](database-schema.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
