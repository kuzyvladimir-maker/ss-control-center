# 🚚 Shipping Labels — Модуль

## Суть
Модуль покупки shipping labels в SS Command Center (`/shipping`) для заказов Amazon, Walmart, NAN Health (Shopify), eBay, TikTok и объединённых заказов (Merged Orders). Процесс полностью работает внутри Next.js приложения: сбор заказов → 3-классовая температурная классификация → подбор упаковки и погоды → расчёт плана в БД (`ShippingPlan` / `ShippingPlanItem`) → ревью и ручные правки в UI → покупка → PDF в Google Drive и автопечать.

> **Единый канон алгоритма выбора тарифа и покупки:** [shipping-rate-selection.md](shipping-rate-selection.md).

## Путь в приложении
`/shipping`

## Даты на карточке заказа

Для заказов Amazon через Veeqo оператор может отдельно менять `Label` и `Ship` в шапке карточки и в `PickRateDialog`.

| Поле | Автоматическое значение | Что меняется при правке |
|---|---|---|
| **`Label`** (`labelDate`) | `computeLabelDate(shipBy)` — сегодня или следующий рабочий день начиная с 15:00 ET при `Ship by` позже сегодня | Дата покупки/печати этикетки для статистики Amazon (LSR). Тарифы остаются прежними. |
| **`Ship`** (`physicalShipDate`) | Совпадает с `Label` или переносится на понедельник по Monday-shift | Тарифы перекотируются на выбранную дату, обновляется транзит (`N days`). После покупки по этой дате выбирается папка PDF и указывается день отгрузки в Veeqo. |

Для Walmart доступно одно поле `Ship`. Этикетка покупается через SWW API, отметка `Shipped` выполняется отдельно.

## Workflow
1. **Сбор заказов** — Veeqo API, фильтр `status !== "shipped"` (статус Veeqo — источник истины, не append-only заметка) + `isProcurementPlaced` (тег `Placed` или все строки закуплены; для Shopify пропускается) + целевой `dispatch_date`.
2. **Классификация** — 3-классовый резолв `FROZEN / CHILLED / DRY` по приоритету `SkuTemperatureClass > ProductTypeOverride > Veeqo tag > FROZEN default`; в смешанном заказе побеждает самый строгий класс; Walmart всегда `DRY` с флагом конфликта (см. [Frozen/Dry/Chilled классификация](frozen-dry-classification.md)).
3. **Упаковка и вес** — внутренняя БД `SkuShippingData` (для single-item) и `PackingProfile` (для multi-item / `qty > 1`), с автозаполнением из истории отправленных заказов (`findShippedPackage`). Перед котировкой габариты/вес пушатся в Veeqo (`updateAllocationPackage`).
4. **Получение ставок** — для Amazon Frozen/Chilled через Rate Shopping API (`POST /shipping/api/v1/rates`, с мерджем Allocation Pool после 11:00 ET для `shipDate = today` и ретраем пустого пула); для Amazon Dry и прочих Veeqo-каналов — `GET /shipping/rates/{allocationId}`; для Walmart — Ship with Walmart (SWW); для NAN Health (Shopify) — серверные снапшоты `NanRateSnapshot`.
5. **Выбор лучшей ставки** — канонический алгоритм в [Выбор ставки](shipping-rate-selection.md) (профиль `Live` с погодной таблицей, кулерами, доп. льдом и летним полом; откат в 1 клик на `Summer` v3.5; для Frozen/Chilled — [Ship Date Trick](ship-date-trick.md)). Проверка процентного бюджета (`budgetMax`) **отменена** — см. [budget-check-algorithm.md](budget-check-algorithm.md).
6. **План** — запись в Prisma `ShippingPlan` и `ShippingPlanItem`. Оператор видит диагностику, погоду, кулер и доп. лёд, может отредактировать даты и выбрать тариф через `PickRateDialog`. Кнопка `clear` сбрасывает ручные даты и тариф и пересчитывает автоматический план.
7. **Покупка** — `Buy label` на карточке или массовая `Buy selected` (`BUY_CONCURRENCY = 4`). Для Veeqo `buildBuyOverrideWithDates` передаёт в `/api/shipping/buy` обе даты в `BuyOverride`, в том числе при правке только дат. После частичного сбоя массовой покупки `retainFailedOrderKeys` сохраняет тарифы и ручные даты (`labelDateByOrder` и `shipDateByOrder`) для некупленных заказов. Ручные правки очищаются только у успешно купленных. Walmart покупается через `/api/shipping/walmart/buy`, NAN Health — в Shopify.
8. **Перекотировка и покупка в Veeqo** — пуш финального веса (с учётом доп. льда и FedEx One Rate `+20%`), котировка по `physicalShipDate`, ретрай пустого пула, сопоставление через `matchLiveRate` и извлечение VAS из живого тарифа. Сервер применяет выбранную `labelDate` к `dispatch_date` в Veeqo перед `POST /shipping/shipments`, если дата в Veeqo отличается. Сама покупка — строго **1 POST, 0 retry**. Подробности в [каноне выбора тарифа, §7](shipping-rate-selection.md).
9. **Сохранение после покупки в Veeqo** — PDF сохраняется в Google Drive по `physicalShipDate` в [папку дня фактической отгрузки](label-filename-format.md). Резервные варианты — локальный диск в dev и proxy `/api/shipping/label-pdf`. В employee note добавляется `Label: <labelDate> · 📅 SHIP ON <physicalShipDate>` при разных датах или `Ship: <physicalShipDate>` при совпадении. В Turso в `ShippingPlanItem` фиксируются `labelDate`, `physicalShipDate` и `actualShipDay`.
10. **Post-buy modal** — обязательный отчёт `BuyReportDialog` со счётчиками Bought / PDF saved / Failed + tracking + per-order ошибки + автопечать DYMO. Audit-лог в `logs/shipping-buy.jsonl`.

## Ключевые бизнес-правила
- **Walmart в weekend** → не включать в план и не покупать.
- **Смешанные заказы (`Frozen + Dry`)** → **НЕ стоп**; весь заказ идёт по самому строгому классу (`FROZEN > CHILLED > DRY`).
- **Нет тега/класса** → в `Live` **НЕ стоп**; безопасный дефолт **`FROZEN`** с пометкой `unknown` на карточке.
- **Проверка бюджета (`budgetMax`)** → **отменена** (`budgetMax: null`).
- **FedEx One Rate** → вес этикетки **`+20%` (`×1.20`)**.
- **VAS** — не хардкод, читать из `rate.shipping_service_options[]` (USPS Ground Advantage требует `DELIVERY_CONFIRMATION`, `null` → без VAS-полей).
- **Защита от дублей** — статус заказа в Veeqo (`status === "shipped"`), а не append-only employee note `"Label Purchased"` (отменённая этикетка откатывает статус на `awaiting_fulfillment`).
- **`tracking_number`** может быть объектом, не строкой → `pickTrackingString()` ([veeqo-api-quirks §8](veeqo-api-quirks.md)).

## Связанные файлы
- `src/app/shipping/page.tsx` — UI страница с per-row и bulk Buy, переключателем `Summer / Shadow / Live`, `PickRateDialog`, `BuyReportDialog`
- `src/app/api/shipping/plan/route.ts` — формирование плана, погодный движок, Ship Date Trick
- `src/app/api/shipping/buy/route.ts` — покупка с пушем пакета, re-quote (`matchLiveRate`), VAS extraction, 3-layer PDF persistence, audit log
- `src/app/api/shipping/rates/route.ts` — живые тарифы для `PickRateDialog`
- `src/app/api/shipping/merge/rates/route.ts` и `merge/buy/route.ts` — объединённые заказы
- `src/lib/shipping/rate-selection.ts` и `src/lib/shipping/temp-class/*` — алгоритмы выбора ставки
- `src/lib/shipping/requote-match.ts`, `buy-override.ts`, `rate-pool-merge.ts` — перекотировка, ручные override, мердж пулов
- `src/lib/veeqo/client.ts` — `buyShippingLabel`, `getShippingRates`, `getRatesForShipDate`, `getRatesForLaterShipDay`, `extractVasFromRate`, `updateOrderDispatchDate`
- `src/lib/google-drive.ts` — service-account upload PDF этикеток
- `src/lib/sku-database.ts` — SKU lookup в Prisma `SkuShippingData`

## 🔗 Связи
- **Канон выбора тарифа:** [Выбор ставки (канон)](shipping-rate-selection.md)
- **Зависит от:** [Veeqo API](veeqo-api.md), [SKU Database](google-sheets-sku-db.md), [Timezone правила](timezone-rules.md), [Frozen/Dry/Chilled классификация](frozen-dry-classification.md)
- **Используется в:** [Dashboard](dashboard.md)
- **Связанные модули:** [Frozen Analytics](frozen-analytics.md), [Adjustments Monitor](adjustments-monitor.md), [Amazon Notifications Map](amazon-notifications-map.md)
- **Правила и детали:** [Ship Date Trick](ship-date-trick.md), [Frozen shipping rules](frozen-shipping-rules.md), [Правила carrier](carrier-selection-rules.md), [Frozen Risk Cap](shipping-frozen-risk-cap.md), [Walmart ограничения](walmart-restrictions.md), [Формат имени PDF](label-filename-format.md), [Производительность модуля](shipping-labels-performance-2026-07-30.md)
- **Архив:** [Бюджет (отменено)](budget-check-algorithm.md), [Weekend распределение (legacy n8n)](weekend-distribution.md)

## История
- 2026-11-27: Добавлены инструкции по независимой правке `Label` и `Ship`, сохранению ручных дат при ошибке массовой покупки и проверке папки PDF, заметки Veeqo и записи в Turso после покупки.
- 2026-11-27: Аудит и унификация документации (канон в [shipping-rate-selection.md](shipping-rate-selection.md)) + фиксы надёжности в проде: ретрай пустого пула Veeqo (`liveRatesCount=0`), мердж FedEx после 11:00 ET в `plan/route.ts`, проброс `quoteAnchorDay` в `Live`, перекотировка веса доп. льда и FedEx One Rate `+20%` в плане, сохранение `rateOverrides` при ошибке в `buySelected`, `matchLiveRate` + ретрай в `merge/buy`. Закреплены решения владельца: отмена `budgetMax`, FedEx One Rate = `+20%`, правила `Live` без изменений.
- 2026-11-20 — [Manual rate override refused at Buy: price guard used the plan price](shipping-manual-override-requote-price-2026-11-20.md)
- 2026-11-20 — [Pick rate missed FedEx on ship-today: past 16:00Z quote anchor](shipping-pick-rate-missing-fedex-today-2026-11-20.md)
- 2026-10-27: «Discard label» на карточках из поиска / Archive — отмена конкретной этикетки с проверкой у перевозчика, сухим режимом и одним вызовом на трек-номер; NAN — ссылка «Void label in Shopify»: [shipping-label-discard-archive-2026-10-27](shipping-label-discard-archive-2026-10-27.md)
- 2026-10-26 — [NAN Health (Shopify) rates from admin-UI snapshots](shipping-nan-health-rate-snapshots.md)
- 2026-10-26 — [Slowness: Prisma libsql adapter = one DB lock per client → pool](perf-prisma-libsql-mutex-2026-10-26.md)
- 2026-10-23 — [Temperature-aware rate selection: plan](frozen-weather-rate-selection-plan-2026-10-23.md) · [implementation & go-live](temp-class-rate-engine-implementation-2026-10-23.md)
- 2026-10-21 — [Package autofill from shipped history, Buy-after-Save zeros, our ship-by deadline](shipping-package-autofill-and-own-deadline-2026-10-21.md)
- 2026-08-04: «Жму Save в Package — ничего не меняется»: [shipping-edit-package-save-not-applying](shipping-edit-package-save-not-applying.md)
- 2026-07-30: Разбор скорости модуля: [shipping-labels-performance-2026-07-30](shipping-labels-performance-2026-07-30.md)
- 2026-05-14: Sprint покупки этикеток в продакшене (Ship Date Trick, VAS из живого rate, `tracking_number` object-shape, `BuyReportDialog` + audit log, Google Drive upload, упрощение Dry-правил).
- 2026-05-12: SKU migration Google Sheets → внутренняя БД (см. [sku-database-migration](sku-database-migration.md)).
- 2026-04-10: Wiki-статья создана при полной индексации проекта.
