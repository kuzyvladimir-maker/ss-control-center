/**
 * Phase 2.4 Stage 6 — Validator 13: Packaging dimensions.
 *
 * Length + width + height must be filled and positive. Carrier rates
 * are computed from these; missing dims → shipping label purchase
 * blows up. Amazon also rejects FBA submissions without dims.
 */

import type { ValidatorFn } from "../types";

const MAX_REASONABLE_IN = 108; // Carrier max parcel dimension is 108".

export const validatorPackagingDims: ValidatorFn = async ({ sku }) => {
  const missing: string[] = [];
  const oversized: string[] = [];
  for (const [name, value] of [
    ["package_length_in", sku.package_length_in],
    ["package_width_in", sku.package_width_in],
    ["package_height_in", sku.package_height_in],
  ] as const) {
    if (value == null || value <= 0) {
      missing.push(name);
      continue;
    }
    if (value > MAX_REASONABLE_IN) oversized.push(name);
  }
  if (missing.length > 0) {
    return {
      validator_id: "validator-packaging-dims",
      passed: false,
      severity: "error",
      message: `Packaging dimensions missing or non-positive: ${missing.join(", ")}.`,
      details: { missing },
    };
  }
  if (oversized.length > 0) {
    return {
      validator_id: "validator-packaging-dims",
      passed: false,
      severity: "warning",
      message: `Dimension(s) exceed carrier max (108"): ${oversized.join(", ")}.`,
      details: { oversized, max_in: MAX_REASONABLE_IN },
    };
  }
  return {
    validator_id: "validator-packaging-dims",
    passed: true,
    details: {
      l: sku.package_length_in,
      w: sku.package_width_in,
      h: sku.package_height_in,
    },
  };
};
