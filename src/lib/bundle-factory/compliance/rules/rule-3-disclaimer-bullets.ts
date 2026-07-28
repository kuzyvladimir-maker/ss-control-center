// Rule 3 — At least one bullet must carry the curator/assembler disclaimer.
//
// Uses the verified-short DISCLAIMER_BULLET text from
// `remediation/disclaimer-text.ts`. That exact wording is the ONLY one
// that survives Amazon PDP code 99300 (verified empirically in Phase 2.6.2
// safety test 5b — see `docs/PHASE_2_6_2_SAFETY_TEST_REPORT.md`).
//
// AUTO-FIX: when `options.autoFix` is true and the disclaimer is missing,
// append `DISCLAIMER_BULLET` as the last bullet and mark `auto_fix_applied`.
// Mutation is in-place on `input.bullets` (after the array is replaced
// with a new array by the orchestrator, so the caller's input object is
// not affected).

import {
  DISCLAIMER_BULLET,
  hasDisclaimerText,
} from "@/lib/bundle-factory/remediation/disclaimer-text";
import type { ComplianceInput, ComplianceOptions, RuleResult } from "../types";

export function ruleDisclaimerBullets(
  input: ComplianceInput,
  options: ComplianceOptions = {},
): RuleResult {
  // Own-brand passthrough (Uncrustables): NOT a gift set — no curator/assembler
  // disclaimer. The disclaimer is only correct (and only survives 99300) on
  // Salutem-branded gift-set listings; injecting it under a donor brand would
  // be both wrong and confusing. Skip entirely.
  if (input.own_brand) {
    return { rule_id: "rule-3-disclaimer-bullets", passed: true };
  }

  const bullets = Array.isArray(input.bullets) ? input.bullets : [];
  const present = hasDisclaimerText(...bullets);

  if (present) {
    return { rule_id: "rule-3-disclaimer-bullets", passed: true };
  }

  if (options.autoFix) {
    bullets.push(DISCLAIMER_BULLET);
    input.bullets = bullets;
    return {
      rule_id: "rule-3-disclaimer-bullets",
      passed: true,
      auto_fix_attempted: true,
      auto_fix_applied: true,
      details: { injected_bullet: DISCLAIMER_BULLET },
    };
  }

  return {
    rule_id: "rule-3-disclaimer-bullets",
    passed: false,
    reason: "missing_disclaimer_bullet",
    auto_fix_attempted: false,
    details: { bullet_count: bullets.length },
  };
}
