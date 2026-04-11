# 📧 Gmail API — Интеграция

## Суть
Получение buyer messages и chargeback notifications из Gmail. Пока подключён только store2 (kuzy.vladimir@gmail.com).

## Gmail Queries
- **Buyer messages:** `from:marketplace.amazon.com to:{account_email} newer_than:2d`
- **Chargebacks:** `from:cb-seller-notification@amazon.com newer_than:7d`

## Парсинг писем
| Поле | Откуда | Regex |
|------|--------|-------|
| Order ID | Subject/Body | `(Order:\s*\|Order ID:\s*)(\d{3}-\d{7}-\d{7})` |
| Customer Name | Subject | `from Amazon customer (.+?)[\s(]` |
| ASIN | Body (таблица) | HTML parsing |
| Message Text | Body | После "Message:" |

## Phase 1 ограничение
Messages и Chargebacks через Gmail работают только для аккаунтов с подключённым Gmail API. Store1 (Salutem Solutions) нужен OAuth.

## Связанные файлы
- `src/lib/gmail-api.ts` — Gmail OAuth клиент
- `src/lib/customer-hub/gmail-parser.ts` — парсинг писем

## 🔗 Связи
- **Используется в:** [Customer Hub](customer-hub.md) (Messages + Chargebacks табы)
- **Связан с:** [Amazon SP-API](amazon-sp-api.md) (обогащение данных заказа)
- **См. также:** [A-to-Z & Chargeback](atoz-chargeback.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
