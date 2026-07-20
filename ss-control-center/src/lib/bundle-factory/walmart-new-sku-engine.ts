import { createHash } from "node:crypto";

import {
  sha256WalmartJson,
  stableWalmartJson,
  type MarketplaceDistributionApproval,
  type ProductTruthRecipeComponentEvidence,
} from "./walmart-listing-contract";
import type {
  ProductTruthNewSkuView as ProductTruthRecipeInput,
  ProductTruthWalmartPilotCandidate as WalmartPilotCandidate,
} from "@/lib/sourcing/product-truth-read-contract";
import { PRODUCT_TRUTH_READ_CONTRACT_VERSION } from "@/lib/sourcing/product-truth-read-contract";
import { hashWalmartPayload } from "./distribution/walmart-payload-hash";
import {
  WALMART_OWNER_PERMIT_SCHEMA,
  assertWalmartOwnerPermitSignature,
  buildWalmartOwnerPermitSigningRequest,
  inspectWalmartOwnerPermitTrustRoot,
  walmartOwnerPermitRuntimeEnvironment,
  type WalmartOwnerPermit,
} from "./walmart-owner-permit";
import {
  WALMART_SELLER_CATALOG_AUTHORITY_MAX_AGE_MS,
  verifyWalmartSellerCatalogAuthorityBinding,
  type SealedWalmartSellerCatalogAuthorityBinding,
} from "./walmart-new-sku-catalog-authority";
import {
  WALMART_NEW_SKU_POLICY_REVIEW_EVIDENCE_SCHEMA,
  WALMART_NEW_SKU_REQUIRED_POLICY_REVIEW_DOMAIN_IDS,
  WALMART_NEW_SKU_REQUIRED_POLICY_SOURCE_IDS,
  type WalmartNewSkuPolicyReviewBinding,
} from "./walmart-new-sku-policy-review-evidence";
import {
  WALMART_POLICY_SOURCES,
  WALMART_POLICY_VERSION,
} from "./validation/walmart-prepublication-policy";

export const WALMART_NEW_SKU_PLAN_SCHEMA =
  "walmart-new-sku-plan/1.3.0" as const;
export const WALMART_NEW_SKU_DOCTOR_RECEIPT_SCHEMA =
  "walmart-new-sku-doctor-receipt/1.4.0" as const;
export const WALMART_NEW_SKU_STAGE_SCHEMA =
  "walmart-new-sku-stage/1.0.0" as const;
export const WALMART_NEW_SKU_UPC_ROTATION_RECEIPT_SCHEMA =
  "walmart-new-sku-upc-rotation-receipt/1.0.0" as const;
export const WALMART_NEW_SKU_CERTIFICATION_INPUT_SCHEMA =
  "walmart-new-sku-certification-input/1.2.0" as const;
export const WALMART_NEW_SKU_CERTIFICATION_SCHEMA =
  "walmart-new-sku-certification/1.4.0" as const;
export const WALMART_NEW_SKU_CERTIFICATION_RECEIPT_SCHEMA =
  "walmart-new-sku-certification-receipt/1.0.0" as const;
export const WALMART_NEW_SKU_DRY_RUN_RECEIPT_SCHEMA =
  "walmart-new-sku-dry-run-receipt/1.0.0" as const;
export const WALMART_NEW_SKU_APPROVAL_SCHEMA =
  "walmart-new-sku-approval/1.0.0" as const;
export const WALMART_NEW_SKU_OWNER_PERMIT_SCHEMA = WALMART_OWNER_PERMIT_SCHEMA;
export const WALMART_NEW_SKU_APPLY_RECEIPT_SCHEMA =
  "walmart-new-sku-apply-receipt/1.0.0" as const;
export const WALMART_NEW_SKU_VERIFY_RECEIPT_SCHEMA =
  "walmart-new-sku-verify-receipt/1.1.0" as const;
export const WALMART_NEW_SKU_PILOT_MAX_APPLY = 2;
export const WALMART_NEW_SKU_PILOT_PACK_COUNTS = [2, 3] as const;
export const WALMART_NEW_SKU_DRY_RUN_MAX_AGE_MS = 30 * 60 * 1_000;
export const WALMART_NEW_SKU_APPROVAL_MAX_AGE_MS = 30 * 60 * 1_000;
export const WALMART_NEW_SKU_DOCTOR_MAX_AGE_MS = 30 * 60 * 1_000;

export type WalmartNewSkuPlanBlocker =
  | "COUNT_ACCURATE_RIGHTS_CLEARED_MAIN_IMAGE"
  | "RIGHTS_CLEARED_SECONDARY_IMAGE"
  | "OPERATOR_VERIFIED_PACKAGE_MEASUREMENTS"
  | "EXACT_UPC_CATALOG_SEARCH"
  | "SELLER_CATALOG_RECIPE_NOVELTY"
  | "CURRENT_WALMART_GET_SPEC"
  | "SELLER_ACCOUNT_HEALTH_AND_PUBLISH_ELIGIBILITY"
  | "BRAND_RIGHTS_EVIDENCE"
  | "CATEGORY_AND_SKU_POLICY_CLEARANCE"
  | "CURRENT_RECALL_CHECK"
  | "EXPIRATION_AND_LOT_PROCEDURE"
  | "POSITIVE_VERIFIED_COMPONENT_INVENTORY"
  | "EXPLICIT_DISTRIBUTION_APPROVAL";

export interface DeterministicWalmartContent {
  generator: "deterministic-product-truth-multipack/v1";
  title: string;
  bullets: string[];
  description: string;
}

export interface WalmartNewSkuPlanCandidate {
  candidate_key: string;
  donor_product_id: string;
  canonical_variant_id: string;
  pack_count: number;
  source_candidate: WalmartPilotCandidate;
  recipe_input: ProductTruthRecipeInput;
  content: DeterministicWalmartContent;
  required_before_certification: WalmartNewSkuPlanBlocker[];
}

export interface WalmartNewSkuPlan {
  schema_version: typeof WALMART_NEW_SKU_PLAN_SCHEMA;
  plan_sha256: string;
  wave_id: string;
  phase: "PILOT";
  created_at: string;
  as_of: string;
  store_index: number;
  seller_account_fingerprint_sha256: string;
  seller_catalog_authority: SealedWalmartSellerCatalogAuthorityBinding;
  doctor_receipt_sha256: string;
  engine_release_sha256: string;
  release_manifest_sha256: string;
  database_target_fingerprint_sha256: string;
  database_schema_sha256: string;
  item_spec_version: string;
  zip: string;
  max_live_submissions: 1;
  marketplace_mutation_allowed: false;
  candidates: WalmartNewSkuPlanCandidate[];
}

export interface WalmartNewSkuStagePreview {
  schema_version: typeof WALMART_NEW_SKU_STAGE_SCHEMA;
  wave_id: string;
  plan_sha256: string;
  candidate_key: string;
  store_index: number;
  generation_job_id: string;
  bundle_draft_id: string;
  proposed_sku: string;
  marketplace_mutation_allowed: false;
}

export interface WalmartNewSkuStageArtifact extends WalmartNewSkuStagePreview {
  stage_sha256: string;
  staged_at: string;
  staged_by: string;
  upc_pool_id: string;
  upc: string;
  upc_gs1_validated: boolean;
  upc_reserved_until: string;
  state: "UPC_RESERVED";
}

export interface WalmartExactCatalogMatchEvidence {
  searched_at: string;
  query_gtin: string;
  result: "EXACT_MATCH";
  setup_method: "MP_ITEM_MATCH";
  response_format: "SPEC";
  feed_type: "MP_ITEM_MATCH";
  spec_version: string;
  walmart_item_id: string | null;
  normalized_identifiers: string[];
  response_sha256: string;
  match_fingerprint_sha256: string;
  correlation_id: string;
  evidence_ref: string;
}

export interface WalmartSellerSkuAbsenceEvidence {
  checked_at: string;
  sku: string;
  endpoint: string;
  result: "NOT_FOUND";
  http_status: 404;
  correlation_id: string;
  response_sha256: string;
  evidence_ref: string;
}

export interface WalmartNewSkuUpcRotationPreview {
  plan_sha256: string;
  prior_stage_sha256: string;
  candidate_key: string;
  bundle_draft_id: string;
  old_upc_pool_id: string;
  old_upc: string;
  exact_match: WalmartExactCatalogMatchEvidence;
  confirmation_sha256: string;
  internal_database_mutated: false;
  marketplace_mutated: false;
}

export interface WalmartNewSkuUpcRotationReceipt {
  schema_version: typeof WALMART_NEW_SKU_UPC_ROTATION_RECEIPT_SCHEMA;
  receipt_sha256: string;
  confirmation_sha256: string;
  plan_sha256: string;
  prior_stage_sha256: string;
  new_stage_sha256: string;
  candidate_key: string;
  bundle_draft_id: string;
  rotated_at: string;
  rotated_by: string;
  exact_match: WalmartExactCatalogMatchEvidence;
  retired_upc_pool_id: string;
  retired_upc: string;
  retired_upc_status: "RETIRED";
  retired_upc_disposition: "FUTURE_MP_ITEM_MATCH";
  new_upc_pool_id: string;
  new_upc: string;
  new_upc_status: "RESERVED";
  new_stage: WalmartNewSkuStageArtifact;
  internal_database_mutated: true;
  marketplace_mutated: false;
}

export interface WalmartNewSkuPhysicalPackageInput {
  schema_version: "bundle-factory.verified-physical-package/v1";
  source: "OPERATOR_SHIP_SPECS";
  verified_at: string;
  weight_oz: number;
  length_in: number;
  width_in: number;
  height_in: number;
}

export type WalmartNewSkuEvidenceArtifactKind =
  | "IMAGE_RIGHTS"
  | "COUNTRY_OF_ORIGIN"
  | "PRODUCT_ATTRIBUTE"
  | "CATEGORY_APPROVAL"
  | "POLICY_REVIEW"
  | "RECALL_CHECK"
  | "BRAND_RIGHTS"
  | "SELLER_ACCOUNT_HEALTH"
  | "LOT_CONTROL_PROCEDURE"
  | "EXPIRATION_SOURCE";

export interface WalmartNewSkuEvidenceArtifactInput {
  ref: string;
  kind: WalmartNewSkuEvidenceArtifactKind;
  path: string;
  sha256: string;
  byte_size: number;
  captured_at: string;
  source_url: string | null;
}

export interface WalmartNewSkuCertificationInput {
  schema_version: typeof WALMART_NEW_SKU_CERTIFICATION_INPUT_SCHEMA;
  wave_id: string;
  candidate_key: string;
  stage_sha256: string;
  price_cents: number;
  packaging_cost_cents: number;
  shipping_label_cents: number;
  shipping_in_price: boolean;
  evidence_artifacts: WalmartNewSkuEvidenceArtifactInput[];
  images: Array<{
    role: "MAIN" | "SECONDARY" | "NUTRITION";
    url: string;
    depicted_component_keys: string[];
    source_content_observation_ids: string[];
    represented_unit_count: number;
    rights_basis:
      | "OWNED"
      | "LICENSED"
      | "SOURCE_ALLOWED"
      | "AI_DERIVED_FROM_RIGHTS_CLEARED_INPUTS";
    rights_evidence_ref: string;
    reviewed_at: string;
  }>;
  physical_package: WalmartNewSkuPhysicalPackageInput;
  walmart: {
    product_type: string;
    country_of_origin_substantial_transformation: string;
    country_of_origin_evidence: {
      canonical_variant_id: string;
      content_observation_id: string;
      value: string;
      source: "PRODUCT_LABEL" | "MANUFACTURER_DOCUMENT" | "AUTHORIZED_BRAND_RECORD";
      evidence_ref: string;
      verified_at: string;
    };
    public_attributes: Record<string, unknown>;
    public_attribute_evidence: Record<string, {
      source: "PRODUCT_TRUTH" | "OPERATOR_SHIP_SPECS";
      source_path: string;
      evidence_ref: string;
    }>;
    offer_handoff: {
      mode: "INLINE";
      quantity: 1;
      fulfillment_center_id: string;
      fulfillment_lag_time: number;
    };
  };
  prepublication: {
    seller_account_health: {
      status: "HEALTHY_AND_ACCEPTING_NEW_ITEMS";
      store_index: 1;
      seller_account_fingerprint_sha256: string;
      verified_at: string;
      evidence_ref: string;
    };
    category_approvals: Array<{
      scope: string;
      status: "APPROVED" | "NOT_REQUIRED";
      verified_at: string;
      evidence_ref: string;
    }>;
    sku_policy_review: {
      status: "CLEARED";
      reviewed_at: string;
      evidence_ref: string;
    };
    recall_check: {
      status: "CLEAR";
      checked_at: string;
      source: string;
      evidence_ref: string;
    };
    brand_rights: {
      brand: string;
      basis: "BRAND_OWNER" | "AUTHORIZED_RESELLER";
      verified_at: string;
      evidence_ref: string;
    };
    condition: { value: "New"; verified_at: string };
    expiration: {
      applicable: true;
      shelf_life_days: number;
      minimum_days_remaining_at_ship: number;
      lot_check_procedure_ref: string;
      source_ref: string;
      verified_at: string;
    };
  };
}

export interface WalmartNewSkuCertificationArtifact {
  schema_version: typeof WALMART_NEW_SKU_CERTIFICATION_SCHEMA;
  certification_sha256: string;
  wave_id: string;
  plan_sha256: string;
  stage_sha256: string;
  candidate_key: string;
  store_index: number;
  seller_account_fingerprint_sha256: string;
  seller_catalog_authority: SealedWalmartSellerCatalogAuthorityBinding;
  bundle_draft_id: string;
  master_bundle_id: string;
  channel_sku_id: string;
  sku: string;
  upc: string;
  certified_at: string;
  certification_input_sha256: string;
  validation_run_id: string;
  validation_status: "PASSED";
  payload_sha256: string;
  product_truth_recipe_hash: string;
  product_truth_binding: {
    donor_product_id: string;
    canonical_variant_id: string;
    content_observation_id: string;
    price_observation_id: string;
    qty: number;
    zip: string;
    price_max_age_ms: number;
    component_sha256: string;
  };
  catalog_search_evidence_ref: string;
  seller_sku_absence_evidence_ref: string;
  seller_account_health_evidence_ref: string;
  seller_account_health_verified_at: string;
  item_spec_schema_sha256: string;
  source_evidence_sha256: string;
  marketplace_mutation_allowed: false;
}

export interface WalmartNewSkuDoctorReceipt {
  schema_version: typeof WALMART_NEW_SKU_DOCTOR_RECEIPT_SCHEMA;
  receipt_sha256: string;
  checked_at: string;
  expires_at: string;
  store_index: number;
  seller_account_fingerprint_sha256: string;
  seller_catalog_authority: SealedWalmartSellerCatalogAuthorityBinding;
  database_target_fingerprint_sha256: string;
  database_schema_sha256: string;
  engine_release_sha256: string;
  expected_engine_release_sha256: string;
  release_manifest_sha256: string;
  frozen_release_verified: true;
  frozen_release_source_modes_verified: true;
  planning_scope: {
    as_of: string;
    zip: "33765";
    max_price_age_ms: 86_400_000;
    limit: 1;
    pack_count: 2 | 3;
  };
  owner_permit_key_id: string;
  owner_permit_public_key_spki_sha256: string;
  item_spec_version: string;
  walmart_api_probe: {
    method: "GET";
    path: "/v3/items/walmart/search";
    response_format: "SPEC";
    upc_sha256: string;
    http_status: 200;
    correlation_id: string;
    response_sha256: string;
    authenticated_catalog_read: true;
  };
  product_truth_schema_ready: true;
  publish_lifecycle_schema_ready: true;
  upc_pool: {
    available: number;
    duplicate_draft_reservations: 0;
  };
  ready_for_plan: true;
  infrastructure_ready_for_pilot: true;
  ready_for_live_apply: false;
  blockers: [];
  claims: {
    read_only: true;
    provider_calls: 0;
    marketplace_mutated: false;
    listing_published: false;
    migration_applied: false;
    backfill_performed: false;
  };
}

export interface WalmartNewSkuCertificationReceipt {
  schema_version: typeof WALMART_NEW_SKU_CERTIFICATION_RECEIPT_SCHEMA;
  receipt_sha256: string;
  certification_sha256: string;
  captured_at: string;
  payload: Record<string, unknown>;
  validation: unknown;
  sources: unknown;
}

export interface WalmartNewSkuDryRunReceipt {
  schema_version: typeof WALMART_NEW_SKU_DRY_RUN_RECEIPT_SCHEMA;
  receipt_sha256: string;
  certification_sha256: string;
  channel_sku_id: string;
  sku: string;
  replayed_at: string;
  validation_status: "PASSED";
  validation_results: unknown;
  payload_sha256: string;
  payload: Record<string, unknown>;
  live_spec_validation: {
    valid: true;
    spec_version: string;
    schema_sha256: string;
    fetched_at: string;
    issues: unknown[];
  };
  offer_handoff: unknown;
  marketplace_mutated: false;
}

export interface WalmartNewSkuApprovalArtifact {
  schema_version: typeof WALMART_NEW_SKU_APPROVAL_SCHEMA;
  approval_sha256: string;
  certification_sha256: string;
  certification_receipt_sha256: string;
  dry_run_receipt_sha256: string;
  candidate_key: string;
  bundle_draft_id: string;
  channel_sku_id: string;
  sku: string;
  payload_sha256: string;
  validation_run_id: string;
  approved_at: string;
  approved_by: string;
  distribution_approval: MarketplaceDistributionApproval;
  live_apply_authorized: true;
  max_apply_skus: 1;
  marketplace_mutation_performed: false;
}

export interface WalmartNewSkuApplyReceipt {
  schema_version: typeof WALMART_NEW_SKU_APPLY_RECEIPT_SCHEMA;
  receipt_sha256: string;
  approval_sha256: string;
  certification_sha256: string;
  channel_sku_id: string;
  sku: string;
  requested_at: string;
  mode: "PREVIEW" | "LIVE";
  marketplace_mutation_requested: boolean;
  result: unknown;
  latest_submission_attempt: unknown;
}

export type WalmartNewSkuOwnerPermit = WalmartOwnerPermit;

export interface WalmartNewSkuVerifyReceipt {
  schema_version: typeof WALMART_NEW_SKU_VERIFY_RECEIPT_SCHEMA;
  receipt_sha256: string;
  certification_sha256: string;
  channel_sku_id: string;
  sku: string;
  payload_sha256: string;
  submission_attempt_binding: {
    attempt_id: string;
    channel_sku_id: string;
    certification_sha256: string;
    payload_sha256: string;
    seller_account_fingerprint_sha256: string;
    idempotency_key: string;
  } | null;
  verified_at: string;
  marketplace_mutated: false;
  local_lifecycle_reconciled: boolean;
  buyer_evidence_recorded: boolean;
  poll_result: unknown;
  buyer_evidence_status: unknown;
}

export class WalmartNewSkuPlanError extends Error {
  readonly code = "WALMART_NEW_SKU_PLAN_BLOCKED";
  readonly blockers: string[];

  constructor(blockers: string[]) {
    super(`Walmart new-SKU plan blocked: ${blockers.join("; ")}`);
    this.name = "WalmartNewSkuPlanError";
    this.blockers = blockers;
  }
}

const PLACEHOLDER_TEXT = /(?:^|[^A-Z0-9])(?:TODO|TBD)(?:$|[^A-Z0-9])|PLACEHOLDER|TO_FILL|REPLACE_ME|UNKNOWN_EVIDENCE/i;
const ACCOUNT_EVIDENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const SELLER_ACCOUNT_HEALTH_MAX_AGE_MS = 60 * 60 * 1_000;
const POLICY_REVIEW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const RECALL_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * Stable, non-secret binding for one configured Walmart seller account.
 * Raw seller IDs never enter artifacts or logs; only this domain-separated
 * fingerprint is sealed into the plan and certification.
 */
export function fingerprintWalmartSellerAccount(input: {
  storeIndex: number;
  sellerId: string;
}): string {
  if (!Number.isInteger(input.storeIndex) || input.storeIndex <= 0) {
    throw new WalmartNewSkuPlanError(["SELLER_ACCOUNT_STORE_INDEX_INVALID"]);
  }
  const normalizedSellerId = input.sellerId
    .normalize("NFKC")
    .trim()
    .toUpperCase();
  if (
    !normalizedSellerId ||
    normalizedSellerId.length > 256 ||
    /[\u0000-\u001F\u007F]/.test(normalizedSellerId) ||
    PLACEHOLDER_TEXT.test(normalizedSellerId)
  ) {
    throw new WalmartNewSkuPlanError(["SELLER_ACCOUNT_ID_INVALID"]);
  }
  return sha256WalmartJson({
    binding_version: "walmart-seller-account-binding/1.0.0",
    store_index: input.storeIndex,
    normalized_seller_id: normalizedSellerId,
  });
}

function hasPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return PLACEHOLDER_TEXT.test(value);
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasPlaceholder);
  }
  return false;
}

function isFreshPastIso(value: unknown, maxAgeMs: number, now: Date): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const parsed = Date.parse(value);
  return (
    Number.isFinite(parsed) &&
    parsed <= now.getTime() + 5 * 60_000 &&
    now.getTime() - parsed <= maxAgeMs
  );
}

function isEvidenceReference(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return (
    normalized.length >= 12 &&
    !PLACEHOLDER_TEXT.test(normalized) &&
    /^(?:https:\/\/|[a-z][a-z0-9+.-]{1,31}:)\S+$/i.test(normalized)
  );
}

function getCertificationSourcePath(
  component: ProductTruthRecipeComponentEvidence,
  physical: WalmartNewSkuPhysicalPackageInput,
  source: "PRODUCT_TRUTH" | "OPERATOR_SHIP_SPECS",
  path: string,
): unknown {
  const allowedProductTruthRoots: Record<string, unknown> = {
    "component.product_name": component.product_name,
    "component.manufacturer_brand": component.manufacturer_brand,
    "component.manufacturer_upc": component.manufacturer_upc,
    "component.flavor": component.flavor,
    "component.facts.ingredients": component.facts.ingredients,
    "component.facts.allergens": component.facts.allergens,
    "component.facts.nutrition_facts": component.facts.nutrition_facts,
  };
  if (source === "PRODUCT_TRUTH") {
    if (path in allowedProductTruthRoots) return allowedProductTruthRoots[path];
    const prefix = "component.facts.attributes.";
    if (!path.startsWith(prefix)) return undefined;
    const parts = path.slice(prefix.length).split(".").filter(Boolean);
    let current: unknown = component.facts.attributes;
    for (const part of parts) {
      if (
        part === "__proto__" ||
        part === "prototype" ||
        part === "constructor" ||
        !current ||
        typeof current !== "object" ||
        Array.isArray(current) ||
        !(part in (current as Record<string, unknown>))
      ) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
  const physicalValues: Record<string, unknown> = {
    "physical_package.weight_oz": physical.weight_oz,
    "physical_package.length_in": physical.length_in,
    "physical_package.width_in": physical.width_in,
    "physical_package.height_in": physical.height_in,
  };
  return physicalValues[path];
}

export function isValidOwnerPoolUpca(value: string): boolean {
  if (!/^\d{12}$/.test(value)) return false;
  let sum = 0;
  for (let index = 0; index < 11; index += 1) {
    const digit = value.charCodeAt(index) - 48;
    sum += index % 2 === 0 ? digit * 3 : digit;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === value.charCodeAt(11) - 48;
}

function normalizedGtin14(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text) || ![8, 12, 13, 14].includes(text.length)) return null;
  return text.padStart(14, "0");
}

export function certifyNoExactWalmartCatalogMatch(input: {
  upc: string;
  responseBody: unknown;
  searchedAt: Date;
  correlationId: string;
  responseFormat?: "SPEC" | "DEFAULT";
}): {
  searched_at: string;
  query_gtin: string;
  result: "NO_EXACT_MATCH";
  setup_method: "FULL_ITEM";
  walmart_item_id: null;
  response_format: "SPEC" | "DEFAULT";
  catalog_outcome: "NO_MATCH" | "MP_ITEM_FULL_SETUP";
  response_sha256: string;
  feed_type: "MP_ITEM" | null;
  spec_version: string | null;
  evidence_ref: string;
} {
  const responseFormat = input.responseFormat ?? "DEFAULT";
  const parsed = parseWalmartCatalogSearch({
    upc: input.upc,
    responseBody: input.responseBody,
    responseFormat,
  });
  if (parsed.outcome === "EXACT_MATCH") {
    throw new WalmartNewSkuPlanError([
      `CATALOG_EXACT_MATCH_PILOT_BLOCKED:${stableWalmartJson(parsed)}`,
    ]);
  }
  const responseHash = sha256WalmartJson(input.responseBody);
  const correlation = input.correlationId.trim() || "unavailable";
  return {
    searched_at: input.searchedAt.toISOString(),
    query_gtin: input.upc,
    result: "NO_EXACT_MATCH",
    setup_method: "FULL_ITEM",
    walmart_item_id: null,
    response_format: responseFormat,
    catalog_outcome:
      parsed.outcome === "FULL_ITEM" ? "MP_ITEM_FULL_SETUP" : "NO_MATCH",
    response_sha256: responseHash,
    feed_type: parsed.outcome === "FULL_ITEM" ? "MP_ITEM" : null,
    spec_version: parsed.outcome === "FULL_ITEM" ? parsed.spec_version : null,
    evidence_ref:
      `walmart-api:/v3/items/walmart/search?upc=${input.upc}` +
      `&responseFormat=${responseFormat}` +
      `#sha256=${responseHash};cid=${correlation}`,
  };
}

export function certifyWalmartSellerSkuAbsent(input: {
  sku: string;
  httpStatus: number;
  responseBody: unknown;
  checkedAt: Date;
  correlationId: string;
}): WalmartSellerSkuAbsenceEvidence {
  const sku = input.sku.trim();
  const correlationId = input.correlationId.trim();
  if (!/^WM-[A-F0-9]{4}-[A-F0-9]{4}$/.test(sku)) {
    throw new WalmartNewSkuPlanError(["SELLER_SKU_ABSENCE_SKU_INVALID"]);
  }
  if (!Number.isFinite(input.checkedAt.getTime()) || !correlationId) {
    throw new WalmartNewSkuPlanError([
      "SELLER_SKU_ABSENCE_RESPONSE_PROVENANCE_INVALID",
    ]);
  }
  if (input.httpStatus !== 404) {
    throw new WalmartNewSkuPlanError([
      input.httpStatus >= 200 && input.httpStatus < 300
        ? `SELLER_SKU_ALREADY_EXISTS:${sku}`
        : `SELLER_SKU_ABSENCE_UNPROVEN_HTTP_${input.httpStatus}`,
    ]);
  }
  // A transport-level 404 is not sufficient proof that this exact seller SKU
  // is absent. Gateways, bad routes, and account-scoped authorization failures
  // can also surface as 404. Only Walmart's structured ITEM_NOT_FOUND response
  // is admissible at this mutation-key boundary; every ambiguous envelope must
  // fail closed before MP_ITEM can create or update anything.
  const responseRoot =
    input.responseBody &&
    typeof input.responseBody === "object" &&
    !Array.isArray(input.responseBody)
      ? input.responseBody as Record<string, unknown>
      : null;
  const errors = responseRoot?.errors;
  const exactNotFound =
    Array.isArray(errors) &&
    errors.length === 1 &&
    errors[0] != null &&
    typeof errors[0] === "object" &&
    !Array.isArray(errors[0]) &&
    (errors[0] as Record<string, unknown>).code === "ITEM_NOT_FOUND";
  if (!exactNotFound) {
    throw new WalmartNewSkuPlanError([
      "SELLER_SKU_ABSENCE_UNPROVEN_404_ENVELOPE",
    ]);
  }
  const endpoint = `/v3/items/${encodeURIComponent(sku)}`;
  const responseSha256 = sha256WalmartJson(input.responseBody);
  return {
    checked_at: input.checkedAt.toISOString(),
    sku,
    endpoint,
    result: "NOT_FOUND",
    http_status: 404,
    correlation_id: correlationId,
    response_sha256: responseSha256,
    evidence_ref:
      `walmart-api:${endpoint}#status=404;sha256=${responseSha256};` +
      `cid=${correlationId}`,
  };
}

function parseWalmartCatalogSearch(input: {
  upc: string;
  responseBody: unknown;
  responseFormat: "SPEC" | "DEFAULT";
}):
  | { outcome: "NO_MATCH" }
  | {
      outcome: "FULL_ITEM";
      spec_version: string;
      normalized_identifiers: string[];
    }
  | {
      outcome: "EXACT_MATCH";
      source: "SPEC" | "DEFAULT";
      item_id: string | null;
      spec_version: string | null;
      normalized_identifiers: string[];
    } {
  if (!isValidOwnerPoolUpca(input.upc)) {
    throw new WalmartNewSkuPlanError(["CATALOG_SEARCH_UPC_INVALID"]);
  }
  const root = input.responseBody;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new WalmartNewSkuPlanError(["CATALOG_SEARCH_RESPONSE_MALFORMED"]);
  }
  const rootRecord = root as Record<string, unknown>;
  if (!("items" in rootRecord)) {
    if (Object.keys(rootRecord).length === 0) return { outcome: "NO_MATCH" };
    throw new WalmartNewSkuPlanError(["CATALOG_SEARCH_ITEMS_MISSING"]);
  }
  const items = rootRecord.items;
  if (!Array.isArray(items)) {
    throw new WalmartNewSkuPlanError(["CATALOG_SEARCH_ITEMS_MALFORMED"]);
  }
  if (items.length === 0) return { outcome: "NO_MATCH" };
  if (input.responseFormat === "SPEC") {
    return parseWalmartSpecCatalogSearch(input.upc, items);
  }
  const target = normalizedGtin14(input.upc)!;
  const exactRows: Array<{
    index: number;
    item_id: string | null;
    normalized_identifiers: string[];
  }> = [];
  items.forEach((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new WalmartNewSkuPlanError([`CATALOG_SEARCH_ITEM_${index}_MALFORMED`]);
    }
    const row = value as Record<string, unknown>;
    if (!Array.isArray(row.standardUpc) || row.standardUpc.length === 0) {
      throw new WalmartNewSkuPlanError([
        `CATALOG_SEARCH_ITEM_${index}_IDENTIFIERS_AMBIGUOUS`,
      ]);
    }
    const identifiers = row.standardUpc.map(normalizedGtin14);
    if (identifiers.some((identifier) => identifier == null)) {
      throw new WalmartNewSkuPlanError([
        `CATALOG_SEARCH_ITEM_${index}_IDENTIFIER_MALFORMED`,
      ]);
    }
    if (!identifiers.includes(target)) return;
    const itemId = row.itemId == null ? null : String(row.itemId).trim();
    exactRows.push({
      index,
      item_id: itemId || null,
      normalized_identifiers: [...new Set(identifiers as string[])].sort(),
    });
  });
  if (exactRows.length === 0) return { outcome: "NO_MATCH" };
  if (exactRows.length !== 1) {
    throw new WalmartNewSkuPlanError([
      `CATALOG_EXACT_MATCH_AMBIGUOUS:${stableWalmartJson(exactRows)}`,
    ]);
  }
  return {
    outcome: "EXACT_MATCH",
    source: "DEFAULT",
    item_id: exactRows[0].item_id,
    spec_version: null,
    normalized_identifiers: exactRows[0].normalized_identifiers,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function collectSpecProductIdentifiers(
  value: unknown,
  output: Array<{ type: string; normalized: string }>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSpecProductIdentifiers(item, output);
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key !== "productIdentifiers") {
      collectSpecProductIdentifiers(child, output);
      continue;
    }
    const rows = Array.isArray(child) ? child : [child];
    if (rows.length === 0) {
      throw new WalmartNewSkuPlanError(["CATALOG_SPEC_IDENTIFIERS_EMPTY"]);
    }
    for (const row of rows) {
      if (!isPlainRecord(row)) {
        throw new WalmartNewSkuPlanError(["CATALOG_SPEC_IDENTIFIER_MALFORMED"]);
      }
      const type = typeof row.productIdType === "string"
        ? row.productIdType.trim().toUpperCase()
        : "";
      const normalized = normalizedGtin14(row.productId);
      if (!(["UPC", "GTIN"] as const).includes(type as "UPC" | "GTIN") || !normalized) {
        throw new WalmartNewSkuPlanError(["CATALOG_SPEC_IDENTIFIER_MALFORMED"]);
      }
      output.push({ type, normalized });
    }
  }
}

function parseWalmartSpecCatalogSearch(
  upc: string,
  items: unknown[],
):
  | {
      outcome: "FULL_ITEM";
      spec_version: string;
      normalized_identifiers: string[];
    }
  | {
      outcome: "EXACT_MATCH";
      source: "SPEC";
      item_id: string | null;
      spec_version: string;
      normalized_identifiers: string[];
    } {
  if (items.length !== 1) {
    throw new WalmartNewSkuPlanError([
      `CATALOG_SPEC_RESULT_COUNT_AMBIGUOUS:${items.length}`,
    ]);
  }
  const row = items[0];
  if (!isPlainRecord(row)) {
    throw new WalmartNewSkuPlanError(["CATALOG_SPEC_ITEM_MALFORMED"]);
  }
  if (row.feedType !== "MP_ITEM" && row.feedType !== "MP_ITEM_MATCH") {
    throw new WalmartNewSkuPlanError(["CATALOG_SPEC_FEED_TYPE_UNSUPPORTED"]);
  }
  const specVersion = typeof row.version === "string" ? row.version.trim() : "";
  if (!specVersion || !isPlainRecord(row.itemSpecPayload)) {
    throw new WalmartNewSkuPlanError(["CATALOG_SPEC_PAYLOAD_MALFORMED"]);
  }
  const header = row.itemSpecPayload.MPItemFeedHeader;
  const mpItems = row.itemSpecPayload.MPItem;
  if (
    !isPlainRecord(header) ||
    header.version !== specVersion ||
    (header.businessUnit != null && header.businessUnit !== "WALMART_US") ||
    !Array.isArray(mpItems) ||
    mpItems.length !== 1 ||
    !isPlainRecord(mpItems[0])
  ) {
    throw new WalmartNewSkuPlanError(["CATALOG_SPEC_ENVELOPE_AMBIGUOUS"]);
  }
  const identifierRows: Array<{ type: string; normalized: string }> = [];
  collectSpecProductIdentifiers(mpItems[0], identifierRows);
  const normalizedIdentifiers = [
    ...new Set(identifierRows.map((identifier) => identifier.normalized)),
  ].sort();
  const target = normalizedGtin14(upc)!;
  if (normalizedIdentifiers.length === 0 || !normalizedIdentifiers.includes(target)) {
    throw new WalmartNewSkuPlanError(["CATALOG_SPEC_QUERY_IDENTIFIER_MISMATCH"]);
  }
  if (row.feedType === "MP_ITEM") {
    return {
      outcome: "FULL_ITEM",
      spec_version: specVersion,
      normalized_identifiers: normalizedIdentifiers,
    };
  }
  const itemId = row.itemId == null ? null : String(row.itemId).trim() || null;
  return {
    outcome: "EXACT_MATCH",
    source: "SPEC",
    item_id: itemId,
    spec_version: specVersion,
    normalized_identifiers: normalizedIdentifiers,
  };
}

/**
 * Prove that exactly one unambiguous Walmart catalog row owns the staged UPC.
 * This proof authorizes only an internal pool rotation; it never authorizes a
 * Walmart item mutation or silently switches the pilot to MP_ITEM_MATCH.
 */
export function proveExactWalmartCatalogMatch(input: {
  upc: string;
  responseBody: unknown;
  searchedAt: Date;
  correlationId: string;
}): WalmartExactCatalogMatchEvidence {
  const parsed = parseWalmartCatalogSearch({
    upc: input.upc,
    responseBody: input.responseBody,
    responseFormat: "SPEC",
  });
  if (parsed.outcome === "NO_MATCH" || parsed.outcome === "FULL_ITEM") {
    throw new WalmartNewSkuPlanError(["CATALOG_EXACT_MATCH_NOT_FOUND"]);
  }
  if (parsed.source !== "SPEC" || !parsed.spec_version) {
    throw new WalmartNewSkuPlanError(["CATALOG_EXACT_MATCH_NOT_SPEC_FORMAT"]);
  }
  if (!Number.isFinite(input.searchedAt.getTime())) {
    throw new WalmartNewSkuPlanError(["CATALOG_SEARCH_TIME_INVALID"]);
  }
  const correlation = input.correlationId.trim();
  if (!correlation) {
    throw new WalmartNewSkuPlanError(["CATALOG_SEARCH_CORRELATION_ID_MISSING"]);
  }
  const responseHash = sha256WalmartJson(input.responseBody);
  const matchFingerprint = sha256WalmartJson({
    query_gtin: normalizedGtin14(input.upc),
    response_format: "SPEC",
    feed_type: "MP_ITEM_MATCH",
    spec_version: parsed.spec_version,
    walmart_item_id: parsed.item_id,
    normalized_identifiers: parsed.normalized_identifiers,
  });
  return {
    searched_at: input.searchedAt.toISOString(),
    query_gtin: input.upc,
    result: "EXACT_MATCH",
    setup_method: "MP_ITEM_MATCH",
    response_format: "SPEC",
    feed_type: "MP_ITEM_MATCH",
    spec_version: parsed.spec_version,
    walmart_item_id: parsed.item_id,
    normalized_identifiers: parsed.normalized_identifiers,
    response_sha256: responseHash,
    match_fingerprint_sha256: matchFingerprint,
    correlation_id: correlation,
    evidence_ref:
      `walmart-api:/v3/items/walmart/search?upc=${input.upc}&responseFormat=SPEC` +
      `#sha256=${responseHash};match=${matchFingerprint};cid=${correlation}`,
  };
}

export function buildWalmartNewSkuUpcRotationPreview(input: {
  plan: WalmartNewSkuPlan;
  stage: WalmartNewSkuStageArtifact;
  exactMatch: WalmartExactCatalogMatchEvidence;
}): WalmartNewSkuUpcRotationPreview {
  assertWalmartNewSkuStageArtifactIntegrity(input.stage, input.plan);
  const normalizedIdentifiers = [
    ...new Set(input.exactMatch.normalized_identifiers),
  ].sort();
  const expectedMatchFingerprint = sha256WalmartJson({
    query_gtin: normalizedGtin14(input.stage.upc),
    response_format: "SPEC",
    feed_type: "MP_ITEM_MATCH",
    spec_version: input.exactMatch.spec_version,
    walmart_item_id: input.exactMatch.walmart_item_id,
    normalized_identifiers: normalizedIdentifiers,
  });
  const searchedAt = Date.parse(input.exactMatch.searched_at);
  const expectedEvidenceRef =
    `walmart-api:/v3/items/walmart/search?upc=${input.stage.upc}` +
    `&responseFormat=SPEC#sha256=${input.exactMatch.response_sha256}` +
    `;match=${input.exactMatch.match_fingerprint_sha256}` +
    `;cid=${input.exactMatch.correlation_id}`;
  if (
    input.exactMatch.result !== "EXACT_MATCH" ||
    input.exactMatch.setup_method !== "MP_ITEM_MATCH" ||
    input.exactMatch.response_format !== "SPEC" ||
    input.exactMatch.feed_type !== "MP_ITEM_MATCH" ||
    input.exactMatch.query_gtin !== input.stage.upc ||
    !input.exactMatch.spec_version.trim() ||
    !Array.isArray(input.exactMatch.normalized_identifiers) ||
    input.exactMatch.normalized_identifiers.some(
      (identifier) => typeof identifier !== "string" || !/^\d{14}$/.test(identifier),
    ) ||
    normalizedIdentifiers.length === 0 ||
    stableWalmartJson(input.exactMatch.normalized_identifiers) !==
      stableWalmartJson(normalizedIdentifiers) ||
    !normalizedIdentifiers.includes(normalizedGtin14(input.stage.upc)!) ||
    (typeof input.exactMatch.walmart_item_id === "string" &&
      !input.exactMatch.walmart_item_id.trim()) ||
    !Number.isFinite(searchedAt) ||
    !input.exactMatch.correlation_id.trim() ||
    !/^[a-f0-9]{64}$/.test(input.exactMatch.response_sha256) ||
    input.exactMatch.match_fingerprint_sha256 !== expectedMatchFingerprint ||
    input.exactMatch.evidence_ref !== expectedEvidenceRef
  ) {
    throw new WalmartNewSkuPlanError(["UPC_ROTATION_EXACT_MATCH_BINDING_INVALID"]);
  }
  const confirmationSha256 = sha256WalmartJson({
    operation: "ROTATE_EXACT_MATCHED_WALMART_UPC/v1",
    plan_sha256: input.plan.plan_sha256,
    prior_stage_sha256: input.stage.stage_sha256,
    candidate_key: input.stage.candidate_key,
    bundle_draft_id: input.stage.bundle_draft_id,
    old_upc_pool_id: input.stage.upc_pool_id,
    old_upc: input.stage.upc,
    exact_walmart_item_id: input.exactMatch.walmart_item_id,
    exact_feed_type: input.exactMatch.feed_type,
    exact_spec_version: input.exactMatch.spec_version,
    exact_match_fingerprint_sha256:
      input.exactMatch.match_fingerprint_sha256,
  });
  return {
    plan_sha256: input.plan.plan_sha256,
    prior_stage_sha256: input.stage.stage_sha256,
    candidate_key: input.stage.candidate_key,
    bundle_draft_id: input.stage.bundle_draft_id,
    old_upc_pool_id: input.stage.upc_pool_id,
    old_upc: input.stage.upc,
    exact_match: input.exactMatch,
    confirmation_sha256: confirmationSha256,
    internal_database_mutated: false,
    marketplace_mutated: false,
  };
}

function isPilotImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443" || url.port === "8443") &&
      !url.search &&
      !url.hash &&
      /\.(?:jpe?g|png)$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function cleanPlainText(value: string, label: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) throw new WalmartNewSkuPlanError([`${label}_MISSING`]);
  return cleaned;
}

function assertLength(value: string, max: number, label: string): string {
  if (value.length > max) {
    throw new WalmartNewSkuPlanError([
      `${label}_TOO_LONG:${value.length}>${max}`,
    ]);
  }
  return value;
}

function contentIdentityLabel(
  component: ProductTruthRecipeComponentEvidence,
): string {
  return cleanPlainText(component.product_name, "PRODUCT_NAME")
    .replace(/[.,;:!\s]+$/g, "")
    .trim();
}

/**
 * Produce conservative copy directly from the sealed exact-variant evidence.
 * No model, retailer harvest or inferred benefit/claim participates here.
 */
export function buildDeterministicWalmartMultipackContent(input: {
  component: ProductTruthRecipeComponentEvidence;
  packCount: number;
}): DeterministicWalmartContent {
  if (!WALMART_NEW_SKU_PILOT_PACK_COUNTS.includes(
    input.packCount as (typeof WALMART_NEW_SKU_PILOT_PACK_COUNTS)[number],
  )) {
    throw new WalmartNewSkuPlanError([
      `PILOT_PACK_COUNT_UNSUPPORTED:${input.packCount}`,
    ]);
  }
  if (input.component.qty !== input.packCount) {
    throw new WalmartNewSkuPlanError([
      `RECIPE_QTY_MISMATCH:${input.component.qty}!=${input.packCount}`,
    ]);
  }

  const identity = contentIdentityLabel(input.component);
  const brand = cleanPlainText(input.component.manufacturer_brand, "BRAND");
  const flavor = input.component.flavor
    ? cleanPlainText(input.component.flavor, "FLAVOR")
    : null;
  const title = assertLength(
    `${identity} (Pack of ${input.packCount})`,
    150,
    "WALMART_TITLE",
  );
  const bullets = [
    `Includes ${input.packCount} identical, new retail packages.`,
    `Exact manufacturer brand: ${brand}.`,
    flavor
      ? `Exact flavor or variant: ${flavor}.`
      : "Exact variant is shown in the product title and package images.",
    "Manufacturer ingredients and allergen details remain on each package.",
    `Multipack quantity is ${input.packCount}; the main image must show the same count.`,
  ].map((bullet, index) =>
    assertLength(cleanPlainText(bullet, `BULLET_${index + 1}`), 150, `BULLET_${index + 1}`),
  );
  const description = assertLength(
    cleanPlainText(
      `This listing contains ${input.packCount} identical, new retail packages of ${identity}. ` +
        "The brand, flavor or variant, package identity, ingredients, allergen information, " +
        "and label details must match the exact packages shown in the listing images.",
      "DESCRIPTION",
    ),
    4_000,
    "DESCRIPTION",
  );

  return {
    generator: "deterministic-product-truth-multipack/v1",
    title,
    bullets,
    description,
  };
}

function candidateKey(input: {
  donorProductId: string;
  canonicalVariantId: string;
  packCount: number;
}): string {
  return `wm-${sha256WalmartJson({
    donor_product_id: input.donorProductId,
    canonical_variant_id: input.canonicalVariantId,
    pack_count: input.packCount,
  }).slice(0, 16)}`;
}

const REQUIRED_BEFORE_CERTIFICATION: WalmartNewSkuPlanBlocker[] = [
  "COUNT_ACCURATE_RIGHTS_CLEARED_MAIN_IMAGE",
  "RIGHTS_CLEARED_SECONDARY_IMAGE",
  "OPERATOR_VERIFIED_PACKAGE_MEASUREMENTS",
  "EXACT_UPC_CATALOG_SEARCH",
  "SELLER_CATALOG_RECIPE_NOVELTY",
  "CURRENT_WALMART_GET_SPEC",
  "SELLER_ACCOUNT_HEALTH_AND_PUBLISH_ELIGIBILITY",
  "BRAND_RIGHTS_EVIDENCE",
  "CATEGORY_AND_SKU_POLICY_CLEARANCE",
  "CURRENT_RECALL_CHECK",
  "EXPIRATION_AND_LOT_PROCEDURE",
  "POSITIVE_VERIFIED_COMPONENT_INVENTORY",
  "EXPLICIT_DISTRIBUTION_APPROVAL",
];

function planHash(
  plan: Omit<WalmartNewSkuPlan, "plan_sha256">,
): string {
  return sha256WalmartJson(plan);
}

function assertCatalogAuthorityScope(input: {
  authority: unknown;
  storeIndex: number;
  businessSellerFingerprintSha256: string;
  label: string;
}): SealedWalmartSellerCatalogAuthorityBinding {
  let authority: SealedWalmartSellerCatalogAuthorityBinding;
  try {
    authority = verifyWalmartSellerCatalogAuthorityBinding(input.authority);
  } catch (error) {
    throw new WalmartNewSkuPlanError([
      `${input.label}_CATALOG_AUTHORITY_INVALID:${
        error instanceof Error ? error.message : String(error)
      }`,
    ]);
  }
  if (
    authority.account_scope.store_index !== input.storeIndex ||
    authority.account_scope.business_seller_account_fingerprint_sha256 !==
      input.businessSellerFingerprintSha256
  ) {
    throw new WalmartNewSkuPlanError([
      `${input.label}_CATALOG_AUTHORITY_SCOPE_MISMATCH`,
    ]);
  }
  return authority;
}

function expectedWaveId(value: Omit<WalmartNewSkuPlan, "plan_sha256" | "wave_id">): string {
  const datePart = value.created_at.slice(0, 10).replaceAll("-", "");
  const stableKeys = value.candidates
    .map((candidate) => candidate.candidate_key)
    .sort();
  return `WM-PILOT-${datePart}-${sha256WalmartJson({
    candidate_keys: stableKeys,
    created_at: value.created_at,
    as_of: value.as_of,
    store_index: value.store_index,
    seller_account_fingerprint_sha256:
      value.seller_account_fingerprint_sha256,
    zip: value.zip,
    max_live_submissions: value.max_live_submissions,
  }).slice(0, 8)}`;
}

export function assertWalmartNewSkuPlanIntegrity(
  value: WalmartNewSkuPlan,
): void {
  if (value.schema_version !== WALMART_NEW_SKU_PLAN_SCHEMA) {
    throw new WalmartNewSkuPlanError(["PLAN_SCHEMA_UNSUPPORTED"]);
  }
  const { plan_sha256: actual, ...unsigned } = value;
  const expected = planHash(unsigned);
  if (actual !== expected) {
    throw new WalmartNewSkuPlanError([
      `PLAN_HASH_MISMATCH:${actual || "missing"}!=${expected}`,
    ]);
  }
  if (value.marketplace_mutation_allowed !== false) {
    throw new WalmartNewSkuPlanError(["PLAN_CANNOT_AUTHORIZE_MARKETPLACE_MUTATION"]);
  }
  const createdAt = Date.parse(value.created_at);
  const asOf = Date.parse(value.as_of);
  if (
    value.phase !== "PILOT" ||
    !Number.isInteger(value.store_index) ||
    value.store_index !== 1 ||
    !/^[a-f0-9]{64}$/.test(value.seller_account_fingerprint_sha256) ||
    !/^[a-f0-9]{64}$/.test(value.doctor_receipt_sha256) ||
    !/^[a-f0-9]{64}$/.test(value.engine_release_sha256) ||
    !/^[a-f0-9]{64}$/.test(value.release_manifest_sha256) ||
    !/^[a-f0-9]{64}$/.test(value.database_target_fingerprint_sha256) ||
    !/^[a-f0-9]{64}$/.test(value.database_schema_sha256) ||
    !value.item_spec_version?.trim() ||
    value.zip !== "33765" ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(asOf) ||
    createdAt < asOf
  ) {
    throw new WalmartNewSkuPlanError(["PLAN_SCOPE_INVALID"]);
  }
  assertCatalogAuthorityScope({
    authority: value.seller_catalog_authority,
    storeIndex: value.store_index,
    businessSellerFingerprintSha256:
      value.seller_account_fingerprint_sha256,
    label: "PLAN",
  });
  if (
    value.max_live_submissions !== 1
  ) {
    throw new WalmartNewSkuPlanError(["PILOT_APPLY_LIMIT_INVALID"]);
  }
  if (
    !Array.isArray(value.candidates) ||
    value.candidates.length !== 1
  ) {
    throw new WalmartNewSkuPlanError(["PLAN_CANDIDATE_COUNT_INVALID"]);
  }
  const waveInput = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => key !== "plan_sha256" && key !== "wave_id",
    ),
  ) as Omit<WalmartNewSkuPlan, "plan_sha256" | "wave_id">;
  if (value.wave_id !== expectedWaveId(waveInput)) {
    throw new WalmartNewSkuPlanError(["PLAN_WAVE_ID_INVALID"]);
  }
  const keys = new Set<string>();
  for (const candidate of value.candidates) {
    if (keys.has(candidate.candidate_key)) {
      throw new WalmartNewSkuPlanError([
        `DUPLICATE_CANDIDATE:${candidate.candidate_key}`,
      ]);
    }
    keys.add(candidate.candidate_key);
    const component = candidate.recipe_input.components[0];
    if (
      candidate.recipe_input.components.length !== 1 ||
      component?.donor_product_id !== candidate.donor_product_id ||
      component?.canonical_variant_id !== candidate.canonical_variant_id ||
      component?.qty !== candidate.pack_count
    ) {
      throw new WalmartNewSkuPlanError([
        `CANDIDATE_RECIPE_DRIFT:${candidate.candidate_key}`,
      ]);
    }
    if (
      !WALMART_NEW_SKU_PILOT_PACK_COUNTS.includes(
        candidate.pack_count as (typeof WALMART_NEW_SKU_PILOT_PACK_COUNTS)[number],
      ) ||
      candidate.recipe_input.contractVersion !==
        PRODUCT_TRUTH_READ_CONTRACT_VERSION ||
      !Number.isFinite(candidate.recipe_input.price_max_age_ms) ||
      candidate.recipe_input.price_max_age_ms !== 24 * 60 * 60 * 1_000 ||
      component.price_evidence.locality_evidence !== "zip_scoped" ||
      component.price_evidence.zip !== value.zip
    ) {
      throw new WalmartNewSkuPlanError([
        `CANDIDATE_RECIPE_SCOPE_INVALID:${candidate.candidate_key}`,
      ]);
    }
    const expectedKey = candidateKey({
      donorProductId: candidate.donor_product_id,
      canonicalVariantId: candidate.canonical_variant_id,
      packCount: candidate.pack_count,
    });
    if (candidate.candidate_key !== expectedKey) {
      throw new WalmartNewSkuPlanError([
        `CANDIDATE_KEY_DRIFT:${candidate.candidate_key}`,
      ]);
    }
    if (
      candidate.recipe_input.as_of !== value.as_of ||
      candidate.recipe_input.zip !== value.zip
    ) {
      throw new WalmartNewSkuPlanError([
        `CANDIDATE_RECIPE_SCOPE_DRIFT:${candidate.candidate_key}`,
      ]);
    }
    if (
      candidate.source_candidate.donor_product_id !== component.donor_product_id ||
      candidate.source_candidate.canonical_variant_id !== component.canonical_variant_id ||
      candidate.source_candidate.content_observation_id !==
        component.content_observation_id ||
      candidate.source_candidate.price_observation_id !==
        component.price_evidence.observation_id ||
      candidate.source_candidate.brand !== component.manufacturer_brand ||
      candidate.source_candidate.title !== component.product_name ||
      candidate.source_candidate.flavor !== component.flavor ||
      candidate.source_candidate.manufacturer_upc !== component.manufacturer_upc
    ) {
      throw new WalmartNewSkuPlanError([
        `CANDIDATE_SOURCE_DRIFT:${candidate.candidate_key}`,
      ]);
    }
    const expectedContent = buildDeterministicWalmartMultipackContent({
      component,
      packCount: candidate.pack_count,
    });
    if (stableWalmartJson(candidate.content) !== stableWalmartJson(expectedContent)) {
      throw new WalmartNewSkuPlanError([
        `CANDIDATE_CONTENT_DRIFT:${candidate.candidate_key}`,
      ]);
    }
    if (
      stableWalmartJson(candidate.required_before_certification) !==
      stableWalmartJson(REQUIRED_BEFORE_CERTIFICATION)
    ) {
      throw new WalmartNewSkuPlanError([
        `CANDIDATE_GATE_DRIFT:${candidate.candidate_key}`,
      ]);
    }
  }
}

function deterministicEngineId(prefix: string, seed: unknown, length = 24): string {
  return `${prefix}-${sha256WalmartJson(seed).slice(0, length)}`;
}

export function buildWalmartNewSkuStagePreview(input: {
  plan: WalmartNewSkuPlan;
  candidateKey: string;
}): WalmartNewSkuStagePreview {
  assertWalmartNewSkuPlanIntegrity(input.plan);
  const candidate = input.plan.candidates.find(
    (item) => item.candidate_key === input.candidateKey,
  );
  if (!candidate) {
    throw new WalmartNewSkuPlanError([
      `CANDIDATE_NOT_IN_PLAN:${input.candidateKey}`,
    ]);
  }
  const seed = {
    channel: "WALMART",
    store_index: input.plan.store_index,
    candidate_key: candidate.candidate_key,
  };
  const skuHash = sha256WalmartJson(seed).toUpperCase();
  return {
    schema_version: WALMART_NEW_SKU_STAGE_SCHEMA,
    wave_id: input.plan.wave_id,
    plan_sha256: input.plan.plan_sha256,
    candidate_key: candidate.candidate_key,
    store_index: input.plan.store_index,
    generation_job_id: deterministicEngineId(
      "wmjob",
      { wave_id: input.plan.wave_id, plan_sha256: input.plan.plan_sha256 },
    ),
    bundle_draft_id: deterministicEngineId("wmdraft", seed),
    proposed_sku: `WM-${skuHash.slice(0, 4)}-${skuHash.slice(4, 8)}`,
    marketplace_mutation_allowed: false,
  };
}

function stageHash(
  value: Omit<WalmartNewSkuStageArtifact, "stage_sha256">,
): string {
  return sha256WalmartJson(value);
}

export function sealWalmartNewSkuStageArtifact(
  input: Omit<WalmartNewSkuStageArtifact, "stage_sha256">,
): WalmartNewSkuStageArtifact {
  if (!/^\d{12}$/.test(input.upc)) {
    throw new WalmartNewSkuPlanError(["STAGE_UPC_NOT_UPCA"]);
  }
  if (!input.staged_by.trim()) {
    throw new WalmartNewSkuPlanError(["STAGE_ACTOR_MISSING"]);
  }
  const artifact = { ...input, stage_sha256: stageHash(input) };
  assertWalmartNewSkuStageArtifactIntegrity(artifact);
  return artifact;
}

export function assertWalmartNewSkuStageArtifactIntegrity(
  artifact: WalmartNewSkuStageArtifact,
  plan?: WalmartNewSkuPlan,
): void {
  if (artifact.schema_version !== WALMART_NEW_SKU_STAGE_SCHEMA) {
    throw new WalmartNewSkuPlanError(["STAGE_SCHEMA_UNSUPPORTED"]);
  }
  const { stage_sha256: actual, ...unsigned } = artifact;
  const expected = stageHash(unsigned);
  if (actual !== expected) {
    throw new WalmartNewSkuPlanError([
      `STAGE_HASH_MISMATCH:${actual || "missing"}!=${expected}`,
    ]);
  }
  if (artifact.marketplace_mutation_allowed !== false) {
    throw new WalmartNewSkuPlanError([
      "STAGE_CANNOT_AUTHORIZE_MARKETPLACE_MUTATION",
    ]);
  }
  if (
    !/^WM-PILOT-\d{8}-[a-f0-9]{8}$/.test(artifact.wave_id) ||
    !/^[a-f0-9]{64}$/.test(artifact.plan_sha256) ||
    !Number.isInteger(artifact.store_index) ||
    artifact.store_index <= 0 ||
    !artifact.candidate_key?.trim() ||
    !artifact.generation_job_id?.trim() ||
    !artifact.bundle_draft_id?.trim() ||
    !artifact.upc_pool_id?.trim() ||
    !artifact.staged_by?.trim() ||
    artifact.state !== "UPC_RESERVED"
  ) {
    throw new WalmartNewSkuPlanError(["STAGE_IDENTITY_INVALID"]);
  }
  if (!/^WM-[A-F0-9]{4}-[A-F0-9]{4}$/.test(artifact.proposed_sku)) {
    throw new WalmartNewSkuPlanError(["STAGE_SKU_FORMAT_INVALID"]);
  }
  if (!isValidOwnerPoolUpca(artifact.upc)) {
    throw new WalmartNewSkuPlanError(["STAGE_UPC_NOT_VALID_UPCA"]);
  }
  const stagedAt = Date.parse(artifact.staged_at);
  const reservedUntil = Date.parse(artifact.upc_reserved_until);
  if (
    !Number.isFinite(stagedAt) ||
    !Number.isFinite(reservedUntil) ||
    reservedUntil <= stagedAt
  ) {
    throw new WalmartNewSkuPlanError(["STAGE_UPC_RESERVATION_INVALID"]);
  }
  if (plan) {
    assertWalmartNewSkuPlanIntegrity(plan);
    const preview = buildWalmartNewSkuStagePreview({
      plan,
      candidateKey: artifact.candidate_key,
    });
    for (const key of [
      "wave_id",
      "plan_sha256",
      "store_index",
      "generation_job_id",
      "bundle_draft_id",
      "proposed_sku",
    ] as const) {
      if (artifact[key] !== preview[key]) {
        throw new WalmartNewSkuPlanError([`STAGE_PLAN_DRIFT:${key}`]);
      }
    }
  }
}

export function sealWalmartNewSkuUpcRotationReceipt(
  input: Omit<WalmartNewSkuUpcRotationReceipt, "receipt_sha256">,
  plan: WalmartNewSkuPlan,
  priorStage: WalmartNewSkuStageArtifact,
): WalmartNewSkuUpcRotationReceipt {
  const receipt = {
    ...input,
    receipt_sha256: sha256WalmartJson(input),
  };
  assertWalmartNewSkuUpcRotationReceiptIntegrity(receipt, plan, priorStage);
  return receipt;
}

export function assertWalmartNewSkuUpcRotationReceiptIntegrity(
  receipt: WalmartNewSkuUpcRotationReceipt,
  plan: WalmartNewSkuPlan,
  priorStage: WalmartNewSkuStageArtifact,
): void {
  assertWalmartNewSkuStageArtifactIntegrity(priorStage, plan);
  assertWalmartNewSkuStageArtifactIntegrity(receipt.new_stage, plan);
  if (
    receipt.schema_version !== WALMART_NEW_SKU_UPC_ROTATION_RECEIPT_SCHEMA
  ) {
    throw new WalmartNewSkuPlanError(["UPC_ROTATION_RECEIPT_SCHEMA_UNSUPPORTED"]);
  }
  const { receipt_sha256: actual, ...body } = receipt;
  assertReceiptHash(actual, body, "UPC_ROTATION_RECEIPT");
  const preview = buildWalmartNewSkuUpcRotationPreview({
    plan,
    stage: priorStage,
    exactMatch: receipt.exact_match,
  });
  const rotatedAt = Date.parse(receipt.rotated_at);
  const searchedAt = Date.parse(receipt.exact_match.searched_at);
  if (
    receipt.confirmation_sha256 !== preview.confirmation_sha256 ||
    receipt.plan_sha256 !== plan.plan_sha256 ||
    receipt.prior_stage_sha256 !== priorStage.stage_sha256 ||
    receipt.new_stage_sha256 !== receipt.new_stage.stage_sha256 ||
    receipt.candidate_key !== priorStage.candidate_key ||
    receipt.bundle_draft_id !== priorStage.bundle_draft_id ||
    receipt.retired_upc_pool_id !== priorStage.upc_pool_id ||
    receipt.retired_upc !== priorStage.upc ||
    receipt.retired_upc_status !== "RETIRED" ||
    receipt.retired_upc_disposition !== "FUTURE_MP_ITEM_MATCH" ||
    receipt.new_upc_pool_id !== receipt.new_stage.upc_pool_id ||
    receipt.new_upc !== receipt.new_stage.upc ||
    receipt.new_upc_status !== "RESERVED" ||
    receipt.new_upc_pool_id === receipt.retired_upc_pool_id ||
    receipt.new_upc === receipt.retired_upc ||
    receipt.new_stage.candidate_key !== priorStage.candidate_key ||
    receipt.new_stage.bundle_draft_id !== priorStage.bundle_draft_id ||
    receipt.new_stage.generation_job_id !== priorStage.generation_job_id ||
    receipt.new_stage.proposed_sku !== priorStage.proposed_sku ||
    receipt.new_stage.staged_at !== receipt.rotated_at ||
    receipt.new_stage.staged_by !== receipt.rotated_by ||
    !receipt.rotated_by.trim() ||
    !Number.isFinite(rotatedAt) ||
    !Number.isFinite(searchedAt) ||
    searchedAt > rotatedAt + 5 * 60_000 ||
    rotatedAt - searchedAt > 5 * 60_000 ||
    receipt.internal_database_mutated !== true ||
    receipt.marketplace_mutated !== false
  ) {
    throw new WalmartNewSkuPlanError(["UPC_ROTATION_RECEIPT_BINDING_INVALID"]);
  }
}

export function assertWalmartNewSkuCertificationInput(input: {
  certification: WalmartNewSkuCertificationInput;
  plan: WalmartNewSkuPlan;
  stage: WalmartNewSkuStageArtifact;
  now?: Date;
}): void {
  const { certification, plan, stage } = input;
  const now = input.now ?? new Date();
  assertWalmartNewSkuPlanIntegrity(plan);
  assertWalmartNewSkuStageArtifactIntegrity(stage, plan);
  const failures: string[] = [];
  if (certification.schema_version !== WALMART_NEW_SKU_CERTIFICATION_INPUT_SCHEMA) {
    failures.push("CERTIFICATION_INPUT_SCHEMA_UNSUPPORTED");
  }
  if (certification.wave_id !== plan.wave_id) failures.push("CERTIFICATION_WAVE_MISMATCH");
  if (certification.candidate_key !== stage.candidate_key) {
    failures.push("CERTIFICATION_CANDIDATE_MISMATCH");
  }
  if (certification.stage_sha256 !== stage.stage_sha256) {
    failures.push("CERTIFICATION_STAGE_HASH_MISMATCH");
  }
  if (hasPlaceholder(certification)) failures.push("CERTIFICATION_PLACEHOLDER_PRESENT");
  if (!Number.isSafeInteger(certification.price_cents) || certification.price_cents <= 0) {
    failures.push("CERTIFICATION_PRICE_INVALID");
  }
  if (
    !Number.isSafeInteger(certification.packaging_cost_cents) ||
    certification.packaging_cost_cents <= 0 ||
    !Number.isSafeInteger(certification.shipping_label_cents) ||
    certification.shipping_label_cents < 0 ||
    typeof certification.shipping_in_price !== "boolean"
  ) {
    failures.push("CERTIFICATION_COST_BASIS_INVALID");
  }
  const allowedEvidenceKinds = new Set<WalmartNewSkuEvidenceArtifactKind>([
    "IMAGE_RIGHTS",
    "COUNTRY_OF_ORIGIN",
    "PRODUCT_ATTRIBUTE",
    "CATEGORY_APPROVAL",
    "POLICY_REVIEW",
    "RECALL_CHECK",
    "BRAND_RIGHTS",
    "SELLER_ACCOUNT_HEALTH",
    "LOT_CONTROL_PROCEDURE",
    "EXPIRATION_SOURCE",
  ]);
  const evidenceByRef = new Map<string, WalmartNewSkuEvidenceArtifactInput>();
  if (
    !Array.isArray(certification.evidence_artifacts) ||
    certification.evidence_artifacts.length === 0
  ) {
    failures.push("CERTIFICATION_EVIDENCE_ARTIFACTS_REQUIRED");
  } else {
    for (const [index, evidence] of certification.evidence_artifacts.entries()) {
      const pathIsAbsolute =
        typeof evidence?.path === "string" &&
        (evidence.path.startsWith("/") || /^file:\/\//i.test(evidence.path));
      if (
        !evidence ||
        !isEvidenceReference(evidence.ref) ||
        !allowedEvidenceKinds.has(evidence.kind) ||
        !pathIsAbsolute ||
        !/^[a-f0-9]{64}$/.test(evidence.sha256) ||
        !Number.isSafeInteger(evidence.byte_size) ||
        evidence.byte_size <= 0 ||
        evidence.byte_size > 25 * 1024 * 1024 ||
        !isFreshPastIso(evidence.captured_at, ACCOUNT_EVIDENCE_MAX_AGE_MS, now) ||
        !(
          evidence.source_url === null ||
          (typeof evidence.source_url === "string" &&
            /^https:\/\/\S+$/i.test(evidence.source_url))
        )
      ) {
        failures.push(`EVIDENCE_ARTIFACT_${index}_INVALID`);
        continue;
      }
      if (evidenceByRef.has(evidence.ref)) {
        failures.push(`EVIDENCE_ARTIFACT_${index}_REF_DUPLICATE`);
      } else {
        evidenceByRef.set(evidence.ref, evidence);
      }
    }
  }
  const requiredEvidence = new Map<string, WalmartNewSkuEvidenceArtifactKind>();
  const requireEvidence = (
    ref: unknown,
    kind: WalmartNewSkuEvidenceArtifactKind,
    label: string,
  ) => {
    if (!isEvidenceReference(ref)) return;
    const existing = requiredEvidence.get(ref);
    if (existing && existing !== kind) {
      failures.push(`${label}_EVIDENCE_KIND_CONFLICT`);
      return;
    }
    requiredEvidence.set(ref, kind);
  };
  const candidate = plan.candidates.find(
    (item) => item.candidate_key === stage.candidate_key,
  )!;
  const component = candidate.recipe_input.components[0];
  const componentKeys = new Set([component.component_key]);
  const observationIds = new Set([component.content_observation_id]);
  const main = certification.images.filter((image) => image.role === "MAIN");
  const secondary = certification.images.filter((image) => image.role !== "MAIN");
  if (main.length !== 1) failures.push("CERTIFICATION_MAIN_IMAGE_COUNT_INVALID");
  if (secondary.length < 1) failures.push("CERTIFICATION_SECONDARY_IMAGE_REQUIRED");
  const urls = new Set<string>();
  for (const [index, image] of certification.images.entries()) {
    if (!isPilotImageUrl(image.url)) failures.push(`IMAGE_${index}_URL_INVALID`);
    if (urls.has(image.url)) failures.push(`IMAGE_${index}_URL_DUPLICATE`);
    urls.add(image.url);
    if (
      image.depicted_component_keys.length === 0 ||
      image.depicted_component_keys.some((key) => !componentKeys.has(key))
    ) {
      failures.push(`IMAGE_${index}_COMPONENT_LINEAGE_INVALID`);
    }
    if (
      image.source_content_observation_ids.length === 0 ||
      image.source_content_observation_ids.some((id) => !observationIds.has(id))
    ) {
      failures.push(`IMAGE_${index}_OBSERVATION_LINEAGE_INVALID`);
    }
    if (!Number.isInteger(image.represented_unit_count) || image.represented_unit_count <= 0) {
      failures.push(`IMAGE_${index}_COUNT_INVALID`);
    }
    if (![
      "OWNED",
      "LICENSED",
      "SOURCE_ALLOWED",
      "AI_DERIVED_FROM_RIGHTS_CLEARED_INPUTS",
    ].includes(image.rights_basis)) {
      failures.push(`IMAGE_${index}_RIGHTS_BASIS_INVALID`);
    }
    if (!isEvidenceReference(image.rights_evidence_ref)) {
      failures.push(`IMAGE_${index}_RIGHTS_REF_INVALID`);
    } else {
      requireEvidence(
        image.rights_evidence_ref,
        "IMAGE_RIGHTS",
        `IMAGE_${index}_RIGHTS`,
      );
    }
    if (!isFreshPastIso(image.reviewed_at, ACCOUNT_EVIDENCE_MAX_AGE_MS, now)) {
      failures.push(`IMAGE_${index}_REVIEW_DATE_INVALID`);
    }
  }
  if (main[0]?.represented_unit_count !== candidate.pack_count) {
    failures.push("CERTIFICATION_MAIN_IMAGE_RECIPE_COUNT_MISMATCH");
  }
  const physical = certification.physical_package;
  if (
    physical.schema_version !== "bundle-factory.verified-physical-package/v1" ||
    physical.source !== "OPERATOR_SHIP_SPECS" ||
    !isFreshPastIso(physical.verified_at, ACCOUNT_EVIDENCE_MAX_AGE_MS, now) ||
    [physical.weight_oz, physical.length_in, physical.width_in, physical.height_in]
      .some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    failures.push("CERTIFICATION_PHYSICAL_PACKAGE_INVALID");
  }
  if (
    !certification.walmart.product_type.trim() ||
    PLACEHOLDER_TEXT.test(certification.walmart.product_type)
  ) failures.push("PRODUCT_TYPE_MISSING");
  if (
    !certification.walmart.country_of_origin_substantial_transformation.trim() ||
    PLACEHOLDER_TEXT.test(
      certification.walmart.country_of_origin_substantial_transformation,
    )
  ) {
    failures.push("COUNTRY_OF_ORIGIN_MISSING");
  }
  if (
    !certification.walmart.public_attributes ||
    typeof certification.walmart.public_attributes !== "object" ||
    Array.isArray(certification.walmart.public_attributes)
  ) {
    failures.push("PUBLIC_ATTRIBUTES_INVALID");
  } else {
    const quantityKeys = new Set(["multipackQuantity", "countPerPack", "count"]);
    const evidence = certification.walmart.public_attribute_evidence;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      failures.push("PUBLIC_ATTRIBUTE_EVIDENCE_INVALID");
    } else {
      const publicKeys = Object.keys(certification.walmart.public_attributes);
      for (const key of publicKeys) {
        if (quantityKeys.has(key)) continue;
        const row = evidence[key];
        if (!row) {
          failures.push(`PUBLIC_ATTRIBUTE_${key}_EVIDENCE_MISSING`);
          continue;
        }
        const sourceValue = getCertificationSourcePath(
          component,
          physical,
          row.source,
          row.source_path,
        );
        if (
          sourceValue === undefined ||
          stableWalmartJson(sourceValue) !==
            stableWalmartJson(certification.walmart.public_attributes[key]) ||
          !isEvidenceReference(row.evidence_ref)
        ) {
          failures.push(`PUBLIC_ATTRIBUTE_${key}_EVIDENCE_MISMATCH`);
        } else {
          requireEvidence(
            row.evidence_ref,
            "PRODUCT_ATTRIBUTE",
            `PUBLIC_ATTRIBUTE_${key}`,
          );
        }
      }
      for (const key of Object.keys(evidence)) {
        if (!(key in certification.walmart.public_attributes) || quantityKeys.has(key)) {
          failures.push(`PUBLIC_ATTRIBUTE_${key}_EVIDENCE_ORPHANED`);
        }
      }
    }
  }
  const country = certification.walmart.country_of_origin_evidence;
  if (
    !country ||
    country.canonical_variant_id !== component.canonical_variant_id ||
    country.content_observation_id !== component.content_observation_id ||
    country.value.trim().toLowerCase() !==
      certification.walmart.country_of_origin_substantial_transformation
        .trim()
        .toLowerCase() ||
    !["PRODUCT_LABEL", "MANUFACTURER_DOCUMENT", "AUTHORIZED_BRAND_RECORD"]
      .includes(country.source) ||
    !isEvidenceReference(country.evidence_ref) ||
    !isFreshPastIso(country.verified_at, ACCOUNT_EVIDENCE_MAX_AGE_MS, now)
  ) {
    failures.push("COUNTRY_OF_ORIGIN_EVIDENCE_INVALID");
  } else {
    requireEvidence(
      country.evidence_ref,
      "COUNTRY_OF_ORIGIN",
      "COUNTRY_OF_ORIGIN",
    );
  }
  const handoff = certification.walmart.offer_handoff;
  if (
    handoff.mode !== "INLINE" ||
    handoff.quantity !== 1 ||
    !handoff.fulfillment_center_id.trim() ||
    PLACEHOLDER_TEXT.test(handoff.fulfillment_center_id) ||
    !Number.isInteger(handoff.fulfillment_lag_time) ||
    handoff.fulfillment_lag_time < 0 ||
    handoff.fulfillment_lag_time > 9
  ) {
    failures.push("PILOT_OFFER_HANDOFF_INVALID");
  }
  const manual = certification.prepublication;
  if (
    manual.seller_account_health?.status !==
      "HEALTHY_AND_ACCEPTING_NEW_ITEMS" ||
    manual.seller_account_health?.store_index !== plan.store_index ||
    manual.seller_account_health?.seller_account_fingerprint_sha256 !==
      plan.seller_account_fingerprint_sha256 ||
    !isFreshPastIso(
      manual.seller_account_health?.verified_at,
      SELLER_ACCOUNT_HEALTH_MAX_AGE_MS,
      now,
    ) ||
    !isEvidenceReference(manual.seller_account_health?.evidence_ref)
  ) {
    failures.push("SELLER_ACCOUNT_HEALTH_EVIDENCE_INVALID");
  } else {
    requireEvidence(
      manual.seller_account_health.evidence_ref,
      "SELLER_ACCOUNT_HEALTH",
      "SELLER_ACCOUNT_HEALTH",
    );
  }
  if (
    !Array.isArray(manual.category_approvals) ||
    manual.category_approvals.length === 0 ||
    manual.category_approvals.some(
      (approval) =>
        !approval.scope.trim() ||
        !["APPROVED", "NOT_REQUIRED"].includes(approval.status) ||
        !isFreshPastIso(
          approval.verified_at,
          ACCOUNT_EVIDENCE_MAX_AGE_MS,
          now,
        ) ||
        !isEvidenceReference(approval.evidence_ref),
    ) ||
    !manual.category_approvals.some(
      (approval) =>
        approval.scope === "INGESTIBLE_PRODUCTS" &&
        approval.status === "APPROVED",
    )
  ) {
    failures.push("INGESTIBLE_PRODUCTS_APPROVAL_MISSING");
  } else {
    for (const approval of manual.category_approvals) {
      requireEvidence(
        approval.evidence_ref,
        "CATEGORY_APPROVAL",
        "CATEGORY_APPROVAL",
      );
    }
  }
  if (
    manual.brand_rights.brand.trim().toLowerCase() !==
      component.manufacturer_brand.trim().toLowerCase() ||
    !["BRAND_OWNER", "AUTHORIZED_RESELLER"].includes(manual.brand_rights.basis) ||
    !isFreshPastIso(
      manual.brand_rights.verified_at,
      ACCOUNT_EVIDENCE_MAX_AGE_MS,
      now,
    ) ||
    !isEvidenceReference(manual.brand_rights.evidence_ref)
  ) {
    failures.push("FULL_ITEM_BRAND_RIGHTS_INVALID");
  } else {
    requireEvidence(
      manual.brand_rights.evidence_ref,
      "BRAND_RIGHTS",
      "BRAND_RIGHTS",
    );
  }
  if (
    manual.condition.value !== "New" ||
    !isFreshPastIso(
      manual.condition.verified_at,
      ACCOUNT_EVIDENCE_MAX_AGE_MS,
      now,
    ) ||
    manual.sku_policy_review.status !== "CLEARED" ||
    !isFreshPastIso(
      manual.sku_policy_review.reviewed_at,
      POLICY_REVIEW_MAX_AGE_MS,
      now,
    ) ||
    !isEvidenceReference(manual.sku_policy_review.evidence_ref) ||
    manual.recall_check.status !== "CLEAR" ||
    !isFreshPastIso(
      manual.recall_check.checked_at,
      RECALL_CHECK_MAX_AGE_MS,
      now,
    ) ||
    !manual.recall_check.source.trim() ||
    PLACEHOLDER_TEXT.test(manual.recall_check.source) ||
    !isEvidenceReference(manual.recall_check.evidence_ref)
  ) {
    failures.push("MANUAL_POLICY_EVIDENCE_INVALID");
  } else {
    requireEvidence(
      manual.sku_policy_review.evidence_ref,
      "POLICY_REVIEW",
      "SKU_POLICY_REVIEW",
    );
    requireEvidence(
      manual.recall_check.evidence_ref,
      "RECALL_CHECK",
      "RECALL_CHECK",
    );
  }
  if (
    manual.expiration.applicable !== true ||
    manual.expiration.shelf_life_days < 30 ||
    manual.expiration.minimum_days_remaining_at_ship < 30 ||
    !isEvidenceReference(manual.expiration.lot_check_procedure_ref) ||
    !isEvidenceReference(manual.expiration.source_ref) ||
    !isFreshPastIso(
      manual.expiration.verified_at,
      ACCOUNT_EVIDENCE_MAX_AGE_MS,
      now,
    )
  ) {
    failures.push("EXPIRATION_CONTROL_INVALID");
  } else {
    requireEvidence(
      manual.expiration.lot_check_procedure_ref,
      "LOT_CONTROL_PROCEDURE",
      "LOT_CONTROL_PROCEDURE",
    );
    requireEvidence(
      manual.expiration.source_ref,
      "EXPIRATION_SOURCE",
      "EXPIRATION_SOURCE",
    );
  }
  for (const [ref, kind] of requiredEvidence) {
    const artifact = evidenceByRef.get(ref);
    if (!artifact) failures.push(`EVIDENCE_ARTIFACT_MISSING:${ref}`);
    else if (artifact.kind !== kind) {
      failures.push(`EVIDENCE_ARTIFACT_KIND_MISMATCH:${ref}:${artifact.kind}!=${kind}`);
    }
  }
  for (const ref of evidenceByRef.keys()) {
    if (!requiredEvidence.has(ref)) failures.push(`EVIDENCE_ARTIFACT_ORPHANED:${ref}`);
  }
  if (failures.length > 0) throw new WalmartNewSkuPlanError(failures);
}

/** Exact operator evidence fingerprint used by the preview/confirmation gate. */
export function hashWalmartNewSkuCertificationInput(
  certification: WalmartNewSkuCertificationInput,
): string {
  return sha256WalmartJson(certification);
}

function certificationHash(
  input: Omit<WalmartNewSkuCertificationArtifact, "certification_sha256">,
): string {
  return sha256WalmartJson(input);
}

export function sealWalmartNewSkuDoctorReceipt(
  input: Omit<WalmartNewSkuDoctorReceipt, "receipt_sha256">,
): WalmartNewSkuDoctorReceipt {
  const receipt = { ...input, receipt_sha256: sha256WalmartJson(input) };
  assertWalmartNewSkuDoctorReceiptIntegrity(receipt, new Date(input.checked_at));
  return receipt;
}

export function assertWalmartNewSkuDoctorReceiptIntegrity(
  receipt: WalmartNewSkuDoctorReceipt,
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { receipt_sha256: actual, ...unsigned } = receipt;
  const expected = sha256WalmartJson(unsigned);
  const checkedAt = Date.parse(receipt.checked_at);
  const expiresAt = Date.parse(receipt.expires_at);
  const planningAsOf = Date.parse(receipt.planning_scope?.as_of ?? "");
  const nowMs = now.getTime();
  const digestFields = [
    actual,
    receipt.seller_account_fingerprint_sha256,
    receipt.database_target_fingerprint_sha256,
    receipt.database_schema_sha256,
    receipt.engine_release_sha256,
    receipt.expected_engine_release_sha256,
    receipt.release_manifest_sha256,
    receipt.owner_permit_public_key_spki_sha256,
    receipt.walmart_api_probe?.upc_sha256,
    receipt.walmart_api_probe?.response_sha256,
  ];
  const ownerTrust = inspectWalmartOwnerPermitTrustRoot(env);
  const catalogAuthority = assertCatalogAuthorityScope({
    authority: receipt.seller_catalog_authority,
    storeIndex: receipt.store_index,
    businessSellerFingerprintSha256:
      receipt.seller_account_fingerprint_sha256,
    label: "DOCTOR",
  });
  const catalogFreshnessInstants = [
    catalogAuthority.source_artifact.cutoff_at,
    catalogAuthority.source_artifact.downloaded_at,
    catalogAuthority.mirror_reconciliation.synced_at,
    catalogAuthority.walmart_report_diagnostic.downloaded_at,
  ].map((value) => Date.parse(value));
  if (
    receipt.schema_version !== WALMART_NEW_SKU_DOCTOR_RECEIPT_SCHEMA ||
    actual !== expected ||
    digestFields.some((value) => !/^[a-f0-9]{64}$/.test(value ?? "")) ||
    receipt.expected_engine_release_sha256 !== receipt.engine_release_sha256 ||
    receipt.frozen_release_verified !== true ||
    receipt.frozen_release_source_modes_verified !== true ||
    !Number.isInteger(receipt.store_index) ||
    receipt.store_index !== 1 ||
    !Number.isFinite(planningAsOf) ||
    planningAsOf > checkedAt ||
    checkedAt - planningAsOf > 15 * 60_000 ||
    receipt.planning_scope?.zip !== "33765" ||
    receipt.planning_scope?.max_price_age_ms !== 86_400_000 ||
    receipt.planning_scope?.limit !== 1 ||
    (receipt.planning_scope?.pack_count !== 2 &&
      receipt.planning_scope?.pack_count !== 3) ||
    !receipt.item_spec_version?.trim() ||
    !/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(receipt.owner_permit_key_id ?? "") ||
    ownerTrust.active_key_ids.length !== 1 ||
    ownerTrust.active_key_ids[0] !== receipt.owner_permit_key_id ||
    ownerTrust.active_key_fingerprints[0] !==
      receipt.owner_permit_public_key_spki_sha256 ||
    !Number.isFinite(checkedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= checkedAt ||
    expiresAt - checkedAt > WALMART_NEW_SKU_DOCTOR_MAX_AGE_MS ||
    checkedAt > nowMs + 5 * 60_000 ||
    nowMs > expiresAt ||
    receipt.walmart_api_probe?.method !== "GET" ||
    receipt.walmart_api_probe?.path !== "/v3/items/walmart/search" ||
    receipt.walmart_api_probe?.response_format !== "SPEC" ||
    receipt.walmart_api_probe?.http_status !== 200 ||
    receipt.walmart_api_probe?.authenticated_catalog_read !== true ||
    receipt.product_truth_schema_ready !== true ||
    receipt.publish_lifecycle_schema_ready !== true ||
    !Number.isSafeInteger(receipt.upc_pool?.available) ||
    receipt.upc_pool.available <= 0 ||
    receipt.upc_pool.duplicate_draft_reservations !== 0 ||
    receipt.ready_for_plan !== true ||
    receipt.infrastructure_ready_for_pilot !== true ||
    receipt.ready_for_live_apply !== false ||
    !Array.isArray(receipt.blockers) ||
    receipt.blockers.length !== 0 ||
    receipt.claims?.read_only !== true ||
    receipt.claims?.provider_calls !== 0 ||
    receipt.claims?.marketplace_mutated !== false ||
    receipt.claims?.listing_published !== false ||
    receipt.claims?.migration_applied !== false ||
    receipt.claims?.backfill_performed !== false ||
    catalogFreshnessInstants.some((instant) =>
      !Number.isFinite(instant) ||
      instant > nowMs ||
      nowMs - instant > WALMART_SELLER_CATALOG_AUTHORITY_MAX_AGE_MS
    )
  ) {
    throw new WalmartNewSkuPlanError(["DOCTOR_RECEIPT_INVALID_OR_STALE"]);
  }
}

export function sealWalmartNewSkuCertificationArtifact(
  input: Omit<WalmartNewSkuCertificationArtifact, "certification_sha256">,
): WalmartNewSkuCertificationArtifact {
  const artifact = { ...input, certification_sha256: certificationHash(input) };
  assertWalmartNewSkuCertificationArtifactIntegrity(artifact);
  return artifact;
}

export function assertWalmartNewSkuCertificationArtifactIntegrity(
  artifact: WalmartNewSkuCertificationArtifact,
): void {
  if (artifact.schema_version !== WALMART_NEW_SKU_CERTIFICATION_SCHEMA) {
    throw new WalmartNewSkuPlanError(["CERTIFICATION_SCHEMA_UNSUPPORTED"]);
  }
  const { certification_sha256: actual, ...unsigned } = artifact;
  const expected = certificationHash(unsigned);
  if (actual !== expected) {
    throw new WalmartNewSkuPlanError([
      `CERTIFICATION_HASH_MISMATCH:${actual || "missing"}!=${expected}`,
    ]);
  }
  if (artifact.validation_status !== "PASSED") {
    throw new WalmartNewSkuPlanError(["CERTIFICATION_NOT_PASSED"]);
  }
  if (artifact.marketplace_mutation_allowed !== false) {
    throw new WalmartNewSkuPlanError([
      "CERTIFICATION_CANNOT_AUTHORIZE_MARKETPLACE_MUTATION",
    ]);
  }
  if (!/^WM-PILOT-\d{8}-[a-f0-9]{8}$/.test(artifact.wave_id)) {
    throw new WalmartNewSkuPlanError(["CERTIFICATION_WAVE_ID_INVALID"]);
  }
  if (!Number.isInteger(artifact.store_index) || artifact.store_index <= 0) {
    throw new WalmartNewSkuPlanError(["CERTIFICATION_STORE_INDEX_INVALID"]);
  }
  assertCatalogAuthorityScope({
    authority: artifact.seller_catalog_authority,
    storeIndex: artifact.store_index,
    businessSellerFingerprintSha256:
      artifact.seller_account_fingerprint_sha256,
    label: "CERTIFICATION",
  });
  for (const [name, value] of [
    ["candidate_key", artifact.candidate_key],
    ["bundle_draft_id", artifact.bundle_draft_id],
    ["master_bundle_id", artifact.master_bundle_id],
    ["channel_sku_id", artifact.channel_sku_id],
    ["validation_run_id", artifact.validation_run_id],
    ["catalog_search_evidence_ref", artifact.catalog_search_evidence_ref],
    [
      "seller_sku_absence_evidence_ref",
      artifact.seller_sku_absence_evidence_ref,
    ],
    [
      "seller_account_health_evidence_ref",
      artifact.seller_account_health_evidence_ref,
    ],
  ]) {
    if (typeof value !== "string" || !value.trim()) {
      throw new WalmartNewSkuPlanError([
        `CERTIFICATION_${name.toUpperCase()}_INVALID`,
      ]);
    }
  }
  if (!/^WM-[A-F0-9]{4}-[A-F0-9]{4}$/.test(artifact.sku)) {
    throw new WalmartNewSkuPlanError(["CERTIFICATION_SKU_INVALID"]);
  }
  if (!isValidOwnerPoolUpca(artifact.upc)) {
    throw new WalmartNewSkuPlanError(["CERTIFICATION_UPC_INVALID"]);
  }
  if (!Number.isFinite(Date.parse(artifact.certified_at))) {
    throw new WalmartNewSkuPlanError(["CERTIFICATION_TIMESTAMP_INVALID"]);
  }
  if (
    !Number.isFinite(Date.parse(artifact.seller_account_health_verified_at)) ||
    Date.parse(artifact.seller_account_health_verified_at) >
      Date.parse(artifact.certified_at)
  ) {
    throw new WalmartNewSkuPlanError([
      "CERTIFICATION_SELLER_ACCOUNT_HEALTH_TIMESTAMP_INVALID",
    ]);
  }
  const truth = artifact.product_truth_binding;
  if (
    !truth ||
    !truth.donor_product_id?.trim() ||
    !truth.canonical_variant_id?.trim() ||
    !truth.content_observation_id?.trim() ||
    !truth.price_observation_id?.trim() ||
    !Number.isInteger(truth.qty) ||
    truth.qty <= 0 ||
    !truth.zip?.trim() ||
    !Number.isSafeInteger(truth.price_max_age_ms) ||
    truth.price_max_age_ms <= 0 ||
    !/^[a-f0-9]{64}$/.test(truth.component_sha256)
  ) {
    throw new WalmartNewSkuPlanError([
      "CERTIFICATION_PRODUCT_TRUTH_BINDING_INVALID",
    ]);
  }
  for (const [name, value] of [
    ["plan_sha256", artifact.plan_sha256],
    [
      "seller_account_fingerprint_sha256",
      artifact.seller_account_fingerprint_sha256,
    ],
    ["stage_sha256", artifact.stage_sha256],
    ["certification_input_sha256", artifact.certification_input_sha256],
    ["payload_sha256", artifact.payload_sha256],
    ["product_truth_recipe_hash", artifact.product_truth_recipe_hash],
    ["item_spec_schema_sha256", artifact.item_spec_schema_sha256],
    ["source_evidence_sha256", artifact.source_evidence_sha256],
  ]) {
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new WalmartNewSkuPlanError([`${name.toUpperCase()}_INVALID`]);
    }
  }
}

function assertReceiptHash(
  actual: string,
  body: unknown,
  label: string,
): void {
  const expected = sha256WalmartJson(body);
  if (!/^[a-f0-9]{64}$/.test(actual) || actual !== expected) {
    throw new WalmartNewSkuPlanError([
      `${label}_HASH_MISMATCH:${actual || "missing"}!=${expected}`,
    ]);
  }
}

export function sealWalmartNewSkuCertificationReceipt(
  input: Omit<WalmartNewSkuCertificationReceipt, "receipt_sha256">,
  certification: WalmartNewSkuCertificationArtifact,
): WalmartNewSkuCertificationReceipt {
  const receipt = {
    ...input,
    receipt_sha256: sha256WalmartJson(input),
  };
  assertWalmartNewSkuCertificationReceiptIntegrity(receipt, certification);
  return receipt;
}

export function assertWalmartNewSkuCertificationReceiptIntegrity(
  receipt: WalmartNewSkuCertificationReceipt,
  certification: WalmartNewSkuCertificationArtifact,
): void {
  assertWalmartNewSkuCertificationArtifactIntegrity(certification);
  if (receipt.schema_version !== WALMART_NEW_SKU_CERTIFICATION_RECEIPT_SCHEMA) {
    throw new WalmartNewSkuPlanError(["CERTIFICATION_RECEIPT_SCHEMA_UNSUPPORTED"]);
  }
  const { receipt_sha256: actual, ...body } = receipt;
  assertReceiptHash(actual, body, "CERTIFICATION_RECEIPT");
  if (
    receipt.certification_sha256 !== certification.certification_sha256 ||
    receipt.captured_at !== certification.certified_at ||
    hashWalmartPayload(receipt.payload) !== certification.payload_sha256 ||
    sha256WalmartJson(receipt.sources) !== certification.source_evidence_sha256
  ) {
    throw new WalmartNewSkuPlanError(["CERTIFICATION_RECEIPT_BINDING_MISMATCH"]);
  }
}

export function sealWalmartNewSkuDryRunReceipt(
  input: Omit<WalmartNewSkuDryRunReceipt, "receipt_sha256">,
  certification: WalmartNewSkuCertificationArtifact,
  now?: Date,
): WalmartNewSkuDryRunReceipt {
  const receipt = {
    ...input,
    receipt_sha256: sha256WalmartJson(input),
  };
  assertWalmartNewSkuDryRunReceiptIntegrity(receipt, certification, now);
  return receipt;
}

export function assertWalmartNewSkuDryRunReceiptIntegrity(
  receipt: WalmartNewSkuDryRunReceipt,
  certification: WalmartNewSkuCertificationArtifact,
  now = new Date(),
): void {
  assertWalmartNewSkuCertificationArtifactIntegrity(certification);
  if (receipt.schema_version !== WALMART_NEW_SKU_DRY_RUN_RECEIPT_SCHEMA) {
    throw new WalmartNewSkuPlanError(["DRY_RUN_RECEIPT_SCHEMA_UNSUPPORTED"]);
  }
  const { receipt_sha256: actual, ...body } = receipt;
  assertReceiptHash(actual, body, "DRY_RUN_RECEIPT");
  if (
    receipt.certification_sha256 !== certification.certification_sha256 ||
    receipt.channel_sku_id !== certification.channel_sku_id ||
    receipt.sku !== certification.sku ||
    receipt.validation_status !== "PASSED" ||
    receipt.marketplace_mutated !== false ||
    receipt.payload_sha256 !== certification.payload_sha256 ||
    hashWalmartPayload(receipt.payload) !== certification.payload_sha256 ||
    receipt.live_spec_validation?.valid !== true ||
    receipt.live_spec_validation.schema_sha256 !==
      certification.item_spec_schema_sha256
  ) {
    throw new WalmartNewSkuPlanError(["DRY_RUN_RECEIPT_BINDING_MISMATCH"]);
  }
  if (
    !isFreshPastIso(
      receipt.replayed_at,
      WALMART_NEW_SKU_DRY_RUN_MAX_AGE_MS,
      now,
    ) ||
    !isFreshPastIso(
      receipt.live_spec_validation.fetched_at,
      WALMART_NEW_SKU_DRY_RUN_MAX_AGE_MS,
      now,
    ) ||
    !isFreshPastIso(
      certification.seller_account_health_verified_at,
      SELLER_ACCOUNT_HEALTH_MAX_AGE_MS,
      now,
    )
  ) {
    throw new WalmartNewSkuPlanError(["DRY_RUN_RECEIPT_STALE"]);
  }
}

export function sealWalmartNewSkuApprovalArtifact(
  input: Omit<WalmartNewSkuApprovalArtifact, "approval_sha256">,
  certification: WalmartNewSkuCertificationArtifact,
  certificationReceipt: WalmartNewSkuCertificationReceipt,
  dryRunReceipt: WalmartNewSkuDryRunReceipt,
  now?: Date,
): WalmartNewSkuApprovalArtifact {
  const artifact = {
    ...input,
    approval_sha256: sha256WalmartJson(input),
  };
  assertWalmartNewSkuApprovalArtifactIntegrity(
    artifact,
    certification,
    certificationReceipt,
    dryRunReceipt,
    now,
  );
  return artifact;
}

export function assertWalmartNewSkuApprovalArtifactIntegrity(
  artifact: WalmartNewSkuApprovalArtifact,
  certification: WalmartNewSkuCertificationArtifact,
  certificationReceipt: WalmartNewSkuCertificationReceipt,
  dryRunReceipt: WalmartNewSkuDryRunReceipt,
  now = new Date(),
): void {
  assertWalmartNewSkuCertificationReceiptIntegrity(
    certificationReceipt,
    certification,
  );
  assertWalmartNewSkuDryRunReceiptIntegrity(dryRunReceipt, certification, now);
  if (artifact.schema_version !== WALMART_NEW_SKU_APPROVAL_SCHEMA) {
    throw new WalmartNewSkuPlanError(["APPROVAL_SCHEMA_UNSUPPORTED"]);
  }
  const { approval_sha256: actual, ...body } = artifact;
  assertReceiptHash(actual, body, "APPROVAL");
  const approval = artifact.distribution_approval;
  if (
    artifact.certification_sha256 !== certification.certification_sha256 ||
    artifact.certification_receipt_sha256 !== certificationReceipt.receipt_sha256 ||
    artifact.dry_run_receipt_sha256 !== dryRunReceipt.receipt_sha256 ||
    artifact.candidate_key !== certification.candidate_key ||
    artifact.bundle_draft_id !== certification.bundle_draft_id ||
    artifact.channel_sku_id !== certification.channel_sku_id ||
    artifact.sku !== certification.sku ||
    artifact.payload_sha256 !== certification.payload_sha256 ||
    artifact.validation_run_id !== certification.validation_run_id ||
    artifact.live_apply_authorized !== true ||
    artifact.max_apply_skus !== 1 ||
    artifact.marketplace_mutation_performed !== false ||
    !artifact.approved_by.trim() ||
    approval.channel_sku_id !== artifact.channel_sku_id ||
    approval.validation_run_id !== artifact.validation_run_id ||
    approval.marketplace_payload_sha256 !== artifact.payload_sha256 ||
    !approval.approved_at ||
    !approval.approved_by
  ) {
    throw new WalmartNewSkuPlanError(["APPROVAL_BINDING_MISMATCH"]);
  }
  if (
    !isFreshPastIso(
      artifact.approved_at,
      WALMART_NEW_SKU_APPROVAL_MAX_AGE_MS,
      now,
    )
  ) {
    throw new WalmartNewSkuPlanError(["APPROVAL_STALE"]);
  }
}

export function sealWalmartNewSkuApplyReceipt(
  input: Omit<WalmartNewSkuApplyReceipt, "receipt_sha256">,
  approval: WalmartNewSkuApprovalArtifact,
): WalmartNewSkuApplyReceipt {
  if (
    input.schema_version !== WALMART_NEW_SKU_APPLY_RECEIPT_SCHEMA ||
    input.approval_sha256 !== approval.approval_sha256 ||
    input.certification_sha256 !== approval.certification_sha256 ||
    input.channel_sku_id !== approval.channel_sku_id ||
    input.sku !== approval.sku ||
    !Number.isFinite(Date.parse(input.requested_at)) ||
    input.marketplace_mutation_requested !== (input.mode === "LIVE")
  ) {
    throw new WalmartNewSkuPlanError(["APPLY_RECEIPT_BINDING_INVALID"]);
  }
  return { ...input, receipt_sha256: sha256WalmartJson(input) };
}

export function assertWalmartNewSkuApplyReceiptIntegrity(
  receipt: WalmartNewSkuApplyReceipt,
  approval: WalmartNewSkuApprovalArtifact,
): void {
  const { receipt_sha256: actual, ...unsigned } = receipt;
  if (
    receipt.schema_version !== WALMART_NEW_SKU_APPLY_RECEIPT_SCHEMA ||
    actual !== sha256WalmartJson(unsigned) ||
    !/^[a-f0-9]{64}$/.test(actual) ||
    receipt.approval_sha256 !== approval.approval_sha256 ||
    receipt.certification_sha256 !== approval.certification_sha256 ||
    receipt.channel_sku_id !== approval.channel_sku_id ||
    receipt.sku !== approval.sku ||
    !Number.isFinite(Date.parse(receipt.requested_at)) ||
    receipt.marketplace_mutation_requested !== (receipt.mode === "LIVE")
  ) {
    throw new WalmartNewSkuPlanError(["APPLY_RECEIPT_INTEGRITY_INVALID"]);
  }
}

/**
 * The external owner may authorize only the exact prepublication catalog
 * snapshot that was sealed into certification. A fresh doctor receipt proves
 * that this same snapshot is still authoritative; a merely equivalent scope
 * with a different source artifact is not sufficient.
 */
export function assertWalmartNewSkuOwnerPermitCatalogAuthorityContinuity(
  doctor: Pick<
    WalmartNewSkuDoctorReceipt,
    | "store_index"
    | "seller_account_fingerprint_sha256"
    | "seller_catalog_authority"
  >,
  certification: Pick<
    WalmartNewSkuCertificationArtifact,
    | "store_index"
    | "seller_account_fingerprint_sha256"
    | "seller_catalog_authority"
  >,
): void {
  const doctorAuthority = assertCatalogAuthorityScope({
    authority: doctor.seller_catalog_authority,
    storeIndex: doctor.store_index,
    businessSellerFingerprintSha256:
      doctor.seller_account_fingerprint_sha256,
    label: "OWNER_PERMIT_DOCTOR",
  });
  const certificationAuthority = assertCatalogAuthorityScope({
    authority: certification.seller_catalog_authority,
    storeIndex: certification.store_index,
    businessSellerFingerprintSha256:
      certification.seller_account_fingerprint_sha256,
    label: "OWNER_PERMIT_CERTIFICATION",
  });
  if (
    doctor.store_index !== certification.store_index ||
    doctor.seller_account_fingerprint_sha256 !==
      certification.seller_account_fingerprint_sha256 ||
    stableWalmartJson(doctorAuthority) !==
      stableWalmartJson(certificationAuthority)
  ) {
    throw new WalmartNewSkuPlanError([
      "OWNER_PERMIT_CATALOG_AUTHORITY_MISMATCH",
    ]);
  }
}

export function assertWalmartNewSkuOwnerPermitIntegrity(
  permit: WalmartNewSkuOwnerPermit,
  certification: WalmartNewSkuCertificationArtifact,
  approval: WalmartNewSkuApprovalArtifact,
  doctor: WalmartNewSkuDoctorReceipt,
  applyPreview: WalmartNewSkuApplyReceipt,
  engineReleaseSha256: string,
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  assertWalmartNewSkuDoctorReceiptIntegrity(doctor, now);
  assertWalmartNewSkuCertificationArtifactIntegrity(certification);
  assertWalmartNewSkuOwnerPermitCatalogAuthorityContinuity(
    doctor,
    certification,
  );
  assertWalmartNewSkuApplyReceiptIntegrity(applyPreview, approval);
  if (
    doctor.engine_release_sha256 !== engineReleaseSha256 ||
    applyPreview.mode !== "PREVIEW" ||
    applyPreview.marketplace_mutation_requested !== false
  ) {
    throw new WalmartNewSkuPlanError(["OWNER_PERMIT_INVALID_OR_STALE"]);
  }
  try {
    assertWalmartOwnerPermitSignature(permit, {
      now,
      env,
      expectedEnvironment: walmartOwnerPermitRuntimeEnvironment(env),
      expected: {
        engine_release_sha256: engineReleaseSha256,
        approval_sha256: approval.approval_sha256,
        doctor_receipt_sha256: doctor.receipt_sha256,
        apply_preview_receipt_sha256: applyPreview.receipt_sha256,
        certification_sha256: certification.certification_sha256,
        candidate_key: certification.candidate_key,
        channel_sku_id: certification.channel_sku_id,
        sku: certification.sku,
        upc: certification.upc,
        payload_sha256: certification.payload_sha256,
        store_index: certification.store_index,
        seller_account_fingerprint_sha256:
          doctor.seller_account_fingerprint_sha256,
        database_target_fingerprint_sha256:
          doctor.database_target_fingerprint_sha256,
      },
    });
  } catch {
    throw new WalmartNewSkuPlanError(["OWNER_PERMIT_SIGNATURE_OR_BINDING_INVALID"]);
  }
}

export function buildWalmartNewSkuOwnerPermitTemplate(input: {
  certification: WalmartNewSkuCertificationArtifact;
  approval: WalmartNewSkuApprovalArtifact;
  applyPreview: WalmartNewSkuApplyReceipt;
  engineReleaseSha256: string;
  now?: Date;
}): Record<string, unknown> {
  assertWalmartNewSkuApplyReceiptIntegrity(input.applyPreview, input.approval);
  const issuedAt = input.now ?? new Date();
  const trust = inspectWalmartOwnerPermitTrustRoot();
  if (trust.active_key_ids.length !== 1) {
    throw new WalmartNewSkuPlanError(["OWNER_PERMIT_TRUST_ROOT_NOT_READY"]);
  }
  return {
    schema_version: WALMART_NEW_SKU_OWNER_PERMIT_SCHEMA,
    algorithm: "Ed25519",
    key_id: trust.active_key_ids[0],
    owner_public_key_spki_sha256: trust.active_key_fingerprints[0],
    signed_body: {
      permit_id: "TODO_OWNER_GENERATED_UNIQUE_PERMIT_ID",
      action: "WALMART_MP_ITEM_SUBMIT",
      environment: "PRODUCTION",
      engine_release_sha256: input.engineReleaseSha256,
      approval_sha256: input.approval.approval_sha256,
      doctor_receipt_sha256: "TODO_FRESH_DOCTOR_RECEIPT_SHA256",
      apply_preview_receipt_sha256: input.applyPreview.receipt_sha256,
      certification_sha256: input.certification.certification_sha256,
      candidate_key: input.certification.candidate_key,
      channel_sku_id: input.certification.channel_sku_id,
      sku: input.certification.sku,
      upc: input.certification.upc,
      payload_sha256: input.certification.payload_sha256,
      store_index: input.certification.store_index,
      seller_account_fingerprint_sha256: "TODO_FROM_FRESH_DOCTOR_RECEIPT",
      database_target_fingerprint_sha256: "TODO_FROM_FRESH_DOCTOR_RECEIPT",
      pilot_slot: null,
      max_pilot_skus: 2,
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(
        issuedAt.getTime() + WALMART_NEW_SKU_APPROVAL_MAX_AGE_MS,
      ).toISOString(),
      approved_by: "TODO_EXTERNAL_OWNER_IDENTITY",
      decision_ref: "TODO_EXTERNAL_OWNER_DECISION_REF",
      live_submission_authorized: true,
      claims: {
        exact_one_sku: true,
        marketplace_submission_max: 1,
        delist: false,
        reprice: false,
        purchase: false,
        schedule: false,
      },
    },
    signing_message_base64: "TODO_AFTER_OWNER_COMPLETES_SIGNED_BODY",
    signature_base64: "TODO_EXTERNAL_OWNER_ED25519_SIGNATURE_BASE64",
    signature_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE",
    permit_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE",
  };
}

/** Builds the exact message for an external owner signer. It never signs. */
export function buildWalmartNewSkuOwnerPermitSigningRequest(input: {
  certification: WalmartNewSkuCertificationArtifact;
  approval: WalmartNewSkuApprovalArtifact;
  doctor: WalmartNewSkuDoctorReceipt;
  applyPreview: WalmartNewSkuApplyReceipt;
  engineReleaseSha256: string;
  permitId: string;
  pilotSlot: 1 | 2;
  approvedBy: string;
  decisionRef: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}) {
  const now = input.now ?? new Date();
  assertWalmartNewSkuDoctorReceiptIntegrity(input.doctor, now, input.env);
  assertWalmartNewSkuCertificationArtifactIntegrity(input.certification);
  assertWalmartNewSkuOwnerPermitCatalogAuthorityContinuity(
    input.doctor,
    input.certification,
  );
  assertWalmartNewSkuApplyReceiptIntegrity(input.applyPreview, input.approval);
  if (
    input.doctor.engine_release_sha256 !== input.engineReleaseSha256 ||
    !/^[-a-zA-Z0-9:._/]{8,200}$/.test(input.permitId) ||
    (input.pilotSlot !== 1 && input.pilotSlot !== 2) ||
    !input.approvedBy.trim() ||
    !isEvidenceReference(input.decisionRef)
  ) {
    throw new WalmartNewSkuPlanError(["OWNER_PERMIT_SIGNING_REQUEST_INVALID"]);
  }
  const permitEnvironment = walmartOwnerPermitRuntimeEnvironment(input.env);
  const trust = inspectWalmartOwnerPermitTrustRoot(
    input.env,
    permitEnvironment,
  );
  if (trust.active_key_ids.length !== 1) {
    throw new WalmartNewSkuPlanError(["OWNER_PERMIT_TRUST_ROOT_NOT_READY"]);
  }
  return buildWalmartOwnerPermitSigningRequest({
    key_id: trust.active_key_ids[0]!,
    env: input.env,
    signed_body: {
      permit_id: input.permitId,
      action: "WALMART_MP_ITEM_SUBMIT",
      environment: permitEnvironment,
      engine_release_sha256: input.engineReleaseSha256,
      approval_sha256: input.approval.approval_sha256,
      doctor_receipt_sha256: input.doctor.receipt_sha256,
      apply_preview_receipt_sha256: input.applyPreview.receipt_sha256,
      certification_sha256: input.certification.certification_sha256,
      candidate_key: input.certification.candidate_key,
      channel_sku_id: input.certification.channel_sku_id,
      sku: input.certification.sku,
      upc: input.certification.upc,
      payload_sha256: input.certification.payload_sha256,
      store_index: input.certification.store_index,
      seller_account_fingerprint_sha256:
        input.doctor.seller_account_fingerprint_sha256,
      database_target_fingerprint_sha256:
        input.doctor.database_target_fingerprint_sha256,
      pilot_slot: input.pilotSlot,
      max_pilot_skus: 2,
      issued_at: now.toISOString(),
      expires_at: new Date(
        now.getTime() + WALMART_NEW_SKU_APPROVAL_MAX_AGE_MS,
      ).toISOString(),
      approved_by: input.approvedBy,
      decision_ref: input.decisionRef,
      live_submission_authorized: true,
      claims: {
        exact_one_sku: true,
        marketplace_submission_max: 1,
        delist: false,
        reprice: false,
        purchase: false,
        schedule: false,
      },
    },
  });
}

export function sealWalmartNewSkuVerifyReceipt(
  input: Omit<WalmartNewSkuVerifyReceipt, "receipt_sha256">,
  certification: WalmartNewSkuCertificationArtifact,
): WalmartNewSkuVerifyReceipt {
  if (
    input.schema_version !== WALMART_NEW_SKU_VERIFY_RECEIPT_SCHEMA ||
    input.certification_sha256 !== certification.certification_sha256 ||
    input.channel_sku_id !== certification.channel_sku_id ||
    input.sku !== certification.sku ||
    input.payload_sha256 !== certification.payload_sha256 ||
    input.marketplace_mutated !== false ||
    !Number.isFinite(Date.parse(input.verified_at))
  ) {
    throw new WalmartNewSkuPlanError(["VERIFY_RECEIPT_BINDING_INVALID"]);
  }
  const attempt = input.submission_attempt_binding;
  if (attempt) {
    const expectedIdempotencyKey = `walmart:v1:${createHash("sha256")
      .update(`${certification.channel_sku_id}\n${certification.payload_sha256}`)
      .digest("hex")}`;
    if (
      !attempt.attempt_id.trim() ||
      attempt.channel_sku_id !== certification.channel_sku_id ||
      attempt.certification_sha256 !== certification.certification_sha256 ||
      attempt.payload_sha256 !== certification.payload_sha256 ||
      attempt.seller_account_fingerprint_sha256 !==
        certification.seller_account_fingerprint_sha256 ||
      attempt.idempotency_key !== expectedIdempotencyKey
    ) {
      throw new WalmartNewSkuPlanError([
        "VERIFY_RECEIPT_ATTEMPT_BINDING_INVALID",
      ]);
    }
  }
  const buyerStatus = input.buyer_evidence_status;
  if (
    !buyerStatus ||
    typeof buyerStatus !== "object" ||
    Array.isArray(buyerStatus)
  ) {
    throw new WalmartNewSkuPlanError(["VERIFY_RECEIPT_STATUS_INVALID"]);
  }
  const status = buyerStatus as Record<string, unknown>;
  if (
    status.channel_sku_id !== certification.channel_sku_id ||
    status.attempt_id !== (attempt?.attempt_id ?? null)
  ) {
    throw new WalmartNewSkuPlanError([
      "VERIFY_RECEIPT_STATUS_ATTEMPT_BINDING_INVALID",
    ]);
  }
  if (input.poll_result != null) {
    if (
      !attempt ||
      typeof input.poll_result !== "object" ||
      Array.isArray(input.poll_result)
    ) {
      throw new WalmartNewSkuPlanError(["VERIFY_RECEIPT_POLL_INVALID"]);
    }
    const poll = input.poll_result as Record<string, unknown>;
    if (
      poll.channel_sku_id !== certification.channel_sku_id ||
      poll.submission_attempt_id !== attempt.attempt_id
    ) {
      throw new WalmartNewSkuPlanError([
        "VERIFY_RECEIPT_POLL_ATTEMPT_BINDING_INVALID",
      ]);
    }
  }
  return { ...input, receipt_sha256: sha256WalmartJson(input) };
}

export function assertWalmartNewSkuVerifyReceiptIntegrity(
  receipt: WalmartNewSkuVerifyReceipt,
  certification: WalmartNewSkuCertificationArtifact,
): void {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new WalmartNewSkuPlanError(["VERIFY_RECEIPT_INVALID"]);
  }
  const { receipt_sha256: actual, ...unsigned } = receipt;
  const expected = sealWalmartNewSkuVerifyReceipt(unsigned, certification);
  if (actual !== expected.receipt_sha256) {
    throw new WalmartNewSkuPlanError(["VERIFY_RECEIPT_HASH_MISMATCH"]);
  }
}

export interface WalmartNewSkuEvidenceSealDraftBinding {
  policy_evidence_index: number;
  policy_evidence_path: string;
  expected_policy_binding: WalmartNewSkuPolicyReviewBinding;
}

/** Identity-only gate for `certify --mode seal-evidence`. Human decisions may
 * still be TODO at this step, but a draft from another plan/stage/candidate or
 * a detached POLICY_REVIEW row can never be sealed under the supplied flags. */
export function assertWalmartNewSkuEvidenceSealDraftBinding(input: {
  draft: unknown;
  plan: WalmartNewSkuPlan;
  stage: WalmartNewSkuStageArtifact;
}): WalmartNewSkuEvidenceSealDraftBinding {
  assertWalmartNewSkuPlanIntegrity(input.plan);
  assertWalmartNewSkuStageArtifactIntegrity(input.stage, input.plan);
  const failures: string[] = [];
  const draft = input.draft;
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    throw new WalmartNewSkuPlanError(["EVIDENCE_SEAL_DRAFT_ROOT_INVALID"]);
  }
  const record = draft as Record<string, unknown>;
  if (record.schema_version !== WALMART_NEW_SKU_CERTIFICATION_INPUT_SCHEMA) {
    failures.push("EVIDENCE_SEAL_DRAFT_SCHEMA_UNSUPPORTED");
  }
  if (record.wave_id !== input.plan.wave_id) {
    failures.push("EVIDENCE_SEAL_DRAFT_WAVE_MISMATCH");
  }
  if (record.candidate_key !== input.stage.candidate_key) {
    failures.push("EVIDENCE_SEAL_DRAFT_CANDIDATE_MISMATCH");
  }
  if (record.stage_sha256 !== input.stage.stage_sha256) {
    failures.push("EVIDENCE_SEAL_DRAFT_STAGE_MISMATCH");
  }
  const candidate = input.plan.candidates.find(
    (item) => item.candidate_key === input.stage.candidate_key,
  )!;
  const walmart = record.walmart &&
    typeof record.walmart === "object" &&
    !Array.isArray(record.walmart)
    ? record.walmart as Record<string, unknown>
    : null;
  const prepublication = record.prepublication &&
    typeof record.prepublication === "object" &&
    !Array.isArray(record.prepublication)
    ? record.prepublication as Record<string, unknown>
    : null;
  const policyReview = prepublication?.sku_policy_review &&
    typeof prepublication.sku_policy_review === "object" &&
    !Array.isArray(prepublication.sku_policy_review)
    ? prepublication.sku_policy_review as Record<string, unknown>
    : null;
  const productType = typeof walmart?.product_type === "string"
    ? walmart.product_type
    : "";
  const policyRef = policyReview?.evidence_ref;
  if (!isEvidenceReference(policyRef)) {
    failures.push("EVIDENCE_SEAL_POLICY_REF_INVALID");
  }
  const evidenceRows = Array.isArray(record.evidence_artifacts)
    ? record.evidence_artifacts
    : [];
  const policyRows = evidenceRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) =>
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      (row as Record<string, unknown>).kind === "POLICY_REVIEW"
    );
  if (policyRows.length !== 1) {
    failures.push("EVIDENCE_SEAL_POLICY_ROW_COUNT_INVALID");
  }
  const policyRow = policyRows[0];
  const policyRowRecord = policyRow?.row as Record<string, unknown> | undefined;
  const policyPath = policyRowRecord?.path;
  if (
    policyRowRecord?.ref !== policyRef ||
    typeof policyPath !== "string" ||
    !policyPath.startsWith("/") ||
    PLACEHOLDER_TEXT.test(policyPath)
  ) {
    failures.push("EVIDENCE_SEAL_POLICY_ROW_BINDING_INVALID");
  }
  if (
    !productType.trim() ||
    PLACEHOLDER_TEXT.test(productType)
  ) {
    failures.push("EVIDENCE_SEAL_PRODUCT_TYPE_MISSING");
  }
  if (failures.length > 0 || !policyRow || typeof policyPath !== "string") {
    throw new WalmartNewSkuPlanError(failures);
  }
  return {
    policy_evidence_index: policyRow.index,
    policy_evidence_path: policyPath,
    expected_policy_binding: {
      wave_id: input.plan.wave_id,
      plan_sha256: input.plan.plan_sha256,
      stage_sha256: input.stage.stage_sha256,
      candidate_key: candidate.candidate_key,
      candidate_sha256: sha256WalmartJson(candidate),
      store_index: input.plan.store_index,
      business_seller_account_fingerprint_sha256:
        input.plan.seller_account_fingerprint_sha256,
      sku: input.stage.proposed_sku,
      upc: input.stage.upc,
      donor_product_id: candidate.donor_product_id,
      canonical_variant_id: candidate.canonical_variant_id,
      product_type: productType,
    },
  };
}

export function buildWalmartNewSkuCertificationTemplate(input: {
  plan: WalmartNewSkuPlan;
  stage: WalmartNewSkuStageArtifact;
  now?: Date;
  policyReviewEvidencePath?: string;
}): Record<string, unknown> {
  assertWalmartNewSkuStageArtifactIntegrity(input.stage, input.plan);
  const candidate = input.plan.candidates.find(
    (item) => item.candidate_key === input.stage.candidate_key,
  )!;
  const component = candidate.recipe_input.components[0];
  return {
    schema_version: WALMART_NEW_SKU_CERTIFICATION_INPUT_SCHEMA,
    wave_id: input.plan.wave_id,
    candidate_key: candidate.candidate_key,
    stage_sha256: input.stage.stage_sha256,
    price_cents: null,
    packaging_cost_cents: null,
    shipping_label_cents: null,
    shipping_in_price: null,
    evidence_artifacts: [
      ["TODO_EVIDENCE_REF_IMAGE_RIGHTS_MAIN", "IMAGE_RIGHTS"],
      ["TODO_EVIDENCE_REF_IMAGE_RIGHTS_SECONDARY", "IMAGE_RIGHTS"],
      ["TODO_EVIDENCE_REF_COUNTRY_OF_ORIGIN", "COUNTRY_OF_ORIGIN"],
      ["TODO_EVIDENCE_REF_CATEGORY_APPROVAL", "CATEGORY_APPROVAL"],
      ["TODO_EVIDENCE_REF_POLICY_REVIEW", "POLICY_REVIEW"],
      ["TODO_EVIDENCE_REF_RECALL_CHECK", "RECALL_CHECK"],
      ["TODO_EVIDENCE_REF_BRAND_RIGHTS", "BRAND_RIGHTS"],
      ["TODO_EVIDENCE_REF_SELLER_ACCOUNT_HEALTH", "SELLER_ACCOUNT_HEALTH"],
      ["TODO_EVIDENCE_REF_LOT_CONTROL", "LOT_CONTROL_PROCEDURE"],
      ["TODO_EVIDENCE_REF_EXPIRATION_SOURCE", "EXPIRATION_SOURCE"],
    ].map(([ref, kind]) => ({
      ref,
      kind,
      path:
        kind === "POLICY_REVIEW" && input.policyReviewEvidencePath
          ? input.policyReviewEvidencePath
          : `/TODO_ABSOLUTE_IMMUTABLE_EVIDENCE_PATH/${ref}`,
      sha256: "TODO_LOWERCASE_SHA256_OF_EVIDENCE_BYTES",
      byte_size: null,
      captured_at: "TODO_CANONICAL_UTC_AFTER_EVIDENCE_CAPTURE",
      source_url:
        kind === "POLICY_REVIEW"
          ? WALMART_POLICY_SOURCES.find(
              (source) => source.id === "prohibited-products-overview",
            )!.url
          : null,
    })),
    images: [
      {
        role: "MAIN",
        url: "TODO_QUERY_FREE_HTTPS_JPEG_OR_PNG",
        depicted_component_keys: [component.component_key],
        source_content_observation_ids: [component.content_observation_id],
        represented_unit_count: candidate.pack_count,
        rights_basis: "TODO_OWNED_LICENSED_SOURCE_ALLOWED_OR_AI_DERIVED",
        rights_evidence_ref: "TODO_EVIDENCE_REF_IMAGE_RIGHTS_MAIN",
        reviewed_at: "TODO_CANONICAL_UTC_AFTER_IMAGE_REVIEW",
      },
      {
        role: "SECONDARY",
        url: "TODO_DISTINCT_QUERY_FREE_HTTPS_JPEG_OR_PNG",
        depicted_component_keys: [component.component_key],
        source_content_observation_ids: [component.content_observation_id],
        represented_unit_count: candidate.pack_count,
        rights_basis: "TODO_OWNED_LICENSED_SOURCE_ALLOWED_OR_AI_DERIVED",
        rights_evidence_ref: "TODO_EVIDENCE_REF_IMAGE_RIGHTS_SECONDARY",
        reviewed_at: "TODO_CANONICAL_UTC_AFTER_IMAGE_REVIEW",
      },
    ],
    physical_package: {
      schema_version: "bundle-factory.verified-physical-package/v1",
      source: "OPERATOR_SHIP_SPECS",
      verified_at: "TODO_CANONICAL_UTC_AFTER_PHYSICAL_MEASUREMENT",
      weight_oz: null,
      length_in: null,
      width_in: null,
      height_in: null,
    },
    walmart: {
      product_type: "TODO_FROM_WALMART_ITEM_SPEC_BROWSER",
      country_of_origin_substantial_transformation: "TODO_VERIFIED_COUNTRY",
      country_of_origin_evidence: {
        canonical_variant_id: component.canonical_variant_id,
        content_observation_id: component.content_observation_id,
        value: "TODO_VERIFIED_COUNTRY",
        source: "TODO_PRODUCT_LABEL_MANUFACTURER_DOCUMENT_OR_AUTHORIZED_BRAND_RECORD",
        evidence_ref: "TODO_EVIDENCE_REF_COUNTRY_OF_ORIGIN",
        verified_at: "TODO_CANONICAL_UTC_AFTER_COUNTRY_VERIFICATION",
      },
      public_attributes: {
        multipackQuantity: candidate.pack_count,
        countPerPack: 1,
        count: candidate.pack_count,
      },
      public_attribute_evidence: {},
      offer_handoff: {
        mode: "INLINE",
        quantity: 1,
        fulfillment_center_id: "TODO_WALMART_FULFILLMENT_CENTER_ID",
        fulfillment_lag_time: null,
      },
    },
    prepublication: {
      seller_account_health: {
        status: "TODO_HEALTHY_AND_ACCEPTING_NEW_ITEMS_AFTER_CHECK",
        store_index: input.plan.store_index,
        seller_account_fingerprint_sha256:
          input.plan.seller_account_fingerprint_sha256,
        verified_at: "TODO_CANONICAL_UTC_AFTER_ACCOUNT_CHECK",
        evidence_ref: "TODO_EVIDENCE_REF_SELLER_ACCOUNT_HEALTH",
      },
      category_approvals: [{
        scope: "INGESTIBLE_PRODUCTS",
        status: "TODO_APPROVED_AFTER_EXACT_ACCOUNT_EVIDENCE",
        verified_at: "TODO_CANONICAL_UTC_AFTER_CATEGORY_APPROVAL_CHECK",
        evidence_ref: "TODO_EVIDENCE_REF_CATEGORY_APPROVAL",
      }],
      sku_policy_review: {
        status: "TODO_CLEARED_AFTER_STRUCTURED_HUMAN_REVIEW",
        reviewed_at: "TODO_CANONICAL_UTC_MATCHING_POLICY_ARTIFACT",
        evidence_ref: "TODO_EVIDENCE_REF_POLICY_REVIEW",
      },
      recall_check: {
        status: "TODO_CLEAR_AFTER_OFFICIAL_RECALL_CHECK",
        checked_at: "TODO_CANONICAL_UTC_AFTER_OFFICIAL_RECALL_CHECK",
        source: "TODO_CURRENT_OFFICIAL_RECALL_SOURCES",
        evidence_ref: "TODO_EVIDENCE_REF_RECALL_CHECK",
      },
      brand_rights: {
        brand: component.manufacturer_brand,
        basis: "TODO_BRAND_OWNER_OR_AUTHORIZED_RESELLER",
        verified_at: "TODO_CANONICAL_UTC_AFTER_BRAND_RIGHTS_CHECK",
        evidence_ref: "TODO_EVIDENCE_REF_BRAND_RIGHTS",
      },
      condition: {
        value: "TODO_VERIFY_EXACT_ITEM_CONDITION_IS_NEW",
        verified_at: "TODO_CANONICAL_UTC_AFTER_CONDITION_CHECK",
      },
      expiration: {
        applicable: "TODO_CONFIRM_EXPIRATION_CONTROL_APPLIES",
        shelf_life_days: null,
        minimum_days_remaining_at_ship: null,
        lot_check_procedure_ref: "TODO_EVIDENCE_REF_LOT_CONTROL",
        source_ref: "TODO_EVIDENCE_REF_EXPIRATION_SOURCE",
        verified_at: "TODO_CANONICAL_UTC_AFTER_EXPIRATION_CONTROL_CHECK",
      },
    },
  };
}

/**
 * Engine-generated fail-closed form for the human/owner policy review. Every
 * product/account binding and every mandatory policy source/domain is filled
 * by the engine; UNRESOLVED/BLOCKED values must be reviewed before certify can
 * accept the exact hashed bytes.
 */
export function buildWalmartNewSkuPolicyReviewEvidenceTemplate(input: {
  plan: WalmartNewSkuPlan;
  stage: WalmartNewSkuStageArtifact;
  now?: Date;
}): Record<string, unknown> {
  assertWalmartNewSkuStageArtifactIntegrity(input.stage, input.plan);
  const candidate = input.plan.candidates.find(
    (item) => item.candidate_key === input.stage.candidate_key,
  )!;
  const sourceUrlById = new Map(
    WALMART_POLICY_SOURCES.map((source) => [source.id, source.url] as const),
  );
  const findingTemplate = new Map<
    (typeof WALMART_NEW_SKU_REQUIRED_POLICY_REVIEW_DOMAIN_IDS)[number],
    {
      policy_source_ids: string[];
      required_approval_scopes: Array<"INGESTIBLE_PRODUCTS">;
    }
  >([
    ["category-preapproval", {
      policy_source_ids: ["prohibited-products-overview"],
      required_approval_scopes: ["INGESTIBLE_PRODUCTS"],
    }],
    ["condition-resale-rights", {
      policy_source_ids: ["resold-products"],
      required_approval_scopes: [],
    }],
    ["food-labeling-prohibited", {
      policy_source_ids: ["food-products", "prohibited-products-overview"],
      required_approval_scopes: [],
    }],
    ["product-claims", {
      policy_source_ids: ["product-claims"],
      required_approval_scopes: [],
    }],
    ["recall-safety", {
      policy_source_ids: ["recalled-products"],
      required_approval_scopes: [],
    }],
    ["territory-legal-sanctions", {
      policy_source_ids: [
        "prohibited-products-overview",
        "restricted-illegal-products",
      ],
      required_approval_scopes: [],
    }],
  ]);
  return {
    schema_version: WALMART_NEW_SKU_POLICY_REVIEW_EVIDENCE_SCHEMA,
    binding: {
      wave_id: input.plan.wave_id,
      plan_sha256: input.plan.plan_sha256,
      stage_sha256: input.stage.stage_sha256,
      candidate_key: candidate.candidate_key,
      candidate_sha256: sha256WalmartJson(candidate),
      store_index: input.plan.store_index,
      business_seller_account_fingerprint_sha256:
        input.plan.seller_account_fingerprint_sha256,
      sku: input.stage.proposed_sku,
      upc: input.stage.upc,
      donor_product_id: candidate.donor_product_id,
      canonical_variant_id: candidate.canonical_variant_id,
      product_type: "TODO_FROM_WALMART_ITEM_SPEC_BROWSER",
    },
    policy_version: WALMART_POLICY_VERSION,
    reviewed_at: "TODO_CANONICAL_UTC_AFTER_HUMAN_POLICY_REVIEW",
    reviewer: {
      reviewer_id: "TODO_REAL_HUMAN_OR_OWNER_IDENTITY",
      role: "TODO_HUMAN_COMPLIANCE_REVIEWER_OR_OWNER",
    },
    decision: "TODO_CLEARED_OR_BLOCKED_AFTER_REVIEW",
    official_sources: WALMART_NEW_SKU_REQUIRED_POLICY_SOURCE_IDS.map(
      (sourceId) => ({
        source_id: sourceId,
        url: sourceUrlById.get(sourceId)!,
        captured_at: "TODO_CANONICAL_UTC_AFTER_SOURCE_CAPTURE",
        checked_at: "TODO_CANONICAL_UTC_AFTER_SOURCE_CHECK",
      }),
    ),
    findings: WALMART_NEW_SKU_REQUIRED_POLICY_REVIEW_DOMAIN_IDS.map(
      (findingId) => ({
        finding_id: findingId,
        disposition: "TODO_CLEARED_REQUIRES_APPROVAL_PROHIBITED_OR_UNRESOLVED",
        summary: `TODO_HUMAN_REVIEW_DECISION_FOR_${findingId.toUpperCase()}`,
        policy_source_ids: findingTemplate.get(findingId)!.policy_source_ids,
        required_approval_scopes:
          findingTemplate.get(findingId)!.required_approval_scopes,
      }),
    ),
    required_category_approvals: [{
      scope: "INGESTIBLE_PRODUCTS",
      status: "TODO_APPROVED_AFTER_EXACT_ACCOUNT_EVIDENCE",
      verified_at: "TODO_CANONICAL_UTC_AFTER_CATEGORY_APPROVAL_CHECK",
      evidence_ref: "TODO_EVIDENCE_REF_CATEGORY_APPROVAL",
    }],
  };
}

export function buildWalmartNewSkuPilotPlan(input: {
  createdAt: Date;
  asOf: Date;
  storeIndex: number;
  sellerId: string;
  doctorBinding: {
    doctorReceiptSha256: string;
    engineReleaseSha256: string;
    releaseManifestSha256: string;
    databaseTargetFingerprintSha256: string;
    databaseSchemaSha256: string;
    itemSpecVersion: string;
    sellerCatalogAuthority: SealedWalmartSellerCatalogAuthorityBinding;
  };
  zip: string;
  maxLiveSubmissions?: number;
  candidates: Array<{
    candidate: WalmartPilotCandidate;
    recipe: ProductTruthRecipeInput;
    packCount: number;
  }>;
}): WalmartNewSkuPlan {
  if (input.storeIndex !== 1) {
    throw new WalmartNewSkuPlanError(["STORE_INDEX_INVALID"]);
  }
  const maxLiveSubmissions =
    input.maxLiveSubmissions ?? 1;
  if (maxLiveSubmissions !== 1) {
    throw new WalmartNewSkuPlanError([
      `PILOT_APPLY_LIMIT_INVALID:${maxLiveSubmissions}`,
    ]);
  }
  if (input.candidates.length === 0) {
    throw new WalmartNewSkuPlanError(["NO_CANONICAL_CANDIDATES"]);
  }
  if (input.candidates.length > 1) {
    throw new WalmartNewSkuPlanError(["PLAN_CANDIDATE_LIMIT_EXCEEDED"]);
  }
  if (input.candidates.length > maxLiveSubmissions) {
    throw new WalmartNewSkuPlanError([
      `PILOT_CANDIDATE_LIMIT_EXCEEDED:${input.candidates.length}>${maxLiveSubmissions}`,
    ]);
  }

  const createdAt = input.createdAt.toISOString();
  const asOf = input.asOf.toISOString();
  const sellerAccountFingerprint = fingerprintWalmartSellerAccount({
    storeIndex: input.storeIndex,
    sellerId: input.sellerId,
  });
  const sellerCatalogAuthority = assertCatalogAuthorityScope({
    authority: input.doctorBinding.sellerCatalogAuthority,
    storeIndex: input.storeIndex,
    businessSellerFingerprintSha256: sellerAccountFingerprint,
    label: "PLAN_INPUT",
  });
  const candidates = input.candidates.map(({ candidate, recipe, packCount }) => {
    const component = recipe.components[0];
    if (
      recipe.components.length !== 1 ||
      component.donor_product_id !== candidate.donor_product_id ||
      component.canonical_variant_id !== candidate.canonical_variant_id
    ) {
      throw new WalmartNewSkuPlanError([
        `CANDIDATE_RECIPE_IDENTITY_MISMATCH:${candidate.donor_product_id}`,
      ]);
    }
    const key = candidateKey({
      donorProductId: candidate.donor_product_id,
      canonicalVariantId: candidate.canonical_variant_id,
      packCount,
    });
    return {
      candidate_key: key,
      donor_product_id: candidate.donor_product_id,
      canonical_variant_id: candidate.canonical_variant_id,
      pack_count: packCount,
      source_candidate: candidate,
      recipe_input: recipe,
      content: buildDeterministicWalmartMultipackContent({
        component,
        packCount,
      }),
      required_before_certification: [...REQUIRED_BEFORE_CERTIFICATION],
    } satisfies WalmartNewSkuPlanCandidate;
  });
  const withoutWave: Omit<WalmartNewSkuPlan, "plan_sha256" | "wave_id"> = {
    schema_version: WALMART_NEW_SKU_PLAN_SCHEMA,
    phase: "PILOT",
    created_at: createdAt,
    as_of: asOf,
    store_index: input.storeIndex,
    seller_account_fingerprint_sha256: sellerAccountFingerprint,
    seller_catalog_authority: sellerCatalogAuthority,
    doctor_receipt_sha256: input.doctorBinding.doctorReceiptSha256,
    engine_release_sha256: input.doctorBinding.engineReleaseSha256,
    release_manifest_sha256: input.doctorBinding.releaseManifestSha256,
    database_target_fingerprint_sha256:
      input.doctorBinding.databaseTargetFingerprintSha256,
    database_schema_sha256: input.doctorBinding.databaseSchemaSha256,
    item_spec_version: input.doctorBinding.itemSpecVersion,
    zip: input.zip.trim(),
    max_live_submissions: maxLiveSubmissions,
    marketplace_mutation_allowed: false,
    candidates,
  };
  const unsigned: Omit<WalmartNewSkuPlan, "plan_sha256"> = {
    ...withoutWave,
    wave_id: expectedWaveId(withoutWave),
  };
  const plan: WalmartNewSkuPlan = {
    ...unsigned,
    plan_sha256: planHash(unsigned),
  };
  assertWalmartNewSkuPlanIntegrity(plan);
  return plan;
}

export function serializeWalmartNewSkuPlan(plan: WalmartNewSkuPlan): string {
  assertWalmartNewSkuPlanIntegrity(plan);
  return `${JSON.stringify(JSON.parse(stableWalmartJson(plan)), null, 2)}\n`;
}

export function serializeWalmartNewSkuStageArtifact(
  artifact: WalmartNewSkuStageArtifact,
): string {
  assertWalmartNewSkuStageArtifactIntegrity(artifact);
  return `${JSON.stringify(JSON.parse(stableWalmartJson(artifact)), null, 2)}\n`;
}

export function serializeWalmartNewSkuCertificationArtifact(
  artifact: WalmartNewSkuCertificationArtifact,
): string {
  assertWalmartNewSkuCertificationArtifactIntegrity(artifact);
  return `${JSON.stringify(JSON.parse(stableWalmartJson(artifact)), null, 2)}\n`;
}
