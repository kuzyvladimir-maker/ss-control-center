import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { Client, Transaction } from "@libsql/client";

import {
  PHASE1_SCOPE_MANIFEST_VERSION,
  renderPhase1ScopeManifestJson,
  sha256Hex,
  validatePhase1ScopeManifestV3Policy,
  type Phase1ScopeListing,
  type Phase1ScopeManifest,
} from "../src/lib/sourcing/phase1-scope-manifest";
import {
  planProductTruthBackfillReadiness,
  type ProductTruthMigrationCertification,
} from "../src/lib/sourcing/product-truth-backfill-readiness";
import {
  PRODUCT_TRUTH_LISTING_KEY_VERSION,
  buildProductTruthListingScope,
} from "../src/lib/sourcing/product-truth-listing-scope";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";
import { assertProductTruthOperationalRunSchema } from "../src/lib/sourcing/product-truth-operational-run-store";
import {
  assertDonorHarvestSchema,
  assertProductTruthEvidenceSchema,
  assertProductTruthListingScopeSchema,
  assertProductTruthMeteredEvidenceSchema,
} from "../src/lib/sourcing/product-truth-schema-gate";

export const PRODUCT_TRUTH_OWNER_BACKFILL_PLAN_VERSION =
  "product-truth-owner-backfill-plan/1.0.0" as const;
export const PRODUCT_TRUTH_OWNER_BACKFILL_APPROVAL_VERSION =
  "product-truth-owner-backfill-approval/1.0.0" as const;
export const PRODUCT_TRUTH_OWNER_BACKFILL_REPORT_VERSION =
  "product-truth-owner-backfill-report/1.0.0" as const;
export const PRODUCT_TRUTH_OWNER_BACKFILL_ARTIFACT_INDEX_VERSION =
  "product-truth-owner-backfill-artifact-index/1.0.0" as const;

type SqlReader = Pick<Client, "execute"> | Pick<Transaction, "execute">;

export interface ProductTruthBackfillWriterActivityRow {
  source: "ENRICHMENT_JOB" | "HARVEST" | "OPERATIONAL_RUN" | "METERED_RECEIPT";
  id: string;
  status: string;
  updatedAt: string | null;
}

export interface ProductTruthBackfillScopeStateRow {
  listingKey: string;
  keyVersion: string;
  channel: string;
  storeIndex: number;
  sku: string;
  registrationKind: string;
  manifestSchemaVersion: string;
  manifestSha256: string;
  manifestAsOf: string;
  ownerDecisionId: string;
  sourceReportId: string;
  sourceContentSha256: string;
  sourceCapturedAt: string;
  createdAt: string;
}

export interface ProductTruthBackfillCanonicalOutcomeRow {
  listingKey: string;
  skuCostId: string;
  evidenceOutcome: string;
  observationKey: string;
  recipeHash: string;
  effectiveDate: string;
  createdAt: string;
}

export interface ProductTruthBackfillPreconditionState {
  writerActivity: ProductTruthBackfillWriterActivityRow[];
  manifestScopeRows: ProductTruthBackfillScopeStateRow[];
  canonicalOutcomes: ProductTruthBackfillCanonicalOutcomeRow[];
  foreignKeyViolations: string[];
}

export interface ProductTruthScopeImportOperation {
  operation: "INSERT_IMMUTABLE_AUTHORITATIVE_LISTING_SCOPE";
  ordinal: number;
  row: ProductTruthBackfillScopeStateRow;
}

export interface ProductTruthBackfillReviewTask {
  taskId: string;
  taskType: "OWNER_CANONICAL_RECIPE_COST_REVIEW";
  listingKey: string;
  channel: "amazon" | "walmart";
  storeIndex: number;
  sku: string;
  reason: "CANONICAL_SCOPED_COST_OUTCOME_MISSING";
  requiredDisposition:
    | "CONFIRM_EXACT_RECIPE_AND_CANONICAL_EVIDENCE"
    | "MARK_UNRESOLVED_OR_UNSOURCEABLE";
  execution: "ARTIFACT_ONLY_MANUAL_REVIEW";
  automaticExecution: false;
  providerCallsPermitted: false;
  legacyInferencePermitted: false;
}

export interface ProductTruthOwnerBackfillPlan {
  schemaVersion: typeof PRODUCT_TRUTH_OWNER_BACKFILL_PLAN_VERSION;
  planId: string;
  createdAt: string;
  expiresAt: string;
  databaseTargetFingerprint: string;
  manifest: {
    schemaVersion: typeof PHASE1_SCOPE_MANIFEST_VERSION;
    sha256: string;
    asOf: string;
    listingCount: number;
  };
  migrationCertification: ProductTruthMigrationCertification;
  readinessPlanSha256: string;
  preconditions: {
    stateSha256: string;
    state: ProductTruthBackfillPreconditionState;
    writersQuiescent: true;
  };
  operations: {
    scopeImports: ProductTruthScopeImportOperation[];
    canonicalCostRecomputes: [];
    reviewTasks: ProductTruthBackfillReviewTask[];
  };
  rollbackPolicy: {
    transactionMode: "SINGLE_WRITE_TRANSACTION";
    rollbackBeforeCommit: true;
    postCommitDeleteRollback: false;
    recovery: "IDEMPOTENT_EXACT_STATE_RECONCILIATION";
  };
  claims: {
    authoritativeScopeImportOnly: true;
    reviewTasksAreArtifactOnly: true;
    databaseWritesLimitedToListingScope: true;
    canonicalCostWrites: false;
    legacyTruthPromotion: false;
    providerCalls: false;
    paidCalls: false;
    marketplaceMutations: false;
    procurementMutations: false;
  };
  planSha256: string;
}

export interface ProductTruthOwnerBackfillApproval {
  schemaVersion: typeof PRODUCT_TRUTH_OWNER_BACKFILL_APPROVAL_VERSION;
  decision: "APPROVE_AUTHORITATIVE_SCOPE_IMPORT_ONLY";
  approvedBy: "owner";
  approvalId: string;
  ownerDecisionId: string;
  planId: string;
  planSha256: string;
  databaseTargetFingerprint: string;
  manifestSha256: string;
  preconditionStateSha256: string;
  allowScopeImport: true;
  allowCanonicalCostRecompute: false;
  allowLegacyTruthPromotion: false;
  backupReference: string;
  issuedAt: string;
  expiresAt: string;
}

export interface ProductTruthBackfillVerification {
  exactManifestScopes: number;
  missingListingKeys: string[];
  conflictingListingKeys: string[];
  unexpectedManifestListingKeys: string[];
  activeWriterRows: ProductTruthBackfillWriterActivityRow[];
  foreignKeyViolations: string[];
  verified: boolean;
}

export interface ProductTruthOwnerBackfillReport {
  schemaVersion: typeof PRODUCT_TRUTH_OWNER_BACKFILL_REPORT_VERSION;
  status: "APPLIED" | "ALREADY_APPLIED";
  planId: string;
  planSha256: string;
  approvalId: string;
  approvalSha256: string;
  databaseTargetFingerprint: string;
  manifestSha256: string;
  startedAt: string;
  completedAt: string;
  preconditionStateSha256: string;
  postStateSha256: string;
  counts: {
    plannedScopeImports: number;
    insertedScopeRows: number;
    exactExistingScopeRows: number;
    reviewTasks: number;
    canonicalCostRecomputes: 0;
  };
  verification: ProductTruthBackfillVerification;
  reviewTasks: ProductTruthBackfillReviewTask[];
  claims: ProductTruthOwnerBackfillPlan["claims"];
  reportSha256: string;
}

export class ProductTruthBackfillWriterError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthBackfillWriterError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthBackfillWriterError(code, message, cause === undefined ? undefined : { cause });
}

function exactText(value: unknown, label: string, maximum = 240): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum) {
    fail("BACKFILL_WRITER_INPUT_INVALID", `${label} must be 1-${maximum} exact characters`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  const text = exactText(value, label, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    fail("BACKFILL_WRITER_INPUT_INVALID", `${label} contains unsafe characters`);
  }
  return text;
}

function exactSha(value: unknown, label: string): string {
  const text = exactText(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(text)) {
    fail("BACKFILL_WRITER_INPUT_INVALID", `${label} must be a lowercase SHA-256`);
  }
  return text;
}

function instant(value: unknown, label: string): string {
  const text = exactText(value, label, 80);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    fail("BACKFILL_WRITER_INPUT_INVALID", `${label} must be a canonical UTC ISO-8601 instant`);
  }
  return text;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en-US"));
}

function manifestBinding(input: {
  manifest: Phase1ScopeManifest;
  manifestJson: string;
  manifestSha256: string;
}): { manifestSha256: string; dispositions: Map<string, string> } {
  if (input.manifest.schemaVersion !== PHASE1_SCOPE_MANIFEST_VERSION) {
    fail("BACKFILL_MANIFEST_INVALID", "manifest schema version is not current");
  }
  const policyErrors = validatePhase1ScopeManifestV3Policy(input.manifest);
  if (policyErrors.length) {
    fail("BACKFILL_MANIFEST_INVALID", policyErrors.join("; "));
  }
  if (
    input.manifest.authoritative !== true
    || input.manifest.blockers.length !== 0
    || input.manifest.counts.blockerCount !== 0
    || input.manifest.counts.liveListings !== input.manifest.listings.length
  ) {
    fail("BACKFILL_MANIFEST_NOT_AUTHORITATIVE", "manifest must be authoritative and fully reconciled");
  }
  const canonical = renderPhase1ScopeManifestJson(input.manifest);
  if (canonical !== input.manifestJson) {
    fail("BACKFILL_MANIFEST_INVALID", "manifest bytes are not the canonical rendering");
  }
  const digest = sha256Hex(canonical);
  if (digest !== exactSha(input.manifestSha256, "manifestSha256")) {
    fail("BACKFILL_MANIFEST_HASH_MISMATCH", "manifest SHA-256 does not match exact bytes");
  }
  const dispositions = new Map<string, string>();
  for (const disposition of input.manifest.scopeDispositions) {
    if (disposition.disposition === "IN_SCOPE") {
      dispositions.set(`${disposition.channel}:${disposition.scopeKey}`, disposition.decisionId);
    }
  }
  return { manifestSha256: digest, dispositions };
}

function expectedScopeRow(input: {
  listing: Phase1ScopeListing;
  manifest: Phase1ScopeManifest;
  manifestSha256: string;
  ownerDecisionId: string;
  createdAt: string;
}): ProductTruthBackfillScopeStateRow {
  const identity = buildProductTruthListingScope(input.listing);
  if (identity.listingKey !== input.listing.listingKey) {
    fail("BACKFILL_MANIFEST_INVALID", `listingKey mismatch for ${input.listing.listingKey}`);
  }
  return {
    listingKey: identity.listingKey,
    keyVersion: PRODUCT_TRUTH_LISTING_KEY_VERSION,
    channel: identity.channel,
    storeIndex: identity.storeIndex,
    sku: identity.sku,
    registrationKind: "AUTHORITATIVE_PHASE1_MANIFEST",
    manifestSchemaVersion: PHASE1_SCOPE_MANIFEST_VERSION,
    manifestSha256: input.manifestSha256,
    manifestAsOf: input.manifest.asOf,
    ownerDecisionId: input.ownerDecisionId,
    sourceReportId: input.listing.sourceReportId,
    sourceContentSha256: input.listing.sourceContentSha256,
    sourceCapturedAt: input.listing.sourceCapturedAt,
    createdAt: input.createdAt,
  };
}

async function assertBackfillSchema(db: Client): Promise<void> {
  try {
    await assertProductTruthEvidenceSchema(db);
    await assertDonorHarvestSchema(db);
    await assertProductTruthListingScopeSchema(db);
    await assertProductTruthMeteredEvidenceSchema(db);
    await assertProductTruthOperationalRunSchema(db);
  } catch (error) {
    fail("BACKFILL_SCHEMA_NOT_READY", error instanceof Error ? error.message : String(error), error);
  }
}

async function activeWriterRows(db: SqlReader): Promise<ProductTruthBackfillWriterActivityRow[]> {
  const result = await db.execute(`
    SELECT 'ENRICHMENT_JOB' AS source,id,status,updatedAt
      FROM EnrichmentJob WHERE status='running'
    UNION ALL
    SELECT 'HARVEST',id,status,updatedAt
      FROM DonorHarvestState WHERE status='running'
    UNION ALL
    SELECT 'OPERATIONAL_RUN',runId,status,updatedAt
      FROM ProductTruthOperationalRun WHERE status='running'
    UNION ALL
    SELECT 'METERED_RECEIPT',id,status,updatedAt
      FROM MeteredReservationReceipt WHERE status IN ('pending','reserved')
    ORDER BY source,id
  `);
  return result.rows.map((row) => ({
    source: String(row.source) as ProductTruthBackfillWriterActivityRow["source"],
    id: String(row.id),
    status: String(row.status),
    updatedAt: row.updatedAt == null ? null : String(row.updatedAt),
  }));
}

async function scopeStateRows(
  db: SqlReader,
  manifestListingKeys: ReadonlySet<string>,
): Promise<ProductTruthBackfillScopeStateRow[]> {
  const rows = (await db.execute(`
    SELECT listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
           manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
           sourceReportId,sourceContentSha256,sourceCapturedAt,createdAt
      FROM ProductTruthListingScope ORDER BY listingKey
  `)).rows;
  return rows
    .filter((row) => manifestListingKeys.has(String(row.listingKey)))
    .map((row) => ({
      listingKey: String(row.listingKey),
      keyVersion: String(row.keyVersion),
      channel: String(row.channel),
      storeIndex: Number(row.storeIndex),
      sku: String(row.sku),
      registrationKind: String(row.registrationKind),
      manifestSchemaVersion: String(row.manifestSchemaVersion),
      manifestSha256: String(row.manifestSha256),
      manifestAsOf: String(row.manifestAsOf),
      ownerDecisionId: String(row.ownerDecisionId),
      sourceReportId: String(row.sourceReportId),
      sourceContentSha256: String(row.sourceContentSha256),
      sourceCapturedAt: String(row.sourceCapturedAt),
      createdAt: String(row.createdAt),
    }));
}

async function canonicalOutcomeRows(
  db: SqlReader,
  manifestListingKeys: ReadonlySet<string>,
): Promise<ProductTruthBackfillCanonicalOutcomeRow[]> {
  const rows = (await db.execute(`
    SELECT link.listingKey,cost.id AS skuCostId,cost.evidenceOutcome,
           cost.observationKey,cost.recipeHash,cost.effectiveDate,cost.createdAt
      FROM SkuCostListingScopeLink link
      JOIN SkuCost cost ON cost.id=link.skuCostId
     WHERE cost.source='retail:batch'
       AND cost.observationKey IS NOT NULL
       AND cost.recipeHash IS NOT NULL
       AND cost.evidenceJson IS NOT NULL
       AND cost.evidenceOutcome IN ('FACT','ESTIMATE','UNSOURCEABLE')
       AND json_valid(cost.evidenceJson)
       AND EXISTS (
         SELECT 1 FROM SkuComponentEvidence evidence
          WHERE evidence.skuCostId=cost.id
       )
     ORDER BY link.listingKey,cost.effectiveDate,cost.createdAt,cost.id
  `)).rows;
  return rows
    .filter((row) => manifestListingKeys.has(String(row.listingKey)))
    .map((row) => ({
      listingKey: String(row.listingKey),
      skuCostId: String(row.skuCostId),
      evidenceOutcome: String(row.evidenceOutcome),
      observationKey: String(row.observationKey),
      recipeHash: String(row.recipeHash),
      effectiveDate: String(row.effectiveDate),
      createdAt: String(row.createdAt),
    }));
}

async function foreignKeyViolations(db: SqlReader): Promise<string[]> {
  const rows = (await db.execute("PRAGMA foreign_key_check")).rows;
  return rows.map((row) => [
    String(row.table),
    String(row.rowid ?? ""),
    String(row.parent ?? ""),
    String(row.fkid ?? ""),
  ].join(":"));
}

async function capturePreconditionState(
  db: SqlReader,
  manifest: Phase1ScopeManifest,
): Promise<ProductTruthBackfillPreconditionState> {
  const keys = new Set(manifest.listings.map((listing) => listing.listingKey));
  const [writerActivity, manifestScopeRows, canonicalOutcomes, violations] = await Promise.all([
    activeWriterRows(db),
    scopeStateRows(db, keys),
    canonicalOutcomeRows(db, keys),
    foreignKeyViolations(db),
  ]);
  return {
    writerActivity,
    manifestScopeRows,
    canonicalOutcomes,
    foreignKeyViolations: sortedUnique(violations),
  };
}

function stateSha256(state: ProductTruthBackfillPreconditionState): string {
  return productTruthOperationalSha256(state);
}

function scopeIdentityAndProvenanceEqual(
  actual: ProductTruthBackfillScopeStateRow,
  expected: ProductTruthBackfillScopeStateRow,
  options: { compareCreatedAt: boolean },
): boolean {
  return actual.listingKey === expected.listingKey
    && actual.keyVersion === expected.keyVersion
    && actual.channel === expected.channel
    && actual.storeIndex === expected.storeIndex
    && actual.sku === expected.sku
    && actual.registrationKind === expected.registrationKind
    && actual.manifestSchemaVersion === expected.manifestSchemaVersion
    && actual.manifestSha256 === expected.manifestSha256
    && actual.manifestAsOf === expected.manifestAsOf
    && actual.ownerDecisionId === expected.ownerDecisionId
    && actual.sourceReportId === expected.sourceReportId
    && actual.sourceContentSha256 === expected.sourceContentSha256
    && actual.sourceCapturedAt === expected.sourceCapturedAt
    && (!options.compareCreatedAt || actual.createdAt === expected.createdAt);
}

function reviewTask(listing: Phase1ScopeListing, manifestSha256: string): ProductTruthBackfillReviewTask {
  return {
    taskId: productTruthOperationalSha256({
      version: "product-truth-backfill-review-task/1.0.0",
      manifestSha256,
      listingKey: listing.listingKey,
      reason: "CANONICAL_SCOPED_COST_OUTCOME_MISSING",
    }),
    taskType: "OWNER_CANONICAL_RECIPE_COST_REVIEW",
    listingKey: listing.listingKey,
    channel: listing.channel,
    storeIndex: listing.storeIndex,
    sku: listing.sku,
    reason: "CANONICAL_SCOPED_COST_OUTCOME_MISSING",
    requiredDisposition: "CONFIRM_EXACT_RECIPE_AND_CANONICAL_EVIDENCE",
    execution: "ARTIFACT_ONLY_MANUAL_REVIEW",
    automaticExecution: false,
    providerCallsPermitted: false,
    legacyInferencePermitted: false,
  };
}

export async function planProductTruthOwnerBackfill(
  db: Client,
  input: {
    planId: string;
    manifest: Phase1ScopeManifest;
    manifestJson: string;
    manifestSha256: string;
    databaseTargetFingerprint: string;
    migrationCertification: ProductTruthMigrationCertification;
    createdAt: string;
    expiresAt: string;
  },
): Promise<ProductTruthOwnerBackfillPlan> {
  const planId = safeId(input.planId, "planId");
  const databaseTargetFingerprint = exactSha(
    input.databaseTargetFingerprint,
    "databaseTargetFingerprint",
  );
  const createdAt = instant(input.createdAt, "createdAt");
  const expiresAt = instant(input.expiresAt, "expiresAt");
  if (Date.parse(createdAt) < Date.parse(input.manifest.asOf)) {
    fail("BACKFILL_PLAN_TIME_INVALID", "createdAt must be at or after manifest asOf");
  }
  const validityMs = Date.parse(expiresAt) - Date.parse(createdAt);
  if (validityMs <= 0 || validityMs > 24 * 60 * 60 * 1000) {
    fail("BACKFILL_PLAN_TIME_INVALID", "plan validity must be greater than zero and no more than 24 hours");
  }
  const binding = manifestBinding(input);
  await assertBackfillSchema(db);

  const readiness = await planProductTruthBackfillReadiness(db, {
    manifest: input.manifest,
    manifestJson: input.manifestJson,
    expectedManifestSha256: binding.manifestSha256,
    databaseTargetFingerprint,
    migrationCertification: input.migrationCertification,
    capturedAt: createdAt,
  });
  if (!readiness.readyForOwnerReviewedBackfill || readiness.blockers.length > 0) {
    fail(
      "BACKFILL_READINESS_BLOCKED",
      `readiness blockers: ${readiness.blockers.join(",") || "unknown"}`,
    );
  }

  const state = await capturePreconditionState(db, input.manifest);
  if (state.writerActivity.length > 0) {
    fail("BACKFILL_WRITERS_NOT_QUIESCENT", "active or unsettled writer rows exist");
  }
  if (state.foreignKeyViolations.length > 0) {
    fail("BACKFILL_INTEGRITY_BLOCKED", "foreign-key violations exist");
  }

  const existing = new Map(state.manifestScopeRows.map((row) => [row.listingKey, row]));
  const imports: ProductTruthScopeImportOperation[] = [];
  for (const [ordinal, listing] of input.manifest.listings.entries()) {
    const ownerDecisionId = binding.dispositions.get(`${listing.channel}:${listing.scopeKey}`);
    if (!ownerDecisionId) {
      fail("BACKFILL_MANIFEST_INVALID", `missing IN_SCOPE owner decision for ${listing.listingKey}`);
    }
    const expected = expectedScopeRow({
      listing,
      manifest: input.manifest,
      manifestSha256: binding.manifestSha256,
      ownerDecisionId,
      createdAt,
    });
    const current = existing.get(listing.listingKey);
    if (current) {
      if (!scopeIdentityAndProvenanceEqual(current, expected, { compareCreatedAt: false })) {
        fail("BACKFILL_SCOPE_CONFLICT", `immutable scope conflicts with manifest: ${listing.listingKey}`);
      }
      continue;
    }
    imports.push({
      operation: "INSERT_IMMUTABLE_AUTHORITATIVE_LISTING_SCOPE",
      ordinal,
      row: expected,
    });
  }

  const missingCosts = new Set(readiness.scopeCoverage.listingsWithoutCanonicalCostOutcome);
  const reviewTasks = input.manifest.listings
    .filter((listing) => missingCosts.has(listing.listingKey))
    .map((listing) => reviewTask(listing, binding.manifestSha256));
  const body = {
    schemaVersion: PRODUCT_TRUTH_OWNER_BACKFILL_PLAN_VERSION,
    planId,
    createdAt,
    expiresAt,
    databaseTargetFingerprint,
    manifest: {
      schemaVersion: PHASE1_SCOPE_MANIFEST_VERSION,
      sha256: binding.manifestSha256,
      asOf: input.manifest.asOf,
      listingCount: input.manifest.listings.length,
    },
    migrationCertification: readiness.migrationCertification,
    readinessPlanSha256: readiness.planSha256,
    preconditions: {
      stateSha256: stateSha256(state),
      state,
      writersQuiescent: true as const,
    },
    operations: {
      scopeImports: imports,
      canonicalCostRecomputes: [] as [],
      reviewTasks,
    },
    rollbackPolicy: {
      transactionMode: "SINGLE_WRITE_TRANSACTION" as const,
      rollbackBeforeCommit: true as const,
      postCommitDeleteRollback: false as const,
      recovery: "IDEMPOTENT_EXACT_STATE_RECONCILIATION" as const,
    },
    claims: {
      authoritativeScopeImportOnly: true as const,
      reviewTasksAreArtifactOnly: true as const,
      databaseWritesLimitedToListingScope: true as const,
      canonicalCostWrites: false as const,
      legacyTruthPromotion: false as const,
      providerCalls: false as const,
      paidCalls: false as const,
      marketplaceMutations: false as const,
      procurementMutations: false as const,
    },
  };
  return { ...body, planSha256: productTruthOperationalSha256(body) };
}

export function expectedProductTruthBackfillConfirmation(
  planSha256: string,
  approvalId: string,
): string {
  return `APPLY_PRODUCT_TRUTH_BACKFILL_V1:${exactSha(planSha256, "planSha256")}:${safeId(approvalId, "approvalId")}`;
}

function validatePlanAndManifest(input: {
  plan: ProductTruthOwnerBackfillPlan;
  expectedPlanSha256: string;
  manifest: Phase1ScopeManifest;
  manifestJson: string;
  manifestSha256: string;
  databaseTargetFingerprint: string;
}): { planSha256: string; expectedRows: Map<string, ProductTruthBackfillScopeStateRow> } {
  if (input.plan.schemaVersion !== PRODUCT_TRUTH_OWNER_BACKFILL_PLAN_VERSION) {
    fail("BACKFILL_PLAN_INVALID", "plan schema version is not current");
  }
  const embeddedHash = exactSha(input.plan.planSha256, "plan.planSha256");
  const { planSha256: _omitted, ...body } = input.plan;
  void _omitted;
  const actualHash = productTruthOperationalSha256(body);
  const expectedHash = exactSha(input.expectedPlanSha256, "expectedPlanSha256");
  if (embeddedHash !== actualHash || expectedHash !== actualHash) {
    fail("BACKFILL_PLAN_HASH_MISMATCH", "plan SHA-256 does not match canonical plan bytes");
  }
  const target = exactSha(input.databaseTargetFingerprint, "databaseTargetFingerprint");
  if (input.plan.databaseTargetFingerprint !== target) {
    fail("BACKFILL_TARGET_MISMATCH", "plan belongs to a different database target");
  }
  const binding = manifestBinding(input);
  if (
    input.plan.manifest.sha256 !== binding.manifestSha256
    || input.plan.manifest.schemaVersion !== input.manifest.schemaVersion
    || input.plan.manifest.asOf !== input.manifest.asOf
    || input.plan.manifest.listingCount !== input.manifest.listings.length
  ) {
    fail("BACKFILL_MANIFEST_MISMATCH", "plan and authoritative manifest do not match");
  }
  if (stateSha256(input.plan.preconditions.state) !== input.plan.preconditions.stateSha256) {
    fail("BACKFILL_PRECONDITION_INVALID", "embedded precondition state hash is invalid");
  }
  if (
    input.plan.preconditions.writersQuiescent !== true
    || input.plan.preconditions.state.writerActivity.length !== 0
    || input.plan.preconditions.state.foreignKeyViolations.length !== 0
    || input.plan.operations.canonicalCostRecomputes.length !== 0
    || input.plan.claims.canonicalCostWrites !== false
    || input.plan.claims.legacyTruthPromotion !== false
    || input.plan.claims.providerCalls !== false
    || input.plan.claims.paidCalls !== false
  ) {
    fail("BACKFILL_PLAN_UNSAFE", "plan contains a forbidden writer/provider/legacy action");
  }

  const manifestByKey = new Map(input.manifest.listings.map((listing) => [listing.listingKey, listing]));
  const preexisting = new Map(
    input.plan.preconditions.state.manifestScopeRows.map((row) => [row.listingKey, row]),
  );
  if (preexisting.size !== input.plan.preconditions.state.manifestScopeRows.length) {
    fail("BACKFILL_PLAN_INVALID", "precondition contains duplicate listing-scope rows");
  }
  for (const [listingKey, row] of preexisting) {
    const listing = manifestByKey.get(listingKey);
    const ownerDecisionId = listing
      ? binding.dispositions.get(`${listing.channel}:${listing.scopeKey}`)
      : undefined;
    if (!listing || !ownerDecisionId) {
      fail("BACKFILL_PLAN_INVALID", `precondition contains non-manifest scope ${listingKey}`);
    }
    const expected = expectedScopeRow({
      listing,
      manifest: input.manifest,
      manifestSha256: binding.manifestSha256,
      ownerDecisionId,
      createdAt: row.createdAt,
    });
    if (!scopeIdentityAndProvenanceEqual(row, expected, { compareCreatedAt: true })) {
      fail("BACKFILL_PLAN_INVALID", `preexisting scope conflicts with manifest ${listingKey}`);
    }
  }
  const operations = new Map<string, ProductTruthBackfillScopeStateRow>();
  for (const operation of input.plan.operations.scopeImports) {
    if (operation.operation !== "INSERT_IMMUTABLE_AUTHORITATIVE_LISTING_SCOPE") {
      fail("BACKFILL_PLAN_UNSAFE", "unknown scope import operation");
    }
    const listing = manifestByKey.get(operation.row.listingKey);
    const ownerDecisionId = listing
      ? binding.dispositions.get(`${listing.channel}:${listing.scopeKey}`)
      : undefined;
    if (!listing || !ownerDecisionId || operations.has(operation.row.listingKey)) {
      fail("BACKFILL_PLAN_INVALID", `invalid/duplicate scope operation ${operation.row.listingKey}`);
    }
    const expected = expectedScopeRow({
      listing,
      manifest: input.manifest,
      manifestSha256: binding.manifestSha256,
      ownerDecisionId,
      createdAt: input.plan.createdAt,
    });
    if (!scopeIdentityAndProvenanceEqual(operation.row, expected, { compareCreatedAt: true })) {
      fail("BACKFILL_PLAN_INVALID", `scope operation drift for ${operation.row.listingKey}`);
    }
    operations.set(operation.row.listingKey, operation.row);
  }
  for (const listing of input.manifest.listings) {
    const existed = preexisting.has(listing.listingKey);
    const inserted = operations.has(listing.listingKey);
    if (existed === inserted) {
      fail("BACKFILL_PLAN_INVALID", `scope operation set does not reconcile ${listing.listingKey}`);
    }
  }
  const expectedReviewKeys = new Set(input.manifest.listings
    .map((listing) => listing.listingKey)
    .filter((listingKey) => !input.plan.preconditions.state.canonicalOutcomes
      .some((outcome) => outcome.listingKey === listingKey)));
  const actualReviewKeys = new Set<string>();
  for (const task of input.plan.operations.reviewTasks) {
    const listing = manifestByKey.get(task.listingKey);
    const expected = listing ? reviewTask(listing, binding.manifestSha256) : null;
    if (
      !expected
      || actualReviewKeys.has(task.listingKey)
      || productTruthOperationalSha256(task) !== productTruthOperationalSha256(expected)
    ) {
      fail("BACKFILL_PLAN_INVALID", `review task is not canonical for ${task.listingKey}`);
    }
    actualReviewKeys.add(task.listingKey);
  }
  if (
    actualReviewKeys.size !== expectedReviewKeys.size
    || [...expectedReviewKeys].some((listingKey) => !actualReviewKeys.has(listingKey))
  ) {
    fail("BACKFILL_PLAN_INVALID", "review task set does not reconcile canonical cost gaps");
  }
  return { planSha256: actualHash, expectedRows: operations };
}

function validateApproval(input: {
  approval: ProductTruthOwnerBackfillApproval;
  expectedApprovalSha256: string;
  plan: ProductTruthOwnerBackfillPlan;
  planSha256: string;
  confirmation: string;
  appliedAt: string;
}): string {
  const approvalSha256 = productTruthOperationalSha256(input.approval);
  if (approvalSha256 !== exactSha(input.expectedApprovalSha256, "expectedApprovalSha256")) {
    fail("BACKFILL_APPROVAL_HASH_MISMATCH", "approval SHA-256 does not match canonical approval");
  }
  const approval = input.approval;
  if (
    approval.schemaVersion !== PRODUCT_TRUTH_OWNER_BACKFILL_APPROVAL_VERSION
    || approval.decision !== "APPROVE_AUTHORITATIVE_SCOPE_IMPORT_ONLY"
    || approval.approvedBy !== "owner"
    || approval.planId !== input.plan.planId
    || approval.planSha256 !== input.planSha256
    || approval.databaseTargetFingerprint !== input.plan.databaseTargetFingerprint
    || approval.manifestSha256 !== input.plan.manifest.sha256
    || approval.preconditionStateSha256 !== input.plan.preconditions.stateSha256
    || approval.allowScopeImport !== true
    || approval.allowCanonicalCostRecompute !== false
    || approval.allowLegacyTruthPromotion !== false
  ) {
    fail("BACKFILL_APPROVAL_INVALID", "approval is not exactly bound to the safe scope-import plan");
  }
  safeId(approval.approvalId, "approval.approvalId");
  safeId(approval.ownerDecisionId, "approval.ownerDecisionId");
  exactText(approval.backupReference, "approval.backupReference", 500);
  const issuedAt = instant(approval.issuedAt, "approval.issuedAt");
  const expiresAt = instant(approval.expiresAt, "approval.expiresAt");
  if (
    Date.parse(issuedAt) < Date.parse(input.plan.createdAt)
    || Date.parse(expiresAt) > Date.parse(input.plan.expiresAt)
    || Date.parse(expiresAt) <= Date.parse(issuedAt)
    || Date.parse(input.appliedAt) > Date.parse(expiresAt)
  ) {
    fail("BACKFILL_APPROVAL_EXPIRED", "approval validity is outside the sealed plan window");
  }
  const expectedConfirmation = expectedProductTruthBackfillConfirmation(
    input.planSha256,
    approval.approvalId,
  );
  if (input.confirmation !== expectedConfirmation) {
    fail("BACKFILL_CONFIRMATION_MISMATCH", "exact owner execution confirmation is required");
  }
  return approvalSha256;
}

async function insertScopeRow(tx: Transaction, row: ProductTruthBackfillScopeStateRow): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO ProductTruthListingScope (
      listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
      manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
      sourceReportId,sourceContentSha256,sourceCapturedAt,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      row.listingKey,
      row.keyVersion,
      row.channel,
      row.storeIndex,
      row.sku,
      row.registrationKind,
      row.manifestSchemaVersion,
      row.manifestSha256,
      row.manifestAsOf,
      row.ownerDecisionId,
      row.sourceReportId,
      row.sourceContentSha256,
      row.sourceCapturedAt,
      row.createdAt,
    ],
  });
}

async function verifyScopeImportWithReader(
  db: SqlReader,
  input: {
    manifest: Phase1ScopeManifest;
    manifestSha256: string;
    dispositions: Map<string, string>;
  },
): Promise<ProductTruthBackfillVerification> {
  const state = await capturePreconditionState(db, input.manifest);
  const byKey = new Map(state.manifestScopeRows.map((row) => [row.listingKey, row]));
  const expectedKeys = new Set(input.manifest.listings.map((listing) => listing.listingKey));
  const missing: string[] = [];
  const conflicting: string[] = [];
  let exact = 0;
  for (const listing of input.manifest.listings) {
    const ownerDecisionId = input.dispositions.get(`${listing.channel}:${listing.scopeKey}`);
    if (!ownerDecisionId) {
      conflicting.push(listing.listingKey);
      continue;
    }
    const expected = expectedScopeRow({
      listing,
      manifest: input.manifest,
      manifestSha256: input.manifestSha256,
      ownerDecisionId,
      createdAt: input.manifest.asOf,
    });
    const row = byKey.get(listing.listingKey);
    if (!row) missing.push(listing.listingKey);
    else if (!scopeIdentityAndProvenanceEqual(row, expected, { compareCreatedAt: false })) {
      conflicting.push(listing.listingKey);
    } else exact += 1;
  }
  const unexpectedRows = (await db.execute({
    sql: `SELECT listingKey FROM ProductTruthListingScope
          WHERE manifestSha256=? ORDER BY listingKey`,
    args: [input.manifestSha256],
  })).rows;
  const unexpected = unexpectedRows
    .map((row) => String(row.listingKey))
    .filter((listingKey) => !expectedKeys.has(listingKey));
  const result: ProductTruthBackfillVerification = {
    exactManifestScopes: exact,
    missingListingKeys: sortedUnique(missing),
    conflictingListingKeys: sortedUnique(conflicting),
    unexpectedManifestListingKeys: sortedUnique(unexpected),
    activeWriterRows: state.writerActivity,
    foreignKeyViolations: state.foreignKeyViolations,
    verified: false,
  };
  result.verified = exact === input.manifest.listings.length
    && result.missingListingKeys.length === 0
    && result.conflictingListingKeys.length === 0
    && result.unexpectedManifestListingKeys.length === 0
    && result.activeWriterRows.length === 0
    && result.foreignKeyViolations.length === 0;
  return result;
}

export async function verifyProductTruthBackfillScopeImport(
  db: Client,
  input: {
    manifest: Phase1ScopeManifest;
    manifestJson: string;
    manifestSha256: string;
  },
): Promise<ProductTruthBackfillVerification> {
  const binding = manifestBinding(input);
  await assertBackfillSchema(db);
  return verifyScopeImportWithReader(db, {
    manifest: input.manifest,
    manifestSha256: binding.manifestSha256,
    dispositions: binding.dispositions,
  });
}

export async function applyProductTruthOwnerBackfill(
  db: Client,
  input: {
    plan: ProductTruthOwnerBackfillPlan;
    expectedPlanSha256: string;
    manifest: Phase1ScopeManifest;
    manifestJson: string;
    manifestSha256: string;
    databaseTargetFingerprint: string;
    approval: ProductTruthOwnerBackfillApproval;
    expectedApprovalSha256: string;
    confirmation: string;
    appliedAt: string;
  },
): Promise<ProductTruthOwnerBackfillReport> {
  const appliedAt = instant(input.appliedAt, "appliedAt");
  const validated = validatePlanAndManifest(input);
  if (Date.parse(appliedAt) < Date.parse(input.plan.createdAt)
      || Date.parse(appliedAt) > Date.parse(input.plan.expiresAt)) {
    fail("BACKFILL_PLAN_EXPIRED", "apply time is outside the sealed plan window");
  }
  const approvalSha256 = validateApproval({
    approval: input.approval,
    expectedApprovalSha256: input.expectedApprovalSha256,
    plan: input.plan,
    planSha256: validated.planSha256,
    confirmation: input.confirmation,
    appliedAt,
  });
  await assertBackfillSchema(db);

  const before = await capturePreconditionState(db, input.manifest);
  const beforeHash = stateSha256(before);
  const currentByKey = new Map(before.manifestScopeRows.map((row) => [row.listingKey, row]));
  const allAlreadyApplied = input.plan.operations.scopeImports.every((operation) => {
    const actual = currentByKey.get(operation.row.listingKey);
    return actual != null
      && scopeIdentityAndProvenanceEqual(actual, operation.row, { compareCreatedAt: true });
  });
  if (before.writerActivity.length > 0 || before.foreignKeyViolations.length > 0) {
    fail("BACKFILL_PRECONDITION_CHANGED", "writers are active or integrity violations appeared");
  }
  let status: ProductTruthOwnerBackfillReport["status"];
  let inserted = 0;
  if (beforeHash !== input.plan.preconditions.stateSha256) {
    if (!allAlreadyApplied) {
      fail("BACKFILL_PRECONDITION_CHANGED", "database state changed after the sealed plan");
    }
    status = "ALREADY_APPLIED";
  } else if (input.plan.operations.scopeImports.length === 0) {
    status = "ALREADY_APPLIED";
  } else {
    const tx = await db.transaction("write");
    try {
      const lockedState = await capturePreconditionState(tx, input.manifest);
      if (stateSha256(lockedState) !== input.plan.preconditions.stateSha256) {
        fail("BACKFILL_PRECONDITION_CHANGED", "database state changed while acquiring writer lock");
      }
      if (lockedState.writerActivity.length > 0 || lockedState.foreignKeyViolations.length > 0) {
        fail("BACKFILL_WRITERS_NOT_QUIESCENT", "writer quiescence was lost before apply");
      }
      for (const operation of input.plan.operations.scopeImports) {
        await insertScopeRow(tx, operation.row);
        inserted += 1;
      }
      const lockedVerification = await verifyScopeImportWithReader(tx, {
        manifest: input.manifest,
        manifestSha256: input.plan.manifest.sha256,
        dispositions: manifestBinding(input).dispositions,
      });
      if (!lockedVerification.verified) {
        fail("BACKFILL_VERIFY_FAILED", "exact scope/integrity verification failed before commit");
      }
      await tx.commit();
      status = "APPLIED";
    } catch (error) {
      if (!tx.closed) await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  }

  const verification = await verifyProductTruthBackfillScopeImport(db, input);
  if (!verification.verified) {
    fail("BACKFILL_VERIFY_FAILED", "post-commit exact scope/integrity verification failed");
  }
  const postState = await capturePreconditionState(db, input.manifest);
  const completedAt = appliedAt;
  const body = {
    schemaVersion: PRODUCT_TRUTH_OWNER_BACKFILL_REPORT_VERSION,
    status,
    planId: input.plan.planId,
    planSha256: validated.planSha256,
    approvalId: input.approval.approvalId,
    approvalSha256,
    databaseTargetFingerprint: input.plan.databaseTargetFingerprint,
    manifestSha256: input.plan.manifest.sha256,
    startedAt: appliedAt,
    completedAt,
    preconditionStateSha256: input.plan.preconditions.stateSha256,
    postStateSha256: stateSha256(postState),
    counts: {
      plannedScopeImports: input.plan.operations.scopeImports.length,
      insertedScopeRows: inserted,
      exactExistingScopeRows: verification.exactManifestScopes - inserted,
      reviewTasks: input.plan.operations.reviewTasks.length,
      canonicalCostRecomputes: 0 as const,
    },
    verification,
    reviewTasks: input.plan.operations.reviewTasks,
    claims: input.plan.claims,
  };
  return { ...body, reportSha256: productTruthOperationalSha256(body) };
}

interface ArtifactFile {
  name: string;
  content: string;
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
}

async function writeAtomicFile(directory: string, file: ArtifactFile): Promise<void> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(file.name)) {
    fail("BACKFILL_ARTIFACT_INVALID", `unsafe artifact name ${file.name}`);
  }
  const destination = resolve(directory, file.name);
  if (dirname(destination) !== directory) {
    fail("BACKFILL_ARTIFACT_INVALID", `unsafe artifact path ${file.name}`);
  }
  const temporary = resolve(directory, `.${file.name}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(file.content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
}

async function writeNewArtifactDirectory(outputDirectory: string, files: readonly ArtifactFile[]): Promise<void> {
  const output = resolve(outputDirectory);
  const parent = dirname(output);
  let parentStats;
  try {
    parentStats = await lstat(parent);
  } catch (error) {
    fail("BACKFILL_ARTIFACT_PARENT_MISSING", `artifact parent does not exist: ${parent}`, error);
  }
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    fail("BACKFILL_ARTIFACT_PARENT_INVALID", "artifact parent must be a real directory");
  }
  if (await realpath(parent) !== parent) {
    fail("BACKFILL_ARTIFACT_PARENT_INVALID", "artifact parent must be a canonical path");
  }
  try {
    await mkdir(output, { mode: 0o700 });
  } catch (error) {
    fail("BACKFILL_ARTIFACT_EXISTS", `artifact directory must not exist: ${output}`, error);
  }
  for (const file of files) await writeAtomicFile(output, file);
  await syncDirectory(output);
  await syncDirectory(parent);
}

export async function writeProductTruthBackfillPlanArtifacts(
  outputDirectory: string,
  plan: ProductTruthOwnerBackfillPlan,
): Promise<{ planSha256: string; outputDirectory: string }> {
  const { planSha256: _omitted, ...body } = plan;
  void _omitted;
  const digest = productTruthOperationalSha256(body);
  if (digest !== plan.planSha256) {
    fail("BACKFILL_PLAN_HASH_MISMATCH", "cannot write an invalid plan artifact");
  }
  const instructions = {
    schemaVersion: "product-truth-owner-backfill-approval-instructions/1.0.0",
    planId: plan.planId,
    planSha256: digest,
    databaseTargetFingerprint: plan.databaseTargetFingerprint,
    manifestSha256: plan.manifest.sha256,
    requiredApprovalVersion: PRODUCT_TRUTH_OWNER_BACKFILL_APPROVAL_VERSION,
    requiredDecision: "APPROVE_AUTHORITATIVE_SCOPE_IMPORT_ONLY",
    requiredConfirmation: `APPLY_PRODUCT_TRUTH_BACKFILL_V1:${digest}:<OWNER_APPROVAL_ID>`,
    scopeImports: plan.operations.scopeImports.length,
    reviewTasks: plan.operations.reviewTasks.length,
    canonicalCostRecomputes: 0,
    warning: "Scope rows are immutable after commit. Approval permits no legacy promotion, provider call, cost write, marketplace mutation, or procurement mutation.",
  };
  await writeNewArtifactDirectory(outputDirectory, [
    { name: "plan.json", content: renderProductTruthOperationalJson(plan) },
    { name: "plan.sha256", content: `${digest}\n` },
    { name: "approval-instructions.json", content: renderProductTruthOperationalJson(instructions) },
  ]);
  return { planSha256: digest, outputDirectory: resolve(outputDirectory) };
}

export async function writeProductTruthBackfillReportArtifacts(
  outputDirectory: string,
  report: ProductTruthOwnerBackfillReport,
): Promise<{ reportSha256: string; artifactIndexSha256: string; outputDirectory: string }> {
  const { reportSha256: _omitted, ...body } = report;
  void _omitted;
  const reportSha256 = productTruthOperationalSha256(body);
  if (reportSha256 !== report.reportSha256) {
    fail("BACKFILL_REPORT_HASH_MISMATCH", "cannot write an invalid report artifact");
  }
  const reportJson = renderProductTruthOperationalJson(report);
  const index = {
    schemaVersion: PRODUCT_TRUTH_OWNER_BACKFILL_ARTIFACT_INDEX_VERSION,
    planId: report.planId,
    planSha256: report.planSha256,
    approvalId: report.approvalId,
    approvalSha256: report.approvalSha256,
    databaseTargetFingerprint: report.databaseTargetFingerprint,
    manifestSha256: report.manifestSha256,
    artifacts: [{
      path: "report.json",
      mediaType: "application/json",
      byteLength: Buffer.byteLength(reportJson),
      sha256: createHash("sha256").update(reportJson).digest("hex"),
    }],
  };
  const indexJson = renderProductTruthOperationalJson(index);
  const artifactIndexSha256 = createHash("sha256").update(indexJson).digest("hex");
  await writeNewArtifactDirectory(outputDirectory, [
    { name: "report.json", content: reportJson },
    { name: "report.sha256", content: `${reportSha256}\n` },
    { name: "artifact-index.json", content: indexJson },
    { name: "artifact-index.sha256", content: `${artifactIndexSha256}\n` },
  ]);
  return { reportSha256, artifactIndexSha256, outputDirectory: resolve(outputDirectory) };
}
