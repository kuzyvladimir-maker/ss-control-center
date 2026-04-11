# 📅 Weekend Distribution (Frozen)

## Суть
Распределение Frozen заказов, накопленных за Пт+Сб+Вс, на отгрузку в Пн и Вт. Цель — равномерная нагрузка и соблюдение дедлайнов.

## Алгоритм
1. Сбор Frozen заказов за Пт+Сб+Вс
2. Сортировка по Delivery By (срочные первые)
3. Split 50/50: первая половина → Пн, вторая → Вт
4. Валидация: если вторничный заказ не успевает (EDD от Вт > Delivery By) → перенести в Пн
5. Обновить dispatch_date в Veeqo

## Ship Date Trick
Для Чт/Пт Frozen когда нет подходящих ставок:
1. Запомнить original Ship Date
2. Временно поставить Ship Date = Monday
3. Получить ставки от Monday
4. **Вернуть Ship Date обратно** (КРИТИЧНО!)
5. Купить label с rate от понедельника но Ship Date = Чт/Пт

## Связанные файлы
- `docs/N8N_SHIPPING_ARCHITECTURE_v1.1.md` — Workflow 3 + Sub-workflow 2.5

## 🔗 Связи
- **Часть:** [Shipping Labels](shipping-labels.md), [n8n Автоматизация](n8n-automation.md)
- **Зависит от:** [Frozen/Dry классификация](frozen-dry-classification.md), [Timezone правила](timezone-rules.md)
- **Связан с:** [Frozen shipping rules](frozen-shipping-rules.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
