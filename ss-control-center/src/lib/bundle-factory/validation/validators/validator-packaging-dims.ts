/**
 * Phase 2.4 Stage 6 — Validator 13: Packaging dimensions.
 *
 * Length + width + height must be filled, positive, and exactly backed by the
 * operator ship-specs provenance. Box/cooler presets cannot satisfy this gate.
 */

import type { ValidatorFn } from "../types";
import { parseVerifiedPhysicalPackageSpecs } from "../../physical-package-specs";

const MAX_REASONABLE_IN = 108; // Carrier max parcel dimension is 108".

export const validatorPackagingDims: ValidatorFn = async ({ sku, master_bundle }) => {
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
  const proof = parseVerifiedPhysicalPackageSpecs(master_bundle?.packaging_spec);
  if (!proof) {
    return {
      validator_id: "validator-packaging-dims",
      passed: false,
      severity: "error",
      message:
        "Package dimensions have no operator-verified ship-specs provenance.",
    };
  }
  if (
    proof.length_in !== sku.package_length_in ||
    proof.width_in !== sku.package_width_in ||
    proof.height_in !== sku.package_height_in
  ) {
    return {
      validator_id: "validator-packaging-dims",
      passed: false,
      severity: "error",
      message: "Package dimensions do not match the verified ship-specs proof.",
      details: {
        actual: {
          l: sku.package_length_in,
          w: sku.package_width_in,
          h: sku.package_height_in,
        },
        verified: {
          l: proof.length_in,
          w: proof.width_in,
          h: proof.height_in,
        },
      },
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
