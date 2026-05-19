// Rule 1 — Title must contain ZERO foreign brand names.
//
// This is the rule that, had it existed on 2026-05-17, would have stopped
// the 5 ASINs that took down the RETAILER account ("Salutem Vita – Kraft
// Spongebob Shapes Mac & Cheese Gift Set", etc).
//
// Own-brand names (Salutem Vita, Starfit, Salutem Solutions, Salutem) are
// stripped from the title first so they never trigger as foreign matches.
//
// HARD BLOCK — no auto-fix. Title regeneration requires AI; that lives in
// Phase 2.1+ pipeline, not in this gate.

import {
  findForeignBrandsInText,
} from "../banned-words";
import type { ComplianceInput, RuleResult } from "../types";

export function ruleTitleForeignBrands(input: ComplianceInput): RuleResult {
  const matches = findForeignBrandsInText(input.title || "");
  if (matches.length === 0) {
    return { rule_id: "rule-1-title-foreign-brands", passed: true };
  }
  return {
    rule_id: "rule-1-title-foreign-brands",
    passed: false,
    reason: "title_foreign_brand",
    details: {
      foreign_brands_in_title: matches,
      title: input.title,
    },
  };
}
