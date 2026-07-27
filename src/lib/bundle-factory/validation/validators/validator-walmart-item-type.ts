/**
 * Phase 2.4 Stage 6 — Validator 9: Walmart item type.
 *
 * Only fires for WALMART channel. Walmart taxonomy requires item_type
 * to be proven by current Get Spec evidence for the exact product type.
 * The local list below is retained only as a legacy diagnostic snapshot;
 * it must never reject a product type accepted by the versioned live spec.
 *
 * Non-Walmart channels skip cleanly.
 */

import type { ValidatorFn } from "../types";
import {
  WALMART_ITEM_MATCH_SPEC_VERSION,
  WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
  parseWalmartAttributes,
} from "../walmart-prepublication-policy";

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
  const parsed = parseWalmartAttributes(sku.attributes);
  const spec = parsed.walmart_prepublication?.item_spec;
  const publicContract = parsed.walmart;
  const currentSpecEvidence =
    spec?.product_type === itemType &&
    publicContract?.product_type === itemType &&
    publicContract.spec_version === spec.version &&
    (spec.version === WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION ||
      spec.version === WALMART_ITEM_MATCH_SPEC_VERSION);
  if (currentSpecEvidence) {
    return {
      validator_id: "validator-walmart-item-type",
      passed: true,
      details: {
        item_type: itemType,
        source: "versioned_get_spec_evidence",
        spec_version: spec.version,
      },
    };
  }
  if (!WALMART_ITEM_TYPES_LOWER.has(itemType.toLowerCase())) {
    return {
      validator_id: "validator-walmart-item-type",
      passed: false,
      severity: "error",
      message: `item_type "${itemType}" has neither current Get Spec evidence nor a legacy snapshot match.`,
      details: { item_type: itemType, legacy_snapshot: WALMART_ITEM_TYPES },
    };
  }
  return {
    validator_id: "validator-walmart-item-type",
    passed: true,
    details: { item_type: itemType, source: "legacy_snapshot_only" },
  };
};
