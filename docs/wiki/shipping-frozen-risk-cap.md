# 🌡️ Shipping — Frozen risk-level → calendar-day cap override

> **Полный канон алгоритма выбора тарифа:** [shipping-rate-selection.md](shipping-rate-selection.md).

## Суть
Для холодовых Amazon-заказов `FrozenRiskAlert` (модуль `frozen-analytics`) ограничивает летний потолок транзита с **3 календарных дней** до **2 календарных дней**, когда для заказа есть pending-алерт с уровнем риска **`high` ИЛИ `critical`** (решение Владимира 2026-06-09: оба уровня `high` и `critical` → 2 дня, не только `critical`).

Зачем: уровни `high` / `critical` ставятся rules-engine'ом `frozen-analytics` при экстремальной жаре в пункте назначения, многодневных высоких температурах по маршруту и жарких летних коридорах, когда 3-дневный транзит несёт риск порчи даже при соблюдении дедлайна маркетплейса.

## Роль в боевом режиме `Live` vs откате `Summer`
- **В откате `Summer` (Master Prompt v3.5, `selectBestRate`):** `frozenMaxCalDays(riskLevel)` напрямую задаёт потолок транзита — `2` дня для `high`/`critical`, иначе `3` дня.
- **В боевом режиме `Live` (`selectTempAwareRate` / `days-table.ts`):** значение `frozenMaxCalDays(riskLevel)` передаётся как **`summerCapDays` — летний пол (floor)**.
  - Погодная таблица (`A` / `M` + кулер) может **расширять** окно в холодную погоду (до 4–5 дней), но **никогда не сужает** его строже `summerCapDays` (`if (days < summerCapDays) { days = summerCapDays; extraIce = 0; }`).
  - Таким образом, при `high`/`critical` пол равен `2` дням (таблица погоды может оставить 2 дня в жару), а без алерта пол равен `3` дням (таблица не сделает заказ строже, чем летом).
  - Для класса `CHILLED` добавка `+1 день` (до 5) применяется уже поверх результата после `summerCapDays` (кроме экстремальной жары `A > 30 °C` и `M > 25 °C`).

## Связано с
- [Выбор ставки (канон)](shipping-rate-selection.md)
- [shipping-frozen-transit-anchor](shipping-frozen-transit-anchor.md) — измерение "N days" в Pacific TZ от фактического дня отгрузки
- `ss-control-center/src/lib/shipping/rate-selection.ts` — `frozenMaxCalDays(riskLevel)` (`high` / `critical` → `2`, иначе `3`)
- `ss-control-center/src/lib/shipping/temp-class/days-table.ts` — `summerCapDays` floor
- `ss-control-center/src/app/api/shipping/plan/route.ts` и `merge/rates/route.ts` — batch `FrozenRiskAlert` lookup + проброс
- `ss-control-center/src/lib/frozen-analytics/rules-engine.ts` — `LEVEL_ORDER = ["ok", "low", "medium", "high", "critical"]`
- `ss-control-center/prisma/schema.prisma` — `FrozenRiskAlert.riskLevel`

---

## 🔁 Flow

### 1. Один SQL up-front в `/api/shipping/plan` (и `/api/shipping/merge/rates`)
Перед циклом по заказам:
```ts
const alertRows = await prisma.frozenRiskAlert.findMany({
  where: { orderId: { in: orderNumbersForRisk }, status: "pending" },
  select: { orderId: true, riskLevel: true },
});
```
Если у заказа (или у участников Merged Group) несколько pending-алертов — берётся **максимальный** `riskLevel` по рангу `ok < low < medium < high < critical`.

### 2. Функция `frozenMaxCalDays`
Реализована в `src/lib/shipping/rate-selection.ts`:
```ts
export function frozenMaxCalDays(riskLevel: string | null | undefined): number {
  const lvl = (riskLevel ?? "").toLowerCase();
  return lvl === "critical" || lvl === "high" ? 2 : 3;
}
```

### 3. Применение при выборе ставки
- **В `Live` (`selectTempAwareRate`):** передаётся `summerCapDays: frozenMaxCalDays(frozenRiskLevel)` как для сегодняшней котировки, так и для понедельника в Monday-shift.
- **В `Summer` / `Shadow` и `merge/rates` (`selectBestRate`):** фильтрует пул `r.calDays <= maxCalDays`, затем выбирает среди валидных ставок с порогом `≤ +$3` за более быстрый транзит. *(Старые запреты «Среда без Ground» и «Пятница без FedEx Express» отменены в v3.5 и больше не применяются.)*

### 4. Отображение в UI
- На карточке показывается `FrozenRiskBadge` с уровнем риска.
- В диагностике `notes` (`Summer`) фиксируется `risk=high→max2d` / `risk=critical→max2d`.

---

## 🤔 Что НЕ изменилось
- Если `alert.status !== "pending"` (`applied` / `ignored` / `resolved`) — алерт не учитывается, действует стандартный пол/кап `3` дня.
- Если `FrozenRiskAlert` отсутствует — действует стандартный пол/кап `3` дня.
- Для `DRY` и не-Amazon (включая Walmart) правило не применяется.

---

## 📝 История
- **2026-11-27:** Статья приведена в соответствие с кодом: уточнено `high` **и** `critical` → `2` дня, убраны устаревшие упоминания «Wed no Ground / Fri no FedEx», описана работа `summerCapDays` как пола в `Live`-режиме, добавлена ссылка на канон [shipping-rate-selection.md](shipping-rate-selection.md).
- **2026-10-26:** `frozenMaxCalDays` подключён в `Live` как `summerCapDays` (летний пол, чтобы погода не делала зимние заказы строже летних).
- **2026-06-09:** Правило расширено с `critical`-only на **`high` и `critical` → 2 дня** (решение Владимира).
- **2026-06-07:** Первичное внедрение правила `critical → 2 days`.
