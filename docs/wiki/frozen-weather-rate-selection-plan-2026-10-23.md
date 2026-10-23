# Temperature-aware rate selection: frozen / chilled / dry (plan, 2026-10-23)

> **Implemented** — see [[temp-class-rate-engine-implementation-2026-10-23]] for
> the shipped engine, the `shipping_rate_profile` flag and the go-live checklist.

Status: **design, not implemented**. Owner (Vladimir) approved the three
classes, the manual override and the chilled rules on 2026-10-23. Extra ice per size
confirmed (XL +4). Still open: the days/ice table and the answers to questions 1–6 (cooler interior
dimensions, the XS/S cap, upsize, packaging prices, the shadow week, and how
ice is shown to the warehouse). The summer rollback point is git tag
`shipping-frozen-summer-profile-2026-10-23`.

## 1. Temperature class per SKU

**Classes.**
- `FROZEN` — the buyer expects the item frozen.
- `CHILLED` — sold refrigerated in stores. We still freeze it at −22 °C and
  pack it with ice, and the buyer accepts it arriving thawed.
- `DRY` — no temperature logic.

**Storage.** A new table, `SkuTemperatureClass`:

| column | |
|---|---|
| `sku` (unique) | our SKU |
| `class` | FROZEN / CHILLED / DRY |
| `source` | `manual` (owner in Command Center), `review` (bulk-approved list), `ai` |
| `setBy`, `note`, `createdAt`, `updatedAt` | |

Every change also appends a row to `SkuTemperatureClassChange` (sku, from, to,
source, setBy, at), so a wrong class can always be traced.

**Resolution for one order line, first match wins:**
1. `SkuTemperatureClass` row for the line's SKU. This is the manual override,
   and nothing reads Veeqo back over it.
2. Legacy `ProductTypeOverride` (keyed by Veeqo productId, 315 rows: Frozen /
   Dry).
3. Veeqo product tag: `chilled` / `refrigerated` → CHILLED, `frozen` → FROZEN,
   `dry` → DRY. When several tags are present, the strictest wins.
4. No answer → FROZEN, flagged `type unknown → treated as Frozen` on the card.

**Order class** is the strictest of all its lines: FROZEN > CHILLED > DRY.
Today only the first line is read, so a dry item listed first ships a mixed
order as Dry. This change fixes that.

**Walmart.** Walmart orders stay DRY, as today. FROZEN and CHILLED are both
forbidden on Walmart, and a cold SKU on a Walmart order is flagged on the card.

**Veeqo tags are an optional mirror.** The class is written to Veeqo only
after the owner says "yes". It is never read back over a manual value.

**UI.**
- A class chip on every row, Frozen / Chilled / Dry. Clicking it changes the
  class for the SKU. This replaces the current "Set Frozen/Dry" button.
- A filter tab for Chilled.

**Initial data (approved 2026-10-23, from Jackie's review sheet):**
- CHILLED: rows 1–18, 20–22 and 24–29.
- DRY: `YA-VPYQ-S643`, `743269731406`.
- FROZEN: `BW-K09A-4RTZ`, `8L-9GYI-BG9M`, `1C1H-3IEB-7J1S`, `742259723711`,
  `742259724435`, `742259723971`, `742259724107`, `743269736760`,
  `1C1H-3IEB-86IA`, `743269736296`.
- Everything else stays on its current tag; untagged means FROZEN.

## 2. Weather inputs (per candidate rate)

- **A** — the daily max in Clearwater on the ship day and the day after. This
  covers the first ~36 hours, when the cold has to hold.
- **M** — the max of the daily highs at two points, the route midpoint and the
  destination ZIP, over the remaining days in transit for that rate. Carrier
  hubs are unknown, so the midpoint stands in for them.
- **Source:** Open-Meteo forecast. It is free, needs no key, and is already
  used by Frozen Analytics. It is cached per (lat/lon rounded, date) for 3
  hours.
- **Count calendar days**, weekends included, as today.
- **No forecast** → the summer profile, exactly as the tag snapshot.

## 3. Days allowed (FROZEN, Clearwater A ≤ 25 °C)

| M (route) | XS, S | M | L | XL |
|---|---|---|---|---|
| > 20 °C | 2 | 2 | 2 | 2 |
| 10…20 °C | 2 | 3 (+2 ice) | 3 (+1) | 3 (+2) |
| 0…10 °C | 3 | 4 (+2) | 3 | 4 (+2) |
| −5…0 °C | 3 | 4; 5 (+2) if A < 15 °C | 4 | 5 (+4) |
| < −5 °C | 3 | 4; 5 (+2) if A < 15 °C | 4 | 5 (+4) |

**Extra ice that fits above the base:** XS 0, S 0, M +2, L +1, XL +4 (owner,
2026-10-23). The base is XS 3, S 5, M 9, L 11, XL 19. Where a size can't take
the extra ice, it gets the no-ice cell. A longer transit is only ever taken
when it is the cheaper rate (normal pick rule below); the table only says what
is *allowed*.

**Overrides to the table:**
- **Hot Clearwater:** if A > 25 °C, the max is 2 days when M > 10 °C,
  otherwise 3.
- **XS/S cap:** never more than 3 days.
- **SKUs with prior warm/spoiled incidents:** one day less.

**CHILLED** follows the frozen table with these changes:
- +1 day to each cell, capped at 5.
- When M > 20 °C: 3 days, and only with +1 ice.
- When A > 30 °C and M > 25 °C: 2 days.
- "Arrived thawed" is not an incident for chilled.

**DRY:** the cheapest rate that meets the deadline. No ice, no weather.

## 4. Picking the rate

1. Drop every rate that misses the marketplace deadline or exceeds the
   allowed days for its own transit and weather.
2. Take the cheapest remaining rate. A faster one wins only if it costs at
   most $1 more ($3 when M > 20 °C, as in summer).
3. Next Day is never bought unless the buyer paid for it (unchanged).
4. The Monday shift (≥15% saving) is unchanged.
5. Upsizing the cooler is **not** offered: in 136 of 136 historical cases it
   was $10–16 more expensive.

**Extra ice.** Shown on the card and in the Veeqo warehouse note. About 1 lb
per piece is added to the label weight, so the carrier doesn't bill an
overweight.

**Card.** The row shows why the rate was picked, for example:
`Frozen · M 3°C / A 22°C → up to 4d · UPS Ground 4d $14.10 · ice 9+2`.

## 5. Rollout

1. **Shadow week.** Compute the weather choice and show it on the card with
   the would-be saving, including 4-day prices, which have never been quoted
   so far. Purchases still use the summer logic.
2. **Owner reviews the savings, then go live.**
3. **Rollback:** restore `rate-selection.ts` from the summer tag, or switch
   the profile back.

## 6. Migrations (Turso, additive only)

- `SkuTemperatureClass`, plus a unique index on `sku`.
- `SkuTemperatureClassChange`.
- No column drops, and `ProductTypeOverride` is kept.
- The script follows the existing `scripts/turso-migrate-*.mjs` pattern and
  is idempotent.
- The seed of the approved list is a separate script that writes only rows
  with source `review`.

## 7. Tests (node:test, `npm run test:shipping`)

**Class resolution:**
- manual beats legacy beats Veeqo tag beats the default;
- the strictest class in a mixed order wins;
- an untagged SKU becomes FROZEN with the "unknown" flag;
- Walmart stays DRY and flags a cold SKU.

**Days table:**
- every cell, for each size and class;
- the XS/S cap;
- the chilled +1, the cap of 5 and the hot-route branches;
- the incident −1.

**Rate pick:**
- fixtures with real candidate lists, including 4-day rates;
- the speed premium of $1 vs $3;
- no forecast falls back to summer, and that output is identical to the
  tagged snapshot (regression test against the current `selectBestRate`).

**Ice and weight:** the extra pieces per size, and the label weight delta.

**Weather:** the cache, and the Open-Meteo failure path.
