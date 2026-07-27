/** Deterministic prohibited/restricted signal screen; not an entitlement gate. */

import type { ValidatorFn } from "../types";
import {
  WALMART_POLICY_VERSION,
  WALMART_STATIC_POLICY_SIGNALS,
  parseWalmartAttributes,
} from "../walmart-prepublication-policy";

function bulletText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string").join(" ")
      : "";
  } catch {
    return "";
  }
}

export const validatorWalmartStaticPolicy: ValidatorFn = async ({
  sku,
  bundle_components,
}) => {
  if (sku.channel !== "WALMART") {
    return {
      validator_id: "validator-walmart-static-policy",
      passed: true,
      details: { skipped: true, reason: "non_walmart_channel" },
    };
  }

  const prepublication = parseWalmartAttributes(sku.attributes).walmart_prepublication;
  const approvals = Array.isArray(prepublication?.category_approvals)
    ? prepublication.category_approvals
    : [];
  const text = [
    sku.title,
    bulletText(sku.bullets),
    sku.description,
    ...bundle_components.flatMap((component) => [
      component.product_name,
      component.manufacturer_brand,
      component.flavor ?? "",
      component.ingredients ?? "",
      component.allergens ?? "",
    ]),
  ].join("\n");
  const matched = WALMART_STATIC_POLICY_SIGNALS.filter((signal) => signal.regex.test(text));
  const failures: string[] = [];
  for (const signal of matched) {
    if (signal.disposition === "PROHIBITED") {
      failures.push(`${signal.id}: prohibited signal (${signal.label})`);
      continue;
    }
    const approved = approvals.some(
      (approval) =>
        approval.scope === signal.approval_scope &&
        approval.status === "APPROVED",
    );
    if (!approved) {
      failures.push(`${signal.id}: requires ${signal.approval_scope} approval evidence`);
    }
  }

  if (failures.length > 0) {
    return {
      validator_id: "validator-walmart-static-policy",
      passed: false,
      severity: "error",
      message: `Walmart static policy screen failed: ${failures.join("; ")}.`,
      details: {
        policy_version: WALMART_POLICY_VERSION,
        matched_signal_ids: matched.map((signal) => signal.id),
        screen_is_not_approval: true,
        failures,
      },
    };
  }
  return {
    validator_id: "validator-walmart-static-policy",
    passed: true,
    details: {
      policy_version: WALMART_POLICY_VERSION,
      matched_signal_ids: matched.map((signal) => signal.id),
      screen_is_not_approval: true,
    },
  };
};

