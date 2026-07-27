/**
 * Deterministic, fail-closed selection for the buyer-facing Shadow-50 pilot.
 *
 * The selector is deliberately offline. It accepts the shared Product Truth
 * Platform audit export plus four frozen raw source snapshots and recompiles
 * the selection evidence from those sources. It never accepts detached
 * caller-authored `expected`, tier, risk, listing-kind, or remediation flags.
 */

import { createHash } from "node:crypto";

import type {
  AuditExpectedTruth,
  AuditIdentityTruth,
  ExpectedPackageFact,
  IdentityRole,
  SizeUnit,
} from "./catalog-visual-audit.ts";
import type {
  WalmartCatalogTruthAuditCase,
  WalmartListingIdentity,
} from "./catalog-truth-export.ts";
import {
  WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA,
  compileWalmartCatalogTruthExport,
  verifyWalmartCatalogTruthAuditExportAgainstSources,
  walmartListingKey,
} from "./catalog-truth-export.ts";
import {
  WALMART_FROZEN_180D_PERFORMANCE_SOURCE_SCHEMA,
  WALMART_ORDER_SHIP_NODE_TYPES,
  WALMART_PERFORMANCE_ASSURANCE,
  WALMART_PERFORMANCE_COHORT_SEMANTICS,
  WALMART_PERFORMANCE_MONEY_SEMANTICS,
  WALMART_RETURN_WFS_SCOPES,
  verifyWalmartFrozen180DayPerformanceSource,
} from "./frozen-performance-source.ts";

const MAX_SHADOW_JSON_DEPTH = 128;
const MAX_SHADOW_JSON_NODES = 500_000;
const MAX_SHADOW_JSON_KEYS = 250_000;
const MAX_SHADOW_JSON_KEYS_PER_OBJECT = 50_000;
const MAX_SHADOW_JSON_STRING_CHARACTERS = 1024 * 1024;
const MAX_SHADOW_JSON_TOTAL_STRING_CHARACTERS = 16 * 1024 * 1024;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function cloneCanonical<T>(value: T): T {
  assertWalmartShadowJsonBudget(value, "Walmart Shadow clone input");
  return structuredClone(value);
}

export {
  WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA,
  walmartListingKey,
} from "./catalog-truth-export.ts";
export type { WalmartListingIdentity } from "./catalog-truth-export.ts";
export {
  compileWalmartShadowPublishedCatalogSourceFromItemReport,
  verifyWalmartShadowPublishedCatalogSourceAgainstItemReportCapture,
} from "./item-report-published-source.ts";
export {
  WALMART_PERFORMANCE_ASSURANCE,
  compileWalmartFrozen180DayPerformanceSource,
  compileWalmartFrozen180DayPerformanceSourceFromItemReports,
  compileWalmartPerformancePopulationFromItemReport,
  verifyWalmartFrozen180DayPerformanceOperationalReadinessAgainstCaptures,
  verifyWalmartFrozen180DayPerformanceSource,
  verifyWalmartFrozen180DayPerformanceSourceAgainstRaw,
  verifyWalmartFrozen180DayPerformanceSourceAgainstItemReports,
  walmartOrdersPartitionId,
} from "./frozen-performance-source.ts";
export const WALMART_SHADOW_LISTING_CHANNEL = "WALMART_US" as const;
export const WALMART_SHADOW_PUBLISHED_CATALOG_SOURCE_SCHEMA =
  "walmart-shadow-published-catalog-source/v2" as const;
export const WALMART_SHADOW_PERFORMANCE_SOURCE_SCHEMA =
  WALMART_FROZEN_180D_PERFORMANCE_SOURCE_SCHEMA;
export const WALMART_SHADOW_PRIOR_VISUAL_SOURCE_SCHEMA =
  "walmart-shadow-prior-visual-source/v2" as const;
export const WALMART_SHADOW_REMEDIATION_SOURCE_SCHEMA =
  "walmart-shadow-remediation-source/v2" as const;
export const WALMART_SHADOW_SELECTION_EVIDENCE_SCHEMA =
  "walmart-shadow-selection-evidence/v3" as const;
export const WALMART_SHADOW_50_SCHEMA = "walmart-visual-shadow-50/v3" as const;
export const WALMART_SHADOW_TRUTH_SCHEMA = "walmart-visual-audit/v3" as const;
/**
 * Keep the already precommitted randomization seed stable across the identity
 * contract migration. Schema v3 changes what is hashed, not who may choose the
 * seed.
 */
export const WALMART_SHADOW_50_SEED = "walmart-shadow-50-v2" as const;

const SELECTION_WINDOW_DAYS = 180;
const RETURN_RISK_MIN_UNITS = 3;
const RETURN_RISK_RATE_PPM = 150_000;
/** Frozen public view used by real-source compilers. */
export const WALMART_SHADOW_PERFORMANCE_COHORT_SEMANTICS = deepFreeze(
  cloneCanonical(WALMART_PERFORMANCE_COHORT_SEMANTICS),
);
export const WALMART_SHADOW_PERFORMANCE_MONEY_SEMANTICS = deepFreeze(
  cloneCanonical(WALMART_PERFORMANCE_MONEY_SEMANTICS),
);

export type ShadowSalesTier = "high" | "medium" | "low";
export type ShadowListingKind = "single" | "multipack";
export type ShadowPrimaryStratum =
  | "known_bad_or_return_risk"
  | "remediated"
  | "multipack"
  | "single_unit_control";

type TierQuota = Record<ShadowSalesTier, number>;

const SHADOW_50_QUOTAS_CANON = deepFreeze({
  known_bad_or_return_risk: { high: 6, medium: 5, low: 4 },
  remediated: { high: 6, medium: 5, low: 4 },
  multipack: { high: 4, medium: 3, low: 3 },
  single_unit_control: { high: 4, medium: 3, low: 3 },
} as const satisfies Record<ShadowPrimaryStratum, TierQuota>);

/** Deep-frozen public view; validator logic uses a separate private canon. */
export const SHADOW_50_QUOTAS = deepFreeze(cloneCanonical(SHADOW_50_QUOTAS_CANON));

const SHADOW_50_ACCEPTANCE_GATES_CANON = deepFreeze({
  scope_and_identity: {
    selected_cases_exactly: 50,
    exact_unique_listing_buyer_item_pairs: true,
    published_only: true,
    product_truth_export_seal_verified: true,
    product_truth_export_recompiled_against_sources: true,
    selection_evidence_integrity_seal_verified: true,
    /**
     * Blocking NO-GO until a deterministic compiler can replay raw frozen
     * catalog/performance/prior-visual/remediation inputs. A caller-computed
     * body hash is integrity evidence, not source authenticity.
     */
    selection_source_recompile_verified: true,
    published_upstream_source_aware_verified: false,
    performance_upstream_source_aware_verified: false,
    prior_visual_upstream_source_aware_verified: false,
    remediation_upstream_source_aware_verified: false,
    auditable_preflight_rate: 1,
    approved_truth_revision_rate: 1,
    same_product_recipe_rate: 1,
    single_or_multipack_only_rate: 1,
    buyer_snapshot_binding_rate: 1,
    buyer_main_asset_binding_rate: 1,
    positional_or_fuzzy_fallbacks: 0,
  },
  snapshot_integrity: {
    product_truth_snapshot_sha256_rate: 1,
    source_evidence_sha256_rate: 1,
    preflight_input_sha256_rate: 1,
    preflight_result_sha256_rate: 1,
    truth_revision_sha256_rate: 1,
    buyer_snapshot_sha256_rate: 1,
    buyer_main_asset_sha256_rate: 1,
    selection_row_sha256_rate: 1,
    canonical_manifest_body_sha256_rate: 1,
    duplicate_or_conflicting_item_ids: 0,
    stale_or_mutable_snapshot_files: 0,
  },
  visual_correctness: {
    human_adjudication_rate: 1,
    false_passes: 0,
    false_bads: 0,
    known_bad_detection_rate: 1,
    known_pass_avoid_bad_rate: 1,
    review_rate_max: 0.25,
    repeated_case_verdict_stability_rate: 1,
    first_attempt_schema_valid_rate: 1,
    worker_contract_attestation_rate: 1,
  },
  safety: {
    shadow_execution_ready: false,
    stop_on_first_technical_failure: true,
    stop_on_first_false_pass_or_false_bad: true,
    explicit_subscription_call_budget: true,
    database_writes: 0,
    walmart_writes: 0,
    r2_writes: 0,
    paid_model_fallbacks: 0,
    remediation_actions: 0,
  },
} as const);

/** Deep-frozen public view; manifests receive independent mutable copies. */
export const SHADOW_50_ACCEPTANCE_GATES = deepFreeze(
  cloneCanonical(SHADOW_50_ACCEPTANCE_GATES_CANON),
);

export interface SealedSourceArtifactBinding {
  artifact_id: string;
  body_sha256: string;
  captured_at: string;
}

interface ShadowSourceSnapshotBase {
  snapshot_id: string;
  body_sha256: string;
  captured_at: string;
  channel: typeof WALMART_SHADOW_LISTING_CHANNEL;
  published_population_complete: true;
}

/**
 * Canonical identity of one seller listing in one Walmart seller account.
 * `sku` is deliberately raw and case-sensitive. A public buyer item ID is not
 * part of this identity: several seller listings may legitimately resolve to
 * the same buyer product, and Walmart's seller WPID is not a buyer item ID.
 */
export type WalmartShadowListingIdentity = WalmartListingIdentity;

export interface WalmartShadowPublishedCatalogSourceArtifact {
  schema_version: "walmart-item-report-published-source/v1";
  source_id: string;
  body_sha256: string;
  raw_transport_sha256: string;
  decoded_report_sha256: string;
  cutoff_at: string;
}

export type WalmartShadowEvidenceLedgerMode = "QUALIFIED" | "ZERO_EVIDENCE";

export interface WalmartShadowQualifiedEvidenceLedgerBinding {
  schema_version:
    | "walmart-shadow-prior-visual-qualified-evidence-ledger/v1"
    | "walmart-shadow-remediation-qualified-evidence-ledger/v1";
  ledger_id: string;
  body_sha256: string;
  captured_at: string;
  mode: WalmartShadowEvidenceLedgerMode;
}

export interface WalmartShadowQualifiedSourceReconciliation {
  population_rows: number;
  ledger_entries: number;
  evidence_accepted: number;
  evidence_rejected: number;
  output_rows: number;
  duplicate_listing_keys: 0;
  conflicting_evidence: 0;
  malformed_evidence: 0;
}

export interface WalmartShadowPublishedCatalogSource extends ShadowSourceSnapshotBase {
  schema_version: typeof WALMART_SHADOW_PUBLISHED_CATALOG_SOURCE_SCHEMA;
  /** Strong upstream binding to the full ITEM report, including excluded rows. */
  source_artifact: WalmartShadowPublishedCatalogSourceArtifact;
  rows: Array<WalmartShadowListingIdentity & {
    published_status: "PUBLISHED";
  }>;
}

export interface WalmartShadowPerformanceSource extends ShadowSourceSnapshotBase {
  schema_version: typeof WALMART_SHADOW_PERFORMANCE_SOURCE_SCHEMA;
  sales_window: {
    starts_at: string;
    start_exclusive: true;
    ends_at: string;
    end_exclusive: true;
    days: typeof SELECTION_WINDOW_DAYS;
  };
  outcome_observation: {
    starts_at: string;
    cutoff_at: string;
    end_exclusive: true;
  };
  cohort_semantics: typeof WALMART_SHADOW_PERFORMANCE_COHORT_SEMANTICS;
  money_semantics: typeof WALMART_SHADOW_PERFORMANCE_MONEY_SEMANTICS;
  assurance: typeof WALMART_PERFORMANCE_ASSURANCE;
  source_bindings: {
    published_population: WalmartShadowPerformanceRawBinding[];
    orders: WalmartShadowPerformanceRawBinding[];
    returns: WalmartShadowPerformanceRawBinding[];
  };
  source_reconciliation: WalmartShadowPerformanceSourceReconciliation;
  rows: Array<WalmartShadowListingIdentity & {
    gross_sales_cents: number;
    units_sold: number;
    units_returned: number;
    units_refunded: number;
    units_replaced: number;
  }>;
}

export interface WalmartShadowPerformanceRawBinding {
  schema_version:
    | "walmart-performance-published-population/v1"
    | "walmart-raw-orders-pages/v2"
    | "walmart-raw-returns-pages/v1";
  source_scope: string;
  seller_account_fingerprint_sha256: string;
  artifact_id: string;
  body_sha256: string;
  captured_at: string;
  store_index: number;
  partition_id: string | null;
  partition_starts_at_exclusive: string | null;
  partition_ends_at_exclusive: string | null;
}

export interface WalmartShadowPerformanceSourceReconciliation {
  published_population_rows: number;
  unique_orders: number;
  order_lines: number;
  eligible_sold_lines: number;
  unique_returns: number;
  return_lines: number;
  replacement_order_lines_excluded: number;
  order_lines_outside_published_population: number;
  outcome_units_outside_sales_cohort: number;
  outcome_units_outside_published_population: number;
  outcome_units_suppressed_by_precedence: number;
  cancelled_outcome_units_excluded: number;
  order_partitions: number;
  order_partition_ids: string[];
  overlapping_orders_deduplicated: number;
  outcome_units_unknown_or_pre_window_purchase_order: number;
  outcome_units_replacement_purchase_order: number;
}

export interface WalmartShadowPriorVisualSource extends ShadowSourceSnapshotBase {
  schema_version: typeof WALMART_SHADOW_PRIOR_VISUAL_SOURCE_SCHEMA;
  cutoff_at: string;
  source_bindings: {
    published_catalog: SealedSourceArtifactBinding;
    evidence_ledger: WalmartShadowQualifiedEvidenceLedgerBinding & {
      schema_version: "walmart-shadow-prior-visual-qualified-evidence-ledger/v1";
    };
  };
  source_reconciliation: WalmartShadowQualifiedSourceReconciliation;
  rows: Array<WalmartShadowListingIdentity & {
    verdict: "BAD" | "PASS" | "NOT_AUDITED";
    label: {
      label_id: string;
      body_sha256: string;
      labeled_at: string;
    } | null;
  }>;
}

export interface WalmartShadowRemediationSource extends ShadowSourceSnapshotBase {
  schema_version: typeof WALMART_SHADOW_REMEDIATION_SOURCE_SCHEMA;
  cutoff_at: string;
  source_bindings: {
    published_catalog: SealedSourceArtifactBinding;
    evidence_ledger: WalmartShadowQualifiedEvidenceLedgerBinding & {
      schema_version: "walmart-shadow-remediation-qualified-evidence-ledger/v1";
    };
  };
  source_reconciliation: WalmartShadowQualifiedSourceReconciliation;
  rows: Array<WalmartShadowListingIdentity & {
    status: "VERIFIED_APPLIED" | "NOT_APPLIED";
    verification: {
      verification_id: string;
      body_sha256: string;
      verified_at: string;
    } | null;
  }>;
}

export interface WalmartShadowSelectionEvidenceRow extends WalmartShadowListingIdentity {
  performance: {
    gross_sales_cents: number;
    units_sold: number;
    units_returned: number;
    units_refunded: number;
    units_replaced: number;
    /** Mutually exclusive cohort outcomes after fixed precedence allocation. */
    return_risk_units: number;
  };
  prior_visual: {
    verdict: "BAD" | "PASS" | "NOT_AUDITED";
    label: WalmartShadowPriorVisualSource["rows"][number]["label"];
  };
  remediation: {
    status: "VERIFIED_APPLIED" | "NOT_APPLIED";
    verification: WalmartShadowRemediationSource["rows"][number]["verification"];
  };
}

export interface WalmartShadowSelectionEvidenceBody {
  schema_version: typeof WALMART_SHADOW_SELECTION_EVIDENCE_SCHEMA;
  /** Opaque producer ID; the canonical body seal below binds it immutably. */
  snapshot_id: string;
  compiled_at: string;
  scope: {
    channel: typeof WALMART_SHADOW_LISTING_CHANNEL;
    published_population_complete: true;
    population_size: number;
    sales_window: {
      starts_at: string;
      start_exclusive: true;
      ends_at: string;
      end_exclusive: true;
      days: typeof SELECTION_WINDOW_DAYS;
    };
    outcome_observation: WalmartShadowPerformanceSource["outcome_observation"];
    cohort_semantics: typeof WALMART_SHADOW_PERFORMANCE_COHORT_SEMANTICS;
    money_semantics: typeof WALMART_SHADOW_PERFORMANCE_MONEY_SEMANTICS;
  };
  source_artifacts: {
    published_catalog: SealedSourceArtifactBinding;
    performance: SealedSourceArtifactBinding;
    prior_visual: SealedSourceArtifactBinding;
    remediation: SealedSourceArtifactBinding;
  };
  rows: WalmartShadowSelectionEvidenceRow[];
}

export interface SealedWalmartShadowSelectionEvidence
  extends WalmartShadowSelectionEvidenceBody {
  body_sha256: string;
}

export type ShadowRiskTuple = readonly [
  prior_visual_bad: 0 | 1,
  elevated_return_risk: 0 | 1,
  return_rate_ppm: number,
  return_risk_units: number,
  units_sold: number,
];

export interface WalmartShadow50Case {
  case_id: string;
  source_truth_case_id: string;
  channel: typeof WALMART_SHADOW_LISTING_CHANNEL;
  store_index: number;
  sku: string;
  listing_key: string;
  /** Exact numeric buyer-facing Walmart item ID, never a seller WPID. */
  item_id: string;
  published_status: "PUBLISHED";
  lifecycle_status: "ACTIVE";
  category: string;
  sales_tier: ShadowSalesTier;
  listing_kind: ShadowListingKind;
  primary_stratum: ShadowPrimaryStratum;
  stratum_rank: number;
  risk: {
    prior_visual_bad: boolean;
    elevated_return_risk: boolean;
    remediation_applied: boolean;
    units_returned: number;
    units_refunded: number;
    units_replaced: number;
    return_risk_units: number;
    return_rate_ppm: number;
    risk_tuple: ShadowRiskTuple;
  };
  expected: AuditExpectedTruth;
  bindings: {
    source_truth_case_canonical_sha256: string;
    selection_row_canonical_sha256: string;
    preflight_input_sha256: string;
    preflight_result_canonical_sha256: string;
    evidence_payload_sha256s: string[];
    truth_revision_id: string;
    truth_revision_body_sha256: string;
    truth_approval_sha256: string;
    buyer_snapshot_id: string;
    buyer_snapshot_body_sha256: string;
    buyer_main_asset_sha256: string;
  };
}

export interface WalmartShadow50Manifest {
  schema_version: typeof WALMART_SHADOW_50_SCHEMA;
  manifest_id: string;
  selection_sha256: string;
  body_sha256: string;
  seed: typeof WALMART_SHADOW_50_SEED;
  source_bindings: {
    catalog_truth_export: {
      schema_version: typeof WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA;
      export_id: string;
      body_sha256: string;
      source_recompile_verified: true;
      product_truth_snapshot_id: string;
      product_truth_snapshot_body_sha256: string;
      buyer_index_id: string;
      buyer_index_body_sha256: string;
    };
    selection_evidence: {
      schema_version: typeof WALMART_SHADOW_SELECTION_EVIDENCE_SCHEMA;
      snapshot_id: string;
      body_sha256: string;
      source_recompile_verified: true;
      upstream_provenance_verified: false;
      source_artifacts: WalmartShadowSelectionEvidenceBody["source_artifacts"];
    };
  };
  selection_policy: {
    exact_size: 50;
    fail_if_any_quota_is_unavailable: true;
    operational_status: "SOURCE_SCHEMAS_READY_UPSTREAM_PROVENANCE_AND_REVENUE_CALIBRATION_NO_GO";
    eligible_truth: "compiled_auditable_approved_product_truth_only";
    eligible_listing_kinds: readonly ["single", "same_product_multipack"];
    stratum_priority: readonly ShadowPrimaryStratum[];
    quotas: typeof SHADOW_50_QUOTAS;
    sales_tiers: {
      population: "complete_published_walmart_scope";
      order: "units_sold_desc_then_listing_key_asc_provisional_no_revenue_calibration";
      high_top_fraction: 0.2;
      medium_cumulative_fraction: 0.5;
    };
    elevated_return_risk: {
      window_days: typeof SELECTION_WINDOW_DAYS;
      minimum_units_sold: typeof RETURN_RISK_MIN_UNITS;
      minimum_return_rate_ppm: typeof RETURN_RISK_RATE_PPM;
      risk_units: "mutually_exclusive_return_plus_refund_plus_replacement";
    };
    within_cell_order: "risk_tuple_desc_then_seeded_hash";
    truth_schema: typeof WALMART_SHADOW_TRUTH_SCHEMA;
  };
  cases: WalmartShadow50Case[];
  distribution: {
    strata: Record<ShadowPrimaryStratum, number>;
    sales_tiers: Record<ShadowSalesTier, number>;
    categories: Record<string, number>;
    listing_kinds: Record<ShadowListingKind, number>;
  };
  acceptance_gates: typeof SHADOW_50_ACCEPTANCE_GATES;
}

interface DerivedCandidate {
  truthCase: WalmartCatalogTruthAuditCase;
  selectionRow: WalmartShadowSelectionEvidenceRow;
  expected: AuditExpectedTruth;
  salesTier: ShadowSalesTier;
  listingKind: ShadowListingKind;
  primaryStratum: ShadowPrimaryStratum;
  riskTuple: ShadowRiskTuple;
  priorVisualBad: boolean;
  elevatedReturnRisk: boolean;
  remediationApplied: boolean;
  returnRatePpm: number;
}

const STRATUM_PRIORITY = deepFreeze([
  "known_bad_or_return_risk",
  "remediated",
  "multipack",
  "single_unit_control",
] as const satisfies readonly ShadowPrimaryStratum[]);
const SALES_TIERS = deepFreeze(
  ["high", "medium", "low"] as const satisfies readonly ShadowSalesTier[],
);
const SHADOW_50_SELECTION_POLICY_CANON = deepFreeze({
  exact_size: 50,
  fail_if_any_quota_is_unavailable: true,
  operational_status: "SOURCE_SCHEMAS_READY_UPSTREAM_PROVENANCE_AND_REVENUE_CALIBRATION_NO_GO",
  eligible_truth: "compiled_auditable_approved_product_truth_only",
  eligible_listing_kinds: ["single", "same_product_multipack"],
  stratum_priority: [...STRATUM_PRIORITY],
  quotas: SHADOW_50_QUOTAS_CANON,
  sales_tiers: {
    population: "complete_published_walmart_scope",
    order: "units_sold_desc_then_listing_key_asc_provisional_no_revenue_calibration",
    high_top_fraction: 0.2,
    medium_cumulative_fraction: 0.5,
  },
  elevated_return_risk: {
    window_days: SELECTION_WINDOW_DAYS,
    minimum_units_sold: RETURN_RISK_MIN_UNITS,
    minimum_return_rate_ppm: RETURN_RISK_RATE_PPM,
    risk_units: "mutually_exclusive_return_plus_refund_plus_replacement",
  },
  within_cell_order: "risk_tuple_desc_then_seeded_hash",
  truth_schema: WALMART_SHADOW_TRUTH_SCHEMA,
} as const satisfies WalmartShadow50Manifest["selection_policy"]);
const SHA256 = /^[a-f0-9]{64}$/;
const SIZE_UNITS = new Set<SizeUnit>([
  "oz", "fl_oz", "count", "lb", "g", "kg", "ml", "l",
]);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Locale-independent UTF-16 code-unit order for reproducible artifacts. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareSafeIntegersDescending(left: number, right: number): number {
  if (left === right) return 0;
  return left > right ? -1 : 1;
}

interface ShadowJsonBudgetFrame {
  value: unknown;
  path: string;
  depth: number;
  entered: boolean;
  index: number;
  keys: string[] | null;
}

/**
 * Iterative JSON preflight. Container breadth never expands the traversal
 * stack, so hostile arrays/objects fail by an explicit budget instead of
 * exhausting the JavaScript call stack or heap before canonicalization.
 */
function assertWalmartShadowJsonBudget(value: unknown, rootPath = "Walmart Shadow JSON"): void {
  const stack: ShadowJsonBudgetFrame[] = [{
    value,
    path: rootPath,
    depth: 0,
    entered: false,
    index: 0,
    keys: null,
  }];
  const active = new Set<object>();
  let nodes = 0;
  let keys = 0;
  let stringCharacters = 0;

  const accountString = (text: string, path: string): void => {
    if (text.length > MAX_SHADOW_JSON_STRING_CHARACTERS) {
      throw new Error(`${path} exceeds the per-string Walmart Shadow JSON budget`);
    }
    stringCharacters += text.length;
    if (!Number.isSafeInteger(stringCharacters)
      || stringCharacters > MAX_SHADOW_JSON_TOTAL_STRING_CHARACTERS) {
      throw new Error(`${rootPath} exceeds the aggregate string Walmart Shadow JSON budget`);
    }
  };

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (!frame.entered) {
      nodes += 1;
      if (!Number.isSafeInteger(nodes) || nodes > MAX_SHADOW_JSON_NODES) {
        throw new Error(`${rootPath} exceeds the Walmart Shadow JSON node budget`);
      }
      if (frame.depth > MAX_SHADOW_JSON_DEPTH) {
        throw new Error(`${frame.path} exceeds the Walmart Shadow JSON depth budget`);
      }
      const current = frame.value;
      if (current === null || typeof current === "boolean") {
        stack.pop();
        continue;
      }
      if (typeof current === "string") {
        accountString(current, frame.path);
        stack.pop();
        continue;
      }
      if (typeof current === "number") {
        if (!Number.isFinite(current)) {
          throw new Error(`${frame.path} contains a non-finite Walmart Shadow JSON number`);
        }
        if (Object.is(current, -0)) {
          throw new Error(`${frame.path} contains ambiguous negative zero`);
        }
        stack.pop();
        continue;
      }
      if (typeof current !== "object" || current === undefined) {
        throw new Error(`${frame.path} contains a non-JSON value`);
      }
      if (active.has(current)) throw new Error(`${frame.path} contains a JSON cycle`);
      active.add(current);
      frame.entered = true;

      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          throw new Error(`${frame.path} must be a plain JSON array`);
        }
        if (current.length > MAX_SHADOW_JSON_NODES - nodes) {
          throw new Error(`${rootPath} exceeds the Walmart Shadow JSON node budget`);
        }
        if (Object.getOwnPropertySymbols(current).length > 0) {
          throw new Error(`${frame.path} contains a non-JSON symbol key`);
        }
        const arrayKeys = Object.keys(current);
        if (arrayKeys.length !== current.length
          || arrayKeys.some((key, index) => key !== String(index))) {
          throw new Error(`${frame.path} contains an array hole or non-JSON array property`);
        }
        frame.keys = null;
        continue;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${frame.path} must contain plain JSON objects only`);
      }
      const ownKeys = Reflect.ownKeys(current);
      if (ownKeys.some((key) => typeof key !== "string")) {
        throw new Error(`${frame.path} contains a non-JSON symbol key`);
      }
      const objectKeys = Object.keys(current);
      if (ownKeys.length !== objectKeys.length) {
        throw new Error(`${frame.path} contains a non-enumerable JSON property`);
      }
      if (objectKeys.length > MAX_SHADOW_JSON_KEYS_PER_OBJECT) {
        throw new Error(`${frame.path} exceeds the per-object Walmart Shadow JSON key budget`);
      }
      keys += objectKeys.length;
      if (!Number.isSafeInteger(keys) || keys > MAX_SHADOW_JSON_KEYS) {
        throw new Error(`${rootPath} exceeds the Walmart Shadow JSON key budget`);
      }
      for (const key of objectKeys) accountString(key, `${frame.path} key`);
      frame.keys = objectKeys;
      continue;
    }

    const current = frame.value as Record<string, unknown> | unknown[];
    const length = Array.isArray(current) ? current.length : frame.keys!.length;
    if (frame.index >= length) {
      active.delete(current as object);
      stack.pop();
      continue;
    }
    const childIndex = frame.index;
    frame.index += 1;
    const key = Array.isArray(current) ? String(childIndex) : frame.keys![childIndex];
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${frame.path}.${key} must be an enumerable JSON data property`);
    }
    stack.push({
      value: descriptor.value,
      path: Array.isArray(current) ? `${frame.path}[${key}]` : `${frame.path}.${key}`,
      depth: frame.depth + 1,
      entered: false,
      index: 0,
      keys: null,
    });
  }
}

function canonicalJsonInternal(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonInternal).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => {
      const item = value[key];
      if (item === undefined) throw new Error(`canonical JSON does not support undefined at ${key}`);
      return `${JSON.stringify(key)}:${canonicalJsonInternal(item)}`;
    }).join(",")}}`;
  }
  throw new Error(`canonical JSON does not support ${typeof value}`);
}

function canonicalJson(value: unknown): string {
  assertWalmartShadowJsonBudget(value);
  return canonicalJsonInternal(value);
}

function assertWalmartShadowJsonInputs(
  inputs: readonly (readonly [label: string, value: unknown])[],
): void {
  for (const [label, value] of inputs) assertWalmartShadowJsonBudget(value, label);
}

function canonicalSha256(value: unknown): string {
  return hash(canonicalJson(value));
}

/** Canonical serializer shared by offline source compilers; rejects undefined/non-finite values. */
export function canonicalWalmartShadowJson(value: unknown): string {
  return canonicalJson(value);
}

/** SHA-256 over canonicalWalmartShadowJson(value). */
export function walmartShadowCanonicalSha256(value: unknown): string {
  return canonicalSha256(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  const allowed = new Set(required);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (extra.length) throw new Error(`${label} has unsupported fields: ${extra.join(", ")}`);
  if (missing.length) throw new Error(`${label} is missing required fields: ${missing.join(", ")}`);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`${path} must be a non-empty trimmed string`);
  }
  return value;
}

function requiredSha(value: unknown, path: string): string {
  const sha = requiredString(value, path);
  if (!SHA256.test(sha)) throw new Error(`${path} must be a lowercase SHA-256`);
  return sha;
}

function requiredTimestamp(value: unknown, path: string): string {
  const timestamp = requiredString(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${path} must be a valid ISO-8601 timestamp`);
  }
  return timestamp;
}

function requiredSafeInteger(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${path} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function safeIntegerSum(values: readonly number[], path: string): number {
  const sum = values.reduce((total, value) => total + BigInt(value), BigInt(0));
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${path} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(sum);
}

function normalizeMarker(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function stringArray(value: unknown, path: string, max = 24): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`${path} must be an array with at most ${max} items`);
  }
  return value.map((item, index) => requiredString(item, `${path}[${index}]`));
}

function markerGroups(value: unknown, path: string): string[][] {
  if (!Array.isArray(value) || value.length > 12) {
    throw new Error(`${path} must be an array with at most 12 groups`);
  }
  return value.map((group, groupIndex) => {
    if (!Array.isArray(group) || group.length === 0 || group.length > 12) {
      throw new Error(`${path}[${groupIndex}] must contain 1-12 aliases`);
    }
    const aliases = group.map((marker, markerIndex) => requiredString(
      marker,
      `${path}[${groupIndex}][${markerIndex}]`,
    ));
    if (new Set(aliases.map(normalizeMarker)).size !== aliases.length) {
      throw new Error(`${path}[${groupIndex}] contains duplicate normalized aliases`);
    }
    return aliases;
  });
}

function validateIdentityTruth(value: unknown, path: string): AuditIdentityTruth {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "brand_aliases", "product_marker_groups", "variant_marker_groups", "forbidden_markers",
  ], path);
  const brandAliases = stringArray(value.brand_aliases, `${path}.brand_aliases`, 12);
  if (!brandAliases.length) throw new Error(`${path}.brand_aliases must not be empty`);
  if (brandAliases.some((alias) => !normalizeMarker(alias).split(" ").some((token) => token.length >= 2))) {
    throw new Error(`${path}.brand_aliases must contain full lexical brand names, not logo-only glyphs`);
  }
  if (new Set(brandAliases.map(normalizeMarker)).size !== brandAliases.length) {
    throw new Error(`${path}.brand_aliases contains duplicate normalized aliases`);
  }
  // Empty product groups are intentional for brand-as-product cases (for
  // example, Dr Pepper). The v3 comparator and truth preflight both support it.
  const productGroups = markerGroups(value.product_marker_groups, `${path}.product_marker_groups`);
  const variantGroups = markerGroups(value.variant_marker_groups, `${path}.variant_marker_groups`);
  if (!Array.isArray(value.forbidden_markers) || value.forbidden_markers.length > 24) {
    throw new Error(`${path}.forbidden_markers must be an array with at most 24 items`);
  }
  const forbiddenMarkers = value.forbidden_markers.map((marker, index) => {
    const markerPath = `${path}.forbidden_markers[${index}]`;
    if (!isRecord(marker)) throw new Error(`${markerPath} must be an object`);
    assertExactKeys(marker, ["role", "aliases"], markerPath);
    if (marker.role !== "brand" && marker.role !== "product" && marker.role !== "variant") {
      throw new Error(`${markerPath}.role is unsupported`);
    }
    const role: IdentityRole = marker.role;
    const aliases = stringArray(marker.aliases, `${markerPath}.aliases`, 12);
    if (!aliases.length) throw new Error(`${markerPath}.aliases must not be empty`);
    if (new Set(aliases.map(normalizeMarker)).size !== aliases.length) {
      throw new Error(`${markerPath}.aliases contains duplicate normalized aliases`);
    }
    return { role, aliases };
  });
  return {
    brand_aliases: brandAliases,
    product_marker_groups: productGroups,
    variant_marker_groups: variantGroups,
    forbidden_markers: forbiddenMarkers,
  };
}

function validatePackageFacts(value: unknown, path: string): ExpectedPackageFact[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    throw new Error(`${path} must contain 1-2 typed package facts`);
  }
  const kinds = new Set<string>();
  return value.map((fact, index) => {
    const factPath = `${path}[${index}]`;
    if (!isRecord(fact)) throw new Error(`${factPath} must be an object`);
    assertExactKeys(fact, ["kind", "value", "unit", "requirement"], factPath);
    if (fact.kind !== "net_content" && fact.kind !== "inner_item_count") {
      throw new Error(`${factPath}.kind is unsupported`);
    }
    if (kinds.has(fact.kind)) throw new Error(`${path} contains duplicate kind ${fact.kind}`);
    kinds.add(fact.kind);
    if (typeof fact.value !== "number" || !Number.isFinite(fact.value) || fact.value <= 0) {
      throw new Error(`${factPath}.value must be a positive number`);
    }
    if (typeof fact.unit !== "string" || !SIZE_UNITS.has(fact.unit as SizeUnit)) {
      throw new Error(`${factPath}.unit is unsupported`);
    }
    if (fact.requirement !== "required" && fact.requirement !== "if_visible") {
      throw new Error(`${factPath}.requirement is unsupported`);
    }
    const unit = fact.unit as SizeUnit;
    if (fact.kind === "net_content" && unit === "count") {
      throw new Error(`${factPath} net_content cannot use count`);
    }
    if (fact.kind === "inner_item_count" && (unit !== "count" || !Number.isInteger(fact.value))) {
      throw new Error(`${factPath} inner_item_count must be a positive integer count`);
    }
    return { kind: fact.kind, value: fact.value, unit, requirement: fact.requirement };
  });
}

function validateExpectedTruth(value: unknown, path: string): AuditExpectedTruth {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, ["title", "outer_units", "identity", "package_facts", "truth_source"], path);
  const outerUnits = requiredSafeInteger(value.outer_units, `${path}.outer_units`, 1);
  if (value.truth_source !== "recipe" && value.truth_source !== "manual_verified") {
    throw new Error(`${path}.truth_source must be recipe or manual_verified`);
  }
  return {
    title: requiredString(value.title, `${path}.title`),
    outer_units: outerUnits,
    identity: validateIdentityTruth(value.identity, `${path}.identity`),
    package_facts: validatePackageFacts(value.package_facts, `${path}.package_facts`),
    truth_source: value.truth_source,
  };
}

function parseSourceArtifact(value: unknown, path: string): SealedSourceArtifactBinding {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, ["artifact_id", "body_sha256", "captured_at"], path);
  return {
    artifact_id: requiredString(value.artifact_id, `${path}.artifact_id`),
    body_sha256: requiredSha(value.body_sha256, `${path}.body_sha256`),
    captured_at: requiredTimestamp(value.captured_at, `${path}.captured_at`),
  };
}

function parseQualifiedEvidenceLedgerBinding(
  value: unknown,
  expectedSchema: WalmartShadowQualifiedEvidenceLedgerBinding["schema_version"],
  path: string,
): WalmartShadowQualifiedEvidenceLedgerBinding {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "schema_version", "ledger_id", "body_sha256", "captured_at", "mode",
  ], path);
  if (value.schema_version !== expectedSchema) {
    throw new Error(`${path}.schema_version must be ${expectedSchema}`);
  }
  if (value.mode !== "QUALIFIED" && value.mode !== "ZERO_EVIDENCE") {
    throw new Error(`${path}.mode must be QUALIFIED or ZERO_EVIDENCE`);
  }
  return {
    schema_version: expectedSchema,
    ledger_id: requiredString(value.ledger_id, `${path}.ledger_id`),
    body_sha256: requiredSha(value.body_sha256, `${path}.body_sha256`),
    captured_at: requiredTimestamp(value.captured_at, `${path}.captured_at`),
    mode: value.mode,
  };
}

function parseQualifiedSourceBindings(
  value: unknown,
  ledgerSchema: WalmartShadowQualifiedEvidenceLedgerBinding["schema_version"],
  cutoffAt: string,
  path: string,
): {
  published_catalog: SealedSourceArtifactBinding;
  evidence_ledger: WalmartShadowQualifiedEvidenceLedgerBinding;
} {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, ["published_catalog", "evidence_ledger"], path);
  const publishedCatalog = parseSourceArtifact(
    value.published_catalog,
    `${path}.published_catalog`,
  );
  const evidenceLedger = parseQualifiedEvidenceLedgerBinding(
    value.evidence_ledger,
    ledgerSchema,
    `${path}.evidence_ledger`,
  );
  if (Date.parse(publishedCatalog.captured_at) > Date.parse(cutoffAt)
    || Date.parse(evidenceLedger.captured_at) > Date.parse(cutoffAt)) {
    throw new Error(`${path} contains an artifact captured after source cutoff_at`);
  }
  return { published_catalog: publishedCatalog, evidence_ledger: evidenceLedger };
}

function parseQualifiedSourceReconciliation(
  value: unknown,
  path: string,
): WalmartShadowQualifiedSourceReconciliation {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "population_rows", "ledger_entries", "evidence_accepted", "evidence_rejected",
    "output_rows", "duplicate_listing_keys", "conflicting_evidence", "malformed_evidence",
  ], path);
  const parsed: WalmartShadowQualifiedSourceReconciliation = {
    population_rows: requiredSafeInteger(value.population_rows, `${path}.population_rows`, 1),
    ledger_entries: requiredSafeInteger(value.ledger_entries, `${path}.ledger_entries`),
    evidence_accepted: requiredSafeInteger(value.evidence_accepted, `${path}.evidence_accepted`),
    evidence_rejected: requiredSafeInteger(value.evidence_rejected, `${path}.evidence_rejected`),
    output_rows: requiredSafeInteger(value.output_rows, `${path}.output_rows`, 1),
    duplicate_listing_keys: requiredSafeInteger(
      value.duplicate_listing_keys,
      `${path}.duplicate_listing_keys`,
    ) as 0,
    conflicting_evidence: requiredSafeInteger(
      value.conflicting_evidence,
      `${path}.conflicting_evidence`,
    ) as 0,
    malformed_evidence: requiredSafeInteger(
      value.malformed_evidence,
      `${path}.malformed_evidence`,
    ) as 0,
  };
  if (parsed.duplicate_listing_keys !== 0
    || parsed.conflicting_evidence !== 0
    || parsed.malformed_evidence !== 0) {
    throw new Error(`${path} integrity counters must all be zero`);
  }
  if (safeIntegerSum(
    [parsed.evidence_accepted, parsed.evidence_rejected],
    `${path} evidence reconciliation sum`,
  ) !== parsed.ledger_entries) {
    throw new Error(`${path} accepted + rejected must equal ledger_entries`);
  }
  return parsed;
}

function parsePerformanceRawBindingArray(
  value: unknown,
  expectedSchema: WalmartShadowPerformanceRawBinding["schema_version"],
  capturedAt: string,
  path: string,
): WalmartShadowPerformanceRawBinding[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array`);
  }
  const parsed = value.map((raw, index) => {
    const bindingPath = `${path}[${index}]`;
    if (!isRecord(raw)) throw new Error(`${bindingPath} must be an object`);
    assertExactKeys(raw, [
      "schema_version", "source_scope", "seller_account_fingerprint_sha256",
      "artifact_id", "body_sha256", "captured_at", "store_index", "partition_id",
      "partition_starts_at_exclusive", "partition_ends_at_exclusive",
    ], bindingPath);
    if (raw.schema_version !== expectedSchema) {
      throw new Error(`${bindingPath}.schema_version must be ${expectedSchema}`);
    }
    const binding: WalmartShadowPerformanceRawBinding = {
      schema_version: expectedSchema,
      source_scope: requiredString(raw.source_scope, `${bindingPath}.source_scope`),
      seller_account_fingerprint_sha256: requiredSha(
        raw.seller_account_fingerprint_sha256,
        `${bindingPath}.seller_account_fingerprint_sha256`,
      ),
      artifact_id: requiredString(raw.artifact_id, `${bindingPath}.artifact_id`),
      body_sha256: requiredSha(raw.body_sha256, `${bindingPath}.body_sha256`),
      captured_at: requiredTimestamp(raw.captured_at, `${bindingPath}.captured_at`),
      store_index: requiredSafeInteger(raw.store_index, `${bindingPath}.store_index`, 1),
      partition_id: raw.partition_id === null
        ? null
        : requiredString(raw.partition_id, `${bindingPath}.partition_id`),
      partition_starts_at_exclusive: raw.partition_starts_at_exclusive === null
        ? null
        : requiredTimestamp(
          raw.partition_starts_at_exclusive,
          `${bindingPath}.partition_starts_at_exclusive`,
        ),
      partition_ends_at_exclusive: raw.partition_ends_at_exclusive === null
        ? null
        : requiredTimestamp(
          raw.partition_ends_at_exclusive,
          `${bindingPath}.partition_ends_at_exclusive`,
        ),
    };
    const isOrders = expectedSchema === "walmart-raw-orders-pages/v2";
    if (isOrders && (binding.partition_id === null
      || binding.partition_starts_at_exclusive === null
      || binding.partition_ends_at_exclusive === null)) {
      throw new Error(`${bindingPath} Orders binding must include its exact partition`);
    }
    if (!isOrders && (binding.partition_id !== null
      || binding.partition_starts_at_exclusive !== null
      || binding.partition_ends_at_exclusive !== null)) {
      throw new Error(`${bindingPath} non-Orders binding cannot claim an Orders partition`);
    }
    if (Date.parse(binding.captured_at) > Date.parse(capturedAt)) {
      throw new Error(`${bindingPath}.captured_at cannot be after performance captured_at`);
    }
    return binding;
  });
  const artifactIds = parsed.map((binding) => binding.artifact_id);
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new Error(`${path} has duplicate artifact_id bindings`);
  }
  const identities = parsed.map((binding) => (
    `${String(binding.store_index).padStart(16, "0")}\0${binding.source_scope}`
    + `\0${binding.partition_starts_at_exclusive ?? ""}`
    + `\0${binding.partition_ends_at_exclusive ?? ""}\0${binding.artifact_id}`
  ));
  if (new Set(identities).size !== identities.length) {
    throw new Error(`${path} has duplicate store_index/artifact_id bindings`);
  }
  if (canonicalJson(identities) !== canonicalJson([...identities].sort(compareCodeUnits))) {
    throw new Error(`${path} must be in canonical store/scope/partition/artifact order`);
  }
  return parsed;
}

function parsePerformanceSourceBindings(
  value: unknown,
  capturedAt: string,
  cutoffAt: string,
  path: string,
): WalmartShadowPerformanceSource["source_bindings"] {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, ["published_population", "orders", "returns"], path);
  const parsed = {
    published_population: parsePerformanceRawBindingArray(
      value.published_population,
      "walmart-performance-published-population/v1",
      capturedAt,
      `${path}.published_population`,
    ),
    orders: parsePerformanceRawBindingArray(
      value.orders,
      "walmart-raw-orders-pages/v2",
      capturedAt,
      `${path}.orders`,
    ),
    returns: parsePerformanceRawBindingArray(
      value.returns,
      "walmart-raw-returns-pages/v1",
      capturedAt,
      `${path}.returns`,
    ),
  };
  const populationStores = parsed.published_population.map((binding) => binding.store_index);
  if (new Set(populationStores).size !== populationStores.length) {
    throw new Error(`${path}.published_population must have exactly one binding per store_index`);
  }
  if (parsed.published_population.some((binding) => binding.source_scope !== "PUBLISHED")) {
    throw new Error(`${path}.published_population source_scope must be PUBLISHED`);
  }
  const expectedStores = new Set(populationStores);
  for (const [name, bindings] of Object.entries({ orders: parsed.orders, returns: parsed.returns })) {
    const actualStores = new Set(bindings.map((binding) => binding.store_index));
    if (actualStores.size !== expectedStores.size
      || [...expectedStores].some((storeIndex) => !actualStores.has(storeIndex))) {
      throw new Error(`${path}.${name} must cover every and only published_population store_index`);
    }
  }
  const expectedOrderScopes = [...WALMART_ORDER_SHIP_NODE_TYPES].sort(compareCodeUnits);
  const expectedReturnScopes = WALMART_RETURN_WFS_SCOPES
    .map((scope) => `WFS_${scope}`)
    .sort(compareCodeUnits);
  for (const storeIndex of populationStores) {
    const storeOrderBindings = parsed.orders
      .filter((binding) => binding.store_index === storeIndex)
    const orderScopes = [...new Set(storeOrderBindings.map((binding) => binding.source_scope))]
      .sort(compareCodeUnits);
    if (canonicalJson(orderScopes) !== canonicalJson(expectedOrderScopes)
      || expectedOrderScopes.some((scope) => (
        storeOrderBindings.filter((binding) => binding.source_scope === scope).length < 2
      ))) {
      throw new Error(
        `${path}.orders must contain exact scopes with baseline and tail partitions per store`,
      );
    }
    const returnScopes = parsed.returns
      .filter((binding) => binding.store_index === storeIndex)
      .map((binding) => binding.source_scope)
      .sort(compareCodeUnits);
    if (canonicalJson(returnScopes) !== canonicalJson(expectedReturnScopes)) {
      throw new Error(`${path}.returns must contain exact WFS_N and WFS_Y scopes per store`);
    }
    const populationBinding = parsed.published_population.find(
      (binding) => binding.store_index === storeIndex,
    )!;
    const transactionBindings = [...parsed.orders, ...parsed.returns].filter(
      (binding) => binding.store_index === storeIndex,
    );
    if (transactionBindings.some((binding) => (
      binding.seller_account_fingerprint_sha256
        !== populationBinding.seller_account_fingerprint_sha256
    ))) {
      throw new Error(`${path} seller account fingerprints must match within each store`);
    }
  }
  const allBindings = [
    ...parsed.published_population,
    ...parsed.orders,
    ...parsed.returns,
  ];
  const latestCapture = new Date(Math.max(
    ...allBindings.map((binding) => Date.parse(binding.captured_at)),
  )).toISOString();
  if (latestCapture !== new Date(Date.parse(capturedAt)).toISOString()) {
    throw new Error(`${path} latest source capture must equal performance captured_at`);
  }
  for (const binding of [...parsed.published_population, ...parsed.returns]) {
    if (Date.parse(binding.captured_at) < Date.parse(cutoffAt)) {
      throw new Error(`${path} population/returns capture cannot precede outcome cutoff`);
    }
  }
  return parsed;
}

function parsePerformanceSourceReconciliation(
  value: unknown,
  path: string,
): WalmartShadowPerformanceSourceReconciliation {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const numericKeys = [
    "published_population_rows", "unique_orders", "order_lines", "eligible_sold_lines",
    "unique_returns", "return_lines", "replacement_order_lines_excluded",
    "order_lines_outside_published_population",
    "outcome_units_outside_sales_cohort", "outcome_units_outside_published_population",
    "outcome_units_suppressed_by_precedence", "cancelled_outcome_units_excluded",
    "order_partitions", "overlapping_orders_deduplicated",
    "outcome_units_unknown_or_pre_window_purchase_order",
    "outcome_units_replacement_purchase_order",
  ] as const;
  assertExactKeys(value, [...numericKeys, "order_partition_ids"], path);
  if (!Array.isArray(value.order_partition_ids) || value.order_partition_ids.length === 0) {
    throw new Error(`${path}.order_partition_ids must be a non-empty array`);
  }
  const orderPartitionIds = value.order_partition_ids.map((id, index) => (
    requiredString(id, `${path}.order_partition_ids[${index}]`)
  ));
  if (new Set(orderPartitionIds).size !== orderPartitionIds.length
    || canonicalJson(orderPartitionIds)
      !== canonicalJson([...orderPartitionIds].sort(compareCodeUnits))) {
    throw new Error(`${path}.order_partition_ids must be unique and canonical`);
  }
  const parsedNumeric = Object.fromEntries(numericKeys.map((key) => [
    key,
    requiredSafeInteger(value[key], `${path}.${key}`),
  ])) as unknown as Omit<WalmartShadowPerformanceSourceReconciliation, "order_partition_ids">;
  const parsed: WalmartShadowPerformanceSourceReconciliation = {
    ...parsedNumeric,
    order_partition_ids: orderPartitionIds,
  };
  if (parsed.order_partitions !== parsed.order_partition_ids.length) {
    throw new Error(`${path}.order_partitions must equal order_partition_ids.length`);
  }
  if (parsed.eligible_sold_lines > parsed.order_lines) {
    throw new Error(`${path}.eligible_sold_lines cannot exceed order_lines`);
  }
  if (parsed.replacement_order_lines_excluded > parsed.order_lines) {
    throw new Error(`${path}.replacement_order_lines_excluded cannot exceed order_lines`);
  }
  if (safeIntegerSum(
    [parsed.eligible_sold_lines, parsed.replacement_order_lines_excluded],
    `${path} eligible/replacement line sum`,
  ) > parsed.order_lines) {
    throw new Error(`${path} eligible sold and replacement-excluded lines cannot exceed order_lines`);
  }
  if ((parsed.unique_orders === 0) !== (parsed.order_lines === 0)) {
    throw new Error(`${path}.unique_orders and order_lines zero/nonzero state must agree`);
  }
  if ((parsed.unique_returns === 0) !== (parsed.return_lines === 0)) {
    throw new Error(`${path}.unique_returns and return_lines zero/nonzero state must agree`);
  }
  if (parsed.order_lines_outside_published_population > parsed.eligible_sold_lines) {
    throw new Error(`${path}.order_lines_outside_published_population cannot exceed eligible_sold_lines`);
  }
  return parsed;
}

function verifySourceEnvelope(
  raw: unknown,
  schema: string,
  idPrefix: string,
  extraKeys: readonly string[],
  path: string,
): {
  value: Record<string, unknown>;
  snapshot_id: string;
  body_sha256: string;
  captured_at: string;
} {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "schema_version", "snapshot_id", "body_sha256", "captured_at", "channel",
    "published_population_complete", ...extraKeys,
  ], path);
  if (raw.schema_version !== schema) throw new Error(`${path}.schema_version must be ${schema}`);
  if (raw.channel !== WALMART_SHADOW_LISTING_CHANNEL) {
    throw new Error(`${path}.channel must be ${WALMART_SHADOW_LISTING_CHANNEL}`);
  }
  if (raw.published_population_complete !== true) {
    throw new Error(`${path}.published_population_complete must be true`);
  }
  const bodySha = requiredSha(raw.body_sha256, `${path}.body_sha256`);
  const body = { ...raw };
  delete body.snapshot_id;
  delete body.body_sha256;
  if (canonicalSha256(body) !== bodySha) {
    throw new Error(`${path}.body_sha256 does not match the canonical source body`);
  }
  const snapshotId = requiredString(raw.snapshot_id, `${path}.snapshot_id`);
  if (snapshotId !== `${idPrefix}-${bodySha.slice(0, 16)}`) {
    throw new Error(`${path}.snapshot_id is not derived from body_sha256`);
  }
  return {
    value: raw,
    snapshot_id: snapshotId,
    body_sha256: bodySha,
    captured_at: requiredTimestamp(raw.captured_at, `${path}.captured_at`),
  };
}

function parseListingIdentity(
  value: Record<string, unknown>,
  path: string,
): WalmartShadowListingIdentity {
  if (value.channel !== WALMART_SHADOW_LISTING_CHANNEL) {
    throw new Error(`${path}.channel must be ${WALMART_SHADOW_LISTING_CHANNEL}`);
  }
  const storeIndex = requiredSafeInteger(value.store_index, `${path}.store_index`, 1);
  const sku = requiredString(value.sku, `${path}.sku`);
  const listingKey = requiredString(value.listing_key, `${path}.listing_key`);
  const expectedListingKey = walmartListingKey(storeIndex, sku);
  if (listingKey !== expectedListingKey) {
    throw new Error(`${path}.listing_key must exactly equal ${expectedListingKey}`);
  }
  return {
    channel: WALMART_SHADOW_LISTING_CHANNEL,
    store_index: storeIndex,
    sku,
    listing_key: listingKey,
  };
}

function parsePublishedCatalogSourceArtifact(
  value: unknown,
  path: string,
): WalmartShadowPublishedCatalogSourceArtifact {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "schema_version", "source_id", "body_sha256", "raw_transport_sha256",
    "decoded_report_sha256", "cutoff_at",
  ], path);
  if (value.schema_version !== "walmart-item-report-published-source/v1") {
    throw new Error(`${path}.schema_version is unsupported`);
  }
  return {
    schema_version: "walmart-item-report-published-source/v1",
    source_id: requiredString(value.source_id, `${path}.source_id`),
    body_sha256: requiredSha(value.body_sha256, `${path}.body_sha256`),
    raw_transport_sha256: requiredSha(
      value.raw_transport_sha256,
      `${path}.raw_transport_sha256`,
    ),
    decoded_report_sha256: requiredSha(
      value.decoded_report_sha256,
      `${path}.decoded_report_sha256`,
    ),
    cutoff_at: requiredTimestamp(value.cutoff_at, `${path}.cutoff_at`),
  };
}

function assertCanonicalUniquePopulation(
  rows: readonly WalmartShadowListingIdentity[],
  path: string,
): void {
  if (rows.length === 0) throw new Error(`${path} must not be empty`);
  const listingKeys = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (listingKeys.has(row.listing_key)) {
      throw new Error(`${path} has duplicate listing_key ${row.listing_key} at index ${index}`);
    }
    listingKeys.add(row.listing_key);
  }
  const canonicalKeys = rows.map((row) => row.listing_key);
  const sorted = [...canonicalKeys].sort(compareCodeUnits);
  if (canonicalJson(canonicalKeys) !== canonicalJson(sorted)) {
    throw new Error(`${path} must be in canonical listing_key order`);
  }
}

function parsePublishedCatalogSource(raw: unknown): WalmartShadowPublishedCatalogSource {
  const path = "published catalog source";
  const envelope = verifySourceEnvelope(
    raw,
    WALMART_SHADOW_PUBLISHED_CATALOG_SOURCE_SCHEMA,
    "walmart-shadow-catalog",
    ["source_artifact", "rows"],
    path,
  );
  const sourceArtifact = parsePublishedCatalogSourceArtifact(
    envelope.value.source_artifact,
    `${path}.source_artifact`,
  );
  if (sourceArtifact.cutoff_at !== envelope.captured_at) {
    throw new Error(`${path}.captured_at must exactly equal source_artifact.cutoff_at`);
  }
  if (!Array.isArray(envelope.value.rows)) throw new Error(`${path}.rows must be an array`);
  const rows = envelope.value.rows.map((row, index) => {
    const rowPath = `${path}.rows[${index}]`;
    if (!isRecord(row)) throw new Error(`${rowPath} must be an object`);
    assertExactKeys(row, [
      "channel", "store_index", "sku", "listing_key", "published_status",
    ], rowPath);
    if (row.published_status !== "PUBLISHED") {
      throw new Error(`${rowPath}.published_status must be PUBLISHED`);
    }
    return { ...parseListingIdentity(row, rowPath), published_status: "PUBLISHED" as const };
  });
  assertCanonicalUniquePopulation(rows, `${path}.rows`);
  return {
    schema_version: WALMART_SHADOW_PUBLISHED_CATALOG_SOURCE_SCHEMA,
    snapshot_id: envelope.snapshot_id,
    body_sha256: envelope.body_sha256,
    captured_at: envelope.captured_at,
    channel: WALMART_SHADOW_LISTING_CHANNEL,
    published_population_complete: true,
    source_artifact: sourceArtifact,
    rows,
  };
}

/**
 * Integrity/schema verifier for a frozen PUBLISHED bridge artifact.
 * Operational provenance still requires
 * verifyWalmartShadowPublishedCatalogSourceAgainstItemReportCapture, which
 * rebuilds this bridge from the authoritative raw v6 ITEM-report capture.
 */
export function verifyWalmartShadowPublishedCatalogSource(
  raw: unknown,
): WalmartShadowPublishedCatalogSource {
  assertWalmartShadowJsonBudget(raw, "published catalog source input");
  return parsePublishedCatalogSource(raw);
}

function parsePerformanceSource(raw: unknown): WalmartShadowPerformanceSource {
  const path = "performance source";
  const frozenPerformance = verifyWalmartFrozen180DayPerformanceSource(raw);
  const envelope = verifySourceEnvelope(
    frozenPerformance,
    WALMART_SHADOW_PERFORMANCE_SOURCE_SCHEMA,
    "walmart-shadow-performance",
    [
      "sales_window", "outcome_observation", "cohort_semantics", "money_semantics",
      "assurance", "source_bindings", "source_reconciliation", "rows",
    ],
    path,
  );
  if (!isRecord(envelope.value.sales_window)) throw new Error(`${path}.sales_window must be an object`);
  assertExactKeys(envelope.value.sales_window, [
    "starts_at", "start_exclusive", "ends_at", "end_exclusive", "days",
  ], `${path}.sales_window`);
  if (envelope.value.sales_window.start_exclusive !== true
    || envelope.value.sales_window.end_exclusive !== true) {
    throw new Error(`${path}.sales_window boundaries must both be exclusive`);
  }
  if (envelope.value.sales_window.days !== SELECTION_WINDOW_DAYS) {
    throw new Error(`${path}.sales_window.days must be ${SELECTION_WINDOW_DAYS}`);
  }
  const startsAt = requiredTimestamp(envelope.value.sales_window.starts_at, `${path}.sales_window.starts_at`);
  const endsAt = requiredTimestamp(envelope.value.sales_window.ends_at, `${path}.sales_window.ends_at`);
  if (Date.parse(endsAt) - Date.parse(startsAt) !== SELECTION_WINDOW_DAYS * 86_400_000) {
    throw new Error(`${path}.sales_window must span exactly ${SELECTION_WINDOW_DAYS} days`);
  }
  if (Date.parse(endsAt) > Date.parse(envelope.captured_at)) {
    throw new Error(`${path}.sales_window cannot end after captured_at`);
  }
  if (!isRecord(envelope.value.outcome_observation)) {
    throw new Error(`${path}.outcome_observation must be an object`);
  }
  assertExactKeys(
    envelope.value.outcome_observation,
    ["starts_at", "cutoff_at", "end_exclusive"],
    `${path}.outcome_observation`,
  );
  const observationStartsAt = requiredTimestamp(
    envelope.value.outcome_observation.starts_at,
    `${path}.outcome_observation.starts_at`,
  );
  const observationCutoffAt = requiredTimestamp(
    envelope.value.outcome_observation.cutoff_at,
    `${path}.outcome_observation.cutoff_at`,
  );
  if (envelope.value.outcome_observation.end_exclusive !== true) {
    throw new Error(`${path}.outcome_observation.end_exclusive must be true`);
  }
  if (observationStartsAt !== startsAt) {
    throw new Error(`${path}.outcome_observation.starts_at must equal sales_window.starts_at`);
  }
  if (Date.parse(observationCutoffAt) < Date.parse(endsAt)) {
    throw new Error(`${path}.outcome_observation.cutoff_at cannot precede sales_window.ends_at`);
  }
  if (Date.parse(observationCutoffAt) > Date.parse(envelope.captured_at)) {
    throw new Error(`${path}.outcome_observation.cutoff_at cannot be after captured_at`);
  }
  if (canonicalJson(envelope.value.cohort_semantics)
    !== canonicalJson(WALMART_PERFORMANCE_COHORT_SEMANTICS)) {
    throw new Error(`${path}.cohort_semantics must exactly match the fixed cohort contract`);
  }
  if (canonicalJson(envelope.value.money_semantics)
    !== canonicalJson(WALMART_PERFORMANCE_MONEY_SEMANTICS)) {
    throw new Error(`${path}.money_semantics must exactly match the fixed money contract`);
  }
  if (canonicalJson(envelope.value.assurance)
    !== canonicalJson(WALMART_PERFORMANCE_ASSURANCE)) {
    throw new Error(`${path}.assurance must preserve the fixed integrity-only/calibration NO-GO`);
  }
  const sourceBindings = parsePerformanceSourceBindings(
    envelope.value.source_bindings,
    envelope.captured_at,
    observationCutoffAt,
    `${path}.source_bindings`,
  );
  const sourceReconciliation = parsePerformanceSourceReconciliation(
    envelope.value.source_reconciliation,
    `${path}.source_reconciliation`,
  );
  const boundPartitionIds = sourceBindings.orders
    .map((binding) => binding.partition_id!)
    .sort(compareCodeUnits);
  if (canonicalJson(boundPartitionIds)
    !== canonicalJson(sourceReconciliation.order_partition_ids)) {
    throw new Error(`${path}.source_reconciliation partition IDs must match Orders bindings`);
  }
  if (!Array.isArray(envelope.value.rows)) throw new Error(`${path}.rows must be an array`);
  const rows = envelope.value.rows.map((row, index) => {
    const rowPath = `${path}.rows[${index}]`;
    if (!isRecord(row)) throw new Error(`${rowPath} must be an object`);
    assertExactKeys(row, [
      "channel", "store_index", "sku", "listing_key",
      "gross_sales_cents", "units_sold", "units_returned", "units_refunded",
      "units_replaced",
    ], rowPath);
    const identity = parseListingIdentity(row, rowPath);
    if (!sourceBindings.published_population.some(
      (binding) => binding.store_index === identity.store_index,
    )) {
      throw new Error(`${rowPath}.store_index has no published-population binding`);
    }
    const unitsSold = requiredSafeInteger(row.units_sold, `${rowPath}.units_sold`);
    const unitsReturned = requiredSafeInteger(row.units_returned, `${rowPath}.units_returned`);
    const unitsRefunded = requiredSafeInteger(row.units_refunded, `${rowPath}.units_refunded`);
    const unitsReplaced = requiredSafeInteger(row.units_replaced, `${rowPath}.units_replaced`);
    const riskUnits = safeIntegerSum(
      [unitsReturned, unitsRefunded, unitsReplaced],
      `${rowPath} return-risk unit sum`,
    );
    if (riskUnits > unitsSold) {
      throw new Error(
        `${rowPath} mutually exclusive return/refund/replacement units cannot exceed units_sold`,
      );
    }
    const grossSalesCents = requiredSafeInteger(
      row.gross_sales_cents,
      `${rowPath}.gross_sales_cents`,
    );
    if (unitsSold === 0 && grossSalesCents !== 0) {
      throw new Error(`${rowPath}.gross_sales_cents must be zero when units_sold is zero`);
    }
    return {
      ...identity,
      gross_sales_cents: grossSalesCents,
      units_sold: unitsSold,
      units_returned: unitsReturned,
      units_refunded: unitsRefunded,
      units_replaced: unitsReplaced,
    };
  });
  assertCanonicalUniquePopulation(rows, `${path}.rows`);
  if (sourceReconciliation.published_population_rows !== rows.length) {
    throw new Error(`${path}.source_reconciliation.published_population_rows must match rows`);
  }
  for (const populationBinding of sourceBindings.published_population) {
    if (!rows.some((row) => row.store_index === populationBinding.store_index)) {
      throw new Error(`${path}.rows has no listing for bound store_index ${populationBinding.store_index}`);
    }
  }
  return {
    schema_version: WALMART_SHADOW_PERFORMANCE_SOURCE_SCHEMA,
    snapshot_id: envelope.snapshot_id,
    body_sha256: envelope.body_sha256,
    captured_at: envelope.captured_at,
    channel: WALMART_SHADOW_LISTING_CHANNEL,
    published_population_complete: true,
    sales_window: {
      starts_at: startsAt,
      start_exclusive: true,
      ends_at: endsAt,
      end_exclusive: true,
      days: SELECTION_WINDOW_DAYS,
    },
    outcome_observation: {
      starts_at: observationStartsAt,
      cutoff_at: observationCutoffAt,
      end_exclusive: true,
    },
    cohort_semantics: cloneCanonical(WALMART_PERFORMANCE_COHORT_SEMANTICS),
    money_semantics: cloneCanonical(WALMART_PERFORMANCE_MONEY_SEMANTICS),
    assurance: cloneCanonical(WALMART_PERFORMANCE_ASSURANCE),
    source_bindings: sourceBindings,
    source_reconciliation: sourceReconciliation,
    rows,
  };
}

function parsePriorVisualSource(raw: unknown): WalmartShadowPriorVisualSource {
  const path = "prior visual source";
  const envelope = verifySourceEnvelope(
    raw,
    WALMART_SHADOW_PRIOR_VISUAL_SOURCE_SCHEMA,
    "walmart-shadow-prior-visual",
    ["cutoff_at", "source_bindings", "source_reconciliation", "rows"],
    path,
  );
  const cutoffAt = requiredTimestamp(envelope.value.cutoff_at, `${path}.cutoff_at`);
  if (cutoffAt !== envelope.captured_at) {
    throw new Error(`${path}.cutoff_at must exactly equal captured_at`);
  }
  const sourceBindings = parseQualifiedSourceBindings(
    envelope.value.source_bindings,
    "walmart-shadow-prior-visual-qualified-evidence-ledger/v1",
    cutoffAt,
    `${path}.source_bindings`,
  );
  const sourceReconciliation = parseQualifiedSourceReconciliation(
    envelope.value.source_reconciliation,
    `${path}.source_reconciliation`,
  );
  if (!Array.isArray(envelope.value.rows)) throw new Error(`${path}.rows must be an array`);
  const rows = envelope.value.rows.map((row, index) => {
    const rowPath = `${path}.rows[${index}]`;
    if (!isRecord(row)) throw new Error(`${rowPath} must be an object`);
    assertExactKeys(row, [
      "channel", "store_index", "sku", "listing_key", "verdict", "label",
    ], rowPath);
    if (row.verdict !== "BAD" && row.verdict !== "PASS" && row.verdict !== "NOT_AUDITED") {
      throw new Error(`${rowPath}.verdict is unsupported`);
    }
    const verdict: WalmartShadowPriorVisualSource["rows"][number]["verdict"] = row.verdict;
    let label: WalmartShadowPriorVisualSource["rows"][number]["label"] = null;
    if (row.label !== null) {
      if (!isRecord(row.label)) throw new Error(`${rowPath}.label must be an object or null`);
      assertExactKeys(row.label, ["label_id", "body_sha256", "labeled_at"], `${rowPath}.label`);
      label = {
        label_id: requiredString(row.label.label_id, `${rowPath}.label.label_id`),
        body_sha256: requiredSha(row.label.body_sha256, `${rowPath}.label.body_sha256`),
        labeled_at: requiredTimestamp(row.label.labeled_at, `${rowPath}.label.labeled_at`),
      };
      if (Date.parse(label.labeled_at) > Date.parse(envelope.captured_at)) {
        throw new Error(`${rowPath}.label.labeled_at cannot be after source captured_at`);
      }
    }
    if ((verdict === "NOT_AUDITED") !== (label === null)) {
      throw new Error(`${rowPath} NOT_AUDITED must have null label and BAD/PASS must have a label`);
    }
    return { ...parseListingIdentity(row, rowPath), verdict, label };
  });
  assertCanonicalUniquePopulation(rows, `${path}.rows`);
  const acceptedEvidence = rows.filter((row) => row.verdict !== "NOT_AUDITED").length;
  if (sourceReconciliation.population_rows !== rows.length
    || sourceReconciliation.output_rows !== rows.length
    || sourceReconciliation.evidence_accepted !== acceptedEvidence) {
    throw new Error(`${path}.source_reconciliation does not match compiled rows`);
  }
  if (sourceBindings.evidence_ledger.mode === "ZERO_EVIDENCE"
    && (sourceReconciliation.ledger_entries !== 0 || acceptedEvidence !== 0)) {
    throw new Error(`${path} ZERO_EVIDENCE ledger must compile every row as NOT_AUDITED`);
  }
  return {
    schema_version: WALMART_SHADOW_PRIOR_VISUAL_SOURCE_SCHEMA,
    snapshot_id: envelope.snapshot_id,
    body_sha256: envelope.body_sha256,
    captured_at: envelope.captured_at,
    channel: WALMART_SHADOW_LISTING_CHANNEL,
    published_population_complete: true,
    cutoff_at: cutoffAt,
    source_bindings: sourceBindings as WalmartShadowPriorVisualSource["source_bindings"],
    source_reconciliation: sourceReconciliation,
    rows,
  };
}

/**
 * Integrity/schema verifier for a frozen prior-visual source artifact.
 *
 * This deliberately does not claim that the qualified ledger is authentic;
 * operational selection still has to use
 * verifyWalmartShadowSelectionEvidenceAgainstSources so the artifact is
 * rebound to the exact authoritative published population.
 */
export function verifyWalmartShadowPriorVisualSource(
  raw: unknown,
): WalmartShadowPriorVisualSource {
  assertWalmartShadowJsonBudget(raw, "prior visual source input");
  return parsePriorVisualSource(raw);
}

function parseRemediationSource(raw: unknown): WalmartShadowRemediationSource {
  const path = "remediation source";
  const envelope = verifySourceEnvelope(
    raw,
    WALMART_SHADOW_REMEDIATION_SOURCE_SCHEMA,
    "walmart-shadow-remediation",
    ["cutoff_at", "source_bindings", "source_reconciliation", "rows"],
    path,
  );
  const cutoffAt = requiredTimestamp(envelope.value.cutoff_at, `${path}.cutoff_at`);
  if (cutoffAt !== envelope.captured_at) {
    throw new Error(`${path}.cutoff_at must exactly equal captured_at`);
  }
  const sourceBindings = parseQualifiedSourceBindings(
    envelope.value.source_bindings,
    "walmart-shadow-remediation-qualified-evidence-ledger/v1",
    cutoffAt,
    `${path}.source_bindings`,
  );
  const sourceReconciliation = parseQualifiedSourceReconciliation(
    envelope.value.source_reconciliation,
    `${path}.source_reconciliation`,
  );
  if (!Array.isArray(envelope.value.rows)) throw new Error(`${path}.rows must be an array`);
  const rows = envelope.value.rows.map((row, index) => {
    const rowPath = `${path}.rows[${index}]`;
    if (!isRecord(row)) throw new Error(`${rowPath} must be an object`);
    assertExactKeys(row, [
      "channel", "store_index", "sku", "listing_key", "status", "verification",
    ], rowPath);
    if (row.status !== "VERIFIED_APPLIED" && row.status !== "NOT_APPLIED") {
      throw new Error(`${rowPath}.status is unsupported`);
    }
    const status: WalmartShadowRemediationSource["rows"][number]["status"] = row.status;
    let verification: WalmartShadowRemediationSource["rows"][number]["verification"] = null;
    if (row.verification !== null) {
      if (!isRecord(row.verification)) {
        throw new Error(`${rowPath}.verification must be an object or null`);
      }
      assertExactKeys(
        row.verification,
        ["verification_id", "body_sha256", "verified_at"],
        `${rowPath}.verification`,
      );
      verification = {
        verification_id: requiredString(
          row.verification.verification_id,
          `${rowPath}.verification.verification_id`,
        ),
        body_sha256: requiredSha(row.verification.body_sha256, `${rowPath}.verification.body_sha256`),
        verified_at: requiredTimestamp(row.verification.verified_at, `${rowPath}.verification.verified_at`),
      };
      if (Date.parse(verification.verified_at) > Date.parse(envelope.captured_at)) {
        throw new Error(`${rowPath}.verification.verified_at cannot be after source captured_at`);
      }
    }
    if ((status === "NOT_APPLIED") !== (verification === null)) {
      throw new Error(`${rowPath} NOT_APPLIED must have null verification and VERIFIED_APPLIED must be verified`);
    }
    return { ...parseListingIdentity(row, rowPath), status, verification };
  });
  assertCanonicalUniquePopulation(rows, `${path}.rows`);
  const acceptedEvidence = rows.filter((row) => row.status === "VERIFIED_APPLIED").length;
  if (sourceReconciliation.population_rows !== rows.length
    || sourceReconciliation.output_rows !== rows.length
    || sourceReconciliation.evidence_accepted !== acceptedEvidence) {
    throw new Error(`${path}.source_reconciliation does not match compiled rows`);
  }
  if (sourceBindings.evidence_ledger.mode === "ZERO_EVIDENCE"
    && (sourceReconciliation.ledger_entries !== 0 || acceptedEvidence !== 0)) {
    throw new Error(`${path} ZERO_EVIDENCE ledger must compile every row as NOT_APPLIED`);
  }
  return {
    schema_version: WALMART_SHADOW_REMEDIATION_SOURCE_SCHEMA,
    snapshot_id: envelope.snapshot_id,
    body_sha256: envelope.body_sha256,
    captured_at: envelope.captured_at,
    channel: WALMART_SHADOW_LISTING_CHANNEL,
    published_population_complete: true,
    cutoff_at: cutoffAt,
    source_bindings: sourceBindings as WalmartShadowRemediationSource["source_bindings"],
    source_reconciliation: sourceReconciliation,
    rows,
  };
}

/**
 * Integrity/schema verifier for a frozen remediation source artifact.
 *
 * This deliberately does not claim that the qualified ledger is authentic;
 * operational selection still has to use
 * verifyWalmartShadowSelectionEvidenceAgainstSources so the artifact is
 * rebound to the exact authoritative published population.
 */
export function verifyWalmartShadowRemediationSource(
  raw: unknown,
): WalmartShadowRemediationSource {
  assertWalmartShadowJsonBudget(raw, "remediation source input");
  return parseRemediationSource(raw);
}

function assertExactPopulationMatch(
  expected: readonly WalmartShadowListingIdentity[],
  actual: readonly WalmartShadowListingIdentity[],
  label: string,
): void {
  const expectedKeys = expected.map((row) => row.listing_key);
  const actualKeys = actual.map((row) => row.listing_key);
  if (canonicalJson(expectedKeys) !== canonicalJson(actualKeys)) {
    throw new Error(`${label} population does not exactly match the complete PUBLISHED catalog`);
  }
}

function assertQualifiedSourceBindsPublishedCatalog(
  catalog: WalmartShadowPublishedCatalogSource,
  source: WalmartShadowPriorVisualSource | WalmartShadowRemediationSource,
  label: string,
): void {
  const binding = source.source_bindings.published_catalog;
  if (binding.artifact_id !== catalog.snapshot_id
    || binding.body_sha256 !== catalog.body_sha256
    || binding.captured_at !== catalog.captured_at) {
    throw new Error(`${label} is detached from the exact authoritative PUBLISHED source`);
  }
  if (Date.parse(source.cutoff_at) < Date.parse(catalog.captured_at)) {
    throw new Error(`${label}.cutoff_at cannot precede the PUBLISHED source`);
  }
}

function parseSelectionRow(value: unknown, path: string): WalmartShadowSelectionEvidenceRow {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "channel", "store_index", "sku", "listing_key",
    "performance", "prior_visual", "remediation",
  ], path);
  const identity = parseListingIdentity(value, path);
  if (!isRecord(value.performance)) throw new Error(`${path}.performance must be an object`);
  assertExactKeys(value.performance, [
    "gross_sales_cents", "units_sold", "units_returned", "units_refunded",
    "units_replaced", "return_risk_units",
  ], `${path}.performance`);
  if (!isRecord(value.prior_visual)) throw new Error(`${path}.prior_visual must be an object`);
  assertExactKeys(value.prior_visual, ["verdict", "label"], `${path}.prior_visual`);
  if (value.prior_visual.verdict !== "BAD" && value.prior_visual.verdict !== "PASS"
    && value.prior_visual.verdict !== "NOT_AUDITED") {
    throw new Error(`${path}.prior_visual.verdict is unsupported`);
  }
  let label: WalmartShadowSelectionEvidenceRow["prior_visual"]["label"] = null;
  if (value.prior_visual.label !== null) {
    if (!isRecord(value.prior_visual.label)) {
      throw new Error(`${path}.prior_visual.label must be an object or null`);
    }
    assertExactKeys(
      value.prior_visual.label,
      ["label_id", "body_sha256", "labeled_at"],
      `${path}.prior_visual.label`,
    );
    label = {
      label_id: requiredString(value.prior_visual.label.label_id, `${path}.prior_visual.label.label_id`),
      body_sha256: requiredSha(value.prior_visual.label.body_sha256, `${path}.prior_visual.label.body_sha256`),
      labeled_at: requiredTimestamp(value.prior_visual.label.labeled_at, `${path}.prior_visual.label.labeled_at`),
    };
  }
  if ((value.prior_visual.verdict === "NOT_AUDITED") !== (label === null)) {
    throw new Error(`${path}.prior_visual label does not match verdict`);
  }
  if (!isRecord(value.remediation)) throw new Error(`${path}.remediation must be an object`);
  assertExactKeys(value.remediation, ["status", "verification"], `${path}.remediation`);
  if (value.remediation.status !== "VERIFIED_APPLIED" && value.remediation.status !== "NOT_APPLIED") {
    throw new Error(`${path}.remediation.status is unsupported`);
  }
  let verification: WalmartShadowSelectionEvidenceRow["remediation"]["verification"] = null;
  if (value.remediation.verification !== null) {
    if (!isRecord(value.remediation.verification)) {
      throw new Error(`${path}.remediation.verification must be an object or null`);
    }
    assertExactKeys(
      value.remediation.verification,
      ["verification_id", "body_sha256", "verified_at"],
      `${path}.remediation.verification`,
    );
    verification = {
      verification_id: requiredString(
        value.remediation.verification.verification_id,
        `${path}.remediation.verification.verification_id`,
      ),
      body_sha256: requiredSha(
        value.remediation.verification.body_sha256,
        `${path}.remediation.verification.body_sha256`,
      ),
      verified_at: requiredTimestamp(
        value.remediation.verification.verified_at,
        `${path}.remediation.verification.verified_at`,
      ),
    };
  }
  if ((value.remediation.status === "NOT_APPLIED") !== (verification === null)) {
    throw new Error(`${path}.remediation verification does not match status`);
  }
  const unitsSold = requiredSafeInteger(value.performance.units_sold, `${path}.performance.units_sold`);
  const unitsReturned = requiredSafeInteger(value.performance.units_returned, `${path}.performance.units_returned`);
  const unitsRefunded = requiredSafeInteger(
    value.performance.units_refunded,
    `${path}.performance.units_refunded`,
  );
  const unitsReplaced = requiredSafeInteger(
    value.performance.units_replaced,
    `${path}.performance.units_replaced`,
  );
  const returnRiskUnits = safeIntegerSum(
    [unitsReturned, unitsRefunded, unitsReplaced],
    `${path}.performance return-risk unit sum`,
  );
  if (requiredSafeInteger(
    value.performance.return_risk_units,
    `${path}.performance.return_risk_units`,
  ) !== returnRiskUnits) {
    throw new Error(`${path}.performance.return_risk_units is not the exact outcome bucket sum`);
  }
  if (returnRiskUnits > unitsSold) {
    throw new Error(`${path}.performance.return_risk_units cannot exceed units_sold`);
  }
  return {
    ...identity,
    performance: {
      gross_sales_cents: requiredSafeInteger(value.performance.gross_sales_cents, `${path}.performance.gross_sales_cents`),
      units_sold: unitsSold,
      units_returned: unitsReturned,
      units_refunded: unitsRefunded,
      units_replaced: unitsReplaced,
      return_risk_units: returnRiskUnits,
    },
    prior_visual: { verdict: value.prior_visual.verdict, label },
    remediation: { status: value.remediation.status, verification },
  };
}

function parseSelectionEvidence(raw: unknown): SealedWalmartShadowSelectionEvidence {
  if (!isRecord(raw)) throw new Error("selection evidence must be a sealed object");
  assertExactKeys(raw, [
    "schema_version", "snapshot_id", "body_sha256", "compiled_at", "scope",
    "source_artifacts", "rows",
  ], "selection evidence");
  if (raw.schema_version !== WALMART_SHADOW_SELECTION_EVIDENCE_SCHEMA) {
    throw new Error(`selection evidence.schema_version must be ${WALMART_SHADOW_SELECTION_EVIDENCE_SCHEMA}`);
  }
  const bodySha = requiredSha(raw.body_sha256, "selection evidence.body_sha256");
  const body = { ...raw };
  delete body.body_sha256;
  if (canonicalSha256(body) !== bodySha) throw new Error("selection evidence canonical body seal mismatch");
  const identityMaterial = { ...body };
  delete identityMaterial.snapshot_id;
  const expectedSnapshotId = `walmart-shadow-selection-${canonicalSha256(identityMaterial).slice(0, 16)}`;
  const snapshotId = requiredString(raw.snapshot_id, "selection evidence.snapshot_id");
  if (snapshotId !== expectedSnapshotId) {
    throw new Error("selection evidence.snapshot_id is not derived from canonical content");
  }
  const compiledAt = requiredTimestamp(raw.compiled_at, "selection evidence.compiled_at");
  if (!isRecord(raw.scope)) throw new Error("selection evidence.scope must be an object");
  assertExactKeys(raw.scope, [
    "channel", "published_population_complete", "population_size", "sales_window",
    "outcome_observation", "cohort_semantics", "money_semantics",
  ], "selection evidence.scope");
  if (raw.scope.channel !== WALMART_SHADOW_LISTING_CHANNEL) {
    throw new Error(
      `selection evidence.scope.channel must be ${WALMART_SHADOW_LISTING_CHANNEL}`,
    );
  }
  if (raw.scope.published_population_complete !== true) {
    throw new Error("selection evidence must cover the complete published Walmart population");
  }
  if (!isRecord(raw.scope.sales_window)) throw new Error("selection evidence.scope.sales_window must be an object");
  assertExactKeys(raw.scope.sales_window, [
    "starts_at", "start_exclusive", "ends_at", "end_exclusive", "days",
  ], "selection evidence.scope.sales_window");
  if (raw.scope.sales_window.start_exclusive !== true
    || raw.scope.sales_window.end_exclusive !== true) {
    throw new Error("selection evidence sales-window boundaries must both be exclusive");
  }
  if (raw.scope.sales_window.days !== SELECTION_WINDOW_DAYS) {
    throw new Error(`selection evidence sales window must be ${SELECTION_WINDOW_DAYS} days`);
  }
  const startsAt = requiredTimestamp(raw.scope.sales_window.starts_at, "selection evidence.scope.sales_window.starts_at");
  const endsAt = requiredTimestamp(raw.scope.sales_window.ends_at, "selection evidence.scope.sales_window.ends_at");
  if (Date.parse(endsAt) - Date.parse(startsAt) !== SELECTION_WINDOW_DAYS * 86_400_000) {
    throw new Error(`selection evidence sales window must span exactly ${SELECTION_WINDOW_DAYS} days`);
  }
  if (Date.parse(endsAt) > Date.parse(compiledAt)) {
    throw new Error("selection evidence sales window cannot end after compiled_at");
  }
  if (!isRecord(raw.scope.outcome_observation)) {
    throw new Error("selection evidence.scope.outcome_observation must be an object");
  }
  assertExactKeys(
    raw.scope.outcome_observation,
    ["starts_at", "cutoff_at", "end_exclusive"],
    "selection evidence.scope.outcome_observation",
  );
  const observationStartsAt = requiredTimestamp(
    raw.scope.outcome_observation.starts_at,
    "selection evidence.scope.outcome_observation.starts_at",
  );
  const observationCutoffAt = requiredTimestamp(
    raw.scope.outcome_observation.cutoff_at,
    "selection evidence.scope.outcome_observation.cutoff_at",
  );
  if (raw.scope.outcome_observation.end_exclusive !== true) {
    throw new Error("selection evidence.scope.outcome_observation.end_exclusive must be true");
  }
  if (observationStartsAt !== startsAt
    || Date.parse(observationCutoffAt) < Date.parse(endsAt)
    || Date.parse(observationCutoffAt) > Date.parse(compiledAt)) {
    throw new Error("selection evidence outcome observation is outside its fixed cohort bounds");
  }
  if (canonicalJson(raw.scope.cohort_semantics)
    !== canonicalJson(WALMART_PERFORMANCE_COHORT_SEMANTICS)) {
    throw new Error("selection evidence.scope.cohort_semantics differs from fixed policy");
  }
  if (canonicalJson(raw.scope.money_semantics)
    !== canonicalJson(WALMART_PERFORMANCE_MONEY_SEMANTICS)) {
    throw new Error("selection evidence.scope.money_semantics differs from fixed policy");
  }
  if (!isRecord(raw.source_artifacts)) throw new Error("selection evidence.source_artifacts must be an object");
  assertExactKeys(raw.source_artifacts, [
    "published_catalog", "performance", "prior_visual", "remediation",
  ], "selection evidence.source_artifacts");
  const sourceArtifacts = {
    published_catalog: parseSourceArtifact(raw.source_artifacts.published_catalog, "selection evidence.source_artifacts.published_catalog"),
    performance: parseSourceArtifact(raw.source_artifacts.performance, "selection evidence.source_artifacts.performance"),
    prior_visual: parseSourceArtifact(raw.source_artifacts.prior_visual, "selection evidence.source_artifacts.prior_visual"),
    remediation: parseSourceArtifact(raw.source_artifacts.remediation, "selection evidence.source_artifacts.remediation"),
  };
  for (const [name, artifact] of Object.entries(sourceArtifacts)) {
    if (Date.parse(artifact.captured_at) > Date.parse(compiledAt)) {
      throw new Error(`selection evidence ${name} source was captured after compiled_at`);
    }
  }
  if (!Array.isArray(raw.rows) || raw.rows.length === 0) {
    throw new Error("selection evidence.rows must be a non-empty array");
  }
  const rows = raw.rows.map((row, index) => parseSelectionRow(row, `selection evidence.rows[${index}]`));
  const populationSize = requiredSafeInteger(raw.scope.population_size, "selection evidence.scope.population_size", 1);
  if (populationSize !== rows.length) throw new Error("selection evidence population_size does not match rows");
  assertCanonicalUniquePopulation(rows, "selection evidence.rows");
  return {
    schema_version: WALMART_SHADOW_SELECTION_EVIDENCE_SCHEMA,
    snapshot_id: snapshotId,
    body_sha256: bodySha,
    compiled_at: compiledAt,
    scope: {
      channel: WALMART_SHADOW_LISTING_CHANNEL,
      published_population_complete: true,
      population_size: populationSize,
      sales_window: {
        starts_at: startsAt,
        start_exclusive: true,
        ends_at: endsAt,
        end_exclusive: true,
        days: SELECTION_WINDOW_DAYS,
      },
      outcome_observation: {
        starts_at: observationStartsAt,
        cutoff_at: observationCutoffAt,
        end_exclusive: true,
      },
      cohort_semantics: cloneCanonical(WALMART_PERFORMANCE_COHORT_SEMANTICS),
      money_semantics: cloneCanonical(WALMART_PERFORMANCE_MONEY_SEMANTICS),
    },
    source_artifacts: sourceArtifacts,
    rows,
  };
}

/**
 * Integrity-only seal helper. Operational selection must additionally pass
 * verifyWalmartShadowSelectionEvidenceAgainstSources; this helper alone does
 * not authenticate caller-authored rows.
 */
export function sealWalmartShadowSelectionEvidence(
  body: WalmartShadowSelectionEvidenceBody,
): SealedWalmartShadowSelectionEvidence {
  assertWalmartShadowJsonBudget(body, "selection evidence seal input");
  if (!isRecord(body) || Object.prototype.hasOwnProperty.call(body, "body_sha256")) {
    throw new Error("selection evidence body must not already contain body_sha256");
  }
  const material = structuredClone(body) as WalmartShadowSelectionEvidenceBody;
  const identityMaterial = { ...material } as Record<string, unknown>;
  delete identityMaterial.snapshot_id;
  material.snapshot_id = `walmart-shadow-selection-${canonicalSha256(identityMaterial).slice(0, 16)}`;
  const sealed = { ...material, body_sha256: canonicalSha256(material) };
  return parseSelectionEvidence(sealed);
}

export function verifyWalmartShadowSelectionEvidence(raw: unknown): boolean {
  try {
    assertWalmartShadowJsonBudget(raw, "selection evidence verification input");
    parseSelectionEvidence(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deterministically join four complete frozen sources. No tier, risk score,
 * stratum, listing kind, or expected truth is accepted from any source row.
 */
export function compileWalmartShadowSelectionEvidence(
  publishedCatalogInput: unknown,
  performanceInput: unknown,
  priorVisualInput: unknown,
  remediationInput: unknown,
): SealedWalmartShadowSelectionEvidence {
  assertWalmartShadowJsonInputs([
    ["published catalog source input", publishedCatalogInput],
    ["performance source input", performanceInput],
    ["prior visual source input", priorVisualInput],
    ["remediation source input", remediationInput],
  ]);
  const catalog = parsePublishedCatalogSource(publishedCatalogInput);
  const performance = parsePerformanceSource(performanceInput);
  const priorVisual = parsePriorVisualSource(priorVisualInput);
  const remediation = parseRemediationSource(remediationInput);

  assertQualifiedSourceBindsPublishedCatalog(catalog, priorVisual, "prior visual source");
  assertQualifiedSourceBindsPublishedCatalog(catalog, remediation, "remediation source");
  assertExactPopulationMatch(catalog.rows, performance.rows, "performance source");
  assertExactPopulationMatch(catalog.rows, priorVisual.rows, "prior visual source");
  assertExactPopulationMatch(catalog.rows, remediation.rows, "remediation source");

  const performanceByListingKey = new Map(
    performance.rows.map((row) => [row.listing_key, row]),
  );
  const priorByListingKey = new Map(
    priorVisual.rows.map((row) => [row.listing_key, row]),
  );
  const remediationByListingKey = new Map(
    remediation.rows.map((row) => [row.listing_key, row]),
  );
  const rows: WalmartShadowSelectionEvidenceRow[] = catalog.rows.map((catalogRow) => {
    const performanceRow = performanceByListingKey.get(catalogRow.listing_key)!;
    const priorRow = priorByListingKey.get(catalogRow.listing_key)!;
    const remediationRow = remediationByListingKey.get(catalogRow.listing_key)!;
    return {
      channel: catalogRow.channel,
      store_index: catalogRow.store_index,
      sku: catalogRow.sku,
      listing_key: catalogRow.listing_key,
      performance: {
        gross_sales_cents: performanceRow.gross_sales_cents,
        units_sold: performanceRow.units_sold,
        units_returned: performanceRow.units_returned,
        units_refunded: performanceRow.units_refunded,
        units_replaced: performanceRow.units_replaced,
        return_risk_units: safeIntegerSum(
          [
            performanceRow.units_returned,
            performanceRow.units_refunded,
            performanceRow.units_replaced,
          ],
          `${performanceRow.listing_key} return-risk unit sum`,
        ),
      },
      prior_visual: {
        verdict: priorRow.verdict,
        label: priorRow.label ? { ...priorRow.label } : null,
      },
      remediation: {
        status: remediationRow.status,
        verification: remediationRow.verification ? { ...remediationRow.verification } : null,
      },
    };
  });
  const compiledAt = new Date(Math.max(
    Date.parse(catalog.captured_at),
    Date.parse(performance.captured_at),
    Date.parse(priorVisual.captured_at),
    Date.parse(remediation.captured_at),
  )).toISOString();
  return sealWalmartShadowSelectionEvidence({
    schema_version: WALMART_SHADOW_SELECTION_EVIDENCE_SCHEMA,
    snapshot_id: "derived-by-sealer",
    compiled_at: compiledAt,
    scope: {
      channel: WALMART_SHADOW_LISTING_CHANNEL,
      published_population_complete: true,
      population_size: catalog.rows.length,
      sales_window: { ...performance.sales_window },
      outcome_observation: { ...performance.outcome_observation },
      cohort_semantics: cloneCanonical(WALMART_PERFORMANCE_COHORT_SEMANTICS),
      money_semantics: cloneCanonical(WALMART_PERFORMANCE_MONEY_SEMANTICS),
    },
    source_artifacts: {
      published_catalog: {
        artifact_id: catalog.snapshot_id,
        body_sha256: catalog.body_sha256,
        captured_at: catalog.captured_at,
      },
      performance: {
        artifact_id: performance.snapshot_id,
        body_sha256: performance.body_sha256,
        captured_at: performance.captured_at,
      },
      prior_visual: {
        artifact_id: priorVisual.snapshot_id,
        body_sha256: priorVisual.body_sha256,
        captured_at: priorVisual.captured_at,
      },
      remediation: {
        artifact_id: remediation.snapshot_id,
        body_sha256: remediation.body_sha256,
        captured_at: remediation.captured_at,
      },
    },
    rows,
  });
}

/** Source-aware verifier required by the Shadow selector. */
export function verifyWalmartShadowSelectionEvidenceAgainstSources(
  rawEvidence: unknown,
  publishedCatalogInput: unknown,
  performanceInput: unknown,
  priorVisualInput: unknown,
  remediationInput: unknown,
): SealedWalmartShadowSelectionEvidence {
  assertWalmartShadowJsonInputs([
    ["selection evidence input", rawEvidence],
    ["published catalog source input", publishedCatalogInput],
    ["performance source input", performanceInput],
    ["prior visual source input", priorVisualInput],
    ["remediation source input", remediationInput],
  ]);
  const verified = parseSelectionEvidence(rawEvidence);
  const recompiled = compileWalmartShadowSelectionEvidence(
    publishedCatalogInput,
    performanceInput,
    priorVisualInput,
    remediationInput,
  );
  if (canonicalJson(verified) !== canonicalJson(recompiled)) {
    throw new Error(
      "selection evidence does not exactly match deterministic compilation from four frozen sources",
    );
  }
  return verified;
}

function deriveSalesTiers(rows: readonly WalmartShadowSelectionEvidenceRow[]): Map<string, ShadowSalesTier> {
  const ordered = [...rows].sort((left, right) => (
    compareSafeIntegersDescending(left.performance.units_sold, right.performance.units_sold)
    || compareCodeUnits(left.listing_key, right.listing_key)
  ));
  const highEnd = Math.ceil(ordered.length * 0.2);
  const mediumEnd = Math.ceil(ordered.length * 0.5);
  return new Map(ordered.map((row, index) => [
    row.listing_key,
    index < highEnd ? "high" : index < mediumEnd ? "medium" : "low",
  ]));
}

function returnRatePpmFromCounts(riskUnits: number, sold: number, path: string): number {
  if (sold === 0) {
    if (riskUnits !== 0) {
      throw new Error(`${path}: zero-unit sales cohort has return-risk outcomes`);
    }
    return 0;
  }
  if (riskUnits > sold) {
    throw new Error(`${path}: return-risk units exceed the sales cohort`);
  }
  const numerator = BigInt(riskUnits) * BigInt(1_000_000);
  const denominator = BigInt(sold);
  const rounded = (numerator + denominator / BigInt(2)) / denominator;
  if (rounded > BigInt(1_000_000)) {
    throw new Error(`${path}: return-risk rate exceeds 1,000,000 ppm`);
  }
  return Number(rounded);
}

function returnRatePpm(row: WalmartShadowSelectionEvidenceRow): number {
  return returnRatePpmFromCounts(
    row.performance.return_risk_units,
    row.performance.units_sold,
    row.listing_key,
  );
}

function compareRiskTuples(left: ShadowRiskTuple, right: ShadowRiskTuple): number {
  for (let index = 0; index < left.length; index += 1) {
    const order = compareSafeIntegersDescending(left[index], right[index]);
    if (order !== 0) return order;
  }
  return 0;
}

function deriveCandidate(
  truthCase: WalmartCatalogTruthAuditCase,
  selectionRow: WalmartShadowSelectionEvidenceRow,
  salesTier: ShadowSalesTier,
): DerivedCandidate | null {
  const truthListingIdentity = parseListingIdentity(
    truthCase as unknown as Record<string, unknown>,
    `${truthCase.sku}.product_truth_listing_identity`,
  );
  if (truthListingIdentity.listing_key !== selectionRow.listing_key) {
    throw new Error(
      `${truthCase.sku}: selection evidence listing_key differs from Product Truth export`,
    );
  }
  if (truthCase.disposition !== "auditable" || truthCase.compiler_reasons.length > 0) return null;
  if (truthCase.published_status !== "PUBLISHED") return null;
  if (truthCase.lifecycle_status !== "ACTIVE") return null;
  if (truthCase.listing_kind !== "single" && truthCase.listing_kind !== "multipack") return null;
  if (truthCase.recipe_composition !== "same_product") return null;
  if (!truthCase.buyer_snapshot || !truthCase.preflight
    || truthCase.preflight.status !== "AUDITABLE" || truthCase.preflight.reasons.length > 0
    || !truthCase.preflight.expected) return null;
  if (truthCase.preflight.sku !== truthCase.sku || truthCase.preflight.item_id !== truthCase.item_id) {
    throw new Error(`${truthCase.sku}: AUDITABLE preflight identity differs from compiled truth case`);
  }
  if (truthCase.preflight.evidence_bindings.length === 0
    || truthCase.preflight.evidence_bindings.some((binding) => binding.payload_sha256 === null)) {
    throw new Error(`${truthCase.sku}: AUDITABLE preflight lacks sealed source evidence`);
  }
  if (!truthCase.preflight_sha256) {
    throw new Error(`${truthCase.sku}: AUDITABLE case has no compiled preflight SHA-256`);
  }
  if (canonicalSha256(truthCase.preflight) !== truthCase.preflight_sha256) {
    throw new Error(`${truthCase.sku}: compiler preflight SHA-256 does not match the result`);
  }
  const expected = validateExpectedTruth(
    truthCase.preflight.expected,
    `${truthCase.sku}.compiled_preflight.expected`,
  );
  if ((truthCase.listing_kind === "single" && expected.outer_units !== 1)
    || (truthCase.listing_kind === "multipack" && expected.outer_units <= 1)) {
    throw new Error(`${truthCase.sku}: listing kind contradicts approved outer_units`);
  }
  const ratePpm = returnRatePpm(selectionRow);
  const priorVisualBad = selectionRow.prior_visual.verdict === "BAD";
  const elevatedReturnRisk = selectionRow.performance.units_sold >= RETURN_RISK_MIN_UNITS
    && ratePpm >= RETURN_RISK_RATE_PPM;
  const remediationApplied = selectionRow.remediation.status === "VERIFIED_APPLIED";
  const riskTuple: ShadowRiskTuple = [
    priorVisualBad ? 1 : 0,
    elevatedReturnRisk ? 1 : 0,
    ratePpm,
    selectionRow.performance.return_risk_units,
    selectionRow.performance.units_sold,
  ];
  const primaryStratum: ShadowPrimaryStratum = priorVisualBad || elevatedReturnRisk
    ? "known_bad_or_return_risk"
    : remediationApplied
      ? "remediated"
      : truthCase.listing_kind === "multipack"
        ? "multipack"
        : "single_unit_control";
  return {
    truthCase,
    selectionRow,
    expected,
    salesTier,
    listingKind: truthCase.listing_kind,
    primaryStratum,
    riskTuple,
    priorVisualBad,
    elevatedReturnRisk,
    remediationApplied,
    returnRatePpm: ratePpm,
  };
}

function emptyDistribution(): WalmartShadow50Manifest["distribution"] {
  return {
    strata: {
      known_bad_or_return_risk: 0,
      remediated: 0,
      multipack: 0,
      single_unit_control: 0,
    },
    sales_tiers: { high: 0, medium: 0, low: 0 },
    categories: Object.create(null) as Record<string, number>,
    listing_kinds: { single: 0, multipack: 0 },
  };
}

function selectionPolicy(): WalmartShadow50Manifest["selection_policy"] {
  return cloneCanonical(SHADOW_50_SELECTION_POLICY_CANON);
}

function acceptanceGates(): WalmartShadow50Manifest["acceptance_gates"] {
  return cloneCanonical(SHADOW_50_ACCEPTANCE_GATES_CANON);
}

/**
 * Select exactly 50 cases with no quota borrowing. The catalog export is
 * deterministically recompiled from the exact Product Truth and buyer-index
 * sources before it is accepted. Selection evidence is likewise recompiled
 * from four exact, frozen derived source populations before any tier or risk
 * is derived. Their upstream bindings are preserved, but this API does not
 * receive the raw ITEM/Orders/Returns/evidence-ledger inputs; the manifest is
 * therefore explicitly upstream-provenance NO-GO. Shadow execution readiness
 * also remains false for independent PDP, human-label, and runner gates.
 */
export function buildWalmartShadow50(
  catalogTruthInput: unknown,
  productTruthSnapshotInput: unknown,
  buyerSnapshotIndexInput: unknown,
  selectionEvidenceInput: unknown,
  publishedCatalogSourceInput: unknown,
  performanceSourceInput: unknown,
  priorVisualSourceInput: unknown,
  remediationSourceInput: unknown,
): WalmartShadow50Manifest {
  if (arguments.length > 8) {
    throw new Error(
      `custom shadow seed is unsupported; the precommitted seed is ${WALMART_SHADOW_50_SEED}`,
    );
  }
  assertWalmartShadowJsonInputs([
    ["catalog truth input", catalogTruthInput],
    ["product truth snapshot input", productTruthSnapshotInput],
    ["buyer snapshot index input", buyerSnapshotIndexInput],
    ["selection evidence input", selectionEvidenceInput],
    ["published catalog source input", publishedCatalogSourceInput],
    ["performance source input", performanceSourceInput],
    ["prior visual source input", priorVisualSourceInput],
    ["remediation source input", remediationSourceInput],
  ]);
  const seed = WALMART_SHADOW_50_SEED;
  const catalogTruth = verifyWalmartCatalogTruthAuditExportAgainstSources(
    catalogTruthInput,
    productTruthSnapshotInput,
    buyerSnapshotIndexInput,
  );
  const selectionEvidence = verifyWalmartShadowSelectionEvidenceAgainstSources(
    selectionEvidenceInput,
    publishedCatalogSourceInput,
    performanceSourceInput,
    priorVisualSourceInput,
    remediationSourceInput,
  );
  const tierByIdentity = deriveSalesTiers(selectionEvidence.rows);
  const selectionByListingKey = new Map(
    selectionEvidence.rows.map((row) => [row.listing_key, row]),
  );
  const candidates: DerivedCandidate[] = [];
  for (const truthCase of catalogTruth.cases) {
    const truthListingIdentity = parseListingIdentity(
      truthCase as unknown as Record<string, unknown>,
      `${truthCase.sku}.product_truth_listing_identity`,
    );
    const selectionRow = selectionByListingKey.get(truthListingIdentity.listing_key);
    if (!selectionRow) {
      if (truthCase.disposition === "auditable") {
        throw new Error(
          `${truthListingIdentity.listing_key}: AUDITABLE truth case is absent from complete selection evidence`,
        );
      }
      continue;
    }
    const tier = tierByIdentity.get(truthListingIdentity.listing_key);
    if (!tier) throw new Error(`${truthListingIdentity.listing_key}: sales tier derivation failed`);
    const candidate = deriveCandidate(truthCase, selectionRow, tier);
    if (candidate) candidates.push(candidate);
  }

  const cases: WalmartShadow50Case[] = [];
  const selectedBuyerItemIds = new Set<string>();
  for (const stratum of STRATUM_PRIORITY) {
    let stratumRank = 0;
    for (const salesTier of SALES_TIERS) {
      const quota = SHADOW_50_QUOTAS_CANON[stratum][salesTier];
      const cell = candidates
        .filter((candidate) => candidate.primaryStratum === stratum && candidate.salesTier === salesTier)
        .sort((left, right) => (
          compareRiskTuples(left.riskTuple, right.riskTuple)
          || compareCodeUnits(
            hash(`${seed}|${left.selectionRow.listing_key}|${left.truthCase.item_id}`),
            hash(`${seed}|${right.selectionRow.listing_key}|${right.truthCase.item_id}`),
          )
        ));
      const uniqueBuyerItemCandidates: DerivedCandidate[] = [];
      const cellBuyerItemIds = new Set<string>();
      for (const candidate of cell) {
        const itemId = candidate.truthCase.item_id;
        if (selectedBuyerItemIds.has(itemId) || cellBuyerItemIds.has(itemId)) continue;
        cellBuyerItemIds.add(itemId);
        uniqueBuyerItemCandidates.push(candidate);
      }
      if (uniqueBuyerItemCandidates.length < quota) {
        throw new Error(
          `${stratum}/${salesTier}: need ${quota} unique-buyer-item AUDITABLE candidates,`
          + ` found ${uniqueBuyerItemCandidates.length}`,
        );
      }
      for (const candidate of uniqueBuyerItemCandidates.slice(0, quota)) {
        stratumRank += 1;
        const truthCase = candidate.truthCase;
        selectedBuyerItemIds.add(truthCase.item_id);
        const preflight = truthCase.preflight!;
        const buyer = truthCase.buyer_snapshot!;
        cases.push({
          case_id: `shadow-${String(cases.length + 1).padStart(2, "0")}-${hash(`${seed}|${candidate.selectionRow.listing_key}|${truthCase.item_id}`).slice(0, 10)}`,
          source_truth_case_id: truthCase.case_id,
          channel: candidate.selectionRow.channel,
          store_index: candidate.selectionRow.store_index,
          sku: truthCase.sku,
          listing_key: candidate.selectionRow.listing_key,
          item_id: truthCase.item_id,
          published_status: "PUBLISHED",
          lifecycle_status: "ACTIVE",
          category: truthCase.category,
          sales_tier: candidate.salesTier,
          listing_kind: candidate.listingKind,
          primary_stratum: candidate.primaryStratum,
          stratum_rank: stratumRank,
          risk: {
            prior_visual_bad: candidate.priorVisualBad,
            elevated_return_risk: candidate.elevatedReturnRisk,
            remediation_applied: candidate.remediationApplied,
            units_returned: candidate.selectionRow.performance.units_returned,
            units_refunded: candidate.selectionRow.performance.units_refunded,
            units_replaced: candidate.selectionRow.performance.units_replaced,
            return_risk_units: candidate.selectionRow.performance.return_risk_units,
            return_rate_ppm: candidate.returnRatePpm,
            risk_tuple: candidate.riskTuple,
          },
          expected: candidate.expected,
          bindings: {
            source_truth_case_canonical_sha256: canonicalSha256(truthCase),
            selection_row_canonical_sha256: canonicalSha256(candidate.selectionRow),
            preflight_input_sha256: preflight.input_sha256,
            preflight_result_canonical_sha256: truthCase.preflight_sha256!,
            evidence_payload_sha256s: [...new Set(preflight.evidence_bindings.map((binding) => binding.payload_sha256!))].sort(),
            truth_revision_id: truthCase.truth_revision.revision_id,
            truth_revision_body_sha256: truthCase.truth_revision.body_sha256,
            truth_approval_sha256: truthCase.truth_revision.approval_sha256!,
            buyer_snapshot_id: buyer.snapshot_id,
            buyer_snapshot_body_sha256: buyer.body_sha256,
            buyer_main_asset_sha256: buyer.main_asset_sha256,
          },
        });
      }
    }
  }
  if (cases.length !== 50) throw new Error(`shadow selection invariant failed: ${cases.length} != 50`);
  assertManifestCaseSemantics(cases, seed);

  const distribution = emptyDistribution();
  for (const item of cases) {
    distribution.strata[item.primary_stratum] += 1;
    distribution.sales_tiers[item.sales_tier] += 1;
    distribution.categories[item.category] = (distribution.categories[item.category] ?? 0) + 1;
    distribution.listing_kinds[item.listing_kind] += 1;
  }
  const sourceBindings: WalmartShadow50Manifest["source_bindings"] = {
    catalog_truth_export: {
      schema_version: WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA,
      export_id: catalogTruth.export_id,
      body_sha256: catalogTruth.body_sha256,
      source_recompile_verified: true,
      product_truth_snapshot_id: catalogTruth.product_truth_snapshot.snapshot_id,
      product_truth_snapshot_body_sha256: catalogTruth.product_truth_snapshot.body_sha256,
      buyer_index_id: catalogTruth.buyer_index.index_id,
      buyer_index_body_sha256: catalogTruth.buyer_index.body_sha256,
    },
    selection_evidence: {
      schema_version: WALMART_SHADOW_SELECTION_EVIDENCE_SCHEMA,
      snapshot_id: selectionEvidence.snapshot_id,
      body_sha256: selectionEvidence.body_sha256,
      source_recompile_verified: true,
      upstream_provenance_verified: false,
      source_artifacts: selectionEvidence.source_artifacts,
    },
  };
  const policy = selectionPolicy();
  const gates = acceptanceGates();
  const selectionMaterial = {
    seed,
    source_bindings: sourceBindings,
    selection_policy: policy,
    cases,
    distribution,
    acceptance_gates: gates,
  };
  const selectionSha = canonicalSha256(selectionMaterial);
  const manifestBody = {
    schema_version: WALMART_SHADOW_50_SCHEMA,
    manifest_id: `walmart-shadow-50-${selectionSha.slice(0, 16)}`,
    selection_sha256: selectionSha,
    ...selectionMaterial,
  };
  return {
    ...manifestBody,
    body_sha256: canonicalSha256(manifestBody),
  };
}

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function parseManifestSourceBindings(
  raw: unknown,
): WalmartShadow50Manifest["source_bindings"] {
  const path = "shadow manifest.source_bindings";
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, ["catalog_truth_export", "selection_evidence"], path);

  const catalogPath = `${path}.catalog_truth_export`;
  if (!isRecord(raw.catalog_truth_export)) throw new Error(`${catalogPath} must be an object`);
  const catalog = raw.catalog_truth_export;
  assertExactKeys(catalog, [
    "schema_version", "export_id", "body_sha256", "source_recompile_verified",
    "product_truth_snapshot_id", "product_truth_snapshot_body_sha256",
    "buyer_index_id", "buyer_index_body_sha256",
  ], catalogPath);
  if (catalog.schema_version !== WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA) {
    throw new Error(`${catalogPath}.schema_version is unsupported`);
  }
  if (catalog.source_recompile_verified !== true) {
    throw new Error(`${catalogPath}.source_recompile_verified must be true`);
  }
  const catalogBodySha = requiredSha(catalog.body_sha256, `${catalogPath}.body_sha256`);
  const exportId = requiredString(catalog.export_id, `${catalogPath}.export_id`);
  if (exportId !== `walmart-truth-audit-${catalogBodySha.slice(0, 16)}`) {
    throw new Error(`${catalogPath}.export_id is not derived from body_sha256`);
  }
  const truthBodySha = requiredSha(
    catalog.product_truth_snapshot_body_sha256,
    `${catalogPath}.product_truth_snapshot_body_sha256`,
  );
  const truthSnapshotId = requiredString(
    catalog.product_truth_snapshot_id,
    `${catalogPath}.product_truth_snapshot_id`,
  );
  if (truthSnapshotId !== `product-truth-${truthBodySha.slice(0, 16)}`) {
    throw new Error(`${catalogPath}.product_truth_snapshot_id is not content-addressed`);
  }
  const buyerBodySha = requiredSha(
    catalog.buyer_index_body_sha256,
    `${catalogPath}.buyer_index_body_sha256`,
  );
  const buyerIndexId = requiredString(catalog.buyer_index_id, `${catalogPath}.buyer_index_id`);
  if (buyerIndexId !== `walmart-buyer-index-${buyerBodySha.slice(0, 16)}`) {
    throw new Error(`${catalogPath}.buyer_index_id is not content-addressed`);
  }

  const selectionPath = `${path}.selection_evidence`;
  if (!isRecord(raw.selection_evidence)) throw new Error(`${selectionPath} must be an object`);
  const selection = raw.selection_evidence;
  assertExactKeys(selection, [
    "schema_version", "snapshot_id", "body_sha256", "source_recompile_verified",
    "upstream_provenance_verified", "source_artifacts",
  ], selectionPath);
  if (selection.schema_version !== WALMART_SHADOW_SELECTION_EVIDENCE_SCHEMA) {
    throw new Error(`${selectionPath}.schema_version is unsupported`);
  }
  if (selection.source_recompile_verified !== true) {
    throw new Error(`${selectionPath}.source_recompile_verified must be true`);
  }
  if (selection.upstream_provenance_verified !== false) {
    throw new Error(`${selectionPath}.upstream_provenance_verified must remain false until all raw-source verifiers pass`);
  }
  const selectionSnapshotId = requiredString(selection.snapshot_id, `${selectionPath}.snapshot_id`);
  if (!/^walmart-shadow-selection-[a-f0-9]{16}$/.test(selectionSnapshotId)) {
    throw new Error(`${selectionPath}.snapshot_id is not a content-addressed selection ID`);
  }
  const selectionBodySha = requiredSha(selection.body_sha256, `${selectionPath}.body_sha256`);
  if (!isRecord(selection.source_artifacts)) {
    throw new Error(`${selectionPath}.source_artifacts must be an object`);
  }
  assertExactKeys(selection.source_artifacts, [
    "published_catalog", "performance", "prior_visual", "remediation",
  ], `${selectionPath}.source_artifacts`);
  const sourceArtifacts = {
    published_catalog: parseSourceArtifact(
      selection.source_artifacts.published_catalog,
      `${selectionPath}.source_artifacts.published_catalog`,
    ),
    performance: parseSourceArtifact(
      selection.source_artifacts.performance,
      `${selectionPath}.source_artifacts.performance`,
    ),
    prior_visual: parseSourceArtifact(
      selection.source_artifacts.prior_visual,
      `${selectionPath}.source_artifacts.prior_visual`,
    ),
    remediation: parseSourceArtifact(
      selection.source_artifacts.remediation,
      `${selectionPath}.source_artifacts.remediation`,
    ),
  };
  const sourcePrefixes = {
    published_catalog: "walmart-shadow-catalog",
    performance: "walmart-shadow-performance",
    prior_visual: "walmart-shadow-prior-visual",
    remediation: "walmart-shadow-remediation",
  } as const;
  for (const name of Object.keys(sourcePrefixes) as Array<keyof typeof sourcePrefixes>) {
    const artifact = sourceArtifacts[name];
    const expectedId = `${sourcePrefixes[name]}-${artifact.body_sha256.slice(0, 16)}`;
    if (artifact.artifact_id !== expectedId) {
      throw new Error(`${selectionPath}.source_artifacts.${name}.artifact_id is not content-addressed`);
    }
  }

  return {
    catalog_truth_export: {
      schema_version: WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA,
      export_id: exportId,
      body_sha256: catalogBodySha,
      source_recompile_verified: true,
      product_truth_snapshot_id: truthSnapshotId,
      product_truth_snapshot_body_sha256: truthBodySha,
      buyer_index_id: buyerIndexId,
      buyer_index_body_sha256: buyerBodySha,
    },
    selection_evidence: {
      schema_version: WALMART_SHADOW_SELECTION_EVIDENCE_SCHEMA,
      snapshot_id: selectionSnapshotId,
      body_sha256: selectionBodySha,
      source_recompile_verified: true,
      upstream_provenance_verified: false,
      source_artifacts: sourceArtifacts,
    },
  };
}

function parseManifestCaseBindings(
  raw: unknown,
  path: string,
): WalmartShadow50Case["bindings"] {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "source_truth_case_canonical_sha256", "selection_row_canonical_sha256",
    "preflight_input_sha256", "preflight_result_canonical_sha256",
    "evidence_payload_sha256s", "truth_revision_id", "truth_revision_body_sha256",
    "truth_approval_sha256", "buyer_snapshot_id", "buyer_snapshot_body_sha256",
    "buyer_main_asset_sha256",
  ], path);
  if (!Array.isArray(raw.evidence_payload_sha256s)
    || raw.evidence_payload_sha256s.length === 0
    || raw.evidence_payload_sha256s.length > 64) {
    throw new Error(`${path}.evidence_payload_sha256s must contain 1-64 hashes`);
  }
  const evidencePayloads = raw.evidence_payload_sha256s.map((value, index) => (
    requiredSha(value, `${path}.evidence_payload_sha256s[${index}]`)
  ));
  const canonicalEvidencePayloads = [...new Set(evidencePayloads)].sort();
  if (canonicalJson(evidencePayloads) !== canonicalJson(canonicalEvidencePayloads)) {
    throw new Error(`${path}.evidence_payload_sha256s must be unique and sorted`);
  }
  const buyerBodySha = requiredSha(
    raw.buyer_snapshot_body_sha256,
    `${path}.buyer_snapshot_body_sha256`,
  );
  const buyerSnapshotId = requiredString(raw.buyer_snapshot_id, `${path}.buyer_snapshot_id`);
  if (!/^walmart-buyer-\d{8}T\d{6}Z-[a-f0-9]{12}$/.test(buyerSnapshotId)
    || !buyerSnapshotId.endsWith(`-${buyerBodySha.slice(0, 12)}`)) {
    throw new Error(`${path}.buyer_snapshot_id is not derived from buyer_snapshot_body_sha256`);
  }
  return {
    source_truth_case_canonical_sha256: requiredSha(
      raw.source_truth_case_canonical_sha256,
      `${path}.source_truth_case_canonical_sha256`,
    ),
    selection_row_canonical_sha256: requiredSha(
      raw.selection_row_canonical_sha256,
      `${path}.selection_row_canonical_sha256`,
    ),
    preflight_input_sha256: requiredSha(raw.preflight_input_sha256, `${path}.preflight_input_sha256`),
    preflight_result_canonical_sha256: requiredSha(
      raw.preflight_result_canonical_sha256,
      `${path}.preflight_result_canonical_sha256`,
    ),
    evidence_payload_sha256s: evidencePayloads,
    truth_revision_id: requiredString(raw.truth_revision_id, `${path}.truth_revision_id`),
    truth_revision_body_sha256: requiredSha(
      raw.truth_revision_body_sha256,
      `${path}.truth_revision_body_sha256`,
    ),
    truth_approval_sha256: requiredSha(raw.truth_approval_sha256, `${path}.truth_approval_sha256`),
    buyer_snapshot_id: buyerSnapshotId,
    buyer_snapshot_body_sha256: buyerBodySha,
    buyer_main_asset_sha256: requiredSha(
      raw.buyer_main_asset_sha256,
      `${path}.buyer_main_asset_sha256`,
    ),
  };
}

function parseManifestCase(
  raw: unknown,
  index: number,
  seed: string,
): WalmartShadow50Case {
  const path = `shadow manifest.cases[${index}]`;
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "case_id", "source_truth_case_id", "channel", "store_index", "sku", "listing_key",
    "item_id", "published_status", "lifecycle_status",
    "category", "sales_tier", "listing_kind", "primary_stratum", "stratum_rank",
    "risk", "expected", "bindings",
  ], path);
  const listingIdentity = parseListingIdentity(raw, path);
  const sku = listingIdentity.sku;
  const itemId = requiredString(raw.item_id, `${path}.item_id`);
  if (!/^\d+$/.test(itemId)) throw new Error(`${path}.item_id must contain digits only`);
  if (raw.published_status !== "PUBLISHED") {
    throw new Error(`${path}.published_status must be PUBLISHED`);
  }
  if (raw.lifecycle_status !== "ACTIVE") {
    throw new Error(`${path}.lifecycle_status must be ACTIVE`);
  }
  const category = requiredString(raw.category, `${path}.category`);
  if (raw.sales_tier !== "high" && raw.sales_tier !== "medium" && raw.sales_tier !== "low") {
    throw new Error(`${path}.sales_tier is unsupported`);
  }
  const salesTier: ShadowSalesTier = raw.sales_tier;
  if (raw.listing_kind !== "single" && raw.listing_kind !== "multipack") {
    throw new Error(`${path}.listing_kind is unsupported`);
  }
  const listingKind: ShadowListingKind = raw.listing_kind;
  if (!STRATUM_PRIORITY.includes(raw.primary_stratum as ShadowPrimaryStratum)) {
    throw new Error(`${path}.primary_stratum is unsupported`);
  }
  const primaryStratum = raw.primary_stratum as ShadowPrimaryStratum;
  const stratumRank = requiredSafeInteger(raw.stratum_rank, `${path}.stratum_rank`, 1);

  if (!isRecord(raw.risk)) throw new Error(`${path}.risk must be an object`);
  assertExactKeys(raw.risk, [
    "prior_visual_bad", "elevated_return_risk", "remediation_applied",
    "units_returned", "units_refunded", "units_replaced", "return_risk_units",
    "return_rate_ppm", "risk_tuple",
  ], `${path}.risk`);
  const priorVisualBad = requiredBoolean(raw.risk.prior_visual_bad, `${path}.risk.prior_visual_bad`);
  const elevatedReturnRisk = requiredBoolean(
    raw.risk.elevated_return_risk,
    `${path}.risk.elevated_return_risk`,
  );
  const remediationApplied = requiredBoolean(
    raw.risk.remediation_applied,
    `${path}.risk.remediation_applied`,
  );
  const unitsReturned = requiredSafeInteger(raw.risk.units_returned, `${path}.risk.units_returned`);
  const unitsRefunded = requiredSafeInteger(raw.risk.units_refunded, `${path}.risk.units_refunded`);
  const unitsReplaced = requiredSafeInteger(raw.risk.units_replaced, `${path}.risk.units_replaced`);
  const returnRiskUnits = safeIntegerSum(
    [unitsReturned, unitsRefunded, unitsReplaced],
    `${path}.risk return-risk unit sum`,
  );
  if (requiredSafeInteger(raw.risk.return_risk_units, `${path}.risk.return_risk_units`)
    !== returnRiskUnits) {
    throw new Error(`${path}.risk.return_risk_units is not the exact outcome bucket sum`);
  }
  const returnRate = requiredSafeInteger(raw.risk.return_rate_ppm, `${path}.risk.return_rate_ppm`);
  if (!Array.isArray(raw.risk.risk_tuple) || raw.risk.risk_tuple.length !== 5) {
    throw new Error(`${path}.risk.risk_tuple must contain exactly 5 integers`);
  }
  const tupleValues = raw.risk.risk_tuple.map((value, tupleIndex) => (
    requiredSafeInteger(value, `${path}.risk.risk_tuple[${tupleIndex}]`)
  ));
  if ((tupleValues[0] !== 0 && tupleValues[0] !== 1)
    || (tupleValues[1] !== 0 && tupleValues[1] !== 1)) {
    throw new Error(`${path}.risk.risk_tuple flags must be 0 or 1`);
  }
  const riskTuple: ShadowRiskTuple = [
    tupleValues[0] as 0 | 1,
    tupleValues[1] as 0 | 1,
    tupleValues[2],
    tupleValues[3],
    tupleValues[4],
  ];
  if (riskTuple[0] !== (priorVisualBad ? 1 : 0)
    || riskTuple[1] !== (elevatedReturnRisk ? 1 : 0)
    || riskTuple[2] !== returnRate) {
    throw new Error(`${path}.risk flags/rate contradict risk_tuple`);
  }
  if (riskTuple[3] !== returnRiskUnits) {
    throw new Error(`${path}.risk.risk_tuple return-risk units differ from outcome buckets`);
  }
  const unitsSold = riskTuple[4];
  if (returnRiskUnits > unitsSold) {
    throw new Error(`${path}.risk.risk_tuple return-risk units cannot exceed units_sold`);
  }
  const derivedReturnRate = returnRatePpmFromCounts(
    returnRiskUnits,
    unitsSold,
    `${path}.risk`,
  );
  if (returnRate !== derivedReturnRate) {
    throw new Error(`${path}.risk.return_rate_ppm is not derived from tuple metrics`);
  }
  const derivedElevatedRisk = unitsSold >= RETURN_RISK_MIN_UNITS
    && returnRate >= RETURN_RISK_RATE_PPM;
  if (elevatedReturnRisk !== derivedElevatedRisk) {
    throw new Error(`${path}.risk.elevated_return_risk contradicts the fixed policy`);
  }
  const derivedStratum: ShadowPrimaryStratum = priorVisualBad || elevatedReturnRisk
    ? "known_bad_or_return_risk"
    : remediationApplied
      ? "remediated"
      : listingKind === "multipack"
        ? "multipack"
        : "single_unit_control";
  if (primaryStratum !== derivedStratum) {
    throw new Error(`${path}.primary_stratum contradicts risk and listing kind`);
  }

  const expected = validateExpectedTruth(raw.expected, `${path}.expected`);
  if ((listingKind === "single" && expected.outer_units !== 1)
    || (listingKind === "multipack" && expected.outer_units <= 1)) {
    throw new Error(`${path}.listing_kind contradicts expected.outer_units`);
  }
  const bindings = parseManifestCaseBindings(raw.bindings, `${path}.bindings`);
  const sourceTruthCaseId = requiredString(raw.source_truth_case_id, `${path}.source_truth_case_id`);
  if (!/^walmart-truth-case-[a-f0-9]{20}$/.test(sourceTruthCaseId)) {
    throw new Error(`${path}.source_truth_case_id is not a content-addressed truth case ID`);
  }
  const expectedCaseId = `shadow-${String(index + 1).padStart(2, "0")}-${hash(`${seed}|${listingIdentity.listing_key}|${itemId}`).slice(0, 10)}`;
  const caseId = requiredString(raw.case_id, `${path}.case_id`);
  if (caseId !== expectedCaseId) throw new Error(`${path}.case_id is not derived from seed and identity`);

  return {
    case_id: caseId,
    source_truth_case_id: sourceTruthCaseId,
    channel: listingIdentity.channel,
    store_index: listingIdentity.store_index,
    sku,
    listing_key: listingIdentity.listing_key,
    item_id: itemId,
    published_status: "PUBLISHED",
    lifecycle_status: "ACTIVE",
    category,
    sales_tier: salesTier,
    listing_kind: listingKind,
    primary_stratum: primaryStratum,
    stratum_rank: stratumRank,
    risk: {
      prior_visual_bad: priorVisualBad,
      elevated_return_risk: elevatedReturnRisk,
      remediation_applied: remediationApplied,
      units_returned: unitsReturned,
      units_refunded: unitsRefunded,
      units_replaced: unitsReplaced,
      return_risk_units: returnRiskUnits,
      return_rate_ppm: returnRate,
      risk_tuple: riskTuple,
    },
    expected,
    bindings,
  };
}

function assertManifestCaseSemantics(
  cases: readonly WalmartShadow50Case[],
  seed: string,
): void {
  if (cases.length !== 50) throw new Error("shadow manifest must contain exactly 50 cases");
  const caseIds = new Set<string>();
  const truthCaseIds = new Set<string>();
  const listingKeys = new Set<string>();
  const itemIds = new Set<string>();
  for (const item of cases) {
    if (caseIds.has(item.case_id)) throw new Error(`shadow manifest has duplicate case_id ${item.case_id}`);
    if (truthCaseIds.has(item.source_truth_case_id)) {
      throw new Error(`shadow manifest has duplicate source_truth_case_id ${item.source_truth_case_id}`);
    }
    if (listingKeys.has(item.listing_key)) {
      throw new Error(`shadow manifest has duplicate listing_key ${item.listing_key}`);
    }
    if (itemIds.has(item.item_id)) throw new Error(`shadow manifest has duplicate item_id ${item.item_id}`);
    caseIds.add(item.case_id);
    truthCaseIds.add(item.source_truth_case_id);
    listingKeys.add(item.listing_key);
    itemIds.add(item.item_id);
  }

  let caseIndex = 0;
  for (const stratum of STRATUM_PRIORITY) {
    let expectedRank = 0;
    for (const tier of SALES_TIERS) {
      const quota = SHADOW_50_QUOTAS_CANON[stratum][tier];
      const cell: WalmartShadow50Case[] = [];
      for (let offset = 0; offset < quota; offset += 1) {
        const item = cases[caseIndex];
        if (!item || item.primary_stratum !== stratum || item.sales_tier !== tier) {
          throw new Error(`shadow manifest cases do not satisfy exact ${stratum}/${tier} quota order`);
        }
        expectedRank += 1;
        if (item.stratum_rank !== expectedRank) {
          throw new Error(`${item.case_id}.stratum_rank must be ${expectedRank}`);
        }
        cell.push(item);
        caseIndex += 1;
      }
      for (let index = 1; index < cell.length; index += 1) {
        const previous = cell[index - 1];
        const current = cell[index];
        const riskOrder = compareRiskTuples(previous.risk.risk_tuple, current.risk.risk_tuple);
        const previousSeeded = hash(`${seed}|${previous.listing_key}|${previous.item_id}`);
        const currentSeeded = hash(`${seed}|${current.listing_key}|${current.item_id}`);
        if (riskOrder > 0 || (riskOrder === 0 && compareCodeUnits(previousSeeded, currentSeeded) > 0)) {
          throw new Error(`shadow manifest ${stratum}/${tier} cell is not in canonical selection order`);
        }
      }
    }
  }
  if (caseIndex !== cases.length) throw new Error("shadow manifest has cases outside fixed quotas");
}

function parseManifestDistribution(
  raw: unknown,
  cases: readonly WalmartShadow50Case[],
): WalmartShadow50Manifest["distribution"] {
  const path = "shadow manifest.distribution";
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, ["strata", "sales_tiers", "categories", "listing_kinds"], path);
  const exactCountRecord = (
    value: unknown,
    keys: readonly string[],
    recordPath: string,
  ): Record<string, number> => {
    if (!isRecord(value)) throw new Error(`${recordPath} must be an object`);
    assertExactKeys(value, keys, recordPath);
    return Object.fromEntries(keys.map((key) => [
      key,
      requiredSafeInteger(value[key], `${recordPath}.${key}`),
    ]));
  };
  const strata = exactCountRecord(raw.strata, STRATUM_PRIORITY, `${path}.strata`);
  const salesTiers = exactCountRecord(raw.sales_tiers, SALES_TIERS, `${path}.sales_tiers`);
  const listingKinds = exactCountRecord(raw.listing_kinds, ["single", "multipack"], `${path}.listing_kinds`);
  if (!isRecord(raw.categories)) throw new Error(`${path}.categories must be an object`);
  const categories = Object.create(null) as Record<string, number>;
  for (const [category, count] of Object.entries(raw.categories)) {
    if (!category.trim() || category !== category.trim()) {
      throw new Error(`${path}.categories has an invalid category key`);
    }
    categories[category] = requiredSafeInteger(count, `${path}.categories.${category}`, 1);
  }
  const parsed = {
    strata: strata as Record<ShadowPrimaryStratum, number>,
    sales_tiers: salesTiers as Record<ShadowSalesTier, number>,
    categories,
    listing_kinds: listingKinds as Record<ShadowListingKind, number>,
  };
  const recomputed = emptyDistribution();
  for (const item of cases) {
    recomputed.strata[item.primary_stratum] += 1;
    recomputed.sales_tiers[item.sales_tier] += 1;
    recomputed.categories[item.category] = (recomputed.categories[item.category] ?? 0) + 1;
    recomputed.listing_kinds[item.listing_kind] += 1;
  }
  if (canonicalJson(parsed) !== canonicalJson(recomputed)) {
    throw new Error("shadow manifest.distribution does not exactly match cases");
  }
  return parsed;
}

function parseWalmartShadow50Manifest(raw: unknown): WalmartShadow50Manifest {
  const path = "shadow manifest";
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "schema_version", "manifest_id", "selection_sha256", "body_sha256", "seed",
    "source_bindings", "selection_policy", "cases", "distribution", "acceptance_gates",
  ], path);
  if (raw.schema_version !== WALMART_SHADOW_50_SCHEMA) {
    throw new Error(`${path}.schema_version must be ${WALMART_SHADOW_50_SCHEMA}`);
  }
  const seed = requiredString(raw.seed, `${path}.seed`);
  if (seed !== WALMART_SHADOW_50_SEED) {
    throw new Error(`${path}.seed must be the precommitted ${WALMART_SHADOW_50_SEED}`);
  }
  const sourceBindings = parseManifestSourceBindings(raw.source_bindings);
  const expectedPolicy = selectionPolicy();
  if (canonicalJson(raw.selection_policy) !== canonicalJson(expectedPolicy)) {
    throw new Error(`${path}.selection_policy does not exactly match the fixed policy`);
  }
  const expectedGates = acceptanceGates();
  if (canonicalJson(raw.acceptance_gates) !== canonicalJson(expectedGates)) {
    throw new Error(`${path}.acceptance_gates does not exactly match the fail-closed safety contract`);
  }
  if (!Array.isArray(raw.cases)) throw new Error(`${path}.cases must be an array`);
  const cases = raw.cases.map((item, index) => parseManifestCase(item, index, seed));
  assertManifestCaseSemantics(cases, seed);
  const distribution = parseManifestDistribution(raw.distribution, cases);

  const bodySha = requiredSha(raw.body_sha256, `${path}.body_sha256`);
  const body = { ...raw };
  delete body.body_sha256;
  if (canonicalSha256(body) !== bodySha) {
    throw new Error(`${path}.body_sha256 does not match the canonical manifest body`);
  }
  const selectionSha = requiredSha(raw.selection_sha256, `${path}.selection_sha256`);
  const selectionMaterial = {
    seed,
    source_bindings: sourceBindings,
    selection_policy: expectedPolicy,
    cases,
    distribution,
    acceptance_gates: expectedGates,
  };
  if (canonicalSha256(selectionMaterial) !== selectionSha) {
    throw new Error(`${path}.selection_sha256 does not match canonical selection semantics`);
  }
  const manifestId = requiredString(raw.manifest_id, `${path}.manifest_id`);
  if (manifestId !== `walmart-shadow-50-${selectionSha.slice(0, 16)}`) {
    throw new Error(`${path}.manifest_id is not derived from selection_sha256`);
  }
  return {
    schema_version: WALMART_SHADOW_50_SCHEMA,
    manifest_id: manifestId,
    selection_sha256: selectionSha,
    body_sha256: bodySha,
    seed,
    source_bindings: sourceBindings,
    selection_policy: expectedPolicy,
    cases,
    distribution,
    acceptance_gates: expectedGates,
  };
}

/**
 * Strictly verify the complete self-contained manifest contract: schema,
 * fixed policy and NO-GO safety gates, 50-case quotas/order, derived case
 * semantics, distributions, content-addressed bindings, and both seals.
 * This proves internal integrity, not authenticity of external source facts.
 */
export function verifyWalmartShadow50Manifest(raw: unknown): raw is WalmartShadow50Manifest {
  try {
    assertWalmartShadowJsonBudget(raw, "Shadow-50 manifest verification input");
    parseWalmartShadow50Manifest(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derived-source replay verifier. It recompiles the catalog export and
 * selection evidence from Product Truth, the exact buyer index, and all four
 * frozen derived selection sources, rebuilds Shadow-50, then requires
 * byte-level canonical equality. It deliberately leaves
 * upstream_provenance_verified=false until the separate raw ITEM,
 * Orders/Returns, prior-label-ledger, and remediation-ledger verifiers pass.
 */
export function verifyWalmartShadow50ManifestAgainstSources(
  rawManifest: unknown,
  productTruthSnapshotInput: unknown,
  buyerSnapshotIndexInput: unknown,
  publishedCatalogSourceInput: unknown,
  performanceSourceInput: unknown,
  priorVisualSourceInput: unknown,
  remediationSourceInput: unknown,
): WalmartShadow50Manifest {
  assertWalmartShadowJsonInputs([
    ["Shadow-50 manifest input", rawManifest],
    ["product truth snapshot input", productTruthSnapshotInput],
    ["buyer snapshot index input", buyerSnapshotIndexInput],
    ["published catalog source input", publishedCatalogSourceInput],
    ["performance source input", performanceSourceInput],
    ["prior visual source input", priorVisualSourceInput],
    ["remediation source input", remediationSourceInput],
  ]);
  const verified = parseWalmartShadow50Manifest(rawManifest);
  const catalogTruth = compileWalmartCatalogTruthExport(
    productTruthSnapshotInput,
    buyerSnapshotIndexInput,
  );
  const selectionEvidence = compileWalmartShadowSelectionEvidence(
    publishedCatalogSourceInput,
    performanceSourceInput,
    priorVisualSourceInput,
    remediationSourceInput,
  );
  const recompiled = buildWalmartShadow50(
    catalogTruth,
    productTruthSnapshotInput,
    buyerSnapshotIndexInput,
    selectionEvidence,
    publishedCatalogSourceInput,
    performanceSourceInput,
    priorVisualSourceInput,
    remediationSourceInput,
  );
  if (canonicalJson(verified) !== canonicalJson(recompiled)) {
    throw new Error(
      "shadow manifest does not exactly match deterministic compilation from Product Truth, buyer index, and four frozen selection sources",
    );
  }
  return verified;
}
