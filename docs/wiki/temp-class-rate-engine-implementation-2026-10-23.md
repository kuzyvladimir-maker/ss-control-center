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
- `pick-rate.ts` — deadline + cold-chain-cap filter, then the **cheapest**
  rate inside the window; a faster rate wins only on an exact price tie.
  Next-Day is never auto-bought. (Until 2026-10-26 it paid a $1 speed premium,
  $3 on a hot route; the owner removed it — see below.)
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

## Closed on 2026-10-23 (second pass)

- **Chilled seed**: the 27 chilled SKUs are filled in the seed JSON. They come
  from the numbered list sent to the topic, which follows the same order as
  the review sheet; rows 19, 23 and 30–39 were verified to match.
- **Per-line class**: each order line now gets its own legacy override and
  Veeqo tags. Previously line 1's Frozen/Dry type was copied to every line.
- **`chilled` / `refrigerated` tag** counts as cold chain in every mode, so
  tagging Veeqo can never produce the "Missing Frozen/Dry tag" stop.
- **Live only**: the resolved class drives the buy. The strictest line wins,
  a manual DRY makes the order Dry, and an untagged SKU is treated as FROZEN
  instead of stopping. Shadow and summer keep the old first-line type.
- **Walmart cold flag**: only a real signal (manual, legacy or tag) raises it,
  not the FROZEN default.
- **"Type unknown → treated as Frozen"** chip on the card.
- **Live ice**: the plan adds extra pieces × 1 lb to the plan-item weight and
  writes `[ice +N]` into the notes. The buy route appends "ADD N EXTRA ICE" to
  the Veeqo warehouse note.
  - Caveat: the live quote is taken without the ice weight. At buy time the
    heavier package goes through the re-quote price guard (≤ max($1, 5%)). A
    larger jump refuses the buy and names the closest options.
- **Chilled filter tab** on /shipping.

## Incident: engine commits reached main

`agent-sync sync` always pushes `HEAD:main`, even from a feature branch.
Because of that, 794a57bd3, af14f6726 and cd826525c landed on main. They were
reverted there by f0f61879f, whose tree is identical to cad34eff7. The
branch re-applies them in d62543c85.

**Rule:** never run `agent-sync sync` on a feature branch. Commit with plain
git and `git push origin <branch>`.

## Remaining before `live`

- Verify the shadow numbers for a week.
- Optionally re-quote the live pick with the ice weight included, so the
  buy-time guard never trips on a heavier package.

## 2026-10-26 — no speed premium in Live

Owner's call: inside the allowed transit window, take the cheapest rate, not
the fastest. The $1 / $3 premium was picking a 2-day UPS Ground over a cheaper
3-day UPS Ground Saver that was also inside the limit.

The two orders the owner flagged, Clearwater → Edmond OK and → Virginia
Beach VA, are Freshpet XS frozen. The limit is 3 days: the weather table gives
2 (hot origin, A 28 °C), and the summer floor raises it to 3. The deadline is
10/30.

| Order | Before | After |
|---|---|---|
| 111-7440529-1259445 | UPS Ground, 2 d, EDD 10/28, $13.18 | UPS Ground Saver, 3 d, EDD 10/29, $10.48 |
| 113-3629043-9294601 | UPS Ground, 2 d, EDD 10/28, $11.61 | UPS Ground Saver, 3 d, EDD 10/29, $8.95 |

FedEx Ground Economy (4 d, EDD 10/30) and USPS Ground Advantage (5 d, EDD
10/31) are cut by the 3-day limit. This was correct before as well.

Summer v3.5 (`rate-selection.ts`, profile `summer`) keeps its $3 rule
unchanged. Commit e5c108a04.
