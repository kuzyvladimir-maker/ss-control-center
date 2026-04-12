# 🚚 Shipping Labels — Модуль

## Суть
Самый зрелый модуль системы (810+ строк алгоритма). Автоматическая генерация плана покупки shipping labels через Veeqo для заказов Amazon и Walmart. Процесс: сбор заказов → анализ → план в Google Sheets → одобрение Владимира → покупка → PDF в Google Drive.

## Путь в приложении
`/shipping`

## Workflow
1. **Сбор заказов** — Veeqo API, фильтр `awaiting_fulfillment` + тег `Placed` + Ship By = сегодня
2. **Классификация** — Frozen/Dry по тегам Veeqo (см. [Frozen/Dry классификация](frozen-dry-classification.md))
3. **Lookup веса** — Google Sheets SKU Database v2 → fallback на историю Veeqo
4. **Получение ставок** — Veeqo GET /shipping/rates/
5. **Выбор лучшей ставки** — алгоритм (см. [Выбор ставки](shipping-rate-selection.md))
6. **Проверка бюджета** — формулы по каналу/типу (см. [Бюджет](budget-check-algorithm.md))
7. **План** — запись в Google Sheets, уведомление в Telegram
8. **Покупка** — после команды "покупай" от Владимира
9. **Сохранение PDF** — Google Drive, структура `MM Month / DD / Channel /`

## Ключевые бизнес-правила
- Walmart в weekend → НЕ покупать (Veeqo шлёт Mark as Shipped)
- Mixed orders (Frozen+Dry) → СТОП
- Без тега Frozen/Dry → СТОП
- VAS поле обязательно при покупке
- Employee notes = защита от дублей ("Label Purchased")

## Связанные файлы
- `src/app/shipping/page.tsx` — UI страница
- `src/app/api/shipping/` — API routes (plan, buy, fix-sku, fix-tag)
- `src/lib/veeqo.ts` — Veeqo API клиент
- `src/lib/google-sheets.ts` — SKU Database lookup
- `docs/MASTER_PROMPT_v3.1.md` — полный алгоритм
- `docs/N8N_SHIPPING_ARCHITECTURE_v1.1.md` — n8n реализация

## 🔗 Связи
- **Зависит от:** [Veeqo API](veeqo-api.md), [SKU Database](google-sheets-sku-db.md), [Timezone правила](timezone-rules.md), [Frozen/Dry классификация](frozen-dry-classification.md)
- **Используется в:** [Dashboard](dashboard.md), [n8n Автоматизация](n8n-automation.md)
- **Связанные модули:** [Frozen Analytics](frozen-analytics.md), [Adjustments Monitor](adjustments-monitor.md), [Amazon Notifications Map](amazon-notifications-map.md) (FBA Inbound Problems, Merchant Order backup alerts)
- **Алгоритмы:** [Выбор ставки](shipping-rate-selection.md), [Бюджет](budget-check-algorithm.md), [Weekend распределение](weekend-distribution.md), [Правила carrier](carrier-selection-rules.md)
- **См. также:** [Walmart ограничения](walmart-restrictions.md), [Формат имени PDF](label-filename-format.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
