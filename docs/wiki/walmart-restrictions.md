# 🏪 Walmart ограничения

## Суть
Специфические правила для Walmart, отличающиеся от Amazon.

## Правила
1. **Frozen на Walmart ЗАПРЕЩЁН.** Если обнаружен тег Frozen → ошибка → СТОП
2. **Walmart = всегда Dry** (автоматическая классификация)
3. **Weekend: НЕ покупать labels.** Veeqo сразу шлёт Mark as Shipped → ломает статистику
4. **Бюджет: 10%** (vs 15% на Amazon)
5. **Walmart API ключ** — получен 2026-04-18 (1 аккаунт: SIRIUS TRADING INTERNATIONAL LLC). См. [Walmart Marketplace API](walmart-api.md)

## 🔗 Связи
- **Используется в:** [Shipping Labels](shipping-labels.md), [Frozen/Dry классификация](frozen-dry-classification.md), [Бюджет](budget-check-algorithm.md)
- **См. также:** [Customer Hub](customer-hub.md) (Walmart временно через скриншоты)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
- 2026-04-18: API ключ получен. Вынесли техническую часть в [walmart-api.md](walmart-api.md). Эта статья остается source of truth по бизнес-правилам (no frozen, no weekend, 10% budget)
