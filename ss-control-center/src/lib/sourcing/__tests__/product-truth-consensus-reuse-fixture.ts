import { createHash } from "node:crypto";

import {
  buildCanonicalProductVariantKey,
} from "../canonical-product-variant";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION,
  renderProductTruthLegacyBridgeStandingPolicy,
  type ProductTruthLegacyBridgeStandingPolicy,
} from "../product-truth-legacy-bridge-apply";
import {
  PRODUCT_TRUTH_CONSENSUS_REUSE_PREFLIGHT_VERSION,
  buildProductTruthConsensusReuseWaves,
  renderProductTruthConsensusReusePreflight,
  type ProductTruthConsensusReuseDonorPreflightState,
  type ProductTruthConsensusReusePreflightReport,
} from "../product-truth-consensus-reuse-preflight";
import {
  PRODUCT_TRUTH_BLIND_DECISION_VERSION,
  PRODUCT_TRUTH_BLIND_TASK_VERSION,
  PRODUCT_TRUTH_MATCHER_REPLAY_CORPUS_VERSION,
  PRODUCT_TRUTH_POST_BLIND_ACCEPTANCE_VERSION,
  PRODUCT_TRUTH_RECONCILIATION_MAP_VERSION,
  compileProductTruthConsensusReuseScope,
  renderProductTruthConsensusReuseScope,
  type ProductTruthConsensusReuseScope,
} from "../product-truth-consensus-reuse-scope";
import type {
  ProductTruthConsensusReuseMaterializationSources,
} from "../product-truth-consensus-reuse-materialization";
import {
  PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION,
  renderProductTruthRecipeRepairScope,
  type ProductTruthRecipeRepairScope,
  type ProductTruthRecipeRepairScopeEntry,
} from "../product-truth-recipe-repair-scope";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "../product-truth-operational-run-contract";

const GENERATED_AT = "2026-07-29T23:26:31.000Z";
const CAPTURED_AT = "2026-07-29T23:20:00.000Z";
const DATABASE_TARGET_FINGERPRINT = "a".repeat(64);
const MANIFEST_SHA256 = "b".repeat(64);
const SELECTED_SKU = "FIXTURE-SELECTED";
const SELECTED_CASE_ID = `quarantine:${SELECTED_SKU}`;
const DONOR_PRODUCT_ID = "fixture-donor";
const DONOR_TITLE = "Acme Delightful White Bread 20 oz";
const LISTING_TITLE =
  "Acme Delightful White Bread 20 oz Bag (Pack of 2)";

type JsonRecord = Record<string, unknown>;

type Bound<T> = {
  value: T;
  json: string;
  sha256: string;
};

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bound<T>(value: T): Bound<T> {
  const json = renderProductTruthOperationalJson(value);
  return {
    value,
    json,
    sha256: sha256Text(json),
  };
}

function embeddedRowHash(value: JsonRecord): string {
  return sha256Text(JSON.stringify(value));
}

function selectedIdentity(form: string) {
  return {
    brand: "Acme",
    productLine: "Delightful",
    flavor: "White",
    modifiers: [],
    form,
    size: "20 oz",
    outerPackCount: 1,
    title: null,
  };
}

function selectedRecipeEntry(
  rawRowSha256: string,
): ProductTruthRecipeRepairScopeEntry {
  const identity = selectedIdentity("bag");
  const variant = buildCanonicalProductVariantKey(identity);
  return {
    ordinal: 0,
    repairPriority: 1,
    listingKey: `walmart:1:${SELECTED_SKU}`,
    channel: "walmart",
    storeIndex: 1,
    sku: SELECTED_SKU,
    listingId: "fixture-item",
    listingTitle: LISTING_TITLE,
    priorityGmv30d: 100,
    priorityOrders30d: 2,
    priorityUnits30d: 2,
    recipeStatus: "MISSING",
    cogsOutcome: "MISSING",
    repairLane: "RETAILER_IDENTITY_RESEARCH",
    bridgeDisposition: "QUARANTINE",
    bridgeBlockerCodes: ["DONOR_TITLE_MATCH_REJECTED"],
    matcherReasonCodes: ["TITLE_TARGET_TOKEN_MISSING"],
    historicalEvidence: {
      status: "VARIANT_MISMATCH",
      rowSha256: rawRowSha256,
      listingTitle: LISTING_TITLE,
      donorTitle: DONOR_TITLE,
      frontImageUrl: null,
      generatedImageUrl: null,
      quantity: null,
      auditBrand: null,
      auditVariant: null,
      reason: "fixture",
      tileReason: null,
      identityProof: false,
    },
    components: [{
      componentIndex: 0,
      quantity: 2,
      disposition: "QUARANTINE",
      identityProof: "NONE",
      targetIdentity: identity,
      targetCanonicalVariantId: variant.canonicalVariantId,
      legacyComponentId: "fixture-component",
      legacyDonorProductId: DONOR_PRODUCT_ID,
      candidateDonorProductId: DONOR_PRODUCT_ID,
      matcherVerdict: "REJECT",
      matcherReasonCodes: ["TITLE_TARGET_TOKEN_MISSING"],
      blockerCodes: ["DONOR_TITLE_MATCH_REJECTED"],
      candidateDonor: {
        donorProductId: DONOR_PRODUCT_ID,
        title: DONOR_TITLE,
        brand: "Acme",
        productLine: "Delightful",
        flavor: "White",
        size: "20 oz",
        upc: "012345678905",
        gtin: null,
        firstPartyDirectOfferCount: 1,
        firstPartyRetailers: ["walmart"],
      },
    }],
  };
}

function recipeRepairScope(input: {
  rawSourceSha256: string;
  rawRowSha256: string;
}): ProductTruthRecipeRepairScope {
  return {
    schemaVersion: PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION,
    generatedAt: CAPTURED_AT,
    source: {
      manifest: {
        schemaVersion: "phase1-authoritative-scope-manifest/v3",
        sha256: MANIFEST_SHA256,
        asOf: CAPTURED_AT,
        listingCount: 1,
      },
      legacyImageState: {
        sha256: input.rawSourceSha256,
        entryCount: 386,
      },
      bridgeSnapshot: {
        schemaVersion: "product-truth-legacy-bridge-snapshot/1.10.0",
        sha256: "c".repeat(64),
        capturedAt: CAPTURED_AT,
      },
      bridgePlan: {
        schemaVersion: "product-truth-legacy-bridge-plan/1.10.0",
        sha256: "d".repeat(64),
        generatedAt: CAPTURED_AT,
      },
      readiness: {
        schemaVersion: "product-truth-consumer-readiness/1.0.0",
        sha256: "e".repeat(64),
        asOf: CAPTURED_AT,
      },
      targetFingerprint: DATABASE_TARGET_FINGERPRINT,
    },
    counts: {
      denominator: 1,
    },
    entries: [selectedRecipeEntry(input.rawRowSha256)],
  } as unknown as ProductTruthRecipeRepairScope;
}

function selectedTaskEvidence(sourceRowSha256: string): {
  taskCase: JsonRecord;
  donorRow: JsonRecord;
} {
  const donorRow: JsonRecord = {
    id: DONOR_PRODUCT_ID,
    brand: "Acme",
    productLine: "Delightful",
    flavor: "White",
    containerType: "bag",
    size: "20 oz",
    category: "Dry",
    upc: "012345678905",
    title: DONOR_TITLE,
    description: "Fixture exact donor description",
    bullets: "[]",
    attributes: "[]",
    nutritionFacts: "{}",
    ingredients: "Wheat",
    mainImageUrl: "https://example.test/main.jpg",
    imageUrls: "[\"https://example.test/main.jpg\"]",
    identityKey: "fixture-legacy-identity",
    identityStatus: "legacy_unverified",
    updatedAt: CAPTURED_AT,
  };
  const offerRow: JsonRecord = {
    id: "fixture-offer",
    donorProductId: DONOR_PRODUCT_ID,
    retailer: "walmart",
    retailerProductId: "fixture-item",
    via: "direct",
    price: 3.99,
    zip: "33765",
    inStock: 1,
    productUrl: "https://www.walmart.com/ip/fixture-item",
    isFirstParty: 1,
    sourceApi: "fixture",
    fetchedAt: CAPTURED_AT,
  };
  const componentRow: JsonRecord = {
    id: "fixture-component",
    sku: SELECTED_SKU,
    idx: 0,
    product: "Acme Delightful White Bread",
    flavor: "White",
    size: "20 oz",
    qty: 2,
    donorProductId: DONOR_PRODUCT_ID,
  };
  return {
    donorRow,
    taskCase: {
      caseId: SELECTED_CASE_ID,
      cohort: "QUARANTINE",
      sourceKey: SELECTED_SKU,
      sourceRowSha256,
      evidenceItems: [{
        evidenceId: "quarantine-inventory-case",
        payload: {
          exactTitleDonorEvidence: [{
            donorProduct: {
              canonicalRowSha256: embeddedRowHash(donorRow),
              row: donorRow,
            },
            firstPartyOffers: [{
              canonicalRowSha256: embeddedRowHash(offerRow),
              row: offerRow,
            }],
          }],
          recipeEvidence: {
            skuComponents: [{
              skuComponent: {
                canonicalRowSha256: embeddedRowHash(componentRow),
                row: componentRow,
              },
            }],
          },
        },
      }],
    },
  };
}

function unresolvedCase(index: number): {
  sku: string;
  caseId: string;
  rawRow: JsonRecord;
  corpusCase: JsonRecord;
  evidenceCase: JsonRecord;
} {
  const suffix = String(index).padStart(3, "0");
  const sku = `FIXTURE-UNRESOLVED-${suffix}`;
  const caseId = `quarantine:${sku}`;
  const rawRow = {
    sku,
    status: "VARIANT_MISMATCH",
    listing: `Unresolved listing ${suffix}`,
    donorTitle: `Unresolved donor ${suffix}`,
  };
  return {
    sku,
    caseId,
    rawRow,
    corpusCase: {
      caseId,
      sourceKey: sku,
      adjudication: { status: "UNRESOLVED" },
    },
    evidenceCase: { caseId, sourceKey: sku },
  };
}

export function makeConsensusReuseEvidenceFixture() {
  const selectedRawRow: JsonRecord = {
    sku: SELECTED_SKU,
    status: "VARIANT_MISMATCH",
    reason: "fixture",
    listing: LISTING_TITLE,
    donorTitle: DONOR_TITLE,
  };
  const selectedRawRowSha256 =
    productTruthOperationalSha256(selectedRawRow);
  const unresolved = Array.from(
    { length: 385 },
    (_, index) => unresolvedCase(index + 1),
  );
  const rawSource = Object.fromEntries([
    [SELECTED_SKU, selectedRawRow],
    ...unresolved.map((value) => [value.sku, value.rawRow] as const),
  ]);
  const raw = bound(rawSource);
  const repairScopeValue = recipeRepairScope({
    rawSourceSha256: raw.sha256,
    rawRowSha256: selectedRawRowSha256,
  });
  const repairScopeJson = renderProductTruthRecipeRepairScope(
    repairScopeValue,
  );
  const repairScope = {
    value: repairScopeValue,
    json: repairScopeJson,
    sha256: sha256Text(repairScopeJson),
  };

  const consensusIdentity = selectedIdentity("bread");
  const target = {
    components: [{
      componentId: "component-001",
      identity: consensusIdentity,
      quantity: 2,
    }],
  };
  const candidateVerdict = {
    candidateId: "candidate-001",
    expectedSemanticRejectReason: null,
    verdict: "EXACT_IDENTITY",
  };
  const corpusCandidates = [{
    candidateId: "candidate-001",
    expectedSemanticRejectReason: null,
    expectedVerdict: "EXACT_IDENTITY",
    identity: consensusIdentity,
    targetComponentId: "component-001",
  }];
  const taskEvidence = selectedTaskEvidence(selectedRawRowSha256);
  const selectedTaskCase = taskEvidence.taskCase;
  const taskCaseSha256 =
    productTruthOperationalSha256(selectedTaskCase);
  const canonicalDecision = {
    caseId: SELECTED_CASE_ID,
    sourceKey: SELECTED_SKU,
    decisionStatus: "RESOLVED",
    taskCaseSha256,
    target,
    candidates: corpusCandidates.map(
      ({ expectedVerdict, ...candidate }) => ({
        ...candidate,
        verdict: expectedVerdict,
      }),
    ),
    unresolvedReasonCodes: [],
  };
  const reconciliationCase = {
    caseId: SELECTED_CASE_ID,
    sourceKey: SELECTED_SKU,
    canonicalDecision,
  };
  const reconciliationCaseSha256 =
    productTruthOperationalSha256(reconciliationCase);
  const frozenSelected = {
    caseId: SELECTED_CASE_ID,
    sourceKey: SELECTED_SKU,
    taskCaseSha256,
  };
  const acceptanceSelected = {
    caseId: SELECTED_CASE_ID,
    sourceKey: SELECTED_SKU,
    blindTaskCaseSha256: taskCaseSha256,
    reconciliationCaseSha256,
    consensusStructureAccepted: true,
    decisionStatus: "RESOLVED",
    candidateVerdicts: [candidateVerdict],
    unresolvedReasonCodes: [],
  };
  const extraEvidenceCases = [
    { caseId: "golden:fixture-1", sourceKey: "golden-1" },
    { caseId: "golden:fixture-2", sourceKey: "golden-2" },
  ];
  const task = bound({
    schemaVersion: PRODUCT_TRUTH_BLIND_TASK_VERSION,
    sourceArtifactSha256: raw.sha256,
    cases: [
      selectedTaskCase,
      ...unresolved.map((value) => value.evidenceCase),
      ...extraEvidenceCases,
    ],
  });
  const frozenA = bound({
    schemaVersion: PRODUCT_TRUTH_BLIND_DECISION_VERSION,
    reviewerId: "codex-review-a",
    decisions: [
      frozenSelected,
      ...unresolved.map((value) => value.evidenceCase),
      ...extraEvidenceCases,
    ],
  });
  const frozenB = bound({
    schemaVersion: PRODUCT_TRUTH_BLIND_DECISION_VERSION,
    reviewerId: "codex-review-b",
    decisions: [
      frozenSelected,
      ...unresolved.map((value) => value.evidenceCase),
      ...extraEvidenceCases,
    ],
  });
  const reconciliation = bound({
    schemaVersion: PRODUCT_TRUTH_RECONCILIATION_MAP_VERSION,
    immutableBindings: {
      task: { artifactSha256: task.sha256 },
      reviewA: { artifactSha256: frozenA.sha256 },
      reviewB: { artifactSha256: frozenB.sha256 },
    },
    cases: [
      reconciliationCase,
      ...unresolved.map((value) => value.evidenceCase),
      ...extraEvidenceCases,
    ],
  });
  const acceptanceA = bound({
    schemaVersion: PRODUCT_TRUTH_POST_BLIND_ACCEPTANCE_VERSION,
    reviewerId: "codex-review-a",
    sourceArtifactSha256: raw.sha256,
    blindTaskArtifactSha256: task.sha256,
    frozenBlindDecisionArtifactSha256: frozenA.sha256,
    reconciliationMapArtifactSha256: reconciliation.sha256,
    decisions: [
      acceptanceSelected,
      ...unresolved.map((value) => value.evidenceCase),
      ...extraEvidenceCases,
    ],
  });
  const acceptanceB = bound({
    schemaVersion: PRODUCT_TRUTH_POST_BLIND_ACCEPTANCE_VERSION,
    reviewerId: "codex-review-b",
    sourceArtifactSha256: raw.sha256,
    blindTaskArtifactSha256: task.sha256,
    frozenBlindDecisionArtifactSha256: frozenB.sha256,
    reconciliationMapArtifactSha256: reconciliation.sha256,
    decisions: [
      acceptanceSelected,
      ...unresolved.map((value) => value.evidenceCase),
      ...extraEvidenceCases,
    ],
  });
  const corpus = bound({
    schemaVersion: PRODUCT_TRUTH_MATCHER_REPLAY_CORPUS_VERSION,
    corpusId: "fixture-corpus",
    source: {
      artifactSha256: raw.sha256,
      declaredQuarantineSourceCount: 386,
    },
    consensusProvenance: {
      blindTaskArtifactSha256: task.sha256,
      reconciliationMapArtifactSha256: reconciliation.sha256,
      frozenBlindArtifacts: [
        {
          reviewerId: "codex-review-a",
          artifactSha256: frozenA.sha256,
        },
        {
          reviewerId: "codex-review-b",
          artifactSha256: frozenB.sha256,
        },
      ],
    },
    quarantineCases: [{
      caseId: SELECTED_CASE_ID,
      sourceKey: SELECTED_SKU,
      sourceRow: selectedRawRow,
      sourceRowSha256: selectedRawRowSha256,
      target,
      candidates: corpusCandidates,
      adjudication: {
        status: "RESOLVED",
        reconciliationCaseSha256,
        finalAcceptances: [
          {
            reviewerId: "codex-review-a",
            consensusMode: "POST_BLIND_RECONCILED_CONSENSUS",
            candidateVerdicts: [candidateVerdict],
            decisionArtifactSha256: acceptanceA.sha256,
          },
          {
            reviewerId: "codex-review-b",
            consensusMode: "POST_BLIND_RECONCILED_CONSENSUS",
            candidateVerdicts: [candidateVerdict],
            decisionArtifactSha256: acceptanceB.sha256,
          },
        ],
      },
    }, ...unresolved.map((value) => value.corpusCase)],
  });
  return {
    generatedAt: GENERATED_AT,
    rawSource: raw.value,
    rawSourceJson: raw.json,
    rawSourceSha256: raw.sha256,
    corpus: corpus.value,
    corpusJson: corpus.json,
    corpusSha256: corpus.sha256,
    acceptanceReviewA: acceptanceA.value,
    acceptanceReviewAJson: acceptanceA.json,
    acceptanceReviewASha256: acceptanceA.sha256,
    acceptanceReviewB: acceptanceB.value,
    acceptanceReviewBJson: acceptanceB.json,
    acceptanceReviewBSha256: acceptanceB.sha256,
    blindTask: task.value,
    blindTaskJson: task.json,
    blindTaskSha256: task.sha256,
    frozenReviewA: frozenA.value,
    frozenReviewAJson: frozenA.json,
    frozenReviewASha256: frozenA.sha256,
    frozenReviewB: frozenB.value,
    frozenReviewBJson: frozenB.json,
    frozenReviewBSha256: frozenB.sha256,
    reconciliationMap: reconciliation.value,
    reconciliationMapJson: reconciliation.json,
    reconciliationMapSha256: reconciliation.sha256,
    recipeRepairScope: repairScope.value,
    recipeRepairScopeJson: repairScope.json,
    recipeRepairScopeSha256: repairScope.sha256,
  };
}

export function makeConsensusReuseScopeFixture(): {
  scope: ProductTruthConsensusReuseScope;
  scopeJson: string;
  scopeSha256: string;
  blindTask: unknown;
  blindTaskJson: string;
  blindTaskSha256: string;
} {
  const evidence = makeConsensusReuseEvidenceFixture();
  const scope = compileProductTruthConsensusReuseScope(evidence);
  const scopeJson = renderProductTruthConsensusReuseScope(scope);
  return {
    scope,
    scopeJson,
    scopeSha256: sha256Text(scopeJson),
    blindTask: evidence.blindTask,
    blindTaskJson: evidence.blindTaskJson,
    blindTaskSha256: evidence.blindTaskSha256,
  };
}

function standingPolicy(): Bound<ProductTruthLegacyBridgeStandingPolicy> {
  const value: ProductTruthLegacyBridgeStandingPolicy = {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION,
    policyId: "fixture-standing-policy",
    approvedBy: "owner",
    issuedAt: "2026-07-29T00:00:00.000Z",
    expiresAt: null,
    databaseTargetFingerprint: DATABASE_TARGET_FINGERPRINT,
    manifestSha256: MANIFEST_SHA256,
    maximumDatabaseRowsPerWave: 100,
    maximumPreflightAgeMs: 3_600_000,
    requiresCollisionFree: true,
    requiresFreshReadyToApplyPreflight: true,
    allowCanonicalMaterialization: true,
    allowProviderCalls: false,
    allowPaidCalls: false,
    allowMarketplaceListingWrites: false,
    allowPriceChanges: false,
    allowInventoryChanges: false,
    allowDelisting: false,
    allowConsumerActivation: false,
    allowProcurement: false,
    revocationRequiresOwnerDecision: true,
    ownerStatement: "Fixture no-paid canonical materialization authority.",
  };
  const json = renderProductTruthLegacyBridgeStandingPolicy(value);
  return { value, json, sha256: sha256Text(json) };
}

export function makeConsensusReuseMaterializationSourcesFixture():
ProductTruthConsensusReuseMaterializationSources {
  const base = makeConsensusReuseScopeFixture();
  const candidate = base.scope.candidates[0]!;
  const sourceIdentity = {
    identityKey: "fixture-legacy-identity",
    identityStatus: "legacy_unverified",
    brand: "Acme",
    productLine: "Delightful",
    flavor: "White",
    containerType: "bag",
    size: "20 oz",
  };
  const donorState: ProductTruthConsensusReuseDonorPreflightState = {
    donorProductId: candidate.donorProductId,
    listingKeys: [candidate.listingKey],
    proposedCanonicalVariantId: candidate.proposedCanonicalVariant.id,
    variantState: "CREATE",
    decisionState: "CREATE",
    existingDecision: null,
    donorTransitionRequired: true,
    sourceIdentity,
    sourceIdentitySha256: productTruthOperationalSha256(sourceIdentity),
    blockers: [],
  };
  const waves = buildProductTruthConsensusReuseWaves({
    candidates: [candidate],
    donorStates: [donorState],
  });
  const preflight: ProductTruthConsensusReusePreflightReport = {
    schemaVersion: PRODUCT_TRUTH_CONSENSUS_REUSE_PREFLIGHT_VERSION,
    status: "READY_TO_PLAN",
    checkedAt: "2026-07-29T23:30:00.000Z",
    databaseTargetFingerprint: DATABASE_TARGET_FINGERPRINT,
    source: {
      consensusReuseScopeSha256: base.scopeSha256,
      consensusReuseScopeGeneratedAt: base.scope.generatedAt,
      targetFingerprint: DATABASE_TARGET_FINGERPRINT,
      manifestSha256: MANIFEST_SHA256,
    },
    counts: {
      selectedCandidates: 1,
      reconciliationCandidatesQuarantined: 0,
      directCandidates: 1,
      directDonors: 1,
      readyListings: 1,
      readyDonors: 1,
      blockedListings: 0,
      blockedDonors: 0,
      canonicalVariantCreates: 1,
      canonicalVariantReuses: 0,
      decisionCreates: 1,
      decisionReuses: 0,
      donorTransitions: 1,
      existingRecipes: 0,
      recommendedWaves: 1,
    },
    blockers: [],
    readyListingKeys: [candidate.listingKey],
    readyDonorProductIds: [candidate.donorProductId],
    readyDonorStates: [donorState],
    waves,
    claims: {
      readOnlyDatabase: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      marketplaceMutations: 0,
      authorizesExecution: false,
      completeDonorGroupsOnly: true,
      maxListingsPerWave: 5,
      maxRowsPerWave: 100,
    },
  };
  const preflightJson =
    renderProductTruthConsensusReusePreflight(preflight);
  const policy = standingPolicy();
  return {
    scope: base.scope,
    scopeJson: base.scopeJson,
    scopeSha256: base.scopeSha256,
    selectionPreflight: preflight,
    selectionPreflightJson: preflightJson,
    selectionPreflightSha256: sha256Text(preflightJson),
    blindTask: base.blindTask,
    blindTaskJson: base.blindTaskJson,
    blindTaskSha256: base.blindTaskSha256,
    standingPolicy: policy.value,
    standingPolicyJson: policy.json,
    standingPolicySha256: policy.sha256,
  };
}

export const CONSENSUS_REUSE_FIXTURE_CONSTANTS = {
  generatedAt: GENERATED_AT,
  databaseTargetFingerprint: DATABASE_TARGET_FINGERPRINT,
  manifestSha256: MANIFEST_SHA256,
  selectedSku: SELECTED_SKU,
  selectedCaseId: SELECTED_CASE_ID,
  donorProductId: DONOR_PRODUCT_ID,
} as const;
