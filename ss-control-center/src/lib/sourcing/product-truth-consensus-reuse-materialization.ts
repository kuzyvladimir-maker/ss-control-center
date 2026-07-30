import { createHash } from "node:crypto";

import type { Client, Row, Transaction } from "@libsql/client";

import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "./canonical-product-match-provenance";
import {
  PRODUCT_TRUTH_CONSENSUS_REUSE_PREFLIGHT_VERSION,
  renderProductTruthConsensusReusePreflight,
  type ProductTruthConsensusReusePreflightReport,
  type ProductTruthConsensusReusePreflightWave,
} from "./product-truth-consensus-reuse-preflight";
import {
  PRODUCT_TRUTH_BLIND_TASK_VERSION,
  PRODUCT_TRUTH_CONSENSUS_REUSE_SCOPE_VERSION,
  renderProductTruthConsensusReuseScope,
  type ProductTruthConsensusReuseCandidate,
  type ProductTruthConsensusReuseScope,
} from "./product-truth-consensus-reuse-scope";
import {
  checkProductTruthConsensusReuseForeignKeys,
} from "./product-truth-consensus-reuse-foreign-key";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_CONTENT_VERSION,
  PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION,
  renderProductTruthLegacyBridgeStandingPolicy,
  type ProductTruthLegacyBridgeComponentEvidenceRow,
  type ProductTruthLegacyBridgeContentRow,
  type ProductTruthLegacyBridgeCostRow,
  type ProductTruthLegacyBridgeDecisionRow,
  type ProductTruthLegacyBridgeDonorTransition,
  type ProductTruthLegacyBridgeScopeLinkRow,
  type ProductTruthLegacyBridgeStandingPolicy,
  type ProductTruthLegacyBridgeVariantRow,
} from "./product-truth-legacy-bridge-apply";
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
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  assertProductTruthEvidenceSchema,
  assertProductTruthListingScopeSchema,
} from "./product-truth-schema-gate";
import {
  PRICE_EVIDENCE_POLICY_VERSION,
  PRODUCT_TRUTH_PROCUREMENT_ZIP,
} from "./price-evidence-policy";

export const PRODUCT_TRUTH_CONSENSUS_REUSE_PLAN_VERSION =
  "product-truth-consensus-reuse-materialization-plan/1.0.0" as const;
export const PRODUCT_TRUTH_CONSENSUS_REUSE_APPLY_PREFLIGHT_VERSION =
  "product-truth-consensus-reuse-apply-preflight/1.0.0" as const;
export const PRODUCT_TRUTH_CONSENSUS_REUSE_APPLY_REPORT_VERSION =
  "product-truth-consensus-reuse-apply-report/1.0.0" as const;
export const PRODUCT_TRUTH_CONSENSUS_REUSE_DECISION_EVIDENCE_VERSION =
  "product-truth-consensus-reuse-decision-evidence/1.0.0" as const;
export const PRODUCT_TRUTH_CONSENSUS_REUSE_CONTENT_SOURCE_VERSION =
  "product-truth-consensus-reuse-content-source/1.0.0" as const;
export const PRODUCT_TRUTH_CONSENSUS_REUSE_RECIPE_SOURCE_VERSION =
  "product-truth-consensus-reuse-recipe-source/1.0.0" as const;
export const PRODUCT_TRUTH_CONSENSUS_REUSE_METHOD =
  "POST_BLIND_RECONCILED_CONSENSUS_CURRENT_VERSION_REBIND" as const;
export const PRODUCT_TRUTH_CONSENSUS_REUSE_CONTENT_SOURCE_API =
  "consensus-reuse-materialized" as const;

const MAX_PRICE_AGE_MS = 24 * 60 * 60 * 1_000;
const CANONICAL_VARIANT_REUSE_IGNORED_COLUMNS = new Set(["createdAt"]);

type JsonRecord = Record<string, unknown>;
type SqlReader = Pick<Client, "execute"> | Pick<Transaction, "execute">;
type ProductTruthConsensusReuseReadyDonorState =
  ProductTruthConsensusReusePreflightReport["readyDonorStates"][number];

export class ProductTruthConsensusReuseMaterializationError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthConsensusReuseMaterializationError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthConsensusReuseMaterializationError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rowHash(value: unknown): string {
  return productTruthOperationalSha256(value);
}

function canonicalJson(value: unknown): string {
  return renderProductTruthOperationalJson(value);
}

function exactText(value: unknown, label: string, maximum = 2_000): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value !== value.trim()
    || value.length > maximum
  ) {
    fail(
      "CONSENSUS_REUSE_MATERIALIZATION_INPUT_INVALID",
      `${label} must be 1-${maximum} exact characters`,
    );
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function exactSha(value: unknown, label: string): string {
  const text = exactText(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(text)) {
    fail(
      "CONSENSUS_REUSE_MATERIALIZATION_INPUT_INVALID",
      `${label} must be lowercase SHA-256`,
    );
  }
  return text;
}

function canonicalInstant(value: unknown, label: string): string {
  const text = exactText(value, label, 80);
  const timestamp = Date.parse(text);
  if (
    !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString() !== text
  ) {
    fail(
      "CONSENSUS_REUSE_MATERIALIZATION_INPUT_INVALID",
      `${label} must be canonical UTC`,
    );
  }
  return text;
}

function recordValue(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(
      "CONSENSUS_REUSE_MATERIALIZATION_SOURCE_INVALID",
      `${label} must be an object`,
    );
  }
  return value as JsonRecord;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(
      "CONSENSUS_REUSE_MATERIALIZATION_SOURCE_INVALID",
      `${label} must be an array`,
    );
  }
  return value;
}

function parseJson(value: unknown, label: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    fail(
      "CONSENSUS_REUSE_MATERIALIZATION_SOURCE_INVALID",
      `${label} is not valid JSON`,
    );
  }
}

function embeddedCanonicalRowHash(value: JsonRecord): string {
  return sha256Text(JSON.stringify(value));
}

function scalar(value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

function rowObject(row: Row): JsonRecord {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, scalar(value ?? null)]),
  );
}

function uniqueBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    const existing = result.get(key);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(value)) {
      fail(
        "CONSENSUS_REUSE_MATERIALIZATION_GRAPH_COLLISION",
        `${label} ${key} has conflicting projections`,
      );
    }
    result.set(key, value);
  }
  return result;
}

function prefixedId(prefix: string, hash: string): string {
  return `${prefix}:${hash}`;
}

export interface ProductTruthConsensusReuseMaterializationSource {
  consensusReuseScopeSchemaVersion:
    typeof PRODUCT_TRUTH_CONSENSUS_REUSE_SCOPE_VERSION;
  consensusReuseScopeSha256: string;
  selectionPreflightSchemaVersion:
    typeof PRODUCT_TRUTH_CONSENSUS_REUSE_PREFLIGHT_VERSION;
  selectionPreflightSha256: string;
  blindTaskSchemaVersion: typeof PRODUCT_TRUTH_BLIND_TASK_VERSION;
  blindTaskSha256: string;
  standingPolicySchemaVersion:
    typeof PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION;
  standingPolicySha256: string;
  standingPolicyId: string;
  manifestSha256: string;
  targetFingerprint: string;
}

export interface ProductTruthConsensusReuseMaterializationComponent {
  componentIndex: 0;
  sourceComponent: {
    id: string;
    sku: string;
    idx: 0;
    product: string;
    flavor: string | null;
    size: string | null;
    qty: number;
    donorProductId: string;
    canonicalRowSha256: string;
  };
  donorProductId: string;
  sourceEvidence: {
    caseIds: string[];
    donorProductRowSha256: string;
    selectedOfferRowSha256: string;
    selectedOfferId: string;
  };
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
}

export interface ProductTruthConsensusReuseMaterializationTarget {
  ordinal: number;
  listingKey: string;
  channel: "walmart";
  storeIndex: number;
  sku: string;
  expectedReadiness: {
    bundleFactory: boolean;
    listingImprovement: boolean;
    unitEconomics: "UNSOURCEABLE";
    procurement: false;
  };
  components: ProductTruthConsensusReuseMaterializationComponent[];
  listingRecipe: ProductTruthListingRecipeRow;
  listingRecipeComponents: ProductTruthListingRecipeComponentRow[];
  componentEvidence: ProductTruthLegacyBridgeComponentEvidenceRow[];
  listingScopeLink: ProductTruthLegacyBridgeScopeLinkRow;
  cost: ProductTruthLegacyBridgeCostRow;
}

export interface ProductTruthConsensusReuseMaterializationPlan {
  schemaVersion: typeof PRODUCT_TRUTH_CONSENSUS_REUSE_PLAN_VERSION;
  planId: string;
  createdAt: string;
  expiresAt: string;
  wave: ProductTruthConsensusReusePreflightWave;
  databaseTargetFingerprint: string;
  source: ProductTruthConsensusReuseMaterializationSource;
  targetsSha256: string;
  targets: ProductTruthConsensusReuseMaterializationTarget[];
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
    postCommitRecovery:
      "APPEND_ONLY_CORRECTION_AND_CONSUMER_CUTOVER_OFF";
  };
  claims: {
    reusesExistingCatalog: true;
    createsAdditionalCatalog: false;
    mutatesLegacyContentFields: false;
    canonicalContentOnly: true;
    historicalPricePromoted: false;
    costOutcome: "UNSOURCEABLE";
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    marketplaceMutations: 0;
    procurementMutations: 0;
    consumerCutover: false;
  };
}

export interface ProductTruthConsensusReuseApplyPreflightReport {
  schemaVersion: typeof PRODUCT_TRUTH_CONSENSUS_REUSE_APPLY_PREFLIGHT_VERSION;
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
    donorVariantDecisionReuses: number;
    donorIdentityTransitionsRequired: number;
  };
  listingKeys: string[];
  foreignKeyViolations: string[];
  claims: ProductTruthConsensusReuseMaterializationPlan["claims"];
}

export interface ProductTruthConsensusReuseApplyReport {
  schemaVersion: typeof PRODUCT_TRUTH_CONSENSUS_REUSE_APPLY_REPORT_VERSION;
  status: "APPLIED" | "ALREADY_APPLIED";
  planId: string;
  planSha256: string;
  standingPolicyId: string;
  standingPolicySha256: string;
  preflightReportSha256: string;
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
  claims: ProductTruthConsensusReuseMaterializationPlan["claims"];
}

export interface ProductTruthConsensusReuseMaterializationSources {
  scope: ProductTruthConsensusReuseScope;
  scopeJson: string;
  scopeSha256: string;
  selectionPreflight: ProductTruthConsensusReusePreflightReport;
  selectionPreflightJson: string;
  selectionPreflightSha256: string;
  blindTask: unknown;
  blindTaskJson: string;
  blindTaskSha256: string;
  standingPolicy: ProductTruthLegacyBridgeStandingPolicy;
  standingPolicyJson: string;
  standingPolicySha256: string;
}

type EmbeddedTaskSource = {
  taskCase: JsonRecord;
  donorRow: JsonRecord;
  donorRowSha256: string;
  offerRow: JsonRecord;
  offerRowSha256: string;
  componentRow: JsonRecord;
  componentRowSha256: string;
};

function assertSourceBytes(
  value: string,
  expectedSha256: string,
  label: string,
): void {
  const expected = exactSha(expectedSha256, `${label}Sha256`);
  const actual = sha256Text(value);
  if (actual !== expected) {
    fail(
      "CONSENSUS_REUSE_MATERIALIZATION_SOURCE_HASH_MISMATCH",
      `${label} ${actual} != ${expected}`,
    );
  }
}

function validateStandingPolicy(
  policy: ProductTruthLegacyBridgeStandingPolicy,
  policyJson: string,
  policySha256: string,
  input: {
    databaseTargetFingerprint: string;
    manifestSha256: string;
    maximumRows?: number;
    at?: string;
  },
): void {
  assertSourceBytes(policyJson, policySha256, "standingPolicy");
  if (
    policy.schemaVersion !== PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION
    || renderProductTruthLegacyBridgeStandingPolicy(policy) !== policyJson
    || policy.databaseTargetFingerprint !== input.databaseTargetFingerprint
    || policy.manifestSha256 !== input.manifestSha256
    || policy.approvedBy !== "owner"
    || policy.allowCanonicalMaterialization !== true
    || policy.requiresCollisionFree !== true
    || policy.requiresFreshReadyToApplyPreflight !== true
    || policy.allowProviderCalls !== false
    || policy.allowPaidCalls !== false
    || policy.allowMarketplaceListingWrites !== false
    || policy.allowPriceChanges !== false
    || policy.allowInventoryChanges !== false
    || policy.allowDelisting !== false
    || policy.allowConsumerActivation !== false
    || policy.allowProcurement !== false
  ) {
    fail(
      "CONSENSUS_REUSE_STANDING_POLICY_INVALID",
      "standing policy is not the exact no-paid canonical materialization authority",
    );
  }
  if (
    input.maximumRows !== undefined
    && input.maximumRows > policy.maximumDatabaseRowsPerWave
  ) {
    fail(
      "CONSENSUS_REUSE_STANDING_POLICY_LIMIT_EXCEEDED",
      `${input.maximumRows} > ${policy.maximumDatabaseRowsPerWave}`,
    );
  }
  if (
    input.at
    && (
      Date.parse(input.at) < Date.parse(policy.issuedAt)
      || (
        policy.expiresAt !== null
        && Date.parse(input.at) > Date.parse(policy.expiresAt)
      )
    )
  ) {
    fail(
      "CONSENSUS_REUSE_STANDING_POLICY_EXPIRED",
      input.at,
    );
  }
}

function assertMaterializationSources(
  input: ProductTruthConsensusReuseMaterializationSources,
): void {
  assertSourceBytes(input.scopeJson, input.scopeSha256, "scope");
  assertSourceBytes(
    input.selectionPreflightJson,
    input.selectionPreflightSha256,
    "selectionPreflight",
  );
  assertSourceBytes(input.blindTaskJson, input.blindTaskSha256, "blindTask");
  if (
    input.scope.schemaVersion !== PRODUCT_TRUTH_CONSENSUS_REUSE_SCOPE_VERSION
    || renderProductTruthConsensusReuseScope(input.scope) !== input.scopeJson
    || input.selectionPreflight.schemaVersion
      !== PRODUCT_TRUTH_CONSENSUS_REUSE_PREFLIGHT_VERSION
    || renderProductTruthConsensusReusePreflight(input.selectionPreflight)
      !== input.selectionPreflightJson
  ) {
    fail(
      "CONSENSUS_REUSE_MATERIALIZATION_SOURCE_INVALID",
      "scope or selection preflight canonical contract mismatch",
    );
  }
  const task = recordValue(input.blindTask, "blindTask");
  if (
    task.schemaVersion !== PRODUCT_TRUTH_BLIND_TASK_VERSION
    || input.scope.source.blindTask.sha256 !== input.blindTaskSha256
    || input.selectionPreflight.source.consensusReuseScopeSha256
      !== input.scopeSha256
    || input.selectionPreflight.databaseTargetFingerprint
      !== input.scope.source.recipeRepairScope.targetFingerprint
    || input.selectionPreflight.source.manifestSha256
      !== input.scope.source.recipeRepairScope.manifestSha256
  ) {
    fail(
      "CONSENSUS_REUSE_MATERIALIZATION_SOURCE_INVALID",
      "cross-source immutable binding mismatch",
    );
  }
  validateStandingPolicy(
    input.standingPolicy,
    input.standingPolicyJson,
    input.standingPolicySha256,
    {
      databaseTargetFingerprint:
        input.scope.source.recipeRepairScope.targetFingerprint,
      manifestSha256:
        input.scope.source.recipeRepairScope.manifestSha256,
    },
  );
}

function taskCaseById(blindTask: unknown, caseId: string): JsonRecord {
  const task = recordValue(blindTask, "blindTask");
  const matches = arrayValue(task.cases, "blindTask.cases")
    .map((value, index) => recordValue(value, `blindTask.cases[${index}]`))
    .filter((value) => value.caseId === caseId);
  if (matches.length !== 1) {
    fail(
      "CONSENSUS_REUSE_TASK_CASE_MISSING",
      `${caseId} expected one task case`,
    );
  }
  return matches[0]!;
}

function inventoryPayload(taskCase: JsonRecord): JsonRecord {
  const items = arrayValue(taskCase.evidenceItems, "taskCase.evidenceItems")
    .map((value, index) => recordValue(value, `evidenceItems[${index}]`));
  const inventory = items.find(
    (item) => item.evidenceId === "quarantine-inventory-case",
  );
  if (!inventory) {
    fail(
      "CONSENSUS_REUSE_TASK_EVIDENCE_MISSING",
      String(taskCase.caseId),
    );
  }
  return recordValue(inventory.payload, "inventory.payload");
}

function offerPriority(row: JsonRecord): number {
  const retailer = String(row.retailer ?? "").toLowerCase();
  if (retailer === "walmart") return 0;
  if (retailer === "target") return 1;
  if (retailer === "publix") return 2;
  return 10;
}

function extractEmbeddedTaskSource(
  candidate: ProductTruthConsensusReuseCandidate,
  blindTask: unknown,
): EmbeddedTaskSource {
  const taskCase = taskCaseById(
    blindTask,
    candidate.immutableEvidence.caseId,
  );
  if (
    rowHash(taskCase) !== candidate.immutableEvidence.taskCaseSha256
    || taskCase.sourceRowSha256 !== candidate.immutableEvidence.sourceRowSha256
  ) {
    fail(
      "CONSENSUS_REUSE_TASK_CASE_DRIFT",
      candidate.immutableEvidence.caseId,
    );
  }
  const payload = inventoryPayload(taskCase);
  const donorMatches = arrayValue(
    payload.exactTitleDonorEvidence,
    "exactTitleDonorEvidence",
  ).map((value, index) =>
    recordValue(value, `exactTitleDonorEvidence[${index}]`))
    .filter((value) => {
      const product = recordValue(value.donorProduct, "donorProduct");
      const row = recordValue(product.row, "donorProduct.row");
      return row.id === candidate.donorProductId
        && row.title === candidate.donorTitle;
    });
  if (donorMatches.length !== 1) {
    fail(
      "CONSENSUS_REUSE_TASK_DONOR_MISMATCH",
      candidate.donorProductId,
    );
  }
  const donorEvidence = donorMatches[0]!;
  const donorProduct = recordValue(
    donorEvidence.donorProduct,
    "donorEvidence.donorProduct",
  );
  const donorRow = recordValue(donorProduct.row, "donorProduct.row");
  const donorRowSha256 = exactSha(
    donorProduct.canonicalRowSha256,
    "donorProduct.canonicalRowSha256",
  );
  if (
    donorRowSha256 !== candidate.immutableEvidence.taskDonorProductRowSha256
    || embeddedCanonicalRowHash(donorRow) !== donorRowSha256
  ) {
    fail(
      "CONSENSUS_REUSE_TASK_DONOR_HASH_MISMATCH",
      candidate.donorProductId,
    );
  }
  const allowedOfferHashes = new Set(
    candidate.immutableEvidence.taskFirstPartyOfferRowSha256s,
  );
  const offers = arrayValue(
    donorEvidence.firstPartyOffers,
    "donorEvidence.firstPartyOffers",
  ).map((value, index) => {
    const offer = recordValue(value, `firstPartyOffers[${index}]`);
    const row = recordValue(offer.row, `firstPartyOffers[${index}].row`);
    const canonicalRowSha256 = exactSha(
      offer.canonicalRowSha256,
      `firstPartyOffers[${index}].canonicalRowSha256`,
    );
    return { row, canonicalRowSha256 };
  }).filter(({ row, canonicalRowSha256 }) => {
    let url: URL;
    try {
      url = new URL(String(row.productUrl ?? ""));
    } catch {
      return false;
    }
    return allowedOfferHashes.has(canonicalRowSha256)
      && embeddedCanonicalRowHash(row) === canonicalRowSha256
      && row.donorProductId === candidate.donorProductId
      && Number(row.isFirstParty) === 1
      && row.via === "direct"
      && url.protocol === "https:"
      && !["bjs", "sams", "samsclub", "costco"].includes(
        String(row.retailer ?? "").toLowerCase(),
      );
  }).sort((left, right) =>
    offerPriority(left.row) - offerPriority(right.row)
    || String(left.row.id).localeCompare(String(right.row.id), "en-US"));
  if (!offers.length) {
    fail(
      "CONSENSUS_REUSE_TASK_OFFER_MISSING",
      candidate.donorProductId,
    );
  }
  const recipeEvidence = recordValue(
    payload.recipeEvidence,
    "payload.recipeEvidence",
  );
  const componentMatches = arrayValue(
    recipeEvidence.skuComponents,
    "recipeEvidence.skuComponents",
  ).map((value, index) =>
    recordValue(value, `skuComponents[${index}]`))
    .map((value) =>
      recordValue(value.skuComponent, "skuComponents[].skuComponent"))
    .filter((value) => {
      const row = recordValue(value.row, "skuComponent.row");
      return row.id === candidate.legacyComponentId;
    });
  if (componentMatches.length !== 1) {
    fail(
      "CONSENSUS_REUSE_TASK_COMPONENT_MISMATCH",
      candidate.listingKey,
    );
  }
  const component = componentMatches[0]!;
  const componentRow = recordValue(component.row, "skuComponent.row");
  const componentRowSha256 = exactSha(
    component.canonicalRowSha256,
    "skuComponent.canonicalRowSha256",
  );
  if (
    embeddedCanonicalRowHash(componentRow) !== componentRowSha256
    || componentRow.sku !== candidate.sku
    || Number(componentRow.idx) !== candidate.componentIndex
    || Number(componentRow.qty) !== candidate.quantity
    || componentRow.donorProductId !== candidate.donorProductId
  ) {
    fail(
      "CONSENSUS_REUSE_TASK_COMPONENT_HASH_MISMATCH",
      candidate.listingKey,
    );
  }
  return {
    taskCase,
    donorRow,
    donorRowSha256,
    offerRow: offers[0]!.row,
    offerRowSha256: offers[0]!.canonicalRowSha256,
    componentRow,
    componentRowSha256,
  };
}

function contentPayload(input: {
  donorRow: JsonRecord;
  offerRow: JsonRecord;
  donorRowSha256: string;
  offerRowSha256: string;
  source: ProductTruthConsensusReuseMaterializationSource;
  caseIds: string[];
}): JsonRecord {
  const imageUrls = parseJson(
    input.donorRow.imageUrls,
    "donorProduct.imageUrls",
  ) ?? [];
  if (
    !Array.isArray(imageUrls)
    || imageUrls.some((value) => typeof value !== "string")
  ) {
    fail(
      "CONSENSUS_REUSE_CONTENT_INVALID",
      `${String(input.donorRow.id)} image gallery is invalid`,
    );
  }
  const upc = nullableText(input.donorRow.upc);
  const normalizedGtin14 = upc && /^\d{8,14}$/.test(upc)
    ? upc.padStart(14, "0")
    : null;
  return {
    _schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_CONTENT_VERSION,
    _capture: "legacy_materialized_bridge",
    title: nullableText(input.donorRow.title),
    description: nullableText(input.donorRow.description),
    bullets: parseJson(input.donorRow.bullets, "donorProduct.bullets"),
    attributes: parseJson(
      input.donorRow.attributes,
      "donorProduct.attributes",
    ),
    nutritionFacts: parseJson(
      input.donorRow.nutritionFacts,
      "donorProduct.nutritionFacts",
    ),
    ingredients: nullableText(input.donorRow.ingredients),
    allergens: null,
    category: nullableText(input.donorRow.category),
    storage: null,
    upc,
    normalizedGtin14,
    mainImageUrl: nullableText(input.donorRow.mainImageUrl),
    imageUrls,
    sourceBinding: {
      schemaVersion: PRODUCT_TRUTH_CONSENSUS_REUSE_CONTENT_SOURCE_VERSION,
      method: PRODUCT_TRUTH_CONSENSUS_REUSE_METHOD,
      consensusReuseScopeSha256:
        input.source.consensusReuseScopeSha256,
      selectionPreflightSha256:
        input.source.selectionPreflightSha256,
      blindTaskSha256: input.source.blindTaskSha256,
      donorProductId: input.donorRow.id,
      donorProductRowSha256: input.donorRowSha256,
      donorUpdatedAt: input.donorRow.updatedAt,
      donorOfferId: input.offerRow.id,
      donorOfferRowSha256: input.offerRowSha256,
      offerFetchedAt: input.offerRow.fetchedAt,
      originalSourceApi: input.offerRow.sourceApi,
      caseIds: input.caseIds,
      historicalPricePromoted: false,
    },
  };
}

function contentFieldHashes(payload: JsonRecord): Record<string, string> {
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

function completeContentPayload(payload: JsonRecord): boolean {
  const title = nullableText(payload.title);
  const description = nullableText(payload.description);
  const ingredients = nullableText(payload.ingredients);
  const category = nullableText(payload.category);
  const normalizedGtin14 = nullableText(payload.normalizedGtin14);
  const mainImageUrl = nullableText(payload.mainImageUrl);
  const imageUrls = Array.isArray(payload.imageUrls)
    ? payload.imageUrls
    : [];
  return Boolean(
    title
    && description
    && ingredients
    && payload.nutritionFacts !== null
    && payload.storage !== null
    && payload.allergens !== null
    && category
    && normalizedGtin14
    && /^\d{14}$/.test(normalizedGtin14)
    && mainImageUrl?.startsWith("https://")
    && imageUrls.length > 0
    && imageUrls.every(
      (value) => typeof value === "string" && value.startsWith("https://"),
    )
    && imageUrls.includes(mainImageUrl),
  );
}

function sourceIdentityFields(
  state: ProductTruthConsensusReuseReadyDonorState,
): JsonRecord {
  return {
    identityKey: state.sourceIdentity.identityKey,
    identityStatus: state.sourceIdentity.identityStatus,
    brand: state.sourceIdentity.brand,
    productLine: state.sourceIdentity.productLine,
    flavor: state.sourceIdentity.flavor,
    containerType: state.sourceIdentity.containerType,
    size: state.sourceIdentity.size,
  };
}

function exactProjection(
  candidate: ProductTruthConsensusReuseCandidate,
  state: ProductTruthConsensusReuseReadyDonorState,
  evidenceJson: string,
  confirmedAt: string,
): ProductTruthLegacyBridgeDonorTransition["exactProjection"] {
  return {
    identityKey: state.sourceIdentity.identityKey,
    brand: exactText(
      candidate.currentTargetIdentity.brand,
      "currentTargetIdentity.brand",
    ),
    productLine:
      nullableText(candidate.currentTargetIdentity.productLine),
    flavor: nullableText(candidate.currentTargetIdentity.flavor),
    containerType: nullableText(candidate.currentTargetIdentity.form),
    size: exactText(
      candidate.currentTargetIdentity.size,
      "currentTargetIdentity.size",
    ),
    identityStatus: "exact_confirmed",
    identityMatcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    identityMatcherImplementationSha256:
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    identityMatcherReleaseSha256:
      CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    identityEvidenceJson: evidenceJson,
    identityConfirmedAt: confirmedAt,
  };
}

function decisionEvidence(input: {
  candidates: readonly ProductTruthConsensusReuseCandidate[];
  source: ProductTruthConsensusReuseMaterializationSource;
}): JsonRecord {
  const ordered = [...input.candidates].sort((left, right) =>
    left.listingKey.localeCompare(right.listingKey, "en-US"));
  const first = ordered[0]!;
  return {
    schemaVersion: PRODUCT_TRUTH_CONSENSUS_REUSE_DECISION_EVIDENCE_VERSION,
    verdict: "EXACT_IDENTITY",
    method: PRODUCT_TRUTH_CONSENSUS_REUSE_METHOD,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256:
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256:
      CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    donorProductId: first.donorProductId,
    canonicalVariantId: first.proposedCanonicalVariant.id,
    source: input.source,
    cases: ordered.map((candidate) => ({
      listingKey: candidate.listingKey,
      caseId: candidate.immutableEvidence.caseId,
      currentTargetIdentity: candidate.currentTargetIdentity,
      consensusTargetIdentity: candidate.consensusTargetIdentity,
      consensusCandidateIdentity: candidate.consensusCandidateIdentity,
      representationTransition: candidate.representationTransition,
      immutableEvidence: candidate.immutableEvidence,
    })),
  };
}

function materializationSource(input: {
  sources: ProductTruthConsensusReuseMaterializationSources;
}): ProductTruthConsensusReuseMaterializationSource {
  return {
    consensusReuseScopeSchemaVersion:
      PRODUCT_TRUTH_CONSENSUS_REUSE_SCOPE_VERSION,
    consensusReuseScopeSha256: input.sources.scopeSha256,
    selectionPreflightSchemaVersion:
      PRODUCT_TRUTH_CONSENSUS_REUSE_PREFLIGHT_VERSION,
    selectionPreflightSha256:
      input.sources.selectionPreflightSha256,
    blindTaskSchemaVersion: PRODUCT_TRUTH_BLIND_TASK_VERSION,
    blindTaskSha256: input.sources.blindTaskSha256,
    standingPolicySchemaVersion:
      PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION,
    standingPolicySha256: input.sources.standingPolicySha256,
    standingPolicyId: input.sources.standingPolicy.policyId,
    manifestSha256:
      input.sources.scope.source.recipeRepairScope.manifestSha256,
    targetFingerprint:
      input.sources.scope.source.recipeRepairScope.targetFingerprint,
  };
}

function donorRows(input: {
  candidates: readonly ProductTruthConsensusReuseCandidate[];
  donorState: ProductTruthConsensusReuseReadyDonorState;
  sources: ProductTruthConsensusReuseMaterializationSources;
  source: ProductTruthConsensusReuseMaterializationSource;
  planId: string;
  createdAt: string;
}): {
  componentSources: Map<string, EmbeddedTaskSource>;
  variant: ProductTruthLegacyBridgeVariantRow;
  decision: ProductTruthLegacyBridgeDecisionRow | null;
  reusedDecision:
    ProductTruthConsensusReuseMaterializationComponent["reusedDecision"];
  donorTransition: ProductTruthLegacyBridgeDonorTransition | null;
  content: ProductTruthLegacyBridgeContentRow;
} {
  const ordered = [...input.candidates].sort((left, right) =>
    left.listingKey.localeCompare(right.listingKey, "en-US"));
  const first = ordered[0]!;
  const componentSources = new Map<string, EmbeddedTaskSource>();
  for (const candidate of ordered) {
    componentSources.set(
      candidate.listingKey,
      extractEmbeddedTaskSource(candidate, input.sources.blindTask),
    );
  }
  const embedded = [...componentSources.values()];
  if (
    new Set(embedded.map((value) => canonicalJson(value.donorRow))).size !== 1
    || new Set(embedded.map((value) => value.donorRowSha256)).size !== 1
  ) {
    fail(
      "CONSENSUS_REUSE_DONOR_CONTENT_COLLISION",
      first.donorProductId,
    );
  }
  const decisionEvidenceValue = decisionEvidence({
    candidates: ordered,
    source: input.source,
  });
  const decisionEvidenceJson = canonicalJson(decisionEvidenceValue);
  const decisionEvidenceHash = rowHash(decisionEvidenceValue);
  const decisionKey = rowHash({
    donorProductId: first.donorProductId,
    canonicalVariantId: first.proposedCanonicalVariant.id,
    decisionStatus: "exact_confirmed",
    evidenceHash: decisionEvidenceHash,
  });
  const createdDecisionId = prefixedId("dpvd", decisionKey);
  const decisionId =
    input.donorState.existingDecision?.id ?? createdDecisionId;
  const decision = input.donorState.decisionState === "CREATE"
    ? {
      id: createdDecisionId,
      decisionKey,
      donorProductId: first.donorProductId,
      canonicalVariantId: first.proposedCanonicalVariant.id,
      decisionStatus: "exact_confirmed" as const,
      matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
      matcherImplementationSha256:
        CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      matcherReleaseSha256:
        CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      evidenceHash: decisionEvidenceHash,
      evidenceJson: decisionEvidenceJson,
      decidedAt: input.createdAt,
      runId: input.planId,
      approvalId: input.source.standingPolicyId,
      createdAt: input.createdAt,
    }
    : null;
  const reusedDecision = input.donorState.existingDecision === null
    ? null
    : {
      decisionId: input.donorState.existingDecision.id,
      donorProductId: first.donorProductId,
      canonicalVariantId: first.proposedCanonicalVariant.id,
      decisionStatus: "exact_confirmed" as const,
      decidedAt: input.donorState.existingDecision.decidedAt,
    };
  if ((decision === null) === (reusedDecision === null)) {
    fail(
      "CONSENSUS_REUSE_DECISION_STATE_INVALID",
      first.donorProductId,
    );
  }
  const donorTransition = input.donorState.donorTransitionRequired
    ? {
      donorProductId: first.donorProductId,
      sourceIdentityStatus: input.donorState.sourceIdentity.identityStatus,
      sourceIdentityKey: input.donorState.sourceIdentity.identityKey,
      sourceIdentityFieldsSha256:
        input.donorState.sourceIdentitySha256,
      exactProjection: exactProjection(
        first,
        input.donorState,
        decisionEvidenceJson,
        input.createdAt,
      ),
    }
    : null;
  if (
    donorTransition
    && rowHash(sourceIdentityFields(input.donorState))
      !== donorTransition.sourceIdentityFieldsSha256
  ) {
    fail(
      "CONSENSUS_REUSE_DONOR_SOURCE_STATE_INVALID",
      first.donorProductId,
    );
  }
  const canonicalEmbedded = embedded[0]!;
  const payload = contentPayload({
    donorRow: canonicalEmbedded.donorRow,
    offerRow: canonicalEmbedded.offerRow,
    donorRowSha256: canonicalEmbedded.donorRowSha256,
    offerRowSha256: canonicalEmbedded.offerRowSha256,
    source: input.source,
    caseIds: ordered.map((candidate) => candidate.immutableEvidence.caseId),
  });
  const contentJson = canonicalJson(payload);
  const contentHash = rowHash(payload);
  const fieldHashesJson = canonicalJson(contentFieldHashes(payload));
  const sourceUrl = exactText(
    canonicalEmbedded.offerRow.productUrl,
    "offer.productUrl",
  );
  const sourceApi = PRODUCT_TRUTH_CONSENSUS_REUSE_CONTENT_SOURCE_API;
  const observedAt = canonicalInstant(
    canonicalEmbedded.donorRow.updatedAt,
    "donor.updatedAt",
  );
  const observationKey = rowHash({
    donorProductId: first.donorProductId,
    canonicalVariantId: first.proposedCanonicalVariant.id,
    variantDecisionId: decisionId,
    sourceUrl,
    sourceApi,
    contentHash,
    observedAt,
    source: input.source,
  });
  return {
    componentSources,
    variant: {
      ...first.proposedCanonicalVariant,
      createdAt: input.createdAt,
    },
    decision,
    reusedDecision,
    donorTransition,
    content: {
      id: prefixedId("pco", observationKey),
      observationKey,
      donorProductId: first.donorProductId,
      canonicalVariantId: first.proposedCanonicalVariant.id,
      variantDecisionId: decisionId,
      sourceUrl,
      sourceApi,
      contentHash,
      fieldHashesJson,
      contentJson,
      observedAt,
      runId: input.planId,
      approvalId: input.source.standingPolicyId,
      meteredReceiptId: null,
      createdAt: input.createdAt,
    },
  };
}

function targetRows(input: {
  ordinal: number;
  candidate: ProductTruthConsensusReuseCandidate;
  donorRows: ReturnType<typeof donorRows>;
  source: ProductTruthConsensusReuseMaterializationSource;
  planId: string;
  createdAt: string;
}): ProductTruthConsensusReuseMaterializationTarget {
  const embedded = input.donorRows.componentSources.get(
    input.candidate.listingKey,
  );
  if (!embedded) {
    fail(
      "CONSENSUS_REUSE_COMPONENT_SOURCE_MISSING",
      input.candidate.listingKey,
    );
  }
  const product = exactText(
    embedded.componentRow.product,
    "component.product",
  );
  const flavor = nullableText(embedded.componentRow.flavor);
  const size = nullableText(embedded.componentRow.size)
    ?? nullableText(input.candidate.currentTargetIdentity.size);
  const decisionId = input.donorRows.decision?.id
    ?? input.donorRows.reusedDecision!.decisionId;
  const componentSourceEvidence = {
    schemaVersion: PRODUCT_TRUTH_CONSENSUS_REUSE_RECIPE_SOURCE_VERSION,
    method: PRODUCT_TRUTH_CONSENSUS_REUSE_METHOD,
    source: input.source,
    caseId: input.candidate.immutableEvidence.caseId,
    immutableEvidence: input.candidate.immutableEvidence,
    sourceComponentRowSha256: embedded.componentRowSha256,
    donorProductRowSha256: embedded.donorRowSha256,
    selectedOfferRowSha256: embedded.offerRowSha256,
    representationTransition: input.candidate.representationTransition,
  };
  const sourceArtifactSha256 = rowHash({
    schemaVersion: PRODUCT_TRUTH_CONSENSUS_REUSE_RECIPE_SOURCE_VERSION,
    listingKey: input.candidate.listingKey,
    source: input.source,
    componentSourceEvidence,
  });
  const recipeMaterialization =
    buildProductTruthListingRecipeMaterialization({
      listingKey: input.candidate.listingKey,
      manifestSha256: input.source.manifestSha256,
      sourceKind: "LEGACY_BRIDGE",
      sourceArtifactSha256,
      effectiveAt: input.createdAt,
      createdAt: input.createdAt,
      runId: input.planId,
      approvalId: input.source.standingPolicyId,
      components: [{
        componentIndex: 0,
        quantity: input.candidate.quantity,
        product,
        flavor,
        size,
        targetCanonicalVariantId:
          input.candidate.proposedCanonicalVariant.id,
        donorProductId: input.candidate.donorProductId,
        variantDecisionId: decisionId,
        sourceComponentId: input.candidate.legacyComponentId,
        sourceEvidence: componentSourceEvidence,
      }],
    });
  const recipeHash = recipeMaterialization.recipe.recipeHash;
  const costComponent = {
    idx: 0,
    product,
    flavor,
    size,
    qty: input.candidate.quantity,
    perUnit: null,
    method: "no-fresh-first-party-price",
    targetComparableUnitPrice: null,
    priceEvidenceStatus: "REJECT",
    targetCanonicalVariantId:
      input.candidate.proposedCanonicalVariant.id,
    contentCanonicalVariantId:
      input.candidate.proposedCanonicalVariant.id,
    priceCanonicalVariantId: null,
    contentObservationId: input.donorRows.content.id,
    priceEvidenceObservationId: null,
    contentDonorProductId: input.candidate.donorProductId,
    priceEvidenceDonorProductId: null,
    priceEvidenceOfferId: null,
    priceVariantDecisionId: null,
    matchTier: "EXACT_IDENTITY",
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256:
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256:
      CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
  };
  const costEvidence = {
    schemaVersion: "product-truth-cogs-evidence/1.0.0",
    channel: input.candidate.channel,
    storeIndex: input.candidate.storeIndex,
    listingKey: input.candidate.listingKey,
    listingKeyVersion: PRODUCT_TRUTH_LISTING_KEY_VERSION,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256:
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256:
      CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    evaluatedAt: input.createdAt,
    procurementZip: PRODUCT_TRUTH_PROCUREMENT_ZIP,
    sourcePolicy: {
      evidence: "historical-content-only",
      maxPriceAgeMs: MAX_PRICE_AGE_MS,
      paidCalls: 0,
      providerCalls: 0,
      historicalPricePromoted: false,
    },
    outcome: "UNSOURCEABLE",
    runId: input.planId,
    approvalId: input.source.standingPolicyId,
    recipeHash,
    components: [costComponent],
  };
  const costEvidenceJson = canonicalJson(costEvidence);
  const costObservationKey = rowHash({
    sku: input.candidate.sku,
    listingKey: input.candidate.listingKey,
    source: "retail:batch",
    recipeHash,
    evidenceHash: sha256Text(costEvidenceJson),
    evaluatedAt: input.createdAt,
    runId: input.planId,
    approvalId: input.source.standingPolicyId,
  });
  const skuCostId =
    `retail:${input.candidate.sku}:consensus:${costObservationKey.slice(0, 24)}`;
  const componentEvidencePayload = {
    schemaVersion: "product-truth-sku-component-evidence/1.0.0",
    sourceEvidenceSchemaVersion:
      PRODUCT_TRUTH_CONSENSUS_REUSE_PLAN_VERSION,
    evidenceStatus: "REJECT",
    targetCanonicalVariantId:
      input.candidate.proposedCanonicalVariant.id,
    contentCanonicalVariantId:
      input.candidate.proposedCanonicalVariant.id,
    priceCanonicalVariantId: null,
    contentObservationId: input.donorRows.content.id,
    priceObservationId: null,
    product,
    flavor,
    size,
    qty: input.candidate.quantity,
    perUnit: null,
    method: "no-fresh-first-party-price",
    targetComparableUnitPrice: null,
    matchTier: "EXACT_IDENTITY",
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256:
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256:
      CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
    rejectionReasons: [
      "NO_ELIGIBLE_PRICE_WITHIN_24_HOURS",
      "HISTORICAL_PRICE_NOT_PROMOTED",
    ],
  };
  const componentEvidenceJson = canonicalJson(componentEvidencePayload);
  const componentEvidenceHash = rowHash(componentEvidencePayload);
  const componentEvidenceKey = rowHash({
    skuCostId,
    componentIndex: 0,
    evidenceHash: componentEvidenceHash,
  });
  const contentReady = completeContentPayload(
    recordValue(
      JSON.parse(input.donorRows.content.contentJson) as unknown,
      "content.contentJson",
    ),
  );
  return {
    ordinal: input.ordinal,
    listingKey: input.candidate.listingKey,
    channel: input.candidate.channel,
    storeIndex: input.candidate.storeIndex,
    sku: input.candidate.sku,
    expectedReadiness: {
      bundleFactory: contentReady,
      listingImprovement: contentReady,
      unitEconomics: "UNSOURCEABLE",
      procurement: false,
    },
    components: [{
      componentIndex: 0,
      sourceComponent: {
        id: exactText(embedded.componentRow.id, "component.id"),
        sku: exactText(embedded.componentRow.sku, "component.sku"),
        idx: 0,
        product,
        flavor,
        size,
        qty: input.candidate.quantity,
        donorProductId: input.candidate.donorProductId,
        canonicalRowSha256: embedded.componentRowSha256,
      },
      donorProductId: input.candidate.donorProductId,
      sourceEvidence: {
        caseIds: [input.candidate.immutableEvidence.caseId],
        donorProductRowSha256: embedded.donorRowSha256,
        selectedOfferRowSha256: embedded.offerRowSha256,
        selectedOfferId: exactText(
          embedded.offerRow.id,
          "offer.id",
        ),
      },
      variant: input.donorRows.variant,
      decision: input.donorRows.decision,
      reusedDecision: input.donorRows.reusedDecision,
      donorTransition: input.donorRows.donorTransition,
      content: input.donorRows.content,
    }],
    listingRecipe: recipeMaterialization.recipe,
    listingRecipeComponents: recipeMaterialization.components,
    componentEvidence: [{
      id: prefixedId("sce", componentEvidenceKey),
      evidenceKey: componentEvidenceKey,
      skuCostId,
      componentIndex: 0,
      evidenceStatus: "REJECT",
      targetCanonicalVariantId:
        input.candidate.proposedCanonicalVariant.id,
      contentCanonicalVariantId:
        input.candidate.proposedCanonicalVariant.id,
      priceCanonicalVariantId: null,
      contentObservationId: input.donorRows.content.id,
      priceObservationId: null,
      matchTier: "EXACT_IDENTITY",
      matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
      matcherImplementationSha256:
        CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      matcherReleaseSha256:
        CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
      evidenceHash: componentEvidenceHash,
      evidenceJson: componentEvidenceJson,
      createdAt: input.createdAt,
    }],
    listingScopeLink: {
      skuCostId,
      listingKey: input.candidate.listingKey,
      linkVersion: SKU_COST_LISTING_SCOPE_LINK_VERSION,
      createdAt: input.createdAt,
    },
    cost: {
      id: skuCostId,
      observationKey: costObservationKey,
      sku: input.candidate.sku,
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
      notes:
        "UNSOURCEABLE: historical exact content retained; no eligible price within 24 hours",
      recipeHash,
      evidenceJson: costEvidenceJson,
      evidenceOutcome: "UNSOURCEABLE",
      matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
      matcherImplementationSha256:
        CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      matcherReleaseSha256:
        CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
      runId: input.planId,
      approvalId: input.source.standingPolicyId,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
  };
}

function uniqueComponentRows(
  targets: readonly ProductTruthConsensusReuseMaterializationTarget[],
): {
  variants: ProductTruthLegacyBridgeVariantRow[];
  decisions: ProductTruthLegacyBridgeDecisionRow[];
  transitions: ProductTruthLegacyBridgeDonorTransition[];
  contents: ProductTruthLegacyBridgeContentRow[];
} {
  const components = targets.flatMap((target) => target.components);
  const donorVariants = new Map<string, string>();
  for (const component of components) {
    const previous = donorVariants.get(component.donorProductId);
    if (previous && previous !== component.variant.id) {
      fail(
        "CONSENSUS_REUSE_DONOR_VARIANT_COLLISION",
        component.donorProductId,
      );
    }
    donorVariants.set(component.donorProductId, component.variant.id);
  }
  return {
    variants: [...uniqueBy(
      components.map((component) => component.variant),
      (row) => row.id,
      "variant",
    ).values()],
    decisions: [...uniqueBy(
      components.flatMap((component) =>
        component.decision ? [component.decision] : []),
      (row) => row.id,
      "decision",
    ).values()],
    transitions: [...uniqueBy(
      components.flatMap((component) =>
        component.donorTransition ? [component.donorTransition] : []),
      (row) => row.donorProductId,
      "donor transition",
    ).values()],
    contents: [...uniqueBy(
      components.map((component) => component.content),
      (row) => row.id,
      "content",
    ).values()],
  };
}

function expectedDatabaseWrites(
  targets: readonly ProductTruthConsensusReuseMaterializationTarget[],
): ProductTruthConsensusReuseMaterializationPlan["databaseWrites"] {
  const rows = uniqueComponentRows(targets);
  const productTruthListingRecipeComponents = targets.reduce(
    (sum, target) => sum + target.listingRecipeComponents.length,
    0,
  );
  const skuComponentEvidence = targets.reduce(
    (sum, target) => sum + target.componentEvidence.length,
    0,
  );
  return {
    maximumRows:
      rows.variants.length
      + rows.decisions.length
      + rows.transitions.length
      + rows.contents.length
      + targets.length * 3
      + productTruthListingRecipeComponents
      + skuComponentEvidence,
    canonicalProductVariants: rows.variants.length,
    donorVariantDecisions: rows.decisions.length,
    donorIdentityTransitions: rows.transitions.length,
    productContentObservations: rows.contents.length,
    productTruthListingRecipes: targets.length,
    productTruthListingRecipeComponents,
    skuCostListingScopeLinks: targets.length,
    skuComponentEvidence,
    skuCosts: targets.length,
  };
}

export function compileProductTruthConsensusReuseMaterializationPlan(input: {
  sources: ProductTruthConsensusReuseMaterializationSources;
  waveOrdinal: number;
  createdAt: string;
  expiresAt: string;
}): ProductTruthConsensusReuseMaterializationPlan {
  assertMaterializationSources(input.sources);
  const createdAt = canonicalInstant(input.createdAt, "createdAt");
  const expiresAt = canonicalInstant(input.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    fail(
      "CONSENSUS_REUSE_MATERIALIZATION_INPUT_INVALID",
      "expiresAt must be after createdAt",
    );
  }
  const wave = input.sources.selectionPreflight.waves.find(
    (value) => value.ordinal === input.waveOrdinal,
  );
  if (!wave) {
    fail(
      "CONSENSUS_REUSE_MATERIALIZATION_WAVE_INVALID",
      `wave ${input.waveOrdinal} is not present`,
    );
  }
  const source = materializationSource(input);
  const planId = `ptcr-wave-${rowHash({
    source,
    wave,
    createdAt,
  }).slice(0, 24)}`;
  const candidates = input.sources.scope.candidates.filter(
    (candidate) =>
      candidate.lane === "DIRECT_SINGLE_VARIANT"
      && wave.listingKeys.includes(candidate.listingKey),
  );
  if (
    candidates.length !== wave.listingKeys.length
    || new Set(candidates.map((candidate) => candidate.listingKey)).size
      !== wave.listingKeys.length
    || new Set(candidates.map((candidate) => candidate.donorProductId)).size
      !== wave.donorProductIds.length
  ) {
    fail(
      "CONSENSUS_REUSE_MATERIALIZATION_WAVE_INVALID",
      "wave candidates do not match immutable selection preflight",
    );
  }
  const candidatesByDonor = Map.groupBy(
    candidates,
    (candidate) => candidate.donorProductId,
  );
  const donorStateById = new Map(
    input.sources.selectionPreflight.readyDonorStates.map(
      (state) => [state.donorProductId, state],
    ),
  );
  const compiledDonorRows = new Map(
    wave.donorProductIds.map((donorProductId) => {
      const donorCandidates = candidatesByDonor.get(donorProductId);
      const donorState = donorStateById.get(donorProductId);
      if (
        !donorCandidates?.length
        || !donorState
        || canonicalJson(
          donorCandidates.map((candidate) => candidate.listingKey).sort(),
        ) !== canonicalJson(donorState.listingKeys)
      ) {
        fail(
          "CONSENSUS_REUSE_MATERIALIZATION_WAVE_INVALID",
          `${donorProductId} is not a complete ready donor group`,
        );
      }
      return [
        donorProductId,
        donorRows({
          candidates: donorCandidates,
          donorState,
          sources: input.sources,
          source,
          planId,
          createdAt,
        }),
      ] as const;
    }),
  );
  const targets = [...candidates]
    .sort((left, right) =>
      left.listingKey.localeCompare(right.listingKey, "en-US"))
    .map((candidate, ordinal) =>
      targetRows({
        ordinal,
        candidate,
        donorRows: compiledDonorRows.get(candidate.donorProductId)!,
        source,
        planId,
        createdAt,
      }));
  const databaseWrites = expectedDatabaseWrites(targets);
  if (
    databaseWrites.maximumRows !== wave.maximumRows
    || databaseWrites.maximumRows
      > input.sources.standingPolicy.maximumDatabaseRowsPerWave
  ) {
    fail(
      "CONSENSUS_REUSE_MATERIALIZATION_ROW_COUNT_MISMATCH",
      `${databaseWrites.maximumRows} != ${wave.maximumRows}`,
    );
  }
  return {
    schemaVersion: PRODUCT_TRUTH_CONSENSUS_REUSE_PLAN_VERSION,
    planId,
    createdAt,
    expiresAt,
    wave,
    databaseTargetFingerprint: source.targetFingerprint,
    source,
    targetsSha256: rowHash(targets),
    targets,
    databaseWrites,
    rollbackPolicy: {
      transactionMode: "SINGLE_WRITE_TRANSACTION",
      rollbackBeforeCommit: true,
      postCommitDeleteRollback: false,
      postCommitRecovery:
        "APPEND_ONLY_CORRECTION_AND_CONSUMER_CUTOVER_OFF",
    },
    claims: {
      reusesExistingCatalog: true,
      createsAdditionalCatalog: false,
      mutatesLegacyContentFields: false,
      canonicalContentOnly: true,
      historicalPricePromoted: false,
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

export function renderProductTruthConsensusReuseMaterializationPlan(
  value: ProductTruthConsensusReuseMaterializationPlan,
): string {
  return canonicalJson(value);
}

export function renderProductTruthConsensusReuseApplyPreflight(
  value: ProductTruthConsensusReuseApplyPreflightReport,
): string {
  return canonicalJson(value);
}

export function renderProductTruthConsensusReuseApplyReport(
  value: ProductTruthConsensusReuseApplyReport,
): string {
  return canonicalJson(value);
}

function validatePlan(input: {
  plan: ProductTruthConsensusReuseMaterializationPlan;
  planJson: string;
  planSha256: string;
  sources: ProductTruthConsensusReuseMaterializationSources;
}): void {
  const expected = compileProductTruthConsensusReuseMaterializationPlan({
    sources: input.sources,
    waveOrdinal: input.plan.wave.ordinal,
    createdAt: input.plan.createdAt,
    expiresAt: input.plan.expiresAt,
  });
  if (
    input.plan.schemaVersion !== PRODUCT_TRUTH_CONSENSUS_REUSE_PLAN_VERSION
    || renderProductTruthConsensusReuseMaterializationPlan(input.plan)
      !== input.planJson
    || sha256Text(input.planJson) !== exactSha(input.planSha256, "planSha256")
    || canonicalJson(expected) !== input.planJson
  ) {
    fail(
      "CONSENSUS_REUSE_PLAN_INVALID",
      "plan bytes do not recompile from bound immutable sources",
    );
  }
}

type RowState = "EXACT" | "ABSENT";

async function exactOrAbsent(
  db: SqlReader,
  table: string,
  primaryKey: string,
  expected: JsonRecord,
  collisionCode: string,
  ignoredColumns: ReadonlySet<string> = new Set(),
): Promise<RowState> {
  const keyValue = expected[primaryKey];
  const result = await db.execute({
    sql: `SELECT * FROM "${table}" WHERE "${primaryKey}"=?`,
    args: [keyValue as never],
  });
  if (result.rows.length === 0) return "ABSENT";
  if (result.rows.length !== 1) {
    fail(collisionCode, `${table}.${primaryKey}=${String(keyValue)}`);
  }
  const actual = rowObject(result.rows[0]!);
  const mismatches = Object.entries(expected)
    .filter(([column, value]) =>
      !ignoredColumns.has(column)
      && !Object.is(actual[column] ?? null, scalar(value ?? null)))
    .map(([column]) => column);
  if (mismatches.length) {
    fail(
      collisionCode,
      `${table}.${primaryKey}=${String(keyValue)} drifted: ${mismatches.join(",")}`,
    );
  }
  return "EXACT";
}

function sourceComponentExpected(
  component: ProductTruthConsensusReuseMaterializationComponent,
): JsonRecord {
  return {
    id: component.sourceComponent.id,
    sku: component.sourceComponent.sku,
    idx: component.sourceComponent.idx,
    product: component.sourceComponent.product,
    flavor: component.sourceComponent.flavor,
    size: component.sourceComponent.size,
    qty: component.sourceComponent.qty,
    donorProductId: component.sourceComponent.donorProductId,
  };
}

function exactProjectionExpected(
  transition: ProductTruthLegacyBridgeDonorTransition,
): JsonRecord {
  return {
    id: transition.donorProductId,
    ...transition.exactProjection,
  };
}

function sourceIdentityExpected(
  transition: ProductTruthLegacyBridgeDonorTransition,
): JsonRecord {
  return {
    id: transition.donorProductId,
    identityKey: transition.sourceIdentityKey,
    identityStatus: transition.sourceIdentityStatus,
  };
}

type TargetPreflight = {
  graphState: "EXACT" | "ABSENT";
  variantStates: Array<{ id: string; state: RowState }>;
  transitionRequired: boolean;
};

async function preflightTarget(
  db: SqlReader,
  plan: ProductTruthConsensusReuseMaterializationPlan,
  target: ProductTruthConsensusReuseMaterializationTarget,
): Promise<TargetPreflight> {
  const listing = await db.execute({
    sql: `SELECT "listingKey","channel","storeIndex","sku","manifestSha256"
      FROM "ProductTruthListingScope" WHERE "listingKey"=?`,
    args: [target.listingKey],
  });
  if (
    listing.rows.length !== 1
    || listing.rows[0]!.channel !== target.channel
    || Number(listing.rows[0]!.storeIndex) !== target.storeIndex
    || listing.rows[0]!.sku !== target.sku
    || listing.rows[0]!.manifestSha256 !== plan.source.manifestSha256
  ) {
    fail(
      "CONSENSUS_REUSE_LISTING_SCOPE_DRIFT",
      target.listingKey,
    );
  }
  const variantStates: Array<{ id: string; state: RowState }> = [];
  const graphRows: RowState[] = [];
  let transitionRequired = false;
  for (const component of target.components) {
    const sourceComponent = await db.execute({
      sql: `SELECT "id","sku","idx","product","flavor","size","qty","donorProductId"
        FROM "SkuComponent" WHERE "id"=?`,
      args: [component.sourceComponent.id],
    });
    if (
      sourceComponent.rows.length !== 1
      || canonicalJson(rowObject(sourceComponent.rows[0]!))
        !== canonicalJson(sourceComponentExpected(component))
    ) {
      fail(
        "CONSENSUS_REUSE_SOURCE_COMPONENT_DRIFT",
        component.sourceComponent.id,
      );
    }
    const variantState = await exactOrAbsent(
      db,
      "CanonicalProductVariant",
      "id",
      component.variant as unknown as JsonRecord,
      "CONSENSUS_REUSE_VARIANT_COLLISION",
      CANONICAL_VARIANT_REUSE_IGNORED_COLUMNS,
    );
    variantStates.push({ id: component.variant.id, state: variantState });
    if (component.decision) {
      graphRows.push(await exactOrAbsent(
        db,
        "DonorProductVariantDecision",
        "id",
        component.decision as unknown as JsonRecord,
        "CONSENSUS_REUSE_DECISION_COLLISION",
      ));
    } else {
      const reused = component.reusedDecision!;
      const result = await db.execute({
        sql: `SELECT "id","donorProductId","canonicalVariantId",
          "decisionStatus","decidedAt"
          FROM "DonorProductVariantDecision" WHERE "id"=?`,
        args: [reused.decisionId],
      });
      if (
        result.rows.length !== 1
        || result.rows[0]!.donorProductId !== reused.donorProductId
        || result.rows[0]!.canonicalVariantId !== reused.canonicalVariantId
        || result.rows[0]!.decisionStatus !== reused.decisionStatus
        || result.rows[0]!.decidedAt !== reused.decidedAt
      ) {
        fail(
          "CONSENSUS_REUSE_REUSED_DECISION_DRIFT",
          reused.decisionId,
        );
      }
    }
    const exactDecisionRows = await db.execute({
      sql: `SELECT "id","canonicalVariantId"
        FROM "DonorProductVariantDecision"
        WHERE "donorProductId"=? AND "decisionStatus"='exact_confirmed'`,
      args: [component.donorProductId],
    });
    const expectedDecisionId =
      component.decision?.id ?? component.reusedDecision!.decisionId;
    if (
      exactDecisionRows.rows.length > 1
      || (
        exactDecisionRows.rows.length === 1
        && (
          exactDecisionRows.rows[0]!.id !== expectedDecisionId
          || exactDecisionRows.rows[0]!.canonicalVariantId
            !== component.variant.id
        )
      )
    ) {
      fail(
        "CONSENSUS_REUSE_EXACT_DECISION_COLLISION",
        component.donorProductId,
      );
    }
    if (component.donorTransition) {
      const donor = await db.execute({
        sql: `SELECT "id","identityKey","identityStatus","brand",
          "productLine","flavor","containerType","size",
          "identityMatcherVersion","identityMatcherImplementationSha256",
          "identityMatcherReleaseSha256","identityEvidenceJson",
          "identityConfirmedAt"
          FROM "DonorProduct" WHERE "id"=?`,
        args: [component.donorProductId],
      });
      if (donor.rows.length !== 1) {
        fail(
          "CONSENSUS_REUSE_DONOR_MISSING",
          component.donorProductId,
        );
      }
      const actual = rowObject(donor.rows[0]!);
      const actualSourceIdentity = {
        identityKey: actual.identityKey,
        identityStatus: actual.identityStatus,
        brand: actual.brand,
        productLine: actual.productLine,
        flavor: actual.flavor,
        containerType: actual.containerType,
        size: actual.size,
      };
      const exact = exactProjectionExpected(component.donorTransition);
      const sourceMatches =
        rowHash(actualSourceIdentity)
          === component.donorTransition.sourceIdentityFieldsSha256;
      const exactMatches = Object.entries(exact).every(
        ([key, value]) => Object.is(actual[key] ?? null, value ?? null),
      );
      if (!sourceMatches && !exactMatches) {
        fail(
          "CONSENSUS_REUSE_DONOR_IDENTITY_DRIFT",
          component.donorProductId,
        );
      }
      transitionRequired = transitionRequired || sourceMatches;
    }
    graphRows.push(await exactOrAbsent(
      db,
      "ProductContentObservation",
      "id",
      component.content as unknown as JsonRecord,
      "CONSENSUS_REUSE_CONTENT_COLLISION",
    ));
  }
  for (const component of target.listingRecipeComponents) {
    graphRows.push(await exactOrAbsent(
      db,
      "ProductTruthListingRecipeComponent",
      "id",
      component as unknown as JsonRecord,
      "CONSENSUS_REUSE_RECIPE_COMPONENT_COLLISION",
    ));
  }
  graphRows.push(await exactOrAbsent(
    db,
    "ProductTruthListingRecipe",
    "id",
    target.listingRecipe as unknown as JsonRecord,
    "CONSENSUS_REUSE_RECIPE_COLLISION",
  ));
  graphRows.push(await exactOrAbsent(
    db,
    "SkuCostListingScopeLink",
    "skuCostId",
    target.listingScopeLink as unknown as JsonRecord,
    "CONSENSUS_REUSE_SCOPE_LINK_COLLISION",
  ));
  for (const evidence of target.componentEvidence) {
    graphRows.push(await exactOrAbsent(
      db,
      "SkuComponentEvidence",
      "id",
      evidence as unknown as JsonRecord,
      "CONSENSUS_REUSE_COMPONENT_EVIDENCE_COLLISION",
    ));
  }
  graphRows.push(await exactOrAbsent(
    db,
    "SkuCost",
    "id",
    target.cost as unknown as JsonRecord,
    "CONSENSUS_REUSE_COST_COLLISION",
  ));
  const exactRows = graphRows.filter((state) => state === "EXACT").length;
  if (exactRows !== 0 && exactRows !== graphRows.length) {
    fail(
      "CONSENSUS_REUSE_PARTIAL_GRAPH",
      target.listingKey,
    );
  }
  if (
    exactRows === graphRows.length
    && (
      variantStates.some(({ state }) => state !== "EXACT")
      || transitionRequired
    )
  ) {
    fail(
      "CONSENSUS_REUSE_PARTIAL_GRAPH",
      `${target.listingKey} graph is exact but identity is incomplete`,
    );
  }
  return {
    graphState: exactRows === graphRows.length ? "EXACT" : "ABSENT",
    variantStates,
    transitionRequired,
  };
}

async function foreignKeyViolations(db: SqlReader): Promise<string[]> {
  const result = await checkProductTruthConsensusReuseForeignKeys(db);
  return result.map((row) => canonicalJson(row).trim());
}

async function preflightStates(
  db: SqlReader,
  plan: ProductTruthConsensusReuseMaterializationPlan,
): Promise<TargetPreflight[]> {
  const states: TargetPreflight[] = [];
  for (const target of plan.targets) {
    states.push(await preflightTarget(db, plan, target));
  }
  const exact = states.filter((state) => state.graphState === "EXACT").length;
  if (exact !== 0 && exact !== plan.targets.length) {
    fail(
      "CONSENSUS_REUSE_PARTIAL_WAVE",
      "wave is partially applied",
    );
  }
  const violations = await foreignKeyViolations(db);
  if (violations.length) {
    fail(
      "CONSENSUS_REUSE_FOREIGN_KEY_VIOLATION",
      violations.join("; "),
    );
  }
  return states;
}

export async function preflightProductTruthConsensusReuseMaterialization(
  input: {
    db: Client;
    databaseTargetFingerprint: string;
    plan: ProductTruthConsensusReuseMaterializationPlan;
    planJson: string;
    planSha256: string;
    sources: ProductTruthConsensusReuseMaterializationSources;
    checkedAt: string;
  },
): Promise<ProductTruthConsensusReuseApplyPreflightReport> {
  validatePlan(input);
  const checkedAt = canonicalInstant(input.checkedAt, "checkedAt");
  if (
    input.databaseTargetFingerprint !== input.plan.databaseTargetFingerprint
    || Date.parse(checkedAt) < Date.parse(input.plan.createdAt)
    || Date.parse(checkedAt) > Date.parse(input.plan.expiresAt)
  ) {
    fail(
      "CONSENSUS_REUSE_PREFLIGHT_WINDOW_INVALID",
      checkedAt,
    );
  }
  validateStandingPolicy(
    input.sources.standingPolicy,
    input.sources.standingPolicyJson,
    input.sources.standingPolicySha256,
    {
      databaseTargetFingerprint: input.databaseTargetFingerprint,
      manifestSha256: input.plan.source.manifestSha256,
      maximumRows: input.plan.databaseWrites.maximumRows,
      at: checkedAt,
    },
  );
  await assertProductTruthEvidenceSchema(input.db);
  await assertProductTruthListingScopeSchema(input.db);
  const tx = await input.db.transaction("read");
  try {
    const states = await preflightStates(tx, input.plan);
    const exactGraphs = states.filter(
      (state) => state.graphState === "EXACT",
    ).length;
    const status = exactGraphs === input.plan.targets.length
      ? "ALREADY_APPLIED"
      : "READY_TO_APPLY";
    const canonicalVariantReuses = new Set(
      states.flatMap((state) =>
        state.variantStates
          .filter(({ state: rowState }) => rowState === "EXACT")
          .map(({ id }) => id)),
    ).size;
    const donorVariantDecisionReuses = new Set(
      input.plan.targets.flatMap((target) =>
        target.components.flatMap((component) =>
          component.reusedDecision
            ? [component.reusedDecision.decisionId]
            : [])),
    ).size;
    return {
      schemaVersion:
        PRODUCT_TRUTH_CONSENSUS_REUSE_APPLY_PREFLIGHT_VERSION,
      status,
      planId: input.plan.planId,
      planSha256: input.planSha256,
      checkedAt,
      databaseTargetFingerprint: input.databaseTargetFingerprint,
      standingPolicyId: input.sources.standingPolicy.policyId,
      standingPolicySha256: input.sources.standingPolicySha256,
      counts: {
        targets: input.plan.targets.length,
        maximumRows: input.plan.databaseWrites.maximumRows,
        absentRows: status === "READY_TO_APPLY"
          ? input.plan.databaseWrites.maximumRows - canonicalVariantReuses
          : 0,
        exactExistingRows: status === "ALREADY_APPLIED"
          ? input.plan.databaseWrites.maximumRows
          : canonicalVariantReuses,
        canonicalVariantReuses,
        donorVariantDecisionReuses,
        donorIdentityTransitionsRequired: status === "READY_TO_APPLY"
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

async function insertRow(
  tx: Transaction,
  table: string,
  row: JsonRecord,
): Promise<void> {
  const columns = Object.keys(row);
  await tx.execute({
    sql: `INSERT INTO "${table}" (${
      columns.map((column) => `"${column}"`).join(",")
    }) VALUES (${columns.map(() => "?").join(",")})`,
    args: columns.map((column) => row[column] as never),
  });
}

async function applyRows(
  tx: Transaction,
  plan: ProductTruthConsensusReuseMaterializationPlan,
  states: readonly TargetPreflight[],
): Promise<{
  canonicalVariantReuses: number;
  donorIdentityTransitions: number;
}> {
  const graphExact = states.every((state) => state.graphState === "EXACT");
  const rows = uniqueComponentRows(plan.targets);
  if (graphExact) {
    return {
      canonicalVariantReuses: rows.variants.length,
      donorIdentityTransitions: 0,
    };
  }
  let canonicalVariantReuses = 0;
  for (const variant of rows.variants) {
    const state = await exactOrAbsent(
      tx,
      "CanonicalProductVariant",
      "id",
      variant as unknown as JsonRecord,
      "CONSENSUS_REUSE_VARIANT_COLLISION",
      CANONICAL_VARIANT_REUSE_IGNORED_COLUMNS,
    );
    if (state === "EXACT") {
      canonicalVariantReuses += 1;
    } else {
      await insertRow(
        tx,
        "CanonicalProductVariant",
        variant as unknown as JsonRecord,
      );
    }
  }
  for (const decision of rows.decisions) {
    await insertRow(
      tx,
      "DonorProductVariantDecision",
      decision as unknown as JsonRecord,
    );
  }
  for (const transition of rows.transitions) {
    const projection = transition.exactProjection;
    const source = sourceIdentityExpected(transition);
    const result = await tx.execute({
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
        transition.donorProductId,
        source.identityKey as string,
        source.identityStatus as string,
      ],
    });
    if (result.rowsAffected !== 1) {
      fail(
        "CONSENSUS_REUSE_DONOR_TRANSITION_FAILED",
        transition.donorProductId,
      );
    }
  }
  for (const content of rows.contents) {
    await insertRow(
      tx,
      "ProductContentObservation",
      content as unknown as JsonRecord,
    );
  }
  for (const target of plan.targets) {
    for (const component of target.listingRecipeComponents) {
      await insertRow(
        tx,
        "ProductTruthListingRecipeComponent",
        component as unknown as JsonRecord,
      );
    }
    await insertRow(
      tx,
      "ProductTruthListingRecipe",
      target.listingRecipe as unknown as JsonRecord,
    );
    await insertRow(
      tx,
      "SkuCostListingScopeLink",
      target.listingScopeLink as unknown as JsonRecord,
    );
    for (const evidence of target.componentEvidence) {
      await insertRow(
        tx,
        "SkuComponentEvidence",
        evidence as unknown as JsonRecord,
      );
    }
    await insertRow(
      tx,
      "SkuCost",
      target.cost as unknown as JsonRecord,
    );
  }
  return {
    canonicalVariantReuses,
    donorIdentityTransitions: rows.transitions.length,
  };
}

function validateApplyPreflight(input: {
  plan: ProductTruthConsensusReuseMaterializationPlan;
  planSha256: string;
  report: ProductTruthConsensusReuseApplyPreflightReport;
  reportJson: string;
  reportSha256: string;
  policy: ProductTruthLegacyBridgeStandingPolicy;
  policySha256: string;
  startedAt: string;
}): void {
  assertSourceBytes(
    input.reportJson,
    input.reportSha256,
    "applyPreflight",
  );
  const startedAt = Date.parse(input.startedAt);
  if (
    input.report.schemaVersion
      !== PRODUCT_TRUTH_CONSENSUS_REUSE_APPLY_PREFLIGHT_VERSION
    || renderProductTruthConsensusReuseApplyPreflight(input.report)
      !== input.reportJson
    || input.report.planId !== input.plan.planId
    || input.report.planSha256 !== input.planSha256
    || input.report.databaseTargetFingerprint
      !== input.plan.databaseTargetFingerprint
    || input.report.standingPolicyId !== input.policy.policyId
    || input.report.standingPolicySha256 !== input.policySha256
    || !["READY_TO_APPLY", "ALREADY_APPLIED"].includes(input.report.status)
    || input.report.counts.targets !== input.plan.targets.length
    || input.report.counts.maximumRows
      !== input.plan.databaseWrites.maximumRows
    || canonicalJson(input.report.listingKeys)
      !== canonicalJson(
        input.plan.targets.map((target) => target.listingKey),
      )
    || canonicalJson(input.report.claims)
      !== canonicalJson(input.plan.claims)
    || (
      input.report.status === "READY_TO_APPLY"
      && (
        input.report.counts.absentRows
          + input.report.counts.exactExistingRows
          !== input.plan.databaseWrites.maximumRows
        || input.report.counts.donorIdentityTransitionsRequired
          !== input.plan.databaseWrites.donorIdentityTransitions
      )
    )
    || (
      input.report.status === "ALREADY_APPLIED"
      && (
        input.report.counts.absentRows !== 0
        || input.report.counts.exactExistingRows
          !== input.plan.databaseWrites.maximumRows
        || input.report.counts.donorIdentityTransitionsRequired !== 0
      )
    )
    || startedAt < Date.parse(input.report.checkedAt)
    || startedAt - Date.parse(input.report.checkedAt)
      > input.policy.maximumPreflightAgeMs
  ) {
    fail(
      "CONSENSUS_REUSE_APPLY_PREFLIGHT_INVALID",
      "fresh plan-bound READY_TO_APPLY preflight is required",
    );
  }
}

export async function applyProductTruthConsensusReuseMaterialization(
  input: {
    db: Client;
    databaseTargetFingerprint: string;
    plan: ProductTruthConsensusReuseMaterializationPlan;
    planJson: string;
    planSha256: string;
    sources: ProductTruthConsensusReuseMaterializationSources;
    preflightReport: ProductTruthConsensusReuseApplyPreflightReport;
    preflightReportJson: string;
    preflightReportSha256: string;
    startedAt: string;
  },
): Promise<ProductTruthConsensusReuseApplyReport> {
  validatePlan(input);
  const startedAt = canonicalInstant(input.startedAt, "startedAt");
  if (
    Date.parse(startedAt) > Date.now()
    || input.databaseTargetFingerprint
      !== input.plan.databaseTargetFingerprint
  ) {
    fail(
      "CONSENSUS_REUSE_APPLY_INPUT_INVALID",
      "timestamp or database target is invalid",
    );
  }
  validateStandingPolicy(
    input.sources.standingPolicy,
    input.sources.standingPolicyJson,
    input.sources.standingPolicySha256,
    {
      databaseTargetFingerprint: input.databaseTargetFingerprint,
      manifestSha256: input.plan.source.manifestSha256,
      maximumRows: input.plan.databaseWrites.maximumRows,
      at: startedAt,
    },
  );
  validateApplyPreflight({
    plan: input.plan,
    planSha256: input.planSha256,
    report: input.preflightReport,
    reportJson: input.preflightReportJson,
    reportSha256: input.preflightReportSha256,
    policy: input.sources.standingPolicy,
    policySha256: input.sources.standingPolicySha256,
    startedAt,
  });
  await assertProductTruthEvidenceSchema(input.db);
  await assertProductTruthListingScopeSchema(input.db);
  let insertedRows = 0;
  let exactExistingRows = 0;
  let canonicalVariantReuses = 0;
  let donorIdentityTransitions = 0;
  let bundleFactoryReady = 0;
  let listingImprovementReady = 0;
  let unitEconomicsUnsourceable = 0;
  let procurementReady = 0;
  const tx = await input.db.transaction("write");
  try {
    const states = await preflightStates(tx, input.plan);
    const exactGraphs = states.filter(
      (state) => state.graphState === "EXACT",
    ).length;
    const txCanonicalVariantReuses = new Set(
      states.flatMap((state) =>
        state.variantStates
          .filter(({ state: rowState }) => rowState === "EXACT")
          .map(({ id }) => id)),
    ).size;
    if (
      exactGraphs === 0
      && txCanonicalVariantReuses
        !== input.preflightReport.counts.canonicalVariantReuses
    ) {
      fail(
        "CONSENSUS_REUSE_TRANSACTION_PREFLIGHT_DRIFT",
        "canonical variant state changed after preflight",
      );
    }
    const applied = await applyRows(tx, input.plan, states);
    canonicalVariantReuses = applied.canonicalVariantReuses;
    donorIdentityTransitions = applied.donorIdentityTransitions;
    if (exactGraphs === 0) {
      insertedRows =
        input.plan.databaseWrites.maximumRows - canonicalVariantReuses;
      exactExistingRows = canonicalVariantReuses;
    } else {
      exactExistingRows = input.plan.databaseWrites.maximumRows;
    }
    const violations = await foreignKeyViolations(tx);
    if (violations.length) {
      fail(
        "CONSENSUS_REUSE_FOREIGN_KEY_VIOLATION",
        violations.join("; "),
      );
    }
    const snapshots = await readProductTruthSnapshotsInTransaction(tx, {
      scopes: input.plan.targets.map((target) => ({
        sku: target.sku,
        channel: target.channel,
        storeIndex: target.storeIndex,
      })),
      expectedManifestSha256: input.plan.source.manifestSha256,
      asOf: startedAt,
      maxPriceAgeMs: MAX_PRICE_AGE_MS,
    });
    bundleFactoryReady = snapshots.filter(
      (snapshot) => snapshot.views.bundleFactory.ready,
    ).length;
    listingImprovementReady = snapshots.filter(
      (snapshot) => snapshot.views.listingImprovement.ready,
    ).length;
    unitEconomicsUnsourceable = snapshots.filter(
      (snapshot) =>
        snapshot.views.unitEconomics.status === "UNSOURCEABLE",
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
        "CONSENSUS_REUSE_READ_CONTRACT_VERIFY_FAILED",
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
      // The original failure is authoritative.
    }
    if (error instanceof ProductTruthConsensusReuseMaterializationError) {
      throw error;
    }
    fail(
      "CONSENSUS_REUSE_TRANSACTION_FAILED",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  const post = await input.db.transaction("read");
  try {
    const states = await preflightStates(post, input.plan);
    if (states.some((state) => state.graphState !== "EXACT")) {
      fail(
        "CONSENSUS_REUSE_POST_VERIFY_FAILED",
        "committed graph is incomplete",
      );
    }
  } finally {
    post.close();
  }
  return {
    schemaVersion: PRODUCT_TRUTH_CONSENSUS_REUSE_APPLY_REPORT_VERSION,
    status: insertedRows > 0 ? "APPLIED" : "ALREADY_APPLIED",
    planId: input.plan.planId,
    planSha256: input.planSha256,
    standingPolicyId: input.sources.standingPolicy.policyId,
    standingPolicySha256: input.sources.standingPolicySha256,
    preflightReportSha256: input.preflightReportSha256,
    databaseTargetFingerprint: input.databaseTargetFingerprint,
    startedAt,
    completedAt: new Date().toISOString(),
    counts: {
      targets: input.plan.targets.length,
      insertedRows,
      exactExistingRows,
      canonicalVariantReuses,
      donorVariantDecisionReuses: new Set(
        input.plan.targets.flatMap((target) =>
          target.components.flatMap((component) =>
            component.reusedDecision
              ? [component.reusedDecision.decisionId]
              : [])),
      ).size,
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
