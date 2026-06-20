// Shared types for the Economics / Profit module (Phase 7).
//
// The whole module is built around one pure formula (see compute-profit.ts):
//
//   profit  = revenue − COGS − packaging − referral_fee − own_shipping
//   revenue = item_price + shipping_charged   (what the customer pays in total)
//   margin% = profit / revenue
//
// "revenue = item + shipping" is Vladimir's rule (the margin target is 20% of
// TOTAL landed revenue, not item-only — see the SKU unit-economics decision).

export type Marketplace = "amazon" | "walmart";

/** Fee category used to pick the right referral-fee rate. Most Salutem items
 *  are food bundles → "grocery_food". Kept small on purpose. */
export type FeeCategory =
  | "grocery_food"
  | "health_personal_care"
  | "beauty"
  | "home_kitchen"
  | "pet"
  | "other";

/** Everything computeProfit() needs — all primitives, no I/O, so it unit-tests
 *  without a database. The orchestrator (resolve-sku.ts) fills this in. */
export interface ProfitInput {
  sku: string;
  marketplace: Marketplace;
  /** Listing price of the item itself. */
  itemPrice: number;
  /** What the customer pays for shipping on top (≈ our label cost on MFN). */
  shippingCharged: number;
  /** Landed product cost for the WHOLE listing (pack-aware: perUnit × packSize). */
  cogs: number;
  /** Cooler + ice + box. 0 when the COGS source already bakes packaging in. */
  packaging: number;
  /** Our own outbound shipping cost — the Veeqo/SWW label we actually pay. */
  ownShipping: number;
  category: FeeCategory;
}

export interface ProfitResult {
  sku: string;
  marketplace: Marketplace;
  /** profit = revenue − cogs − packaging − referralFee − ownShipping. */
  profit: number;
  /** profit / revenue, where revenue = itemPrice + shippingCharged. 0 if no revenue. */
  marginPct: number;
  referralFee: number;
  revenue: number;
  breakdown: {
    itemPrice: number;
    shippingCharged: number;
    cogs: number;
    packaging: number;
    referralFee: number;
    ownShipping: number;
  };
  /** Soft warnings the UI surfaces, e.g. "cogs_missing", "cogs_estimated",
   *  "cogs_stale", "packaging_estimated", "below_target_margin". */
  flags: string[];
}

/** A bucket of operating expense (rent / salaries / subscriptions / payments)
 *  for the business-level P&L. Sourced from the Sellerboard expenses export. */
export interface OpExBucket {
  category: string;
  amount: number;
}
