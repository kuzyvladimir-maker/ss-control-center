# 🥶 Shipping — Frozen "X days" badge anchor

## Суть
На карточке shipping-row справа от рейта показывается `EDD <дата> · N days`.
`N days` — транзит в календарных днях, должен считаться от дня, когда
**warehouse физически отдаёт пакет carrier'у** (== `physicalShipDate` по
Master Prompt v3.3 §0.1). В коде это поле в response называется
`plan.actualShipDay` — это тот же `actualShipDay`, который `selectBestRate`
использовал как ship-day для фильтра Frozen ≤3 cal.day.

## Связано с
- [MASTER_PROMPT v3.3](../MASTER_PROMPT_v3.3.md) — спека
- `docs/MASTER_PROMPT_v3.3.md` §5 (FROZEN правило), §7 (Ship Date Trick), §0.1 (labelDate vs physicalShipDate)
- `src/app/api/shipping/plan/route.ts` — `getDayInfo`, `selectBestRate`, формирование `physicalShipDate` + `legacyActualShipDay`
- `src/app/shipping/page.tsx` — рендер `EDD · N days` (transitAnchor)

---

## 🐛 Bug 2026-06-07 — "4 days" на воскресном Frozen-load

### Симптом
Vladimir смотрит /shipping в воскресенье 6/07. Заказы Amazon-Frozen с
рейтом UPS Ground Saver EDD 6/11 показывают `· 4 days`. По Master Prompt
≤3 cal.day для Frozen — то есть выглядит как нарушение, label не должен
был быть выбран.

### Что происходило на самом деле
Алгоритм корректен:
1. `getDayInfo(today=Sun 6/07)` → `actualShipDay = Mon 6/08` (advance с weekend на следующий бизнес-день)
2. `selectBestRate(rates, productType, deliveryBy, actualShipDay=Mon)` фильтрует `calDays = (EDD - Mon)`. UPS Ground Saver 6/11 → 3 cal.day ≤ 3 → проходит ✓
3. В response: `physicalShipDate = labelDate = today = Sun 6/07` (потому что `trickFired=false`), `actualShipDay = Mon 6/08`

### Почему UI показывал 4
UI fallback chain был:
```ts
transitAnchor = plan.physicalShipDate ?? plan.actualShipDay ?? shipDateGlobal
```
`physicalShipDate=Sun 6/07` → UI считает `6/11 - 6/07 = 4 days`. Badge врёт.

### Fix
Swap fallback order:
```ts
transitAnchor = plan.actualShipDay ?? plan.physicalShipDate ?? shipDateGlobal
```
`actualShipDay = Mon 6/08` → `6/11 - 6/08 = 3 days`. Совпадает с тем, что
реально измерил `selectBestRate`.

### Почему не trogal `physicalShipDate` в route
- `physicalShipDate === labelDate` сейчас используется как detector "shipDateTrickApplied"
  (`labelDate !== physicalShipDate` → trick fired). Если бы я сделал `physicalShipDate = legacyActualShipDay`, на каждом воскресном/субботнем load для **любого** заказа (даже без trick) trick-indicator поднимался бы → false alarm.
- UI swap — surgical fix, ничего не ломает.

### Edge case
Weekday after-cutoff: `labelDate = nextBusinessDay`, `actualShipDay = today`.
Здесь UI теперь считает от today, а labelDate ушёл на завтра. Но
`selectBestRate` тоже работает с today как actualShipDay arg, так что
badge соответствует фильтру. Если когда-то перепишем selectBestRate
honor'ить cutoff — UI всё равно останется консистентным благодаря приоритету
`actualShipDay`.

---

## 📝 Lesson
"N days" badge ОБЯЗАН anchor'иться на тот же ship-day, с которым работал
rate selector. Если UI берёт другую дату — operator видит мнимое нарушение
Frozen-правила и теряет доверие к алгоритму. При любых изменениях
`selectBestRate` или date-handling в `plan/route.ts` — проверять, что
поле, на которое смотрит UI, остаётся равным actualShipDay arg внутри
selectBestRate.
