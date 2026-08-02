import { createHash } from "node:crypto";

import {
  CANONICAL_PRODUCT_MATCHER_VERSION,
  matchCanonicalProductTitle,
  type CanonicalProductMatchResult,
} from "./canonical-product-match";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
} from "./canonical-product-match-provenance";
import {
  PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
  renderProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionScope,
} from "./product-truth-component-acquisition-scope";
import {
  parseProductTruthAuthoritativeWalmartOuterPackTitle,
} from "./product-truth-authoritative-walmart-item-title";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  normalizeProductTruthBridgeGtin,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthAuthoritativeWalmartItemReportEvidenceRow,
  type ProductTruthLegacyBridgeDonorRow,
  type ProductTruthLegacyBridgeSnapshot,
} from "./product-truth-legacy-bridge";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION,
  renderProductTruthSourceDetailAdmission,
  type ProductTruthSourceDetailAdmission,
} from "./product-truth-source-detail-admission";

export const PRODUCT_TRUTH_LISTING_RETAILER_IDENTITY_BRIDGE_VERSION =
  "product-truth-listing-retailer-identity-bridge/1.1.0" as const;
export const PRODUCT_TRUTH_AUTHORITATIVE_LISTING_FORM_POLICY_VERSION =
  "product-truth-authoritative-listing-form/1.1.0" as const;

export type ProductTruthListingRetailerIdentityMethod =
  | "EXACT_SINGLE_UNIT_GTIN_EQUALITY"
  | "EXACT_AUTHORITATIVE_PACKAGE_FORM"
  | "EXACT_FIRST_PARTY_RETAILER_PACKAGE_FORM";

export interface ProductTruthRetailerPackageFormEvidence {
  source: "DONOR_ATTRIBUTES_CONTAINER_TYPE";
  donorProductId: string;
  donorRowSha256: string;
  attributeName: "Container type";
  rawValue: string;
  normalizedForm: string;
}

export interface ProductTruthListingRetailerIdentityEvidence {
  listingKey: string;
  componentIndex: number;
  quantity: number;
  evidenceRowSha256: string;
  sourceReportSha256: string;
  sourceRowNumber: number;
  itemId: string;
  title: string;
  comparisonTitle: string;
  removedPresentationPhrases: string[];
  reportOuterPackCount: number;
  reportGtin: string | null;
  normalizedReportGtin14: string | null;
  reportGtinRole:
    | "EXACT_SINGLE_UNIT_MANUFACTURER_GTIN"
    | "OUTER_MARKETPLACE_OFFER_GTIN";
  identityProofRole:
    | "EXACT_SINGLE_UNIT_MANUFACTURER_GTIN"
    | "EXACT_LISTING_PACKAGE_FORM"
    | "EXACT_FIRST_PARTY_RETAILER_PACKAGE_FORM";
  matcher: CanonicalProductMatchResult;
}

export interface ProductTruthListingRetailerIdentityBridgeTarget {
  ordinal: number;
  acquisitionPriority: number;
  canonicalVariantId: string;
  canonicalIdentityHash: string;
  targetIdentity: ProductTruthComponentAcquisitionScope["targets"][number]["targetIdentity"];
  impact: ProductTruthComponentAcquisitionScope["targets"][number]["impact"];
  identityMethod: ProductTruthListingRetailerIdentityMethod;
  donor: {
    donorProductId: string;
    donorRowSha256: string;
    upc: string | null;
    gtin: string | null;
    normalizedManufacturerGtin14: string;
  };
  retailerItem: {
    offerId: string;
    offerRowSha256: string;
    retailer: "walmart" | "target";
    retailerProductId: string;
    productUrl: string;
  };
  retailerPackageFormEvidence: ProductTruthRetailerPackageFormEvidence | null;
  listingEvidence: ProductTruthListingRetailerIdentityEvidence[];
}

export interface ProductTruthListingRetailerIdentityBridgeExclusion {
  canonicalVariantId: string;
  blockerCodes: string[];
}

export interface ProductTruthListingRetailerIdentityBridge {
  schemaVersion: typeof PRODUCT_TRUTH_LISTING_RETAILER_IDENTITY_BRIDGE_VERSION;
  generatedAt: string;
  databaseTargetFingerprint: string;
  source: {
    componentAcquisitionScope: {
      schemaVersion: typeof PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION;
      sha256: string;
      generatedAt: string;
    };
    bridgeSnapshot: {
      schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION;
      sha256: string;
      capturedAt: string;
    };
    sourceDetailAdmission: {
      schemaVersion: typeof PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION;
      sha256: string;
      generatedAt: string;
    };
  };
  matcher: {
    version: typeof CANONICAL_PRODUCT_MATCHER_VERSION;
    implementationSha256: typeof CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256;
    releaseSha256: typeof CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256;
  };
  policy: {
    schemaVersion: typeof PRODUCT_TRUTH_AUTHORITATIVE_LISTING_FORM_POLICY_VERSION;
    exactRetailerItemBindingRequired: true;
    validManufacturerGtinRequired: true;
    singleUnitListingGtinOnly: true;
    multipackListingGtinRole: "OUTER_MARKETPLACE_OFFER_ONLY";
    authoritativePackageFormRequiresExactMatcher: true;
    firstPartyRetailerContainerTypeAllowed: true;
    firstPartyRetailerFormContradictionFailsClosed: true;
    firstPartyRetailerContainerTypeAttribute: "Container type";
    allowedPresentationPhrases: readonly ["ready to serve"];
  };
  counts: {
    admissionTargets: number;
    targetsWithValidDonorGtin: number;
    exactSingleUnitGtinTargets: number;
    exactAuthoritativePackageFormTargets: number;
    exactFirstPartyRetailerPackageFormTargets: number;
    admittedTargets: number;
    admittedDependentListings: number;
    outerMarketplaceGtinEvidenceRows: number;
    excludedTargets: number;
  };
  exclusionCounts: Array<{ code: string; count: number }>;
  targets: ProductTruthListingRetailerIdentityBridgeTarget[];
  exclusions: ProductTruthListingRetailerIdentityBridgeExclusion[];
  claims: {
    readOnlyInputs: true;
    databaseWrites: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    marketplaceMutations: 0;
    authorizesExecution: false;
    outerMarketplaceGtinNeverBecomesManufacturerTruth: true;
    priceNeverBecomesContentIdentity: true;
  };
}

export class ProductTruthListingRetailerIdentityBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthListingRetailerIdentityBridgeError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthListingRetailerIdentityBridgeError(code, message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalInstant(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!value || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("LISTING_RETAILER_IDENTITY_INPUT_INVALID", `${label} must be canonical UTC`);
  }
  return value;
}

function exactSha(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    fail("LISTING_RETAILER_IDENTITY_INPUT_INVALID", `${label} must be SHA-256`);
  }
  return value;
}

function validateCanonicalSource(input: {
  label: string;
  json: string;
  expectedSha256: string;
  rendered: string;
}): void {
  const expected = exactSha(input.expectedSha256, `${input.label}.sha256`);
  const actual = sha256(input.json);
  if (actual !== expected || input.rendered !== input.json) {
    fail(
      "LISTING_RETAILER_IDENTITY_SOURCE_MISMATCH",
      `${input.label} bytes changed or are not canonical`,
    );
  }
}

function uniqueMap<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    if (result.has(key)) {
      fail("LISTING_RETAILER_IDENTITY_SOURCE_DUPLICATE", `${label} ${key}`);
    }
    result.set(key, row);
  }
  return result;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en-US"));
}

function authoritativeEvidenceCore(
  evidence: ProductTruthAuthoritativeWalmartItemReportEvidenceRow,
): Omit<ProductTruthAuthoritativeWalmartItemReportEvidenceRow, "evidenceRowSha256"> {
  const core = { ...evidence };
  delete (core as Partial<ProductTruthAuthoritativeWalmartItemReportEvidenceRow>)
    .evidenceRowSha256;
  return core;
}

const AUTHORITATIVE_PRESENTATION_PHRASE = /\bready\s+to\s+serve\b/giu;

function listingComparisonTitle(title: string): {
  comparisonTitle: string;
  removedPresentationPhrases: string[];
} {
  const removed = title.match(AUTHORITATIVE_PRESENTATION_PHRASE) ?? [];
  return {
    comparisonTitle: title
      .replace(AUTHORITATIVE_PRESENTATION_PHRASE, " ")
      .replace(/\s+/g, " ")
      .trim(),
    removedPresentationPhrases: removed.map(() => "ready to serve"),
  };
}

const EXACT_PACKAGE_FORMS = new Set([
  "bag",
  "bottle",
  "box",
  "can",
  "carton",
  "jar",
  "packet",
  "pouch",
  "tub",
]);

type RetailerPackageFormObservation =
  | { status: "NONE" | "AMBIGUOUS" }
  | {
    status: "OBSERVED";
    rawValue: string;
    normalizedForm: string;
  };

function normalizeExactPackageForm(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
  return EXACT_PACKAGE_FORMS.has(normalized) ? normalized : null;
}

function observeRetailerPackageForm(
  donor: ProductTruthLegacyBridgeDonorRow,
): RetailerPackageFormObservation {
  if (!donor.attributes) return { status: "NONE" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(donor.attributes);
  } catch {
    return { status: "NONE" };
  }
  if (!Array.isArray(parsed)) return { status: "NONE" };
  const observations = parsed.flatMap((attribute): Array<{
    rawValue: string;
    normalizedForm: string;
  }> => {
    if (!attribute || typeof attribute !== "object") return [];
    const row = attribute as { name?: unknown; value?: unknown };
    if (
      typeof row.name !== "string"
      || row.name.trim().toLocaleLowerCase("en-US") !== "container type"
      || typeof row.value !== "string"
    ) return [];
    const normalizedForm = normalizeExactPackageForm(row.value);
    return normalizedForm
      ? [{ rawValue: row.value, normalizedForm }]
      : [];
  });
  const forms = uniqueSorted(observations.map((row) => row.normalizedForm));
  if (!forms.length) return { status: "NONE" };
  if (forms.length !== 1) return { status: "AMBIGUOUS" };
  const normalizedForm = forms[0]!;
  const rawValue = observations
    .filter((row) => row.normalizedForm === normalizedForm)
    .map((row) => row.rawValue)
    .sort((left, right) => left.localeCompare(right, "en-US"))[0]!;
  return { status: "OBSERVED", rawValue, normalizedForm };
}

function matcherIsExactExceptForPackageForm(
  matcher: CanonicalProductMatchResult,
): boolean {
  const titleEvidence = matcher.titleEvidence;
  const targetSize = matcher.normalized.target.size;
  const candidateSize = matcher.normalized.candidate.size;
  return matcher.verdict === "REJECT"
    && matcher.reasonCodes.length === 1
    && matcher.reasonCodes[0] === "TITLE_TARGET_TOKEN_MISSING"
    && Boolean(titleEvidence)
    && titleEvidence!.missingTargetTokens.length > 0
    && renderProductTruthOperationalJson(titleEvidence!.missingTargetTokens)
      === renderProductTruthOperationalJson(matcher.normalized.target.formTokens)
    && titleEvidence!.unexplainedCandidateTokens.length === 0
    && titleEvidence!.candidateOuterPackCount === titleEvidence!.targetOuterPackCount
    && Boolean(targetSize)
    && Boolean(candidateSize)
    && targetSize!.dimension === candidateSize!.dimension
    && targetSize!.baseUnit === candidateSize!.baseUnit
    && targetSize!.baseAmount === candidateSize!.baseAmount;
}

function compareTargets(
  left: ProductTruthListingRetailerIdentityBridgeTarget,
  right: ProductTruthListingRetailerIdentityBridgeTarget,
): number {
  return right.impact.immediateClosableListings
    - left.impact.immediateClosableListings
    || right.impact.knownGmv30d - left.impact.knownGmv30d
    || right.impact.dependentListings - left.impact.dependentListings
    || left.acquisitionPriority - right.acquisitionPriority
    || left.canonicalVariantId.localeCompare(right.canonicalVariantId, "en-US");
}

export function compileProductTruthListingRetailerIdentityBridge(input: {
  generatedAt: string;
  componentScope: ProductTruthComponentAcquisitionScope;
  componentScopeJson: string;
  componentScopeSha256: string;
  bridgeSnapshot: ProductTruthLegacyBridgeSnapshot;
  bridgeSnapshotJson: string;
  bridgeSnapshotSha256: string;
  sourceDetailAdmission: ProductTruthSourceDetailAdmission;
  sourceDetailAdmissionJson: string;
  sourceDetailAdmissionSha256: string;
}): ProductTruthListingRetailerIdentityBridge {
  const generatedAt = canonicalInstant(input.generatedAt, "generatedAt");
  if (
    input.componentScope.schemaVersion
      !== PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION
    || input.bridgeSnapshot.schemaVersion
      !== PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION
    || input.sourceDetailAdmission.schemaVersion
      !== PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION
  ) {
    fail("LISTING_RETAILER_IDENTITY_SOURCE_VERSION_MISMATCH", "source version changed");
  }
  validateCanonicalSource({
    label: "componentScope",
    json: input.componentScopeJson,
    expectedSha256: input.componentScopeSha256,
    rendered: renderProductTruthComponentAcquisitionScope(input.componentScope),
  });
  validateCanonicalSource({
    label: "bridgeSnapshot",
    json: input.bridgeSnapshotJson,
    expectedSha256: input.bridgeSnapshotSha256,
    rendered: renderProductTruthLegacyBridgeSnapshot(input.bridgeSnapshot),
  });
  validateCanonicalSource({
    label: "sourceDetailAdmission",
    json: input.sourceDetailAdmissionJson,
    expectedSha256: input.sourceDetailAdmissionSha256,
    rendered: renderProductTruthSourceDetailAdmission(input.sourceDetailAdmission),
  });
  if (
    input.componentScope.source.bridgeSnapshot.sha256 !== input.bridgeSnapshotSha256
    || input.componentScope.source.bridgeSnapshot.targetFingerprint
      !== input.bridgeSnapshot.targetFingerprint
    || input.sourceDetailAdmission.source.componentAcquisitionScope.sha256
      !== input.componentScopeSha256
    || input.sourceDetailAdmission.source.bridgeSnapshot.sha256
      !== input.bridgeSnapshotSha256
    || input.sourceDetailAdmission.databaseTargetFingerprint
      !== input.bridgeSnapshot.targetFingerprint
  ) {
    fail(
      "LISTING_RETAILER_IDENTITY_SOURCE_BINDING_MISMATCH",
      "scope, snapshot and admission are not the same immutable evidence set",
    );
  }

  const scopeByVariant = uniqueMap(
    input.componentScope.targets,
    (target) => target.canonicalVariantId,
    "component target",
  );
  const donorById = uniqueMap(
    input.bridgeSnapshot.donors,
    (donor) => donor.id,
    "donor",
  );
  const offerById = uniqueMap(
    input.bridgeSnapshot.offers,
    (offer) => offer.id,
    "offer",
  );
  const reportByListing = uniqueMap(
    input.bridgeSnapshot.authoritativeWalmartItemReportEvidence,
    (evidence) => evidence.listingKey,
    "authoritative Walmart listing evidence",
  );

  const targets: ProductTruthListingRetailerIdentityBridgeTarget[] = [];
  const exclusions: ProductTruthListingRetailerIdentityBridgeExclusion[] = [];
  const exclusionCounts = new Map<string, number>();
  const exclude = (canonicalVariantId: string, codes: readonly string[]): void => {
    const blockerCodes = uniqueSorted(codes);
    exclusions.push({ canonicalVariantId, blockerCodes });
    for (const code of blockerCodes) {
      exclusionCounts.set(code, (exclusionCounts.get(code) ?? 0) + 1);
    }
  };
  let targetsWithValidDonorGtin = 0;
  let outerMarketplaceGtinEvidenceRows = 0;

  for (const admissionTarget of input.sourceDetailAdmission.targets) {
    const scopeTarget = scopeByVariant.get(admissionTarget.canonicalVariantId);
    const blockers: string[] = [];
    if (
      !scopeTarget
      || scopeTarget.canonicalIdentityHash !== admissionTarget.canonicalIdentityHash
      || renderProductTruthOperationalJson(scopeTarget.targetIdentity)
        !== renderProductTruthOperationalJson(admissionTarget.targetIdentity)
    ) {
      fail(
        "LISTING_RETAILER_IDENTITY_TARGET_BINDING_MISMATCH",
        admissionTarget.canonicalVariantId,
      );
    }
    if (
      admissionTarget.candidate.donorProductIds.length !== 1
      || admissionTarget.candidate.offerIds.length !== 1
      || admissionTarget.candidate.admissionReasons.length !== 1
      || admissionTarget.candidate.admissionReasons[0] !== "MISSING_FORM_ONLY"
    ) {
      exclude(admissionTarget.canonicalVariantId, ["ADMISSION_NOT_SINGLE_MISSING_FORM"]);
      continue;
    }
    const donorProductId = admissionTarget.candidate.donorProductIds[0]!;
    const offerId = admissionTarget.candidate.offerIds[0]!;
    const donor = donorById.get(donorProductId);
    const offer = offerById.get(offerId);
    if (!donor || !offer) {
      fail(
        "LISTING_RETAILER_IDENTITY_RETAILER_BINDING_MISSING",
        admissionTarget.canonicalVariantId,
      );
    }
    if (
      offer.donorProductId !== donor.id
      || offer.id !== offerId
      || offer.retailer !== admissionTarget.candidate.retailer
      || offer.retailerProductId !== admissionTarget.candidate.retailerProductId
      || offer.productUrl !== admissionTarget.candidate.productUrl
      || !offer.isFirstParty
      || (offer.via ?? "direct") !== "direct"
      || (offer.packSizeSeen ?? 1) !== 1
    ) {
      fail(
        "LISTING_RETAILER_IDENTITY_RETAILER_BINDING_MISMATCH",
        admissionTarget.canonicalVariantId,
      );
    }
    const normalizedManufacturerGtin14 =
      normalizeProductTruthBridgeGtin(donor.upc)
      ?? normalizeProductTruthBridgeGtin(donor.gtin);
    if (!normalizedManufacturerGtin14) {
      exclude(admissionTarget.canonicalVariantId, ["DONOR_MANUFACTURER_GTIN_INVALID"]);
      continue;
    }
    targetsWithValidDonorGtin += 1;
    const donorRowSha256 = productTruthOperationalSha256(donor);
    const packageFormObservation = observeRetailerPackageForm(donor);
    if (packageFormObservation.status === "AMBIGUOUS") {
      exclude(admissionTarget.canonicalVariantId, [
        "AUTHORITATIVE_RETAILER_PACKAGE_FORM_AMBIGUOUS",
      ]);
      continue;
    }
    const targetPackageForm = normalizeExactPackageForm(
      scopeTarget.targetIdentity.form ?? "",
    );
    if (
      packageFormObservation.status === "OBSERVED"
      && packageFormObservation.normalizedForm !== targetPackageForm
    ) {
      exclude(admissionTarget.canonicalVariantId, [
        "AUTHORITATIVE_RETAILER_PACKAGE_FORM_CONTRADICTION",
      ]);
      continue;
    }
    const retailerPackageFormEvidence: ProductTruthRetailerPackageFormEvidence | null =
      packageFormObservation.status === "OBSERVED"
        ? {
          source: "DONOR_ATTRIBUTES_CONTAINER_TYPE",
          donorProductId: donor.id,
          donorRowSha256,
          attributeName: "Container type",
          rawValue: packageFormObservation.rawValue,
          normalizedForm: packageFormObservation.normalizedForm,
        }
        : null;

    const listingEvidence: ProductTruthListingRetailerIdentityEvidence[] = [];
    for (const dependency of scopeTarget.dependencies) {
      if (dependency.channel !== "walmart") continue;
      const evidence = reportByListing.get(dependency.listingKey);
      if (
        !evidence
        || evidence.storeIndex !== dependency.storeIndex
        || evidence.sku !== dependency.sku
        || evidence.publishStatus !== "PUBLISHED"
        || evidence.lifecycleStatus !== "ACTIVE"
        || productTruthOperationalSha256(authoritativeEvidenceCore(evidence))
          !== evidence.evidenceRowSha256
      ) {
        blockers.push("AUTHORITATIVE_WALMART_EVIDENCE_INVALID");
        continue;
      }
      const outerPack = parseProductTruthAuthoritativeWalmartOuterPackTitle(evidence.title);
      const reportOuterPackCount = outerPack.status === "PARSED"
        ? outerPack.count
        : outerPack.status === "NONE" && dependency.quantity === 1
          ? 1
          : null;
      if (
        reportOuterPackCount !== dependency.quantity
        || dependency.quantity < 1
      ) {
        blockers.push("AUTHORITATIVE_OUTER_PACK_MISMATCH");
        continue;
      }
      const normalizedReportGtin14 =
        normalizeProductTruthBridgeGtin(evidence.gtin)
        ?? normalizeProductTruthBridgeGtin(evidence.upc);
      const singleUnitGtinEquality =
        dependency.quantity === 1
        && normalizedReportGtin14 === normalizedManufacturerGtin14;
      if (dependency.quantity !== 1 && normalizedReportGtin14) {
        outerMarketplaceGtinEvidenceRows += 1;
      }
      const comparison = listingComparisonTitle(evidence.title);
      const matcher = matchCanonicalProductTitle(
        {
          ...scopeTarget.targetIdentity,
          outerPackCount: dependency.quantity,
        },
        {
          title: comparison.comparisonTitle,
          brand: null,
        },
      );
      const exactListingPackageForm = matcher.verdict === "EXACT_IDENTITY";
      const exactRetailerPackageForm = Boolean(retailerPackageFormEvidence)
        && matcherIsExactExceptForPackageForm(matcher);
      if (
        !singleUnitGtinEquality
        && !exactListingPackageForm
        && !exactRetailerPackageForm
      ) {
        blockers.push("AUTHORITATIVE_PACKAGE_FORM_NOT_EXACT");
        continue;
      }
      listingEvidence.push({
        listingKey: dependency.listingKey,
        componentIndex: dependency.componentIndex,
        quantity: dependency.quantity,
        evidenceRowSha256: evidence.evidenceRowSha256,
        sourceReportSha256: evidence.sourceReportSha256,
        sourceRowNumber: evidence.sourceRowNumber,
        itemId: evidence.itemId,
        title: evidence.title,
        comparisonTitle: comparison.comparisonTitle,
        removedPresentationPhrases: comparison.removedPresentationPhrases,
        reportOuterPackCount,
        reportGtin: evidence.gtin ?? evidence.upc,
        normalizedReportGtin14,
        reportGtinRole: singleUnitGtinEquality
          ? "EXACT_SINGLE_UNIT_MANUFACTURER_GTIN"
          : "OUTER_MARKETPLACE_OFFER_GTIN",
        identityProofRole: singleUnitGtinEquality
          ? "EXACT_SINGLE_UNIT_MANUFACTURER_GTIN"
          : exactListingPackageForm
            ? "EXACT_LISTING_PACKAGE_FORM"
            : "EXACT_FIRST_PARTY_RETAILER_PACKAGE_FORM",
        matcher,
      });
    }
    if (!listingEvidence.length) {
      exclude(admissionTarget.canonicalVariantId, blockers.length
        ? blockers
        : ["AUTHORITATIVE_LISTING_EVIDENCE_MISSING"]);
      continue;
    }
    const exactSingleUnitGtin = listingEvidence.some((evidence) =>
      evidence.reportGtinRole === "EXACT_SINGLE_UNIT_MANUFACTURER_GTIN");
    const exactListingPackageForm = listingEvidence.some((evidence) =>
      evidence.identityProofRole === "EXACT_LISTING_PACKAGE_FORM");
    targets.push({
      ordinal: -1,
      acquisitionPriority: admissionTarget.acquisitionPriority,
      canonicalVariantId: admissionTarget.canonicalVariantId,
      canonicalIdentityHash: admissionTarget.canonicalIdentityHash,
      targetIdentity: admissionTarget.targetIdentity,
      impact: admissionTarget.impact,
      identityMethod: exactSingleUnitGtin
        ? "EXACT_SINGLE_UNIT_GTIN_EQUALITY"
        : exactListingPackageForm
          ? "EXACT_AUTHORITATIVE_PACKAGE_FORM"
          : "EXACT_FIRST_PARTY_RETAILER_PACKAGE_FORM",
      donor: {
        donorProductId: donor.id,
        donorRowSha256,
        upc: donor.upc,
        gtin: donor.gtin,
        normalizedManufacturerGtin14,
      },
      retailerItem: {
        offerId: offer.id,
        offerRowSha256: productTruthOperationalSha256(offer),
        retailer: admissionTarget.candidate.retailer,
        retailerProductId: offer.retailerProductId,
        productUrl: offer.productUrl!,
      },
      retailerPackageFormEvidence,
      listingEvidence: listingEvidence.sort((left, right) =>
        left.listingKey.localeCompare(right.listingKey, "en-US")
        || left.componentIndex - right.componentIndex),
    });
  }

  targets.sort(compareTargets);
  targets.forEach((target, ordinal) => {
    target.ordinal = ordinal;
  });
  exclusions.sort((left, right) =>
    left.canonicalVariantId.localeCompare(right.canonicalVariantId, "en-US"));

  return {
    schemaVersion: PRODUCT_TRUTH_LISTING_RETAILER_IDENTITY_BRIDGE_VERSION,
    generatedAt,
    databaseTargetFingerprint: input.bridgeSnapshot.targetFingerprint,
    source: {
      componentAcquisitionScope: {
        schemaVersion: PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
        sha256: input.componentScopeSha256,
        generatedAt: input.componentScope.generatedAt,
      },
      bridgeSnapshot: {
        schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
        sha256: input.bridgeSnapshotSha256,
        capturedAt: input.bridgeSnapshot.capturedAt,
      },
      sourceDetailAdmission: {
        schemaVersion: PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION,
        sha256: input.sourceDetailAdmissionSha256,
        generatedAt: input.sourceDetailAdmission.generatedAt,
      },
    },
    matcher: {
      version: CANONICAL_PRODUCT_MATCHER_VERSION,
      implementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      releaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    },
    policy: {
      schemaVersion: PRODUCT_TRUTH_AUTHORITATIVE_LISTING_FORM_POLICY_VERSION,
      exactRetailerItemBindingRequired: true,
      validManufacturerGtinRequired: true,
      singleUnitListingGtinOnly: true,
      multipackListingGtinRole: "OUTER_MARKETPLACE_OFFER_ONLY",
      authoritativePackageFormRequiresExactMatcher: true,
      firstPartyRetailerContainerTypeAllowed: true,
      firstPartyRetailerFormContradictionFailsClosed: true,
      firstPartyRetailerContainerTypeAttribute: "Container type",
      allowedPresentationPhrases: ["ready to serve"],
    },
    counts: {
      admissionTargets: input.sourceDetailAdmission.targets.length,
      targetsWithValidDonorGtin,
      exactSingleUnitGtinTargets: targets.filter((target) =>
        target.identityMethod === "EXACT_SINGLE_UNIT_GTIN_EQUALITY").length,
      exactAuthoritativePackageFormTargets: targets.filter((target) =>
        target.identityMethod === "EXACT_AUTHORITATIVE_PACKAGE_FORM").length,
      exactFirstPartyRetailerPackageFormTargets: targets.filter((target) =>
        target.identityMethod === "EXACT_FIRST_PARTY_RETAILER_PACKAGE_FORM").length,
      admittedTargets: targets.length,
      admittedDependentListings: new Set(targets.flatMap((target) =>
        target.listingEvidence.map((evidence) => evidence.listingKey))).size,
      outerMarketplaceGtinEvidenceRows,
      excludedTargets: exclusions.length,
    },
    exclusionCounts: [...exclusionCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) =>
        right.count - left.count
        || left.code.localeCompare(right.code, "en-US")),
    targets,
    exclusions,
    claims: {
      readOnlyInputs: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      marketplaceMutations: 0,
      authorizesExecution: false,
      outerMarketplaceGtinNeverBecomesManufacturerTruth: true,
      priceNeverBecomesContentIdentity: true,
    },
  };
}

export function renderProductTruthListingRetailerIdentityBridge(
  value: ProductTruthListingRetailerIdentityBridge,
): string {
  return renderProductTruthOperationalJson(value);
}

export function productTruthListingRetailerIdentityBridgeSha256(
  value: ProductTruthListingRetailerIdentityBridge,
): string {
  return sha256(renderProductTruthListingRetailerIdentityBridge(value));
}
