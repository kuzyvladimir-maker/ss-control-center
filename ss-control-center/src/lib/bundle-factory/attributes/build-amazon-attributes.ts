/**
 * Phase 2.1 / 1.2 — Amazon rich-attribute filler.
 *
 * Builds the food-compliance + composition attributes that the donor catalog
 * lets us fill (ingredients, allergens, item count) into Amazon attribute shape
 * (arrays of `{ value, marketplace_id }`). Stored on ChannelSKU.attributes by
 * promote-draft and merged into the publish payload by amazon-publish.ts.
 *
 * Allergens are derived from the donor ingredient statement with a conservative
 * FDA "Big-9" keyword scan. This is BEST-EFFORT — the authoritative source is
 * the manufacturer label (which the curator disclaimer points buyers to), and
 * the Qualification Officer (Phase 4) verifies before publish.
 */

import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { temperatureRatingForCategory } from "./valid-values-food";

/** FDA Big-9 allergens + the ingredient keywords that imply each. Conservative:
 *  "butter"/"cream" are deliberately excluded from Milk to avoid "peanut butter"
 *  false positives — the manufacturer label remains authoritative. */
const BIG_9: Array<{ canonical: string; re: RegExp }> = [
  { canonical: "Milk", re: /\b(milk|dairy|whey|casein|lactose|cheese)\b/i },
  { canonical: "Eggs", re: /\b(egg|eggs|albumin)\b/i },
  { canonical: "Fish", re: /\b(fish|cod|salmon|tuna|anchovy|tilapia)\b/i },
  { canonical: "Shellfish", re: /\b(shellfish|shrimp|crab|lobster|prawn|crustacean)\b/i },
  { canonical: "Tree Nuts", re: /\b(almond|walnut|cashew|pecan|pistachio|hazelnut|macadamia|tree ?nut)\b/i },
  { canonical: "Peanuts", re: /\b(peanut|peanuts)\b/i },
  { canonical: "Wheat", re: /\b(wheat|gluten|semolina|farina|durum)\b/i },
  { canonical: "Soybeans", re: /\b(soy|soya|soybean|soybeans|soy lecithin)\b/i },
  { canonical: "Sesame", re: /\b(sesame|tahini)\b/i },
];

/** Conservative FDA Big-9 allergen scan over an ingredient statement. */
export function extractAllergens(ingredients?: string | null): string[] {
  if (!ingredients) return [];
  const out: string[] = [];
  for (const a of BIG_9) if (a.re.test(ingredients)) out.push(a.canonical);
  return out;
}

export interface RichAttrInput {
  ingredients?: string | null;
  packCount?: number | null;
  /** Bundle category enum (FROZEN_* / REFRIGERATED_* / DRY_*). Drives the
   *  Amazon `temperature_rating` attribute with the exact valid-value string. */
  category?: string | null;
}

/** Amazon attribute arrays for the donor-derived fields. Empty object if no
 *  donor data — caller merges, so missing keys just fall back to base attrs. */
export function buildRichAmazonAttributes(
  input: RichAttrInput,
): Record<string, unknown> {
  const m = MARKETPLACE_ID;
  const attrs: Record<string, unknown> = {};

  const ingredients = input.ingredients?.trim();
  if (ingredients) {
    attrs.ingredients = [
      { value: ingredients.slice(0, 5000), language_tag: "en_US", marketplace_id: m },
    ];
    const allergens = extractAllergens(ingredients);
    if (allergens.length > 0) {
      attrs.allergen_information = allergens.map((a) => ({
        value: a,
        marketplace_id: m,
      }));
    }
  }

  if (input.packCount && input.packCount > 0) {
    attrs.number_of_items = [
      { value: Math.round(input.packCount), marketplace_id: m },
    ];
  }

  // Food — always expiration-dated.
  attrs.is_expiration_dated_product = [{ value: true, marketplace_id: m }];

  // Storage temperature — exact Amazon FOOD valid-value string, from category.
  // (frozen → "Frozen: 0 degree", refrigerated → "Chilled: 33 to 38 degrees",
  // else "Ambient: Room Temperature"). The first-submit VALIDATION_PREVIEW
  // catches a bad enum before the real PUT, so this is safe to send.
  attrs.temperature_rating = [
    { value: temperatureRatingForCategory(input.category), marketplace_id: m },
  ];

  return attrs;
}
