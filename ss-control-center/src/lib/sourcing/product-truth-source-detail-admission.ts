import { createHash } from "node:crypto";

import {
  evaluateRetailerSourceDetailEscalation,
  RETAILER_SOURCE_DETAIL_ESCALATION_ADMISSION_VERSION,
} from "./donor-catalog";
import {
  normalizeIdentityTokens,
  type CanonicalProductIdentity,
} from "./canonical-product-match";
import {
  PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
  renderProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionTarget,
} from "./product-truth-component-acquisition-scope";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeSnapshot,
} from "./product-truth-legacy-bridge";
import {
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  PRODUCT_TRUTH_SEARCH_QUERY_CALIBRATION_VERSION,
  validateBoundProductTruthSearchQueryCalibration,
  type ProductTruthSearchQueryCalibration,
} from "./product-truth-search-query-calibration";
import {
  scoreOffer,
  type CanonicalProduct,
  type RetailOffer,
} from "./retail-fetch";

export const PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION =
  "product-truth-source-detail-admission/1.1.0" as const;

type AdmissionReason = "MISSING_FORM_ONLY" | "BOUNDED_COPY_ONLY";

export interface ProductTruthSourceDetailAdmissionCandidate {
  retailer: "walmart" | "target";
  retailerProductId: string;
  productUrl: string;
  donorProductIds: string[];
  offerIds: string[];
  observedTitles: string[];
  admissionReasons: AdmissionReason[];
}

export interface ProductTruthSourceDetailAdmissionTarget {
  ordinal: number;
  acquisitionPriority: number;
  canonicalVariantId: string;
  canonicalIdentityHash: string;
  targetIdentity: ProductTruthComponentAcquisitionTarget["targetIdentity"];
  impact: ProductTruthComponentAcquisitionTarget["impact"];
  candidate: ProductTruthSourceDetailAdmissionCandidate;
}

export interface ProductTruthSourceDetailAdmission {
  schemaVersion: typeof PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION;
  generatedAt: string;
  databaseTargetFingerprint: string;
  source: {
    componentAcquisitionScope: {
      schemaVersion:
        typeof PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION;
      sha256: string;
      generatedAt: string;
    };
    bridgeSnapshot: {
      schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION;
      sha256: string;
      capturedAt: string;
    };
    searchQueryCalibration: {
      schemaVersion:
        typeof PRODUCT_TRUTH_SEARCH_QUERY_CALIBRATION_VERSION;
      sha256: string;
      generatedAt: string;
    };
  };
  admissionContract: {
    schemaVersion:
      typeof RETAILER_SOURCE_DETAIL_ESCALATION_ADMISSION_VERSION;
    purpose:
      "BOUND_PAID_DETAIL_TO_FREE_SEARCH_EVIDENCE_WITH_EXACT_SIZE_PACK_AND_VARIANT";
  };
  selectionPolicy: {
    retailers: readonly ["walmart", "target"];
    firstPartyDirectOnly: true;
    exactBaseUnitSizeBeforePaidDetail: true;
    exactOuterPackOneBeforePaidDetail: true;
    candidateRule:
      "EXACTLY_ONE_RETAILER_ITEM_PER_TARGET_AND_ONE_TARGET_PER_RETAILER_ITEM";
    canonicalBindingConflict: "EXCLUDE";
    ranking: readonly [
      "IMMEDIATE_CLOSABLE_LISTINGS_DESC",
      "KNOWN_GMV_30D_DESC",
      "DEPENDENT_LISTINGS_DESC",
      "KNOWN_ORDERS_30D_DESC",
      "KNOWN_UNITS_30D_DESC",
      "ACQUISITION_PRIORITY_ASC",
      "CANONICAL_VARIANT_ID_ASC",
    ];
  };
  counts: {
    providerTargets: number;
    calibrationAdmittedTargets: number;
    evaluatedSearchObservations: number;
    admittedSearchObservations: number;
    targetsWithNoCandidate: number;
    targetsWithMultipleCandidateItems: number;
    crossTargetItemConflicts: number;
    admittedTargets: number;
    admittedDependentListings: number;
    admittedImmediateClosures: number;
  };
  exclusionCounts: Array<{
    code: string;
    count: number;
  }>;
  targets: ProductTruthSourceDetailAdmissionTarget[];
  claims: {
    readOnlyInputs: true;
    databaseWrites: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    marketplaceMutations: 0;
    authorizesExecution: false;
    predictsProviderResults: false;
  };
}

export class ProductTruthSourceDetailAdmissionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthSourceDetailAdmissionError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthSourceDetailAdmissionError(code, message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("SOURCE_DETAIL_ADMISSION_INPUT_INVALID", `${label} must be SHA-256`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail("SOURCE_DETAIL_ADMISSION_INPUT_INVALID", `${label} must be UTC`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("SOURCE_DETAIL_ADMISSION_INPUT_INVALID", `${label} must be canonical UTC`);
  }
  return value;
}

function validateCanonicalSource(input: {
  value: unknown;
  json: string;
  sha256: string;
  rendered: string;
  label: string;
}): void {
  const expected = exactSha(input.sha256, `${input.label} SHA-256`);
  if (sha256(input.json) !== expected || input.rendered !== input.json) {
    fail(
      "SOURCE_DETAIL_ADMISSION_SOURCE_MISMATCH",
      `${input.label} bytes changed or are not canonical`,
    );
  }
}

function brandKey(value: unknown): string {
  return normalizeIdentityTokens(
    typeof value === "string" ? value : null,
  ).sort((left, right) => left.localeCompare(right, "en-US")).join("\u0000");
}

function canonicalProduct(
  identity: CanonicalProductIdentity,
): CanonicalProduct {
  return {
    brand: identity.brand ?? undefined,
    product_line: identity.productLine ?? undefined,
    flavor: identity.flavor ?? undefined,
    modifiers: identity.modifiers ?? undefined,
    container_type: identity.form ?? undefined,
    size: identity.size ?? undefined,
    outer_pack_count: identity.outerPackCount ?? 1,
  };
}

function targetCompare(
  left: ProductTruthComponentAcquisitionTarget,
  right: ProductTruthComponentAcquisitionTarget,
): number {
  return right.impact.immediateClosableListings
    - left.impact.immediateClosableListings
    || right.impact.knownGmv30d - left.impact.knownGmv30d
    || right.impact.dependentListings - left.impact.dependentListings
    || right.impact.knownOrders30d - left.impact.knownOrders30d
    || right.impact.knownUnits30d - left.impact.knownUnits30d
    || left.acquisitionPriority - right.acquisitionPriority
    || left.canonicalVariantId.localeCompare(
      right.canonicalVariantId,
      "en-US",
    );
}

export function compileProductTruthSourceDetailAdmission(input: {
  generatedAt: string;
  componentScope: ProductTruthComponentAcquisitionScope;
  componentScopeJson: string;
  componentScopeSha256: string;
  bridgeSnapshot: ProductTruthLegacyBridgeSnapshot;
  bridgeSnapshotJson: string;
  bridgeSnapshotSha256: string;
  searchQueryCalibration: ProductTruthSearchQueryCalibration;
  searchQueryCalibrationJson: string;
  searchQueryCalibrationSha256: string;
}): ProductTruthSourceDetailAdmission {
  const generatedAt = canonicalInstant(input.generatedAt, "generatedAt");
  if (
    input.componentScope.schemaVersion
      !== PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION
  ) {
    fail("SOURCE_DETAIL_ADMISSION_INPUT_INVALID", "component scope version");
  }
  if (
    input.bridgeSnapshot.schemaVersion
      !== PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION
  ) {
    fail("SOURCE_DETAIL_ADMISSION_INPUT_INVALID", "bridge snapshot version");
  }
  validateCanonicalSource({
    value: input.componentScope,
    json: input.componentScopeJson,
    sha256: input.componentScopeSha256,
    rendered: renderProductTruthComponentAcquisitionScope(
      input.componentScope,
    ),
    label: "component scope",
  });
  validateCanonicalSource({
    value: input.bridgeSnapshot,
    json: input.bridgeSnapshotJson,
    sha256: input.bridgeSnapshotSha256,
    rendered: renderProductTruthLegacyBridgeSnapshot(input.bridgeSnapshot),
    label: "bridge snapshot",
  });
  const calibration = validateBoundProductTruthSearchQueryCalibration({
    calibration: input.searchQueryCalibration,
    json: input.searchQueryCalibrationJson,
    sha256: input.searchQueryCalibrationSha256,
  });
  if (
    input.componentScope.source.bridgeSnapshot.sha256
      !== input.bridgeSnapshotSha256
    || input.componentScope.source.bridgeSnapshot.targetFingerprint
      !== input.bridgeSnapshot.targetFingerprint
    || calibration.source.componentScope.sha256
      !== input.componentScopeSha256
    || calibration.source.bridgeSnapshot.sha256
      !== input.bridgeSnapshotSha256
  ) {
    fail(
      "SOURCE_DETAIL_ADMISSION_SOURCE_MISMATCH",
      "scope, snapshot and calibration are not the same immutable evidence set",
    );
  }

  const calibrationByTarget = new Map(
    calibration.admittedProviderTargets.map((target) => [
      target.canonicalVariantId,
      target,
    ]),
  );
  const donorById = new Map(
    input.bridgeSnapshot.donors.map((donor) => [donor.id, donor]),
  );
  const bindingVariantsByDonor = new Map<string, Set<string>>();
  for (const binding of input.bridgeSnapshot.canonicalDonorBindings) {
    const variants = bindingVariantsByDonor.get(binding.donorProductId)
      ?? new Set<string>();
    variants.add(binding.canonicalVariantId);
    bindingVariantsByDonor.set(binding.donorProductId, variants);
  }
  const searchObservationsByBrand = new Map<string, Array<{
    donor: ProductTruthLegacyBridgeSnapshot["donors"][number];
    offer: ProductTruthLegacyBridgeSnapshot["offers"][number];
    retailer: "walmart" | "target";
  }>>();
  for (const offer of input.bridgeSnapshot.offers) {
    const retailer = offer.retailer.trim().toLowerCase();
    const donor = donorById.get(offer.donorProductId);
    if (
      !donor?.title
      || !donor.brand
      || (retailer !== "walmart" && retailer !== "target")
      || !offer.isFirstParty
      || (offer.via || "direct") !== "direct"
      || (offer.packSizeSeen ?? 1) !== 1
      || !offer.productUrl
    ) continue;
    const key = brandKey(donor.brand);
    const rows = searchObservationsByBrand.get(key) ?? [];
    rows.push({
      donor,
      offer,
      retailer,
    });
    searchObservationsByBrand.set(key, rows);
  }

  const exclusionCounts = new Map<string, number>();
  const exclude = (code: string): void => {
    exclusionCounts.set(code, (exclusionCounts.get(code) ?? 0) + 1);
  };
  const providerTargets = input.componentScope.targets.filter(
    (target) =>
      target.acquisitionLane === "PROVIDER_IDENTITY_ACQUISITION",
  );
  const calibratedTargets = providerTargets.filter((target) => {
    const calibrationTarget = calibrationByTarget.get(
      target.canonicalVariantId,
    );
    return calibrationTarget?.canonicalIdentityHash
      === target.canonicalIdentityHash;
  });
  let evaluatedSearchObservations = 0;
  let admittedSearchObservations = 0;
  let targetsWithNoCandidate = 0;
  let targetsWithMultipleCandidateItems = 0;
  const singleCandidateRows: Array<{
    target: ProductTruthComponentAcquisitionTarget;
    candidate: ProductTruthSourceDetailAdmissionCandidate;
  }> = [];

  for (const target of calibratedTargets) {
    const product = canonicalProduct(target.targetIdentity);
    const candidateItems = new Map<string, {
      retailer: "walmart" | "target";
      retailerProductId: string;
      productUrls: Set<string>;
      donorProductIds: Set<string>;
      offerIds: Set<string>;
      observedTitles: Set<string>;
      admissionReasons: Set<AdmissionReason>;
    }>();
    for (
      const observation of searchObservationsByBrand.get(
        brandKey(target.targetIdentity.brand),
      ) ?? []
    ) {
      const boundVariants = bindingVariantsByDonor.get(
        observation.donor.id,
      ) ?? new Set<string>();
      if (
        [...boundVariants].some(
          (variantId) => variantId !== target.canonicalVariantId,
        )
      ) {
        exclude("CANONICAL_DONOR_VARIANT_CONFLICT");
        continue;
      }
      const retailOffer: RetailOffer = {
        retailer: observation.retailer,
        retailerProductId: observation.offer.retailerProductId,
        price: observation.offer.price,
        currency: observation.offer.currency,
        inStock: observation.offer.inStock,
        productUrl: observation.offer.productUrl,
        zip: observation.offer.zip,
        localityEvidence:
          observation.offer.localityEvidence as RetailOffer["localityEvidence"],
        observedAt:
          observation.offer.fetchedAt ?? input.bridgeSnapshot.capturedAt,
        title: observation.donor.title,
        brand: observation.donor.brand,
        description: observation.donor.description,
        keyFeatures: [],
        imageUrls: [],
        packSizeSeen: observation.offer.packSizeSeen,
        isMarketplaceItem: false,
        sellerName:
          observation.retailer === "walmart" ? "Walmart.com" : "Target",
        sourceApi: observation.offer.sourceApi ?? "legacy_snapshot",
        via: "direct",
      };
      const scored = scoreOffer(retailOffer, product);
      const decision = evaluateRetailerSourceDetailEscalation({
        target: product,
        offer: scored,
      });
      evaluatedSearchObservations += 1;
      if (!decision.admitted || !decision.reason) {
        for (const blocker of decision.blockers) exclude(blocker);
        continue;
      }
      admittedSearchObservations += 1;
      const itemKey =
        `${observation.retailer}\u0000${observation.offer.retailerProductId}`;
      const candidate = candidateItems.get(itemKey) ?? {
        retailer: observation.retailer,
        retailerProductId: observation.offer.retailerProductId,
        productUrls: new Set<string>(),
        donorProductIds: new Set<string>(),
        offerIds: new Set<string>(),
        observedTitles: new Set<string>(),
        admissionReasons: new Set<AdmissionReason>(),
      };
      candidate.productUrls.add(observation.offer.productUrl!);
      candidate.donorProductIds.add(observation.donor.id);
      candidate.offerIds.add(observation.offer.id);
      candidate.observedTitles.add(observation.donor.title!);
      candidate.admissionReasons.add(decision.reason);
      candidateItems.set(itemKey, candidate);
    }
    if (candidateItems.size === 0) {
      targetsWithNoCandidate += 1;
      continue;
    }
    if (candidateItems.size !== 1) {
      targetsWithMultipleCandidateItems += 1;
      continue;
    }
    const candidate = [...candidateItems.values()][0]!;
    singleCandidateRows.push({
      target,
      candidate: {
        retailer: candidate.retailer,
        retailerProductId: candidate.retailerProductId,
        productUrl: [...candidate.productUrls].sort((left, right) =>
          left.localeCompare(right, "en-US"))[0]!,
        donorProductIds: [...candidate.donorProductIds].sort(),
        offerIds: [...candidate.offerIds].sort(),
        observedTitles: [...candidate.observedTitles].sort((left, right) =>
          left.localeCompare(right, "en-US")),
        admissionReasons: [...candidate.admissionReasons].sort(),
      },
    });
  }

  const targetsByRetailerItem = new Map<string, Set<string>>();
  for (const row of singleCandidateRows) {
    const itemKey =
      `${row.candidate.retailer}\u0000${row.candidate.retailerProductId}`;
    const targetIds = targetsByRetailerItem.get(itemKey) ?? new Set<string>();
    targetIds.add(row.target.canonicalVariantId);
    targetsByRetailerItem.set(itemKey, targetIds);
  }
  const unconflicted = singleCandidateRows
    .filter((row) => {
      const itemKey =
        `${row.candidate.retailer}\u0000${row.candidate.retailerProductId}`;
      return targetsByRetailerItem.get(itemKey)?.size === 1;
    })
    .sort((left, right) => targetCompare(left.target, right.target));
  const targets: ProductTruthSourceDetailAdmissionTarget[] =
    unconflicted.map((row, ordinal) => ({
      ordinal,
      acquisitionPriority: row.target.acquisitionPriority,
      canonicalVariantId: row.target.canonicalVariantId,
      canonicalIdentityHash: row.target.canonicalIdentityHash,
      targetIdentity: row.target.targetIdentity,
      impact: row.target.impact,
      candidate: row.candidate,
    }));
  const crossTargetItemConflicts =
    singleCandidateRows.length - unconflicted.length;

  return {
    schemaVersion: PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION,
    generatedAt,
    databaseTargetFingerprint: input.bridgeSnapshot.targetFingerprint,
    source: {
      componentAcquisitionScope: {
        schemaVersion:
          PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
        sha256: input.componentScopeSha256,
        generatedAt: input.componentScope.generatedAt,
      },
      bridgeSnapshot: {
        schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
        sha256: input.bridgeSnapshotSha256,
        capturedAt: input.bridgeSnapshot.capturedAt,
      },
      searchQueryCalibration: {
        schemaVersion: PRODUCT_TRUTH_SEARCH_QUERY_CALIBRATION_VERSION,
        sha256: input.searchQueryCalibrationSha256,
        generatedAt: calibration.generatedAt,
      },
    },
    admissionContract: {
      schemaVersion:
        RETAILER_SOURCE_DETAIL_ESCALATION_ADMISSION_VERSION,
      purpose:
        "BOUND_PAID_DETAIL_TO_FREE_SEARCH_EVIDENCE_WITH_EXACT_SIZE_PACK_AND_VARIANT",
    },
    selectionPolicy: {
      retailers: ["walmart", "target"],
      firstPartyDirectOnly: true,
      exactBaseUnitSizeBeforePaidDetail: true,
      exactOuterPackOneBeforePaidDetail: true,
      candidateRule:
        "EXACTLY_ONE_RETAILER_ITEM_PER_TARGET_AND_ONE_TARGET_PER_RETAILER_ITEM",
      canonicalBindingConflict: "EXCLUDE",
      ranking: [
        "IMMEDIATE_CLOSABLE_LISTINGS_DESC",
        "KNOWN_GMV_30D_DESC",
        "DEPENDENT_LISTINGS_DESC",
        "KNOWN_ORDERS_30D_DESC",
        "KNOWN_UNITS_30D_DESC",
        "ACQUISITION_PRIORITY_ASC",
        "CANONICAL_VARIANT_ID_ASC",
      ],
    },
    counts: {
      providerTargets: providerTargets.length,
      calibrationAdmittedTargets: calibratedTargets.length,
      evaluatedSearchObservations,
      admittedSearchObservations,
      targetsWithNoCandidate,
      targetsWithMultipleCandidateItems,
      crossTargetItemConflicts,
      admittedTargets: targets.length,
      admittedDependentListings: new Set(
        targets.flatMap((target) => {
          const source = input.componentScope.targets.find(
            (candidate) =>
              candidate.canonicalVariantId === target.canonicalVariantId,
          );
          return source?.dependencies.map(
            (dependency) => dependency.listingKey,
          ) ?? [];
        }),
      ).size,
      admittedImmediateClosures: targets.reduce(
        (sum, target) =>
          sum + target.impact.immediateClosableListings,
        0,
      ),
    },
    exclusionCounts: [...exclusionCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) =>
        right.count - left.count
        || left.code.localeCompare(right.code, "en-US")),
    targets,
    claims: {
      readOnlyInputs: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      marketplaceMutations: 0,
      authorizesExecution: false,
      predictsProviderResults: false,
    },
  };
}

export function renderProductTruthSourceDetailAdmission(
  value: ProductTruthSourceDetailAdmission,
): string {
  return renderProductTruthOperationalJson(value);
}

export function productTruthSourceDetailAdmissionSha256(
  value: ProductTruthSourceDetailAdmission,
): string {
  return sha256(renderProductTruthSourceDetailAdmission(value));
}
