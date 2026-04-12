# 📚 Project Wiki — Salutem Solutions Control Center

Оглавление базы знаний проекта. Claude Code читает этот файл в начале сессии.

## 🗺️ Карта связей
- [CONNECTIONS.md](CONNECTIONS.md) — полная карта зависимостей между статьями

---

## 🏗️ Архитектура
- [Архитектура проекта](project-architecture.md) — стек, модули, структура
- [Database Schema](database-schema.md) — Prisma, 19 моделей
- [External API Auth](external-api-auth.md) — Bearer token, middleware, MCP Server

## 📦 Модули
- [Dashboard](dashboard.md) — главная страница, карточки, сводка
- [Shipping Labels](shipping-labels.md) — план + покупка labels через Veeqo
- [Shipment Monitor](shipment-monitor.md) — мониторинг доставок, детекция проблем, подготовка claims (спроектирован, после Phase 1)
- [Customer Hub](customer-hub.md) — Messages, A-to-Z, Chargebacks, Feedback (в разработке)
- [Account Health](account-health.md) — мониторинг 5 аккаунтов, ODR/LSR/VTR
- [Frozen Analytics](frozen-analytics.md) — инциденты с frozen, SKU risk profiles
- [Adjustments Monitor](adjustments-monitor.md) — корректировки веса/размеров
- [A-to-Z & Chargeback](atoz-chargeback.md) — защита от претензий
- [Feedback Manager](feedback-manager.md) — отзывы, классификация удаляемости

## 🧮 Алгоритмы
- [Выбор ставки (Rate Selection)](shipping-rate-selection.md) — Dry vs Frozen логика
- [Budget Check](budget-check-algorithm.md) — формулы бюджета по каналу/типу
- [Decision Engine](customer-hub-decision-engine.md) — 5 слоёв AI-анализа
- [Frozen/Dry классификация](frozen-dry-classification.md) — по тегам Veeqo
- [Weekend Distribution](weekend-distribution.md) — Frozen Пт→Пн/Вт + Ship Date Trick

## 🔌 Интеграции
- [Veeqo API](veeqo-api.md) — заказы, ставки, покупка labels
- [Amazon SP-API](amazon-sp-api.md) — orders, messaging, reports, health, finances
- [Gmail API](gmail-api.md) — buyer messages, chargeback notifications
- [Carrier Tracking APIs](carrier-tracking-apis.md) — UPS Tracking (FedEx/USPS в планах), реальный carrier ETA + события
- [Amazon Notifications Map](amazon-notifications-map.md) — маппинг ~30 типов email-уведомлений → модули + Gmail queries
- [SKU Database (Google Sheets)](google-sheets-sku-db.md) — веса и размеры
- [Claude AI](claude-ai.md) — Decision Engine, генерация ответов
- [Telegram](telegram-notifications.md) — уведомления Владимиру
- [Weather & Geocoding](weather-geocoding.md) — температура для frozen analytics
- [n8n Автоматизация](n8n-automation.md) — 3 workflow для shipping

## 📋 Бизнес-правила
- [Timezone правила](timezone-rules.md) — UTC-7, America/New_York
- [Carrier Selection Rules](carrier-selection-rules.md) — UPS preference, USPS after noon
- [Walmart ограничения](walmart-restrictions.md) — no Frozen, no weekend, 10% budget
- [Frozen Shipping Rules](frozen-shipping-rules.md) — ≤3 дня, food safety CS
- [Label Filename Format](label-filename-format.md) — формат имени PDF

## 📌 Отложенные задачи (TODO)
- [Деплой на Vercel + Postgres](deploy-to-vercel-plan.md) — план публикации в интернет, ~1ч 15м, отложен 2026-04-10

## Решения и паттерны
- (будет дополняться по ходу разработки)

## Известные проблемы и грабли
- (будет дополняться по ходу разработки)

---
Последнее обновление: 2026-04-11
