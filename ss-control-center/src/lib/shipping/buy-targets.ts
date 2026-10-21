/**
 * Which ShippingPlan each row's plan item actually lives in.
 *
 * The page loads ONE batch plan for every ready order. But a per-order
 * re-quote (after the operator saves a new box/weight, or changes the ship
 * date) asks /api/shipping/plan for that single order — and the server
 * answers with a BRAND-NEW plan, whose item has a new id. The page merges that
 * item into its batch list, so the row shows the new weight/box/rate.
 *
 * The buy used to send the BATCH planId together with that NEW item id. The
 * buy route looks the item up inside the plan it was given, finds nothing,
 * and buys nothing: "Buy label" came back with zeros, and only a full page
 * refresh (one new batch plan holding every item) made the purchase work.
 *
 * So every merged item carries its own `planId`, and buys are grouped by it.
 */

export interface PlannedItem {
  id: string;
  orderNumber: string;
  /** Set on items merged in from a single-order re-quote. */
  planId?: string | null;
}

export interface BuyGroup<T extends PlannedItem> {
  planId: string;
  items: T[];
}

/**
 * Group plan items by the plan they belong to. Items without their own
 * `planId` belong to the page's batch plan (`batchPlanId`). Items that
 * belong to no known plan are dropped — there is nothing the buy route
 * could resolve them against.
 */
export function groupBuyTargets<T extends PlannedItem>(
  items: T[],
  batchPlanId: string | null | undefined,
): BuyGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const planId = item.planId || batchPlanId;
    if (!planId) continue;
    const list = groups.get(planId);
    if (list) list.push(item);
    else groups.set(planId, [item]);
  }
  return [...groups.entries()].map(([planId, list]) => ({
    planId,
    items: list,
  }));
}
