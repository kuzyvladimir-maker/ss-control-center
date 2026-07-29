import { createHash } from "node:crypto";

import type { Client, Row, Transaction } from "@libsql/client";

import {
  CANONICAL_PRODUCT_MATCHER_VERSION,
  type CanonicalProductIdentity,
} from "./canonical-product-match";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
} from "./canonical-product-match-provenance";
import { buildCanonicalProductVariantKey } from "./canonical-product-variant";
import {
  normalizeProductTruthBridgeGtin,
  PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION,
  PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION,
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  productTruthLegacyBridgeBytesSha256,
  renderProductTruthLegacyBridgePlan,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeComponentRow,
  type ProductTruthLegacyBridgeComponentPlan,
  type ProductTruthLegacyBridgeDonorRow,
  type ProductTruthLegacyBridgeListingRow,
  type ProductTruthLegacyBridgeOfferRow,
  type ProductTruthLegacyBridgePlan,
  type ProductTruthLegacyBridgeSnapshot,
} from "./product-truth-legacy-bridge";
import {
  PRODUCT_TRUTH_LISTING_KEY_VERSION,
  SKU_COST_LISTING_SCOPE_LINK_VERSION,
} from "./product-truth-listing-scope";
import {
  buildProductTruthListingRecipeMaterialization,
  type ProductTruthListingRecipeComponentRow,
  type ProductTruthListingRecipeRow,
} from "./product-truth-listing-recipe";
import {
  readProductTruthSnapshotsInTransaction,
} from "./product-truth-read-contract";
import {
  assertProductTruthEvidenceSchema,
  assertProductTruthListingScopeSchema,
} from "./product-truth-schema-gate";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  PRICE_EVIDENCE_POLICY_VERSION,
  PRODUCT_TRUTH_PROCUREMENT_ZIP,
} from "./price-evidence-policy";

export const PRODUCT_TRUTH_LEGACY_BRIDGE_APPLY_PLAN_VERSION =
  "product-truth-legacy-bridge-apply-plan/3.3.0" as const;
export const PRODUCT_TRUTH_LEGACY_BRIDGE_APPROVAL_VERSION =
  "product-truth-legacy-bridge-approval/2.0.0" as const;
export const PRODUCT_TRUTH_LEGACY_BRIDGE_APPLY_REPORT_VERSION =
  "product-truth-legacy-bridge-apply-report/3.4.0" as const;
export const PRODUCT_TRUTH_LEGACY_BRIDGE_PREFLIGHT_REPORT_VERSION =
  "product-truth-legacy-bridge-preflight-report/2.2.0" as const;
export const PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION =
  "product-truth-legacy-bridge-standing-policy/1.0.0" as const;
export const PRODUCT_TRUTH_LEGACY_BRIDGE_CONTENT_VERSION =
  "product-content-observation/1.3.0" as const;
export const PRODUCT_TRUTH_LEGACY_BRIDGE_WAVE_MAX_LISTINGS = 50 as const;
export const PRODUCT_TRUTH_LEGACY_BRIDGE_MATERIALIZATION_SOURCE =
  "legacy-materialized-bridge" as const;

type SqlReader = Pick<Client, "execute"> | Pick<Transaction, "execute">;
const CANONICAL_VARIANT_REUSE_IGNORED_COLUMNS = new Set(["createdAt"]);

export class ProductTruthLegacyBridgeApplyError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthLegacyBridgeApplyError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthLegacyBridgeApplyError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("LEGACY_BRIDGE_APPLY_INPUT_INVALID", `${label} must be a lowercase SHA-256`);
  }
  return value;
}

function exactText(value: unknown, label: string, maximum = 500): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
  ) {
    fail(
      "LEGACY_BRIDGE_APPLY_INPUT_INVALID",
      `${label} must be 1-${maximum} exact characters`,
    );
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  const text = exactText(value, label, 80);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    fail("LEGACY_BRIDGE_APPLY_INPUT_INVALID", `${label} must include a timezone`);
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    fail("LEGACY_BRIDGE_APPLY_INPUT_INVALID", `${label} must be a valid timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function parseJson(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function evidenceValue(value: unknown): unknown {
  const record = recordValue(value);
  return record && Object.hasOwn(record, "value") ? record.value : value;
}

function canonicalJson(value: unknown): string {
  return renderProductTruthOperationalJson(value);
}

function rowHash(value: unknown): string {
  return productTruthOperationalSha256(value);
}

function prefixedId(prefix: string, hash: string): string {
  return `${prefix}:${hash}`;
}

export interface ProductTruthLegacyBridgeSourceBinding {
  listingSha256: string;
  legacyComponentSha256: string;
  donorProductSha256: string;
  donorContentSha256: string;
  contentSourceOfferSha256: string;
  componentBarcodeEvidenceSha256: string | null;
  directTargetContentEvidenceSha256: string | null;
}

export interface ProductTruthLegacyBridgeVariantRow {
  id: string;
  variantKey: string;
  identityHash: string;
  keyVersion: string;
  normalizedBrand: string;
  normalizedProductLine: string | null;
  normalizedFlavor: string | null;
  normalizedModifiersJson: string;
  normalizedForm: string | null;
  sizeDimension: string;
  sizeBaseAmount: number;
  sizeBaseUnit: string;
  outerPackCount: number;
  identityJson: string;
  createdAt: string;
}

export interface ProductTruthLegacyBridgeDecisionRow {
  id: string;
  decisionKey: string;
  donorProductId: string;
  canonicalVariantId: string;
  decisionStatus: "exact_confirmed";
  matcherVersion: string;
  matcherImplementationSha256: string;
  matcherReleaseSha256: string;
  evidenceHash: string;
  evidenceJson: string;
  decidedAt: string;
  runId: string;
  approvalId: string;
  createdAt: string;
}

export interface ProductTruthLegacyBridgeDonorTransition {
  donorProductId: string;
  sourceIdentityStatus: string;
  sourceIdentityKey: string;
  sourceIdentityFieldsSha256: string;
  exactProjection: {
    identityKey: string;
    brand: string;
    productLine: string | null;
    flavor: string | null;
    containerType: string | null;
    size: string;
    identityStatus: "exact_confirmed";
    identityMatcherVersion: string;
    identityMatcherImplementationSha256: string;
    identityMatcherReleaseSha256: string;
    identityEvidenceJson: string;
    identityConfirmedAt: string;
  };
}

export interface ProductTruthLegacyBridgeContentRow {
  id: string;
  observationKey: string;
  donorProductId: string;
  canonicalVariantId: string;
  variantDecisionId: string;
  sourceUrl: string;
  sourceApi: string;
  contentHash: string;
  fieldHashesJson: string;
  contentJson: string;
  observedAt: string;
  runId: string;
  approvalId: string;
  meteredReceiptId: null;
  createdAt: string;
}

export interface ProductTruthLegacyBridgeComponentEvidenceRow {
  id: string;
  evidenceKey: string;
  skuCostId: string;
  componentIndex: number;
  evidenceStatus: "REJECT";
  targetCanonicalVariantId: string;
  contentCanonicalVariantId: string;
  priceCanonicalVariantId: null;
  contentObservationId: string;
  priceObservationId: null;
  matchTier: "EXACT_IDENTITY";
  matcherVersion: string;
  matcherImplementationSha256: string;
  matcherReleaseSha256: string;
  pricePolicyVersion: string;
  evidenceHash: string;
  evidenceJson: string;
  createdAt: string;
}

export interface ProductTruthLegacyBridgeScopeLinkRow {
  skuCostId: string;
  listingKey: string;
  linkVersion: string;
  createdAt: string;
}

export interface ProductTruthLegacyBridgeCostRow {
  id: string;
  observationKey: string;
  sku: string;
  asin: null;
  effectiveDate: string;
  productCost: null;
  packagingCost: null;
  iceCost: null;
  totalCost: null;
  costPerUnit: null;
  packSize: null;
  includesPackaging: 0;
  currency: "USD";
  source: "retail:batch";
  confidence: null;
  needsReview: 1;
  notes: string;
  recipeHash: string;
  evidenceJson: string;
  evidenceOutcome: "UNSOURCEABLE";
  matcherVersion: string;
  matcherImplementationSha256: string;
  matcherReleaseSha256: string;
  pricePolicyVersion: string;
  runId: string;
  approvalId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductTruthLegacyBridgeApplyTarget {
  ordinal: number;
  listingKey: string;
  channel: "amazon" | "walmart";
  storeIndex: number;
  sku: string;
  legacyComponentId: string;
  donorProductId: string;
  contentSourceOfferId: string;
  sourceBinding: ProductTruthLegacyBridgeSourceBinding;
  expectedReadiness: {
    bundleFactory: boolean;
    listingImprovement: boolean;
    unitEconomics: "UNSOURCEABLE";
    procurement: false;
  };
  identityReconciliation: ProductTruthLegacyBridgeIdentityReconciliation | null;
  variant: ProductTruthLegacyBridgeVariantRow;
  decision: ProductTruthLegacyBridgeDecisionRow | null;
  reusedDecision: {
    decisionId: string;
    donorProductId: string;
    canonicalVariantId: string;
    decisionStatus: "exact_confirmed";
    decidedAt: string;
  } | null;
  donorTransition: ProductTruthLegacyBridgeDonorTransition | null;
  content: ProductTruthLegacyBridgeContentRow;
  listingRecipe: ProductTruthListingRecipeRow;
  listingRecipeComponents: ProductTruthListingRecipeComponentRow[];
  componentEvidence: ProductTruthLegacyBridgeComponentEvidenceRow;
  listingScopeLink: ProductTruthLegacyBridgeScopeLinkRow;
  cost: ProductTruthLegacyBridgeCostRow;
}

export interface ProductTruthLegacyBridgeIdentityReconciliation {
  schemaVersion:
    "product-truth-legacy-bridge-field-partition-reconciliation/1.0.0";
  mode: "LEXICALLY_EQUIVALENT_DONOR_GRAPH";
  donorProductId: string;
  canonicalListingKey: string;
  canonicalTargetIdentity: CanonicalProductIdentity;
  canonicalTargetVariant: NonNullable<
    ProductTruthLegacyBridgeComponentPlan["targetVariant"]
  >;
  physicalIdentitySha256: string;
  sourceTargets: Array<{
    listingKey: string;
    originalCanonicalVariantId: string;
    originalTargetIdentitySha256: string;
    overlappingProductFlavorTokens: number;
  }>;
  sourceTargetsSha256: string;
}

export interface ProductTruthLegacyBridgeApplyPlan {
  schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_APPLY_PLAN_VERSION;
  planId: string;
  expectedApprovalId: string;
  createdAt: string;
  expiresAt: string;
  databaseTargetFingerprint: string;
  source: {
    snapshotSchemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION;
    snapshotSha256: string;
    bridgePlanSchemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION;
    bridgePlanSha256: string;
    bridgePolicyVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION;
    manifestSha256: string;
  };
  targetsSha256: string;
  targets: ProductTruthLegacyBridgeApplyTarget[];
  databaseWrites: {
    maximumRows: number;
    canonicalProductVariants: number;
    donorVariantDecisions: number;
    donorIdentityTransitions: number;
    productContentObservations: number;
    productTruthListingRecipes: number;
    productTruthListingRecipeComponents: number;
    skuCostListingScopeLinks: number;
    skuComponentEvidence: number;
    skuCosts: number;
  };
  rollbackPolicy: {
    transactionMode: "SINGLE_WRITE_TRANSACTION";
    rollbackBeforeCommit: true;
    postCommitDeleteRollback: false;
    postCommitRecovery: "APPEND_ONLY_CORRECTION_AND_CONSUMER_CUTOVER_OFF";
  };
  claims: {
    reusesExistingLegacyCatalog: true;
    createsAdditionalCatalog: false;
    mutatesLegacyContentFields: false;
    canonicalContentOnly: true;
    costOutcome: "UNSOURCEABLE";
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    marketplaceMutations: 0;
    procurementMutations: 0;
    consumerCutover: false;
  };
}

export interface ProductTruthLegacyBridgeApproval {
  schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_APPROVAL_VERSION;
  decision: "APPROVE_NO_PAID_LEGACY_BRIDGE_WAVE";
  approvedBy: "owner";
  approvalId: string;
  planId: string;
  planSha256: string;
  databaseTargetFingerprint: string;
  sourceSnapshotSha256: string;
  bridgePlanSha256: string;
  targetsSha256: string;
  listingKeys: string[];
  maximumDatabaseRows: number;
  allowCanonicalMaterialization: true;
  allowProviderCalls: false;
  allowPaidCalls: false;
  allowMarketplaceMutations: false;
  allowProcurementMutations: false;
  allowConsumerCutover: false;
  issuedAt: string;
  expiresAt: string;
}

export interface ProductTruthLegacyBridgeStandingPolicy {
  schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION;
  policyId: string;
  approvedBy: "owner";
  issuedAt: string;
  expiresAt: string | null;
  databaseTargetFingerprint: string;
  manifestSha256: string;
  maximumDatabaseRowsPerWave: number;
  maximumPreflightAgeMs: number;
  requiresCollisionFree: true;
  requiresFreshReadyToApplyPreflight: true;
  allowCanonicalMaterialization: true;
  allowProviderCalls: false;
  allowPaidCalls: false;
  allowMarketplaceListingWrites: false;
  allowPriceChanges: false;
  allowInventoryChanges: false;
  allowDelisting: false;
  allowConsumerActivation: false;
  allowProcurement: false;
  revocationRequiresOwnerDecision: true;
  ownerStatement: string;
}

export interface ProductTruthLegacyBridgeApplyReport {
  schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_APPLY_REPORT_VERSION;
  status: "APPLIED" | "ALREADY_APPLIED";
  planId: string;
  planSha256: string;
  approvalId: string;
  approvalSha256: string;
  authorization: {
    mode: "EXACT_OWNER_PLAN" | "STANDING_NO_PAID_POLICY";
    standingPolicyId: string | null;
    standingPolicySha256: string | null;
    preflightReportSha256: string | null;
  };
  databaseTargetFingerprint: string;
  startedAt: string;
  completedAt: string;
  counts: {
    targets: number;
    insertedRows: number;
    exactExistingRows: number;
    canonicalVariantReuses: number;
    donorVariantDecisionReuses: number;
    donorIdentityTransitions: number;
  };
  verification: {
    listingKeys: string[];
    bundleFactoryReady: number;
    listingImprovementReady: number;
    unitEconomicsUnsourceable: number;
    procurementReady: number;
    foreignKeyViolations: string[];
    consumerCutoverChanged: false;
  };
  claims: ProductTruthLegacyBridgeApplyPlan["claims"];
}

export interface ProductTruthLegacyBridgePreflightReport {
  schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_PREFLIGHT_REPORT_VERSION;
  status: "READY_TO_APPLY" | "ALREADY_APPLIED";
  planId: string;
  planSha256: string;
  databaseTargetFingerprint: string;
  checkedAt: string;
  counts: {
    targets: number;
    absentRows: number;
    exactExistingRows: number;
    canonicalVariantReuses: number;
    donorVariantDecisionReuses: number;
    donorIdentityTransitionsRequired: number;
  };
  listingKeys: string[];
  foreignKeyViolations: string[];
  claims: ProductTruthLegacyBridgeApplyPlan["claims"];
}

function sourceIdentityFields(donor: ProductTruthLegacyBridgeDonorRow): unknown {
  return {
    identityKey: donor.identityKey,
    identityStatus: donor.identityStatus,
    brand: donor.brand,
    productLine: donor.productLine,
    flavor: donor.flavor,
    containerType: donor.containerType,
    size: donor.size,
  };
}

function sourceListingFields(listing: ProductTruthLegacyBridgeListingRow): unknown {
  return {
    listingKey: listing.listingKey,
    channel: listing.channel,
    storeIndex: listing.storeIndex,
    sku: listing.sku,
    listingUpc: listing.listingUpc,
    listingUpcSource: listing.listingUpcSource,
    productIdentityJson: listing.productIdentityJson,
    productIdentityUpdatedAt: listing.productIdentityUpdatedAt,
  };
}

function sourceComponentFields(component: ProductTruthLegacyBridgeComponentRow): unknown {
  return {
    id: component.id,
    sku: component.sku,
    idx: component.idx,
    product: component.product,
    flavor: component.flavor,
    size: component.size,
    qty: component.qty,
    donorProductId: component.donorProductId,
    contentDonorProductId: component.contentDonorProductId,
  };
}

function contentSourceOfferFields(offer: ProductTruthLegacyBridgeOfferRow): unknown {
  return {
    id: offer.id,
    donorProductId: offer.donorProductId,
    retailer: offer.retailer,
    retailerProductId: offer.retailerProductId,
    via: offer.via,
    productUrl: offer.productUrl,
    isFirstParty: offer.isFirstParty,
    sourceApi: offer.sourceApi,
  };
}

function sourceContentFields(donor: ProductTruthLegacyBridgeDonorRow): unknown {
  return {
    id: donor.id,
    category: donor.category,
    upc: donor.upc,
    gtin: donor.gtin,
    title: donor.title,
    description: donor.description,
    bullets: donor.bullets,
    attributes: donor.attributes,
    nutritionFacts: donor.nutritionFacts,
    ingredients: donor.ingredients,
    mainImageUrl: donor.mainImageUrl,
    imageUrls: donor.imageUrls,
    createdAt: donor.createdAt,
    updatedAt: donor.updatedAt,
  };
}

function exactProjectionFields(
  donor: ProductTruthLegacyBridgeDonorRow,
  target: CanonicalProductIdentity,
  evidenceJson: string,
  confirmedAt: string,
): ProductTruthLegacyBridgeDonorTransition["exactProjection"] {
  const brand = exactText(target.brand, "targetIdentity.brand");
  const size = exactText(target.size, "targetIdentity.size");
  return {
    identityKey: donor.identityKey,
    brand,
    productLine: target.productLine?.trim() || null,
    flavor: target.flavor?.trim() || null,
    containerType: target.form?.trim() || null,
    size,
    identityStatus: "exact_confirmed",
    identityMatcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    identityMatcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    identityMatcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    identityEvidenceJson: evidenceJson,
    identityConfirmedAt: confirmedAt,
  };
}

function contentPayload(input: {
  donor: ProductTruthLegacyBridgeDonorRow;
  offer: ProductTruthLegacyBridgeOfferRow;
  storageEvidence: unknown;
  allergensEvidence: unknown;
  contentOverride: NonNullable<
    NonNullable<ProductTruthLegacyBridgeComponentPlan["contentAssessment"]>["contentOverride"]
  > | null;
  graphSourceBinding: Pick<
    ProductTruthLegacyBridgeSourceBinding,
    | "donorProductSha256"
    | "donorContentSha256"
    | "contentSourceOfferSha256"
    | "componentBarcodeEvidenceSha256"
    | "directTargetContentEvidenceSha256"
  >;
  sourceSnapshotSha256: string;
  bridgePlanSha256: string;
}): Record<string, unknown> {
  const parsedImages = parseJson(input.donor.imageUrls);
  const images = parsedImages == null ? [] : parsedImages;
  if (!Array.isArray(images) || images.some((image) => typeof image !== "string")) {
    fail("LEGACY_BRIDGE_CONTENT_INVALID", `${input.donor.id} image gallery is invalid`);
  }
  const upc = normalizeProductTruthBridgeGtin(input.donor.upc);
  const content = input.contentOverride;
  return {
    _schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_CONTENT_VERSION,
    _capture: "legacy_materialized_bridge",
    title: content?.title ?? input.donor.title,
    description: content?.description ?? input.donor.description,
    bullets: content?.bullets ?? parseJson(input.donor.bullets),
    attributes: content?.attributes ?? parseJson(input.donor.attributes),
    nutritionFacts: content?.nutritionFacts ?? parseJson(input.donor.nutritionFacts),
    ingredients: content?.ingredients ?? input.donor.ingredients,
    allergens: evidenceValue(input.allergensEvidence),
    category: input.donor.category,
    storage: evidenceValue(input.storageEvidence),
    upc: input.donor.upc,
    normalizedGtin14: upc ?? null,
    mainImageUrl: input.donor.mainImageUrl,
    imageUrls: images,
    sourceBinding: {
      policyVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION,
      materializationRoute: PRODUCT_TRUTH_LEGACY_BRIDGE_MATERIALIZATION_SOURCE,
      originalSourceApi: content?.sourceApi ?? input.offer.sourceApi,
      exactContentEvidenceArtifactSha256: content?.evidenceArtifactSha256 ?? null,
      exactContentRawHtmlSha256: content?.rawHtmlSha256 ?? null,
      sourceSnapshotSha256: input.sourceSnapshotSha256,
      bridgePlanSha256: input.bridgePlanSha256,
      donorProductId: input.donor.id,
      donorOfferId: input.offer.id,
      donorUpdatedAt: input.donor.updatedAt,
      offerFetchedAt: input.offer.fetchedAt,
      rowHashes: input.graphSourceBinding,
    },
  };
}

function contentFieldHashes(payload: Record<string, unknown>): Record<string, string> {
  const fields = [
    "title",
    "description",
    "bullets",
    "attributes",
    "nutritionFacts",
    "ingredients",
    "allergens",
    "category",
    "storage",
    "upc",
    "mainImageUrl",
    "imageUrls",
  ] as const;
  return Object.fromEntries(
    fields.map((field) => [field, rowHash(payload[field])]),
  );
}

function assertBridgeInputs(input: {
  snapshot: ProductTruthLegacyBridgeSnapshot;
  snapshotJson: string;
  snapshotSha256: string;
  bridgePlan: ProductTruthLegacyBridgePlan;
  bridgePlanJson: string;
  bridgePlanSha256: string;
}): void {
  if (input.snapshot.schemaVersion !== PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION) {
    fail("LEGACY_BRIDGE_SOURCE_INVALID", "snapshot schema version mismatch");
  }
  if (renderProductTruthLegacyBridgeSnapshot(input.snapshot) !== input.snapshotJson) {
    fail("LEGACY_BRIDGE_SOURCE_INVALID", "snapshot bytes are not canonical");
  }
  if (
    exactSha(input.snapshotSha256, "snapshotSha256")
      !== productTruthLegacyBridgeBytesSha256(input.snapshotJson)
  ) {
    fail("LEGACY_BRIDGE_SOURCE_INVALID", "snapshot SHA-256 mismatch");
  }
  if (
    input.bridgePlan.schemaVersion !== PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION
    || input.bridgePlan.policyVersion !== PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION
  ) {
    fail("LEGACY_BRIDGE_SOURCE_INVALID", "bridge plan contract mismatch");
  }
  if (renderProductTruthLegacyBridgePlan(input.bridgePlan) !== input.bridgePlanJson) {
    fail("LEGACY_BRIDGE_SOURCE_INVALID", "bridge plan bytes are not canonical");
  }
  if (
    exactSha(input.bridgePlanSha256, "bridgePlanSha256")
      !== productTruthLegacyBridgeBytesSha256(input.bridgePlanJson)
  ) {
    fail("LEGACY_BRIDGE_SOURCE_INVALID", "bridge plan SHA-256 mismatch");
  }
  if (
    input.bridgePlan.source.snapshotSha256 !== input.snapshotSha256
    || input.bridgePlan.source.targetFingerprint !== input.snapshot.targetFingerprint
    || input.bridgePlan.source.manifest.sha256 !== input.snapshot.manifest.sha256
  ) {
    fail("LEGACY_BRIDGE_SOURCE_INVALID", "bridge plan is not bound to the supplied snapshot");
  }
  if (
    input.bridgePlan.matcher.version !== CANONICAL_PRODUCT_MATCHER_VERSION
    || input.bridgePlan.matcher.implementationSha256
      !== CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256
    || input.bridgePlan.matcher.releaseSha256
      !== CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256
  ) {
    fail("LEGACY_BRIDGE_SOURCE_INVALID", "bridge matcher provenance is not current");
  }
}

type ProductTruthLegacyBridgePartitionCandidate = {
  listingKey: string;
  component: ProductTruthLegacyBridgeComponentPlan;
  rebuiltVariant: ReturnType<typeof buildCanonicalProductVariantKey>;
  physicalIdentity: {
    brand: string;
    identityTokens: string[];
    modifiers: string[];
    form: string | null;
    size: {
      dimension: string;
      baseAmount: number;
      baseUnit: string;
    };
    outerPackCount: number;
  };
  overlappingProductFlavorTokens: number;
};

function identityTokens(value: string | null): string[] {
  return value?.split(/\s+/).filter(Boolean) ?? [];
}

function physicalIdentityProjection(
  rebuiltVariant: ReturnType<typeof buildCanonicalProductVariantKey>,
): ProductTruthLegacyBridgePartitionCandidate["physicalIdentity"] {
  const productTokens = new Set(
    identityTokens(rebuiltVariant.normalized.productLine),
  );
  const flavorTokens = new Set(
    identityTokens(rebuiltVariant.normalized.flavor),
  );
  // "with" is a partition connector, not a sellable-variant discriminator
  // when both sides already carry the same explicit identity tokens. For
  // example, "Crushed Tomatoes with Roasted Garlic" and product-line
  // "Crushed Tomatoes" + flavor "Roasted Garlic" describe the same package.
  const identityTokenSet = new Set(
    [...productTokens, ...flavorTokens].filter((token) => token !== "with"),
  );
  return {
    brand: rebuiltVariant.normalized.brand,
    identityTokens: [...identityTokenSet].sort((left, right) =>
      left.localeCompare(right, "en-US")),
    modifiers: [...rebuiltVariant.normalized.modifiers].sort((left, right) =>
      left.localeCompare(right, "en-US")),
    form: rebuiltVariant.normalized.form,
    size: rebuiltVariant.normalized.size,
    outerPackCount: rebuiltVariant.normalized.outerPackCount,
  };
}

function partitionCandidate(
  listingKey: string,
  component: ProductTruthLegacyBridgeComponentPlan,
): ProductTruthLegacyBridgePartitionCandidate {
  if (!component.targetIdentity || !component.targetVariant) {
    fail(
      "LEGACY_BRIDGE_DONOR_PARTITION_INVALID",
      `${listingKey} has no exact target identity`,
    );
  }
  const rebuiltVariant =
    buildCanonicalProductVariantKey(component.targetIdentity);
  if (
    rebuiltVariant.canonicalVariantId
      !== component.targetVariant.canonicalVariantId
    || rebuiltVariant.identityJson !== component.targetVariant.identityJson
  ) {
    fail(
      "LEGACY_BRIDGE_DONOR_PARTITION_INVALID",
      `${listingKey} target variant projection drifted`,
    );
  }
  const productTokens = new Set(
    identityTokens(rebuiltVariant.normalized.productLine),
  );
  const flavorTokens = new Set(
    identityTokens(rebuiltVariant.normalized.flavor),
  );
  const overlappingProductFlavorTokens = [...flavorTokens].filter(
    (token) => productTokens.has(token),
  ).length;
  return {
    listingKey,
    component,
    rebuiltVariant,
    physicalIdentity: physicalIdentityProjection(rebuiltVariant),
    overlappingProductFlavorTokens,
  };
}

function buildIdentityReconciliations(input: {
  bridgePlan: ProductTruthLegacyBridgePlan;
  selectedListingKeys: ReadonlySet<string>;
}): Map<string, ProductTruthLegacyBridgeIdentityReconciliation> {
  const candidatesByDonor = new Map<
    string,
    ProductTruthLegacyBridgePartitionCandidate[]
  >();
  for (const scope of input.bridgePlan.scopes) {
    if (
      !scope.writeEligible
      || ![
        "CONTENT_ONLY_CANONICALIZATION_CANDIDATE",
        "IDENTITY_ONLY_CANONICALIZATION_CANDIDATE",
      ].includes(scope.disposition)
      || scope.components.length !== 1
    ) {
      continue;
    }
    const component = scope.components[0];
    if (
      !component?.donorProductId
      || !component.targetIdentity
      || !component.targetVariant
    ) {
      continue;
    }
    const rows = candidatesByDonor.get(component.donorProductId) ?? [];
    rows.push(partitionCandidate(scope.listingKey, component));
    candidatesByDonor.set(component.donorProductId, rows);
  }

  const reconciliations =
    new Map<string, ProductTruthLegacyBridgeIdentityReconciliation>();
  for (const [donorProductId, unsortedCandidates] of candidatesByDonor) {
    const candidates = [...unsortedCandidates].sort((left, right) =>
      left.listingKey.localeCompare(right.listingKey, "en-US"));
    const variants = new Set(
      candidates.map((row) => row.rebuiltVariant.canonicalVariantId),
    );
    if (variants.size <= 1) continue;
    const selected = candidates.filter((row) =>
      input.selectedListingKeys.has(row.listingKey));
    if (selected.length === 0) continue;
    if (selected.length !== candidates.length) {
      fail(
        "LEGACY_BRIDGE_DONOR_PARTITION_SCOPE_INCOMPLETE",
        [
          `donor ${donorProductId} has ${candidates.length}`,
          "write-eligible field-partition scopes; select the complete donor group",
        ].join(" "),
      );
    }
    const physicalIdentityRows = new Set(
      candidates.map((row) => canonicalJson(row.physicalIdentity)),
    );
    if (physicalIdentityRows.size !== 1) {
      fail(
        "LEGACY_BRIDGE_DONOR_VARIANT_COLLISION",
        `donor ${donorProductId} maps to physically different target identities`,
      );
    }
    const canonical = [...candidates].sort((left, right) => {
      const overlap =
        left.overlappingProductFlavorTokens
        - right.overlappingProductFlavorTokens;
      if (overlap !== 0) return overlap;
      const productLineLength =
        identityTokens(right.rebuiltVariant.normalized.productLine).length
        - identityTokens(left.rebuiltVariant.normalized.productLine).length;
      if (productLineLength !== 0) return productLineLength;
      const flavorLength =
        identityTokens(left.rebuiltVariant.normalized.flavor).length
        - identityTokens(right.rebuiltVariant.normalized.flavor).length;
      if (flavorLength !== 0) return flavorLength;
      return left.rebuiltVariant.canonicalVariantId.localeCompare(
        right.rebuiltVariant.canonicalVariantId,
        "en-US",
      );
    })[0]!;
    const sourceTargets =
      candidates.map((row) => ({
        listingKey: row.listingKey,
        originalCanonicalVariantId: row.rebuiltVariant.canonicalVariantId,
        originalTargetIdentitySha256: rowHash(row.component.targetIdentity),
        overlappingProductFlavorTokens:
          row.overlappingProductFlavorTokens,
      }));
    const reconciliation: ProductTruthLegacyBridgeIdentityReconciliation = {
      schemaVersion:
        "product-truth-legacy-bridge-field-partition-reconciliation/1.0.0",
      mode: "LEXICALLY_EQUIVALENT_DONOR_GRAPH",
      donorProductId,
      canonicalListingKey: canonical.listingKey,
      canonicalTargetIdentity: canonical.component.targetIdentity!,
      canonicalTargetVariant: canonical.component.targetVariant!,
      physicalIdentitySha256: rowHash(canonical.physicalIdentity),
      sourceTargets,
      sourceTargetsSha256: rowHash(sourceTargets),
    };
    for (const row of candidates) {
      reconciliations.set(row.listingKey, reconciliation);
    }
  }
  return reconciliations;
}

function targetFromScope(input: {
  ordinal: number;
  listingKey: string;
  snapshot: ProductTruthLegacyBridgeSnapshot;
  bridgePlan: ProductTruthLegacyBridgePlan;
  snapshotSha256: string;
  bridgePlanSha256: string;
  planId: string;
  approvalId: string;
  createdAt: string;
  identityReconciliation:
    ProductTruthLegacyBridgeIdentityReconciliation | null;
}): ProductTruthLegacyBridgeApplyTarget {
  const listing = input.snapshot.listings.find((row) => row.listingKey === input.listingKey);
  const scope = input.bridgePlan.scopes.find((row) => row.listingKey === input.listingKey);
  if (!listing || !scope) {
    fail("LEGACY_BRIDGE_WAVE_SCOPE_INVALID", `${input.listingKey} is absent from source`);
  }
  if (
    !scope.writeEligible
    || ![
      "CONTENT_ONLY_CANONICALIZATION_CANDIDATE",
      "IDENTITY_ONLY_CANONICALIZATION_CANDIDATE",
    ].includes(scope.disposition)
    || scope.components.length !== 1
  ) {
    fail(
      "LEGACY_BRIDGE_WAVE_SCOPE_INVALID",
      `${input.listingKey} must be a one-component exact-identity candidate`,
    );
  }
  const componentPlan = scope.components[0];
  const barcodeEvidence = input.snapshot.componentBarcodeEvidence.find(
    (row) => row.listingKey === input.listingKey && row.componentIndex === 0,
  ) ?? null;
  const directTargetContentEvidence =
    input.snapshot.directTargetContentEvidence.find(
      (row) => row.donorProductId === componentPlan.donorProductId,
    ) ?? null;
  const strictTitleProof =
    componentPlan.matcherVerdict === "EXACT_IDENTITY"
    && componentPlan.identityProof === "STRICT_TITLE_MATCH";
  const exactLiveBarcodeProof =
    componentPlan.matcherVerdict === null
    && componentPlan.identityProof === "EXACT_LIVE_IMAGE_BARCODE"
    && barcodeEvidence !== null;
  if (
    ![
      "EXACT_CONTENT_ONLY_CANDIDATE",
      "EXACT_IDENTITY_ONLY_CANDIDATE",
    ].includes(componentPlan.disposition)
    || (!strictTitleProof && !exactLiveBarcodeProof)
    || !componentPlan.targetIdentity
    || !componentPlan.targetVariant
    || !componentPlan.contentAssessment
    || !componentPlan.legacyComponentId
    || !componentPlan.donorProductId
    || !componentPlan.contentSourceOfferId
  ) {
    fail(
      "LEGACY_BRIDGE_WAVE_SCOPE_INVALID",
      `${input.listingKey} has incomplete exact identity proof`,
    );
  }
  const overrideEvidenceType =
    componentPlan.contentAssessment.contentOverride?.evidenceType ?? null;
  if (
    (
      overrideEvidenceType === "LIVE_IMAGE_BARCODE"
      && (
        !barcodeEvidence
        || componentPlan.contentAssessment.contentOverride?.evidenceArtifactSha256
          !== barcodeEvidence.evidenceArtifactSha256
      )
    )
    || (
      overrideEvidenceType === "DIRECT_TARGET_CONTENT"
      && (
        !directTargetContentEvidence
        || componentPlan.contentAssessment.contentOverride?.evidenceArtifactSha256
          !== directTargetContentEvidence.evidenceArtifactSha256
      )
    )
    || (
      overrideEvidenceType === null
      && componentPlan.contentAssessment.contentOverride !== null
    )
  ) {
    fail(
      "LEGACY_BRIDGE_WAVE_SCOPE_INVALID",
      `${input.listingKey} exact content evidence binding is incomplete`,
    );
  }
  const originalTargetIdentity = componentPlan.targetIdentity;
  const originalTargetVariant = componentPlan.targetVariant;
  const component = input.snapshot.components.find(
    (row) => row.id === componentPlan.legacyComponentId,
  );
  const donor = input.snapshot.donors.find((row) => row.id === componentPlan.donorProductId);
  const offer = input.snapshot.offers.find(
    (row) => row.id === componentPlan.contentSourceOfferId,
  );
  if (
    !component
    || !donor
    || !offer
    || component.sku !== listing.sku
    || offer.donorProductId !== donor.id
  ) {
    fail("LEGACY_BRIDGE_WAVE_SCOPE_INVALID", `${input.listingKey} source graph is broken`);
  }
  if (
    input.identityReconciliation !== null
    && (
      input.identityReconciliation.donorProductId !== donor.id
      || !input.identityReconciliation.sourceTargets.some(
        (row) =>
          row.listingKey === input.listingKey
          && row.originalCanonicalVariantId
            === originalTargetVariant.canonicalVariantId,
      )
    )
  ) {
    fail(
      "LEGACY_BRIDGE_DONOR_PARTITION_INVALID",
      `${input.listingKey} is not bound to its reconciliation group`,
    );
  }
  const targetIdentity =
    input.identityReconciliation?.canonicalTargetIdentity
    ?? originalTargetIdentity;
  const targetVariant =
    input.identityReconciliation?.canonicalTargetVariant
    ?? originalTargetVariant;
  const rebuiltVariant = buildCanonicalProductVariantKey(targetIdentity);
  if (
    rebuiltVariant.canonicalVariantId !== targetVariant.canonicalVariantId
    || rebuiltVariant.identityJson !== targetVariant.identityJson
  ) {
    fail("LEGACY_BRIDGE_WAVE_SCOPE_INVALID", `${input.listingKey} variant projection drifted`);
  }
  const decisionScope = input.identityReconciliation === null
    ? scope
    : input.bridgePlan.scopes.find(
      (row) =>
        row.listingKey === input.identityReconciliation?.canonicalListingKey,
    );
  const decisionComponentPlan = decisionScope?.components[0];
  if (
    !decisionComponentPlan
    || decisionComponentPlan.donorProductId !== donor.id
    || decisionComponentPlan.targetVariant?.canonicalVariantId
      !== rebuiltVariant.canonicalVariantId
  ) {
    fail(
      "LEGACY_BRIDGE_DONOR_PARTITION_INVALID",
      `${input.listingKey} canonical decision source is incomplete`,
    );
  }
  const sourceBinding: ProductTruthLegacyBridgeSourceBinding = {
    listingSha256: rowHash(sourceListingFields(listing)),
    legacyComponentSha256: rowHash(sourceComponentFields(component)),
    donorProductSha256: rowHash(donor),
    donorContentSha256: rowHash(sourceContentFields(donor)),
    contentSourceOfferSha256: rowHash(contentSourceOfferFields(offer)),
    componentBarcodeEvidenceSha256:
      overrideEvidenceType === "LIVE_IMAGE_BARCODE"
        ? barcodeEvidence?.evidenceArtifactSha256 ?? null
        : null,
    directTargetContentEvidenceSha256:
      overrideEvidenceType === "DIRECT_TARGET_CONTENT"
        ? directTargetContentEvidence?.evidenceArtifactSha256 ?? null
        : null,
  };
  const graphSourceBinding = {
    donorProductSha256: sourceBinding.donorProductSha256,
    donorContentSha256: sourceBinding.donorContentSha256,
    contentSourceOfferSha256: sourceBinding.contentSourceOfferSha256,
    componentBarcodeEvidenceSha256:
      sourceBinding.componentBarcodeEvidenceSha256,
    directTargetContentEvidenceSha256:
      sourceBinding.directTargetContentEvidenceSha256,
  };
  const reusableDecisionBindings = input.snapshot.canonicalDonorBindings.filter(
    (row) =>
      row.donorProductId === donor.id
      && row.canonicalVariantId === rebuiltVariant.canonicalVariantId
      && row.decisionStatus === "exact_confirmed",
  );
  if (reusableDecisionBindings.length > 1) {
    fail(
      "LEGACY_BRIDGE_DECISION_COLLISION",
      `${donor.id} has more than one exact decision for the target variant`,
    );
  }
  const reusableDecisionBinding = reusableDecisionBindings[0] ?? null;
  if (
    reusableDecisionBinding !== null
    && donor.identityStatus !== "exact_confirmed"
  ) {
    fail(
      "LEGACY_BRIDGE_DECISION_COLLISION",
      `${donor.id} exact decision is not backed by an exact donor projection`,
    );
  }
  const decisionEvidence = {
    schemaVersion: "product-truth-legacy-bridge-variant-decision-evidence/2.0.0",
    policyVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION,
    verdict: "EXACT_IDENTITY",
    identityProof: decisionComponentPlan.identityProof,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    matcherReasonCodes: decisionComponentPlan.matcherReasonCodes,
    targetIdentity,
    canonicalVariantId: rebuiltVariant.canonicalVariantId,
    donorProductId: donor.id,
    donorTitle: donor.title,
    sourceSnapshotSha256: input.snapshotSha256,
    bridgePlanSha256: input.bridgePlanSha256,
    sourceBinding: graphSourceBinding,
    identityReconciliation: input.identityReconciliation,
  };
  const decisionEvidenceJson = canonicalJson(decisionEvidence);
  const decisionEvidenceHash = sha256Text(decisionEvidenceJson);
  const decisionKey = rowHash({
    donorProductId: donor.id,
    canonicalVariantId: rebuiltVariant.canonicalVariantId,
    decisionStatus: "exact_confirmed",
    evidenceHash: decisionEvidenceHash,
  });
  const createdDecisionId = prefixedId("dpvd", decisionKey);
  const decisionId =
    reusableDecisionBinding?.decisionId ?? createdDecisionId;
  const decisionSourceHash = reusableDecisionBinding === null
    ? decisionEvidenceHash
    : rowHash({
      schemaVersion:
        "product-truth-legacy-bridge-reused-variant-decision/1.0.0",
      ...reusableDecisionBinding,
    });
  const payload = contentPayload({
    donor,
    offer,
    storageEvidence: componentPlan.contentAssessment.storageEvidence,
    allergensEvidence: componentPlan.contentAssessment.allergensEvidence,
    contentOverride: componentPlan.contentAssessment.contentOverride,
    graphSourceBinding,
    sourceSnapshotSha256: input.snapshotSha256,
    bridgePlanSha256: input.bridgePlanSha256,
  });
  const contentJson = canonicalJson(payload);
  const contentHash = sha256Text(contentJson);
  const fieldHashesJson = canonicalJson(contentFieldHashes(payload));
  const observedAt = canonicalInstant(
    componentPlan.contentAssessment.contentOverride?.observedAt ?? donor.updatedAt,
    `${donor.id}.contentObservedAt`,
  );
  if (Date.parse(observedAt) > Date.parse(input.createdAt)) {
    fail("LEGACY_BRIDGE_WAVE_SCOPE_INVALID", `${donor.id} content is from the future`);
  }
  const observationKey = rowHash({
    donorProductId: donor.id,
    canonicalVariantId: rebuiltVariant.canonicalVariantId,
    variantDecisionId: decisionId,
    sourceUrl:
      componentPlan.contentAssessment.contentOverride?.sourceUrl ?? offer.productUrl,
    sourceApi:
      componentPlan.contentAssessment.contentOverride?.sourceApi
      ?? PRODUCT_TRUTH_LEGACY_BRIDGE_MATERIALIZATION_SOURCE,
    contentHash,
    observedAt,
    sourceSnapshotSha256: input.snapshotSha256,
  });
  const contentSourceUrl =
    componentPlan.contentAssessment.contentOverride?.sourceUrl ?? offer.productUrl;
  const contentSourceApi =
    componentPlan.contentAssessment.contentOverride?.sourceApi
    ?? PRODUCT_TRUTH_LEGACY_BRIDGE_MATERIALIZATION_SOURCE;
  if (!contentSourceUrl?.startsWith("https://") || !contentSourceApi) {
    fail("LEGACY_BRIDGE_CONTENT_INVALID", `${offer.id} source provenance is incomplete`);
  }
  const contentId = prefixedId("pco", observationKey);

  const product = exactText(
    component.product ?? componentPlan.targetIdentity.productLine,
    `${component.id}.product`,
  );
  const componentEvidencePayload = {
    schemaVersion: "product-truth-sku-component-evidence/1.0.0",
    sourceEvidenceSchemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_APPLY_PLAN_VERSION,
    evidenceStatus: "REJECT",
    targetCanonicalVariantId: rebuiltVariant.canonicalVariantId,
    contentCanonicalVariantId: rebuiltVariant.canonicalVariantId,
    priceCanonicalVariantId: null,
    contentObservationId: contentId,
    priceObservationId: null,
    product,
    flavor: component.flavor,
    size: component.size,
    qty: componentPlan.qty,
    perUnit: null,
    method: "no-fresh-first-party-price",
    targetComparableUnitPrice: null,
    matchTier: "EXACT_IDENTITY",
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
    rejectionReasons: [
      "NO_ELIGIBLE_PRICE_WITHIN_24_HOURS",
      "LEGACY_PRICE_NOT_PROMOTED",
    ],
  };
  const componentEvidenceJson = canonicalJson(componentEvidencePayload);
  const componentEvidenceHash = rowHash(componentEvidencePayload);

  const costComponent = {
    idx: 0,
    product,
    flavor: component.flavor,
    size: component.size,
    qty: componentPlan.qty,
    perUnit: null,
    method: "no-fresh-first-party-price",
    targetComparableUnitPrice: null,
    priceEvidenceStatus: "REJECT",
    targetCanonicalVariantId: rebuiltVariant.canonicalVariantId,
    contentCanonicalVariantId: rebuiltVariant.canonicalVariantId,
    priceCanonicalVariantId: null,
    contentObservationId: contentId,
    priceEvidenceObservationId: null,
    contentDonorProductId: donor.id,
    priceEvidenceDonorProductId: null,
    priceEvidenceOfferId: null,
    priceVariantDecisionId: null,
    matchTier: "EXACT_IDENTITY",
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
  };
  const recipeMaterialization = buildProductTruthListingRecipeMaterialization({
    listingKey: listing.listingKey,
    manifestSha256: input.snapshot.manifest.sha256,
    sourceKind: "LEGACY_BRIDGE",
    sourceArtifactSha256: rowHash({
      schemaVersion: "product-truth-legacy-bridge-recipe-source/1.0.0",
      listingKey: listing.listingKey,
      sourceSnapshotSha256: input.snapshotSha256,
      bridgePlanSha256: input.bridgePlanSha256,
      sourceBinding,
      decisionEvidenceHash: decisionSourceHash,
    }),
    effectiveAt: input.createdAt,
    createdAt: input.createdAt,
    runId: input.planId,
    approvalId: input.approvalId,
    components: [{
      componentIndex: 0,
      quantity: componentPlan.qty,
      product,
      flavor: component.flavor,
      size: component.size,
      targetCanonicalVariantId: rebuiltVariant.canonicalVariantId,
      donorProductId: donor.id,
      variantDecisionId: decisionId,
      sourceComponentId: component.id,
      sourceEvidence: {
        schemaVersion: "product-truth-legacy-bridge-recipe-component-source/1.0.0",
        identityProof: componentPlan.identityProof,
        matcherReasonCodes: componentPlan.matcherReasonCodes,
        sourceSnapshotSha256: input.snapshotSha256,
        bridgePlanSha256: input.bridgePlanSha256,
        sourceBinding,
        identityReconciliation: input.identityReconciliation,
      },
    }],
  });
  const recipeHash = recipeMaterialization.recipe.recipeHash;
  const costEvidence = {
    schemaVersion: "product-truth-cogs-evidence/1.0.0",
    channel: listing.channel,
    storeIndex: listing.storeIndex,
    listingKey: listing.listingKey,
    listingKeyVersion: PRODUCT_TRUTH_LISTING_KEY_VERSION,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    evaluatedAt: input.createdAt,
    procurementZip: PRODUCT_TRUTH_PROCUREMENT_ZIP,
    sourcePolicy: {
      evidence: "existing-catalog-only",
      maxPriceAgeMs: 24 * 60 * 60 * 1_000,
      paidCalls: 0,
      providerCalls: 0,
    },
    outcome: "UNSOURCEABLE",
    runId: input.planId,
    approvalId: input.approvalId,
    recipeHash,
    components: [costComponent],
  };
  const costEvidenceJson = canonicalJson(costEvidence);
  const costObservationKey = rowHash({
    sku: listing.sku,
    listingKey: listing.listingKey,
    source: "retail:batch",
    recipeHash,
    evidenceHash: sha256Text(costEvidenceJson),
    evaluatedAt: input.createdAt,
    runId: input.planId,
    approvalId: input.approvalId,
  });
  const skuCostId = `retail:${listing.sku}:bridge:${costObservationKey.slice(0, 24)}`;
  const componentEvidenceKey = rowHash({
    skuCostId,
    componentIndex: 0,
    evidenceHash: componentEvidenceHash,
  });

  return {
    ordinal: input.ordinal,
    listingKey: listing.listingKey,
    channel: listing.channel,
    storeIndex: listing.storeIndex,
    sku: listing.sku,
    legacyComponentId: component.id,
    donorProductId: donor.id,
    contentSourceOfferId: offer.id,
    sourceBinding,
    expectedReadiness: {
      bundleFactory:
        scope.disposition === "CONTENT_ONLY_CANONICALIZATION_CANDIDATE",
      listingImprovement:
        scope.disposition === "CONTENT_ONLY_CANONICALIZATION_CANDIDATE",
      unitEconomics: "UNSOURCEABLE",
      procurement: false,
    },
    variant: {
      ...rebuiltVariant.db,
      createdAt: input.createdAt,
    },
    identityReconciliation: input.identityReconciliation,
    decision: reusableDecisionBinding === null ? {
      id: createdDecisionId,
      decisionKey,
      donorProductId: donor.id,
      canonicalVariantId: rebuiltVariant.canonicalVariantId,
      decisionStatus: "exact_confirmed",
      matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
      matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      evidenceHash: decisionEvidenceHash,
      evidenceJson: decisionEvidenceJson,
      decidedAt: input.createdAt,
      runId: input.planId,
      approvalId: input.approvalId,
      createdAt: input.createdAt,
    } : null,
    reusedDecision: reusableDecisionBinding === null ? null : {
      decisionId: reusableDecisionBinding.decisionId,
      donorProductId: reusableDecisionBinding.donorProductId,
      canonicalVariantId: reusableDecisionBinding.canonicalVariantId,
      decisionStatus: "exact_confirmed",
      decidedAt: reusableDecisionBinding.decidedAt,
    },
    donorTransition: reusableDecisionBinding === null ? {
      donorProductId: donor.id,
      sourceIdentityStatus: donor.identityStatus,
      sourceIdentityKey: donor.identityKey,
      sourceIdentityFieldsSha256: rowHash(sourceIdentityFields(donor)),
      exactProjection: exactProjectionFields(
        donor,
        targetIdentity,
        decisionEvidenceJson,
        input.createdAt,
      ),
    } : null,
    content: {
      id: contentId,
      observationKey,
      donorProductId: donor.id,
      canonicalVariantId: rebuiltVariant.canonicalVariantId,
      variantDecisionId: decisionId,
      sourceUrl: contentSourceUrl,
      sourceApi: contentSourceApi,
      contentHash,
      fieldHashesJson,
      contentJson,
      observedAt,
      runId: input.planId,
      approvalId: input.approvalId,
      meteredReceiptId: null,
      createdAt: input.createdAt,
    },
    listingRecipe: recipeMaterialization.recipe,
    listingRecipeComponents: recipeMaterialization.components,
    componentEvidence: {
      id: prefixedId("sce", componentEvidenceKey),
      evidenceKey: componentEvidenceKey,
      skuCostId,
      componentIndex: 0,
      evidenceStatus: "REJECT",
      targetCanonicalVariantId: rebuiltVariant.canonicalVariantId,
      contentCanonicalVariantId: rebuiltVariant.canonicalVariantId,
      priceCanonicalVariantId: null,
      contentObservationId: contentId,
      priceObservationId: null,
      matchTier: "EXACT_IDENTITY",
      matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
      matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
      evidenceHash: componentEvidenceHash,
      evidenceJson: componentEvidenceJson,
      createdAt: input.createdAt,
    },
    listingScopeLink: {
      skuCostId,
      listingKey: listing.listingKey,
      linkVersion: SKU_COST_LISTING_SCOPE_LINK_VERSION,
      createdAt: input.createdAt,
    },
    cost: {
      id: skuCostId,
      observationKey: costObservationKey,
      sku: listing.sku,
      asin: null,
      effectiveDate: input.createdAt,
      productCost: null,
      packagingCost: null,
      iceCost: null,
      totalCost: null,
      costPerUnit: null,
      packSize: null,
      includesPackaging: 0,
      currency: "USD",
      source: "retail:batch",
      confidence: null,
      needsReview: 1,
      notes: "UNSOURCEABLE: no eligible price within 24 hours; exact legacy content retained",
      recipeHash,
      evidenceJson: costEvidenceJson,
      evidenceOutcome: "UNSOURCEABLE",
      matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
      matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
      runId: input.planId,
      approvalId: input.approvalId,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
  };
}

function uniqueExactRows<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
): T[] {
  const rows = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    const existing = rows.get(key);
    if (existing && canonicalJson(existing) !== canonicalJson(value)) {
      fail(
        "LEGACY_BRIDGE_GRAPH_COLLISION",
        `${label} ${key} has conflicting projections inside the wave`,
      );
    }
    rows.set(key, value);
  }
  return [...rows.values()];
}

function waveRows(targets: readonly ProductTruthLegacyBridgeApplyTarget[]): {
  variants: ProductTruthLegacyBridgeVariantRow[];
  decisions: ProductTruthLegacyBridgeDecisionRow[];
  donorTransitions: ProductTruthLegacyBridgeDonorTransition[];
  contents: ProductTruthLegacyBridgeContentRow[];
} {
  const donorVariants = new Map<string, string>();
  for (const target of targets) {
    const existingVariant = donorVariants.get(target.donorProductId);
    if (existingVariant && existingVariant !== target.variant.id) {
      fail(
        "LEGACY_BRIDGE_DONOR_VARIANT_COLLISION",
        [
          `donor ${target.donorProductId} maps to both`,
          `${existingVariant} and ${target.variant.id}`,
        ].join(" "),
      );
    }
    donorVariants.set(target.donorProductId, target.variant.id);
  }
  return {
    variants: uniqueExactRows(targets.map((target) => target.variant), (row) => row.id, "variant"),
    decisions: uniqueExactRows(
      targets.flatMap((target) =>
        target.decision === null ? [] : [target.decision]),
      (row) => row.id,
      "decision",
    ),
    donorTransitions: uniqueExactRows(
      targets.flatMap((target) =>
        target.donorTransition === null ? [] : [target.donorTransition]),
      (row) => row.donorProductId,
      "donor transition",
    ),
    contents: uniqueExactRows(
      targets.map((target) => target.content),
      (row) => row.id,
      "content observation",
    ),
  };
}

function expectedDatabaseWrites(
  targets: readonly ProductTruthLegacyBridgeApplyTarget[],
): ProductTruthLegacyBridgeApplyPlan["databaseWrites"] {
  const rows = waveRows(targets);
  return {
    maximumRows:
      rows.variants.length
      + rows.decisions.length
      + rows.donorTransitions.length
      + rows.contents.length
      + targets.length * 4
      + targets.reduce(
        (sum, target) => sum + target.listingRecipeComponents.length,
        0,
      ),
    canonicalProductVariants: rows.variants.length,
    donorVariantDecisions: rows.decisions.length,
    donorIdentityTransitions: rows.donorTransitions.length,
    productContentObservations: rows.contents.length,
    productTruthListingRecipes: targets.length,
    productTruthListingRecipeComponents: targets.reduce(
      (sum, target) => sum + target.listingRecipeComponents.length,
      0,
    ),
    skuCostListingScopeLinks: targets.length,
    skuComponentEvidence: targets.length,
    skuCosts: targets.length,
  };
}

function donorVariantDecisionReuseCount(
  targets: readonly ProductTruthLegacyBridgeApplyTarget[],
): number {
  return new Set(
    targets.flatMap((target) =>
      target.reusedDecision === null
        ? []
        : [target.reusedDecision.decisionId]),
  ).size;
}

export function planProductTruthLegacyBridgeApply(input: {
  snapshot: ProductTruthLegacyBridgeSnapshot;
  snapshotJson: string;
  snapshotSha256: string;
  bridgePlan: ProductTruthLegacyBridgePlan;
  bridgePlanJson: string;
  bridgePlanSha256: string;
  listingKeys: readonly string[];
  createdAt: string;
  expiresAt: string;
}): ProductTruthLegacyBridgeApplyPlan {
  assertBridgeInputs(input);
  const createdAt = canonicalInstant(input.createdAt, "createdAt");
  const expiresAt = canonicalInstant(input.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    fail("LEGACY_BRIDGE_APPLY_INPUT_INVALID", "expiresAt must be after createdAt");
  }
  if (
    input.listingKeys.length < 1
    || input.listingKeys.length > PRODUCT_TRUTH_LEGACY_BRIDGE_WAVE_MAX_LISTINGS
    || new Set(input.listingKeys).size !== input.listingKeys.length
  ) {
    fail(
      "LEGACY_BRIDGE_WAVE_SCOPE_INVALID",
      [
        "wave requires 1-",
        String(PRODUCT_TRUTH_LEGACY_BRIDGE_WAVE_MAX_LISTINGS),
        " unique explicitly selected listings",
      ].join(""),
    );
  }
  const listingKeys = [...input.listingKeys].sort((left, right) =>
    left.localeCompare(right, "en-US"));
  const planSeed = {
    sourceSnapshotSha256: input.snapshotSha256,
    bridgePlanSha256: input.bridgePlanSha256,
    listingKeys,
    createdAt,
  };
  const planId = `ptlb-wave-${rowHash(planSeed).slice(0, 24)}`;
  const expectedApprovalId = `owner-${planId}`;
  const identityReconciliations = buildIdentityReconciliations({
    bridgePlan: input.bridgePlan,
    selectedListingKeys: new Set(listingKeys),
  });
  const targets = listingKeys.map((listingKey, ordinal) => targetFromScope({
    ordinal,
    listingKey,
    snapshot: input.snapshot,
    bridgePlan: input.bridgePlan,
    snapshotSha256: input.snapshotSha256,
    bridgePlanSha256: input.bridgePlanSha256,
    planId,
    approvalId: expectedApprovalId,
    createdAt,
    identityReconciliation:
      identityReconciliations.get(listingKey) ?? null,
  }));
  const databaseWrites = expectedDatabaseWrites(targets);
  return {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_APPLY_PLAN_VERSION,
    planId,
    expectedApprovalId,
    createdAt,
    expiresAt,
    databaseTargetFingerprint: input.snapshot.targetFingerprint,
    source: {
      snapshotSchemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
      snapshotSha256: input.snapshotSha256,
      bridgePlanSchemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION,
      bridgePlanSha256: input.bridgePlanSha256,
      bridgePolicyVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION,
      manifestSha256: input.snapshot.manifest.sha256,
    },
    targetsSha256: rowHash(targets),
    targets,
    databaseWrites,
    rollbackPolicy: {
      transactionMode: "SINGLE_WRITE_TRANSACTION",
      rollbackBeforeCommit: true,
      postCommitDeleteRollback: false,
      postCommitRecovery: "APPEND_ONLY_CORRECTION_AND_CONSUMER_CUTOVER_OFF",
    },
    claims: {
      reusesExistingLegacyCatalog: true,
      createsAdditionalCatalog: false,
      mutatesLegacyContentFields: false,
      canonicalContentOnly: true,
      costOutcome: "UNSOURCEABLE",
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      marketplaceMutations: 0,
      procurementMutations: 0,
      consumerCutover: false,
    },
  };
}

export function renderProductTruthLegacyBridgeApplyPlan(
  value: ProductTruthLegacyBridgeApplyPlan,
): string {
  return canonicalJson(value);
}

export function renderProductTruthLegacyBridgeApproval(
  value: ProductTruthLegacyBridgeApproval,
): string {
  return canonicalJson(value);
}

export function renderProductTruthLegacyBridgeStandingPolicy(
  value: ProductTruthLegacyBridgeStandingPolicy,
): string {
  return canonicalJson(value);
}

export function renderProductTruthLegacyBridgeApplyReport(
  value: ProductTruthLegacyBridgeApplyReport,
): string {
  return canonicalJson(value);
}

export function renderProductTruthLegacyBridgePreflightReport(
  value: ProductTruthLegacyBridgePreflightReport,
): string {
  return canonicalJson(value);
}

export function expectedProductTruthLegacyBridgeConfirmation(
  plan: ProductTruthLegacyBridgeApplyPlan,
  planSha256: string,
): string {
  return [
    "APPROVE_PRODUCT_TRUTH_LEGACY_BRIDGE_WAVE",
    plan.planId,
    exactSha(planSha256, "planSha256"),
    `${plan.targets.length}_LISTINGS`,
    `${plan.databaseWrites.maximumRows}_MAX_ROWS`,
    "NO_PAID_CALLS",
    "NO_MARKETPLACE_MUTATIONS",
  ].join(":");
}

function validatePlan(
  plan: ProductTruthLegacyBridgeApplyPlan,
  planJson: string,
  planSha256: string,
): void {
  if (plan.schemaVersion !== PRODUCT_TRUTH_LEGACY_BRIDGE_APPLY_PLAN_VERSION) {
    fail("LEGACY_BRIDGE_APPLY_PLAN_INVALID", "unsupported plan version");
  }
  if (renderProductTruthLegacyBridgeApplyPlan(plan) !== planJson) {
    fail("LEGACY_BRIDGE_APPLY_PLAN_INVALID", "plan bytes are not canonical");
  }
  if (sha256Text(planJson) !== exactSha(planSha256, "planSha256")) {
    fail("LEGACY_BRIDGE_APPLY_PLAN_INVALID", "plan SHA-256 mismatch");
  }
  const decisionBindingsValid = plan.targets.every((target) => {
    if (
      (target.decision === null) === (target.reusedDecision === null)
      || (target.decision === null) !== (target.donorTransition === null)
    ) {
      return false;
    }
    const decisionId =
      target.decision?.id ?? target.reusedDecision?.decisionId;
    const decisionDonorProductId =
      target.decision?.donorProductId
      ?? target.reusedDecision?.donorProductId;
    const decisionCanonicalVariantId =
      target.decision?.canonicalVariantId
      ?? target.reusedDecision?.canonicalVariantId;
    return (
      decisionId !== undefined
      && decisionDonorProductId === target.donorProductId
      && decisionCanonicalVariantId === target.variant.id
      && target.content.donorProductId === target.donorProductId
      && target.content.canonicalVariantId === target.variant.id
      && target.content.variantDecisionId === decisionId
      && target.listingRecipeComponents.length > 0
      && target.listingRecipeComponents.every(
        (component) =>
          component.donorProductId === target.donorProductId
          && component.targetCanonicalVariantId === target.variant.id
          && component.variantDecisionId === decisionId,
      )
    );
  });
  const targetsByListingKey = new Map(
    plan.targets.map((target) => [target.listingKey, target]),
  );
  const reconciliationsValid = plan.targets.every((target) => {
    const reconciliation = target.identityReconciliation;
    if (reconciliation === null) return true;
    let rebuilt: ReturnType<typeof buildCanonicalProductVariantKey>;
    try {
      rebuilt = buildCanonicalProductVariantKey(
        reconciliation.canonicalTargetIdentity,
      );
    } catch {
      return false;
    }
    const sortedSourceTargets = [...reconciliation.sourceTargets].sort(
      (left, right) =>
        left.listingKey.localeCompare(right.listingKey, "en-US"),
    );
    return (
      reconciliation.schemaVersion
        === "product-truth-legacy-bridge-field-partition-reconciliation/1.0.0"
      && reconciliation.mode === "LEXICALLY_EQUIVALENT_DONOR_GRAPH"
      && reconciliation.donorProductId === target.donorProductId
      && rebuilt.canonicalVariantId === target.variant.id
      && rebuilt.canonicalVariantId
        === reconciliation.canonicalTargetVariant.canonicalVariantId
      && rebuilt.identityJson
        === reconciliation.canonicalTargetVariant.identityJson
      && reconciliation.physicalIdentitySha256
        === rowHash(physicalIdentityProjection(rebuilt))
      && reconciliation.sourceTargetsSha256
        === rowHash(reconciliation.sourceTargets)
      && canonicalJson(sortedSourceTargets)
        === canonicalJson(reconciliation.sourceTargets)
      && new Set(
        reconciliation.sourceTargets.map((row) => row.listingKey),
      ).size === reconciliation.sourceTargets.length
      && reconciliation.sourceTargets.some(
        (row) => row.listingKey === target.listingKey,
      )
      && reconciliation.sourceTargets.some(
        (row) => row.listingKey === reconciliation.canonicalListingKey,
      )
      && reconciliation.sourceTargets.every((row) => {
        const groupedTarget = targetsByListingKey.get(row.listingKey);
        return (
          groupedTarget !== undefined
          && groupedTarget.donorProductId === target.donorProductId
          && canonicalJson(groupedTarget.identityReconciliation)
            === canonicalJson(reconciliation)
        );
      })
    );
  });
  if (
    plan.targets.length < 1
    || plan.targets.length > PRODUCT_TRUTH_LEGACY_BRIDGE_WAVE_MAX_LISTINGS
    || !decisionBindingsValid
    || !reconciliationsValid
    || rowHash(plan.targets) !== plan.targetsSha256
    || canonicalJson(plan.databaseWrites)
      !== canonicalJson(expectedDatabaseWrites(plan.targets))
    || plan.claims.providerCalls !== 0
    || plan.claims.paidCalls !== 0
    || plan.claims.marketplaceMutations !== 0
    || plan.claims.procurementMutations !== 0
    || plan.claims.consumerCutover !== false
  ) {
    fail("LEGACY_BRIDGE_APPLY_PLAN_INVALID", "plan safety/count contract mismatch");
  }
}

function validateApproval(input: {
  plan: ProductTruthLegacyBridgeApplyPlan;
  planSha256: string;
  approval: ProductTruthLegacyBridgeApproval;
  approvalJson: string;
  approvalSha256: string;
  confirmation: string;
  now: string;
}): void {
  const { plan, approval } = input;
  if (approval.schemaVersion !== PRODUCT_TRUTH_LEGACY_BRIDGE_APPROVAL_VERSION) {
    fail("LEGACY_BRIDGE_APPROVAL_INVALID", "unsupported approval version");
  }
  if (renderProductTruthLegacyBridgeApproval(approval) !== input.approvalJson) {
    fail("LEGACY_BRIDGE_APPROVAL_INVALID", "approval bytes are not canonical");
  }
  if (sha256Text(input.approvalJson) !== exactSha(input.approvalSha256, "approvalSha256")) {
    fail("LEGACY_BRIDGE_APPROVAL_INVALID", "approval SHA-256 mismatch");
  }
  if (
    approval.decision !== "APPROVE_NO_PAID_LEGACY_BRIDGE_WAVE"
    || approval.approvedBy !== "owner"
    || approval.approvalId !== plan.expectedApprovalId
    || approval.planId !== plan.planId
    || approval.planSha256 !== input.planSha256
    || approval.databaseTargetFingerprint !== plan.databaseTargetFingerprint
    || approval.sourceSnapshotSha256 !== plan.source.snapshotSha256
    || approval.bridgePlanSha256 !== plan.source.bridgePlanSha256
    || approval.targetsSha256 !== plan.targetsSha256
    || canonicalJson(approval.listingKeys)
      !== canonicalJson(plan.targets.map((target) => target.listingKey))
    || approval.maximumDatabaseRows !== plan.databaseWrites.maximumRows
    || approval.allowCanonicalMaterialization !== true
    || approval.allowProviderCalls !== false
    || approval.allowPaidCalls !== false
    || approval.allowMarketplaceMutations !== false
    || approval.allowProcurementMutations !== false
    || approval.allowConsumerCutover !== false
  ) {
    fail("LEGACY_BRIDGE_APPROVAL_INVALID", "approval does not match the exact plan");
  }
  const now = Date.parse(canonicalInstant(input.now, "now"));
  const issuedAt = Date.parse(canonicalInstant(approval.issuedAt, "approval.issuedAt"));
  const expiresAt = Date.parse(canonicalInstant(approval.expiresAt, "approval.expiresAt"));
  if (
    issuedAt < Date.parse(plan.createdAt)
    || expiresAt > Date.parse(plan.expiresAt)
    || issuedAt > now
    || now > expiresAt
  ) {
    fail("LEGACY_BRIDGE_APPROVAL_INVALID", "approval is not active inside the plan window");
  }
  if (
    input.confirmation
      !== expectedProductTruthLegacyBridgeConfirmation(plan, input.planSha256)
  ) {
    fail("LEGACY_BRIDGE_CONFIRMATION_MISMATCH", "exact owner confirmation is required");
  }
}

function assertExactObjectKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  const record = recordValue(value);
  if (!record) {
    fail("LEGACY_BRIDGE_STANDING_POLICY_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(record).sort((left, right) => left.localeCompare(right));
  const wanted = [...expected].sort((left, right) => left.localeCompare(right));
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    fail(
      "LEGACY_BRIDGE_STANDING_POLICY_INVALID",
      `${label} has missing or unexpected fields`,
    );
  }
}

function validateStandingPolicyAuthorization(input: {
  plan: ProductTruthLegacyBridgeApplyPlan;
  planSha256: string;
  policy: ProductTruthLegacyBridgeStandingPolicy;
  policyJson: string;
  policySha256: string;
  preflightReport: ProductTruthLegacyBridgePreflightReport;
  preflightReportJson: string;
  preflightReportSha256: string;
  now: string;
}): void {
  assertExactObjectKeys(input.policy, [
    "allowCanonicalMaterialization",
    "allowConsumerActivation",
    "allowDelisting",
    "allowInventoryChanges",
    "allowMarketplaceListingWrites",
    "allowPaidCalls",
    "allowPriceChanges",
    "allowProcurement",
    "allowProviderCalls",
    "approvedBy",
    "databaseTargetFingerprint",
    "expiresAt",
    "issuedAt",
    "manifestSha256",
    "maximumDatabaseRowsPerWave",
    "maximumPreflightAgeMs",
    "ownerStatement",
    "policyId",
    "requiresCollisionFree",
    "requiresFreshReadyToApplyPreflight",
    "revocationRequiresOwnerDecision",
    "schemaVersion",
  ], "standing policy");
  const { policy, plan, preflightReport } = input;
  if (
    policy.schemaVersion !== PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION
    || renderProductTruthLegacyBridgeStandingPolicy(policy) !== input.policyJson
    || sha256Text(input.policyJson)
      !== exactSha(input.policySha256, "standingPolicySha256")
  ) {
    fail(
      "LEGACY_BRIDGE_STANDING_POLICY_INVALID",
      "standing policy bytes, version, or SHA-256 mismatch",
    );
  }
  const issuedAt = Date.parse(canonicalInstant(policy.issuedAt, "policy.issuedAt"));
  const now = Date.parse(canonicalInstant(input.now, "now"));
  const expiresAt = policy.expiresAt === null
    ? null
    : Date.parse(canonicalInstant(policy.expiresAt, "policy.expiresAt"));
  if (
    policy.approvedBy !== "owner"
    || exactText(policy.policyId, "policy.policyId", 160) !== policy.policyId
    || exactText(policy.ownerStatement, "policy.ownerStatement", 2_000)
      !== policy.ownerStatement
    || issuedAt > now
    || (expiresAt !== null && now > expiresAt)
    || policy.databaseTargetFingerprint !== plan.databaseTargetFingerprint
    || policy.manifestSha256 !== plan.source.manifestSha256
    || !Number.isInteger(policy.maximumDatabaseRowsPerWave)
    || policy.maximumDatabaseRowsPerWave < 1
    || policy.maximumDatabaseRowsPerWave > 100
    || !Number.isInteger(policy.maximumPreflightAgeMs)
    || policy.maximumPreflightAgeMs < 1
    || policy.maximumPreflightAgeMs > 15 * 60 * 1_000
    || policy.requiresCollisionFree !== true
    || policy.requiresFreshReadyToApplyPreflight !== true
    || policy.allowCanonicalMaterialization !== true
    || policy.allowProviderCalls !== false
    || policy.allowPaidCalls !== false
    || policy.allowMarketplaceListingWrites !== false
    || policy.allowPriceChanges !== false
    || policy.allowInventoryChanges !== false
    || policy.allowDelisting !== false
    || policy.allowConsumerActivation !== false
    || policy.allowProcurement !== false
    || policy.revocationRequiresOwnerDecision !== true
    || plan.databaseWrites.maximumRows > policy.maximumDatabaseRowsPerWave
    || Date.parse(plan.createdAt) < issuedAt
  ) {
    fail(
      "LEGACY_BRIDGE_STANDING_POLICY_INVALID",
      "standing policy does not authorize this exact bounded wave",
    );
  }
  if (
    renderProductTruthLegacyBridgePreflightReport(preflightReport)
      !== input.preflightReportJson
    || sha256Text(input.preflightReportJson)
      !== exactSha(input.preflightReportSha256, "preflightReportSha256")
    || preflightReport.schemaVersion
      !== PRODUCT_TRUTH_LEGACY_BRIDGE_PREFLIGHT_REPORT_VERSION
    || preflightReport.status !== "READY_TO_APPLY"
    || preflightReport.planId !== plan.planId
    || preflightReport.planSha256 !== input.planSha256
    || preflightReport.databaseTargetFingerprint !== plan.databaseTargetFingerprint
    || preflightReport.counts.targets !== plan.targets.length
    || preflightReport.counts.absentRows <= 0
    || preflightReport.counts.absentRows
      + preflightReport.counts.exactExistingRows
      !== plan.databaseWrites.maximumRows
    || preflightReport.counts.canonicalVariantReuses
      !== preflightReport.counts.exactExistingRows
    || preflightReport.counts.canonicalVariantReuses
      > plan.databaseWrites.canonicalProductVariants
    || preflightReport.counts.donorVariantDecisionReuses
      !== donorVariantDecisionReuseCount(plan.targets)
    || preflightReport.counts.donorIdentityTransitionsRequired
      !== plan.databaseWrites.donorIdentityTransitions
    || preflightReport.foreignKeyViolations.length !== 0
    || canonicalJson(preflightReport.listingKeys)
      !== canonicalJson(plan.targets.map((target) => target.listingKey))
    || canonicalJson(preflightReport.claims) !== canonicalJson(plan.claims)
  ) {
    fail(
      "LEGACY_BRIDGE_STANDING_PREFLIGHT_INVALID",
      "standing policy requires the exact fresh READY_TO_APPLY preflight",
    );
  }
  const checkedAt = Date.parse(
    canonicalInstant(preflightReport.checkedAt, "preflightReport.checkedAt"),
  );
  if (
    checkedAt > now
    || now - checkedAt > policy.maximumPreflightAgeMs
  ) {
    fail(
      "LEGACY_BRIDGE_STANDING_PREFLIGHT_STALE",
      "standing-policy preflight is not fresh at apply start",
    );
  }
}

function rowObject(row: Row): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value]));
}

function comparable(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function assertExactDatabaseRow(
  row: Row,
  expected: Record<string, unknown>,
  code: string,
  ignoredColumns: ReadonlySet<string> = new Set(),
): void {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (ignoredColumns.has(key)) continue;
    if (comparable(row[key]) !== comparable(expectedValue)) {
      fail(code, `${key} differs from the approved row`);
    }
  }
}

async function exactOrAbsent(
  db: SqlReader,
  table: string,
  keyColumn: string,
  expected: Record<string, unknown>,
  collisionCode: string,
  ignoredColumns: ReadonlySet<string> = new Set(),
): Promise<"ABSENT" | "EXACT"> {
  const row = (await db.execute({
    sql: `SELECT * FROM "${table}" WHERE "${keyColumn}"=?`,
    args: [expected[keyColumn] as string],
  })).rows[0];
  if (!row) return "ABSENT";
  assertExactDatabaseRow(row, expected, collisionCode, ignoredColumns);
  return "EXACT";
}

async function readCurrentSourceRows(
  db: SqlReader,
  target: ProductTruthLegacyBridgeApplyTarget,
): Promise<{
  listing: ProductTruthLegacyBridgeListingRow;
  component: ProductTruthLegacyBridgeComponentRow;
  donor: ProductTruthLegacyBridgeDonorRow;
  offer: ProductTruthLegacyBridgeOfferRow;
  donorRaw: Row;
}> {
  const listingRow = (await db.execute({
    sql: `SELECT
      scope.listingKey, scope.channel, scope.storeIndex, scope.sku,
      quality.gmv30d AS priorityGmv30d,
      quality.orders30d AS priorityOrders30d,
      quality.units30d AS priorityUnits30d,
      quality.scoredAt AS priorityObservedAt,
      shipping.upc AS listingUpc, shipping.upcSource AS listingUpcSource,
      shipping.productIdentity, shipping.updatedAt AS productIdentityUpdatedAt
      FROM ProductTruthListingScope scope
      LEFT JOIN SkuShippingData shipping ON shipping.sku=scope.sku
      LEFT JOIN WalmartListingQualityItem quality
        ON scope.channel='walmart'
       AND quality.storeIndex=scope.storeIndex
       AND quality.sku=scope.sku
      WHERE scope.listingKey=?`,
    args: [target.listingKey],
  })).rows[0];
  const componentRow = (await db.execute({
    sql: `SELECT
      id, sku, idx, product, flavor, size, qty, costMethod, retailer, matchedTitle,
      perUnitCost, lineCost, donorProductId, contentDonorProductId,
      priceEvidenceDonorProductId, priceEvidenceOfferId
      FROM SkuComponent WHERE id=?`,
    args: [target.legacyComponentId],
  })).rows[0];
  const donorRow = (await db.execute({
    sql: `SELECT
      id, brand, productLine, flavor, containerType, size, category, upc, gtin,
      title, description, bullets, attributes, nutritionFacts, ingredients,
      mainImageUrl, imageUrls, identityKey, identityStatus, createdAt, updatedAt,
      identityMatcherVersion, identityMatcherImplementationSha256,
      identityMatcherReleaseSha256, identityEvidenceJson, identityConfirmedAt
      FROM DonorProduct WHERE id=?`,
    args: [target.donorProductId],
  })).rows[0];
  const offerRow = (await db.execute({
    sql: `SELECT
      id, donorProductId, retailer, retailerProductId, via, price, packSizeSeen,
      pricePerUnit, currency, zip, localityEvidence, inStock, productUrl,
      isFirstParty, sourceApi, fetchedAt
      FROM DonorOffer WHERE id=?`,
    args: [target.contentSourceOfferId],
  })).rows[0];
  if (!listingRow || !componentRow || !donorRow || !offerRow) {
    fail("LEGACY_BRIDGE_SOURCE_DRIFT", `${target.listingKey} source graph is incomplete`);
  }
  const nullableText = (value: unknown): string | null =>
    typeof value === "string" ? value : null;
  const nullableNumber = (value: unknown): number | null =>
    value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  const listing: ProductTruthLegacyBridgeListingRow = {
    listingKey: String(listingRow.listingKey),
    channel: String(listingRow.channel) as "amazon" | "walmart",
    storeIndex: Number(listingRow.storeIndex),
    sku: String(listingRow.sku),
    listingUpc: nullableText(listingRow.listingUpc),
    listingUpcSource: nullableText(listingRow.listingUpcSource),
    priorityGmv30d: nullableNumber(listingRow.priorityGmv30d),
    priorityOrders30d: nullableNumber(listingRow.priorityOrders30d),
    priorityUnits30d: nullableNumber(listingRow.priorityUnits30d),
    priorityObservedAt: nullableText(listingRow.priorityObservedAt),
    productIdentityJson: nullableText(listingRow.productIdentity),
    productIdentityUpdatedAt: nullableText(listingRow.productIdentityUpdatedAt),
  };
  const component: ProductTruthLegacyBridgeComponentRow = {
    id: String(componentRow.id),
    sku: String(componentRow.sku),
    idx: Number(componentRow.idx),
    product: nullableText(componentRow.product),
    flavor: nullableText(componentRow.flavor),
    size: nullableText(componentRow.size),
    qty: Number(componentRow.qty),
    costMethod: nullableText(componentRow.costMethod),
    retailer: nullableText(componentRow.retailer),
    matchedTitle: nullableText(componentRow.matchedTitle),
    perUnitCost: nullableNumber(componentRow.perUnitCost),
    lineCost: nullableNumber(componentRow.lineCost),
    donorProductId: nullableText(componentRow.donorProductId),
    contentDonorProductId: nullableText(componentRow.contentDonorProductId),
    priceEvidenceDonorProductId: nullableText(componentRow.priceEvidenceDonorProductId),
    priceEvidenceOfferId: nullableText(componentRow.priceEvidenceOfferId),
  };
  const donor: ProductTruthLegacyBridgeDonorRow = {
    id: String(donorRow.id),
    brand: nullableText(donorRow.brand),
    productLine: nullableText(donorRow.productLine),
    flavor: nullableText(donorRow.flavor),
    containerType: nullableText(donorRow.containerType),
    size: nullableText(donorRow.size),
    category: nullableText(donorRow.category),
    upc: nullableText(donorRow.upc),
    gtin: nullableText(donorRow.gtin),
    title: nullableText(donorRow.title),
    description: nullableText(donorRow.description),
    bullets: nullableText(donorRow.bullets),
    attributes: nullableText(donorRow.attributes),
    nutritionFacts: nullableText(donorRow.nutritionFacts),
    ingredients: nullableText(donorRow.ingredients),
    mainImageUrl: nullableText(donorRow.mainImageUrl),
    imageUrls: nullableText(donorRow.imageUrls),
    identityKey: String(donorRow.identityKey),
    identityStatus: String(donorRow.identityStatus),
    createdAt: String(donorRow.createdAt),
    updatedAt: String(donorRow.updatedAt),
  };
  const offer: ProductTruthLegacyBridgeOfferRow = {
    id: String(offerRow.id),
    donorProductId: String(offerRow.donorProductId),
    retailer: String(offerRow.retailer),
    retailerProductId: String(offerRow.retailerProductId),
    via: String(offerRow.via),
    price: nullableNumber(offerRow.price),
    packSizeSeen: nullableNumber(offerRow.packSizeSeen),
    pricePerUnit: nullableNumber(offerRow.pricePerUnit),
    currency: String(offerRow.currency),
    zip: nullableText(offerRow.zip),
    localityEvidence: nullableText(offerRow.localityEvidence),
    inStock: offerRow.inStock == null ? null : Boolean(offerRow.inStock),
    productUrl: nullableText(offerRow.productUrl),
    isFirstParty: Boolean(offerRow.isFirstParty),
    sourceApi: nullableText(offerRow.sourceApi),
    fetchedAt: nullableText(offerRow.fetchedAt),
  };
  return { listing, component, donor, offer, donorRaw: donorRow };
}

function donorExactProjectionMatches(
  row: Row,
  target: ProductTruthLegacyBridgeApplyTarget,
): boolean {
  if (target.donorTransition === null) {
    return target.reusedDecision !== null
      && row.identityStatus === "exact_confirmed";
  }
  const projection = target.donorTransition.exactProjection;
  return Object.entries(projection).every(
    ([key, value]) => comparable(row[key]) === comparable(value),
  );
}

async function assertReusedDecision(
  db: SqlReader,
  target: ProductTruthLegacyBridgeApplyTarget,
): Promise<void> {
  if (target.reusedDecision === null) return;
  const rows = (await db.execute({
    sql: `SELECT id,donorProductId,canonicalVariantId,decisionStatus,decidedAt
          FROM DonorProductVariantDecision WHERE id=?`,
    args: [target.reusedDecision.decisionId],
  })).rows;
  if (
    rows.length !== 1
    || rows[0].id !== target.reusedDecision.decisionId
    || rows[0].donorProductId !== target.reusedDecision.donorProductId
    || rows[0].canonicalVariantId
      !== target.reusedDecision.canonicalVariantId
    || rows[0].decisionStatus !== target.reusedDecision.decisionStatus
    || comparable(rows[0].decidedAt)
      !== comparable(target.reusedDecision.decidedAt)
  ) {
    fail(
      "LEGACY_BRIDGE_REUSED_DECISION_DRIFT",
      `${target.listingKey} exact decision binding differs`,
    );
  }
}

async function preflightTarget(
  db: SqlReader,
  target: ProductTruthLegacyBridgeApplyTarget,
): Promise<{
  graphState: "ABSENT" | "EXACT";
  variantState: "ABSENT" | "EXACT";
  donorNeedsTransition: boolean;
}> {
  const source = await readCurrentSourceRows(db, target);
  if (
    rowHash(sourceListingFields(source.listing)) !== target.sourceBinding.listingSha256
    || rowHash(sourceComponentFields(source.component))
      !== target.sourceBinding.legacyComponentSha256
    || rowHash(contentSourceOfferFields(source.offer))
      !== target.sourceBinding.contentSourceOfferSha256
  ) {
    fail("LEGACY_BRIDGE_SOURCE_DRIFT", `${target.listingKey} listing/component/offer drifted`);
  }
  const sourceDonorHashMatches =
    rowHash(source.donor) === target.sourceBinding.donorProductSha256;
  const exactDonor = donorExactProjectionMatches(source.donorRaw, target);
  if (
    (!sourceDonorHashMatches && !exactDonor)
    || (target.reusedDecision !== null && !sourceDonorHashMatches)
  ) {
    fail("LEGACY_BRIDGE_SOURCE_DRIFT", `${target.listingKey} donor row drifted`);
  }
  await assertReusedDecision(db, target);
  // Content fields are immutable inputs to this bridge even after the
  // transitional identity projection changes.
  const plannedContent = recordValue(JSON.parse(target.content.contentJson))?.sourceBinding;
  if (!plannedContent) {
    fail("LEGACY_BRIDGE_APPLY_PLAN_INVALID", `${target.listingKey} content binding missing`);
  }
  if (rowHash(sourceContentFields(source.donor)) !== target.sourceBinding.donorContentSha256) {
    fail("LEGACY_BRIDGE_SOURCE_DRIFT", `${target.listingKey} donor content drifted`);
  }

  // Canonical variants are keyed only by normalized product identity. A
  // compatible row may have been created by an earlier evidence lane, so its
  // historical creation timestamp is not part of the identity contract.
  const variantState = await exactOrAbsent(
    db,
    "CanonicalProductVariant",
    "id",
    target.variant as unknown as Record<string, unknown>,
    "LEGACY_BRIDGE_VARIANT_COLLISION",
    CANONICAL_VARIANT_REUSE_IGNORED_COLUMNS,
  );
  const rows: Array<["ABSENT" | "EXACT", string]> = [];
  if (target.decision !== null) {
    rows.push([
      await exactOrAbsent(
        db,
        "DonorProductVariantDecision",
        "id",
        target.decision as unknown as Record<string, unknown>,
        "LEGACY_BRIDGE_DECISION_COLLISION",
      ),
      "decision",
    ]);
  }
  rows.push([
    await exactOrAbsent(
      db,
      "ProductContentObservation",
      "id",
      target.content as unknown as Record<string, unknown>,
      "LEGACY_BRIDGE_CONTENT_COLLISION",
    ),
    "content",
  ]);
  rows.push([
    await exactOrAbsent(
      db,
      "ProductTruthListingRecipe",
      "id",
      target.listingRecipe as unknown as Record<string, unknown>,
      "LEGACY_BRIDGE_LISTING_RECIPE_COLLISION",
    ),
    "listingRecipe",
  ]);
  for (const component of target.listingRecipeComponents) {
    rows.push([
      await exactOrAbsent(
        db,
        "ProductTruthListingRecipeComponent",
        "id",
        component as unknown as Record<string, unknown>,
        "LEGACY_BRIDGE_LISTING_RECIPE_COMPONENT_COLLISION",
      ),
      `listingRecipeComponent:${component.componentIndex}`,
    ]);
  }
  rows.push([
    await exactOrAbsent(
      db,
      "SkuCostListingScopeLink",
      "skuCostId",
      target.listingScopeLink as unknown as Record<string, unknown>,
      "LEGACY_BRIDGE_SCOPE_LINK_COLLISION",
    ),
    "scopeLink",
  ]);
  rows.push([
    await exactOrAbsent(
      db,
      "SkuComponentEvidence",
      "id",
      target.componentEvidence as unknown as Record<string, unknown>,
      "LEGACY_BRIDGE_COMPONENT_EVIDENCE_COLLISION",
    ),
    "componentEvidence",
  ]);
  rows.push([
    await exactOrAbsent(
      db,
      "SkuCost",
      "id",
      target.cost as unknown as Record<string, unknown>,
      "LEGACY_BRIDGE_COST_COLLISION",
    ),
    "cost",
  ]);
  const exactRows = rows.filter(([state]) => state === "EXACT").length;
  const absentRows = rows.length - exactRows;
  if (exactRows !== 0 && absentRows !== 0) {
    fail(
      "LEGACY_BRIDGE_PARTIAL_GRAPH",
      `${target.listingKey} has a partial immutable canonical graph`,
    );
  }
  const graphState = exactRows === rows.length ? "EXACT" : "ABSENT";
  if (graphState === "EXACT" && variantState !== "EXACT") {
    fail(
      "LEGACY_BRIDGE_PARTIAL_GRAPH",
      `${target.listingKey} immutable graph exists without its canonical variant`,
    );
  }
  if (exactRows === rows.length && !exactDonor) {
    fail(
      "LEGACY_BRIDGE_PARTIAL_GRAPH",
      `${target.listingKey} immutable graph exists but donor projection is not exact`,
    );
  }
  if (
    exactRows === 0
    && exactDonor
    && target.reusedDecision === null
  ) {
    fail(
      "LEGACY_BRIDGE_PARTIAL_GRAPH",
      `${target.listingKey} donor projection exists without its immutable graph`,
    );
  }
  return {
    graphState,
    variantState,
    donorNeedsTransition: target.donorTransition !== null && !exactDonor,
  };
}

async function insertRow(
  tx: Transaction,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const columns = Object.keys(row);
  await tx.execute({
    sql: `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(",")})
      VALUES (${columns.map(() => "?").join(",")})`,
    args: columns.map((column) => row[column] as never),
  });
}

async function applyListingRows(
  tx: Transaction,
  target: ProductTruthLegacyBridgeApplyTarget,
): Promise<void> {
  for (const component of target.listingRecipeComponents) {
    await insertRow(
      tx,
      "ProductTruthListingRecipeComponent",
      component as unknown as Record<string, unknown>,
    );
  }
  await insertRow(
    tx,
    "ProductTruthListingRecipe",
    target.listingRecipe as unknown as Record<string, unknown>,
  );
  await insertRow(
    tx,
    "SkuCostListingScopeLink",
    target.listingScopeLink as unknown as Record<string, unknown>,
  );
  await insertRow(
    tx,
    "SkuComponentEvidence",
    target.componentEvidence as unknown as Record<string, unknown>,
  );
  await insertRow(
    tx,
    "SkuCost",
    target.cost as unknown as Record<string, unknown>,
  );
}

async function applyWaveRows(
  tx: Transaction,
  targets: readonly ProductTruthLegacyBridgeApplyTarget[],
): Promise<number> {
  const rows = waveRows(targets);
  let canonicalVariantReuses = 0;
  for (const variant of rows.variants) {
    const row = variant as unknown as Record<string, unknown>;
    const state = await exactOrAbsent(
      tx,
      "CanonicalProductVariant",
      "id",
      row,
      "LEGACY_BRIDGE_VARIANT_COLLISION",
      CANONICAL_VARIANT_REUSE_IGNORED_COLUMNS,
    );
    if (state === "EXACT") {
      canonicalVariantReuses += 1;
    } else {
      await insertRow(tx, "CanonicalProductVariant", row);
    }
  }
  for (const decision of rows.decisions) {
    await insertRow(
      tx,
      "DonorProductVariantDecision",
      decision as unknown as Record<string, unknown>,
    );
  }
  for (const transition of rows.donorTransitions) {
    const projection = transition.exactProjection;
    const result = await tx.execute({
      sql: `UPDATE "DonorProduct" SET
        identityKey=?, brand=?, productLine=?, flavor=?, containerType=?, size=?,
        identityStatus=?, identityMatcherVersion=?,
        identityMatcherImplementationSha256=?, identityMatcherReleaseSha256=?,
        identityEvidenceJson=?, identityConfirmedAt=?
        WHERE id=?`,
      args: [
        projection.identityKey,
        projection.brand,
        projection.productLine,
        projection.flavor,
        projection.containerType,
        projection.size,
        projection.identityStatus,
        projection.identityMatcherVersion,
        projection.identityMatcherImplementationSha256,
        projection.identityMatcherReleaseSha256,
        projection.identityEvidenceJson,
        projection.identityConfirmedAt,
        transition.donorProductId,
      ],
    });
    if (result.rowsAffected !== 1) {
      fail(
        "LEGACY_BRIDGE_DONOR_TRANSITION_FAILED",
        `${transition.donorProductId} did not update exactly one donor row`,
      );
    }
  }
  for (const content of rows.contents) {
    await insertRow(
      tx,
      "ProductContentObservation",
      content as unknown as Record<string, unknown>,
    );
  }
  for (const target of targets) {
    await applyListingRows(tx, target);
  }
  return canonicalVariantReuses;
}

async function foreignKeyViolations(db: SqlReader): Promise<string[]> {
  const result = await db.execute("PRAGMA foreign_key_check");
  return result.rows.map((row) => canonicalJson(rowObject(row)).trim());
}

async function verifyAppliedTarget(
  db: SqlReader,
  target: ProductTruthLegacyBridgeApplyTarget,
): Promise<void> {
  const state = await preflightTarget(db, target);
  if (state.graphState !== "EXACT" || state.donorNeedsTransition) {
    fail("LEGACY_BRIDGE_POST_VERIFY_FAILED", `${target.listingKey} graph is incomplete`);
  }
}

export async function preflightProductTruthLegacyBridgeWave(input: {
  db: Client;
  databaseTargetFingerprint: string;
  plan: ProductTruthLegacyBridgeApplyPlan;
  planJson: string;
  planSha256: string;
  checkedAt: string;
}): Promise<ProductTruthLegacyBridgePreflightReport> {
  validatePlan(input.plan, input.planJson, input.planSha256);
  const checkedAt = canonicalInstant(input.checkedAt, "checkedAt");
  if (input.databaseTargetFingerprint !== input.plan.databaseTargetFingerprint) {
    fail("LEGACY_BRIDGE_DATABASE_TARGET_MISMATCH", "database fingerprint differs from plan");
  }
  if (
    Date.parse(checkedAt) < Date.parse(input.plan.createdAt)
    || Date.parse(checkedAt) > Date.parse(input.plan.expiresAt)
  ) {
    fail("LEGACY_BRIDGE_APPLY_PLAN_EXPIRED", "preflight is outside the plan window");
  }
  await assertProductTruthEvidenceSchema(input.db);
  await assertProductTruthListingScopeSchema(input.db);
  const tx = await input.db.transaction("read");
  try {
    const states: Awaited<ReturnType<typeof preflightTarget>>[] = [];
    for (const target of input.plan.targets) {
      states.push(await preflightTarget(tx, target));
    }
    const exactGraphs = states.filter((state) => state.graphState === "EXACT").length;
    if (exactGraphs !== 0 && exactGraphs !== input.plan.targets.length) {
      fail("LEGACY_BRIDGE_PARTIAL_WAVE", "wave is partially applied");
    }
    const violations = await foreignKeyViolations(tx);
    if (violations.length) {
      fail("LEGACY_BRIDGE_FOREIGN_KEY_VIOLATION", violations.join("; "));
    }
    const status = exactGraphs === input.plan.targets.length
      ? "ALREADY_APPLIED"
      : "READY_TO_APPLY";
    const canonicalVariantReuses = new Set(
      input.plan.targets
        .filter((_, index) => states[index]?.variantState === "EXACT")
        .map((target) => target.variant.id),
    ).size;
    const donorVariantDecisionReuses =
      donorVariantDecisionReuseCount(input.plan.targets);
    return {
      schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_PREFLIGHT_REPORT_VERSION,
      status,
      planId: input.plan.planId,
      planSha256: input.planSha256,
      databaseTargetFingerprint: input.databaseTargetFingerprint,
      checkedAt,
      counts: {
        targets: input.plan.targets.length,
        absentRows: status === "READY_TO_APPLY"
          ? input.plan.databaseWrites.maximumRows - canonicalVariantReuses
          : 0,
        exactExistingRows: status === "ALREADY_APPLIED"
          ? input.plan.databaseWrites.maximumRows
          : canonicalVariantReuses,
        canonicalVariantReuses,
        donorVariantDecisionReuses,
        donorIdentityTransitionsRequired:
          status === "READY_TO_APPLY"
            ? input.plan.databaseWrites.donorIdentityTransitions
            : 0,
      },
      listingKeys: input.plan.targets.map((target) => target.listingKey),
      foreignKeyViolations: [],
      claims: input.plan.claims,
    };
  } finally {
    tx.close();
  }
}

type ProductTruthLegacyBridgeWaveAuthorizationInput =
  | {
      approval: ProductTruthLegacyBridgeApproval;
      approvalJson: string;
      approvalSha256: string;
      confirmation: string;
      standingPolicy?: never;
      standingPolicyJson?: never;
      standingPolicySha256?: never;
      standingPreflightReport?: never;
      standingPreflightReportJson?: never;
      standingPreflightReportSha256?: never;
    }
  | {
      approval?: never;
      approvalJson?: never;
      approvalSha256?: never;
      confirmation?: never;
      standingPolicy: ProductTruthLegacyBridgeStandingPolicy;
      standingPolicyJson: string;
      standingPolicySha256: string;
      standingPreflightReport: ProductTruthLegacyBridgePreflightReport;
      standingPreflightReportJson: string;
      standingPreflightReportSha256: string;
    };

export async function applyProductTruthLegacyBridgeWave(input: {
  db: Client;
  databaseTargetFingerprint: string;
  plan: ProductTruthLegacyBridgeApplyPlan;
  planJson: string;
  planSha256: string;
  startedAt: string;
  completedAt?: string;
} & ProductTruthLegacyBridgeWaveAuthorizationInput): Promise<ProductTruthLegacyBridgeApplyReport> {
  validatePlan(input.plan, input.planJson, input.planSha256);
  const startedAt = canonicalInstant(input.startedAt, "startedAt");
  const invocationTime = Date.now();
  if (Date.parse(startedAt) > invocationTime) {
    fail(
      "LEGACY_BRIDGE_TIMESTAMP_INVALID",
      "startedAt cannot be later than the apply invocation",
    );
  }
  const requestedCompletedAt = input.completedAt === undefined
    ? null
    : canonicalInstant(input.completedAt, "completedAt");
  if (
    requestedCompletedAt !== null
    && (
      Date.parse(requestedCompletedAt) < Date.parse(startedAt)
      || Date.parse(requestedCompletedAt) > invocationTime
    )
  ) {
    fail(
      "LEGACY_BRIDGE_TIMESTAMP_INVALID",
      "completedAt must be between startedAt and the apply invocation",
    );
  }
  if (input.databaseTargetFingerprint !== input.plan.databaseTargetFingerprint) {
    fail("LEGACY_BRIDGE_DATABASE_TARGET_MISMATCH", "database fingerprint differs from plan");
  }
  let authorization: ProductTruthLegacyBridgeApplyReport["authorization"];
  let authorizationId: string;
  let authorizationSha256: string;
  if (input.standingPolicy) {
    validateStandingPolicyAuthorization({
      plan: input.plan,
      planSha256: input.planSha256,
      policy: input.standingPolicy,
      policyJson: input.standingPolicyJson,
      policySha256: input.standingPolicySha256,
      preflightReport: input.standingPreflightReport,
      preflightReportJson: input.standingPreflightReportJson,
      preflightReportSha256: input.standingPreflightReportSha256,
      now: startedAt,
    });
    authorization = {
      mode: "STANDING_NO_PAID_POLICY",
      standingPolicyId: input.standingPolicy.policyId,
      standingPolicySha256: input.standingPolicySha256,
      preflightReportSha256: input.standingPreflightReportSha256,
    };
    authorizationId = input.plan.expectedApprovalId;
    authorizationSha256 = input.standingPolicySha256;
  } else {
    validateApproval({
      plan: input.plan,
      planSha256: input.planSha256,
      approval: input.approval,
      approvalJson: input.approvalJson,
      approvalSha256: input.approvalSha256,
      confirmation: input.confirmation,
      now: startedAt,
    });
    authorization = {
      mode: "EXACT_OWNER_PLAN",
      standingPolicyId: null,
      standingPolicySha256: null,
      preflightReportSha256: null,
    };
    authorizationId = input.approval.approvalId;
    authorizationSha256 = input.approvalSha256;
  }
  let insertedRows = 0;
  let exactExistingRows = 0;
  let canonicalVariantReuses = 0;
  const donorVariantDecisionReuses =
    donorVariantDecisionReuseCount(input.plan.targets);
  let donorIdentityTransitions = 0;
  let bundleFactoryReady = 0;
  let listingImprovementReady = 0;
  let unitEconomicsUnsourceable = 0;
  let procurementReady = 0;
  await assertProductTruthEvidenceSchema(input.db);
  await assertProductTruthListingScopeSchema(input.db);
  const tx = await input.db.transaction("write");
  try {
    const preflight: Awaited<ReturnType<typeof preflightTarget>>[] = [];
    for (const target of input.plan.targets) {
      preflight.push(await preflightTarget(tx, target));
    }
    const exactGraphs = preflight.filter((state) => state.graphState === "EXACT").length;
    if (exactGraphs !== 0 && exactGraphs !== input.plan.targets.length) {
      fail("LEGACY_BRIDGE_PARTIAL_WAVE", "wave is partially applied");
    }
    const preflightCanonicalVariantReuses = new Set(
      input.plan.targets
        .filter((_, index) => preflight[index]?.variantState === "EXACT")
        .map((target) => target.variant.id),
    ).size;
    if (
      input.standingPolicy
      && (
        exactGraphs !== 0
        || preflightCanonicalVariantReuses
          !== input.standingPreflightReport.counts.canonicalVariantReuses
        || donorVariantDecisionReuses
          !== input.standingPreflightReport.counts.donorVariantDecisionReuses
      )
    ) {
      fail(
        "LEGACY_BRIDGE_STANDING_PREFLIGHT_DRIFT",
        "canonical database state changed after the standing-policy preflight",
      );
    }
    if (exactGraphs === 0) {
      canonicalVariantReuses = await applyWaveRows(tx, input.plan.targets);
      if (canonicalVariantReuses !== preflightCanonicalVariantReuses) {
        fail(
          "LEGACY_BRIDGE_TRANSACTION_PREFLIGHT_DRIFT",
          "canonical variant state changed inside the write transaction",
        );
      }
      insertedRows =
        input.plan.databaseWrites.maximumRows - canonicalVariantReuses;
      exactExistingRows = canonicalVariantReuses;
      donorIdentityTransitions =
        input.plan.databaseWrites.donorIdentityTransitions;
    } else {
      exactExistingRows = input.plan.databaseWrites.maximumRows;
      canonicalVariantReuses = input.plan.databaseWrites.canonicalProductVariants;
    }
    const violations = await foreignKeyViolations(tx);
    if (violations.length) {
      fail("LEGACY_BRIDGE_FOREIGN_KEY_VIOLATION", violations.join("; "));
    }
    const snapshots = await readProductTruthSnapshotsInTransaction(tx, {
      scopes: input.plan.targets.map((target) => ({
        sku: target.sku,
        channel: target.channel,
        storeIndex: target.storeIndex,
      })),
      expectedManifestSha256: input.plan.source.manifestSha256,
      asOf: startedAt,
      maxPriceAgeMs: 24 * 60 * 60 * 1_000,
    });
    bundleFactoryReady = snapshots.filter(
      (snapshot) => snapshot.views.bundleFactory.ready,
    ).length;
    listingImprovementReady = snapshots.filter(
      (snapshot) => snapshot.views.listingImprovement.ready,
    ).length;
    unitEconomicsUnsourceable = snapshots.filter(
      (snapshot) => snapshot.views.unitEconomics.status === "UNSOURCEABLE",
    ).length;
    procurementReady = snapshots.filter(
      (snapshot) => snapshot.views.procurement.ready,
    ).length;
    const expectedBundleFactoryReady = input.plan.targets.filter(
      (target) => target.expectedReadiness.bundleFactory,
    ).length;
    const expectedListingImprovementReady = input.plan.targets.filter(
      (target) => target.expectedReadiness.listingImprovement,
    ).length;
    const expectedUnitEconomicsUnsourceable = input.plan.targets.filter(
      (target) => target.expectedReadiness.unitEconomics === "UNSOURCEABLE",
    ).length;
    const expectedProcurementReady = input.plan.targets.filter(
      (target) => target.expectedReadiness.procurement,
    ).length;
    if (
      bundleFactoryReady !== expectedBundleFactoryReady
      || listingImprovementReady !== expectedListingImprovementReady
      || unitEconomicsUnsourceable !== expectedUnitEconomicsUnsourceable
      || procurementReady !== expectedProcurementReady
    ) {
      fail(
        "LEGACY_BRIDGE_READ_CONTRACT_VERIFY_FAILED",
        [
          `bundle=${bundleFactoryReady}/${expectedBundleFactoryReady}`,
          `listing=${listingImprovementReady}/${expectedListingImprovementReady}`,
          `unsourceable=${unitEconomicsUnsourceable}/${expectedUnitEconomicsUnsourceable}`,
          `procurement=${procurementReady}/${expectedProcurementReady}`,
        ].join(" "),
      );
    }
    await tx.commit();
  } catch (error) {
    try {
      await tx.rollback();
    } catch {
      // The original failure is authoritative; a closed/rolled-back
      // transaction may reject a second rollback call.
    }
    if (error instanceof ProductTruthLegacyBridgeApplyError) throw error;
    fail(
      "LEGACY_BRIDGE_TRANSACTION_FAILED",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  for (const target of input.plan.targets) {
    await verifyAppliedTarget(input.db, target);
  }
  const violations = await foreignKeyViolations(input.db);
  if (violations.length) {
    fail("LEGACY_BRIDGE_POST_VERIFY_FAILED", violations.join("; "));
  }
  const completedAt = requestedCompletedAt ?? new Date().toISOString();
  return {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_APPLY_REPORT_VERSION,
    status: insertedRows > 0 ? "APPLIED" : "ALREADY_APPLIED",
    planId: input.plan.planId,
    planSha256: input.planSha256,
    approvalId: authorizationId,
    approvalSha256: authorizationSha256,
    authorization,
    databaseTargetFingerprint: input.databaseTargetFingerprint,
    startedAt,
    completedAt,
    counts: {
      targets: input.plan.targets.length,
      insertedRows,
      exactExistingRows,
      canonicalVariantReuses,
      donorVariantDecisionReuses,
      donorIdentityTransitions,
    },
    verification: {
      listingKeys: input.plan.targets.map((target) => target.listingKey),
      bundleFactoryReady,
      listingImprovementReady,
      unitEconomicsUnsourceable,
      procurementReady,
      foreignKeyViolations: [],
      consumerCutoverChanged: false,
    },
    claims: input.plan.claims,
  };
}
