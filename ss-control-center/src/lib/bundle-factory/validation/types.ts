/**
 * Phase 2.4 Stage 6 — shared types for the 15 validators + orchestrator.
 *
 * Each validator is a pure function returning a ValidatorResult; the
 * orchestrator (validation-pipeline.ts) bundles them into a ValidationOutcome
 * and persists status onto ChannelSKU. Mirrors the Phase 2.0 Compliance
 * Gate shape so the two systems read similarly.
 */

import type { ChannelSKU } from "@/generated/prisma/client";

/**
 * Per-validator result. `severity` controls how the orchestrator
 * categorises the overall outcome: any `error` → FAILED, only `warning` →
 * NEEDS_REVIEW, none → PASSED. Validators that ran cleanly always set
 * `passed: true` and no severity is needed.
 */
export interface ValidatorResult {
  validator_id: string; // 'validator-title', etc. — stable string used by UI badges
  passed: boolean;
  severity?: "error" | "warning"; // omitted when passed=true
  message?: string; // human-readable; safe to render in UI
  details?: Record<string, unknown>;
}

/**
 * Input handed to every validator. We pre-load the master bundle + its
 * components because most validators need at least one or two fields
 * from them (browse_node, package dims, etc.). Avoid re-querying inside
 * each validator — keeps run time predictable and tests easy to stub.
 */
export interface ValidatorInput {
  sku: ChannelSKU;
  /** Master bundle the SKU belongs to. May be `null` only if the SKU was
   *  orphaned (data error) — validators should treat that as a hard fail
   *  via validator-brand-field or skip and report. */
  master_bundle: {
    id: string;
    brand: string;
    category: string;
    packaging_spec: string;
    total_weight_oz: number | null;
    main_image_url: string;
  } | null;
  /** Bundle components for inventory + multi-brand checks. */
  bundle_components: Array<{
    product_name: string;
    manufacturer_brand: string;
    manufacturer_upc: string | null;
    qty: number;
  }>;
  /** `compliance-rerun` validator needs the parent BundleDraft brand so it
   *  can hand the gate a real `ComplianceInput.brand`. */
  draft_brand: string;
}

export type ValidationOutcomeStatus =
  | "PASSED"
  | "NEEDS_REVIEW"
  | "FAILED";

export interface ValidationOutcome {
  status: ValidationOutcomeStatus;
  can_publish: boolean; // === (status === 'PASSED')
  results: ValidatorResult[];
  /** Convenience: array of failed validator ids for the UI to render. */
  failed: string[];
  /** Convenience: array of warning-only validator ids. */
  warnings: string[];
  duration_ms: number;
}

/** Validators that fire across every channel — registered first. */
export type ValidatorFn = (input: ValidatorInput) => Promise<ValidatorResult>;
