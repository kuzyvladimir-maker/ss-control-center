# 📊 Dashboard — Модуль

## Суть
Главная страница приложения. Карточки с ключевыми показателями, data overview, quick actions. Агрегация данных со всех модулей.

## Путь в приложении
`/` (root) — **работает**

## Связанные файлы
- `src/app/page.tsx` — UI
- `src/app/api/dashboard/summary/` — API summary
- `src/components/dashboard/` — компоненты

## 🔗 Связи
- **Зависит от:** [Shipping Labels](shipping-labels.md), [Customer Hub](customer-hub.md), [Account Health](account-health.md), [Frozen Analytics](frozen-analytics.md), [Adjustments Monitor](adjustments-monitor.md)
- **Связан с:** [Amazon Notifications Map](amazon-notifications-map.md) (счётчики unread/active/alerts питаются из уведомлений)
- **См. также:** [Архитектура проекта](project-architecture.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
