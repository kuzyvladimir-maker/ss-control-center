/**
 * Phase 2.4 Stage 6 — Validator 14: Package weight.
 *
 * Must be filled and > 0 oz. Carrier rate quotes will fail otherwise;
 * Amazon FBA submissions are rejected.
 */

import type { ValidatorFn } from "../types";

const MAX_REASONABLE_OZ = 70 * 16; // Carrier max parcel weight is ~70 lb.

export const validatorWeight: ValidatorFn = async ({ sku }) => {
  const weight = sku.package_weight_oz;
  if (weight == null || weight <= 0) {
    return {
      validator_id: "validator-weight",
      passed: false,
      severity: "error",
      message: "package_weight_oz is missing or non-positive.",
    };
  }
  if (weight > MAX_REASONABLE_OZ) {
    return {
      validator_id: "validator-weight",
      passed: false,
      severity: "warning",
      message: `Package weight ${weight} oz exceeds carrier max (~${MAX_REASONABLE_OZ} oz / 70 lb).`,
      details: { weight_oz: weight, max_oz: MAX_REASONABLE_OZ },
    };
  }
  return {
    validator_id: "validator-weight",
    passed: true,
    details: { weight_oz: weight },
  };
};
