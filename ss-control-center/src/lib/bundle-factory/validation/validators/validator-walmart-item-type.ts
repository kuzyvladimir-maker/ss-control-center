/**
 * Phase 2.4 Stage 6 — Validator 9: Walmart item type.
 *
 * Only fires for WALMART channel. Walmart taxonomy requires item_type
 * to be one of the grocery-relevant slugs below. We keep the list local
 * (instead of a Walmart-API live lookup) because Walmart's taxonomy
 * API is unreliable and the slugs change rarely — when they do,
 * Vladimir bumps the list manually.
 *
 * Non-Walmart channels skip cleanly.
 */

import type { ValidatorFn } from "../types";

// Walmart Marketplace product type slugs that match Salutem's bundle
// catalogue (frozen meals, refrigerated lunches, shelf-stable snacks,
// gift baskets, pet food). Source: Walmart Seller Center → Item Spec
// browser (snapshot 2026-05-19). Add new entries when Vladimir launches
// in a new sub-category.
export const WALMART_ITEM_TYPES = [
  "Frozen Meals",
  "Frozen Vegetables",
  "Frozen Meat",
  "Refrigerated Lunches",
  "Refrigerated Snacks",
  "Refrigerated Deli Meat",
  "Shelf-Stable Snacks",
  "Snack Variety Packs",
  "Gift Baskets",
  "Gourmet Gift Baskets",
  "Dog Food",
  "Cat Food",
  "Beverage Variety Packs",
] as const;

const WALMART_ITEM_TYPES_LOWER = new Set(
  WALMART_ITEM_TYPES.map((s) => s.toLowerCase()),
);

export const validatorWalmartItemType: ValidatorFn = async ({ sku }) => {
  if (sku.channel !== "WALMART") {
    return {
      validator_id: "validator-walmart-item-type",
      passed: true,
      details: { skipped: true, reason: "non_walmart_channel" },
    };
  }
  const itemType = (sku.item_type || "").trim();
  if (!itemType) {
    return {
      validator_id: "validator-walmart-item-type",
      passed: false,
      severity: "error",
      message: "Walmart ChannelSKU is missing item_type — required by Walmart taxonomy.",
    };
  }
  if (!WALMART_ITEM_TYPES_LOWER.has(itemType.toLowerCase())) {
    return {
      validator_id: "validator-walmart-item-type",
      passed: false,
      severity: "error",
      message: `item_type "${itemType}" not in the Walmart grocery taxonomy.`,
      details: { item_type: itemType, allowed: WALMART_ITEM_TYPES },
    };
  }
  return {
    validator_id: "validator-walmart-item-type",
    passed: true,
    details: { item_type: itemType },
  };
};
