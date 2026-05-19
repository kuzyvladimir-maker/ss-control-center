// Phase 2.0 Compliance Gate — shared types.
//
// One ComplianceInput goes in, eight rules each produce a RuleResult, the
// orchestrator (gate.ts) bundles them into a ComplianceDecision. Persistence
// (ComplianceCheck + ComplianceAuditLog rows) happens inside the
// orchestrator; the rule functions themselves are pure (or async, for the
// two rules that hit external systems) and don't touch the database.

export type ComplianceDecisionKind = "CAN_PUBLISH" | "BLOCKED";

/**
 * One bundle component as it arrives at Stage 4 (content gen). The gate
 * only cares about brand for Rule 5 (multi-brand gating), and product
 * keywords for Rule 7 (permanent blocklist match). Other component fields
 * (UPC, weight, source, …) are out of scope.
 */
export interface BundleComponentInput {
  brand: string;
  product_name?: string;
}

/**
 * Everything the gate needs to evaluate one draft. Coming from
 * BundleDraft (during pipeline) or ChannelSKU (final pre-publish check).
 * Callers omit `bundle_draft_id`/`channel_sku_id` when running ad-hoc
 * (e.g. smoke tests); persistence is skipped in that case.
 */
export interface ComplianceInput {
  bundle_draft_id?: string;
  channel_sku_id?: string;

  title: string;
  brand: string;
  bullets: string[];
  description: string;

  browse_node?: string | null;
  main_image_url?: string | null;

  bundle_components: BundleComponentInput[];

  /** When true, Rule 6 is bypassed (used for unit smoke runs without
   *  Anthropic key, or when caller already validated image elsewhere). */
  skip_image_check?: boolean;
}

export interface ComplianceOptions {
  /**
   * When true, the gate will try to auto-fix violations of rules 3 + 4
   * (disclaimer bullet + disclaimer paragraph) by mutating the input
   * arrays/strings in-place. The mutated values are returned alongside
   * the decision so the caller can persist them. Rules 1, 5, 6 cannot
   * be auto-fixed — they require AI regeneration.
   */
  autoFix?: boolean;

  /** Actor recorded in ComplianceAuditLog for this run. Defaults to
   *  `"system"`. */
  actor?: string;
}

export interface RuleResult {
  rule_id: string; // 'rule-1-title-foreign-brands', etc.
  passed: boolean;
  reason?: string; // short machine code, e.g. 'title_foreign_brand'
  details?: Record<string, unknown>;
  auto_fix_attempted?: boolean;
  auto_fix_applied?: boolean;
  /** Cost in cents for rules that hit paid APIs (currently Rule 6). */
  cost_cents?: number;
}

export interface ComplianceDecision {
  decision: ComplianceDecisionKind;

  rules: RuleResult[];

  /** Quick-access pointer to the persisted ComplianceCheck row. Absent
   *  when the gate ran without a bundle_draft_id. */
  compliance_check_id?: string;

  /** Aggregate cost across all rules. */
  cost_cents: number;

  /** Final (possibly mutated by autoFix) bullets/description. The caller
   *  is expected to persist these back onto the parent draft alongside
   *  `compliance_status`. */
  final_bullets: string[];
  final_description: string;

  /** Aggregated quick-access fields persisted on ComplianceCheck. */
  detected_brands: string[];
  detected_logos: string[];
}
