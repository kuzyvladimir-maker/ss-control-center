# 🚛 Carrier Selection Rules

> **Полный канон выбора тарифа:** [shipping-rate-selection.md](shipping-rate-selection.md).

## Суть
Действующие правила по перевозчикам при выборе и покупке shipping labels.

## Действующие правила (на 2026-11-27)
- **Нет запретов и преференций по перевозчикам.** UPS, FedEx и USPS участвуют на равных во всех режимах (`DRY`, `FROZEN`, `CHILLED`), если тариф укладывается в дедлайн маркетплейса (`EDD <= deliveryBy`) и разрешённое холодовое окно (`calDays <= allowedDays`).
- **Next Day / Overnight / Priority Mail Express:** никогда не покупаются автоматически в `Live`-режиме (только ручной выбор оператора в `PickRateDialog`).
- **Внутри разрешённого окна (`Live`):** побеждает **самый дешёвый** тариф (`SPEED_TOLERANCE_USD = 0`); более быстрый выигрывает только при точном совпадении цены. (В откате `Summer` v3.5 для Frozen действует абсолютный порог `≤ +$3` за более быструю доставку.)
- **FedEx после 11:00 ET (`16:00Z`) на `shipDate = today`:** Rate Shopping API Veeqo перестаёт отдавать FedEx после 11:00 ET, поэтому `rates/route.ts` и `plan/route.ts` домердживают отсутствующие сервисы из Allocation Pool (`mergeMissingRates`).

## FedEx One Rate
- **Канонический множитель веса: `+20%` (`×1.20`)** (подтверждено владельцем 2026-06-09 и 2026-11-27).
- Применяется автоматически ко всем сервисам, чьё название содержит `"one rate"`, при пуше веса в Veeqo (`updateAllocationPackage`) и при перекотировке в плане. В каталоге/на карточке отображается базовый вес.
- Старая колонка Google Sheets `K = H × 1.25` **отменена**.

## Claims Protected Badge
- Этикетки Amazon, купленные через Veeqo (Amazon Buy Shipping V2), получают защиту от A-to-Z claims по задержке/потере перевозчиком (Claims Protected).
- Этикетки Walmart, купленные через Ship with Walmart (SWW), получают защиту Walmart от delivery defects (поэтому покупка Walmart через Veeqo запрещена по умолчанию).

## ❌ Отменённые правила (история)
Следующие правила из старого `MASTER_PROMPT v3.1` **больше не действуют** и не должны возвращаться:
- ~~UPS предпочтительнее при разнице ≤10% от самого дешёвого~~ — **отменено 2026-05-14**.
- ~~После 12:00 ET убрать USPS (Dry)~~ — **отменено 2026-05-14**.
- ~~При разнице ≤$0.50 выбрать более ранний EDD~~ — **отменено 2026-06-12** (в `Live` порог `$0`, в `Summer` v3.5 — `$3`).
- ~~Среда: убрать Ground; Пятница: убрать FedEx Express~~ — **отменено 2026-06-12** (v3.5).
- ~~Запрет Ground Saver / Ground Economy / tender-to-USPS для Frozen~~ — **отменено 2026-06-12** (v3.5).
- ~~FedEx One Rate = `×1.25`~~ — **отменено** (заменено на `+20%` / `×1.20`).

## 🔗 Связи
- **Канон:** [Выбор ставки (канон)](shipping-rate-selection.md)
- **Используется в:** [Shipping Labels](shipping-labels.md)
- **Связан с:** [A-to-Z & Chargeback](atoz-chargeback.md) (Claims Protected), [Pick rate missing FedEx today](shipping-pick-rate-missing-fedex-today-2026-11-20.md)

## История
- 2026-11-27: Статья обновлена под актуальный код: старые правила v3.1 явно отмечены как отменённые, закреплён коэффициент FedEx One Rate `+20%` (`×1.20`), добавлена ссылка на единый канон.
- 2026-06-12: Master Prompt v3.5 снял запреты Wed Ground, Fri FedEx Express и Ground Saver/Economy.
- 2026-05-14: Отменены 12:00 ET USPS cutoff и ≤10% UPS preference.
- 2026-04-10: Wiki-статья создана при полной индексации проекта.
