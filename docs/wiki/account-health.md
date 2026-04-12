# 💓 Account Health Monitor — Модуль

## Суть
Непрерывный мониторинг 5 Amazon аккаунтов. Синхронизация метрик через SP-API, алерты при ухудшении, протокол каскадной блокировки при suspension. Приоритет: CRITICAL.

## Путь в приложении
`/account-health` — **работает**

## Ключевые метрики
| Метрика | Порог | Окно |
|---------|-------|------|
| ODR (Order Defect Rate) | <1% | 60 дней |
| LSR (Late Shipment Rate) | <4% | 10 и 30 дней |
| VTR (Valid Tracking Rate) | >95% | 30 дней |
| Pre-fulfillment Cancel Rate | <2.5% | 7 дней |
| On-Time Delivery Rate | info | 14 дней |

## Компоненты ODR
- Negative Feedback Rate
- A-to-Z Claims Rate
- Chargeback Rate

## Связанные файлы
- `src/app/account-health/page.tsx` — UI
- `src/app/api/account-health/` — API routes
- `src/components/account-health/` — компоненты
- `src/lib/amazon-sp-api/account-health-sync.ts` — синхронизация
- `docs/ACCOUNT_HEALTH_MONITOR_v1.0.md` — полный алгоритм

## DB модели
- `AccountHealthSnapshot` — снимки метрик
- `AccountAlert` — алерты по метрикам

## 🔗 Связи
- **Зависит от:** [Amazon SP-API](amazon-sp-api.md), [Amazon Notifications Map](amazon-notifications-map.md) (Listing compliance, removals, Business Updates через Gmail — нет в SP-API)
- **Используется в:** [Dashboard](dashboard.md)
- **Связанные модули:** [A-to-Z & Chargeback](atoz-chargeback.md) (влияет на ODR), [Feedback Manager](feedback-manager.md) (Negative Feedback → ODR), [Shipping Labels](shipping-labels.md) (LSR/VTR)
- **См. также:** [Database Schema](database-schema.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
