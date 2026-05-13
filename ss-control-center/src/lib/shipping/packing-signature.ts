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
}

export function buildPackingSignature(items: OrderLineItem[]): string {
  const filtered = items.filter((i) => i.sku && i.quantity > 0);
  const sorted = [...filtered].sort((a, b) => a.sku.localeCompare(b.sku));
  return sorted.map((i) => `${i.sku}:${i.quantity}`).join("|");
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
