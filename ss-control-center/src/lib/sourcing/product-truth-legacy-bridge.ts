import { createHash } from "node:crypto";

import {
  CANONICAL_PRODUCT_MATCHER_VERSION,
  matchCanonicalProductTitle,
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

/**
 * This is an immutable, read-only migration plan over the existing legacy
 * catalog. It is deliberately not a third product catalog and it never treats
 * a historical `costMethod=exact` flag as identity proof.
 */
export const PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION =
  "product-truth-legacy-bridge-snapshot/1.0.0" as const;
export const PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION =
  "product-truth-legacy-bridge-plan/1.0.0" as const;
export const PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION =
  "product-truth-legacy-bridge-policy/1.0.0" as const;
export const PRODUCT_TRUTH_LEGACY_BRIDGE_PRICE_MAX_AGE_MS =
  24 * 60 * 60 * 1_000;

export type ProductTruthBridgeComponentDisposition =
  | "EXACT_CONTENT_AND_PRICE_CANDIDATE"
  | "EXACT_CONTENT_ONLY_CANDIDATE"
  | "EXACT_IDENTITY_ONLY_CANDIDATE"
  | "PRICE_ONLY_ESTIMATE"
  | "QUARANTINE";

export type ProductTruthBridgeScopeDisposition =
  | "EXACT_CANONICALIZATION_CANDIDATE"
  | "CONTENT_ONLY_CANONICALIZATION_CANDIDATE"
  | "IDENTITY_ONLY_CANONICALIZATION_CANDIDATE"
  | "QUARANTINE";

export type ProductTruthBridgeIdentityProof =
  | "EXACT_GTIN"
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
  | "DONOR_TITLE_MATCH_ESTIMATE_ONLY"
  | "FIRST_PARTY_DIRECT_OFFER_MISSING";

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

export interface ProductTruthLegacyBridgeSnapshot {
  schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION;
  capturedAt: string;
  targetFingerprint: string;
  manifest: ProductTruthLegacyBridgeManifestBinding;
  listings: ProductTruthLegacyBridgeListingRow[];
  components: ProductTruthLegacyBridgeComponentRow[];
  donors: ProductTruthLegacyBridgeDonorRow[];
  offers: ProductTruthLegacyBridgeOfferRow[];
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
    exactCanonicalizationCandidates: number;
    contentOnlyCanonicalizationCandidates: number;
    identityOnlyCanonicalizationCandidates: number;
    quarantinedListings: number;
    componentsTotal: number;
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
): ProductTruthLegacyBridgeOfferRow | null {
  return [...(offersByDonor.get(donorProductId) ?? [])]
    .filter(usableContentSourceOffer)
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
    return /(?:food condition|storage)/i.test(String(row.name ?? ""))
      && Boolean(stringOrNull(row.value));
  }) ?? null;
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
): NonNullable<ProductTruthLegacyBridgeComponentPlan["contentAssessment"]> {
  const missing: string[] = [];
  const images = parsedJson(donor.imageUrls);
  const imageUrls = Array.isArray(images)
    ? images.filter((value): value is string => typeof value === "string")
    : [];
  const storageEvidence = explicitStorageEvidence(donor.attributes);
  const allergensEvidence = explicitAllergensEvidence(donor.nutritionFacts, donor.ingredients);
  if (!donor.title) missing.push("TITLE");
  if (!donor.description) missing.push("DESCRIPTION");
  if (!normalizeProductTruthBridgeGtin(donor.upc)) missing.push("MANUFACTURER_UPC");
  if (!donor.ingredients) missing.push("INGREDIENTS");
  if (!donor.nutritionFacts) missing.push("NUTRITION");
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
  componentIndex: number;
  quantity: number;
  targetIdentity: CanonicalProductIdentity | null;
  legacyComponent: ProductTruthLegacyBridgeComponentRow | null;
  targetBlockers?: ProductTruthBridgeBlocker[];
  listingGtin: string | null;
  evaluatedAt: string;
  donorsById: ReadonlyMap<string, ProductTruthLegacyBridgeDonorRow>;
  donorsByGtin: ReadonlyMap<string, readonly ProductTruthLegacyBridgeDonorRow[]>;
  offersById: ReadonlyMap<string, ProductTruthLegacyBridgeOfferRow>;
  offersByDonor: ReadonlyMap<string, readonly ProductTruthLegacyBridgeOfferRow[]>;
}): ProductTruthLegacyBridgeComponentPlan {
  const blockers = [...(input.targetBlockers ?? [])];
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

  let targetVariant: ProductTruthBridgeCanonicalVariantProjection | null = null;
  try {
    targetVariant = projectVariant(buildCanonicalProductVariantKey(input.targetIdentity));
  } catch (error) {
    blockers.push(bridgeError(
      "TARGET_VARIANT_INVALID",
      error instanceof Error ? error.message : "target variant could not be built",
    ));
  }
  if (!input.legacyComponent || !targetVariant) {
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
      targetIdentity: input.targetIdentity,
      targetVariant,
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
  const donor = exactGtinDonor ?? linkedDonor;
  if (link.donorProductId && !linkedDonor) {
    blockers.push(bridgeError("LEGACY_DONOR_ORPHANED", `DonorProduct ${link.donorProductId} does not exist`));
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
      targetIdentity: input.targetIdentity,
      targetVariant,
      matcherVerdict: null,
      matcherReasonCodes: [],
      disposition: "QUARANTINE",
      blockers,
    };
  }

  if (exactGtinDonor) {
    const contentSourceOffer = chooseContentSourceOffer(donor.id, input.offersByDonor);
    const contentAssessment = assessLegacyContent(donor, contentSourceOffer);
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
      identityProof: "EXACT_GTIN",
      contentAssessment,
      targetIdentity: input.targetIdentity,
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

  const match = matchCanonicalProductTitle(input.targetIdentity, {
    title: donor.title,
    // Legacy donor.brand is frequently truncated. The strict bridge still
    // proves the complete target brand as a brand-led phrase in donor.title.
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
      targetIdentity: input.targetIdentity,
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
      targetIdentity: input.targetIdentity,
      targetVariant,
      matcherVerdict: match.verdict,
      matcherReasonCodes: match.reasonCodes,
      disposition: "PRICE_ONLY_ESTIMATE",
      blockers,
    };
  }

  const contentSourceOffer = chooseContentSourceOffer(donor.id, input.offersByDonor);
  const contentAssessment = assessLegacyContent(donor, contentSourceOffer);
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
    targetIdentity: input.targetIdentity,
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
      || disposition === "CONTENT_ONLY_CANONICALIZATION_CANDIDATE",
    blockers,
    components,
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
  const offersById = new Map(input.snapshot.offers.map((row) => [row.id, row]));
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

  const scopes = [...input.snapshot.listings]
    .sort((left, right) => left.listingKey.localeCompare(right.listingKey))
    .map((listing): ProductTruthLegacyBridgeScopePlan => {
      const parsed = parseIdentity(listing.productIdentityJson);
      const scopeBlockers = [...parsed.blockers];
      const legacyComponents = componentsBySku.get(listing.sku) ?? [];
      if (!parsed.identity) return aggregateScope(listing, [], scopeBlockers);

      const isBundle = parsed.identity.is_bundle === true;
      const listingGtin = isBundle ? null : normalizeProductTruthBridgeGtin(listing.listingUpc);
      const identityComponents = Array.isArray(parsed.identity.components)
        ? parsed.identity.components as ParsedBundleComponent[]
        : [];
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
          componentIndex: 0,
          quantity: positiveInteger(parsed.identity.units_in_listing) ?? legacyComponents[0]?.qty ?? 1,
          targetIdentity: target,
          legacyComponent: legacyComponents.find((row) => row.idx === 0) ?? legacyComponents[0] ?? null,
          listingGtin,
          evaluatedAt: input.snapshot.capturedAt,
          donorsById,
          donorsByGtin,
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
            componentIndex: index,
            quantity: positiveInteger(identityComponent.qty) ?? legacyComponent?.qty ?? 1,
            targetIdentity: target,
            legacyComponent,
            targetBlockers,
            listingGtin: null,
            evaluatedAt: input.snapshot.capturedAt,
            donorsById,
            donorsByGtin,
            offersById,
            offersByDonor,
          }));
        }
      }
      return aggregateScope(listing, plans, scopeBlockers);
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
