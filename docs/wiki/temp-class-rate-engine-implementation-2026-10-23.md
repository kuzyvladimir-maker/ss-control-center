# Temperature-aware rate engine — implementation & go-live (2026-10-23)

Implements the owner-approved design in
[[frozen-weather-rate-selection-plan-2026-10-23]] (topic 135). The summer
profile (Master Prompt v3.5, `src/lib/shipping/rate-selection.ts`) is **not
touched** — it stays the one-switch rollback, snapshot tag
`shipping-frozen-summer-profile-2026-10-23`.

## What shipped

**Engine** — `src/lib/shipping/temp-class/` (pure, 38 unit tests in
`src/lib/shipping/__tests__/temp-class-*.test.ts`):
- `classes.ts` / `resolve-class.ts` — FROZEN > CHILLED > DRY; strictest class in
  a mixed order wins; precedence manual (SkuTemperatureClass) > legacy
  (ProductTypeOverride) > Veeqo tag > **FROZEN default**; Walmart forced DRY with
  a cold-conflict flag.
- `days-table.ts` — allowed transit days + extra ice by class/size/weather.
  FROZEN table per the plan doc; CHILLED = +1 day (cap 5) with the heat
  overrides; DRY = no cap. XS/S cap 3; hot-origin cap; prior-incident −1;
  "ice unavailable → cell without ice".
- `ice.ts` — bases XS 3 / S 5 / M 9 / L 11 / XL 19; extra capacity XS 0 / S 0 /
  M +2 / L +1 / XL +4; +1 lb & $0.10 per extra piece.
- `weather.ts` — Open-Meteo. **A** = Clearwater max (ship day + next). **M** =
  max at route midpoint + destination over the window. 3-hour cache. No forecast
  → engine stands down and the summer pick is used.
- `pick-rate.ts` — deadline + cold-chain-cap filter, cheapest with a $1 speed
  premium ($3 when the route is hot), Next-Day never auto-bought.
- `shadow.ts` — the card payload: would-pick, saving vs summer, the 4-/5-day
  prices summer never quoted, and the ice note.
- `profile.ts` — the `shipping_rate_profile` Setting flag.

**DB** — `SkuTemperatureClass` (+ `SkuTemperatureClassChange` audit) in
`prisma/schema.prisma`. Migration `scripts/turso-migrate-sku-temperature-class.mjs`
(idempotent). Seed `scripts/seed-sku-temperature-class.mjs` from
`scripts/data/sku-temperature-class-seed.json`.

**API** — `POST/GET /api/shipping/temperature-class` (owner sets the class per
SKU; no Veeqo tag write — that is a separate step). `GET/PUT
/api/shipping/rate-profile` (the flag).

**Plan route** — resolves the order class, and when the engine is on computes
the shadow result on the already-fetched rate list and attaches it to each plan
item. In `live` it swaps the pick to the temperature-aware one and disables the
Monday-shift (engines must not mix).

**UI** (`src/app/shipping/page.tsx`) — a clickable Frozen/Chilled/Dry class chip
per card, a "Cold on Walmart" warning, and a shadow block showing the would-pick,
the saving, the ice, and the longer-transit prices.

## The flag (`shipping_rate_profile`)

| value | behaviour |
|---|---|
| `summer` | engine OFF — pure v3.5. The rollback. |
| `shadow` | compute + show the saving; **buy by summer**. The launch state. Default when the row is unset. |
| `live` | buy the temperature-aware pick. |

Flip it: `PUT /api/shipping/rate-profile {"profile":"live"}` (or set the Setting
row directly). Takes effect within 60 s (cached).

## Go-live checklist

1. **Apply the migration** on Turso: `node scripts/turso-migrate-sku-temperature-class.mjs`.
2. **Seed the classes**: paste the 27 chilled SKUs into the seed JSON, then
   `node scripts/seed-sku-temperature-class.mjs --apply`.
3. Deploy. Default profile `shadow` → cards show savings, nothing buys
   differently.
4. Owner reviews the shadow savings for a week.
5. On the owner's word: `PUT /api/shipping/rate-profile {"profile":"live"}`.
   Carrier override and Next-Day rules still apply.

## Known gaps (flagged to owner)

- **Chilled seed SKUs** — the review sheet (`1NXuQpZutohF…`) requires Google
  sign-in and could not be exported; the 27 chilled codes are a TODO in the seed
  JSON. Frozen (10) + dry (2) are pre-filled.
- **Live buy-time ice** — in `live`, the plan picks the right carrier, but the
  extra-ice label-weight bump and the Veeqo warehouse ice-note are **not yet
  written at purchase** (shadow week doesn't buy, so no impact now). This is the
  one buy-route follow-up before flipping `live`.
- **Chilled filter tab** — not added yet (class chip + shadow are in).
