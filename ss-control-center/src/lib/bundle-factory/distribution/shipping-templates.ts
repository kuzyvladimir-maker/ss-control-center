/**
 * Amazon frozen shipping templates (merchant_shipping_group).
 *
 * Frozen bundles charge the customer weight-based shipping via an Amazon
 * shipping template instead of baking it into the item price (Vladimir
 * 2026-07-01). We attach the template GUID + set the full package weight so
 * Amazon computes the delivery charge.
 *
 * Small Frozen (`27fef112…`) is the template Vladimir's live best-sellers use
 * for the S-band. M/L/XL default to it until size-specific GUIDs are supplied
 * (env-overridable) — Amazon charges by the package WEIGHT within a template,
 * so a weight-tiered template still scales up for heavier sets. The owner's SP
 * data only showed S-band templates; confirm M/L/XL GUIDs when available.
 */

import type { Cooler } from "@/lib/pricing/cost-model";

const SMALL_FROZEN_GUID = "27fef112-3cf4-4f8f-b117-7c47254aa16c";

/** merchant_shipping_group GUID for a cooler size (env override → Small Frozen). */
export function frozenShippingGroupGuid(cooler: Cooler): string {
  const env: Record<Cooler, string | undefined> = {
    S: process.env.BF_FROZEN_TEMPLATE_S,
    M: process.env.BF_FROZEN_TEMPLATE_M,
    L: process.env.BF_FROZEN_TEMPLATE_L,
    XL: process.env.BF_FROZEN_TEMPLATE_XL,
  };
  return env[cooler] || SMALL_FROZEN_GUID;
}

/** Full package weight (product + cooler + ice + box) per cooler, in POUNDS —
 *  the owner's shipping-template bands (S 10–12 / M 16–18 / L ~22 / XL 32–34). */
const PACKAGE_WEIGHT_LB: Record<Cooler, number> = { S: 11, M: 17, L: 22, XL: 33 };

/** Full package weight in ounces for the Amazon item_package_weight attribute. */
export function packageWeightOz(cooler: Cooler): number {
  return Math.round(PACKAGE_WEIGHT_LB[cooler] * 16);
}
