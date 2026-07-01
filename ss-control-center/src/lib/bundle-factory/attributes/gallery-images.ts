/**
 * Secondary (gallery) image wiring for Amazon listings.
 *
 * Amazon lets a listing carry a MAIN image plus up to 8 secondary gallery
 * images (`other_product_image_locator_1..8`). The Bundle Factory previously
 * populated NONE of the secondary slots except the cold-chain brand card — the
 * donor's own infographic/nutrition/lifestyle photos were harvested and stored
 * on the draft but never reached the payload. This module closes that gap:
 *
 *   donor secondary photos (retailer CDN) → mirror to R2 → gallery locators.
 *
 * We mirror to R2 because Amazon must be able to fetch the image reliably;
 * retailer CDNs rotate keys and can block Amazon's fetcher. The brand card is
 * appended AFTER these (see brand-assets.appendColdChainBrandCard), so the
 * gallery reads: donor infographic/lifestyle …, then the "why-us" card.
 */

import { mirrorImages } from "../r2-image-mirror";

/** Reserve the last slot(s) for the brand card → cap donor gallery at 6, well
 *  under Amazon's 8-slot ceiling. */
export const MAX_DONOR_GALLERY = 6;

/** Ask known retailer CDNs for a large, white-background render so the mirrored
 *  gallery image is crisp and Amazon-friendly (≥1000px recommended). Unknown
 *  hosts pass through unchanged. */
export function upsizeCdnUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname;
    // Adobe Scene7 (Target): wid/hei/qlt.
    if (host.includes("scene7.com")) {
      u.searchParams.set("wid", "1600");
      u.searchParams.set("hei", "1600");
      u.searchParams.set("fmt", "jpeg");
      u.searchParams.set("qlt", "90");
      return u.toString();
    }
    // Walmart i5 images: odnHeight/odnWidth + white bg.
    if (host.includes("walmartimages.com")) {
      u.searchParams.set("odnHeight", "1600");
      u.searchParams.set("odnWidth", "1600");
      u.searchParams.set("odnBg", "FFFFFF");
      return u.toString();
    }
    // Salsify (nutrition labels etc.) — already sized; leave as-is.
    return url;
  } catch {
    return url;
  }
}

/** Build `other_product_image_locator_N` attribute entries from already-hosted
 *  URLs, filling from slot `startSlot` (1-based). Returns an attribute-shaped
 *  object ready to merge/Object.assign into the payload. */
export function galleryLocatorAttrs(
  urls: string[],
  marketplaceId: string,
  startSlot = 1,
  max = MAX_DONOR_GALLERY,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  urls.slice(0, max).forEach((url, i) => {
    out[`other_product_image_locator_${startSlot + i}`] = [
      { media_location: url, language_tag: "en_US", marketplace_id: marketplaceId },
    ];
  });
  return out;
}

/**
 * Mirror donor secondary photos to R2 and return the hosted URLs, upsized and
 * de-duplicated, capped to MAX_DONOR_GALLERY. Only successfully-uploaded images
 * are returned (an un-mirrored retailer URL is unreliable for Amazon, so it's
 * dropped rather than risk a broken gallery slot). Best-effort: returns [] on
 * any failure so the caller still publishes with just main + brand card.
 */
export async function mirrorDonorGallery(
  bundleSku: string,
  rawUrls: string[],
): Promise<string[]> {
  const seen = new Set<string>();
  const urls = rawUrls
    .filter((u) => typeof u === "string" && u.trim().length > 0)
    .map((u) => upsizeCdnUrl(u.trim()))
    .filter((u) => (seen.has(u) ? false : (seen.add(u), true)))
    .slice(0, MAX_DONOR_GALLERY);
  if (urls.length === 0) return [];
  try {
    const res = await mirrorImages({ bundle_sku: bundleSku, image_urls: urls });
    return res.filter((r) => r.uploaded).map((r) => r.r2_url);
  } catch {
    return [];
  }
}
