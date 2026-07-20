/**
 * Phase 2.4 Stage 6 — Validator 5: Compliance Gate re-run.
 *
 * Final gate pass with the actual main_image_url plumbed in (so Rule 6
 * VISION fires for real). NO autoFix — by Stage 6 the disclaimer has
 * been injected long ago at Stage 4; if Rule 3/4 trip here it's a real
 * regression and we want it surfaced, not silently re-fixed.
 *
 * Fail-CLOSED — if the gate errors out we treat the validator as a hard
 * error so a broken Anthropic key never lets a non-compliant listing
 * sail through.
 */

import { runComplianceGate } from "@/lib/bundle-factory/compliance/gate";
import type { ValidatorFn } from "../types";

export const validatorComplianceRerun: ValidatorFn = async ({
  sku,
  master_bundle,
  bundle_components,
  draft_brand,
}) => {
  // This legacy gate contains Amazon browse-node/disclaimer/brand rules and
  // has no channel input. Walmart is now covered by its dedicated Product
  // Truth, static-policy and prepublication validators; running Amazon rules
  // here would reject legitimate exact manufacturer-brand Walmart offers.
  if (sku.channel === "WALMART") {
    return {
      validator_id: "validator-compliance-rerun",
      passed: true,
      details: { skipped: true, reason: "dedicated_walmart_compliance_gates" },
    };
  }
  let bullets: string[] = [];
  try {
    const parsed = JSON.parse(sku.bullets || "[]");
    if (Array.isArray(parsed)) {
      bullets = parsed.filter((b): b is string => typeof b === "string");
    }
  } catch {
    /* validator-bullets will flag this — gate accepts empty array */
  }

  let decision;
  try {
    decision = await runComplianceGate(
      {
        // Intentionally NOT passing channel_sku_id — this is a verify
        // pass and we don't want runComplianceGate to mutate ChannelSKU
        // status (the validation orchestrator owns that).
        title: sku.title,
        brand: master_bundle?.brand || draft_brand,
        bullets,
        description: sku.description,
        browse_node: sku.channel_browse_node,
        main_image_url: sku.main_image_url,
        bundle_components: bundle_components.map((c) => ({
          brand: c.manufacturer_brand,
          product_name: c.product_name,
        })),
        skip_image_check: false,
      },
      { autoFix: false, actor: "validation-pipeline" },
    );
  } catch (e) {
    return {
      validator_id: "validator-compliance-rerun",
      passed: false,
      severity: "error",
      message: `Compliance gate threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (decision.decision === "CAN_PUBLISH") {
    return {
      validator_id: "validator-compliance-rerun",
      passed: true,
      details: {
        rules_passed: decision.rules.filter((r) => r.passed).length,
        detected_logos: decision.detected_logos,
      },
    };
  }

  const failedRules = decision.rules
    .filter((r) => !r.passed)
    .map((r) => `${r.rule_id}${r.reason ? `=${r.reason}` : ""}`);

  return {
    validator_id: "validator-compliance-rerun",
    passed: false,
    severity: "error",
    message: `Compliance gate rejected: ${failedRules.join(", ")}`,
    details: {
      failed_rules: failedRules,
      detected_brands: decision.detected_brands,
      detected_logos: decision.detected_logos,
    },
  };
};
