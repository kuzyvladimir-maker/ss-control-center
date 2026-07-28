/**
 * Amazon frozen shipping templates (merchant_shipping_group).
 *
 * Frozen bundles charge the customer weight-based shipping via an Amazon
 * shipping template instead of baking it into the item price (Vladimir
 * 2026-07-01). We attach the template GUID + set the full package weight so
 * Amazon computes the delivery charge.
 *
 * Owner's canonical setup (Vladimir 2026-07-04/07): only TWO templates exist —
 * "Small Frozen" (`27fef112…`) for XS/S coolers, and the account's Migrated
 * DEFAULT template for M/L/XL. Both charge $9/order + $1.50 per declared pound,
 * so the DECLARED weight (PACKAGE_WEIGHT_LB: S 10 / M 16 / L 24 / XL 34) is the
 * lever that makes the customer's shipping charge track our real label cost.
 */

import type { Cooler } from "@/lib/pricing/cost-model";

const SMALL_FROZEN_GUID = "27fef112-3cf4-4f8f-b117-7c47254aa16c";
/** The account's "Migrated Template" (DEFAULT) — Amazon identifies migrated
 *  legacy templates by this literal value in merchant_shipping_group (verified
 *  on the live BF listings, which show "Migrated Template" in Seller Central). */
const MIGRATED_DEFAULT_TEMPLATE = "legacy-template-id";

/** merchant_shipping_group for a cooler size (env override wins). Owner's rule
 *  (2026-07-04): XS/S ship on the "Small Frozen" template; M/L/XL ship on the
 *  Migrated default template ($9 + $1.50/lb — weight does the scaling). */
export function frozenShippingGroupGuid(cooler: Cooler): string {
  const env: Record<Cooler, string | undefined> = {
    S: process.env.BF_FROZEN_TEMPLATE_S,
    M: process.env.BF_FROZEN_TEMPLATE_M,
    L: process.env.BF_FROZEN_TEMPLATE_L,
    XL: process.env.BF_FROZEN_TEMPLATE_XL,
  };
  const fallback = cooler === "S" ? SMALL_FROZEN_GUID : MIGRATED_DEFAULT_TEMPLATE;
  return env[cooler] || fallback;
}

/** DECLARED package weight per cooler, in POUNDS — the owner's canonical
 *  convention (Vladimir 2026-07-07): S=10, M=16, L=24, XL=34. The frozen
 *  templates charge the customer 9 + 1.5×lb, so these weights make the charge
 *  track our real label cost (S $24/label~$20, M $33/~$32, L $45/$45, XL $60/$60). */
export const PACKAGE_WEIGHT_LB: Record<Cooler, number> = { S: 10, M: 16, L: 24, XL: 34 };

/** Frozen shipping-template rate: $9 per order + $1.50 per declared pound
 *  (same rate on Small Frozen and the Migrated default template). */
export const FROZEN_CHARGE_PER_ORDER_USD = 9;
export const FROZEN_CHARGE_PER_LB_USD = 1.5;

/** What the CUSTOMER pays for shipping for a given cooler size, in cents. */
export function frozenShippingChargeCents(cooler: Cooler): number {
  return Math.round(
    (FROZEN_CHARGE_PER_ORDER_USD + FROZEN_CHARGE_PER_LB_USD * PACKAGE_WEIGHT_LB[cooler]) * 100,
  );
}

/** Full package weight in ounces for the Amazon item_package_weight attribute. */
export function packageWeightOz(cooler: Cooler): number {
  return Math.round(PACKAGE_WEIGHT_LB[cooler] * 16);
}
