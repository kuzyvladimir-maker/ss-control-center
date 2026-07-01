/**
 * Fixed, reusable brand-story ("Dear customer / why-us") secondary image.
 *
 * A SINGLE unified asset shown on EVERY cold-chain (frozen/refrigerated) Amazon
 * listing — it explains the insulated foam-cooler + gel-pack packaging, the
 * delivery, the dedicated support and the pricing rationale. Produced ONCE and
 * uploaded to R2 (bucket salutem-bundle-factory-images, e.g. key
 * `prod/brand/salutem-brand-card-v1.png`); the publish path then references this
 * SAME url for all listings, so there is zero per-listing cost. See memory
 * project_brand_story_image and docs/marketplace-rules/amazon.
 *
 * It is a SECONDARY (gallery) image, never the MAIN — secondary slots allow
 * text/graphics, so a branded infographic is Amazon-compliant there (the MAIN
 * stays the frozen-hero cooler+product shot).
 *
 * LIVE asset (2026-07-01): generated via gpt-image-2, brand-voice-clean — no
 * emoji, no promo adjectives ("Superior packaging" → "Insulated foam cooler and
 * gel packs"). If this url is ever cleared to "" the injection becomes a safe
 * no-op again (no broken/empty image slot).
 */
export const BRAND_CARD_COLD_CHAIN_URL =
  "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/prod/brand/salutem-brand-card-v1.png";

/** Cold-chain when the temperature_rating value denotes Frozen or Chilled
 *  (matches the exact FOOD valid-value strings "Frozen: 0 degree" /
 *  "Chilled: 33 to 38 degrees"; "Ambient: Room Temperature" is not cold-chain). */
export function isColdChainTemperature(
  tempValue: string | null | undefined,
): boolean {
  return /\b(frozen|chilled)\b/i.test(tempValue ?? "");
}

/** First string `value` of an Amazon attribute array (`[{ value, ... }]`). */
function firstAttrValue(v: unknown): string | undefined {
  if (Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === "object") {
    const val = (v[0] as Record<string, unknown>).value;
    return typeof val === "string" ? val : undefined;
  }
  return undefined;
}

/**
 * Append the fixed brand-story card as the LAST secondary gallery slot, but ONLY
 * for cold-chain listings (gated on the already-merged temperature_rating) and
 * ONLY when the asset url is set. Mutates `attrs` in place.
 *
 * Placed after any existing `other_product_image_locator_N` so donor secondary
 * photos (once wired) always precede the brand card in the gallery.
 */
export function appendColdChainBrandCard(
  attrs: Record<string, unknown>,
  marketplaceId: string,
  url: string = BRAND_CARD_COLD_CHAIN_URL,
): void {
  if (!url) return;
  if (!isColdChainTemperature(firstAttrValue(attrs.temperature_rating))) return;

  let n = 1;
  while (attrs[`other_product_image_locator_${n}`] != null) n++;
  attrs[`other_product_image_locator_${n}`] = [
    { media_location: url, language_tag: "en_US", marketplace_id: marketplaceId },
  ];
}
