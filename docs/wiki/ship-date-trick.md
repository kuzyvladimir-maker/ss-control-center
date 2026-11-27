# 📅 Ship Date Trick (Frozen Monday-shift)

> **Полный канон алгоритма выбора тарифа:** [shipping-rate-selection.md](shipping-rate-selection.md).

## Суть
Для холодовых Amazon-заказов (`FROZEN` и `CHILLED`) отгрузка в конце недели часто либо не даёт ни одного тарифа в разрешённом окне транзита, либо оставляет только дорогие экспресс-/субботние варианты. Сдвиг **физического дня отгрузки** (`physicalShipDate`) на следующий рабочий понедельник открывает более дешёвые (или более быстрые) будничные тарифы, при этом **дата этикетки для Amazon** (`labelDate`) остаётся сегодняшней — Late Shipment Rate не страдает.

Алгоритм автоматический и работает в **обоих** профилях (`Live` и `Summer`).

## Когда запускается (`plan/route.ts`)
Условия в `src/app/api/shipping/plan/route.ts`:
- `isAmazon` (включая `Merged Orders`) и `productType === "Frozen"` (то есть `FROZEN` или `CHILLED`);
- оператор не задал явный `shipDateOverride`;
- сегодня не понедельник (`dayInfo.dayName !== "Mon"`) и `effectiveShipDay` не понедельник (если планируем в воскресенье на понедельник — на *следующий* понедельник через неделю не прыгаем);
- `nextMonday = nextMondayFrom(effectiveShipDay)` (автоматически пропускает федеральные праздники США) хотя бы на 1 день раньше дедлайна (`monDeadlineDays >= 1`).

## Как котируется понедельник (в `/api/shipping/plan`)
> Старый механизм `PUT dispatch_date → sleep 800ms → GET /shipping/rates → restore` **заменён** в Master Prompt v3.5 на date-anchored Rate Shopping API без мутации заказа.

1. Вызывается `getRatesForLaterShipDay(order, nextMonday, effectiveShipDay, newApiParcel, baseRates)` → **`POST /shipping/api/v1/rates`** с `preferred_shipment_date = "${nextMonday}T16:00:00Z"` и габаритами из нашего каталога.
2. **Проверка честности якоря (`anchorHonored` / `quoteAnchorDay`):**
   - `getRatesForLaterShipDay` сравнивает `delivery_promise_date` общих сервисов между базовой датой и понедельником (с учётом `pickupGapBusinessDays`, чтобы `Sun → Mon = 0` не считалось ошибкой).
   - Если Veeqo **проигнорировал** `preferred_shipment_date` (`anchorHonored = false`, доказанный баг Veeqo от 2026-10-06), EDD возвращаются **без изменения** с `quoteAnchorDay = effectiveBusinessDay(baseYmd)`, а **автоматический Monday-shift отменяется** (отгружаем сегодня, чтобы не получить ложный «1-дневный» транзит).
3. **Выбор лучшего тарифа понедельника:**
   - В **`Live`**: запрашивается погода `getRouteWeather(destZip, nextMonday)` и запускается `selectTempAwareRate` (с тем же `summerCapDays` и учётом доп. льда на понедельник).
   - В **`Summer` / `Shadow`**: запускается `selectBestRate` от `nextMonday`.
4. **Решение «Сегодня vs Понедельник» (`chooseTodayOrMonday` в `src/lib/shipping/rate-selection.ts`):**
   Понедельник выигрывает, если выполнено **любое** из 3 условий:
   1. **Сегодня нет валидного тарифа** (`!todayPick && mondayPick`);
   2. **Понедельник быстрее в транзите** (`mondayTransit < todayTransit`) **и дороже не более чем на `$3`** (`mondayPrice <= todayPrice + $3`, `FROZEN_SPEED_TOLERANCE_USD = 3`);
   3. **Понедельник более чем на 15% дешевле** (`mondayPrice < todayPrice * 0.85`, `MONDAY_SHIFT_MIN_SAVING_PCT = 0.15`), даже если транзит на день длиннее (оба варианта уже прошли холодовой лимит и дедлайн).
   - Иначе остаётся отгрузка сегодня.
5. Если победил понедельник: `physicalShipDate = nextMonday`, `labelDate` остаётся `computeLabelDate(shipBy)`, `shipDateTrickApplied = true`, в `notes` пишется `Shifted to Mon YYYY-MM-DD: <reason>`. Заказ в Veeqo на этапе плана **не мутируется**.

## Как применяется при покупке (в `/api/shipping/buy` и `/api/shipping/merge/buy`)
Покупка идёт через Allocation Pool, который привязан к `order.dispatch_date`, поэтому при `physicalShipDate !== labelDate` выполняется **dual-date dance**:
1. `PUT /orders/{id}` → `dispatch_date = physicalShipDate T06:59:59.000Z`.
2. Живая перекотировка `GET /shipping/rates/{allocationId}` (с ретраем пустого пула) и сопоставление через `matchLiveRate`.
3. **ДО покупки (`POST /shipping/shipments`)**: `PUT /orders/{id}` → `dispatch_date = labelDate T06:59:59.000Z`, чтобы этикетка напечаталась с сегодняшней датой для Amazon (LSR = 0). Если re-quote не нашёл ставку или покупка упала — исходный `dispatch_date` восстанавливается.
4. `POST /shipping/shipments` (строго 1 POST, 0 retry).
5. В employee note Veeqo дописывается `📅 SHIP ON YYYY-MM-DD`, а PDF кладётся в папку Google Drive по `physicalShipDate`.

## Связанные файлы
- `ss-control-center/src/lib/shipping/rate-selection.ts` — `chooseTodayOrMonday`, `FROZEN_SPEED_TOLERANCE_USD`, `MONDAY_SHIFT_MIN_SAVING_PCT`
- `ss-control-center/src/lib/veeqo/client.ts` — `getRatesForLaterShipDay`, `getRatesForShipDate`
- `ss-control-center/src/lib/shipping/dates.ts` — `computeLabelDate`, `nextMondayFrom`, `pickupGapBusinessDays`
- `ss-control-center/src/app/api/shipping/plan/route.ts` — запуск и сравнение
- `ss-control-center/src/app/api/shipping/buy/route.ts` и `merge/buy/route.ts` — dual-date dance при покупке

## 🔗 Связи
- **Канон:** [Выбор ставки (канон)](shipping-rate-selection.md)
- **Часть:** [Shipping Labels](shipping-labels.md)
- **Зависит от:** [Frozen Shipping Rules](frozen-shipping-rules.md), [Timezone правила](timezone-rules.md), [Veeqo API](veeqo-api.md)

## История
- 2026-11-27: Документ обновлён под актуальный механизм `POST /shipping/api/v1/rates` (`getRatesForLaterShipDay` + `anchorHonored`/`quoteAnchorDay`) и правила `chooseTodayOrMonday` (нет сегодня / быстрее и ≤+$3 / >15% дешевле), а также работу в `Live` с погодой понедельника.
- 2026-10-25: Monday-shift заработал в `Live`-режиме через погодный движок; добавлена проверка `pickupGapBusinessDays` и отказ от сдвига при `anchorHonored = false` (EDD перевозчика никогда не сдвигается вручную).
- 2026-10-06: Доказан баг Veeqo с игнорированием `preferred_shipment_date` → добавлена проверка `anchorHonored` / `quoteAnchorDay`.
- 2026-06-12 (Master Prompt v3.5): Переход с `PUT dispatch_date + 800ms + GET` на новый Rate Shopping API `POST /shipping/api/v1/rates` и правила `chooseTodayOrMonday` (`$3` / `>15%`).
- 2026-05-14: Первая автоматическая реализация (тогда через временный `PUT dispatch_date → 800ms → GET` и гард `monDeadlineDays >= 1`).
