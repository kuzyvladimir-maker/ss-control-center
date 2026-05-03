# 🗺️ CONNECTIONS — Карта связей Wiki

Полная карта зависимостей между wiki-статьями проекта SS Control Center.

---

## Модули

### [Dashboard](dashboard.md)
← [Shipping Labels](shipping-labels.md), [Customer Hub](customer-hub.md), [Account Health](account-health.md), [Frozen Analytics](frozen-analytics.md), [Adjustments Monitor](adjustments-monitor.md), [Shipment Monitor](shipment-monitor.md)

### [Shipping Labels](shipping-labels.md)
← [Veeqo API](veeqo-api.md), [SKU Database](google-sheets-sku-db.md), [Timezone правила](timezone-rules.md), [Frozen/Dry классификация](frozen-dry-classification.md)
→ [Dashboard](dashboard.md), [n8n Автоматизация](n8n-automation.md), [Frozen Analytics](frozen-analytics.md), [Adjustments Monitor](adjustments-monitor.md), [Shipment Monitor](shipment-monitor.md)
⊂ [Выбор ставки](shipping-rate-selection.md), [Бюджет](budget-check-algorithm.md), [Weekend распределение](weekend-distribution.md), [Carrier rules](carrier-selection-rules.md), [Label filename](label-filename-format.md)

### [Customer Hub](customer-hub.md)
← [Gmail API](gmail-api.md), [Amazon SP-API](amazon-sp-api.md), [Claude AI](claude-ai.md), [Veeqo API](veeqo-api.md)
→ [Dashboard](dashboard.md)
⊂ [Decision Engine](customer-hub-decision-engine.md), [A-to-Z & Chargeback](atoz-chargeback.md), [Feedback Manager](feedback-manager.md)

### [Account Health](account-health.md)
← [Amazon SP-API](amazon-sp-api.md)
→ [Dashboard](dashboard.md)
⇔ [A-to-Z & Chargeback](atoz-chargeback.md) (ODR), [Feedback Manager](feedback-manager.md) (Negative Feedback), [Shipping Labels](shipping-labels.md) (LSR/VTR)

### [Frozen Analytics](frozen-analytics.md)
← [Veeqo API](veeqo-api.md), [Weather/Geocoding](weather-geocoding.md), [Shipping Labels](shipping-labels.md), [Shipment Monitor](shipment-monitor.md)
⇔ [Customer Hub](customer-hub.md) (frozen жалобы), [Frozen/Dry классификация](frozen-dry-classification.md), [Frozen shipping rules](frozen-shipping-rules.md)

### [Adjustments Monitor](adjustments-monitor.md)
← [Amazon SP-API](amazon-sp-api.md), [SKU Database](google-sheets-sku-db.md)
→ [Dashboard](dashboard.md)
⇔ [Shipping Labels](shipping-labels.md) (label cost/carrier)

### [Shipment Monitor](shipment-monitor.md)
← [Veeqo API](veeqo-api.md) (tracking events), [Shipping Labels](shipping-labels.md) (label data), [Carrier APIs](carrier-tracking-apis.md) (Level 2)
→ [Dashboard](dashboard.md), [Frozen Analytics](frozen-analytics.md) (delivery timeline)
⇔ [Customer Hub](customer-hub.md) (delivery issues), [Telegram](telegram-notifications.md) (daily report)

---

## Алгоритмы

### [Выбор ставки](shipping-rate-selection.md)
⊂ [Shipping Labels](shipping-labels.md)
← [Timezone правила](timezone-rules.md), [Frozen/Dry классификация](frozen-dry-classification.md)
→ [Бюджет](budget-check-algorithm.md)
⇔ [Carrier rules](carrier-selection-rules.md)

### [Budget Check](budget-check-algorithm.md)
⊂ [Shipping Labels](shipping-labels.md)
← [Выбор ставки](shipping-rate-selection.md)
⇔ [Walmart ограничения](walmart-restrictions.md)

### [Decision Engine](customer-hub-decision-engine.md)
⊂ [Customer Hub](customer-hub.md)
← [Claude AI](claude-ai.md), [Amazon SP-API](amazon-sp-api.md)
→ [A-to-Z & Chargeback](atoz-chargeback.md)
⇔ [Frozen shipping rules](frozen-shipping-rules.md)

### [Frozen/Dry классификация](frozen-dry-classification.md)
← [Veeqo API](veeqo-api.md) (теги)
→ [Shipping Labels](shipping-labels.md), [Выбор ставки](shipping-rate-selection.md), [Бюджет](budget-check-algorithm.md)
⇔ [Walmart ограничения](walmart-restrictions.md), [Frozen Analytics](frozen-analytics.md)

### [Weekend Distribution](weekend-distribution.md)
⊂ [Shipping Labels](shipping-labels.md), [n8n Автоматизация](n8n-automation.md)
← [Frozen/Dry классификация](frozen-dry-classification.md), [Timezone правила](timezone-rules.md)
⇔ [Frozen shipping rules](frozen-shipping-rules.md)

---

## Интеграции

### [Veeqo API](veeqo-api.md)
→ [Shipping Labels](shipping-labels.md), [Frozen Analytics](frozen-analytics.md), [Customer Hub](customer-hub.md), [n8n Автоматизация](n8n-automation.md), [Shipment Monitor](shipment-monitor.md)
⇔ [Timezone правила](timezone-rules.md), [Frozen/Dry классификация](frozen-dry-classification.md), [SKU Database](google-sheets-sku-db.md)

### [Amazon SP-API](amazon-sp-api.md)
→ [Customer Hub](customer-hub.md), [Account Health](account-health.md), [A-to-Z & Chargeback](atoz-chargeback.md), [Feedback Manager](feedback-manager.md), [Adjustments Monitor](adjustments-monitor.md)
⇔ [Gmail API](gmail-api.md), [External API Auth](external-api-auth.md)

### [Walmart Marketplace API](walmart-api.md)
→ [Customer Hub](customer-hub.md) (orders + returns sync, заменяет screenshot schema), [Adjustments Monitor](adjustments-monitor.md) (recon reports), [Account Health](account-health.md) (Seller Performance), [Shipment Monitor](shipment-monitor.md) (Level 1.5 tracking), [Shipping Labels](shipping-labels.md) (verification endpoint), [Dashboard](dashboard.md)
⇔ [Veeqo API](veeqo-api.md) (Veeqo использует delegated Walmart key), [External API Auth](external-api-auth.md)
← [Walmart ограничения](walmart-restrictions.md)

### [Gmail API](gmail-api.md)
→ [Customer Hub](customer-hub.md) (Messages + Chargebacks)
⇔ [Amazon SP-API](amazon-sp-api.md), [A-to-Z & Chargeback](atoz-chargeback.md), [Amazon Notifications Map](amazon-notifications-map.md)

### [Amazon Notifications Map](amazon-notifications-map.md)
← [Gmail API](gmail-api.md), [Amazon SP-API](amazon-sp-api.md)
→ [Customer Hub](customer-hub.md), [Account Health](account-health.md), [Shipping Labels](shipping-labels.md), [Adjustments Monitor](adjustments-monitor.md), [A-to-Z & Chargeback](atoz-chargeback.md), [Feedback Manager](feedback-manager.md)
⇔ [Dashboard](dashboard.md) (счётчики), [Decision Engine](customer-hub-decision-engine.md), [n8n Автоматизация](n8n-automation.md)

### [SKU Database](google-sheets-sku-db.md)
→ [Shipping Labels](shipping-labels.md), [n8n Автоматизация](n8n-automation.md)
⇔ [Adjustments Monitor](adjustments-monitor.md), [Veeqo API](veeqo-api.md)

### [Claude AI](claude-ai.md)
→ [Customer Hub](customer-hub.md), [Decision Engine](customer-hub-decision-engine.md), [Feedback Manager](feedback-manager.md), [A-to-Z & Chargeback](atoz-chargeback.md)

### [Telegram](telegram-notifications.md)
→ [Shipping Labels](shipping-labels.md), [n8n Автоматизация](n8n-automation.md), [Account Health](account-health.md), [Shipment Monitor](shipment-monitor.md)

### [Weather/Geocoding](weather-geocoding.md)
→ [Frozen Analytics](frozen-analytics.md)

### [Carrier Tracking APIs](carrier-tracking-apis.md)
→ [Shipment Monitor](shipment-monitor.md) (Level 2), [Frozen Analytics](frozen-analytics.md)

### [n8n Автоматизация](n8n-automation.md)
Реализует [Shipping Labels](shipping-labels.md)
← [Veeqo API](veeqo-api.md), [SKU Database](google-sheets-sku-db.md), [Telegram](telegram-notifications.md)
⊂ [Выбор ставки](shipping-rate-selection.md), [Бюджет](budget-check-algorithm.md), [Weekend распределение](weekend-distribution.md), [Frozen/Dry классификация](frozen-dry-classification.md)

---

## Бизнес-правила

### [Timezone правила](timezone-rules.md)
→ [Shipping Labels](shipping-labels.md), [Выбор ставки](shipping-rate-selection.md), [n8n Автоматизация](n8n-automation.md), [Weekend распределение](weekend-distribution.md)
← [Veeqo API](veeqo-api.md)

### [Carrier Selection Rules](carrier-selection-rules.md)
⊂ [Выбор ставки](shipping-rate-selection.md)
⇔ [A-to-Z & Chargeback](atoz-chargeback.md) (Claims Protected), [SKU Database](google-sheets-sku-db.md)

### [Walmart ограничения](walmart-restrictions.md)
→ [Shipping Labels](shipping-labels.md), [Frozen/Dry классификация](frozen-dry-classification.md), [Бюджет](budget-check-algorithm.md)
⇔ [Customer Hub](customer-hub.md)

### [Frozen Shipping Rules](frozen-shipping-rules.md)
→ [Shipping Labels](shipping-labels.md), [Выбор ставки](shipping-rate-selection.md), [Customer Hub](customer-hub.md), [Decision Engine](customer-hub-decision-engine.md)
⇔ [Frozen Analytics](frozen-analytics.md), [Frozen/Dry классификация](frozen-dry-classification.md), [Weekend распределение](weekend-distribution.md)

### [Label Filename Format](label-filename-format.md)
⊂ [Shipping Labels](shipping-labels.md), [n8n Автоматизация](n8n-automation.md)

---

## Design / UI mockups

### [Design System](design/index.md)
Каталог HTML‑mockup'ов в `/design/` и описание Salutem Design System v1.0. Источник визуальной правды для Next.js реализации.

**Design tokens (source of truth):**
- `design/DESIGN_TOKENS.md` ⊂ все `design/*.html` (CSS variables, типографика, радиусы)

**Module ↔ mockup (двусторонние связи):**
- `design/dashboard_salutem.html` ⇔ [Dashboard](dashboard.md)
- `design/account_health_salutem.html` ⇔ [Account Health](account-health.md)
- `design/shipping_labels_salutem.html` ⇔ [Shipping Labels](shipping-labels.md)
- `design/customer_hub_salutem_v2.html` ⇔ [Customer Hub](customer-hub.md), [Decision Engine](customer-hub-decision-engine.md), [A-to-Z & Chargeback](atoz-chargeback.md), [Feedback Manager](feedback-manager.md)
- `design/frozen_analytics_salutem.html` ⇔ [Frozen Analytics](frozen-analytics.md)
- `design/adjustments_salutem.html` ⇔ [Adjustments Monitor](adjustments-monitor.md)
- `design/settings_salutem.html` ⇔ [External API Auth](external-api-auth.md), [Amazon SP-API](amazon-sp-api.md), [Veeqo API](veeqo-api.md), [Gmail API](gmail-api.md), [Claude AI](claude-ai.md), [Telegram](telegram-notifications.md), [SKU Database](google-sheets-sku-db.md), [Walmart API](walmart-api.md)

**Deprecated:**
- `design/customer_hub_v1_DEPRECATED.html` — архив v1, до алгоритма v2.1

---

## Инфраструктура

### [Database Schema](database-schema.md)
→ все модули

### [External API Auth](external-api-auth.md)
⇔ [Amazon SP-API](amazon-sp-api.md), [Veeqo API](veeqo-api.md), [Архитектура проекта](project-architecture.md)

### [Auth System (UI login)](auth-system.md)
← [Database Schema](database-schema.md) (модель User), Turso cloud DB
⇔ [External API Auth](external-api-auth.md) (параллельный механизм), [Архитектура проекта](project-architecture.md), [Деплой на Vercel](deploy-to-vercel-plan.md)

### [Архитектура проекта](project-architecture.md)
Обзорная статья, ссылается на все модули.

---

## Легенда
- `←` зависит от
- `→` используется в
- `⊂` является частью
- `⇔` двусторонняя связь

---
Последнее обновление: 2026-04-19 (+ design/ mockups)
