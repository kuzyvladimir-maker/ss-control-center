// Rule 8 — No promotional / health-claim language in title, bullets, or description.
//
// Case-insensitive substring scan against PROMOTIONAL_BANNED and
// HEALTH_CLAIM_BANNED. Both lists are intentionally loose (substring,
// not word-boundary) because the Phase 2.6.2 safety test showed that
// the 99300 classifier matches subjective claims well beyond regex
// wordlist scope — being slightly over-aggressive here is preferable to
// publishing content that Amazon will suppress.
//
// HARD BLOCK — no auto-fix. The Phase 2.6.1 Smart Scrub experiment
// proved that programmatic word removal mangles the content; the
// Bundle Factory pipeline should regenerate offending text through
// AI instead (Phase 2.1+).

import {
  PROMOTIONAL_BANNED,
  PROMOTIONAL_BANNED_LOWER,
  HEALTH_CLAIM_BANNED,
  HEALTH_CLAIM_BANNED_LOWER,
  findBannedSubstrings,
} from "../banned-words";
import type { ComplianceInput, RuleResult } from "../types";

export function rulePromotionalLanguage(input: ComplianceInput): RuleResult {
  const haystack = [
    input.title || "",
    ...((Array.isArray(input.bullets) ? input.bullets : []).filter(
      (b): b is string => typeof b === "string",
    )),
    input.description || "",
  ].join(" \n ");

  const promotional = findBannedSubstrings(
    haystack,
    PROMOTIONAL_BANNED,
    PROMOTIONAL_BANNED_LOWER,
  );
  const health = findBannedSubstrings(
    haystack,
    HEALTH_CLAIM_BANNED,
    HEALTH_CLAIM_BANNED_LOWER,
  );

  if (promotional.length === 0 && health.length === 0) {
    return { rule_id: "rule-8-promotional-language", passed: true };
  }

  const reason = promotional.length > 0 && health.length > 0
    ? "promotional_and_health_claims"
    : promotional.length > 0
      ? "promotional_language"
      : "health_claim_language";

  return {
    rule_id: "rule-8-promotional-language",
    passed: false,
    reason,
    details: {
      promotional_words: promotional,
      health_claim_words: health,
    },
  };
}
