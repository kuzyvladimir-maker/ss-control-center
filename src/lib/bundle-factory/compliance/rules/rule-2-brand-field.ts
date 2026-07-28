// Rule 2 — Amazon brand field must be one of the allowed values.
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
