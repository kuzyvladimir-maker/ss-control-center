# 💰 Budget Check Algorithm

## Суть
Проверка стоимости shipping label против бюджета. Если label дороже лимита → СТОП ("на ревью").

## Абсолютный лимит
Label cost > 50% от (orderTotal + shippingCharged) → СТОП для всех каналов/типов.

## Формулы по каналу/типу
| Канал | Тип | Формула | Минимум |
|-------|-----|---------|---------|
| Walmart | Dry | 10% × margin + shippingCharged | $10 |
| Amazon | Frozen | 15% × margin + shippingCharged | $15 |
| Amazon | Dry | 15% × margin + shippingCharged | $10 |

Где `margin = orderTotal - shippingCharged`.

## Связанные файлы
- `docs/MASTER_PROMPT_v3.1.md` — секция "Check Budget"
- `docs/N8N_SHIPPING_ARCHITECTURE_v1.1.md` — нод 12

## 🔗 Связи
- **Часть:** [Shipping Labels](shipping-labels.md)
- **Следует после:** [Выбор ставки](shipping-rate-selection.md)
- **См. также:** [Walmart ограничения](walmart-restrictions.md) (отдельный % бюджета)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
