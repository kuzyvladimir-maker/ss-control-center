/** Deterministic, fail-closed selection for the buyer-facing shadow-50 pilot. */

import { createHash } from "node:crypto";

import type {
  AuditExpectedTruth,
  AuditIdentityTruth,
  ExpectedPackageFact,
  IdentityRole,
  SizeUnit,
} from "./catalog-visual-audit";

export const WALMART_SHADOW_50_SCHEMA = "walmart-visual-shadow-50/v1";
export const WALMART_SHADOW_TRUTH_SCHEMA = "walmart-visual-audit/v3" as const;

export type ShadowSalesTier = "high" | "medium" | "low";
export type ShadowListingKind = "single" | "multipack" | "bundle" | "variety";
export type ShadowPrimaryStratum =
  | "known_bad_or_return_risk"
  | "remediated"
  | "multipack"
  | "single_unit_control";

export interface WalmartShadowCandidate {
  sku: string;
  item_id: string;
  published_status: "PUBLISHED";
  lifecycle_status?: string | null;
  category: string;
  sales_tier: ShadowSalesTier;
  listing_kind: ShadowListingKind;
  risk_score: number;
  prior_visual_bad: boolean;
  elevated_return_risk: boolean;
  remediation_applied: boolean;
  /** Exact comparator-compatible v3 truth; legacy marker_groups are forbidden. */
  expected: AuditExpectedTruth;
}

type TierQuota = Record<ShadowSalesTier, number>;

export const SHADOW_50_QUOTAS: Record<ShadowPrimaryStratum, TierQuota> = {
  known_bad_or_return_risk: { high: 6, medium: 5, low: 4 },
  remediated: { high: 6, medium: 5, low: 4 },
  multipack: { high: 4, medium: 3, low: 3 },
  single_unit_control: { high: 4, medium: 3, low: 3 },
};

export const SHADOW_50_ACCEPTANCE_GATES = {
  scope_and_identity: {
    selected_cases_exactly: 50,
    exact_unique_sku_item_pairs: true,
    published_only: true,
    seller_exact_sku_match_rate: 1,
    seller_to_buyer_item_id_match_rate: 1,
    buyer_pdp_identity_evidence_rate: 1,
    positional_or_fuzzy_fallbacks: 0,
  },
  snapshot_integrity: {
    main_binary_capture_rate: 1,
    advertised_gallery_binary_capture_rate: 1,
    raster_magic_validation_rate: 1,
    binary_sha256_rate: 1,
    payload_sha256_rate: 1,
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
    stop_on_first_technical_failure: true,
    stop_on_first_false_pass_or_false_bad: true,
    explicit_subscription_call_budget: true,
    database_writes: 0,
    walmart_writes: 0,
    r2_writes: 0,
    paid_model_fallbacks: 0,
    remediation_actions: 0,
  },
} as const;

export interface WalmartShadow50Case extends WalmartShadowCandidate {
  case_id: string;
  primary_stratum: ShadowPrimaryStratum;
  stratum_rank: number;
}

export interface WalmartShadow50Manifest {
  schema_version: typeof WALMART_SHADOW_50_SCHEMA;
  manifest_id: string;
  seed: string;
  selection_policy: {
    exact_size: 50;
    fail_if_any_quota_is_unavailable: true;
    stratum_priority: ShadowPrimaryStratum[];
    quotas: typeof SHADOW_50_QUOTAS;
    within_cell_order: "risk_desc_then_seeded_hash";
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

const STRATUM_PRIORITY: ShadowPrimaryStratum[] = [
  "known_bad_or_return_risk",
  "remediated",
  "multipack",
  "single_unit_control",
];
const SALES_TIERS: ShadowSalesTier[] = ["high", "medium", "low"];

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (extra.length) throw new Error(`${label} has unsupported fields: ${extra.join(", ")}`);
}

const SIZE_UNITS = new Set<SizeUnit>([
  "oz", "fl_oz", "count", "lb", "g", "kg", "ml", "l",
]);

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value.trim();
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

function stringArray(value: unknown, path: string, max = 12): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`${path} must be an array with at most ${max} items`);
  }
  return value.map((item, index) => requiredString(item, `${path}[${index}]`).slice(0, 300));
}

function markerGroups(value: unknown, path: string, allowEmpty: boolean): string[][] {
  if (!Array.isArray(value) || value.length > 12 || (!allowEmpty && value.length === 0)) {
    throw new Error(`${path} must ${allowEmpty ? "be an array" : "not be empty"}`);
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
  const brandAliases = stringArray(value.brand_aliases, `${path}.brand_aliases`);
  if (!brandAliases.length) throw new Error(`${path}.brand_aliases must not be empty`);
  if (brandAliases.some((alias) => !normalizeMarker(alias).split(" ").some((token) => token.length >= 2))) {
    throw new Error(`${path}.brand_aliases must contain full lexical brand names, not logo-only glyphs`);
  }
  if (new Set(brandAliases.map(normalizeMarker)).size !== brandAliases.length) {
    throw new Error(`${path}.brand_aliases contains duplicate normalized aliases`);
  }
  const productGroups = markerGroups(value.product_marker_groups, `${path}.product_marker_groups`, false);
  const variantGroups = markerGroups(value.variant_marker_groups, `${path}.variant_marker_groups`, true);
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
    const aliases = stringArray(marker.aliases, `${markerPath}.aliases`);
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
  if (!Number.isInteger(value.outer_units) || Number(value.outer_units) < 1) {
    throw new Error(`${path}.outer_units must be an integer >= 1`);
  }
  const truthSource = value.truth_source;
  if (truthSource !== "recipe" && truthSource !== "live_title"
    && truthSource !== "historical_title" && truthSource !== "manual_verified") {
    throw new Error(`${path}.truth_source is unsupported`);
  }
  return {
    title: requiredString(value.title, `${path}.title`),
    outer_units: Number(value.outer_units),
    identity: validateIdentityTruth(value.identity, `${path}.identity`),
    package_facts: validatePackageFacts(value.package_facts, `${path}.package_facts`),
    truth_source: truthSource,
  };
}

function assertCandidate(candidate: WalmartShadowCandidate): WalmartShadowCandidate {
  if (!isRecord(candidate)) throw new Error("shadow candidate must be an object");
  assertExactKeys(candidate, [
    "sku", "item_id", "published_status", "lifecycle_status", "category",
    "sales_tier", "listing_kind", "risk_score", "prior_visual_bad",
    "elevated_return_risk", "remediation_applied", "expected",
  ], `shadow candidate ${String(candidate.sku ?? "(unknown)")}`);
  if (!candidate.sku || candidate.sku !== candidate.sku.trim()) {
    throw new Error("shadow candidate SKU must be non-empty and trimmed");
  }
  if (!/^\d+$/.test(candidate.item_id)) {
    throw new Error(`${candidate.sku}: item_id must contain digits only`);
  }
  if (candidate.published_status !== "PUBLISHED") {
    throw new Error(`${candidate.sku}: shadow candidates must be PUBLISHED`);
  }
  if (candidate.lifecycle_status !== undefined
    && candidate.lifecycle_status !== null
    && (typeof candidate.lifecycle_status !== "string" || !candidate.lifecycle_status.trim())) {
    throw new Error(`${candidate.sku}: lifecycle_status must be a non-empty string or null`);
  }
  if (!candidate.category?.trim()) throw new Error(`${candidate.sku}: category is required`);
  if (!SALES_TIERS.includes(candidate.sales_tier)) {
    throw new Error(`${candidate.sku}: invalid sales_tier`);
  }
  if (!["single", "multipack", "bundle", "variety"].includes(candidate.listing_kind)) {
    throw new Error(`${candidate.sku}: invalid listing_kind`);
  }
  if (!Number.isFinite(candidate.risk_score) || candidate.risk_score < 0) {
    throw new Error(`${candidate.sku}: risk_score must be non-negative`);
  }
  for (const field of ["prior_visual_bad", "elevated_return_risk", "remediation_applied"] as const) {
    if (typeof candidate[field] !== "boolean") throw new Error(`${candidate.sku}: ${field} must be boolean`);
  }
  return {
    ...candidate,
    expected: validateExpectedTruth(candidate.expected, `${candidate.sku}.expected`),
  };
}

export function shadowPrimaryStratum(candidate: WalmartShadowCandidate): ShadowPrimaryStratum {
  if (candidate.prior_visual_bad || candidate.elevated_return_risk) {
    return "known_bad_or_return_risk";
  }
  if (candidate.remediation_applied) return "remediated";
  if (candidate.expected.outer_units > 1 || candidate.listing_kind !== "single") return "multipack";
  return "single_unit_control";
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
    categories: {},
    listing_kinds: { single: 0, multipack: 0, bundle: 0, variety: 0 },
  };
}

/**
 * Select exactly 50 cases with no quota borrowing. Insufficient source cells
 * fail instead of silently replacing high-risk rows with convenient controls.
 */
export function buildWalmartShadow50(
  candidates: WalmartShadowCandidate[],
  seed = "walmart-shadow-50-v1",
): WalmartShadow50Manifest {
  if (!Array.isArray(candidates)) throw new Error("shadow candidates must be an array");
  if (!seed.trim()) throw new Error("shadow seed is required");
  const seenSkus = new Set<string>();
  const seenItemIds = new Set<string>();
  const validatedCandidates = candidates.map(assertCandidate);
  for (const candidate of validatedCandidates) {
    if (seenSkus.has(candidate.sku)) throw new Error(`duplicate shadow SKU ${candidate.sku}`);
    if (seenItemIds.has(candidate.item_id)) throw new Error(`duplicate shadow item_id ${candidate.item_id}`);
    seenSkus.add(candidate.sku);
    seenItemIds.add(candidate.item_id);
  }

  const cases: WalmartShadow50Case[] = [];
  for (const stratum of STRATUM_PRIORITY) {
    let stratumRank = 0;
    for (const salesTier of SALES_TIERS) {
      const quota = SHADOW_50_QUOTAS[stratum][salesTier];
      const cell = validatedCandidates
        .filter((candidate) => shadowPrimaryStratum(candidate) === stratum && candidate.sales_tier === salesTier)
        .sort((left, right) => {
          if (left.risk_score !== right.risk_score) return right.risk_score - left.risk_score;
          return hash(`${seed}|${left.sku}|${left.item_id}`).localeCompare(
            hash(`${seed}|${right.sku}|${right.item_id}`),
          );
        });
      if (cell.length < quota) {
        throw new Error(`${stratum}/${salesTier}: need ${quota} candidates, found ${cell.length}`);
      }
      for (const candidate of cell.slice(0, quota)) {
        stratumRank += 1;
        cases.push({
          ...candidate,
          case_id: `shadow-${String(cases.length + 1).padStart(2, "0")}-${hash(`${seed}|${candidate.sku}|${candidate.item_id}`).slice(0, 10)}`,
          primary_stratum: stratum,
          stratum_rank: stratumRank,
        });
      }
    }
  }
  if (cases.length !== 50) throw new Error(`shadow selection invariant failed: ${cases.length} != 50`);

  const distribution = emptyDistribution();
  for (const item of cases) {
    distribution.strata[item.primary_stratum] += 1;
    distribution.sales_tiers[item.sales_tier] += 1;
    distribution.categories[item.category] = (distribution.categories[item.category] ?? 0) + 1;
    distribution.listing_kinds[item.listing_kind] += 1;
  }
  const selectionSha = hash(JSON.stringify(cases.map((item) => ({
    case_id: item.case_id,
    sku: item.sku,
    item_id: item.item_id,
    primary_stratum: item.primary_stratum,
    sales_tier: item.sales_tier,
  }))));

  return {
    schema_version: WALMART_SHADOW_50_SCHEMA,
    manifest_id: `walmart-shadow-50-${selectionSha.slice(0, 12)}`,
    seed,
    selection_policy: {
      exact_size: 50,
      fail_if_any_quota_is_unavailable: true,
      stratum_priority: [...STRATUM_PRIORITY],
      quotas: SHADOW_50_QUOTAS,
      within_cell_order: "risk_desc_then_seeded_hash",
      truth_schema: WALMART_SHADOW_TRUTH_SCHEMA,
    },
    cases,
    distribution,
    acceptance_gates: SHADOW_50_ACCEPTANCE_GATES,
  };
}
