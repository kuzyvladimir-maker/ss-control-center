import type { LineItemStatus } from "@/lib/veeqo/procurement-notes-parser";

/**
 * Decide which order-level tags should be present after a procurement
 * action, based on the per-line-item statuses parsed out of the
 * [PROCUREMENT] block.
 *
 * Rules:
 *   - All line items have status `bought` → `Placed` (no `Need More`)
 *   - Some line items bought, others not (or some `remain:N`) → `Need More`
 *   - No line item has any status → neither tag (back to fresh state)
 *
 * `allLineItemIds` is the full set of line items on the order (passed
 * in because the [PROCUREMENT] block only mentions items that have been
 * touched; untouched items count as "not bought yet").
 */
export function decideOrderTags(
  allLineItemIds: ReadonlyArray<string>,
  statuses: ReadonlyMap<string, LineItemStatus>
): { addPlaced: boolean; addNeedMore: boolean } {
  if (allLineItemIds.length === 0) {
    return { addPlaced: false, addNeedMore: false };
  }

  let boughtCount = 0;
  let anyTouched = false;

  for (const id of allLineItemIds) {
    const s = statuses.get(id);
    if (!s) continue;
    anyTouched = true;
    if (s.kind === "bought") boughtCount++;
  }

  if (boughtCount === allLineItemIds.length) {
    return { addPlaced: true, addNeedMore: false };
  }
  if (anyTouched) {
    return { addPlaced: false, addNeedMore: true };
  }
  return { addPlaced: false, addNeedMore: false };
}
