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
 * Cache of all available company tags (id ↔ name lookup). Tags rarely
 * change, so we cache for the lifetime of the serverless function.
 * Refreshed on demand via `getTagId` if a name isn't found.
 */
let tagsCache: Array<{ id: number; name: string }> | null = null;

async function loadTags(force = false): Promise<Array<{ id: number; name: string }>> {
  if (!force && tagsCache) return tagsCache;
  const data = (await veeqoFetch(`/tags`)) as Array<{ id: number; name: string }>;
  tagsCache = Array.isArray(data) ? data : [];
  return tagsCache;
}

async function getTagId(tagName: string): Promise<number | null> {
  let tags = await loadTags();
  let found = tags.find((t) => t.name === tagName);
  if (!found) {
    // Maybe a brand new tag was just created — refresh once
    tags = await loadTags(true);
    found = tags.find((t) => t.name === tagName);
  }
  return found?.id ?? null;
}

/**
 * Attach an existing tag to one or more orders via Veeqo's bulk-tagging
 * endpoint. This is the ONE shape Veeqo's REST API actually accepts for
 * order-tag mutations — `PUT /orders/{id}` with `tags_attributes` or
 * `tag_list` returns 200 but silently does nothing.
 *
 * Reference: https://developers.veeqo.com/api/operations/untagging-orders/
 * (POST is the symmetric tagging endpoint, same body shape as DELETE)
 */
export async function bulkTagOrders(
  orderIds: ReadonlyArray<string | number>,
  tagIds: ReadonlyArray<number>
): Promise<void> {
  if (orderIds.length === 0 || tagIds.length === 0) return;
  await veeqoFetch(`/bulk_tagging`, {
    method: "POST",
    body: JSON.stringify({
      order_ids: orderIds.map((id) => Number(id)),
      tag_ids: [...tagIds],
    }),
  });
}

/**
 * Remove existing tag(s) from one or more orders via the documented
 * `DELETE /bulk_tagging` endpoint.
 */
export async function bulkUntagOrders(
  orderIds: ReadonlyArray<string | number>,
  tagIds: ReadonlyArray<number>
): Promise<void> {
  if (orderIds.length === 0 || tagIds.length === 0) return;
  await veeqoFetch(`/bulk_tagging`, {
    method: "DELETE",
    body: JSON.stringify({
      order_ids: orderIds.map((id) => Number(id)),
      tag_ids: [...tagIds],
    }),
  });
}

/**
 * Convenience wrapper: attach a tag to an order by name. Resolves the
 * tag id from /tags first.
 */
export async function addTagToOrder(
  orderId: string | number,
  tagName: string
): Promise<void> {
  const id = await getTagId(tagName);
  if (id == null) {
    throw new Error(
      `Tag '${tagName}' not found in Veeqo company tags — create it in the Veeqo UI first`
    );
  }
  await bulkTagOrders([orderId], [id]);
}

/**
 * Convenience wrapper: remove a tag from an order by name.
 */
export async function removeTagFromOrder(
  orderId: string | number,
  tagName: string
): Promise<void> {
  const id = await getTagId(tagName);
  if (id == null) return; // tag doesn't even exist; nothing to remove
  await bulkUntagOrders([orderId], [id]);
}

export { getTagId };
