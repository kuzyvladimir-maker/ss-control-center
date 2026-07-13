# 🧪 New-ASIN Launch Experiment — Coupon vs Sale Price (A/B)

**Owner decision 2026-07-13.** Test which price lever brings a NEW Amazon listing
to life fastest. Extends [[pricing-launch-sop]] (Layer B) — same discount depth,
we vary only the MECHANISM and measure sales.

## Hypothesis
At equal effective discount, does a **coupon** (green clip badge) or a **sale
price** (strikethrough "Was/Now") produce first sales sooner and more units?

## Design (163 live Uncrustables ASINs, store1 Salutem)
- **Foundation (both arms):** base list price = Layer A ITEM PRICE for every ASIN,
  enforced by the ChannelMax min/max file (`Min=floor ×1.3`, `Max=ITEM ×1.5`).
  Base is identical across arms → only the lever differs.
- **Balanced split:** within each count tier (24/30/45/90/120) ASINs are alternated
  A/B, so both arms have the same count-mix (≈ 47/10/10/8/7). No count confound.
- **ARM A — COUPON** (82 ASINs): grouped into **5 coupons by count** (ASINs
  semicolon-joined), **13% off**, 30-day window, budgets $110/$120/$180/$340/$400
  (≈10 redemptions/tier) = **$1,150 committed** (spent only on redemptions + $0.60
  each). Grouped by owner (2026-07-13) to keep committed budget low; per-ASIN sales
  attribution recovered later from the coupon/statement report.
- **ARM B — SALE PRICE** (81 ASINs): per-ASIN `purchasable_offer.discounted_price`
  with `start_at`/`end_at` via SP-API, **13% off** (effective = Arm A effective ≈
  floor). No redemption fee, no budget.
- **Window:** 2026-07-14 → 2026-08-13 (30-day honeymoon).

## Files (command-center `public/`, served at salutemsolutions.info)
- `channelmax-uncrustables-launch.txt` — base guardrail, all 163 (upload first).
- `coupons-uncrustables-launch.csv` — Arm A, 5 grouped coupons (Jackie → Manage Coupons in bulk).
- `salesprice-uncrustables-launch.csv` — Arm B spec (applied via SP-API).
- `launch-experiment-assignments.csv` — master map ASIN→arm→effective price (metrics join key).

## Execution order
1. Jackie uploads the ChannelMax file → prices settle to ITEM PRICE (both arms).
2. Jackie uploads Arm A coupons (Manage Coupons in bulk).
3. We set Arm B sale prices via SP-API (`discounted_price` + dates).
4. Run 30 days; measure.

## Metrics (compare Arm A vs Arm B over the window)
Join Amazon **Sales & Traffic by child ASIN** (SP-API `GET_SALES_AND_TRAFFIC_REPORT`)
to `launch-experiment-assignments.csv`, aggregate per arm:
- **Time-to-first-sale** (days from launch to first unit).
- **Units ordered** (total + per count tier).
- **Sessions / Glance Views** (traffic).
- **Unit Session % (conversion).**
- **Ordered product sales $.**
Equal effective price + equal count-mix → the winner = the more effective lever.
Coupon per-ASIN redemptions from the coupon performance / statement report.

## After the test (per SOP Layer B)
Winning lever stays; narrow the discount in steps (**13→10→7→4→0**, one step every
3–5 days while velocity holds) back to the permanent Layer A ITEM PRICE. Base list
price never moves — only the coupon/sale overlay.

## Связано с
- [[pricing-launch-sop]] — Layer A price model + Layer B launch rules
- [[channelmax-guide]] — how the min/max file feeds the repricer
- [[uncrustables-pricing-model]] — validated cost model
