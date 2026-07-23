import { createHash } from "node:crypto";

import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "@/lib/sourcing/canonical-product-match-provenance";

export const PRODUCT_TRUTH_LISTING_MANIFEST_SCHEMA =
  "product-truth-listing-manifest/1.1.0" as const;
export const WALMART_PUBLIC_CONTRACT_SCHEMA =
  "walmart-mp-item-public/1.0.0" as const;
export const WALMART_PREPUBLICATION_EVIDENCE_SCHEMA =
  "walmart-prepublication-evidence/1.2.0" as const;
export const MARKETPLACE_DISTRIBUTION_APPROVAL_SCHEMA =
  "marketplace-distribution-approval/1.0.0" as const;

export interface ProductTruthPriceEvidence {
  role: "PRICE";
  observation_id: string;
  donor_offer_id: string;
  match_tier: "EXACT_IDENTITY";
  retailer: string;
  source_url: string;
  observed_at: string;
  locality_evidence: "zip_scoped" | "store_scoped";
  zip: string | null;
  first_party: true;
  in_stock: true;
  package_price: number;
  pack_size_seen: number;
  price_per_unit: number;
}

export interface ProductTruthRecipeComponentEvidence {
  component_key: string;
  donor_product_id: string;
  canonical_variant_id: string;
  variant_decision_id: string;
  product_name: string;
  manufacturer_brand: string;
  manufacturer_upc: string | null;
  flavor: string | null;
  qty: number;
  content_role: "EXACT";
  content_observation_id: string;
  content_source_url: string;
  content_captured_at: string;
  matcher_version: string;
  matcher_implementation_sha256: string;
  matcher_release_sha256: string;
  facts: {
    ingredients: string | null;
    allergens: unknown;
    nutrition_facts: unknown;
    attributes: Record<string, unknown>;
  };
  price_evidence: ProductTruthPriceEvidence;
}

export type ProductTruthImageRightsBasis =
  | "OWNED"
  | "LICENSED"
  | "SOURCE_ALLOWED"
  | "AI_DERIVED_FROM_RIGHTS_CLEARED_INPUTS";

export interface ProductTruthListingImageEvidence {
  role: "MAIN" | "SECONDARY" | "NUTRITION";
  url: string;
  depicted_component_keys: string[];
  source_content_observation_ids: string[];
  represented_unit_count: number;
  rights_basis: ProductTruthImageRightsBasis;
  rights_evidence_ref: string;
  reviewed_at: string;
}

export interface ProductTruthListingManifest {
  schema_version: typeof PRODUCT_TRUTH_LISTING_MANIFEST_SCHEMA;
  listing_scope: {
    channel: "WALMART";
    store_index: number;
    sku: string;
  };
  verified_at: string;
  recipe_hash: string;
  components: ProductTruthRecipeComponentEvidence[];
  images: ProductTruthListingImageEvidence[];
}

export function assertCurrentProductTruthMatcherProvenance(
  components: ReadonlyArray<ProductTruthRecipeComponentEvidence>,
): void {
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error("Product Truth matcher provenance requires recipe components");
  }
  for (const [index, component] of components.entries()) {
    const mismatches = [
      component.matcher_version === CANONICAL_PRODUCT_MATCHER_VERSION
        ? null
        : "matcher_version",
      component.matcher_implementation_sha256 === CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256
        ? null
        : "matcher_implementation_sha256",
      component.matcher_release_sha256 === CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256
        ? null
        : "matcher_release_sha256",
    ].filter((field): field is string => field !== null);
    if (mismatches.length > 0) {
      const componentKey = component.component_key?.trim() || `component[${index}]`;
      throw new Error(
        `${componentKey}: Product Truth matcher provenance is not current (${mismatches.join(", ")})`,
      );
    }
  }
}

export interface WalmartPublicListingContract {
  contract_version: typeof WALMART_PUBLIC_CONTRACT_SCHEMA;
  spec_version: string;
  spec_schema_hash: string;
  spec_fetched_at: string;
  product_type: string;
  country_of_origin_substantial_transformation: string;
  secondary_image_urls: string[];
  public_attributes: Record<string, unknown>;
  offer_handoff:
    | {
        mode: "INLINE";
        quantity: number;
        fulfillment_center_id: string;
        fulfillment_lag_time: number;
      }
    | {
        mode: "STAGED_AFTER_ITEM_SETUP";
        quantity: number;
        fulfillment_center_id: string;
        fulfillment_lag_time: number;
      };
}

export interface WalmartPrepublicationEvidence {
  schema_version: typeof WALMART_PREPUBLICATION_EVIDENCE_SCHEMA;
  policy_version: string;
  generated_at: string;
  store_index: number;
  sku: string;
  catalog_search: {
    searched_at: string;
    query_gtin: string;
    result: "EXACT_MATCH" | "NO_EXACT_MATCH";
    setup_method: "MATCH_EXISTING" | "FULL_ITEM";
    walmart_item_id: string | null;
    evidence_ref: string;
  };
  seller_account_health: {
    status: "HEALTHY_AND_ACCEPTING_NEW_ITEMS";
    store_index: number;
    seller_account_fingerprint_sha256: string;
    verified_at: string;
    evidence_ref: string;
  };
  fulfillment_compliance: {
    method: "SELLER_FULFILLED";
    inventory_owned_by_seller: true;
    direct_retailer_fulfillment: false;
    competitor_branded_packaging: false;
    third_party_promotional_materials: false;
    fulfillment_center_id: string;
    fulfillment_lag_time: number;
    lag_exemption_status: "NOT_REQUIRED" | "APPROVED";
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
    basis: "BRAND_OWNER" | "AUTHORIZED_RESELLER" | "LEGITIMATE_RESALE";
    verified_at: string;
    evidence_ref: string;
  };
  product_identifier: {
    identifier_type: "UPC";
    value: string;
    checksum_valid: true;
    pool_acquired_from: string;
    pool_recorded_owner: string;
    registry_status: "VERIFIED";
    registry_registrant_name: string;
    aligned_brand: string;
    brand_alignment_status: "VERIFIED";
    seller_account_fingerprint_sha256: string;
    seller_assignment_authority_status: "VERIFIED";
    verified_at: string;
    evidence_ref: string;
  };
  condition: { value: "New"; verified_at: string };
  expiration: {
    applicable: boolean;
    shelf_life_days: number | null;
    minimum_days_remaining_at_ship: number | null;
    lot_check_procedure_ref: string | null;
    source_ref: string;
    verified_at: string;
  };
  item_spec: {
    feed_type: "MP_ITEM" | "MP_ITEM_MATCH";
    version: string;
    product_type: string;
    retrieved_at: string;
    schema_sha256: string;
    attributes_sha256: string;
    required_attributes: string[];
    missing_required_attributes: string[];
    validation_status: "PASSED";
  };
}

export interface MarketplaceDistributionApproval {
  schema_version: typeof MARKETPLACE_DISTRIBUTION_APPROVAL_SCHEMA;
  approved_at: string;
  approved_by: string;
  channel_sku_id: string;
  publishable_content_sha256: string;
  marketplace_payload_sha256: string;
  product_truth_recipe_hash: string;
  walmart_prepublication_sha256: string;
  validation_run_id: string;
}

export interface WalmartListingAttributeRoot extends Record<string, unknown> {
  product_truth_manifest?: ProductTruthListingManifest;
  walmart?: WalmartPublicListingContract;
  walmart_prepublication?: WalmartPrepublicationEvidence;
  distribution_approval?: MarketplaceDistributionApproval;
}

export interface PublishableWalmartSkuInput {
  id: string;
  sku: string;
  channel: string;
  validation_check_id: string | null;
  upc: string;
  title: string;
  bullets: string;
  description: string;
  price_cents: number;
  main_image_url: string | null;
  package_weight_oz: number | null;
  package_length_in: number | null;
  package_width_in: number | null;
  package_height_in: number | null;
  attributes: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function stableWalmartJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function sha256WalmartJson(value: unknown): string {
  return createHash("sha256").update(stableWalmartJson(value)).digest("hex");
}

export function parseWalmartListingAttributes(
  raw: string | Record<string, unknown>,
): WalmartListingAttributeRoot {
  const parsed = typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ChannelSKU.attributes must be a JSON object");
  }
  return parsed as WalmartListingAttributeRoot;
}

export function computeProductTruthRecipeHash(
  components: ReadonlyArray<Pick<
    ProductTruthRecipeComponentEvidence,
    "component_key" | "canonical_variant_id" | "qty"
  >>,
): string {
  return sha256WalmartJson(
    [...components]
      .map((component) => ({
        component_key: component.component_key.trim(),
        canonical_variant_id: component.canonical_variant_id.trim(),
        qty: component.qty,
      }))
      .sort((left, right) => left.component_key.localeCompare(right.component_key, "en-US")),
  );
}

function publicAttributesWithoutApproval(raw: string): WalmartListingAttributeRoot {
  const attributes = parseWalmartListingAttributes(raw);
  const withoutApproval = { ...attributes };
  delete withoutApproval.distribution_approval;
  return withoutApproval;
}

export function computePublishableWalmartSkuHash(
  sku: PublishableWalmartSkuInput,
): string {
  return sha256WalmartJson({
    id: sku.id,
    sku: sku.sku,
    channel: sku.channel,
    upc: sku.upc,
    title: sku.title,
    bullets: JSON.parse(sku.bullets) as unknown,
    description: sku.description,
    price_cents: sku.price_cents,
    main_image_url: sku.main_image_url,
    package_weight_oz: sku.package_weight_oz,
    package_length_in: sku.package_length_in,
    package_width_in: sku.package_width_in,
    package_height_in: sku.package_height_in,
    attributes: publicAttributesWithoutApproval(sku.attributes),
  });
}

export function buildProductTruthListingManifest(input: {
  sku: string;
  storeIndex: number;
  verifiedAt: Date;
  packCount: number;
  components: ProductTruthRecipeComponentEvidence[];
  images: ProductTruthListingImageEvidence[];
}): ProductTruthListingManifest {
  if (!input.sku.trim()) throw new Error("Walmart SKU is required");
  if (!Number.isInteger(input.storeIndex) || input.storeIndex <= 0) {
    throw new Error("Walmart storeIndex must be a positive integer");
  }
  if (!Number.isInteger(input.packCount) || input.packCount <= 0) {
    throw new Error("packCount must be a positive integer");
  }
  if (input.components.length === 0) throw new Error("recipe components are required");
  assertCurrentProductTruthMatcherProvenance(input.components);
  const componentKeys = new Set<string>();
  const observationIds = new Set<string>();
  let total = 0;
  for (const component of input.components) {
    if (!component.component_key.trim() || componentKeys.has(component.component_key)) {
      throw new Error("component_key must be non-empty and unique");
    }
    componentKeys.add(component.component_key);
    if (!Number.isInteger(component.qty) || component.qty <= 0) {
      throw new Error(`${component.component_key}: qty must be a positive integer`);
    }
    total += component.qty;
    if (component.content_role !== "EXACT") {
      throw new Error(`${component.component_key}: content_role must be EXACT`);
    }
    if (
      !component.canonical_variant_id.trim() ||
      !component.variant_decision_id.trim() ||
      !component.content_observation_id.trim()
    ) {
      throw new Error(`${component.component_key}: exact identity/content evidence is incomplete`);
    }
    observationIds.add(component.content_observation_id);
    if (
      component.price_evidence.match_tier !== "EXACT_IDENTITY" ||
      component.price_evidence.first_party !== true ||
      component.price_evidence.in_stock !== true
    ) {
      throw new Error(`${component.component_key}: pilot price evidence must be exact first-party in-stock`);
    }
  }
  if (total !== input.packCount) {
    throw new Error(`recipe total ${total} does not equal packCount ${input.packCount}`);
  }

  const main = input.images.filter((image) => image.role === "MAIN");
  if (main.length !== 1) throw new Error("exactly one MAIN image evidence row is required");
  for (const image of input.images) {
    if (!Number.isInteger(image.represented_unit_count) || image.represented_unit_count <= 0) {
      throw new Error(`${image.role}: represented_unit_count must be positive`);
    }
    if (image.source_content_observation_ids.some((id) => !observationIds.has(id))) {
      throw new Error(`${image.role}: image references content outside the exact recipe`);
    }
    if (image.depicted_component_keys.some((key) => !componentKeys.has(key))) {
      throw new Error(`${image.role}: image references an unknown component`);
    }
  }
  if (main[0].represented_unit_count !== input.packCount) {
    throw new Error("MAIN image represented count does not equal packCount");
  }

  const recipeHash = computeProductTruthRecipeHash(input.components);
  return {
    schema_version: PRODUCT_TRUTH_LISTING_MANIFEST_SCHEMA,
    listing_scope: {
      channel: "WALMART",
      store_index: input.storeIndex,
      sku: input.sku,
    },
    verified_at: input.verifiedAt.toISOString(),
    recipe_hash: recipeHash,
    components: input.components,
    images: input.images,
  };
}

export function mergeWalmartListingContracts(
  rawAttributes: string | Record<string, unknown>,
  input: {
    productTruth: ProductTruthListingManifest;
    walmart: WalmartPublicListingContract;
    prepublication?: WalmartPrepublicationEvidence;
  },
): string {
  const current = parseWalmartListingAttributes(rawAttributes);
  const withoutApproval = { ...current };
  delete withoutApproval.distribution_approval;
  return stableWalmartJson({
    ...withoutApproval,
    product_truth_manifest: input.productTruth,
    walmart: input.walmart,
    ...(input.prepublication ? { walmart_prepublication: input.prepublication } : {}),
  });
}

export function sealWalmartDistributionApproval(input: {
  sku: PublishableWalmartSkuInput;
  approvedAt: Date;
  approvedBy: string;
  validationRunId: string;
  marketplacePayloadSha256: string;
}): { attributes: string; approval: MarketplaceDistributionApproval } {
  const validationRunId = input.validationRunId.trim();
  if (
    !input.sku.validation_check_id?.trim() ||
    input.sku.validation_check_id !== validationRunId
  ) {
    throw new Error(
      "Walmart distribution approval must bind the current ChannelSKU validation run",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(input.marketplacePayloadSha256)) {
    throw new Error("Walmart marketplace payload SHA-256 is required for approval");
  }
  const root = parseWalmartListingAttributes(input.sku.attributes);
  const truth = root.product_truth_manifest;
  const prepublication = root.walmart_prepublication;
  if (truth?.schema_version !== PRODUCT_TRUTH_LISTING_MANIFEST_SCHEMA) {
    throw new Error("Product Truth manifest is missing or unsupported");
  }
  assertCurrentProductTruthMatcherProvenance(truth.components);
  if (prepublication?.schema_version !== WALMART_PREPUBLICATION_EVIDENCE_SCHEMA) {
    throw new Error("Walmart prepublication evidence is missing or unsupported");
  }
  if (truth.listing_scope.sku !== input.sku.sku) {
    throw new Error("Product Truth manifest SKU does not match ChannelSKU");
  }
  const approval: MarketplaceDistributionApproval = {
    schema_version: MARKETPLACE_DISTRIBUTION_APPROVAL_SCHEMA,
    approved_at: input.approvedAt.toISOString(),
    approved_by: input.approvedBy.trim(),
    channel_sku_id: input.sku.id,
    publishable_content_sha256: computePublishableWalmartSkuHash(input.sku),
    marketplace_payload_sha256: input.marketplacePayloadSha256,
    product_truth_recipe_hash: truth.recipe_hash,
    walmart_prepublication_sha256: sha256WalmartJson(prepublication),
    validation_run_id: validationRunId,
  };
  if (!approval.approved_by || !approval.validation_run_id.trim()) {
    throw new Error("Approval actor and validation run are required");
  }
  return {
    approval,
    attributes: stableWalmartJson({ ...root, distribution_approval: approval }),
  };
}

export function assertValidWalmartDistributionApproval(
  sku: PublishableWalmartSkuInput,
): MarketplaceDistributionApproval {
  const root = parseWalmartListingAttributes(sku.attributes);
  const approval = root.distribution_approval;
  const truth = root.product_truth_manifest;
  const prepublication = root.walmart_prepublication;
  if (approval?.schema_version !== MARKETPLACE_DISTRIBUTION_APPROVAL_SCHEMA) {
    throw new Error("Walmart distribution approval is missing or unsupported");
  }
  if (truth?.schema_version !== PRODUCT_TRUTH_LISTING_MANIFEST_SCHEMA) {
    throw new Error("Product Truth manifest is missing or unsupported");
  }
  assertCurrentProductTruthMatcherProvenance(truth.components);
  if (approval.channel_sku_id !== sku.id) {
    throw new Error("Walmart distribution approval targets another ChannelSKU");
  }
  if (!/^[a-f0-9]{64}$/.test(approval.marketplace_payload_sha256)) {
    throw new Error("Walmart distribution approval payload hash is missing");
  }
  if (
    !sku.validation_check_id?.trim() ||
    approval.validation_run_id !== sku.validation_check_id
  ) {
    throw new Error(
      "Walmart distribution approval does not bind the current validation run",
    );
  }
  if (approval.product_truth_recipe_hash !== truth.recipe_hash) {
    throw new Error("Walmart distribution approval Product Truth hash mismatch");
  }
  if (
    !prepublication ||
    approval.walmart_prepublication_sha256 !== sha256WalmartJson(prepublication)
  ) {
    throw new Error("Walmart distribution approval prepublication hash mismatch");
  }
  if (approval.publishable_content_sha256 !== computePublishableWalmartSkuHash(sku)) {
    throw new Error("Walmart publishable content changed after approval");
  }
  return approval;
}
