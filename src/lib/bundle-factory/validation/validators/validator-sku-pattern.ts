/**
 * Phase 2.4 Stage 6 — Validator 11: SKU pattern.
 *
 * Salutem SKU convention is `XX-XXXX-XXXX` — two-letter brand prefix,
 * four-digit category code, four-char unique suffix. Enforced both for
 * operational sanity (Veeqo + warehouse expect this shape) and so
 * Amazon's seller-SKU search returns the right item.
 *
 * Letter case enforced uppercase. Suffix allows alphanumerics so
 * promote-draft can use a cuid-derived slug.
 */

import type { ValidatorFn } from "../types";

const SKU_PATTERN = /^[A-Z]{2}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export const validatorSkuPattern: ValidatorFn = async ({ sku }) => {
  const value = (sku.sku || "").trim();
  if (!value) {
    return {
      validator_id: "validator-sku-pattern",
      passed: false,
      severity: "error",
      message: "SKU is empty.",
    };
  }
  if (!SKU_PATTERN.test(value)) {
    return {
      validator_id: "validator-sku-pattern",
      passed: false,
      severity: "error",
      message: `SKU "${value}" does not match XX-XXXX-XXXX pattern.`,
      details: { sku: value, expected_pattern: SKU_PATTERN.source },
    };
  }
  return { validator_id: "validator-sku-pattern", passed: true };
};
