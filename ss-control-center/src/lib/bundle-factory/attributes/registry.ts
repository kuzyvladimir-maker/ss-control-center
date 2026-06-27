/**
 * Phase 0.1 — Attribute registry.
 *
 * Single source of truth for "which attributes does a listing of product type X
 * carry, and how do we fill each". Raw field lists come from the marketplaces'
 * own definition APIs (bundled JSON in ./schemas/); the fill-map says how each
 * is sourced. The listing builder (Phase 2 filler) and the Qualification Officer
 * (Phase 4) both read this — so coverage and checks never drift.
 */

import type { AmazonProductType, AttrSpec, RawAttr } from "./types";
import { FILL_MAP } from "./fill-map";

import GROCERY from "./schemas/GROCERY.json";
import PET_FOOD from "./schemas/PET_FOOD.json";
import FOOD from "./schemas/FOOD.json";
import GOURMET_FOOD from "./schemas/GOURMET_FOOD.json";
import SNACK_FOOD from "./schemas/SNACK_FOOD.json";
import CHOCOLATE_CANDY from "./schemas/CHOCOLATE_CANDY.json";
import COFFEE from "./schemas/COFFEE.json";
import TEA from "./schemas/TEA.json";

const RAW: Record<AmazonProductType, RawAttr[]> = {
  GROCERY: GROCERY as RawAttr[],
  PET_FOOD: PET_FOOD as RawAttr[],
  FOOD: FOOD as RawAttr[],
  GOURMET_FOOD: GOURMET_FOOD as RawAttr[],
  SNACK_FOOD: SNACK_FOOD as RawAttr[],
  CHOCOLATE_CANDY: CHOCOLATE_CANDY as RawAttr[],
  COFFEE: COFFEE as RawAttr[],
  TEA: TEA as RawAttr[],
};

/**
 * Pick the Amazon product type for a listing.
 *
 * Owner decision (2026-06-27): default GROCERY for ~all new listings; pet-food
 * bundles → PET_FOOD. "Gift basket" is browse-node positioning, NOT a product
 * type (Amazon has no GIFT_BASKET type). The bundle's food sub-category
 * (frozen/refrigerated/shelf-stable) does not change the product type — it all
 * lists under GROCERY — but it does drive storage/temperature attributes.
 */
export function productTypeForBundle(opts?: {
  isPet?: boolean;
}): AmazonProductType {
  return opts?.isPet ? "PET_FOOD" : "GROCERY";
}

/** The full attribute spec for a product type: raw field + how we fill it. */
export function getRegistry(productType: AmazonProductType): AttrSpec[] {
  const raw = RAW[productType] ?? RAW.GROCERY;
  return raw.map((a) => {
    const m = FILL_MAP[a.key];
    return {
      ...a,
      fill: m?.fill ?? "review",
      source: m?.source,
    };
  });
}

/** Hard-required attributes for a product type. */
export function getRequired(productType: AmazonProductType): AttrSpec[] {
  return getRegistry(productType).filter((a) => a.required);
}

/** Attributes the builder can auto-fill (everything not 'review'/'operator'). */
export function getAutoFillable(productType: AmazonProductType): AttrSpec[] {
  return getRegistry(productType).filter(
    (a) => a.fill !== "review" && a.fill !== "operator",
  );
}

/** Attributes with no auto-source yet — the QA Officer must flag these. */
export function getNeedsReview(productType: AmazonProductType): AttrSpec[] {
  return getRegistry(productType).filter((a) => a.fill === "review");
}

/** How a given attribute key is sourced (defaults to 'review'). */
export function fillSourceFor(key: string): AttrSpec["fill"] {
  return FILL_MAP[key]?.fill ?? "review";
}

/** All product types the registry knows. */
export const PRODUCT_TYPES = Object.keys(RAW) as AmazonProductType[];
