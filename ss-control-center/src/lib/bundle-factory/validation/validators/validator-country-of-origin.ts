/**
 * Phase 2.4 Stage 6 — Validator 15: Country of origin.
 *
 * Required field on every marketplace. Defaults to "US" for bundles
 * assembled at our facility (set in the schema default); validator just
 * ensures it's present + non-empty.
 *
 * Accepts ISO 3166-1 alpha-2 (US, CA, MX, …) and common longer forms
 * (United States, Canada). Anything else → warning, since marketplaces
 * vary in how strict they are about the canonical form.
 */

import type { ValidatorFn } from "../types";

const KNOWN_ISO2 = new Set([
  "US", "CA", "MX", "GB", "DE", "FR", "IT", "ES", "JP", "CN", "KR", "AU", "NZ", "BR", "CL", "AR",
]);

export const validatorCountryOfOrigin: ValidatorFn = async ({ sku }) => {
  const value = (sku.country_of_origin || "").trim();
  if (!value) {
    return {
      validator_id: "validator-country-of-origin",
      passed: false,
      severity: "error",
      message: "country_of_origin is empty.",
    };
  }
  const upper = value.toUpperCase();
  if (value.length === 2 && KNOWN_ISO2.has(upper)) {
    return {
      validator_id: "validator-country-of-origin",
      passed: true,
      details: { country_of_origin: upper },
    };
  }
  if (
    /^(united states|usa|us of a|canada|mexico|united kingdom|germany|france|japan|china)$/i
      .test(value)
  ) {
    return {
      validator_id: "validator-country-of-origin",
      passed: true,
      details: { country_of_origin: value },
    };
  }
  return {
    validator_id: "validator-country-of-origin",
    passed: false,
    severity: "warning",
    message: `country_of_origin "${value}" is non-canonical; marketplaces may reject. Prefer ISO 3166-1 alpha-2 (e.g. "US").`,
    details: { country_of_origin: value },
  };
};
