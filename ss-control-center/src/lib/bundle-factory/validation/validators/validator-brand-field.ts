/**
 * Phase 2.4 Stage 6 — Validator 4: Brand field.
 *
 * The ChannelSKU.brand value (lifted from MasterBundle.brand) must be
 * one of the allowed own-brand strings — Salutem Vita, Starfit, or
 * Generic. Any other value would either be a typo (auto-suspend risk)
 * or a foreign brand erroneously stamped on our listing.
 */

import { ALLOWED_BRAND_FIELD_VALUES } from "@/lib/bundle-factory/compliance/banned-words";
import { isOwnBrandPassthrough } from "@/lib/bundle-factory/own-brand";
import type { ValidatorFn } from "../types";
import {
  PRODUCT_TRUTH_LISTING_MANIFEST_SCHEMA,
  hasText,
  parseWalmartAttributes,
} from "../walmart-prepublication-policy";

const ALLOWED_LOWER = new Set(
  ALLOWED_BRAND_FIELD_VALUES.map((s) => s.toLowerCase()),
);

export const validatorBrandField: ValidatorFn = async ({
  sku,
  master_bundle,
  bundle_components,
}) => {
  if (!master_bundle) {
    return {
      validator_id: "validator-brand-field",
      passed: false,
      severity: "error",
      message: "SKU is missing its parent MasterBundle — cannot validate brand.",
    };
  }
  const brand = (master_bundle.brand || "").trim();
  if (!brand) {
    return {
      validator_id: "validator-brand-field",
      passed: false,
      severity: "error",
      message: "MasterBundle.brand is empty.",
    };
  }
  // Own-brand passthrough (Uncrustables): the listing publishes UNDER the donor
  // brand, so the donor brand IS a legitimate brand-field value — mirrors
  // compliance Rule 2. The house-brand allowlist only applies to gift sets.
  if (isOwnBrandPassthrough(brand)) {
    return { validator_id: "validator-brand-field", passed: true };
  }
  // A Walmart exact manufacturer-brand listing is legitimate even when that
  // brand is not a house-brand allowlist value, but only when Product Truth,
  // the materialized recipe and explicit brand-rights evidence all agree.
  if (sku.channel === "WALMART" && !ALLOWED_LOWER.has(brand.toLowerCase())) {
    const parsed = parseWalmartAttributes(sku.attributes);
    const truth = parsed.product_truth_manifest;
    const rights = parsed.walmart_prepublication?.brand_rights;
    const brandLower = brand.toLowerCase();
    const exactManifestBrand =
      truth?.schema_version === PRODUCT_TRUTH_LISTING_MANIFEST_SCHEMA &&
      Array.isArray(truth.components) &&
      truth.components.length > 0 &&
      truth.components.every(
        (component) =>
          hasText(component.manufacturer_brand) &&
          component.manufacturer_brand.trim().toLowerCase() === brandLower &&
          component.content_role === "EXACT",
      );
    const exactRecipeBrand =
      bundle_components.length > 0 &&
      bundle_components.every(
        (component) =>
          component.manufacturer_brand.trim().toLowerCase() === brandLower,
      );
    const rightsBasis = rights?.basis;
    const rightsMatch =
      String(rights?.brand ?? "").trim().toLowerCase() === brandLower &&
      ["BRAND_OWNER", "AUTHORIZED_RESELLER", "LEGITIMATE_RESALE"].includes(
        String(rightsBasis ?? ""),
      ) &&
      hasText(rights?.evidence_ref);
    if (exactManifestBrand && exactRecipeBrand && rightsMatch) {
      return {
        validator_id: "validator-brand-field",
        passed: true,
        details: { brand, basis: rightsBasis, source: "walmart_exact_brand_rights" },
      };
    }
    return {
      validator_id: "validator-brand-field",
      passed: false,
      severity: "error",
      message: `Walmart brand "${brand}" lacks matching exact Product Truth and brand-rights evidence.`,
      details: {
        brand,
        exact_manifest_brand: exactManifestBrand,
        exact_recipe_brand: exactRecipeBrand,
        rights_match: rightsMatch,
      },
    };
  }
  if (!ALLOWED_LOWER.has(brand.toLowerCase())) {
    return {
      validator_id: "validator-brand-field",
      passed: false,
      severity: "error",
      message: `Brand "${brand}" is not in the allowed own-brand list.`,
      details: { brand, allowed: ALLOWED_BRAND_FIELD_VALUES },
    };
  }
  return { validator_id: "validator-brand-field", passed: true };
};
