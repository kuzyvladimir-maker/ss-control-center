# ⚙️ n8n Автоматизация

## Суть
3 n8n workflow для автоматизации shipping labels. Справочная архитектура — реализация может быть как в n8n, так и напрямую через Jackie.

## Workflows
| # | Workflow | Триггер | Задача |
|---|----------|---------|--------|
| 1 | Order Analyzer | Schedule (9:00 + 14:00 ET будни) | Собрать заказы → план в Google Sheets |
| 2 | Label Purchaser | Webhook ("покупай") | Купить labels по плану |
| 2.5 | Ship Date Trick | Sub-workflow | Frozen Чт/Пт без ставок → rate от Monday |
| 3 | Weekend Distributor | Schedule (Пт 17:00 ET) | Split Frozen на Пн/Вт |

## Credentials
- Veeqo: HTTP Header Auth
- Google Sheets/Drive: OAuth2 (kuzy.vladimir@gmail.com)
- Telegram: Bot Token

## Error Handling
- HTTP retry 3x с 5 сек задержкой (Veeqo), 2x (Google)
- Error Trigger → Telegram + log в Google Sheets "Errors" tab

## Связанные файлы
- `docs/N8N_SHIPPING_ARCHITECTURE_v1.1.md` — полная архитектура

## 🔗 Связи
- **Реализует:** [Shipping Labels](shipping-labels.md)
- **Использует:** [Veeqo API](veeqo-api.md), [SKU Database](google-sheets-sku-db.md), [Telegram](telegram-notifications.md)
- **Алгоритмы:** [Выбор ставки](shipping-rate-selection.md), [Бюджет](budget-check-algorithm.md), [Weekend распределение](weekend-distribution.md), [Frozen/Dry классификация](frozen-dry-classification.md)
- **См. также:** [Timezone правила](timezone-rules.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
