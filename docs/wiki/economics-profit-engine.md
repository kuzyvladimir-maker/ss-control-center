# Economics / Profit module (Phase 7)

**Status:** 7.0 + 7.1 shipped (2026-06-20). 7.2 (OpEx + business P&L) pending
Vladimir's Sellerboard expenses CSV. 7.3 (settlement reconciliation) later.

## What it is

A read-only financial-planning page (`/economics`) where every live ASIN/SKU
has a clear unit profit:

```
revenue  = item_price + shipping_charged          (what the customer pays in total)
referral = referralFee(marketplace, category, revenue)   (on the TOTAL sale)
profit   = revenue − COGS − packaging − referral − own_shipping
margin%  = profit / revenue
```

`revenue = item + shipping` is Vladimir's rule (the 20% margin target is on total
landed revenue, not item-only). Two per-marketplace fee calculators (Amazon vs
Walmart, category-based). Rows sorted worst-margin first = the worklist.

## Data roles (decided with Vladimir 2026-06-20)

| Input | Source |
|---|---|
| Revenue / price | Amazon: `AmazonListingSnapshot.price` (latest per store+sku); Walmart: `WalmartBuyBoxItem.sellerItemPrice` |
| Shipping charged | Walmart: `WalmartBuyBoxItem.sellerShipPrice`; Amazon MFN: ≈ own label (flagged estimate) |
| COGS | `SkuCost` table (the parallel sourcing engine fills it from the donor base). Module CONSUMES it, never matches donors itself. No fresh row → `cogs_missing` flag. |
| Packaging | cooler + ice from cost-model numbers, **weight-based** cooler. Guarded by `SkuCost.includesPackaging` (no double-count). |
| Own shipping | Amazon: avg `AmazonOrderShipment.outboundLabelCost` per SKU. Walmart: estimated from weight via cost-model `LABEL` (flagged). |
| Referral fee | OUR estimated calculators (`fee-tables.ts`). NOT settlement actuals. |
| OpEx (rent/salary/subscriptions) | Sellerboard "expenses" CSV → `OpExEntry` (Phase 7.2). NOT per-SKU COGS. |

Fulfillment is MFN/buy-to-order → no FBA fee/storage; "own shipping" = our real
Veeqo/SWW label + packaging.

## Files

- `src/lib/economics/types.ts` — ProfitInput / ProfitResult / FeeCategory.
- `src/lib/economics/fee-tables.ts` — `amazonReferralFee` / `walmartReferralFee`
  (published US schedules as data; Amazon grocery 8% ≤$15 else 15%, Walmart
  grocery 8% ≤$10 else 15%; estimate, calibrate against settlement later).
- `src/lib/economics/compute-profit.ts` — `computeProfit()`, the one pure formula.
- `src/lib/economics/packaging.ts` — `coolerForWeight` / `iceCost` /
  `packagingForSku` (double-count guard). New weight-based cooler — the
  Uncrustables unit-count `coolerFor` in cost-model.ts is left untouched.
- `src/lib/economics/cogs.ts` — `getCogsForSkus()` over `SkuCost`, pack-aware,
  `missing` / `stale` flags. Mirrors reprice-engine's "latest effectiveDate wins".
- `src/lib/economics/categories.ts` — `resolveSkuCategories()`, default
  `grocery_food`, overrides via `Setting` key `economics:category:<sku>`.
- `src/lib/economics/resolve-sku.ts` — `loadSkuEconomics()`, the only DB
  orchestrator; assembles inputs from caches, flags everything estimated.
- `src/app/api/economics/skus/route.ts` — `GET ?store=&marketplace=`.
- `src/app/economics/page.tsx` — table + KPIs (live SKUs / COGS missing /
  below-20% margin). Nav entry in `SidebarContent.tsx` after Reference Catalog.
- `scripts/check-economics-core.ts` — pure-core sanity checks (all pass).
- `scripts/smoke-economics.ts` — live orchestrator smoke (needs Turso env; local
  dev.db is unmigrated so it only runs against prod/deploy).

## Estimated vs actual

Everything from `fee-tables.ts` is a PLANNING estimate. Actual referral/FBA fees
live in settlement reports (`settlement-reports.ts`, `amountDescription`). Phase
7.3 parses those and shows estimate-vs-actual drift. Do not feed estimated fees
into the repricer's hard floor without sign-off. Follow-up: point
`reprice-engine.marginFloorPrice` at `fee-tables.ts` so the floor and this page
share one fee model (the legacy hardcoded 15% is `LEGACY_FLAT_REFERRAL`).

## Known gaps / next

- 7.2: add `OpExEntry` table + Sellerboard expenses CSV import + business P&L
  (Σ contribution − OpEx). Blocked on the actual CSV column layout from Vladimir.
- Walmart SKUs have ~zero Sellerboard COGS (Sellerboard is Amazon-only) → most
  show `cogs_missing` until the donor-base sourcing fills `SkuCost`.
- P&L volume weighting is by order count until per-order line items exist (7.3).
