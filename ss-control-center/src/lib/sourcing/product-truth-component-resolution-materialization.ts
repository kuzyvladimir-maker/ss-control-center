import { createHash } from "node:crypto";

import type { Client, InStatement, Row, Transaction } from "@libsql/client";

import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "./canonical-product-match-provenance";
import {
  buildCanonicalProductVariantKey,
} from "./canonical-product-variant";
import {
  EXACT_CONTENT_IDENTITY_POLICY_VERSION,
} from "./exact-content-identity-policy";
import {
  LEGACY_CATALOG_RECOVERY_IDENTITY_POLICY_VERSION,
  evaluateLegacyCatalogRecoveryIdentity,
} from "./legacy-catalog-recovery-identity";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_CONTENT_VERSION,
  PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION,
  renderProductTruthLegacyBridgeStandingPolicy,
  type ProductTruthLegacyBridgeContentRow,
  type ProductTruthLegacyBridgeDecisionRow,
  type ProductTruthLegacyBridgeDonorTransition,
  type ProductTruthLegacyBridgeStandingPolicy,
  type ProductTruthLegacyBridgeVariantRow,
} from "./product-truth-legacy-bridge-apply";
import {
  normalizeProductTruthBridgeGtin,
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeDonorRow,
  type ProductTruthLegacyBridgeOfferRow,
  type ProductTruthLegacyBridgeSnapshot,
} from "./product-truth-legacy-bridge";
import {
  PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
  renderProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionTarget,
} from "./product-truth-component-acquisition-scope";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  assertProductTruthEvidenceSchema,
  assertProductTruthListingScopeSchema,
} from "./product-truth-schema-gate";

export const PRODUCT_TRUTH_COMPONENT_RESOLUTION_PLAN_VERSION =
  "product-truth-component-resolution-materialization-plan/1.0.0" as const;
export const PRODUCT_TRUTH_COMPONENT_RESOLUTION_METHOD =
  "EXISTING_CATALOG_EXACT_CONTENT_TARGET_RESOLUTION" as const;
export const PRODUCT_TRUTH_COMPONENT_RESOLUTION_DECISION_EVIDENCE_VERSION =
  "product-truth-component-resolution-decision-evidence/1.1.0" as const;
export const PRODUCT_TRUTH_COMPONENT_RESOLUTION_CONTENT_SOURCE_VERSION =
  "product-truth-component-resolution-content-source/1.0.0" as const;
export const PRODUCT_TRUTH_COMPONENT_RESOLUTION_PREFLIGHT_VERSION =
  "product-truth-component-resolution-materialization-preflight/1.0.0" as const;
export const PRODUCT_TRUTH_COMPONENT_RESOLUTION_APPLY_REPORT_VERSION =
  "product-truth-component-resolution-materialization-apply-report/1.0.0" as const;

type JsonRecord = Record<string, unknown>;
type SqlReader = Pick<Client, "execute"> | Pick<Transaction, "execute">;
type RowState = "ABSENT" | "EXACT";
const VARIANT_IGNORED_COLUMNS = new Set(["createdAt"]);

export class ProductTruthComponentResolutionMaterializationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthComponentResolutionMaterializationError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthComponentResolutionMaterializationError(code, message);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return renderProductTruthOperationalJson(value);
}

function exactSha(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    fail("COMPONENT_RESOLUTION_INPUT_INVALID", `${label} must be SHA-256`);
  }
  return value;
}

function exactInstant(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (
    !value
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value
  ) {
    fail("COMPONENT_RESOLUTION_INPUT_INVALID", `${label} must be canonical UTC`);
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseJson(value: string | null, label: string): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    fail("COMPONENT_RESOLUTION_LEGACY_CONTENT_INVALID", label);
  }
}

function assertBoundCanonicalJson(input: {
  label: string;
  json: string;
  sha256: string;
  canonicalJson: string;
}): void {
  const expected = exactSha(input.sha256, `${input.label}.sha256`);
  const actual = sha256Text(input.json);
  if (actual !== expected) {
    fail(
      "COMPONENT_RESOLUTION_SOURCE_HASH_MISMATCH",
      `${input.label} ${actual} != ${expected}`,
    );
  }
  if (input.json !== input.canonicalJson) {
    fail(
      "COMPONENT_RESOLUTION_SOURCE_NOT_CANONICAL",
      input.label,
    );
  }
}

function uniqueMap<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) {
      fail("COMPONENT_RESOLUTION_SOURCE_DUPLICATE", `${label} ${key}`);
    }
    result.set(key, value);
  }
  return result;
}

function offerPriority(offer: ProductTruthLegacyBridgeOfferRow): number {
  if (offer.retailer === "walmart") return 0;
  if (offer.retailer === "target") return 1;
  if (offer.retailer === "publix") return 2;
  return 10;
}

function selectedOffer(input: {
  target: ProductTruthComponentAcquisitionTarget;
  offerById: ReadonlyMap<string, ProductTruthLegacyBridgeOfferRow>;
}): ProductTruthLegacyBridgeOfferRow {
  const candidate = input.target.exactCatalogCandidates[0]!;
  const offers = candidate.ordinaryFirstPartyOffers
    .map((summary) => input.offerById.get(summary.offerId))
    .filter(
      (offer): offer is ProductTruthLegacyBridgeOfferRow =>
        Boolean(offer)
        && offer!.donorProductId === candidate.donorProductId
        && offer!.isFirstParty
        && offer!.via === "direct"
        && Boolean(offer!.productUrl)
        && !["bjs", "sams", "samsclub", "costco"].includes(
          offer!.retailer.toLowerCase(),
        ),
    )
    .sort(
      (left, right) =>
        offerPriority(left) - offerPriority(right)
        || left.id.localeCompare(right.id, "en-US"),
    );
  if (!offers.length) {
    fail(
      "COMPONENT_RESOLUTION_FIRST_PARTY_OFFER_MISSING",
      input.target.canonicalVariantId,
    );
  }
  return offers[0]!;
}

function fieldHashes(payload: JsonRecord): string {
  return canonicalJson(Object.fromEntries(
    [
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
    ].map((field) => [
      field,
      productTruthOperationalSha256(payload[field]),
    ]),
  ));
}

export interface ProductTruthComponentResolutionMaterializationTarget {
  ordinal: number;
  acquisitionPriority: number;
  canonicalVariantId: string;
  donorProductId: string;
  selectedOfferId: string;
  dependentListingKeys: string[];
  variant: ProductTruthLegacyBridgeVariantRow;
  decision: ProductTruthLegacyBridgeDecisionRow;
  donorTransition: ProductTruthLegacyBridgeDonorTransition;
  content: ProductTruthLegacyBridgeContentRow;
}

export interface ProductTruthComponentResolutionMaterializationPlan {
  schemaVersion: typeof PRODUCT_TRUTH_COMPONENT_RESOLUTION_PLAN_VERSION;
  planId: string;
  createdAt: string;
  expiresAt: string;
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
    standingPolicy: {
      schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION;
      sha256: string;
      policyId: string;
    };
    matcher: {
      version: typeof CANONICAL_PRODUCT_MATCHER_VERSION;
      implementationSha256: typeof CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256;
      releaseSha256: typeof CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256;
    };
    contentIdentityPolicyVersion:
      typeof EXACT_CONTENT_IDENTITY_POLICY_VERSION;
  };
  targetsSha256: string;
  targets: ProductTruthComponentResolutionMaterializationTarget[];
  databaseWrites: {
    maximumRows: number;
    canonicalProductVariants: number;
    donorVariantDecisions: number;
    donorIdentityTransitions: number;
    productContentObservations: number;
    listingRecipes: 0;
    skuCosts: 0;
  };
  claims: {
    noPaidExistingCatalogLaneOnly: true;
    allTargetsCollisionFree: true;
    exactContentPackagePolicyEnforced: true;
    createsAdditionalCatalog: false;
    listingRecipesRequireAllComponents: true;
    listingRecipesMaterialized: 0;
    skuCostsMaterialized: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    marketplaceMutations: 0;
    procurementMutations: 0;
    consumerActivation: false;
  };
}

export interface ProductTruthComponentResolutionMaterializationSources {
  componentScope: ProductTruthComponentAcquisitionScope;
  componentScopeJson: string;
  componentScopeSha256: string;
  bridgeSnapshot: ProductTruthLegacyBridgeSnapshot;
  bridgeSnapshotJson: string;
  bridgeSnapshotSha256: string;
  standingPolicy: ProductTruthLegacyBridgeStandingPolicy;
  standingPolicyJson: string;
  standingPolicySha256: string;
}

export interface ProductTruthComponentResolutionPreflightReport {
  schemaVersion: typeof PRODUCT_TRUTH_COMPONENT_RESOLUTION_PREFLIGHT_VERSION;
  status: "READY_TO_APPLY" | "ALREADY_APPLIED";
  planId: string;
  planSha256: string;
  checkedAt: string;
  databaseTargetFingerprint: string;
  standingPolicyId: string;
  standingPolicySha256: string;
  counts: {
    targets: number;
    maximumRows: number;
    absentRows: number;
    exactExistingRows: number;
    canonicalVariantReuses: number;
    donorIdentityTransitionsRequired: number;
  };
  targetStates: Array<{
    canonicalVariantId: string;
    donorProductId: string;
    variant: RowState;
    decision: RowState;
    donorIdentity: "SOURCE" | "EXACT";
    content: RowState;
  }>;
  claims: ProductTruthComponentResolutionMaterializationPlan["claims"];
}

export interface ProductTruthComponentResolutionApplyReport {
  schemaVersion: typeof PRODUCT_TRUTH_COMPONENT_RESOLUTION_APPLY_REPORT_VERSION;
  status: "APPLIED" | "ALREADY_APPLIED";
  planId: string;
  planSha256: string;
  preflightReportSha256: string;
  databaseTargetFingerprint: string;
  standingPolicyId: string;
  standingPolicySha256: string;
  startedAt: string;
  completedAt: string;
  counts: {
    targets: number;
    insertedRows: number;
    exactExistingRows: number;
    canonicalVariantReuses: number;
    donorIdentityTransitions: number;
  };
  verification: {
    exactTargets: number;
    foreignKeyViolations: string[];
    listingRecipesMaterialized: 0;
    skuCostsMaterialized: 0;
  };
  claims: ProductTruthComponentResolutionMaterializationPlan["claims"];
}

function validateSources(
  input: ProductTruthComponentResolutionMaterializationSources,
): void {
  assertBoundCanonicalJson({
    label: "componentScope",
    json: input.componentScopeJson,
    sha256: input.componentScopeSha256,
    canonicalJson:
      renderProductTruthComponentAcquisitionScope(input.componentScope),
  });
  assertBoundCanonicalJson({
    label: "bridgeSnapshot",
    json: input.bridgeSnapshotJson,
    sha256: input.bridgeSnapshotSha256,
    canonicalJson: renderProductTruthLegacyBridgeSnapshot(
      input.bridgeSnapshot,
    ),
  });
  assertBoundCanonicalJson({
    label: "standingPolicy",
    json: input.standingPolicyJson,
    sha256: input.standingPolicySha256,
    canonicalJson: renderProductTruthLegacyBridgeStandingPolicy(
      input.standingPolicy,
    ),
  });
  if (
    input.componentScope.schemaVersion
      !== PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION
    || input.bridgeSnapshot.schemaVersion
      !== PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION
    || input.standingPolicy.schemaVersion
      !== PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION
    || input.componentScope.source.bridgeSnapshot.sha256
      !== input.bridgeSnapshotSha256
    || input.componentScope.source.bridgeSnapshot.targetFingerprint
      !== input.bridgeSnapshot.targetFingerprint
    || input.standingPolicy.databaseTargetFingerprint
      !== input.bridgeSnapshot.targetFingerprint
    || input.standingPolicy.manifestSha256
      !== input.bridgeSnapshot.manifest.sha256
    || input.standingPolicy.approvedBy !== "owner"
    || !input.standingPolicy.allowCanonicalMaterialization
    || !input.standingPolicy.requiresCollisionFree
    || !input.standingPolicy.requiresFreshReadyToApplyPreflight
    || input.standingPolicy.allowProviderCalls
    || input.standingPolicy.allowPaidCalls
    || input.standingPolicy.allowMarketplaceListingWrites
    || input.standingPolicy.allowPriceChanges
    || input.standingPolicy.allowInventoryChanges
    || input.standingPolicy.allowDelisting
    || input.standingPolicy.allowConsumerActivation
    || input.standingPolicy.allowProcurement
  ) {
    fail(
      "COMPONENT_RESOLUTION_SOURCE_BINDING_INVALID",
      "scope, snapshot, or standing policy differs from the no-paid authority",
    );
  }
}

function compileTarget(input: {
  target: ProductTruthComponentAcquisitionTarget;
  donor: ProductTruthLegacyBridgeDonorRow;
  offer: ProductTruthLegacyBridgeOfferRow;
  sources: ProductTruthComponentResolutionMaterializationSources;
  planId: string;
  createdAt: string;
  ordinal: number;
}): ProductTruthComponentResolutionMaterializationTarget {
  const scopeCandidate = input.target.exactCatalogCandidates[0];
  if (!scopeCandidate || scopeCandidate.donorProductId !== input.donor.id) {
    fail(
      "COMPONENT_RESOLUTION_SOURCE_BINDING_INVALID",
      `${input.target.canonicalVariantId}: candidate donor drift`,
    );
  }
  if (!input.donor.title || !input.donor.brand) {
    fail(
      "COMPONENT_RESOLUTION_SOURCE_BINDING_INVALID",
      `${input.target.canonicalVariantId}: candidate donor lacks title or brand`,
    );
  }
  const identityDecision = evaluateLegacyCatalogRecoveryIdentity({
    target: input.target.targetIdentity,
    donor: {
      title: input.donor.title,
      brand: input.donor.brand,
    },
  });
  if (
    !identityDecision.eligible
    || canonicalJson(identityDecision)
      !== canonicalJson(scopeCandidate.identityDecision)
  ) {
    fail(
      "COMPONENT_RESOLUTION_CONTENT_IDENTITY_REJECTED",
      `${input.target.canonicalVariantId}: ${identityDecision.blockers.join(",")}`,
    );
  }
  const variantKey = buildCanonicalProductVariantKey(
    input.target.targetIdentity,
  );
  if (
    variantKey.canonicalVariantId !== input.target.canonicalVariantId
    || variantKey.identityJson !== input.target.canonicalIdentityJson
  ) {
    fail(
      "COMPONENT_RESOLUTION_TARGET_VARIANT_DRIFT",
      input.target.canonicalVariantId,
    );
  }
  const donorRowSha256 = productTruthOperationalSha256(input.donor);
  const offerRowSha256 = productTruthOperationalSha256(input.offer);
  const decisionEvidence = {
    schemaVersion:
      PRODUCT_TRUTH_COMPONENT_RESOLUTION_DECISION_EVIDENCE_VERSION,
    verdict: "EXACT_IDENTITY",
    method: PRODUCT_TRUTH_COMPONENT_RESOLUTION_METHOD,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256:
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256:
      CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    contentIdentityPolicyVersion:
      EXACT_CONTENT_IDENTITY_POLICY_VERSION,
    legacyCatalogRecoveryIdentityPolicyVersion:
      LEGACY_CATALOG_RECOVERY_IDENTITY_POLICY_VERSION,
    legacyCatalogRecoveryIdentityDecision: identityDecision,
    contentIdentityDecision: identityDecision.contentIdentityDecision,
    componentAcquisitionScopeSha256:
      input.sources.componentScopeSha256,
    bridgeSnapshotSha256: input.sources.bridgeSnapshotSha256,
    donorProductId: input.donor.id,
    donorProductRowSha256: donorRowSha256,
    canonicalVariantId: variantKey.canonicalVariantId,
    selectedOfferId: input.offer.id,
    selectedOfferRowSha256: offerRowSha256,
    dependentComponents: input.target.dependencies.map((dependency) => ({
      listingKey: dependency.listingKey,
      componentIndex: dependency.componentIndex,
      quantity: dependency.quantity,
      legacyComponentId: dependency.legacyComponentId,
    })),
  };
  const evidenceJson = canonicalJson(decisionEvidence);
  const evidenceHash = sha256Text(evidenceJson);
  const decisionKey = productTruthOperationalSha256({
    donorProductId: input.donor.id,
    canonicalVariantId: variantKey.canonicalVariantId,
    decisionStatus: "exact_confirmed",
    evidenceHash,
  });
  const decisionId = `dpvd:${decisionKey}`;
  const sourceIdentityFieldsSha256 = productTruthOperationalSha256({
    identityKey: input.donor.identityKey,
    identityStatus: input.donor.identityStatus,
    brand: input.donor.brand,
    productLine: input.donor.productLine,
    flavor: input.donor.flavor,
    containerType: input.donor.containerType,
    size: input.donor.size,
  });
  const imageUrls = parseJson(
    input.donor.imageUrls,
    `${input.donor.id}.imageUrls`,
  ) ?? [];
  if (
    !Array.isArray(imageUrls)
    || imageUrls.some((value) => typeof value !== "string")
  ) {
    fail(
      "COMPONENT_RESOLUTION_LEGACY_CONTENT_INVALID",
      `${input.donor.id}.imageUrls`,
    );
  }
  const normalizedGtin14 =
    normalizeProductTruthBridgeGtin(input.donor.gtin)
    ?? normalizeProductTruthBridgeGtin(input.donor.upc);
  const contentPayload: JsonRecord = {
    _schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_CONTENT_VERSION,
    _capture: "legacy_materialized_bridge",
    title: nullableText(input.donor.title),
    description: nullableText(input.donor.description),
    bullets: parseJson(input.donor.bullets, `${input.donor.id}.bullets`),
    attributes: parseJson(
      input.donor.attributes,
      `${input.donor.id}.attributes`,
    ),
    nutritionFacts: parseJson(
      input.donor.nutritionFacts,
      `${input.donor.id}.nutritionFacts`,
    ),
    ingredients: nullableText(input.donor.ingredients),
    allergens: null,
    category: nullableText(input.donor.category),
    storage: null,
    upc: nullableText(input.donor.upc),
    normalizedGtin14,
    mainImageUrl: nullableText(input.donor.mainImageUrl),
    imageUrls,
    sourceBinding: {
      schemaVersion:
        PRODUCT_TRUTH_COMPONENT_RESOLUTION_CONTENT_SOURCE_VERSION,
      method: PRODUCT_TRUTH_COMPONENT_RESOLUTION_METHOD,
      componentAcquisitionScopeSha256:
        input.sources.componentScopeSha256,
      bridgeSnapshotSha256: input.sources.bridgeSnapshotSha256,
      donorProductId: input.donor.id,
      donorProductRowSha256: donorRowSha256,
      donorUpdatedAt: input.donor.updatedAt,
      donorOfferId: input.offer.id,
      donorOfferRowSha256: offerRowSha256,
      offerFetchedAt: input.offer.fetchedAt,
      originalSourceApi: input.offer.sourceApi,
      historicalPricePromoted: false,
    },
  };
  const contentJson = canonicalJson(contentPayload);
  const contentHash = sha256Text(contentJson);
  const observationKey = productTruthOperationalSha256({
    donorProductId: input.donor.id,
    canonicalVariantId: variantKey.canonicalVariantId,
    variantDecisionId: decisionId,
    sourceUrl: input.offer.productUrl,
    sourceApi: "component-resolution-materialized",
    contentHash,
    observedAt: input.donor.updatedAt,
    sourceScopeSha256: input.sources.componentScopeSha256,
  });
  return {
    ordinal: input.ordinal,
    acquisitionPriority: input.target.acquisitionPriority,
    canonicalVariantId: input.target.canonicalVariantId,
    donorProductId: input.donor.id,
    selectedOfferId: input.offer.id,
    dependentListingKeys: [...new Set(
      input.target.dependencies.map((dependency) => dependency.listingKey),
    )].sort(),
    variant: {
      ...variantKey.db,
      createdAt: input.createdAt,
    },
    decision: {
      id: decisionId,
      decisionKey,
      donorProductId: input.donor.id,
      canonicalVariantId: variantKey.canonicalVariantId,
      decisionStatus: "exact_confirmed",
      matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
      matcherImplementationSha256:
        CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      matcherReleaseSha256:
        CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      evidenceHash,
      evidenceJson,
      decidedAt: input.createdAt,
      runId: input.planId,
      approvalId: input.sources.standingPolicy.policyId,
      createdAt: input.createdAt,
    },
    donorTransition: {
      donorProductId: input.donor.id,
      sourceIdentityStatus: input.donor.identityStatus,
      sourceIdentityKey: input.donor.identityKey,
      sourceIdentityFieldsSha256,
      exactProjection: {
        identityKey: input.donor.identityKey,
        brand: String(input.target.targetIdentity.brand),
        productLine: nullableText(input.target.targetIdentity.productLine),
        flavor: nullableText(input.target.targetIdentity.flavor),
        containerType: nullableText(input.target.targetIdentity.form),
        size: String(input.target.targetIdentity.size),
        identityStatus: "exact_confirmed",
        identityMatcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
        identityMatcherImplementationSha256:
          CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
        identityMatcherReleaseSha256:
          CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
        identityEvidenceJson: evidenceJson,
        identityConfirmedAt: input.createdAt,
      },
    },
    content: {
      id: `pco:${observationKey}`,
      observationKey,
      donorProductId: input.donor.id,
      canonicalVariantId: variantKey.canonicalVariantId,
      variantDecisionId: decisionId,
      sourceUrl: String(input.offer.productUrl),
      sourceApi: "component-resolution-materialized",
      contentHash,
      fieldHashesJson: fieldHashes(contentPayload),
      contentJson,
      observedAt: input.donor.updatedAt,
      runId: input.planId,
      approvalId: input.sources.standingPolicy.policyId,
      meteredReceiptId: null,
      createdAt: input.createdAt,
    },
  };
}

export function compileProductTruthComponentResolutionMaterializationPlan(
  input: {
    sources: ProductTruthComponentResolutionMaterializationSources;
    createdAt: string;
    expiresAt: string;
  },
): ProductTruthComponentResolutionMaterializationPlan {
  validateSources(input.sources);
  const createdAt = exactInstant(input.createdAt, "createdAt");
  const expiresAt = exactInstant(input.expiresAt, "expiresAt");
  if (
    Date.parse(expiresAt) <= Date.parse(createdAt)
    || Date.parse(createdAt) < Date.parse(input.sources.standingPolicy.issuedAt)
    || (
      input.sources.standingPolicy.expiresAt !== null
      && Date.parse(expiresAt)
        > Date.parse(input.sources.standingPolicy.expiresAt)
    )
  ) {
    fail(
      "COMPONENT_RESOLUTION_PLAN_WINDOW_INVALID",
      "plan timestamps are outside standing authority",
    );
  }
  const donorById = uniqueMap(
    input.sources.bridgeSnapshot.donors,
    (donor) => donor.id,
    "donor",
  );
  const offerById = uniqueMap(
    input.sources.bridgeSnapshot.offers,
    (offer) => offer.id,
    "offer",
  );
  const selectedTargets = input.sources.componentScope.targets.filter(
    (target) =>
      target.acquisitionLane === "EXISTING_CATALOG_EXACT_CANDIDATE",
  );
  if (!selectedTargets.length) {
    fail(
      "COMPONENT_RESOLUTION_PLAN_EMPTY",
      "no collision-free existing-catalog targets",
    );
  }
  const donorIds = selectedTargets.map(
    (target) => target.exactCatalogCandidates[0]?.donorProductId ?? "",
  );
  if (
    selectedTargets.some(
      (target) =>
        target.exactCatalogCandidates.length !== 1
        || target.identityQuality.status !== "ACQUISITION_READY",
    )
    || new Set(donorIds).size !== donorIds.length
  ) {
    fail(
      "COMPONENT_RESOLUTION_TARGET_SET_NOT_COLLISION_FREE",
      "target lane or donor uniqueness changed",
    );
  }
  const planId = `ptcr-free-${productTruthOperationalSha256({
    componentScopeSha256: input.sources.componentScopeSha256,
    standingPolicySha256: input.sources.standingPolicySha256,
    createdAt,
  }).slice(0, 24)}`;
  const targets = selectedTargets.map((target, ordinal) => {
    const donorProductId =
      target.exactCatalogCandidates[0]!.donorProductId;
    const donor = donorById.get(donorProductId);
    if (!donor || donor.identityStatus === "exact_confirmed") {
      fail(
        "COMPONENT_RESOLUTION_DONOR_SOURCE_STATE_INVALID",
        donorProductId,
      );
    }
    return compileTarget({
      target,
      donor,
      offer: selectedOffer({ target, offerById }),
      sources: input.sources,
      planId,
      createdAt,
      ordinal,
    });
  });
  const maximumRows = targets.length * 4;
  if (
    maximumRows > input.sources.standingPolicy.maximumDatabaseRowsPerWave
  ) {
    fail(
      "COMPONENT_RESOLUTION_STANDING_LIMIT_EXCEEDED",
      `${maximumRows} > ${
        input.sources.standingPolicy.maximumDatabaseRowsPerWave
      }`,
    );
  }
  return {
    schemaVersion: PRODUCT_TRUTH_COMPONENT_RESOLUTION_PLAN_VERSION,
    planId,
    createdAt,
    expiresAt,
    databaseTargetFingerprint:
      input.sources.bridgeSnapshot.targetFingerprint,
    source: {
      componentAcquisitionScope: {
        schemaVersion: input.sources.componentScope.schemaVersion,
        sha256: input.sources.componentScopeSha256,
      },
      bridgeSnapshot: {
        schemaVersion: input.sources.bridgeSnapshot.schemaVersion,
        sha256: input.sources.bridgeSnapshotSha256,
      },
      standingPolicy: {
        schemaVersion: input.sources.standingPolicy.schemaVersion,
        sha256: input.sources.standingPolicySha256,
        policyId: input.sources.standingPolicy.policyId,
      },
      matcher: {
        version: CANONICAL_PRODUCT_MATCHER_VERSION,
        implementationSha256:
          CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
        releaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      },
      contentIdentityPolicyVersion:
        EXACT_CONTENT_IDENTITY_POLICY_VERSION,
    },
    targetsSha256: productTruthOperationalSha256(targets),
    targets,
    databaseWrites: {
      maximumRows,
      canonicalProductVariants: targets.length,
      donorVariantDecisions: targets.length,
      donorIdentityTransitions: targets.length,
      productContentObservations: targets.length,
      listingRecipes: 0,
      skuCosts: 0,
    },
    claims: {
      noPaidExistingCatalogLaneOnly: true,
      allTargetsCollisionFree: true,
      exactContentPackagePolicyEnforced: true,
      createsAdditionalCatalog: false,
      listingRecipesRequireAllComponents: true,
      listingRecipesMaterialized: 0,
      skuCostsMaterialized: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      marketplaceMutations: 0,
      procurementMutations: 0,
      consumerActivation: false,
    },
  };
}

export function renderProductTruthComponentResolutionMaterializationPlan(
  value: ProductTruthComponentResolutionMaterializationPlan,
): string {
  return canonicalJson(value);
}

export function renderProductTruthComponentResolutionPreflightReport(
  value: ProductTruthComponentResolutionPreflightReport,
): string {
  return canonicalJson(value);
}

export function renderProductTruthComponentResolutionApplyReport(
  value: ProductTruthComponentResolutionApplyReport,
): string {
  return canonicalJson(value);
}

function scalar(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

function rowObject(row: Row): JsonRecord {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, scalar(value)]),
  );
}

function assertEquivalent(input: {
  actual: JsonRecord;
  expected: JsonRecord;
  ignored?: ReadonlySet<string>;
  code: string;
  label: string;
}): void {
  const ignored = input.ignored ?? new Set<string>();
  const mismatches = Object.entries(input.expected)
    .filter(([key, value]) =>
      !ignored.has(key)
      && !Object.is(input.actual[key] ?? null, scalar(value)))
    .map(([key]) => key);
  if (mismatches.length) {
    fail(
      input.code,
      `${input.label} drifted: ${mismatches.join(",")}`,
    );
  }
}

async function exactOrAbsent(input: {
  db: SqlReader;
  table: string;
  primaryKey: string;
  expected: JsonRecord;
  ignored?: ReadonlySet<string>;
  collisionCode: string;
}): Promise<RowState> {
  const keyValue = input.expected[input.primaryKey];
  const rows = (await input.db.execute({
    sql: `SELECT * FROM "${input.table}" WHERE "${input.primaryKey}"=?`,
    args: [keyValue as never],
  })).rows;
  if (!rows.length) return "ABSENT";
  if (rows.length !== 1) {
    fail(
      input.collisionCode,
      `${input.table}.${input.primaryKey}=${String(keyValue)}`,
    );
  }
  assertEquivalent({
    actual: rowObject(rows[0]!),
    expected: input.expected,
    ignored: input.ignored,
    code: input.collisionCode,
    label: `${input.table}.${input.primaryKey}=${String(keyValue)}`,
  });
  return "EXACT";
}

function sourceDonorExpected(
  donor: ProductTruthLegacyBridgeDonorRow,
): JsonRecord {
  return {
    id: donor.id,
    brand: donor.brand,
    productLine: donor.productLine,
    flavor: donor.flavor,
    containerType: donor.containerType,
    size: donor.size,
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
    identityKey: donor.identityKey,
    identityStatus: donor.identityStatus,
    updatedAt: donor.updatedAt,
  };
}

function exactDonorExpected(
  target: ProductTruthComponentResolutionMaterializationTarget,
  donor: ProductTruthLegacyBridgeDonorRow,
): JsonRecord {
  return {
    ...sourceDonorExpected(donor),
    ...target.donorTransition.exactProjection,
  };
}

function sourceOfferExpected(
  offer: ProductTruthLegacyBridgeOfferRow,
): JsonRecord {
  return {
    id: offer.id,
    donorProductId: offer.donorProductId,
    retailer: offer.retailer,
    retailerProductId: offer.retailerProductId,
    via: offer.via,
    price: offer.price,
    packSizeSeen: offer.packSizeSeen,
    pricePerUnit: offer.pricePerUnit,
    currency: offer.currency,
    zip: offer.zip,
    localityEvidence: offer.localityEvidence,
    inStock: offer.inStock === null ? null : Number(offer.inStock),
    productUrl: offer.productUrl,
    isFirstParty: Number(offer.isFirstParty),
    sourceApi: offer.sourceApi,
    fetchedAt: offer.fetchedAt,
  };
}

type TargetState =
  ProductTruthComponentResolutionPreflightReport["targetStates"][number];

async function targetState(input: {
  db: SqlReader;
  target: ProductTruthComponentResolutionMaterializationTarget;
  donor: ProductTruthLegacyBridgeDonorRow;
  offer: ProductTruthLegacyBridgeOfferRow;
}): Promise<TargetState> {
  const variant = await exactOrAbsent({
    db: input.db,
    table: "CanonicalProductVariant",
    primaryKey: "id",
    expected: input.target.variant as unknown as JsonRecord,
    ignored: VARIANT_IGNORED_COLUMNS,
    collisionCode: "COMPONENT_RESOLUTION_VARIANT_COLLISION",
  });
  const decision = await exactOrAbsent({
    db: input.db,
    table: "DonorProductVariantDecision",
    primaryKey: "id",
    expected: input.target.decision as unknown as JsonRecord,
    collisionCode: "COMPONENT_RESOLUTION_DECISION_COLLISION",
  });
  const content = await exactOrAbsent({
    db: input.db,
    table: "ProductContentObservation",
    primaryKey: "id",
    expected: input.target.content as unknown as JsonRecord,
    collisionCode: "COMPONENT_RESOLUTION_CONTENT_COLLISION",
  });
  const donorRows = (await input.db.execute({
    sql: `SELECT * FROM "DonorProduct" WHERE "id"=?`,
    args: [input.target.donorProductId],
  })).rows;
  if (donorRows.length !== 1) {
    fail(
      "COMPONENT_RESOLUTION_DONOR_SOURCE_DRIFT",
      input.target.donorProductId,
    );
  }
  const donorRow = rowObject(donorRows[0]!);
  let donorIdentity: TargetState["donorIdentity"];
  try {
    assertEquivalent({
      actual: donorRow,
      expected: exactDonorExpected(input.target, input.donor),
      code: "COMPONENT_RESOLUTION_DONOR_SOURCE_DRIFT",
      label: input.target.donorProductId,
    });
    donorIdentity = "EXACT";
  } catch (error) {
    if (
      !(error instanceof ProductTruthComponentResolutionMaterializationError)
      || error.code !== "COMPONENT_RESOLUTION_DONOR_SOURCE_DRIFT"
    ) throw error;
    assertEquivalent({
      actual: donorRow,
      expected: sourceDonorExpected(input.donor),
      code: "COMPONENT_RESOLUTION_DONOR_SOURCE_DRIFT",
      label: input.target.donorProductId,
    });
    donorIdentity = "SOURCE";
  }
  const offerRows = (await input.db.execute({
    sql: `SELECT * FROM "DonorOffer" WHERE "id"=?`,
    args: [input.target.selectedOfferId],
  })).rows;
  if (offerRows.length !== 1) {
    fail(
      "COMPONENT_RESOLUTION_OFFER_SOURCE_DRIFT",
      input.target.selectedOfferId,
    );
  }
  assertEquivalent({
    actual: rowObject(offerRows[0]!),
    expected: sourceOfferExpected(input.offer),
    code: "COMPONENT_RESOLUTION_OFFER_SOURCE_DRIFT",
    label: input.target.selectedOfferId,
  });
  const allExact =
    variant === "EXACT"
    && decision === "EXACT"
    && donorIdentity === "EXACT"
    && content === "EXACT";
  const ready =
    (variant === "ABSENT" || variant === "EXACT")
    && decision === "ABSENT"
    && donorIdentity === "SOURCE"
    && content === "ABSENT";
  if (!allExact && !ready) {
    fail(
      "COMPONENT_RESOLUTION_PARTIAL_GRAPH",
      input.target.canonicalVariantId,
    );
  }
  return {
    canonicalVariantId: input.target.canonicalVariantId,
    donorProductId: input.target.donorProductId,
    variant,
    decision,
    donorIdentity,
    content,
  };
}

function validatePlan(input: {
  plan: ProductTruthComponentResolutionMaterializationPlan;
  planJson: string;
  planSha256: string;
  sources: ProductTruthComponentResolutionMaterializationSources;
}): void {
  const expected =
    compileProductTruthComponentResolutionMaterializationPlan({
      sources: input.sources,
      createdAt: input.plan.createdAt,
      expiresAt: input.plan.expiresAt,
    });
  if (
    input.plan.schemaVersion
      !== PRODUCT_TRUTH_COMPONENT_RESOLUTION_PLAN_VERSION
    || renderProductTruthComponentResolutionMaterializationPlan(input.plan)
      !== input.planJson
    || sha256Text(input.planJson)
      !== exactSha(input.planSha256, "planSha256")
    || canonicalJson(expected) !== input.planJson
  ) {
    fail(
      "COMPONENT_RESOLUTION_PLAN_INVALID",
      "plan bytes do not recompile from immutable sources",
    );
  }
}

async function readTargetStates(input: {
  db: SqlReader;
  plan: ProductTruthComponentResolutionMaterializationPlan;
  sources: ProductTruthComponentResolutionMaterializationSources;
}): Promise<TargetState[]> {
  const donorById = uniqueMap(
    input.sources.bridgeSnapshot.donors,
    (donor) => donor.id,
    "donor",
  );
  const offerById = uniqueMap(
    input.sources.bridgeSnapshot.offers,
    (offer) => offer.id,
    "offer",
  );
  const states: TargetState[] = [];
  for (const target of input.plan.targets) {
    const donor = donorById.get(target.donorProductId);
    const offer = offerById.get(target.selectedOfferId);
    if (!donor || !offer) {
      fail(
        "COMPONENT_RESOLUTION_SOURCE_ROW_MISSING",
        target.canonicalVariantId,
      );
    }
    states.push(await targetState({
      db: input.db,
      target,
      donor,
      offer,
    }));
  }
  return states;
}

function reportCounts(
  states: readonly TargetState[],
): ProductTruthComponentResolutionPreflightReport["counts"] {
  const absentRows = states.reduce(
    (sum, state) =>
      sum
      + Number(state.variant === "ABSENT")
      + Number(state.decision === "ABSENT")
      + Number(state.donorIdentity === "SOURCE")
      + Number(state.content === "ABSENT"),
    0,
  );
  return {
    targets: states.length,
    maximumRows: states.length * 4,
    absentRows,
    exactExistingRows: states.length * 4 - absentRows,
    canonicalVariantReuses: states.filter(
      (state) => state.variant === "EXACT",
    ).length,
    donorIdentityTransitionsRequired: states.filter(
      (state) => state.donorIdentity === "SOURCE",
    ).length,
  };
}

export async function preflightProductTruthComponentResolutionMaterialization(
  input: {
    db: Client;
    databaseTargetFingerprint: string;
    plan: ProductTruthComponentResolutionMaterializationPlan;
    planJson: string;
    planSha256: string;
    sources: ProductTruthComponentResolutionMaterializationSources;
    checkedAt: string;
  },
): Promise<ProductTruthComponentResolutionPreflightReport> {
  validatePlan(input);
  const checkedAt = exactInstant(input.checkedAt, "checkedAt");
  if (
    input.databaseTargetFingerprint
      !== input.plan.databaseTargetFingerprint
    || Date.parse(checkedAt) < Date.parse(input.plan.createdAt)
    || Date.parse(checkedAt) > Date.parse(input.plan.expiresAt)
    || Date.parse(checkedAt) > Date.now()
  ) {
    fail(
      "COMPONENT_RESOLUTION_PREFLIGHT_INPUT_INVALID",
      "database fingerprint or clock differs from plan",
    );
  }
  await assertProductTruthEvidenceSchema(input.db);
  await assertProductTruthListingScopeSchema(input.db);
  const tx = await input.db.transaction("read");
  try {
    const targetStates = await readTargetStates({
      db: tx,
      plan: input.plan,
      sources: input.sources,
    });
    const counts = reportCounts(targetStates);
    const status = counts.absentRows === 0
      ? "ALREADY_APPLIED"
      : "READY_TO_APPLY";
    if (
      counts.maximumRows !== input.plan.databaseWrites.maximumRows
      || (
        status === "READY_TO_APPLY"
        && counts.donorIdentityTransitionsRequired !== targetStates.length
      )
    ) {
      fail(
        "COMPONENT_RESOLUTION_PREFLIGHT_STATE_INVALID",
        status,
      );
    }
    return {
      schemaVersion: PRODUCT_TRUTH_COMPONENT_RESOLUTION_PREFLIGHT_VERSION,
      status,
      planId: input.plan.planId,
      planSha256: input.planSha256,
      checkedAt,
      databaseTargetFingerprint: input.databaseTargetFingerprint,
      standingPolicyId: input.sources.standingPolicy.policyId,
      standingPolicySha256: input.sources.standingPolicySha256,
      counts,
      targetStates,
      claims: input.plan.claims,
    };
  } finally {
    tx.close();
  }
}

async function insertRow(
  tx: Transaction,
  table: string,
  row: JsonRecord,
): Promise<void> {
  const columns = Object.keys(row);
  const statement: InStatement = {
    sql: `INSERT INTO "${table}" (${
      columns.map((column) => `"${column}"`).join(",")
    }) VALUES (${columns.map(() => "?").join(",")})`,
    args: columns.map((column) => row[column] as never),
  };
  await tx.execute(statement);
}

async function foreignKeyViolations(
  db: SqlReader,
): Promise<string[]> {
  const rows = (await db.execute("PRAGMA foreign_key_check")).rows;
  return rows.map((row) => canonicalJson(rowObject(row)));
}

function validatePreflight(input: {
  report: ProductTruthComponentResolutionPreflightReport;
  reportJson: string;
  reportSha256: string;
  plan: ProductTruthComponentResolutionMaterializationPlan;
  planSha256: string;
  sources: ProductTruthComponentResolutionMaterializationSources;
  startedAt: string;
}): void {
  const expectedJson =
    renderProductTruthComponentResolutionPreflightReport(input.report);
  if (
    input.report.schemaVersion
      !== PRODUCT_TRUTH_COMPONENT_RESOLUTION_PREFLIGHT_VERSION
    || expectedJson !== input.reportJson
    || sha256Text(input.reportJson)
      !== exactSha(input.reportSha256, "preflightReportSha256")
    || input.report.planId !== input.plan.planId
    || input.report.planSha256 !== input.planSha256
    || input.report.databaseTargetFingerprint
      !== input.plan.databaseTargetFingerprint
    || input.report.standingPolicyId
      !== input.sources.standingPolicy.policyId
    || input.report.standingPolicySha256
      !== input.sources.standingPolicySha256
    || Date.parse(input.startedAt) < Date.parse(input.report.checkedAt)
    || Date.parse(input.startedAt) - Date.parse(input.report.checkedAt)
      > input.sources.standingPolicy.maximumPreflightAgeMs
    || !["READY_TO_APPLY", "ALREADY_APPLIED"].includes(
      input.report.status,
    )
  ) {
    fail(
      "COMPONENT_RESOLUTION_PREFLIGHT_INVALID",
      "fresh plan-bound preflight is required",
    );
  }
}

export async function applyProductTruthComponentResolutionMaterialization(
  input: {
    db: Client;
    databaseTargetFingerprint: string;
    plan: ProductTruthComponentResolutionMaterializationPlan;
    planJson: string;
    planSha256: string;
    sources: ProductTruthComponentResolutionMaterializationSources;
    preflightReport: ProductTruthComponentResolutionPreflightReport;
    preflightReportJson: string;
    preflightReportSha256: string;
    startedAt: string;
  },
): Promise<ProductTruthComponentResolutionApplyReport> {
  validatePlan(input);
  const startedAt = exactInstant(input.startedAt, "startedAt");
  if (
    input.databaseTargetFingerprint
      !== input.plan.databaseTargetFingerprint
    || Date.parse(startedAt) < Date.parse(input.plan.createdAt)
    || Date.parse(startedAt) > Date.parse(input.plan.expiresAt)
    || Date.parse(startedAt) > Date.now()
  ) {
    fail(
      "COMPONENT_RESOLUTION_APPLY_INPUT_INVALID",
      "database fingerprint or clock differs from plan",
    );
  }
  validatePreflight({
    report: input.preflightReport,
    reportJson: input.preflightReportJson,
    reportSha256: input.preflightReportSha256,
    plan: input.plan,
    planSha256: input.planSha256,
    sources: input.sources,
    startedAt,
  });
  await assertProductTruthEvidenceSchema(input.db);
  await assertProductTruthListingScopeSchema(input.db);
  const tx = await input.db.transaction("write");
  let insertedRows = 0;
  let exactExistingRows = 0;
  let canonicalVariantReuses = 0;
  let donorIdentityTransitions = 0;
  try {
    const states = await readTargetStates({
      db: tx,
      plan: input.plan,
      sources: input.sources,
    });
    if (
      canonicalJson(states)
        !== canonicalJson(input.preflightReport.targetStates)
    ) {
      fail(
        "COMPONENT_RESOLUTION_TRANSACTION_PREFLIGHT_DRIFT",
        "database changed after preflight",
      );
    }
    for (const [index, target] of input.plan.targets.entries()) {
      const state = states[index]!;
      if (
        state.variant === "EXACT"
        && state.decision === "EXACT"
        && state.donorIdentity === "EXACT"
        && state.content === "EXACT"
      ) {
        exactExistingRows += 4;
        canonicalVariantReuses += 1;
        continue;
      }
      if (state.variant === "EXACT") {
        canonicalVariantReuses += 1;
        exactExistingRows += 1;
      } else {
        await insertRow(
          tx,
          "CanonicalProductVariant",
          target.variant as unknown as JsonRecord,
        );
        insertedRows += 1;
      }
      await insertRow(
        tx,
        "DonorProductVariantDecision",
        target.decision as unknown as JsonRecord,
      );
      insertedRows += 1;
      const projection = target.donorTransition.exactProjection;
      const transition = await tx.execute({
        sql: `UPDATE "DonorProduct" SET
          "identityKey"=?,"brand"=?,"productLine"=?,"flavor"=?,
          "containerType"=?,"size"=?,"identityStatus"=?,
          "identityMatcherVersion"=?,
          "identityMatcherImplementationSha256"=?,
          "identityMatcherReleaseSha256"=?,
          "identityEvidenceJson"=?,"identityConfirmedAt"=?
          WHERE "id"=? AND "identityKey"=? AND "identityStatus"=?`,
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
          target.donorTransition.donorProductId,
          target.donorTransition.sourceIdentityKey,
          target.donorTransition.sourceIdentityStatus,
        ],
      });
      if (transition.rowsAffected !== 1) {
        fail(
          "COMPONENT_RESOLUTION_DONOR_TRANSITION_FAILED",
          target.donorProductId,
        );
      }
      insertedRows += 1;
      donorIdentityTransitions += 1;
      await insertRow(
        tx,
        "ProductContentObservation",
        target.content as unknown as JsonRecord,
      );
      insertedRows += 1;
    }
    const violations = await foreignKeyViolations(tx);
    if (violations.length) {
      fail(
        "COMPONENT_RESOLUTION_FOREIGN_KEY_VIOLATION",
        violations.join(";"),
      );
    }
    const finalStates = await readTargetStates({
      db: tx,
      plan: input.plan,
      sources: input.sources,
    });
    if (
      finalStates.some(
        (state) =>
          state.variant !== "EXACT"
          || state.decision !== "EXACT"
          || state.donorIdentity !== "EXACT"
          || state.content !== "EXACT",
      )
    ) {
      fail(
        "COMPONENT_RESOLUTION_TRANSACTION_POSTCONDITION_FAILED",
        "one or more target graphs remain incomplete",
      );
    }
    await tx.commit();
  } catch (error) {
    try {
      await tx.rollback();
    } catch {
      // Preserve the authoritative apply failure.
    }
    throw error;
  }
  const post = await input.db.transaction("read");
  let exactTargets = 0;
  try {
    const finalStates = await readTargetStates({
      db: post,
      plan: input.plan,
      sources: input.sources,
    });
    exactTargets = finalStates.filter(
      (state) =>
        state.variant === "EXACT"
        && state.decision === "EXACT"
        && state.donorIdentity === "EXACT"
        && state.content === "EXACT",
    ).length;
    if (exactTargets !== input.plan.targets.length) {
      fail(
        "COMPONENT_RESOLUTION_POST_VERIFY_FAILED",
        `${exactTargets}/${input.plan.targets.length}`,
      );
    }
  } finally {
    post.close();
  }
  return {
    schemaVersion: PRODUCT_TRUTH_COMPONENT_RESOLUTION_APPLY_REPORT_VERSION,
    status: insertedRows > 0 ? "APPLIED" : "ALREADY_APPLIED",
    planId: input.plan.planId,
    planSha256: input.planSha256,
    preflightReportSha256: input.preflightReportSha256,
    databaseTargetFingerprint: input.databaseTargetFingerprint,
    standingPolicyId: input.sources.standingPolicy.policyId,
    standingPolicySha256: input.sources.standingPolicySha256,
    startedAt,
    completedAt: new Date().toISOString(),
    counts: {
      targets: input.plan.targets.length,
      insertedRows,
      exactExistingRows,
      canonicalVariantReuses,
      donorIdentityTransitions,
    },
    verification: {
      exactTargets,
      foreignKeyViolations: [],
      listingRecipesMaterialized: 0,
      skuCostsMaterialized: 0,
    },
    claims: input.plan.claims,
  };
}
