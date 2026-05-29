# 💸 Shipping Adjustments Monitor — v2.0
## 2026-05-29

> Полная переработка модуля. Старая версия (v1.0, 2026-04-07) описывала
> намерения; ничего не работало end-to-end. v2.0 — то, что реально
> крутится в проде после Phase A–F.

---

## 🎯 ЧТО ДЕЛАЕТ МОДУЛЬ

Маркетплейсы автоматически перемеряют посылки на своих складах и при
расхождении с заявленными размерами/весом доначисляют (или возвращают)
деньги — **Shipping Adjustment**. Модуль:

1. **Тянет adjustments** из Amazon SP-API и Walmart Marketplace API
   автоматически (cron) + по кнопке «Sync now».
2. **Привязывает** каждый adjustment к конкретному order и SKU там,
   где данные позволяют (Settlement Reports → 91% order coverage, 56%
   SKU coverage).
3. **Агрегирует по SKU** в `SkuAdjustmentProfile`: total потерь,
   средний amount, чаще всего тип ошибки, нужно ли править SKU
   Database (≥3 корректировки = `needsSkuDbUpdate=true`).
4. **Показывает на /adjustments** — KPI cards (за месяц, за 30 дней,
   Amazon, Walmart), таблица всех adjustments, SKU Issues панель,
   Sync history панель.

---

## 🔌 ИСТОЧНИКИ ДАННЫХ

### Amazon

| Источник | Endpoint | Что даёт | Когда |
|---|---|---|---|
| **Financial Events** | `/finances/v0/financialEvents` | Свежие adjustments в real-time. **Нет** order-id / SKU. | Каждый запуск Sync (~5-10s) |
| **Settlement Reports** | `/reports/2021-06-30/reports` (V2 TSV) | Те же события + order-id + SKU lookup. | Каждый запуск Sync (~30-60s) |

**Реальные Amazon AdjustmentType строки** (15+ типов, фильтруются по
`ADJUSTMENT_TYPE_MAP`):

| Amazon raw | Наш display type |
|---|---|
| `PostageBilling_PostageAdjustment` | `WeightAdjustment` ← основной (carrier reweigh) |
| `PostageRefund_PostageAdjustment` | `WeightAdjustmentRefund` |
| `ReturnPostageBilling_*` (8 sub-types) | `ReturnShipping` |

> До Phase A парсер фильтровал по трём вымышленным строкам
> (`ShippingChargeback / CarrierAdjustment / WeightAdjustment`) — ни
> одна не существует в реальном API. Поэтому каждый scan возвращал 0.

### Walmart

| Источник | Endpoint | Что даёт |
|---|---|---|
| **Recon reports** | `/v3/report/reconreport/reconFile` | Все транзакции (sales, refunds, adjustments, fees). Adjustment-rows зеркалятся в `ShippingAdjustment` с `channel='Walmart'`. |

### Banned/suspended аккаунты

- **STORE2** (Personal) — skip (403 на SP-API).
- **STORE5** (Retailer, US-suspended) — включён, API всё ещё отвечает.

---

## 🗄️ DB МОДЕЛИ

### `ShippingAdjustment` — одна строка на одну корректировку

```
id, createdAt, externalId (@unique), channel (Amazon|Walmart),
storeId, currency, orderId?, amazonOrderId?, walmartOrderId?,
adjustmentDate, adjustmentType, adjustmentAmount, adjustmentReason,
rawType, sku?, productName?, carrier?, service?,
declaredWeightLbs?, declaredDimL/W/H?, originalLabelCost?,
adjustedWeightLbs?, adjustedDimL/W/H?,
reviewed, skuDataFixed, notes
```

**ExternalId формула** (одинаковая для Financial Events и Settlement):
```
amazon:<storeId>:<rawType>:<isoPostedDate>:<amountCents>
walmart:<storeIdx>:<txType>:<poId>:<isoTimestamp>:<amountCents>
```
Это позволяет Settlement-row **upsert-обогащать** существующую
Financial-Events-row order-id и SKU, а не дублировать.

### `SkuAdjustmentProfile` — агрегация по SKU

Один row на уникальный SKU из ShippingAdjustment. Поля:
`totalAdjustments, totalAmountLost, avgAdjustmentAmount,
mostCommonType, needsSkuDbUpdate, suggestedWeight,
lastAdjustmentDate, channel`.

**Триггеры пересборки:** каждый scan (`scan` / `settlement-sync` /
`walmart/sync`) вызывает `rebuildSkuProfilesFor()` для тронутых SKU.

### `WalmartReconTransaction` — полный ledger Walmart recon

Все типы транзакций (Sales, Refunds, Adjustments, Fees). Не отображается
на /adjustments — только adjustment-rows зеркалятся туда.

### `SyncLog` — история запусков

Каждый sync endpoint пишет row на старте, апдейтит на конце. Используется
для панели "Sync history" на странице. jobName-prefixes:
- `adjustments-amazon-scan`
- `adjustments-amazon-settlement`
- `adjustments-walmart`
- `adjustments-amazon` (cron — обе фазы Amazon)

---

## 🔄 ЗАПУСК

### Вручную — кнопка «Sync now»

3-step flow на странице `/adjustments`:
1. Amazon Financial Events (~5-10s) — POST `/api/adjustments/scan`
2. Amazon Settlement Reports (~30-60s) — POST `/api/adjustments/settlement-sync`
3. Walmart Recon (~10-30s, capped 8 dates) — POST `/api/adjustments/walmart/sync`

Прогресс показывается в баннере под header-ом. Walmart-failure
не валит весь sync.

### Автоматически — cron

В `vercel.json`:
- `/api/cron/walmart` — 06:00 UTC (Walmart recon + catalog + orders)
- `/api/cron/adjustments-amazon` — 08:30 UTC (Amazon FE + Settlement)

CRON_SECRET-gated.

---

## 📊 КАК ЧИТАТЬ СТРАНИЦУ /adjustments

| Элемент | Источник |
|---|---|
| Sidebar pill "Adjustments" | `s.adjustments.unreviewed` (30d unreviewed count) |
| KPI "This month" | sum of `adjustmentAmount` где createdAt ≥ monthStart |
| KPI "Last 30 days" | sum of `adjustmentAmount` где createdAt ≥ 30d ago |
| KPI "Amazon" / "Walmart" | sum by channel |
| Banner "N SKUs with systematic issues" | count `SkuAdjustmentProfile.needsSkuDbUpdate=true` |
| FilterTabs (All/Amazon/Walmart) | client-side filter |
| Shipping adjustments table | `/api/adjustments?channel&days&sku` |
| SKU issues panel | `/api/adjustments/sku-profiles` (с needsSkuDbUpdate=true) |
| Sync history panel | `/api/adjustments/sync-log` (последние 10 SyncLog) |

---

## 🧪 ТЕКУЩЕЕ СОСТОЯНИЕ (2026-05-29 после Phase F smoke)

```
ShippingAdjustment:        196 rows (0 reviewed)
SkuAdjustmentProfile:       54 rows (10 нуждаются в SKU-DB update)
```

| Тип | Кол-во | Сумма |
|---|---|---|
| WeightAdjustment | 158 | -$961.80 |
| WeightAdjustmentRefund | 33 | +$516.62 |
| ReturnShipping | 5 | -$6.90 |
| **Net** | **196** | **-$452.08** |

**Coverage:**
- 91% rows имеют orderId (Settlement Reports vs Financial Events alone)
- 56% rows имеют SKU (two-pass orderToSku across all settlement TSVs)

---

## 🚧 ИЗВЕСТНЫЕ ОГРАНИЧЕНИЯ

1. **44% rows без SKU** — это adjustments для orders из settlement
   периодов которые мы ещё не выкачали (Settlement Reports эмитятся
   раз в 1-2 недели; cron работает с 60d окна).
2. **Walmart recon — пустой** — у Vladimir-а последние доступные
   recon-dates 2025-07. Плумбинг работает; данные начнут падать когда
   Walmart возобновит recon emits.
3. **Carrier/service/declared-dims fields пусты** — Amazon SP-API не
   отдаёт original carrier/service на adjustment-event. Нужна
   отдельная интеграция с Buy Shipping API V2 (вне scope Phase A-F).
4. **CSV upload** — не реализован. Если нужен manual backfill из
   Excel — отдельная задача.

---

## 📂 КЛЮЧЕВЫЕ ФАЙЛЫ

```
src/lib/amazon-sp-api/finances.ts            — parseAdjustments + buildAdjustmentExternalId
src/lib/amazon-sp-api/settlement-reports.ts  — Settlement TSV → adjustments
src/lib/adjustments/sku-profiles.ts          — rebuildSkuProfilesFor / rebuildAll
src/app/api/adjustments/scan/route.ts        — POST Financial Events scan
src/app/api/adjustments/settlement-sync/     — POST Settlement Reports sync
src/app/api/adjustments/walmart/sync/        — POST Walmart recon sync
src/app/api/adjustments/sync-log/route.ts    — GET sync history
src/app/api/cron/adjustments-amazon/         — Daily cron
src/app/adjustments/page.tsx                 — UI page
prisma/migrations/20260529000000_adjustments_phase_a_real_types/
scripts/turso-migrate-adjustments-phase-a.mjs — Turso runner
```

---

## 📜 HISTORY

- **v1.0** — 2026-04-07 — initial spec
- **v2.0** — 2026-05-29 — Phase A–F полная переработка после
  read-only диагностики 2026-05-22 (`ADJUSTMENTS_DIAGNOSIS_REPORT_2026-05-22.md`)
