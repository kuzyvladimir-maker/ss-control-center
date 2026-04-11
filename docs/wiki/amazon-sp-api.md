# 🛒 Amazon SP-API — Интеграция

## Суть
Amazon Selling Partner API — доступ к заказам, сообщениям, отчётам, финансам, здоровью аккаунтов. Per-store credentials для 5 аккаунтов.

## Используемые модули
| Модуль | Файл | Назначение |
|--------|------|-----------|
| Auth | `auth.ts` | Per-store OAuth: `AMAZON_SP_REFRESH_TOKEN_STORE{N}` с fallback |
| Client | `client.ts` | Базовый HTTP клиент |
| Orders | `orders.ts` | Заказы, трекинг |
| Messaging | `messaging.ts` | Ответы покупателям |
| Reports | `reports.ts` | GET_CLAIM_DATA, GET_SELLER_FEEDBACK_DATA |
| Finances | `finances.ts` | Транзакции, adjustments |
| Solicitations | `solicitations.ts` | Запросы отзывов |
| Account Health | `account-health-sync.ts` | Метрики ODR/LSR/VTR |

## 5 аккаунтов
1. Salutem Solutions (store1) — SP-API ✅
2. Vladimir Personal (store2) — SP-API ✅ + Gmail ✅
3. AMZ Commerce (store3) — SP-API ✅
4. Sirius International (store4) — SP-API ✅
5. Retailer Distributor (store5) — SP-API ✅

## Связанные файлы
- `src/lib/amazon-sp-api/` — весь каталог
- `src/app/api/amazon/` — API routes

## 🔗 Связи
- **Используется в:** [Customer Hub](customer-hub.md), [Account Health](account-health.md), [A-to-Z & Chargeback](atoz-chargeback.md), [Feedback Manager](feedback-manager.md), [Adjustments Monitor](adjustments-monitor.md)
- **Связан с:** [Gmail API](gmail-api.md) (buyer messages), [External API Auth](external-api-auth.md)
- **См. также:** [Database Schema](database-schema.md) (`AmazonOrder`, `SyncLog`)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
