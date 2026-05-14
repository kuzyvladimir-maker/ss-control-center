# 🎯 Алгоритм выбора ставки (Rate Selection)

## Суть
Ключевой алгоритм Shipping Labels — выбор лучшего carrier/service из доступных ставок Veeqo. Логика различается для Dry и Frozen товаров.

## Dry товары
1. Фильтр: EDD ≤ Delivery By (дедлайн)
2. Сортировка по цене → берём самый дешёвый

> ⚠️ Решение 2026-05-14: убраны два правила из MASTER_PROMPT v3.1
> — *12:00 ET cutoff для USPS* и *≤10% предпочтение UPS*. Оператор
> сам видит весь список альтернатив и решает по carrier reliability /
> cut-off. Алгоритм остаётся "cheapest meets deadline".

## Frozen товары
1. Фильтр: calendar days ≤ 3 И EDD ≤ Delivery By
2. Среда → убрать Ground (5 кал. дней = не успеет)
3. Пятница → убрать FedEx Express
4. Сортировка по цене
5. **Правило ~10%:** чуть дороже но на 1-2 дня быстрее → предпочтительнее
6. **Правило ≤$0.50:** при близкой цене → более ранний EDD
7. **Ship Date Trick** (автоматический) — если сегодня нет ставок ИЛИ
   лучшая ставка содержит Saturday surcharge: временно ставим
   `dispatch_date = next Monday` в Veeqo, переzaprosиваем `/shipping/rates`,
   сравниваем цену. Если понедельник дешевле → выбираем его и
   `actualShipDay` записывается как понедельник. Veeqo `dispatch_date`
   восстанавливается обратно к исходному значению до момента покупки.
   В момент покупки в `/api/shipping/buy` дата снова сдвигается на
   понедельник (постоянно), а в employee note добавляется
   `📅 SHIP ON YYYY-MM-DD`. См. [Ship Date Trick](ship-date-trick.md).

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
- 2026-05-14: Dry — удалены правила "12:00 ET USPS" и "≤10% UPS"
  (решение Владимира). Frozen — Ship Date Trick реализован полностью
  (раньше был "Handle manually"); триггерится не только при отсутствии
  ставок, но и при Saturday-surcharge в лучшей ставке.
