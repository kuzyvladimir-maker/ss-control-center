/**
 * Veeqo product-image lookup by SKU.
 *
 * Why this exists: Walmart's Marketplace API doesn't expose product images
 * anywhere, and scraping walmart.com from Vercel datacenter IPs gets served
 * a PerimeterX captcha page (confirmed via runtime logs — 200 OK with a
 * 15kB challenge body instead of the real product page). Veeqo already
 * mirrors our full product catalog and serves thumbnails via its own CDN
 * (thumbnails.veeqo.com), so we use it as the image source instead.
 *
 * Used by /api/walmart/retire-listing/sku-details to fan out per-SKU image
 * lookups when the "Снять с продажи" modal renders its results.
 */

import { veeqoFetch } from "./client";

interface VeeqoSellableLite {
  sku_code?: string;
  image_url?: string;
  main_thumbnail_url?: string;
}

interface VeeqoProductLite {
  id?: number | string;
  title?: string;
  main_image_src?: string;
  main_image_url?: string;
  sellables?: VeeqoSellableLite[];
}

/**
 * Look up the product image URL for a single seller SKU.
 *
 * Strategy: Veeqo's `/products?query=` searches across product title AND
 * sellable sku_code. The first result is almost always our exact SKU
 * match — we then look across its sellables for the one whose sku_code
 * equals our requested SKU and use that sellable's per-variant image,
 * falling back to the product-level main_image_src when the sellable
 * has no image of its own.
 *
 * Returns null when Veeqo returns no results / the SKU isn't found.
 */
export async function fetchVeeqoImageBySku(
  sku: string,
): Promise<string | null> {
  if (!sku.trim()) return null;
  let products: VeeqoProductLite[];
  try {
    const data = await veeqoFetch(`/products?query=${encodeURIComponent(sku)}`);
    products = Array.isArray(data) ? (data as VeeqoProductLite[]) : [];
  } catch {
    return null;
  }
  if (products.length === 0) return null;

  // Find a sellable whose sku_code is an EXACT match, across all returned
  // products. /products?query=X is loose (matches title + sku, returns
  // 11 results for our test SKU) — scanning every sellable guarantees we
  // pick the right one even when ranking puts a related variant first.
  for (const p of products) {
    for (const s of p.sellables ?? []) {
      if (s.sku_code === sku) {
        return s.image_url || s.main_thumbnail_url || p.main_image_src || p.main_image_url || null;
      }
    }
  }

  // No exact sku match — fall back to the first product's image. Better
  // than nothing (visually shows the same product family).
  const p0 = products[0]!;
  return p0.main_image_src || p0.main_image_url || null;
}
