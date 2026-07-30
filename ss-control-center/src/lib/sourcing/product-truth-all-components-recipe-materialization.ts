import { createHash } from "node:crypto";

import type {
  Client,
  InValue,
  Row,
  Transaction,
} from "@libsql/client";

import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "./canonical-product-match-provenance";
import {
  type ProductTruthLegacyBridgeStandingPolicy,
  PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION,
  renderProductTruthLegacyBridgeStandingPolicy,
} from "./product-truth-legacy-bridge-apply";
import {
  type ProductTruthLegacyBridgeCanonicalDonorBindingRow,
  type ProductTruthLegacyBridgeSnapshot,
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  renderProductTruthLegacyBridgeSnapshot,
} from "./product-truth-legacy-bridge";
import {
  type ProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionTarget,
  PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
  renderProductTruthComponentAcquisitionScope,
} from "./product-truth-component-acquisition-scope";
import {
  buildProductTruthListingRecipeMaterialization,
  type ProductTruthListingRecipeComponentRow,
  type ProductTruthListingRecipeRow,
} from "./product-truth-listing-recipe";
import {
  PRODUCT_TRUTH_LISTING_KEY_VERSION,
  SKU_COST_LISTING_SCOPE_LINK_VERSION,
} from "./product-truth-listing-scope";
import {
  type ProductTruthRecipeRepairScope,
  type ProductTruthRecipeRepairScopeEntry,
  PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION,
  renderProductTruthRecipeRepairScope,
} from "./product-truth-recipe-repair-scope";
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

export const PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_PLAN_VERSION =
  "product-truth-all-components-recipe-materialization-plan/1.0.0" as const;
export const PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_PREFLIGHT_VERSION =
  "product-truth-all-components-recipe-materialization-preflight/1.0.0" as const;
export const PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_REPORT_VERSION =
  "product-truth-all-components-recipe-materialization-report/1.0.0" as const;
export const PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_SOURCE_VERSION =
  "product-truth-all-components-recipe-source/1.0.0" as const;
export const PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_MAX_LISTINGS = 50 as const;

type JsonRecord = Record<string, unknown>;
type SqlReader = Pick<Client, "execute"> | Pick<Transaction, "execute">;
type TargetState = "ABSENT" | "EXACT";
type CostComponentDraft = {
  idx: number;
  product: string;
  flavor: string | null;
  size: string | null;
  qty: number;
  perUnit: null;
  method: "price-reconciliation-pending";
  targetComparableUnitPrice: null;
  priceEvidenceStatus: "REJECT";
  targetCanonicalVariantId: string;
  contentCanonicalVariantId: string | null;
  priceCanonicalVariantId: null;
  contentObservationId: string | null;
  priceEvidenceObservationId: null;
  contentDonorProductId: string | null;
  priceEvidenceDonorProductId: null;
  priceEvidenceOfferId: null;
  priceVariantDecisionId: null;
  matchTier: "EXACT_IDENTITY";
  matcherVersion: string;
  matcherImplementationSha256: string;
  matcherReleaseSha256: string;
  pricePolicyVersion: string;
};

const SCOPE_COLUMNS = [
  "listingKey",
  "keyVersion",
  "channel",
  "storeIndex",
  "sku",
  "registrationKind",
  "manifestSchemaVersion",
  "manifestSha256",
  "manifestAsOf",
  "ownerDecisionId",
  "sourceReportId",
  "sourceContentSha256",
  "sourceCapturedAt",
  "createdAt",
] as const;

const VARIANT_COLUMNS = [
  "id",
  "variantKey",
  "keyVersion",
  "identityHash",
  "identityJson",
] as const;

const DECISION_COLUMNS = [
  "id",
  "decisionKey",
  "donorProductId",
  "canonicalVariantId",
  "decisionStatus",
  "matcherVersion",
  "matcherImplementationSha256",
  "matcherReleaseSha256",
  "evidenceHash",
  "evidenceJson",
  "decidedAt",
  "runId",
  "approvalId",
  "createdAt",
] as const;

const DONOR_IDENTITY_COLUMNS = [
  "id",
  "identityKey",
  "identityStatus",
] as const;

const CONTENT_COLUMNS = [
  "id",
  "observationKey",
  "donorProductId",
  "canonicalVariantId",
  "variantDecisionId",
  "sourceUrl",
  "sourceApi",
  "contentHash",
  "fieldHashesJson",
  "contentJson",
  "observedAt",
  "runId",
  "approvalId",
  "meteredReceiptId",
  "createdAt",
] as const;

export interface ProductTruthAllComponentsRecipeSources {
  recipeRepairScope: ProductTruthRecipeRepairScope;
  recipeRepairScopeJson: string;
  recipeRepairScopeSha256: string;
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

export interface ProductTruthAllComponentsRecipeComponentEvidenceRow {
  id: string;
  evidenceKey: string;
  skuCostId: string;
  componentIndex: number;
  evidenceStatus: "REJECT";
  targetCanonicalVariantId: string;
  contentCanonicalVariantId: string | null;
  priceCanonicalVariantId: null;
  contentObservationId: string | null;
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

export interface ProductTruthAllComponentsRecipeCostRow {
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

export interface ProductTruthAllComponentsRecipeScopeLinkRow {
  skuCostId: string;
  listingKey: string;
  linkVersion: string;
  createdAt: string;
}

export interface ProductTruthAllComponentsRecipeSourceBinding {
  recipeRepairEntrySha256: string;
  componentAcquisitionTargetsSha256: string;
  canonicalBindingsSha256: string;
  listingScopeSha256: string;
  components: Array<{
    componentIndex: number;
    targetCanonicalVariantId: string;
    acquisitionTargetSha256: string;
    canonicalBindingSha256: string;
    canonicalVariantSha256: string;
    variantDecisionSha256: string;
    donorIdentitySha256: string;
    contentObservationSha256: string | null;
  }>;
  sourceGraphSha256: string;
}

export interface ProductTruthAllComponentsRecipeTarget {
  ordinal: number;
  listingKey: string;
  channel: "amazon" | "walmart";
  storeIndex: number;
  sku: string;
  sourceBinding: ProductTruthAllComponentsRecipeSourceBinding;
  listingRecipe: ProductTruthListingRecipeRow;
  listingRecipeComponents: ProductTruthListingRecipeComponentRow[];
  cost: ProductTruthAllComponentsRecipeCostRow;
  componentEvidence: ProductTruthAllComponentsRecipeComponentEvidenceRow[];
  listingScopeLink: ProductTruthAllComponentsRecipeScopeLinkRow;
}

export interface ProductTruthAllComponentsRecipePlan {
  schemaVersion: typeof PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_PLAN_VERSION;
  planId: string;
  createdAt: string;
  expiresAt: string;
  databaseTargetFingerprint: string;
  manifestSha256: string;
  source: {
    recipeRepairScopeSha256: string;
    componentScopeSha256: string;
    bridgeSnapshotSha256: string;
    standingPolicySha256: string;
    standingPolicyId: string;
  };
  selectedListingKeys: string[];
  targetsSha256: string;
  targets: ProductTruthAllComponentsRecipeTarget[];
  databaseWrites: {
    maximumRows: number;
    listingRecipes: number;
    listingRecipeComponents: number;
    skuCosts: number;
    componentEvidence: number;
    listingScopeLinks: number;
  };
  claims: {
    existingCatalogReused: true;
    legacyDonorLinksIgnored: true;
    everyComponentIndependentlyExact: true;
    priceEvidenceNotPromoted: true;
    initialCostOutcome: "UNSOURCEABLE";
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    marketplaceMutations: 0;
    priceChanges: 0;
    inventoryChanges: 0;
    delisting: 0;
    procurementMutations: 0;
    consumerCutover: false;
  };
}

export interface ProductTruthAllComponentsRecipePreflight {
  schemaVersion: typeof PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_PREFLIGHT_VERSION;
  status: "READY_TO_APPLY" | "ALREADY_APPLIED";
  planId: string;
  planSha256: string;
  databaseTargetFingerprint: string;
  standingPolicyId: string;
  standingPolicySha256: string;
  checkedAt: string;
  counts: {
    targets: number;
    maximumRows: number;
    absentRows: number;
    exactExistingRows: number;
  };
  targetStates: Array<{
    listingKey: string;
    state: TargetState;
  }>;
  foreignKeyViolations: string[];
}

export interface ProductTruthAllComponentsRecipeReport {
  schemaVersion: typeof PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_REPORT_VERSION;
  status: "APPLIED" | "ALREADY_APPLIED";
  planId: string;
  planSha256: string;
  preflightSha256: string;
  databaseTargetFingerprint: string;
  standingPolicyId: string;
  standingPolicySha256: string;
  startedAt: string;
  completedAt: string;
  counts: {
    targets: number;
    insertedRows: number;
    exactExistingRows: number;
    listingRecipes: number;
    listingRecipeComponents: number;
    skuCosts: number;
    componentEvidence: number;
    listingScopeLinks: number;
  };
  verification: {
    listingKeys: string[];
    recipeHashes: string[];
    costOutcomes: ["UNSOURCEABLE"];
    foreignKeyViolations: string[];
    providerCalls: 0;
    paidCalls: 0;
    marketplaceMutations: 0;
    consumerCutoverChanged: false;
  };
}

export class ProductTruthAllComponentsRecipeMaterializationError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(`${code}: ${message}`, { cause });
    this.name = "ProductTruthAllComponentsRecipeMaterializationError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthAllComponentsRecipeMaterializationError(
    code,
    message,
    cause,
  );
}

function canonicalJson(value: unknown): string {
  return renderProductTruthOperationalJson(value);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("ALL_COMPONENTS_RECIPE_INPUT_INVALID", `${label} must be SHA-256`);
  }
  return value;
}

function exactText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    fail("ALL_COMPONENTS_RECIPE_INPUT_INVALID", `${label} must be exact text`);
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function canonicalInstant(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    fail(
      "ALL_COMPONENTS_RECIPE_INPUT_INVALID",
      `${label} must be canonical UTC`,
    );
  }
  return value;
}

function scalar(value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

function projection(
  row: Row,
  columns: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    columns.map((column) => [column, scalar(row[column] ?? null)]),
  );
}

function rowSha(row: Row, columns: readonly string[]): string {
  return productTruthOperationalSha256(projection(row, columns));
}

function assertBoundCanonicalJson(input: {
  label: string;
  json: string;
  sha256: string;
  rendered: string;
}): void {
  if (
    sha256Text(input.json) !== exactSha(input.sha256, `${input.label}.sha256`)
    || input.json !== input.rendered
  ) {
    fail(
      "ALL_COMPONENTS_RECIPE_SOURCE_BYTES_INVALID",
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
      fail("ALL_COMPONENTS_RECIPE_SOURCE_DUPLICATE", `${label} ${key}`);
    }
    result.set(key, value);
  }
  return result;
}

function validateSources(
  sources: ProductTruthAllComponentsRecipeSources,
): void {
  assertBoundCanonicalJson({
    label: "recipeRepairScope",
    json: sources.recipeRepairScopeJson,
    sha256: sources.recipeRepairScopeSha256,
    rendered: renderProductTruthRecipeRepairScope(sources.recipeRepairScope),
  });
  assertBoundCanonicalJson({
    label: "componentScope",
    json: sources.componentScopeJson,
    sha256: sources.componentScopeSha256,
    rendered: renderProductTruthComponentAcquisitionScope(
      sources.componentScope,
    ),
  });
  assertBoundCanonicalJson({
    label: "bridgeSnapshot",
    json: sources.bridgeSnapshotJson,
    sha256: sources.bridgeSnapshotSha256,
    rendered: renderProductTruthLegacyBridgeSnapshot(sources.bridgeSnapshot),
  });
  assertBoundCanonicalJson({
    label: "standingPolicy",
    json: sources.standingPolicyJson,
    sha256: sources.standingPolicySha256,
    rendered: renderProductTruthLegacyBridgeStandingPolicy(
      sources.standingPolicy,
    ),
  });
  const manifestSha256 = sources.recipeRepairScope.source.manifest.sha256;
  if (
    sources.recipeRepairScope.schemaVersion
      !== PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION
    || sources.componentScope.schemaVersion
      !== PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION
    || sources.bridgeSnapshot.schemaVersion
      !== PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION
    || sources.standingPolicy.schemaVersion
      !== PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION
    || sources.componentScope.source.recipeRepairScope.sha256
      !== sources.recipeRepairScopeSha256
    || sources.componentScope.source.bridgeSnapshot.sha256
      !== sources.bridgeSnapshotSha256
    || sources.recipeRepairScope.source.bridgeSnapshot.sha256
      !== sources.bridgeSnapshotSha256
    || sources.bridgeSnapshot.manifest.sha256 !== manifestSha256
    || sources.standingPolicy.manifestSha256 !== manifestSha256
    || sources.componentScope.source.bridgeSnapshot.targetFingerprint
      !== sources.bridgeSnapshot.targetFingerprint
    || sources.recipeRepairScope.source.targetFingerprint
      !== sources.bridgeSnapshot.targetFingerprint
    || sources.standingPolicy.databaseTargetFingerprint
      !== sources.bridgeSnapshot.targetFingerprint
    || sources.componentScope.matcher.version
      !== CANONICAL_PRODUCT_MATCHER_VERSION
    || sources.componentScope.matcher.implementationSha256
      !== CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256
    || sources.componentScope.matcher.releaseSha256
      !== CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256
    || sources.standingPolicy.allowCanonicalMaterialization !== true
    || sources.standingPolicy.allowProviderCalls !== false
    || sources.standingPolicy.allowPaidCalls !== false
    || sources.standingPolicy.allowMarketplaceListingWrites !== false
    || sources.standingPolicy.allowPriceChanges !== false
    || sources.standingPolicy.allowInventoryChanges !== false
    || sources.standingPolicy.allowDelisting !== false
    || sources.standingPolicy.allowConsumerActivation !== false
    || sources.standingPolicy.allowProcurement !== false
  ) {
    fail(
      "ALL_COMPONENTS_RECIPE_SOURCE_CONTRACT_INVALID",
      "immutable sources do not share one exact Product Truth boundary",
    );
  }
}

type StaticComponent = {
  repairComponent:
    ProductTruthRecipeRepairScopeEntry["components"][number];
  acquisitionTarget: ProductTruthComponentAcquisitionTarget;
  canonicalBinding: ProductTruthLegacyBridgeCanonicalDonorBindingRow;
};

type StaticCandidate = {
  entry: ProductTruthRecipeRepairScopeEntry;
  components: StaticComponent[];
};

function staticCandidates(input: {
  sources: ProductTruthAllComponentsRecipeSources;
  listingKeys: readonly string[];
}): StaticCandidate[] {
  validateSources(input.sources);
  if (
    input.listingKeys.length < 1
    || input.listingKeys.length > PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_MAX_LISTINGS
    || new Set(input.listingKeys).size !== input.listingKeys.length
  ) {
    fail(
      "ALL_COMPONENTS_RECIPE_SCOPE_INVALID",
      "1-50 explicit unique listing keys are required",
    );
  }
  const sortedKeys = [...input.listingKeys].sort((left, right) =>
    left.localeCompare(right, "en-US"));
  if (canonicalJson(sortedKeys) !== canonicalJson(input.listingKeys)) {
    fail(
      "ALL_COMPONENTS_RECIPE_SCOPE_INVALID",
      "listing keys must be sorted canonically",
    );
  }
  const entryByListing = uniqueMap(
    input.sources.recipeRepairScope.entries,
    (entry) => entry.listingKey,
    "recipe entry",
  );
  const targetByVariant = uniqueMap(
    input.sources.componentScope.targets,
    (target) => target.canonicalVariantId,
    "component target",
  );
  const bindingsByVariant = new Map<
    string,
    ProductTruthLegacyBridgeCanonicalDonorBindingRow[]
  >();
  for (const binding of input.sources.bridgeSnapshot.canonicalDonorBindings) {
    const rows = bindingsByVariant.get(binding.canonicalVariantId) ?? [];
    rows.push(binding);
    bindingsByVariant.set(binding.canonicalVariantId, rows);
  }
  return sortedKeys.map((listingKey) => {
    const entry = entryByListing.get(listingKey);
    if (
      !entry
      || entry.recipeStatus !== "MISSING"
      || entry.components.length < 1
      || entry.components.some(
        (component, index) =>
          component.componentIndex !== index
          || !component.targetCanonicalVariantId
          || !component.targetIdentity,
      )
    ) {
      fail(
        "ALL_COMPONENTS_RECIPE_LISTING_NOT_ELIGIBLE",
        `${listingKey} is not one missing contiguous exact-target recipe`,
      );
    }
    const components = entry.components.map((repairComponent) => {
      const canonicalVariantId = repairComponent.targetCanonicalVariantId!;
      const acquisitionTarget = targetByVariant.get(canonicalVariantId);
      const bindings = bindingsByVariant.get(canonicalVariantId) ?? [];
      const dependency = acquisitionTarget?.dependencies.find(
        (row) =>
          row.listingKey === listingKey
          && row.componentIndex === repairComponent.componentIndex
          && row.quantity === repairComponent.quantity,
      );
      if (
        !acquisitionTarget
        || acquisitionTarget.acquisitionLane !== "EXISTING_CANONICAL_BINDING"
        || acquisitionTarget.identityQuality.status !== "ACQUISITION_READY"
        || !dependency
        || bindings.length !== 1
        || bindings[0].decisionStatus !== "exact_confirmed"
      ) {
        fail(
          "ALL_COMPONENTS_RECIPE_COMPONENT_NOT_EXACT",
          `${listingKey}:${repairComponent.componentIndex}`,
        );
      }
      return {
        repairComponent,
        acquisitionTarget,
        canonicalBinding: bindings[0],
      };
    });
    return { entry, components };
  });
}

function planId(input: {
  sources: ProductTruthAllComponentsRecipeSources;
  listingKeys: readonly string[];
  createdAt: string;
}): string {
  return `ptacr-${productTruthOperationalSha256({
    schemaVersion: PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_PLAN_VERSION,
    databaseTargetFingerprint:
      input.sources.bridgeSnapshot.targetFingerprint,
    manifestSha256: input.sources.bridgeSnapshot.manifest.sha256,
    recipeRepairScopeSha256: input.sources.recipeRepairScopeSha256,
    componentScopeSha256: input.sources.componentScopeSha256,
    bridgeSnapshotSha256: input.sources.bridgeSnapshotSha256,
    standingPolicySha256: input.sources.standingPolicySha256,
    listingKeys: input.listingKeys,
    createdAt: input.createdAt,
  }).slice(0, 24)}`;
}

function expectedWrites(
  targets: readonly ProductTruthAllComponentsRecipeTarget[],
): ProductTruthAllComponentsRecipePlan["databaseWrites"] {
  const componentCount = targets.reduce(
    (sum, target) => sum + target.listingRecipeComponents.length,
    0,
  );
  return {
    maximumRows: targets.length * 3 + componentCount * 2,
    listingRecipes: targets.length,
    listingRecipeComponents: componentCount,
    skuCosts: targets.length,
    componentEvidence: componentCount,
    listingScopeLinks: targets.length,
  };
}

async function selectedContentObservation(input: {
  db: SqlReader;
  canonicalVariantId: string;
  donorProductId: string;
  variantDecisionId: string;
  createdAt: string;
}): Promise<Row | null> {
  const rows = (await input.db.execute({
    sql: `SELECT * FROM ProductContentObservation
          WHERE canonicalVariantId=?
            AND donorProductId=?
            AND variantDecisionId=?
            AND observedAt<=?
          ORDER BY observedAt DESC,createdAt DESC,id ASC`,
    args: [
      input.canonicalVariantId,
      input.donorProductId,
      input.variantDecisionId,
      input.createdAt,
    ],
  })).rows;
  return rows[0] ?? null;
}

async function buildTargetFromDatabase(input: {
  db: SqlReader;
  sources: ProductTruthAllComponentsRecipeSources;
  candidate: StaticCandidate;
  ordinal: number;
  planId: string;
  createdAt: string;
}): Promise<ProductTruthAllComponentsRecipeTarget> {
  const { entry } = input.candidate;
  const scope = (await input.db.execute({
    sql: "SELECT * FROM ProductTruthListingScope WHERE listingKey=?",
    args: [entry.listingKey],
  })).rows[0];
  if (
    !scope
    || scope.registrationKind !== "AUTHORITATIVE_PHASE1_MANIFEST"
    || scope.manifestSha256 !== input.sources.bridgeSnapshot.manifest.sha256
    || scope.channel !== entry.channel
    || Number(scope.storeIndex) !== entry.storeIndex
    || scope.sku !== entry.sku
  ) {
    fail(
      "ALL_COMPONENTS_RECIPE_LISTING_SCOPE_INVALID",
      entry.listingKey,
    );
  }
  const recipeComponents = [];
  const componentSources = [];
  const costComponentDrafts: CostComponentDraft[] = [];
  for (const component of input.candidate.components) {
    const binding = component.canonicalBinding;
    const decision = (await input.db.execute({
      sql: "SELECT * FROM DonorProductVariantDecision WHERE id=?",
      args: [binding.decisionId],
    })).rows[0];
    const donor = (await input.db.execute({
      sql: "SELECT * FROM DonorProduct WHERE id=?",
      args: [binding.donorProductId],
    })).rows[0];
    const variant = (await input.db.execute({
      sql: "SELECT * FROM CanonicalProductVariant WHERE id=?",
      args: [binding.canonicalVariantId],
    })).rows[0];
    if (
      !decision
      || !donor
      || !variant
      || decision.donorProductId !== binding.donorProductId
      || decision.canonicalVariantId !== binding.canonicalVariantId
      || decision.decisionStatus !== "exact_confirmed"
      || decision.matcherVersion !== CANONICAL_PRODUCT_MATCHER_VERSION
      || decision.matcherImplementationSha256
        !== CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256
      || decision.matcherReleaseSha256
        !== CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256
      || donor.identityStatus !== "exact_confirmed"
      || variant.identityJson
        !== component.acquisitionTarget.canonicalIdentityJson
      || variant.identityHash
        !== component.acquisitionTarget.canonicalIdentityHash
    ) {
      fail(
        "ALL_COMPONENTS_RECIPE_EXACT_BINDING_INVALID",
        `${entry.listingKey}:${component.repairComponent.componentIndex}`,
      );
    }
    const content = await selectedContentObservation({
      db: input.db,
      canonicalVariantId: binding.canonicalVariantId,
      donorProductId: binding.donorProductId,
      variantDecisionId: binding.decisionId,
      createdAt: input.createdAt,
    });
    const source = {
      schemaVersion: PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_SOURCE_VERSION,
      recipeRepairScopeSha256: input.sources.recipeRepairScopeSha256,
      componentScopeSha256: input.sources.componentScopeSha256,
      bridgeSnapshotSha256: input.sources.bridgeSnapshotSha256,
      recipeRepairEntrySha256: productTruthOperationalSha256(entry),
      acquisitionTargetSha256: productTruthOperationalSha256(
        component.acquisitionTarget,
      ),
      canonicalBindingSha256: productTruthOperationalSha256(binding),
      canonicalBinding: binding,
      legacyComponentId: component.repairComponent.legacyComponentId,
      legacyDonorProductId:
        component.repairComponent.legacyDonorProductId,
      legacyDonorLinkIgnored: true,
      selectedIdentitySource: "CURRENT_CANONICAL_DONOR_BINDING",
      selectedContentObservationId: content ? String(content.id) : null,
      selectedContentObservationSha256: content
        ? rowSha(content, CONTENT_COLUMNS)
        : null,
    };
    const targetIdentity = component.repairComponent.targetIdentity!;
    recipeComponents.push({
      componentIndex: component.repairComponent.componentIndex,
      quantity: component.repairComponent.quantity,
      product: exactText(
        targetIdentity.productLine,
        `${entry.listingKey}.productLine`,
      ),
      flavor: nullableText(targetIdentity.flavor),
      size: nullableText(targetIdentity.size),
      targetCanonicalVariantId: binding.canonicalVariantId,
      donorProductId: binding.donorProductId,
      variantDecisionId: binding.decisionId,
      sourceComponentId: null,
      sourceEvidence: source,
    });
    componentSources.push({
      componentIndex: component.repairComponent.componentIndex,
      targetCanonicalVariantId: binding.canonicalVariantId,
      acquisitionTargetSha256: productTruthOperationalSha256(
        component.acquisitionTarget,
      ),
      canonicalBindingSha256: productTruthOperationalSha256(binding),
      canonicalVariantSha256: rowSha(variant, VARIANT_COLUMNS),
      variantDecisionSha256: rowSha(decision, DECISION_COLUMNS),
      donorIdentitySha256: rowSha(donor, DONOR_IDENTITY_COLUMNS),
      contentObservationSha256: content
        ? rowSha(content, CONTENT_COLUMNS)
        : null,
    });
    costComponentDrafts.push({
      idx: component.repairComponent.componentIndex,
      product: exactText(
        targetIdentity.productLine,
        `${entry.listingKey}.productLine`,
      ),
      flavor: nullableText(targetIdentity.flavor),
      size: nullableText(targetIdentity.size),
      qty: component.repairComponent.quantity,
      perUnit: null,
      method: "price-reconciliation-pending",
      targetComparableUnitPrice: null,
      priceEvidenceStatus: "REJECT",
      targetCanonicalVariantId: binding.canonicalVariantId,
      contentCanonicalVariantId: content
        ? binding.canonicalVariantId
        : null,
      priceCanonicalVariantId: null,
      contentObservationId: content ? String(content.id) : null,
      priceEvidenceObservationId: null,
      contentDonorProductId: content ? binding.donorProductId : null,
      priceEvidenceDonorProductId: null,
      priceEvidenceOfferId: null,
      priceVariantDecisionId: null,
      matchTier: "EXACT_IDENTITY",
      matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
      matcherImplementationSha256:
        CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
    });
  }
  const recipeRepairEntrySha256 = productTruthOperationalSha256(entry);
  const componentAcquisitionTargetsSha256 = productTruthOperationalSha256(
    input.candidate.components.map((row) => row.acquisitionTarget),
  );
  const canonicalBindingsSha256 = productTruthOperationalSha256(
    input.candidate.components.map((row) => row.canonicalBinding),
  );
  const sourceBindingBase = {
    recipeRepairEntrySha256,
    componentAcquisitionTargetsSha256,
    canonicalBindingsSha256,
    listingScopeSha256: rowSha(scope, SCOPE_COLUMNS),
    components: componentSources,
  };
  const sourceGraphSha256 = productTruthOperationalSha256({
    schemaVersion: PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_SOURCE_VERSION,
    listingKey: entry.listingKey,
    ...sourceBindingBase,
  });
  const sourceBinding: ProductTruthAllComponentsRecipeSourceBinding = {
    ...sourceBindingBase,
    sourceGraphSha256,
  };
  const recipe = buildProductTruthListingRecipeMaterialization({
    listingKey: entry.listingKey,
    manifestSha256: input.sources.bridgeSnapshot.manifest.sha256,
    sourceKind: "LEGACY_BRIDGE",
    sourceArtifactSha256: sourceGraphSha256,
    effectiveAt: input.createdAt,
    createdAt: input.createdAt,
    runId: input.planId,
    approvalId: input.sources.standingPolicy.policyId,
    components: recipeComponents,
  });
  const costEvidence = {
    schemaVersion: "product-truth-cogs-evidence/1.0.0",
    channel: entry.channel,
    storeIndex: entry.storeIndex,
    listingKey: entry.listingKey,
    listingKeyVersion: PRODUCT_TRUTH_LISTING_KEY_VERSION,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256:
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    evaluatedAt: input.createdAt,
    procurementZip: PRODUCT_TRUTH_PROCUREMENT_ZIP,
    sourcePolicy: {
      evidence: "all-components-exact-existing-catalog",
      paidCalls: 0,
      providerCalls: 0,
      pricePromotion: "DEFERRED_TO_CANONICAL_COGS_RECONCILER",
    },
    outcome: "UNSOURCEABLE",
    runId: input.planId,
    approvalId: input.sources.standingPolicy.policyId,
    recipeHash: recipe.recipe.recipeHash,
    components: costComponentDrafts,
  };
  const costEvidenceJson = canonicalJson(costEvidence);
  const costObservationKey = productTruthOperationalSha256({
    sku: entry.sku,
    listingKey: entry.listingKey,
    source: "retail:batch",
    recipeHash: recipe.recipe.recipeHash,
    evidenceHash: sha256Text(costEvidenceJson),
    evaluatedAt: input.createdAt,
    runId: input.planId,
    approvalId: input.sources.standingPolicy.policyId,
  });
  const skuCostId =
    `retail:${entry.sku}:all-components:${costObservationKey.slice(0, 24)}`;
  const componentEvidence =
    recipe.components.map((recipeComponent, index) => {
      const source = costComponentDrafts[index]!;
      const payload = {
        schemaVersion: "product-truth-sku-component-evidence/1.0.0",
        sourceEvidenceSchemaVersion:
          PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_PLAN_VERSION,
        evidenceStatus: "REJECT",
        targetCanonicalVariantId: source.targetCanonicalVariantId,
        contentCanonicalVariantId: source.contentCanonicalVariantId,
        priceCanonicalVariantId: null,
        contentObservationId: source.contentObservationId,
        priceObservationId: null,
        product: source.product,
        flavor: source.flavor,
        size: source.size,
        qty: source.qty,
        perUnit: null,
        method: "price-reconciliation-pending",
        targetComparableUnitPrice: null,
        matchTier: "EXACT_IDENTITY",
        matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
        matcherImplementationSha256:
          CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
        matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
        pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
        rejectionReasons: [
          "PRICE_EVIDENCE_NOT_PROMOTED_BY_RECIPE_MATERIALIZER",
        ],
        listingRecipeComponentId: recipeComponent.id,
        sourceGraphSha256,
      };
      const evidenceJson = canonicalJson(payload);
      const evidenceHash = sha256Text(evidenceJson);
      const evidenceKey = productTruthOperationalSha256({
        skuCostId,
        componentIndex: index,
        evidenceHash,
      });
      return {
        id: `sce:${evidenceKey}`,
        evidenceKey,
        skuCostId,
        componentIndex: index,
        evidenceStatus: "REJECT",
        targetCanonicalVariantId: source.targetCanonicalVariantId,
        contentCanonicalVariantId: source.contentCanonicalVariantId,
        priceCanonicalVariantId: null,
        contentObservationId: source.contentObservationId,
        priceObservationId: null,
        matchTier: "EXACT_IDENTITY",
        matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
        matcherImplementationSha256:
          CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
        matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
        pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
        evidenceHash,
        evidenceJson,
        createdAt: input.createdAt,
      } satisfies ProductTruthAllComponentsRecipeComponentEvidenceRow;
    });
  return {
    ordinal: input.ordinal,
    listingKey: entry.listingKey,
    channel: entry.channel,
    storeIndex: entry.storeIndex,
    sku: entry.sku,
    sourceBinding,
    listingRecipe: recipe.recipe,
    listingRecipeComponents: recipe.components,
    cost: {
      id: skuCostId,
      observationKey: costObservationKey,
      sku: entry.sku,
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
        "UNSOURCEABLE: exact recipe materialized; canonical saved-price reconciliation pending",
      recipeHash: recipe.recipe.recipeHash,
      evidenceJson: costEvidenceJson,
      evidenceOutcome: "UNSOURCEABLE",
      matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
      matcherImplementationSha256:
        CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
      runId: input.planId,
      approvalId: input.sources.standingPolicy.policyId,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
    componentEvidence,
    listingScopeLink: {
      skuCostId,
      listingKey: entry.listingKey,
      linkVersion: SKU_COST_LISTING_SCOPE_LINK_VERSION,
      createdAt: input.createdAt,
    },
  };
}

async function existingRecipeCount(
  db: SqlReader,
  listingKey: string,
): Promise<number> {
  const row = (await db.execute({
    sql: `SELECT COUNT(*) AS count FROM ProductTruthListingRecipe
          WHERE listingKey=?`,
    args: [listingKey],
  })).rows[0];
  return Number(row?.count ?? 0);
}

export async function planProductTruthAllComponentsRecipeMaterialization(input: {
  db: Client;
  sources: ProductTruthAllComponentsRecipeSources;
  listingKeys: readonly string[];
  createdAt: string;
  expiresAt: string;
}): Promise<ProductTruthAllComponentsRecipePlan> {
  const createdAt = canonicalInstant(input.createdAt, "createdAt");
  const expiresAt = canonicalInstant(input.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    fail("ALL_COMPONENTS_RECIPE_INPUT_INVALID", "expiresAt must follow createdAt");
  }
  const listingKeys = [...input.listingKeys].sort((left, right) =>
    left.localeCompare(right, "en-US"));
  const candidates = staticCandidates({
    sources: input.sources,
    listingKeys,
  });
  await assertProductTruthEvidenceSchema(input.db);
  await assertProductTruthListingScopeSchema(input.db);
  const currentPlanId = planId({
    sources: input.sources,
    listingKeys,
    createdAt,
  });
  const tx = await input.db.transaction("read");
  try {
    const targets = [];
    for (const [ordinal, candidate] of candidates.entries()) {
      if (await existingRecipeCount(tx, candidate.entry.listingKey)) {
        fail(
          "ALL_COMPONENTS_RECIPE_SCOPE_STALE",
          `${candidate.entry.listingKey} already has a canonical recipe`,
        );
      }
      targets.push(await buildTargetFromDatabase({
        db: tx,
        sources: input.sources,
        candidate,
        ordinal,
        planId: currentPlanId,
        createdAt,
      }));
    }
    const databaseWrites = expectedWrites(targets);
    if (
      databaseWrites.maximumRows > 100
      || databaseWrites.maximumRows
        > input.sources.standingPolicy.maximumDatabaseRowsPerWave
    ) {
      fail(
        "ALL_COMPONENTS_RECIPE_SCOPE_INVALID",
        "bounded wave exceeds standing-policy row ceiling",
      );
    }
    const targetsSha256 = productTruthOperationalSha256(targets);
    return {
      schemaVersion: PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_PLAN_VERSION,
      planId: currentPlanId,
      createdAt,
      expiresAt,
      databaseTargetFingerprint:
        input.sources.bridgeSnapshot.targetFingerprint,
      manifestSha256: input.sources.bridgeSnapshot.manifest.sha256,
      source: {
        recipeRepairScopeSha256: input.sources.recipeRepairScopeSha256,
        componentScopeSha256: input.sources.componentScopeSha256,
        bridgeSnapshotSha256: input.sources.bridgeSnapshotSha256,
        standingPolicySha256: input.sources.standingPolicySha256,
        standingPolicyId: input.sources.standingPolicy.policyId,
      },
      selectedListingKeys: listingKeys,
      targetsSha256,
      targets,
      databaseWrites,
      claims: {
        existingCatalogReused: true,
        legacyDonorLinksIgnored: true,
        everyComponentIndependentlyExact: true,
        priceEvidenceNotPromoted: true,
        initialCostOutcome: "UNSOURCEABLE",
        providerCalls: 0,
        paidCalls: 0,
        retailerFetches: 0,
        marketplaceMutations: 0,
        priceChanges: 0,
        inventoryChanges: 0,
        delisting: 0,
        procurementMutations: 0,
        consumerCutover: false,
      },
    };
  } finally {
    tx.close();
  }
}

export function renderProductTruthAllComponentsRecipePlan(
  value: ProductTruthAllComponentsRecipePlan,
): string {
  return canonicalJson(value);
}

export function renderProductTruthAllComponentsRecipePreflight(
  value: ProductTruthAllComponentsRecipePreflight,
): string {
  return canonicalJson(value);
}

export function renderProductTruthAllComponentsRecipeReport(
  value: ProductTruthAllComponentsRecipeReport,
): string {
  return canonicalJson(value);
}

function validatePlan(input: {
  plan: ProductTruthAllComponentsRecipePlan;
  planJson: string;
  planSha256: string;
  sources: ProductTruthAllComponentsRecipeSources;
}): StaticCandidate[] {
  validateSources(input.sources);
  const expectedClaims: ProductTruthAllComponentsRecipePlan["claims"] = {
    existingCatalogReused: true,
    legacyDonorLinksIgnored: true,
    everyComponentIndependentlyExact: true,
    priceEvidenceNotPromoted: true,
    initialCostOutcome: "UNSOURCEABLE",
    providerCalls: 0,
    paidCalls: 0,
    retailerFetches: 0,
    marketplaceMutations: 0,
    priceChanges: 0,
    inventoryChanges: 0,
    delisting: 0,
    procurementMutations: 0,
    consumerCutover: false,
  };
  const expectedPlanId = planId({
    sources: input.sources,
    listingKeys: input.plan.selectedListingKeys,
    createdAt: input.plan.createdAt,
  });
  if (
    input.plan.schemaVersion
      !== PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_PLAN_VERSION
    || renderProductTruthAllComponentsRecipePlan(input.plan)
      !== input.planJson
    || sha256Text(input.planJson)
      !== exactSha(input.planSha256, "planSha256")
    || input.plan.planId !== expectedPlanId
    || input.plan.databaseTargetFingerprint
      !== input.sources.bridgeSnapshot.targetFingerprint
    || input.plan.manifestSha256
      !== input.sources.bridgeSnapshot.manifest.sha256
    || input.plan.source.recipeRepairScopeSha256
      !== input.sources.recipeRepairScopeSha256
    || input.plan.source.componentScopeSha256
      !== input.sources.componentScopeSha256
    || input.plan.source.bridgeSnapshotSha256
      !== input.sources.bridgeSnapshotSha256
    || input.plan.source.standingPolicySha256
      !== input.sources.standingPolicySha256
    || input.plan.source.standingPolicyId
      !== input.sources.standingPolicy.policyId
    || productTruthOperationalSha256(input.plan.targets)
      !== input.plan.targetsSha256
    || canonicalJson(expectedWrites(input.plan.targets))
      !== canonicalJson(input.plan.databaseWrites)
    || input.plan.databaseWrites.maximumRows > 100
    || canonicalJson(input.plan.claims) !== canonicalJson(expectedClaims)
    || canonicalInstant(input.plan.createdAt, "plan.createdAt")
      !== input.plan.createdAt
    || canonicalInstant(input.plan.expiresAt, "plan.expiresAt")
      !== input.plan.expiresAt
  ) {
    fail(
      "ALL_COMPONENTS_RECIPE_PLAN_INVALID",
      "plan bytes or invariants differ",
    );
  }
  return staticCandidates({
    sources: input.sources,
    listingKeys: input.plan.selectedListingKeys,
  });
}

async function assertSourceBinding(input: {
  db: SqlReader;
  sources: ProductTruthAllComponentsRecipeSources;
  candidate: StaticCandidate;
  target: ProductTruthAllComponentsRecipeTarget;
  plan: ProductTruthAllComponentsRecipePlan;
}): Promise<void> {
  const rebuilt = await buildTargetFromDatabase({
    db: input.db,
    sources: input.sources,
    candidate: input.candidate,
    ordinal: input.target.ordinal,
    planId: input.plan.planId,
    createdAt: input.plan.createdAt,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(input.target)) {
    fail(
      "ALL_COMPONENTS_RECIPE_SOURCE_DRIFT",
      input.target.listingKey,
    );
  }
}

function assertEquivalent(
  actual: Row,
  expected: Record<string, unknown>,
  label: string,
): void {
  const mismatches = Object.entries(expected)
    .filter(([key, value]) =>
      canonicalJson(scalar(actual[key] ?? null)) !== canonicalJson(value))
    .map(([key]) => key);
  if (mismatches.length) {
    fail(
      "ALL_COMPONENTS_RECIPE_ROW_CONFLICT",
      `${label}: ${mismatches.join(",")}`,
    );
  }
}

async function exactOrAbsent(input: {
  db: SqlReader;
  table: string;
  where: string;
  args: InValue[];
  expected: Record<string, unknown>;
  label: string;
}): Promise<TargetState> {
  const rows = (await input.db.execute({
    sql: `SELECT * FROM "${input.table}" WHERE ${input.where}`,
    args: input.args,
  })).rows;
  if (!rows.length) return "ABSENT";
  if (rows.length !== 1) {
    fail("ALL_COMPONENTS_RECIPE_ROW_CONFLICT", `${input.label}: duplicate`);
  }
  assertEquivalent(rows[0], input.expected, input.label);
  return "EXACT";
}

async function targetState(
  db: SqlReader,
  target: ProductTruthAllComponentsRecipeTarget,
): Promise<TargetState> {
  const states: TargetState[] = [];
  states.push(await exactOrAbsent({
    db,
    table: "ProductTruthListingRecipe",
    where: "id=? OR recipeKey=? OR listingKey=?",
    args: [
      target.listingRecipe.id,
      target.listingRecipe.recipeKey,
      target.listingKey,
    ],
    expected: target.listingRecipe as unknown as Record<string, unknown>,
    label: `${target.listingKey}:recipe`,
  }));
  for (const component of target.listingRecipeComponents) {
    states.push(await exactOrAbsent({
      db,
      table: "ProductTruthListingRecipeComponent",
      where:
        "id=? OR componentKey=? OR (listingRecipeId=? AND componentIndex=?)",
      args: [
        component.id,
        component.componentKey,
        component.listingRecipeId,
        component.componentIndex,
      ],
      expected: component as unknown as Record<string, unknown>,
      label: `${target.listingKey}:recipe-component:${component.componentIndex}`,
    }));
  }
  states.push(await exactOrAbsent({
    db,
    table: "SkuCost",
    where: "id=? OR observationKey=?",
    args: [target.cost.id, target.cost.observationKey],
    expected: target.cost as unknown as Record<string, unknown>,
    label: `${target.listingKey}:cost`,
  }));
  for (const evidence of target.componentEvidence) {
    states.push(await exactOrAbsent({
      db,
      table: "SkuComponentEvidence",
      where:
        "id=? OR evidenceKey=? OR (skuCostId=? AND componentIndex=?)",
      args: [
        evidence.id,
        evidence.evidenceKey,
        evidence.skuCostId,
        evidence.componentIndex,
      ],
      expected: evidence as unknown as Record<string, unknown>,
      label: `${target.listingKey}:cost-component:${evidence.componentIndex}`,
    }));
  }
  states.push(await exactOrAbsent({
    db,
    table: "SkuCostListingScopeLink",
    where: "skuCostId=? OR (skuCostId=? AND listingKey=?)",
    args: [
      target.listingScopeLink.skuCostId,
      target.listingScopeLink.skuCostId,
      target.listingScopeLink.listingKey,
    ],
    expected: target.listingScopeLink as unknown as Record<string, unknown>,
    label: `${target.listingKey}:scope-link`,
  }));
  const exactCount = states.filter((state) => state === "EXACT").length;
  if (exactCount === 0) return "ABSENT";
  if (exactCount === states.length) return "EXACT";
  fail("ALL_COMPONENTS_RECIPE_PARTIAL_TARGET", target.listingKey);
}

async function foreignKeyViolations(db: SqlReader): Promise<string[]> {
  const rows = (await db.execute("PRAGMA foreign_key_check")).rows;
  return rows.map((row) => canonicalJson(
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, scalar(value)]),
    ),
  ).trim());
}

export async function preflightProductTruthAllComponentsRecipeMaterialization(
  input: {
    db: Client;
    databaseTargetFingerprint: string;
    plan: ProductTruthAllComponentsRecipePlan;
    planJson: string;
    planSha256: string;
    sources: ProductTruthAllComponentsRecipeSources;
    checkedAt: string;
  },
): Promise<ProductTruthAllComponentsRecipePreflight> {
  const candidates = validatePlan(input);
  const checkedAt = canonicalInstant(input.checkedAt, "checkedAt");
  if (
    input.databaseTargetFingerprint !== input.plan.databaseTargetFingerprint
    || Date.parse(checkedAt) < Date.parse(input.plan.createdAt)
    || Date.parse(checkedAt) > Date.parse(input.plan.expiresAt)
  ) {
    fail(
      "ALL_COMPONENTS_RECIPE_PREFLIGHT_INVALID",
      "database target or clock differs from the plan",
    );
  }
  await assertProductTruthEvidenceSchema(input.db);
  await assertProductTruthListingScopeSchema(input.db);
  const tx = await input.db.transaction("read");
  try {
    const targetStates = [];
    for (const [index, target] of input.plan.targets.entries()) {
      await assertSourceBinding({
        db: tx,
        sources: input.sources,
        candidate: candidates[index]!,
        target,
        plan: input.plan,
      });
      targetStates.push({
        listingKey: target.listingKey,
        state: await targetState(tx, target),
      });
    }
    const exactTargets = targetStates.filter(
      (row) => row.state === "EXACT",
    ).length;
    if (exactTargets !== 0 && exactTargets !== targetStates.length) {
      fail(
        "ALL_COMPONENTS_RECIPE_PARTIAL_WAVE",
        "wave is partially applied",
      );
    }
    const violations = await foreignKeyViolations(tx);
    if (violations.length) {
      fail(
        "ALL_COMPONENTS_RECIPE_FOREIGN_KEY_VIOLATION",
        violations.join(";"),
      );
    }
    const status = exactTargets === targetStates.length
      ? "ALREADY_APPLIED"
      : "READY_TO_APPLY";
    return {
      schemaVersion: PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_PREFLIGHT_VERSION,
      status,
      planId: input.plan.planId,
      planSha256: input.planSha256,
      databaseTargetFingerprint: input.databaseTargetFingerprint,
      standingPolicyId: input.sources.standingPolicy.policyId,
      standingPolicySha256: input.sources.standingPolicySha256,
      checkedAt,
      counts: {
        targets: input.plan.targets.length,
        maximumRows: input.plan.databaseWrites.maximumRows,
        absentRows: status === "READY_TO_APPLY"
          ? input.plan.databaseWrites.maximumRows
          : 0,
        exactExistingRows: status === "ALREADY_APPLIED"
          ? input.plan.databaseWrites.maximumRows
          : 0,
      },
      targetStates,
      foreignKeyViolations: [],
    };
  } finally {
    tx.close();
  }
}

function validateStandingAuthorization(input: {
  plan: ProductTruthAllComponentsRecipePlan;
  planSha256: string;
  sources: ProductTruthAllComponentsRecipeSources;
  preflight: ProductTruthAllComponentsRecipePreflight;
  preflightJson: string;
  preflightSha256: string;
  startedAt: string;
}): void {
  const { standingPolicy: policy } = input.sources;
  const startedAt = Date.parse(input.startedAt);
  const expiresAt = policy.expiresAt === null
    ? null
    : Date.parse(canonicalInstant(policy.expiresAt, "policy.expiresAt"));
  if (
    policy.approvedBy !== "owner"
    || Date.parse(canonicalInstant(policy.issuedAt, "policy.issuedAt"))
      > startedAt
    || (expiresAt !== null && startedAt > expiresAt)
    || policy.databaseTargetFingerprint
      !== input.plan.databaseTargetFingerprint
    || policy.manifestSha256 !== input.plan.manifestSha256
    || policy.maximumDatabaseRowsPerWave
      < input.plan.databaseWrites.maximumRows
    || policy.maximumDatabaseRowsPerWave > 100
    || policy.requiresCollisionFree !== true
    || policy.requiresFreshReadyToApplyPreflight !== true
    || input.preflight.schemaVersion
      !== PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_PREFLIGHT_VERSION
    || input.preflight.status !== "READY_TO_APPLY"
    || input.preflight.planId !== input.plan.planId
    || input.preflight.planSha256 !== input.planSha256
    || input.preflight.databaseTargetFingerprint
      !== input.plan.databaseTargetFingerprint
    || input.preflight.standingPolicyId !== policy.policyId
    || input.preflight.standingPolicySha256
      !== input.sources.standingPolicySha256
    || renderProductTruthAllComponentsRecipePreflight(input.preflight)
      !== input.preflightJson
    || sha256Text(input.preflightJson)
      !== exactSha(input.preflightSha256, "preflightSha256")
    || startedAt < Date.parse(input.preflight.checkedAt)
    || startedAt - Date.parse(input.preflight.checkedAt)
      > policy.maximumPreflightAgeMs
  ) {
    fail(
      "ALL_COMPONENTS_RECIPE_STANDING_AUTHORITY_INVALID",
      "fresh standing-policy-bound READY_TO_APPLY preflight is required",
    );
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

export async function applyProductTruthAllComponentsRecipeMaterialization(
  input: {
    db: Client;
    databaseTargetFingerprint: string;
    plan: ProductTruthAllComponentsRecipePlan;
    planJson: string;
    planSha256: string;
    sources: ProductTruthAllComponentsRecipeSources;
    preflight: ProductTruthAllComponentsRecipePreflight;
    preflightJson: string;
    preflightSha256: string;
    startedAt: string;
  },
): Promise<ProductTruthAllComponentsRecipeReport> {
  const candidates = validatePlan(input);
  const startedAt = canonicalInstant(input.startedAt, "startedAt");
  if (
    input.databaseTargetFingerprint !== input.plan.databaseTargetFingerprint
    || Date.parse(startedAt) < Date.parse(input.plan.createdAt)
    || Date.parse(startedAt) > Date.parse(input.plan.expiresAt)
  ) {
    fail(
      "ALL_COMPONENTS_RECIPE_APPLY_INVALID",
      "database target or clock differs from plan",
    );
  }
  validateStandingAuthorization({
    plan: input.plan,
    planSha256: input.planSha256,
    sources: input.sources,
    preflight: input.preflight,
    preflightJson: input.preflightJson,
    preflightSha256: input.preflightSha256,
    startedAt,
  });
  await assertProductTruthEvidenceSchema(input.db);
  await assertProductTruthListingScopeSchema(input.db);
  const tx = await input.db.transaction("write");
  try {
    const states = [];
    for (const [index, target] of input.plan.targets.entries()) {
      await assertSourceBinding({
        db: tx,
        sources: input.sources,
        candidate: candidates[index]!,
        target,
        plan: input.plan,
      });
      states.push(await targetState(tx, target));
    }
    if (
      canonicalJson(states)
      !== canonicalJson(input.preflight.targetStates.map((row) => row.state))
    ) {
      fail(
        "ALL_COMPONENTS_RECIPE_TRANSACTION_DRIFT",
        "database changed after preflight",
      );
    }
    for (const [index, target] of input.plan.targets.entries()) {
      if (states[index] === "EXACT") continue;
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
      await insertRow(tx, "SkuCost", target.cost as unknown as JsonRecord);
      if (await targetState(tx, target) !== "EXACT") {
        fail(
          "ALL_COMPONENTS_RECIPE_POSTCONDITION_FAILED",
          target.listingKey,
        );
      }
    }
    const violations = await foreignKeyViolations(tx);
    if (violations.length) {
      fail(
        "ALL_COMPONENTS_RECIPE_FOREIGN_KEY_VIOLATION",
        violations.join(";"),
      );
    }
    await tx.commit();
    const status = states.every((state) => state === "EXACT")
      ? "ALREADY_APPLIED"
      : "APPLIED";
    const completedAt = new Date().toISOString();
    return {
      schemaVersion: PRODUCT_TRUTH_ALL_COMPONENTS_RECIPE_REPORT_VERSION,
      status,
      planId: input.plan.planId,
      planSha256: input.planSha256,
      preflightSha256: input.preflightSha256,
      databaseTargetFingerprint: input.databaseTargetFingerprint,
      standingPolicyId: input.sources.standingPolicy.policyId,
      standingPolicySha256: input.sources.standingPolicySha256,
      startedAt,
      completedAt,
      counts: {
        targets: input.plan.targets.length,
        insertedRows: status === "APPLIED"
          ? input.plan.databaseWrites.maximumRows
          : 0,
        exactExistingRows: status === "ALREADY_APPLIED"
          ? input.plan.databaseWrites.maximumRows
          : 0,
        listingRecipes: input.plan.databaseWrites.listingRecipes,
        listingRecipeComponents:
          input.plan.databaseWrites.listingRecipeComponents,
        skuCosts: input.plan.databaseWrites.skuCosts,
        componentEvidence: input.plan.databaseWrites.componentEvidence,
        listingScopeLinks: input.plan.databaseWrites.listingScopeLinks,
      },
      verification: {
        listingKeys: input.plan.targets.map((target) => target.listingKey),
        recipeHashes: input.plan.targets.map(
          (target) => target.listingRecipe.recipeHash,
        ),
        costOutcomes: ["UNSOURCEABLE"],
        foreignKeyViolations: [],
        providerCalls: 0,
        paidCalls: 0,
        marketplaceMutations: 0,
        consumerCutoverChanged: false,
      },
    };
  } catch (error) {
    try {
      await tx.rollback();
    } catch {
      // Preserve the primary fail-closed error.
    }
    throw error;
  } finally {
    tx.close();
  }
}
