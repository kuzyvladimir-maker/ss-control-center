# 🏷️ Frozen/Dry классификация

## Суть
Определение типа товара (Frozen или Dry) — критично для выбора carrier/service и бизнес-правил. Единственный источник — теги Veeqo на продукте.

## Правила
1. **Walmart = всегда Dry** (frozen на Walmart ЗАПРЕЩЁН). Если обнаружен тег Frozen на Walmart → ошибка → СТОП
2. **Amazon = по тегу Veeqo:** `frozen` → Frozen, `dry` → Dry
3. **Нет тега → СТОП** с сообщением "нужна информация"
4. **Mixed order (Frozen + Dry в одном)** → СТОП

## ⚠️ Никогда не угадывать тип — только по тегам!

## Fallback
`ProductTypeOverride` в DB — ручное переопределение по Veeqo product ID.

## Связанные файлы
- `docs/MASTER_PROMPT_v3.1.md` — секция "Classify Frozen/Dry"
- `docs/N8N_SHIPPING_ARCHITECTURE_v1.1.md` — нод 9
- `prisma/schema.prisma` — `ProductTypeOverride`

## 🔗 Связи
- **Используется в:** [Shipping Labels](shipping-labels.md), [Выбор ставки](shipping-rate-selection.md), [Бюджет](budget-check-algorithm.md)
- **Зависит от:** [Veeqo API](veeqo-api.md) (product tags)
- **Связан с:** [Frozen Analytics](frozen-analytics.md), [Frozen shipping rules](frozen-shipping-rules.md), [Walmart ограничения](walmart-restrictions.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
