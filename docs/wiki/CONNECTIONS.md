# 🗺️ CONNECTIONS — Карта связей Wiki

Полная карта зависимостей между wiki-статьями проекта SS Control Center.

---

## Модули

### [Dashboard](dashboard.md)
← [Shipping Labels](shipping-labels.md), [Customer Hub](customer-hub.md), [Account Health](account-health.md), [Frozen Analytics](frozen-analytics.md), [Adjustments Monitor](adjustments-monitor.md), [Shipment Monitor](shipment-monitor.md)

### [Shipping Labels](shipping-labels.md)
← [Veeqo API](veeqo-api.md), [Veeqo API Quirks](veeqo-api-quirks.md) (VAS из shipping_service_options, tracking object-shape, Vercel ephemeral disk), [SKU Database](sku-database-migration.md), [Timezone правила](timezone-rules.md), [Frozen/Dry классификация](frozen-dry-classification.md), [Procurement](procurement-module.md) (ждёт тега `Placed` на заказе перед покупкой этикетки), [Claude AI](claude-ai.md) (AI classification в [Shipping Labels Page v1](shipping-labels-page-v1.md)), [Google Drive](google-drive-setup.md) (постоянное хранение PDF этикеток), [Drive Backfill](drive-backfill.md) (Layer 2 safety net когда синхронная загрузка упала), [Frozen Analytics](frozen-analytics.md) (risk badge + recommendation per row + PDF filename marker)
→ [Dashboard](dashboard.md), [n8n Автоматизация](n8n-automation.md) (заменён ss-control-center), [Frozen Analytics](frozen-analytics.md), [Adjustments Monitor](adjustments-monitor.md), [Shipment Monitor](shipment-monitor.md)
⊂ [Выбор ставки](shipping-rate-selection.md), [Ship Date Trick](ship-date-trick.md), [Бюджет](budget-check-algorithm.md), [Weekend распределение](weekend-distribution.md), [Carrier rules](carrier-selection-rules.md), [Label filename](label-filename-format.md), [Shipping Labels Page v1](shipping-labels-page-v1.md) (UI и dashboard)

### [Procurement](procurement-module.md)
← [Veeqo API](veeqo-api.md) (orders + products + tags + internal notes)
→ [Shipping Labels](shipping-labels.md) (ставит тег `Placed` → Shipping Labels автоматически видит заказ как готовый к покупке этикетки; раньше тег ставился вручную), [Telegram](telegram-notifications.md) (Phase 7 — уведомления о приоритетных заказах)
⊂ SS Control Center (auth, design system, Turso БД)
⇔ SKUStorePriority (новая таблица в БД)

### [Bundle Factory](bundle-factory.md)
← Perplexity API (research стадия), OpenAI API (image gen + content backup), [Claude AI](claude-ai.md) (primary text generation), Higgsfield (image + video alternative), Cloudflare R2 (CDN storage для bundle images), GS1 GEPIR (UPC validation), [Amazon SP-API](amazon-sp-api.md) (Listings Items API + Brand Registry для Salutem Vita), [Walmart Marketplace API](walmart-api.md) (item listings), **Vladimir's Walmart Business account** (authoritative для Walmart store registry)
→ [Procurement](procurement-module.md) (новый bundle создаёт дефолтный SKUStorePriority с порядком магазинов), [Dashboard](dashboard.md) (Bundle Factory analytics card в Phase 2)
⊂ **Marketplace Rules KB** (`docs/marketplace-rules/` — 25 файлов: Amazon Gift Set Policy, browse-nodes-grocery, gtin-exemption-process, category-files, Walmart Multipack, eBay, TikTok), Salutem Vita + Starfit Brand Registry, SS Control Center (auth, design system, Turso БД)
⇔ [Customer Hub](customer-hub.md) (Order ID coupling после first order на новом ASIN), [Frozen Analytics](frozen-analytics.md) (новый Frozen bundle → risk profiling), [SKU Database](sku-database-migration.md) (новый bundle → запись с cost & shipping data)
**Phase 0 завершён 2026-05-17:** Концепт (`BUNDLE_FACTORY_CONCEPT_v1_0.md`), Sourcing Map v1.1 (**37 магазинов, 14 Walmart**), Data Model (14 Prisma моделей в `BUNDLE_FACTORY_DATA_MODEL.md`), Marketplace Rules KB (25 файлов), Phase 1 промпт для Claude Code.
**Phase 1 завершён 2026-05-17** (ветка `feat/bundle-factory-phase-1`): 14 Prisma моделей в `prisma/schema.prisma` + миграция (sqlite + idempotent Turso script `scripts/turso-migrate-bundle-factory-phase-1.mjs`) + 5 seed-скриптов (37 stores, 9 brand accounts, 30 marketplace rules, 63 GTIN trackers, UPC pool с graceful skip когда Active Listings Report отсутствует) + 10 API endpoints `/api/bundle-factory/{stores,upc-pool,master-bundles,channel-skus,briefs,drafts,research,marketplace-rules,generation-jobs,lifecycle-logs}` + 7 UI pages `/bundle-factory/{,briefs,drafts,master-bundles,live,stores,settings}` (Salutem Design System v1.0) + sidebar entry. Ready for Phase 2.

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
← [Amazon SP-API](amazon-sp-api.md), [SKU Database](sku-database-migration.md)
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
⇔ [Timezone правила](timezone-rules.md), [Frozen/Dry классификация](frozen-dry-classification.md), [SKU Database](sku-database-migration.md)

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

### [SKU Database](sku-database-migration.md)
→ [Shipping Labels](shipping-labels.md), [n8n Автоматизация](n8n-automation.md)
⇔ [Adjustments Monitor](adjustments-monitor.md), [Veeqo API](veeqo-api.md)
← [Database Schema](database-schema.md) (таблица `SkuShippingData`)
Мигрировано из Google Sheets 2026-05-12. Архив: [google-sheets-sku-db.md](google-sheets-sku-db.md) (DEPRECATED).

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
← [Veeqo API](veeqo-api.md), [SKU Database](sku-database-migration.md), [Telegram](telegram-notifications.md)
⊂ [Выбор ставки](shipping-rate-selection.md), [Бюджет](budget-check-algorithm.md), [Weekend распределение](weekend-distribution.md), [Frozen/Dry классификация](frozen-dry-classification.md)

---

## Бизнес-правила

### [Timezone правила](timezone-rules.md)
→ [Shipping Labels](shipping-labels.md), [Выбор ставки](shipping-rate-selection.md), [n8n Автоматизация](n8n-automation.md), [Weekend распределение](weekend-distribution.md)
← [Veeqo API](veeqo-api.md)

### [Carrier Selection Rules](carrier-selection-rules.md)
⊂ [Выбор ставки](shipping-rate-selection.md)
⇔ [A-to-Z & Chargeback](atoz-chargeback.md) (Claims Protected), [SKU Database](sku-database-migration.md)

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
- `design/settings_salutem.html` ⇔ [External API Auth](external-api-auth.md), [Amazon SP-API](amazon-sp-api.md), [Veeqo API](veeqo-api.md), [Gmail API](gmail-api.md), [Claude AI](claude-ai.md), [Telegram](telegram-notifications.md), [SKU Database](sku-database-migration.md), [Walmart API](walmart-api.md)

**Deprecated:**
- `design/customer_hub_v1_DEPRECATED.html` — архив v1, до алгоритма v2.1

### [Legacy Rebrand 2026-05](legacy-rebrand-2026-05.md)
← [Mobile Adaptation](mobile-adaptation.md) (баг обнаружен в Phase 0 audit)
→ [Auth System](auth-system.md), [Customer Hub](customer-hub.md)
⊂ Salutem Design System

### [Mobile Adaptation](mobile-adaptation.md)
**Phase 2 завершён 2026-05-04** — все таблицы проекта поддерживают мобильное отображение через паттерн "table + cards в одном компоненте". Phase 1 (App Shell) и Phase 2 (таблицы) вместе покрывают весь UI.

← [Design System](design/index.md) (токены не менялись), [Архитектура проекта](project-architecture.md) (Next.js 16, Tailwind v4, shadcn/ui)
⇔ ВСЕ модули (Dashboard, Customer Hub, Adjustments, Frozen Analytics, Claims, Feedback, Shipping, Settings, Account Health) — каждый имеет mobile-version
⊂ AppShell (Phase 1), Sidebar→drawer (Phase 1), Header→hamburger (Phase 1), 13 таблиц→cards (Phase 2)
← MobileNavContext, shadcn/ui:Sheet

---

## Инфраструктура

### [Database Schema](database-schema.md)
→ все модули

### [External API Auth](external-api-auth.md)
⇔ [Amazon SP-API](amazon-sp-api.md), [Veeqo API](veeqo-api.md), [Архитектура проекта](project-architecture.md)

### [Auth System (UI login)](auth-system.md)
← [Database Schema](database-schema.md) (модель User), Turso cloud DB
⇔ [External API Auth](external-api-auth.md) (параллельный механизм), [Архитектура проекта](project-architecture.md), [Деплой на Vercel](deploy-to-vercel-plan.md)

### [Store Filter System](store-filter-system.md)
← [Database Schema](database-schema.md) (`Store.channel` / `Store.storeIndex` / `Store.sellerId`)
→ [Dashboard](dashboard.md), [Sales Cards on Dashboard](sales-cards-dashboard.md)
⇔ `src/components/layout/Sidebar.tsx` (StoreFilterSelector), `src/components/layout/Header.tsx` (StoresLiveBadge)
Phase 2 planned → [Customer Hub](customer-hub.md), [Adjustments Monitor](adjustments-monitor.md), [Account Health](account-health.md), [Shipping Labels](shipping-labels.md)

### [Sales Cards on Dashboard](sales-cards-dashboard.md)
← [Store Filter System](store-filter-system.md), [Database Schema](database-schema.md) (`AmazonOrder`, `WalmartOrder`), [Amazon SP-API](amazon-sp-api.md), [Walmart API](walmart-api.md)
→ [Dashboard](dashboard.md)
⇔ `scripts/backfill-orders.ts` (data fresh-ness)
Phase 2 planned → sales-analytics-module (полноценная страница `/analytics`)

### [Архитектура проекта](project-architecture.md)
Обзорная статья, ссылается на все модули.

---

## Account Health v2.0

### [Account Health v2.0](account-health-v2.md)
← [Amazon SP-API](amazon-sp-api.md) — Selling Partner Insights role (AHR + Policy Compliance), Account Health API, Listings Issues API
← [Walmart API](walmart-api.md) — Seller Performance v2 (Insights API: `/v3/insights/performance/{metric}/summary` × 10 metrics) + Items API (lifecycleStatus для compliance)
← [Telegram Notifications](telegram-notifications.md) — канал доставки Critical Alerts
⇔ [Critical Alerts](critical-alerts.md)
→ [Dashboard](dashboard.md) — счётчик unacknowledged алертов в Health Issues card
⊂ [Database Schema](database-schema.md) — модели `PolicyViolationCategory`, `PolicyViolationDetail`, `WalmartPerformanceSnapshot`, `WalmartItemCompliance`
⇔ `docs/CLAUDE_CODE_PROMPT_ACCOUNT_HEALTH_V2.md` (implementation prompt)

### [Critical Alerts](critical-alerts.md)
⊂ [Account Health v2.0](account-health-v2.md)
← `AccountHealthSnapshot`, `WalmartPerformanceSnapshot` — evaluator создаёт алерты после каждого sync
→ Topbar `CriticalAlertsBell` компонент (polling 30 сек)
→ Telegram (severity CRITICAL/HIGH)
⊂ [Database Schema](database-schema.md) — модель `CriticalAlert`

### Иерархия БД
- `PolicyViolationDetail` ⊂ `PolicyViolationCategory` ⊂ `AccountHealthSnapshot`
- `WalmartItemCompliance` ⊂ `WalmartPerformanceSnapshot`

---

## Легенда
- `←` зависит от
- `→` используется в
- `⊂` является частью
- `⇔` двусторонняя связь

---
Последнее обновление: 2026-05-14 (+ Sprint shipping labels prod: VAS live-read, post-buy modal, Drive upload, ship-date-trick)
