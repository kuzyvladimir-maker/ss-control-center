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
import { isOwnBrandPassthrough } from "../../own-brand";
import type { ComplianceInput, RuleResult } from "../types";

export function ruleTitleForeignBrands(input: ComplianceInput): RuleResult {
  let matches = findForeignBrandsInText(input.title || "");
  // Own-brand passthrough (Uncrustables): the listing publishes UNDER the donor
  // brand, so that brand IS allowed in the title — the "no foreign brand in
  // title" block only applies when the brand field is Salutem. Drop any match
  // that belongs to the own-brand identity: the brand field itself AND any term
  // on the passthrough allowlist (e.g. both "Smucker's" and its "Uncrustables"
  // product line). Any OTHER unexpected foreign brand (Kraft, Tyson…) still flags.
  if (input.own_brand) {
    const ownLower = (input.brand || "").trim().toLowerCase();
    matches = matches.filter((m) => {
      if (isOwnBrandPassthrough(m)) return false;
      if (ownLower) {
        const ml = m.toLowerCase();
        if (ml.includes(ownLower) || ownLower.includes(ml)) return false;
      }
      return true;
    });
  }
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
