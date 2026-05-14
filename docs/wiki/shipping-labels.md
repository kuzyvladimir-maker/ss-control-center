# 🚚 Shipping Labels — Модуль

## Суть
Самый зрелый модуль системы (810+ строк алгоритма). Автоматическая генерация плана покупки shipping labels через Veeqo для заказов Amazon и Walmart. Процесс: сбор заказов → анализ → план в Google Sheets → одобрение Владимира → покупка → PDF в Google Drive.

## Путь в приложении
`/shipping`

## Workflow
1. **Сбор заказов** — Veeqo API, фильтр `awaiting_fulfillment` + тег `Placed` + Ship By = сегодня
2. **Классификация** — Frozen/Dry по тегам Veeqo (см. [Frozen/Dry классификация](frozen-dry-classification.md))
3. **Lookup веса** — внутренняя БД `SkuShippingData` (миграция из Google Sheets 2026-05-12, см. [sku-database-migration](sku-database-migration.md)) → fallback на `PackingProfile` для multi-item заказов
4. **Получение ставок** — Veeqo GET /shipping/rates/
5. **Выбор лучшей ставки** — алгоритм (см. [Выбор ставки](shipping-rate-selection.md)), для Frozen — [Ship Date Trick](ship-date-trick.md)
6. **Проверка бюджета** — формулы по каналу/типу (см. [Бюджет](budget-check-algorithm.md))
7. **План** — запись в Prisma `ShippingPlan` + `ShippingPlanItem`. Уведомления в Telegram (план + результат покупки).
8. **Покупка** — кнопка "Buy label" per-row или bulk через "Buy selected"
9. **Re-fetch rates** перед покупкой → извлечение VAS из `rate.shipping_service_options[]` (см. [veeqo-api-quirks §7](veeqo-api-quirks.md))
10. **Persistence PDF** — Google Drive (preferred) → local disk (dev) → Veeqo `label_url` (fallback). См. [google-drive-setup](google-drive-setup.md)
11. **Post-buy modal** — обязательный отчёт со счётчиками Bought / PDF saved / Failed + tracking + per-order ошибки. Audit-лог в `logs/shipping-buy.jsonl`.

## Ключевые бизнес-правила
- Walmart в weekend → НЕ покупать (Veeqo шлёт Mark as Shipped)
- Mixed orders (Frozen+Dry) → СТОП
- Без тега Frozen/Dry → СТОП
- VAS — **не хардкод**, читать из `rate.shipping_service_options[]` (USPS Ground Advantage требует `DELIVERY_CONFIRMATION`, не `NO_CONFIRMATION`, см. [veeqo-api-quirks §7](veeqo-api-quirks.md))
- Employee notes = защита от дублей ("Label Purchased")
- `tracking_number` может быть объектом, не строкой → `pickTrackingString()` ([veeqo-api-quirks §8](veeqo-api-quirks.md))

## Связанные файлы
- `src/app/shipping/page.tsx` — UI страница с per-row и bulk Buy, post-buy modal `BuyReportDialog`
- `src/app/api/shipping/plan/route.ts` — формирование плана + Ship Date Trick
- `src/app/api/shipping/buy/route.ts` — покупка с re-fetch rates, VAS extraction, 3-layer PDF persistence, audit log
- `src/lib/veeqo/client.ts` — `buyShippingLabel`, `getShippingRates`, `extractVasFromRate`, `updateOrderDispatchDate`
- `src/lib/google-drive.ts` — service-account upload PDF этикеток
- `src/lib/sku-database.ts` — SKU lookup в Prisma `SkuShippingData`
- `docs/MASTER_PROMPT_v3.1.md` — оригинальный алгоритм (часть данных устарела — см. предупреждения в самом файле)
- `docs/N8N_SHIPPING_ARCHITECTURE_v1.1.md` — старая n8n реализация (заменена Next.js приложением)

## 🔗 Связи
- **Зависит от:** [Veeqo API](veeqo-api.md), [SKU Database](google-sheets-sku-db.md), [Timezone правила](timezone-rules.md), [Frozen/Dry классификация](frozen-dry-classification.md)
- **Используется в:** [Dashboard](dashboard.md), [n8n Автоматизация](n8n-automation.md)
- **Связанные модули:** [Frozen Analytics](frozen-analytics.md), [Adjustments Monitor](adjustments-monitor.md), [Amazon Notifications Map](amazon-notifications-map.md) (FBA Inbound Problems, Merchant Order backup alerts)
- **Алгоритмы:** [Выбор ставки](shipping-rate-selection.md), [Бюджет](budget-check-algorithm.md), [Weekend распределение](weekend-distribution.md), [Правила carrier](carrier-selection-rules.md)
- **См. также:** [Walmart ограничения](walmart-restrictions.md), [Формат имени PDF](label-filename-format.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
- 2026-05-12: SKU migration Google Sheets → внутренняя БД (см. [sku-database-migration](sku-database-migration.md))
- 2026-05-14: Sprint покупки этикеток в продакшене
  - Ship Date Trick реализован (был "Handle manually") — см. [ship-date-trick](ship-date-trick.md)
  - VAS читается из живого rate (`shipping_service_options`), а не хардкод — [veeqo-api-quirks §7](veeqo-api-quirks.md)
  - `tracking_number` object-shape — [veeqo-api-quirks §8](veeqo-api-quirks.md)
  - Post-buy modal + audit log — [veeqo-api-quirks §9](veeqo-api-quirks.md)
  - Google Drive upload реализован в ss-control-center (раньше работал только n8n) — [google-drive-setup](google-drive-setup.md), [veeqo-api-quirks §10](veeqo-api-quirks.md)
  - Dry-правила выбора ставки упрощены (убраны 12pm USPS cutoff и 10% UPS prefer) — [shipping-rate-selection](shipping-rate-selection.md)
