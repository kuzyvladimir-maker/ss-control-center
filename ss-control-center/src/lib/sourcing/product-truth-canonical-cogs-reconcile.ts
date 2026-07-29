import { createHash } from "node:crypto";

import type { Client, Row, Transaction } from "@libsql/client";

import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "./canonical-product-match-provenance";
import {
  evaluatePriceEvidenceEligibility,
  PRICE_EVIDENCE_POLICY_VERSION,
} from "./price-evidence-policy";
import {
  type ProductTruthLegacyBridgeStandingPolicy,
  PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION,
  renderProductTruthLegacyBridgeStandingPolicy,
} from "./product-truth-legacy-bridge-apply";
import {
  productTruthListingRecipeStructuralHash,
} from "./product-truth-listing-recipe";
import {
  SKU_COST_LISTING_SCOPE_LINK_VERSION,
} from "./product-truth-listing-scope";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  assertProductTruthEvidenceSchema,
  assertProductTruthListingScopeSchema,
} from "./product-truth-schema-gate";

export const PRODUCT_TRUTH_CANONICAL_COGS_RECONCILE_PLAN_VERSION =
  "product-truth-canonical-cogs-reconcile-plan/2.0.0" as const;
export const PRODUCT_TRUTH_CANONICAL_COGS_RECONCILE_PREFLIGHT_VERSION =
  "product-truth-canonical-cogs-reconcile-preflight/2.0.0" as const;
export const PRODUCT_TRUTH_CANONICAL_COGS_RECONCILE_REPORT_VERSION =
  "product-truth-canonical-cogs-reconcile-report/2.0.0" as const;
export const PRODUCT_TRUTH_CANONICAL_COGS_RECONCILE_MAX_LISTINGS = 33 as const;
export const PRODUCT_TRUTH_SAVED_PRICE_MAX_AGE_MS = 48 * 60 * 60 * 1_000;

const LISTING_RECIPE_MIGRATION_ID =
  "20260729010000_product_truth_listing_recipe";
const LISTING_RECIPE_MIGRATION_SHA256 =
  "1800ecf61715e1c61dbb9113c5e688dce2544002b3e564ea6f11f6f569b2acba";

type SqlReader = Pick<Client, "execute"> | Pick<Transaction, "execute">;
type JsonRecord = Record<string, unknown>;

const SCOPE_COLUMNS = [
  "listingKey", "keyVersion", "channel", "storeIndex", "sku",
  "registrationKind", "manifestSchemaVersion", "manifestSha256",
  "manifestAsOf", "ownerDecisionId", "sourceReportId",
  "sourceContentSha256", "sourceCapturedAt", "createdAt",
] as const;

const RECIPE_COLUMNS = [
  "id", "recipeKey", "listingKey", "recipeVersion", "recipeHash",
  "componentCount", "sourceKind", "sourceArtifactSha256", "manifestSha256",
  "evidenceHash", "evidenceJson", "effectiveAt", "runId", "approvalId",
  "createdAt",
] as const;

const RECIPE_COMPONENT_COLUMNS = [
  "id", "componentKey", "listingRecipeId", "componentIndex", "quantity",
  "product", "flavor", "size", "targetCanonicalVariantId", "donorProductId",
  "variantDecisionId", "sourceComponentId", "evidenceHash", "evidenceJson",
  "createdAt",
] as const;

const COST_COLUMNS = [
  "id", "sku", "asin", "effectiveDate", "productCost", "packagingCost",
  "iceCost", "totalCost", "costPerUnit", "packSize", "includesPackaging",
  "currency", "source", "confidence", "needsReview", "notes", "createdAt",
  "updatedAt", "observationKey", "recipeHash", "evidenceJson",
  "evidenceOutcome", "matcherVersion", "matcherImplementationSha256",
  "matcherReleaseSha256", "pricePolicyVersion", "runId", "approvalId",
] as const;

const COMPONENT_EVIDENCE_COLUMNS = [
  "id", "evidenceKey", "skuCostId", "componentIndex", "evidenceStatus",
  "targetCanonicalVariantId", "contentCanonicalVariantId",
  "priceCanonicalVariantId", "contentObservationId", "priceObservationId",
  "matchTier", "matcherVersion", "matcherImplementationSha256",
  "matcherReleaseSha256", "pricePolicyVersion", "evidenceHash",
  "evidenceJson", "createdAt",
] as const;

const CONTENT_OBSERVATION_COLUMNS = [
  "id", "observationKey", "donorProductId", "canonicalVariantId",
  "variantDecisionId", "sourceUrl", "sourceApi", "contentHash",
  "fieldHashesJson", "contentJson", "observedAt", "runId", "approvalId",
  "meteredReceiptId", "createdAt",
] as const;

const PRICE_OBSERVATION_COLUMNS = [
  "id", "observationKey", "donorOfferId", "donorProductId",
  "canonicalVariantId", "variantDecisionId", "retailer",
  "retailerProductId", "via", "title", "price", "packSizeSeen",
  "pricePerUnit", "currency", "zip", "localityEvidence", "inStock",
  "productUrl", "sellerName", "isFirstParty", "sourceApi", "observedAt",
  "runId", "approvalId", "meteredReceiptId", "createdAt",
] as const;

const DECISION_COLUMNS = [
  "id", "decisionKey", "donorProductId", "canonicalVariantId",
  "decisionStatus", "matcherVersion", "matcherImplementationSha256",
  "matcherReleaseSha256", "evidenceHash", "evidenceJson", "decidedAt",
  "runId", "approvalId", "createdAt",
] as const;

type CanonicalCogsMaterializationMode =
  | "CANONICALIZE_PRE_RECIPE_UNSOURCEABLE"
  | "PROMOTE_SAVED_EXACT_PRICE";

type CanonicalCostRow = {
  id: string;
  observationKey: string;
  sku: string;
  asin: null;
  effectiveDate: string;
  productCost: number | null;
  packagingCost: null;
  iceCost: null;
  totalCost: number | null;
  costPerUnit: number | null;
  packSize: number | null;
  includesPackaging: 0;
  currency: string;
  source: "retail:batch";
  confidence: number | null;
  needsReview: 0 | 1;
  notes: string;
  recipeHash: string;
  evidenceJson: string;
  evidenceOutcome: "FACT" | "UNSOURCEABLE";
  matcherVersion: string;
  matcherImplementationSha256: string;
  matcherReleaseSha256: string;
  pricePolicyVersion: string;
  runId: null;
  approvalId: null;
  createdAt: string;
  updatedAt: string;
};

type CanonicalComponentEvidenceRow = {
  id: string;
  evidenceKey: string;
  skuCostId: string;
  componentIndex: number;
  evidenceStatus: "FACT" | "REJECT";
  targetCanonicalVariantId: string;
  contentCanonicalVariantId: string | null;
  priceCanonicalVariantId: string | null;
  contentObservationId: string | null;
  priceObservationId: string | null;
  matchTier: string;
  matcherVersion: string;
  matcherImplementationSha256: string;
  matcherReleaseSha256: string;
  pricePolicyVersion: string;
  evidenceHash: string;
  evidenceJson: string;
  createdAt: string;
};

type CanonicalScopeLinkRow = {
  skuCostId: string;
  listingKey: string;
  linkVersion: string;
  createdAt: string;
};

export interface ProductTruthCanonicalCogsReconcileTarget {
  listingKey: string;
  sku: string;
  materializationMode: CanonicalCogsMaterializationMode;
  sourceCostId: string;
  listingRecipeId: string;
  listingRecipeHash: string;
  sourceBinding: {
    scopeSha256: string;
    recipeSha256: string;
    recipeComponentsSha256: string;
    sourceCostSha256: string;
    sourceComponentEvidenceSha256: string;
    sourceContentObservationsSha256: string;
    eligiblePriceObservationsSha256: string;
    eligiblePriceDecisionsSha256: string;
    selectedPriceObservationsSha256: string;
    selectedPriceDecisionsSha256: string;
    otherScopedCostsSha256: string;
    listingRecipeMigrationReceiptSha256: string;
    sourceGraphSha256: string;
  };
  cost: CanonicalCostRow;
  componentEvidence: CanonicalComponentEvidenceRow[];
  listingScopeLink: CanonicalScopeLinkRow;
}

export interface ProductTruthCanonicalCogsReconcilePlan {
  schemaVersion: typeof PRODUCT_TRUTH_CANONICAL_COGS_RECONCILE_PLAN_VERSION;
  planId: string;
  createdAt: string;
  expiresAt: string;
  databaseTargetFingerprint: string;
  manifestSha256: string;
  targetsSha256: string;
  targets: ProductTruthCanonicalCogsReconcileTarget[];
  databaseWrites: {
    maximumRows: number;
    skuCosts: number;
    componentEvidence: number;
    listingScopeLinks: number;
  };
  claims: {
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    marketplaceMutations: 0;
    priceChanges: 0;
    inventoryChanges: 0;
    delisting: 0;
    procurementMutations: 0;
    consumerCutover: false;
    mutatesExistingCanonicalEvidence: false;
    costOutcomes: Array<"FACT" | "UNSOURCEABLE">;
    savedEvidenceOnly: true;
  };
}

export interface ProductTruthCanonicalCogsReconcilePreflight {
  schemaVersion: typeof PRODUCT_TRUTH_CANONICAL_COGS_RECONCILE_PREFLIGHT_VERSION;
  status: "READY_TO_APPLY" | "ALREADY_APPLIED";
  planId: string;
  planSha256: string;
  databaseTargetFingerprint: string;
  checkedAt: string;
  counts: {
    targets: number;
    absentRows: number;
    exactExistingRows: number;
  };
  listingKeys: string[];
  foreignKeyViolations: string[];
}

export interface ProductTruthCanonicalCogsReconcileReport {
  schemaVersion: typeof PRODUCT_TRUTH_CANONICAL_COGS_RECONCILE_REPORT_VERSION;
  status: "APPLIED" | "ALREADY_APPLIED";
  planId: string;
  planSha256: string;
  databaseTargetFingerprint: string;
  standingPolicyId: string;
  standingPolicySha256: string;
  preflightReportSha256: string;
  startedAt: string;
  completedAt: string;
  counts: {
    targets: number;
    insertedRows: number;
    exactExistingRows: number;
    skuCosts: number;
    componentEvidence: number;
    listingScopeLinks: number;
  };
  verification: {
    listingKeys: string[];
    costIds: string[];
    recipeHashes: string[];
    costOutcomes: Array<"FACT" | "UNSOURCEABLE">;
    foreignKeyViolations: string[];
    providerCalls: 0;
    paidCalls: 0;
    marketplaceMutations: 0;
    consumerCutoverChanged: false;
  };
}

export class ProductTruthCanonicalCogsReconcileError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(`${code}: ${message}`, { cause });
    this.name = "ProductTruthCanonicalCogsReconcileError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthCanonicalCogsReconcileError(code, message, cause);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("CANONICAL_COGS_INPUT_INVALID", `${label} must be SHA-256`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    fail("CANONICAL_COGS_INPUT_INVALID", `${label} must be canonical UTC`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return renderProductTruthOperationalJson(value);
}

function jsonObject(value: unknown, label: string): JsonRecord {
  if (typeof value !== "string") {
    fail("CANONICAL_COGS_SOURCE_INVALID", `${label} JSON is missing`);
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("CANONICAL_COGS_SOURCE_INVALID", `${label} must be an object`);
    }
    return parsed as JsonRecord;
  } catch (error) {
    if (error instanceof ProductTruthCanonicalCogsReconcileError) throw error;
    fail("CANONICAL_COGS_SOURCE_INVALID", `${label} is invalid JSON`, error);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail("CANONICAL_COGS_SOURCE_INVALID", `${label} is missing`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    fail("CANONICAL_COGS_SOURCE_INVALID", `${label} must be an integer`);
  }
  return parsed;
}

function positiveNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail("CANONICAL_COGS_SOURCE_INVALID", `${label} must be positive`);
  }
  return parsed;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function projection<T extends readonly string[]>(
  row: Row,
  columns: T,
): Record<T[number], unknown> {
  return Object.fromEntries(
    columns.map((column) => [column, row[column]]),
  ) as Record<T[number], unknown>;
}

function rowSha<T extends readonly string[]>(row: Row, columns: T): string {
  return productTruthOperationalSha256(projection(row, columns));
}

function assertExactRow(
  actual: Row,
  expected: Record<string, unknown>,
  code: string,
): void {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key];
    if (canonicalJson(actualValue) !== canonicalJson(expectedValue)) {
      fail(code, `${key} differs`);
    }
  }
}

async function foreignKeyViolations(db: SqlReader): Promise<string[]> {
  const rows = (await db.execute("PRAGMA foreign_key_check")).rows;
  return rows.map((row) =>
    `${String(row.table)}:${String(row.rowid)}:${String(row.parent)}`);
}

function expectedDatabaseWrites(
  targets: readonly ProductTruthCanonicalCogsReconcileTarget[],
): ProductTruthCanonicalCogsReconcilePlan["databaseWrites"] {
  const componentEvidence = targets.reduce(
    (sum, target) => sum + target.componentEvidence.length,
    0,
  );
  return {
    maximumRows: targets.length * 2 + componentEvidence,
    skuCosts: targets.length,
    componentEvidence,
    listingScopeLinks: targets.length,
  };
}

function canonicalMatcherTuple(row: Row, label: string): void {
  if (
    row.matcherVersion !== CANONICAL_PRODUCT_MATCHER_VERSION
    || row.matcherImplementationSha256
      !== CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256
    || row.matcherReleaseSha256 !== CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256
  ) {
    fail("CANONICAL_COGS_SOURCE_INVALID", `${label} matcher tuple is stale`);
  }
}

function canonicalRetailer(value: unknown): "walmart" | "target" | "publix" | null {
  const normalized = String(value ?? "").toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[\s_-]+/g, "")
    .trim();
  return normalized === "walmart"
    || normalized === "target"
    || normalized === "publix"
    ? normalized
    : null;
}

function eligibleSavedPriceObservation(
  row: Row,
  input: {
    targetCanonicalVariantId: string;
    planCreatedAt: string;
  },
): boolean {
  const observedAt = Date.parse(String(row.observedAt ?? ""));
  const planCreatedAt = Date.parse(input.planCreatedAt);
  const pricePerUnit = Number(row.pricePerUnit);
  const packSizeSeen = Number(row.packSizeSeen);
  const decision = evaluatePriceEvidenceEligibility({
    retailer: nullableText(row.retailer),
    via: nullableText(row.via),
    price: Number.isFinite(pricePerUnit) ? pricePerUnit : null,
    isFirstParty: bool(row.isFirstParty),
    inStock: bool(row.inStock),
    zip: nullableText(row.zip),
    localityEvidence: nullableText(row.localityEvidence),
    fetchedAt: nullableText(row.observedAt),
    matchVerdict: "EXACT_IDENTITY",
  }, {
    now: input.planCreatedAt,
    maxAgeMs: PRODUCT_TRUTH_SAVED_PRICE_MAX_AGE_MS,
  });
  return (
    row.canonicalVariantId === input.targetCanonicalVariantId
    && row.via === "direct"
    && canonicalRetailer(row.retailer) !== null
    && decision.eligibility === "FACT"
    && Number.isFinite(pricePerUnit)
    && pricePerUnit > 0
    && Number.isInteger(packSizeSeen)
    && packSizeSeen === 1
    && row.currency === "USD"
    && nullableText(row.productUrl) !== null
    && nullableText(row.sourceApi) !== null
    && Number.isFinite(observedAt)
    && observedAt <= planCreatedAt
    && planCreatedAt - observedAt <= PRODUCT_TRUTH_SAVED_PRICE_MAX_AGE_MS
  );
}

function savedPriceOrder(left: Row, right: Row): number {
  const priceDelta = positiveNumber(left.pricePerUnit, "left pricePerUnit")
    - positiveNumber(right.pricePerUnit, "right pricePerUnit");
  if (Math.abs(priceDelta) > 0.000001) return priceDelta;
  const retailerOrder = ["walmart", "target", "publix"];
  const retailerDelta = retailerOrder.indexOf(canonicalRetailer(left.retailer)!)
    - retailerOrder.indexOf(canonicalRetailer(right.retailer)!);
  if (retailerDelta !== 0) return retailerDelta;
  const observedDelta = Date.parse(String(right.observedAt))
    - Date.parse(String(left.observedAt));
  if (observedDelta !== 0) return observedDelta;
  return String(left.id).localeCompare(String(right.id), "en-US");
}

async function savedPriceCandidates(
  db: SqlReader,
  input: {
    targetCanonicalVariantId: string;
    planCreatedAt: string;
  },
): Promise<{ eligible: Row[]; selected: Row; decisions: Row[] }> {
  const rows = (await db.execute({
    sql: `SELECT observation.*
          FROM DonorOfferObservation observation
          WHERE observation.canonicalVariantId=?
            AND observation.observedAt<=?
          ORDER BY observation.observedAt DESC,observation.id`,
    args: [input.targetCanonicalVariantId, input.planCreatedAt],
  })).rows;
  const latestByOffer = new Map<string, Row>();
  for (const row of rows) {
    const offerId = text(row.donorOfferId, "price donorOfferId");
    if (!latestByOffer.has(offerId)) latestByOffer.set(offerId, row);
  }
  const eligible = [...latestByOffer.values()]
    .filter((row) => eligibleSavedPriceObservation(row, input))
    .sort(savedPriceOrder);
  if (!eligible.length) {
    fail(
      "CANONICAL_COGS_SAVED_PRICE_MISSING",
      input.targetCanonicalVariantId,
    );
  }
  const decisions: Row[] = [];
  for (const row of eligible) {
    const decision = (await db.execute({
      sql: `SELECT * FROM DonorProductVariantDecision WHERE id=?`,
      args: [text(row.variantDecisionId, "price variantDecisionId")],
    })).rows[0];
    if (
      !decision
      || decision.donorProductId !== row.donorProductId
      || decision.canonicalVariantId !== input.targetCanonicalVariantId
      || decision.decisionStatus !== "exact_confirmed"
    ) {
      fail(
        "CANONICAL_COGS_SAVED_PRICE_DECISION_INVALID",
        String(row.id),
      );
    }
    canonicalMatcherTuple(decision, `price decision ${String(row.id)}`);
    decisions.push(decision);
  }
  return { eligible, selected: eligible[0], decisions };
}

function sourceCostIdFromRecipeComponents(rows: readonly Row[]): string {
  const ids = rows.map((row, index) => {
    const evidence = jsonObject(
      row.evidenceJson,
      `recipe component ${index} evidence`,
    );
    const sourceEvidence = evidence.sourceEvidence;
    if (!sourceEvidence || typeof sourceEvidence !== "object"
      || Array.isArray(sourceEvidence)) {
      fail(
        "CANONICAL_COGS_SOURCE_INVALID",
        `recipe component ${index} source evidence is missing`,
      );
    }
    return text(
      (sourceEvidence as JsonRecord).skuCostId,
      `recipe component ${index} source cost`,
    );
  });
  if (new Set(ids).size !== 1) {
    fail(
      "CANONICAL_COGS_SOURCE_INVALID",
      "recipe components do not share one source cost graph",
    );
  }
  return ids[0];
}

async function buildTargetFromDatabase(
  db: SqlReader,
  input: {
    listingKey: string;
    manifestSha256: string;
    databaseTargetFingerprint: string;
    planCreatedAt: string;
  },
): Promise<ProductTruthCanonicalCogsReconcileTarget> {
  const scope = (await db.execute({
    sql: "SELECT * FROM ProductTruthListingScope WHERE listingKey=?",
    args: [input.listingKey],
  })).rows[0];
  if (
    !scope
    || scope.registrationKind !== "AUTHORITATIVE_PHASE1_MANIFEST"
    || scope.manifestSha256 !== input.manifestSha256
  ) {
    fail(
      "CANONICAL_COGS_SCOPE_INVALID",
      `${input.listingKey} is not in the authoritative manifest`,
    );
  }
  const recipes = (await db.execute({
    sql: `SELECT * FROM ProductTruthListingRecipe
          WHERE listingKey=?
          ORDER BY effectiveAt DESC,createdAt DESC,id DESC`,
    args: [input.listingKey],
  })).rows;
  if (!recipes.length) {
    fail("CANONICAL_COGS_RECIPE_MISSING", input.listingKey);
  }
  const recipe = recipes[0];
  if (
    recipe.manifestSha256 !== input.manifestSha256
    || recipe.recipeVersion !== "product-truth-listing-recipe/1.0.0"
    || typeof recipe.recipeHash !== "string"
    || !/^[a-f0-9]{64}$/.test(recipe.recipeHash)
  ) {
    fail("CANONICAL_COGS_RECIPE_INVALID", input.listingKey);
  }
  const recipeComponents = (await db.execute({
    sql: `SELECT * FROM ProductTruthListingRecipeComponent
          WHERE listingRecipeId=? ORDER BY componentIndex`,
    args: [recipe.id as string],
  })).rows;
  if (
    !recipeComponents.length
    || integer(recipe.componentCount, "recipe componentCount")
      !== recipeComponents.length
    || recipeComponents.some(
      (row, index) => integer(row.componentIndex, "recipe componentIndex") !== index,
    )
  ) {
    fail("CANONICAL_COGS_RECIPE_INVALID", `${input.listingKey} component set`);
  }
  const structuralHash = productTruthListingRecipeStructuralHash({
    listingKey: input.listingKey,
    components: recipeComponents.map((row, index) => ({
      componentIndex: index,
      quantity: integer(row.quantity, `recipe component ${index} quantity`),
      targetCanonicalVariantId: text(
        row.targetCanonicalVariantId,
        `recipe component ${index} variant`,
      ),
    })),
  });
  if (structuralHash !== recipe.recipeHash) {
    fail("CANONICAL_COGS_RECIPE_INVALID", `${input.listingKey} structural hash`);
  }
  const planCreatedAt = canonicalInstant(input.planCreatedAt, "planCreatedAt");
  const scopedCosts = (await db.execute({
    sql: `SELECT cost.*
          FROM SkuCostListingScopeLink link
          JOIN SkuCost cost ON cost.id=link.skuCostId
          WHERE link.listingKey=? AND cost.createdAt<?
          ORDER BY cost.effectiveDate DESC,cost.createdAt DESC,cost.id DESC`,
    args: [input.listingKey, planCreatedAt],
  })).rows;
  const currentRecipeCosts = scopedCosts.filter(
    (row) => row.recipeHash === recipe.recipeHash,
  );
  const currentRecipeCost = currentRecipeCosts[0] ?? null;
  if (
    currentRecipeCost !== null
    && currentRecipeCost.evidenceOutcome !== "UNSOURCEABLE"
  ) {
    fail(
      "CANONICAL_COGS_ALREADY_MATERIALIZED",
      `${input.listingKey} current recipe already has ${String(
        currentRecipeCost.evidenceOutcome,
      )}`,
    );
  }
  const materializationMode: CanonicalCogsMaterializationMode =
    currentRecipeCost === null
      ? "CANONICALIZE_PRE_RECIPE_UNSOURCEABLE"
      : "PROMOTE_SAVED_EXACT_PRICE";
  const sourceCostId = currentRecipeCost === null
    ? sourceCostIdFromRecipeComponents(recipeComponents)
    : text(currentRecipeCost.id, "current recipe source cost id");
  const sourceCost = scopedCosts.find((row) => row.id === sourceCostId);
  if (!sourceCost) {
    fail("CANONICAL_COGS_SOURCE_COST_MISSING", sourceCostId);
  }
  canonicalMatcherTuple(sourceCost, "source cost");
  const sourceCostEvidence = jsonObject(
    sourceCost.evidenceJson,
    "source cost evidence",
  );
  const sourceEffectiveDate = canonicalInstant(
    sourceCost.effectiveDate,
    "source cost effectiveDate",
  );
  const sourceCreatedAt = canonicalInstant(
    sourceCost.createdAt,
    "source cost createdAt",
  );
  if (
    sourceCost.sku !== scope.sku
    || sourceCost.source !== "retail:batch"
    || sourceCost.evidenceOutcome !== "UNSOURCEABLE"
    || sourceCostEvidence.outcome !== "UNSOURCEABLE"
    || sourceCostEvidence.listingKey !== input.listingKey
    || sourceCostEvidence.channel !== scope.channel
    || integer(sourceCostEvidence.storeIndex, "source storeIndex")
      !== integer(scope.storeIndex, "scope storeIndex")
    || sourceCost.productCost !== null
    || sourceCost.totalCost !== null
    || sourceCost.costPerUnit !== null
    || (
      materializationMode === "CANONICALIZE_PRE_RECIPE_UNSOURCEABLE"
      && sourceCost.recipeHash === recipe.recipeHash
    )
    || (
      materializationMode === "PROMOTE_SAVED_EXACT_PRICE"
      && sourceCost.recipeHash !== recipe.recipeHash
    )
  ) {
    fail(
      "CANONICAL_COGS_SOURCE_COST_INVALID",
      `${input.listingKey} is not an eligible UNSOURCEABLE graph`,
    );
  }
  const migrationReceipt = (await db.execute({
    sql: `SELECT migrationId,migrationSha256,targetFingerprint,action,appliedAt
          FROM ProductTruthMigrationReceipt WHERE migrationId=?`,
    args: [LISTING_RECIPE_MIGRATION_ID],
  })).rows[0];
  if (
    !migrationReceipt
    || migrationReceipt.migrationSha256 !== LISTING_RECIPE_MIGRATION_SHA256
    || migrationReceipt.targetFingerprint !== input.databaseTargetFingerprint
    || migrationReceipt.action !== "applied"
    || (
      materializationMode === "CANONICALIZE_PRE_RECIPE_UNSOURCEABLE"
      && Date.parse(sourceCreatedAt)
        >= Date.parse(canonicalInstant(
          migrationReceipt.appliedAt,
          "listing recipe migration appliedAt",
        ))
    )
  ) {
    fail(
      "CANONICAL_COGS_MIGRATION_RECEIPT_INVALID",
      "source cost is not proven to predate the recipe migration",
    );
  }
  const sourceEvidenceRows = (await db.execute({
    sql: `SELECT * FROM SkuComponentEvidence
          WHERE skuCostId=? ORDER BY componentIndex`,
    args: [sourceCostId],
  })).rows;
  if (sourceEvidenceRows.length !== recipeComponents.length) {
    fail(
      "CANONICAL_COGS_SOURCE_COMPONENT_SET_INVALID",
      input.listingKey,
    );
  }
  const sourceContentRows: Array<Row | null> = [];
  for (let index = 0; index < sourceEvidenceRows.length; index += 1) {
    const sourceRow = sourceEvidenceRows[index];
    const contentObservationId = nullableText(sourceRow.contentObservationId);
    if (contentObservationId === null) {
      if (sourceRow.contentCanonicalVariantId !== null) {
        fail(
          "CANONICAL_COGS_SOURCE_COMPONENT_INVALID",
          `${input.listingKey}:${index} content binding`,
        );
      }
      sourceContentRows.push(null);
      continue;
    }
    const contentRows = (await db.execute({
      sql: "SELECT * FROM ProductContentObservation WHERE id=?",
      args: [contentObservationId],
    })).rows;
    if (
      contentRows.length !== 1
      || contentRows[0].canonicalVariantId
        !== sourceRow.contentCanonicalVariantId
    ) {
      fail(
        "CANONICAL_COGS_SOURCE_COMPONENT_INVALID",
        `${input.listingKey}:${index} content observation`,
      );
    }
    sourceContentRows.push(contentRows[0]);
  }

  const priceSelections = materializationMode === "PROMOTE_SAVED_EXACT_PRICE"
    ? await Promise.all(recipeComponents.map((row) =>
      savedPriceCandidates(db, {
        targetCanonicalVariantId: text(
          row.targetCanonicalVariantId,
          "recipe targetCanonicalVariantId",
        ),
        planCreatedAt,
      })))
    : recipeComponents.map(() => null);
  const createdAt = planCreatedAt;
  const newComponentEvidence: CanonicalComponentEvidenceRow[] =
    sourceEvidenceRows.map((sourceRow, index) => {
      const recipeComponent = recipeComponents[index];
      const sourcePayload = jsonObject(
        sourceRow.evidenceJson,
        `source component ${index} evidence`,
      );
      canonicalMatcherTuple(sourceRow, `source component ${index}`);
      const quantity = integer(
        sourcePayload.qty,
        `source component ${index} quantity`,
      );
      const targetCanonicalVariantId = text(
        recipeComponent.targetCanonicalVariantId,
        `recipe component ${index} variant`,
      );
      const product = text(
        recipeComponent.product,
        `recipe component ${index} product`,
      );
      const flavor = nullableText(recipeComponent.flavor);
      const size = nullableText(recipeComponent.size);
      const contentCanonicalVariantId =
        nullableText(sourceRow.contentCanonicalVariantId);
      const contentObservationId = nullableText(sourceRow.contentObservationId);
      const contentObservation = sourceContentRows[index];
      const contentDonorProductId = contentObservation === null
        ? null
        : text(
          contentObservation.donorProductId,
          `source component ${index} content donor`,
        );
      const priceSelection = priceSelections[index];
      const selectedPrice = priceSelection?.selected ?? null;
      const selectedPriceDecision = selectedPrice === null
        ? null
        : priceSelection!.decisions[
          priceSelection!.eligible.findIndex((row) => row.id === selectedPrice.id)
        ];
      const evidenceStatus = selectedPrice === null ? "REJECT" : "FACT";
      const priceCanonicalVariantId = selectedPrice === null
        ? null
        : text(
          selectedPrice.canonicalVariantId,
          `selected price ${index} canonicalVariantId`,
        );
      const priceObservationId = selectedPrice === null
        ? null
        : text(selectedPrice.id, `selected price ${index} id`);
      const perUnit = selectedPrice === null
        ? null
        : positiveNumber(
          selectedPrice.pricePerUnit,
          `selected price ${index} pricePerUnit`,
        );
      if (
        integer(sourceRow.componentIndex, "source componentIndex") !== index
        || sourceRow.evidenceStatus !== "REJECT"
        || sourceRow.targetCanonicalVariantId !== targetCanonicalVariantId
        || sourceRow.priceCanonicalVariantId !== null
        || sourceRow.priceObservationId !== null
        || sourceRow.pricePolicyVersion !== PRICE_EVIDENCE_POLICY_VERSION
        || quantity !== integer(
          recipeComponent.quantity,
          `recipe component ${index} quantity`,
        )
        || text(sourcePayload.product, "source component product") !== product
        || nullableText(sourcePayload.flavor) !== flavor
        || nullableText(sourcePayload.size) !== size
        || (contentCanonicalVariantId === null)
          !== (contentObservationId === null)
        || (
          contentCanonicalVariantId !== null
          && contentCanonicalVariantId !== targetCanonicalVariantId
        )
        || sourceRow.evidenceHash !== sha256Text(String(sourceRow.evidenceJson))
        || (
          selectedPrice !== null
          && (
            priceCanonicalVariantId !== targetCanonicalVariantId
            || selectedPriceDecision === null
          )
        )
      ) {
        fail(
          "CANONICAL_COGS_SOURCE_COMPONENT_INVALID",
          `${input.listingKey}:${index}`,
        );
      }
      const payload = {
        schemaVersion: "product-truth-sku-component-evidence/1.0.0",
        sourceEvidenceSchemaVersion:
          "product-truth-saved-price-evidence/1.0.0",
        evidenceStatus,
        targetCanonicalVariantId,
        contentCanonicalVariantId,
        priceCanonicalVariantId,
        contentObservationId,
        contentDonorProductId,
        priceObservationId,
        priceEvidenceDonorProductId: selectedPrice === null
          ? null
          : text(selectedPrice.donorProductId, "price donorProductId"),
        priceEvidenceOfferId: selectedPrice === null
          ? null
          : text(selectedPrice.donorOfferId, "price donorOfferId"),
        priceVariantDecisionId: selectedPrice === null
          ? null
          : text(selectedPrice.variantDecisionId, "price variantDecisionId"),
        matchTier: selectedPrice === null
          ? text(sourceRow.matchTier, "source matchTier")
          : "EXACT_IDENTITY",
        matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
        matcherImplementationSha256:
          CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
        matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
        pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
        product,
        flavor,
        size,
        qty: quantity,
        perUnit,
        method: selectedPrice === null
          ? "no-fresh-first-party-price"
          : "exact",
        targetComparableUnitPrice: null,
        rejectionReasons: selectedPrice === null
          ? (
            Array.isArray(sourcePayload.rejectionReasons)
              ? sourcePayload.rejectionReasons
              : ["NO_ELIGIBLE_PRICE_WITHIN_24_HOURS"]
          )
          : [],
        selectedPrice: selectedPrice === null
          ? null
          : projection(selectedPrice, PRICE_OBSERVATION_COLUMNS),
        materialization: {
          schemaVersion:
            "product-truth-canonical-cogs-reconcile-source/2.0.0",
          materializationMode,
          sourceCostId,
          sourceComponentEvidenceId: String(sourceRow.id),
          sourceComponentEvidenceSha256: rowSha(
            sourceRow,
            COMPONENT_EVIDENCE_COLUMNS,
          ),
          listingRecipeId: String(recipe.id),
          listingRecipeHash: String(recipe.recipeHash),
          selectedPriceObservationSha256: selectedPrice === null
            ? null
            : rowSha(selectedPrice, PRICE_OBSERVATION_COLUMNS),
          selectedPriceDecisionSha256: selectedPriceDecision === null
            ? null
            : rowSha(selectedPriceDecision, DECISION_COLUMNS),
        },
      };
      const evidenceJson = canonicalJson(payload);
      const evidenceHash = sha256Text(evidenceJson);
      const evidenceKey = productTruthOperationalSha256({
        schemaVersion: "product-truth-canonical-cogs-component-key/2.0.0",
        listingKey: input.listingKey,
        sourceCostId,
        listingRecipeId: recipe.id,
        componentIndex: index,
        evidenceHash,
      });
      return {
        id: `sce:${evidenceKey}`,
        evidenceKey,
        skuCostId: "",
        componentIndex: index,
        evidenceStatus,
        targetCanonicalVariantId,
        contentCanonicalVariantId,
        priceCanonicalVariantId,
        contentObservationId,
        priceObservationId,
        matchTier: selectedPrice === null
          ? String(sourceRow.matchTier)
          : "EXACT_IDENTITY",
        matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
        matcherImplementationSha256:
          CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
        matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
        pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
        evidenceHash,
        evidenceJson,
        createdAt,
      };
    });

  const costComponents = newComponentEvidence.map((row, index) => {
    const payload = jsonObject(row.evidenceJson, `new component ${index}`);
    return {
      idx: index,
      product: payload.product,
      flavor: payload.flavor,
      size: payload.size,
      qty: payload.qty,
      perUnit: payload.perUnit,
      method: payload.method,
      targetCanonicalVariantId: row.targetCanonicalVariantId,
      contentCanonicalVariantId: row.contentCanonicalVariantId,
      priceCanonicalVariantId: row.priceCanonicalVariantId,
      contentObservationId: row.contentObservationId,
      priceEvidenceObservationId: row.priceObservationId,
      contentDonorProductId: payload.contentDonorProductId,
      priceEvidenceDonorProductId: payload.priceEvidenceDonorProductId,
      priceEvidenceOfferId: payload.priceEvidenceOfferId,
      priceVariantDecisionId: payload.priceVariantDecisionId,
      matchTier: row.matchTier,
      priceEvidenceStatus: row.evidenceStatus,
      matcherVersion: row.matcherVersion,
      matcherImplementationSha256: row.matcherImplementationSha256,
      matcherReleaseSha256: row.matcherReleaseSha256,
      pricePolicyVersion: row.pricePolicyVersion,
    };
  });
  const evaluatedAt = materializationMode === "PROMOTE_SAVED_EXACT_PRICE"
    ? canonicalInstant(
      priceSelections.map((selection) =>
        String(selection!.selected.observedAt)).sort().at(-1),
      "saved price evaluatedAt",
    )
    : canonicalInstant(
      sourceCostEvidence.evaluatedAt ?? sourceEffectiveDate,
      "source cost evaluatedAt",
    );
  const costOutcome = materializationMode === "PROMOTE_SAVED_EXACT_PRICE"
    ? "FACT"
    : "UNSOURCEABLE";
  const packSize = costOutcome === "FACT"
    ? costComponents.reduce(
      (sum, component) => sum + integer(component.qty, "component qty"),
      0,
    )
    : null;
  const productCost = costOutcome === "FACT"
    ? Math.round(costComponents.reduce(
      (sum, component) =>
        sum
        + positiveNumber(component.perUnit, "component perUnit")
          * integer(component.qty, "component qty"),
      0,
    ) * 100) / 100
    : null;
  const costPerUnit = productCost === null || packSize === null
    ? null
    : Math.round((productCost / packSize) * 100) / 100;
  const costEvidence = {
    schemaVersion: "product-truth-cogs-evidence/1.0.0",
    channel: scope.channel,
    storeIndex: integer(scope.storeIndex, "scope storeIndex"),
    listingKey: input.listingKey,
    listingKeyVersion: scope.keyVersion,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    evaluatedAt,
    procurementZip: sourceCostEvidence.procurementZip ?? "33765",
    sourcePolicy: {
      policyVersion: "product-truth-cost-source-policy/1.0.0",
      retailerAllowlist: ["walmart", "target", "publix"],
      allowClubRetailers: false,
      evidence: "saved-observations-only",
      maxPriceAgeMs: PRODUCT_TRUTH_SAVED_PRICE_MAX_AGE_MS,
      paidCalls: 0,
      providerCalls: 0,
    },
    outcome: costOutcome,
    recipeHash: String(recipe.recipeHash),
    ...(costOutcome === "FACT"
      ? {
          total: productCost,
          costPerUnit,
          packSize,
          lowIdentityConfidence: false,
          aboveSale: false,
        }
      : {}),
    runId: null,
    approvalId: null,
    components: costComponents,
    materialization: {
      schemaVersion: "product-truth-canonical-cogs-reconcile-source/2.0.0",
      materializationMode,
      sourceCostId,
      sourceObservationKey: sourceCost.observationKey,
      sourceCostSha256: rowSha(sourceCost, COST_COLUMNS),
      listingRecipeId: recipe.id,
      listingRecipeHash: recipe.recipeHash,
      preservesHistoricalEvaluationAt:
        materializationMode === "CANONICALIZE_PRE_RECIPE_UNSOURCEABLE",
      providerCalls: 0,
      paidCalls: 0,
    },
  };
  const evidenceJson = canonicalJson(costEvidence);
  const observationKey = productTruthOperationalSha256({
    schemaVersion: "product-truth-canonical-cogs-observation-key/2.0.0",
    listingKey: input.listingKey,
    sourceCostId,
    sourceObservationKey: sourceCost.observationKey,
    listingRecipeId: recipe.id,
    recipeHash: recipe.recipeHash,
    outcome: costOutcome,
    evaluatedAt,
    selectedPriceObservationIds: priceSelections.flatMap(
      (selection) => selection === null ? [] : [String(selection.selected.id)],
    ),
  });
  const costId =
    `retail:${String(scope.sku)}:recipe:${observationKey.slice(0, 24)}`;
  for (const row of newComponentEvidence) row.skuCostId = costId;

  const cost: CanonicalCostRow = {
    id: costId,
    observationKey,
    sku: String(scope.sku),
    asin: null,
    effectiveDate: materializationMode === "PROMOTE_SAVED_EXACT_PRICE"
      ? createdAt
      : sourceEffectiveDate,
    productCost,
    packagingCost: null,
    iceCost: null,
    totalCost: productCost,
    costPerUnit,
    packSize,
    includesPackaging: 0,
    currency: nullableText(sourceCost.currency) ?? "USD",
    source: "retail:batch",
    confidence: typeof sourceCost.confidence === "number"
      ? sourceCost.confidence
      : null,
    needsReview: costOutcome === "FACT" ? 0 : 1,
    notes: costOutcome === "FACT"
      ? "FACT: saved exact local first-party price evidence; zero provider calls"
      : "UNSOURCEABLE: canonical recipe reconciliation of sealed pre-migration evidence",
    recipeHash: String(recipe.recipeHash),
    evidenceJson,
    evidenceOutcome: costOutcome,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
    runId: null,
    approvalId: null,
    createdAt,
    updatedAt: createdAt,
  };
  const listingScopeLink: CanonicalScopeLinkRow = {
    skuCostId: costId,
    listingKey: input.listingKey,
    linkVersion: SKU_COST_LISTING_SCOPE_LINK_VERSION,
    createdAt,
  };

  const otherCosts = scopedCosts;
  const migrationReceiptProjection = projection(migrationReceipt, [
    "migrationId", "migrationSha256", "targetFingerprint", "action", "appliedAt",
  ]);
  const sourceBindingBase = {
    scopeSha256: rowSha(scope, SCOPE_COLUMNS),
    recipeSha256: rowSha(recipe, RECIPE_COLUMNS),
    recipeComponentsSha256: productTruthOperationalSha256(
      recipeComponents.map((row) => projection(row, RECIPE_COMPONENT_COLUMNS)),
    ),
    sourceCostSha256: rowSha(sourceCost, COST_COLUMNS),
    sourceComponentEvidenceSha256: productTruthOperationalSha256(
      sourceEvidenceRows.map(
        (row) => projection(row, COMPONENT_EVIDENCE_COLUMNS),
      ),
    ),
    sourceContentObservationsSha256: productTruthOperationalSha256(
      sourceContentRows.map((row) => row === null
        ? null
        : projection(row, CONTENT_OBSERVATION_COLUMNS)),
    ),
    eligiblePriceObservationsSha256: productTruthOperationalSha256(
      priceSelections.map((selection) => selection === null
        ? []
        : selection.eligible.map(
          (row) => projection(row, PRICE_OBSERVATION_COLUMNS),
        )),
    ),
    eligiblePriceDecisionsSha256: productTruthOperationalSha256(
      priceSelections.map((selection) => selection === null
        ? []
        : selection.decisions.map(
          (row) => projection(row, DECISION_COLUMNS),
        )),
    ),
    selectedPriceObservationsSha256: productTruthOperationalSha256(
      priceSelections.flatMap((selection) => selection === null
        ? []
        : [projection(selection.selected, PRICE_OBSERVATION_COLUMNS)]),
    ),
    selectedPriceDecisionsSha256: productTruthOperationalSha256(
      priceSelections.flatMap((selection) => {
        if (selection === null) return [];
        const selectedIndex = selection.eligible.findIndex(
          (row) => row.id === selection.selected.id,
        );
        return [projection(selection.decisions[selectedIndex], DECISION_COLUMNS)];
      }),
    ),
    otherScopedCostsSha256: productTruthOperationalSha256(
      otherCosts.map((row) => projection(row, COST_COLUMNS)),
    ),
    listingRecipeMigrationReceiptSha256:
      productTruthOperationalSha256(migrationReceiptProjection),
  };
  const sourceGraphSha256 = productTruthOperationalSha256({
    schemaVersion: "product-truth-canonical-cogs-source-graph/2.0.0",
    listingKey: input.listingKey,
    materializationMode,
    sourceCostId,
    listingRecipeId: recipe.id,
    ...sourceBindingBase,
  });
  return {
    listingKey: input.listingKey,
    sku: String(scope.sku),
    materializationMode,
    sourceCostId,
    listingRecipeId: String(recipe.id),
    listingRecipeHash: String(recipe.recipeHash),
    sourceBinding: { ...sourceBindingBase, sourceGraphSha256 },
    cost,
    componentEvidence: newComponentEvidence,
    listingScopeLink,
  };
}

export async function planProductTruthCanonicalCogsReconciliation(input: {
  db: Client;
  databaseTargetFingerprint: string;
  manifestSha256: string;
  listingKeys: readonly string[];
  createdAt: string;
  expiresAt: string;
}): Promise<ProductTruthCanonicalCogsReconcilePlan> {
  const databaseTargetFingerprint = exactSha(
    input.databaseTargetFingerprint,
    "databaseTargetFingerprint",
  );
  const manifestSha256 = exactSha(input.manifestSha256, "manifestSha256");
  const createdAt = canonicalInstant(input.createdAt, "createdAt");
  const expiresAt = canonicalInstant(input.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    fail("CANONICAL_COGS_INPUT_INVALID", "expiresAt must follow createdAt");
  }
  if (
    input.listingKeys.length < 1
    || input.listingKeys.length
      > PRODUCT_TRUTH_CANONICAL_COGS_RECONCILE_MAX_LISTINGS
    || new Set(input.listingKeys).size !== input.listingKeys.length
  ) {
    fail(
      "CANONICAL_COGS_SCOPE_INVALID",
      "1-33 explicit unique listing keys are required",
    );
  }
  const listingKeys = [...input.listingKeys].sort((left, right) =>
    left.localeCompare(right, "en-US"));
  await assertProductTruthEvidenceSchema(input.db);
  await assertProductTruthListingScopeSchema(input.db);
  const tx = await input.db.transaction("read");
  try {
    const targets = [];
    for (const listingKey of listingKeys) {
      targets.push(await buildTargetFromDatabase(tx, {
        listingKey,
        manifestSha256,
        databaseTargetFingerprint,
        planCreatedAt: createdAt,
      }));
    }
    const databaseWrites = expectedDatabaseWrites(targets);
    if (databaseWrites.maximumRows > 100) {
      fail(
        "CANONICAL_COGS_SCOPE_INVALID",
        "bounded standing-authority wave exceeds 100 rows",
      );
    }
    const targetsSha256 = productTruthOperationalSha256(targets);
    const costOutcomes = [...new Set(
      targets.map((target) => target.cost.evidenceOutcome),
    )].sort() as Array<"FACT" | "UNSOURCEABLE">;
    const planId = `ptcc-${productTruthOperationalSha256({
      databaseTargetFingerprint,
      manifestSha256,
      listingKeys,
      targetsSha256,
      createdAt,
    }).slice(0, 24)}`;
    return {
      schemaVersion: PRODUCT_TRUTH_CANONICAL_COGS_RECONCILE_PLAN_VERSION,
      planId,
      createdAt,
      expiresAt,
      databaseTargetFingerprint,
      manifestSha256,
      targetsSha256,
      targets,
      databaseWrites,
      claims: {
        providerCalls: 0,
        paidCalls: 0,
        retailerFetches: 0,
        marketplaceMutations: 0,
        priceChanges: 0,
        inventoryChanges: 0,
        delisting: 0,
        procurementMutations: 0,
        consumerCutover: false,
        mutatesExistingCanonicalEvidence: false,
        costOutcomes,
        savedEvidenceOnly: true,
      },
    };
  } finally {
    tx.close();
  }
}

export function renderProductTruthCanonicalCogsReconcilePlan(
  value: ProductTruthCanonicalCogsReconcilePlan,
): string {
  return canonicalJson(value);
}

export function renderProductTruthCanonicalCogsReconcilePreflight(
  value: ProductTruthCanonicalCogsReconcilePreflight,
): string {
  return canonicalJson(value);
}

export function renderProductTruthCanonicalCogsReconcileReport(
  value: ProductTruthCanonicalCogsReconcileReport,
): string {
  return canonicalJson(value);
}

function validatePlan(
  plan: ProductTruthCanonicalCogsReconcilePlan,
  planJson: string,
  planSha256: string,
): void {
  if (
    plan.schemaVersion !== PRODUCT_TRUTH_CANONICAL_COGS_RECONCILE_PLAN_VERSION
    || renderProductTruthCanonicalCogsReconcilePlan(plan) !== planJson
    || sha256Text(planJson) !== exactSha(planSha256, "planSha256")
    || exactSha(plan.databaseTargetFingerprint, "databaseTargetFingerprint")
      !== plan.databaseTargetFingerprint
    || exactSha(plan.manifestSha256, "manifestSha256") !== plan.manifestSha256
    || canonicalInstant(plan.createdAt, "createdAt") !== plan.createdAt
    || canonicalInstant(plan.expiresAt, "expiresAt") !== plan.expiresAt
    || Date.parse(plan.expiresAt) <= Date.parse(plan.createdAt)
    || plan.targets.length < 1
    || plan.targets.length
      > PRODUCT_TRUTH_CANONICAL_COGS_RECONCILE_MAX_LISTINGS
    || productTruthOperationalSha256(plan.targets) !== plan.targetsSha256
    || canonicalJson(plan.databaseWrites)
      !== canonicalJson(expectedDatabaseWrites(plan.targets))
    || plan.databaseWrites.maximumRows > 100
    || canonicalJson(plan.claims) !== canonicalJson({
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      marketplaceMutations: 0,
      priceChanges: 0,
      inventoryChanges: 0,
      delisting: 0,
      procurementMutations: 0,
      consumerCutover: false,
      mutatesExistingCanonicalEvidence: false,
      costOutcomes: [...new Set(
        plan.targets.map((target) => target.cost.evidenceOutcome),
      )].sort(),
      savedEvidenceOnly: true,
    })
  ) {
    fail("CANONICAL_COGS_PLAN_INVALID", "plan bytes or invariants differ");
  }
  const listingKeys = plan.targets.map((target) => target.listingKey);
  const sorted = [...listingKeys].sort((left, right) =>
    left.localeCompare(right, "en-US"));
  if (
    new Set(listingKeys).size !== listingKeys.length
    || canonicalJson(listingKeys) !== canonicalJson(sorted)
  ) {
    fail("CANONICAL_COGS_PLAN_INVALID", "targets are not canonical");
  }
}

async function assertSourceBinding(
  db: SqlReader,
  plan: ProductTruthCanonicalCogsReconcilePlan,
  target: ProductTruthCanonicalCogsReconcileTarget,
): Promise<void> {
  const rebuilt = await buildTargetFromDatabase(db, {
    listingKey: target.listingKey,
    manifestSha256: plan.manifestSha256,
    databaseTargetFingerprint: plan.databaseTargetFingerprint,
    planCreatedAt: plan.createdAt,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(target)) {
    fail(
      "CANONICAL_COGS_SOURCE_DRIFT",
      `${target.listingKey} source graph differs from the sealed plan`,
    );
  }
}

async function targetState(
  db: SqlReader,
  target: ProductTruthCanonicalCogsReconcileTarget,
): Promise<"ABSENT" | "EXACT"> {
  const costRows = (await db.execute({
    sql: "SELECT * FROM SkuCost WHERE id=? OR observationKey=?",
    args: [target.cost.id, target.cost.observationKey],
  })).rows;
  const linkRows = (await db.execute({
    sql: "SELECT * FROM SkuCostListingScopeLink WHERE skuCostId=?",
    args: [target.cost.id],
  })).rows;
  const evidenceRows = (await db.execute({
    sql: `SELECT * FROM SkuComponentEvidence
          WHERE skuCostId=? ORDER BY componentIndex`,
    args: [target.cost.id],
  })).rows;
  const present = costRows.length + linkRows.length + evidenceRows.length;
  const expected = 2 + target.componentEvidence.length;
  if (present === 0) {
    for (const row of target.componentEvidence) {
      const collision = (await db.execute({
        sql: "SELECT id FROM SkuComponentEvidence WHERE id=? OR evidenceKey=?",
        args: [row.id, row.evidenceKey],
      })).rows[0];
      if (collision) {
        fail(
          "CANONICAL_COGS_COMPONENT_COLLISION",
          `${target.listingKey}:${row.componentIndex}`,
        );
      }
    }
    return "ABSENT";
  }
  if (
    present !== expected
    || costRows.length !== 1
    || linkRows.length !== 1
    || evidenceRows.length !== target.componentEvidence.length
  ) {
    fail("CANONICAL_COGS_PARTIAL_GRAPH", target.listingKey);
  }
  assertExactRow(
    costRows[0],
    target.cost as unknown as Record<string, unknown>,
    "CANONICAL_COGS_COST_COLLISION",
  );
  assertExactRow(
    linkRows[0],
    target.listingScopeLink as unknown as Record<string, unknown>,
    "CANONICAL_COGS_SCOPE_LINK_COLLISION",
  );
  target.componentEvidence.forEach((expectedRow, index) => {
    assertExactRow(
      evidenceRows[index],
      expectedRow as unknown as Record<string, unknown>,
      "CANONICAL_COGS_COMPONENT_COLLISION",
    );
  });
  return "EXACT";
}

export async function preflightProductTruthCanonicalCogsReconciliation(input: {
  db: Client;
  databaseTargetFingerprint: string;
  plan: ProductTruthCanonicalCogsReconcilePlan;
  planJson: string;
  planSha256: string;
  checkedAt: string;
}): Promise<ProductTruthCanonicalCogsReconcilePreflight> {
  validatePlan(input.plan, input.planJson, input.planSha256);
  const checkedAt = canonicalInstant(input.checkedAt, "checkedAt");
  if (input.databaseTargetFingerprint !== input.plan.databaseTargetFingerprint) {
    fail("CANONICAL_COGS_DATABASE_TARGET_MISMATCH", "target differs from plan");
  }
  if (
    Date.parse(checkedAt) < Date.parse(input.plan.createdAt)
    || Date.parse(checkedAt) > Date.parse(input.plan.expiresAt)
  ) {
    fail("CANONICAL_COGS_PLAN_EXPIRED", "preflight is outside plan window");
  }
  await assertProductTruthEvidenceSchema(input.db);
  await assertProductTruthListingScopeSchema(input.db);
  const tx = await input.db.transaction("read");
  try {
    const states = [];
    for (const target of input.plan.targets) {
      await assertSourceBinding(tx, input.plan, target);
      states.push(await targetState(tx, target));
    }
    const exactTargets = states.filter((state) => state === "EXACT").length;
    if (exactTargets !== 0 && exactTargets !== input.plan.targets.length) {
      fail("CANONICAL_COGS_PARTIAL_WAVE", "wave is partially applied");
    }
    const violations = await foreignKeyViolations(tx);
    if (violations.length) {
      fail("CANONICAL_COGS_FOREIGN_KEY_VIOLATION", violations.join("; "));
    }
    const status = exactTargets === input.plan.targets.length
      ? "ALREADY_APPLIED"
      : "READY_TO_APPLY";
    return {
      schemaVersion: PRODUCT_TRUTH_CANONICAL_COGS_RECONCILE_PREFLIGHT_VERSION,
      status,
      planId: input.plan.planId,
      planSha256: input.planSha256,
      databaseTargetFingerprint: input.databaseTargetFingerprint,
      checkedAt,
      counts: {
        targets: input.plan.targets.length,
        absentRows: status === "READY_TO_APPLY"
          ? input.plan.databaseWrites.maximumRows
          : 0,
        exactExistingRows: status === "ALREADY_APPLIED"
          ? input.plan.databaseWrites.maximumRows
          : 0,
      },
      listingKeys: input.plan.targets.map((target) => target.listingKey),
      foreignKeyViolations: [],
    };
  } finally {
    tx.close();
  }
}

function validateStandingAuthorization(input: {
  plan: ProductTruthCanonicalCogsReconcilePlan;
  planSha256: string;
  policy: ProductTruthLegacyBridgeStandingPolicy;
  policyJson: string;
  policySha256: string;
  preflight: ProductTruthCanonicalCogsReconcilePreflight;
  preflightJson: string;
  preflightSha256: string;
  now: string;
}): void {
  const { plan, policy, preflight } = input;
  const issuedAt = Date.parse(canonicalInstant(policy.issuedAt, "policy.issuedAt"));
  const expiresAt = policy.expiresAt === null
    ? null
    : Date.parse(canonicalInstant(policy.expiresAt, "policy.expiresAt"));
  const now = Date.parse(canonicalInstant(input.now, "now"));
  if (
    policy.schemaVersion !== PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION
    || renderProductTruthLegacyBridgeStandingPolicy(policy) !== input.policyJson
    || sha256Text(input.policyJson) !== exactSha(
      input.policySha256,
      "policySha256",
    )
    || policy.approvedBy !== "owner"
    || typeof policy.policyId !== "string"
    || !policy.policyId.trim()
    || issuedAt > now
    || (expiresAt !== null && now > expiresAt)
    || policy.databaseTargetFingerprint !== plan.databaseTargetFingerprint
    || policy.manifestSha256 !== plan.manifestSha256
    || !Number.isInteger(policy.maximumDatabaseRowsPerWave)
    || policy.maximumDatabaseRowsPerWave < plan.databaseWrites.maximumRows
    || policy.maximumDatabaseRowsPerWave > 100
    || !Number.isInteger(policy.maximumPreflightAgeMs)
    || policy.maximumPreflightAgeMs < 1
    || policy.maximumPreflightAgeMs > 15 * 60 * 1_000
    || policy.requiresCollisionFree !== true
    || policy.requiresFreshReadyToApplyPreflight !== true
    || policy.allowCanonicalMaterialization !== true
    || policy.allowProviderCalls !== false
    || policy.allowPaidCalls !== false
    || policy.allowMarketplaceListingWrites !== false
    || policy.allowPriceChanges !== false
    || policy.allowInventoryChanges !== false
    || policy.allowDelisting !== false
    || policy.allowConsumerActivation !== false
    || policy.allowProcurement !== false
    || policy.revocationRequiresOwnerDecision !== true
    || Date.parse(plan.createdAt) < issuedAt
  ) {
    fail(
      "CANONICAL_COGS_STANDING_POLICY_INVALID",
      "standing policy does not authorize this bounded materialization",
    );
  }
  if (
    preflight.schemaVersion
      !== PRODUCT_TRUTH_CANONICAL_COGS_RECONCILE_PREFLIGHT_VERSION
    || renderProductTruthCanonicalCogsReconcilePreflight(preflight)
      !== input.preflightJson
    || sha256Text(input.preflightJson)
      !== exactSha(input.preflightSha256, "preflightSha256")
    || preflight.status !== "READY_TO_APPLY"
    || preflight.planId !== plan.planId
    || preflight.planSha256 !== input.planSha256
    || preflight.databaseTargetFingerprint !== plan.databaseTargetFingerprint
    || preflight.counts.targets !== plan.targets.length
    || preflight.counts.absentRows !== plan.databaseWrites.maximumRows
    || preflight.counts.exactExistingRows !== 0
    || canonicalJson(preflight.listingKeys)
      !== canonicalJson(plan.targets.map((target) => target.listingKey))
    || preflight.foreignKeyViolations.length !== 0
  ) {
    fail(
      "CANONICAL_COGS_STANDING_PREFLIGHT_INVALID",
      "exact READY_TO_APPLY preflight is required",
    );
  }
  const checkedAt = Date.parse(
    canonicalInstant(preflight.checkedAt, "preflight.checkedAt"),
  );
  if (checkedAt > now || now - checkedAt > policy.maximumPreflightAgeMs) {
    fail(
      "CANONICAL_COGS_STANDING_PREFLIGHT_STALE",
      "preflight is not fresh",
    );
  }
}

async function insertRow(
  tx: Transaction,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const columns = Object.keys(row);
  await tx.execute({
    sql: `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(",")})
          VALUES (${columns.map(() => "?").join(",")})`,
    args: columns.map((column) => row[column] as never),
  });
}

export async function applyProductTruthCanonicalCogsReconciliation(input: {
  db: Client;
  databaseTargetFingerprint: string;
  plan: ProductTruthCanonicalCogsReconcilePlan;
  planJson: string;
  planSha256: string;
  standingPolicy: ProductTruthLegacyBridgeStandingPolicy;
  standingPolicyJson: string;
  standingPolicySha256: string;
  preflight: ProductTruthCanonicalCogsReconcilePreflight;
  preflightJson: string;
  preflightSha256: string;
  startedAt: string;
  completedAt?: string;
}): Promise<ProductTruthCanonicalCogsReconcileReport> {
  validatePlan(input.plan, input.planJson, input.planSha256);
  const startedAt = canonicalInstant(input.startedAt, "startedAt");
  const invocationTime = Date.now();
  if (Date.parse(startedAt) > invocationTime) {
    fail("CANONICAL_COGS_TIMESTAMP_INVALID", "startedAt is in the future");
  }
  const requestedCompletedAt = input.completedAt === undefined
    ? null
    : canonicalInstant(input.completedAt, "completedAt");
  if (
    requestedCompletedAt !== null
    && (
      Date.parse(requestedCompletedAt) < Date.parse(startedAt)
      || Date.parse(requestedCompletedAt) > invocationTime
    )
  ) {
    fail("CANONICAL_COGS_TIMESTAMP_INVALID", "completedAt is invalid");
  }
  if (input.databaseTargetFingerprint !== input.plan.databaseTargetFingerprint) {
    fail("CANONICAL_COGS_DATABASE_TARGET_MISMATCH", "target differs from plan");
  }
  validateStandingAuthorization({
    plan: input.plan,
    planSha256: input.planSha256,
    policy: input.standingPolicy,
    policyJson: input.standingPolicyJson,
    policySha256: input.standingPolicySha256,
    preflight: input.preflight,
    preflightJson: input.preflightJson,
    preflightSha256: input.preflightSha256,
    now: startedAt,
  });
  await assertProductTruthEvidenceSchema(input.db);
  await assertProductTruthListingScopeSchema(input.db);
  let insertedRows = 0;
  let exactExistingRows = 0;
  const tx = await input.db.transaction("write");
  try {
    const states = [];
    for (const target of input.plan.targets) {
      await assertSourceBinding(tx, input.plan, target);
      states.push(await targetState(tx, target));
    }
    if (states.some((state) => state !== "ABSENT")) {
      fail(
        "CANONICAL_COGS_STANDING_PREFLIGHT_DRIFT",
        "canonical COGS state changed after preflight",
      );
    }
    for (const target of input.plan.targets) {
      await insertRow(
        tx,
        "SkuCostListingScopeLink",
        target.listingScopeLink as unknown as Record<string, unknown>,
      );
      for (const row of target.componentEvidence) {
        await insertRow(
          tx,
          "SkuComponentEvidence",
          row as unknown as Record<string, unknown>,
        );
      }
      await insertRow(
        tx,
        "SkuCost",
        target.cost as unknown as Record<string, unknown>,
      );
    }
    insertedRows = input.plan.databaseWrites.maximumRows;
    const violations = await foreignKeyViolations(tx);
    if (violations.length) {
      fail("CANONICAL_COGS_FOREIGN_KEY_VIOLATION", violations.join("; "));
    }
    for (const target of input.plan.targets) {
      if (await targetState(tx, target) !== "EXACT") {
        fail("CANONICAL_COGS_POST_VERIFY_FAILED", target.listingKey);
      }
    }
    await tx.commit();
  } catch (error) {
    try {
      await tx.rollback();
    } catch {
      // Preserve the authoritative original failure.
    }
    if (error instanceof ProductTruthCanonicalCogsReconcileError) throw error;
    fail(
      "CANONICAL_COGS_TRANSACTION_FAILED",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  for (const target of input.plan.targets) {
    if (await targetState(input.db, target) !== "EXACT") {
      fail("CANONICAL_COGS_POST_VERIFY_FAILED", target.listingKey);
    }
  }
  const violations = await foreignKeyViolations(input.db);
  if (violations.length) {
    fail("CANONICAL_COGS_POST_VERIFY_FAILED", violations.join("; "));
  }
  const completedAt = requestedCompletedAt ?? new Date().toISOString();
  return {
    schemaVersion: PRODUCT_TRUTH_CANONICAL_COGS_RECONCILE_REPORT_VERSION,
    status: insertedRows > 0 ? "APPLIED" : "ALREADY_APPLIED",
    planId: input.plan.planId,
    planSha256: input.planSha256,
    databaseTargetFingerprint: input.databaseTargetFingerprint,
    standingPolicyId: input.standingPolicy.policyId,
    standingPolicySha256: input.standingPolicySha256,
    preflightReportSha256: input.preflightSha256,
    startedAt,
    completedAt,
    counts: {
      targets: input.plan.targets.length,
      insertedRows,
      exactExistingRows,
      skuCosts: input.plan.databaseWrites.skuCosts,
      componentEvidence: input.plan.databaseWrites.componentEvidence,
      listingScopeLinks: input.plan.databaseWrites.listingScopeLinks,
    },
    verification: {
      listingKeys: input.plan.targets.map((target) => target.listingKey),
      costIds: input.plan.targets.map((target) => target.cost.id),
      recipeHashes: input.plan.targets.map(
        (target) => target.listingRecipeHash,
      ),
      costOutcomes: [...new Set(
        input.plan.targets.map((target) => target.cost.evidenceOutcome),
      )].sort() as Array<"FACT" | "UNSOURCEABLE">,
      foreignKeyViolations: [],
      providerCalls: 0,
      paidCalls: 0,
      marketplaceMutations: 0,
      consumerCutoverChanged: false,
    },
  };
}
