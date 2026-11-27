# 📅 Weekend Distribution (Frozen) *(АРХИВ — legacy n8n)*

> **⛔ АРХИВ (legacy n8n):**
> Этот workflow из старой n8n-архитектуры **больше не используется** и заменён Next.js-модулем `/shipping`.
> Актуальный канон выбора тарифов, работы в выходные и Monday-shift: [shipping-rate-selection.md](shipping-rate-selection.md) и [ship-date-trick.md](ship-date-trick.md).

## Историческая справка (legacy n8n, не действует)

### Суть
Раньше в n8n планировалось распределение Frozen-заказов, накопленных за Пт+Сб+Вс, на отгрузку в Пн и Вт (50/50) с валидацией дедлайна и ручным обновлением `dispatch_date` в Veeqo.

### Старый алгоритм (архив)
1. Сбор Frozen-заказов за Пт+Сб+Вс.
2. Сортировка по Delivery By (срочные первые).
3. Split 50/50: первая половина → Пн, вторая → Вт.
4. Валидация: если вторничный заказ не успевает (EDD от Вт > Delivery By) → перенести в Пн.
5. Обновить `dispatch_date` в Veeqo.

### Старый Ship Date Trick (архив)
В legacy n8n сдвиг делался через временный `PUT dispatch_date = Monday → GET rates → restore`. В текущем Next.js-приложении этот механизм заменён на date-anchored Rate Shopping API (`POST /shipping/api/v1/rates`, см. [ship-date-trick.md](ship-date-trick.md)).

## Связанные файлы (архив)
- `docs/N8N_SHIPPING_ARCHITECTURE_v1.1.md` — Workflow 3 + Sub-workflow 2.5 (заменён Next.js)

## 🔗 Связи
- **Актуальный канон:** [Выбор ставки (канон)](shipping-rate-selection.md), [Ship Date Trick](ship-date-trick.md)
- **Часть:** [Shipping Labels](shipping-labels.md), [n8n Автоматизация](n8n-automation.md)

## История
- 2026-11-27: Помечено как **АРХИВ (legacy n8n)**, заменено Next.js `/shipping` и каноном [shipping-rate-selection.md](shipping-rate-selection.md).
- 2026-04-10: Wiki-статья создана при полной индексации проекта.
