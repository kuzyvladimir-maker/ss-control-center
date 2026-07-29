import { createHash } from "node:crypto";

import {
  CANONICAL_PRODUCT_MATCHER_VERSION,
  CANONICAL_TITLE_NEUTRAL_TOKENS,
  matchCanonicalProduct,
  matchCanonicalProductTitle,
  normalizeIdentityTokens,
  parseCanonicalSize,
  type CanonicalMatchReasonCode,
  type CanonicalMatchVerdict,
  type CanonicalProductIdentity,
} from "./canonical-product-match";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
} from "./canonical-product-match-provenance";
import {
  buildCanonicalProductVariantKey,
  type CanonicalProductVariantKey,
} from "./canonical-product-variant";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  evaluatePriceEvidenceEligibility,
  PRICE_EVIDENCE_POLICY_VERSION,
} from "./price-evidence-policy";
import {
  parseProductTruthAuthoritativeWalmartOuterPackTitle,
} from "./product-truth-authoritative-walmart-item-title";

/**
 * This is an immutable, read-only migration plan over the existing legacy
 * catalog. It is deliberately not a third product catalog and it never treats
 * a historical `costMethod=exact` flag as identity proof.
 */
export const PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION =
  "product-truth-legacy-bridge-snapshot/1.7.0" as const;
export const PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION =
  "product-truth-legacy-bridge-plan/1.7.0" as const;
export const PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION =
  "product-truth-legacy-bridge-policy/1.5.0" as const;
export const PRODUCT_TRUTH_LIVE_IMAGE_BARCODE_EVIDENCE_VERSION =
  "product-truth-live-image-barcode-evidence/1.0.0" as const;
export const PRODUCT_TRUTH_DIRECT_TARGET_CONTENT_EVIDENCE_VERSION =
  "product-truth-direct-target-content-evidence/1.0.0" as const;
export const PRODUCT_TRUTH_AUTHORITATIVE_WALMART_ITEM_REPORT_EVIDENCE_VERSION =
  "product-truth-authoritative-walmart-item-report-evidence/1.0.0" as const;
export const PRODUCT_TRUTH_LEGACY_BRIDGE_PRICE_MAX_AGE_MS =
  24 * 60 * 60 * 1_000;

export type ProductTruthBridgeComponentDisposition =
  | "ALREADY_CANONICAL"
  | "EXACT_CONTENT_AND_PRICE_CANDIDATE"
  | "EXACT_CONTENT_ONLY_CANDIDATE"
  | "EXACT_IDENTITY_ONLY_CANDIDATE"
  | "PRICE_ONLY_ESTIMATE"
  | "QUARANTINE";

export type ProductTruthBridgeScopeDisposition =
  | "ALREADY_CANONICAL"
  | "EXACT_CANONICALIZATION_CANDIDATE"
  | "CONTENT_ONLY_CANONICALIZATION_CANDIDATE"
  | "IDENTITY_ONLY_CANONICALIZATION_CANDIDATE"
  | "QUARANTINE";

export type ProductTruthBridgeIdentityProof =
  | "EXACT_GTIN"
  | "EXACT_LIVE_IMAGE_BARCODE"
  | "EXACT_AUTHORITATIVE_WALMART_REPORT_TITLE"
  | "STRICT_TITLE_MATCH"
  | "NONE";

export type ProductTruthBridgeBlockerCode =
  | "PRODUCT_IDENTITY_MISSING"
  | "PRODUCT_IDENTITY_INVALID_JSON"
  | "PRODUCT_IDENTITY_INVALID"
  | "LEGACY_COMPONENT_MISSING"
  | "LEGACY_COMPONENT_COUNT_MISMATCH"
  | "LEGACY_DONOR_LINK_MISSING"
  | "LEGACY_DONOR_LINK_CONFLICT"
  | "LEGACY_DONOR_ORPHANED"
  | "BUNDLE_COMPONENT_BRAND_UNPROVEN"
  | "TARGET_VARIANT_INVALID"
  | "DONOR_TITLE_MATCH_REJECTED"
  | "DONOR_TITLE_MATCH_AMBIGUOUS"
  | "DONOR_TITLE_MATCH_ESTIMATE_ONLY"
  | "LIVE_BARCODE_EVIDENCE_INVALID"
  | "LIVE_BARCODE_IDENTITY_CONTRADICTION"
  | "DIRECT_TARGET_CONTENT_EVIDENCE_INVALID"
  | "FIRST_PARTY_DIRECT_OFFER_MISSING"
  | "CANONICAL_DONOR_VARIANT_CONFLICT"
  | "CANONICAL_LISTING_STATE_INVALID";

export interface ProductTruthLegacyBridgeManifestBinding {
  schemaVersion: string;
  sha256: string;
  asOf: string;
  listingCount: number;
}

export interface ProductTruthLegacyBridgeListingRow {
  listingKey: string;
  channel: "amazon" | "walmart";
  storeIndex: number;
  sku: string;
  listingUpc: string | null;
  listingUpcSource: string | null;
  priorityGmv30d: number | null;
  priorityOrders30d: number | null;
  priorityUnits30d: number | null;
  priorityObservedAt: string | null;
  productIdentityJson: string | null;
  productIdentityUpdatedAt: string | null;
}

export interface ProductTruthLegacyBridgeComponentRow {
  id: string;
  sku: string;
  idx: number;
  product: string | null;
  flavor: string | null;
  size: string | null;
  qty: number;
  costMethod: string | null;
  retailer: string | null;
  matchedTitle: string | null;
  perUnitCost: number | null;
  lineCost: number | null;
  donorProductId: string | null;
  contentDonorProductId: string | null;
  priceEvidenceDonorProductId: string | null;
  priceEvidenceOfferId: string | null;
}

export interface ProductTruthLegacyBridgeDonorRow {
  id: string;
  brand: string | null;
  productLine: string | null;
  flavor: string | null;
  containerType: string | null;
  size: string | null;
  category: string | null;
  upc: string | null;
  gtin: string | null;
  title: string | null;
  description: string | null;
  bullets: string | null;
  attributes: string | null;
  nutritionFacts: string | null;
  ingredients: string | null;
  mainImageUrl: string | null;
  imageUrls: string | null;
  identityKey: string;
  identityStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductTruthLegacyBridgeOfferRow {
  id: string;
  donorProductId: string;
  retailer: string;
  retailerProductId: string;
  via: string;
  price: number | null;
  packSizeSeen: number | null;
  pricePerUnit: number | null;
  currency: string;
  zip: string | null;
  localityEvidence: string | null;
  inStock: boolean | null;
  productUrl: string | null;
  isFirstParty: boolean;
  sourceApi: string | null;
  fetchedAt: string | null;
}

export interface ProductTruthLegacyBridgeCanonicalDonorBindingRow {
  donorProductId: string;
  canonicalVariantId: string;
  canonicalIdentityJson?: string | null;
  decisionId: string;
  decisionStatus: string;
  decidedAt: string;
}

export interface ProductTruthLegacyBridgeCanonicalListingComponentRow {
  listingKey: string;
  skuCostId: string;
  componentIndex: number;
  evidenceStatus: string;
  targetCanonicalVariantId: string;
  contentCanonicalVariantId: string | null;
  contentObservationId: string | null;
  observedContentCanonicalVariantId: string | null;
  decisionId?: string | null;
  decisionStatus: string | null;
  decisionCanonicalVariantId: string | null;
  recipeTargetCanonicalVariantId?: string | null;
  recipeDonorProductId?: string | null;
  recipeVariantDecisionId?: string | null;
  recipeComponentEvidenceHash?: string | null;
  recipeComponentEvidenceJson?: string | null;
}

export interface ProductTruthLiveImageBarcodeEvidence {
  schemaVersion: typeof PRODUCT_TRUTH_LIVE_IMAGE_BARCODE_EVIDENCE_VERSION;
  listingKey: string;
  componentIndex: number;
  capturedAt: string;
  sourceImageFile: string;
  image: {
    imageId: string;
    slot: string;
    sourceAssetSha256: string;
    modelAssetSha256: string;
  };
  barcode: {
    decoder: "APPLE_VISION_VNDETECTBARCODESREQUEST";
    symbology: string;
    payload: string;
    normalizedGtin14: string;
    confidence: number;
  };
  visualObservation: {
    brandText: string;
    productText: string;
    readableIdentity: "clear";
    multipleDistinctProducts: "no";
    gridCellKind: "single_sellable_package";
    externalPackageCount: 1;
    identityModifiers: string[];
  };
  buyerPdp: {
    title: string;
    brand: string | null;
    productType: string | null;
    productLine: string | null;
    flavor: string | null;
    count: number | null;
    multipackQuantity: number | null;
    containerType: string | null;
    netContent: string | null;
    foodCondition: string | null;
  };
  retailerContent: {
    retailer: "target";
    retailerProductId: string;
    productUrl: string;
    finalUrl: string;
    httpStatus: 200;
    fetchedAt: string;
    htmlFile: string;
    htmlSha256: string;
    normalizedGtin14: string;
    title: string;
    description: string;
    bullets: string[];
    attributes: string[];
    nutritionFacts: Record<string, unknown>;
    ingredients: string;
    allergens: string;
    mainImageUrl?: string;
    imageUrls?: string[];
    category?: string;
    classificationEvidence?: {
      departmentName: string;
      productTypeName: string;
      itemTypeName: string;
      storageClass: "Shelf Stable";
      storageRuleVersion: "target-grocery-crackers-shelf-stable/1.0.0";
    };
  };
  sourceHashes: {
    intakeIndexFileSha256: string;
    intakeIndexBodySha256: string;
    buyerPdpFileSha256: string;
    observerPlanFileSha256: string;
    observerPlanBodySha256: string;
    observationsFileSha256: string;
    executionIndexFileSha256: string;
    executionIndexBodySha256: string;
  };
  safety: {
    modelCalls: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerReads: 1;
    databaseWrites: 0;
    walmartWrites: 0;
  };
}

export interface ProductTruthLegacyBridgeComponentBarcodeEvidenceRow
  extends ProductTruthLiveImageBarcodeEvidence {
  evidenceArtifactSha256: string;
}

export interface ProductTruthDirectTargetContentEvidence {
  schemaVersion: typeof PRODUCT_TRUTH_DIRECT_TARGET_CONTENT_EVIDENCE_VERSION;
  donorProductId: string;
  offerId: string;
  capturedAt: string;
  retailerContent: {
    retailer: "target";
    retailerProductId: string;
    productUrl: string;
    finalUrl: string;
    httpStatus: 200;
    fetchedAt: string;
    htmlFile: string;
    htmlSha256: string;
    normalizedGtin14: string;
    title: string;
    description: string;
    bullets: string[];
    attributes: string[];
    nutritionFacts: Record<string, unknown>;
    ingredients: string;
    allergens: string;
  };
  safety: {
    modelCalls: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerReads: 1;
    databaseWrites: 0;
    walmartWrites: 0;
  };
}

export interface ProductTruthLegacyBridgeDirectTargetContentEvidenceRow
  extends ProductTruthDirectTargetContentEvidence {
  evidenceArtifactSha256: string;
}

export interface ProductTruthAuthoritativeWalmartItemReportEvidenceRow {
  schemaVersion:
    typeof PRODUCT_TRUTH_AUTHORITATIVE_WALMART_ITEM_REPORT_EVIDENCE_VERSION;
  listingKey: string;
  storeIndex: number;
  sku: string;
  itemId: string;
  title: string;
  brand: string | null;
  gtin: string | null;
  upc: string | null;
  itemPageUrl: string | null;
  primaryImageUrl: string | null;
  publishStatus: "PUBLISHED";
  lifecycleStatus: "ACTIVE";
  sourceReportId: string;
  sourceReportName: string;
  sourceReportCapturedAt: string;
  sourceReportSha256: string;
  sourceReportByteLength: number;
  sourceRowNumber: number;
  evidenceRowSha256: string;
}

export interface ProductTruthLegacyBridgeSnapshot {
  schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION;
  capturedAt: string;
  targetFingerprint: string;
  manifest: ProductTruthLegacyBridgeManifestBinding;
  listings: ProductTruthLegacyBridgeListingRow[];
  components: ProductTruthLegacyBridgeComponentRow[];
  donors: ProductTruthLegacyBridgeDonorRow[];
  offers: ProductTruthLegacyBridgeOfferRow[];
  canonicalDonorBindings: ProductTruthLegacyBridgeCanonicalDonorBindingRow[];
  canonicalListingComponents: ProductTruthLegacyBridgeCanonicalListingComponentRow[];
  componentBarcodeEvidence: ProductTruthLegacyBridgeComponentBarcodeEvidenceRow[];
  directTargetContentEvidence: ProductTruthLegacyBridgeDirectTargetContentEvidenceRow[];
  authoritativeWalmartItemReportEvidence:
    ProductTruthAuthoritativeWalmartItemReportEvidenceRow[];
}

export interface ProductTruthBridgeBlocker {
  code: ProductTruthBridgeBlockerCode;
  message: string;
}

export interface ProductTruthBridgeCanonicalVariantProjection {
  canonicalVariantId: string;
  variantKey: string;
  identityHash: string;
  keyVersion: string;
  identityJson: string;
}

export interface ProductTruthLegacyBridgeComponentPlan {
  componentIndex: number;
  qty: number;
  legacyComponentId: string | null;
  donorProductId: string | null;
  legacyDonorProductId: string | null;
  donorOfferId: string | null;
  contentSourceOfferId: string | null;
  identityProof: ProductTruthBridgeIdentityProof;
  contentAssessment: {
    complete: boolean;
    missing: string[];
    storageEvidence: unknown;
    allergensEvidence: unknown;
    contentOverride: {
      evidenceType: "LIVE_IMAGE_BARCODE" | "DIRECT_TARGET_CONTENT";
      sourceUrl: string;
      sourceApi: "target_direct_html";
      observedAt: string;
      evidenceArtifactSha256: string;
      rawHtmlSha256: string;
      title: string;
      description: string;
      bullets: string[];
      attributes: string[];
      nutritionFacts: Record<string, unknown>;
      ingredients: string;
    } | null;
  } | null;
  targetIdentity: CanonicalProductIdentity | null;
  targetVariant: ProductTruthBridgeCanonicalVariantProjection | null;
  matcherVerdict: CanonicalMatchVerdict | null;
  matcherReasonCodes: CanonicalMatchReasonCode[];
  disposition: ProductTruthBridgeComponentDisposition;
  blockers: ProductTruthBridgeBlocker[];
}

export interface ProductTruthLegacyBridgeScopePlan {
  listingKey: string;
  channel: "amazon" | "walmart";
  storeIndex: number;
  sku: string;
  disposition: ProductTruthBridgeScopeDisposition;
  writeEligible: boolean;
  supersedesInvalidCanonicalCostIds: string[];
  blockers: ProductTruthBridgeBlocker[];
  components: ProductTruthLegacyBridgeComponentPlan[];
}

export interface ProductTruthLegacyBridgePlan {
  schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION;
  policyVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION;
  generatedAt: string;
  source: {
    snapshotSchemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION;
    snapshotSha256: string;
    targetFingerprint: string;
    manifest: ProductTruthLegacyBridgeManifestBinding;
  };
  matcher: {
    version: typeof CANONICAL_PRODUCT_MATCHER_VERSION;
    implementationSha256: typeof CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256;
    releaseSha256: typeof CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256;
  };
  pricePolicy: {
    version: typeof PRICE_EVIDENCE_POLICY_VERSION;
    evaluatedAt: string;
    maxAgeMs: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_PRICE_MAX_AGE_MS;
  };
  safety: {
    readOnly: true;
    databaseWrites: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    mutatesLegacyCatalog: false;
    createsAdditionalCatalog: false;
    historicalExactFlagsAreIdentityProof: false;
    priceProxyMayProvideContent: false;
  };
  counts: {
    listingsTotal: number;
    alreadyCanonicalListings: number;
    exactCanonicalizationCandidates: number;
    contentOnlyCanonicalizationCandidates: number;
    identityOnlyCanonicalizationCandidates: number;
    quarantinedListings: number;
    componentsTotal: number;
    alreadyCanonicalComponents: number;
    exactContentAndPriceCandidates: number;
    exactContentOnlyCandidates: number;
    exactIdentityOnlyCandidates: number;
    priceOnlyEstimates: number;
    quarantinedComponents: number;
  };
  scopes: ProductTruthLegacyBridgeScopePlan[];
}

type ParsedProductIdentity = {
  brand?: unknown;
  product_line?: unknown;
  flavor?: unknown;
  size?: unknown;
  container_type?: unknown;
  base_unit?: unknown;
  units_in_listing?: unknown;
  is_bundle?: unknown;
  components?: unknown;
};

type ParsedBundleComponent = {
  product?: unknown;
  flavor?: unknown;
  size?: unknown;
  qty?: unknown;
  container_type?: unknown;
};

function bridgeError(code: ProductTruthBridgeBlockerCode, message: string): ProductTruthBridgeBlocker {
  return { code, message };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function foldedTokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Validate a GTIN-8/12/13/14 and normalize it to a 14-digit comparison key. */
export function normalizeProductTruthBridgeGtin(value: string | null | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(digits.length)) return null;
  let sum = 0;
  for (let index = 0; index < digits.length - 1; index += 1) {
    const digit = Number(digits[index]);
    const distanceFromCheck = digits.length - 1 - index;
    sum += digit * (distanceFromCheck % 2 === 1 ? 3 : 1);
  }
  const expected = (10 - (sum % 10)) % 10;
  if (expected !== Number(digits.at(-1))) return null;
  return digits.padStart(14, "0");
}

function targetRetailerProductIdFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/(^|\.)target\.com$/i.test(url.hostname)) return null;
    return url.pathname.match(/\/A-(\d+)(?:\/|$)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function directTargetContentArtifact(
  evidence: ProductTruthLegacyBridgeDirectTargetContentEvidenceRow,
): ProductTruthDirectTargetContentEvidence {
  return {
    schemaVersion: evidence.schemaVersion,
    donorProductId: evidence.donorProductId,
    offerId: evidence.offerId,
    capturedAt: evidence.capturedAt,
    retailerContent: evidence.retailerContent,
    safety: evidence.safety,
  };
}

function assertDirectTargetContentEvidence(input: {
  evidence: ProductTruthLegacyBridgeDirectTargetContentEvidenceRow;
  donor: ProductTruthLegacyBridgeDonorRow | undefined;
  offer: ProductTruthLegacyBridgeOfferRow | undefined;
  evaluatedAt: string;
}): void {
  const { evidence, donor, offer } = input;
  const invalid = (message: string): never => {
    throw new Error(
      `LEGACY_BRIDGE_DIRECT_TARGET_CONTENT_EVIDENCE_INVALID:${evidence.donorProductId}:${message}`,
    );
  };
  const capturedAt = Date.parse(evidence.capturedAt);
  const evaluatedAt = Date.parse(input.evaluatedAt);
  const donorGtin = donor
    ? normalizeProductTruthBridgeGtin(donor.upc)
      ?? normalizeProductTruthBridgeGtin(donor.gtin)
    : null;
  const productUrlItemId = targetRetailerProductIdFromUrl(
    evidence.retailerContent.productUrl,
  );
  const finalUrlItemId = targetRetailerProductIdFromUrl(
    evidence.retailerContent.finalUrl,
  );
  const offerUrlItemId = targetRetailerProductIdFromUrl(offer?.productUrl);
  const artifactJson = renderProductTruthOperationalJson(
    directTargetContentArtifact(evidence),
  );
  if (
    evidence.schemaVersion !== PRODUCT_TRUTH_DIRECT_TARGET_CONTENT_EVIDENCE_VERSION
    || !/^[a-f0-9]{64}$/.test(evidence.evidenceArtifactSha256)
    || productTruthLegacyBridgeBytesSha256(artifactJson)
      !== evidence.evidenceArtifactSha256
    || !Number.isFinite(capturedAt)
    || !Number.isFinite(evaluatedAt)
    || capturedAt > evaluatedAt
    || evaluatedAt - capturedAt > PRODUCT_TRUTH_LEGACY_BRIDGE_PRICE_MAX_AGE_MS
    || !donor
    || !offer
    || offer.id !== evidence.offerId
    || offer.donorProductId !== evidence.donorProductId
    || offer.retailer.trim().toLowerCase() !== "target"
    || offer.via.trim().toLowerCase() !== "direct"
    || offer.isFirstParty !== true
    || !offer.sourceApi
    || offer.productUrl !== evidence.retailerContent.productUrl
    || productUrlItemId !== evidence.retailerContent.retailerProductId
    || finalUrlItemId !== evidence.retailerContent.retailerProductId
    || offerUrlItemId !== evidence.retailerContent.retailerProductId
    || evidence.retailerContent.retailer !== "target"
    || evidence.retailerContent.httpStatus !== 200
    || evidence.retailerContent.fetchedAt !== evidence.capturedAt
    || !/^[a-f0-9]{64}$/.test(evidence.retailerContent.htmlSha256)
    || !donorGtin
    || donorGtin !== evidence.retailerContent.normalizedGtin14
    || !evidence.retailerContent.title
    || !evidence.retailerContent.description
    || !evidence.retailerContent.bullets.length
    || !evidence.retailerContent.attributes.length
    || !Object.keys(evidence.retailerContent.nutritionFacts).length
    || !evidence.retailerContent.ingredients
    || !evidence.retailerContent.allergens
    || evidence.safety.modelCalls !== 0
    || evidence.safety.providerCalls !== 0
    || evidence.safety.paidCalls !== 0
    || evidence.safety.retailerReads !== 1
    || evidence.safety.databaseWrites !== 0
    || evidence.safety.walmartWrites !== 0
  ) {
    invalid("contract, source graph, GTIN, Target item, freshness, content, or safety gate failed");
  }
}

function containsAllIdentityTokens(haystack: string, needles: string | null | undefined): boolean {
  const available = new Set(normalizeIdentityTokens(haystack));
  return normalizeIdentityTokens(needles).every((token) => available.has(token));
}

function equivalentCanonicalSize(left: string | null, right: string | null): boolean {
  const a = parseCanonicalSize(left);
  const b = parseCanonicalSize(right);
  if (!a || !b || a.dimension !== b.dimension) return false;
  const denominator = Math.max(Math.abs(a.baseAmount), Math.abs(b.baseAmount), Number.EPSILON);
  return Math.abs(a.baseAmount - b.baseAmount) / denominator <= 0.01;
}

function existingModifiers(
  value: CanonicalProductIdentity["modifiers"],
): string[] {
  if (Array.isArray(value)) return [...value];
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function mergeProductLine(
  sourceProductLine: string | null,
  targetProductLine: string | null | undefined,
): string | null {
  const values = [sourceProductLine, targetProductLine]
    .filter((value): value is string => Boolean(value?.trim()));
  if (!values.length) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const token of foldedTokens(value)) {
      if (seen.has(token)) continue;
      seen.add(token);
      result.push(token);
    }
  }
  return result.join(" ");
}

function assessLiveBarcodeEvidence(input: {
  evidence: ProductTruthLegacyBridgeComponentBarcodeEvidenceRow;
  expectedListingKey: string;
  expectedComponentIndex: number;
  expectedQuantity: number;
  evaluatedAt: string;
  targetIdentity: CanonicalProductIdentity;
  donor: ProductTruthLegacyBridgeDonorRow;
}): {
  valid: boolean;
  targetIdentity: CanonicalProductIdentity;
  blockers: ProductTruthBridgeBlocker[];
} {
  const { evidence, donor } = input;
  const blockers: ProductTruthBridgeBlocker[] = [];
  const invalid = (message: string) => blockers.push(
    bridgeError("LIVE_BARCODE_EVIDENCE_INVALID", message),
  );
  const contradiction = (message: string) => blockers.push(
    bridgeError("LIVE_BARCODE_IDENTITY_CONTRADICTION", message),
  );
  const hashes = [
    evidence.evidenceArtifactSha256,
    evidence.image.sourceAssetSha256,
    evidence.image.modelAssetSha256,
    evidence.retailerContent.htmlSha256,
    ...Object.values(evidence.sourceHashes),
  ];
  const retailerContentUrlValid =
    targetRetailerProductIdFromUrl(evidence.retailerContent.productUrl)
      === evidence.retailerContent.retailerProductId
    && targetRetailerProductIdFromUrl(evidence.retailerContent.finalUrl)
      === evidence.retailerContent.retailerProductId;
  if (
    evidence.schemaVersion !== PRODUCT_TRUTH_LIVE_IMAGE_BARCODE_EVIDENCE_VERSION
    || evidence.listingKey !== input.expectedListingKey
    || evidence.componentIndex !== input.expectedComponentIndex
    || !Number.isFinite(Date.parse(evidence.capturedAt))
    || Date.parse(evidence.capturedAt) > Date.parse(input.evaluatedAt)
    || Date.parse(input.evaluatedAt) - Date.parse(evidence.capturedAt)
      > PRODUCT_TRUTH_LEGACY_BRIDGE_PRICE_MAX_AGE_MS
    || hashes.some((value) => !/^[a-f0-9]{64}$/.test(value))
    || evidence.barcode.decoder !== "APPLE_VISION_VNDETECTBARCODESREQUEST"
    || evidence.barcode.confidence < 0.98
    || evidence.barcode.confidence > 1
    || normalizeProductTruthBridgeGtin(evidence.barcode.payload)
      !== evidence.barcode.normalizedGtin14
    || evidence.retailerContent.retailer !== "target"
    || evidence.retailerContent.httpStatus !== 200
    || !retailerContentUrlValid
    || evidence.retailerContent.fetchedAt !== evidence.capturedAt
    || evidence.retailerContent.normalizedGtin14 !== evidence.barcode.normalizedGtin14
    || !evidence.retailerContent.title
    || !evidence.retailerContent.description
    || !evidence.retailerContent.bullets.length
    || !evidence.retailerContent.attributes.length
    || !Object.keys(evidence.retailerContent.nutritionFacts).length
    || !evidence.retailerContent.ingredients
    || !evidence.retailerContent.allergens
    || evidence.visualObservation.readableIdentity !== "clear"
    || evidence.visualObservation.multipleDistinctProducts !== "no"
    || evidence.visualObservation.gridCellKind !== "single_sellable_package"
    || evidence.visualObservation.externalPackageCount !== 1
    || evidence.safety.modelCalls !== 0
    || evidence.safety.providerCalls !== 0
    || evidence.safety.paidCalls !== 0
    || evidence.safety.retailerReads !== 1
    || evidence.safety.databaseWrites !== 0
    || evidence.safety.walmartWrites !== 0
  ) invalid("barcode artifact contract, freshness, hash, decoder, visual, or safety gate failed");

  const donorGtin = normalizeProductTruthBridgeGtin(donor.upc)
    ?? normalizeProductTruthBridgeGtin(donor.gtin);
  if (!donorGtin || donorGtin !== evidence.barcode.normalizedGtin14) {
    contradiction("decoded live package barcode does not equal the linked donor GTIN");
  }
  if (evidence.buyerPdp.multipackQuantity !== input.expectedQuantity) {
    contradiction(
      `buyer PDP multipack ${evidence.buyerPdp.multipackQuantity ?? "missing"}`
      + ` does not equal recipe quantity ${input.expectedQuantity}`,
    );
  }

  const identityText = [
    evidence.visualObservation.brandText,
    evidence.visualObservation.productText,
    evidence.buyerPdp.title,
    evidence.buyerPdp.brand,
    evidence.buyerPdp.productType,
    evidence.buyerPdp.productLine,
    evidence.buyerPdp.flavor,
  ].filter(Boolean).join(" ");
  if (!containsAllIdentityTokens(identityText, input.targetIdentity.brand)) {
    contradiction("live image/PDP does not prove every target brand token");
  }
  if (!containsAllIdentityTokens(identityText, input.targetIdentity.productLine)) {
    contradiction("live image/PDP does not prove every target product-line token");
  }
  if (!containsAllIdentityTokens(identityText, input.targetIdentity.flavor)) {
    contradiction("live image/PDP does not prove every target flavor token");
  }
  if (
    input.targetIdentity.form
    && !containsAllIdentityTokens(
      evidence.buyerPdp.containerType ?? "",
      input.targetIdentity.form,
    )
  ) contradiction("buyer PDP container type does not prove the target form");

  const sizeCandidates = [
    evidence.buyerPdp.count == null ? null : `${evidence.buyerPdp.count} count`,
    evidence.buyerPdp.netContent,
  ];
  if (
    input.targetIdentity.size
    && !sizeCandidates.some((candidate) =>
      equivalentCanonicalSize(String(input.targetIdentity.size), candidate))
  ) contradiction("buyer PDP does not prove the target component size");

  const identityModifiers = [...new Set(
    evidence.visualObservation.identityModifiers.map((value) => value.trim()).filter(Boolean),
  )].sort();
  if (
    !identityModifiers.length
    || !identityModifiers.every((value) =>
      containsAllIdentityTokens(identityText, value)
      && containsAllIdentityTokens(donor.title ?? "", value))
  ) contradiction("variant modifier is not independently present in live pixels/PDP and donor title");

  const augmentedTarget: CanonicalProductIdentity = {
    ...input.targetIdentity,
    productLine: mergeProductLine(
      evidence.buyerPdp.productLine,
      input.targetIdentity.productLine,
    ),
    modifiers: [...new Set([
      ...existingModifiers(input.targetIdentity.modifiers),
      ...identityModifiers,
    ])].sort(),
  };
  const donorTitleMatch = matchCanonicalProductTitle(
    { ...augmentedTarget, form: null },
    { title: donor.title, brand: null },
  );
  if (
    donorTitleMatch.verdict === "REJECT"
    || donorTitleMatch.titleEvidence?.missingTargetTokens.length
    || donorTitleMatch.titleEvidence?.unexplainedCandidateTokens.length
  ) contradiction(
    `barcode donor title remains identity-incompatible: ${donorTitleMatch.reasonCodes.join(",")}`,
  );

  return {
    valid: blockers.length === 0,
    targetIdentity: augmentedTarget,
    blockers,
  };
}

function explicitBundleTarget(
  component: ParsedBundleComponent,
  donorBrand: string | null,
): CanonicalProductIdentity | null {
  const product = stringOrNull(component.product);
  if (!product || !donorBrand) return null;
  const productTokens = foldedTokens(product);
  const brandTokens = foldedTokens(donorBrand);
  if (
    !brandTokens.length
    || brandTokens.length >= productTokens.length
    || brandTokens.some((token, index) => token !== productTokens[index])
  ) return null;
  const productLine = productTokens.slice(brandTokens.length).join(" ");
  if (!productLine) return null;
  return {
    brand: donorBrand,
    productLine,
    flavor: stringOrNull(component.flavor),
    form: stringOrNull(component.container_type),
    size: stringOrNull(component.size),
    outerPackCount: 1,
  };
}

function projectVariant(value: CanonicalProductVariantKey): ProductTruthBridgeCanonicalVariantProjection {
  return {
    canonicalVariantId: value.canonicalVariantId,
    variantKey: value.variantKey,
    identityHash: value.identityHash,
    keyVersion: value.keyVersion,
    identityJson: value.identityJson,
  };
}

function isRegionalRetailer(retailer: string): boolean {
  return ["publix", "aldi", "winndixie", "winn-dixie", "bravo"].includes(retailer);
}

function usableStandardOffer(
  offer: ProductTruthLegacyBridgeOfferRow,
  evaluatedAt: string,
): boolean {
  const retailer = offer.retailer.trim().toLowerCase();
  if (["bjs", "bj's", "sams", "samsclub", "sam's club", "costco"].includes(retailer)) return false;
  if (offer.via.trim().toLowerCase() !== "direct" || offer.isFirstParty !== true) return false;
  if (!offer.productUrl || offer.currency.toUpperCase() !== "USD") return false;
  if (!(Number(offer.price) > 0)) return false;
  if (offer.packSizeSeen != null && offer.packSizeSeen !== 1) return false;
  if (isRegionalRetailer(retailer) && offer.zip !== "33765") return false;
  return evaluatePriceEvidenceEligibility({
    retailer: offer.retailer,
    via: offer.via,
    price: offer.price,
    isFirstParty: offer.isFirstParty,
    inStock: offer.inStock,
    zip: offer.zip,
    localityEvidence: offer.localityEvidence,
    fetchedAt: offer.fetchedAt,
    matchVerdict: "EXACT_IDENTITY",
  }, {
    now: evaluatedAt,
    maxAgeMs: PRODUCT_TRUTH_LEGACY_BRIDGE_PRICE_MAX_AGE_MS,
  }).eligibility === "FACT";
}

function offerUnitPrice(offer: ProductTruthLegacyBridgeOfferRow): number {
  return Number(offer.pricePerUnit) > 0 ? Number(offer.pricePerUnit) : Number(offer.price);
}

function usableContentSourceOffer(offer: ProductTruthLegacyBridgeOfferRow): boolean {
  const retailer = offer.retailer.trim().toLowerCase();
  return !["bjs", "bj's", "sams", "samsclub", "sam's club", "costco"].includes(retailer)
    && offer.via.trim().toLowerCase() === "direct"
    && offer.isFirstParty === true
    && Boolean(offer.productUrl?.startsWith("https://"))
    && Boolean(offer.sourceApi);
}

function chooseContentSourceOffer(
  donorProductId: string,
  offersByDonor: ReadonlyMap<string, readonly ProductTruthLegacyBridgeOfferRow[]>,
  exactTargetRetailerProductId: string | null = null,
): ProductTruthLegacyBridgeOfferRow | null {
  return [...(offersByDonor.get(donorProductId) ?? [])]
    .filter((offer) =>
      usableContentSourceOffer(offer)
      && (
        exactTargetRetailerProductId === null
        || (
          offer.retailer.trim().toLowerCase() === "target"
          && offer.retailerProductId === exactTargetRetailerProductId
          && targetRetailerProductIdFromUrl(offer.productUrl) === exactTargetRetailerProductId
        )
      ))
    .sort((left, right) => {
      const leftTime = Date.parse(left.fetchedAt ?? "");
      const rightTime = Date.parse(right.fetchedAt ?? "");
      return (Number.isFinite(rightTime) ? rightTime : -Infinity)
        - (Number.isFinite(leftTime) ? leftTime : -Infinity)
        || left.retailer.localeCompare(right.retailer)
        || left.id.localeCompare(right.id);
    })[0] ?? null;
}

function parsedJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function explicitStorageEvidence(attributes: string | null): unknown {
  const parsed = parsedJson(attributes);
  if (!Array.isArray(parsed)) return null;
  return parsed.find((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    return /(?:food condition|state of readiness|storage)/i.test(
      String(row.name ?? row.label ?? ""),
    )
      && Boolean(stringOrNull(row.value));
  }) ?? null;
}

function directTargetStorageEvidence(
  evidence: ProductTruthLegacyBridgeDirectTargetContentEvidenceRow | null,
): unknown {
  const value = evidence?.retailerContent.attributes.find((attribute) =>
    /^(?:food condition|state of readiness|storage)\s*:/i.test(attribute.trim()));
  if (!value) return null;
  return {
    source: "targetDirectHtml.productDescription.attributes",
    value: value.replace(/^[^:]+:\s*/, "").trim() || value,
  };
}

function explicitAllergensEvidence(
  nutritionFacts: string | null,
  ingredients: string | null,
): unknown {
  const nutrition = parsedJson(nutritionFacts);
  if (nutrition && typeof nutrition === "object" && !Array.isArray(nutrition)) {
    const record = nutrition as Record<string, unknown>;
    const key = Object.keys(record).find((candidate) => /allergen/i.test(candidate));
    if (key) return { source: "nutritionFacts", value: record[key] };
  }
  if (Array.isArray(nutrition)) {
    const item = nutrition.find((candidate) =>
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
      && /allergen/i.test(String((candidate as Record<string, unknown>).name ?? "")));
    if (item) return { source: "nutritionFacts", value: item };
  }
  const explicit = ingredients?.match(/\b(?:contains|may contain)\s*:[^|\n]+/i)?.[0]?.trim();
  return explicit ? { source: "ingredients", value: explicit } : null;
}

function httpsUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function assessLegacyContent(
  donor: ProductTruthLegacyBridgeDonorRow,
  sourceOffer: ProductTruthLegacyBridgeOfferRow | null,
  barcodeEvidence: ProductTruthLegacyBridgeComponentBarcodeEvidenceRow | null = null,
  directTargetEvidence:
    ProductTruthLegacyBridgeDirectTargetContentEvidenceRow | null = null,
): NonNullable<ProductTruthLegacyBridgeComponentPlan["contentAssessment"]> {
  const missing: string[] = [];
  const images = parsedJson(donor.imageUrls);
  const imageUrls = Array.isArray(images)
    ? images.filter((value): value is string => typeof value === "string")
    : [];
  const targetContent = barcodeEvidence?.retailerContent
    ?? directTargetEvidence?.retailerContent
    ?? null;
  const evidenceArtifactSha256 = barcodeEvidence?.evidenceArtifactSha256
    ?? directTargetEvidence?.evidenceArtifactSha256
    ?? null;
  const contentOverride = targetContent && evidenceArtifactSha256 ? {
    evidenceType: barcodeEvidence
      ? "LIVE_IMAGE_BARCODE" as const
      : "DIRECT_TARGET_CONTENT" as const,
    sourceUrl: targetContent.finalUrl,
    sourceApi: "target_direct_html" as const,
    observedAt: targetContent.fetchedAt,
    evidenceArtifactSha256,
    rawHtmlSha256: targetContent.htmlSha256,
    title: targetContent.title,
    description: targetContent.description,
    bullets: targetContent.bullets,
    attributes: targetContent.attributes,
    nutritionFacts: targetContent.nutritionFacts,
    ingredients: targetContent.ingredients,
  } : null;
  const storageEvidence = barcodeEvidence?.buyerPdp.foodCondition
    ? {
        source: "walmartBuyerPdp.foodCondition",
        value: barcodeEvidence.buyerPdp.foodCondition,
      }
    : directTargetStorageEvidence(directTargetEvidence)
      ?? explicitStorageEvidence(donor.attributes);
  const allergensEvidence = targetContent?.allergens
    ? {
        source: "targetDirectHtml.nutritionFacts.warning",
        value: targetContent.allergens,
      }
    : explicitAllergensEvidence(donor.nutritionFacts, donor.ingredients);
  if (!donor.title && !contentOverride?.title) missing.push("TITLE");
  if (!donor.description && !contentOverride?.description) missing.push("DESCRIPTION");
  if (!normalizeProductTruthBridgeGtin(donor.upc)) missing.push("MANUFACTURER_UPC");
  if (!donor.ingredients && !contentOverride?.ingredients) missing.push("INGREDIENTS");
  if (!donor.nutritionFacts && !contentOverride?.nutritionFacts) missing.push("NUTRITION");
  if (!donor.category) missing.push("CATEGORY");
  if (!storageEvidence) missing.push("STORAGE");
  if (!allergensEvidence) missing.push("ALLERGENS");
  if (!httpsUrl(donor.mainImageUrl)) missing.push("MAIN_IMAGE");
  if (
    !imageUrls.length
    || imageUrls.some((url) => !httpsUrl(url))
    || !donor.mainImageUrl
    || !imageUrls.includes(donor.mainImageUrl)
  ) missing.push("GALLERY");
  if (!sourceOffer) missing.push("EXACT_SOURCE_URL");
  return {
    complete: missing.length === 0,
    missing,
    storageEvidence,
    allergensEvidence,
    contentOverride,
  };
}

function chooseOffer(
  donorProductId: string,
  explicitOfferId: string | null,
  componentRetailer: string | null,
  evaluatedAt: string,
  offersById: ReadonlyMap<string, ProductTruthLegacyBridgeOfferRow>,
  offersByDonor: ReadonlyMap<string, readonly ProductTruthLegacyBridgeOfferRow[]>,
): ProductTruthLegacyBridgeOfferRow | null {
  if (explicitOfferId) {
    const explicit = offersById.get(explicitOfferId);
    if (
      explicit
      && explicit.donorProductId === donorProductId
      && usableStandardOffer(explicit, evaluatedAt)
    ) return explicit;
  }
  const preferredRetailer = componentRetailer?.trim().toLowerCase() || null;
  const candidates = [...(offersByDonor.get(donorProductId) ?? [])]
    .filter((offer) => usableStandardOffer(offer, evaluatedAt))
    .sort((left, right) => {
      const leftPreferred = preferredRetailer && left.retailer.toLowerCase() === preferredRetailer ? 0 : 1;
      const rightPreferred = preferredRetailer && right.retailer.toLowerCase() === preferredRetailer ? 0 : 1;
      return leftPreferred - rightPreferred
        || offerUnitPrice(left) - offerUnitPrice(right)
        || left.retailer.localeCompare(right.retailer)
        || left.id.localeCompare(right.id);
    });
  return candidates[0] ?? null;
}

function parseIdentity(
  value: string | null,
): { identity: ParsedProductIdentity | null; blockers: ProductTruthBridgeBlocker[] } {
  if (!value) {
    return {
      identity: null,
      blockers: [bridgeError("PRODUCT_IDENTITY_MISSING", "SkuShippingData.productIdentity is empty")],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {
      identity: null,
      blockers: [bridgeError("PRODUCT_IDENTITY_INVALID_JSON", "productIdentity is not valid JSON")],
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      identity: null,
      blockers: [bridgeError("PRODUCT_IDENTITY_INVALID", "productIdentity must be an object")],
    };
  }
  return { identity: parsed as ParsedProductIdentity, blockers: [] };
}

function linkedDonorId(
  component: ProductTruthLegacyBridgeComponentRow,
): { donorProductId: string | null; blockers: ProductTruthBridgeBlocker[] } {
  const contentIds = [...new Set(
    [component.contentDonorProductId, component.donorProductId].filter(
      (value): value is string => Boolean(value),
    ),
  )];
  if (contentIds.length > 1) {
    return {
      donorProductId: null,
      blockers: [bridgeError(
        "LEGACY_DONOR_LINK_CONFLICT",
        "deprecated and exact-content donor links disagree",
      )],
    };
  }
  const donorProductId = contentIds[0] ?? component.priceEvidenceDonorProductId;
  if (!donorProductId) {
    return {
      donorProductId: null,
      blockers: [bridgeError("LEGACY_DONOR_LINK_MISSING", "component has no donor link")],
    };
  }
  return { donorProductId, blockers: [] };
}

function componentPlan(input: {
  listingKey: string;
  componentIndex: number;
  quantity: number;
  targetIdentity: CanonicalProductIdentity | null;
  legacyComponent: ProductTruthLegacyBridgeComponentRow | null;
  barcodeEvidence: ProductTruthLegacyBridgeComponentBarcodeEvidenceRow | null;
  targetBlockers?: ProductTruthBridgeBlocker[];
  listingGtin: string | null;
  evaluatedAt: string;
  donorsById: ReadonlyMap<string, ProductTruthLegacyBridgeDonorRow>;
  donorsByGtin: ReadonlyMap<string, readonly ProductTruthLegacyBridgeDonorRow[]>;
  donorsByLeadingTitleToken: ReadonlyMap<
    string,
    readonly ProductTruthLegacyBridgeDonorRow[]
  >;
  canonicalDonorBindings: ReadonlyMap<
    string,
    readonly ProductTruthLegacyBridgeCanonicalDonorBindingRow[]
  >;
  directTargetContentEvidenceByDonor: ReadonlyMap<
    string,
    ProductTruthLegacyBridgeDirectTargetContentEvidenceRow
  >;
  offersById: ReadonlyMap<string, ProductTruthLegacyBridgeOfferRow>;
  offersByDonor: ReadonlyMap<string, readonly ProductTruthLegacyBridgeOfferRow[]>;
}): ProductTruthLegacyBridgeComponentPlan {
  let blockers = [...(input.targetBlockers ?? [])];
  if (!input.legacyComponent) {
    blockers.push(bridgeError("LEGACY_COMPONENT_MISSING", "no SkuComponent row exists at this index"));
  }
  if (!input.targetIdentity) {
    return {
      componentIndex: input.componentIndex,
      qty: input.quantity,
      legacyComponentId: input.legacyComponent?.id ?? null,
      donorProductId: null,
      legacyDonorProductId: null,
      donorOfferId: null,
      contentSourceOfferId: null,
      identityProof: "NONE",
      contentAssessment: null,
      targetIdentity: null,
      targetVariant: null,
      matcherVerdict: null,
      matcherReasonCodes: [],
      disposition: "QUARANTINE",
      blockers,
    };
  }

  if (!input.legacyComponent) {
    return {
      componentIndex: input.componentIndex,
      qty: input.quantity,
      legacyComponentId: null,
      donorProductId: null,
      legacyDonorProductId: null,
      donorOfferId: null,
      contentSourceOfferId: null,
      identityProof: "NONE",
      contentAssessment: null,
      targetIdentity: input.targetIdentity,
      targetVariant: null,
      matcherVerdict: null,
      matcherReasonCodes: [],
      disposition: "QUARANTINE",
      blockers,
    };
  }

  const link = linkedDonorId(input.legacyComponent);
  blockers.push(...link.blockers);
  const linkedDonor = link.donorProductId ? input.donorsById.get(link.donorProductId) : null;
  const gtinCandidates = input.listingGtin
    ? [...(input.donorsByGtin.get(input.listingGtin) ?? [])]
    : [];
  const exactGtinDonor = gtinCandidates
    .sort((left, right) => {
      const leftLinked = left.id === link.donorProductId ? 0 : 1;
      const rightLinked = right.id === link.donorProductId ? 0 : 1;
      return leftLinked - rightLinked
        || Number(Boolean(right.title)) - Number(Boolean(left.title))
        || left.id.localeCompare(right.id);
    })[0] ?? null;
  const barcodeGtin = input.barcodeEvidence?.barcode.normalizedGtin14 ?? null;
  const barcodeCandidates = barcodeGtin
    ? [...(input.donorsByGtin.get(barcodeGtin) ?? [])]
    : [];
  const barcodeDonor = barcodeCandidates
    .sort((left, right) => {
      const leftLinked = left.id === link.donorProductId ? 0 : 1;
      const rightLinked = right.id === link.donorProductId ? 0 : 1;
      return leftLinked - rightLinked
        || Number(Boolean(right.title)) - Number(Boolean(left.title))
        || left.id.localeCompare(right.id);
    })[0] ?? null;
  let resolvedTargetIdentity = input.targetIdentity;
  let acceptedBarcodeDonor: ProductTruthLegacyBridgeDonorRow | null = null;
  if (input.barcodeEvidence) {
    if (!barcodeDonor) {
      blockers.push(bridgeError(
        "LIVE_BARCODE_EVIDENCE_INVALID",
        "decoded barcode has no exact donor GTIN candidate",
      ));
    } else {
      const assessment = assessLiveBarcodeEvidence({
        evidence: input.barcodeEvidence,
        expectedListingKey: input.listingKey,
        expectedComponentIndex: input.componentIndex,
        expectedQuantity: input.quantity,
        evaluatedAt: input.evaluatedAt,
        targetIdentity: input.targetIdentity,
        donor: barcodeDonor,
      });
      blockers.push(...assessment.blockers);
      if (assessment.valid) {
        acceptedBarcodeDonor = barcodeDonor;
        resolvedTargetIdentity = assessment.targetIdentity;
      }
    }
  }
  let donor = acceptedBarcodeDonor ?? exactGtinDonor ?? linkedDonor;
  if (link.donorProductId && !linkedDonor) {
    blockers.push(bridgeError("LEGACY_DONOR_ORPHANED", `DonorProduct ${link.donorProductId} does not exist`));
  }

  let targetVariant: ProductTruthBridgeCanonicalVariantProjection | null = null;
  try {
    targetVariant = projectVariant(buildCanonicalProductVariantKey(resolvedTargetIdentity));
  } catch (error) {
    blockers.push(bridgeError(
      "TARGET_VARIANT_INVALID",
      error instanceof Error ? error.message : "target variant could not be built",
    ));
  }
  if (!targetVariant) {
    return {
      componentIndex: input.componentIndex,
      qty: input.quantity,
      legacyComponentId: input.legacyComponent.id,
      donorProductId: donor?.id ?? link.donorProductId,
      legacyDonorProductId: link.donorProductId,
      donorOfferId: null,
      contentSourceOfferId: null,
      identityProof: "NONE",
      contentAssessment: null,
      targetIdentity: resolvedTargetIdentity,
      targetVariant: null,
      matcherVerdict: null,
      matcherReasonCodes: [],
      disposition: "QUARANTINE",
      blockers,
    };
  }

  // Conflicting legacy content links require adjudication. Independent GTIN or
  // title evidence must not silently choose one side and erase that conflict.
  if (link.blockers.some((blocker) => blocker.code === "LEGACY_DONOR_LINK_CONFLICT")) {
    return {
      componentIndex: input.componentIndex,
      qty: input.quantity,
      legacyComponentId: input.legacyComponent.id,
      donorProductId: donor?.id ?? null,
      legacyDonorProductId: link.donorProductId,
      donorOfferId: null,
      contentSourceOfferId: null,
      identityProof: "NONE",
      contentAssessment: null,
      targetIdentity: resolvedTargetIdentity,
      targetVariant,
      matcherVerdict: null,
      matcherReasonCodes: [],
      disposition: "QUARANTINE",
      blockers,
    };
  }

  let titleMatch = donor
    ? matchCanonicalProductTitle(resolvedTargetIdentity, {
        title: donor.title,
        // Legacy donor.brand is frequently truncated. The strict bridge still
        // proves the complete target brand as a brand-led phrase in donor.title.
        brand: null,
      })
    : null;
  if (
    !acceptedBarcodeDonor
    && !exactGtinDonor
    && (
      !donor
      || titleMatch?.verdict !== "EXACT_IDENTITY"
      || !donorCanonicalBindingCompatible({
        donor,
        targetVariant,
        canonicalDonorBindings: input.canonicalDonorBindings,
      })
    )
  ) {
    const leadingBrandToken = foldedTokens(
      typeof resolvedTargetIdentity.brand === "string"
        ? resolvedTargetIdentity.brand
        : "",
    )[0] ?? null;
    const exactCandidates = leadingBrandToken
      ? (input.donorsByLeadingTitleToken.get(leadingBrandToken) ?? [])
          .map((candidate) => ({
            donor: candidate,
            match: matchCanonicalProductTitle(resolvedTargetIdentity, {
              title: candidate.title,
              brand: null,
            }),
          }))
          .filter(({ donor: candidate, match }) =>
            match.verdict === "EXACT_IDENTITY"
            && donorCanonicalBindingCompatible({
              donor: candidate,
              targetVariant,
              canonicalDonorBindings: input.canonicalDonorBindings,
            }))
          .sort((left, right) => left.donor.id.localeCompare(right.donor.id))
      : [];
    if (exactCandidates.length === 1) {
      donor = exactCandidates[0]!.donor;
      titleMatch = exactCandidates[0]!.match;
      // A unique strict exact donor repairs only missing/orphaned/stale legacy
      // linkage. The legacy row remains immutable and its original donor ID is
      // retained separately in the plan evidence.
      blockers = blockers.filter((blocker) =>
        blocker.code !== "LEGACY_DONOR_LINK_MISSING"
        && blocker.code !== "LEGACY_DONOR_ORPHANED");
    } else if (exactCandidates.length > 1) {
      blockers.push(bridgeError(
        "DONOR_TITLE_MATCH_AMBIGUOUS",
        `strict matcher found ${exactCandidates.length} exact donor candidates: ${
          exactCandidates.map(({ donor: candidate }) => candidate.id).join(",")
        }`,
      ));
      return {
        componentIndex: input.componentIndex,
        qty: input.quantity,
        legacyComponentId: input.legacyComponent.id,
        donorProductId: donor?.id ?? link.donorProductId,
        legacyDonorProductId: link.donorProductId,
        donorOfferId: null,
        contentSourceOfferId: null,
        identityProof: "NONE",
        contentAssessment: null,
        targetIdentity: resolvedTargetIdentity,
        targetVariant,
        matcherVerdict: null,
        matcherReasonCodes: [],
        disposition: "QUARANTINE",
        blockers,
      };
    }
  }

  if (!donor) {
    return {
      componentIndex: input.componentIndex,
      qty: input.quantity,
      legacyComponentId: input.legacyComponent.id,
      donorProductId: link.donorProductId,
      legacyDonorProductId: link.donorProductId,
      donorOfferId: null,
      contentSourceOfferId: null,
      identityProof: "NONE",
      contentAssessment: null,
      targetIdentity: resolvedTargetIdentity,
      targetVariant,
      matcherVerdict: null,
      matcherReasonCodes: [],
      disposition: "QUARANTINE",
      blockers,
    };
  }

  const canonicalConflict = canonicalDonorConflictBlocker({
    donor,
    targetVariant,
    canonicalDonorBindings: input.canonicalDonorBindings,
  });
  if (canonicalConflict) {
    blockers.push(canonicalConflict);
    return {
      componentIndex: input.componentIndex,
      qty: input.quantity,
      legacyComponentId: input.legacyComponent.id,
      donorProductId: donor.id,
      legacyDonorProductId: link.donorProductId,
      donorOfferId: null,
      contentSourceOfferId: null,
      identityProof: "NONE",
      contentAssessment: null,
      targetIdentity: resolvedTargetIdentity,
      targetVariant,
      matcherVerdict: null,
      matcherReasonCodes: [],
      disposition: "QUARANTINE",
      blockers,
    };
  }

  if (acceptedBarcodeDonor || exactGtinDonor) {
    const contentSourceOffer = chooseContentSourceOffer(
      donor.id,
      input.offersByDonor,
      acceptedBarcodeDonor && input.barcodeEvidence
        ? input.barcodeEvidence.retailerContent.retailerProductId
        : null,
    );
    const contentAssessment = assessLegacyContent(
      donor,
      contentSourceOffer,
      acceptedBarcodeDonor ? input.barcodeEvidence : null,
    );
    const offer = chooseOffer(
      donor.id,
      input.legacyComponent.priceEvidenceOfferId,
      input.legacyComponent.retailer,
      input.evaluatedAt,
      input.offersById,
      input.offersByDonor,
    );
    if (!offer) {
      blockers.push(bridgeError(
        "FIRST_PARTY_DIRECT_OFFER_MISSING",
        "exact GTIN donor has no standard non-club first-party direct USD offer",
      ));
    }
    // A valid manufacturer GTIN is variant-specific identity evidence. It may
    // repair a stale legacy donor link, but the legacy row is never mutated.
    return {
      componentIndex: input.componentIndex,
      qty: input.quantity,
      legacyComponentId: input.legacyComponent.id,
      donorProductId: donor.id,
      legacyDonorProductId: link.donorProductId,
      donorOfferId: offer?.id ?? null,
      contentSourceOfferId: contentSourceOffer?.id ?? null,
      identityProof: acceptedBarcodeDonor ? "EXACT_LIVE_IMAGE_BARCODE" : "EXACT_GTIN",
      contentAssessment,
      targetIdentity: resolvedTargetIdentity,
      targetVariant,
      matcherVerdict: null,
      matcherReasonCodes: [],
      disposition: !contentAssessment.complete
        ? "EXACT_IDENTITY_ONLY_CANDIDATE"
        : offer
          ? "EXACT_CONTENT_AND_PRICE_CANDIDATE"
          : "EXACT_CONTENT_ONLY_CANDIDATE",
      blockers: blockers.filter((blocker) =>
        blocker.code !== "LEGACY_DONOR_LINK_MISSING"
        && blocker.code !== "LEGACY_DONOR_ORPHANED"),
    };
  }

  const match = titleMatch ?? matchCanonicalProductTitle(resolvedTargetIdentity, {
    title: donor.title,
    brand: null,
  });
  if (match.verdict === "REJECT") {
    blockers.push(bridgeError(
      "DONOR_TITLE_MATCH_REJECTED",
      `strict matcher rejected donor title: ${match.reasonCodes.join(",")}`,
    ));
    return {
      componentIndex: input.componentIndex,
      qty: input.quantity,
      legacyComponentId: input.legacyComponent.id,
      donorProductId: donor.id,
      legacyDonorProductId: link.donorProductId,
      donorOfferId: null,
      contentSourceOfferId: null,
      identityProof: "NONE",
      contentAssessment: null,
      targetIdentity: resolvedTargetIdentity,
      targetVariant,
      matcherVerdict: match.verdict,
      matcherReasonCodes: match.reasonCodes,
      disposition: "QUARANTINE",
      blockers,
    };
  }
  if (match.verdict !== "EXACT_IDENTITY") {
    blockers.push(bridgeError(
      "DONOR_TITLE_MATCH_ESTIMATE_ONLY",
      `${match.verdict} may provide typed price evidence but never content truth`,
    ));
    return {
      componentIndex: input.componentIndex,
      qty: input.quantity,
      legacyComponentId: input.legacyComponent.id,
      donorProductId: donor.id,
      legacyDonorProductId: link.donorProductId,
      donorOfferId: null,
      contentSourceOfferId: null,
      identityProof: "NONE",
      contentAssessment: null,
      targetIdentity: resolvedTargetIdentity,
      targetVariant,
      matcherVerdict: match.verdict,
      matcherReasonCodes: match.reasonCodes,
      disposition: "PRICE_ONLY_ESTIMATE",
      blockers,
    };
  }

  const directTargetEvidence =
    input.directTargetContentEvidenceByDonor.get(donor.id) ?? null;
  const contentSourceOffer = directTargetEvidence
    ? input.offersById.get(directTargetEvidence.offerId) ?? null
    : chooseContentSourceOffer(donor.id, input.offersByDonor);
  const contentAssessment = assessLegacyContent(
    donor,
    contentSourceOffer,
    null,
    directTargetEvidence,
  );
  const offer = chooseOffer(
    donor.id,
    input.legacyComponent.priceEvidenceOfferId,
    input.legacyComponent.retailer,
    input.evaluatedAt,
    input.offersById,
    input.offersByDonor,
  );
  if (!offer) {
    blockers.push(bridgeError(
      "FIRST_PARTY_DIRECT_OFFER_MISSING",
      "no standard non-club first-party direct USD offer is usable",
    ));
  }
  return {
    componentIndex: input.componentIndex,
    qty: input.quantity,
    legacyComponentId: input.legacyComponent.id,
    donorProductId: donor.id,
    legacyDonorProductId: link.donorProductId,
    donorOfferId: offer?.id ?? null,
    contentSourceOfferId: contentSourceOffer?.id ?? null,
    identityProof: "STRICT_TITLE_MATCH",
    contentAssessment,
    targetIdentity: resolvedTargetIdentity,
    targetVariant,
    matcherVerdict: match.verdict,
    matcherReasonCodes: match.reasonCodes,
    disposition: !contentAssessment.complete
      ? "EXACT_IDENTITY_ONLY_CANDIDATE"
      : offer
        ? "EXACT_CONTENT_AND_PRICE_CANDIDATE"
        : "EXACT_CONTENT_ONLY_CANDIDATE",
    blockers,
  };
}

function aggregateScope(
  listing: ProductTruthLegacyBridgeListingRow,
  components: ProductTruthLegacyBridgeComponentPlan[],
  blockers: ProductTruthBridgeBlocker[],
): ProductTruthLegacyBridgeScopePlan {
  const allExact = components.length > 0 && components.every((component) =>
    component.disposition === "EXACT_CONTENT_AND_PRICE_CANDIDATE"
    || component.disposition === "EXACT_CONTENT_ONLY_CANDIDATE");
  const allPriced = allExact && components.every(
    (component) => component.disposition === "EXACT_CONTENT_AND_PRICE_CANDIDATE",
  );
  const allIdentityOnlyOrBetter = components.length > 0 && components.every((component) =>
    component.disposition === "EXACT_CONTENT_AND_PRICE_CANDIDATE"
    || component.disposition === "EXACT_CONTENT_ONLY_CANDIDATE"
    || component.disposition === "EXACT_IDENTITY_ONLY_CANDIDATE");
  const disposition: ProductTruthBridgeScopeDisposition = blockers.length || !allIdentityOnlyOrBetter
    ? "QUARANTINE"
    : !allExact
      ? "IDENTITY_ONLY_CANONICALIZATION_CANDIDATE"
      : allPriced
        ? "EXACT_CANONICALIZATION_CANDIDATE"
        : "CONTENT_ONLY_CANONICALIZATION_CANDIDATE";
  return {
    listingKey: listing.listingKey,
    channel: listing.channel,
    storeIndex: listing.storeIndex,
    sku: listing.sku,
    disposition,
    writeEligible: disposition === "EXACT_CANONICALIZATION_CANDIDATE"
      || disposition === "CONTENT_ONLY_CANONICALIZATION_CANDIDATE"
      || disposition === "IDENTITY_ONLY_CANONICALIZATION_CANDIDATE",
    supersedesInvalidCanonicalCostIds: [],
    blockers,
    components,
  };
}

type ProductTruthLegacyBridgeReconciliationSourceTarget = {
  listingKey: string;
  originalCanonicalVariantId: string;
  originalTargetIdentitySha256: string;
  overlappingProductFlavorTokens: number;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function identityPartitionPhysicalProjection(
  rebuiltVariant: CanonicalProductVariantKey,
): {
  brand: string;
  identityTokens: string[];
  modifiers: string[];
  form: string | null;
  size: CanonicalProductVariantKey["normalized"]["size"];
  outerPackCount: number;
} {
  const productTokens = new Set(
    rebuiltVariant.normalized.productLine?.split(/\s+/).filter(Boolean) ?? [],
  );
  const flavorTokens = new Set(
    rebuiltVariant.normalized.flavor?.split(/\s+/).filter(Boolean) ?? [],
  );
  const identityTokens = new Set(
    [...productTokens, ...flavorTokens].filter((token) => token !== "with"),
  );
  return {
    brand: rebuiltVariant.normalized.brand,
    identityTokens: [...identityTokens].sort((left, right) =>
      left.localeCompare(right, "en-US")),
    modifiers: [...rebuiltVariant.normalized.modifiers].sort((left, right) =>
      left.localeCompare(right, "en-US")),
    form: rebuiltVariant.normalized.form,
    size: rebuiltVariant.normalized.size,
    outerPackCount: rebuiltVariant.normalized.outerPackCount,
  };
}

function identityPartitionPhysicalProjectionV2(
  rebuiltVariant: CanonicalProductVariantKey,
): {
  brand: string;
  identityTokens: string[];
  modifiers: string[];
  size: CanonicalProductVariantKey["normalized"]["size"];
  outerPackCount: number;
} {
  const productTokens =
    rebuiltVariant.normalized.productLine?.split(/\s+/).filter(Boolean) ?? [];
  const flavorTokens =
    rebuiltVariant.normalized.flavor?.split(/\s+/).filter(Boolean) ?? [];
  const formTokens =
    rebuiltVariant.normalized.form?.split(/\s+/).filter(Boolean) ?? [];
  const identityTokens = new Set(
    [...productTokens, ...flavorTokens, ...formTokens]
      .filter((token) => token !== "with"),
  );
  return {
    brand: rebuiltVariant.normalized.brand,
    identityTokens: [...identityTokens].sort((left, right) =>
      left.localeCompare(right, "en-US")),
    modifiers: [...rebuiltVariant.normalized.modifiers].sort((left, right) =>
      left.localeCompare(right, "en-US")),
    size: rebuiltVariant.normalized.size,
    outerPackCount: rebuiltVariant.normalized.outerPackCount,
  };
}

function canonicalBindingVariant(
  binding: ProductTruthLegacyBridgeCanonicalDonorBindingRow,
): CanonicalProductVariantKey | null {
  if (!binding.canonicalIdentityJson) return null;
  try {
    const parsed = recordValue(JSON.parse(binding.canonicalIdentityJson));
    const size = recordValue(parsed?.size);
    if (
      parsed?.schemaVersion
        !== "canonical-product-variant-identity/1.0.0"
      || typeof parsed.brand !== "string"
      || !Array.isArray(parsed.modifiers)
      || parsed.modifiers.some((value) => typeof value !== "string")
      || !size
      || typeof size.baseAmount !== "number"
      || !Number.isFinite(size.baseAmount)
      || typeof size.baseUnit !== "string"
      || typeof parsed.outerPackCount !== "number"
      || !Number.isInteger(parsed.outerPackCount)
    ) {
      return null;
    }
    const identity: CanonicalProductIdentity = {
      brand: parsed.brand,
      productLine:
        typeof parsed.productLine === "string" ? parsed.productLine : null,
      flavor: typeof parsed.flavor === "string" ? parsed.flavor : null,
      modifiers: parsed.modifiers as string[],
      form: typeof parsed.form === "string" ? parsed.form : null,
      size: `${size.baseAmount} ${size.baseUnit}`,
      outerPackCount: parsed.outerPackCount,
    };
    const rebuilt = buildCanonicalProductVariantKey(identity);
    return rebuilt.canonicalVariantId === binding.canonicalVariantId
        && rebuilt.identityJson === binding.canonicalIdentityJson
      ? rebuilt
      : null;
  } catch {
    return null;
  }
}

function canonicalBindingMatchesPhysicalIdentityPartition(
  binding: ProductTruthLegacyBridgeCanonicalDonorBindingRow,
  targetVariant: ProductTruthBridgeCanonicalVariantProjection,
): boolean {
  const bindingVariant = canonicalBindingVariant(binding);
  if (!bindingVariant) return false;
  const target = canonicalBindingVariant({
    donorProductId: binding.donorProductId,
    canonicalVariantId: targetVariant.canonicalVariantId,
    canonicalIdentityJson: targetVariant.identityJson,
    decisionId: binding.decisionId,
    decisionStatus: binding.decisionStatus,
    decidedAt: binding.decidedAt,
  });
  return target !== null
    && productTruthOperationalSha256(
      identityPartitionPhysicalProjectionV2(bindingVariant),
    ) === productTruthOperationalSha256(
      identityPartitionPhysicalProjectionV2(target),
    );
}

function donorCanonicalBindingCompatible(input: {
  donor: ProductTruthLegacyBridgeDonorRow;
  targetVariant: ProductTruthBridgeCanonicalVariantProjection;
  canonicalDonorBindings: ReadonlyMap<
    string,
    readonly ProductTruthLegacyBridgeCanonicalDonorBindingRow[]
  >;
}): boolean {
  const existingBindings =
    input.canonicalDonorBindings.get(input.donor.id) ?? [];
  const conflictingBindings = existingBindings.filter(
    (binding) =>
      binding.canonicalVariantId !== input.targetVariant.canonicalVariantId,
  );
  if (conflictingBindings.length === 0) return true;
  return input.donor.identityStatus === "exact_confirmed"
    && existingBindings.length === 1
    && conflictingBindings.length === 1
    && canonicalBindingMatchesPhysicalIdentityPartition(
      existingBindings[0]!,
      input.targetVariant,
    );
}

function canonicalDonorConflictBlocker(input: {
  donor: ProductTruthLegacyBridgeDonorRow;
  targetVariant: ProductTruthBridgeCanonicalVariantProjection;
  canonicalDonorBindings: ReadonlyMap<
    string,
    readonly ProductTruthLegacyBridgeCanonicalDonorBindingRow[]
  >;
}): ProductTruthBridgeBlocker | null {
  if (donorCanonicalBindingCompatible(input)) return null;
  const existingBindings =
    input.canonicalDonorBindings.get(input.donor.id) ?? [];
  return bridgeError(
    "CANONICAL_DONOR_VARIANT_CONFLICT",
    [
      `DonorProduct ${input.donor.id} is already bound to`,
      existingBindings
        .map((binding) => binding.canonicalVariantId)
        .sort()
        .join(","),
      `instead of ${input.targetVariant.canonicalVariantId}`,
    ].join(" "),
  );
}

const AUTHORITATIVE_WALMART_TITLE_MEASURE =
  /\b\d+(?:\.\d+)?\s*(?:fl\s*oz|oz|ounce|ounces|lb|lbs|pound|pounds|kg|kgs|g|gram|grams|ml|l|liter|liters|litre|litres|ct|count|counts)\b/gi;
const AUTHORITATIVE_WALMART_TITLE_NEUTRAL =
  new Set<string>(CANONICAL_TITLE_NEUTRAL_TOKENS);
const AUTHORITATIVE_WALMART_PLACEHOLDER_SIGNATURES = new Set([
  "coming soon",
  "n a",
  "placeholder",
  "test",
  "tbd",
]);

function authoritativeWalmartEvidenceCore(
  evidence: ProductTruthAuthoritativeWalmartItemReportEvidenceRow,
): Omit<ProductTruthAuthoritativeWalmartItemReportEvidenceRow, "evidenceRowSha256"> {
  const core = { ...evidence };
  delete (core as Partial<ProductTruthAuthoritativeWalmartItemReportEvidenceRow>)
    .evidenceRowSha256;
  return core;
}

function exactNormalizedTitleKey(value: string | null | undefined): string {
  return JSON.stringify(normalizeIdentityTokens(value));
}

function titleContainsEquivalentCanonicalSize(
  title: string,
  size: string,
): boolean {
  const matches = title.matchAll(
    new RegExp(
      AUTHORITATIVE_WALMART_TITLE_MEASURE.source,
      AUTHORITATIVE_WALMART_TITLE_MEASURE.flags,
    ),
  );
  return [...matches].some((match) =>
    equivalentCanonicalSize(size, match[0] ?? null));
}

function explicitDonorAttributeBrand(attributes: string | null): string | null {
  const parsed = parsedJson(attributes);
  if (!Array.isArray(parsed)) return null;
  const values = parsed
    .map((item): string | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      return /^brand$/i.test(String(row.name ?? row.label ?? "").trim())
        ? stringOrNull(row.value)
        : null;
    })
    .filter((value): value is string => value !== null);
  const normalized = new Map(
    values.map((value) => [foldedTokens(value).join("\u0000"), value]),
  );
  return normalized.size === 1 ? [...normalized.values()][0]! : null;
}

function orderedPrefix(
  prefix: readonly string[],
  value: readonly string[],
): boolean {
  return prefix.length > 0
    && prefix.length <= value.length
    && prefix.every((token, index) => token === value[index]);
}

function recoverAuthoritativeWalmartReportScope(input: {
  listing: ProductTruthLegacyBridgeListingRow;
  legacyComponents: readonly ProductTruthLegacyBridgeComponentRow[];
  evidence: ProductTruthAuthoritativeWalmartItemReportEvidenceRow | null;
  donorsByExactTitle: ReadonlyMap<
    string,
    readonly ProductTruthLegacyBridgeDonorRow[]
  >;
  canonicalDonorBindings: ReadonlyMap<
    string,
    readonly ProductTruthLegacyBridgeCanonicalDonorBindingRow[]
  >;
  directTargetContentEvidenceByDonor: ReadonlyMap<
    string,
    ProductTruthLegacyBridgeDirectTargetContentEvidenceRow
  >;
  offersByDonor: ReadonlyMap<
    string,
    readonly ProductTruthLegacyBridgeOfferRow[]
  >;
}): ProductTruthLegacyBridgeScopePlan | null {
  const { listing, evidence } = input;
  if (
    listing.channel !== "walmart"
    || evidence === null
    || evidence.listingKey !== listing.listingKey
    || evidence.storeIndex !== listing.storeIndex
    || evidence.sku !== listing.sku
  ) return null;

  const outerPack =
    parseProductTruthAuthoritativeWalmartOuterPackTitle(evidence.title);
  if (
    outerPack.status === "INVALID"
    || outerPack.status === "AMBIGUOUS"
    || !outerPack.baseTokens.length
  ) return null;
  const quantity = outerPack.status === "PARSED" ? outerPack.count! : 1;
  const legacyComponent = input.legacyComponents.length === 0
    ? null
    : input.legacyComponents.length === 1
        && input.legacyComponents[0]?.idx === 0
        && positiveInteger(input.legacyComponents[0].qty) === quantity
      ? input.legacyComponents[0]
      : undefined;
  if (legacyComponent === undefined) return null;
  const baseSignature = outerPack.baseTokens.join(" ");
  if (
    AUTHORITATIVE_WALMART_PLACEHOLDER_SIGNATURES.has(baseSignature)
    || baseSignature.includes("coming soon")
  ) return null;

  const titleCandidates =
    input.donorsByExactTitle.get(JSON.stringify(outerPack.normalizedBaseTokens))
    ?? [];
  if (titleCandidates.length !== 1) return null;
  const donor = titleCandidates[0]!;
  if (
    !donor.title
    || !donor.brand
    || !evidence.brand
  ) return null;
  const reportBrandTokens = foldedTokens(evidence.brand);
  const donorBrandTokens = foldedTokens(donor.brand);
  const donorTitleTokens = foldedTokens(donor.title);
  const reportBrandIsTitlePrefix =
    orderedPrefix(reportBrandTokens, donorTitleTokens);
  const donorAttributeBrandTokens =
    foldedTokens(explicitDonorAttributeBrand(donor.attributes) ?? "");
  const reportBrandIsAttributeCorroboratedExpansion =
    orderedPrefix(donorBrandTokens, reportBrandTokens)
    && donorBrandTokens.length < reportBrandTokens.length
    && orderedPrefix(donorBrandTokens, donorTitleTokens)
    && donorAttributeBrandTokens.join("\u0000")
      === reportBrandTokens.join("\u0000");
  const canonicalBrand = reportBrandIsTitlePrefix
    ? evidence.brand
    : reportBrandIsAttributeCorroboratedExpansion
      ? donor.brand
      : null;
  if (
    !(
      orderedPrefix(donorBrandTokens, reportBrandTokens)
      || orderedPrefix(reportBrandTokens, donorBrandTokens)
    )
    || !canonicalBrand
    || foldedTokens(donor.title).join("\u0000")
      !== outerPack.baseTokens.join("\u0000")
  ) return null;

  const brandTokens = foldedTokens(canonicalBrand);
  const titleWithoutMeasure =
    donor.title.replace(AUTHORITATIVE_WALMART_TITLE_MEASURE, " ");
  const titleTokens = foldedTokens(titleWithoutMeasure);
  if (
    brandTokens.length === 0
    || titleTokens.length <= brandTokens.length
    || brandTokens.some((token, index) => titleTokens[index] !== token)
  ) return null;
  const productLineTokens = titleTokens
    .slice(brandTokens.length)
    .filter((token) =>
      !AUTHORITATIVE_WALMART_TITLE_NEUTRAL.has(token)
      && !/^\d+$/.test(token));
  if (productLineTokens.length === 0) return null;

  const sourceSize = legacyComponent?.size?.trim() || null;
  const size = sourceSize
    ? parseCanonicalSize(sourceSize)
        && titleContainsEquivalentCanonicalSize(donor.title, sourceSize)
      ? sourceSize
      : null
    : donor.size?.trim()
      ? parseCanonicalSize(donor.size)
          && titleContainsEquivalentCanonicalSize(donor.title, donor.size)
        ? donor.size.trim()
        : null
      : parseCanonicalSize(donor.title)
        ? donor.title
        : null;
  if (!size) return null;
  const targetIdentity: CanonicalProductIdentity = {
    brand: canonicalBrand,
    productLine: productLineTokens.join(" "),
    flavor: null,
    modifiers: [],
    form: null,
    size,
    outerPackCount: 1,
  };
  // The report base title and donor title have already passed byte-bound,
  // ordered whole-token equality above. A second raw-title parse would turn
  // legitimate inner package evidence such as `10.8 oz, 14 Count` into an
  // artificial ambiguous-size rejection. Validate the resulting structured
  // canonical identity against itself instead; this still requires an exact
  // brand, discriminator, one parseable donor size, and a valid outer count.
  const matcher = matchCanonicalProduct(targetIdentity, targetIdentity);
  if (matcher.verdict !== "EXACT_IDENTITY") return null;

  let targetVariant: ProductTruthBridgeCanonicalVariantProjection;
  try {
    targetVariant = projectVariant(
      buildCanonicalProductVariantKey(targetIdentity),
    );
  } catch {
    return null;
  }
  if (
    canonicalDonorConflictBlocker({
      donor,
      targetVariant,
      canonicalDonorBindings: input.canonicalDonorBindings,
    })
  ) return null;

  const contentSourceOffer = chooseContentSourceOffer(
    donor.id,
    input.offersByDonor,
  );
  if (!contentSourceOffer) return null;
  const directTargetEvidence =
    input.directTargetContentEvidenceByDonor.get(donor.id) ?? null;
  const contentAssessment = assessLegacyContent(
    donor,
    contentSourceOffer,
    null,
    directTargetEvidence,
  );
  const component: ProductTruthLegacyBridgeComponentPlan = {
    componentIndex: 0,
    qty: quantity,
    legacyComponentId: null,
    donorProductId: donor.id,
    legacyDonorProductId: null,
    donorOfferId: null,
    contentSourceOfferId: contentSourceOffer.id,
    identityProof: "EXACT_AUTHORITATIVE_WALMART_REPORT_TITLE",
    contentAssessment,
    targetIdentity,
    targetVariant,
    matcherVerdict: matcher.verdict,
    matcherReasonCodes: matcher.reasonCodes,
    disposition: contentAssessment.complete
      ? "EXACT_CONTENT_ONLY_CANDIDATE"
      : "EXACT_IDENTITY_ONLY_CANDIDATE",
    blockers: [],
  };
  return aggregateScope(listing, [component], []);
}

function validIdentityPartitionReconciliation(input: {
  component: ProductTruthLegacyBridgeComponentPlan;
  row: ProductTruthLegacyBridgeCanonicalListingComponentRow;
}): boolean {
  const { component, row } = input;
  if (
    !component.targetIdentity
    || !component.targetVariant
    || !row.recipeComponentEvidenceHash
    || !row.recipeComponentEvidenceJson
    || !row.recipeTargetCanonicalVariantId
    || !row.recipeDonorProductId
    || !row.recipeVariantDecisionId
    || !row.decisionId
  ) {
    return false;
  }
  if (
    createHash("sha256").update(row.recipeComponentEvidenceJson).digest("hex")
      !== row.recipeComponentEvidenceHash
  ) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.recipeComponentEvidenceJson);
  } catch {
    return false;
  }
  if (
    renderProductTruthOperationalJson(parsed)
      !== row.recipeComponentEvidenceJson
  ) {
    return false;
  }
  const evidence = recordValue(parsed);
  const sourceEvidence = recordValue(evidence?.sourceEvidence);
  const reconciliation = recordValue(sourceEvidence?.identityReconciliation);
  if (!reconciliation) return false;
  const canonicalTargetIdentity =
    recordValue(reconciliation.canonicalTargetIdentity);
  const canonicalTargetVariant =
    recordValue(reconciliation.canonicalTargetVariant);
  const sourceTargets = Array.isArray(reconciliation.sourceTargets)
    ? reconciliation.sourceTargets
    : null;
  const reconciliationSchemaVersion = reconciliation.schemaVersion;
  const v1 =
    reconciliationSchemaVersion
      === "product-truth-legacy-bridge-field-partition-reconciliation/1.0.0";
  const v2 =
    reconciliationSchemaVersion
      === "product-truth-legacy-bridge-field-partition-reconciliation/2.0.0";
  if (
    !evidence
    || evidence.schemaVersion
      !== "product-truth-listing-recipe-component-evidence/1.0.0"
    || evidence.listingKey !== row.listingKey
    || evidence.componentIndex !== row.componentIndex
    || evidence.targetCanonicalVariantId
      !== row.recipeTargetCanonicalVariantId
    || evidence.donorProductId !== row.recipeDonorProductId
    || evidence.variantDecisionId !== row.recipeVariantDecisionId
    || evidence.sourceEvidenceSha256
      !== productTruthOperationalSha256(sourceEvidence)
    || sourceEvidence?.schemaVersion
      !== "product-truth-legacy-bridge-recipe-component-source/1.0.0"
    || (!v1 && !v2)
    || reconciliation.mode !== "LEXICALLY_EQUIVALENT_DONOR_GRAPH"
    || reconciliation.donorProductId !== row.recipeDonorProductId
    || typeof reconciliation.canonicalListingKey !== "string"
    || !canonicalTargetIdentity
    || !canonicalTargetVariant
    || !sourceTargets
    || sourceTargets.length < (v1 ? 2 : 1)
    || reconciliation.sourceTargetsSha256
      !== productTruthOperationalSha256(sourceTargets)
    || (
      v2
      && (
        typeof reconciliation.canonicalDecisionId !== "string"
        || reconciliation.canonicalDecisionId !== row.decisionId
      )
    )
  ) {
    return false;
  }
  const parsedSourceTargets =
    sourceTargets.map((value): ProductTruthLegacyBridgeReconciliationSourceTarget | null => {
      const target = recordValue(value);
      if (
        !target
        || typeof target.listingKey !== "string"
        || typeof target.originalCanonicalVariantId !== "string"
        || typeof target.originalTargetIdentitySha256 !== "string"
        || typeof target.overlappingProductFlavorTokens !== "number"
        || !Number.isInteger(target.overlappingProductFlavorTokens)
        || target.overlappingProductFlavorTokens < 0
      ) {
        return null;
      }
      return {
        listingKey: target.listingKey,
        originalCanonicalVariantId: target.originalCanonicalVariantId,
        originalTargetIdentitySha256: target.originalTargetIdentitySha256,
        overlappingProductFlavorTokens:
          Number(target.overlappingProductFlavorTokens),
      };
    });
  if (
    parsedSourceTargets.some((value) => value === null)
    || new Set(parsedSourceTargets.map((value) => value!.listingKey)).size
      !== parsedSourceTargets.length
    || !parsedSourceTargets.some(
      (value) => value!.listingKey === reconciliation.canonicalListingKey,
    )
    || parsedSourceTargets.some(
      (value, index) =>
        index > 0
        && parsedSourceTargets[index - 1]!.listingKey.localeCompare(
          value!.listingKey,
          "en-US",
        ) >= 0,
    )
  ) {
    return false;
  }
  const sourceTarget = parsedSourceTargets.find(
    (value) => value!.listingKey === row.listingKey,
  );
  if (
    !sourceTarget
    || sourceTarget.originalCanonicalVariantId
      !== component.targetVariant.canonicalVariantId
    || sourceTarget.originalTargetIdentitySha256
      !== productTruthOperationalSha256(component.targetIdentity)
  ) {
    return false;
  }
  try {
    const original = buildCanonicalProductVariantKey(component.targetIdentity);
    const canonical = buildCanonicalProductVariantKey(
      canonicalTargetIdentity as CanonicalProductIdentity,
    );
    const canonicalProjection = projectVariant(canonical);
    return (
      original.canonicalVariantId
        === component.targetVariant.canonicalVariantId
      && canonical.canonicalVariantId === row.targetCanonicalVariantId
      && row.recipeTargetCanonicalVariantId === row.targetCanonicalVariantId
      && row.recipeVariantDecisionId === row.decisionId
      && canonicalTargetVariant.canonicalVariantId
        === canonicalProjection.canonicalVariantId
      && canonicalTargetVariant.variantKey === canonicalProjection.variantKey
      && canonicalTargetVariant.identityHash === canonicalProjection.identityHash
      && canonicalTargetVariant.keyVersion === canonicalProjection.keyVersion
      && canonicalTargetVariant.identityJson === canonicalProjection.identityJson
      && productTruthOperationalSha256(
        v1
          ? identityPartitionPhysicalProjection(original)
          : identityPartitionPhysicalProjectionV2(original),
      ) === productTruthOperationalSha256(
        v1
          ? identityPartitionPhysicalProjection(canonical)
          : identityPartitionPhysicalProjectionV2(canonical),
      )
      && reconciliation.physicalIdentitySha256
        === productTruthOperationalSha256(
          v1
            ? identityPartitionPhysicalProjection(canonical)
            : identityPartitionPhysicalProjectionV2(canonical),
        )
    );
  } catch {
    return false;
  }
}

function classifyExistingCanonicalScope(
  scope: ProductTruthLegacyBridgeScopePlan,
  rows: readonly ProductTruthLegacyBridgeCanonicalListingComponentRow[],
): ProductTruthLegacyBridgeScopePlan {
  if (!rows.length) return scope;
  const costIds = new Set(rows.map((row) => row.skuCostId));
  const byIndex = new Map<number, ProductTruthLegacyBridgeCanonicalListingComponentRow>();
  let valid = costIds.size === 1 && rows.length === scope.components.length;
  for (const row of rows) {
    if (byIndex.has(row.componentIndex)) valid = false;
    byIndex.set(row.componentIndex, row);
  }
  for (const component of scope.components) {
    const row = byIndex.get(component.componentIndex);
    const targetVariantId = component.targetVariant?.canonicalVariantId ?? null;
    const canonicalEvidenceVariantId = row?.targetCanonicalVariantId ?? null;
    const targetBindingValid =
      targetVariantId === canonicalEvidenceVariantId
      || (
        row !== undefined
        && validIdentityPartitionReconciliation({ component, row })
      );
    const contentBindingValid =
      row !== undefined
      && (
        (
          row.contentCanonicalVariantId === null
          && row.contentObservationId === null
          && row.observedContentCanonicalVariantId === null
        )
        || (
          row.contentCanonicalVariantId === canonicalEvidenceVariantId
          && Boolean(row.contentObservationId)
          && row.observedContentCanonicalVariantId
            === canonicalEvidenceVariantId
        )
      );
    if (
      !row
      || !targetVariantId
      || !canonicalEvidenceVariantId
      || !["FACT", "MANUAL_FACT", "ESTIMATE", "REJECT"].includes(row.evidenceStatus)
      || !targetBindingValid
      || !contentBindingValid
      || row.decisionStatus !== "exact_confirmed"
      || row.decisionCanonicalVariantId !== canonicalEvidenceVariantId
    ) {
      valid = false;
    }
  }
  if (valid) {
    return {
      ...scope,
      disposition: "ALREADY_CANONICAL",
      writeEligible: false,
      supersedesInvalidCanonicalCostIds: [],
      blockers: [],
      components: scope.components.map((component) => ({
        ...component,
        disposition: "ALREADY_CANONICAL",
        blockers: [],
      })),
    };
  }
  const blocker = bridgeError(
    "CANONICAL_LISTING_STATE_INVALID",
    [
      `latest canonical evidence for ${scope.listingKey} is incomplete or conflicts`,
      `with the current target identity (${[...costIds].sort().join(",") || "no cost id"})`,
    ].join(" "),
  );
  const repairableLegacyPlaceholder =
    rows.length === scope.components.length
    && rows.every(
      (row) =>
        row.evidenceStatus === "REJECT"
        && row.contentCanonicalVariantId === null
        && row.contentObservationId === null
        && row.observedContentCanonicalVariantId === null
        && row.decisionId == null
        && row.decisionStatus === null
        && row.decisionCanonicalVariantId === null
        && row.recipeTargetCanonicalVariantId == null
        && row.recipeDonorProductId == null
        && row.recipeVariantDecisionId == null
        && row.recipeComponentEvidenceHash == null
        && row.recipeComponentEvidenceJson == null,
    );
  if (
    scope.writeEligible
    && costIds.size === 1
    && scope.components.length > 0
    && repairableLegacyPlaceholder
  ) {
    return {
      ...scope,
      supersedesInvalidCanonicalCostIds: [...costIds].sort(),
    };
  }
  return {
    ...scope,
    disposition: "QUARANTINE",
    writeEligible: false,
    supersedesInvalidCanonicalCostIds: [],
    blockers: [...scope.blockers, blocker],
    components: scope.components.map((component) => ({
      ...component,
      disposition: "QUARANTINE",
      blockers: [...component.blockers, blocker],
    })),
  };
}

export function renderProductTruthLegacyBridgeSnapshot(
  value: ProductTruthLegacyBridgeSnapshot,
): string {
  return renderProductTruthOperationalJson(value);
}

export function renderProductTruthLegacyBridgePlan(
  value: ProductTruthLegacyBridgePlan,
): string {
  return renderProductTruthOperationalJson(value);
}

export function productTruthLegacyBridgeSha256(value: unknown): string {
  return productTruthOperationalSha256(value);
}

export function productTruthLegacyBridgeBytesSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function compileProductTruthLegacyBridgePlan(input: {
  snapshot: ProductTruthLegacyBridgeSnapshot;
  snapshotJson: string;
  snapshotSha256: string;
  generatedAt: string;
}): ProductTruthLegacyBridgePlan {
  if (input.snapshot.schemaVersion !== PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION) {
    throw new Error("LEGACY_BRIDGE_SNAPSHOT_VERSION_INVALID");
  }
  const canonicalSnapshotJson = renderProductTruthLegacyBridgeSnapshot(input.snapshot);
  if (canonicalSnapshotJson !== input.snapshotJson) {
    throw new Error("LEGACY_BRIDGE_SNAPSHOT_NOT_CANONICAL");
  }
  if (
    !/^[a-f0-9]{64}$/.test(input.snapshotSha256)
    || productTruthLegacyBridgeBytesSha256(input.snapshotJson) !== input.snapshotSha256
  ) {
    throw new Error("LEGACY_BRIDGE_SNAPSHOT_SHA256_MISMATCH");
  }
  if (!Number.isFinite(Date.parse(input.generatedAt))) {
    throw new Error("LEGACY_BRIDGE_GENERATED_AT_INVALID");
  }
  if (input.snapshot.manifest.listingCount !== input.snapshot.listings.length) {
    throw new Error("LEGACY_BRIDGE_MANIFEST_COUNT_MISMATCH");
  }

  const barcodeEvidenceByComponent = new Map<
    string,
    ProductTruthLegacyBridgeComponentBarcodeEvidenceRow
  >();
  for (const evidence of input.snapshot.componentBarcodeEvidence) {
    const key = `${evidence.listingKey}:${evidence.componentIndex}`;
    if (barcodeEvidenceByComponent.has(key)) {
      throw new Error(`LEGACY_BRIDGE_BARCODE_EVIDENCE_DUPLICATE:${key}`);
    }
    barcodeEvidenceByComponent.set(key, evidence);
  }
  const listingsByKey = new Map(
    input.snapshot.listings.map((listing) => [listing.listingKey, listing]),
  );
  const authoritativeWalmartEvidenceByListing = new Map<
    string,
    ProductTruthAuthoritativeWalmartItemReportEvidenceRow
  >();
  for (const evidence of input.snapshot.authoritativeWalmartItemReportEvidence) {
    const listing = listingsByKey.get(evidence.listingKey);
    const core = authoritativeWalmartEvidenceCore(evidence);
    if (
      evidence.schemaVersion
        !== PRODUCT_TRUTH_AUTHORITATIVE_WALMART_ITEM_REPORT_EVIDENCE_VERSION
      || authoritativeWalmartEvidenceByListing.has(evidence.listingKey)
      || !listing
      || listing.channel !== "walmart"
      || listing.storeIndex !== evidence.storeIndex
      || listing.sku !== evidence.sku
      || !evidence.itemId
      || !evidence.title
      || evidence.publishStatus !== "PUBLISHED"
      || evidence.lifecycleStatus !== "ACTIVE"
      || !evidence.sourceReportId
      || !evidence.sourceReportName
      || !Number.isFinite(Date.parse(evidence.sourceReportCapturedAt))
      || Date.parse(evidence.sourceReportCapturedAt)
        > Date.parse(input.snapshot.capturedAt)
      || !/^[a-f0-9]{64}$/.test(evidence.sourceReportSha256)
      || !Number.isSafeInteger(evidence.sourceReportByteLength)
      || evidence.sourceReportByteLength < 1
      || !Number.isSafeInteger(evidence.sourceRowNumber)
      || evidence.sourceRowNumber < 2
      || !/^[a-f0-9]{64}$/.test(evidence.evidenceRowSha256)
      || productTruthOperationalSha256(core) !== evidence.evidenceRowSha256
    ) {
      throw new Error(
        `LEGACY_BRIDGE_AUTHORITATIVE_WALMART_EVIDENCE_INVALID:${evidence.listingKey}`,
      );
    }
    authoritativeWalmartEvidenceByListing.set(
      evidence.listingKey,
      evidence,
    );
  }
  const donorsById = new Map(input.snapshot.donors.map((row) => [row.id, row]));
  const donorsByGtin = new Map<string, ProductTruthLegacyBridgeDonorRow[]>();
  for (const donor of input.snapshot.donors) {
    const keys = [...new Set(
      [normalizeProductTruthBridgeGtin(donor.upc), normalizeProductTruthBridgeGtin(donor.gtin)]
        .filter((value): value is string => Boolean(value)),
    )];
    for (const key of keys) {
      const list = donorsByGtin.get(key) ?? [];
      list.push(donor);
      donorsByGtin.set(key, list);
    }
  }
  const donorsByLeadingTitleToken = new Map<
    string,
    ProductTruthLegacyBridgeDonorRow[]
  >();
  for (const donor of input.snapshot.donors) {
    const leadingToken = foldedTokens(donor.title ?? "")[0];
    if (!leadingToken) continue;
    const list = donorsByLeadingTitleToken.get(leadingToken) ?? [];
    list.push(donor);
    donorsByLeadingTitleToken.set(leadingToken, list);
  }
  for (const list of donorsByLeadingTitleToken.values()) {
    list.sort((left, right) => left.id.localeCompare(right.id));
  }
  const donorsByExactTitle = new Map<
    string,
    ProductTruthLegacyBridgeDonorRow[]
  >();
  for (const donor of input.snapshot.donors) {
    if (!donor.title) continue;
    const key = exactNormalizedTitleKey(donor.title);
    const list = donorsByExactTitle.get(key) ?? [];
    list.push(donor);
    donorsByExactTitle.set(key, list);
  }
  for (const list of donorsByExactTitle.values()) {
    list.sort((left, right) => left.id.localeCompare(right.id));
  }
  const offersById = new Map(input.snapshot.offers.map((row) => [row.id, row]));
  const directTargetContentEvidenceByDonor = new Map<
    string,
    ProductTruthLegacyBridgeDirectTargetContentEvidenceRow
  >();
  for (const evidence of input.snapshot.directTargetContentEvidence) {
    if (directTargetContentEvidenceByDonor.has(evidence.donorProductId)) {
      throw new Error(
        `LEGACY_BRIDGE_DIRECT_TARGET_CONTENT_EVIDENCE_DUPLICATE:${evidence.donorProductId}`,
      );
    }
    assertDirectTargetContentEvidence({
      evidence,
      donor: donorsById.get(evidence.donorProductId),
      offer: offersById.get(evidence.offerId),
      evaluatedAt: input.snapshot.capturedAt,
    });
    directTargetContentEvidenceByDonor.set(evidence.donorProductId, evidence);
  }
  const canonicalDonorBindings = new Map<
    string,
    ProductTruthLegacyBridgeCanonicalDonorBindingRow[]
  >();
  for (const binding of input.snapshot.canonicalDonorBindings) {
    if (binding.decisionStatus !== "exact_confirmed") continue;
    const bindings =
      canonicalDonorBindings.get(binding.donorProductId) ?? [];
    bindings.push(binding);
    canonicalDonorBindings.set(binding.donorProductId, bindings);
  }
  const offersByDonor = new Map<string, ProductTruthLegacyBridgeOfferRow[]>();
  for (const offer of input.snapshot.offers) {
    const list = offersByDonor.get(offer.donorProductId) ?? [];
    list.push(offer);
    offersByDonor.set(offer.donorProductId, list);
  }
  const componentsBySku = new Map<string, ProductTruthLegacyBridgeComponentRow[]>();
  for (const component of input.snapshot.components) {
    const list = componentsBySku.get(component.sku) ?? [];
    list.push(component);
    componentsBySku.set(component.sku, list);
  }
  for (const list of componentsBySku.values()) {
    list.sort((left, right) => left.idx - right.idx || left.id.localeCompare(right.id));
  }
  const canonicalComponentsByListing = new Map<
    string,
    ProductTruthLegacyBridgeCanonicalListingComponentRow[]
  >();
  for (const component of input.snapshot.canonicalListingComponents) {
    const list = canonicalComponentsByListing.get(component.listingKey) ?? [];
    list.push(component);
    canonicalComponentsByListing.set(component.listingKey, list);
  }
  for (const list of canonicalComponentsByListing.values()) {
    list.sort((left, right) =>
      left.componentIndex - right.componentIndex || left.skuCostId.localeCompare(right.skuCostId));
  }

  const scopes = [...input.snapshot.listings]
    .sort((left, right) => left.listingKey.localeCompare(right.listingKey))
    .map((listing): ProductTruthLegacyBridgeScopePlan => {
      const parsed = parseIdentity(listing.productIdentityJson);
      const scopeBlockers = [...parsed.blockers];
      const legacyComponents = componentsBySku.get(listing.sku) ?? [];
      if (!parsed.identity) {
        const recovered = recoverAuthoritativeWalmartReportScope({
          listing,
          legacyComponents,
          evidence:
            authoritativeWalmartEvidenceByListing.get(listing.listingKey)
            ?? null,
          donorsByExactTitle,
          canonicalDonorBindings,
          directTargetContentEvidenceByDonor,
          offersByDonor,
        });
        if (recovered) {
          return classifyExistingCanonicalScope(
            recovered,
            canonicalComponentsByListing.get(listing.listingKey) ?? [],
          );
        }
        return classifyExistingCanonicalScope(
          aggregateScope(listing, [], scopeBlockers),
          canonicalComponentsByListing.get(listing.listingKey) ?? [],
        );
      }

      const listingQuantity = positiveInteger(parsed.identity.units_in_listing) ?? 1;
      const identityComponents = Array.isArray(parsed.identity.components)
        ? parsed.identity.components as ParsedBundleComponent[]
        : [];
      const declaredBundle = parsed.identity.is_bundle === true;
      // Historical identity rows sometimes called a same-product multipack a
      // bundle while preserving no mixed component graph. Recovery is allowed
      // only when the independent legacy BOM has exactly one base component
      // and its quantity exactly equals the declared listing quantity. The
      // component still has to pass the normal strict matcher; this structural
      // repair by itself proves no product identity.
      const recoverEmptyBundleAsMultipack =
        declaredBundle
        && identityComponents.length === 0
        && listingQuantity > 1
        && legacyComponents.length === 1
        && legacyComponents[0].idx === 0
        && positiveInteger(legacyComponents[0].qty) === listingQuantity;
      const isBundle = declaredBundle && !recoverEmptyBundleAsMultipack;
      // A marketplace listing UPC identifies the sellable outer offer. It can
      // prove the donor base unit only for an explicitly single-unit listing;
      // multipacks and bundles must use component-level evidence instead.
      const listingGtin = isBundle || listingQuantity !== 1
        ? null
        : normalizeProductTruthBridgeGtin(listing.listingUpc);
      const expectedCount = isBundle ? identityComponents.length : 1;
      if (legacyComponents.length !== expectedCount) {
        scopeBlockers.push(bridgeError(
          "LEGACY_COMPONENT_COUNT_MISMATCH",
          `identity expects ${expectedCount} component(s), legacy BOM has ${legacyComponents.length}`,
        ));
      }

      const plans: ProductTruthLegacyBridgeComponentPlan[] = [];
      if (!isBundle) {
        const target: CanonicalProductIdentity = {
          brand: stringOrNull(parsed.identity.brand),
          productLine: stringOrNull(parsed.identity.product_line),
          flavor: stringOrNull(parsed.identity.flavor),
          form: stringOrNull(parsed.identity.container_type),
          size: stringOrNull(parsed.identity.size),
          outerPackCount: 1,
        };
        plans.push(componentPlan({
          listingKey: listing.listingKey,
          componentIndex: 0,
          quantity: listingQuantity,
          targetIdentity: target,
          legacyComponent: legacyComponents.find((row) => row.idx === 0) ?? legacyComponents[0] ?? null,
          barcodeEvidence:
            barcodeEvidenceByComponent.get(`${listing.listingKey}:0`) ?? null,
          listingGtin,
          evaluatedAt: input.snapshot.capturedAt,
          donorsById,
          donorsByGtin,
          donorsByLeadingTitleToken,
          canonicalDonorBindings,
          directTargetContentEvidenceByDonor,
          offersById,
          offersByDonor,
        }));
      } else if (!identityComponents.length) {
        scopeBlockers.push(bridgeError(
          "PRODUCT_IDENTITY_INVALID",
          "bundle identity has no components",
        ));
      } else {
        for (let index = 0; index < identityComponents.length; index += 1) {
          const identityComponent = identityComponents[index];
          const legacyComponent = legacyComponents.find((row) => row.idx === index) ?? null;
          const link = legacyComponent ? linkedDonorId(legacyComponent) : { donorProductId: null, blockers: [] };
          const donorBrand = link.donorProductId
            ? donorsById.get(link.donorProductId)?.brand ?? null
            : null;
          const target = explicitBundleTarget(identityComponent, donorBrand);
          const targetBlockers = target
            ? []
            : [bridgeError(
                "BUNDLE_COMPONENT_BRAND_UNPROVEN",
                "bundle component product must begin with the exact linked donor brand",
              )];
          plans.push(componentPlan({
            listingKey: listing.listingKey,
            componentIndex: index,
            quantity: positiveInteger(identityComponent.qty) ?? legacyComponent?.qty ?? 1,
            targetIdentity: target,
            legacyComponent,
            barcodeEvidence:
              barcodeEvidenceByComponent.get(`${listing.listingKey}:${index}`) ?? null,
            targetBlockers,
            listingGtin: null,
            evaluatedAt: input.snapshot.capturedAt,
            donorsById,
            donorsByGtin,
            donorsByLeadingTitleToken,
            canonicalDonorBindings,
            directTargetContentEvidenceByDonor,
            offersById,
            offersByDonor,
          }));
        }
      }
      const classified = classifyExistingCanonicalScope(
        aggregateScope(listing, plans, scopeBlockers),
        canonicalComponentsByListing.get(listing.listingKey) ?? [],
      );
      if (
        classified.disposition !== "QUARANTINE"
        || (declaredBundle && identityComponents.length > 0)
      ) return classified;
      const recovered = recoverAuthoritativeWalmartReportScope({
        listing,
        legacyComponents,
        evidence:
          authoritativeWalmartEvidenceByListing.get(listing.listingKey)
          ?? null,
        donorsByExactTitle,
        canonicalDonorBindings,
        directTargetContentEvidenceByDonor,
        offersByDonor,
      });
      return recovered
        ? classifyExistingCanonicalScope(
            recovered,
            canonicalComponentsByListing.get(listing.listingKey) ?? [],
          )
        : classified;
    });

  const componentPlans = scopes.flatMap((scope) => scope.components);
  return {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION,
    policyVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION,
    generatedAt: new Date(input.generatedAt).toISOString(),
    source: {
      snapshotSchemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
      snapshotSha256: input.snapshotSha256,
      targetFingerprint: input.snapshot.targetFingerprint,
      manifest: input.snapshot.manifest,
    },
    matcher: {
      version: CANONICAL_PRODUCT_MATCHER_VERSION,
      implementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      releaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    },
    pricePolicy: {
      version: PRICE_EVIDENCE_POLICY_VERSION,
      evaluatedAt: input.snapshot.capturedAt,
      maxAgeMs: PRODUCT_TRUTH_LEGACY_BRIDGE_PRICE_MAX_AGE_MS,
    },
    safety: {
      readOnly: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      mutatesLegacyCatalog: false,
      createsAdditionalCatalog: false,
      historicalExactFlagsAreIdentityProof: false,
      priceProxyMayProvideContent: false,
    },
    counts: {
      listingsTotal: scopes.length,
      alreadyCanonicalListings: scopes.filter(
        (scope) => scope.disposition === "ALREADY_CANONICAL",
      ).length,
      exactCanonicalizationCandidates: scopes.filter(
        (scope) => scope.disposition === "EXACT_CANONICALIZATION_CANDIDATE",
      ).length,
      contentOnlyCanonicalizationCandidates: scopes.filter(
        (scope) => scope.disposition === "CONTENT_ONLY_CANONICALIZATION_CANDIDATE",
      ).length,
      identityOnlyCanonicalizationCandidates: scopes.filter(
        (scope) => scope.disposition === "IDENTITY_ONLY_CANONICALIZATION_CANDIDATE",
      ).length,
      quarantinedListings: scopes.filter((scope) => scope.disposition === "QUARANTINE").length,
      componentsTotal: componentPlans.length,
      alreadyCanonicalComponents: componentPlans.filter(
        (component) => component.disposition === "ALREADY_CANONICAL",
      ).length,
      exactContentAndPriceCandidates: componentPlans.filter(
        (component) => component.disposition === "EXACT_CONTENT_AND_PRICE_CANDIDATE",
      ).length,
      exactContentOnlyCandidates: componentPlans.filter(
        (component) => component.disposition === "EXACT_CONTENT_ONLY_CANDIDATE",
      ).length,
      exactIdentityOnlyCandidates: componentPlans.filter(
        (component) => component.disposition === "EXACT_IDENTITY_ONLY_CANDIDATE",
      ).length,
      priceOnlyEstimates: componentPlans.filter(
        (component) => component.disposition === "PRICE_ONLY_ESTIMATE",
      ).length,
      quarantinedComponents: componentPlans.filter(
        (component) => component.disposition === "QUARANTINE",
      ).length,
    },
    scopes,
  };
}
