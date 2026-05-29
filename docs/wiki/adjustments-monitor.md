# 💸 Adjustments Monitor — Модуль

## Суть
Мониторинг shipping adjustments — доп. чарджи и возвраты от Amazon/Walmart
за расхождение заявленных и фактических размеров/веса посылок. Выявляет
системные проблемы по SKU (3+ корректировки → "needsSkuDbUpdate"),
показывает суммарные потери, ведёт sync history.

## Путь в приложении
`/adjustments` — **полностью рабочий** (после Phase A–F, 2026-05-29)

## Текущие данные (2026-05-29)
- 196 ShippingAdjustment rows (91% с orderId, 56% с SKU)
- 54 SkuAdjustmentProfile (10 нуждаются в SKU-DB update)
- WeightAdjustment $-961.80 за 60d, Refund +$516.62, ReturnShipping $-6.90

## Источники
- **Amazon Financial Events** (`/finances/v0/financialEvents`) — real-time
- **Amazon Settlement Reports** (`/reports/2021-06-30/...V2_FLAT_FILE_V2`)
  — order-id + SKU линковка
- **Walmart Recon** (`/v3/report/reconreport/reconFile`) — adjustments
  зеркалятся в ShippingAdjustment с channel='Walmart'

## Запуск
- **Вручную:** кнопка "Sync now" на /adjustments (3-step, ~30-90s)
- **Auto:** cron `/api/cron/adjustments-amazon` каждый день 08:30 UTC

## SKU Adjustment Profiles
Агрегация по SKU. `needsSkuDbUpdate=true` если ≥3 корректировок.
Пересборка автоматическая при каждом scan для тронутых SKU.

## Sync History
Панель внизу страницы показывает 10 последних SyncLog entries:
started · jobName · status · items · duration.

## DB модели
- `ShippingAdjustment` — отдельные adjustments (unified Amazon + Walmart)
- `SkuAdjustmentProfile` — профили по SKU
- `WalmartReconTransaction` — полный Walmart recon ledger
- `SyncLog` — история запусков (jobName starts with "adjustments-")

## Ключевые файлы
- `src/lib/amazon-sp-api/finances.ts` — parseAdjustments + buildAdjustmentExternalId
- `src/lib/amazon-sp-api/settlement-reports.ts` — Settlement TSV parser
- `src/lib/adjustments/sku-profiles.ts` — rebuildSkuProfilesFor
- `src/app/adjustments/page.tsx` — UI page (Sync button, KPIs, table, panels)
- `src/app/api/adjustments/scan|settlement-sync|walmart/sync|sync-log/` — API
- `src/app/api/cron/adjustments-amazon/` — daily cron
- `docs/ADJUSTMENTS_MONITOR_v2.0.md` — полная актуальная спецификация

## 🔗 Связи
- **Зависит от:** [Amazon SP-API](amazon-sp-api.md) (Finances + Reports roles),
  [SKU Database](google-sheets-sku-db.md)
- **Используется в:** [Dashboard](dashboard.md) (`adjustments.monthlyTotal`,
  `adjustments.unreviewed` для сайдбара)
- **Связанные модули:** [Shipping Labels](shipping-labels.md),
  [Walmart Returns](../wiki/walmart-returns.md) (recon overlap)
- **См. также:** [Database Schema](database-schema.md),
  [Diagnosis report (read-only audit before fix)](../ADJUSTMENTS_DIAGNOSIS_REPORT_2026-05-22.md)

## История
- 2026-04-07: v1.0 spec (`ADJUSTMENTS_MONITOR_v1.0.md`)
- 2026-04-10: wiki-статья создана
- 2026-05-22: read-only диагностика — модуль не работает (0 rows ever)
- 2026-05-29: **Phase A–F переработка** — модуль работает end-to-end
  (`ADJUSTMENTS_MONITOR_v2.0.md`)
