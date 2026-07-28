// Rule 4 — Description must carry the curator/assembler disclaimer.
//
// Mirrors Rule 3 but for the long-form description. Uses
// `DISCLAIMER_DESCRIPTION` from `remediation/disclaimer-text.ts`.
//
// AUTO-FIX: append the disclaimer paragraph (with `\n\n` separator) to
// `input.description` when `options.autoFix` is true and the disclaimer
// is missing. Mutation in-place.

import {
  DISCLAIMER_DESCRIPTION,
  hasDisclaimerText,
} from "@/lib/bundle-factory/remediation/disclaimer-text";
import type { ComplianceInput, ComplianceOptions, RuleResult } from "../types";

export function ruleDisclaimerDescription(
  input: ComplianceInput,
  options: ComplianceOptions = {},
): RuleResult {
  // Own-brand passthrough (Uncrustables): NOT a gift set — no curator/assembler
  // disclaimer (see Rule 3). Skip entirely.
  if (input.own_brand) {
    return { rule_id: "rule-4-disclaimer-description", passed: true };
  }

  const description = typeof input.description === "string"
    ? input.description
    : "";
  const present = hasDisclaimerText(description);

  if (present) {
    return { rule_id: "rule-4-disclaimer-description", passed: true };
  }

  if (options.autoFix) {
    const sep = description.length > 0 ? "\n\n" : "";
    input.description = `${description}${sep}${DISCLAIMER_DESCRIPTION}`;
    return {
      rule_id: "rule-4-disclaimer-description",
      passed: true,
      auto_fix_attempted: true,
      auto_fix_applied: true,
      details: { appended_paragraph: DISCLAIMER_DESCRIPTION },
    };
  }

  return {
    rule_id: "rule-4-disclaimer-description",
    passed: false,
    reason: "missing_disclaimer_description",
    auto_fix_attempted: false,
    details: { description_length: description.length },
  };
}
