// Phase 2.0 Compliance Gate — Amazon Gift Basket Exception browse nodes.
//
// Multi-brand bundles are only allowed under these category nodes
// (Amazon Gift Basket Policy, Oct 2024). Listings under any other node
// that mention multiple manufacturer brands risk Trademark Logo Misuse
// the way the 2026-05-17 RETAILER ASINs did.
//
// Reused from `bundle-factory/audit/forbidden-brands.ts` (GIFT_BASKET_EXCEPTION_NODES)
// but re-declared here as the compliance module's source of truth so the
// audit module's list can drift over time without surprising the gate.

export const GIFT_BASKET_EXCEPTION_NODES = [
  "12011207011", // Food Assortments & Variety Gifts (primary)
  "2255572011", // Candy & Chocolate Gifts
  "2255573011", // Cheese & Charcuterie Gifts
  "23900459011", // Coffee Gifts
  "23700435011", // Gourmet Tea Gifts
  "78380725011", // Advent Calendars
] as const;

export type GiftBasketExceptionNode = (typeof GIFT_BASKET_EXCEPTION_NODES)[number];

const NODE_SET = new Set<string>(GIFT_BASKET_EXCEPTION_NODES);

/**
 * True if the given browse node id (string) is one of the Gift Basket
 * Exception nodes. Whitespace is trimmed; null/undefined returns false.
 */
export function isGiftBasketExceptionNode(node: string | null | undefined): boolean {
  if (!node) return false;
  return NODE_SET.has(node.trim());
}
