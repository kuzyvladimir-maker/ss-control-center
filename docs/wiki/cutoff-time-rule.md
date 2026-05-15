# 🕒 Cutoff Time Rule + Two Dates Per Order

## Суть
Каждый заказ имеет **две даты**, которые могут совпадать или различаться:

- **`labelDate`** — дата на этикетке (для Amazon Late Shipment Rate)
- **`physicalShipDate`** — когда реально передаём перевозчику (для rate calculation, Drive folder)

Cutoff 15:00 ET применяется только когда есть **запас по Ship by**. Для заказов с Ship by = today алгоритм всегда ставит `labelDate = today` чтобы не сломать статистику Amazon.

**Дата:** 2026-05-14 (v3.3 — переработана концепция из v3.2)
**Контекст:** MASTER_PROMPT v3.3 §0.1
**Спецификация:** [`docs/MASTER_PROMPT_v3.3.md`](../MASTER_PROMPT_v3.3.md)

---

## Почему так

Amazon следит за **датой на этикетке**, не за физической отгрузкой. Это позволяет:

1. **Спасти статистику** для late-вечерних покупок: Ship by = today, время 21:00 → этикетка с today, физическая отгрузка завтра — Amazon доволен.
2. **Обойти Frozen-ограничения**: этикетка с today, физическая отгрузка через 3-4 дня в понедельник — Frozen rule (EDD ≤ 3 кал. дня) соблюдён.

Старая модель v3.2 с глобальным `effectiveShipDate` ломала случай (1) — после 15:00 ET алгоритм сдвигал ship date на завтра даже для заказов с Ship by = today, что приводило к late shipment.

---

## Алгоритм определения `labelDate`

```
shipBy = order.dispatch_date в local TZ
now = текущее время в America/New_York

if shipBy < today:
    labelDate = today           # overdue, минимизировать урон
elif shipBy == today:
    labelDate = today           # дедлайн сегодня — нет выбора
elif shipBy == tomorrow:
    labelDate = today if now < 15:00 ET else tomorrow
else:                            # shipBy ≥ +2 дня
    labelDate = today if now < 15:00 ET else nextBusinessDay(today)
```

**Cutoff применяется ТОЛЬКО когда `shipBy > today`** (есть запас).

---

## Алгоритм определения `physicalShipDate`

```
candidate = labelDate

if isFrozen and isAmazon:
    rates = getRates(physicalDate = candidate)
    best = selectFrozenRate(rates, candidate, deliverBy)
    if best:
        physicalShipDate = candidate    # обычный кейс
    else:
        monday = ближайший понедельник от candidate
        rates = getRates(physicalDate = monday)
        best = selectFrozenRate(rates, monday, deliverBy)
        if best:
            physicalShipDate = monday   # Ship Date Trick
        else:
            need_attention 'no_service'
else:  # Dry
    physicalShipDate = candidate
    best = selectDryRate(rates)
```

---

## Business day

Business day = понедельник-пятница, **НЕ** US federal holiday.

Holiday detection: npm `date-holidays` (`new Holidays('US')`). Автоматическое обновление.

---

## Примеры (четверг 14 мая 2026, 21:12 ET)

| Заказ | Ship by | Frozen? | labelDate | physicalShipDate | Сценарий |
|-------|---------|---------|-----------|------------------|----------|
| A | 5/14 (Thu) | Frozen | **Thu 5/14** | **Thu 5/14** | EDD ≤ 5/17 есть — обычный кейс |
| B | 5/14 (Thu) | Frozen | **Thu 5/14** | **Mon 5/18** | EDD только пн (4 дня) — Ship Date Trick |
| C | 5/16 (Sat) | Frozen | **Fri 5/15** | **Mon 5/18** | Cutoff → пт, Frozen rule → пн |
| D | 5/14 (Thu) | Dry | **Thu 5/14** | **Thu 5/14** | Обычный |
| E | 5/16 (Sat) | Dry | **Fri 5/15** | **Fri 5/15** | Cutoff применился (есть запас) |
| F | 5/13 (Wed, прошел) | Frozen | **Thu 5/14** | **Thu 5/14** или **Mon 5/18** | Overdue, warning |
| G | 5/15 (Fri) | Dry | **Fri 5/15** | **Fri 5/15** | Cutoff сдвинул, запас был |
| H | 5/14, 14:30 ET | любой | **Thu 5/14** | physical зависит от Frozen | До cutoff, всё today |

---

## Реализация в коде

### Утилита `src/lib/shipping/dates.ts`

```typescript
import Holidays from "date-holidays";

const CUTOFF_HOUR_NY = 15; // 3 PM ET
const hd = new Holidays("US");

function nyDate(): { year: string; month: string; day: string; hour: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  return {
    year: parts.find((p) => p.type === "year")!.value,
    month: parts.find((p) => p.type === "month")!.value,
    day: parts.find((p) => p.type === "day")!.value,
    hour: Number(parts.find((p) => p.type === "hour")!.value),
  };
}

export function isBusinessDay(d: Date): boolean {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  const h = hd.isHoliday(d);
  if (h && Array.isArray(h)) {
    return !h.some((x) => x.type === "public" || x.type === "bank");
  }
  return true;
}

export function nextBusinessDay(d: Date): Date {
  const next = new Date(d);
  do {
    next.setDate(next.getDate() + 1);
  } while (!isBusinessDay(next));
  return next;
}

/** YYYY-MM-DD в America/New_York */
export function todayNY(): string {
  const p = nyDate();
  return `${p.year}-${p.month}-${p.day}`;
}

export function isAfterCutoff(): boolean {
  return nyDate().hour >= CUTOFF_HOUR_NY;
}

/**
 * Per-order labelDate. Принимает Ship by (YYYY-MM-DD в NY TZ).
 */
export function computeLabelDate(shipByYMD: string): string {
  const today = todayNY();
  const todayDate = new Date(`${today}T12:00:00`);
  const shipByDate = new Date(`${shipByYMD}T12:00:00`);

  if (shipByDate < todayDate) return today; // overdue
  if (shipByDate.getTime() === todayDate.getTime()) return today; // дедлайн сегодня

  if (!isAfterCutoff()) return today; // до cutoff — можно today

  // После cutoff, есть запас → next business day
  return nextBusinessDay(todayDate).toISOString().split("T")[0];
}

export function nextMondayFrom(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00`);
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() !== 1 || !isBusinessDay(d));
  // Если понедельник holiday — двигаем дальше до business day
  while (!isBusinessDay(d)) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().split("T")[0];
}
```

`computePhysicalShipDate(order, candidateLabelDate)` живёт в логике формирования плана (`/api/shipping/plan/route.ts`), поскольку требует запроса rates.

---

## UI индикация

На карточке заказа сверху:
```
Order #001-...  Ship by: Thu 5/14
  Label: Thu 5/14    Physical: Mon 5/18  (Ship Date Trick)
```

Цветовая подсветка:
- 🟢 labelDate == physicalShipDate
- 🟡 labelDate ≠ physicalShipDate (Ship Date Trick)
- 🔴 overdue (Ship by < today)

### Editable Ship Date (как в Veeqo)

Дополнительно — два editable дропдауна на карточке:
- `Label Date`: Today / Tomorrow / Custom
- `Physical`: Today / Tomorrow / Monday / Custom

Дефолты — computed. Vladimir может вручную переопределить.

---

## Конфигурация

`CUTOFF_HOUR_NY = 15` — константа в коде. Если в будущем нужно сделать настраиваемым — вынести в Setting.

---

## 🔗 Связи

- **Часть:** [MASTER_PROMPT v3.3](../MASTER_PROMPT_v3.3.md) §0.1
- **Используется в:** [Shipping Labels Page v1](shipping-labels-page-v1.md), [Shipping Labels](shipping-labels.md)
- **Связано с:** [Ship Date Trick](ship-date-trick.md), [Timezone правила](timezone-rules.md)
- **См. также:** [Carrier Selection Rules](carrier-selection-rules.md), [Frozen Shipping Rules](frozen-shipping-rules.md)

---

## История
- 2026-05-14 (вечер): v3.3 — концепция двух дат, per-order cutoff.
- 2026-05-14 (день): v3.2 — глобальный cutoff (заменено).
