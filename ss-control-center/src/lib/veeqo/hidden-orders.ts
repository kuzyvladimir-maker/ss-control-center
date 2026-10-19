/**
 * Veeqo orders the Command Center must never show.
 *
 * Technical orders that live in Veeqo for another system's sake — they are
 * not real sales, nothing needs to be bought or shipped for them, and they
 * must not inflate any count or statistic. Filtering happens at the Veeqo
 * read choke points (fetchAllOrders, fetchOrdersInRange, searchOrders and the
 * Procurement fetcher), so every module downstream inherits it.
 *
 * To hide another order: add its numeric Veeqo id AND its order number.
 */
export const HIDDEN_VEEQO_ORDERS: ReadonlyArray<{
  id: string;
  number: string;
  reason: string;
}> = [
  {
    id: "2164588032",
    number: "TEST-RATE-DELETE-ME-2",
    reason:
      "Technical order used by the StillFrozen site — hidden from the Command Center (owner 2026-10-19)",
  },
];

const HIDDEN_IDS = new Set(HIDDEN_VEEQO_ORDERS.map((o) => o.id));
const HIDDEN_NUMBERS = new Set(HIDDEN_VEEQO_ORDERS.map((o) => o.number));

export function isHiddenVeeqoOrder(order: unknown): boolean {
  if (!order || typeof order !== "object") return false;
  const o = order as { id?: unknown; number?: unknown };
  return (
    (o.id != null && HIDDEN_IDS.has(String(o.id))) ||
    (o.number != null && HIDDEN_NUMBERS.has(String(o.number)))
  );
}

export function withoutHiddenOrders<T>(orders: T[]): T[] {
  return orders.filter((o) => !isHiddenVeeqoOrder(o));
}
