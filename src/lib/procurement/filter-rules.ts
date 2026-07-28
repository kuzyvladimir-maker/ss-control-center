import { hasTag, PROCUREMENT_TAGS } from "@/lib/veeqo/tags";
import { isFulfillmentOnlyStore } from "./excluded-stores";

/**
 * Decide whether a Veeqo order should appear in the Procurement list.
 *
 * Excluded if any of these tags are present:
 *   - Placed             → Vladimir already bought it; Shipping Labels owns it now
 *   - canceled           → won't be fulfilled
 *   - need to adjast     → can't be bought anywhere; needs marketplace adjustment
 *
 * Also excluded: orders from fulfillment-only stores (e.g. customer "Angel"
 * whose stock Vladimir already holds and just packs/ships, not buys).
 *
 * NOT exclusionary:
 *   - Заказано у Майка   → ordered through Mike (Publix) rather than online.
 *     These USED to be hidden, which dropped them into a blind spot: invisible
 *     in Procurement yet still "Waiting for procurement" on Shipping Labels
 *     (which only looks at the `Placed` tag). They now stay in the list,
 *     flagged `fromMike` so the UI paints them with a bright "от Майка" badge
 *     and keeps them OUT of the buy pool — see `fromMike` on ProcurementCard.
 *   - Need More          → "still buying, partially completed", which is
 *     exactly what Procurement shows.
 */
export function shouldIncludeOrderInProcurement(order: unknown): boolean {
  if (hasTag(order as never, PROCUREMENT_TAGS.PLACED)) return false;
  if (hasTag(order as never, PROCUREMENT_TAGS.CANCELED)) return false;
  if (hasTag(order as never, PROCUREMENT_TAGS.NEED_TO_ADJUST)) return false;
  if (isFulfillmentOnlyStore(order as never)) return false;
  return true;
}
