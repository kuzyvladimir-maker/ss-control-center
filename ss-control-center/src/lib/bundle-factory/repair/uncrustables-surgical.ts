/**
 * Production-safe, PATCH-only repair flow for the July 2026 Uncrustables launch.
 *
 * Safety invariants:
 *  - plans are derived from a complete immutable live ledger and are SHA-256 sealed;
 *  - the executor is offline unless `apply` is explicitly true and the caller
 *    supplies the plan-specific confirmation token;
 *  - each action is a narrow Listings Items PATCH (media, offer, or text/count);
 *  - every real PATCH is preceded by VALIDATION_PREVIEW; Amazon rejects
 *    `merge` in preview mode, so selector-aware offer merges use a sealed
 *    selector `replace` surrogate while every other operation stays exact;
 *  - offer patches merge into the latest live offer, preserving quantity
 *    discounts, metadata, and unrelated entries. The owner-reviewed launch
 *    layer decides per SKU whether discounted_price is absent (coupon arm) or
 *    is an exact dated Sale Price schedule (sale arm); list_price stays absent;
 *  - legacy execution verifies accepted writes inline; OFFER production uses
 *    persistent submit-only evidence followed by a separate GET-only settle;
 *  - progress is append-only: each checkpoint event is its own immutable JSON.
 *
 * This module never imports Prisma and never performs a Listings Items PUT.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import {
  priceSchedule,
} from "@/lib/amazon-sp-api/pricing";
import type {
  ListingItem,
  ListingPatch,
} from "@/lib/amazon-sp-api/listings";
import { priceFor } from "@/lib/pricing/cost-model";
import { BRAND_CARD_COLD_CHAIN_URL } from "../attributes/brand-assets";
import {
  amazonAllergenFamily,
  amazonContainedAllergenToken,
  amazonMayContainAllergenToken,
  normalizeAllergenDeclaration,
  type AllergenDeclaration,
} from "../allergen-declaration";
import { validateSemanticOutput } from "../content-generation";
import {
  DONOR_ENRICHMENT_SCHEMA_VERSION,
  UNCRUSTABLES_DONOR_MANIFEST_SHA256,
  donorManifestMap,
  parseDonorEnrichmentManifest,
  type DonorEnrichmentManifest,
} from "../donor-enrichment";
import type { Variant, VariantComponent } from "../variation-matrix";
import {
  renderUncrustablesRepairContent,
  uncrustablesFlavorLabel,
} from "./uncrustables-content";
import {
  UNCRUSTABLES_LAUNCH_PRICING_SCHEMA,
  launchPricingRowsBySku,
  verifyUncrustablesLaunchPricingManifest,
  type UncrustablesLaunchLever,
  type UncrustablesLaunchPricingManifest,
  type UncrustablesLaunchPricingRow,
  type UncrustablesSalePriceSchedule,
} from "./uncrustables-launch-pricing";
import {
  verifyUncrustablesLaunchExecutionAuthorization,
  verifyUncrustablesLaunchExecutionEvidenceBytes,
  type LaunchExecutionAuthorizationRuntimeInput,
} from "./uncrustables-launch-execution-authorization";
import {
  DEFAULT_OFFER_SETTLEMENT_POLICY,
  OFFER_ONLY_EXECUTION_PROFILE,
  assertOfferOnlyExecutionSelection,
  assertOfferSubmitOnlyMayStart,
  resolveOfferSettlementPolicy,
  runReadOnlyOfferSettlement,
  runReadOnlySettlementScheduler,
  type OfferExecutionPhase,
  type OfferSettlementPolicyInput,
} from "./uncrustables-offer-two-phase";
import {
  EXTERNAL_OVERWRITE_TERMINAL_DETAIL_SCHEMA,
  EXTERNAL_OVERWRITE_TERMINAL_STATUS,
  verifyExternalOverwriteDispositionProposal,
  verifyExternalOverwriteTerminalEvent,
  type ExternalOverwriteDispositionProposal,
} from "./uncrustables-external-overwrite-disposition-contract";
import {
  PRE_REQUEST_ABORT_TERMINAL_DETAIL_SCHEMA,
  PRE_REQUEST_ABORT_TERMINAL_STATUS,
  verifyPreRequestAbortDispositionProposal,
  verifyPreRequestAbortTerminalEvent,
  type PreRequestAbortDispositionProposal,
} from "./uncrustables-pre-request-abort-disposition-contract";
import { preflightDeclaredUncrustablesMainHash } from "../audit/uncrustables-main-production-preflight";

export {
  DEFAULT_OFFER_SETTLEMENT_POLICY,
  OFFER_ONLY_EXECUTION_PROFILE,
} from "./uncrustables-offer-two-phase";
export type { OfferExecutionPhase } from "./uncrustables-offer-two-phase";

export const REPAIR_PLAN_SCHEMA = "uncrustables-surgical-repair/v2" as const;
export const DESIRED_MANIFEST_SCHEMA =
  "uncrustables-surgical-desired/v1" as const;
export const CHECKPOINT_SCHEMA =
  "uncrustables-surgical-checkpoint/v1" as const;
export const SELECTOR_REPLACE_SURROGATE_FOR_MERGE =
  "SELECTOR_REPLACE_SURROGATE_FOR_MERGE" as const;
export const UNCRUSTABLES_APP_ROOT = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
export const CANONICAL_UNCRUSTABLES_FORWARD_CHECKPOINT_ROOT = path.join(
  UNCRUSTABLES_APP_ROOT,
  "data/repairs/checkpoints",
);
export const CANONICAL_UNCRUSTABLES_AMAZON_COORDINATION_DIR = path.join(
  UNCRUSTABLES_APP_ROOT,
  "data/repairs/runtime-locks/uncrustables-amazon-us",
);
export const HERO_MANIFEST_SCHEMA =
  "uncrustables-hero-generation-manifest/v1.0" as const;
export const GALLERY_MANIFEST_SCHEMA =
  "uncrustables-product-gallery-manifest/v1.0" as const;
export const PTD_ATTRIBUTE_PROOF_SCHEMA =
  "amazon-food-ptd-attribute-proof/v1" as const;
export const PTD_ATTRIBUTE_PROOF_SHA256 =
  "98f65723cdb9fd4dedc63317e7ad08bd45e17c95917e3b0ee9e372956a1d0ec9" as const;

/** Verified by pixel comparison on 2026-07-17: this is the Amazon JPEG rehost
 * of the fixed Salutem price-rationale / thank-you card. */
export const VERIFIED_BRAND_CARD_REHOST_URL =
  "https://m.media-amazon.com/images/I/81OibsvvU0L.jpg";

/** The only two accepted locators for the byte-verified fixed card. Amazon may
 * return its exact JPEG rehost after ingesting the R2 source, so both are
 * accepted while every other lookalike or rehost remains fail-closed. */
export function isVerifiedBrandCardLocator(url: string): boolean {
  return (
    url === BRAND_CARD_COLD_CHAIN_URL ||
    url === VERIFIED_BRAND_CARD_REHOST_URL
  );
}

/** This image occupied slot 1 on exactly three legacy listings and is a product
 * nutrition image, not the required fixed Salutem card. */
export const KNOWN_WRONG_SLOT_1_URL =
  "https://m.media-amazon.com/images/I/81+K8ip-dSL.jpg";

export type RepairActionKind =
  | "MEDIA"
  | "OFFER"
  | "TEXT_COUNT"
  | "STRUCTURED_ATTRIBUTES";

export type OfferMergePreviewContext =
  | "FORWARD_OFFER"
  | "ROLLBACK_INVERSE_OFFER";

export interface ValidationPreviewPatchSet {
  strategy: "EXACT" | typeof SELECTOR_REPLACE_SURROGATE_FOR_MERGE;
  actual_patches: ListingPatch[];
  preview_patches: ListingPatch[];
  /** Present only for the single reviewed purchasable_offer merge. */
  actual_merge_patch?: ListingPatch;
  preview_surrogate_patch?: ListingPatch;
  omitted_null_members: string[];
}

/** Optional sixth gateway argument used only when previewing a merge
 * surrogate. It lets the CLI bind its rollback CAS to the sealed actual merge
 * while sending only the non-mutating selector-replace surrogate to Amazon. */
export interface RepairValidationPreviewContext {
  strategy: typeof SELECTOR_REPLACE_SURROGATE_FOR_MERGE;
  offer_merge_context: OfferMergePreviewContext;
  actual_patches: ListingPatch[];
}

/** Repairs that can clear Amazon validation issues must run before actions
 * whose previews are evaluated against those fields. Keep the order explicit
 * and exhaustive so adding a new action kind cannot silently choose an unsafe
 * execution position. */
const REPAIR_ACTION_EXECUTION_ORDER = {
  TEXT_COUNT: 0,
  STRUCTURED_ATTRIBUTES: 1,
  MEDIA: 2,
  OFFER: 3,
} satisfies Record<RepairActionKind, number>;

export interface DesiredMediaRepair {
  main_image_url?: string;
  main_image_sha256?: string;
  gallery_slots: Array<{ slot: number; url: string }>;
  delete_gallery_slots?: number[];
}

export interface DesiredOfferRepair {
  currency: "USD";
  consumer_price: number;
  business_price: number;
  minimum_seller_allowed_price: number;
  maximum_seller_allowed_price: number;
  discounted_price_absent: boolean;
  discounted_price_schedule?: UncrustablesSalePriceSchedule;
  launch_lever?: UncrustablesLaunchLever;
  list_price_absent: true;
}

export interface DesiredTextCountRepair {
  title?: string;
  bullets?: string[];
  description?: string;
  unit_count?: number;
  unit_count_type?: "Count" | "Ounce";
  number_of_items?: number;
  /** Product type passed in the PATCH body. This does not bypass preview. */
  request_product_type?: string;
  /** Post-GET product type required for the primary strategy to verify. */
  expected_product_type?: string;
  /** These live issue codes must be absent before verification succeeds. */
  must_clear_issue_codes?: string[];
  /** Reviewed fallback, used only if Amazon accepts the primary patch but its
   * post-GET verification still fails. */
  fallback?: {
    reason: string;
    unit_count: number;
    unit_count_type: "Count" | "Ounce";
    number_of_items: number;
    request_product_type: string;
    expected_product_type: string;
    must_clear_issue_codes?: string[];
  };
}

/** Exact donor-label facts plus narrowly reviewed package configuration.
 * Manufacturer nutrition, shelf life, and inventory are intentionally absent:
 * this action cannot invent or overwrite them. */
export interface DesiredStructuredAttributesRepair {
  ingredients: string;
  ingredients_sha256: string;
  allergen_information: string[];
  reviewed_allergens: AllergenDeclaration;
  resolved_donor_ids: string[];
  item_package_quantity?: number;
  each_unit_count?: number;
  each_unit_count_absent?: true;
  is_expiration_dated_product?: true;
  merchant_shipping_group?: string;
}

export type RepairDesiredState =
  | { kind: "MEDIA"; value: DesiredMediaRepair }
  | { kind: "OFFER"; value: DesiredOfferRepair }
  | { kind: "TEXT_COUNT"; value: DesiredTextCountRepair }
  | {
      kind: "STRUCTURED_ATTRIBUTES";
      value: DesiredStructuredAttributesRepair;
    };

export interface PlannedRepairAction {
  action_id: string;
  kind: RepairActionKind;
  reasons: string[];
  review?: {
    confidence: "HIGH" | "MEDIUM" | "LOW";
    rationale: string;
    evidence: string[];
  };
  desired: RepairDesiredState;
}

export interface RepairPlanEntry {
  sku: string;
  asin: string;
  store_index: number;
  audited_product_type: string;
  actions: PlannedRepairAction[];
}

export interface RepairPlanBlocker {
  sku: string;
  asin: string | null;
  codes: string[];
  message: string;
}

/** Structured, SHA-bound evidence emitted only by the offline catalog-title
 * alignment workflow. Generic semantic validation does not consume this
 * object; the one reviewed Amazon package-arithmetic compatibility rule below
 * validates every member independently before allowing its narrow exception. */
export interface CatalogTitleAlignmentSemanticEvidence {
  schema_version: "uncrustables-amazon-catalog-title-alignment/v1";
  sku: string;
  asin: string;
  intended_count: number;
  catalog_title: string;
  recipe_identities: string[];
  identity_validation:
    | "GENERIC_STRICT"
    | "REVIEWED_CATALOG_API_EVIDENCE";
  catalog_conflict_evidence_sha256: string;
  reviewed_catalog_override?: {
    policy: "EXACT_REVIEWED_CATALOG_API_EVIDENCE_V1";
    catalog_evidence_path: string;
    catalog_evidence_file_sha256: string;
    catalog_evidence_body_sha256: string;
    catalog_evidence_row_sha256: string;
    catalog_api_identifiers: Array<{ type: string; value: string }>;
    exact_unit_count: number;
    exact_number_of_items: number | null;
    recipe_components_sha256: string;
    generic_rejection: string;
  };
}

export interface UncrustablesRepairPlan {
  schema_version: typeof REPAIR_PLAN_SCHEMA;
  immutable: true;
  plan_id: string;
  created_at: string;
  source_ledger: {
    path: string;
    sha256: string;
    audit_id: string;
    schema_version: string;
    completed_at: string | null;
  };
  /** Exact reviewed desired-state manifest bytes used to build this plan. A
   * programmatic/test plan may omit it, but live rollback preparation binds it
   * whenever present so an older same-ledger override file cannot be confused
   * with the reviewed source of truth. */
  desired_manifest_source?: {
    path: string;
    sha256: string;
    schema_version: typeof DESIRED_MANIFEST_SCHEMA;
    reviewed_at: string;
    source_ledger_sha256: string;
  } | null;
  /** Independent, owner-reviewed Layer B source. Keeping it separate from the
   * content manifest prevents a pricing experiment change from invalidating
   * catalog-title evidence or silently changing copy/media review lineage. */
  launch_pricing_source?: {
    path: string;
    sha256: string;
    schema_version: typeof UNCRUSTABLES_LAUNCH_PRICING_SCHEMA;
    reviewed_at: string;
    body_sha256: string;
    rows: number;
    coupon_rows: number;
    sale_price_rows: number;
  } | null;
  media_asset_source?: {
    path: string;
    sha256: string;
    schema_version: string;
    run_id: string;
    source_ledger_sha256: string;
    rows: number;
    qa_verified: true;
    gallery_manifest?: {
      path: string;
      sha256: string;
      schema_version: string;
      rows: number;
    };
  } | null;
  structured_attribute_source?: {
    donor_manifest: {
      path: string;
      sha256: string;
      schema_version: string;
      reviewed_at: string;
      source_ledger_sha256: string;
      donors: number;
      aliases: number;
    };
    ptd_proof: {
      path: string;
      sha256: string;
      schema_version: string;
      fetched_at: string;
      marketplace_id: string;
      product_types: string[];
    };
  } | null;
  policy: {
    marketplace_id: string;
    patch_only: true;
    validation_preview_required: true;
    post_get_verification_required: true;
    business_price_equals_consumer_price: true;
    discounted_price_absent: boolean;
    launch_pricing_overlay_pinned?: boolean;
    list_price_absent: true;
    structured_attributes_donor_reviewed: true;
    structured_attributes_ptd_proof_required: true;
    ingredient_keyword_allergen_inference: false;
    shelf_life_mutation: false;
    inventory_mutation: false;
    nutrition_mutation: false;
    brand_card_url: string;
    verified_brand_card_rehost_url: string;
  };
  scope: {
    requested_skus: string[] | null;
    limit: number | null;
    ledger_rows_considered: number;
    entries: number;
    actions: number;
    blocked: number;
  };
  semantic_audit: {
    validator: "validateSemanticOutput";
    checked: number;
    passed: number;
    failed: number;
    repaired_by_manifest: number;
    repaired_deterministically: number;
    blocked: number;
    failures: Array<{
      sku: string;
      intended_pack_count: number;
      error: string;
      disposition:
        | "EXPLICIT_TEXT_COUNT_REPAIR"
        | "DETERMINISTIC_RECIPE_REPAIR"
        | "BLOCKED_REVIEW_REQUIRED";
    }>;
  };
  entries: RepairPlanEntry[];
  blockers: RepairPlanBlocker[];
  sha256: string;
}

export interface DesiredRepairManifest {
  schema_version: typeof DESIRED_MANIFEST_SCHEMA;
  immutable?: true;
  source_ledger_sha256?: string;
  reviewed_at?: string;
  repairs: Array<{
    sku: string;
    review?: {
      confidence: "HIGH" | "MEDIUM" | "LOW";
      rationale: string;
      evidence: string[];
      catalog_title_alignment?: CatalogTitleAlignmentSemanticEvidence;
      supersedes?: Array<{
        field: "text_count.title";
        prior_value: string;
        source_manifest_path: string;
        source_manifest_sha256: string;
        reason: "AMAZON_CATALOG_ITEM_NAME_CONFLICT";
      }>;
    };
    media?: {
      main_image_url?: string;
      /** Slot 1 must be the fixed brand card. A full hero repair supplies 5-7
       * secondary images (card + 4-6 product images). */
      gallery_image_urls?: string[];
      /** Explicit tail slots to remove after writing gallery_image_urls. When
       * present this must be the exact contiguous complement through slot 8. */
      delete_gallery_slots?: number[];
    };
    offer?: Partial<DesiredOfferRepair>;
    text_count?: DesiredTextCountRepair;
    /** Optional exact rare-SKU package configuration. It is accepted only
     * alongside HIGH-confidence review evidence in this sealed manifest. */
    structured_attributes?: {
      item_package_quantity?: number;
      each_unit_count?: number;
      each_unit_count_absent?: true;
      is_expiration_dated_product?: true;
      merchant_shipping_group?: string;
    };
  }>;
}

export interface AmazonFoodPtdAttributeProof {
  schema_version: typeof PTD_ATTRIBUTE_PROOF_SCHEMA;
  immutable: true;
  fetched_at: string;
  evidence: {
    marketplace_id: string;
    requirements: "LISTING";
    locale: "en_US";
  };
  scope: {
    ledger_path: string;
    ledger_sha256: string;
    live_listing_count: number;
    product_type_counts: Record<string, number>;
  };
  shared_attribute_contract: {
    ingredients: {
      max_utf8_bytes: number;
    };
    allergen_information: {
      max_unique_items: number;
      full_enum_count: number;
      full_enum_sha256: string;
      enum_tokens: string[];
      may_contain_enum_count: number;
      may_contain_enum_sha256: string;
      may_contain_enum_tokens: string[];
    };
    each_unit_count: {
      max_unique_items: number;
      value_type: "number";
    };
  };
  product_types: Record<
    string,
    {
      schema_sha256: string;
      attributes: {
        ingredients: { contract: string };
        allergen_information: { contract: string };
        each_unit_count: { contract: string };
      };
    }
  >;
}

export interface HeroGenerationManifest {
  schema_version: typeof HERO_MANIFEST_SCHEMA;
  immutable: true;
  external_mutations?: {
    r2_asset_uploads?: number;
    amazon_calls?: number;
    database_writes?: number;
  };
  run_id: string;
  source_snapshot: { path?: string; sha256: string };
  summary: { target: number; succeeded: number; failed: number };
  rows: Array<{
    sku: string;
    asin: string;
    status: "SUCCEEDED" | string;
    gallery_image_urls?: string[];
    result?: {
      ok?: boolean;
      image_url?: string;
      image_sha256?: string;
      total_units?: number;
      expected_flavors?: string[];
      visible_boxes?: number;
      gallery_image_urls?: string[];
      gallery_qa?: { pass?: boolean; verified?: boolean };
      plan?: Array<{
        donor_id?: string;
        source_url?: string;
        source_reviewed?: boolean;
        recipe_qty?: number;
        visible_boxes?: number;
      }>;
      qa?: { pass?: boolean; verified?: boolean };
    };
  }>;
}

export interface ProductGalleryManifest {
  schema_version: typeof GALLERY_MANIFEST_SCHEMA;
  immutable: true;
  source_ledger_sha256: string;
  summary: { target: number; passed: number; failed: number };
  rows: Array<{
    sku: string;
    asin: string;
    verified: true;
    image_urls: string[];
    evidence: string[];
    assets: Array<{
      donor_id: string;
      donor_title: string;
      flavor: string;
      source_url: string;
      source_sha256: string;
      asset_sha256: string;
      dimensions: { width: number; height: number };
      r2_key: string;
      r2_url: string;
    }>;
  }>;
}

type UnknownRecord = Record<string, unknown>;

interface LedgerRowLike {
  sku?: unknown;
  asin?: unknown;
  store_index?: unknown;
  canonical?: {
    total_units?: unknown;
    components?: unknown;
    pricing?: {
      suggested?: unknown;
      floor?: unknown;
    };
  };
  live?: {
    fetched?: unknown;
    error?: unknown;
    product_type?: unknown;
    consumer_offer?: {
      our_price?: unknown;
      discounted_price?: unknown;
      minimum_seller_allowed_price?: unknown;
      maximum_seller_allowed_price?: unknown;
    };
    raw_attributes?: unknown;
    raw_offers?: unknown;
    gallery_image_urls?: unknown;
    title?: unknown;
    bullets?: unknown;
    description?: unknown;
    brand?: unknown;
  };
  db?: {
    channel_sku?: {
      attributes?: unknown;
    } | null;
    draft?: {
      id?: unknown;
      brand?: unknown;
      pack_count?: unknown;
      selected_variant_idx?: unknown;
      selected_variant?: {
        name?: unknown;
        composition?: unknown;
      } | null;
      secondary_image_urls?: unknown;
    } | null;
  };
  anomalies?: unknown;
}

interface LedgerLike {
  schema_version?: unknown;
  audit_id?: unknown;
  complete?: unknown;
  immutable?: unknown;
  mode?: unknown;
  external_mutations?: unknown;
  completed_at?: unknown;
  source_snapshot?: unknown;
  rows?: unknown;
}

export interface BuildRepairPlanOptions {
  ledgerPath: string;
  ledgerBytes: Buffer;
  manifest?: DesiredRepairManifest | null;
  manifestSource?: { path: string; bytes: Buffer } | null;
  launchPricingManifest?: {
    path: string;
    bytes: Buffer;
  } | null;
  heroManifest?: { path: string; bytes: Buffer } | null;
  galleryManifest?: { path: string; bytes: Buffer } | null;
  donorManifest?: { path: string; bytes: Buffer } | null;
  ptdProof?: { path: string; bytes: Buffer } | null;
  skus?: string[] | null;
  limit?: number | null;
  createdAt?: Date;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** JSON with recursively sorted object keys, used for stable digests. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function planDigest(plan: Omit<UncrustablesRepairPlan, "sha256">): string {
  return sha256(stableJson(plan));
}

export function verifyRepairPlan(plan: UncrustablesRepairPlan): void {
  if (plan.schema_version !== REPAIR_PLAN_SCHEMA || plan.immutable !== true) {
    throw new Error("Repair plan is not an immutable supported v2 plan.");
  }
  const { sha256: claimed, ...body } = plan;
  const actual = planDigest(body);
  if (claimed !== actual) {
    throw new Error(
      `Repair plan SHA-256 mismatch: expected ${claimed}, calculated ${actual}.`,
    );
  }
  if (
    plan.policy.shelf_life_mutation !== false ||
    plan.policy.inventory_mutation !== false ||
    plan.policy.nutrition_mutation !== false ||
    plan.policy.ingredient_keyword_allergen_inference !== false ||
    plan.policy.structured_attributes_donor_reviewed !== true ||
    plan.policy.structured_attributes_ptd_proof_required !== true
  ) {
    throw new Error("Repair plan structured-attribute safety policy was weakened.");
  }
  if (
    plan.desired_manifest_source != null &&
    (plan.desired_manifest_source.schema_version !== DESIRED_MANIFEST_SCHEMA ||
      !/^[a-f0-9]{64}$/i.test(plan.desired_manifest_source.sha256) ||
      !nonEmptyString(plan.desired_manifest_source.path) ||
      !nonEmptyString(plan.desired_manifest_source.reviewed_at) ||
      plan.desired_manifest_source.source_ledger_sha256 !==
        plan.source_ledger.sha256)
  ) {
    throw new Error("Repair plan desired-manifest source is invalid or unbound.");
  }
  if (
    plan.launch_pricing_source != null &&
    (plan.launch_pricing_source.schema_version !==
      UNCRUSTABLES_LAUNCH_PRICING_SCHEMA ||
      !/^[a-f0-9]{64}$/i.test(plan.launch_pricing_source.sha256) ||
      !/^[a-f0-9]{64}$/i.test(plan.launch_pricing_source.body_sha256) ||
      !nonEmptyString(plan.launch_pricing_source.path) ||
      !nonEmptyString(plan.launch_pricing_source.reviewed_at) ||
      plan.launch_pricing_source.rows <= 0 ||
      plan.launch_pricing_source.coupon_rows <= 0 ||
      plan.launch_pricing_source.sale_price_rows <= 0 ||
      plan.launch_pricing_source.coupon_rows +
        plan.launch_pricing_source.sale_price_rows !==
        plan.launch_pricing_source.rows)
  ) {
    throw new Error("Repair plan launch-pricing source is invalid or unbound.");
  }
  if (
    Boolean(plan.launch_pricing_source) !==
      (plan.policy.launch_pricing_overlay_pinned === true) ||
    (plan.launch_pricing_source != null &&
      plan.policy.discounted_price_absent !== false)
  ) {
    throw new Error("Repair plan launch-pricing policy/source binding is inconsistent.");
  }
  if (plan.structured_attribute_source) {
    if (
      plan.structured_attribute_source.donor_manifest.sha256 !==
        UNCRUSTABLES_DONOR_MANIFEST_SHA256 ||
      plan.structured_attribute_source.donor_manifest.source_ledger_sha256 !==
        plan.source_ledger.sha256 ||
      plan.structured_attribute_source.ptd_proof.sha256 !==
        PTD_ATTRIBUTE_PROOF_SHA256 ||
      plan.structured_attribute_source.ptd_proof.marketplace_id !== MARKETPLACE_ID
    ) {
      throw new Error("Repair plan structured-attribute sources are not exact pinned proofs.");
    }
  }
  const actionIds = new Set<string>();
  let structuredActions = 0;
  for (const entry of plan.entries) {
    let previousExecutionRank = -1;
    for (const action of entry.actions) {
      const executionRank = REPAIR_ACTION_EXECUTION_ORDER[action.kind];
      if (executionRank == null) {
        throw new Error(`Unsupported repair action kind in ${action.action_id}.`);
      }
      if (executionRank < previousExecutionRank) {
        throw new Error(
          `Unsafe repair action order for ${entry.sku}: ${action.kind} cannot follow a later dependency stage.`,
        );
      }
      previousExecutionRank = executionRank;
      if (actionIds.has(action.action_id)) {
        throw new Error(`Duplicate repair action id: ${action.action_id}`);
      }
      actionIds.add(action.action_id);
      if (action.kind !== action.desired.kind) {
        throw new Error(`Action kind mismatch in ${action.action_id}.`);
      }
      if (action.desired.kind === "MEDIA") {
        const media = action.desired.value;
        const written = media.gallery_slots.map((item) => item.slot);
        const deleted = media.delete_gallery_slots ?? [];
        if (
          written.some((slot) => !Number.isInteger(slot) || slot < 1 || slot > 8) ||
          deleted.some((slot) => !Number.isInteger(slot) || slot < 1 || slot > 8) ||
          new Set(written).size !== written.length ||
          new Set(deleted).size !== deleted.length ||
          written.some((slot) => deleted.includes(slot))
        ) {
          throw new Error(`Invalid/overlapping media slots in ${action.action_id}.`);
        }
        if (media.delete_gallery_slots !== undefined) {
          const expectedWritten = Array.from(
            { length: media.gallery_slots.length },
            (_, index) => index + 1,
          );
          const expectedDeleted = Array.from(
            { length: 8 - media.gallery_slots.length },
            (_, index) => media.gallery_slots.length + 1 + index,
          );
          if (
            stableJson(written) !== stableJson(expectedWritten) ||
            stableJson(deleted) !== stableJson(expectedDeleted)
          ) {
            throw new Error(
              `Explicit gallery replacement in ${action.action_id} must write a contiguous prefix and delete its exact tail through slot 8.`,
            );
          }
        }
        if (media.main_image_sha256 && !/^[a-f0-9]{64}$/i.test(media.main_image_sha256)) {
          throw new Error(`Invalid MAIN SHA-256 in ${action.action_id}.`);
        }
      } else if (action.desired.kind === "OFFER") {
        const offer = action.desired.value;
        for (const [field, amount] of [
          ["consumer_price", offer.consumer_price],
          ["business_price", offer.business_price],
          ["minimum_seller_allowed_price", offer.minimum_seller_allowed_price],
          ["maximum_seller_allowed_price", offer.maximum_seller_allowed_price],
        ] as const) {
          validateMoney(`${action.action_id}.${field}`, amount);
        }
        if (
          offer.currency !== "USD" ||
          offer.list_price_absent !== true ||
          differs(offer.business_price, offer.consumer_price) ||
          offer.minimum_seller_allowed_price > offer.consumer_price ||
          differs(offer.maximum_seller_allowed_price, offer.consumer_price)
        ) {
          throw new Error(`Invalid canonical offer state in ${action.action_id}.`);
        }
        const schedule = offer.discounted_price_schedule;
        if (Boolean(offer.launch_lever) !== Boolean(plan.launch_pricing_source)) {
          throw new Error(
            `Offer launch lever/source binding is inconsistent in ${action.action_id}.`,
          );
        }
        if (schedule) {
          validateMoney(
            `${action.action_id}.discounted_price_schedule.value_with_tax`,
            schedule.value_with_tax,
          );
        }
        if (offer.discounted_price_absent) {
          if (schedule != null || offer.launch_lever?.startsWith("SALEPRICE_")) {
            throw new Error(
              `Contradictory absent Sale Price policy in ${action.action_id}.`,
            );
          }
        } else if (
          !plan.launch_pricing_source ||
          !offer.launch_lever?.startsWith("SALEPRICE_") ||
          !schedule ||
          schedule.value_with_tax + 0.005 <
            offer.minimum_seller_allowed_price ||
          schedule.value_with_tax >= offer.consumer_price ||
          !Number.isFinite(Date.parse(schedule.start_at)) ||
          !Number.isFinite(Date.parse(schedule.end_at)) ||
          Date.parse(schedule.end_at) <= Date.parse(schedule.start_at)
        ) {
          throw new Error(`Invalid pinned Sale Price in ${action.action_id}.`);
        }
      } else if (action.desired.kind === "STRUCTURED_ATTRIBUTES") {
        structuredActions++;
        const structured = action.desired.value;
        if (
          !structured.ingredients ||
          Buffer.byteLength(structured.ingredients, "utf8") > 6000 ||
          structured.ingredients_sha256 !== sha256(structured.ingredients) ||
          structured.allergen_information.length === 0 ||
          structured.allergen_information.length > 20 ||
          new Set(structured.allergen_information).size !==
            structured.allergen_information.length ||
          structured.resolved_donor_ids.length === 0 ||
          new Set(structured.resolved_donor_ids).size !==
            structured.resolved_donor_ids.length ||
          structured.resolved_donor_ids.some(
            (id) =>
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                id,
              ),
          )
        ) {
          throw new Error(`Invalid structured desired state in ${action.action_id}.`);
        }
        const declaration = normalizeAllergenDeclaration(
          structured.reviewed_allergens,
          `${action.action_id}.reviewed_allergens`,
        );
        const contains = new Set(
          declaration.contains.map(canonicalAllergenToken),
        );
        const containsFamilies = new Set(
          declaration.contains.map(amazonAllergenFamily),
        );
        const mayLabels = declaration.may_contain.filter(
          (label) => !containsFamilies.has(amazonAllergenFamily(label)),
        );
        const expected = [
          ...Array.from(contains).sort(),
          ...mayLabels.map(amazonMayContainAllergenToken).sort(),
        ];
        if (stableJson(expected) !== stableJson(structured.allergen_information)) {
          throw new Error(
            `Structured allergen tokens do not match reviewed declarations in ${action.action_id}.`,
          );
        }
        for (const [field, value] of [
          ["item_package_quantity", structured.item_package_quantity],
          ["each_unit_count", structured.each_unit_count],
        ] as const) {
          if (value != null && (!Number.isInteger(value) || value <= 0)) {
            throw new Error(`Invalid ${field} in ${action.action_id}.`);
          }
        }
        if (
          structured.merchant_shipping_group != null &&
          !structured.merchant_shipping_group.trim()
        ) {
          throw new Error(
            `Invalid merchant_shipping_group in ${action.action_id}.`,
          );
        }
        const rawStructured = structured as unknown as Record<string, unknown>;
        if (
          rawStructured.each_unit_count_absent === false ||
          (structured.each_unit_count_absent === true &&
            structured.each_unit_count != null) ||
          rawStructured.is_expiration_dated_product === false
        ) {
          throw new Error(
            `Contradictory structured absence/expiration policy in ${action.action_id}.`,
          );
        }
      }
    }
  }
  if (structuredActions > 0 && !plan.structured_attribute_source) {
    throw new Error("Structured actions require exact pinned donor/PTD sources.");
  }
  if (
    plan.scope.entries !== plan.entries.length ||
    plan.scope.actions !==
      plan.entries.reduce((sum, entry) => sum + entry.actions.length, 0) ||
    plan.scope.blocked !== plan.blockers.length ||
    plan.semantic_audit.blocked !==
      plan.semantic_audit.failures.filter(
        (failure) => failure.disposition === "BLOCKED_REVIEW_REQUIRED",
      ).length
  ) {
    throw new Error("Repair plan scope/semantic summaries are inconsistent.");
  }
}

export function confirmationToken(plan: UncrustablesRepairPlan): string {
  verifyRepairPlan(plan);
  return `APPLY-UNCRUSTABLES-${plan.sha256.slice(0, 16).toUpperCase()}`;
}

export const REPAIR_EXECUTION_SELECTION_SCHEMA =
  "uncrustables-repair-execution-selection/v1" as const;
export const CONTENT_STRUCTURED_MEDIA_ONLY_PROFILE =
  "CONTENT_STRUCTURED_MEDIA_ONLY_V1" as const;
export const TEXT_STRUCTURED_ONLY_PROFILE =
  "TEXT_STRUCTURED_ONLY_V1" as const;
export const MAIN_MEDIA_ONLY_PROFILE =
  "MAIN_MEDIA_ONLY_V1" as const;
export const GALLERY_MEDIA_ONLY_PROFILE =
  "GALLERY_MEDIA_ONLY_V1" as const;
export const OFFER_PATCH_PATHS = [
  "/attributes/list_price",
  "/attributes/purchasable_offer",
] as const;
export const MEDIA_PATCH_PATHS = [
  "/attributes/main_product_image_locator",
  ...Array.from(
    { length: 8 },
    (_, index) => `/attributes/other_product_image_locator_${index + 1}`,
  ),
] as const;
/** Independent fail-closed boundary for OFFER-only execution. The exact
 * selected-action guard is still authoritative; this blacklist prevents a
 * future dispatcher regression from reaching any current content or media
 * attribute through the same gateway. */
export const OFFER_ONLY_FORBIDDEN_PATCH_PATHS = [
  "/attributes/allergen_information",
  "/attributes/bullet_point",
  "/attributes/each_unit_count",
  "/attributes/ingredients",
  "/attributes/is_expiration_dated_product",
  "/attributes/item_name",
  "/attributes/item_package_quantity",
  "/attributes/merchant_shipping_group",
  "/attributes/number_of_items",
  "/attributes/product_description",
  "/attributes/unit_count",
  ...MEDIA_PATCH_PATHS,
].sort();
/** Fail-closed profile boundary for secondary-gallery-only execution. The
 * exact selected action guard remains authoritative, while this blacklist
 * independently prevents MAIN, content, structured, and offer mutations. */
export const GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS = [
  "/attributes/allergen_information",
  "/attributes/bullet_point",
  "/attributes/each_unit_count",
  "/attributes/ingredients",
  "/attributes/is_expiration_dated_product",
  "/attributes/item_name",
  "/attributes/item_package_quantity",
  "/attributes/main_product_image_locator",
  "/attributes/merchant_shipping_group",
  "/attributes/number_of_items",
  "/attributes/product_description",
  "/attributes/unit_count",
  ...OFFER_PATCH_PATHS,
].sort();
/** Fail-closed profile boundary for MAIN-only execution. The exact selected
 * action guard remains authoritative, while this blacklist independently
 * prevents gallery, content, structured, and offer mutations. */
export const MAIN_MEDIA_FORBIDDEN_PATCH_PATHS = [
  "/attributes/allergen_information",
  "/attributes/bullet_point",
  "/attributes/each_unit_count",
  "/attributes/ingredients",
  "/attributes/is_expiration_dated_product",
  "/attributes/item_name",
  "/attributes/item_package_quantity",
  "/attributes/merchant_shipping_group",
  "/attributes/number_of_items",
  "/attributes/product_description",
  "/attributes/unit_count",
  ...MEDIA_PATCH_PATHS.filter(
    (patchPath) => patchPath !== "/attributes/main_product_image_locator",
  ),
  ...OFFER_PATCH_PATHS,
].sort();

export interface RepairExecutionSelectionInput {
  sourcePlanPath?: string | null;
  createdAt?: Date;
  skus?: string[] | null;
  limit?: number | null;
  /** An explicit subset is sealed into a selection-specific confirmation
   * token. Omitting this field preserves the legacy whole-action selection. */
  actionKinds?: RepairActionKind[] | null;
}

export interface RepairExecutionSelection {
  schema_version: typeof REPAIR_EXECUTION_SELECTION_SCHEMA;
  immutable: true;
  created_at: string;
  profile:
    | typeof CONTENT_STRUCTURED_MEDIA_ONLY_PROFILE
    | typeof TEXT_STRUCTURED_ONLY_PROFILE
    | typeof MAIN_MEDIA_ONLY_PROFILE
    | typeof GALLERY_MEDIA_ONLY_PROFILE
    | typeof OFFER_ONLY_EXECUTION_PROFILE
    | "EXACT_ACTION_SUBSET_V1";
  source_plan: { path: string | null; sha256: string };
  requested_skus: string[] | null;
  limit: number | null;
  requested_action_kinds: RepairActionKind[] | null;
  selected_skus: string[];
  selected_action_ids: string[];
  selected_actions: number;
  forbidden_patch_paths: string[];
  sha256: string;
  confirmation_token: string;
}

function resolveRepairExecutionSelection(
  plan: UncrustablesRepairPlan,
  input: RepairExecutionSelectionInput = {},
): { entries: RepairPlanEntry[]; selection: RepairExecutionSelection } {
  verifyRepairPlan(plan);
  const requestedSkus = input.skus?.length
    ? [...new Set(input.skus.map((sku) => sku.trim()).filter(Boolean))]
    : null;
  const requested = requestedSkus ? new Set(requestedSkus) : null;
  let entries = plan.entries.filter(
    (entry) => !requested || requested.has(entry.sku),
  );
  if (requested) {
    const found = new Set(entries.map((entry) => entry.sku));
    const missing = requestedSkus!.filter((sku) => !found.has(sku));
    if (missing.length) {
      throw new Error(
        `Requested SKU(s) absent from plan entries: ${missing.join(", ")}`,
      );
    }
  }
  const limit = input.limit ?? null;
  if (limit != null) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Execution limit must be a positive integer.");
    }
    entries = entries.slice(0, limit);
  }

  let requestedKinds: RepairActionKind[] | null = null;
  if (input.actionKinds != null) {
    if (input.actionKinds.length === 0) {
      throw new Error("Explicit actionKinds selection cannot be empty.");
    }
    const validKinds = new Set<RepairActionKind>(
      Object.keys(REPAIR_ACTION_EXECUTION_ORDER) as RepairActionKind[],
    );
    for (const kind of input.actionKinds) {
      if (!validKinds.has(kind)) {
        throw new Error(`Unknown repair action kind: ${String(kind)}.`);
      }
    }
    requestedKinds = [...new Set(input.actionKinds)].sort(
      (left, right) =>
        REPAIR_ACTION_EXECUTION_ORDER[left] -
        REPAIR_ACTION_EXECUTION_ORDER[right],
    );
    const allowed = new Set(requestedKinds);
    entries = entries
      .map((entry) => ({
        ...entry,
        actions: entry.actions.filter((action) => allowed.has(action.kind)),
      }))
      .filter((entry) => entry.actions.length > 0);
  }
  const actionIds = entries.flatMap((entry) =>
    entry.actions.map((action) => action.action_id),
  );
  if (actionIds.length === 0) {
    throw new Error("Execution selection contains no repair actions.");
  }
  const nonOfferKinds: RepairActionKind[] = [
    "TEXT_COUNT",
    "STRUCTURED_ATTRIBUTES",
    "MEDIA",
  ];
  const textStructuredKinds: RepairActionKind[] = [
    "TEXT_COUNT",
    "STRUCTURED_ATTRIBUTES",
  ];
  const mediaKinds: RepairActionKind[] = ["MEDIA"];
  const offerKinds: RepairActionKind[] = ["OFFER"];
  const isContentOnly =
    requestedKinds != null &&
    stableJson(requestedKinds) === stableJson(nonOfferKinds);
  const isTextStructuredOnly =
    requestedKinds != null &&
    stableJson(requestedKinds) === stableJson(textStructuredKinds);
  const isMediaOnly =
    requestedKinds != null &&
    stableJson(requestedKinds) === stableJson(mediaKinds);
  const isOfferOnly =
    requestedKinds != null &&
    stableJson(requestedKinds) === stableJson(offerKinds);
  const selectedMediaActions = entries.flatMap((entry) => entry.actions);
  const isMainMediaOnly =
    isMediaOnly &&
    selectedMediaActions.every(
      (action) =>
        action.kind === "MEDIA" &&
        action.desired.kind === "MEDIA" &&
        action.desired.value.main_image_url != null &&
        action.desired.value.gallery_slots.length === 0 &&
        (action.desired.value.delete_gallery_slots?.length ?? 0) === 0 &&
        stableJson(potentialActionPatchPaths(action)) ===
          stableJson(["/attributes/main_product_image_locator"]),
    );
  const isGalleryMediaOnly =
    isMediaOnly &&
    selectedMediaActions.every(
      (action) =>
        action.kind === "MEDIA" &&
        action.desired.kind === "MEDIA" &&
        action.desired.value.main_image_url == null &&
        action.desired.value.main_image_sha256 == null &&
        potentialActionPatchPaths(action).every((patchPath) =>
          /^\/attributes\/other_product_image_locator_[1-8]$/.test(patchPath),
        ),
    );
  if (isMediaOnly && !isMainMediaOnly && !isGalleryMediaOnly) {
    throw new Error(
      "MEDIA-only execution selection must contain uniformly MAIN-only or gallery-only actions/paths.",
    );
  }
  const body = {
    schema_version: REPAIR_EXECUTION_SELECTION_SCHEMA,
    immutable: true as const,
    created_at: (input.createdAt ?? new Date()).toISOString(),
    profile: isContentOnly
      ? CONTENT_STRUCTURED_MEDIA_ONLY_PROFILE
      : isTextStructuredOnly
        ? TEXT_STRUCTURED_ONLY_PROFILE
        : isMainMediaOnly
          ? MAIN_MEDIA_ONLY_PROFILE
          : isGalleryMediaOnly
            ? GALLERY_MEDIA_ONLY_PROFILE
            : isOfferOnly
              ? OFFER_ONLY_EXECUTION_PROFILE
              : ("EXACT_ACTION_SUBSET_V1" as const),
    source_plan: {
      path: input.sourcePlanPath?.trim() || null,
      sha256: plan.sha256,
    },
    requested_skus: requestedSkus,
    limit,
    requested_action_kinds: requestedKinds,
    selected_skus: entries.map((entry) => entry.sku),
    selected_action_ids: actionIds,
    selected_actions: actionIds.length,
    forbidden_patch_paths: isContentOnly
      ? [...OFFER_PATCH_PATHS]
      : isTextStructuredOnly
        ? [...OFFER_PATCH_PATHS, ...MEDIA_PATCH_PATHS].sort()
        : isMainMediaOnly
          ? [...MAIN_MEDIA_FORBIDDEN_PATCH_PATHS]
          : isGalleryMediaOnly
            ? [...GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS]
            : isOfferOnly
              ? [...OFFER_ONLY_FORBIDDEN_PATCH_PATHS]
              : [],
  };
  const digest = sha256(stableJson(body));
  return {
    entries,
    selection: {
      ...body,
      sha256: digest,
      confirmation_token: requestedKinds == null
        ? confirmationToken(plan)
        : `APPLY-UNCRUSTABLES-SELECTION-${digest.slice(0, 16).toUpperCase()}`,
    },
  };
}

export function repairExecutionSelection(
  plan: UncrustablesRepairPlan,
  input: RepairExecutionSelectionInput = {},
): RepairExecutionSelection {
  return resolveRepairExecutionSelection(plan, input).selection;
}

export function verifyRepairExecutionSelection(
  plan: UncrustablesRepairPlan,
  selection: RepairExecutionSelection,
): void {
  verifyRepairPlan(plan);
  const { sha256: claimed, confirmation_token: claimedToken, ...body } =
    selection;
  if (
    selection.schema_version !== REPAIR_EXECUTION_SELECTION_SCHEMA ||
    selection.immutable !== true ||
    !Number.isFinite(new Date(selection.created_at).getTime()) ||
    selection.source_plan.sha256 !== plan.sha256 ||
    claimed !== sha256(stableJson(body)) ||
    claimedToken !==
      `APPLY-UNCRUSTABLES-SELECTION-${claimed.slice(0, 16).toUpperCase()}`
  ) {
    throw new Error("Invalid or tampered repair execution selection.");
  }
  if (selection.requested_action_kinds == null) {
    throw new Error("Persisted execution selection must contain explicit action kinds.");
  }
  const recomputed = resolveRepairExecutionSelection(plan, {
    sourcePlanPath: selection.source_plan.path,
    createdAt: new Date(selection.created_at),
    skus: selection.requested_skus,
    limit: selection.limit,
    actionKinds: selection.requested_action_kinds,
  }).selection;
  if (stableJson(recomputed) !== stableJson(selection)) {
    throw new Error(
      "Repair execution selection does not exactly match its sealed source plan.",
    );
  }
  if (selection.profile === CONTENT_STRUCTURED_MEDIA_ONLY_PROFILE) {
    if (
      selection.requested_action_kinds.includes("OFFER") ||
      stableJson(selection.forbidden_patch_paths) !==
        stableJson([...OFFER_PATCH_PATHS]) ||
      selection.selected_action_ids.some((actionId) =>
        plan.entries.some((entry) =>
          entry.actions.some(
            (action) => action.action_id === actionId && action.kind === "OFFER",
          ),
        ),
      )
    ) {
      throw new Error("Content-only execution selection contains an OFFER action.");
    }
  } else if (selection.profile === TEXT_STRUCTURED_ONLY_PROFILE) {
    const excludedKinds = new Set<RepairActionKind>(["MEDIA", "OFFER"]);
    if (
      selection.requested_action_kinds.some((kind) => excludedKinds.has(kind)) ||
      stableJson(selection.forbidden_patch_paths) !==
        stableJson([...OFFER_PATCH_PATHS, ...MEDIA_PATCH_PATHS].sort()) ||
      selection.selected_action_ids.some((actionId) =>
        plan.entries.some((entry) =>
          entry.actions.some(
            (action) =>
              action.action_id === actionId && excludedKinds.has(action.kind),
          ),
        ),
      )
    ) {
      throw new Error(
        "Text/structured-only execution selection contains a MEDIA or OFFER action.",
      );
    }
  } else if (selection.profile === MAIN_MEDIA_ONLY_PROFILE) {
    const selectedActionIds = new Set(selection.selected_action_ids);
    const selectedActions = plan.entries.flatMap((entry) =>
      entry.actions.filter((action) => selectedActionIds.has(action.action_id)),
    );
    if (
      stableJson(selection.requested_action_kinds) !== stableJson(["MEDIA"]) ||
      stableJson(selection.forbidden_patch_paths) !==
        stableJson(MAIN_MEDIA_FORBIDDEN_PATCH_PATHS) ||
      selectedActions.length !== selection.selected_action_ids.length ||
      selectedActions.some(
        (action) =>
          action.kind !== "MEDIA" ||
          action.desired.kind !== "MEDIA" ||
          action.desired.value.main_image_url == null ||
          action.desired.value.gallery_slots.length !== 0 ||
          (action.desired.value.delete_gallery_slots?.length ?? 0) !== 0 ||
          stableJson(potentialActionPatchPaths(action)) !==
            stableJson(["/attributes/main_product_image_locator"]),
      )
    ) {
      throw new Error(
        "MAIN-media-only execution selection contains gallery or a non-MAIN action/path.",
      );
    }
  } else if (selection.profile === GALLERY_MEDIA_ONLY_PROFILE) {
    const selectedActionIds = new Set(selection.selected_action_ids);
    const selectedActions = plan.entries.flatMap((entry) =>
      entry.actions.filter((action) => selectedActionIds.has(action.action_id)),
    );
    if (
      stableJson(selection.requested_action_kinds) !== stableJson(["MEDIA"]) ||
      stableJson(selection.forbidden_patch_paths) !==
        stableJson(GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS) ||
      selectedActions.length !== selection.selected_action_ids.length ||
      selectedActions.some(
        (action) =>
          action.kind !== "MEDIA" ||
          action.desired.kind !== "MEDIA" ||
          action.desired.value.main_image_url != null ||
          action.desired.value.main_image_sha256 != null ||
          potentialActionPatchPaths(action).some(
            (patchPath) =>
              !/^\/attributes\/other_product_image_locator_[1-8]$/.test(
                patchPath,
              ),
          ),
      )
    ) {
      throw new Error(
        "Gallery-media-only execution selection contains MAIN or a non-gallery action/path.",
      );
    }
  } else if (selection.profile === OFFER_ONLY_EXECUTION_PROFILE) {
    const selectedActionIds = new Set(selection.selected_action_ids);
    const selectedActions = plan.entries.flatMap((entry) =>
      entry.actions.filter((action) => selectedActionIds.has(action.action_id)),
    );
    if (
      stableJson(selection.requested_action_kinds) !== stableJson(["OFFER"]) ||
      stableJson(selection.forbidden_patch_paths) !==
        stableJson(OFFER_ONLY_FORBIDDEN_PATCH_PATHS) ||
      selectedActions.length !== selection.selected_action_ids.length ||
      selectedActions.some(
        (action) =>
          action.kind !== "OFFER" ||
          action.desired.kind !== "OFFER" ||
          potentialActionPatchPaths(action).some(
            (patchPath) =>
              !(OFFER_PATCH_PATHS as readonly string[]).includes(patchPath),
          ),
      )
    ) {
      throw new Error(
        "OFFER-only execution selection contains a non-OFFER action/path.",
      );
    }
    assertOfferOnlyExecutionSelection({ plan, selection });
  }
}

export async function writeImmutableRepairExecutionSelection(
  outputDir: string,
  selection: RepairExecutionSelection,
): Promise<string> {
  const file = path.join(
    outputDir,
    `URES-${selection.created_at.replace(/[-:.]/g, "")}-${selection.sha256.slice(0, 12)}.json`,
  );
  await mkdir(outputDir, { recursive: true });
  await writeFile(file, `${JSON.stringify(selection, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return file;
}

export async function readRepairExecutionSelection(
  file: string,
  plan: UncrustablesRepairPlan,
): Promise<RepairExecutionSelection> {
  const selection = JSON.parse(
    await readFile(file, "utf8"),
  ) as RepairExecutionSelection;
  verifyRepairExecutionSelection(plan, selection);
  return selection;
}

function assertHttpsUrl(label: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use https.`);
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new Error(`${label} is not a safe public image URL.`);
  }
}

function validateMoney(label: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 10_000) {
    throw new Error(`${label} must be a finite positive dollar amount.`);
  }
  const rounded = roundMoney(value);
  if (Math.abs(rounded - value) > 0.00001) {
    throw new Error(`${label} must have at most two decimal places.`);
  }
  return rounded;
}

function validateTextCount(value: DesiredTextCountRepair, sku: string): void {
  const keys = Object.keys(value);
  if (keys.length === 0) {
    throw new Error(`Manifest text_count for ${sku} is empty.`);
  }
  if (value.title != null && !value.title.trim()) {
    throw new Error(`Manifest title for ${sku} is empty.`);
  }
  if (value.bullets != null) {
    if (
      value.bullets.length !== 5 ||
      value.bullets.some((bullet) => !bullet.trim())
    ) {
      throw new Error(`Manifest bullets for ${sku} must contain 5 non-empty bullets.`);
    }
  }
  if (value.description != null && !value.description.trim()) {
    throw new Error(`Manifest description for ${sku} is empty.`);
  }
  for (const [label, count] of [
    ["unit_count", value.unit_count],
    ["number_of_items", value.number_of_items],
  ] as const) {
    if (count != null && (!Number.isInteger(count) || count <= 0)) {
      throw new Error(`Manifest ${label} for ${sku} must be a positive integer.`);
    }
  }
  if (value.unit_count_type != null && value.unit_count == null) {
    throw new Error(`Manifest unit_count_type for ${sku} requires unit_count.`);
  }
  if (value.unit_count_type === "Ounce" && value.number_of_items == null) {
    throw new Error(
      `Manifest Ounce unit_count for ${sku} requires number_of_items as the sellable pack count.`,
    );
  }
  if (value.request_product_type != null && !value.request_product_type.trim()) {
    throw new Error(`Manifest request_product_type for ${sku} is empty.`);
  }
  if (value.expected_product_type != null && !value.expected_product_type.trim()) {
    throw new Error(`Manifest expected_product_type for ${sku} is empty.`);
  }
  if (value.must_clear_issue_codes?.some((code) => !code.trim())) {
    throw new Error(`Manifest issue-code gate for ${sku} contains an empty code.`);
  }
  if (value.fallback) {
    const fallback = value.fallback;
    if (
      !fallback.reason.trim() ||
      !Number.isInteger(fallback.unit_count) ||
      fallback.unit_count <= 0 ||
      !Number.isInteger(fallback.number_of_items) ||
      fallback.number_of_items <= 0 ||
      !fallback.request_product_type.trim() ||
      !fallback.expected_product_type.trim()
    ) {
      throw new Error(`Manifest fallback strategy for ${sku} is incomplete.`);
    }
  }
}

/** Amazon PASTRY can require a physical-weight unit_count while
 * number_of_items remains the customer-facing sandwich count. Never treat a
 * reviewed ounce total (for example 252 oz) as a 252-sandwich recipe. */
function desiredPackCount(
  value: DesiredTextCountRepair | null | undefined,
): number | null {
  if (!value) return null;
  if (value.unit_count_type === "Ounce") {
    return value.number_of_items ?? null;
  }
  return value.unit_count ?? value.number_of_items ?? null;
}

function semanticComponent(value: unknown): VariantComponent | null {
  if (!isRecord(value)) return null;
  const productName = nonEmptyString(value.product_name);
  const qty = finiteNumber(value.qty);
  if (!productName || qty == null || !Number.isInteger(qty) || qty <= 0) return null;
  return {
    research_pool_id:
      nonEmptyString(value.product_id ?? value.research_pool_id) ?? "ledger",
    product_name: productName,
    brand: nonEmptyString(value.brand) ?? "Uncrustables",
    ...(nonEmptyString(value.flavor) ? { flavor: nonEmptyString(value.flavor) as string } : {}),
    qty,
    unit_price_cents: finiteNumber(value.unit_price_cents) ?? 0,
  };
}

function semanticComponentsForRow(row: LedgerRowLike): VariantComponent[] {
  const selectedRaw = row.db?.draft?.selected_variant?.composition;
  const canonicalRaw = isRecord(row.canonical) ? row.canonical.components : undefined;
  const rawComponents = Array.isArray(selectedRaw)
    ? selectedRaw
    : Array.isArray(canonicalRaw)
      ? canonicalRaw
      : [];
  return rawComponents
    .map(semanticComponent)
    .filter((component): component is VariantComponent => component != null);
}

/**
 * Amazon's exact catalog title for this one reviewed ASIN exposes both the
 * manufacturer retail configuration (4ct × pack of 6) and the sellable total
 * (24 sandwiches).  The generic validator must continue to reject that shape
 * everywhere else: this compatibility record is pinned to the immutable
 * 2026-07-18 alignment output and its Catalog Items identifier evidence.
 */
export const REVIEWED_SZ_CATALOG_ALIGNED_MANIFEST_FILE_SHA256 =
  "b3cb16800c6ef286fcb0df00e0e8d4c6fde0829fd91869f2f768c57d6d9ad2b6" as const;
export const REVIEWED_SZ_CATALOG_ALIGNED_MANIFEST_BODY_SHA256 =
  "068d4fa70d67eee64d05caedd1fd2c38208ec5de9ef30ca8f5ad64ee00c20ed0" as const;

const REVIEWED_SZ_CATALOG_PACKAGING = {
  sku: "SZ-ASPI-JFAT",
  asin: "B0H776M5B5",
  title:
    "Uncrustables Frozen Peanut Butter & Blackberry Spread Sandwiches, 8oz/4ct - Pack of 6 (24 Sandwiches Total)",
  semantic_error:
    "own-brand title must contain exactly one count claim equal to 24; found 4",
  semantic_title:
    "Uncrustables Frozen Peanut Butter & Blackberry Spread Sandwiches, 24 Count",
  intended_count: 24,
  product_id: "03eba512-c138-4942-bd34-177fae87c91b",
  product_name:
    "Smucker's Uncrustables Frozen Peanut Butter & Blackberry Spread Sandwich - 8oz/4ct",
  unit_price_cents: 97,
  source_ledger_sha256:
    "46a80e727880d83bd9e52a1c58c753eeeede0cb8cbdd3443e825aba9cbaaa02f",
  source_plan_internal_sha256:
    "0ed98236c3d0331da923c7227bd62791d9c50307ffcf0ad5ccf9f8104567ebae",
  source_plan_file_sha256:
    "9c243c8b2295916f7ceb5fa0d8f7e3043ca0b7ad93013552f65ba00cee17e469",
  source_manifest_file_sha256:
    "f7e02809067844330baf60f8cc1b886d15ab6154d72eff77b7b3a56715629dea",
  source_manifest_body_sha256:
    "82d59b1d3795f7b058204c4ca7848a4372e61fc1559799aac933cb67bf120e61",
  checkpoint_set_sha256:
    "f95618bc5f5c4e9cfafd4c2df80867ea9027432673cf5051a420d2d701594565",
  catalog_evidence_file_sha256:
    "b26c6933c301cec61a03a143d39c646e87943db7e4411e43129314918be86c49",
  catalog_evidence_body_sha256:
    "2ffb50e1c21fd060a0b1f49a0bae39981f87d5288b55429e504c0f71992e1b3e",
  catalog_evidence_row_sha256:
    "133f947f3d38ccfe81c92b585cf85eea29d2e8094e163275502b37e52688809e",
  catalog_conflict_evidence_sha256:
    "86f2db04540db6e84ae520c3611d93c4fcc8affb0db2ddc6f87b4badd955abaa",
  recipe_components_sha256:
    "07279ea01794a3c090cc46e81bd042554554a9f21171184f5d2af502e686f93b",
  prior_title:
    "Smucker's Uncrustables Peanut Butter & Blackberry Spread Frozen Sandwiches, Individually Wrapped, 24 Count",
  identifiers: [
    { type: "ean", value: "0664554043946" },
    { type: "upc", value: "664554043946" },
  ],
} as const;

function exactRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

function exactStringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function canonicalDesiredManifestBodySha256(
  manifest: DesiredRepairManifest,
): string | null {
  const record = manifest as unknown as UnknownRecord;
  if (typeof record.body_sha256 !== "string") return null;
  const body = { ...record };
  delete body.body_sha256;
  return sha256(stableJson(body));
}

function exactRecipeComponentProjection(value: unknown): UnknownRecord | null {
  if (!isRecord(value)) return null;
  return {
    product_id: value.product_id,
    product_name: value.product_name,
    brand: value.brand,
    flavor: value.flavor ?? null,
    qty: value.qty,
    unit_price_cents: value.unit_price_cents,
  };
}

/**
 * Fail-closed compatibility gate for the one exact catalog-owned title that
 * legitimately contains retail-package numerals.  It does not change
 * `validateSemanticOutput`; it merely proves that removing Amazon's package
 * arithmetic makes the otherwise exact recipe/count content pass unchanged.
 */
function acceptsReviewedSzCatalogPackagingTitle(input: {
  manifest: DesiredRepairManifest | null | undefined;
  manifestSourceSha256: string | null;
  ledgerSha256: string;
  row: LedgerRowLike;
  explicit: DesiredRepairManifest["repairs"][number];
  intendedPackCount: number;
  semanticError: string;
  variant: Variant;
}): boolean {
  const policy = REVIEWED_SZ_CATALOG_PACKAGING;
  const manifest = input.manifest;
  if (
    !manifest ||
    manifest.immutable !== true ||
    manifest.repairs.length !== 164 ||
    manifest.source_ledger_sha256 !== policy.source_ledger_sha256 ||
    input.ledgerSha256 !== policy.source_ledger_sha256 ||
    input.manifestSourceSha256 !==
      REVIEWED_SZ_CATALOG_ALIGNED_MANIFEST_FILE_SHA256 ||
    (manifest as unknown as UnknownRecord).body_sha256 !==
      REVIEWED_SZ_CATALOG_ALIGNED_MANIFEST_BODY_SHA256 ||
    canonicalDesiredManifestBodySha256(manifest) !==
      REVIEWED_SZ_CATALOG_ALIGNED_MANIFEST_BODY_SHA256 ||
    input.semanticError !== policy.semantic_error ||
    input.intendedPackCount !== policy.intended_count ||
    input.explicit.sku !== policy.sku ||
    input.row.sku !== policy.sku ||
    input.row.asin !== policy.asin ||
    input.explicit.text_count?.title !== policy.title ||
    input.explicit.text_count.unit_count !== policy.intended_count ||
    input.explicit.text_count.unit_count_type !== "Count" ||
    input.explicit.text_count.number_of_items !== policy.intended_count ||
    input.explicit.review?.confidence !== "HIGH"
  ) {
    return false;
  }

  const sourceArtifacts = exactRecord(
    (manifest as unknown as UnknownRecord).source_artifacts,
  );
  const alignment = exactRecord(
    sourceArtifacts?.amazon_catalog_title_alignment,
  );
  const sourcePlan = exactRecord(alignment?.source_plan);
  const sourceManifest = exactRecord(alignment?.source_desired_manifest);
  const sourceLedger = exactRecord(alignment?.source_ledger);
  const checkpointSet = exactRecord(alignment?.checkpoint_set);
  const catalogEvidence = exactRecord(
    alignment?.reviewed_catalog_api_evidence,
  );
  if (
    alignment?.schema_version !==
      "uncrustables-amazon-catalog-title-alignment/v1" ||
    alignment.offline_only !== true ||
    sourcePlan?.internal_sha256 !== policy.source_plan_internal_sha256 ||
    sourcePlan.file_sha256 !== policy.source_plan_file_sha256 ||
    sourceManifest?.file_sha256 !== policy.source_manifest_file_sha256 ||
    sourceManifest.body_sha256 !== policy.source_manifest_body_sha256 ||
    sourceLedger?.file_sha256 !== policy.source_ledger_sha256 ||
    checkpointSet?.sha256 !== policy.checkpoint_set_sha256 ||
    checkpointSet.files !== 605 ||
    checkpointSet.selected_actions !== 605 ||
    checkpointSet.terminal_preview_valid !== 569 ||
    checkpointSet.terminal_failed_catalog_title_conflict !== 34 ||
    checkpointSet.terminal_staged_dependency_exceptions !== 2 ||
    catalogEvidence?.schema_version !==
      "uncrustables-catalog-title-api-evidence/v1" ||
    catalogEvidence.file_sha256 !== policy.catalog_evidence_file_sha256 ||
    catalogEvidence.body_sha256 !== policy.catalog_evidence_body_sha256 ||
    alignment.aligned_rows !== 34 ||
    alignment.generic_strict_alignments !== 29 ||
    alignment.reviewed_catalog_api_overrides !== 5 ||
    stableJson(exactStringList(catalogEvidence.exact_override_skus)) !==
      stableJson([
        "KD-AS12-8HZ3",
        "RL-AS64-Q8QX",
        "SZ-ASPI-JFAT",
        "VA-ASOK-QJCA",
        "WK-AS2R-FJUW",
      ])
  ) {
    return false;
  }

  const rowEvidence = input.explicit.review.catalog_title_alignment;
  const override = rowEvidence?.reviewed_catalog_override;
  if (
    rowEvidence?.schema_version !==
      "uncrustables-amazon-catalog-title-alignment/v1" ||
    rowEvidence.sku !== policy.sku ||
    rowEvidence.asin !== policy.asin ||
    rowEvidence.intended_count !== policy.intended_count ||
    rowEvidence.catalog_title !== policy.title ||
    stableJson(rowEvidence.recipe_identities) !== stableJson(["BLACKBERRY"]) ||
    rowEvidence.identity_validation !== "REVIEWED_CATALOG_API_EVIDENCE" ||
    rowEvidence.catalog_conflict_evidence_sha256 !==
      policy.catalog_conflict_evidence_sha256 ||
    override?.policy !== "EXACT_REVIEWED_CATALOG_API_EVIDENCE_V1" ||
    override.catalog_evidence_file_sha256 !==
      policy.catalog_evidence_file_sha256 ||
    override.catalog_evidence_body_sha256 !==
      policy.catalog_evidence_body_sha256 ||
    override.catalog_evidence_row_sha256 !==
      policy.catalog_evidence_row_sha256 ||
    stableJson(override.catalog_api_identifiers) !==
      stableJson(policy.identifiers) ||
    override.exact_unit_count !== policy.intended_count ||
    override.exact_number_of_items !== null ||
    override.recipe_components_sha256 !== policy.recipe_components_sha256 ||
    override.generic_rejection !==
      "Amazon catalog title must contain exactly one exact 24 Count claim."
  ) {
    return false;
  }

  const supersedes = input.explicit.review.supersedes;
  if (
    !Array.isArray(supersedes) ||
    supersedes.length !== 1 ||
    supersedes[0].field !== "text_count.title" ||
    supersedes[0].prior_value !== policy.prior_title ||
    supersedes[0].source_manifest_sha256 !==
      policy.source_manifest_file_sha256 ||
    supersedes[0].reason !== "AMAZON_CATALOG_ITEM_NAME_CONFLICT"
  ) {
    return false;
  }

  const expectedComponent = {
    product_id: policy.product_id,
    product_name: policy.product_name,
    brand: "Uncrustables",
    flavor: null,
    qty: policy.intended_count,
    unit_price_cents: policy.unit_price_cents,
  };
  const selectedComponents = input.row.db?.draft?.selected_variant?.composition;
  const canonicalComponents = input.row.canonical?.components;
  if (
    input.row.db?.draft?.pack_count !== policy.intended_count ||
    !Array.isArray(selectedComponents) ||
    selectedComponents.length !== 1 ||
    !Array.isArray(canonicalComponents) ||
    canonicalComponents.length !== 1 ||
    stableJson(exactRecipeComponentProjection(selectedComponents[0])) !==
      stableJson(expectedComponent) ||
    stableJson(exactRecipeComponentProjection(canonicalComponents[0])) !==
      stableJson(expectedComponent)
  ) {
    return false;
  }

  const packageMatch = policy.title.match(
    /^Uncrustables Frozen Peanut Butter & Blackberry Spread Sandwiches, (\d+(?:\.\d+)?)oz\/(\d+)ct - Pack of (\d+) \((\d+) Sandwiches Total\)$/,
  );
  if (!packageMatch) return false;
  const [, ouncesRaw, retailCountRaw, retailPacksRaw, totalRaw] = packageMatch;
  const ounces = Number(ouncesRaw);
  const retailCount = Number(retailCountRaw);
  const retailPacks = Number(retailPacksRaw);
  const explicitTotal = Number(totalRaw);
  if (
    ounces !== 8 ||
    retailCount !== 4 ||
    retailPacks !== 6 ||
    explicitTotal !== policy.intended_count ||
    retailCount * retailPacks !== explicitTotal
  ) {
    return false;
  }

  return (
    validateSemanticOutput(
      {
        title: policy.semantic_title,
        bullets: input.explicit.text_count.bullets,
        description: input.explicit.text_count.description,
      },
      {
        brand:
          nonEmptyString(input.row.db?.draft?.brand) ??
          nonEmptyString(input.row.live?.brand) ??
          "Uncrustables",
        pack_count: policy.intended_count,
        selected_variant: input.variant,
      },
    ) === null
  );
}

function semanticAuditForRow(
  row: LedgerRowLike,
  explicit: DesiredRepairManifest["repairs"][number] | null | undefined,
  useExplicitText = false,
): { intendedPackCount: number; error: string | null; variant: Variant } | null {
  if (row.live?.fetched !== true) return null;
  const components = semanticComponentsForRow(row);
  if (components.length === 0) return null;
  const selectedTotal = components.reduce((sum, component) => sum + component.qty, 0);
  const explicitCount = desiredPackCount(explicit?.text_count);
  const intendedPackCount = explicitCount ?? selectedTotal;
  const variant: Variant = {
    idx: 0,
    name:
      nonEmptyString(row.db?.draft?.selected_variant?.name) ??
      nonEmptyString(row.sku) ??
      "ledger",
    composition: components,
    cost_cents: 0,
    suggested_price_cents: 0,
    margin_cents: 0,
    margin_pct: 0,
    feasibility_score: 0,
    notes: "Immutable ledger semantic audit",
  };
  const liveBullets = Array.isArray(row.live?.bullets)
    ? row.live.bullets.filter((value): value is string => typeof value === "string")
    : [];
  const desired = useExplicitText ? explicit?.text_count : null;
  const error = validateSemanticOutput(
    {
      title: desired?.title ?? row.live?.title,
      bullets: desired?.bullets ?? liveBullets,
      description: desired?.description ?? row.live?.description,
    },
    {
      brand:
        nonEmptyString(row.db?.draft?.brand) ??
        nonEmptyString(row.live?.brand) ??
        "Uncrustables",
      pack_count: intendedPackCount,
      selected_variant: variant,
    },
  );
  return { intendedPackCount, error, variant };
}

function parseManifest(
  manifest: DesiredRepairManifest | null | undefined,
): Map<string, DesiredRepairManifest["repairs"][number]> {
  const result = new Map<string, DesiredRepairManifest["repairs"][number]>();
  if (!manifest) return result;
  if (
    manifest.schema_version !== DESIRED_MANIFEST_SCHEMA ||
    !Array.isArray(manifest.repairs)
  ) {
    throw new Error(`Manifest must use schema ${DESIRED_MANIFEST_SCHEMA}.`);
  }
  for (const item of manifest.repairs) {
    const sku = nonEmptyString(item.sku);
    if (!sku) throw new Error("Every manifest repair must have a SKU.");
    if (result.has(sku)) throw new Error(`Duplicate manifest SKU: ${sku}`);

    if (item.review) {
      if (
        !["HIGH", "MEDIUM", "LOW"].includes(item.review.confidence) ||
        !item.review.rationale.trim() ||
        !Array.isArray(item.review.evidence) ||
        item.review.evidence.length === 0 ||
        item.review.evidence.some((evidence) => !evidence.trim())
      ) {
        throw new Error(`Manifest review evidence for ${sku} is incomplete.`);
      }
    }

    if (item.media) {
      if (item.media.main_image_url) {
        assertHttpsUrl(`${sku} main_image_url`, item.media.main_image_url);
      }
      const gallery = item.media.gallery_image_urls;
      if (gallery) {
        gallery.forEach((url, index) => {
          assertHttpsUrl(`${sku} gallery slot ${index + 1}`, url);
        });
        if (new Set(gallery).size !== gallery.length) {
          throw new Error(`Manifest gallery for ${sku} contains duplicate URLs.`);
        }
        if (!isVerifiedBrandCardLocator(gallery[0])) {
          throw new Error(
            `Manifest gallery slot 1 for ${sku} must be one of the two byte-verified fixed brand-card locators.`,
          );
        }
        if (item.media.main_image_url && (gallery.length < 5 || gallery.length > 7)) {
          throw new Error(
            `Full media repair for ${sku} requires 5-7 secondary images (brand card + 4-6 product images).`,
          );
        }
        if (!item.media.main_image_url && (gallery.length < 1 || gallery.length > 8)) {
          throw new Error(`Manifest gallery for ${sku} must contain 1-8 images.`);
        }
      }
      const deleteGallerySlots = item.media.delete_gallery_slots;
      if (deleteGallerySlots !== undefined) {
        if (!gallery) {
          throw new Error(
            `Manifest gallery deletions for ${sku} require an explicit ordered gallery.`,
          );
        }
        const expectedDeleteSlots = Array.from(
          { length: 8 - gallery.length },
          (_, index) => gallery.length + 1 + index,
        );
        if (
          !Array.isArray(deleteGallerySlots) ||
          deleteGallerySlots.some(
            (slot) => !Number.isInteger(slot) || slot < 1 || slot > 8,
          ) ||
          stableJson(deleteGallerySlots) !== stableJson(expectedDeleteSlots)
        ) {
          throw new Error(
            `Manifest gallery deletions for ${sku} must be the exact ordered tail ${JSON.stringify(expectedDeleteSlots)}.`,
          );
        }
      }
      if (!item.media.main_image_url && !gallery?.length) {
        throw new Error(`Manifest media repair for ${sku} is empty.`);
      }
    }
    if (item.text_count) validateTextCount(item.text_count, sku);
    if (item.structured_attributes) {
      if (item.review?.confidence !== "HIGH") {
        throw new Error(
          `Manifest structured_attributes for ${sku} requires HIGH-confidence review evidence.`,
        );
      }
      const structured = item.structured_attributes;
      if (
        structured.item_package_quantity == null &&
        structured.each_unit_count == null &&
        structured.each_unit_count_absent !== true &&
        structured.is_expiration_dated_product !== true &&
        structured.merchant_shipping_group == null
      ) {
        throw new Error(`Manifest structured_attributes for ${sku} is empty.`);
      }
      const rawStructured = structured as Record<string, unknown>;
      if (
        rawStructured.each_unit_count_absent === false ||
        (structured.each_unit_count_absent === true &&
          structured.each_unit_count != null)
      ) {
        throw new Error(
          `Manifest each_unit_count policy for ${sku} is contradictory.`,
        );
      }
      if (rawStructured.is_expiration_dated_product === false) {
        throw new Error(
          `Manifest is_expiration_dated_product for ${sku} cannot be false.`,
        );
      }
      for (const [field, value] of [
        ["item_package_quantity", structured.item_package_quantity],
        ["each_unit_count", structured.each_unit_count],
      ] as const) {
        if (value != null && (!Number.isInteger(value) || value <= 0)) {
          throw new Error(
            `Manifest ${field} for ${sku} must be a positive integer.`,
          );
        }
      }
      if (
        structured.merchant_shipping_group != null &&
        !structured.merchant_shipping_group.trim()
      ) {
        throw new Error(
          `Manifest merchant_shipping_group for ${sku} must be non-empty.`,
        );
      }
    }
    result.set(sku, item);
  }
  return result;
}

interface ParsedLaunchPricingSource {
  manifest: UncrustablesLaunchPricingManifest;
  rowsBySku: Map<string, UncrustablesLaunchPricingRow>;
  source: NonNullable<UncrustablesRepairPlan["launch_pricing_source"]>;
}

function parseLaunchPricingSource(
  source: { path: string; bytes: Buffer } | null | undefined,
): ParsedLaunchPricingSource | null {
  if (!source) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(source.bytes.toString("utf8"));
  } catch {
    throw new Error("Launch-pricing manifest is not valid JSON.");
  }
  const manifest = verifyUncrustablesLaunchPricingManifest(raw);
  return {
    manifest,
    rowsBySku: launchPricingRowsBySku(manifest),
    source: {
      path: path.resolve(source.path),
      sha256: sha256(source.bytes),
      schema_version: UNCRUSTABLES_LAUNCH_PRICING_SCHEMA,
      reviewed_at: manifest.reviewed_at,
      body_sha256: manifest.body_sha256,
      rows: manifest.scope.rows,
      coupon_rows: manifest.scope.coupon_rows,
      sale_price_rows: manifest.scope.sale_price_rows,
    },
  };
}

interface ParsedPtdProof {
  proof: AmazonFoodPtdAttributeProof;
  source: NonNullable<
    NonNullable<UncrustablesRepairPlan["structured_attribute_source"]>["ptd_proof"]
  >;
}

function parsePtdAttributeProof(
  source: { path: string; bytes: Buffer } | null | undefined,
  ledgerPath: string,
  ledgerSha256: string,
): ParsedPtdProof | null {
  if (!source) return null;
  const digest = sha256(source.bytes);
  if (digest !== PTD_ATTRIBUTE_PROOF_SHA256) {
    throw new Error(
      `PTD attribute proof SHA-256 must equal ${PTD_ATTRIBUTE_PROOF_SHA256}; got ${digest}.`,
    );
  }
  let proof: AmazonFoodPtdAttributeProof;
  try {
    proof = JSON.parse(source.bytes.toString("utf8")) as AmazonFoodPtdAttributeProof;
  } catch {
    throw new Error("PTD attribute proof is not valid JSON.");
  }
  if (
    proof.schema_version !== PTD_ATTRIBUTE_PROOF_SCHEMA ||
    proof.immutable !== true ||
    proof.evidence?.marketplace_id !== MARKETPLACE_ID ||
    proof.evidence?.requirements !== "LISTING" ||
    proof.evidence?.locale !== "en_US" ||
    !nonEmptyString(proof.fetched_at) ||
    !Number.isFinite(Date.parse(proof.fetched_at)) ||
    !isRecord(proof.product_types) ||
    proof.scope?.ledger_sha256 !== ledgerSha256 ||
    path.resolve(proof.scope?.ledger_path ?? "") !== path.resolve(ledgerPath)
  ) {
    throw new Error(
      "PTD attribute proof must be immutable, current-schema JSON for the US LISTING/en_US request.",
    );
  }
  const shared = proof.shared_attribute_contract;
  const allergen = shared?.allergen_information;
  if (
    !Number.isInteger(shared?.ingredients?.max_utf8_bytes) ||
    shared.ingredients.max_utf8_bytes <= 0 ||
    !Number.isInteger(allergen?.max_unique_items) ||
    allergen.max_unique_items <= 0 ||
    !Array.isArray(allergen.enum_tokens) ||
    allergen.enum_tokens.length !== allergen.full_enum_count ||
    sha256(stableJson(allergen.enum_tokens)) !== allergen.full_enum_sha256 ||
    !Array.isArray(allergen.may_contain_enum_tokens) ||
    allergen.may_contain_enum_tokens.length !== allergen.may_contain_enum_count ||
    sha256(stableJson(allergen.may_contain_enum_tokens)) !==
      allergen.may_contain_enum_sha256 ||
    allergen.may_contain_enum_tokens.some(
      (token) => !allergen.enum_tokens.includes(token),
    ) ||
    shared.each_unit_count?.max_unique_items !== 1 ||
    shared.each_unit_count?.value_type !== "number"
  ) {
    throw new Error("PTD shared structured-attribute contract is incomplete or tampered.");
  }
  for (const productType of ["GROCERY", "FOOD", "PASTRY"]) {
    const schema = proof.product_types[productType];
    if (
      !schema ||
      !/^[a-f0-9]{64}$/i.test(schema.schema_sha256) ||
      schema.attributes?.ingredients?.contract !==
        "shared_attribute_contract.ingredients" ||
      schema.attributes?.allergen_information?.contract !==
        "shared_attribute_contract.allergen_information" ||
      schema.attributes?.each_unit_count?.contract !==
        "shared_attribute_contract.each_unit_count"
    ) {
      throw new Error(
        `PTD attribute proof is incomplete for product type ${productType}.`,
      );
    }
  }
  return {
    proof,
    source: {
      path: path.resolve(source.path),
      sha256: digest,
      schema_version: proof.schema_version,
      fetched_at: proof.fetched_at,
      marketplace_id: proof.evidence.marketplace_id,
      product_types: Object.keys(proof.product_types).sort(),
    },
  };
}

interface ParsedDonorManifest {
  manifest: DonorEnrichmentManifest;
  source: NonNullable<
    NonNullable<UncrustablesRepairPlan["structured_attribute_source"]>["donor_manifest"]
  >;
}

function parsePinnedDonorManifest(
  source: { path: string; bytes: Buffer } | null | undefined,
  ledgerPath: string,
  ledgerSha256: string,
): ParsedDonorManifest | null {
  if (!source) return null;
  const digest = sha256(source.bytes);
  if (digest !== UNCRUSTABLES_DONOR_MANIFEST_SHA256) {
    throw new Error(
      `Donor manifest SHA-256 must equal the reviewed digest ${UNCRUSTABLES_DONOR_MANIFEST_SHA256}; got ${digest}.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source.bytes.toString("utf8"));
  } catch {
    throw new Error("Donor enrichment manifest is not valid JSON.");
  }
  const manifest = parseDonorEnrichmentManifest(raw);
  if (
    manifest.schema_version !== DONOR_ENRICHMENT_SCHEMA_VERSION ||
    manifest.ledger.sha256 !== ledgerSha256 ||
    path.resolve(manifest.ledger.path) !== path.resolve(ledgerPath)
  ) {
    throw new Error(
      "Donor enrichment manifest must be reviewed against the exact repair ledger path and SHA-256.",
    );
  }
  return {
    manifest,
    source: {
      path: path.resolve(source.path),
      sha256: digest,
      schema_version: manifest.schema_version,
      reviewed_at: manifest.reviewed_at,
      source_ledger_sha256: manifest.ledger.sha256,
      donors: manifest.donors.length,
      aliases: manifest.aliases.length,
    },
  };
}

function canonicalAllergenToken(label: string): string {
  return amazonContainedAllergenToken(label);
}

function deriveReviewedAllergenUnion(
  declarations: AllergenDeclaration[],
  allowedTokens: Set<string>,
  maxUniqueItems: number,
): Pick<
  DesiredStructuredAttributesRepair,
  "allergen_information" | "reviewed_allergens"
> {
  const contains = new Map<string, string>();
  const mayContain = new Map<string, string>();
  for (const declaration of declarations) {
    for (const label of declaration.contains) {
      const token = canonicalAllergenToken(label);
      if (!allowedTokens.has(token)) {
        throw new Error(
          `PTD proof does not authorize contained allergen token ${JSON.stringify(token)}.`,
        );
      }
      if (!contains.has(token)) contains.set(token, label);
    }
    for (const label of declaration.may_contain) {
      const token = canonicalAllergenToken(label);
      if (!mayContain.has(token)) mayContain.set(token, label);
    }
  }
  const containedFamilies = new Set(
    Array.from(contains.values()).map(amazonAllergenFamily),
  );
  for (const [token, label] of mayContain) {
    if (containedFamilies.has(amazonAllergenFamily(label))) {
      mayContain.delete(token);
    }
  }
  const containsTokens = Array.from(contains.keys()).sort();
  const mayTokens = Array.from(mayContain.values())
    .map(amazonMayContainAllergenToken)
    .sort();
  for (const token of mayTokens) {
    if (!allowedTokens.has(token)) {
      throw new Error(
        `PTD proof does not authorize precautionary allergen token ${JSON.stringify(token)}.`,
      );
    }
  }
  const allergenInformation = [...containsTokens, ...mayTokens];
  if (
    allergenInformation.length === 0 ||
    allergenInformation.length > maxUniqueItems
  ) {
    throw new Error(
      `Reviewed allergen union has ${allergenInformation.length} values; PTD allows ${maxUniqueItems}.`,
    );
  }
  return {
    allergen_information: allergenInformation,
    reviewed_allergens: {
      contains: containsTokens.map((token) => contains.get(token) as string),
      may_contain: Array.from(mayContain.keys())
        .sort()
        .map((token) => mayContain.get(token) as string),
    },
  };
}

interface StructuredRecipeComponent {
  product_id?: unknown;
  research_pool_id?: unknown;
  product_name?: unknown;
  qty?: unknown;
}

/** Resolve the immutable ledger recipe against the exact reviewed donor set.
 * There is no ingredient keyword inference: allergens come only from the
 * manufacturer-label declarations in the pinned donor manifest. */
export function deriveDonorStructuredAttributes(input: {
  sku: string;
  productType: string;
  totalUnits: number;
  draftId: string;
  selectedVariantIdx: number;
  components: StructuredRecipeComponent[];
  donorManifest: DonorEnrichmentManifest;
  ptdProof: AmazonFoodPtdAttributeProof;
  reviewedOverride?: DesiredRepairManifest["repairs"][number]["structured_attributes"];
}): DesiredStructuredAttributesRepair {
  if (
    !Number.isInteger(input.totalUnits) ||
    input.totalUnits <= 0 ||
    !input.draftId ||
    !Number.isInteger(input.selectedVariantIdx) ||
    input.selectedVariantIdx < 0 ||
    input.components.length === 0
  ) {
    throw new Error(`${input.sku}: canonical recipe identity is incomplete.`);
  }
  const schema = input.ptdProof.product_types[input.productType];
  if (!schema) {
    throw new Error(`${input.sku}: no sealed PTD proof for ${input.productType}.`);
  }
  const donors = donorManifestMap(input.donorManifest);
  const selectedIds = new Set(input.donorManifest.selected_donor_ids);
  const ingredientDonors = new Map<
    string,
    { label: string; ingredients: string }
  >();
  const declarations: AllergenDeclaration[] = [];
  let qtySum = 0;
  for (const [index, component] of input.components.entries()) {
    const componentId = nonEmptyString(
      component.product_id ?? component.research_pool_id,
    );
    const productName = nonEmptyString(component.product_name);
    const qty = finiteNumber(component.qty);
    if (
      !componentId ||
      !productName ||
      qty == null ||
      !Number.isInteger(qty) ||
      qty <= 0
    ) {
      throw new Error(`${input.sku}: recipe component ${index} is malformed.`);
    }
    qtySum += qty;
    let resolvedId = componentId;
    const reviewedAlias = input.donorManifest.aliases.find(
      (alias) => alias.from_donor_id === componentId,
    );
    if (reviewedAlias) {
      if (
        productName !== reviewedAlias.expected_selected_product_name ||
        !selectedIds.has(componentId)
      ) {
        throw new Error(`${input.sku}: reviewed donor alias identity drifted.`);
      }
      const target = reviewedAlias.targets.find(
        (candidate) => candidate.bundle_draft_id === input.draftId,
      );
      if (
        !target ||
        target.selected_variant_idx !== input.selectedVariantIdx ||
        target.expected_qty !== qty
      ) {
        throw new Error(`${input.sku}: reviewed donor alias target/quantity drifted.`);
      }
      resolvedId = reviewedAlias.to_donor_id;
    } else if (!selectedIds.has(componentId)) {
      throw new Error(
        `${input.sku}: donor ${componentId} is outside the exact ledger-selected set.`,
      );
    }
    const donor = donors.get(resolvedId);
    if (!donor) {
      throw new Error(
        `${input.sku}: resolved donor ${resolvedId} lacks reviewed manufacturer facts.`,
      );
    }
    if (!ingredientDonors.has(resolvedId)) {
      const label = uncrustablesFlavorLabel(donor.expected_title);
      if (!label) {
        throw new Error(
          `${input.sku}: reviewed donor ${resolvedId} has no clean flavor label.`,
        );
      }
      ingredientDonors.set(resolvedId, {
        label,
        ingredients: donor.reviewed.ingredients,
      });
      declarations.push(
        normalizeAllergenDeclaration(
          donor.reviewed.allergens,
          `${input.sku}.donor.${resolvedId}.allergens`,
        ),
      );
    }
  }
  if (qtySum !== input.totalUnits) {
    throw new Error(
      `${input.sku}: recipe quantity ${qtySum} does not equal canonical total ${input.totalUnits}.`,
    );
  }
  const ingredientEntries = Array.from(ingredientDonors.values());
  const ingredients = ingredientEntries.length === 1
    ? ingredientEntries[0].ingredients
    : ingredientEntries
        .map((entry) => `${entry.label}: ${entry.ingredients}`)
        .join(" | ");
  const ingredientBytes = Buffer.byteLength(ingredients, "utf8");
  const shared = input.ptdProof.shared_attribute_contract;
  if (
    !ingredients ||
    ingredientBytes > shared.ingredients.max_utf8_bytes
  ) {
    throw new Error(
      `${input.sku}: exact ingredients require ${ingredientBytes} UTF-8 bytes; PTD allows ${shared.ingredients.max_utf8_bytes}.`,
    );
  }
  const allergenUnion = deriveReviewedAllergenUnion(
    declarations,
    new Set(shared.allergen_information.enum_tokens),
    shared.allergen_information.max_unique_items,
  );
  const reviewed = input.reviewedOverride;
  return {
    ingredients,
    ingredients_sha256: sha256(ingredients),
    ...allergenUnion,
    resolved_donor_ids: Array.from(ingredientDonors.keys()),
    ...(reviewed?.item_package_quantity != null
      ? { item_package_quantity: reviewed.item_package_quantity }
      : {}),
    ...(reviewed?.each_unit_count != null
      ? { each_unit_count: reviewed.each_unit_count }
      : {}),
    ...(reviewed?.each_unit_count_absent === true
      ? { each_unit_count_absent: true as const }
      : {}),
    ...(reviewed?.is_expiration_dated_product === true
      ? { is_expiration_dated_product: true as const }
      : {}),
    ...(reviewed?.merchant_shipping_group != null
      ? { merchant_shipping_group: reviewed.merchant_shipping_group.trim() }
      : {}),
  };
}

interface ResolvedHeroAsset {
  asin: string;
  mainImageUrl: string;
  imageSha256: string;
  galleryImageUrls: string[];
}

const GALLERY_FLAVOR_DISCRIMINATORS = [
  "raspberry",
  "grape",
  "strawberry",
  "honey",
  "chocolate",
  "hazelnut",
  "blueberry",
  "blackberry",
  "mixed berry",
  "apple",
  "cinnamon",
  "wildberry",
  "banana",
] as const;
const GALLERY_SUBLINE_QUALIFIERS = [
  "protein",
  "reduced sugar",
  "whole wheat",
] as const;

/** Lightweight identity check kept local so this offline repair module does
 * not pull Prisma/R2 dependencies from the image compositor. */
function galleryDonorTitleMatchesFlavor(flavor: string, donorTitle: string): boolean {
  if (!/uncrustables/i.test(flavor) || !/uncrustables/i.test(donorTitle)) return false;
  const normalizedFlavor = flavor.toLowerCase().replace(/-/g, " ");
  const normalizedDonor = donorTitle.toLowerCase().replace(/-/g, " ");
  const flavorTokens = GALLERY_FLAVOR_DISCRIMINATORS.filter((token) =>
    normalizedFlavor.includes(token),
  );
  const donorTokens = GALLERY_FLAVOR_DISCRIMINATORS.filter((token) =>
    normalizedDonor.includes(token),
  );
  if (flavorTokens.length || donorTokens.length) {
    if (
      !flavorTokens.length ||
      !donorTokens.length ||
      !flavorTokens.some((token) => donorTokens.includes(token))
    ) {
      return false;
    }
  } else if (
    !/peanut\s+butter/i.test(flavor) ||
    !/peanut\s+butter/i.test(donorTitle)
  ) {
    return false;
  }
  return GALLERY_SUBLINE_QUALIFIERS.every(
    (qualifier) =>
      normalizedFlavor.includes(qualifier) === normalizedDonor.includes(qualifier),
  );
}

function parseProductGalleryManifest(
  source: { path: string; bytes: Buffer } | null | undefined,
  rows: LedgerRowLike[],
  expectedLedgerSha256: string,
): {
  galleries: Map<string, string[]>;
  source: NonNullable<
    NonNullable<UncrustablesRepairPlan["media_asset_source"]>["gallery_manifest"]
  >;
} | null {
  if (!source) return null;
  const parsed = JSON.parse(source.bytes.toString("utf8")) as ProductGalleryManifest;
  if (
    parsed.schema_version !== GALLERY_MANIFEST_SCHEMA ||
    parsed.immutable !== true ||
    parsed.source_ledger_sha256 !== expectedLedgerSha256 ||
    !Array.isArray(parsed.rows) ||
    parsed.summary?.failed !== 0 ||
    parsed.summary?.passed !== parsed.summary?.target
  ) {
    throw new Error(
      "Product-gallery manifest must be immutable, complete, fully verified, and reviewed against the exact repair ledger SHA-256.",
    );
  }
  const bySku = new Map(parsed.rows.map((item) => [item.sku, item]));
  if (bySku.size !== parsed.rows.length) {
    throw new Error("Product-gallery manifest contains duplicate SKUs.");
  }
  const galleries = new Map<string, string[]>();
  for (const row of rows) {
    if (row.live?.fetched !== true) continue;
    const sku = nonEmptyString(row.sku);
    const asin = nonEmptyString(row.asin);
    if (!sku || !asin) continue;
    const item = bySku.get(sku);
    if (!item || item.asin !== asin || item.verified !== true) {
      throw new Error(`Verified product gallery is missing or mismatched for ${sku}.`);
    }
    const recipeComponents = semanticComponentsForRow(row);
    if (recipeComponents.length === 0) {
      throw new Error(`Verified product gallery for ${sku} has no canonical recipe.`);
    }
    if (
      !Array.isArray(item.assets) ||
      !Array.isArray(item.evidence) ||
      item.assets.length !== item.image_urls.length ||
      item.evidence.length !== item.assets.length
    ) {
      throw new Error(
        `Verified product gallery for ${sku} requires one structured asset and evidence row per URL.`,
      );
    }
    const representedComponents = new Set<string>();
    item.assets.forEach((asset, index) => {
      const component = recipeComponents.find(
        (candidate) =>
          candidate.product_name === asset.flavor || candidate.flavor === asset.flavor,
      );
      if (!component) {
        throw new Error(
          `Verified product gallery asset ${index + 1} for ${sku} names a flavor outside the canonical recipe.`,
        );
      }
      if (!galleryDonorTitleMatchesFlavor(asset.flavor, asset.donor_title)) {
        throw new Error(
          `Verified product gallery donor/title mismatch for ${sku} asset ${index + 1}.`,
        );
      }
      if (
        !nonEmptyString(asset.donor_id) ||
        !nonEmptyString(asset.source_url) ||
        !/^[a-f0-9]{64}$/i.test(asset.source_sha256) ||
        !/^[a-f0-9]{64}$/i.test(asset.asset_sha256) ||
        !Number.isInteger(asset.dimensions?.width) ||
        !Number.isInteger(asset.dimensions?.height) ||
        asset.dimensions.width < 1000 ||
        asset.dimensions.height < 1000
      ) {
        throw new Error(
          `Verified product gallery asset ${index + 1} for ${sku} has incomplete provenance.`,
        );
      }
      assertHttpsUrl(`${sku} gallery source ${index + 1}`, asset.source_url);
      assertHttpsUrl(`${sku} gallery R2 asset ${index + 1}`, asset.r2_url);
      const expectedKey =
        `uncrustables-product-gallery/v1/${asset.asset_sha256.slice(0, 2).toLowerCase()}/` +
        `${asset.asset_sha256.toLowerCase()}.jpg`;
      if (
        asset.r2_key !== expectedKey ||
        !new URL(asset.r2_url).hostname.endsWith(".r2.dev") ||
        !new URL(asset.r2_url).pathname.endsWith(`/${expectedKey}`) ||
        item.image_urls[index] !== asset.r2_url
      ) {
        throw new Error(
          `Verified product gallery asset ${index + 1} for ${sku} is not exact-hash-addressed R2 provenance.`,
        );
      }
      const expectedEvidence =
        `donor=${asset.donor_id};source_sha256=${asset.source_sha256};` +
        `asset_sha256=${asset.asset_sha256};dimensions=${asset.dimensions.width}x${asset.dimensions.height};` +
        `r2_key=${asset.r2_key}`;
      if (item.evidence[index] !== expectedEvidence) {
        throw new Error(
          `Verified product gallery evidence mismatch for ${sku} asset ${index + 1}.`,
        );
      }
      representedComponents.add(component.product_name);
    });
    const missingRecipeComponent = recipeComponents.find(
      (component) => !representedComponents.has(component.product_name),
    );
    if (missingRecipeComponent) {
      throw new Error(
        `Verified product gallery for ${sku} omits recipe component ${missingRecipeComponent.product_name}.`,
      );
    }
    const urls = [...new Set(item.image_urls.map((url) => url.trim()).filter(Boolean))]
      .filter((url) => url !== BRAND_CARD_COLD_CHAIN_URL);
    if (urls.length < 4 || urls.length > 6) {
      throw new Error(`Verified product gallery for ${sku} must contain 4-6 unique images.`);
    }
    urls.forEach((url, index) => assertHttpsUrl(`${sku} verified gallery ${index + 1}`, url));
    galleries.set(sku, urls);
  }
  return {
    galleries,
    source: {
      path: path.resolve(source.path),
      sha256: sha256(source.bytes),
      schema_version: parsed.schema_version,
      rows: galleries.size,
    },
  };
}

function parseHeroManifest(
  source: { path: string; bytes: Buffer } | null | undefined,
  gallerySource: { path: string; bytes: Buffer } | null | undefined,
  rows: LedgerRowLike[],
  expectedLedgerSha256: string,
  reviewedPackCounts: ReadonlyMap<string, number>,
): {
  assets: Map<string, ResolvedHeroAsset>;
  source: NonNullable<UncrustablesRepairPlan["media_asset_source"]>;
} | null {
  if (!source) return null;
  const verifiedGalleries = parseProductGalleryManifest(
    gallerySource,
    rows,
    expectedLedgerSha256,
  );
  const parsed = JSON.parse(source.bytes.toString("utf8")) as HeroGenerationManifest;
  // The hero snapshot SHA is provenance, not an optimistic-lock token: hero generation can
  // legitimately predate a later offline ledger resummary, while the SKU/ASIN cohort remains
  // unchanged. Safety here comes from complete exact SKU+ASIN matching, per-asset QA/SHA, and
  // pinning the immutable hero-manifest bytes in the sealed plan. In contrast, the separately
  // reviewed gallery manifest is authored for the repair decision itself and must match the
  // exact current repair-ledger SHA above.
  if (
    parsed.schema_version !== HERO_MANIFEST_SCHEMA ||
    parsed.immutable !== true ||
    !nonEmptyString(parsed.run_id) ||
    !isRecord(parsed.source_snapshot) ||
    !nonEmptyString(parsed.source_snapshot.sha256) ||
    !Array.isArray(parsed.rows) ||
    parsed.summary?.failed !== 0 ||
    parsed.summary?.succeeded !== parsed.summary?.target ||
    finiteNumber(parsed.external_mutations?.r2_asset_uploads) !== parsed.summary?.succeeded ||
    parsed.external_mutations?.amazon_calls !== 0 ||
    parsed.external_mutations?.database_writes !== 0
  ) {
    throw new Error(
      "Hero manifest must be immutable, complete, QA-addressable, and have zero Amazon/DB writes.",
    );
  }
  const bySku = new Map<string, HeroGenerationManifest["rows"][number]>();
  for (const item of parsed.rows) {
    if (bySku.has(item.sku)) throw new Error(`Duplicate hero-manifest SKU: ${item.sku}`);
    bySku.set(item.sku, item);
  }
  const assets = new Map<string, ResolvedHeroAsset>();
  for (const row of rows) {
    if (row.live?.fetched !== true) continue;
    const sku = nonEmptyString(row.sku);
    const asin = nonEmptyString(row.asin);
    if (!sku || !asin) continue;
    const item = bySku.get(sku);
    if (!item) throw new Error(`Hero manifest is missing live SKU ${sku}.`);
    const mainImageUrl = nonEmptyString(item.result?.image_url);
    const imageSha = nonEmptyString(item.result?.image_sha256);
    const canonicalTotal = finiteNumber(row.canonical?.total_units);
    const expectedTotal = reviewedPackCounts.get(sku) ?? canonicalTotal;
    const heroTotal = finiteNumber(item.result?.total_units);
    const planRecipeQuantities = (item.result?.plan ?? []).map((candidate) =>
      finiteNumber(candidate.recipe_qty),
    );
    const recipeTotal = planRecipeQuantities.reduce<number>(
      (sum, value) => sum + (value ?? 0),
      0,
    );
    if (
      item.asin !== asin ||
      item.status !== "SUCCEEDED" ||
      item.result?.ok !== true ||
      !mainImageUrl ||
      !/^[a-f0-9]{64}$/i.test(imageSha ?? "") ||
      item.result?.qa?.pass !== true ||
      item.result?.qa?.verified !== true ||
      expectedTotal == null ||
      !Number.isInteger(expectedTotal) ||
      expectedTotal <= 0 ||
      heroTotal !== expectedTotal ||
      planRecipeQuantities.length === 0 ||
      planRecipeQuantities.some(
        (quantity) =>
          quantity == null || !Number.isInteger(quantity) || quantity <= 0,
      ) ||
      recipeTotal !== expectedTotal
    ) {
      throw new Error(
        `Hero asset for ${sku} is not a successful QA/count-verified ASIN match.`,
      );
    }
    assertHttpsUrl(`${sku} hero MAIN`, mainImageUrl);
    if (!new URL(mainImageUrl).hostname.endsWith(".r2.dev")) {
      throw new Error(`Hero MAIN for ${sku} must be a versioned R2 asset.`);
    }
    const authenticity = preflightDeclaredUncrustablesMainHash({
      sku,
      main_image_url: mainImageUrl,
      image_sha256: imageSha as string,
      pack_count: expectedTotal,
      components: semanticComponentsForRow(row).map((component) => ({
        product_name: component.product_name,
        flavor: component.flavor,
        qty: component.qty,
      })),
    });
    if (!authenticity.pass) {
      throw new Error(
        `Hero MAIN authenticity blocked for ${sku}: ${authenticity.findings
          .map((item) => `${item.code}: ${item.message}`)
          .join("; ")}`,
      );
    }
    let gallery = verifiedGalleries?.galleries.get(sku);
    if (!gallery) {
      throw new Error(
        `Hero manifest for ${sku} has no separately sealed, recipe/donor-bound 4-6 image gallery.`,
      );
    }
    if (gallery[0] === BRAND_CARD_COLD_CHAIN_URL) gallery = gallery.slice(1);
    gallery = [...new Set(gallery.map((url) => url.trim()).filter(Boolean))]
      .filter((url) => url !== mainImageUrl && url !== BRAND_CARD_COLD_CHAIN_URL)
      .slice(0, 6);
    if (gallery.length < 4 || gallery.length > 6) {
      throw new Error(
        `Hero gallery for ${sku} requires 4-6 unique real-product images; got ${gallery.length}.`,
      );
    }
    gallery.forEach((url, index) => assertHttpsUrl(`${sku} product gallery ${index + 1}`, url));
    assets.set(sku, {
      asin,
      mainImageUrl,
      imageSha256: imageSha as string,
      galleryImageUrls: gallery,
    });
  }
  return {
    assets,
    source: {
      path: path.resolve(source.path),
      sha256: sha256(source.bytes),
      schema_version: parsed.schema_version,
      run_id: parsed.run_id,
      source_ledger_sha256: parsed.source_snapshot.sha256,
      rows: assets.size,
      qa_verified: true,
      ...(verifiedGalleries ? { gallery_manifest: verifiedGalleries.source } : {}),
    },
  };
}

function anomalyCodes(row: LedgerRowLike): string[] {
  if (!Array.isArray(row.anomalies)) return [];
  return row.anomalies
    .map((item) => (isRecord(item) ? nonEmptyString(item.code) : null))
    .filter((value): value is string => value != null);
}

function differs(left: number | null, right: number): boolean {
  return left == null || Math.abs(left - right) >= 0.005;
}

type SalePriceObservation =
  | { state: "ABSENT"; schedule: null; diagnostic: null }
  | {
      state: "PRESENT";
      schedule: UncrustablesSalePriceSchedule;
      diagnostic: UncrustablesSalePriceSchedule;
    }
  | {
      state: "MALFORMED";
      schedule: null;
      diagnostic: { state: "MALFORMED"; reason: string; actual: unknown };
    };

type ExactSelectorObservation =
  | { state: "PRESENT"; entry: UnknownRecord; diagnostic: UnknownRecord }
  | {
      state: "MALFORMED";
      entry: null;
      diagnostic: { state: "MALFORMED"; reason: string; actual: unknown };
    };

type MoneyObservation =
  | { state: "PRESENT"; value: number; diagnostic: number }
  | {
      state: "MALFORMED";
      value: null;
      diagnostic: { state: "MALFORMED"; reason: string; actual: unknown };
    };

function malformedSelector(reason: string, actual: unknown): ExactSelectorObservation {
  return {
    state: "MALFORMED",
    entry: null,
    diagnostic: { state: "MALFORMED", reason, actual: structuredClone(actual) },
  };
}

function observeExactAttributeSelector(
  rawPurchasableOffer: unknown,
  audience: "ALL" | "B2B",
): ExactSelectorObservation {
  if (!Array.isArray(rawPurchasableOffer)) {
    return malformedSelector("purchasable_offer is not an array", rawPurchasableOffer);
  }
  const marketplaceAudienceMatches = rawPurchasableOffer.filter((entry) => {
    if (!isRecord(entry)) return false;
    const actualAudience = isRecord(entry.audience)
      ? entry.audience.value
      : entry.audience;
    return actualAudience === audience && entry.marketplace_id === MARKETPLACE_ID;
  });
  if (
    marketplaceAudienceMatches.length !== 1 ||
    !isRecord(marketplaceAudienceMatches[0])
  ) {
    return malformedSelector(
      `expected one exact ${audience}/${MARKETPLACE_ID} selector; found ${marketplaceAudienceMatches.length}`,
      marketplaceAudienceMatches,
    );
  }
  const entry = marketplaceAudienceMatches[0];
  if (entry.currency !== "USD") {
    return malformedSelector(
      `exact ${audience}/${MARKETPLACE_ID} selector must use USD`,
      entry,
    );
  }
  return { state: "PRESENT", entry, diagnostic: entry };
}

function malformedMoney(reason: string, actual: unknown): MoneyObservation {
  return {
    state: "MALFORMED",
    value: null,
    diagnostic: { state: "MALFORMED", reason, actual: structuredClone(actual) },
  };
}

function observeExactScheduledMoney(
  selector: ExactSelectorObservation,
  key: string,
): MoneyObservation {
  if (selector.state !== "PRESENT") {
    return malformedMoney(selector.diagnostic.reason, selector.diagnostic.actual);
  }
  const rows = selector.entry[key];
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !isRecord(rows[0]) ||
    !Array.isArray(rows[0].schedule) ||
    rows[0].schedule.length !== 1 ||
    !isRecord(rows[0].schedule[0])
  ) {
    return malformedMoney(
      `${key} must contain exactly one row and one schedule`,
      rows,
    );
  }
  const value = finiteNumber(rows[0].schedule[0].value_with_tax);
  if (value == null || value <= 0) {
    return malformedMoney(`${key} has an invalid value_with_tax`, rows[0].schedule[0]);
  }
  return { state: "PRESENT", value, diagnostic: value };
}

function observeExactBusinessPrice(
  rawOffers: unknown,
  rawPurchasableOffer: unknown,
): MoneyObservation {
  if (Array.isArray(rawOffers)) {
    const marketplaceB2b = rawOffers.filter((offer) => {
      if (!isRecord(offer)) return false;
      const audience = isRecord(offer.audience)
        ? offer.audience.value
        : offer.audience;
      return (
        (offer.offerType === "B2B" || audience === "B2B") &&
        offer.marketplaceId === MARKETPLACE_ID
      );
    });
    if (marketplaceB2b.length > 0) {
      if (marketplaceB2b.length !== 1 || !isRecord(marketplaceB2b[0])) {
        return malformedMoney(
          `expected one exact top-level B2B/${MARKETPLACE_ID} offer; found ${marketplaceB2b.length}`,
          marketplaceB2b,
        );
      }
      const price = isRecord(marketplaceB2b[0].price)
        ? marketplaceB2b[0].price
        : null;
      const currency = price
        ? nonEmptyString(price.currencyCode) ?? nonEmptyString(price.currency)
        : null;
      const value = price ? finiteNumber(price.amount) : null;
      if (currency !== "USD" || value == null || value <= 0) {
        return malformedMoney(
          "exact top-level B2B offer has an invalid USD price",
          marketplaceB2b[0],
        );
      }
      return { state: "PRESENT", value, diagnostic: value };
    }
  }
  return observeExactScheduledMoney(
    observeExactAttributeSelector(rawPurchasableOffer, "B2B"),
    "our_price",
  );
}

/** Top-level B2C is Amazon's marketplace-facing projection. Listings Items
 * may omit the whole `offers` collection, but once it is present we require
 * exactly one internally consistent US B2C/USD row. This prevents an
 * attribute-level price from closing settlement while the observable B2C
 * offer is stale, duplicated, or malformed. */
function observeExactTopLevelConsumerPrice(
  rawOffers: unknown,
): MoneyObservation | null {
  if (rawOffers == null) return null;
  if (!Array.isArray(rawOffers)) {
    return malformedMoney("top-level offers is not an array", {
      value_type: typeof rawOffers,
    });
  }
  if (rawOffers.length === 0) return null;
  if (rawOffers.some((offer) => !isRecord(offer))) {
    return malformedMoney("top-level offers contains a non-object row", {
      offer_count: rawOffers.length,
    });
  }
  const marketplaceB2c = rawOffers.filter((offer) => {
    if (!isRecord(offer)) return false;
    const audience = isRecord(offer.audience)
      ? offer.audience.value
      : offer.audience;
    return (
      (offer.offerType === "B2C" || audience === "ALL") &&
      offer.marketplaceId === MARKETPLACE_ID
    );
  });
  if (marketplaceB2c.length !== 1 || !isRecord(marketplaceB2c[0])) {
    return malformedMoney(
      `expected one exact top-level B2C/${MARKETPLACE_ID} offer; found ${marketplaceB2c.length}`,
      {
        offer_count: rawOffers.length,
        matching_offer_count: marketplaceB2c.length,
      },
    );
  }
  const offer = marketplaceB2c[0];
  const audience = isRecord(offer.audience)
    ? offer.audience.value
    : offer.audience;
  if (offer.offerType !== "B2C" || audience !== "ALL") {
    return malformedMoney(
      "exact top-level B2C offer must identify both B2C and ALL",
      {
        offer_type: nonEmptyString(offer.offerType),
        audience: nonEmptyString(audience),
      },
    );
  }
  const price = isRecord(offer.price) ? offer.price : null;
  const currency = price
    ? nonEmptyString(price.currencyCode) ?? nonEmptyString(price.currency)
    : null;
  const value = price ? finiteNumber(price.amount) : null;
  if (currency !== "USD" || value == null || value <= 0) {
    return malformedMoney("exact top-level B2C offer has an invalid USD price", {
      currency,
      value,
    });
  }
  return { state: "PRESENT", value, diagnostic: value };
}

function malformedSalePrice(reason: string, actual: unknown): SalePriceObservation {
  return {
    state: "MALFORMED",
    schedule: null,
    diagnostic: { state: "MALFORMED", reason, actual: structuredClone(actual) },
  };
}

function observeSalePrice(rawPurchasableOffer: unknown): SalePriceObservation {
  const selector = observeExactAttributeSelector(rawPurchasableOffer, "ALL");
  if (selector.state !== "PRESENT") {
    return malformedSalePrice(
      selector.diagnostic.reason,
      selector.diagnostic.actual,
    );
  }
  const consumer = selector.entry;
  if (!Object.prototype.hasOwnProperty.call(consumer, "discounted_price")) {
    return { state: "ABSENT", schedule: null, diagnostic: null };
  }
  if (
    !Array.isArray(consumer.discounted_price) ||
    consumer.discounted_price.length !== 1 ||
    !isRecord(consumer.discounted_price[0])
  ) {
    return malformedSalePrice(
      "discounted_price must contain exactly one row when present",
      consumer.discounted_price,
    );
  }
  const discounted = consumer.discounted_price[0];
  if (
    !Array.isArray(discounted.schedule) ||
    discounted.schedule.length !== 1 ||
    !isRecord(discounted.schedule[0])
  ) {
    return malformedSalePrice(
      "discounted_price row must contain exactly one schedule",
      discounted.schedule,
    );
  }
  const rawSchedule = discounted.schedule[0];
  const value = finiteNumber(rawSchedule.value_with_tax);
  const startAt = nonEmptyString(rawSchedule.start_at);
  const endAt = nonEmptyString(rawSchedule.end_at);
  if (
    value == null ||
    value <= 0 ||
    !startAt ||
    !endAt ||
    !Number.isFinite(Date.parse(startAt)) ||
    !Number.isFinite(Date.parse(endAt)) ||
    Date.parse(endAt) <= Date.parse(startAt)
  ) {
    return malformedSalePrice(
      "discounted_price schedule has an invalid amount or date range",
      rawSchedule,
    );
  }
  const schedule = {
    value_with_tax: value,
    start_at: startAt,
    end_at: endAt,
  };
  return { state: "PRESENT", schedule, diagnostic: schedule };
}

function sameInstant(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

function salePriceMatches(
  actual: SalePriceObservation,
  desired: DesiredOfferRepair,
): boolean {
  if (desired.discounted_price_absent) return actual.state === "ABSENT";
  const expected = desired.discounted_price_schedule;
  return Boolean(
    actual.state === "PRESENT" &&
      actual.schedule &&
      expected &&
      !differs(actual.schedule.value_with_tax, expected.value_with_tax) &&
      sameInstant(actual.schedule.start_at, expected.start_at) &&
      sameInstant(actual.schedule.end_at, expected.end_at),
  );
}

function actionId(sku: string, kind: RepairActionKind): string {
  return `${sku}:${kind.toLowerCase()}`;
}

function buildExplicitOffer(
  sku: string,
  canonical: DesiredOfferRepair | null,
  override: Partial<DesiredOfferRepair>,
): DesiredOfferRepair {
  const value: DesiredOfferRepair = {
    currency: override.currency ?? canonical?.currency ?? "USD",
    consumer_price:
      override.consumer_price ?? canonical?.consumer_price ?? Number.NaN,
    business_price:
      override.business_price ??
      override.consumer_price ??
      canonical?.business_price ??
      Number.NaN,
    minimum_seller_allowed_price:
      override.minimum_seller_allowed_price ??
      canonical?.minimum_seller_allowed_price ??
      Number.NaN,
    maximum_seller_allowed_price:
      override.maximum_seller_allowed_price ??
      override.consumer_price ??
      canonical?.maximum_seller_allowed_price ??
      Number.NaN,
    discounted_price_absent: true,
    list_price_absent: true,
  };
  const rawOverride = override as Record<string, unknown>;
  if (
    rawOverride.discounted_price_absent === false ||
    rawOverride.discounted_price_schedule != null ||
    rawOverride.launch_lever != null ||
    rawOverride.list_price_absent === false
  ) {
    throw new Error(
      `Manifest offer for ${sku} cannot define launch pricing; use the independent pinned launch-pricing source.`,
    );
  }
  if (value.currency !== "USD") {
    throw new Error(`Manifest offer for ${sku} must use USD.`);
  }
  value.consumer_price = validateMoney(
    `${sku} consumer_price`,
    value.consumer_price,
  );
  value.business_price = validateMoney(
    `${sku} business_price`,
    value.business_price,
  );
  value.minimum_seller_allowed_price = validateMoney(
    `${sku} minimum_seller_allowed_price`,
    value.minimum_seller_allowed_price,
  );
  value.maximum_seller_allowed_price = validateMoney(
    `${sku} maximum_seller_allowed_price`,
    value.maximum_seller_allowed_price,
  );
  if (value.business_price !== value.consumer_price) {
    throw new Error(
      `Manifest offer for ${sku} must set B2B equal to the canonical consumer price.`,
    );
  }
  if (
    value.minimum_seller_allowed_price > value.consumer_price ||
    value.maximum_seller_allowed_price !== value.consumer_price
  ) {
    throw new Error(
      `Manifest offer for ${sku} must have min <= base and max = base.`,
    );
  }
  return value;
}

function applyPinnedLaunchPricing(
  sku: string,
  asin: string,
  reviewedCount: number,
  canonical: DesiredOfferRepair,
  row: UncrustablesLaunchPricingRow,
): DesiredOfferRepair {
  if (
    row.sku !== sku ||
    row.asin !== asin ||
    row.count !== reviewedCount ||
    differs(canonical.consumer_price, row.base_price) ||
    differs(canonical.business_price, row.base_price) ||
    differs(canonical.minimum_seller_allowed_price, row.floor_price) ||
    differs(canonical.maximum_seller_allowed_price, row.base_price)
  ) {
    throw new Error(
      `Pinned launch-pricing identity or Layer A values do not match ${sku}/${asin}.`,
    );
  }
  if (row.arm === "A") {
    if (row.sale_price_schedule !== null || !row.lever.startsWith("COUPON_")) {
      throw new Error(`Pinned coupon launch row is contradictory for ${sku}.`);
    }
    return {
      ...canonical,
      discounted_price_absent: true,
      launch_lever: row.lever,
    };
  }
  const schedule = row.sale_price_schedule;
  if (!schedule || !row.lever.startsWith("SALEPRICE_")) {
    throw new Error(`Pinned Sale Price launch row is incomplete for ${sku}.`);
  }
  if (
    differs(schedule.value_with_tax, row.effective_price) ||
    schedule.value_with_tax + 0.005 < canonical.minimum_seller_allowed_price ||
    schedule.value_with_tax >= canonical.consumer_price ||
    !Number.isFinite(Date.parse(schedule.start_at)) ||
    !Number.isFinite(Date.parse(schedule.end_at)) ||
    Date.parse(schedule.end_at) <= Date.parse(schedule.start_at)
  ) {
    throw new Error(`Pinned Sale Price schedule is unsafe for ${sku}.`);
  }
  return {
    ...canonical,
    discounted_price_absent: false,
    discounted_price_schedule: structuredClone(schedule),
    launch_lever: row.lever,
  };
}

/** Re-prove every sealed OFFER against the exact launch-manifest bytes before
 * any live credential or marketplace call. A recomputed repair-plan digest is
 * not sufficient authority to change coupon/Sale Price routing. */
export function assertRepairPlanLaunchPricingBinding(
  plan: UncrustablesRepairPlan,
  launchManifestBytes: Buffer,
  options: { requireOwnerApproval?: boolean; now?: Date } = {},
): void {
  verifyRepairPlan(plan);
  if (!plan.launch_pricing_source) {
    throw new Error("Repair plan has no pinned launch-pricing source.");
  }
  if (sha256(launchManifestBytes) !== plan.launch_pricing_source.sha256) {
    throw new Error("Launch-pricing source bytes do not match the repair plan.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(launchManifestBytes.toString("utf8"));
  } catch {
    throw new Error("Launch-pricing source bytes are not valid JSON.");
  }
  const manifest = verifyUncrustablesLaunchPricingManifest(raw);
  if (options.requireOwnerApproval) {
    const now = options.now ?? new Date();
    if (
      manifest.decision.revision_status !== "OWNER_APPROVED" ||
      manifest.decision.owner_approved_at == null
    ) {
      throw new Error(
        "Launch-pricing safety revision still requires explicit owner approval.",
      );
    }
    if (Date.parse(manifest.decision.owner_approved_at) > now.getTime()) {
      throw new Error("Launch-pricing owner approval timestamp is in the future.");
    }
    if (now.getTime() >= Date.parse(manifest.scope.end_at)) {
      throw new Error(
        "Launch-pricing schedule has expired; rebuild and re-approve a fresh synchronized window.",
      );
    }
  }
  if (
    manifest.body_sha256 !== plan.launch_pricing_source.body_sha256 ||
    manifest.reviewed_at !== plan.launch_pricing_source.reviewed_at ||
    manifest.scope.rows !== plan.launch_pricing_source.rows ||
    manifest.scope.coupon_rows !== plan.launch_pricing_source.coupon_rows ||
    manifest.scope.sale_price_rows !==
      plan.launch_pricing_source.sale_price_rows
  ) {
    throw new Error("Launch-pricing manifest metadata does not match the repair plan.");
  }
  const rowsBySku = launchPricingRowsBySku(manifest);
  for (const entry of plan.entries) {
    for (const action of entry.actions) {
      if (action.desired.kind !== "OFFER") continue;
      const row = rowsBySku.get(entry.sku);
      if (!row || row.asin !== entry.asin) {
        throw new Error(
          `Repair OFFER ${action.action_id} is absent or excluded in the launch-pricing source.`,
        );
      }
      const canonical: DesiredOfferRepair = {
        currency: "USD",
        consumer_price: row.base_price,
        business_price: row.base_price,
        minimum_seller_allowed_price: row.floor_price,
        maximum_seller_allowed_price: row.base_price,
        discounted_price_absent: true,
        list_price_absent: true,
      };
      const expected = applyPinnedLaunchPricing(
        entry.sku,
        entry.asin,
        row.count,
        canonical,
        row,
      );
      if (stableJson(action.desired.value) !== stableJson(expected)) {
        throw new Error(
          `Repair OFFER ${action.action_id} does not exactly match its pinned launch-pricing row.`,
        );
      }
    }
  }
}

/** Build and seal a repair plan without making any network or database calls. */
export function buildRepairPlan(
  options: BuildRepairPlanOptions,
): UncrustablesRepairPlan {
  let ledger: LedgerLike;
  try {
    ledger = JSON.parse(options.ledgerBytes.toString("utf8")) as LedgerLike;
  } catch {
    throw new Error("Ledger is not valid JSON.");
  }
  if (
    ledger.complete !== true ||
    ledger.immutable !== true ||
    !(
      ledger.mode === "live" ||
      (ledger.mode === "offline-resummarize" &&
        isRecord(ledger.source_snapshot) &&
        ledger.source_snapshot.mode === "live" &&
        nonEmptyString(ledger.source_snapshot.sha256) != null)
    ) ||
    ledger.external_mutations !== false ||
    !Array.isArray(ledger.rows)
  ) {
    throw new Error(
      "Repair plans require a complete immutable live ledger (or its sealed offline resummary) with external_mutations=false.",
    );
  }
  const auditId = nonEmptyString(ledger.audit_id);
  const ledgerSchema = nonEmptyString(ledger.schema_version);
  if (!auditId || !ledgerSchema) {
    throw new Error("Ledger is missing audit_id or schema_version.");
  }

  const ledgerSha256 = sha256(options.ledgerBytes);
  const manifest = parseManifest(options.manifest);
  const launchPricing = parseLaunchPricingSource(
    options.launchPricingManifest,
  );
  if (
    options.manifest?.source_ledger_sha256 &&
    options.manifest.source_ledger_sha256 !== ledgerSha256
  ) {
    throw new Error(
      "Desired-state manifest was reviewed against a different ledger SHA-256.",
    );
  }
  let desiredManifestSource: NonNullable<
    UncrustablesRepairPlan["desired_manifest_source"]
  > | null = null;
  if (options.manifestSource) {
    if (!options.manifest) {
      throw new Error("A desired-manifest source was supplied without a manifest.");
    }
    let sourceManifest: DesiredRepairManifest;
    try {
      sourceManifest = JSON.parse(
        options.manifestSource.bytes.toString("utf8"),
      ) as DesiredRepairManifest;
    } catch {
      throw new Error("Desired-manifest source is not valid JSON.");
    }
    if (stableJson(sourceManifest) !== stableJson(options.manifest)) {
      throw new Error(
        "Desired-manifest object does not match its exact source bytes.",
      );
    }
    const reviewedAt = nonEmptyString(sourceManifest.reviewed_at);
    if (
      sourceManifest.schema_version !== DESIRED_MANIFEST_SCHEMA ||
      sourceManifest.immutable !== true ||
      sourceManifest.source_ledger_sha256 !== ledgerSha256 ||
      !reviewedAt
    ) {
      throw new Error(
        "Live desired-manifest source must be immutable, reviewed, and bound to the exact source ledger.",
      );
    }
    desiredManifestSource = {
      path: path.resolve(options.manifestSource.path),
      sha256: sha256(options.manifestSource.bytes),
      schema_version: DESIRED_MANIFEST_SCHEMA,
      reviewed_at: reviewedAt,
      source_ledger_sha256: ledgerSha256,
    };
  }
  if (Boolean(options.donorManifest) !== Boolean(options.ptdProof)) {
    throw new Error(
      "Structured-attribute planning requires both the pinned donor manifest and the pinned PTD proof.",
    );
  }
  const donorSource = parsePinnedDonorManifest(
    options.donorManifest,
    options.ledgerPath,
    ledgerSha256,
  );
  const ptdSource = parsePtdAttributeProof(
    options.ptdProof,
    options.ledgerPath,
    ledgerSha256,
  );
  const requestedSkus = options.skus?.length
    ? [...new Set(options.skus.map((sku) => sku.trim()).filter(Boolean))].sort()
    : null;
  const requestedSet = requestedSkus ? new Set(requestedSkus) : null;
  const limit = options.limit ?? null;
  if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("Plan limit must be a positive integer.");
  }

  const ledgerRows = ledger.rows as LedgerRowLike[];
  let rows = ledgerRows
    .filter((row) => !requestedSet || requestedSet.has(String(row.sku ?? "")))
    .sort((a, b) => String(a.sku ?? "").localeCompare(String(b.sku ?? "")));
  if (limit != null) rows = rows.slice(0, limit);

  if (requestedSet) {
    const found = new Set(rows.map((row) => String(row.sku ?? "")));
    const missing = requestedSkus?.filter((sku) => !found.has(sku)) ?? [];
    if (missing.length) {
      throw new Error(`Requested SKU(s) absent from ledger: ${missing.join(", ")}`);
    }
  }
  for (const sku of manifest.keys()) {
    if (!ledgerRows.some((row) => row.sku === sku)) {
      throw new Error(`Manifest SKU ${sku} is absent from the exact source ledger.`);
    }
  }
  const hero = parseHeroManifest(
    options.heroManifest,
    options.galleryManifest,
    rows,
    ledgerSha256,
    new Map(
      Array.from(manifest.entries())
        .filter(
          ([, repair]) =>
            repair.review?.confidence === "HIGH" &&
            repair.text_count?.unit_count != null,
        )
        .map(([sku, repair]) => [sku, repair.text_count?.unit_count as number]),
    ),
  );

  const entries: RepairPlanEntry[] = [];
  const blockers: RepairPlanBlocker[] = [];
  const semanticFailures: UncrustablesRepairPlan["semantic_audit"]["failures"] = [];
  let semanticChecked = 0;
  let semanticRepaired = 0;
  let semanticDeterministic = 0;
  const unsafeCanonicalCodes = new Set([
    "CANONICAL_COMPOSITION_MISSING",
    "DRAFT_MASTER_COUNT_MISMATCH",
    "RECIPE_COUNT_MISMATCH",
  ]);

  for (const row of rows) {
    const sku = nonEmptyString(row.sku);
    const asin = nonEmptyString(row.asin);
    const storeIndex = finiteNumber(row.store_index);
    const productType = nonEmptyString(row.live?.product_type);
    const codes = anomalyCodes(row);
    const explicit = sku ? manifest.get(sku) : null;

    if (!sku || !asin || !Number.isInteger(storeIndex) || !productType) {
      blockers.push({
        sku: sku ?? "UNKNOWN",
        asin,
        codes: ["INVALID_LEDGER_IDENTITY"],
        message: "Ledger row lacks SKU, ASIN, store index, or live product type.",
      });
      continue;
    }
    if (row.live?.fetched !== true) {
      blockers.push({
        sku,
        asin,
        codes: ["AMAZON_LISTING_NOT_FOUND"],
        message: `No successful live GET in source ledger: ${String(row.live?.error ?? "unknown error")}`,
      });
      continue;
    }

    let deterministicTextRepair: DesiredTextCountRepair | null = null;
    const semantic = semanticAuditForRow(row, explicit);
    if (semantic) {
      semanticChecked++;
      if (semantic.error) {
        if (explicit?.text_count) {
          const corrected = semanticAuditForRow(row, explicit, true);
          const acceptsReviewedCatalogPackaging = Boolean(
            corrected?.error &&
              acceptsReviewedSzCatalogPackagingTitle({
                manifest: options.manifest,
                manifestSourceSha256: desiredManifestSource?.sha256 ?? null,
                ledgerSha256,
                row,
                explicit,
                intendedPackCount: corrected.intendedPackCount,
                semanticError: corrected.error,
                variant: corrected.variant,
              }),
          );
          if (!corrected || (corrected.error && !acceptsReviewedCatalogPackaging)) {
            throw new Error(
              `Reviewed text_count manifest does not repair semantic failure for ${sku}: ${corrected?.error ?? "no semantic recipe"}`,
            );
          }
          semanticRepaired++;
          semanticFailures.push({
            sku,
            intended_pack_count: semantic.intendedPackCount,
            error: semantic.error,
            disposition: "EXPLICIT_TEXT_COUNT_REPAIR",
          });
        } else {
          const rendered = renderUncrustablesRepairContent({
            variant: semantic.variant,
            total: semantic.intendedPackCount,
          });
          const renderedError = validateSemanticOutput(rendered, {
            brand:
              nonEmptyString(row.db?.draft?.brand) ??
              nonEmptyString(row.live?.brand) ??
              "Uncrustables",
            pack_count: semantic.intendedPackCount,
            selected_variant: semantic.variant,
          });
          if (renderedError) {
            blockers.push({
              sku,
              asin,
              codes: ["SEMANTIC_CONTENT_FAILED"],
              message:
                `${semantic.error}. Deterministic recipe renderer also failed: ${renderedError}.`,
            });
            semanticFailures.push({
              sku,
              intended_pack_count: semantic.intendedPackCount,
              error: semantic.error,
              disposition: "BLOCKED_REVIEW_REQUIRED",
            });
            continue;
          }
          deterministicTextRepair = {
            ...rendered,
            unit_count: semantic.intendedPackCount,
            unit_count_type: "Count",
            number_of_items: semantic.intendedPackCount,
          };
          semanticDeterministic++;
          semanticFailures.push({
            sku,
            intended_pack_count: semantic.intendedPackCount,
            error: semantic.error,
            disposition: "DETERMINISTIC_RECIPE_REPAIR",
          });
        }
      }
    }

    const actions: PlannedRepairAction[] = [];

    const heroAsset = hero?.assets.get(sku);
    if (heroAsset && explicit?.media) {
      throw new Error(
        `SKU ${sku} has both a hero-manifest asset and an explicit media override.`,
      );
    }
    const explicitGallery = explicit?.media?.gallery_image_urls;
    const explicitGalleryDeletes = explicit?.media?.delete_gallery_slots;
    const media: DesiredMediaRepair = {
      ...(heroAsset
        ? {
            main_image_url: heroAsset.mainImageUrl,
            main_image_sha256: heroAsset.imageSha256,
          }
        : explicit?.media?.main_image_url
          ? { main_image_url: explicit.media.main_image_url }
        : {}),
      gallery_slots: heroAsset
        ? [BRAND_CARD_COLD_CHAIN_URL, ...heroAsset.galleryImageUrls]
            .map((url, index) => ({ slot: index + 1, url }))
        : explicitGallery
          ? explicitGallery.map((url, index) => ({ slot: index + 1, url }))
          : [],
      ...(heroAsset
        ? {
            delete_gallery_slots: Array.from(
              { length: 8 - (heroAsset.galleryImageUrls.length + 1) },
              (_, index) => heroAsset.galleryImageUrls.length + 2 + index,
            ),
          }
        : explicitGalleryDeletes !== undefined
          ? { delete_gallery_slots: [...explicitGalleryDeletes] }
          : {}),
    };
    const slot1 = Array.isArray(row.live?.gallery_image_urls)
      ? nonEmptyString(row.live?.gallery_image_urls[0])
      : null;
    if (!explicitGallery && slot1 === KNOWN_WRONG_SLOT_1_URL) {
      media.gallery_slots.push({ slot: 1, url: BRAND_CARD_COLD_CHAIN_URL });
    }
    if (media.main_image_url || media.gallery_slots.length) {
      actions.push({
        action_id: actionId(sku, "MEDIA"),
        kind: "MEDIA",
        reasons: explicit?.media
          ? ["EXPLICIT_REVIEWED_MEDIA_MANIFEST"]
          : heroAsset
            ? [
                "QA_VERIFIED_DETERMINISTIC_COOLER_HERO",
                "FIXED_CARD_PLUS_REVIEWED_PRODUCT_GALLERY",
              ]
            : ["WRONG_PRICE_INFOGRAPHIC_SLOT_1"],
        ...(explicit?.review ? { review: explicit.review } : {}),
        desired: { kind: "MEDIA", value: media },
      });
    }

    const reviewedPriceCount =
      explicit?.review?.confidence === "HIGH"
        ? desiredPackCount(explicit.text_count)
        : null;
    if (
      reviewedPriceCount != null &&
      explicit?.text_count?.number_of_items != null &&
      explicit.text_count.number_of_items !== reviewedPriceCount
    ) {
      throw new Error(
        `HIGH-reviewed pack-count repair for ${sku} must keep number_of_items aligned with the derived sellable count before pricing.`,
      );
    }
    const reviewedPricing =
      reviewedPriceCount != null ? priceFor(reviewedPriceCount) : null;
    if (reviewedPriceCount != null && !reviewedPricing) {
      throw new Error(
        `No canonical Uncrustables price exists for HIGH-reviewed count ${reviewedPriceCount} on ${sku}.`,
      );
    }
    const suggested =
      reviewedPricing?.suggested ?? finiteNumber(row.canonical?.pricing?.suggested);
    const floor = reviewedPricing?.floor ?? finiteNumber(row.canonical?.pricing?.floor);
    const canonicalOffer =
      suggested != null && floor != null
        ? buildExplicitOffer(
            sku,
            null,
            {
              currency: "USD",
              consumer_price: suggested,
              business_price: suggested,
              minimum_seller_allowed_price: floor,
              maximum_seller_allowed_price: suggested,
            },
          )
        : null;
    const launchRow = launchPricing?.rowsBySku.get(sku) ?? null;
    if (launchPricing && !launchRow) {
      throw new Error(
        `Pinned launch-pricing source has no exact row for selected SKU ${sku}.`,
      );
    }
    const launchCount = reviewedPriceCount ?? semantic?.intendedPackCount ?? null;
    if (launchRow && launchCount == null) {
      throw new Error(
        `Pinned launch-pricing row for ${sku} has no independently derived sellable count.`,
      );
    }
    const launchAwareCanonicalOffer =
      canonicalOffer && launchRow && launchCount != null
        ? applyPinnedLaunchPricing(
            sku,
            asin,
            launchCount,
            canonicalOffer,
            launchRow,
          )
        : canonicalOffer;
    const unsafeCanonical = codes.filter((code) => unsafeCanonicalCodes.has(code));
    let offer: DesiredOfferRepair | null = null;
    if (explicit?.offer) {
      if (unsafeCanonical.length > 0 && explicit.review?.confidence !== "HIGH") {
        throw new Error(
          `Unsafe canonical override for ${sku} requires HIGH-confidence review evidence.`,
        );
      }
      const explicitBaseOffer = buildExplicitOffer(
        sku,
        canonicalOffer,
        explicit.offer,
      );
      offer = launchRow && launchCount != null
        ? applyPinnedLaunchPricing(
            sku,
            asin,
            launchCount,
            explicitBaseOffer,
            launchRow,
          )
        : explicitBaseOffer;
      if (
        reviewedPricing &&
        (differs(offer.consumer_price, reviewedPricing.suggested) ||
          differs(offer.business_price, reviewedPricing.suggested) ||
          differs(offer.minimum_seller_allowed_price, reviewedPricing.floor) ||
          differs(offer.maximum_seller_allowed_price, reviewedPricing.suggested))
      ) {
        throw new Error(
          `Reviewed offer for ${sku} must match priceFor(${reviewedPriceCount}) exactly.`,
        );
      }
    } else if (
      launchAwareCanonicalOffer &&
      (unsafeCanonical.length === 0 || reviewedPricing != null)
    ) {
      const rawAttributes = isRecord(row.live?.raw_attributes)
        ? row.live.raw_attributes
        : {};
      const liveConsumerSelector = observeExactAttributeSelector(
        rawAttributes.purchasable_offer,
        "ALL",
      );
      const liveOurPrice = observeExactScheduledMoney(
        liveConsumerSelector,
        "our_price",
      );
      const liveMinimum = observeExactScheduledMoney(
        liveConsumerSelector,
        "minimum_seller_allowed_price",
      );
      const liveMaximum = observeExactScheduledMoney(
        liveConsumerSelector,
        "maximum_seller_allowed_price",
      );
      const liveBusiness = observeExactBusinessPrice(
        row.live?.raw_offers,
        rawAttributes.purchasable_offer,
      );
      const liveSalePrice = observeSalePrice(
        rawAttributes.purchasable_offer,
      );
      const hasListPrice = rawAttributes.list_price != null;
      const needsOffer =
        differs(
          liveOurPrice.value,
          launchAwareCanonicalOffer.consumer_price,
        ) ||
        differs(
          liveMinimum.value,
          launchAwareCanonicalOffer.minimum_seller_allowed_price,
        ) ||
        differs(
          liveMaximum.value,
          launchAwareCanonicalOffer.maximum_seller_allowed_price,
        ) ||
        differs(
          liveBusiness.value,
          launchAwareCanonicalOffer.business_price,
        ) ||
        !salePriceMatches(liveSalePrice, launchAwareCanonicalOffer) ||
        hasListPrice;
      if (needsOffer) offer = launchAwareCanonicalOffer;
    }
    if (offer) {
      actions.push({
        action_id: actionId(sku, "OFFER"),
        kind: "OFFER",
        reasons: [
          ...(explicit?.offer
            ? ["EXPLICIT_REVIEWED_OFFER_MANIFEST"]
            : reviewedPricing
              ? ["HIGH_REVIEWED_COUNT_PRICE_MODEL_MISMATCH"]
              : ["CANONICAL_PRICE_OR_B2B_MISMATCH"]),
          ...(launchRow ? ["PINNED_COUPON_VS_SALE_PRICE_LAUNCH"] : []),
        ],
        ...(explicit?.review ? { review: explicit.review } : {}),
        desired: { kind: "OFFER", value: offer },
      });
    } else if (unsafeCanonical.length > 0 && reviewedPricing == null) {
      blockers.push({
        sku,
        asin,
        codes: unsafeCanonical,
        message:
          "Automatic price repair blocked because the ledger's canonical count/composition is internally inconsistent; supply a reviewed manifest override.",
      });
    }

    const textCountRepair = explicit?.text_count ?? deterministicTextRepair;
    if (textCountRepair) {
      actions.push({
        action_id: actionId(sku, "TEXT_COUNT"),
        kind: "TEXT_COUNT",
        reasons: explicit?.text_count
          ? ["EXPLICIT_REVIEWED_TEXT_COUNT_MANIFEST"]
          : ["DETERMINISTIC_RECIPE_SEMANTIC_REPAIR"],
        ...(explicit?.review ? { review: explicit.review } : {}),
        desired: { kind: "TEXT_COUNT", value: textCountRepair },
      });
    } else {
      const textCodes = codes.filter((code) =>
        [
          "TITLE_COUNT_MISMATCH",
          "UNIT_COUNT_MISMATCH",
          "NUMBER_OF_ITEMS_MISMATCH",
        ].includes(code),
      );
      if (textCodes.length > 0) {
        blockers.push({
          sku,
          asin,
          codes: textCodes,
          message:
            "Text/count drift requires reviewed exact text in the desired-state manifest; the repair tool will not rewrite customer-facing claims heuristically.",
        });
      }
    }

    if (donorSource && ptdSource) {
      const rawComponents = Array.isArray(row.canonical?.components)
        ? row.canonical.components as StructuredRecipeComponent[]
        : [];
      const canonicalTotal = finiteNumber(row.canonical?.total_units);
      const reviewedTotal =
        explicit?.review?.confidence === "HIGH"
          ? desiredPackCount(explicit.text_count) ?? canonicalTotal
          : canonicalTotal;
      const draftId = nonEmptyString(row.db?.draft?.id);
      const selectedVariantIdx = finiteNumber(row.db?.draft?.selected_variant_idx);
      if (
        reviewedTotal == null ||
        !draftId ||
        selectedVariantIdx == null ||
        !Number.isInteger(selectedVariantIdx)
      ) {
        throw new Error(
          `${sku}: donor-derived structured attributes require exact recipe total, draft ID, and selected variant index.`,
        );
      }
      const desiredStructured = deriveDonorStructuredAttributes({
        sku,
        productType,
        totalUnits: reviewedTotal,
        draftId,
        selectedVariantIdx,
        components: rawComponents,
        donorManifest: donorSource.manifest,
        ptdProof: ptdSource.proof,
        reviewedOverride: explicit?.structured_attributes,
      });
      const rawAttributes = isRecord(row.live?.raw_attributes)
        ? row.live.raw_attributes
        : {};
      const actualAllergens = attrStrings(rawAttributes.allergen_information)
        .sort();
      const expectedAllergens = [...desiredStructured.allergen_information].sort();
      const differsFromLive =
        attrString(rawAttributes.ingredients) !== desiredStructured.ingredients ||
        stableJson(actualAllergens) !== stableJson(expectedAllergens) ||
        (desiredStructured.item_package_quantity != null &&
          attrNumber(rawAttributes.item_package_quantity) !==
            desiredStructured.item_package_quantity) ||
        (desiredStructured.each_unit_count != null &&
          attrNumber(rawAttributes.each_unit_count) !==
            desiredStructured.each_unit_count) ||
        (desiredStructured.each_unit_count_absent === true &&
          rawAttributes.each_unit_count != null) ||
        (desiredStructured.is_expiration_dated_product === true &&
          !attrBoolean(rawAttributes.is_expiration_dated_product)) ||
        (desiredStructured.merchant_shipping_group != null &&
          attrString(rawAttributes.merchant_shipping_group) !==
            desiredStructured.merchant_shipping_group);
      if (differsFromLive) {
        actions.push({
          action_id: actionId(sku, "STRUCTURED_ATTRIBUTES"),
          kind: "STRUCTURED_ATTRIBUTES",
          reasons: [
            "PINNED_MANUFACTURER_INGREDIENTS",
            "REVIEWED_ALLERGEN_UNION",
            ...(explicit?.structured_attributes
              ? ["EXPLICIT_REVIEWED_PACKAGE_CONFIGURATION"]
              : []),
          ],
          ...(explicit?.structured_attributes && explicit.review
            ? { review: explicit.review }
            : {}),
          desired: {
            kind: "STRUCTURED_ATTRIBUTES",
            value: desiredStructured,
          },
        });
      }
    }

    if (actions.length > 0) {
      actions.sort(
        (left, right) =>
          REPAIR_ACTION_EXECUTION_ORDER[left.kind] -
            REPAIR_ACTION_EXECUTION_ORDER[right.kind] ||
          left.action_id.localeCompare(right.action_id),
      );
      entries.push({
        sku,
        asin,
        store_index: storeIndex as number,
        audited_product_type: productType,
        actions,
      });
    }
  }

  const createdAt = options.createdAt ?? new Date();
  const createdIso = createdAt.toISOString();
  const planId = `URP-${createdIso.replace(/[-:.]/g, "").replace("Z", "Z")}`;
  const body: Omit<UncrustablesRepairPlan, "sha256"> = {
    schema_version: REPAIR_PLAN_SCHEMA,
    immutable: true,
    plan_id: planId,
    created_at: createdIso,
    source_ledger: {
      path: path.resolve(options.ledgerPath),
      sha256: ledgerSha256,
      audit_id: auditId,
      schema_version: ledgerSchema,
      completed_at: nonEmptyString(ledger.completed_at),
    },
    desired_manifest_source: desiredManifestSource,
    launch_pricing_source: launchPricing?.source ?? null,
    media_asset_source: hero?.source ?? null,
    structured_attribute_source:
      donorSource && ptdSource
        ? {
            donor_manifest: donorSource.source,
            ptd_proof: ptdSource.source,
          }
        : null,
    policy: {
      marketplace_id: MARKETPLACE_ID,
      patch_only: true,
      validation_preview_required: true,
      post_get_verification_required: true,
      business_price_equals_consumer_price: true,
      discounted_price_absent: launchPricing == null,
      launch_pricing_overlay_pinned: launchPricing != null,
      list_price_absent: true,
      structured_attributes_donor_reviewed: true,
      structured_attributes_ptd_proof_required: true,
      ingredient_keyword_allergen_inference: false,
      shelf_life_mutation: false,
      inventory_mutation: false,
      nutrition_mutation: false,
      brand_card_url: BRAND_CARD_COLD_CHAIN_URL,
      verified_brand_card_rehost_url: VERIFIED_BRAND_CARD_REHOST_URL,
    },
    scope: {
      requested_skus: requestedSkus,
      limit,
      ledger_rows_considered: rows.length,
      entries: entries.length,
      actions: entries.reduce((sum, entry) => sum + entry.actions.length, 0),
      blocked: blockers.length,
    },
    semantic_audit: {
      validator: "validateSemanticOutput",
      checked: semanticChecked,
      passed: semanticChecked - semanticFailures.length,
      failed: semanticFailures.length,
      repaired_by_manifest: semanticRepaired,
      repaired_deterministically: semanticDeterministic,
      blocked: semanticFailures.filter(
        (failure) => failure.disposition === "BLOCKED_REVIEW_REQUIRED",
      ).length,
      failures: semanticFailures,
    },
    entries,
    blockers,
  };
  const plan = { ...body, sha256: planDigest(body) };
  if (options.launchPricingManifest) {
    assertRepairPlanLaunchPricingBinding(
      plan,
      options.launchPricingManifest.bytes,
    );
  }
  return plan;
}

export async function writeImmutablePlan(
  outputDir: string,
  plan: UncrustablesRepairPlan,
): Promise<string> {
  verifyRepairPlan(plan);
  await mkdir(outputDir, { recursive: true });
  const file = path.join(
    outputDir,
    `${plan.plan_id}-${plan.sha256.slice(0, 12)}.json`,
  );
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return file;
}

export const CHANNELMAX_MANIFEST_SCHEMA =
  "uncrustables-channelmax-artifact/v1" as const;

export interface ChannelMaxArtifactManifest {
  schema_version: typeof CHANNELMAX_MANIFEST_SCHEMA;
  immutable: true;
  created_at: string;
  source_plan_id: string;
  source_plan_sha256: string;
  selling_venue: "AmazonUS";
  columns: [
    "SKU",
    "ASIN",
    "SellingVenue",
    "MinSellingPrice",
    "MaxSellingPrice",
  ];
  rows: number;
  tsv_file: string;
  tsv_sha256: string;
  uploaded: false;
  sha256: string;
}

/**
 * Emit the exact ChannelMAX min/max artifact from the sealed OFFER actions.
 * The `.txt` uses CRLF and ChannelMAX's exact five headers. Both files use
 * exclusive creation; this function never uploads the artifact.
 */
export async function writeImmutableChannelMaxArtifact(
  outputDir: string,
  plan: UncrustablesRepairPlan,
): Promise<{ tsvPath: string; manifestPath: string; manifest: ChannelMaxArtifactManifest }> {
  verifyRepairPlan(plan);
  if (plan.launch_pricing_source) {
    throw new Error(
      "Bounds-only ChannelMAX artifacts are disabled for launch-aware plans: they do not park SKU repricing or prove a Manual model. Build a separately verified Manual-model assignment artifact.",
    );
  }
  const offerRows = plan.entries
    .flatMap((entry) =>
      entry.actions
        .filter(
          (action): action is PlannedRepairAction & {
            desired: { kind: "OFFER"; value: DesiredOfferRepair };
          } => action.desired.kind === "OFFER",
        )
        .map((action) => ({ entry, offer: action.desired.value })),
    )
    .sort((left, right) => left.entry.sku.localeCompare(right.entry.sku));
  if (offerRows.length === 0) {
    throw new Error("Plan contains no OFFER actions for a ChannelMAX artifact.");
  }
  const columns = [
    "SKU",
    "ASIN",
    "SellingVenue",
    "MinSellingPrice",
    "MaxSellingPrice",
  ] as const;
  const lines = [columns.join("\t")];
  for (const { entry, offer } of offerRows) {
    lines.push(
      [
        entry.sku,
        entry.asin,
        "AmazonUS",
        offer.minimum_seller_allowed_price.toFixed(2),
        offer.maximum_seller_allowed_price.toFixed(2),
      ].join("\t"),
    );
  }
  const tsv = `${lines.join("\r\n")}\r\n`;
  const base = `${plan.plan_id}-${plan.sha256.slice(0, 12)}-channelmax`;
  const tsvName = `${base}.txt`;
  const manifestName = `${base}.manifest.json`;
  const createdAt = new Date().toISOString();
  const manifestBody: Omit<ChannelMaxArtifactManifest, "sha256"> = {
    schema_version: CHANNELMAX_MANIFEST_SCHEMA,
    immutable: true,
    created_at: createdAt,
    source_plan_id: plan.plan_id,
    source_plan_sha256: plan.sha256,
    selling_venue: "AmazonUS",
    columns: [...columns],
    rows: offerRows.length,
    tsv_file: tsvName,
    tsv_sha256: sha256(tsv),
    uploaded: false,
  };
  const manifest: ChannelMaxArtifactManifest = {
    ...manifestBody,
    sha256: sha256(stableJson(manifestBody)),
  };
  await mkdir(outputDir, { recursive: true });
  const tsvPath = path.join(outputDir, tsvName);
  const manifestPath = path.join(outputDir, manifestName);
  await writeFile(tsvPath, tsv, { encoding: "utf8", flag: "wx" });
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    // The TSV remains immutable and hash-addressed if the manifest write fails;
    // callers can safely rerun into another output directory.
    throw error;
  }
  return { tsvPath, manifestPath, manifest };
}

export async function readRepairPlan(file: string): Promise<UncrustablesRepairPlan> {
  const plan = JSON.parse(await readFile(file, "utf8")) as UncrustablesRepairPlan;
  verifyRepairPlan(plan);
  return plan;
}

export type CheckpointStatus =
  | "PREVIEW_VALID"
  | "SUBMISSION_ARMED"
  | "SUBMITTED"
  | "PENDING_QUARANTINED"
  | "SETTLEMENT_PENDING"
  | "SETTLED_BEFORE"
  | "SETTLED_NON_DESIRED"
  | "SETTLEMENT_UNRESOLVED"
  | typeof EXTERNAL_OVERWRITE_TERMINAL_STATUS
  | typeof PRE_REQUEST_ABORT_TERMINAL_STATUS
  | "FENCE_RELEASE_ARMED"
  | "FENCE_RELEASED"
  | "VERIFIED"
  | "ALREADY_APPLIED"
  | "FAILED";

export interface CheckpointEvent {
  schema_version: typeof CHECKPOINT_SCHEMA;
  immutable: true;
  event_id: string;
  created_at: string;
  plan_sha256: string;
  action_id: string;
  sku: string;
  kind: RepairActionKind;
  status: CheckpointStatus;
  detail: UnknownRecord;
  sha256: string;
}

export interface PendingRepairSubmission {
  action_id: string;
  sku: string;
  kind: RepairActionKind;
  source_status: "SUBMISSION_ARMED" | "SUBMITTED";
  submitted_event_id: string;
  submitted_at: string;
  detail: UnknownRecord;
  armed_event_id?: string;
  armed_detail?: UnknownRecord;
}

export class ImmutableCheckpointStore {
  private readonly rootDir: string;
  private readonly planSha256: string;

  constructor(
    rootDir: string,
    planSha256: string,
    private readonly coordinationDir: string =
      CANONICAL_UNCRUSTABLES_AMAZON_COORDINATION_DIR,
  ) {
    this.rootDir = rootDir;
    this.planSha256 = planSha256;
  }

  private directory(): string {
    return path.join(this.rootDir, this.planSha256.slice(0, 20));
  }

  /** Exclusive marketplace/scope process lease. There is intentionally no automatic
   * stale-lock eviction: after a crash, an operator must first settle every
   * armed/submitted mutation before manually removing the lease file. */
  async acquireExecutionLease(purpose: string): Promise<() => Promise<void>> {
    const coordinationDir = path.resolve(this.coordinationDir);
    await mkdir(coordinationDir, { recursive: true });
    const leasePath = path.join(coordinationDir, "active-execution.lock");
    const leaseId = randomUUID();
    const body = {
      schema_version: "uncrustables-amazon-mutation-lease/v1",
      immutable_plan_sha256: this.planSha256,
      lease_id: leaseId,
      acquired_at: new Date().toISOString(),
      process_id: process.pid,
      purpose,
    };
    try {
      await writeFile(leasePath, `${JSON.stringify(body, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Amazon mutation execution lease already exists for plan ${this.planSha256}. Refusing concurrent or post-crash execution; inspect ${leasePath} and pending settlement checkpoints before manual lease removal.`,
        );
      }
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      const current = JSON.parse(await readFile(leasePath, "utf8")) as {
        lease_id?: unknown;
      };
      if (current.lease_id !== leaseId) {
        throw new Error(
          `Amazon mutation execution lease ownership changed for ${this.planSha256}; refusing to remove it.`,
        );
      }
      await unlink(leasePath);
      released = true;
    };
  }

  /** Persistent cross-plan fence. It remains while an armed/submitted write
   * is unresolved, preventing a newer repair-plan SHA from ignoring the older
   * plan's checkpoint journal after the active process exits. */
  async claimPendingMutationFence(purpose: string): Promise<void> {
    const coordinationDir = path.resolve(this.coordinationDir);
    await mkdir(coordinationDir, { recursive: true });
    const fencePath = path.join(coordinationDir, "pending-mutation-fence.json");
    const body = {
      schema_version: "uncrustables-amazon-pending-mutation-fence/v1",
      repair_plan_sha256: this.planSha256,
      claimed_at: new Date().toISOString(),
      process_id: process.pid,
      purpose,
    };
    try {
      await writeFile(fencePath, `${JSON.stringify(body, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(fencePath, "utf8")) as {
        repair_plan_sha256?: unknown;
      };
      if (existing.repair_plan_sha256 !== this.planSha256) {
        throw new Error(
          `Amazon mutation fence belongs to unresolved repair plan ${String(existing.repair_plan_sha256 ?? "unknown")}; refusing plan ${this.planSha256}. Inspect ${fencePath} and settle the older plan first.`,
        );
      }
    }
  }

  async releasePendingMutationFence(): Promise<void> {
    const fencePath = path.join(
      path.resolve(this.coordinationDir),
      "pending-mutation-fence.json",
    );
    let existing: { repair_plan_sha256?: unknown };
    try {
      existing = JSON.parse(await readFile(fencePath, "utf8")) as {
        repair_plan_sha256?: unknown;
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (existing.repair_plan_sha256 !== this.planSha256) {
      throw new Error(
        "Refusing to remove Amazon mutation fence owned by another repair plan.",
      );
    }
    await unlink(fencePath);
  }

  private async appendUnchecked(
    input: Omit<
      CheckpointEvent,
      "schema_version" | "immutable" | "event_id" | "created_at" | "plan_sha256" | "sha256"
    >,
  ): Promise<CheckpointEvent> {
    const createdAt = new Date().toISOString();
    const eventId = randomUUID();
    const body: Omit<CheckpointEvent, "sha256"> = {
      schema_version: CHECKPOINT_SCHEMA,
      immutable: true,
      event_id: eventId,
      created_at: createdAt,
      plan_sha256: this.planSha256,
      ...input,
    };
    const event: CheckpointEvent = { ...body, sha256: sha256(stableJson(body)) };
    const directory = this.directory();
    await mkdir(directory, { recursive: true });
    const safeAction = input.action_id.replace(/[^A-Za-z0-9_.-]+/g, "_");
    const file = path.join(
      directory,
      `${createdAt.replace(/[-:.]/g, "")}-${safeAction}-${input.status}-${eventId}.json`,
    );
    await writeFile(file, `${JSON.stringify(event, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return event;
  }

  async append(
    input: Omit<
      CheckpointEvent,
      "schema_version" | "immutable" | "event_id" | "created_at" | "plan_sha256" | "sha256"
    >,
  ): Promise<CheckpointEvent> {
    if (
      input.status === EXTERNAL_OVERWRITE_TERMINAL_STATUS ||
      input.status === PRE_REQUEST_ABORT_TERMINAL_STATUS
    ) {
      throw new Error(
        "Evidence-bound disposition terminal checkpoints require their exact disposition method.",
      );
    }
    return this.appendUnchecked(input);
  }

  /** Terminalize one accepted OFFER only after a separately sealed, exact
   * ChannelMAX-overwrite proposal has been confirmed. This appends evidence but
   * intentionally never releases the process-global pending fence. */
  async dispositionExternallyOverwrittenOffer(input: {
    proposal: ExternalOverwriteDispositionProposal;
    confirmation: string;
  }): Promise<CheckpointEvent> {
    verifyExternalOverwriteDispositionProposal(input.proposal);
    if (input.confirmation !== input.proposal.confirmation_token) {
      throw new Error("External-overwrite disposition confirmation mismatch.");
    }
    if (input.proposal.plan.sha256 !== this.planSha256) {
      throw new Error(
        "External-overwrite disposition belongs to another repair plan.",
      );
    }
    const pending = await this.pendingSubmissions();
    const submission = pending.get(input.proposal.action.action_id);
    if (
      pending.size !== 1 ||
      !submission ||
      submission.source_status !== "SUBMITTED" ||
      submission.submitted_event_id !==
        input.proposal.pending_submission.event_id ||
      submission.sku !== input.proposal.action.sku ||
      submission.kind !== "OFFER"
    ) {
      throw new Error(
        "External-overwrite disposition no longer matches the one canonical pending OFFER.",
      );
    }

    const fencePath = path.join(
      path.resolve(this.coordinationDir),
      "pending-mutation-fence.json",
    );
    if (path.resolve(input.proposal.fence.path) !== fencePath) {
      throw new Error("Disposition proposal is not bound to the canonical fence path.");
    }
    const fenceBefore = await readFile(fencePath);
    if (sha256(fenceBefore) !== input.proposal.fence.file_sha256) {
      throw new Error("Pending mutation fence changed after disposition planning.");
    }

    const names = (await readdir(this.directory()))
      .filter((name) => name.endsWith(".json"))
      .sort();
    const eventsById = new Map<string, CheckpointEvent>();
    for (const name of names) {
      const event = JSON.parse(
        await readFile(path.join(this.directory(), name), "utf8"),
      ) as CheckpointEvent;
      const { sha256: claimed, ...body } = event;
      if (
        event.schema_version !== CHECKPOINT_SCHEMA ||
        event.immutable !== true ||
        event.plan_sha256 !== this.planSha256 ||
        claimed !== sha256(stableJson(body)) ||
        eventsById.has(event.event_id)
      ) {
        throw new Error(`Invalid/tampered checkpoint event: ${name}`);
      }
      eventsById.set(event.event_id, event);
    }
    verifyExternalOverwriteTerminalEvent({
      terminalEvent: {
        plan_sha256: this.planSha256,
        action_id: input.proposal.action.action_id,
        sku: input.proposal.action.sku,
        kind: "OFFER",
        status: EXTERNAL_OVERWRITE_TERMINAL_STATUS,
        detail: {
          schema_version: EXTERNAL_OVERWRITE_TERMINAL_DETAIL_SCHEMA,
          submitted_event_id: input.proposal.pending_submission.event_id,
          proposal: input.proposal,
        },
      },
      eventsById,
    });

    const event = await this.appendUnchecked({
      action_id: input.proposal.action.action_id,
      sku: input.proposal.action.sku,
      kind: "OFFER",
      status: EXTERNAL_OVERWRITE_TERMINAL_STATUS,
      detail: {
        schema_version: EXTERNAL_OVERWRITE_TERMINAL_DETAIL_SCHEMA,
        submitted_event_id: input.proposal.pending_submission.event_id,
        proposal: input.proposal,
      },
    });
    const fenceAfter = await readFile(fencePath);
    if (!fenceAfter.equals(fenceBefore)) {
      throw new Error(
        "Pending mutation fence changed during disposition; manual review required.",
      );
    }
    if ((await this.pendingSubmissions()).has(input.proposal.action.action_id)) {
      throw new Error("External-overwrite terminal checkpoint did not close its exact submission.");
    }
    return event;
  }

  /** Close only a proven synchronous pre-request abort. This status is
   * intentionally not VERIFIED/ALREADY_APPLIED: it clears ambiguity so a new
   * exact execution may retry the action, while preserving the fence until a
   * separate confirmed release step. */
  async dispositionPreRequestAbort(input: {
    proposal: PreRequestAbortDispositionProposal;
    confirmation: string;
  }): Promise<CheckpointEvent> {
    verifyPreRequestAbortDispositionProposal(input.proposal);
    if (input.confirmation !== input.proposal.confirmation_token) {
      throw new Error("Pre-request abort disposition confirmation mismatch.");
    }
    if (input.proposal.plan.sha256 !== this.planSha256) {
      throw new Error("Pre-request abort disposition belongs to another plan.");
    }
    const pending = await this.pendingSubmissions();
    const submission = pending.get(input.proposal.action.action_id);
    if (
      pending.size !== 1 ||
      !submission ||
      submission.source_status !== "SUBMISSION_ARMED" ||
      submission.submitted_event_id !== input.proposal.armed.event_id ||
      submission.sku !== input.proposal.action.sku ||
      submission.kind !== "MEDIA"
    ) {
      throw new Error(
        "Pre-request abort disposition no longer matches the one canonical armed action.",
      );
    }

    const fencePath = path.join(
      path.resolve(this.coordinationDir),
      "pending-mutation-fence.json",
    );
    if (path.resolve(input.proposal.fence.path) !== fencePath) {
      throw new Error("Pre-request abort proposal is not bound to the canonical fence path.");
    }
    const fenceBefore = await readFile(fencePath);
    if (sha256(fenceBefore) !== input.proposal.fence.file_sha256) {
      throw new Error("Pending mutation fence changed after abort planning.");
    }

    const names = (await readdir(this.directory()))
      .filter((name) => name.endsWith(".json"))
      .sort();
    const eventsById = new Map<string, CheckpointEvent>();
    for (const name of names) {
      const event = JSON.parse(
        await readFile(path.join(this.directory(), name), "utf8"),
      ) as CheckpointEvent;
      const { sha256: claimed, ...body } = event;
      if (
        event.schema_version !== CHECKPOINT_SCHEMA ||
        event.immutable !== true ||
        event.plan_sha256 !== this.planSha256 ||
        claimed !== sha256(stableJson(body)) ||
        eventsById.has(event.event_id)
      ) {
        throw new Error(`Invalid/tampered checkpoint event: ${name}`);
      }
      eventsById.set(event.event_id, event);
    }
    verifyPreRequestAbortTerminalEvent({
      terminalEvent: {
        plan_sha256: this.planSha256,
        action_id: input.proposal.action.action_id,
        sku: input.proposal.action.sku,
        kind: "MEDIA",
        status: PRE_REQUEST_ABORT_TERMINAL_STATUS,
        detail: {
          schema_version: PRE_REQUEST_ABORT_TERMINAL_DETAIL_SCHEMA,
          armed_event_id: input.proposal.armed.event_id,
          proposal: input.proposal,
        },
      },
      eventsById,
    });

    const event = await this.appendUnchecked({
      action_id: input.proposal.action.action_id,
      sku: input.proposal.action.sku,
      kind: "MEDIA",
      status: PRE_REQUEST_ABORT_TERMINAL_STATUS,
      detail: {
        schema_version: PRE_REQUEST_ABORT_TERMINAL_DETAIL_SCHEMA,
        armed_event_id: input.proposal.armed.event_id,
        proposal: input.proposal,
      },
    });
    const fenceAfter = await readFile(fencePath);
    if (!fenceAfter.equals(fenceBefore)) {
      throw new Error(
        "Pending mutation fence changed during abort disposition; manual review required.",
      );
    }
    if ((await this.pendingSubmissions()).has(input.proposal.action.action_id)) {
      throw new Error("Pre-request abort checkpoint did not close its exact armed event.");
    }
    return event;
  }

  async verifiedActionIds(): Promise<Set<string>> {
    const complete = new Set<string>();
    let names: string[];
    try {
      names = await readdir(this.directory());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return complete;
      throw error;
    }
    const events: CheckpointEvent[] = [];
    for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
      const event = JSON.parse(
        await readFile(path.join(this.directory(), name), "utf8"),
      ) as CheckpointEvent;
      const { sha256: claimed, ...body } = event;
      if (
        event.schema_version !== CHECKPOINT_SCHEMA ||
        event.immutable !== true ||
        event.plan_sha256 !== this.planSha256 ||
        claimed !== sha256(stableJson(body))
      ) {
        throw new Error(`Invalid/tampered checkpoint event: ${name}`);
      }
      events.push(event);
    }
    const eventsById = new Map(events.map((event) => [event.event_id, event]));
    for (const event of events) {
      if (event.status === EXTERNAL_OVERWRITE_TERMINAL_STATUS) {
        verifyExternalOverwriteTerminalEvent({ terminalEvent: event, eventsById });
      }
      if (event.status === PRE_REQUEST_ABORT_TERMINAL_STATUS) {
        verifyPreRequestAbortTerminalEvent({ terminalEvent: event, eventsById });
      }
      if (
        event.status === "VERIFIED" ||
        event.status === "ALREADY_APPLIED" ||
        event.status === EXTERNAL_OVERWRITE_TERMINAL_STATUS
      ) {
        complete.add(event.action_id);
      }
    }
    return complete;
  }

  /** Return only submissions that have no later immutable settlement marker.
   * FAILED deliberately does not close a submission: a Listings Items PATCH
   * accepted by Amazon can still become visible after a readback timeout. */
  async pendingSubmissions(): Promise<Map<string, PendingRepairSubmission>> {
    const pending = new Map<string, PendingRepairSubmission>();
    let names: string[];
    try {
      names = await readdir(this.directory());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return pending;
      throw error;
    }
    const events: Array<{ name: string; event: CheckpointEvent }> = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const event = JSON.parse(
        await readFile(path.join(this.directory(), name), "utf8"),
      ) as CheckpointEvent;
      const { sha256: claimed, ...body } = event;
      if (
        event.schema_version !== CHECKPOINT_SCHEMA ||
        event.immutable !== true ||
        event.plan_sha256 !== this.planSha256 ||
        claimed !== sha256(stableJson(body))
      ) {
        throw new Error(`Invalid/tampered checkpoint event: ${name}`);
      }
      events.push({ name, event });
    }
    events.sort(
      (left, right) =>
        left.event.created_at.localeCompare(right.event.created_at) ||
        left.name.localeCompare(right.name),
    );
    const submittedByEventId = new Map(
      events
        .filter(({ event }) =>
          event.status === "SUBMISSION_ARMED" || event.status === "SUBMITTED"
        )
        .map(({ event }) => [event.event_id, event] as const),
    );
    const eventsById = new Map(
      events.map(({ event }) => [event.event_id, event] as const),
    );
    for (const { event } of events) {
      if (event.status === "SUBMITTED") {
        const armedEventId = event.detail.armed_event_id;
        if (typeof armedEventId === "string" && armedEventId.length > 0) {
          const armed = submittedByEventId.get(armedEventId);
          if (
            !armed ||
            armed.status !== "SUBMISSION_ARMED" ||
            armed.action_id !== event.action_id ||
            armed.sku !== event.sku ||
            armed.kind !== event.kind ||
            (armed.detail.launch_execution_authorization_body_sha256 != null ||
            event.detail.launch_execution_authorization_body_sha256 != null
              ? armed.detail.launch_execution_authorization_body_sha256 !==
                event.detail.launch_execution_authorization_body_sha256
              : false)
          ) {
            throw new Error(
              `SUBMITTED checkpoint ${event.event_id} has invalid armed-event lineage.`,
            );
          }
        }
      }
      if (event.status === EXTERNAL_OVERWRITE_TERMINAL_STATUS) {
        verifyExternalOverwriteTerminalEvent({ terminalEvent: event, eventsById });
      }
      if (event.status === PRE_REQUEST_ABORT_TERMINAL_STATUS) {
        verifyPreRequestAbortTerminalEvent({ terminalEvent: event, eventsById });
      }
      if (
        event.status === "VERIFIED" ||
        event.status === "ALREADY_APPLIED" ||
        event.status === EXTERNAL_OVERWRITE_TERMINAL_STATUS ||
        event.status === PRE_REQUEST_ABORT_TERMINAL_STATUS
      ) {
        const closedEventId = event.detail.submitted_event_id;
        if (typeof closedEventId === "string" && closedEventId.length > 0) {
          const submitted = submittedByEventId.get(closedEventId);
          if (
            !submitted ||
            submitted.action_id !== event.action_id ||
            submitted.sku !== event.sku ||
            submitted.kind !== event.kind
          ) {
            throw new Error(
              `Terminal checkpoint ${event.event_id} cross-closes an invalid submitted event.`,
            );
          }
        }
      }
    }
    const explicitlyClosedSubmissionIds = new Set(
      events
        .filter(({ event }) =>
          event.status === "VERIFIED" ||
          event.status === "ALREADY_APPLIED" ||
          event.status === EXTERNAL_OVERWRITE_TERMINAL_STATUS ||
          event.status === PRE_REQUEST_ABORT_TERMINAL_STATUS)
        .map(({ event }) =>
          event.status === PRE_REQUEST_ABORT_TERMINAL_STATUS
            ? event.detail.armed_event_id
            : event.detail.submitted_event_id
        )
        .filter(
          (eventId): eventId is string =>
            typeof eventId === "string" && eventId.length > 0,
        ),
    );
    const supersededArmedEventIds = new Set(
      events
        .filter(({ event }) => event.status === "SUBMITTED")
        .map(({ event }) => event.detail.armed_event_id)
        .filter(
          (eventId): eventId is string =>
            typeof eventId === "string" && eventId.length > 0,
        ),
    );
    for (const { event } of events) {
      if (event.status === "SUBMISSION_ARMED" || event.status === "SUBMITTED") {
        if (
          explicitlyClosedSubmissionIds.has(event.event_id) ||
          (event.status === "SUBMISSION_ARMED" &&
            supersededArmedEventIds.has(event.event_id))
        ) continue;
        if (pending.has(event.action_id)) {
          throw new Error(
            `Multiple unresolved submissions exist for action ${event.action_id}; refusing ambiguous recovery.`,
          );
        }
        pending.set(event.action_id, {
          action_id: event.action_id,
          sku: event.sku,
          kind: event.kind,
          source_status: event.status,
          submitted_event_id: event.event_id,
          submitted_at: event.created_at,
          detail: structuredClone(event.detail),
          ...(event.status === "SUBMITTED" &&
          typeof event.detail.armed_event_id === "string" &&
          event.detail.armed_event_id.length > 0
            ? {
                armed_event_id: event.detail.armed_event_id,
                armed_detail: structuredClone(
                  submittedByEventId.get(event.detail.armed_event_id)?.detail ?? {},
                ),
              }
            : event.status === "SUBMISSION_ARMED"
              ? {
                  armed_event_id: event.event_id,
                  armed_detail: structuredClone(event.detail),
                }
              : {}),
        });
      } else if (
        event.status === "VERIFIED" ||
        event.status === "ALREADY_APPLIED" ||
        event.status === EXTERNAL_OVERWRITE_TERMINAL_STATUS ||
        event.status === PRE_REQUEST_ABORT_TERMINAL_STATUS
      ) {
        const current = pending.get(event.action_id);
        const closedEventId = event.status === PRE_REQUEST_ABORT_TERMINAL_STATUS
          ? event.detail.armed_event_id
          : event.detail.submitted_event_id;
        if (
          current &&
          typeof closedEventId === "string" &&
          closedEventId === current.submitted_event_id
        ) {
          pending.delete(event.action_id);
        }
      }
    }
    return pending;
  }

  /** Check every canonical SHA-addressed forward journal below this checkpoint
   * root. The marketplace fence is process-global, so it may be removed only
   * when no repair plan still has an armed/submitted mutation. Diagnostic
   * preview directories are intentionally excluded: canonical live journals
   * are named by the first 20 hex characters of their sealed plan SHA. */
  async hasGlobalPendingSubmissions(): Promise<boolean> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{20}$/.test(entry.name)) continue;
      const directory = path.join(this.rootDir, entry.name);
      const names = (await readdir(directory))
        .filter((name) => name.endsWith(".json"))
        .sort();
      if (names.length === 0) continue;
      const first = JSON.parse(
        await readFile(path.join(directory, names[0]), "utf8"),
      ) as CheckpointEvent;
      if (
        typeof first.plan_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(first.plan_sha256) ||
        first.plan_sha256.slice(0, 20) !== entry.name
      ) {
        throw new Error(
          `Canonical checkpoint directory ${entry.name} is not bound to a valid plan SHA-256.`,
        );
      }
      const store = new ImmutableCheckpointStore(
        this.rootDir,
        first.plan_sha256,
        this.coordinationDir,
      );
      if ((await store.pendingSubmissions()).size > 0) return true;
    }
    return false;
  }
}

const PURCHASABLE_OFFER_SELECTORS = [
  "marketplace_id",
  "currency",
  "audience",
] as const;

function purchasableOfferSelector(
  entry: UnknownRecord,
  requireExplicit: boolean,
): { marketplace_id: string; currency: string; audience: string } {
  const marketplaceId = nonEmptyString(entry.marketplace_id) ??
    (requireExplicit ? null : MARKETPLACE_ID);
  const currency = nonEmptyString(entry.currency) ??
    (requireExplicit ? null : "USD");
  const audience = nonEmptyString(entry.audience) ??
    (requireExplicit ? null : "ALL");
  if (!marketplaceId || !currency || !audience) {
    throw new Error(
      "purchasable_offer merge entries require marketplace_id, currency, and audience selectors.",
    );
  }
  return { marketplace_id: marketplaceId, currency, audience };
}

function purchasableOfferSelectorKey(
  entry: UnknownRecord,
  requireExplicit = false,
): string {
  const selector = purchasableOfferSelector(entry, requireExplicit);
  return `${selector.marketplace_id}\u0000${selector.currency}\u0000${selector.audience}`;
}

function sortedPurchasableOffers(entries: UnknownRecord[]): UnknownRecord[] {
  return entries
    .map((entry) => structuredClone(entry))
    .sort(
      (left, right) =>
        purchasableOfferSelectorKey(left).localeCompare(
          purchasableOfferSelectorKey(right),
        ) || stableJson(left).localeCompare(stableJson(right)),
    );
}

function purchasableOfferEntries(value: unknown, label: string): UnknownRecord[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) {
    throw new Error(`${label} must be an array of offer objects.`);
  }
  return value.map((entry) => structuredClone(entry as UnknownRecord));
}

/**
 * Apply Amazon's selector-aware `merge` semantics locally. This is used only
 * for sealed expected-state/CAS calculations and tests; the live request still
 * sends the narrow merge payload to Amazon.
 */
export function applyPurchasableOfferMerge(
  existing: unknown,
  mergeValue: unknown,
): Record<string, unknown>[] {
  const entries = purchasableOfferEntries(existing, "Existing purchasable_offer");
  const updates = purchasableOfferEntries(
    mergeValue,
    "purchasable_offer merge value",
  );
  const seenUpdates = new Set<string>();
  for (const update of updates) {
    const selector = purchasableOfferSelector(update, true);
    const selectorKey = purchasableOfferSelectorKey(update, true);
    if (seenUpdates.has(selectorKey)) {
      throw new Error(`Duplicate purchasable_offer merge selector ${selectorKey}.`);
    }
    seenUpdates.add(selectorKey);
    let target = entries.find(
      (entry) => purchasableOfferSelectorKey(entry) === selectorKey,
    );
    if (!target) {
      target = { ...selector };
      entries.push(target);
    }
    for (const [key, value] of Object.entries(update)) {
      if ((PURCHASABLE_OFFER_SELECTORS as readonly string[]).includes(key)) {
        continue;
      }
      if (value === null) delete target[key];
      else target[key] = structuredClone(value);
    }
  }
  return sortedPurchasableOffers(entries);
}

/** Narrow selector-aware merge payload recommended by Listings Items. It
 * changes only the canonical consumer fields and B2B `our_price`; quantity
 * discounts, metadata, and unrelated audiences are not echoed or overwritten. */
export function canonicalPurchasableOfferMergeValue(
  desired: DesiredOfferRepair,
): Record<string, unknown>[] {
  const saleSchedule = desired.discounted_price_schedule;
  if (!desired.discounted_price_absent && !saleSchedule) {
    throw new Error("Pinned Sale Price desired state is missing its schedule.");
  }
  const discountedPrice: unknown = desired.discounted_price_absent
    ? null
    : [
        {
          schedule: [
            {
              value_with_tax: saleSchedule?.value_with_tax,
              start_at: saleSchedule?.start_at,
              end_at: saleSchedule?.end_at,
            },
          ],
        },
      ];
  return [
    {
      marketplace_id: MARKETPLACE_ID,
      currency: desired.currency,
      audience: "ALL",
      our_price: priceSchedule(desired.consumer_price),
      minimum_seller_allowed_price: priceSchedule(
        desired.minimum_seller_allowed_price,
      ),
      maximum_seller_allowed_price: priceSchedule(
        desired.maximum_seller_allowed_price,
      ),
      // Coupon arm: null removes only this field from the ALL selector. Sale
      // arm: the exact owner-reviewed schedule is written without changing
      // StandardPrice/our_price, min/max, or unrelated offer metadata.
      discounted_price: discountedPrice,
    },
    {
      marketplace_id: MARKETPLACE_ID,
      currency: desired.currency,
      audience: "B2B",
      our_price: priceSchedule(desired.business_price),
    },
  ];
}

function offerMergePreviewSurrogate(
  actualMergePatch: ListingPatch,
  context: OfferMergePreviewContext,
): {
  patch: ListingPatch;
  omittedNullMembers: string[];
} {
  if (
    actualMergePatch.op !== "merge" ||
    actualMergePatch.path !== "/attributes/purchasable_offer"
  ) {
    throw new Error(
      `Preview surrogate accepts only selector-aware purchasable_offer merge, got ${actualMergePatch.op} ${actualMergePatch.path}.`,
    );
  }
  const updates = purchasableOfferEntries(
    actualMergePatch.value,
    "Actual purchasable_offer merge preview source",
  );
  if (updates.length === 0) {
    throw new Error("purchasable_offer merge preview source is empty.");
  }
  const seenSelectors = new Set<string>();
  const omittedNullMembers: string[] = [];
  const previewValue = updates.map((raw) => {
    const selector = purchasableOfferSelector(raw, true);
    const selectorKey = purchasableOfferSelectorKey(raw, true);
    if (seenSelectors.has(selectorKey)) {
      throw new Error(
        `Duplicate purchasable_offer preview selector ${selectorKey}.`,
      );
    }
    seenSelectors.add(selectorKey);
    if (!["ALL", "B2B"].includes(selector.audience)) {
      throw new Error(
        `Unreviewed purchasable_offer preview audience ${selector.audience}.`,
      );
    }
    const previewEntry: UnknownRecord = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === null) {
        if ((PURCHASABLE_OFFER_SELECTORS as readonly string[]).includes(key)) {
          throw new Error(
            `Null selector ${key} is forbidden in purchasable_offer merge.`,
          );
        }
        // Selector-aware replace previews the non-null update fields. Omitted
        // members are preserved by Amazon; the real selector merge performs
        // the deletion and the mandatory post-GET proves the absent state.
        omittedNullMembers.push(`${selector.audience}.${key}`);
        continue;
      }
      previewEntry[key] = structuredClone(value);
    }
    if (
      Object.keys(previewEntry).every((key) =>
        (PURCHASABLE_OFFER_SELECTORS as readonly string[]).includes(key),
      )
    ) {
      throw new Error(
        `Selector ${selector.audience} has only null deletions and cannot be safely previewed as replace.`,
      );
    }
    return previewEntry;
  });

  const audiences = updates
    .map((entry) => purchasableOfferSelector(entry, true).audience)
    .sort();
  if (
    context === "FORWARD_OFFER" &&
    stableJson(audiences) !== stableJson(["ALL", "B2B"].sort())
  ) {
    throw new Error(
      "Forward OFFER merge preview must contain exactly the ALL and B2B selectors.",
    );
  }
  const sortedOmissions = [...omittedNullMembers].sort();
  const forwardOmissionsValid =
    stableJson(sortedOmissions) === stableJson(["ALL.discounted_price"]) ||
    (sortedOmissions.length === 0 &&
      updates.some((entry) => {
        const selector = purchasableOfferSelector(entry, true);
        return selector.audience === "ALL" && entry.discounted_price != null;
      }));
  if (
    context === "FORWARD_OFFER" &&
    !forwardOmissionsValid
  ) {
    throw new Error(
      "Forward OFFER preview must either omit discounted_price:null for the coupon arm or include a non-null pinned Sale Price for the sale arm.",
    );
  }
  return {
    patch: {
      op: "replace",
      path: actualMergePatch.path,
      value: previewValue,
    },
    omittedNullMembers: sortedOmissions,
  };
}

/** Amazon returns HTTP 400 when `op:merge` is submitted with
 * VALIDATION_PREVIEW. Build the narrow selector-aware replace surrogate used
 * only for that preview request. The actual patch array is retained verbatim
 * and remains the sole input to rollback coverage, the real PATCH and
 * post-write verification. */
export function buildValidationPreviewPatchSet(
  actualPatches: ListingPatch[],
  context: RepairActionKind | OfferMergePreviewContext,
): ValidationPreviewPatchSet {
  if (!Array.isArray(actualPatches) || actualPatches.length === 0) {
    throw new Error("VALIDATION_PREVIEW requires a non-empty actual patch set.");
  }
  const seenPaths = new Set<string>();
  const mergeIndexes: number[] = [];
  actualPatches.forEach((patch, index) => {
    if (seenPaths.has(patch.path)) {
      throw new Error(`VALIDATION_PREVIEW patch set repeats ${patch.path}.`);
    }
    seenPaths.add(patch.path);
    if (patch.op === "merge") mergeIndexes.push(index);
  });
  const actual = structuredClone(actualPatches);
  if (mergeIndexes.length === 0) {
    return {
      strategy: "EXACT",
      actual_patches: actual,
      preview_patches: structuredClone(actual),
      omitted_null_members: [],
    };
  }
  if (mergeIndexes.length !== 1) {
    throw new Error(
      `VALIDATION_PREVIEW supports exactly one reviewed offer merge, got ${mergeIndexes.length}.`,
    );
  }
  const offerContext: OfferMergePreviewContext | null =
    context === "OFFER"
      ? "FORWARD_OFFER"
      : context === "FORWARD_OFFER" || context === "ROLLBACK_INVERSE_OFFER"
        ? context
        : null;
  if (!offerContext) {
    throw new Error(
      `Non-OFFER ${context} action contains an unpreviewable merge operation.`,
    );
  }
  const mergeIndex = mergeIndexes[0];
  const actualMergePatch = actual[mergeIndex];
  const surrogate = offerMergePreviewSurrogate(actualMergePatch, offerContext);
  const preview = structuredClone(actual);
  preview[mergeIndex] = surrogate.patch;
  return {
    strategy: SELECTOR_REPLACE_SURROGATE_FOR_MERGE,
    actual_patches: actual,
    preview_patches: preview,
    actual_merge_patch: structuredClone(actualMergePatch),
    preview_surrogate_patch: structuredClone(surrogate.patch),
    omitted_null_members: surrogate.omittedNullMembers,
  };
}

/** Rebuild and compare the preview request, failing closed if a gateway caller
 * changed anything beyond merge->replace and omission of actual null deletion
 * members. */
export function assertValidationPreviewSurrogateMatches(input: {
  actualPatches: ListingPatch[];
  previewPatches: ListingPatch[];
  context: OfferMergePreviewContext;
}): ValidationPreviewPatchSet {
  const expected = buildValidationPreviewPatchSet(
    input.actualPatches,
    input.context,
  );
  if (expected.strategy !== SELECTOR_REPLACE_SURROGATE_FOR_MERGE) {
    throw new Error("Preview surrogate assertion received an exact patch set.");
  }
  if (
    stableJson(expected.preview_patches) !== stableJson(input.previewPatches)
  ) {
    throw new Error(
      "VALIDATION_PREVIEW surrogate differs from the reviewed selector-replace transformation.",
    );
  }
  return expected;
}

export function validationPreviewCheckpointDetail(
  set: ValidationPreviewPatchSet,
): UnknownRecord {
  if (set.strategy === "EXACT") {
    return {
      patch_sha256: patchDigest(set.actual_patches),
      patch_paths: set.actual_patches.map((patch) => patch.path),
    };
  }
  if (!set.actual_merge_patch || !set.preview_surrogate_patch) {
    throw new Error("Merge preview evidence is incomplete.");
  }
  return {
    strategy: SELECTOR_REPLACE_SURROGATE_FOR_MERGE,
    actual_merge_patch_sha256: sha256(stableJson(set.actual_merge_patch)),
    actual_merge_patch_path: set.actual_merge_patch.path,
    actual_merge_patch_paths: [set.actual_merge_patch.path],
    preview_surrogate_patch_sha256: sha256(
      stableJson(set.preview_surrogate_patch),
    ),
    preview_surrogate_patch_path: set.preview_surrogate_patch.path,
    preview_surrogate_patch_paths: [set.preview_surrogate_patch.path],
    actual_request_patch_sha256: patchDigest(set.actual_patches),
    actual_request_patch_paths: set.actual_patches.map((patch) => patch.path),
    preview_request_patch_sha256: patchDigest(set.preview_patches),
    preview_request_patch_paths: set.preview_patches.map((patch) => patch.path),
    omitted_null_members: set.omitted_null_members,
  };
}

export function validationPreviewGatewayContext(
  set: ValidationPreviewPatchSet,
  context: OfferMergePreviewContext,
): RepairValidationPreviewContext | undefined {
  return set.strategy === SELECTOR_REPLACE_SURROGATE_FOR_MERGE
    ? {
        strategy: SELECTOR_REPLACE_SURROGATE_FOR_MERGE,
        offer_merge_context: context,
        actual_patches: structuredClone(set.actual_patches),
      }
    : undefined;
}

/** Local projection of the canonical merge, retained for deterministic tests
 * and rollback planning. */
export function mergeCanonicalPurchasableOffer(
  existing: unknown,
  desired: DesiredOfferRepair,
): Record<string, unknown>[] {
  return applyPurchasableOfferMerge(
    existing,
    canonicalPurchasableOfferMergeValue(desired),
  );
}

function observedB2bOfferEntries(offers: unknown): UnknownRecord[] {
  if (!Array.isArray(offers)) return [];
  const bySelector = new Map<string, UnknownRecord>();
  for (const raw of offers) {
    if (!isRecord(raw)) continue;
    const audience = isRecord(raw.audience)
      ? nonEmptyString(raw.audience.value)
      : nonEmptyString(raw.audience);
    if (raw.offerType !== "B2B" && audience !== "B2B") continue;
    const price = isRecord(raw.price) ? finiteNumber(raw.price.amount) : null;
    if (price == null || price <= 0) continue;
    const marketplaceId = nonEmptyString(raw.marketplaceId) ?? MARKETPLACE_ID;
    const currency = isRecord(raw.price)
      ? nonEmptyString(raw.price.currencyCode) ??
        nonEmptyString(raw.price.currency) ??
        "USD"
      : "USD";
    const entry: UnknownRecord = {
      marketplace_id: marketplaceId,
      currency,
      audience: "B2B",
      our_price: priceSchedule(price),
    };
    bySelector.set(purchasableOfferSelectorKey(entry, true), entry);
  }
  return [...bySelector.values()];
}

/**
 * Listings Items currently omits B2B instances from `attributes` for these
 * SKUs while returning their marketplace-observed prices in top-level
 * `offers`. Combine both representations into the selector-level projection
 * used by forward/rollback CAS. When both exist, the observed offer price wins
 * while all writable attribute metadata remains intact.
 */
export function canonicalPurchasableOfferStateValue(
  live: ListingItem,
): Record<string, unknown>[] {
  const attrs = (live.attributes ?? {}) as UnknownRecord;
  const entries = purchasableOfferEntries(
    attrs.purchasable_offer,
    "Live purchasable_offer",
  );
  for (const observed of observedB2bOfferEntries(live.offers)) {
    const key = purchasableOfferSelectorKey(observed, true);
    const existing = entries.find(
      (entry) => purchasableOfferSelectorKey(entry) === key,
    );
    if (existing) existing.our_price = structuredClone(observed.our_price);
    else entries.push(observed);
  }
  return sortedPurchasableOffers(entries);
}

/** Build the inverse selector merge that transforms `after` back to `before`.
 * Only changed members are emitted; preserved quantity discounts/metadata are
 * never echoed. */
export function purchasableOfferRestoreMergeValue(
  before: unknown,
  after: unknown,
): Record<string, unknown>[] {
  const beforeEntries = purchasableOfferEntries(before, "Before purchasable_offer");
  const afterEntries = purchasableOfferEntries(after, "After purchasable_offer");
  const beforeBySelector = new Map(
    beforeEntries.map((entry) => [purchasableOfferSelectorKey(entry), entry]),
  );
  const afterBySelector = new Map(
    afterEntries.map((entry) => [purchasableOfferSelectorKey(entry), entry]),
  );
  const selectors = [...new Set([
    ...beforeBySelector.keys(),
    ...afterBySelector.keys(),
  ])].sort();
  const restore: UnknownRecord[] = [];
  for (const selectorKey of selectors) {
    const beforeEntry = beforeBySelector.get(selectorKey);
    const afterEntry = afterBySelector.get(selectorKey);
    const source = beforeEntry ?? afterEntry;
    if (!source) continue;
    const selector = purchasableOfferSelector(source, false);
    const value: UnknownRecord = { ...selector };
    const fields = new Set([
      ...Object.keys(beforeEntry ?? {}),
      ...Object.keys(afterEntry ?? {}),
    ]);
    for (const key of [...fields].sort()) {
      if ((PURCHASABLE_OFFER_SELECTORS as readonly string[]).includes(key)) {
        continue;
      }
      const beforePresent = beforeEntry != null &&
        Object.prototype.hasOwnProperty.call(beforeEntry, key);
      const afterPresent = afterEntry != null &&
        Object.prototype.hasOwnProperty.call(afterEntry, key);
      const beforeValue = beforePresent ? beforeEntry?.[key] : undefined;
      const afterValue = afterPresent ? afterEntry?.[key] : undefined;
      if (
        beforePresent === afterPresent &&
        stableJson(beforeValue) === stableJson(afterValue)
      ) {
        continue;
      }
      value[key] = beforePresent ? structuredClone(beforeValue) : null;
    }
    if (Object.keys(value).length > PURCHASABLE_OFFER_SELECTORS.length) {
      restore.push(value);
    }
  }
  if (restore.length === 0) {
    throw new Error("purchasable_offer inverse merge has no changed members.");
  }
  return restore;
}

function localizedValue(value: string): UnknownRecord {
  return {
    value,
    language_tag: "en_US",
    marketplace_id: MARKETPLACE_ID,
  };
}

function mediaValue(url: string): UnknownRecord[] {
  return [
    {
      media_location: url,
      language_tag: "en_US",
      marketplace_id: MARKETPLACE_ID,
    },
  ];
}

function firstObject(value: unknown): UnknownRecord {
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : {};
}

/**
 * Amazon Listings Items does not permit an attribute instance to be deleted by
 * path alone. A DELETE must carry the Product Type Definition selector values
 * that identify the marketplace/locale/offer instance to remove. Keep this
 * allow-list deliberately limited to attributes this repair flow can touch;
 * an unknown selector contract fails plan construction instead of emitting an
 * ambiguous delete.
 */
function deleteSelectorNames(attribute: string): string[] {
  if (
    attribute === "main_product_image_locator" ||
    /^other_product_image_locator_[1-8]$/.test(attribute) ||
    [
      "allergen_information",
      "item_package_quantity",
      "each_unit_count",
      "is_expiration_dated_product",
      "merchant_shipping_group",
      "unit_count",
      "number_of_items",
    ].includes(attribute)
  ) {
    return ["marketplace_id"];
  }
  if (
    ["ingredients", "item_name", "bullet_point", "product_description"].includes(
      attribute,
    )
  ) {
    return ["marketplace_id", "language_tag"];
  }
  if (attribute === "list_price" || attribute === "business_price") {
    return ["marketplace_id", "currency"];
  }
  if (attribute === "purchasable_offer") {
    return ["marketplace_id", "currency", "audience"];
  }
  throw new Error(
    `No reviewed Amazon delete-selector contract for /attributes/${attribute}.`,
  );
}

/** Build a selector-valued top-level attribute DELETE from the exact live (or
 * sealed expected-after) value. The returned selector objects intentionally
 * omit non-selector data such as price, image URL, and customer-facing text. */
export function buildSelectorDeletePatch(
  patchPath: string,
  attributeValue: unknown,
): ListingPatch {
  const match = /^\/attributes\/([A-Za-z0-9_]+)$/.exec(patchPath);
  if (!match) throw new Error(`Unsupported selector DELETE path: ${patchPath}.`);
  if (!Array.isArray(attributeValue) || attributeValue.length === 0) {
    throw new Error(
      `Selector DELETE ${patchPath} requires a non-empty captured attribute array.`,
    );
  }
  const selectors = deleteSelectorNames(match[1]);
  const values: UnknownRecord[] = [];
  const seen = new Set<string>();
  for (const raw of attributeValue) {
    if (!isRecord(raw)) {
      throw new Error(`Selector DELETE ${patchPath} contains a non-object value.`);
    }
    const selector: UnknownRecord = {};
    for (const name of selectors) {
      const value = raw[name];
      if (value == null || (typeof value === "string" && !value.trim())) {
        throw new Error(
          `Selector DELETE ${patchPath} is missing required selector ${name}.`,
        );
      }
      selector[name] = structuredClone(value);
    }
    const digest = stableJson(selector);
    if (!seen.has(digest)) {
      seen.add(digest);
      values.push(selector);
    }
  }
  if (values.length === 0) {
    throw new Error(`Selector DELETE ${patchPath} produced no selector values.`);
  }
  return { op: "delete", path: patchPath, value: values };
}

export function buildActionPatches(
  action: PlannedRepairAction,
  live: ListingItem,
): ListingPatch[] {
  const attrs = (live.attributes ?? {}) as UnknownRecord;
  if (action.desired.kind === "MEDIA") {
    const desired = action.desired.value;
    const patches: ListingPatch[] = [];
    if (desired.main_image_url) {
      patches.push({
        op: "replace",
        path: "/attributes/main_product_image_locator",
        value: mediaValue(desired.main_image_url),
      });
    }
    for (const item of desired.gallery_slots) {
      patches.push({
        op: "replace",
        path: `/attributes/other_product_image_locator_${item.slot}`,
        value: mediaValue(item.url),
      });
    }
    for (const slot of desired.delete_gallery_slots ?? []) {
      const attribute = `other_product_image_locator_${slot}`;
      if (attrs[attribute] != null) {
        patches.push(
          buildSelectorDeletePatch(`/attributes/${attribute}`, attrs[attribute]),
        );
      }
    }
    return patches;
  }
  if (action.desired.kind === "OFFER") {
    const desired = action.desired.value;
    const patches: ListingPatch[] = [
      {
        op: "merge",
        path: "/attributes/purchasable_offer",
        value: canonicalPurchasableOfferMergeValue(desired),
      },
    ];
    if (attrs.list_price != null) {
      patches.push(
        buildSelectorDeletePatch("/attributes/list_price", attrs.list_price),
      );
    }
    return patches;
  }
  if (action.desired.kind === "STRUCTURED_ATTRIBUTES") {
    const desired = action.desired.value;
    const patches: ListingPatch[] = [
      {
        op: "replace",
        path: "/attributes/ingredients",
        value: [localizedValue(desired.ingredients)],
      },
      {
        op: "replace",
        path: "/attributes/allergen_information",
        value: desired.allergen_information.map((value) => ({
          value,
          marketplace_id: MARKETPLACE_ID,
        })),
      },
    ];
    for (const [attribute, value] of [
      ["item_package_quantity", desired.item_package_quantity],
      ["each_unit_count", desired.each_unit_count],
    ] as const) {
      if (value == null) continue;
      const current = firstObject(attrs[attribute]);
      patches.push({
        op: "replace",
        path: `/attributes/${attribute}`,
        value: [
          {
            ...current,
            value,
            marketplace_id: MARKETPLACE_ID,
          },
        ],
      });
    }
    if (
      desired.each_unit_count_absent === true &&
      attrs.each_unit_count != null
    ) {
      patches.push(
        buildSelectorDeletePatch(
          "/attributes/each_unit_count",
          attrs.each_unit_count,
        ),
      );
    }
    if (desired.is_expiration_dated_product === true) {
      const current = firstObject(attrs.is_expiration_dated_product);
      patches.push({
        op: "replace",
        path: "/attributes/is_expiration_dated_product",
        value: [
          {
            ...current,
            value: true,
            marketplace_id: MARKETPLACE_ID,
          },
        ],
      });
    }
    if (desired.merchant_shipping_group != null) {
      const current = firstObject(attrs.merchant_shipping_group);
      patches.push({
        op: "replace",
        path: "/attributes/merchant_shipping_group",
        value: [
          {
            ...current,
            value: desired.merchant_shipping_group,
            marketplace_id: MARKETPLACE_ID,
          },
        ],
      });
    }
    return patches;
  }

  const desired = action.desired.value;
  const patches: ListingPatch[] = [];
  if (desired.title != null) {
    patches.push({
      op: "replace",
      path: "/attributes/item_name",
      value: [localizedValue(desired.title)],
    });
  }
  if (desired.bullets != null) {
    patches.push({
      op: "replace",
      path: "/attributes/bullet_point",
      value: desired.bullets.map(localizedValue),
    });
  }
  if (desired.description != null) {
    patches.push({
      op: "replace",
      path: "/attributes/product_description",
      value: [localizedValue(desired.description)],
    });
  }
  if (desired.unit_count != null) {
    const current = firstObject(attrs.unit_count);
    const currentType = isRecord(current.type) ? current.type : {};
    const unitType = desired.unit_count_type ?? nonEmptyString(currentType.value) ?? "Count";
    patches.push({
      op: "replace",
      path: "/attributes/unit_count",
      value: [
        {
          ...current,
          type: {
            ...currentType,
            value: unitType,
            language_tag: nonEmptyString(currentType.language_tag) ?? "en_US",
          },
          value: desired.unit_count,
          marketplace_id: MARKETPLACE_ID,
        },
      ],
    });
  }
  if (desired.number_of_items != null) {
    const current = firstObject(attrs.number_of_items);
    patches.push({
      op: "replace",
      path: "/attributes/number_of_items",
      value: [
        {
          ...current,
          value: desired.number_of_items,
          marketplace_id: MARKETPLACE_ID,
        },
      ],
    });
  }
  return patches;
}

function summaryFor(live: ListingItem) {
  return (
    live.summaries?.find((item) => item.marketplaceId === MARKETPLACE_ID) ??
    live.summaries?.[0]
  );
}

function mediaUrl(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const item = value.find(
    (entry) => isRecord(entry) && entry.marketplace_id === MARKETPLACE_ID,
  ) ?? value[0];
  return isRecord(item) ? nonEmptyString(item.media_location) : null;
}

function attrString(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const item = value.find(
    (entry) => isRecord(entry) && entry.marketplace_id === MARKETPLACE_ID,
  ) ?? value[0];
  return isRecord(item) ? nonEmptyString(item.value) : null;
}

function attrStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter(
      (item) =>
        item.marketplace_id == null || item.marketplace_id === MARKETPLACE_ID,
    )
    .map((item) => nonEmptyString(item.value))
    .filter((item): item is string => item != null);
}

function attrNumber(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const item = value.find(
    (entry) => isRecord(entry) && entry.marketplace_id === MARKETPLACE_ID,
  ) ?? value[0];
  return isRecord(item) ? finiteNumber(item.value) : null;
}

function attrBoolean(value: unknown): boolean | null {
  if (!Array.isArray(value)) return null;
  const item = value.find(
    (entry) => isRecord(entry) && entry.marketplace_id === MARKETPLACE_ID,
  ) ?? value[0];
  if (!isRecord(item)) return null;
  return typeof item.value === "boolean" ? item.value : null;
}

function unitCountType(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const item = value.find(
    (entry) => isRecord(entry) && entry.marketplace_id === MARKETPLACE_ID,
  ) ?? value[0];
  if (!isRecord(item) || !isRecord(item.type)) return null;
  return nonEmptyString(item.type.value);
}

export interface MediaEquivalence {
  equivalent(expectedUrl: string, actualUrl: string): Promise<boolean>;
}

const exactMediaEquivalence: MediaEquivalence = {
  equivalent: async (expected, actual) => expected === actual,
};

export interface VerificationResult {
  ok: boolean;
  checks: Array<{ field: string; ok: boolean; expected: unknown; actual: unknown }>;
}

const OFFER_PRICE_CHECK_KEYS = [
  ["purchasable_offer.our_price", "attribute_consumer_price"],
  ["offers.B2C.price", "top_level_consumer_price"],
  ["business_price", "business_price"],
  [
    "purchasable_offer.minimum_seller_allowed_price",
    "minimum_seller_allowed_price",
  ],
  [
    "purchasable_offer.maximum_seller_allowed_price",
    "maximum_seller_allowed_price",
  ],
  ["purchasable_offer.discounted_price", "discounted_price"],
  ["list_price", "list_price"],
] as const;

type OfferPriceValueKey = (typeof OFFER_PRICE_CHECK_KEYS)[number][1];

function safeObservedOfferPrice(field: string, actual: unknown): number | null {
  if (typeof actual === "number" && Number.isFinite(actual) && actual > 0) {
    return actual;
  }
  if (
    field === "purchasable_offer.discounted_price" &&
    isRecord(actual)
  ) {
    const value = finiteNumber(actual.value_with_tax);
    return value != null && value > 0 ? value : null;
  }
  if (field === "list_price" && Array.isArray(actual)) {
    const rows = actual.filter(
      (row) =>
        isRecord(row) &&
        row.marketplace_id === MARKETPLACE_ID &&
        row.currency === "USD",
    );
    if (rows.length !== 1 || !isRecord(rows[0])) return null;
    const value = finiteNumber(rows[0].value);
    return value != null && value > 0 ? value : null;
  }
  return null;
}

/** Persist only allowlisted price scalars and check names. In-memory verifier
 * diagnostics can contain selector rows, but an unresolved checkpoint must
 * never become a copy of Amazon's raw listing payload. */
function safeOfferPriceSettlementDiagnostics(
  action: PlannedRepairAction,
  verification: VerificationResult | null,
): UnknownRecord {
  if (action.desired.kind !== "OFFER") {
    throw new Error(
      `Offer price diagnostics require an OFFER action, got ${action.kind}.`,
    );
  }
  const desired = action.desired.value;
  const desiredPriceValues: Record<OfferPriceValueKey, number | null> = {
    attribute_consumer_price: desired.consumer_price,
    top_level_consumer_price: desired.consumer_price,
    business_price: desired.business_price,
    minimum_seller_allowed_price: desired.minimum_seller_allowed_price,
    maximum_seller_allowed_price: desired.maximum_seller_allowed_price,
    discounted_price: desired.discounted_price_absent
      ? null
      : desired.discounted_price_schedule?.value_with_tax ?? null,
    list_price: null,
  };
  if (!verification) {
    return {
      failed_check_names: [],
      desired_price_values: desiredPriceValues,
      actual_price_values: null,
    };
  }
  const checksByField = new Map(
    verification.checks.map((check) => [check.field, check] as const),
  );
  const actualPriceValues = Object.fromEntries(
    OFFER_PRICE_CHECK_KEYS.map(([field, key]) => [
      key,
      safeObservedOfferPrice(field, checksByField.get(field)?.actual ?? null),
    ]),
  ) as Record<OfferPriceValueKey, number | null>;
  const allowlistedFields = new Set<string>(
    OFFER_PRICE_CHECK_KEYS.map(([field]) => field),
  );
  return {
    failed_check_names: verification.checks
      .filter((check) => !check.ok && allowlistedFields.has(check.field))
      .map((check) => check.field),
    desired_price_values: desiredPriceValues,
    actual_price_values: actualPriceValues,
  };
}

export async function verifyActionState(
  action: PlannedRepairAction,
  live: ListingItem,
  mediaEquivalence: MediaEquivalence = exactMediaEquivalence,
): Promise<VerificationResult> {
  const attrs = (live.attributes ?? {}) as UnknownRecord;
  const checks: VerificationResult["checks"] = [];
  if (action.desired.kind === "MEDIA") {
    const desired = action.desired.value;
    const compare = async (field: string, expected: string, actual: string | null) => {
      const ok = actual != null && (expected === actual || await mediaEquivalence.equivalent(expected, actual));
      checks.push({ field, ok, expected, actual });
    };
    if (desired.main_image_url) {
      // Amazon can accept a source locator, rehost it, and expose the new
      // asset in summaries before (or instead of) echoing that locator back in
      // attributes. The summary MAIN is the buyer-facing truth. Prefer it
      // whenever present; fall back to the seller attribute only when Amazon
      // omits the summary image entirely. This also prevents us from replacing
      // a MAIN that is already correct for buyers merely because the authoring
      // locator is stale.
      const buyerMain = nonEmptyString(summaryFor(live)?.mainImage?.link);
      await compare(
        buyerMain == null
          ? "main_product_image_locator"
          : "main_product_image_buyer_summary",
        desired.main_image_url,
        buyerMain ?? mediaUrl(attrs.main_product_image_locator),
      );
    }
    for (const item of desired.gallery_slots) {
      await compare(
        `other_product_image_locator_${item.slot}`,
        item.url,
        mediaUrl(attrs[`other_product_image_locator_${item.slot}`]),
      );
    }
    for (const slot of desired.delete_gallery_slots ?? []) {
      const actual = mediaUrl(attrs[`other_product_image_locator_${slot}`]);
      checks.push({
        field: `other_product_image_locator_${slot}`,
        ok: actual == null,
        expected: null,
        actual,
      });
    }
  } else if (action.desired.kind === "OFFER") {
    const desired = action.desired.value;
    const consumer = observeExactAttributeSelector(
      attrs.purchasable_offer,
      "ALL",
    );
    const ourPrice = observeExactScheduledMoney(consumer, "our_price");
    const topLevelConsumer = observeExactTopLevelConsumerPrice(live.offers);
    const business = observeExactBusinessPrice(
      live.offers,
      attrs.purchasable_offer,
    );
    const minimum = observeExactScheduledMoney(
      consumer,
      "minimum_seller_allowed_price",
    );
    const maximum = observeExactScheduledMoney(
      consumer,
      "maximum_seller_allowed_price",
    );
    const values = [
      ["purchasable_offer.our_price", desired.consumer_price, ourPrice],
      ["business_price", desired.business_price, business],
      ["purchasable_offer.minimum_seller_allowed_price", desired.minimum_seller_allowed_price, minimum],
      ["purchasable_offer.maximum_seller_allowed_price", desired.maximum_seller_allowed_price, maximum],
    ] as const;
    for (const [field, expected, observation] of values) {
      checks.push({
        field,
        ok: !differs(observation.value, expected),
        expected,
        actual: observation.diagnostic,
      });
    }
    if (topLevelConsumer != null) {
      checks.splice(1, 0, {
        field: "offers.B2C.price",
        ok: !differs(topLevelConsumer.value, desired.consumer_price),
        expected: desired.consumer_price,
        actual: topLevelConsumer.diagnostic,
      });
    }
    const actualSalePrice = observeSalePrice(attrs.purchasable_offer);
    checks.push({
      field: "purchasable_offer.discounted_price",
      ok: salePriceMatches(actualSalePrice, desired),
      expected: desired.discounted_price_absent
        ? null
        : desired.discounted_price_schedule ?? null,
      actual: actualSalePrice.diagnostic,
    });
    checks.push({
      field: "list_price",
      ok: attrs.list_price == null,
      expected: null,
      actual: attrs.list_price ?? null,
    });
  } else if (action.desired.kind === "STRUCTURED_ATTRIBUTES") {
    const desired = action.desired.value;
    const ingredients = attrString(attrs.ingredients);
    checks.push({
      field: "ingredients",
      ok:
        ingredients === desired.ingredients &&
        (ingredients == null ? null : sha256(ingredients)) ===
          desired.ingredients_sha256,
      expected: desired.ingredients,
      actual: ingredients,
    });
    const actualAllergens = attrStrings(attrs.allergen_information).sort();
    const expectedAllergens = [...desired.allergen_information].sort();
    checks.push({
      field: "allergen_information",
      ok: stableJson(actualAllergens) === stableJson(expectedAllergens),
      expected: expectedAllergens,
      actual: actualAllergens,
    });
    for (const [attribute, expected] of [
      ["item_package_quantity", desired.item_package_quantity],
      ["each_unit_count", desired.each_unit_count],
    ] as const) {
      if (expected == null) continue;
      const actual = attrNumber(attrs[attribute]);
      checks.push({
        field: attribute,
        ok: actual === expected,
        expected,
        actual,
      });
    }
    if (desired.each_unit_count_absent === true) {
      checks.push({
        field: "each_unit_count",
        ok: attrs.each_unit_count == null,
        expected: null,
        actual: attrs.each_unit_count ?? null,
      });
    }
    if (desired.is_expiration_dated_product === true) {
      const actual = attrBoolean(attrs.is_expiration_dated_product);
      checks.push({
        field: "is_expiration_dated_product",
        ok: actual === true,
        expected: true,
        actual,
      });
    }
    if (desired.merchant_shipping_group != null) {
      const actual = attrString(attrs.merchant_shipping_group);
      checks.push({
        field: "merchant_shipping_group",
        ok: actual === desired.merchant_shipping_group,
        expected: desired.merchant_shipping_group,
        actual,
      });
    }
  } else {
    const desired = action.desired.value;
    if (desired.title != null) {
      const actual = attrString(attrs.item_name) ?? summaryFor(live)?.itemName ?? null;
      checks.push({ field: "item_name", ok: actual === desired.title, expected: desired.title, actual });
    }
    if (desired.bullets != null) {
      const actual = attrStrings(attrs.bullet_point);
      checks.push({ field: "bullet_point", ok: stableJson(actual) === stableJson(desired.bullets), expected: desired.bullets, actual });
    }
    if (desired.description != null) {
      const actual = attrString(attrs.product_description);
      checks.push({ field: "product_description", ok: actual === desired.description, expected: desired.description, actual });
    }
    if (desired.unit_count != null) {
      const actual = attrNumber(attrs.unit_count);
      checks.push({ field: "unit_count", ok: actual === desired.unit_count, expected: desired.unit_count, actual });
    }
    if (desired.unit_count_type != null) {
      const actual = unitCountType(attrs.unit_count);
      checks.push({ field: "unit_count.type", ok: actual === desired.unit_count_type, expected: desired.unit_count_type, actual });
    }
    if (desired.number_of_items != null) {
      const actual = attrNumber(attrs.number_of_items);
      checks.push({ field: "number_of_items", ok: actual === desired.number_of_items, expected: desired.number_of_items, actual });
    }
    if (desired.expected_product_type != null) {
      const actual = summaryFor(live)?.productType ?? null;
      checks.push({ field: "product_type", ok: actual === desired.expected_product_type, expected: desired.expected_product_type, actual });
    }
    for (const code of desired.must_clear_issue_codes ?? []) {
      const present = (live.issues ?? []).some((issue) => String(issue.code ?? "") === code);
      checks.push({ field: `issue.${code}`, ok: !present, expected: "absent", actual: present ? "present" : "absent" });
    }
  }
  return { ok: checks.length > 0 && checks.every((check) => check.ok), checks };
}

export interface PhysicalMutationContext {
  store_index: number;
  marketplace_id: string;
  amazon_merchant_id: string;
}

export interface RepairAmazonGateway {
  /** The concrete transport invokes the supplied synchronous guard only after
   * all async preflight work and immediately before a real marketplace write. */
  physicalMutationGuardContract?: "CALL_IMMEDIATELY_BEFORE_REQUEST_V1";
  getListing(
    storeIndex: number,
    sku: string,
    signal?: AbortSignal,
  ): Promise<ListingItem>;
  patchListing(
    storeIndex: number,
    sku: string,
    productType: string,
    patches: ListingPatch[],
    validationPreview: boolean,
    previewContext?: RepairValidationPreviewContext,
    beforeMutatingRequest?: (context: PhysicalMutationContext) => void,
  ): Promise<UnknownRecord>;
}

export const EXACT_PATH_SETTLEMENT_GUARD =
  "EXACT_ACTION_PATHS_V1" as const;

interface ExactPathSettlementEvidence {
  schema_version: typeof EXACT_PATH_SETTLEMENT_GUARD;
  actual_patch_sha256: string;
  exact_action_paths: string[];
  before_path_state_sha256: string;
}

interface SettlementObservation {
  classification: "DESIRED" | "BEFORE" | "NON_DESIRED";
  path_state_sha256: string;
  verification: VerificationResult;
}

interface SettlementPollingOutcome {
  state: "DESIRED" | "STABLE_BEFORE" | "STABLE_NON_DESIRED" | "UNRESOLVED";
  attempts: number;
  consecutive_stable_reads: number;
  last: SettlementObservation | null;
}

function exactAttributePath(pathValue: string): string {
  const match = /^\/attributes\/([A-Za-z0-9_]+)$/.exec(pathValue);
  if (!match) {
    throw new Error(`Settlement guard received unsupported action path ${pathValue}.`);
  }
  return match[1];
}

function exactActionPathStateSha256(
  live: ListingItem,
  paths: readonly string[],
): string {
  const attrs = isRecord(live.attributes) ? live.attributes : {};
  const states = [...new Set(paths)].sort().map((patchPath) => {
    const attribute = exactAttributePath(patchPath);
    const present = attribute === "purchasable_offer"
      ? canonicalPurchasableOfferStateValue(live).length > 0
      : Object.prototype.hasOwnProperty.call(attrs, attribute);
    const value = attribute === "purchasable_offer"
      ? canonicalPurchasableOfferStateValue(live)
      : present
        ? attrs[attribute]
        : null;
    return {
      path: patchPath,
      present,
      value_sha256: sha256(stableJson(value)),
    };
  });
  return sha256(stableJson(states));
}

function settlementEvidence(
  live: ListingItem,
  patches: readonly ListingPatch[],
): ExactPathSettlementEvidence {
  const exactActionPaths = [...new Set(patches.map((patch) => patch.path))].sort();
  if (exactActionPaths.length === 0) {
    throw new Error("Settlement guard cannot seal an empty PATCH.");
  }
  return {
    schema_version: EXACT_PATH_SETTLEMENT_GUARD,
    actual_patch_sha256: patchDigest([...patches]),
    exact_action_paths: exactActionPaths,
    before_path_state_sha256: exactActionPathStateSha256(
      live,
      exactActionPaths,
    ),
  };
}

function parseSettlementEvidence(
  pending: PendingRepairSubmission,
): ExactPathSettlementEvidence {
  const raw = pending.detail.settlement_guard;
  if (!isRecord(raw)) {
    throw new Error(
      `Pending Amazon submission ${pending.action_id} has no exact-path settlement evidence.`,
    );
  }
  const rawPaths = raw.exact_action_paths;
  const paths = Array.isArray(rawPaths) &&
      rawPaths.every(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    ? rawPaths
    : [];
  for (const patchPath of paths) exactAttributePath(patchPath);
  if (
    raw.schema_version !== EXACT_PATH_SETTLEMENT_GUARD ||
    paths.length === 0 ||
    new Set(paths).size !== paths.length ||
    !/^[a-f0-9]{64}$/.test(String(raw.actual_patch_sha256 ?? "")) ||
    !/^[a-f0-9]{64}$/.test(String(raw.before_path_state_sha256 ?? ""))
  ) {
    throw new Error(
      `Pending Amazon submission ${pending.action_id} has invalid exact-path settlement evidence.`,
    );
  }
  return {
    schema_version: EXACT_PATH_SETTLEMENT_GUARD,
    actual_patch_sha256: String(raw.actual_patch_sha256),
    exact_action_paths: [...paths].sort(),
    before_path_state_sha256: String(raw.before_path_state_sha256),
  };
}

async function pollActionSettlement(input: {
  entry: RepairPlanEntry;
  action: PlannedRepairAction;
  gateway: RepairAmazonGateway;
  mediaEquivalence: MediaEquivalence;
  evidence: ExactPathSettlementEvidence;
  attempts: number;
  delayMs: number;
  stableReads: number;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<SettlementPollingOutcome> {
  let consecutive = 0;
  let previousKey: string | null = null;
  let last: SettlementObservation | null = null;
  for (let attempt = 1; attempt <= input.attempts; attempt++) {
    await input.sleep(input.delayMs);
    const live = await input.gateway.getListing(
      input.entry.store_index,
      input.entry.sku,
    );
    listingIdentity(input.entry, live);
    const verification = await verifyActionState(
      input.action,
      live,
      input.mediaEquivalence,
    );
    const pathStateSha256 = exactActionPathStateSha256(
      live,
      input.evidence.exact_action_paths,
    );
    const classification = verification.ok
      ? "DESIRED"
      : pathStateSha256 === input.evidence.before_path_state_sha256
        ? "BEFORE"
        : "NON_DESIRED";
    last = {
      classification,
      path_state_sha256: pathStateSha256,
      verification,
    };
    const key = `${classification}:${pathStateSha256}`;
    consecutive = key === previousKey ? consecutive + 1 : 1;
    previousKey = key;
    if (classification === "DESIRED" && consecutive >= input.stableReads) {
      return {
        state: "DESIRED",
        attempts: attempt,
        consecutive_stable_reads: consecutive,
        last,
      };
    }
  }
  if (last && consecutive >= input.stableReads) {
    return {
      state: last.classification === "BEFORE"
        ? "STABLE_BEFORE"
        : "STABLE_NON_DESIRED",
      attempts: input.attempts,
      consecutive_stable_reads: consecutive,
      last,
    };
  }
  return {
    state: "UNRESOLVED",
    attempts: input.attempts,
    consecutive_stable_reads: consecutive,
    last,
  };
}

export interface ExecuteRepairOptions {
  apply: boolean;
  /** Legacy mode submits and waits inline. OFFER and exact MAIN-media
   * production rollouts may use explicit two-phase modes so a delayed Amazon
   * projection can never authorize a second PATCH after a process restart. */
  executionPhase?: OfferExecutionPhase;
  /** Dedicated exact-selection recovery for any already-pending action kind.
   * It is GET-only and cannot be combined with apply/preview/OFFER phases. */
  recoverPendingOnly?: boolean;
  validationOnly?: boolean;
  confirmation?: string | null;
  checkpointStore: ImmutableCheckpointStore;
  mediaEquivalence?: MediaEquivalence;
  /** Immutable, plan-bound positive action selection. Runtime SKU/limit
   * narrowing is forbidden when this artifact is supplied. */
  executionSelection?: RepairExecutionSelection | null;
  /** Short-lived, exact plan/selection-bound proof that every active SKU is
   * parked in ChannelMAX Manual with skip rules enabled and every Arm A coupon
   * is SCHEDULED before the synchronized start. Required for launch-aware
   * OFFER writes only. */
  launchExecutionAuthorization?:
    | LaunchExecutionAuthorizationRuntimeInput
    | null;
  skus?: string[] | null;
  limit?: number | null;
  requestDelayMs?: number;
  verifyAttempts?: number;
  verifyDelayMs?: number;
  /** Extended bounded polling after an accepted write is not promptly stable. */
  settlementAttempts?: number;
  settlementDelayMs?: number;
  settlementStableReads?: number;
  offerSettlementPolicy?: OfferSettlementPolicyInput;
  pendingRecoveryPolicy?: OfferSettlementPolicyInput;
  maxErrors?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface ExecuteRepairResult {
  mode:
    | "DRY_RUN"
    | "VALIDATION_PREVIEW"
    | "APPLY"
    | "OFFER_SUBMIT_ONLY"
    | "MEDIA_SUBMIT_ONLY"
    | "OFFER_SETTLE_ONLY"
    | "PENDING_SETTLE_ONLY";
  selection_sha256: string | null;
  selected_entries: number;
  selected_actions: number;
  quarantined_pending_actions: number;
  resumed_actions: number;
  verified_actions: number;
  already_applied_actions: number;
  preview_valid_actions: number;
  submitted_actions: number;
  failed_actions: number;
  recovered_pending_actions: number;
  unresolved_settlements: number;
  stopped_early: boolean;
}

function guardRepairGatewayPatchPaths(
  gateway: RepairAmazonGateway,
  forbiddenPatchPaths: readonly string[],
): RepairAmazonGateway {
  if (forbiddenPatchPaths.length === 0) return gateway;
  const forbidden = new Set(forbiddenPatchPaths);
  return {
    physicalMutationGuardContract: gateway.physicalMutationGuardContract,
    getListing: (storeIndex, sku, signal) =>
      gateway.getListing(storeIndex, sku, signal),
    patchListing: (
      storeIndex,
      sku,
      productType,
      patches,
      validationPreview,
      previewContext,
      beforeMutatingRequest,
    ) => {
      const inspectedPatches = [
        ...patches,
        ...(previewContext?.actual_patches ?? []),
      ];
      const blocked = inspectedPatches
        .map((patch) => patch.path)
        .filter((patchPath) => forbidden.has(patchPath));
      if (blocked.length > 0) {
        throw new SettlementGuardError(
          `Execution selection forbids ${[...new Set(blocked)].sort().join(", ")} for ${sku}; no Amazon call was made.`,
        );
      }
      return gateway.patchListing(
        storeIndex,
        sku,
        productType,
        patches,
        validationPreview,
        previewContext,
        beforeMutatingRequest,
      );
    },
  };
}

/** Bind every selected gateway call to the conservative path set of its exact
 * sealed plan action. This is deliberately stronger than the profile-level
 * blacklist: a future patch-builder regression cannot smuggle another
 * selected action's attribute (or a preview-surrogate actual payload) through
 * the same SKU invocation. */
function guardRepairGatewayActionPatchPaths(
  gateway: RepairAmazonGateway,
  entry: RepairPlanEntry,
  action: PlannedRepairAction,
): RepairAmazonGateway {
  const allowed = new Set(potentialActionPatchPaths(action));
  return {
    physicalMutationGuardContract: gateway.physicalMutationGuardContract,
    getListing: (storeIndex, sku, signal) =>
      gateway.getListing(storeIndex, sku, signal),
    patchListing: (
      storeIndex,
      sku,
      productType,
      patches,
      validationPreview,
      previewContext,
      beforeMutatingRequest,
    ) => {
      if (storeIndex !== entry.store_index || sku !== entry.sku) {
        throw new SettlementGuardError(
          `Selected action ${action.action_id} was invoked for unexpected listing ${storeIndex}:${sku}; no Amazon call was made.`,
        );
      }
      const inspectedPatches = [
        ...patches,
        ...(previewContext?.actual_patches ?? []),
      ];
      const blocked = inspectedPatches
        .map((patch) => patch.path)
        .filter((patchPath) => !allowed.has(patchPath));
      if (blocked.length > 0) {
        throw new SettlementGuardError(
          `Selected action ${action.action_id} contains path(s) outside its sealed boundary: ${[
            ...new Set(blocked),
          ].sort().join(", ")}; no Amazon call was made.`,
        );
      }
      return gateway.patchListing(
        storeIndex,
        sku,
        productType,
        patches,
        validationPreview,
        previewContext,
        beforeMutatingRequest,
      );
    },
  };
}

/** Defense in depth for every read-only settlement mode. Its adapter has no
 * write capability, and
 * this gateway trap independently rejects both validation previews and real
 * PATCHes if future control-flow changes accidentally reach a mutating path. */
function guardRepairGatewayReadOnly(
  gateway: RepairAmazonGateway,
): RepairAmazonGateway {
  return {
    getListing: (storeIndex, sku, signal) =>
      gateway.getListing(storeIndex, sku, signal),
    patchListing: (_storeIndex, sku) => {
      throw new SettlementGuardError(
        `Read-only settlement forbids every PATCH for ${sku}; no Amazon PATCH was made.`,
      );
    },
  };
}

function responseDetail(response: UnknownRecord): UnknownRecord {
  return {
    status: response.status ?? null,
    submission_id: response.submissionId ?? null,
    issues: Array.isArray(response.issues) ? response.issues : [],
  };
}

/** Amazon can return status=VALID while warning that a submitted attribute was
 * ignored. Treat that specific warning as blocking; accepting it would record
 * a preview as successful even though the desired state cannot be reached. */
export function hasBlockingIssues(response: UnknownRecord): boolean {
  return Array.isArray(response.issues) && response.issues.some(
    (issue) =>
      isRecord(issue) &&
      (String(issue.severity ?? "").toUpperCase() === "ERROR" ||
        String(issue.code ?? "").trim() === "90000900"),
  );
}

function listingIdentity(entry: RepairPlanEntry, live: ListingItem): string {
  const summary = summaryFor(live);
  if (!summary?.asin || summary.asin !== entry.asin) {
    throw new Error(
      `ASIN precondition failed for ${entry.sku}: expected ${entry.asin}, got ${summary?.asin ?? "missing"}.`,
    );
  }
  const productType = nonEmptyString(summary.productType);
  if (!productType) throw new Error(`Live productType missing for ${entry.sku}.`);
  return productType;
}

/** Settlement is scoped to Amazon US. Remove every attribute/summarization
 * row that is not explicitly bound to that marketplace before evaluating a
 * terminal DESIRED state; a first-row fallback from another marketplace must
 * never close a US submission. Top-level offers are retained because the
 * Listings Items GET itself is marketplace-scoped and those rows do not carry
 * a marketplace selector. */
function exactMarketplaceListing(live: ListingItem): ListingItem {
  const attributes = Object.fromEntries(
    Object.entries((live.attributes ?? {}) as UnknownRecord).map(
      ([attribute, value]) => [
        attribute,
        Array.isArray(value)
          ? value.filter(
              (item) =>
                isRecord(item) && item.marketplace_id === MARKETPLACE_ID,
            )
          : value,
      ],
    ),
  );
  return {
    ...live,
    summaries: live.summaries?.filter(
      (summary) => summary.marketplaceId === MARKETPLACE_ID,
    ),
    attributes,
  };
}

function patchDigest(patches: ListingPatch[]): string {
  return sha256(stableJson(patches));
}

function requestedProductType(
  action: PlannedRepairAction,
  liveProductType: string,
): string {
  return action.desired.kind === "TEXT_COUNT" &&
    nonEmptyString(action.desired.value.request_product_type)
    ? action.desired.value.request_product_type as string
    : liveProductType;
}

class PostGetVerificationError extends Error {
  readonly verification: VerificationResult | null;

  constructor(message: string, verification: VerificationResult | null) {
    super(message);
    this.name = "PostGetVerificationError";
    this.verification = verification;
  }
}

class SettlementGuardError extends Error {
  readonly hardStop = true;

  constructor(message: string) {
    super(message);
    this.name = "SettlementGuardError";
  }
}

function fallbackAction(
  action: PlannedRepairAction,
): PlannedRepairAction | null {
  if (action.desired.kind !== "TEXT_COUNT" || !action.desired.value.fallback) {
    return null;
  }
  const fallback = action.desired.value.fallback;
  return {
    ...action,
    reasons: [...action.reasons, "REVIEWED_PRODUCT_TYPE_FALLBACK"],
    desired: {
      kind: "TEXT_COUNT",
      value: {
        unit_count: fallback.unit_count,
        unit_count_type: fallback.unit_count_type,
        number_of_items: fallback.number_of_items,
        request_product_type: fallback.request_product_type,
        expected_product_type: fallback.expected_product_type,
        must_clear_issue_codes: fallback.must_clear_issue_codes,
      },
    },
  };
}

export interface PendingRepairSettlementOutcome {
  action_id: string;
  sku: string;
  strategy: "PRIMARY" | "REVIEWED_FALLBACK";
  state: SettlementPollingOutcome["state"];
  verification: VerificationResult | null;
}

function potentialActionPatchPaths(
  action: PlannedRepairAction,
): string[] {
  const paths = new Set<string>();
  if (action.desired.kind === "OFFER") {
    paths.add("/attributes/purchasable_offer");
    // list_price is conditional on live state, so it must still be included in
    // the conservative preflight path set.
    paths.add("/attributes/list_price");
  } else if (action.desired.kind === "MEDIA") {
    const desired = action.desired.value;
    if (desired.main_image_url) {
      paths.add("/attributes/main_product_image_locator");
    }
    for (const item of desired.gallery_slots) {
      paths.add(`/attributes/other_product_image_locator_${item.slot}`);
    }
    for (const slot of desired.delete_gallery_slots ?? []) {
      paths.add(`/attributes/other_product_image_locator_${slot}`);
    }
  } else if (action.desired.kind === "STRUCTURED_ATTRIBUTES") {
    const desired = action.desired.value;
    paths.add("/attributes/ingredients");
    paths.add("/attributes/allergen_information");
    if (desired.item_package_quantity != null) {
      paths.add("/attributes/item_package_quantity");
    }
    if (
      desired.each_unit_count != null ||
      desired.each_unit_count_absent === true
    ) {
      paths.add("/attributes/each_unit_count");
    }
    if (desired.is_expiration_dated_product === true) {
      paths.add("/attributes/is_expiration_dated_product");
    }
    if (desired.merchant_shipping_group != null) {
      paths.add("/attributes/merchant_shipping_group");
    }
  } else {
    const desired = action.desired.value;
    if (desired.title != null) paths.add("/attributes/item_name");
    if (desired.bullets != null) paths.add("/attributes/bullet_point");
    if (desired.description != null) {
      paths.add("/attributes/product_description");
    }
    if (desired.unit_count != null) paths.add("/attributes/unit_count");
    if (desired.number_of_items != null) {
      paths.add("/attributes/number_of_items");
    }
    const fallback = fallbackAction(action);
    if (fallback) {
      for (const fallbackPath of potentialActionPatchPaths(fallback)) {
        paths.add(fallbackPath);
      }
    }
  }
  return [...paths].sort();
}

function scopedPatchPathKey(
  storeIndex: number,
  sku: string,
  patchPath: string,
): string {
  return stableJson([storeIndex, sku, patchPath]);
}

export interface QuarantinedPendingRepairSubmission {
  action_id: string;
  sku: string;
  submitted_event_id: string;
  exact_action_paths: string[];
}

/** Authorize a disjoint same-plan resume without pretending that an
 * unselected accepted write has settled. This function is filesystem-only:
 * every guard is evaluated before the executor is allowed to make an Amazon
 * GET, preview, or PATCH. PENDING_QUARANTINED is evidence, not a closing
 * status, so the global mutation fence deliberately remains in place. */
export async function quarantineUnselectedPendingRepairSubmissions(input: {
  plan: UncrustablesRepairPlan;
  selection: RepairExecutionSelection;
  checkpointStore: ImmutableCheckpointStore;
}): Promise<QuarantinedPendingRepairSubmission[]> {
  verifyRepairExecutionSelection(input.plan, input.selection);
  const selectedActionIds = new Set(input.selection.selected_action_ids);
  const plannedByActionId = new Map(
    input.plan.entries.flatMap((entry) =>
      entry.actions.map(
        (action) => [action.action_id, { entry, action }] as const,
      ),
    ),
  );
  const selectedPathKeys = new Set<string>();
  for (const actionId of selectedActionIds) {
    const planned = plannedByActionId.get(actionId);
    if (!planned) {
      throw new SettlementGuardError(
        `Selected action ${actionId} is absent from the sealed repair plan.`,
      );
    }
    for (const patchPath of potentialActionPatchPaths(planned.action)) {
      selectedPathKeys.add(
        scopedPatchPathKey(
          planned.entry.store_index,
          planned.entry.sku,
          patchPath,
        ),
      );
    }
  }

  const quarantined: QuarantinedPendingRepairSubmission[] = [];
  const pending = await input.checkpointStore.pendingSubmissions();
  for (const submission of [...pending.values()].sort((left, right) =>
    left.action_id.localeCompare(right.action_id)
  )) {
    if (selectedActionIds.has(submission.action_id)) continue;
    const planned = plannedByActionId.get(submission.action_id);
    const quarantinableKinds =
      input.selection.profile === CONTENT_STRUCTURED_MEDIA_ONLY_PROFILE ||
      input.selection.profile === GALLERY_MEDIA_ONLY_PROFILE
        ? new Set<RepairActionKind>(["OFFER"])
        : input.selection.profile === TEXT_STRUCTURED_ONLY_PROFILE
          ? new Set<RepairActionKind>(["MEDIA", "OFFER"])
          : null;
    const expectedSubmissionStrategy = submission.kind === "OFFER"
      ? SELECTOR_REPLACE_SURROGATE_FOR_MERGE
      : submission.kind === "MEDIA"
        ? "PRIMARY"
        : null;
    if (
      !quarantinableKinds ||
      !planned ||
      planned.entry.sku !== submission.sku ||
      planned.action.kind !== submission.kind ||
      !quarantinableKinds.has(submission.kind) ||
      expectedSubmissionStrategy == null ||
      submission.detail.strategy !== expectedSubmissionStrategy
    ) {
      throw new SettlementGuardError(
        `Unselected pending submission ${submission.action_id} is not an exact same-plan OFFER/MEDIA action with its documented strategy eligible for ${input.selection.profile} quarantine.`,
      );
    }

    let evidence: ExactPathSettlementEvidence;
    try {
      evidence = parseSettlementEvidence(submission);
    } catch (error) {
      throw new SettlementGuardError(
        error instanceof Error ? error.message : String(error),
      );
    }
    const allowedBoundaryPaths = new Set<string>(
      submission.kind === "OFFER" ? OFFER_PATCH_PATHS : MEDIA_PATCH_PATHS,
    );
    const plannedPaths = new Set(potentialActionPatchPaths(planned.action));
    if (
      evidence.exact_action_paths.some(
        (patchPath) =>
          !allowedBoundaryPaths.has(patchPath) || !plannedPaths.has(patchPath),
      )
    ) {
      throw new SettlementGuardError(
        `Pending ${submission.kind} ${submission.action_id} contains a path outside its sealed action boundary.`,
      );
    }
    const recordedPatchSha =
      typeof submission.detail.actual_request_patch_sha256 === "string"
        ? submission.detail.actual_request_patch_sha256
        : typeof submission.detail.patch_sha256 === "string"
          ? submission.detail.patch_sha256
          : null;
    if (recordedPatchSha !== evidence.actual_patch_sha256) {
      throw new SettlementGuardError(
        `Pending ${submission.kind} ${submission.action_id} patch SHA conflicts with its settlement evidence.`,
      );
    }
    const recordedPaths = Array.isArray(
      submission.detail.actual_request_patch_paths,
    )
      ? submission.detail.actual_request_patch_paths.filter(
          (item): item is string => typeof item === "string",
        ).sort()
      : Array.isArray(submission.detail.patch_paths)
        ? submission.detail.patch_paths.filter(
            (item): item is string => typeof item === "string",
          ).sort()
        : null;
    if (
      recordedPaths == null ||
      stableJson(recordedPaths) !== stableJson(evidence.exact_action_paths)
    ) {
      throw new SettlementGuardError(
        `Pending ${submission.kind} ${submission.action_id} path list conflicts with its settlement evidence.`,
      );
    }
    for (const patchPath of evidence.exact_action_paths) {
      const key = scopedPatchPathKey(
        planned.entry.store_index,
        planned.entry.sku,
        patchPath,
      );
      if (selectedPathKeys.has(key)) {
        throw new SettlementGuardError(
          `Pending ${submission.kind} ${submission.action_id} overlaps selected path ${patchPath}; no Amazon call was made.`,
        );
      }
    }
    await input.checkpointStore.append({
      action_id: submission.action_id,
      sku: submission.sku,
      kind: submission.kind,
      status: "PENDING_QUARANTINED",
      detail: {
        selection_sha256: input.selection.sha256,
        submitted_event_id: submission.submitted_event_id,
        settlement_guard: evidence,
        isolation_scope: {
          store_index: planned.entry.store_index,
          sku: planned.entry.sku,
          exact_action_paths: evidence.exact_action_paths,
        },
      },
    });
    quarantined.push({
      action_id: submission.action_id,
      sku: submission.sku,
      submitted_event_id: submission.submitted_event_id,
      exact_action_paths: evidence.exact_action_paths,
    });
  }
  return quarantined;
}

interface BoundPendingOfferSubmission {
  submission: PendingRepairSubmission;
  entry: RepairPlanEntry;
  action: PlannedRepairAction & { desired: { kind: "OFFER"; value: DesiredOfferRepair } };
  evidence: ExactPathSettlementEvidence;
}

function assertPendingLaunchAuthorizationLineage(
  plan: UncrustablesRepairPlan,
  submission: PendingRepairSubmission,
): void {
  if (!plan.launch_pricing_source || submission.kind !== "OFFER") return;
  const submittedDigest =
    submission.detail.launch_execution_authorization_body_sha256;
  const armedDigest =
    submission.armed_detail?.launch_execution_authorization_body_sha256;
  if (
    typeof submittedDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(submittedDigest) ||
    typeof armedDigest !== "string" ||
    armedDigest !== submittedDigest
  ) {
    throw new SettlementGuardError(
      `Pending launch OFFER ${submission.action_id} is missing exact execution-authorization lineage; no Amazon call was made.`,
    );
  }
}

/** Validate every immutable pending row before SETTLE_ONLY performs its first
 * GET. This is deliberately stricter than ordinary recovery: the entire
 * canonical pending set must be explained by the exact OFFER selection (or by
 * already-terminal actions from that same selection), and every path/digest
 * must remain inside the sealed action boundary. */
function bindPendingOfferSubmissions(input: {
  plan: UncrustablesRepairPlan;
  selection: RepairExecutionSelection;
  pending: Map<string, PendingRepairSubmission>;
  terminalActionIds: Set<string>;
}): BoundPendingOfferSubmission[] {
  const selected = assertOfferOnlyExecutionSelection(input);
  const selectedIds = new Set(selected.map((action) => action.action_id));
  const selectedTerminal = new Set(
    [...input.terminalActionIds].filter((actionId) => selectedIds.has(actionId)),
  );
  if (selected.length !== input.pending.size + selectedTerminal.size) {
    throw new SettlementGuardError(
      `OFFER settle-only selection covers ${selected.length} action(s), but canonical pending/terminal state accounts for ${input.pending.size + selectedTerminal.size}; no Amazon call was made.`,
    );
  }
  const plannedByActionId = new Map(
    input.plan.entries.flatMap((entry) =>
      entry.actions.map((action) => [action.action_id, { entry, action }] as const),
    ),
  );
  const bindings: BoundPendingOfferSubmission[] = [];
  for (const submission of [...input.pending.values()].sort((left, right) =>
    left.action_id < right.action_id ? -1 : left.action_id > right.action_id ? 1 : 0
  )) {
    const planned = plannedByActionId.get(submission.action_id);
    if (
      !selectedIds.has(submission.action_id) ||
      !planned ||
      planned.entry.sku !== submission.sku ||
      submission.kind !== "OFFER" ||
      planned.action.kind !== "OFFER" ||
      planned.action.desired.kind !== "OFFER"
    ) {
      throw new SettlementGuardError(
        `Canonical pending submission ${submission.action_id}/${submission.sku} is outside the exact OFFER settle-only selection; no Amazon call was made.`,
      );
    }
    assertPendingLaunchAuthorizationLineage(input.plan, submission);
    const armedCrashWindow =
      submission.detail.crash_window_guard === true &&
      submission.detail.strategy === "PRIMARY";
    if (
      !armedCrashWindow &&
      submission.detail.strategy !== SELECTOR_REPLACE_SURROGATE_FOR_MERGE
    ) {
      throw new SettlementGuardError(
        `Pending OFFER ${submission.action_id} has an undocumented submission strategy; no Amazon call was made.`,
      );
    }
    let evidence: ExactPathSettlementEvidence;
    try {
      evidence = parseSettlementEvidence(submission);
    } catch (error) {
      throw new SettlementGuardError(
        `${error instanceof Error ? error.message : String(error)} No Amazon call was made.`,
      );
    }
    const plannedPaths = new Set(potentialActionPatchPaths(planned.action));
    if (
      evidence.exact_action_paths.some(
        (patchPath) =>
          !(OFFER_PATCH_PATHS as readonly string[]).includes(patchPath) ||
          !plannedPaths.has(patchPath),
      )
    ) {
      throw new SettlementGuardError(
        `Pending OFFER ${submission.action_id} contains a path outside its sealed action boundary; no Amazon call was made.`,
      );
    }
    const recordedPatchSha =
      typeof submission.detail.actual_request_patch_sha256 === "string"
        ? submission.detail.actual_request_patch_sha256
        : typeof submission.detail.patch_sha256 === "string"
          ? submission.detail.patch_sha256
          : armedCrashWindow
            ? evidence.actual_patch_sha256
            : null;
    const recordedPaths = Array.isArray(
      submission.detail.actual_request_patch_paths,
    )
      ? submission.detail.actual_request_patch_paths.filter(
          (item): item is string => typeof item === "string",
        ).sort()
      : Array.isArray(submission.detail.patch_paths)
        ? submission.detail.patch_paths.filter(
            (item): item is string => typeof item === "string",
          ).sort()
        : armedCrashWindow
          ? evidence.exact_action_paths
          : null;
    if (
      recordedPatchSha !== evidence.actual_patch_sha256 ||
      recordedPaths == null ||
      stableJson(recordedPaths) !== stableJson(evidence.exact_action_paths)
    ) {
      throw new SettlementGuardError(
        `Pending OFFER ${submission.action_id} conflicts with its exact settlement evidence; no Amazon call was made.`,
      );
    }
    bindings.push({
      submission,
      entry: planned.entry,
      action: planned.action as BoundPendingOfferSubmission["action"],
      evidence,
    });
  }
  return bindings;
}

async function settlePendingOfferSelection(input: {
  plan: UncrustablesRepairPlan;
  selection: RepairExecutionSelection;
  gateway: RepairAmazonGateway;
  checkpointStore: ImmutableCheckpointStore;
  mediaEquivalence: MediaEquivalence;
  policy: OfferSettlementPolicyInput;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<{
  verified: number;
  terminal: number;
  unresolved: number;
}> {
  const policy = resolveOfferSettlementPolicy(input.policy);
  const pending = await input.checkpointStore.pendingSubmissions();
  const terminalActionIds = await input.checkpointStore.verifiedActionIds();
  const bindings = bindPendingOfferSubmissions({
    plan: input.plan,
    selection: input.selection,
    pending,
    terminalActionIds,
  });
  const byActionId = new Map(
    bindings.map((binding) => [binding.submission.action_id, binding] as const),
  );
  const latestVerificationByActionId = new Map<string, VerificationResult>();
  for (const binding of bindings) {
    await input.checkpointStore.append({
      action_id: binding.submission.action_id,
      sku: binding.submission.sku,
      kind: "OFFER",
      status: "SETTLEMENT_PENDING",
      detail: {
        recovery: true,
        trigger: "OFFER_SETTLE_ONLY",
        submitted_event_id: binding.submission.submitted_event_id,
        submitted_at: binding.submission.submitted_at,
        settlement_guard: binding.evidence,
        horizon_ms: policy.horizonMs,
        poll_interval_ms: policy.pollIntervalMs,
        request_delay_ms: policy.requestDelayMs,
        observation_timeout_ms: policy.observationTimeoutMs,
        stable_reads_required: policy.stableReads,
        ...safeOfferPriceSettlementDiagnostics(binding.action, null),
      },
    });
  }
  const outcomes = await runReadOnlyOfferSettlement({
    plan: input.plan,
    selection: input.selection,
    pending: bindings.map(({ submission }) => ({
      action_id: submission.action_id,
      sku: submission.sku,
      submitted_event_id: submission.submitted_event_id,
      submitted_at: submission.submitted_at,
    })),
    terminalActionIds,
    policy,
    dependencies: {
      ...(input.sleep ? { sleep: input.sleep } : {}),
      observe: async (submission, _progress, signal) => {
        const binding = byActionId.get(submission.action_id);
        if (
          !binding ||
          binding.submission.submitted_event_id !==
            submission.submitted_event_id
        ) {
          throw new SettlementGuardError(
            `OFFER settlement identity changed for ${submission.action_id}.`,
          );
        }
        const live = await input.gateway.getListing(
          binding.entry.store_index,
          binding.entry.sku,
          signal,
        );
        listingIdentity(binding.entry, live);
        const verification = await verifyActionState(
          binding.action,
          live,
          input.mediaEquivalence,
        );
        latestVerificationByActionId.set(submission.action_id, verification);
        const pathStateSha256 = exactActionPathStateSha256(
          live,
          binding.evidence.exact_action_paths,
        );
        return {
          classification: verification.ok
            ? "DESIRED"
            : pathStateSha256 === binding.evidence.before_path_state_sha256
              ? "BEFORE"
              : "NON_DESIRED",
          path_state_sha256: pathStateSha256,
          verification,
        };
      },
      onVerified: async (submission, observation, progress) => {
        const verification = observation.verification as VerificationResult;
        await input.checkpointStore.append({
          action_id: submission.action_id,
          sku: submission.sku,
          kind: "OFFER",
          status: "VERIFIED",
          detail: {
            recovery: true,
            trigger: "OFFER_SETTLE_ONLY",
            submitted_event_id: submission.submitted_event_id,
            stable_post_write_reads: progress.consecutive_identical_reads,
            polling_reads: progress.reads,
            polling_sweep: progress.sweep,
            elapsed_ms: progress.elapsed_ms,
            path_state_sha256: observation.path_state_sha256,
            checks: verification.checks,
          },
        });
      },
      onPending: async (submission, outcome) => {
        const binding = byActionId.get(submission.action_id);
        if (!binding) {
          throw new SettlementGuardError(
            `OFFER settlement lost binding ${submission.action_id}.`,
          );
        }
        await input.checkpointStore.append({
          action_id: submission.action_id,
          sku: submission.sku,
          kind: "OFFER",
          status: "SETTLEMENT_UNRESOLVED",
          detail: {
            recovery: true,
            trigger: "OFFER_SETTLE_ONLY",
            submitted_event_id: submission.submitted_event_id,
            disposition: outcome.disposition,
            polling_reads: outcome.reads,
            read_errors: outcome.read_errors,
            consecutive_stable_reads: outcome.consecutive_identical_reads,
            last_classification: outcome.last_classification,
            last_path_state_sha256: outcome.last_path_state_sha256,
            remains_pending: true,
            automatic_resubmission_authorized: false,
            ...safeOfferPriceSettlementDiagnostics(
              binding.action,
              latestVerificationByActionId.get(submission.action_id) ?? null,
            ),
          },
        });
      },
    },
  });
  return {
    verified: outcomes.filter((outcome) => outcome.disposition === "VERIFIED")
      .length,
    terminal: input.selection.selected_action_ids.filter((actionId) =>
      terminalActionIds.has(actionId)
    ).length,
    unresolved: outcomes.filter((outcome) => outcome.disposition !== "VERIFIED")
      .length,
  };
}

interface BoundPendingRepairSubmission {
  submission: PendingRepairSubmission;
  entry: RepairPlanEntry;
  action: PlannedRepairAction;
  evidence: ExactPathSettlementEvidence;
}

/** Bind a sealed positive selection to the complete canonical pending set
 * before generic recovery is allowed to perform its first GET. Unlike OFFER
 * settle-only, this accepts every repair action kind, while retaining exact
 * action/SKU/kind/path/digest/submission identity. */
function bindPendingRepairSelection(input: {
  plan: UncrustablesRepairPlan;
  selection: RepairExecutionSelection;
  pending: Map<string, PendingRepairSubmission>;
  terminalActionIds: Set<string>;
}): BoundPendingRepairSubmission[] {
  verifyRepairExecutionSelection(input.plan, input.selection);
  const selectedIds = new Set(input.selection.selected_action_ids);
  const selectedTerminal = new Set(
    [...input.terminalActionIds].filter((actionId) => selectedIds.has(actionId)),
  );
  if (
    input.selection.selected_action_ids.length !==
      input.pending.size + selectedTerminal.size
  ) {
    throw new SettlementGuardError(
      `Generic pending recovery selection covers ${input.selection.selected_action_ids.length} action(s), but canonical pending/terminal state accounts for ${input.pending.size + selectedTerminal.size}; no Amazon call was made.`,
    );
  }
  const plannedByActionId = new Map(
    input.plan.entries.flatMap((entry) =>
      entry.actions.map((action) => [action.action_id, { entry, action }] as const),
    ),
  );
  for (const actionId of input.selection.selected_action_ids) {
    if (input.pending.has(actionId) && selectedTerminal.has(actionId)) {
      throw new SettlementGuardError(
        `Selected action ${actionId} is both pending and terminal; no Amazon call was made.`,
      );
    }
    if (!input.pending.has(actionId) && !selectedTerminal.has(actionId)) {
      throw new SettlementGuardError(
        `Selected action ${actionId} is neither canonical pending nor terminal; no Amazon call was made.`,
      );
    }
  }

  const bindings: BoundPendingRepairSubmission[] = [];
  for (const submission of [...input.pending.values()].sort((left, right) =>
    left.action_id.localeCompare(right.action_id)
  )) {
    const planned = plannedByActionId.get(submission.action_id);
    if (
      !selectedIds.has(submission.action_id) ||
      !planned ||
      planned.entry.sku !== submission.sku ||
      planned.action.kind !== submission.kind
    ) {
      throw new SettlementGuardError(
        `Canonical pending submission ${submission.action_id}/${submission.sku}/${submission.kind} is outside the exact recovery selection; no Amazon call was made.`,
      );
    }
    assertPendingLaunchAuthorizationLineage(input.plan, submission);

    const strategy = submission.detail.strategy;
    const armedCrashWindow =
      submission.detail.crash_window_guard === true &&
      (strategy === "PRIMARY" || strategy === "REVIEWED_FALLBACK");
    let action: PlannedRepairAction | null = planned.action;
    if (strategy === "REVIEWED_FALLBACK") {
      action = fallbackAction(planned.action);
    } else if (
      strategy !== "PRIMARY" &&
      !(
        submission.kind === "OFFER" &&
        strategy === SELECTOR_REPLACE_SURROGATE_FOR_MERGE
      )
    ) {
      action = null;
    }
    if (!action || action.kind !== submission.kind) {
      throw new SettlementGuardError(
        `Pending ${submission.kind} ${submission.action_id} has no matching documented submission strategy in the sealed plan; no Amazon call was made.`,
      );
    }
    if (submission.source_status === "SUBMITTED") {
      const armedEventId = submission.detail.armed_event_id;
      const armedDetail = submission.armed_detail;
      const armedStrategyMatches =
        armedDetail?.strategy === strategy ||
        (submission.kind === "OFFER" &&
          strategy === SELECTOR_REPLACE_SURROGATE_FOR_MERGE &&
          armedDetail?.strategy === "PRIMARY");
      if (
        typeof armedEventId !== "string" ||
        armedEventId.length === 0 ||
        submission.armed_event_id !== armedEventId ||
        !armedDetail ||
        armedDetail.crash_window_guard !== true ||
        !armedStrategyMatches ||
        stableJson(armedDetail.settlement_guard) !==
          stableJson(submission.detail.settlement_guard)
      ) {
        throw new SettlementGuardError(
          `Pending ${submission.kind} ${submission.action_id} is SUBMITTED without exact matching SUBMISSION_ARMED lineage; no Amazon call was made.`,
        );
      }
    }
    if (
      submission.source_status === "SUBMISSION_ARMED" &&
      !armedCrashWindow
    ) {
      throw new SettlementGuardError(
        `Pending ${submission.kind} ${submission.action_id} has an unguarded standalone SUBMISSION_ARMED event; no Amazon call was made.`,
      );
    }

    let evidence: ExactPathSettlementEvidence;
    try {
      evidence = parseSettlementEvidence(submission);
    } catch (error) {
      throw new SettlementGuardError(
        `${error instanceof Error ? error.message : String(error)} No Amazon call was made.`,
      );
    }
    const plannedPaths = new Set(potentialActionPatchPaths(action));
    const violatesKindBoundary = (patchPath: string): boolean =>
      submission.kind === "MEDIA"
        ? !(MEDIA_PATCH_PATHS as readonly string[]).includes(patchPath)
        : submission.kind === "OFFER"
          ? !(OFFER_PATCH_PATHS as readonly string[]).includes(patchPath)
          : false;
    if (
      evidence.exact_action_paths.some(
        (patchPath) =>
          !plannedPaths.has(patchPath) ||
          violatesKindBoundary(patchPath) ||
          (input.selection.profile === GALLERY_MEDIA_ONLY_PROFILE &&
            !/^\/attributes\/other_product_image_locator_[1-8]$/.test(
              patchPath,
            )),
      )
    ) {
      throw new SettlementGuardError(
        `Pending ${submission.kind} ${submission.action_id} contains a path outside its sealed action boundary; no Amazon call was made.`,
      );
    }
    const hasActualPatchSha = Object.prototype.hasOwnProperty.call(
      submission.detail,
      "actual_request_patch_sha256",
    );
    const recordedPatchSha = hasActualPatchSha
      ? typeof submission.detail.actual_request_patch_sha256 === "string"
        ? submission.detail.actual_request_patch_sha256
        : null
      : typeof submission.detail.patch_sha256 === "string"
        ? submission.detail.patch_sha256
        : armedCrashWindow
          ? evidence.actual_patch_sha256
          : null;
    const hasActualPaths = Object.prototype.hasOwnProperty.call(
      submission.detail,
      "actual_request_patch_paths",
    );
    const rawRecordedPaths = hasActualPaths
      ? submission.detail.actual_request_patch_paths
      : Object.prototype.hasOwnProperty.call(submission.detail, "patch_paths")
        ? submission.detail.patch_paths
        : armedCrashWindow
          ? evidence.exact_action_paths
          : null;
    const recordedPaths = Array.isArray(rawRecordedPaths) &&
        rawRecordedPaths.every((item): item is string => typeof item === "string")
      ? [...rawRecordedPaths].sort()
      : null;
    if (
      recordedPatchSha !== evidence.actual_patch_sha256 ||
      recordedPaths == null ||
      stableJson(recordedPaths) !== stableJson(evidence.exact_action_paths)
    ) {
      throw new SettlementGuardError(
        `Pending ${submission.kind} ${submission.action_id} conflicts with its exact settlement evidence; no Amazon call was made.`,
      );
    }
    bindings.push({
      submission,
      entry: planned.entry,
      action,
      evidence,
    });
  }
  return bindings;
}

async function settlePendingRepairSelection(input: {
  plan: UncrustablesRepairPlan;
  selection: RepairExecutionSelection;
  gateway: RepairAmazonGateway;
  checkpointStore: ImmutableCheckpointStore;
  mediaEquivalence: MediaEquivalence;
  policy: OfferSettlementPolicyInput;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<{
  verified: number;
  terminal: number;
  unresolved: number;
}> {
  const policy = resolveOfferSettlementPolicy(input.policy);
  if (policy.stableReads !== 3) {
    throw new SettlementGuardError(
      "Generic pending recovery requires exactly 3 stable DESIRED reads; no Amazon call was made.",
    );
  }
  const pending = await input.checkpointStore.pendingSubmissions();
  const terminalActionIds = await input.checkpointStore.verifiedActionIds();
  const bindings = bindPendingRepairSelection({
    plan: input.plan,
    selection: input.selection,
    pending,
    terminalActionIds,
  });
  const byActionId = new Map(
    bindings.map((binding) => [binding.submission.action_id, binding] as const),
  );
  const latestVerificationByActionId = new Map<string, VerificationResult>();
  for (const binding of bindings) {
    await input.checkpointStore.append({
      action_id: binding.submission.action_id,
      sku: binding.submission.sku,
      kind: binding.submission.kind,
      status: "SETTLEMENT_PENDING",
      detail: {
        recovery: true,
        trigger: "PENDING_SETTLE_ONLY",
        selection_sha256: input.selection.sha256,
        submitted_event_id: binding.submission.submitted_event_id,
        submitted_at: binding.submission.submitted_at,
        settlement_guard: binding.evidence,
        horizon_ms: policy.horizonMs,
        poll_interval_ms: policy.pollIntervalMs,
        request_delay_ms: policy.requestDelayMs,
        observation_timeout_ms: policy.observationTimeoutMs,
        stable_reads_required: policy.stableReads,
        ...(binding.action.desired.kind === "OFFER"
          ? safeOfferPriceSettlementDiagnostics(binding.action, null)
          : {}),
      },
    });
  }
  const outcomes = await runReadOnlySettlementScheduler({
    pending: bindings.map(({ submission }) => ({
      action_id: submission.action_id,
      sku: submission.sku,
      submitted_event_id: submission.submitted_event_id,
      submitted_at: submission.submitted_at,
    })),
    policy,
    requireUniqueSkus: false,
    dependencies: {
      ...(input.sleep ? { sleep: input.sleep } : {}),
      observe: async (submission, _progress, signal) => {
        const binding = byActionId.get(submission.action_id);
        if (
          !binding ||
          binding.submission.submitted_event_id !==
            submission.submitted_event_id
        ) {
          throw new SettlementGuardError(
            `Pending recovery identity changed for ${submission.action_id}.`,
          );
        }
        const rawLive = await input.gateway.getListing(
          binding.entry.store_index,
          binding.entry.sku,
          signal,
        );
        const live = exactMarketplaceListing(rawLive);
        listingIdentity(binding.entry, live);
        const verification = await verifyActionState(
          binding.action,
          live,
          input.mediaEquivalence,
        );
        latestVerificationByActionId.set(submission.action_id, verification);
        const pathStateSha256 = exactActionPathStateSha256(
          live,
          binding.evidence.exact_action_paths,
        );
        return {
          classification: verification.ok
            ? "DESIRED"
            : pathStateSha256 === binding.evidence.before_path_state_sha256
              ? "BEFORE"
              : "NON_DESIRED",
          path_state_sha256: pathStateSha256,
          verification,
        };
      },
      onVerified: async (submission, observation, progress) => {
        const binding = byActionId.get(submission.action_id);
        if (!binding) {
          throw new SettlementGuardError(
            `Pending recovery lost binding ${submission.action_id}.`,
          );
        }
        const verification = observation.verification as VerificationResult;
        await input.checkpointStore.append({
          action_id: submission.action_id,
          sku: submission.sku,
          kind: binding.submission.kind,
          status: "VERIFIED",
          detail: {
            recovery: true,
            trigger: "PENDING_SETTLE_ONLY",
            selection_sha256: input.selection.sha256,
            submitted_event_id: submission.submitted_event_id,
            stable_post_write_reads: progress.consecutive_identical_reads,
            polling_reads: progress.reads,
            polling_sweep: progress.sweep,
            elapsed_ms: progress.elapsed_ms,
            path_state_sha256: observation.path_state_sha256,
            checks: verification.checks,
          },
        });
      },
      onPending: async (submission, outcome) => {
        const binding = byActionId.get(submission.action_id);
        if (!binding) {
          throw new SettlementGuardError(
            `Pending recovery lost binding ${submission.action_id}.`,
          );
        }
        await input.checkpointStore.append({
          action_id: submission.action_id,
          sku: submission.sku,
          kind: binding.submission.kind,
          status: "SETTLEMENT_UNRESOLVED",
          detail: {
            recovery: true,
            trigger: "PENDING_SETTLE_ONLY",
            selection_sha256: input.selection.sha256,
            submitted_event_id: submission.submitted_event_id,
            disposition: outcome.disposition,
            polling_reads: outcome.reads,
            read_errors: outcome.read_errors,
            consecutive_stable_reads: outcome.consecutive_identical_reads,
            last_classification: outcome.last_classification,
            last_path_state_sha256: outcome.last_path_state_sha256,
            remains_pending: true,
            automatic_resubmission_authorized: false,
            ...(binding.action.desired.kind === "OFFER"
              ? safeOfferPriceSettlementDiagnostics(
                  binding.action,
                  latestVerificationByActionId.get(submission.action_id) ?? null,
                )
              : {}),
          },
        });
      },
    },
  });
  return {
    verified: outcomes.filter((outcome) => outcome.disposition === "VERIFIED")
      .length,
    terminal: input.selection.selected_action_ids.filter((actionId) =>
      terminalActionIds.has(actionId)
    ).length,
    unresolved: outcomes.filter((outcome) => outcome.disposition !== "VERIFIED")
      .length,
  };
}

/** Read-only recovery for accepted Listings Items submissions left open by a
 * prior process/readback timeout. It never PATCHes. Only stable desired closes
 * a submission; stable before/non-desired and unstable results remain pending
 * and therefore block every later write. */
export async function recoverPendingRepairSettlements(input: {
  plan: UncrustablesRepairPlan;
  gateway: RepairAmazonGateway;
  checkpointStore: ImmutableCheckpointStore;
  mediaEquivalence?: MediaEquivalence;
  skus?: string[] | null;
  /** Optional exact action selection. Pending submissions outside this set
   * remain open and are never polled, closed, or resubmitted. */
  actionIds?: string[] | null;
  attempts?: number;
  delayMs?: number;
  stableReads?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<PendingRepairSettlementOutcome[]> {
  verifyRepairPlan(input.plan);
  const attempts = input.attempts ?? 20;
  const delayMs = input.delayMs ?? 30_000;
  const stableReads = input.stableReads ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 60) {
    throw new Error("Settlement attempts must be an integer from 1 to 60.");
  }
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error("Settlement delay must be a non-negative integer.");
  }
  if (!Number.isInteger(stableReads) || stableReads < 2 || stableReads > 10) {
    throw new Error("Settlement stable reads must be an integer from 2 to 10.");
  }
  if (stableReads > attempts) {
    throw new Error("Settlement stable reads cannot exceed settlement attempts.");
  }
  const selectedSkus = input.skus?.length
    ? new Set(input.skus.map((sku) => sku.trim()).filter(Boolean))
    : null;
  const selectedActionIds = input.actionIds?.length
    ? new Set(input.actionIds.map((actionId) => actionId.trim()).filter(Boolean))
    : null;
  const actionById = new Map(
    input.plan.entries.flatMap((entry) =>
      entry.actions.map((action) => [action.action_id, { entry, action }] as const),
    ),
  );
  const pending = await input.checkpointStore.pendingSubmissions();
  const outcomes: PendingRepairSettlementOutcome[] = [];
  const sleep = input.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (const submission of [...pending.values()].sort(
    (left, right) => left.action_id.localeCompare(right.action_id),
  )) {
    if (selectedSkus && !selectedSkus.has(submission.sku)) continue;
    if (selectedActionIds && !selectedActionIds.has(submission.action_id)) {
      continue;
    }
    const planned = actionById.get(submission.action_id);
    if (
      !planned ||
      planned.entry.sku !== submission.sku ||
      planned.action.kind !== submission.kind
    ) {
      throw new SettlementGuardError(
        `Pending Amazon submission ${submission.action_id} is not bound to the exact sealed plan action.`,
      );
    }
    const strategy = submission.detail.strategy === "REVIEWED_FALLBACK"
      ? "REVIEWED_FALLBACK"
      : "PRIMARY";
    const action = strategy === "REVIEWED_FALLBACK"
      ? fallbackAction(planned.action)
      : planned.action;
    if (!action) {
      throw new SettlementGuardError(
        `Pending fallback submission ${submission.action_id} has no reviewed fallback in the sealed plan.`,
      );
    }
    let evidence: ExactPathSettlementEvidence;
    try {
      evidence = parseSettlementEvidence(submission);
    } catch (error) {
      await input.checkpointStore.append({
        action_id: submission.action_id,
        sku: submission.sku,
        kind: submission.kind,
        status: "SETTLEMENT_UNRESOLVED",
        detail: {
          recovery: true,
          submitted_event_id: submission.submitted_event_id,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      outcomes.push({
        action_id: submission.action_id,
        sku: submission.sku,
        strategy,
        state: "UNRESOLVED",
        verification: null,
      });
      continue;
    }
    await input.checkpointStore.append({
      action_id: submission.action_id,
      sku: submission.sku,
      kind: submission.kind,
      status: "SETTLEMENT_PENDING",
      detail: {
        recovery: true,
        submitted_event_id: submission.submitted_event_id,
        submitted_at: submission.submitted_at,
        strategy,
        settlement_guard: evidence,
        attempts,
        delay_ms: delayMs,
        stable_reads_required: stableReads,
      },
    });
    const settled = await pollActionSettlement({
      entry: planned.entry,
      action,
      gateway: input.gateway,
      mediaEquivalence: input.mediaEquivalence ?? exactMediaEquivalence,
      evidence,
      attempts,
      delayMs,
      stableReads,
      sleep,
    });
    const detail = {
      recovery: true,
      submitted_event_id: submission.submitted_event_id,
      strategy,
      settlement_guard: evidence,
      polling_attempts: settled.attempts,
      consecutive_stable_reads: settled.consecutive_stable_reads,
      last_classification: settled.last?.classification ?? null,
      last_path_state_sha256: settled.last?.path_state_sha256 ?? null,
      checks: settled.last?.verification.checks ?? [],
    };
    if (settled.state === "DESIRED") {
      await input.checkpointStore.append({
        action_id: submission.action_id,
        sku: submission.sku,
        kind: submission.kind,
        status: "VERIFIED",
        detail: { ...detail, recovered_late_submission: true },
      });
    } else if (settled.state === "STABLE_BEFORE") {
      await input.checkpointStore.append({
        action_id: submission.action_id,
        sku: submission.sku,
        kind: submission.kind,
        status: "SETTLED_BEFORE",
        detail,
      });
    } else if (settled.state === "STABLE_NON_DESIRED") {
      await input.checkpointStore.append({
        action_id: submission.action_id,
        sku: submission.sku,
        kind: submission.kind,
        status: "SETTLED_NON_DESIRED",
        detail,
      });
    } else {
      await input.checkpointStore.append({
        action_id: submission.action_id,
        sku: submission.sku,
        kind: submission.kind,
        status: "SETTLEMENT_UNRESOLVED",
        detail,
      });
    }
    outcomes.push({
      action_id: submission.action_id,
      sku: submission.sku,
      strategy,
      state: settled.state,
      verification: settled.last?.verification ?? null,
    });
  }
  return outcomes;
}

async function verifySubmittedActionSettlement(input: {
  entry: RepairPlanEntry;
  action: PlannedRepairAction;
  gateway: RepairAmazonGateway;
  checkpointStore: ImmutableCheckpointStore;
  mediaEquivalence: MediaEquivalence;
  evidence: ExactPathSettlementEvidence;
  submittedEventId: string;
  strategy: "PRIMARY" | "REVIEWED_FALLBACK";
  requestDelayMs: number;
  verifyAttempts: number;
  verifyDelayMs: number;
  settlementAttempts: number;
  settlementDelayMs: number;
  settlementStableReads: number;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<VerificationResult> {
  await input.checkpointStore.append({
    action_id: input.action.action_id,
    sku: input.entry.sku,
    kind: input.action.kind,
    status: "SETTLEMENT_PENDING",
    detail: {
      recovery: false,
      submitted_event_id: input.submittedEventId,
      trigger: "ACCEPTED_WRITE_POST_GET",
      strategy: input.strategy,
      settlement_guard: input.evidence,
      fast_verify_attempts: input.verifyAttempts,
      extended_attempts: input.settlementAttempts,
      extended_delay_ms: input.settlementDelayMs,
      stable_reads_required: input.settlementStableReads,
    },
  });
  let lastVerification: VerificationResult | null = null;
  let stableDesiredReads = 0;
  let previousDesiredDigest: string | null = null;
  for (let attempt = 1; attempt <= input.verifyAttempts; attempt++) {
    await input.sleep(attempt === 1 ? input.requestDelayMs : input.verifyDelayMs);
    const after = await input.gateway.getListing(
      input.entry.store_index,
      input.entry.sku,
    );
    listingIdentity(input.entry, after);
    lastVerification = await verifyActionState(
      input.action,
      after,
      input.mediaEquivalence,
    );
    if (!lastVerification.ok) {
      stableDesiredReads = 0;
      previousDesiredDigest = null;
      continue;
    }
    const digest = exactActionPathStateSha256(
      after,
      input.evidence.exact_action_paths,
    );
    stableDesiredReads = digest === previousDesiredDigest
      ? stableDesiredReads + 1
      : 1;
    previousDesiredDigest = digest;
    if (stableDesiredReads >= input.settlementStableReads) {
      await input.checkpointStore.append({
        action_id: input.action.action_id,
        sku: input.entry.sku,
        kind: input.action.kind,
        status: "VERIFIED",
        detail: {
          submitted_event_id: input.submittedEventId,
          strategy: input.strategy,
          stable_post_write_reads: stableDesiredReads,
          path_state_sha256: digest,
          checks: lastVerification.checks,
        },
      });
      return lastVerification;
    }
  }

  const settled = await pollActionSettlement({
    entry: input.entry,
    action: input.action,
    gateway: input.gateway,
    mediaEquivalence: input.mediaEquivalence,
    evidence: input.evidence,
    attempts: input.settlementAttempts,
    delayMs: input.settlementDelayMs,
    stableReads: input.settlementStableReads,
    sleep: input.sleep,
  });
  const detail = {
    recovery: false,
    submitted_event_id: input.submittedEventId,
    strategy: input.strategy,
    settlement_guard: input.evidence,
    fast_verify_attempts: input.verifyAttempts,
    extended_polling_attempts: settled.attempts,
    consecutive_stable_reads: settled.consecutive_stable_reads,
    last_classification: settled.last?.classification ?? null,
    last_path_state_sha256: settled.last?.path_state_sha256 ?? null,
    checks: settled.last?.verification.checks ?? lastVerification?.checks ?? [],
  };
  if (settled.state === "DESIRED" && settled.last) {
    await input.checkpointStore.append({
      action_id: input.action.action_id,
      sku: input.entry.sku,
      kind: input.action.kind,
      status: "VERIFIED",
      detail: {
        ...detail,
        recovered_late_submission: true,
      },
    });
    return settled.last.verification;
  }
  if (settled.state === "STABLE_BEFORE") {
    await input.checkpointStore.append({
      action_id: input.action.action_id,
      sku: input.entry.sku,
      kind: input.action.kind,
      status: "SETTLED_BEFORE",
      detail,
    });
    throw new SettlementGuardError(
      `Amazon accepted ${input.action.action_id}, but only the stable pre-write state is observable. The submission remains open because a later apply cannot be excluded; no fallback or second write was attempted.`,
    );
  }
  if (settled.state === "STABLE_NON_DESIRED") {
    await input.checkpointStore.append({
      action_id: input.action.action_id,
      sku: input.entry.sku,
      kind: input.action.kind,
      status: "SETTLED_NON_DESIRED",
      detail,
    });
    throw new SettlementGuardError(
      `Amazon submission ${input.action.action_id} is stable but non-desired. It remains open because a later apply cannot be excluded; no fallback or automatic resubmission was attempted.`,
    );
  }
  await input.checkpointStore.append({
    action_id: input.action.action_id,
    sku: input.entry.sku,
    kind: input.action.kind,
    status: "SETTLEMENT_UNRESOLVED",
    detail,
  });
  throw new SettlementGuardError(
    `Amazon submission ${input.action.action_id} did not reach a stable exact-path state after bounded settlement polling.`,
  );
}

async function executeFallbackAction(input: {
  entry: RepairPlanEntry;
  action: PlannedRepairAction;
  gateway: RepairAmazonGateway;
  checkpointStore: ImmutableCheckpointStore;
  mediaEquivalence: MediaEquivalence;
  requestDelayMs: number;
  verifyAttempts: number;
  verifyDelayMs: number;
  settlementAttempts: number;
  settlementDelayMs: number;
  settlementStableReads: number;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<VerificationResult> {
  const {
    entry,
    action,
    gateway,
    checkpointStore,
    mediaEquivalence,
    requestDelayMs,
    verifyAttempts,
    verifyDelayMs,
    settlementAttempts,
    settlementDelayMs,
    settlementStableReads,
    sleep,
  } = input;
  let live = await gateway.getListing(entry.store_index, entry.sku);
  let productType = requestedProductType(action, listingIdentity(entry, live));
  const already = await verifyActionState(action, live, mediaEquivalence);
  if (already.ok) return already;

  let patches = buildActionPatches(action, live);
  let guarded = false;
  for (let guardAttempt = 1; guardAttempt <= 2; guardAttempt++) {
    const preview = await gateway.patchListing(
      entry.store_index,
      entry.sku,
      productType,
      patches,
      true,
    );
    if (preview.status !== "VALID" || hasBlockingIssues(preview)) {
      throw new Error(
        `Fallback VALIDATION_PREVIEW rejected ${action.action_id}: ${JSON.stringify(responseDetail(preview))}`,
      );
    }
    await checkpointStore.append({
      action_id: action.action_id,
      sku: entry.sku,
      kind: action.kind,
      status: "PREVIEW_VALID",
      detail: {
        strategy: "REVIEWED_FALLBACK",
        guard_attempt: guardAttempt,
        patch_sha256: patchDigest(patches),
        patch_paths: patches.map((patch) => patch.path),
        ...responseDetail(preview),
      },
    });
    await sleep(requestDelayMs);
    live = await gateway.getListing(entry.store_index, entry.sku);
    productType = requestedProductType(action, listingIdentity(entry, live));
    const nowApplied = await verifyActionState(action, live, mediaEquivalence);
    if (nowApplied.ok) return nowApplied;
    const fresh = buildActionPatches(action, live);
    if (patchDigest(fresh) === patchDigest(patches)) {
      guarded = true;
      break;
    }
    patches = fresh;
  }
  if (!guarded) {
    throw new Error(
      `Live attributes changed during fallback preview twice for ${action.action_id}.`,
    );
  }
  await sleep(requestDelayMs);
  // VALIDATION_PREVIEW is not an optimistic lock. Capture the exact path
  // state immediately before the real fallback PATCH and refuse if the
  // previewed payload would have changed.
  live = await gateway.getListing(entry.store_index, entry.sku);
  productType = requestedProductType(action, listingIdentity(entry, live));
  const immediatelyApplied = await verifyActionState(
    action,
    live,
    mediaEquivalence,
  );
  if (immediatelyApplied.ok) return immediatelyApplied;
  const immediatelyFresh = buildActionPatches(action, live);
  if (patchDigest(immediatelyFresh) !== patchDigest(patches)) {
    throw new Error(
      `Fallback payload changed after preview for ${action.action_id}; refusing an unpreviewed PATCH.`,
    );
  }
  patches = immediatelyFresh;
  const exactSettlementEvidence = settlementEvidence(live, patches);
  const armedCheckpoint = await checkpointStore.append({
    action_id: action.action_id,
    sku: entry.sku,
    kind: action.kind,
    status: "SUBMISSION_ARMED",
    detail: {
      strategy: "REVIEWED_FALLBACK",
      crash_window_guard: true,
      settlement_guard: exactSettlementEvidence,
    },
  });
  const submitted = await gateway.patchListing(
    entry.store_index,
    entry.sku,
    productType,
    patches,
    false,
  );
  if (
    !["ACCEPTED", "IN_PROGRESS"].includes(String(submitted.status ?? "")) ||
    hasBlockingIssues(submitted)
  ) {
    throw new Error(
      `Amazon did not accept fallback ${action.action_id}: ${JSON.stringify(responseDetail(submitted))}`,
    );
  }
  const submittedCheckpoint = await checkpointStore.append({
    action_id: action.action_id,
    sku: entry.sku,
    kind: action.kind,
    status: "SUBMITTED",
    detail: {
      strategy: "REVIEWED_FALLBACK",
      patch_sha256: patchDigest(patches),
      patch_paths: patches.map((patch) => patch.path),
      armed_event_id: armedCheckpoint.event_id,
      settlement_guard: exactSettlementEvidence,
      ...responseDetail(submitted),
    },
  });
  return verifySubmittedActionSettlement({
    entry,
    action,
    gateway,
    checkpointStore,
    mediaEquivalence,
    evidence: exactSettlementEvidence,
    submittedEventId: submittedCheckpoint.event_id,
    strategy: "REVIEWED_FALLBACK",
    requestDelayMs,
    verifyAttempts,
    verifyDelayMs,
    settlementAttempts,
    settlementDelayMs,
    settlementStableReads,
    sleep,
  });
}

/** Fail closed before the first marketplace read of an exact MAIN submit-only
 * wave. A single invocation may submit every action in its sealed selection,
 * but no restart may proceed while any canonical forward journal is pending.
 * Terminal actions are also non-repeatable with the same selection. */
async function assertMainMediaSubmitOnlyMayStart(input: {
  plan: UncrustablesRepairPlan;
  selection: RepairExecutionSelection;
  checkpointStore: ImmutableCheckpointStore;
}): Promise<void> {
  verifyRepairExecutionSelection(input.plan, input.selection);
  if (input.selection.profile !== MAIN_MEDIA_ONLY_PROFILE) {
    throw new SettlementGuardError(
      `MAIN submit-only requires an exact ${MAIN_MEDIA_ONLY_PROFILE} execution selection. No Amazon call was made.`,
    );
  }
  const pending = await input.checkpointStore.pendingSubmissions();
  const globalPending = await input.checkpointStore.hasGlobalPendingSubmissions();
  if (pending.size > 0 || globalPending) {
    const localIds = [...pending.keys()].sort();
    throw new SettlementGuardError(
      localIds.length > 0
        ? `Submit-only MAIN execution is blocked by persistent pending action(s): ${localIds.join(", ")}. Run exact --recover-pending-only settlement first; no PATCH is authorized.`
        : "Submit-only MAIN execution is blocked by a pending action in another canonical forward journal. Settle that exact selection first; no PATCH is authorized.",
    );
  }
  const terminal = await input.checkpointStore.verifiedActionIds();
  const repeated = input.selection.selected_action_ids.filter((actionId) =>
    terminal.has(actionId)
  );
  if (repeated.length > 0) {
    throw new SettlementGuardError(
      `Submit-only MAIN execution includes terminal action(s): ${repeated.join(", ")}. Build a new exact selection; no PATCH is authorized.`,
    );
  }
}

/** Execute a sealed plan. `apply=false` is a pure offline dry run: the gateway
 * is never touched. */
async function executeRepairPlanInternal(
  plan: UncrustablesRepairPlan,
  gateway: RepairAmazonGateway,
  options: ExecuteRepairOptions,
): Promise<ExecuteRepairResult> {
  verifyRepairPlan(plan);
  const executionPhase = options.executionPhase ?? "SUBMIT_AND_SETTLE";
  const recoverPendingOnly = options.recoverPendingOnly === true;
  if (options.apply && options.validationOnly) {
    throw new Error("apply and validationOnly are mutually exclusive.");
  }
  const executionSelection = options.executionSelection ?? null;
  if (
    executionSelection &&
    ((options.skus?.length ?? 0) > 0 || options.limit != null)
  ) {
    throw new Error(
      "A sealed execution selection cannot be combined with runtime skus/limit narrowing.",
    );
  }
  if (executionSelection) {
    verifyRepairExecutionSelection(plan, executionSelection);
  }
  if (recoverPendingOnly) {
    if (options.apply || options.validationOnly) {
      throw new Error(
        "PENDING_SETTLE_ONLY is read-only and forbids apply/validationOnly. No Amazon call was made.",
      );
    }
    if (executionPhase !== "SUBMIT_AND_SETTLE") {
      throw new Error(
        "PENDING_SETTLE_ONLY cannot be combined with an OFFER execution phase. No Amazon call was made.",
      );
    }
    if (!executionSelection) {
      throw new Error(
        "PENDING_SETTLE_ONLY requires an exact sealed execution selection. No Amazon call was made.",
      );
    }
    if (options.offerSettlementPolicy) {
      throw new Error(
        "PENDING_SETTLE_ONLY accepts pendingRecoveryPolicy, not offerSettlementPolicy. No Amazon call was made.",
      );
    }
  } else if (options.pendingRecoveryPolicy) {
    throw new Error(
      "pendingRecoveryPolicy is accepted only in PENDING_SETTLE_ONLY mode.",
    );
  }
  if (executionPhase === "SUBMIT_ONLY") {
    if (!options.apply || options.validationOnly) {
      throw new Error(
        "SUBMIT_ONLY requires apply=true and validationOnly=false. No Amazon call was made.",
      );
    }
    if (!executionSelection) {
      throw new Error(
        `SUBMIT_ONLY requires an exact ${OFFER_ONLY_EXECUTION_PROFILE} or ${MAIN_MEDIA_ONLY_PROFILE} execution selection. No Amazon call was made.`,
      );
    }
    if (executionSelection.profile === OFFER_ONLY_EXECUTION_PROFILE) {
      assertOfferOnlyExecutionSelection({ plan, selection: executionSelection });
    } else if (executionSelection.profile !== MAIN_MEDIA_ONLY_PROFILE) {
      throw new Error(
        `SUBMIT_ONLY forbids profile ${executionSelection.profile}; only ${OFFER_ONLY_EXECUTION_PROFILE} and ${MAIN_MEDIA_ONLY_PROFILE} are eligible. No Amazon call was made.`,
      );
    }
  } else if (executionPhase === "SETTLE_ONLY") {
    if (options.apply || options.validationOnly) {
      throw new Error(
        "OFFER SETTLE_ONLY is read-only and forbids apply/validationOnly. No Amazon call was made.",
      );
    }
    if (
      !executionSelection ||
      executionSelection.profile !== OFFER_ONLY_EXECUTION_PROFILE
    ) {
      throw new Error(
        "OFFER SETTLE_ONLY requires an exact OFFER_ONLY_V1 execution selection. No Amazon call was made.",
      );
    }
    assertOfferOnlyExecutionSelection({ plan, selection: executionSelection });
  } else if (options.offerSettlementPolicy) {
    throw new Error(
      "offerSettlementPolicy is accepted only in OFFER SETTLE_ONLY mode.",
    );
  }
  const expectedConfirmation = executionSelection?.confirmation_token ??
    confirmationToken(plan);
  if (options.apply && options.confirmation !== expectedConfirmation) {
    throw new Error(
      `Live apply requires --confirm=${expectedConfirmation}. No Amazon call was made.`,
    );
  }
  let entries: RepairPlanEntry[];
  if (executionSelection) {
    const selected = new Set(executionSelection.selected_action_ids);
    entries = plan.entries
      .map((entry) => ({
        ...entry,
        actions: entry.actions.filter((action) => selected.has(action.action_id)),
      }))
      .filter((entry) => entry.actions.length > 0);
    const resolvedActionIds = entries.flatMap((entry) =>
      entry.actions.map((action) => action.action_id)
    );
    if (
      stableJson(resolvedActionIds) !==
      stableJson(executionSelection.selected_action_ids)
    ) {
      throw new Error(
        "Execution selection action order no longer matches its sealed plan.",
      );
    }
  } else {
    const requested = options.skus?.length
      ? new Set(options.skus.map((sku) => sku.trim()).filter(Boolean))
      : null;
    entries = plan.entries.filter(
      (entry) => !requested || requested.has(entry.sku),
    );
    if (options.limit != null) {
      if (!Number.isInteger(options.limit) || options.limit <= 0) {
        throw new Error("Execution limit must be a positive integer.");
      }
      entries = entries.slice(0, options.limit);
    }
    if (requested) {
      const found = new Set(entries.map((entry) => entry.sku));
      const missing = [...requested].filter((sku) => !found.has(sku));
      if (missing.length) {
        throw new Error(
          `Requested SKU(s) absent from plan entries: ${missing.join(", ")}`,
        );
      }
    }
  }
  const selectedActions = entries.reduce((sum, entry) => sum + entry.actions.length, 0);
  const selectedHasOffer = entries.some((entry) =>
    entry.actions.some((action) => action.kind === "OFFER"),
  );
  const selectedOfferStoreIndices = new Set(
    entries
      .filter((entry) =>
        entry.actions.some((action) => action.kind === "OFFER")
      )
      .map((entry) => entry.store_index),
  );
  const assertCurrentLaunchOfferAuthorization = (
    action: PlannedRepairAction | null,
  ): string | null => {
    if (
      !plan.launch_pricing_source ||
      !options.apply ||
      (action != null && action.kind !== "OFFER")
    ) {
      return null;
    }
    const runtime = options.launchExecutionAuthorization;
    if (!runtime || !executionSelection) {
      throw new Error(
        "Launch-aware OFFER writes require a current ChannelMAX+Coupon execution authorization bound to the exact selection. No Amazon call was made.",
      );
    }
    if (
      selectedOfferStoreIndices.size !== 1 ||
      !selectedOfferStoreIndices.has(runtime.authorization.account.store_index) ||
      runtime.authorization.account.marketplace_id !== MARKETPLACE_ID
    ) {
      throw new Error(
        "Launch execution authorization is bound to a different store or marketplace. No Amazon call was made.",
      );
    }
    const authorizationNow = new Date();
    const evidence = [
      [
        runtime.authorization.channelmax.source_export,
        runtime.evidence_bytes.channelmax_source_export,
      ],
      [
        runtime.authorization.channelmax.assignment_upload,
        runtime.evidence_bytes.channelmax_assignment_upload,
      ],
      [
        runtime.authorization.coupons.source_evidence,
        runtime.evidence_bytes.coupon_source_evidence,
      ],
    ] as const;
    for (const [reference, bytes] of evidence) {
      if (!Buffer.isBuffer(bytes) || sha256(bytes) !== reference.sha256) {
        throw new Error(
          `Launch execution evidence bytes do not match ${reference.path}. No Amazon call was made.`,
        );
      }
    }
    verifyUncrustablesLaunchExecutionEvidenceBytes(
      runtime.authorization,
      runtime.launchPricingManifest,
      runtime.evidence_bytes,
    );
    if (!Buffer.isBuffer(runtime.launchPricingSourceBytes)) {
      throw new Error(
        "Exact launch-pricing source bytes are required at the core execution boundary. No Amazon call was made.",
      );
    }
    assertRepairPlanLaunchPricingBinding(
      plan,
      runtime.launchPricingSourceBytes,
      { requireOwnerApproval: true, now: authorizationNow },
    );
    verifyUncrustablesLaunchExecutionAuthorization(
      runtime.authorization,
      {
        planSha256: plan.sha256,
        executionSelectionSha256: executionSelection.sha256,
        launchPricingSourceSha256: runtime.launchPricingSourceSha256,
        launchPricingManifest: runtime.launchPricingManifest,
        now: authorizationNow,
      },
    );
    if (
      runtime.launchPricingSourceSha256 !==
        plan.launch_pricing_source.sha256 ||
      runtime.launchPricingManifest.body_sha256 !==
        plan.launch_pricing_source.body_sha256 ||
      runtime.launchPricingManifest.reviewed_at !==
        plan.launch_pricing_source.reviewed_at
    ) {
      throw new Error(
        "Launch execution authorization does not match the plan's pinned launch-pricing bytes. No Amazon call was made.",
      );
    }
    return runtime.authorization.body_sha256;
  };
  if (
    plan.launch_pricing_source &&
    options.apply &&
    selectedHasOffer &&
    (executionPhase !== "SUBMIT_ONLY" ||
      executionSelection?.profile !== OFFER_ONLY_EXECUTION_PROFILE)
  ) {
    throw new Error(
      `Launch-aware OFFER writes require SUBMIT_ONLY and an exact ${OFFER_ONLY_EXECUTION_PROFILE} selection. No Amazon call was made.`,
    );
  }
  if (plan.launch_pricing_source && options.apply && selectedHasOffer) {
    assertCurrentLaunchOfferAuthorization(null);
    if (
      gateway.physicalMutationGuardContract !==
        "CALL_IMMEDIATELY_BEFORE_REQUEST_V1"
    ) {
      throw new Error(
        "Launch-aware OFFER writes require a gateway that revalidates authorization immediately before the physical request. No Amazon call was made.",
      );
    }
  }
  const result: ExecuteRepairResult = {
    mode: recoverPendingOnly
      ? "PENDING_SETTLE_ONLY"
      : executionPhase === "SUBMIT_ONLY"
      ? executionSelection?.profile === MAIN_MEDIA_ONLY_PROFILE
        ? "MEDIA_SUBMIT_ONLY"
        : "OFFER_SUBMIT_ONLY"
      : executionPhase === "SETTLE_ONLY"
        ? "OFFER_SETTLE_ONLY"
        : options.apply
          ? "APPLY"
          : options.validationOnly
            ? "VALIDATION_PREVIEW"
            : "DRY_RUN",
    selection_sha256: executionSelection?.sha256 ?? null,
    selected_entries: entries.length,
    selected_actions: selectedActions,
    quarantined_pending_actions: 0,
    resumed_actions: 0,
    verified_actions: 0,
    already_applied_actions: 0,
    preview_valid_actions: 0,
    submitted_actions: 0,
    failed_actions: 0,
    recovered_pending_actions: 0,
    unresolved_settlements: 0,
    stopped_early: false,
  };
  if (
    !options.apply &&
    !options.validationOnly &&
    executionPhase !== "SETTLE_ONLY" &&
    !recoverPendingOnly
  ) return result;

  const requestDelayMs = options.requestDelayMs ?? 250;
  const verifyAttempts = options.verifyAttempts ?? 6;
  const verifyDelayMs = options.verifyDelayMs ?? 10_000;
  const settlementAttempts = options.settlementAttempts ?? 20;
  const settlementDelayMs = options.settlementDelayMs ?? 30_000;
  const settlementStableReads = options.settlementStableReads ?? 3;
  const maxErrors = options.maxErrors ?? 1;
  if (requestDelayMs < 200) throw new Error("requestDelayMs must be >= 200.");
  if (!Number.isInteger(verifyAttempts) || verifyAttempts <= 0 || verifyAttempts > 10) {
    throw new Error("verifyAttempts must be an integer from 1 to 10.");
  }
  if (
    !Number.isInteger(settlementAttempts) ||
    settlementAttempts < 1 ||
    settlementAttempts > 60
  ) {
    throw new Error("settlementAttempts must be an integer from 1 to 60.");
  }
  if (!Number.isInteger(settlementDelayMs) || settlementDelayMs < 0) {
    throw new Error("settlementDelayMs must be a non-negative integer.");
  }
  if (
    !Number.isInteger(settlementStableReads) ||
    settlementStableReads < 2 ||
    settlementStableReads > 10 ||
    settlementStableReads > settlementAttempts
  ) {
    throw new Error(
      "settlementStableReads must be an integer from 2 to 10 and cannot exceed settlementAttempts.",
    );
  }
  if (!Number.isInteger(maxErrors) || maxErrors <= 0) {
    throw new Error("maxErrors must be a positive integer.");
  }
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const mediaEquivalence = options.mediaEquivalence ?? exactMediaEquivalence;
  const selectedActionIds = entries.flatMap((entry) =>
    entry.actions.map((action) => action.action_id)
  );
  const executionGateway = guardRepairGatewayPatchPaths(
    gateway,
    executionSelection?.forbidden_patch_paths ?? [],
  );
  const coordinatedGateway =
    executionPhase === "SETTLE_ONLY" || recoverPendingOnly
    ? guardRepairGatewayReadOnly(executionGateway)
    : executionGateway;
  const needsMarketplaceCoordination =
    options.apply || executionPhase === "SETTLE_ONLY" || recoverPendingOnly;
  const submitOnlyPurpose = executionSelection?.profile === MAIN_MEDIA_ONLY_PROFILE
    ? `MEDIA_SUBMIT_ONLY:${plan.plan_id}`
    : `OFFER_SUBMIT_ONLY:${plan.plan_id}`;
  const releaseExecutionLease = needsMarketplaceCoordination
    ? await options.checkpointStore.acquireExecutionLease(
        recoverPendingOnly
          ? `PENDING_SETTLE_ONLY:${plan.plan_id}`
          : executionPhase === "SETTLE_ONLY"
          ? `OFFER_SETTLE_ONLY:${plan.plan_id}`
          : executionPhase === "SUBMIT_ONLY"
            ? submitOnlyPurpose
            : `FORWARD_APPLY:${plan.plan_id}`,
      )
    : null;
  let mutationFenceClaimed = false;
  try {
  if (needsMarketplaceCoordination) {
    await options.checkpointStore.claimPendingMutationFence(
      recoverPendingOnly
        ? `PENDING_SETTLE_ONLY:${plan.plan_id}`
        : executionPhase === "SETTLE_ONLY"
        ? `OFFER_SETTLE_ONLY:${plan.plan_id}`
        : executionPhase === "SUBMIT_ONLY"
          ? submitOnlyPurpose
          : `FORWARD_APPLY:${plan.plan_id}`,
    );
    mutationFenceClaimed = true;
    if (recoverPendingOnly && executionSelection) {
      const settled = await settlePendingRepairSelection({
        plan,
        selection: executionSelection,
        gateway: coordinatedGateway,
        checkpointStore: options.checkpointStore,
        // MAIN recovery must follow Amazon's source -> CDN rehost and buyer
        // summary projection. The production comparator independently bounds
        // every allow-listed image GET; tests may inject an exact comparator.
        // Gallery comparisons remain exact whenever both sides are Amazon CDN
        // locators, as enforced by PerceptualMediaEquivalence.
        mediaEquivalence:
          options.mediaEquivalence ?? exactMediaEquivalence,
        policy:
          options.pendingRecoveryPolicy ?? DEFAULT_OFFER_SETTLEMENT_POLICY,
        sleep: options.sleep,
      });
      result.verified_actions = settled.verified;
      result.resumed_actions = settled.terminal;
      result.recovered_pending_actions = settled.verified;
      result.unresolved_settlements = settled.unresolved;
      result.stopped_early = settled.unresolved > 0;
      return result;
    } else if (executionPhase === "SUBMIT_ONLY" && executionSelection) {
      if (executionSelection.profile === MAIN_MEDIA_ONLY_PROFILE) {
        await assertMainMediaSubmitOnlyMayStart({
          plan,
          selection: executionSelection,
          checkpointStore: options.checkpointStore,
        });
      } else {
        assertOfferSubmitOnlyMayStart({
          plan,
          selection: executionSelection,
          pendingActionIds: (await options.checkpointStore.pendingSubmissions())
            .keys(),
          terminalActionIds: await options.checkpointStore.verifiedActionIds(),
        });
      }
    } else if (executionPhase === "SETTLE_ONLY" && executionSelection) {
      const settled = await settlePendingOfferSelection({
        plan,
        selection: executionSelection,
        gateway: coordinatedGateway,
        checkpointStore: options.checkpointStore,
        mediaEquivalence,
        policy:
          options.offerSettlementPolicy ?? DEFAULT_OFFER_SETTLEMENT_POLICY,
        sleep: options.sleep,
      });
      result.verified_actions = settled.verified;
      result.resumed_actions = settled.terminal;
      result.recovered_pending_actions = settled.verified;
      result.unresolved_settlements = settled.unresolved;
      result.stopped_early = settled.unresolved > 0;
      return result;
    } else if (executionSelection) {
      const quarantined =
        await quarantineUnselectedPendingRepairSubmissions({
          plan,
          selection: executionSelection,
          checkpointStore: options.checkpointStore,
        });
      result.quarantined_pending_actions = quarantined.length;
    }
  }
  const recovered = options.apply && executionPhase === "SUBMIT_AND_SETTLE"
    ? await recoverPendingRepairSettlements({
        plan,
        gateway: coordinatedGateway,
        checkpointStore: options.checkpointStore,
        mediaEquivalence,
        skus: entries.map((entry) => entry.sku),
        actionIds: executionSelection ? selectedActionIds : null,
        attempts: settlementAttempts,
        delayMs: settlementDelayMs,
        stableReads: settlementStableReads,
        sleep,
      })
    : [];
  const recoveredByAction = new Map(
    recovered.map((outcome) => [outcome.action_id, outcome]),
  );
  const completed = await options.checkpointStore.verifiedActionIds();

  outer: for (const entry of entries) {
    for (const action of entry.actions) {
      const actionGateway = executionSelection
        ? guardRepairGatewayActionPatchPaths(coordinatedGateway, entry, action)
        : coordinatedGateway;
      try {
        const recoveredSettlement = recoveredByAction.get(action.action_id);
        if (recoveredSettlement) {
          result.recovered_pending_actions++;
          if (recoveredSettlement.state === "DESIRED") {
            result.resumed_actions++;
            continue;
          }
          if (recoveredSettlement.state === "UNRESOLVED") {
            result.unresolved_settlements++;
            throw new SettlementGuardError(
              `Pending Amazon submission ${action.action_id} remains unresolved; no new PATCH was attempted.`,
            );
          }
          throw new SettlementGuardError(
            `Pending Amazon submission ${action.action_id} remains open after ${recoveredSettlement.state}; this invocation will not fallback or resubmit it.`,
          );
        }
        let live = await actionGateway.getListing(entry.store_index, entry.sku);
        let productType = requestedProductType(
          action,
          listingIdentity(entry, live),
        );
        let existingState = await verifyActionState(action, live, mediaEquivalence);
        let resumedStrategy: "PRIMARY" | "REVIEWED_FALLBACK" = "PRIMARY";
        if (completed.has(action.action_id) && !existingState.ok) {
          const reviewedFallback = fallbackAction(action);
          if (reviewedFallback) {
            const fallbackState = await verifyActionState(
              reviewedFallback,
              live,
              mediaEquivalence,
            );
            if (fallbackState.ok) {
              existingState = fallbackState;
              resumedStrategy = "REVIEWED_FALLBACK";
            }
          }
        }
        if (existingState.ok) {
          await options.checkpointStore.append({
            action_id: action.action_id,
            sku: entry.sku,
            kind: action.kind,
            status: "ALREADY_APPLIED",
            detail: {
              checks: existingState.checks,
              ...(completed.has(action.action_id)
                ? {
                    resumed_checkpoint_revalidated: true,
                    resumed_strategy: resumedStrategy,
                  }
                : {}),
            },
          });
          if (completed.has(action.action_id)) {
            result.resumed_actions++;
          } else {
            result.already_applied_actions++;
          }
          continue;
        }

        let patches = buildActionPatches(action, live);
        if (patches.length === 0) throw new Error("Action produced no patches.");
        if (options.validationOnly) {
          const previewSet = buildValidationPreviewPatchSet(
            patches,
            action.kind,
          );
          const preview = await actionGateway.patchListing(
            entry.store_index,
            entry.sku,
            productType,
            previewSet.preview_patches,
            true,
            validationPreviewGatewayContext(previewSet, "FORWARD_OFFER"),
          );
          if (preview.status !== "VALID" || hasBlockingIssues(preview)) {
            throw new Error(
              `VALIDATION_PREVIEW rejected ${action.action_id}: ${JSON.stringify(responseDetail(preview))}`,
            );
          }
          await options.checkpointStore.append({
            action_id: action.action_id,
            sku: entry.sku,
            kind: action.kind,
            status: "PREVIEW_VALID",
            detail: {
              validation_only: true,
              ...validationPreviewCheckpointDetail(previewSet),
              ...responseDetail(preview),
            },
          });
          const reviewedFallback = fallbackAction(action);
          if (reviewedFallback) {
            await sleep(requestDelayMs);
            const fallbackPatches = buildActionPatches(reviewedFallback, live);
            const fallbackPreview = await actionGateway.patchListing(
              entry.store_index,
              entry.sku,
              requestedProductType(reviewedFallback, listingIdentity(entry, live)),
              fallbackPatches,
              true,
            );
            if (
              fallbackPreview.status !== "VALID" ||
              hasBlockingIssues(fallbackPreview)
            ) {
              throw new Error(
                `Fallback VALIDATION_PREVIEW rejected ${action.action_id}: ${JSON.stringify(responseDetail(fallbackPreview))}`,
              );
            }
            await options.checkpointStore.append({
              action_id: action.action_id,
              sku: entry.sku,
              kind: action.kind,
              status: "PREVIEW_VALID",
              detail: {
                validation_only: true,
                strategy: "REVIEWED_FALLBACK",
                patch_sha256: patchDigest(fallbackPatches),
                patch_paths: fallbackPatches.map((patch) => patch.path),
                ...responseDetail(fallbackPreview),
              },
            });
          }
          result.preview_valid_actions++;
          await sleep(requestDelayMs);
          continue;
        }
        let guarded = false;
        let guardedPreviewSet: ValidationPreviewPatchSet | null = null;
        for (let guardAttempt = 1; guardAttempt <= 2; guardAttempt++) {
          const previewSet = buildValidationPreviewPatchSet(
            patches,
            action.kind,
          );
          const preview = await actionGateway.patchListing(
            entry.store_index,
            entry.sku,
            productType,
            previewSet.preview_patches,
            true,
            validationPreviewGatewayContext(previewSet, "FORWARD_OFFER"),
          );
          if (preview.status !== "VALID" || hasBlockingIssues(preview)) {
            throw new Error(
              `VALIDATION_PREVIEW rejected ${action.action_id}: ${JSON.stringify(responseDetail(preview))}`,
            );
          }
          await options.checkpointStore.append({
            action_id: action.action_id,
            sku: entry.sku,
            kind: action.kind,
            status: "PREVIEW_VALID",
            detail: {
              guard_attempt: guardAttempt,
              ...validationPreviewCheckpointDetail(previewSet),
              ...responseDetail(preview),
            },
          });

          await sleep(requestDelayMs);
          live = await actionGateway.getListing(entry.store_index, entry.sku);
          productType = requestedProductType(
            action,
            listingIdentity(entry, live),
          );
          const nowApplied = await verifyActionState(action, live, mediaEquivalence);
          if (nowApplied.ok) {
            await options.checkpointStore.append({
              action_id: action.action_id,
              sku: entry.sku,
              kind: action.kind,
              status: "ALREADY_APPLIED",
              detail: { checks: nowApplied.checks, after_preview: true },
            });
            result.already_applied_actions++;
            guarded = false;
            patches = [];
            break;
          }
          const freshPatches = buildActionPatches(action, live);
          if (patchDigest(freshPatches) === patchDigest(patches)) {
            guarded = true;
            guardedPreviewSet = previewSet;
            break;
          }
          patches = freshPatches;
        }
        if (patches.length === 0) continue;
        if (!guarded) {
          throw new Error(
            `Live attributes changed during preview twice for ${action.action_id}; refusing stale PATCH.`,
          );
        }
        if (
          !guardedPreviewSet ||
          patchDigest(guardedPreviewSet.actual_patches) !== patchDigest(patches)
        ) {
          throw new Error(
            `Preview evidence is not bound to the actual PATCH for ${action.action_id}.`,
          );
        }

        await sleep(requestDelayMs);
        // Capture and seal the exact action-path state immediately before the
        // real PATCH. This is also a second stale-preview guard; the actual
        // request bytes and the immutable repair plan remain unchanged.
        live = await actionGateway.getListing(entry.store_index, entry.sku);
        productType = requestedProductType(
          action,
          listingIdentity(entry, live),
        );
        const immediatelyApplied = await verifyActionState(
          action,
          live,
          mediaEquivalence,
        );
        if (immediatelyApplied.ok) {
          await options.checkpointStore.append({
            action_id: action.action_id,
            sku: entry.sku,
            kind: action.kind,
            status: "ALREADY_APPLIED",
            detail: {
              checks: immediatelyApplied.checks,
              immediately_before_write: true,
            },
          });
          result.already_applied_actions++;
          continue;
        }
        const immediatelyFreshPatches = buildActionPatches(action, live);
        if (
          patchDigest(immediatelyFreshPatches) !== patchDigest(patches) ||
          patchDigest(guardedPreviewSet.actual_patches) !==
            patchDigest(immediatelyFreshPatches)
        ) {
          throw new Error(
            `Forward payload changed after preview for ${action.action_id}; refusing an unpreviewed PATCH.`,
          );
        }
        patches = immediatelyFreshPatches;
        const exactSettlementEvidence = settlementEvidence(live, patches);
        const launchAuthorizationBodySha256 =
          assertCurrentLaunchOfferAuthorization(action);
        const armedCheckpoint = await options.checkpointStore.append({
          action_id: action.action_id,
          sku: entry.sku,
          kind: action.kind,
          status: "SUBMISSION_ARMED",
          detail: {
            strategy: "PRIMARY",
            crash_window_guard: true,
            settlement_guard: exactSettlementEvidence,
            ...(launchAuthorizationBodySha256
              ? {
                  launch_execution_authorization_body_sha256:
                    launchAuthorizationBodySha256,
                }
              : {}),
          },
        });
        const patchAuthorizationBodySha256 =
          assertCurrentLaunchOfferAuthorization(action);
        if (
          patchAuthorizationBodySha256 !== launchAuthorizationBodySha256
        ) {
          throw new Error(
            `Launch execution authorization changed between arming and PATCH for ${action.action_id}. No Amazon call was made.`,
          );
        }
        let physicalMutationGuardCalled = false;
        const physicalMutationGuardRequired =
          launchAuthorizationBodySha256 != null ||
          actionGateway.physicalMutationGuardContract ===
            "CALL_IMMEDIATELY_BEFORE_REQUEST_V1";
        const submitted = await actionGateway.patchListing(
          entry.store_index,
          entry.sku,
          productType,
          patches,
          false,
          undefined,
          (physicalContext) => {
            if (
              physicalContext.store_index !== entry.store_index ||
              physicalContext.marketplace_id !== MARKETPLACE_ID ||
              typeof physicalContext.amazon_merchant_id !== "string" ||
              physicalContext.amazon_merchant_id.trim().length === 0
            ) {
              throw new Error(
                `Physical Amazon account context does not match the selected listing for ${action.action_id}. No Amazon call was made.`,
              );
            }
            // Launch authorization is an OFFER-only contract. MEDIA/content/
            // structured writes still receive the immediate physical store +
            // marketplace guard above, but must never require pricing runtime.
            if (action.kind === "OFFER") {
              const runtime = options.launchExecutionAuthorization;
              if (
                !runtime ||
                physicalContext.store_index !==
                  runtime.authorization.account.store_index ||
                physicalContext.marketplace_id !==
                  runtime.authorization.account.marketplace_id ||
                physicalContext.amazon_merchant_id !==
                  runtime.authorization.account.amazon_merchant_id
              ) {
                throw new Error(
                  `Physical Amazon account does not match launch authorization for ${action.action_id}. No Amazon call was made.`,
                );
              }
              const physicalRequestAuthorizationBodySha256 =
                assertCurrentLaunchOfferAuthorization(action);
              if (
                physicalRequestAuthorizationBodySha256 !==
                patchAuthorizationBodySha256
              ) {
                throw new Error(
                  `Launch execution authorization changed before the physical request for ${action.action_id}. No Amazon call was made.`,
                );
              }
            }
            physicalMutationGuardCalled = true;
          },
        );
        if (
          physicalMutationGuardRequired &&
          !physicalMutationGuardCalled
        ) {
          throw new Error(
            `Gateway did not invoke the physical mutation guard for ${action.action_id}; submission state is unsafe.`,
          );
        }
        if (
          !["ACCEPTED", "IN_PROGRESS"].includes(String(submitted.status ?? "")) ||
          hasBlockingIssues(submitted)
        ) {
          throw new Error(
            `Amazon did not accept ${action.action_id}: ${JSON.stringify(responseDetail(submitted))}`,
          );
        }
        const submittedCheckpoint = await options.checkpointStore.append({
          action_id: action.action_id,
          sku: entry.sku,
          kind: action.kind,
          status: "SUBMITTED",
          detail: {
            strategy: "PRIMARY",
            armed_event_id: armedCheckpoint.event_id,
            ...validationPreviewCheckpointDetail(guardedPreviewSet),
            settlement_guard: exactSettlementEvidence,
            ...(patchAuthorizationBodySha256
              ? {
                  launch_execution_authorization_body_sha256:
                    patchAuthorizationBodySha256,
                }
              : {}),
            ...responseDetail(submitted),
          },
        });
        if (executionPhase === "SUBMIT_ONLY") {
          // Deliberately stop this action at persistent SUBMITTED evidence.
          // Settlement is a separate GET-only invocation; no post-write GET or
          // retrying PATCH is reachable from this branch.
          result.submitted_actions++;
          continue;
        }
        const finalVerification = await verifySubmittedActionSettlement({
          entry,
          action,
          gateway: actionGateway,
          checkpointStore: options.checkpointStore,
          mediaEquivalence,
          evidence: exactSettlementEvidence,
          submittedEventId: submittedCheckpoint.event_id,
          strategy: "PRIMARY",
          requestDelayMs,
          verifyAttempts,
          verifyDelayMs,
          settlementAttempts,
          settlementDelayMs,
          settlementStableReads,
          sleep,
        });
        await options.checkpointStore.append({
          action_id: action.action_id,
          sku: entry.sku,
          kind: action.kind,
          status: "VERIFIED",
          detail: { checks: finalVerification.checks },
        });
        result.verified_actions++;
      } catch (error) {
        let finalError: unknown = error;
        const reviewedFallback =
          error instanceof PostGetVerificationError ? fallbackAction(action) : null;
        if (reviewedFallback) {
          const primaryError = error as PostGetVerificationError;
          await options.checkpointStore.append({
            action_id: action.action_id,
            sku: entry.sku,
            kind: action.kind,
            status: "FAILED",
            detail: {
              strategy: "PRIMARY",
              error: primaryError.message,
              checks: primaryError.verification?.checks ?? [],
              fallback_authorized: true,
            },
          });
          try {
            const fallbackVerification = await executeFallbackAction({
              entry,
              action: reviewedFallback,
              gateway: actionGateway,
              checkpointStore: options.checkpointStore,
              mediaEquivalence,
              requestDelayMs,
              verifyAttempts,
              verifyDelayMs,
              settlementAttempts,
              settlementDelayMs,
              settlementStableReads,
              sleep,
            });
            await options.checkpointStore.append({
              action_id: action.action_id,
              sku: entry.sku,
              kind: action.kind,
              status: "VERIFIED",
              detail: {
                strategy: "REVIEWED_FALLBACK",
                checks: fallbackVerification.checks,
              },
            });
            result.verified_actions++;
            continue;
          } catch (fallbackError) {
            finalError = fallbackError;
          }
        }
        result.failed_actions++;
        await options.checkpointStore.append({
          action_id: action.action_id,
          sku: entry.sku,
          kind: action.kind,
          status: "FAILED",
          detail: {
            error:
              finalError instanceof Error ? finalError.message : String(finalError),
            ...(reviewedFallback ? { strategy: "REVIEWED_FALLBACK" } : {}),
          },
        });
        if (finalError instanceof SettlementGuardError) {
          result.unresolved_settlements++;
          result.stopped_early = true;
          break outer;
        }
        if (result.failed_actions >= maxErrors) {
          result.stopped_early = true;
          break outer;
        }
      }
    }
  }
    return result;
  } finally {
    try {
      if (
        mutationFenceClaimed &&
        !(await options.checkpointStore.hasGlobalPendingSubmissions())
      ) {
        await options.checkpointStore.releasePendingMutationFence();
      }
    } finally {
      await releaseExecutionLease?.();
    }
  }
}

function runtimeSelectionContainsOffer(
  plan: UncrustablesRepairPlan,
  options: ExecuteRepairOptions,
): boolean {
  const selection = options.executionSelection ?? null;
  if (selection) {
    verifyRepairExecutionSelection(plan, selection);
    const selected = new Set(selection.selected_action_ids);
    return plan.entries.some((entry) =>
      entry.actions.some(
        (action) => action.kind === "OFFER" && selected.has(action.action_id),
      ),
    );
  }
  const requested = options.skus?.length
    ? new Set(options.skus.map((sku) => sku.trim()).filter(Boolean))
    : null;
  let entries = plan.entries.filter(
    (entry) => !requested || requested.has(entry.sku),
  );
  if (options.limit != null) entries = entries.slice(0, options.limit);
  return entries.some((entry) =>
    entry.actions.some((action) => action.kind === "OFFER"),
  );
}

/** Canonical executor. Legacy OFFER plans remain readable/settleable, but no
 * direct caller can mutate them after the launch-specific safety contract was
 * introduced. */
export async function executeRepairPlan(
  plan: UncrustablesRepairPlan,
  gateway: RepairAmazonGateway,
  options: ExecuteRepairOptions,
): Promise<ExecuteRepairResult> {
  verifyRepairPlan(plan);
  if (
    options.apply &&
    !plan.launch_pricing_source &&
    runtimeSelectionContainsOffer(plan, options)
  ) {
    throw new Error(
      "Legacy OFFER writes are disabled in the canonical executor: build a launch-aware plan with current ChannelMAX+Coupon authorization. No Amazon call was made.",
    );
  }
  return executeRepairPlanInternal(plan, gateway, options);
}

/** @internal Unit tests for pre-launch checkpoint mechanics only. The runtime
 * guard makes an accidental production import fail before any gateway call. */
export async function __testOnlyExecuteRepairPlanLegacyUnsafe(
  plan: UncrustablesRepairPlan,
  gateway: RepairAmazonGateway,
  options: ExecuteRepairOptions,
): Promise<ExecuteRepairResult> {
  if (!process.env.NODE_TEST_CONTEXT) {
    throw new Error(
      "The legacy unsafe executor is available only inside the Node test runner. No Amazon call was made.",
    );
  }
  return executeRepairPlanInternal(plan, gateway, options);
}
