import { veeqoFetch } from "./client";

// Procurement-related tag names. Note: `need to adjast` is intentionally
// misspelled — that's the tag Vladimir uses in Veeqo, we keep it verbatim.
const PROCUREMENT_TAG_NAMES = {
  PLACED: "Placed",
  NEED_MORE: "Need More",
  ORDERED_BY_MIKE: "Заказано у Майка",
  CANCELED: "canceled",
  NEED_TO_ADJUST: "need to adjast",
} as const;

export const PROCUREMENT_TAGS = PROCUREMENT_TAG_NAMES;

export type ProcurementTag =
  (typeof PROCUREMENT_TAG_NAMES)[keyof typeof PROCUREMENT_TAG_NAMES];

// Veeqo tag entries arrive either as plain strings or as objects with `id`/`name`.
type RawTag = string | { id?: number | string; name?: string } | null | undefined;

interface OrderLike {
  tags?: RawTag[] | null;
}

export interface OrderTag {
  id: number | string | null; // null when API returned a plain string
  name: string;
}

/**
 * Returns the full list of tags on an order with both id and name.
 * Tolerates both shapes Veeqo returns.
 *
 * The id is needed to send `tags_attributes: [{ id, _destroy: true }]`
 * when removing a tag via PUT /orders/{id} — Rails-style nested
 * attributes require the existing record id.
 */
export function getOrderTags(order: OrderLike | null | undefined): OrderTag[] {
  if (!order?.tags || !Array.isArray(order.tags)) return [];
  const out: OrderTag[] = [];
  for (const t of order.tags) {
    if (typeof t === "string") {
      if (t) out.push({ id: null, name: t });
    } else if (t && typeof t === "object" && typeof t.name === "string" && t.name) {
      out.push({ id: t.id ?? null, name: t.name });
    }
  }
  return out;
}

/** Convenience: just the names. */
export function getOrderTagNames(order: OrderLike | null | undefined): string[] {
  return getOrderTags(order).map((t) => t.name);
}

/**
 * Exact (case-sensitive) tag presence check.
 */
export function hasTag(
  order: OrderLike | null | undefined,
  tagName: string
): boolean {
  return getOrderTagNames(order).includes(tagName);
}

/** Default colour for our managed procurement tags. */
export function colourFor(tagName: string): string {
  if (tagName === PROCUREMENT_TAGS.PLACED) return "blue";
  if (tagName === PROCUREMENT_TAGS.NEED_MORE) return "yellow";
  return "grey";
}

/**
 * Add a tag to an order. Phase 1 does NOT call this — kept here so Phase 3
 * (the "купил всё" action) can use it.
 *
 * TODO(phase-3): The exact Veeqo endpoint for tag mutation isn't documented in
 * MASTER_PROMPT_v3.1.md (`POST /orders/{id}/tags` is noted as not working).
 * Try in this order when wiring Phase 3:
 *   1. PUT /orders/{id} with { order: { tag_list: ["Placed", ...] } }
 *   2. PUT /orders/{id} with { order: { tags_attributes: [...] } } (mirrors setProductTag)
 *   3. POST /orders/{id}/tags
 * If none work, ping Veeqo support — Vladimir has a contact.
 */
export async function addTagToOrder(
  orderId: string | number,
  tagName: string
): Promise<void> {
  const order = await veeqoFetch(`/orders/${orderId}`);
  const currentTags = getOrderTagNames(order);
  if (currentTags.includes(tagName)) return;

  const newTags = [...currentTags, tagName];
  await veeqoFetch(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({ order: { tag_list: newTags } }),
  });
}

/**
 * Remove a tag from an order. See TODO on `addTagToOrder` re: endpoint shape.
 */
export async function removeTagFromOrder(
  orderId: string | number,
  tagName: string
): Promise<void> {
  const order = await veeqoFetch(`/orders/${orderId}`);
  const currentTags = getOrderTagNames(order);
  const newTags = currentTags.filter((t) => t !== tagName);
  if (newTags.length === currentTags.length) return;

  await veeqoFetch(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({ order: { tag_list: newTags } }),
  });
}
