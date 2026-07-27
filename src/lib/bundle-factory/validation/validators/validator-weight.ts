/**
 * Phase 2.4 Stage 6 — Validator 14: Package weight.
 *
 * Must be filled, positive, and exactly backed by the operator ship-specs
 * provenance. Calculated cooler weights are pricing inputs, not product facts.
 */

import type { ValidatorFn } from "../types";
import { parseVerifiedPhysicalPackageSpecs } from "../../physical-package-specs";

const MAX_REASONABLE_OZ = 70 * 16; // Carrier max parcel weight is ~70 lb.

export const validatorWeight: ValidatorFn = async ({ sku, master_bundle }) => {
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
  const proof = parseVerifiedPhysicalPackageSpecs(master_bundle?.packaging_spec);
  if (!proof) {
    return {
      validator_id: "validator-weight",
      passed: false,
      severity: "error",
      message:
        "Package weight has no operator-verified ship-specs provenance.",
    };
  }
  if (proof.weight_oz !== weight) {
    return {
      validator_id: "validator-weight",
      passed: false,
      severity: "error",
      message: "Package weight does not match the verified ship-specs proof.",
      details: { weight_oz: weight, verified_weight_oz: proof.weight_oz },
    };
  }
  return {
    validator_id: "validator-weight",
    passed: true,
    details: { weight_oz: weight },
  };
};
