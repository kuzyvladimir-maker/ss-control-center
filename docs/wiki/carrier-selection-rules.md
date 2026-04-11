# 🚛 Carrier Selection Rules

## Суть
Правила предпочтения carrier при выборе ставки.

## Общие правила
- **UPS предпочтительнее** при разнице ≤10% от самого дешёвого
- **После 12:00 ET** → убрать USPS если есть альтернативы (Dry)
- При разнице ≤$0.50 → выбрать более ранний EDD

## Frozen-специфичные
- **Среда:** убрать Ground (5 кал. дней → не успеет)
- **Пятница:** убрать FedEx Express
- Calendar days ≤ 3 обязательно

## FedEx One Rate
Отдельная колонка веса в SKU Database (K = H × 1.25). Использовать Weight FedEx только для FedEx One Rate тарифов.

## Claims Protected Badge
Labels купленные через Buy Shipping получают защиту от A-to-Z claims по carrier delay.

## 🔗 Связи
- **Часть:** [Выбор ставки](shipping-rate-selection.md)
- **Используется в:** [Shipping Labels](shipping-labels.md)
- **Связан с:** [A-to-Z & Chargeback](atoz-chargeback.md) (Claims Protected), [SKU Database](google-sheets-sku-db.md) (FedEx weight)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
