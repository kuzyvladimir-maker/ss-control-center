import { createHash } from "node:crypto";

import type { Client, Row, Transaction } from "@libsql/client";

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
  buildProductTruthListingRecipeMaterialization,
  productTruthListingRecipeStructuralHash,
  type ProductTruthListingRecipeComponentRow,
  type ProductTruthListingRecipeRow,
} from "./product-truth-listing-recipe";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  assertProductTruthEvidenceSchema,
  assertProductTruthListingScopeSchema,
} from "./product-truth-schema-gate";

export const PRODUCT_TRUTH_CANONICAL_RECIPE_RECONCILE_PLAN_VERSION =
  "product-truth-canonical-recipe-reconcile-plan/1.0.0" as const;
export const PRODUCT_TRUTH_CANONICAL_RECIPE_RECONCILE_PREFLIGHT_VERSION =
  "product-truth-canonical-recipe-reconcile-preflight/1.0.0" as const;
export const PRODUCT_TRUTH_CANONICAL_RECIPE_RECONCILE_REPORT_VERSION =
  "product-truth-canonical-recipe-reconcile-report/1.0.0" as const;
export const PRODUCT_TRUTH_CANONICAL_RECIPE_RECONCILE_MAX_LISTINGS = 50 as const;
const LISTING_RECIPE_MIGRATION_ID =
  "20260729010000_product_truth_listing_recipe";
const LISTING_RECIPE_MIGRATION_SHA256 =
  "1800ecf61715e1c61dbb9113c5e688dce2544002b3e564ea6f11f6f569b2acba";

type SqlReader = Pick<Client, "execute"> | Pick<Transaction, "execute">;

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

const COST_COLUMNS = [
  "id",
  "sku",
  "effectiveDate",
  "productCost",
  "packagingCost",
  "iceCost",
  "totalCost",
  "costPerUnit",
  "packSize",
  "includesPackaging",
  "currency",
  "source",
  "confidence",
  "needsReview",
  "notes",
  "createdAt",
  "updatedAt",
  "observationKey",
  "recipeHash",
  "evidenceJson",
  "evidenceOutcome",
  "matcherVersion",
  "matcherImplementationSha256",
  "matcherReleaseSha256",
  "pricePolicyVersion",
  "runId",
  "approvalId",
] as const;

const COMPONENT_EVIDENCE_COLUMNS = [
  "id",
  "evidenceKey",
  "skuCostId",
  "componentIndex",
  "evidenceStatus",
  "targetCanonicalVariantId",
  "contentCanonicalVariantId",
  "priceCanonicalVariantId",
  "contentObservationId",
  "priceObservationId",
  "matchTier",
  "matcherVersion",
  "matcherImplementationSha256",
  "matcherReleaseSha256",
  "pricePolicyVersion",
  "evidenceHash",
  "evidenceJson",
  "createdAt",
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

const CONTENT_ANCHOR_COLUMNS = [
  "id",
  "observationKey",
  "donorProductId",
  "canonicalVariantId",
  "variantDecisionId",
  "contentHash",
  "observedAt",
  "runId",
  "approvalId",
  "meteredReceiptId",
  "createdAt",
] as const;

const PRICE_ANCHOR_COLUMNS = [
  "id",
  "observationKey",
  "donorOfferId",
  "donorProductId",
  "canonicalVariantId",
  "variantDecisionId",
  "retailer",
  "retailerProductId",
  "price",
  "packSizeSeen",
  "pricePerUnit",
  "currency",
  "zip",
  "localityEvidence",
  "inStock",
  "productUrl",
  "isFirstParty",
  "sourceApi",
  "observedAt",
  "runId",
  "approvalId",
  "meteredReceiptId",
  "createdAt",
] as const;

type SourceBinding = {
  scopeSha256: string;
  costSha256: string;
  costRecipeHashMode:
    | "STRUCTURAL_LISTING_RECIPE_V1"
    | "LEGACY_PRE_LISTING_RECIPE_MIGRATION";
  listingRecipeMigrationReceiptSha256: string;
  components: Array<{
    componentIndex: number;
    componentEvidenceSha256: string;
    decisionSha256: string;
    contentAnchorSha256: string | null;
    priceAnchorSha256: string | null;
  }>;
  sourceGraphSha256: string;
};

export interface ProductTruthCanonicalRecipeReconcileTarget {
  listingKey: string;
  sku: string;
  costId: string;
  costOutcome: "FACT" | "ESTIMATE" | "UNSOURCEABLE";
  sourceBinding: SourceBinding;
  listingRecipe: ProductTruthListingRecipeRow;
  listingRecipeComponents: ProductTruthListingRecipeComponentRow[];
}

export interface ProductTruthCanonicalRecipeReconcilePlan {
  schemaVersion: typeof PRODUCT_TRUTH_CANONICAL_RECIPE_RECONCILE_PLAN_VERSION;
  planId: string;
  createdAt: string;
  expiresAt: string;
  databaseTargetFingerprint: string;
  manifestSha256: string;
  targetsSha256: string;
  targets: ProductTruthCanonicalRecipeReconcileTarget[];
  databaseWrites: {
    maximumRows: number;
    listingRecipes: number;
    listingRecipeComponents: number;
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
  };
}

export interface ProductTruthCanonicalRecipeReconcilePreflight {
  schemaVersion: typeof PRODUCT_TRUTH_CANONICAL_RECIPE_RECONCILE_PREFLIGHT_VERSION;
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

export interface ProductTruthCanonicalRecipeReconcileReport {
  schemaVersion: typeof PRODUCT_TRUTH_CANONICAL_RECIPE_RECONCILE_REPORT_VERSION;
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
    listingRecipes: number;
    listingRecipeComponents: number;
  };
  verification: {
    listingKeys: string[];
    recipeHashes: string[];
    foreignKeyViolations: string[];
    providerCalls: 0;
    paidCalls: 0;
    marketplaceMutations: 0;
    consumerCutoverChanged: false;
  };
}

export class ProductTruthCanonicalRecipeReconcileError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthCanonicalRecipeReconcileError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthCanonicalRecipeReconcileError(
    code,
    message,
    cause === undefined ? undefined : { cause },
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
    fail("CANONICAL_RECIPE_INPUT_INVALID", `${label} must be SHA-256`);
  }
  return value;
}

function exactText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail("CANONICAL_RECIPE_INPUT_INVALID", `${label} must be non-empty text`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    fail("CANONICAL_RECIPE_INPUT_INVALID", `${label} must be canonical UTC ISO`);
  }
  return value;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string") {
    fail("CANONICAL_RECIPE_SOURCE_INVALID", `${label} must be JSON text`);
  }
  try {
    const parsed = recordValue(JSON.parse(value));
    if (!parsed) throw new Error("not an object");
    return parsed;
  } catch (error) {
    fail("CANONICAL_RECIPE_SOURCE_INVALID", `${label} is invalid`, error);
  }
}

function scalar(value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

function projection(
  row: Row,
  columns: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(columns.map((column) => [column, scalar(row[column])]));
}

function rowSha(row: Row, columns: readonly string[]): string {
  return productTruthOperationalSha256(projection(row, columns));
}

function assertExactRow(
  actual: Row,
  expected: Record<string, unknown>,
  code: string,
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (scalar(actual[key]) !== scalar(value)) {
      fail(code, `${key} differs from the sealed row`);
    }
  }
}

async function foreignKeyViolations(db: SqlReader): Promise<string[]> {
  const result = await db.execute("PRAGMA foreign_key_check");
  return result.rows.map((row) => canonicalJson(
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, scalar(value)])),
  ).trim());
}

function outcome(value: unknown): "FACT" | "ESTIMATE" | "UNSOURCEABLE" {
  if (value === "FACT" || value === "ESTIMATE" || value === "UNSOURCEABLE") {
    return value;
  }
  fail("CANONICAL_RECIPE_SOURCE_INVALID", "cost outcome is not typed");
}

function componentPayload(
  evidenceRow: Row,
  expectedIndex: number,
): {
  product: string;
  flavor: string | null;
  size: string | null;
  quantity: number;
  targetCanonicalVariantId: string;
} {
  if (Number(evidenceRow.componentIndex) !== expectedIndex) {
    fail(
      "CANONICAL_RECIPE_COMPONENT_SET_INVALID",
      "component indexes must be contiguous from zero",
    );
  }
  const evidence = parseObject(
    evidenceRow.evidenceJson,
    `component evidence ${expectedIndex}`,
  );
  const product = exactText(evidence.product, `component ${expectedIndex}.product`);
  const quantity = Number(evidence.qty);
  if (!Number.isInteger(quantity) || quantity < 1) {
    fail(
      "CANONICAL_RECIPE_COMPONENT_SET_INVALID",
      `component ${expectedIndex} quantity is invalid`,
    );
  }
  const flavor = evidence.flavor === null
    ? null
    : exactText(evidence.flavor, `component ${expectedIndex}.flavor`);
  const size = evidence.size === null
    ? null
    : exactText(evidence.size, `component ${expectedIndex}.size`);
  const targetCanonicalVariantId = exactText(
    evidence.targetCanonicalVariantId,
    `component ${expectedIndex}.targetCanonicalVariantId`,
  );
  if (targetCanonicalVariantId !== evidenceRow.targetCanonicalVariantId) {
    fail(
      "CANONICAL_RECIPE_SOURCE_DRIFT",
      `component ${expectedIndex} target variant differs`,
    );
  }
  return { product, flavor, size, quantity, targetCanonicalVariantId };
}

async function readAnchor(
  db: SqlReader,
  table: "ProductContentObservation" | "DonorOfferObservation",
  id: unknown,
): Promise<Row | null> {
  if (id === null) return null;
  const row = (await db.execute({
    sql: `SELECT * FROM "${table}" WHERE id=?`,
    args: [exactText(id, `${table}.id`)],
  })).rows[0];
  if (!row) {
    fail("CANONICAL_RECIPE_SOURCE_INCOMPLETE", `${table} anchor is absent`);
  }
  return row;
}

async function exactDecisionForComponent(
  db: SqlReader,
  evidenceRow: Row,
): Promise<{
  decision: Row;
  contentAnchor: Row | null;
  priceAnchor: Row | null;
}> {
  const targetVariantId = exactText(
    evidenceRow.targetCanonicalVariantId,
    "targetCanonicalVariantId",
  );
  const contentAnchor = await readAnchor(
    db,
    "ProductContentObservation",
    evidenceRow.contentObservationId,
  );
  const priceAnchor = await readAnchor(
    db,
    "DonorOfferObservation",
    evidenceRow.priceObservationId,
  );
  const anchoredDecisionIds = new Set<string>();
  for (const anchor of [contentAnchor, priceAnchor]) {
    if (
      anchor
      && anchor.canonicalVariantId === targetVariantId
      && typeof anchor.variantDecisionId === "string"
      && anchor.variantDecisionId
    ) {
      anchoredDecisionIds.add(anchor.variantDecisionId);
    }
  }
  if (anchoredDecisionIds.size > 1) {
    fail(
      "CANONICAL_RECIPE_IDENTITY_AMBIGUOUS",
      `${targetVariantId} has conflicting exact anchors`,
    );
  }
  let rows: Row[];
  if (anchoredDecisionIds.size === 1) {
    const [decisionId] = anchoredDecisionIds;
    rows = (await db.execute({
      sql: `SELECT decision.*,donor.identityStatus AS donorIdentityStatus
            FROM DonorProductVariantDecision decision
            JOIN DonorProduct donor ON donor.id=decision.donorProductId
            WHERE decision.id=?`,
      args: [decisionId],
    })).rows;
  } else {
    rows = (await db.execute({
      sql: `SELECT decision.*,donor.identityStatus AS donorIdentityStatus
            FROM DonorProductVariantDecision decision
            JOIN DonorProduct donor ON donor.id=decision.donorProductId
            WHERE decision.canonicalVariantId=?
              AND decision.decisionStatus='exact_confirmed'
              AND decision.matcherVersion=?
              AND decision.matcherImplementationSha256=?
              AND decision.matcherReleaseSha256=?
              AND donor.identityStatus='exact_confirmed'
            ORDER BY decision.id`,
      args: [
        targetVariantId,
        CANONICAL_PRODUCT_MATCHER_VERSION,
        CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
        CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      ],
    })).rows;
  }
  if (rows.length !== 1) {
    fail(
      "CANONICAL_RECIPE_IDENTITY_AMBIGUOUS",
      `${targetVariantId} requires exactly one exact donor decision`,
    );
  }
  const decision = rows[0];
  if (
    decision.canonicalVariantId !== targetVariantId
    || decision.decisionStatus !== "exact_confirmed"
    || decision.donorIdentityStatus !== "exact_confirmed"
    || decision.matcherVersion !== CANONICAL_PRODUCT_MATCHER_VERSION
    || decision.matcherImplementationSha256
      !== CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256
    || decision.matcherReleaseSha256 !== CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256
  ) {
    fail(
      "CANONICAL_RECIPE_IDENTITY_INVALID",
      `${targetVariantId} donor decision is not current exact identity`,
    );
  }
  for (const anchor of [contentAnchor, priceAnchor]) {
    if (
      anchor
      && anchor.canonicalVariantId === targetVariantId
      && (
        anchor.variantDecisionId !== decision.id
        || anchor.donorProductId !== decision.donorProductId
      )
    ) {
      fail(
        "CANONICAL_RECIPE_IDENTITY_INVALID",
        `${targetVariantId} exact anchor disagrees with its decision`,
      );
    }
  }
  return { decision, contentAnchor, priceAnchor };
}

async function buildTargetFromDatabase(
  db: SqlReader,
  input: {
    listingKey: string;
    manifestSha256: string;
    databaseTargetFingerprint: string;
    createdAt: string;
  },
): Promise<ProductTruthCanonicalRecipeReconcileTarget> {
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
      "CANONICAL_RECIPE_SCOPE_INVALID",
      `${input.listingKey} is not in the exact authoritative manifest`,
    );
  }
  const costs = (await db.execute({
    sql: `SELECT cost.*
          FROM SkuCostListingScopeLink link
          JOIN SkuCost cost ON cost.id=link.skuCostId
          WHERE link.listingKey=?
          ORDER BY cost.effectiveDate DESC,cost.createdAt DESC,cost.id DESC`,
    args: [input.listingKey],
  })).rows;
  if (!costs.length) {
    fail("CANONICAL_RECIPE_COST_GRAPH_MISSING", input.listingKey);
  }
  const cost = costs[0];
  const typedOutcome = outcome(cost.evidenceOutcome);
  if (
    cost.sku !== scope.sku
    || cost.matcherVersion !== CANONICAL_PRODUCT_MATCHER_VERSION
    || cost.matcherImplementationSha256 !== CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256
    || cost.matcherReleaseSha256 !== CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256
    || typeof cost.recipeHash !== "string"
    || !/^[a-f0-9]{64}$/.test(cost.recipeHash)
  ) {
    fail(
      "CANONICAL_RECIPE_COST_GRAPH_INVALID",
      `${input.listingKey} latest scoped cost is not canonical`,
    );
  }
  const evidenceRows = (await db.execute({
    sql: `SELECT * FROM SkuComponentEvidence
          WHERE skuCostId=? ORDER BY componentIndex`,
    args: [cost.id as string],
  })).rows;
  if (!evidenceRows.length) {
    fail("CANONICAL_RECIPE_COMPONENT_SET_INVALID", input.listingKey);
  }
  const scopeSha256 = rowSha(scope, SCOPE_COLUMNS);
  const costSha256 = rowSha(cost, COST_COLUMNS);
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
  ) {
    fail(
      "CANONICAL_RECIPE_MIGRATION_RECEIPT_INVALID",
      "listing recipe migration receipt is missing or drifted",
    );
  }
  const migrationAppliedAt = canonicalInstant(
    migrationReceipt.appliedAt,
    "listing recipe migration appliedAt",
  );
  const listingRecipeMigrationReceiptSha256 = productTruthOperationalSha256(
    projection(migrationReceipt, [
      "migrationId",
      "migrationSha256",
      "targetFingerprint",
      "action",
      "appliedAt",
    ]),
  );
  const candidateComponents = [];
  const sourceComponents: SourceBinding["components"] = [];
  for (let index = 0; index < evidenceRows.length; index += 1) {
    const evidenceRow = evidenceRows[index];
    const payload = componentPayload(evidenceRow, index);
    const identity = await exactDecisionForComponent(db, evidenceRow);
    const componentEvidenceSha256 = rowSha(
      evidenceRow,
      COMPONENT_EVIDENCE_COLUMNS,
    );
    const decisionSha256 = rowSha(identity.decision, DECISION_COLUMNS);
    const contentAnchorSha256 = identity.contentAnchor
      ? rowSha(identity.contentAnchor, CONTENT_ANCHOR_COLUMNS)
      : null;
    const priceAnchorSha256 = identity.priceAnchor
      ? rowSha(identity.priceAnchor, PRICE_ANCHOR_COLUMNS)
      : null;
    sourceComponents.push({
      componentIndex: index,
      componentEvidenceSha256,
      decisionSha256,
      contentAnchorSha256,
      priceAnchorSha256,
    });
    candidateComponents.push({
      componentIndex: index,
      quantity: payload.quantity,
      product: payload.product,
      flavor: payload.flavor,
      size: payload.size,
      targetCanonicalVariantId: payload.targetCanonicalVariantId,
      donorProductId: String(identity.decision.donorProductId),
      variantDecisionId: String(identity.decision.id),
      sourceComponentId: null,
      sourceEvidence: {
        schemaVersion:
          "product-truth-canonical-recipe-reconcile-component-source/1.0.0",
        listingKey: input.listingKey,
        skuCostId: String(cost.id),
        componentEvidenceId: String(evidenceRow.id),
        componentEvidenceSha256,
        variantDecisionId: String(identity.decision.id),
        decisionSha256,
        contentAnchorId: identity.contentAnchor
          ? String(identity.contentAnchor.id)
          : null,
        contentAnchorSha256,
        priceAnchorId: identity.priceAnchor
          ? String(identity.priceAnchor.id)
          : null,
        priceAnchorSha256,
      },
    });
  }
  const structuralHash = productTruthListingRecipeStructuralHash({
    listingKey: input.listingKey,
    components: candidateComponents.map((component) => ({
      componentIndex: component.componentIndex,
      quantity: component.quantity,
      targetCanonicalVariantId: component.targetCanonicalVariantId,
    })),
  });
  const costRecipeHashMode: SourceBinding["costRecipeHashMode"] | null =
    structuralHash === cost.recipeHash
    ? "STRUCTURAL_LISTING_RECIPE_V1"
    : Date.parse(canonicalInstant(cost.createdAt, "cost.createdAt"))
        < Date.parse(migrationAppliedAt)
      ? "LEGACY_PRE_LISTING_RECIPE_MIGRATION"
      : null;
  if (costRecipeHashMode === null) {
    fail(
      "CANONICAL_RECIPE_HASH_MISMATCH",
      `${input.listingKey} post-migration cost recipe does not match component evidence`,
    );
  }
  const sourceBindingBase = {
    scopeSha256,
    costSha256,
    costRecipeHashMode,
    listingRecipeMigrationReceiptSha256,
    components: sourceComponents,
  };
  const sourceGraphSha256 = productTruthOperationalSha256({
    schemaVersion: "product-truth-canonical-recipe-source-graph/1.0.0",
    listingKey: input.listingKey,
    costId: cost.id,
    ...sourceBindingBase,
  });
  const sourceBinding: SourceBinding = {
    ...sourceBindingBase,
    sourceGraphSha256,
  };
  const recipe = buildProductTruthListingRecipeMaterialization({
    listingKey: input.listingKey,
    manifestSha256: input.manifestSha256,
    sourceKind: "CANONICAL_COST_GRAPH",
    sourceArtifactSha256: sourceGraphSha256,
    effectiveAt: canonicalInstant(cost.effectiveDate, "cost.effectiveDate"),
    createdAt: input.createdAt,
    runId: null,
    approvalId: null,
    components: candidateComponents,
  });
  if (recipe.recipe.recipeHash !== structuralHash) {
    fail("CANONICAL_RECIPE_HASH_MISMATCH", `${input.listingKey} structural rebuild`);
  }
  return {
    listingKey: input.listingKey,
    sku: String(scope.sku),
    costId: String(cost.id),
    costOutcome: typedOutcome,
    sourceBinding,
    listingRecipe: recipe.recipe,
    listingRecipeComponents: recipe.components,
  };
}

function expectedDatabaseWrites(
  targets: readonly ProductTruthCanonicalRecipeReconcileTarget[],
): ProductTruthCanonicalRecipeReconcilePlan["databaseWrites"] {
  const components = targets.reduce(
    (sum, target) => sum + target.listingRecipeComponents.length,
    0,
  );
  return {
    maximumRows: targets.length + components,
    listingRecipes: targets.length,
    listingRecipeComponents: components,
  };
}

export async function planProductTruthCanonicalRecipeReconciliation(input: {
  db: Client;
  databaseTargetFingerprint: string;
  manifestSha256: string;
  listingKeys: readonly string[];
  createdAt: string;
  expiresAt: string;
}): Promise<ProductTruthCanonicalRecipeReconcilePlan> {
  const databaseTargetFingerprint = exactSha(
    input.databaseTargetFingerprint,
    "databaseTargetFingerprint",
  );
  const manifestSha256 = exactSha(input.manifestSha256, "manifestSha256");
  const createdAt = canonicalInstant(input.createdAt, "createdAt");
  const expiresAt = canonicalInstant(input.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    fail("CANONICAL_RECIPE_INPUT_INVALID", "expiresAt must follow createdAt");
  }
  if (
    input.listingKeys.length < 1
    || input.listingKeys.length > PRODUCT_TRUTH_CANONICAL_RECIPE_RECONCILE_MAX_LISTINGS
    || new Set(input.listingKeys).size !== input.listingKeys.length
  ) {
    fail(
      "CANONICAL_RECIPE_SCOPE_INVALID",
      "1-50 explicit unique listing keys are required",
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
        createdAt,
      }));
    }
    const databaseWrites = expectedDatabaseWrites(targets);
    if (databaseWrites.maximumRows > 100) {
      fail(
        "CANONICAL_RECIPE_SCOPE_INVALID",
        "bounded standing-authority wave exceeds 100 rows",
      );
    }
    const targetsSha256 = productTruthOperationalSha256(targets);
    const planId = `ptcr-${productTruthOperationalSha256({
      databaseTargetFingerprint,
      manifestSha256,
      listingKeys,
      targetsSha256,
      createdAt,
    }).slice(0, 24)}`;
    return {
      schemaVersion: PRODUCT_TRUTH_CANONICAL_RECIPE_RECONCILE_PLAN_VERSION,
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
      },
    };
  } finally {
    tx.close();
  }
}

export function renderProductTruthCanonicalRecipeReconcilePlan(
  value: ProductTruthCanonicalRecipeReconcilePlan,
): string {
  return canonicalJson(value);
}

export function renderProductTruthCanonicalRecipeReconcilePreflight(
  value: ProductTruthCanonicalRecipeReconcilePreflight,
): string {
  return canonicalJson(value);
}

export function renderProductTruthCanonicalRecipeReconcileReport(
  value: ProductTruthCanonicalRecipeReconcileReport,
): string {
  return canonicalJson(value);
}

function validatePlan(
  plan: ProductTruthCanonicalRecipeReconcilePlan,
  planJson: string,
  planSha256: string,
): void {
  if (
    plan.schemaVersion !== PRODUCT_TRUTH_CANONICAL_RECIPE_RECONCILE_PLAN_VERSION
    || renderProductTruthCanonicalRecipeReconcilePlan(plan) !== planJson
    || sha256Text(planJson) !== exactSha(planSha256, "planSha256")
    || exactSha(plan.databaseTargetFingerprint, "databaseTargetFingerprint")
      !== plan.databaseTargetFingerprint
    || exactSha(plan.manifestSha256, "manifestSha256") !== plan.manifestSha256
    || canonicalInstant(plan.createdAt, "createdAt") !== plan.createdAt
    || canonicalInstant(plan.expiresAt, "expiresAt") !== plan.expiresAt
    || Date.parse(plan.expiresAt) <= Date.parse(plan.createdAt)
    || plan.targets.length < 1
    || plan.targets.length > PRODUCT_TRUTH_CANONICAL_RECIPE_RECONCILE_MAX_LISTINGS
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
    })
  ) {
    fail("CANONICAL_RECIPE_PLAN_INVALID", "plan bytes or invariants differ");
  }
  const listingKeys = plan.targets.map((target) => target.listingKey);
  const sorted = [...listingKeys].sort((left, right) => left.localeCompare(right, "en-US"));
  if (
    new Set(listingKeys).size !== listingKeys.length
    || canonicalJson(listingKeys) !== canonicalJson(sorted)
  ) {
    fail("CANONICAL_RECIPE_PLAN_INVALID", "targets are not canonical");
  }
}

async function assertSourceBinding(
  db: SqlReader,
  plan: ProductTruthCanonicalRecipeReconcilePlan,
  target: ProductTruthCanonicalRecipeReconcileTarget,
): Promise<void> {
  const rebuilt = await buildTargetFromDatabase(db, {
    listingKey: target.listingKey,
    manifestSha256: plan.manifestSha256,
    databaseTargetFingerprint: plan.databaseTargetFingerprint,
    createdAt: plan.createdAt,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(target)) {
    fail(
      "CANONICAL_RECIPE_SOURCE_DRIFT",
      `${target.listingKey} source graph differs from the sealed plan`,
    );
  }
}

async function targetState(
  db: SqlReader,
  target: ProductTruthCanonicalRecipeReconcileTarget,
): Promise<"ABSENT" | "EXACT"> {
  const recipes = (await db.execute({
    sql: `SELECT * FROM ProductTruthListingRecipe
          WHERE id=? OR recipeKey=? OR listingKey=?`,
    args: [
      target.listingRecipe.id,
      target.listingRecipe.recipeKey,
      target.listingKey,
    ],
  })).rows;
  if (!recipes.length) {
    for (const component of target.listingRecipeComponents) {
      const collision = (await db.execute({
        sql: `SELECT id FROM ProductTruthListingRecipeComponent
              WHERE id=? OR componentKey=?
                 OR (listingRecipeId=? AND componentIndex=?)
              LIMIT 1`,
        args: [
          component.id,
          component.componentKey,
          component.listingRecipeId,
          component.componentIndex,
        ],
      })).rows[0];
      if (collision) {
        fail(
          "CANONICAL_RECIPE_COMPONENT_COLLISION",
          `${target.listingKey}:${component.componentIndex}`,
        );
      }
    }
    return "ABSENT";
  }
  if (recipes.length !== 1) {
    fail("CANONICAL_RECIPE_COLLISION", `${target.listingKey} has multiple recipes`);
  }
  assertExactRow(
    recipes[0],
    target.listingRecipe as unknown as Record<string, unknown>,
    "CANONICAL_RECIPE_COLLISION",
  );
  const components = (await db.execute({
    sql: `SELECT * FROM ProductTruthListingRecipeComponent
          WHERE listingRecipeId=? ORDER BY componentIndex`,
    args: [target.listingRecipe.id],
  })).rows;
  if (components.length !== target.listingRecipeComponents.length) {
    fail(
      "CANONICAL_RECIPE_COMPONENT_COLLISION",
      `${target.listingKey} component count differs`,
    );
  }
  target.listingRecipeComponents.forEach((expected, index) => {
    assertExactRow(
      components[index],
      expected as unknown as Record<string, unknown>,
      "CANONICAL_RECIPE_COMPONENT_COLLISION",
    );
  });
  return "EXACT";
}

export async function preflightProductTruthCanonicalRecipeReconciliation(input: {
  db: Client;
  databaseTargetFingerprint: string;
  plan: ProductTruthCanonicalRecipeReconcilePlan;
  planJson: string;
  planSha256: string;
  checkedAt: string;
}): Promise<ProductTruthCanonicalRecipeReconcilePreflight> {
  validatePlan(input.plan, input.planJson, input.planSha256);
  const checkedAt = canonicalInstant(input.checkedAt, "checkedAt");
  if (input.databaseTargetFingerprint !== input.plan.databaseTargetFingerprint) {
    fail("CANONICAL_RECIPE_DATABASE_TARGET_MISMATCH", "target differs from plan");
  }
  if (
    Date.parse(checkedAt) < Date.parse(input.plan.createdAt)
    || Date.parse(checkedAt) > Date.parse(input.plan.expiresAt)
  ) {
    fail("CANONICAL_RECIPE_PLAN_EXPIRED", "preflight is outside plan window");
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
      fail("CANONICAL_RECIPE_PARTIAL_WAVE", "wave is partially applied");
    }
    const violations = await foreignKeyViolations(tx);
    if (violations.length) {
      fail("CANONICAL_RECIPE_FOREIGN_KEY_VIOLATION", violations.join("; "));
    }
    const status = exactTargets === input.plan.targets.length
      ? "ALREADY_APPLIED"
      : "READY_TO_APPLY";
    return {
      schemaVersion: PRODUCT_TRUTH_CANONICAL_RECIPE_RECONCILE_PREFLIGHT_VERSION,
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
  plan: ProductTruthCanonicalRecipeReconcilePlan;
  planSha256: string;
  policy: ProductTruthLegacyBridgeStandingPolicy;
  policyJson: string;
  policySha256: string;
  preflight: ProductTruthCanonicalRecipeReconcilePreflight;
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
    || sha256Text(input.policyJson) !== exactSha(input.policySha256, "policySha256")
    || policy.approvedBy !== "owner"
    || typeof policy.policyId !== "string"
    || !policy.policyId.trim()
    || typeof policy.ownerStatement !== "string"
    || !policy.ownerStatement.trim()
    || issuedAt > now
    || (expiresAt !== null && now > expiresAt)
    || policy.databaseTargetFingerprint !== plan.databaseTargetFingerprint
    || policy.manifestSha256 !== plan.manifestSha256
    || !Number.isInteger(policy.maximumDatabaseRowsPerWave)
    || policy.maximumDatabaseRowsPerWave < 1
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
      "CANONICAL_RECIPE_STANDING_POLICY_INVALID",
      "standing policy does not authorize this bounded materialization",
    );
  }
  if (
    preflight.schemaVersion
      !== PRODUCT_TRUTH_CANONICAL_RECIPE_RECONCILE_PREFLIGHT_VERSION
    || renderProductTruthCanonicalRecipeReconcilePreflight(preflight)
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
      "CANONICAL_RECIPE_STANDING_PREFLIGHT_INVALID",
      "exact READY_TO_APPLY preflight is required",
    );
  }
  const checkedAt = Date.parse(
    canonicalInstant(preflight.checkedAt, "preflight.checkedAt"),
  );
  if (
    checkedAt > now
    || now - checkedAt > policy.maximumPreflightAgeMs
  ) {
    fail(
      "CANONICAL_RECIPE_STANDING_PREFLIGHT_STALE",
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

export async function applyProductTruthCanonicalRecipeReconciliation(input: {
  db: Client;
  databaseTargetFingerprint: string;
  plan: ProductTruthCanonicalRecipeReconcilePlan;
  planJson: string;
  planSha256: string;
  standingPolicy: ProductTruthLegacyBridgeStandingPolicy;
  standingPolicyJson: string;
  standingPolicySha256: string;
  preflight: ProductTruthCanonicalRecipeReconcilePreflight;
  preflightJson: string;
  preflightSha256: string;
  startedAt: string;
  completedAt?: string;
}): Promise<ProductTruthCanonicalRecipeReconcileReport> {
  validatePlan(input.plan, input.planJson, input.planSha256);
  const startedAt = canonicalInstant(input.startedAt, "startedAt");
  const invocationTime = Date.now();
  if (Date.parse(startedAt) > invocationTime) {
    fail("CANONICAL_RECIPE_TIMESTAMP_INVALID", "startedAt is in the future");
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
    fail("CANONICAL_RECIPE_TIMESTAMP_INVALID", "completedAt is invalid");
  }
  if (input.databaseTargetFingerprint !== input.plan.databaseTargetFingerprint) {
    fail("CANONICAL_RECIPE_DATABASE_TARGET_MISMATCH", "target differs from plan");
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
    const exactTargets = states.filter((state) => state === "EXACT").length;
    if (exactTargets !== 0) {
      fail(
        "CANONICAL_RECIPE_STANDING_PREFLIGHT_DRIFT",
        "canonical recipe state changed after preflight",
      );
    }
    for (const target of input.plan.targets) {
      for (const component of target.listingRecipeComponents) {
        await insertRow(
          tx,
          "ProductTruthListingRecipeComponent",
          component as unknown as Record<string, unknown>,
        );
      }
      await insertRow(
        tx,
        "ProductTruthListingRecipe",
        target.listingRecipe as unknown as Record<string, unknown>,
      );
    }
    insertedRows = input.plan.databaseWrites.maximumRows;
    const violations = await foreignKeyViolations(tx);
    if (violations.length) {
      fail("CANONICAL_RECIPE_FOREIGN_KEY_VIOLATION", violations.join("; "));
    }
    for (const target of input.plan.targets) {
      if (await targetState(tx, target) !== "EXACT") {
        fail("CANONICAL_RECIPE_POST_VERIFY_FAILED", target.listingKey);
      }
    }
    await tx.commit();
  } catch (error) {
    try {
      await tx.rollback();
    } catch {
      // Preserve the authoritative original failure.
    }
    if (error instanceof ProductTruthCanonicalRecipeReconcileError) throw error;
    fail(
      "CANONICAL_RECIPE_TRANSACTION_FAILED",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  for (const target of input.plan.targets) {
    if (await targetState(input.db, target) !== "EXACT") {
      fail("CANONICAL_RECIPE_POST_VERIFY_FAILED", target.listingKey);
    }
  }
  const violations = await foreignKeyViolations(input.db);
  if (violations.length) {
    fail("CANONICAL_RECIPE_POST_VERIFY_FAILED", violations.join("; "));
  }
  const completedAt = requestedCompletedAt ?? new Date().toISOString();
  return {
    schemaVersion: PRODUCT_TRUTH_CANONICAL_RECIPE_RECONCILE_REPORT_VERSION,
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
      listingRecipes: input.plan.databaseWrites.listingRecipes,
      listingRecipeComponents:
        input.plan.databaseWrites.listingRecipeComponents,
    },
    verification: {
      listingKeys: input.plan.targets.map((target) => target.listingKey),
      recipeHashes: input.plan.targets.map(
        (target) => target.listingRecipe.recipeHash,
      ),
      foreignKeyViolations: [],
      providerCalls: 0,
      paidCalls: 0,
      marketplaceMutations: 0,
      consumerCutoverChanged: false,
    },
  };
}
