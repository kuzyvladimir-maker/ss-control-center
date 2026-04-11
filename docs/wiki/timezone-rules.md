# ⏰ Timezone правила

## Суть
Железное правило: все даты из Veeqo конвертировать в UTC-7 (Pacific Time). "Сегодня" определяется по America/New_York.

## Конверсии
| Поле Veeqo | Конверсия | Результат |
|------------|-----------|-----------|
| `dispatch_date` | UTC → UTC-7 | Ship By (реальный) |
| `due_date` | UTC → UTC-7 | Deliver By (дедлайн Amazon) |
| `delivery_promise_date` | UTC → UTC-7 | EDD из рейта |

## "Сегодня"
Текущая дата по **America/New_York**. Используется для определения: какие заказы шипить, какой день недели (для Frozen правил), после полудня или нет (для USPS фильтра).

## Фактический день отгрузки
- Sunday → Monday
- Saturday → Monday
- Остальные дни → сегодня

## ⚠️ Никогда не брать даты из Veeqo без конвертации!

## 🔗 Связи
- **Используется в:** [Shipping Labels](shipping-labels.md), [Выбор ставки](shipping-rate-selection.md), [n8n Автоматизация](n8n-automation.md), [Weekend распределение](weekend-distribution.md)
- **Зависит от:** [Veeqo API](veeqo-api.md) (источник UTC дат)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
