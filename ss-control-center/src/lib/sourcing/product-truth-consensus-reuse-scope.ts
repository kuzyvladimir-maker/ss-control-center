import { createHash } from "node:crypto";

import {
  buildCanonicalProductVariantKey,
  normalizeCanonicalProductVariantIdentity,
  type NormalizedCanonicalProductVariantIdentity,
} from "./canonical-product-variant";
import {
  parseCanonicalSize,
  type CanonicalProductIdentity,
  type NormalizedCanonicalSize,
} from "./canonical-product-match";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION,
  renderProductTruthRecipeRepairScope,
  type ProductTruthRecipeRepairScope,
  type ProductTruthRecipeRepairScopeEntry,
} from "./product-truth-recipe-repair-scope";

export const PRODUCT_TRUTH_CONSENSUS_REUSE_SCOPE_VERSION =
  "product-truth-consensus-reuse-scope/1.0.0" as const;

export const PRODUCT_TRUTH_MATCHER_REPLAY_CORPUS_VERSION =
  "product-truth-matcher-replay-corpus/2.2.0" as const;
export const PRODUCT_TRUTH_POST_BLIND_ACCEPTANCE_VERSION =
  "product-truth-matcher-post-blind-consensus-acceptance/2.2.0" as const;
export const PRODUCT_TRUTH_BLIND_TASK_VERSION =
  "product-truth-matcher-blinded-evidence-task/2.1.0" as const;
export const PRODUCT_TRUTH_BLIND_DECISION_VERSION =
  "product-truth-matcher-blinded-decision/2.1.0" as const;
export const PRODUCT_TRUTH_RECONCILIATION_MAP_VERSION =
  "product-truth-matcher-post-blind-reconciliation-map/1.0.0" as const;

const EXPECTED_RAW_QUARANTINE_COUNT = 386;
const EXPECTED_BLIND_CASE_COUNT = 388;

const FORM_REPRESENTATION_TRANSITIONS = new Set([
  "bagel=>bag",
  "bags tea=>box",
  "bread=>bag",
  "bread=>loaf",
  "breakfast cereal=>box",
  "candy=>bag",
  "canned tomatoes=>can",
  "canned vegetables=>can",
  "cocoa powder=>pouch",
  "cracker=>box",
  "noodles=>bowl",
  "pasta=>box",
  "sauce=>bottle",
  "soda=>bottle",
  "tortilla=>bag",
]);

type JsonRecord = Record<string, unknown>;

export type ProductTruthConsensusReuseLane =
  | "DIRECT_SINGLE_VARIANT"
  | "FIELD_PARTITION_RECONCILIATION_REQUIRED";

export type ProductTruthConsensusReuseExclusionReason =
  | "CURRENT_SCOPE_MISSING"
  | "CURRENT_RECIPE_PRESENT"
  | "CURRENT_COMPONENT_SET_NOT_SINGLE"
  | "CONSENSUS_UNRESOLVED"
  | "CONSENSUS_NOT_SINGLE_EXACT"
  | "IMMUTABLE_REVIEW_CHAIN_INVALID"
  | "SOURCE_ROW_DRIFT"
  | "CURRENT_LISTING_TITLE_DRIFT"
  | "CURRENT_DONOR_TITLE_DRIFT"
  | "CURRENT_QUANTITY_DRIFT"
  | "CURRENT_TARGET_IDENTITY_DRIFT"
  | "FORM_REPRESENTATION_NOT_ALLOWED"
  | "CURRENT_DONOR_SIZE_CONFLICT";

export interface ProductTruthConsensusReuseCandidate {
  ordinal: number;
  lane: ProductTruthConsensusReuseLane;
  listingKey: string;
  channel: "walmart";
  storeIndex: number;
  sku: string;
  listingTitle: string;
  componentIndex: 0;
  quantity: number;
  legacyComponentId: string | null;
  donorProductId: string;
  donorTitle: string;
  donorDeclaredSize: string | null;
  donorFirstPartyRetailers: string[];
  currentTargetCanonicalVariantId: string;
  proposedCanonicalVariant: ReturnType<
    typeof buildCanonicalProductVariantKey
  >["db"];
  currentTargetIdentity: CanonicalProductIdentity;
  consensusTargetIdentity: CanonicalProductIdentity;
  consensusCandidateIdentity: CanonicalProductIdentity;
  representationTransition: {
    consensusSemanticForm: string;
    currentContainerForm: string;
    modifiersPreservedFromConsensus: string[];
  };
  immutableEvidence: {
    caseId: string;
    sourceRowSha256: string;
    taskCaseSha256: string;
    reconciliationCaseSha256: string;
    corpusCaseSha256: string;
    repairScopeEntrySha256: string;
    frozenReviewACaseSha256: string;
    frozenReviewBCaseSha256: string;
    acceptanceReviewACaseSha256: string;
    acceptanceReviewBCaseSha256: string;
    taskDonorProductRowSha256: string;
    taskFirstPartyOfferRowSha256s: string[];
  };
}

export interface ProductTruthConsensusReuseScope {
  schemaVersion: typeof PRODUCT_TRUTH_CONSENSUS_REUSE_SCOPE_VERSION;
  generatedAt: string;
  source: {
    rawSource: {
      sha256: string;
      quarantineCount: number;
    };
    corpus: {
      schemaVersion: typeof PRODUCT_TRUTH_MATCHER_REPLAY_CORPUS_VERSION;
      sha256: string;
      corpusId: string;
    };
    acceptanceReviewA: {
      schemaVersion: typeof PRODUCT_TRUTH_POST_BLIND_ACCEPTANCE_VERSION;
      sha256: string;
      reviewerId: "codex-review-a";
    };
    acceptanceReviewB: {
      schemaVersion: typeof PRODUCT_TRUTH_POST_BLIND_ACCEPTANCE_VERSION;
      sha256: string;
      reviewerId: "codex-review-b";
    };
    blindTask: {
      schemaVersion: typeof PRODUCT_TRUTH_BLIND_TASK_VERSION;
      sha256: string;
    };
    frozenReviewA: {
      schemaVersion: typeof PRODUCT_TRUTH_BLIND_DECISION_VERSION;
      sha256: string;
      reviewerId: "codex-review-a";
    };
    frozenReviewB: {
      schemaVersion: typeof PRODUCT_TRUTH_BLIND_DECISION_VERSION;
      sha256: string;
      reviewerId: "codex-review-b";
    };
    reconciliationMap: {
      schemaVersion: typeof PRODUCT_TRUTH_RECONCILIATION_MAP_VERSION;
      sha256: string;
    };
    recipeRepairScope: {
      schemaVersion: typeof PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION;
      sha256: string;
      denominator: number;
      targetFingerprint: string;
      manifestSha256: string;
    };
    consensusResolution?: {
      schemaVersion:
        "product-truth-consensus-reuse-resolution/1.0.0";
      sha256: string;
      baseScopeSha256: string;
      canonicalBindingSnapshotSha256: string;
    };
  };
  selectionPolicy: {
    sourceStatus: "VARIANT_MISMATCH";
    adjudicationStatus: "RESOLVED";
    requiredVerdict: "EXACT_IDENTITY";
    requiredIndependentAcceptances: 2;
    currentRecipeStatus: "MISSING";
    currentComponentCount: 1;
    identityCore:
      "NORMALIZED_BRAND_PRODUCT_LINE_FLAVOR_SIZE_OUTER_PACK_EQUAL";
    formPolicy: "EXPLICIT_SEMANTIC_TO_CONTAINER_TRANSITION_ALLOWLIST";
    modifierPolicy:
      "PRESERVE_CONSENSUS_MODIFIERS_IN_PROPOSED_CURRENT_VARIANT";
    donorSizePolicy:
      "NULL_ALLOWED_NON_NULL_MUST_EQUAL_NORMALIZED_TARGET_SIZE";
    donorCollisionPolicy:
      | "ONE_DONOR_ONE_VARIANT_OR_EXPLICIT_FIELD_PARTITION_RECONCILIATION"
      | "ONE_DONOR_ONE_VARIANT_RESOLVED_BY_BOUND_REVIEW";
  };
  counts: {
    rawQuarantine: number;
    currentScopeMatches: number;
    currentRecipeMissing: number;
    resolvedSingleExact: number;
    exactCurrentTitlesAndQuantity: number;
    identityCoreCompatible: number;
    selected: number;
    directSingleVariant: number;
    fieldPartitionReconciliationRequired: number;
    selectedDonors: number;
    directDonors: number;
    reconciliationDonors: number;
  };
  exclusionCounts: Array<{
    reason: ProductTruthConsensusReuseExclusionReason;
    count: number;
  }>;
  reconciliationGroups: Array<{
    donorProductId: string;
    donorTitle: string;
    listingKeys: string[];
    proposedCanonicalVariantIds: string[];
    evidenceSha256: string;
  }>;
  resolvedReconciliationGroups?: Array<{
    donorProductId: string;
    listingKeys: string[];
    resolutionKind:
      | "FIELD_PARTITION_CHOSEN_VARIANT"
      | "EXISTING_CANONICAL_BINDING_REUSE";
    canonicalVariantId: string;
    evidenceSha256: string;
  }>;
  candidates: ProductTruthConsensusReuseCandidate[];
  claims: {
    readOnlySources: true;
    databaseWrites: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    marketplaceMutations: 0;
    authorizesExecution: false;
    legacyStatusUsedAsIdentityProof: false;
    postBlindConsensusUsedAsBoundEvidence: true;
    currentVersionDecisionRequired: true;
    oldDecisionIdsReused: false;
    createsAdditionalCatalog: false;
    consensusResolutionBound?: true;
    existingCanonicalBindingOnlyReusedWhenExact?: true;
  };
}

export class ProductTruthConsensusReuseScopeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthConsensusReuseScopeError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthConsensusReuseScopeError(code, message);
}

function recordValue(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("CONSENSUS_REUSE_SOURCE_INVALID", `${label} must be an object`);
  }
  return value as JsonRecord;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    fail("CONSENSUS_REUSE_SOURCE_INVALID", `${label} must be an array`);
  }
  return value;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail("CONSENSUS_REUSE_SOURCE_INVALID", `${label} must be non-empty text`);
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("CONSENSUS_REUSE_SOURCE_INVALID", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function exactInstant(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail("CONSENSUS_REUSE_SOURCE_INVALID", `${label} must be canonical UTC`);
  }
  return value;
}

function bytesSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertBoundBytes(input: {
  label: string;
  json: string;
  sha256: string;
}): string {
  const expected = exactSha256(input.sha256, `${input.label}.sha256`);
  const actual = bytesSha256(input.json);
  if (actual !== expected) {
    fail(
      "CONSENSUS_REUSE_SOURCE_HASH_MISMATCH",
      `${input.label} ${actual} != ${expected}`,
    );
  }
  return actual;
}

function assertSchema(
  value: JsonRecord,
  expected: string,
  label: string,
): void {
  if (value.schemaVersion !== expected) {
    fail(
      "CONSENSUS_REUSE_SOURCE_SCHEMA_MISMATCH",
      `${label} ${String(value.schemaVersion)} != ${expected}`,
    );
  }
}

function keyedBy(
  values: unknown,
  key: string,
  label: string,
): Map<string, JsonRecord> {
  const result = new Map<string, JsonRecord>();
  for (const [index, value] of arrayValue(values, label).entries()) {
    const row = recordValue(value, `${label}[${index}]`);
    const rowKey = textValue(row[key], `${label}[${index}].${key}`);
    if (result.has(rowKey)) {
      fail("CONSENSUS_REUSE_SOURCE_DUPLICATE", `${label}.${key}=${rowKey}`);
    }
    result.set(rowKey, row);
  }
  return result;
}

function normalizedIdentity(
  value: unknown,
  label: string,
): {
  raw: CanonicalProductIdentity;
  normalized: NormalizedCanonicalProductVariantIdentity;
} {
  const row = recordValue(value, label);
  const raw: CanonicalProductIdentity = {
    brand: nullableText(row.brand),
    productLine: nullableText(row.productLine),
    flavor: nullableText(row.flavor),
    modifiers: Array.isArray(row.modifiers)
      ? row.modifiers.map((modifier, index) =>
        textValue(modifier, `${label}.modifiers[${index}]`))
      : nullableText(row.modifiers),
    form: nullableText(row.form),
    size: nullableText(row.size),
    outerPackCount: row.outerPackCount as number | null | undefined,
    title: null,
  };
  try {
    return {
      raw,
      normalized: normalizeCanonicalProductVariantIdentity(raw),
    };
  } catch (error) {
    fail(
      "CONSENSUS_REUSE_IDENTITY_INVALID",
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return renderProductTruthOperationalJson(left)
    === renderProductTruthOperationalJson(right);
}

function sameIdentityCore(
  left: NormalizedCanonicalProductVariantIdentity,
  right: NormalizedCanonicalProductVariantIdentity,
): boolean {
  return left.brand === right.brand
    && left.productLine === right.productLine
    && left.flavor === right.flavor
    && sameJson(left.size, right.size)
    && left.outerPackCount === right.outerPackCount;
}

function sizeEquivalent(
  left: NormalizedCanonicalSize,
  right: NormalizedCanonicalProductVariantIdentity["size"],
): boolean {
  if (
    left.dimension !== right.dimension
    || left.baseUnit !== right.baseUnit
  ) {
    return false;
  }
  const tolerance = Math.max(1e-9, Math.abs(right.baseAmount) * 1e-12);
  return Math.abs(left.baseAmount - right.baseAmount) <= tolerance;
}

function canonicalCaseHash(value: JsonRecord): string {
  return productTruthOperationalSha256(value);
}

function embeddedCanonicalRowHash(value: JsonRecord): string {
  // The frozen blinded-task compiler used JSON.stringify over its deterministic
  // SQL column projection. Preserve that byte contract instead of silently
  // re-canonicalizing the historical row with the newer operational renderer.
  return bytesSha256(JSON.stringify(value));
}

function semanticDecisionShape(
  value: JsonRecord,
  verdictField: "verdict" | "expectedVerdict",
): unknown {
  const target = recordValue(value.target, "decision.target");
  const targetComponents = arrayValue(
    target.components,
    "decision.target.components",
  ).map((component, index) => {
    const row = recordValue(
      component,
      `decision.target.components[${index}]`,
    );
    return {
      componentId: row.componentId,
      identity: row.identity,
      quantity: row.quantity,
    };
  });
  const candidates = arrayValue(
    value.candidates,
    "decision.candidates",
  ).map((candidate, index) => {
    const row = recordValue(candidate, `decision.candidates[${index}]`);
    return {
      candidateId: row.candidateId,
      expectedSemanticRejectReason:
        row.expectedSemanticRejectReason,
      identity: row.identity,
      targetComponentId: row.targetComponentId,
      verdict: row[verdictField],
    };
  });
  return {
    caseId: value.caseId,
    sourceKey: value.sourceKey,
    decisionStatus: value.decisionStatus,
    target: { components: targetComponents },
    candidates,
    unresolvedReasonCodes: value.unresolvedReasonCodes,
  };
}

function acceptanceVerdicts(value: JsonRecord): unknown {
  return {
    caseId: value.caseId,
    sourceKey: value.sourceKey,
    decisionStatus: value.decisionStatus,
    candidateVerdicts: value.candidateVerdicts,
    unresolvedReasonCodes: value.unresolvedReasonCodes,
  };
}

function firstExactCandidate(input: {
  corpusCase: JsonRecord;
  reconciliationCase: JsonRecord;
  frozenA: JsonRecord;
  frozenB: JsonRecord;
  acceptanceA: JsonRecord;
  acceptanceB: JsonRecord;
  taskCaseSha256: string;
  reconciliationCaseSha256: string;
}): {
  targetComponent: JsonRecord;
  candidate: JsonRecord;
} | null {
  const adjudication = recordValue(
    input.corpusCase.adjudication,
    "corpusCase.adjudication",
  );
  if (adjudication.status !== "RESOLVED") return null;

  const target = recordValue(input.corpusCase.target, "corpusCase.target");
  const targetComponents = arrayValue(
    target.components,
    "corpusCase.target.components",
  ).map((value, index) =>
    recordValue(value, `corpusCase.target.components[${index}]`));
  const candidates = arrayValue(
    input.corpusCase.candidates,
    "corpusCase.candidates",
  ).map((value, index) =>
    recordValue(value, `corpusCase.candidates[${index}]`));
  if (
    targetComponents.length !== 1
    || candidates.length !== 1
    || candidates[0]!.expectedVerdict !== "EXACT_IDENTITY"
  ) {
    return null;
  }

  const canonicalDecision = recordValue(
    input.reconciliationCase.canonicalDecision,
    "reconciliationCase.canonicalDecision",
  );
  const corpusDecision = {
    caseId: input.corpusCase.caseId,
    sourceKey: input.corpusCase.sourceKey,
    decisionStatus: "RESOLVED",
    target: input.corpusCase.target,
    candidates: input.corpusCase.candidates,
    unresolvedReasonCodes: [],
  };
  if (
    canonicalDecision.taskCaseSha256 !== input.taskCaseSha256
    || !sameJson(
      semanticDecisionShape(canonicalDecision, "verdict"),
      semanticDecisionShape(corpusDecision, "expectedVerdict"),
    )
  ) {
    fail(
      "CONSENSUS_REUSE_RECONCILIATION_DRIFT",
      textValue(input.corpusCase.caseId, "corpusCase.caseId"),
    );
  }

  for (const [label, frozen] of [
    ["frozenReviewA", input.frozenA],
    ["frozenReviewB", input.frozenB],
  ] as const) {
    if (
      frozen.taskCaseSha256 !== input.taskCaseSha256
      || frozen.caseId !== input.corpusCase.caseId
      || frozen.sourceKey !== input.corpusCase.sourceKey
    ) {
      fail("CONSENSUS_REUSE_BLIND_REVIEW_DRIFT", label);
    }
  }

  const expectedAcceptance = {
    caseId: input.corpusCase.caseId,
    sourceKey: input.corpusCase.sourceKey,
    decisionStatus: "RESOLVED",
    candidateVerdicts: [{
      candidateId: candidates[0]!.candidateId,
      expectedSemanticRejectReason:
        candidates[0]!.expectedSemanticRejectReason,
      verdict: "EXACT_IDENTITY",
    }],
    unresolvedReasonCodes: [],
  };
  for (const [label, acceptance] of [
    ["acceptanceReviewA", input.acceptanceA],
    ["acceptanceReviewB", input.acceptanceB],
  ] as const) {
    if (
      acceptance.blindTaskCaseSha256 !== input.taskCaseSha256
      || acceptance.reconciliationCaseSha256
        !== input.reconciliationCaseSha256
      || acceptance.consensusStructureAccepted !== true
      || !sameJson(acceptanceVerdicts(acceptance), expectedAcceptance)
    ) {
      fail("CONSENSUS_REUSE_ACCEPTANCE_DRIFT", label);
    }
  }

  const finalAcceptances = arrayValue(
    adjudication.finalAcceptances,
    "corpusCase.adjudication.finalAcceptances",
  ).map((value, index) =>
    recordValue(value, `finalAcceptances[${index}]`));
  if (
    finalAcceptances.length !== 2
    || new Set(
      finalAcceptances.map((acceptance) => acceptance.reviewerId),
    ).size !== 2
    || finalAcceptances.some(
      (acceptance) =>
        acceptance.consensusMode !== "POST_BLIND_RECONCILED_CONSENSUS"
        || !sameJson(acceptance.candidateVerdicts, [
          {
            candidateId: candidates[0]!.candidateId,
            expectedSemanticRejectReason:
              candidates[0]!.expectedSemanticRejectReason,
            verdict: "EXACT_IDENTITY",
          },
        ]),
    )
  ) {
    fail(
      "CONSENSUS_REUSE_ACCEPTANCE_COUNT_INVALID",
      textValue(input.corpusCase.caseId, "corpusCase.caseId"),
    );
  }
  return {
    targetComponent: targetComponents[0]!,
    candidate: candidates[0]!,
  };
}

function taskDonorEvidence(input: {
  taskCase: JsonRecord;
  donorProductId: string;
  donorTitle: string;
}): {
  donorRowSha256: string;
  donorSize: string | null;
  firstPartyOfferRowSha256s: string[];
} {
  const evidenceItems = arrayValue(
    input.taskCase.evidenceItems,
    "taskCase.evidenceItems",
  ).map((value, index) =>
    recordValue(value, `taskCase.evidenceItems[${index}]`));
  const inventory = evidenceItems.find(
    (item) => item.evidenceId === "quarantine-inventory-case",
  );
  if (!inventory) {
    fail("CONSENSUS_REUSE_TASK_EVIDENCE_MISSING", "quarantine inventory");
  }
  const payload = recordValue(inventory.payload, "inventory.payload");
  const donors = arrayValue(
    payload.exactTitleDonorEvidence,
    "inventory.payload.exactTitleDonorEvidence",
  ).map((value, index) =>
    recordValue(value, `exactTitleDonorEvidence[${index}]`));
  const matches = donors.filter((donorEvidence) => {
    const product = recordValue(
      donorEvidence.donorProduct,
      "donorEvidence.donorProduct",
    );
    const row = recordValue(product.row, "donorEvidence.donorProduct.row");
    return row.id === input.donorProductId && row.title === input.donorTitle;
  });
  if (matches.length !== 1) {
    fail(
      "CONSENSUS_REUSE_TASK_DONOR_MISMATCH",
      `${input.donorProductId} expected one embedded donor`,
    );
  }
  const match = matches[0]!;
  const product = recordValue(match.donorProduct, "donorEvidence.donorProduct");
  const row = recordValue(product.row, "donorEvidence.donorProduct.row");
  const donorRowSha256 = exactSha256(
    product.canonicalRowSha256,
    "donorProduct.canonicalRowSha256",
  );
  if (embeddedCanonicalRowHash(row) !== donorRowSha256) {
    fail("CONSENSUS_REUSE_TASK_DONOR_HASH_MISMATCH", input.donorProductId);
  }
  const firstPartyOfferRowSha256s = arrayValue(
    match.firstPartyOffers,
    "donorEvidence.firstPartyOffers",
  ).map((value, index) => {
    const offer = recordValue(value, `firstPartyOffers[${index}]`);
    const offerRow = recordValue(offer.row, `firstPartyOffers[${index}].row`);
    const offerSha256 = exactSha256(
      offer.canonicalRowSha256,
      `firstPartyOffers[${index}].canonicalRowSha256`,
    );
    if (
      embeddedCanonicalRowHash(offerRow) !== offerSha256
      || offerRow.donorProductId !== input.donorProductId
      || Number(offerRow.isFirstParty) !== 1
      || offerRow.via !== "direct"
    ) {
      fail("CONSENSUS_REUSE_TASK_OFFER_MISMATCH", input.donorProductId);
    }
    return offerSha256;
  }).sort();
  if (firstPartyOfferRowSha256s.length < 1) {
    fail("CONSENSUS_REUSE_TASK_OFFER_MISSING", input.donorProductId);
  }
  return {
    donorRowSha256,
    donorSize: nullableText(row.size),
    firstPartyOfferRowSha256s,
  };
}

function exclusionHistogram(
  reasons: readonly ProductTruthConsensusReuseExclusionReason[],
): ProductTruthConsensusReuseScope["exclusionCounts"] {
  const counts = new Map<ProductTruthConsensusReuseExclusionReason, number>();
  for (const reason of reasons) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) =>
      right.count - left.count
      || left.reason.localeCompare(right.reason, "en-US"));
}

export function compileProductTruthConsensusReuseScope(input: {
  generatedAt: string;
  rawSource: unknown;
  rawSourceJson: string;
  rawSourceSha256: string;
  corpus: unknown;
  corpusJson: string;
  corpusSha256: string;
  acceptanceReviewA: unknown;
  acceptanceReviewAJson: string;
  acceptanceReviewASha256: string;
  acceptanceReviewB: unknown;
  acceptanceReviewBJson: string;
  acceptanceReviewBSha256: string;
  blindTask: unknown;
  blindTaskJson: string;
  blindTaskSha256: string;
  frozenReviewA: unknown;
  frozenReviewAJson: string;
  frozenReviewASha256: string;
  frozenReviewB: unknown;
  frozenReviewBJson: string;
  frozenReviewBSha256: string;
  reconciliationMap: unknown;
  reconciliationMapJson: string;
  reconciliationMapSha256: string;
  recipeRepairScope: ProductTruthRecipeRepairScope;
  recipeRepairScopeJson: string;
  recipeRepairScopeSha256: string;
}): ProductTruthConsensusReuseScope {
  const generatedAt = exactInstant(input.generatedAt, "generatedAt");
  const sources = {
    raw: assertBoundBytes({
      label: "rawSource",
      json: input.rawSourceJson,
      sha256: input.rawSourceSha256,
    }),
    corpus: assertBoundBytes({
      label: "corpus",
      json: input.corpusJson,
      sha256: input.corpusSha256,
    }),
    acceptanceA: assertBoundBytes({
      label: "acceptanceReviewA",
      json: input.acceptanceReviewAJson,
      sha256: input.acceptanceReviewASha256,
    }),
    acceptanceB: assertBoundBytes({
      label: "acceptanceReviewB",
      json: input.acceptanceReviewBJson,
      sha256: input.acceptanceReviewBSha256,
    }),
    task: assertBoundBytes({
      label: "blindTask",
      json: input.blindTaskJson,
      sha256: input.blindTaskSha256,
    }),
    frozenA: assertBoundBytes({
      label: "frozenReviewA",
      json: input.frozenReviewAJson,
      sha256: input.frozenReviewASha256,
    }),
    frozenB: assertBoundBytes({
      label: "frozenReviewB",
      json: input.frozenReviewBJson,
      sha256: input.frozenReviewBSha256,
    }),
    reconciliation: assertBoundBytes({
      label: "reconciliationMap",
      json: input.reconciliationMapJson,
      sha256: input.reconciliationMapSha256,
    }),
    repair: assertBoundBytes({
      label: "recipeRepairScope",
      json: input.recipeRepairScopeJson,
      sha256: input.recipeRepairScopeSha256,
    }),
  };
  if (
    renderProductTruthRecipeRepairScope(input.recipeRepairScope)
      !== input.recipeRepairScopeJson
  ) {
    fail(
      "CONSENSUS_REUSE_REPAIR_SCOPE_NOT_CANONICAL",
      "recipe repair scope bytes differ from canonical rendering",
    );
  }

  const raw = recordValue(input.rawSource, "rawSource");
  const corpus = recordValue(input.corpus, "corpus");
  const acceptanceA = recordValue(
    input.acceptanceReviewA,
    "acceptanceReviewA",
  );
  const acceptanceB = recordValue(
    input.acceptanceReviewB,
    "acceptanceReviewB",
  );
  const task = recordValue(input.blindTask, "blindTask");
  const frozenA = recordValue(input.frozenReviewA, "frozenReviewA");
  const frozenB = recordValue(input.frozenReviewB, "frozenReviewB");
  const reconciliation = recordValue(
    input.reconciliationMap,
    "reconciliationMap",
  );
  assertSchema(
    corpus,
    PRODUCT_TRUTH_MATCHER_REPLAY_CORPUS_VERSION,
    "corpus",
  );
  assertSchema(
    acceptanceA,
    PRODUCT_TRUTH_POST_BLIND_ACCEPTANCE_VERSION,
    "acceptanceReviewA",
  );
  assertSchema(
    acceptanceB,
    PRODUCT_TRUTH_POST_BLIND_ACCEPTANCE_VERSION,
    "acceptanceReviewB",
  );
  assertSchema(task, PRODUCT_TRUTH_BLIND_TASK_VERSION, "blindTask");
  assertSchema(
    frozenA,
    PRODUCT_TRUTH_BLIND_DECISION_VERSION,
    "frozenReviewA",
  );
  assertSchema(
    frozenB,
    PRODUCT_TRUTH_BLIND_DECISION_VERSION,
    "frozenReviewB",
  );
  assertSchema(
    reconciliation,
    PRODUCT_TRUTH_RECONCILIATION_MAP_VERSION,
    "reconciliationMap",
  );

  const source = recordValue(corpus.source, "corpus.source");
  const consensusProvenance = recordValue(
    corpus.consensusProvenance,
    "corpus.consensusProvenance",
  );
  const frozenArtifacts = keyedBy(
    consensusProvenance.frozenBlindArtifacts,
    "reviewerId",
    "corpus.consensusProvenance.frozenBlindArtifacts",
  );
  const immutableBindings = recordValue(
    reconciliation.immutableBindings,
    "reconciliation.immutableBindings",
  );
  const bindingTask = recordValue(immutableBindings.task, "bindings.task");
  const bindingReviewA = recordValue(
    immutableBindings.reviewA,
    "bindings.reviewA",
  );
  const bindingReviewB = recordValue(
    immutableBindings.reviewB,
    "bindings.reviewB",
  );
  if (
    source.artifactSha256 !== sources.raw
    || task.sourceArtifactSha256 !== sources.raw
    || acceptanceA.sourceArtifactSha256 !== sources.raw
    || acceptanceB.sourceArtifactSha256 !== sources.raw
    || input.recipeRepairScope.source.legacyImageState.sha256 !== sources.raw
    || consensusProvenance.blindTaskArtifactSha256 !== sources.task
    || consensusProvenance.reconciliationMapArtifactSha256
      !== sources.reconciliation
    || bindingTask.artifactSha256 !== sources.task
    || bindingReviewA.artifactSha256 !== sources.frozenA
    || bindingReviewB.artifactSha256 !== sources.frozenB
    || acceptanceA.blindTaskArtifactSha256 !== sources.task
    || acceptanceB.blindTaskArtifactSha256 !== sources.task
    || acceptanceA.frozenBlindDecisionArtifactSha256 !== sources.frozenA
    || acceptanceB.frozenBlindDecisionArtifactSha256 !== sources.frozenB
    || acceptanceA.reconciliationMapArtifactSha256 !== sources.reconciliation
    || acceptanceB.reconciliationMapArtifactSha256 !== sources.reconciliation
    || frozenArtifacts.get("codex-review-a")?.artifactSha256 !== sources.frozenA
    || frozenArtifacts.get("codex-review-b")?.artifactSha256 !== sources.frozenB
  ) {
    fail(
      "CONSENSUS_REUSE_IMMUTABLE_BINDING_MISMATCH",
      "the nine supplied artifacts do not bind one immutable evidence chain",
    );
  }
  if (
    acceptanceA.reviewerId !== "codex-review-a"
    || acceptanceB.reviewerId !== "codex-review-b"
    || frozenA.reviewerId !== "codex-review-a"
    || frozenB.reviewerId !== "codex-review-b"
  ) {
    fail("CONSENSUS_REUSE_REVIEWER_MISMATCH", "reviewer identities drifted");
  }

  const quarantineCases = arrayValue(
    corpus.quarantineCases,
    "corpus.quarantineCases",
  ).map((value, index) =>
    recordValue(value, `corpus.quarantineCases[${index}]`));
  const rawQuarantine = Object.values(raw).filter((value) =>
    recordValue(value, "raw row").status === "VARIANT_MISMATCH").length;
  const taskCases = keyedBy(task.cases, "caseId", "blindTask.cases");
  const frozenACases = keyedBy(
    frozenA.decisions,
    "caseId",
    "frozenReviewA.decisions",
  );
  const frozenBCases = keyedBy(
    frozenB.decisions,
    "caseId",
    "frozenReviewB.decisions",
  );
  const acceptanceACases = keyedBy(
    acceptanceA.decisions,
    "caseId",
    "acceptanceReviewA.decisions",
  );
  const acceptanceBCases = keyedBy(
    acceptanceB.decisions,
    "caseId",
    "acceptanceReviewB.decisions",
  );
  const reconciliationCases = keyedBy(
    reconciliation.cases,
    "caseId",
    "reconciliationMap.cases",
  );
  if (
    quarantineCases.length !== EXPECTED_RAW_QUARANTINE_COUNT
    || rawQuarantine !== EXPECTED_RAW_QUARANTINE_COUNT
    || taskCases.size !== EXPECTED_BLIND_CASE_COUNT
    || frozenACases.size !== EXPECTED_BLIND_CASE_COUNT
    || frozenBCases.size !== EXPECTED_BLIND_CASE_COUNT
    || acceptanceACases.size !== EXPECTED_BLIND_CASE_COUNT
    || acceptanceBCases.size !== EXPECTED_BLIND_CASE_COUNT
    || reconciliationCases.size !== EXPECTED_BLIND_CASE_COUNT
    || source.declaredQuarantineSourceCount !== EXPECTED_RAW_QUARANTINE_COUNT
  ) {
    fail(
      "CONSENSUS_REUSE_DENOMINATOR_MISMATCH",
      "386 quarantine / 388 blinded evidence contract is incomplete",
    );
  }

  const repairBySku = new Map<string, ProductTruthRecipeRepairScopeEntry>();
  for (const entry of input.recipeRepairScope.entries) {
    if (repairBySku.has(entry.sku)) {
      fail(
        "CONSENSUS_REUSE_CURRENT_SCOPE_AMBIGUOUS",
        `duplicate authoritative SKU ${entry.sku}`,
      );
    }
    repairBySku.set(entry.sku, entry);
  }

  const exclusionReasons: ProductTruthConsensusReuseExclusionReason[] = [];
  const provisional: ProductTruthConsensusReuseCandidate[] = [];
  let currentScopeMatches = 0;
  let currentRecipeMissing = 0;
  let resolvedSingleExact = 0;
  let exactCurrentTitlesAndQuantity = 0;
  let identityCoreCompatible = 0;

  for (const corpusCase of quarantineCases) {
    const caseId = textValue(corpusCase.caseId, "corpusCase.caseId");
    const sku = textValue(corpusCase.sourceKey, `${caseId}.sourceKey`);
    const entry = repairBySku.get(sku);
    if (!entry) {
      exclusionReasons.push("CURRENT_SCOPE_MISSING");
      continue;
    }
    currentScopeMatches += 1;
    if (entry.recipeStatus !== "MISSING") {
      exclusionReasons.push("CURRENT_RECIPE_PRESENT");
      continue;
    }
    currentRecipeMissing += 1;
    if (entry.components.length !== 1) {
      exclusionReasons.push("CURRENT_COMPONENT_SET_NOT_SINGLE");
      continue;
    }

    const taskCase = taskCases.get(caseId);
    const frozenCaseA = frozenACases.get(caseId);
    const frozenCaseB = frozenBCases.get(caseId);
    const acceptanceCaseA = acceptanceACases.get(caseId);
    const acceptanceCaseB = acceptanceBCases.get(caseId);
    const reconciliationCase = reconciliationCases.get(caseId);
    if (
      !taskCase
      || !frozenCaseA
      || !frozenCaseB
      || !acceptanceCaseA
      || !acceptanceCaseB
      || !reconciliationCase
    ) {
      exclusionReasons.push("IMMUTABLE_REVIEW_CHAIN_INVALID");
      continue;
    }
    const taskCaseSha256 = canonicalCaseHash(taskCase);
    const reconciliationCaseSha256 = canonicalCaseHash(reconciliationCase);
    let exact: ReturnType<typeof firstExactCandidate>;
    try {
      exact = firstExactCandidate({
        corpusCase,
        reconciliationCase,
        frozenA: frozenCaseA,
        frozenB: frozenCaseB,
        acceptanceA: acceptanceCaseA,
        acceptanceB: acceptanceCaseB,
        taskCaseSha256,
        reconciliationCaseSha256,
      });
    } catch (error) {
      if (error instanceof ProductTruthConsensusReuseScopeError) throw error;
      exclusionReasons.push("IMMUTABLE_REVIEW_CHAIN_INVALID");
      continue;
    }
    if (!exact) {
      const adjudication = recordValue(
        corpusCase.adjudication,
        `${caseId}.adjudication`,
      );
      exclusionReasons.push(
        adjudication.status === "RESOLVED"
          ? "CONSENSUS_NOT_SINGLE_EXACT"
          : "CONSENSUS_UNRESOLVED",
      );
      continue;
    }
    resolvedSingleExact += 1;

    const rawRow = recordValue(raw[sku], `rawSource.${sku}`);
    const sourceRow = recordValue(corpusCase.sourceRow, `${caseId}.sourceRow`);
    const sourceRowSha256 = exactSha256(
      corpusCase.sourceRowSha256,
      `${caseId}.sourceRowSha256`,
    );
    if (
      canonicalCaseHash(rawRow) !== sourceRowSha256
      || !sameJson(rawRow, sourceRow)
      || taskCase.sourceRowSha256 !== sourceRowSha256
      || rawRow.status !== "VARIANT_MISMATCH"
      || rawRow.sku !== sku
    ) {
      exclusionReasons.push("SOURCE_ROW_DRIFT");
      continue;
    }
    const component = entry.components[0]!;
    if (entry.listingTitle !== rawRow.listing) {
      exclusionReasons.push("CURRENT_LISTING_TITLE_DRIFT");
      continue;
    }
    const donorTitle = component.candidateDonor?.title;
    if (
      !component.candidateDonor
      || !component.candidateDonorProductId
      || !donorTitle
      || donorTitle !== rawRow.donorTitle
    ) {
      exclusionReasons.push("CURRENT_DONOR_TITLE_DRIFT");
      continue;
    }
    if (component.quantity !== exact.targetComponent.quantity) {
      exclusionReasons.push("CURRENT_QUANTITY_DRIFT");
      continue;
    }
    exactCurrentTitlesAndQuantity += 1;

    const currentIdentity = normalizedIdentity(
      {
        ...component.targetIdentity,
        modifiers: [],
        title: null,
      },
      `${caseId}.currentTargetIdentity`,
    );
    const consensusTarget = normalizedIdentity(
      exact.targetComponent.identity,
      `${caseId}.consensusTargetIdentity`,
    );
    const consensusCandidate = normalizedIdentity(
      exact.candidate.identity,
      `${caseId}.consensusCandidateIdentity`,
    );
    const rebuiltCurrent = buildCanonicalProductVariantKey(
      currentIdentity.raw,
    );
    if (
      rebuiltCurrent.canonicalVariantId
        !== component.targetCanonicalVariantId
      || !sameIdentityCore(
        currentIdentity.normalized,
        consensusTarget.normalized,
      )
      || !sameIdentityCore(
        consensusTarget.normalized,
        consensusCandidate.normalized,
      )
    ) {
      exclusionReasons.push("CURRENT_TARGET_IDENTITY_DRIFT");
      continue;
    }
    identityCoreCompatible += 1;
    const formTransition =
      `${consensusTarget.normalized.form}=>${currentIdentity.normalized.form}`;
    if (
      consensusTarget.normalized.form !== currentIdentity.normalized.form
      && !FORM_REPRESENTATION_TRANSITIONS.has(formTransition)
    ) {
      exclusionReasons.push("FORM_REPRESENTATION_NOT_ALLOWED");
      continue;
    }

    const taskEvidence = taskDonorEvidence({
      taskCase,
      donorProductId: component.candidateDonorProductId,
      donorTitle,
    });
    if (taskEvidence.donorSize) {
      const parsedDonorSize = parseCanonicalSize(taskEvidence.donorSize);
      if (
        !parsedDonorSize
        || !sizeEquivalent(parsedDonorSize, currentIdentity.normalized.size)
      ) {
        exclusionReasons.push("CURRENT_DONOR_SIZE_CONFLICT");
        continue;
      }
    }

    const proposedIdentity: CanonicalProductIdentity = {
      ...consensusTarget.raw,
      form: currentIdentity.raw.form,
      title: null,
    };
    const proposedVariant = buildCanonicalProductVariantKey(proposedIdentity);
    provisional.push({
      ordinal: 0,
      lane: "DIRECT_SINGLE_VARIANT",
      listingKey: entry.listingKey,
      channel: "walmart",
      storeIndex: entry.storeIndex,
      sku,
      listingTitle: entry.listingTitle,
      componentIndex: 0,
      quantity: component.quantity,
      legacyComponentId: component.legacyComponentId,
      donorProductId: component.candidateDonorProductId,
      donorTitle,
      donorDeclaredSize: taskEvidence.donorSize,
      donorFirstPartyRetailers:
        component.candidateDonor.firstPartyRetailers,
      currentTargetCanonicalVariantId:
        component.targetCanonicalVariantId!,
      proposedCanonicalVariant: proposedVariant.db,
      currentTargetIdentity: currentIdentity.raw,
      consensusTargetIdentity: consensusTarget.raw,
      consensusCandidateIdentity: consensusCandidate.raw,
      representationTransition: {
        consensusSemanticForm: consensusTarget.normalized.form!,
        currentContainerForm: currentIdentity.normalized.form!,
        modifiersPreservedFromConsensus:
          proposedVariant.normalized.modifiers,
      },
      immutableEvidence: {
        caseId,
        sourceRowSha256,
        taskCaseSha256,
        reconciliationCaseSha256,
        corpusCaseSha256: canonicalCaseHash(corpusCase),
        repairScopeEntrySha256:
          productTruthOperationalSha256(entry),
        frozenReviewACaseSha256: canonicalCaseHash(frozenCaseA),
        frozenReviewBCaseSha256: canonicalCaseHash(frozenCaseB),
        acceptanceReviewACaseSha256:
          canonicalCaseHash(acceptanceCaseA),
        acceptanceReviewBCaseSha256:
          canonicalCaseHash(acceptanceCaseB),
        taskDonorProductRowSha256: taskEvidence.donorRowSha256,
        taskFirstPartyOfferRowSha256s:
          taskEvidence.firstPartyOfferRowSha256s,
      },
    });
  }

  const byDonor = Map.groupBy(
    provisional,
    (candidate) => candidate.donorProductId,
  );
  const reconciliationGroups:
    ProductTruthConsensusReuseScope["reconciliationGroups"] = [];
  for (const [donorProductId, candidates] of byDonor) {
    const variantIds = [...new Set(
      candidates.map(
        (candidate) => candidate.proposedCanonicalVariant.id,
      ),
    )].sort();
    if (variantIds.length <= 1) continue;
    candidates.forEach((candidate) => {
      candidate.lane = "FIELD_PARTITION_RECONCILIATION_REQUIRED";
    });
    reconciliationGroups.push({
      donorProductId,
      donorTitle: candidates[0]!.donorTitle,
      listingKeys: candidates
        .map((candidate) => candidate.listingKey)
        .sort(),
      proposedCanonicalVariantIds: variantIds,
      evidenceSha256: productTruthOperationalSha256({
        donorProductId,
        cases: candidates
          .map((candidate) => ({
            listingKey: candidate.listingKey,
            proposedCanonicalVariantId:
              candidate.proposedCanonicalVariant.id,
            immutableEvidence: candidate.immutableEvidence,
          }))
          .sort((left, right) =>
            left.listingKey.localeCompare(right.listingKey, "en-US")),
      }),
    });
  }

  const candidates = provisional
    .sort((left, right) =>
      left.listingKey.localeCompare(right.listingKey, "en-US"))
    .map((candidate, ordinal) => ({ ...candidate, ordinal }));
  const direct = candidates.filter(
    (candidate) => candidate.lane === "DIRECT_SINGLE_VARIANT",
  );
  const reconciliations = candidates.filter(
    (candidate) =>
      candidate.lane === "FIELD_PARTITION_RECONCILIATION_REQUIRED",
  );
  const directDonors = new Set(
    direct.map((candidate) => candidate.donorProductId),
  ).size;
  const reconciliationDonors = reconciliationGroups.length;

  return {
    schemaVersion: PRODUCT_TRUTH_CONSENSUS_REUSE_SCOPE_VERSION,
    generatedAt,
    source: {
      rawSource: {
        sha256: sources.raw,
        quarantineCount: rawQuarantine,
      },
      corpus: {
        schemaVersion: PRODUCT_TRUTH_MATCHER_REPLAY_CORPUS_VERSION,
        sha256: sources.corpus,
        corpusId: textValue(corpus.corpusId, "corpus.corpusId"),
      },
      acceptanceReviewA: {
        schemaVersion: PRODUCT_TRUTH_POST_BLIND_ACCEPTANCE_VERSION,
        sha256: sources.acceptanceA,
        reviewerId: "codex-review-a",
      },
      acceptanceReviewB: {
        schemaVersion: PRODUCT_TRUTH_POST_BLIND_ACCEPTANCE_VERSION,
        sha256: sources.acceptanceB,
        reviewerId: "codex-review-b",
      },
      blindTask: {
        schemaVersion: PRODUCT_TRUTH_BLIND_TASK_VERSION,
        sha256: sources.task,
      },
      frozenReviewA: {
        schemaVersion: PRODUCT_TRUTH_BLIND_DECISION_VERSION,
        sha256: sources.frozenA,
        reviewerId: "codex-review-a",
      },
      frozenReviewB: {
        schemaVersion: PRODUCT_TRUTH_BLIND_DECISION_VERSION,
        sha256: sources.frozenB,
        reviewerId: "codex-review-b",
      },
      reconciliationMap: {
        schemaVersion: PRODUCT_TRUTH_RECONCILIATION_MAP_VERSION,
        sha256: sources.reconciliation,
      },
      recipeRepairScope: {
        schemaVersion: PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION,
        sha256: sources.repair,
        denominator: input.recipeRepairScope.counts.denominator,
        targetFingerprint:
          input.recipeRepairScope.source.targetFingerprint,
        manifestSha256:
          input.recipeRepairScope.source.manifest.sha256,
      },
    },
    selectionPolicy: {
      sourceStatus: "VARIANT_MISMATCH",
      adjudicationStatus: "RESOLVED",
      requiredVerdict: "EXACT_IDENTITY",
      requiredIndependentAcceptances: 2,
      currentRecipeStatus: "MISSING",
      currentComponentCount: 1,
      identityCore:
        "NORMALIZED_BRAND_PRODUCT_LINE_FLAVOR_SIZE_OUTER_PACK_EQUAL",
      formPolicy:
        "EXPLICIT_SEMANTIC_TO_CONTAINER_TRANSITION_ALLOWLIST",
      modifierPolicy:
        "PRESERVE_CONSENSUS_MODIFIERS_IN_PROPOSED_CURRENT_VARIANT",
      donorSizePolicy:
        "NULL_ALLOWED_NON_NULL_MUST_EQUAL_NORMALIZED_TARGET_SIZE",
      donorCollisionPolicy:
        "ONE_DONOR_ONE_VARIANT_OR_EXPLICIT_FIELD_PARTITION_RECONCILIATION",
    },
    counts: {
      rawQuarantine,
      currentScopeMatches,
      currentRecipeMissing,
      resolvedSingleExact,
      exactCurrentTitlesAndQuantity,
      identityCoreCompatible,
      selected: candidates.length,
      directSingleVariant: direct.length,
      fieldPartitionReconciliationRequired: reconciliations.length,
      selectedDonors: byDonor.size,
      directDonors,
      reconciliationDonors,
    },
    exclusionCounts: exclusionHistogram(exclusionReasons),
    reconciliationGroups: reconciliationGroups.sort((left, right) =>
      left.donorProductId.localeCompare(right.donorProductId, "en-US")),
    candidates,
    claims: {
      readOnlySources: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      marketplaceMutations: 0,
      authorizesExecution: false,
      legacyStatusUsedAsIdentityProof: false,
      postBlindConsensusUsedAsBoundEvidence: true,
      currentVersionDecisionRequired: true,
      oldDecisionIdsReused: false,
      createsAdditionalCatalog: false,
    },
  };
}

export function renderProductTruthConsensusReuseScope(
  value: ProductTruthConsensusReuseScope,
): string {
  return renderProductTruthOperationalJson(value);
}
