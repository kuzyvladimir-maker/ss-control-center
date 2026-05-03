/**
 * Veeqo stores/channels whose orders should NOT appear in the Procurement
 * list. Vladimir doesn't buy product for these — he ships from existing
 * warehouse stock as a fulfillment service.
 *
 * Currently:
 *   - "NAN health" — Shopify orders flow into Veeqo as a separate store.
 *     Vladimir's warehouse (Warehouse 1162) holds NAN health stock and
 *     packs/ships their orders, so they shouldn't show up in Procurement.
 *
 * Match is exact (trimmed, case-insensitive) against `order.channel.name`.
 * If the real Veeqo store name turns out to be different, edit this list.
 */
export const FULFILLMENT_ONLY_STORE_NAMES: ReadonlyArray<string> = [
  "NAN health",
  "NAN Health",
  "Nan health",
  "NANhealth",
];

const NORMALIZED_SET = new Set(
  FULFILLMENT_ONLY_STORE_NAMES.map((n) => n.trim().toLowerCase())
);

interface OrderLike {
  channel?: { name?: string } | null;
}

export function isFulfillmentOnlyStore(
  order: OrderLike | null | undefined
): boolean {
  const name = order?.channel?.name;
  if (typeof name !== "string") return false;
  return NORMALIZED_SET.has(name.trim().toLowerCase());
}
