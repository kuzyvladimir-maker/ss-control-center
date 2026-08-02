// Rule 2 — brand field policy. Amazon: one of our allowed values.
// Walmart: the original manufacturer brand (see the channel carve-out below).
//
// The brand field is the Amazon-displayed manufacturer name on the PDP.
// Setting it to a foreign brand (Kraft, Tyson, …) is how some sellers
// try to game search ranking and is the single fastest way to get an IP
// complaint. Salutem Vita / Starfit are our two Brand Registry brands;
// "Generic" is allowed for single-component non-bundle listings.
//
// HARD BLOCK — no auto-fix.

import { ALLOWED_BRAND_FIELD_VALUES } from "../banned-words";
import type { ComplianceInput, RuleResult } from "../types";

const ALLOWED_LOWER = new Set<string>(
  ALLOWED_BRAND_FIELD_VALUES.map((s) => s.toLowerCase()),
);

export function ruleBrandField(input: ComplianceInput): RuleResult {
  const brand = (input.brand || "").trim();
  if (!brand) {
    return {
      rule_id: "rule-2-brand-field",
      passed: false,
      reason: "brand_field_empty",
      details: { brand },
    };
  }
  // Own-brand passthrough (Uncrustables): the listing publishes UNDER the donor
  // brand, so the donor brand IS a legitimate brand-field value — the allowed-
  // list (Salutem Vita / Starfit / Generic) only applies to gift-set listings.
  if (input.own_brand) {
    return { rule_id: "rule-2-brand-field", passed: true };
  }
  // Walmart is the opposite policy to Amazon (owner decision 2026-08-02): the
  // brand field must carry the ORIGINAL manufacturer brand of the item being
  // listed, never one of our own. This rule's allow-list exists to stop a
  // foreign brand being borrowed for Amazon search ranking; on Walmart naming
  // the true manufacturer is the correct and required behaviour.
  if ((input.channel ?? "").toUpperCase() === "WALMART") {
    return { rule_id: "rule-2-brand-field", passed: true };
  }
  if (!ALLOWED_LOWER.has(brand.toLowerCase())) {
    return {
      rule_id: "rule-2-brand-field",
      passed: false,
      reason: "brand_not_allowed",
      details: {
        brand,
        allowed: ALLOWED_BRAND_FIELD_VALUES,
      },
    };
  }
  return { rule_id: "rule-2-brand-field", passed: true };
}
