# 🎯 Алгоритм выбора ставки (Rate Selection)

## Суть
Ключевой алгоритм Shipping Labels — выбор лучшего carrier/service из доступных ставок Veeqo. Логика различается для Dry и Frozen товаров.

## Dry товары
1. Фильтр: EDD ≤ Delivery By (дедлайн)
2. После 12:00 ET → убрать USPS если есть альтернативы
3. Сортировка по цене (дешевле = лучше)
4. **Правило ≤10%:** если UPS на ≤10% дороже самого дешёвого → выбрать UPS
5. **Правило ≤$0.50:** при разнице ≤50¢ → выбрать более ранний EDD

## Frozen товары
1. Фильтр: calendar days ≤ 3 И EDD ≤ Delivery By
2. Среда → убрать Ground (5 кал. дней = не успеет)
3. Пятница → убрать FedEx Express
4. Сортировка по цене
5. **Правило ~10%:** чуть дороже но на 1-2 дня быстрее → предпочтительнее
6. **Правило ≤$0.50:** при близкой цене → более ранний EDD
7. Нет ставок в Чт/Пт → Ship Date Trick (см. [Weekend распределение](weekend-distribution.md))

## Связанные файлы
- `docs/MASTER_PROMPT_v3.1.md` — секция "Select Best Rate"
- `docs/N8N_SHIPPING_ARCHITECTURE_v1.1.md` — нод "Select Best Rate"

## 🔗 Связи
- **Часть:** [Shipping Labels](shipping-labels.md)
- **Зависит от:** [Timezone правила](timezone-rules.md), [Frozen/Dry классификация](frozen-dry-classification.md)
- **Связан с:** [Carrier selection rules](carrier-selection-rules.md), [Budget check](budget-check-algorithm.md)
- **См. также:** [Veeqo API](veeqo-api.md) (GET /shipping/rates/)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
