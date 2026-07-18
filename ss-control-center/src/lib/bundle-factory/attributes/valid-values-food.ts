/**
 * Amazon FOOD product-type VALID VALUES (accepted enum strings).
 *
 * Source: the Amazon FOOD inventory-file template "Valid Values" tab, provided
 * by Vladimir 2026-07-01 (`FOOD7.csv`). These are the exact strings Amazon
 * accepts for the dropdown/enum fields — using anything else makes the listing
 * PUT reject. See docs/marketplace-rules/amazon/food-flat-file-notes.md.
 *
 * NOTE on the two naming systems: the flat-file values below are Amazon's
 * published accepted values. For the Listings Items API PUT most food
 * attributes take the SAME human string (e.g. temperature_rating), but a few
 * differ — condition_type in the Listings API is the token `new_new`, not the
 * flat-file "New". The runtime VALIDATION_PREVIEW (amazon-publish first submit)
 * catches a bad enum as INVALID before the real PUT, so wiring these is safe.
 */

/** temperature_rating — the field that tells Amazon how to store/ship food. */
export const TEMPERATURE_RATING = {
  AMBIENT: "Ambient: Room Temperature",
  FROZEN: "Frozen: 0 degree",
  CHILLED: "Chilled: 33 to 38 degrees",
} as const;

/** Map a Bundle Factory category enum to the correct temperature_rating value. */
export function temperatureRatingForCategory(
  category: string | null | undefined,
): string {
  const c = (category ?? "").toUpperCase();
  if (/FROZEN/.test(c)) return TEMPERATURE_RATING.FROZEN;
  if (/REFRIGERATED|CHILLED|COLD/.test(c)) return TEMPERATURE_RATING.CHILLED;
  return TEMPERATURE_RATING.AMBIENT;
}

/** condition_type — flat-file values. Listings API uses `new_new` for new. */
export const CONDITION_TYPE_VALUES = [
  "New",
  "new, open_box",
  "new, oem",
  "Used - Like New",
  "Used - Very Good",
  "Used - Good",
  "Used - Acceptable",
  "Collectible - Like New",
  "Collectible - Very Good",
  "Collectible - Good",
  "Collectible - Acceptable",
  "Club",
  "Refurbished",
] as const;
/** Listings API token for a brand-new sealed product. */
export const CONDITION_TYPE_NEW_LISTINGS_API = "new_new";

/** unit_count_type — the unit the pack count is measured in. */
export const UNIT_COUNT_TYPE_VALUES = [
  "Count",
  "Fl Oz",
  "Ounce",
  "Pound",
  "Gram",
  "Foot",
  "Sq Ft",
] as const;

/** product_expiration_type. */
export const PRODUCT_EXPIRATION_TYPE_VALUES = [
  "Does Not Expire",
  "Expiration Date Required",
  "Expiration On Package",
  "Production Date Required",
  "Shelf Life",
] as const;

/** dangerous_goods (supplier_declared_dg_hz_regulation) — flat-file values.
 *  Listings API token for none is `not_applicable`. */
export const DANGEROUS_GOODS_VALUES = [
  "GHS",
  "Unknown",
  "Other",
  "Not Applicable",
  "Transportation",
  "Waste",
  "Storage",
] as const;

/** diet_type. */
export const DIET_TYPE_VALUES = [
  "Vegan",
  "Vegetarian",
  "Halal",
  "Gluten Free",
  "Kosher",
  "Paleo",
] as const;

/** external_product_id_type. */
export const EXTERNAL_PRODUCT_ID_TYPE_VALUES = [
  "EAN",
  "GCID",
  "GTIN",
  "UPC",
  "ASIN",
  "ISBN",
] as const;

/** external_id (GTIN) exemption reasons. */
export const GTIN_EXEMPTION_REASON_VALUES = [
  "Manufacture on Demand",
  "Plan Item",
  "Refurbished",
  "CustomProductBundle",
  "ReplacementPart",
  "Pre-Order",
] as const;

/** item_type_keyword — the FOOD template's frozen-food BTG keyword. The keyword
 *  is category/BTG-specific; this is the value Amazon's frozen-food template
 *  exposes. "food-gifts" (currently used) is a GROCERY gift keyword. Switching a
 *  frozen own-brand listing to this places it in the frozen-meals node. */
export const ITEM_TYPE_KEYWORD_FROZEN_MEALS = "frozen-kids-meals-and-entrees";

/** Yes/No enums (is_expiration_dated_product, contains_liquid_contents,
 *  is_heat_sensitive, are_batteries_included, batteries_required). */
export const YES_NO_VALUES = ["Yes", "No"] as const;

/** Gift occasion_type values (subset used for gifting merchandising). */
export const OCCASION_VALUES = [
  "Easter", "Christmas", "Earth Day", "Graduation", "Fathers Day", "Birthday",
  "Thanksgiving", "Hanukkah", "Back To School", "Kwanzaa", "Friendship",
  "New Year", "Valentines Day", "Congratulations", "Retirement", "Anniversary",
  "Admin Day", "Mothers Day", "New Baby", "Wedding", "Holiday", "New Home",
  "Thank You", "Halloween", "Get Well",
] as const;

/**
 * allergen_information — the FDA "core" allergens accepted after a reviewed
 * manufacturer-label declaration. Amazon's
 * accepted values are LOWERCASE, underscore-joined tokens (verified 2026-07-01
 * against the live GROCERY + FOOD productType schema — a shared 184-token enum:
 * "milk", "peanuts", "soy", "wheat", "tree_nuts", "sesame_seeds", plus every
 * "..._free" / "..._may_contain" variant). Title-Case is rejected (error 90244).
 * Ingredient keyword scans are diagnostic-only and never populate this field.
 */
export const ALLERGEN_CORE_VALUES = [
  "milk", "eggs", "fish", "crustacean", "tree_nuts", "peanuts", "wheat",
  "soy", "sesame_seeds",
] as const;
