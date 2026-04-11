# Архитектура проекта

## Суть
Salutem Solutions Control Center — веб-платформа на Next.js 14 для управления e-commerce бизнесом (Amazon, Walmart). Один интерфейс для заказов, доставки, CS и аналитики.

## Стек
- Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui
- SQLite через Prisma ORM
- Внешние API: Veeqo, Sellbrite, Amazon SP-API, Gmail API, Google Sheets, Telegram, Claude API

## Ключевые модули (Phase 1)
1. **Customer Hub** — единая страница (Messages, A-to-Z, Chargebacks, Feedback) с AI-анализом
2. **Shipping Labels** — автоматическая генерация плана и покупка этикеток через Veeqo
3. **Account Health** — мониторинг метрик аккаунтов (ODR/LSR/VTR) через SP-API
4. **Frozen Analytics** — анализ инцидентов с frozen-товарами, риск-профили SKU
5. **Adjustments** — мониторинг корректировок стоимости доставки
6. **Dashboard** — сводка: заказы, этикетки, кейсы

## Связанные файлы
- `CLAUDE.md` — главная спецификация
- `docs/CUSTOMER_HUB_ALGORITHM_v2.1.md` — логика Customer Hub (актуальная)
- `docs/MASTER_PROMPT_v3.1.md` — логика Shipping Labels
- `docs/FROZEN_ANALYTICS_v1.0.md` — Frozen analytics
- `docs/N8N_SHIPPING_ARCHITECTURE_v1.1.md` — n8n архитектура (справка)

## 🔗 Связи
- **Модули:** [Dashboard](dashboard.md), [Shipping Labels](shipping-labels.md), [Customer Hub](customer-hub.md), [Account Health](account-health.md), [Frozen Analytics](frozen-analytics.md), [Adjustments Monitor](adjustments-monitor.md)
- **Интеграции:** [Veeqo](veeqo-api.md), [Amazon SP-API](amazon-sp-api.md), [Gmail](gmail-api.md), [Claude AI](claude-ai.md)
- **Инфраструктура:** [Database Schema](database-schema.md), [External API Auth](external-api-auth.md)
- **Карта связей:** [CONNECTIONS.md](CONNECTIONS.md)

## История
- 2026-04-10: Создана как стартовая wiki-статья
- 2026-04-10: Добавлена секция связей при полной индексации
