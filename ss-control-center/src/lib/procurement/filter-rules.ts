import { hasTag, PROCUREMENT_TAGS } from "@/lib/veeqo/tags";
import { isFulfillmentOnlyStore } from "./excluded-stores";

/**
 * Decide whether a Veeqo order should appear in the Procurement list.
 *
 * Excluded if any of these tags are present:
 *   - Placed             → Vladimir already bought it; Shipping Labels owns it now
 *   - Заказано у Майка   → handed off to Mike (external buyer)
 *   - canceled           → won't be fulfilled
 *   - need to adjast     → can't be bought anywhere; needs marketplace adjustment
 *
 * Also excluded: orders from fulfillment-only stores (e.g. customer "Angel"
 * whose stock Vladimir already holds and just packs/ships, not buys).
 *
 * The `Need More` tag is NOT exclusionary — it actually means "still buying,
 * partially completed", which is exactly what Procurement shows.
 */
export function shouldIncludeOrderInProcurement(order: unknown): boolean {
  if (hasTag(order as never, PROCUREMENT_TAGS.PLACED)) return false;
  if (hasTag(order as never, PROCUREMENT_TAGS.ORDERED_BY_MIKE)) return false;
  if (hasTag(order as never, PROCUREMENT_TAGS.CANCELED)) return false;
  if (hasTag(order as never, PROCUREMENT_TAGS.NEED_TO_ADJUST)) return false;
  if (isFulfillmentOnlyStore(order as never)) return false;
  return true;
}
