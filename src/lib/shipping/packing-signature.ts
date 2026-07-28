/**
 * Packing signature — deterministic key for PackingProfile lookups.
 *
 * Sorting by SKU is what makes [A:2, B:1] and [B:1, A:2] equivalent. The
 * format intentionally avoids whitespace/JSON so it's safe to store and
 * compare as a plain unique-indexed string.
 */

export interface OrderLineItem {
  sku: string;
  quantity: number;
  // Stable fallback identity (Veeqo sellable / product id) used ONLY when the
  // line has no SKU — e.g. Shopify (NAN health) / eBay listings that arrive
  // without a sku_code. Without it those items were dropped from the signature
  // → empty signature → "Order has no packing signature" → couldn't save a
  // packing profile → couldn't quote/buy. Keyed as `#<id>` so it can never
  // collide with a real SKU. Backward-compatible: a line WITH a SKU produces
  // the exact same key as before, so existing saved profiles still match.
  fallbackId?: string | number | null;
}

/** Deterministic key for one line: its SKU, else `#<fallbackId>`, else "". */
function lineKey(i: OrderLineItem): string {
  const sku = (i.sku ?? "").trim();
  if (sku) return sku;
  const fb = i.fallbackId != null ? String(i.fallbackId).trim() : "";
  return fb ? `#${fb}` : "";
}

export function buildPackingSignature(items: OrderLineItem[]): string {
  const keyed = items
    .map((i) => ({ key: lineKey(i), quantity: i.quantity }))
    .filter((i) => i.key && i.quantity > 0);
  const sorted = [...keyed].sort((a, b) => a.key.localeCompare(b.key));
  return sorted.map((i) => `${i.key}:${i.quantity}`).join("|");
}

export function buildPackingDescription(
  items: Array<{ productTitle: string; quantity: number }>
): string {
  return items.map((i) => `${i.productTitle} × ${i.quantity}`).join(" + ");
}

/**
 * "Does this order need a PackingProfile, or can it use the per-SKU
 * SkuShippingData row directly?" Two or more lines, or a single line with
 * qty > 1, requires a profile.
 */
export function requiresPackingProfile(items: OrderLineItem[]): boolean {
  if (items.length > 1) return true;
  if (items.length === 1 && items[0].quantity > 1) return true;
  return false;
}
