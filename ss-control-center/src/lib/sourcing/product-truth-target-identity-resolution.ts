import { createHash } from "node:crypto";

import {
  matchCanonicalProductTitle,
  type CanonicalProductIdentity,
  type CanonicalProductMatchResult,
} from "./canonical-product-match";
import {
  buildCanonicalProductVariantKey,
} from "./canonical-product-variant";
import {
  PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
  renderProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionScope,
} from "./product-truth-component-acquisition-scope";
import {
  compileProductTruthDirectRetailerIdentityEvidence,
  PRODUCT_TRUTH_DIRECT_RETAILER_IDENTITY_EVIDENCE_VERSION,
  renderProductTruthDirectRetailerIdentityEvidence,
  type ProductTruthDirectRetailerIdentityEvidence,
} from "./product-truth-direct-retailer-identity-evidence";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  normalizeProductTruthBridgeGtin,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeDonorRow,
  type ProductTruthLegacyBridgeOfferRow,
  type ProductTruthLegacyBridgeSnapshot,
} from "./product-truth-legacy-bridge";
import {
  compileProductTruthListingRetailerIdentityBridge,
  PRODUCT_TRUTH_LISTING_RETAILER_IDENTITY_BRIDGE_VERSION,
  renderProductTruthListingRetailerIdentityBridge,
  type ProductTruthListingRetailerIdentityBridge,
} from "./product-truth-listing-retailer-identity-bridge";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION,
  renderProductTruthSourceDetailAdmission,
  type ProductTruthSourceDetailAdmission,
} from "./product-truth-source-detail-admission";

export const PRODUCT_TRUTH_TARGET_IDENTITY_RESOLUTION_VERSION =
  "product-truth-target-identity-resolution/1.0.0" as const;
export const PRODUCT_TRUTH_TARGET_IDENTITY_RESOLUTION_POLICY_VERSION =
  "product-truth-target-identity-resolution-policy/1.0.0" as const;

export type ProductTruthTargetIdentityResolutionMethod =
  | "DIRECT_RETAILER_PACKAGE_FORM_CORRECTION"
  | "CROSS_RETAILER_GTIN_EQUALITY";

export interface ProductTruthTargetIdentityResolutionEvidenceInput {
  evidence: ProductTruthDirectRetailerIdentityEvidence;
  evidenceJson: string;
  evidenceSha256: string;
  htmlBytes: Uint8Array;
}

export interface ProductTruthTargetIdentityResolutionTarget {
  ordinal: number;
  acquisitionPriority: number;
  sourceCanonicalVariantId: string;
  sourceCanonicalIdentityHash: string;
  sourceIdentity: CanonicalProductIdentity;
  resolvedCanonicalVariantId: string;
  resolvedCanonicalIdentityHash: string;
  resolvedCanonicalIdentityJson: string;
  resolvedIdentity: CanonicalProductIdentity;
  changedFields: Array<"form">;
  resolutionMethod: ProductTruthTargetIdentityResolutionMethod;
  impact: ProductTruthComponentAcquisitionScope["targets"][number]["impact"];
  dependencies:
    ProductTruthComponentAcquisitionScope["targets"][number]["dependencies"];
  materializationDonor: {
    donorProductId: string;
    donorRowSha256: string;
    normalizedManufacturerGtin14: string;
    exactPackageForm: string;
  };
  materializationOffer: {
    offerId: string;
    offerRowSha256: string;
    retailer: string;
    retailerProductId: string;
    productUrl: string;
  };
  identityEvidence: {
    schemaVersion:
      typeof PRODUCT_TRUTH_DIRECT_RETAILER_IDENTITY_EVIDENCE_VERSION;
    evidenceSha256: string;
    htmlSha256: string;
    retailer: "walmart" | "target";
    retailerProductId: string;
    observedGtin14: string;
    observedPackageForm: string | null;
    titleMatcherWithoutForm: CanonicalProductMatchResult;
  };
}

export interface ProductTruthTargetIdentityResolution {
  schemaVersion: typeof PRODUCT_TRUTH_TARGET_IDENTITY_RESOLUTION_VERSION;
  generatedAt: string;
  databaseTargetFingerprint: string;
  source: {
    componentAcquisitionScope: {
      schemaVersion: typeof PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION;
      sha256: string;
    };
    bridgeSnapshot: {
      schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION;
      sha256: string;
    };
    sourceDetailAdmission: {
      schemaVersion: typeof PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION;
      sha256: string;
    };
    listingRetailerIdentityBridge: {
      schemaVersion:
        typeof PRODUCT_TRUTH_LISTING_RETAILER_IDENTITY_BRIDGE_VERSION;
      sha256: string;
    };
    directRetailerEvidenceSha256: string[];
  };
  policy: {
    schemaVersion:
      typeof PRODUCT_TRUTH_TARGET_IDENTITY_RESOLUTION_POLICY_VERSION;
    exactFirstPartyItemBindingRequired: true;
    rawHtmlReparseRequired: true;
    manufacturerGtinEqualityRequired: true;
    titleExactWithoutFormRequired: true;
    packageFormFromTitleForbidden: true;
    directFormCorrectionFields: readonly ["form"];
    clubsExcluded: true;
    bjsExcluded: true;
  };
  counts: {
    inputEvidence: number;
    resolvedTargets: number;
    correctedTargets: number;
    crossRetailerGtinTargets: number;
    dependentListings: number;
  };
  targets: ProductTruthTargetIdentityResolutionTarget[];
  claims: {
    readOnlyInputs: true;
    databaseWrites: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    marketplaceMutations: 0;
    authorizesExecution: false;
    createsAdditionalCatalog: false;
    priceNeverBecomesIdentity: true;
  };
}

export class ProductTruthTargetIdentityResolutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthTargetIdentityResolutionError";
    this.code = code;
  }
}

const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1_000;
const EXACT_FORMS = new Set([
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

function fail(code: string, message: string): never {
  throw new ProductTruthTargetIdentityResolutionError(code, message);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalInstant(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (
    !value
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value
  ) fail("TARGET_IDENTITY_RESOLUTION_INPUT_INVALID", `${label} must be UTC`);
  return value;
}

function exactSha(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    fail("TARGET_IDENTITY_RESOLUTION_INPUT_INVALID", `${label} must be SHA-256`);
  }
  return value;
}

function validateCanonicalSource(input: {
  label: string;
  json: string;
  sha256: string;
  rendered: string;
}): void {
  if (
    sha256(input.json) !== exactSha(input.sha256, `${input.label}.sha256`)
    || input.json !== input.rendered
  ) {
    fail(
      "TARGET_IDENTITY_RESOLUTION_SOURCE_MISMATCH",
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
      fail("TARGET_IDENTITY_RESOLUTION_SOURCE_DUPLICATE", `${label} ${key}`);
    }
    result.set(key, row);
  }
  return result;
}

function normalizedForm(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ");
  return EXACT_FORMS.has(normalized) ? normalized : null;
}

function donorPackageForm(donor: ProductTruthLegacyBridgeDonorRow): string | null {
  if (!donor.attributes) return null;
  let attributes: unknown;
  try {
    attributes = JSON.parse(donor.attributes);
  } catch {
    return null;
  }
  if (!Array.isArray(attributes)) return null;
  const forms = attributes.flatMap((candidate): string[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return [];
    }
    const row = candidate as { name?: unknown; value?: unknown };
    if (
      typeof row.name !== "string"
      || row.name.trim().toLocaleLowerCase("en-US") !== "container type"
      || typeof row.value !== "string"
    ) return [];
    const form = normalizedForm(row.value);
    return form ? [form] : [];
  });
  const unique = [...new Set(forms)];
  return unique.length === 1 ? unique[0]! : null;
}

function ordinaryOffer(offer: ProductTruthLegacyBridgeOfferRow): boolean {
  const retailer = offer.retailer.trim().toLocaleLowerCase("en-US");
  return offer.isFirstParty
    && offer.via === "direct"
    && (offer.packSizeSeen ?? 1) === 1
    && Boolean(offer.productUrl?.startsWith("https://"))
    && ![
      "bjs",
      "bj's",
      "sams",
      "samsclub",
      "sam's club",
      "costco",
    ].includes(retailer);
}

function offerPriority(offer: ProductTruthLegacyBridgeOfferRow): number {
  if (offer.retailer === "walmart") return 0;
  if (offer.retailer === "target") return 1;
  if (offer.retailer === "publix") return 2;
  return 10;
}

function validateDirectEvidence(input: {
  source: ProductTruthTargetIdentityResolutionEvidenceInput;
  generatedAt: string;
}): ProductTruthDirectRetailerIdentityEvidence {
  const { source } = input;
  validateCanonicalSource({
    label: "directRetailerIdentityEvidence",
    json: source.evidenceJson,
    sha256: source.evidenceSha256,
    rendered: renderProductTruthDirectRetailerIdentityEvidence(source.evidence),
  });
  if (
    source.evidence.schemaVersion
      !== PRODUCT_TRUTH_DIRECT_RETAILER_IDENTITY_EVIDENCE_VERSION
    || sha256(source.htmlBytes) !== source.evidence.retailerContent.htmlSha256
    || Date.parse(source.evidence.capturedAt) > Date.parse(input.generatedAt)
    || Date.parse(input.generatedAt) - Date.parse(source.evidence.capturedAt)
      > MAX_EVIDENCE_AGE_MS
  ) {
    fail(
      "TARGET_IDENTITY_RESOLUTION_EVIDENCE_INVALID",
      source.evidence.targetCanonicalVariantId,
    );
  }
  const recompiled = compileProductTruthDirectRetailerIdentityEvidence({
    targetCanonicalVariantId: source.evidence.targetCanonicalVariantId,
    donorProductId: source.evidence.donorProductId,
    offerId: source.evidence.offerId,
    retailer: source.evidence.retailerContent.retailer,
    productUrl: source.evidence.retailerContent.productUrl,
    finalUrl: source.evidence.retailerContent.finalUrl,
    httpStatus: source.evidence.retailerContent.httpStatus,
    capturedAt: source.evidence.capturedAt,
    htmlFile: source.evidence.retailerContent.htmlFile,
    htmlBytes: source.htmlBytes,
  });
  if (
    renderProductTruthDirectRetailerIdentityEvidence(recompiled)
      !== source.evidenceJson
  ) {
    fail(
      "TARGET_IDENTITY_RESOLUTION_EVIDENCE_REPARSE_MISMATCH",
      source.evidence.targetCanonicalVariantId,
    );
  }
  return source.evidence;
}

function exactTitleWithoutForm(input: {
  target: CanonicalProductIdentity;
  title: string;
  canonicalVariantId: string;
}): CanonicalProductMatchResult {
  const matcher = matchCanonicalProductTitle(
    { ...input.target, form: null },
    { title: input.title, brand: null },
  );
  if (
    matcher.verdict !== "EXACT_IDENTITY"
    || matcher.titleEvidence?.missingTargetTokens.length
    || matcher.titleEvidence?.unexplainedCandidateTokens.length
  ) {
    fail(
      "TARGET_IDENTITY_RESOLUTION_TITLE_NOT_EXACT",
      `${input.canonicalVariantId}: ${matcher.reasonCodes.join(",")}`,
    );
  }
  return matcher;
}

function exactDonorBindingAllowed(input: {
  snapshot: ProductTruthLegacyBridgeSnapshot;
  donorProductId: string;
  resolvedCanonicalVariantId: string;
}): boolean {
  return input.snapshot.canonicalDonorBindings
    .filter((binding) => binding.donorProductId === input.donorProductId)
    .every((binding) =>
      binding.canonicalVariantId === input.resolvedCanonicalVariantId);
}

function compareTargets(
  left: ProductTruthTargetIdentityResolutionTarget,
  right: ProductTruthTargetIdentityResolutionTarget,
): number {
  return right.impact.immediateClosableListings
    - left.impact.immediateClosableListings
    || right.impact.knownGmv30d - left.impact.knownGmv30d
    || right.impact.dependentListings - left.impact.dependentListings
    || left.acquisitionPriority - right.acquisitionPriority
    || left.sourceCanonicalVariantId.localeCompare(
      right.sourceCanonicalVariantId,
      "en-US",
    );
}

export function compileProductTruthTargetIdentityResolution(input: {
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
  listingRetailerIdentityBridge: ProductTruthListingRetailerIdentityBridge;
  listingRetailerIdentityBridgeJson: string;
  listingRetailerIdentityBridgeSha256: string;
  directEvidence: ProductTruthTargetIdentityResolutionEvidenceInput[];
}): ProductTruthTargetIdentityResolution {
  const generatedAt = canonicalInstant(input.generatedAt, "generatedAt");
  validateCanonicalSource({
    label: "componentAcquisitionScope",
    json: input.componentScopeJson,
    sha256: input.componentScopeSha256,
    rendered: renderProductTruthComponentAcquisitionScope(input.componentScope),
  });
  validateCanonicalSource({
    label: "bridgeSnapshot",
    json: input.bridgeSnapshotJson,
    sha256: input.bridgeSnapshotSha256,
    rendered: renderProductTruthLegacyBridgeSnapshot(input.bridgeSnapshot),
  });
  validateCanonicalSource({
    label: "sourceDetailAdmission",
    json: input.sourceDetailAdmissionJson,
    sha256: input.sourceDetailAdmissionSha256,
    rendered: renderProductTruthSourceDetailAdmission(input.sourceDetailAdmission),
  });
  validateCanonicalSource({
    label: "listingRetailerIdentityBridge",
    json: input.listingRetailerIdentityBridgeJson,
    sha256: input.listingRetailerIdentityBridgeSha256,
    rendered: renderProductTruthListingRetailerIdentityBridge(
      input.listingRetailerIdentityBridge,
    ),
  });
  if (
    input.componentScope.schemaVersion
      !== PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION
    || input.bridgeSnapshot.schemaVersion
      !== PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION
    || input.sourceDetailAdmission.schemaVersion
      !== PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION
    || input.listingRetailerIdentityBridge.schemaVersion
      !== PRODUCT_TRUTH_LISTING_RETAILER_IDENTITY_BRIDGE_VERSION
    || input.componentScope.source.bridgeSnapshot.sha256
      !== input.bridgeSnapshotSha256
    || input.sourceDetailAdmission.source.componentAcquisitionScope.sha256
      !== input.componentScopeSha256
    || input.sourceDetailAdmission.source.bridgeSnapshot.sha256
      !== input.bridgeSnapshotSha256
    || input.listingRetailerIdentityBridge.source.componentAcquisitionScope.sha256
      !== input.componentScopeSha256
    || input.listingRetailerIdentityBridge.source.bridgeSnapshot.sha256
      !== input.bridgeSnapshotSha256
    || input.listingRetailerIdentityBridge.source.sourceDetailAdmission.sha256
      !== input.sourceDetailAdmissionSha256
    || input.bridgeSnapshot.targetFingerprint
      !== input.componentScope.source.bridgeSnapshot.targetFingerprint
  ) {
    fail(
      "TARGET_IDENTITY_RESOLUTION_SOURCE_BINDING_MISMATCH",
      "scope, snapshot, admission and bridge are not one immutable set",
    );
  }
  const recompiledBridge = compileProductTruthListingRetailerIdentityBridge({
    generatedAt: input.listingRetailerIdentityBridge.generatedAt,
    componentScope: input.componentScope,
    componentScopeJson: input.componentScopeJson,
    componentScopeSha256: input.componentScopeSha256,
    bridgeSnapshot: input.bridgeSnapshot,
    bridgeSnapshotJson: input.bridgeSnapshotJson,
    bridgeSnapshotSha256: input.bridgeSnapshotSha256,
    sourceDetailAdmission: input.sourceDetailAdmission,
    sourceDetailAdmissionJson: input.sourceDetailAdmissionJson,
    sourceDetailAdmissionSha256: input.sourceDetailAdmissionSha256,
  });
  if (
    renderProductTruthListingRetailerIdentityBridge(recompiledBridge)
      !== input.listingRetailerIdentityBridgeJson
  ) {
    fail(
      "TARGET_IDENTITY_RESOLUTION_SOURCE_RECOMPILE_MISMATCH",
      "listing retailer bridge changed",
    );
  }
  const validatedEvidence = input.directEvidence.map((source) => ({
    evidence: validateDirectEvidence({ source, generatedAt }),
    sha256: source.evidenceSha256,
  }));
  uniqueMap(
    validatedEvidence,
    (row) => row.evidence.targetCanonicalVariantId,
    "direct evidence",
  );
  const scopeByVariant = uniqueMap(
    input.componentScope.targets,
    (target) => target.canonicalVariantId,
    "component target",
  );
  const admissionByVariant = uniqueMap(
    input.sourceDetailAdmission.targets,
    (target) => target.canonicalVariantId,
    "admission target",
  );
  const exclusionByVariant = uniqueMap(
    input.listingRetailerIdentityBridge.exclusions,
    (target) => target.canonicalVariantId,
    "listing bridge exclusion",
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
  const offersByDonor = new Map<string, ProductTruthLegacyBridgeOfferRow[]>();
  for (const offer of input.bridgeSnapshot.offers) {
    const rows = offersByDonor.get(offer.donorProductId) ?? [];
    rows.push(offer);
    offersByDonor.set(offer.donorProductId, rows);
  }
  const targets: ProductTruthTargetIdentityResolutionTarget[] = [];
  for (const evidenceRow of validatedEvidence) {
    const { evidence } = evidenceRow;
    const target = scopeByVariant.get(evidence.targetCanonicalVariantId);
    const admission = admissionByVariant.get(evidence.targetCanonicalVariantId);
    const exclusion = exclusionByVariant.get(evidence.targetCanonicalVariantId);
    const evidenceDonor = donorById.get(evidence.donorProductId);
    const evidenceOffer = offerById.get(evidence.offerId);
    if (
      !target
      || !admission
      || !exclusion
      || !evidenceDonor
      || !evidenceOffer
      || admission.candidate.donorProductIds.length !== 1
      || admission.candidate.donorProductIds[0] !== evidenceDonor.id
      || admission.candidate.offerIds.length !== 1
      || admission.candidate.offerIds[0] !== evidenceOffer.id
      || evidenceOffer.donorProductId !== evidenceDonor.id
      || evidenceOffer.retailer !== evidence.retailerContent.retailer
      || evidenceOffer.retailerProductId
        !== evidence.retailerContent.retailerProductId
      || evidenceOffer.productUrl !== evidence.retailerContent.productUrl
      || !ordinaryOffer(evidenceOffer)
    ) {
      fail(
        "TARGET_IDENTITY_RESOLUTION_EVIDENCE_BINDING_MISMATCH",
        evidence.targetCanonicalVariantId,
      );
    }
    const titleMatcherWithoutForm = exactTitleWithoutForm({
      target: target.targetIdentity,
      title: evidence.retailerContent.title,
      canonicalVariantId: target.canonicalVariantId,
    });
    let resolvedIdentity: CanonicalProductIdentity;
    let changedFields: Array<"form">;
    let resolutionMethod: ProductTruthTargetIdentityResolutionMethod;
    let materializationDonor: ProductTruthLegacyBridgeDonorRow;
    let exactPackageForm: string;
    const observedForm = evidence.retailerContent.packageFormEvidence
      ?.normalizedForm ?? null;
    if (observedForm) {
      const sourceForm = normalizedForm(target.targetIdentity.form);
      const donorGtin = normalizeProductTruthBridgeGtin(evidenceDonor.upc)
        ?? normalizeProductTruthBridgeGtin(evidenceDonor.gtin);
      if (
        !sourceForm
        || sourceForm === observedForm
        || donorGtin !== evidence.retailerContent.normalizedGtin14
        || !exclusion.blockerCodes.some((code) => [
          "AUTHORITATIVE_RETAILER_PACKAGE_FORM_CONTRADICTION",
          "AUTHORITATIVE_PACKAGE_FORM_NOT_EXACT",
        ].includes(code))
      ) {
        fail(
          "TARGET_IDENTITY_RESOLUTION_FORM_CORRECTION_INVALID",
          target.canonicalVariantId,
        );
      }
      resolvedIdentity = { ...target.targetIdentity, form: observedForm };
      changedFields = ["form"];
      resolutionMethod = "DIRECT_RETAILER_PACKAGE_FORM_CORRECTION";
      materializationDonor = evidenceDonor;
      exactPackageForm = observedForm;
    } else {
      if (
        !exclusion.blockerCodes.includes("DONOR_MANUFACTURER_GTIN_INVALID")
      ) {
        fail(
          "TARGET_IDENTITY_RESOLUTION_GTIN_PIVOT_INVALID",
          target.canonicalVariantId,
        );
      }
      const sourceForm = normalizedForm(target.targetIdentity.form);
      const candidates = input.bridgeSnapshot.donors.filter((donor) => {
        const gtin = normalizeProductTruthBridgeGtin(donor.upc)
          ?? normalizeProductTruthBridgeGtin(donor.gtin);
        return donor.id !== evidenceDonor.id
          && gtin === evidence.retailerContent.normalizedGtin14
          && donorPackageForm(donor) === sourceForm
          && (offersByDonor.get(donor.id) ?? []).some(ordinaryOffer);
      });
      if (!sourceForm || candidates.length !== 1) {
        fail(
          "TARGET_IDENTITY_RESOLUTION_GTIN_PIVOT_CARDINALITY_INVALID",
          `${target.canonicalVariantId}: ${candidates.length}`,
        );
      }
      resolvedIdentity = target.targetIdentity;
      changedFields = [];
      resolutionMethod = "CROSS_RETAILER_GTIN_EQUALITY";
      materializationDonor = candidates[0]!;
      exactPackageForm = sourceForm;
    }
    const resolvedVariant = buildCanonicalProductVariantKey(resolvedIdentity);
    const donorGtin = normalizeProductTruthBridgeGtin(materializationDonor.upc)
      ?? normalizeProductTruthBridgeGtin(materializationDonor.gtin);
    const offers = (offersByDonor.get(materializationDonor.id) ?? [])
      .filter(ordinaryOffer)
      .sort((left, right) =>
        offerPriority(left) - offerPriority(right)
        || left.id.localeCompare(right.id, "en-US"));
    if (
      donorGtin !== evidence.retailerContent.normalizedGtin14
      || !offers.length
      || !exactDonorBindingAllowed({
        snapshot: input.bridgeSnapshot,
        donorProductId: materializationDonor.id,
        resolvedCanonicalVariantId: resolvedVariant.canonicalVariantId,
      })
    ) {
      fail(
        "TARGET_IDENTITY_RESOLUTION_MATERIALIZATION_DONOR_INVALID",
        target.canonicalVariantId,
      );
    }
    const selectedOffer = offers[0]!;
    targets.push({
      ordinal: -1,
      acquisitionPriority: target.acquisitionPriority,
      sourceCanonicalVariantId: target.canonicalVariantId,
      sourceCanonicalIdentityHash: target.canonicalIdentityHash,
      sourceIdentity: target.targetIdentity,
      resolvedCanonicalVariantId: resolvedVariant.canonicalVariantId,
      resolvedCanonicalIdentityHash: resolvedVariant.identityHash,
      resolvedCanonicalIdentityJson: resolvedVariant.identityJson,
      resolvedIdentity,
      changedFields,
      resolutionMethod,
      impact: target.impact,
      dependencies: target.dependencies,
      materializationDonor: {
        donorProductId: materializationDonor.id,
        donorRowSha256: productTruthOperationalSha256(materializationDonor),
        normalizedManufacturerGtin14: donorGtin,
        exactPackageForm,
      },
      materializationOffer: {
        offerId: selectedOffer.id,
        offerRowSha256: productTruthOperationalSha256(selectedOffer),
        retailer: selectedOffer.retailer,
        retailerProductId: selectedOffer.retailerProductId,
        productUrl: selectedOffer.productUrl!,
      },
      identityEvidence: {
        schemaVersion: evidence.schemaVersion,
        evidenceSha256: evidenceRow.sha256,
        htmlSha256: evidence.retailerContent.htmlSha256,
        retailer: evidence.retailerContent.retailer,
        retailerProductId: evidence.retailerContent.retailerProductId,
        observedGtin14: evidence.retailerContent.normalizedGtin14,
        observedPackageForm: observedForm,
        titleMatcherWithoutForm,
      },
    });
  }
  targets.sort(compareTargets);
  targets.forEach((target, ordinal) => {
    target.ordinal = ordinal;
  });
  if (
    new Set(targets.map((target) => target.resolvedCanonicalVariantId)).size
      !== targets.length
    || new Set(targets.map((target) =>
      target.materializationDonor.donorProductId)).size !== targets.length
  ) {
    fail(
      "TARGET_IDENTITY_RESOLUTION_COLLISION",
      "resolved variants and donors must be one-to-one",
    );
  }
  return {
    schemaVersion: PRODUCT_TRUTH_TARGET_IDENTITY_RESOLUTION_VERSION,
    generatedAt,
    databaseTargetFingerprint: input.bridgeSnapshot.targetFingerprint,
    source: {
      componentAcquisitionScope: {
        schemaVersion: PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
        sha256: input.componentScopeSha256,
      },
      bridgeSnapshot: {
        schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
        sha256: input.bridgeSnapshotSha256,
      },
      sourceDetailAdmission: {
        schemaVersion: PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION,
        sha256: input.sourceDetailAdmissionSha256,
      },
      listingRetailerIdentityBridge: {
        schemaVersion: PRODUCT_TRUTH_LISTING_RETAILER_IDENTITY_BRIDGE_VERSION,
        sha256: input.listingRetailerIdentityBridgeSha256,
      },
      directRetailerEvidenceSha256: validatedEvidence
        .map((row) => row.sha256)
        .sort((left, right) => left.localeCompare(right, "en-US")),
    },
    policy: {
      schemaVersion: PRODUCT_TRUTH_TARGET_IDENTITY_RESOLUTION_POLICY_VERSION,
      exactFirstPartyItemBindingRequired: true,
      rawHtmlReparseRequired: true,
      manufacturerGtinEqualityRequired: true,
      titleExactWithoutFormRequired: true,
      packageFormFromTitleForbidden: true,
      directFormCorrectionFields: ["form"],
      clubsExcluded: true,
      bjsExcluded: true,
    },
    counts: {
      inputEvidence: validatedEvidence.length,
      resolvedTargets: targets.length,
      correctedTargets: targets.filter((target) =>
        target.changedFields.length > 0).length,
      crossRetailerGtinTargets: targets.filter((target) =>
        target.resolutionMethod === "CROSS_RETAILER_GTIN_EQUALITY").length,
      dependentListings: new Set(targets.flatMap((target) =>
        target.dependencies.map((dependency) => dependency.listingKey))).size,
    },
    targets,
    claims: {
      readOnlyInputs: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      marketplaceMutations: 0,
      authorizesExecution: false,
      createsAdditionalCatalog: false,
      priceNeverBecomesIdentity: true,
    },
  };
}

export function renderProductTruthTargetIdentityResolution(
  value: ProductTruthTargetIdentityResolution,
): string {
  return renderProductTruthOperationalJson(value);
}

export function productTruthTargetIdentityResolutionSha256(
  value: ProductTruthTargetIdentityResolution,
): string {
  return sha256(renderProductTruthTargetIdentityResolution(value));
}
