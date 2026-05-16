# 📚 Project Wiki — Salutem Solutions Control Center

Оглавление базы знаний проекта. Claude Code читает этот файл в начале сессии.

## 🗺️ Карта связей
- [CONNECTIONS.md](CONNECTIONS.md) — полная карта зависимостей между статьями

---

## 🎨 Design / UI
- [Design System и mockup‘ы](design/index.md) — Salutem Design System v1.0, каталог 7 HTML mockup'ов в `/design/` (source of truth для Next.js UI)
- [Mobile Adaptation](mobile-adaptation.md) — аудит мобильной адаптации, план перехода (sidebar→drawer, table→cards, breakpoint md=768px)

## 🏗️ Архитектура
- [Архитектура проекта](project-architecture.md) — стек, модули, структура
- [Database Schema](database-schema.md) — Prisma, 19 моделей
- [Auth System (UI login)](auth-system.md) — логин в UI Control Center, SHA-256+salt, session cookies
- [External API Auth](external-api-auth.md) — Bearer token, middleware, MCP Server

## 📦 Модули
- [Dashboard](dashboard.md) — главная страница, карточки, сводка
- [Store Filter System](store-filter-system.md) — глобальный мульти-селект магазинов (Phase 1: Dashboard) — 2026-05-12
- [Sales Cards on Dashboard](sales-cards-dashboard.md) — 5-period gross revenue + linear forecast (Dashboard) — 2026-05-12
- [Procurement Module](./procurement-module.md) — мобильный закуп товара в магазинах (Publix, Walmart, BJ's). Выборка из Veeqo по тегам, фильтрация workflow-меток, разметка через `Placed` / `Need More`. Будущая основа агента-автозакупщика.
- [Shipping Labels](shipping-labels.md) — план + покупка labels через Veeqo. Полная спец v1.0: [shipping-labels-page-v1.md](shipping-labels-page-v1.md) — dashboard + AI classify + packing profiles (2026-05-12)
- [Shipment Monitor](shipment-monitor.md) — мониторинг доставок, детекция проблем, подготовка claims (спроектирован, после Phase 1)
- [Customer Hub](customer-hub.md) — Messages, A-to-Z, Chargebacks, Feedback (в разработке)
- [Account Health v2.0](account-health-v2.md) — мониторинг Amazon (AHR + Policy Compliance × 10 категорий + ODR/LSR/VTR) + Walmart (8 metrics live через Insights API + Item Compliance), 2 таба, drill-down по нарушениям — 2026-05-12, Walmart Performance v2 — 2026-05-15
- [Critical Alerts Engine](critical-alerts.md) — Telegram + UI push при пересечении критических порогов Amazon/Walmart — 2026-05-12
- [Account Health (исходный)](account-health.md) — предыдущая версия, оставлена как reference
- [Frozen Analytics](frozen-analytics.md) — инциденты с frozen, SKU risk profiles
- [Adjustments Monitor](adjustments-monitor.md) — корректировки веса/размеров
- [A-to-Z & Chargeback](atoz-chargeback.md) — защита от претензий
- [Feedback Manager](feedback-manager.md) — отзывы, классификация удаляемости

## 🧮 Алгоритмы
- [Выбор ставки (Rate Selection)](shipping-rate-selection.md) — Dry vs Frozen логика (Dry-правила упрощены 2026-05-14)
- [Ship Date Trick](ship-date-trick.md) — автоматический сдвиг Frozen на понедельник для дешёвой ставки — 2026-05-14
- [Budget Check](budget-check-algorithm.md) — формулы бюджета по каналу/типу
- [Decision Engine](customer-hub-decision-engine.md) — 5 слоёв AI-анализа
- [Frozen/Dry классификация](frozen-dry-classification.md) — по тегам Veeqo
- [Weekend Distribution](weekend-distribution.md) — Frozen Пт→Пн/Вт + Ship Date Trick

## 🔌 Интеграции
- [Veeqo API](veeqo-api.md) — заказы, ставки, покупка labels
- [Veeqo API Quirks](veeqo-api-quirks.md) — подводные камни (10 пунктов): VAS из `shipping_service_options`, tracking_number бывает объектом, order tags → /bulk_tagging, /buy 200 + errors[], Vercel ephemeral disk
- [Google Drive (PDF этикеток)](google-drive-setup.md) — OAuth refresh-token setup (service account на personal Gmail Drive не работает) — переписано 2026-05-15
- [Drive Backfill (Layer 2)](drive-backfill.md) — async safety net поверх синхронной Drive загрузки; n8n cron каждые 15 мин + admin retry на `/admin/integrations` — 2026-05-15
- [Amazon SP-API](amazon-sp-api.md) — orders, messaging, reports, health, finances
- [Walmart Marketplace API](walmart-api.md) — orders, returns, recon reports, Seller Performance v2 через Insights API (10 per-metric endpoints, 2026-05-15)
- [Gmail API](gmail-api.md) — buyer messages, chargeback notifications
- [Carrier Tracking APIs](carrier-tracking-apis.md) — UPS Tracking (FedEx/USPS в планах), реальный carrier ETA + события
- [Amazon Notifications Map](amazon-notifications-map.md) — маппинг ~30 типов email-уведомлений → модули + Gmail queries
- [SKU Database (Internal DB)](sku-database-migration.md) — веса и размеры, мигрировано из Google Sheets 2026-05-12
- [Claude AI](claude-ai.md) — Decision Engine, генерация ответов
- [Telegram](telegram-notifications.md) — уведомления Владимиру
- [Weather & Geocoding](weather-geocoding.md) — температура для frozen analytics
- [n8n Автоматизация](n8n-automation.md) — 3 workflow для shipping

## 📋 Бизнес-правила
- [Timezone правила](timezone-rules.md) — UTC-7, America/New_York
- [Cutoff Time Rule (3 PM ET)](cutoff-time-rule.md) — effective ship date → next business day после 15:00 ET; skip weekends/US federal holidays. §0.1 MASTER_PROMPT v3.2 — 2026-05-14
- [Carrier Selection Rules](carrier-selection-rules.md) — UPS preference, USPS after noon
- [Walmart ограничения](walmart-restrictions.md) — no Frozen, no weekend, 10% budget
- [Frozen Shipping Rules](frozen-shipping-rules.md) — ≤3 дня, food safety CS
- [Label Filename Format](label-filename-format.md) — формат имени PDF

## 📌 Отложенные задачи (TODO)
- [Деплой на Vercel + Postgres](deploy-to-vercel-plan.md) — план публикации в интернет, ~1ч 15м, отложен 2026-04-10

## Решения и паттерны
- [Legacy Rebrand 2026-05](legacy-rebrand-2026-05.md) — миграция Login/Invite/StoreTabs на Salutem Design System

## Известные проблемы и грабли
- [Veeqo API Quirks](veeqo-api-quirks.md) — order tags нельзя ставить через `PUT /orders/{id}` (silently no-op); работает только `POST /bulk_tagging`. Найдено 2026-05-04.
- [Veeqo API Quirks §7](veeqo-api-quirks.md) — VAS поле динамическое, читать из `rate.shipping_service_options[]` (USPS Ground Advantage требует `DELIVERY_CONFIRMATION`, не `NO_CONFIRMATION`). Master Prompt §12 устарел. 2026-05-14.
- [Veeqo API Quirks §8](veeqo-api-quirks.md) — `tracking_number` может быть объектом, не строкой. 2026-05-14.
- [Veeqo API Quirks §10](veeqo-api-quirks.md) — Vercel serverless ↔ `writeFileSync('public/labels')` не работает; нужен Google Drive или fallback на Veeqo URL. 2026-05-14.

---
Последнее обновление: 2026-05-14
- **MASTER_PROMPT v3.2 + Cutoff Time Rule** — effective ship date вместо «today» после 15:00 ET, учёт weekends и US federal holidays. §0.1 нового MASTER_PROMPT.
- Sprint shipping labels в продакшене: VAS из live rate, tracking object-shape, post-buy modal + audit log, Google Drive upload (раньше работал только n8n).
- Ship Date Trick реализован (был "Handle manually").
- Dry rate rules упрощены.
