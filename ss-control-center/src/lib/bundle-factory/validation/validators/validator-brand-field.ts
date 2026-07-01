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

const ALLOWED_LOWER = new Set(
  ALLOWED_BRAND_FIELD_VALUES.map((s) => s.toLowerCase()),
);

export const validatorBrandField: ValidatorFn = async ({ master_bundle }) => {
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
