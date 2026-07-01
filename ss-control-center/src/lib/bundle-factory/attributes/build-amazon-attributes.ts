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
import {
  temperatureRatingForCategory,
  CONDITION_TYPE_NEW_LISTINGS_API,
} from "./valid-values-food";

/** FDA Big-9 allergens + the ingredient keywords that imply each. Conservative:
 *  "butter"/"cream" are deliberately excluded from Milk to avoid "peanut butter"
 *  false positives — the manufacturer label remains authoritative.
 *  NOTE: `canonical` MUST be the exact Amazon FOOD allergen_information valid
 *  value — "Crustacean" (not "Shellfish"), "Soy" (not "Soybeans"),
 *  "Sesame Seeds" (not "Sesame"); anything else is rejected by the PUT. */
const BIG_9: Array<{ canonical: string; re: RegExp }> = [
  { canonical: "Milk", re: /\b(milk|dairy|whey|casein|lactose|cheese)\b/i },
  { canonical: "Eggs", re: /\b(egg|eggs|albumin)\b/i },
  { canonical: "Fish", re: /\b(fish|cod|salmon|tuna|anchovy|tilapia)\b/i },
  { canonical: "Crustacean", re: /\b(shellfish|shrimp|crab|lobster|prawn|crustacean)\b/i },
  { canonical: "Tree Nuts", re: /\b(almond|walnut|cashew|pecan|pistachio|hazelnut|macadamia|tree ?nut)\b/i },
  { canonical: "Peanuts", re: /\b(peanut|peanuts)\b/i },
  { canonical: "Wheat", re: /\b(wheat|gluten|semolina|farina|durum)\b/i },
  { canonical: "Soy", re: /\b(soy|soya|soybean|soybeans|soy lecithin)\b/i },
  { canonical: "Sesame Seeds", re: /\b(sesame|tahini)\b/i },
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
   *  Amazon `temperature_rating` + `is_heat_sensitive` attributes. */
  category?: string | null;
  /** Bundle contains a liquid item (drink/sauce). Defaults false (solid food)
   *  → contains_liquid_contents = "No". Set true for drink bundles. */
  containsLiquid?: boolean;
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

  // --- Extra recommended FOOD attributes (owner: fill the full relevant set for
  // better Amazon search visibility). All are exact FOOD valid-value strings and
  // truthful for our bundles — nothing invented. See food-flat-file-notes.md.

  // condition_type — every bundle is a brand-new sealed product (Listings token).
  attrs.condition_type = [
    { value: CONDITION_TYPE_NEW_LISTINGS_API, marketplace_id: m },
  ];

  // product_expiration_type — consistent with is_expiration_dated_product above.
  attrs.product_expiration_type = [
    { value: "Expiration Date Required", marketplace_id: m },
  ];

  // is_heat_sensitive — cold-chain (frozen/refrigerated) food is heat sensitive;
  // dry/ambient is not. Derived from the same category signal as temperature.
  const c = (input.category ?? "").toUpperCase();
  const coldChain = /FROZEN|REFRIGERATED|CHILLED|COLD/.test(c);
  attrs.is_heat_sensitive = [
    { value: coldChain ? "Yes" : "No", marketplace_id: m },
  ];

  // contains_liquid_contents — default "No" (solid food); true only for drinks.
  attrs.contains_liquid_contents = [
    { value: input.containsLiquid ? "Yes" : "No", marketplace_id: m },
  ];

  return attrs;
}
