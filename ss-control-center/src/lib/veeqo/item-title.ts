/**
 * The full, human-readable name of a Veeqo order line.
 *
 * Veeqo splits a line item's name across TWO fields:
 *
 *   sellable.product_title — the PRODUCT master name
 *                            "Omega 3 Krill Oil Dietary Supplement Softgels"
 *   sellable.title         — the VARIANT the customer actually bought
 *                            "2-Pack Bundle", "60 Softgels Bottle"
 *
 * Veeqo's own order list renders the two joined together, which is why the
 * Veeqo tab reads "… Softgels 2-Pack Bundle" while the Command Center used
 * to show only the master half. That hid the single most important fact for
 * picking and packing: HOW MANY units go in the box. Channels that keep the
 * pack size in the master title (most Amazon listings) are unaffected — the
 * variant is then either empty, a placeholder, or already contained in the
 * master, and we return the master unchanged.
 *
 * See docs/wiki/veeqo-line-item-title.md.
 */

type Sellableish =
  | {
      sku_code?: unknown;
      sku?: unknown;
      title?: unknown;
      product_title?: unknown;
      product?: { title?: unknown; name?: unknown } | null;
    }
  | null
  | undefined;

/** Variant names that carry no information — Veeqo/Shopify defaults. */
const PLACEHOLDER_VARIANTS = new Set([
  "default title",
  "default",
  "base",
  "basic",
  "single",
  "standard",
  "one size",
  "n a",
  "na",
  "none",
]);

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Case/punctuation-insensitive form used only for the containment checks. */
const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Does `haystack` already contain `needle` as a whole run of words? */
const containsPhrase = (haystack: string, needle: string): boolean => {
  const n = normalize(needle);
  if (!n) return false;
  return ` ${normalize(haystack)} `.includes(` ${n} `);
};

export function buildVeeqoItemTitle(sellable: Sellableish): string {
  const s = sellable ?? {};
  const sku = str(s.sku_code) || str(s.sku);

  // The master name, with Veeqo's older field shapes as fallbacks.
  const base =
    str(s.product_title) || str(s.product?.title) || str(s.product?.name);
  const variant = str(s.title);

  if (!base) return variant || sku;
  if (!variant) return base;

  // A variant that is really the SKU, or a marketplace default, adds nothing.
  if (normalize(variant) === normalize(sku)) return base;
  if (PLACEHOLDER_VARIANTS.has(normalize(variant))) return base;

  // Already spelled out in the master name — nothing to append.
  if (containsPhrase(base, variant)) return base;
  // Some channels put the WHOLE name in the variant field; prefer it.
  if (containsPhrase(variant, base)) return variant;

  return `${base} ${variant}`;
}
