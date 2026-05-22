/**
 * Resolve the Amazon browse_node a bundle should publish under, given
 * its composition. The two rules that matter:
 *
 *   1. Multi-brand bundles (>1 distinct manufacturer brand) MUST live
 *      under a Gift Basket Exception node — without it, Amazon flags
 *      Trademark Logo Misuse because the listing names brands the
 *      seller isn't the manufacturer of. Rule 5 of the compliance
 *      gate fires when this is violated.
 *
 *   2. Single-brand bundles CAN use a category-specific node and don't
 *      need the exception. Today we still default to the same Gift
 *      Basket node for simplicity — the per-category Amazon node IDs
 *      need verification with Vladimir's Brand Registry first. The
 *      resolver's branching keeps the future swap a one-file change.
 *
 * Non-Amazon channels (Walmart, eBay, TikTok) return null — they don't
 * use this concept; their own item-type validators handle equivalents.
 */

import { GIFT_BASKET_EXCEPTION_NODES } from "./compliance/browse-nodes";

/** Primary Gift Basket Exception node — "Food Assortments & Variety Gifts". */
export const DEFAULT_GIFT_BASKET_NODE = GIFT_BASKET_EXCEPTION_NODES[0];

export interface BrandedComponent {
  brand?: string | null;
}

/** Distinct non-empty manufacturer brands, case-insensitive. */
export function countDistinctBrands(components: BrandedComponent[]): number {
  const set = new Set<string>();
  for (const c of components) {
    const b = (c.brand || "").trim().toLowerCase();
    if (b) set.add(b);
  }
  return set.size;
}

export interface ResolveAmazonBrowseNodeInput {
  channel: string;
  distinct_brands: number;
}

/**
 * Returns the Amazon browse_node to set on a ChannelSKU and to pass into
 * the compliance gate. Non-Amazon channels return null.
 */
export function resolveAmazonBrowseNode(
  input: ResolveAmazonBrowseNodeInput,
): string | null {
  if (!input.channel.startsWith("AMAZON_")) return null;
  if (input.distinct_brands > 1) {
    return DEFAULT_GIFT_BASKET_NODE;
  }
  // Single-brand: today the Gift Basket Exception is still the safest
  // default — it's a valid food node and won't be rejected. When
  // Vladimir confirms per-category Amazon node IDs (FROZEN_GROCERY →
  // 16310101, etc.) wire them through here.
  return DEFAULT_GIFT_BASKET_NODE;
}
