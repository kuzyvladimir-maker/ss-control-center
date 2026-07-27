/**
 * Phase 2.1 / 1.2 — Amazon rich-attribute filler.
 *
 * Builds the food-compliance + composition attributes that the donor catalog
 * lets us fill (ingredients, allergens, item count) into Amazon attribute shape
 * (arrays of `{ value, marketplace_id }`). Stored on ChannelSKU.attributes by
 * promote-draft and merged into the publish payload by amazon-publish.ts.
 *
 * Ingredient statements are preserved exactly. Marketplace allergen and
 * expiration declarations are emitted only when an explicit reviewed value is
 * supplied; ingredient/category heuristics are never promoted as product facts.
 */

import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import {
  temperatureRatingForCategory,
  CONDITION_TYPE_NEW_LISTINGS_API,
  PRODUCT_EXPIRATION_TYPE_VALUES,
} from "./valid-values-food";

/** Exact positive tokens accepted by Amazon's food PTDs. Values still require
 * a reviewed manufacturer-label declaration; this allowlist is validation,
 * not an ingredient-to-allergen inference table. */
const AMAZON_ALLERGEN_TOKENS = new Set([
  "milk",
  "eggs",
  "fish",
  "crustacean",
  "tree_nuts",
  "peanuts",
  "wheat",
  "soy",
  "sesame_seeds",
  // Exact authoritative positive label supported by the live food PTDs.
  "hazelnut",
]);

export type ProductExpirationType =
  (typeof PRODUCT_EXPIRATION_TYPE_VALUES)[number];

/** Explicit reviewed evidence. The source is part of the input contract so a
 * category default cannot accidentally opt a listing into expiration fields. */
export interface VerifiedExpirationEvidence {
  source: "MANUFACTURER_LABEL" | "OPERATOR_REVIEW";
  is_expiration_dated_product: boolean;
  product_expiration_type?: ProductExpirationType | null;
}

export interface RichAttrInput {
  ingredients?: string | null;
  /** Authoritative positive Amazon allergen tokens from a reviewed manufacturer
   * declaration. Precautionary `may contain` labels must not be passed here. */
  allergens?: string[] | null;
  packCount?: number | null;
  /** Bundle category enum (FROZEN_* / REFRIGERATED_* / DRY_*). Drives the
   *  Amazon `temperature_rating` + `is_heat_sensitive` attributes. */
  category?: string | null;
  /** Bundle contains a liquid item (drink/sauce). Defaults false (solid food)
   *  → contains_liquid_contents = "No". Set true for drink bundles. */
  containsLiquid?: boolean;
  /** Reviewed manufacturer/operator evidence only. Omission means neither
   * expiration field is emitted. */
  verifiedExpiration?: VerifiedExpirationEvidence | null;
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
    const utf8Bytes = Buffer.byteLength(ingredients, "utf8");
    if (utf8Bytes > 6000) {
      throw new Error(
        `Manufacturer ingredients require ${utf8Bytes} UTF-8 bytes; Amazon food PTD allows 6000.`,
      );
    }
    attrs.ingredients = [
      { value: ingredients, language_tag: "en_US", marketplace_id: m },
    ];
  }
  const allergens = Array.from(new Set(input.allergens ?? []));
  for (const allergen of allergens) {
    if (!AMAZON_ALLERGEN_TOKENS.has(allergen)) {
      throw new Error(`Unsupported Amazon allergen token: ${JSON.stringify(allergen)}`);
    }
  }
  if (allergens.length > 0) {
    attrs.allergen_information = allergens.map((a) => ({
      value: a,
      marketplace_id: m,
    }));
  }

  if (input.packCount && input.packCount > 0) {
    attrs.number_of_items = [
      { value: Math.round(input.packCount), marketplace_id: m },
    ];
  }

  const expiration = input.verifiedExpiration;
  if (expiration) {
    if (
      expiration.source !== "MANUFACTURER_LABEL" &&
      expiration.source !== "OPERATOR_REVIEW"
    ) {
      throw new Error(
        `Unsupported expiration evidence source: ${JSON.stringify(expiration.source)}`,
      );
    }
    const expirationType = expiration.product_expiration_type ?? null;
    if (
      expirationType != null &&
      !(PRODUCT_EXPIRATION_TYPE_VALUES as readonly string[]).includes(expirationType)
    ) {
      throw new Error(
        `Unsupported Amazon product expiration type: ${JSON.stringify(expirationType)}`,
      );
    }
    if (
      expiration.is_expiration_dated_product === false &&
      expirationType != null &&
      expirationType !== "Does Not Expire"
    ) {
      throw new Error(
        "A non-expiring product cannot use an expiration-required product type.",
      );
    }
    if (
      expiration.is_expiration_dated_product === true &&
      expirationType === "Does Not Expire"
    ) {
      throw new Error(
        "An expiration-dated product cannot use the Does Not Expire product type.",
      );
    }
    attrs.is_expiration_dated_product = [
      { value: expiration.is_expiration_dated_product, marketplace_id: m },
    ];
    if (expirationType != null) {
      attrs.product_expiration_type = [
        { value: expirationType, marketplace_id: m },
      ];
    }
  }

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

  // is_heat_sensitive — cold-chain (frozen/refrigerated) food is heat sensitive;
  // dry/ambient is not. Derived from the same category signal as temperature.
  const c = (input.category ?? "").toUpperCase();
  const coldChain = /FROZEN|REFRIGERATED|CHILLED|COLD/.test(c);
  attrs.is_heat_sensitive = [
    { value: coldChain, marketplace_id: m },
  ];

  // contains_liquid_contents — default "No" (solid food); true only for drinks.
  attrs.contains_liquid_contents = [
    { value: Boolean(input.containsLiquid), marketplace_id: m },
  ];

  return attrs;
}
