import type { Client, Transaction } from "@libsql/client";

import {
  PHASE1_SCOPE_MANIFEST_VERSION,
  renderPhase1ScopeManifestJson,
  sha256Hex,
  validatePhase1ScopeManifestV3Policy,
  type Phase1ScopeManifest,
} from "./phase1-scope-manifest";
import { PRODUCT_TRUTH_LISTING_KEY_VERSION } from "./product-truth-listing-scope";
import { productTruthOperationalSha256 } from "./product-truth-operational-run-contract";
import { assertProductTruthOperationalRunSchema } from "./product-truth-operational-run-store";
import {
  assertDonorHarvestSchema,
  assertProductTruthEvidenceSchema,
  assertProductTruthListingScopeSchema,
  assertProductTruthMeteredEvidenceSchema,
} from "./product-truth-schema-gate";

export const PRODUCT_TRUTH_BACKFILL_READINESS_VERSION =
  "product-truth-backfill-readiness/1.0.0" as const;
export const PRODUCT_TRUTH_MIGRATION_CERTIFICATION_VERSION =
  "product-truth-migration-certification/1.0.0" as const;

export interface ProductTruthMigrationCertification {
  contractVersion: typeof PRODUCT_TRUTH_MIGRATION_CERTIFICATION_VERSION;
  migrationSetSha256: string;
  migrationReportSha256: string;
  schemaFingerprintSha256: string;
  databaseTargetFingerprint: string;
  allMigrationsApplied: boolean;
  allReceiptsTracked: boolean;
  receiptLedgerReady: boolean;
}

export interface ProductTruthBackfillStage {
  ordinal: number;
  stage:
    | "MIGRATION_CERTIFICATION"
    | "WRITER_QUIESCENCE"
    | "AUTHORITATIVE_SCOPE_IMPORT"
    | "CANONICAL_IDENTITY_CONTENT_REVIEW"
    | "CANONICAL_SCOPED_COST_RECOMPUTE"
    | "READ_ONLY_INTEGRITY_VERIFICATION";
  status: "READY" | "PENDING" | "BLOCKED" | "REVIEW_REQUIRED";
  counts: Record<string, number>;
  blockers: string[];
  execution: "READ_ONLY" | "SEPARATE_OWNER_REVIEWED_WRITER_REQUIRED";
}

export interface ProductTruthBackfillReadinessPlan {
  contractVersion: typeof PRODUCT_TRUTH_BACKFILL_READINESS_VERSION;
  mode: "READ_ONLY_NO_PAID_PLAN";
  capturedAt: string;
  databaseTargetFingerprint: string;
  authoritativeManifestSha256: string;
  migrationCertification: ProductTruthMigrationCertification;
  catalogCounts: {
    donorProducts: number;
    legacyUnverifiedDonors: number;
    exactConfirmedDonors: number;
    canonicalVariants: number;
    exactVariantDecisions: number;
    contentObservations: number;
    offerObservations: number;
    skuCosts: number;
    legacyOrUnscopedSkuCosts: number;
    canonicalScopedSkuCosts: number;
    componentEvidence: number;
  };
  scopeCoverage: {
    manifestListings: number;
    exactRegistryListings: number;
    missingRegistryListingKeys: string[];
    conflictingRegistryListingKeys: string[];
    unexpectedCurrentManifestListingKeys: string[];
    listingsWithoutCanonicalCostOutcome: string[];
  };
  writerActivity: {
    runningEnrichmentJobs: number;
    runningHarvestRows: number;
    runningOperationalRuns: number;
    unsettledMeteredReceipts: number;
  };
  integrity: {
    foreignKeyViolations: number;
    foreignKeyViolationSamples: string[];
    exactProjectionWithoutDecision: number;
    exactDecisionWithoutProjection: number;
  };
  stages: ProductTruthBackfillStage[];
  blockers: string[];
  readyForOwnerReviewedBackfill: boolean;
  readyForConsumerShadow: boolean;
  claims: {
    databaseWrites: false;
    providerCalls: false;
    paidCalls: false;
    marketplaceMutations: false;
    procurementMutations: false;
    legacyTruthPromotion: false;
  };
  planSha256: string;
}

export class ProductTruthBackfillReadinessError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthBackfillReadinessError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthBackfillReadinessError(code, message);
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("BACKFILL_INPUT_INVALID", `${label} must be an exact lowercase SHA-256 digest`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    fail("BACKFILL_INPUT_INVALID", `${label} must be exact timestamp text`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("BACKFILL_INPUT_INVALID", `${label} must be a canonical UTC ISO-8601 instant`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    fail("BACKFILL_SNAPSHOT_INVALID", `${label} must be a non-negative integer`);
  }
  return result;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en-US"));
}

function validateManifest(input: {
  manifest: Phase1ScopeManifest;
  manifestJson: string;
  expectedManifestSha256: string;
}): { manifestSha256: string; canonicalJson: string } {
  const expectedManifestSha256 = exactSha256(
    input.expectedManifestSha256,
    "expectedManifestSha256",
  );
  if (input.manifest.schemaVersion !== PHASE1_SCOPE_MANIFEST_VERSION) {
    fail("BACKFILL_MANIFEST_INVALID", "manifest schema version is not current");
  }
  const policyErrors = validatePhase1ScopeManifestV3Policy(input.manifest);
  if (policyErrors.length > 0) {
    fail(
      "BACKFILL_MANIFEST_INVALID",
      `manifest v3 policy binding is invalid: ${policyErrors.join("; ")}`,
    );
  }
  if (
    input.manifest.authoritative !== true
    || input.manifest.blockers.length !== 0
    || input.manifest.counts.blockerCount !== 0
    || input.manifest.counts.liveListings !== input.manifest.listings.length
  ) {
    fail(
      "BACKFILL_MANIFEST_NOT_AUTHORITATIVE",
      "manifest must be authoritative, reconciled, and have zero blockers",
    );
  }
  const canonicalJson = renderPhase1ScopeManifestJson(input.manifest);
  if (canonicalJson !== input.manifestJson) {
    fail(
      "BACKFILL_MANIFEST_INVALID",
      "manifest bytes must exactly equal the canonical manifest rendering",
    );
  }
  const manifestSha256 = sha256Hex(canonicalJson);
  if (manifestSha256 !== expectedManifestSha256) {
    fail("BACKFILL_MANIFEST_HASH_MISMATCH", "manifest SHA-256 does not match its bytes");
  }
  return { manifestSha256, canonicalJson };
}

function validateCertification(
  value: ProductTruthMigrationCertification,
  targetFingerprint: string,
): ProductTruthMigrationCertification {
  if (
    !value
    || typeof value !== "object"
    || value.contractVersion !== PRODUCT_TRUTH_MIGRATION_CERTIFICATION_VERSION
  ) {
    fail(
      "BACKFILL_MIGRATION_CERTIFICATION_INVALID",
      `migration certification must use ${PRODUCT_TRUTH_MIGRATION_CERTIFICATION_VERSION}`,
    );
  }
  const result: ProductTruthMigrationCertification = {
    contractVersion: PRODUCT_TRUTH_MIGRATION_CERTIFICATION_VERSION,
    migrationSetSha256: exactSha256(value.migrationSetSha256, "migrationSetSha256"),
    migrationReportSha256: exactSha256(
      value.migrationReportSha256,
      "migrationReportSha256",
    ),
    schemaFingerprintSha256: exactSha256(
      value.schemaFingerprintSha256,
      "schemaFingerprintSha256",
    ),
    databaseTargetFingerprint: exactSha256(
      value.databaseTargetFingerprint,
      "migrationCertification.databaseTargetFingerprint",
    ),
    allMigrationsApplied: value.allMigrationsApplied === true,
    allReceiptsTracked: value.allReceiptsTracked === true,
    receiptLedgerReady: value.receiptLedgerReady === true,
  };
  if (result.databaseTargetFingerprint !== targetFingerprint) {
    fail(
      "BACKFILL_DATABASE_TARGET_MISMATCH",
      "migration certification belongs to a different database target",
    );
  }
  return result;
}

async function scalarCounts(tx: Transaction): Promise<ProductTruthBackfillReadinessPlan["catalogCounts"]> {
  const result = await tx.execute(`
    SELECT
      (SELECT COUNT(*) FROM DonorProduct) AS donorProducts,
      (SELECT COUNT(*) FROM DonorProduct
        WHERE identityStatus='legacy_unverified') AS legacyUnverifiedDonors,
      (SELECT COUNT(*) FROM DonorProduct
        WHERE identityStatus='exact_confirmed') AS exactConfirmedDonors,
      (SELECT COUNT(*) FROM CanonicalProductVariant) AS canonicalVariants,
      (SELECT COUNT(*) FROM DonorProductVariantDecision
        WHERE decisionStatus='exact_confirmed') AS exactVariantDecisions,
      (SELECT COUNT(*) FROM ProductContentObservation) AS contentObservations,
      (SELECT COUNT(*) FROM DonorOfferObservation) AS offerObservations,
      (SELECT COUNT(*) FROM SkuCost) AS skuCosts,
      (SELECT COUNT(*) FROM SkuCost cost
        WHERE cost.source <> 'retail:batch'
           OR cost.observationKey IS NULL
           OR cost.recipeHash IS NULL
           OR cost.evidenceJson IS NULL
           OR cost.evidenceOutcome NOT IN ('FACT','ESTIMATE','UNSOURCEABLE')
           OR NOT EXISTS (
             SELECT 1 FROM SkuCostListingScopeLink link
             WHERE link.skuCostId=cost.id
           )) AS legacyOrUnscopedSkuCosts,
      (SELECT COUNT(*) FROM SkuCost cost
        WHERE cost.source='retail:batch'
          AND cost.observationKey IS NOT NULL
          AND cost.recipeHash IS NOT NULL
          AND cost.evidenceJson IS NOT NULL
          AND cost.evidenceOutcome IN ('FACT','ESTIMATE','UNSOURCEABLE')
          AND EXISTS (
            SELECT 1 FROM SkuCostListingScopeLink link
            WHERE link.skuCostId=cost.id
          )
          AND EXISTS (
            SELECT 1 FROM SkuComponentEvidence evidence
            WHERE evidence.skuCostId=cost.id
          )) AS canonicalScopedSkuCosts,
      (SELECT COUNT(*) FROM SkuComponentEvidence) AS componentEvidence
  `);
  const row = result.rows[0] ?? {};
  return {
    donorProducts: integer(row.donorProducts, "donorProducts"),
    legacyUnverifiedDonors: integer(row.legacyUnverifiedDonors, "legacyUnverifiedDonors"),
    exactConfirmedDonors: integer(row.exactConfirmedDonors, "exactConfirmedDonors"),
    canonicalVariants: integer(row.canonicalVariants, "canonicalVariants"),
    exactVariantDecisions: integer(row.exactVariantDecisions, "exactVariantDecisions"),
    contentObservations: integer(row.contentObservations, "contentObservations"),
    offerObservations: integer(row.offerObservations, "offerObservations"),
    skuCosts: integer(row.skuCosts, "skuCosts"),
    legacyOrUnscopedSkuCosts: integer(
      row.legacyOrUnscopedSkuCosts,
      "legacyOrUnscopedSkuCosts",
    ),
    canonicalScopedSkuCosts: integer(
      row.canonicalScopedSkuCosts,
      "canonicalScopedSkuCosts",
    ),
    componentEvidence: integer(row.componentEvidence, "componentEvidence"),
  };
}

async function writerActivity(
  tx: Transaction,
): Promise<ProductTruthBackfillReadinessPlan["writerActivity"]> {
  const result = await tx.execute(`
    SELECT
      (SELECT COUNT(*) FROM EnrichmentJob WHERE status='running')
        AS runningEnrichmentJobs,
      (SELECT COUNT(*) FROM DonorHarvestState WHERE status='running')
        AS runningHarvestRows,
      (SELECT COUNT(*) FROM ProductTruthOperationalRun WHERE status='running')
        AS runningOperationalRuns,
      (SELECT COUNT(*) FROM MeteredReservationReceipt
        WHERE status IN ('pending','reserved')) AS unsettledMeteredReceipts
  `);
  const row = result.rows[0] ?? {};
  return {
    runningEnrichmentJobs: integer(row.runningEnrichmentJobs, "runningEnrichmentJobs"),
    runningHarvestRows: integer(row.runningHarvestRows, "runningHarvestRows"),
    runningOperationalRuns: integer(row.runningOperationalRuns, "runningOperationalRuns"),
    unsettledMeteredReceipts: integer(
      row.unsettledMeteredReceipts,
      "unsettledMeteredReceipts",
    ),
  };
}

const PRODUCT_TRUTH_FOREIGN_KEY_TABLES = new Set([
  "DonorHarvestState",
  "DonorProductVariantDecision",
  "ProductContentObservation",
  "DonorOfferObservation",
  "SkuComponentEvidence",
  "MeteredReservationReceipt",
  "MeteredReservationSettlement",
  "SkuCostListingScopeLink",
  "EnrichmentJob",
  "ProductTruthOperationalRunItem",
  "ProductTruthOperationalEvent",
]);

async function integritySnapshot(
  tx: Transaction,
): Promise<ProductTruthBackfillReadinessPlan["integrity"]> {
  const violations = (await tx.execute("PRAGMA foreign_key_check")).rows
    .filter((row) => PRODUCT_TRUTH_FOREIGN_KEY_TABLES.has(String(row.table)))
    .map((row) => [
      String(row.table),
      String(row.rowid ?? ""),
      String(row.parent ?? ""),
      String(row.fkid ?? ""),
    ].join(":"));
  const projection = await tx.execute(`
    SELECT
      (SELECT COUNT(*) FROM DonorProduct product
        WHERE product.identityStatus='exact_confirmed'
          AND NOT EXISTS (
            SELECT 1 FROM DonorProductVariantDecision decision
            WHERE decision.donorProductId=product.id
              AND decision.decisionStatus='exact_confirmed'
              AND decision.canonicalVariantId IS NOT NULL
          )) AS exactProjectionWithoutDecision,
      (SELECT COUNT(*) FROM DonorProductVariantDecision decision
        JOIN DonorProduct product ON product.id=decision.donorProductId
        WHERE decision.decisionStatus='exact_confirmed'
          AND product.identityStatus <> 'exact_confirmed')
        AS exactDecisionWithoutProjection
  `);
  const row = projection.rows[0] ?? {};
  return {
    foreignKeyViolations: violations.length,
    foreignKeyViolationSamples: sortedUnique(violations).slice(0, 50),
    exactProjectionWithoutDecision: integer(
      row.exactProjectionWithoutDecision,
      "exactProjectionWithoutDecision",
    ),
    exactDecisionWithoutProjection: integer(
      row.exactDecisionWithoutProjection,
      "exactDecisionWithoutProjection",
    ),
  };
}

async function scopeCoverage(input: {
  tx: Transaction;
  manifest: Phase1ScopeManifest;
  manifestSha256: string;
  capturedAt: string;
}): Promise<ProductTruthBackfillReadinessPlan["scopeCoverage"]> {
  const rows = (await input.tx.execute(`
    SELECT listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
           manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
           sourceReportId,sourceContentSha256,sourceCapturedAt
    FROM ProductTruthListingScope ORDER BY listingKey
  `)).rows;
  const byListingKey = new Map(rows.map((row) => [String(row.listingKey), row]));
  const dispositions = new Map(input.manifest.scopeDispositions.map((scope) => [
    `${scope.channel}:${scope.scopeKey}`,
    scope,
  ]));
  const expectedKeys = new Set(input.manifest.listings.map((listing) => listing.listingKey));
  const missing: string[] = [];
  const conflicting: string[] = [];
  let exact = 0;
  for (const listing of input.manifest.listings) {
    const row = byListingKey.get(listing.listingKey);
    if (!row) {
      missing.push(listing.listingKey);
      continue;
    }
    const disposition = dispositions.get(`${listing.channel}:${listing.scopeKey}`);
    if (
      row.keyVersion === PRODUCT_TRUTH_LISTING_KEY_VERSION
      && row.channel === listing.channel
      && Number(row.storeIndex) === listing.storeIndex
      && row.sku === listing.sku
      && row.registrationKind === "AUTHORITATIVE_PHASE1_MANIFEST"
      && row.manifestSchemaVersion === PHASE1_SCOPE_MANIFEST_VERSION
      && row.manifestSha256 === input.manifestSha256
      && row.manifestAsOf === input.manifest.asOf
      && row.ownerDecisionId === disposition?.decisionId
      && row.sourceReportId === listing.sourceReportId
      && row.sourceContentSha256 === listing.sourceContentSha256
      && row.sourceCapturedAt === listing.sourceCapturedAt
    ) {
      exact += 1;
    } else {
      conflicting.push(listing.listingKey);
    }
  }
  const unexpected = rows
    .filter((row) => row.manifestSha256 === input.manifestSha256)
    .map((row) => String(row.listingKey))
    .filter((listingKey) => !expectedKeys.has(listingKey));

  const canonicalRows = (await input.tx.execute({
    sql: `SELECT scope.listingKey,
      SUM(CASE WHEN cost.source='retail:batch'
        AND cost.observationKey IS NOT NULL
        AND cost.recipeHash IS NOT NULL
        AND cost.evidenceJson IS NOT NULL
        AND cost.evidenceOutcome IN ('FACT','ESTIMATE','UNSOURCEABLE')
        AND json_valid(cost.evidenceJson)
        AND json_extract(cost.evidenceJson,'$.channel')=scope.channel
        AND json_extract(cost.evidenceJson,'$.storeIndex')=scope.storeIndex
        AND json_extract(cost.evidenceJson,'$.listingKey')=scope.listingKey
        AND cost.sku=scope.sku
        AND julianday(cost.effectiveDate)<=julianday(?)
        AND julianday(cost.createdAt)<=julianday(?)
        AND EXISTS (
          SELECT 1 FROM SkuComponentEvidence evidence
          WHERE evidence.skuCostId=cost.id
        ) THEN 1 ELSE 0 END) AS canonicalOutcomes
      FROM ProductTruthListingScope scope
      LEFT JOIN SkuCostListingScopeLink link ON link.listingKey=scope.listingKey
      LEFT JOIN SkuCost cost ON cost.id=link.skuCostId
      WHERE scope.manifestSha256=?
      GROUP BY scope.listingKey ORDER BY scope.listingKey`,
    args: [input.capturedAt, input.capturedAt, input.manifestSha256],
  })).rows;
  const canonicalByKey = new Map(canonicalRows.map((row) => [
    String(row.listingKey),
    integer(row.canonicalOutcomes, `canonicalOutcomes:${String(row.listingKey)}`),
  ]));
  const withoutCanonicalOutcome = input.manifest.listings
    .map((listing) => listing.listingKey)
    .filter((listingKey) => (canonicalByKey.get(listingKey) ?? 0) < 1);

  return {
    manifestListings: input.manifest.listings.length,
    exactRegistryListings: exact,
    missingRegistryListingKeys: sortedUnique(missing),
    conflictingRegistryListingKeys: sortedUnique(conflicting),
    unexpectedCurrentManifestListingKeys: sortedUnique(unexpected),
    listingsWithoutCanonicalCostOutcome: sortedUnique(withoutCanonicalOutcome),
  };
}

function stage(
  ordinal: number,
  name: ProductTruthBackfillStage["stage"],
  status: ProductTruthBackfillStage["status"],
  counts: Record<string, number>,
  blockers: string[],
  execution: ProductTruthBackfillStage["execution"],
): ProductTruthBackfillStage {
  return {
    ordinal,
    stage: name,
    status,
    counts,
    blockers: sortedUnique(blockers),
    execution,
  };
}

/**
 * Produce a consistent, read-only plan. Schema validation and every data query
 * are local DB reads; this function contains no provider or marketplace path.
 */
export async function planProductTruthBackfillReadiness(
  db: Client,
  input: {
    manifest: Phase1ScopeManifest;
    manifestJson: string;
    expectedManifestSha256: string;
    databaseTargetFingerprint: string;
    migrationCertification: ProductTruthMigrationCertification;
    capturedAt: string;
  },
): Promise<ProductTruthBackfillReadinessPlan> {
  const databaseTargetFingerprint = exactSha256(
    input.databaseTargetFingerprint,
    "databaseTargetFingerprint",
  );
  const capturedAt = canonicalInstant(input.capturedAt, "capturedAt");
  const { manifestSha256 } = validateManifest(input);
  if (Date.parse(capturedAt) < Date.parse(input.manifest.asOf)) {
    fail("BACKFILL_INPUT_INVALID", "capturedAt must be at or after manifest asOf");
  }
  const migrationCertification = validateCertification(
    input.migrationCertification,
    databaseTargetFingerprint,
  );

  try {
    await assertProductTruthEvidenceSchema(db);
    await assertDonorHarvestSchema(db);
    await assertProductTruthListingScopeSchema(db);
    await assertProductTruthMeteredEvidenceSchema(db);
    await assertProductTruthOperationalRunSchema(db);
  } catch (error) {
    fail(
      "BACKFILL_SCHEMA_NOT_READY",
      error instanceof Error ? error.message : String(error),
    );
  }

  const tx = await db.transaction("read");
  let counts: ProductTruthBackfillReadinessPlan["catalogCounts"];
  let activity: ProductTruthBackfillReadinessPlan["writerActivity"];
  let integrity: ProductTruthBackfillReadinessPlan["integrity"];
  let coverage: ProductTruthBackfillReadinessPlan["scopeCoverage"];
  try {
    counts = await scalarCounts(tx);
    activity = await writerActivity(tx);
    integrity = await integritySnapshot(tx);
    coverage = await scopeCoverage({
      tx,
      manifest: input.manifest,
      manifestSha256,
      capturedAt,
    });
    await tx.commit();
  } catch (error) {
    if (!tx.closed) await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }

  const certificationBlockers = [
    !migrationCertification.allMigrationsApplied
      ? "MIGRATIONS_NOT_ALL_APPLIED"
      : null,
    !migrationCertification.allReceiptsTracked
      ? "MIGRATION_RECEIPTS_NOT_ALL_TRACKED"
      : null,
    !migrationCertification.receiptLedgerReady
      ? "MIGRATION_RECEIPT_LEDGER_NOT_READY"
      : null,
  ].filter((value): value is string => value !== null);
  const activityTotal = Object.values(activity).reduce((sum, value) => sum + value, 0);
  const activityBlockers = activityTotal === 0 ? [] : ["PRODUCT_TRUTH_WRITERS_NOT_QUIESCENT"];
  const scopeBlockers = [
    coverage.conflictingRegistryListingKeys.length > 0
      ? "LISTING_SCOPE_REGISTRY_CONFLICT"
      : null,
    coverage.unexpectedCurrentManifestListingKeys.length > 0
      ? "UNEXPECTED_CURRENT_MANIFEST_SCOPE"
      : null,
  ].filter((value): value is string => value !== null);
  const integrityBlockers = [
    integrity.foreignKeyViolations > 0 ? "PRODUCT_TRUTH_FOREIGN_KEY_VIOLATION" : null,
    integrity.exactProjectionWithoutDecision > 0
      ? "EXACT_PROJECTION_WITHOUT_IMMUTABLE_DECISION"
      : null,
    integrity.exactDecisionWithoutProjection > 0
      ? "EXACT_DECISION_WITHOUT_MATERIALIZED_PROJECTION"
      : null,
  ].filter((value): value is string => value !== null);

  const stages: ProductTruthBackfillStage[] = [
    stage(
      0,
      "MIGRATION_CERTIFICATION",
      certificationBlockers.length ? "BLOCKED" : "READY",
      { certifiedMigrations: migrationCertification.allMigrationsApplied ? 1 : 0 },
      certificationBlockers,
      "READ_ONLY",
    ),
    stage(
      1,
      "WRITER_QUIESCENCE",
      activityBlockers.length ? "BLOCKED" : "READY",
      activity,
      activityBlockers,
      "READ_ONLY",
    ),
    stage(
      2,
      "AUTHORITATIVE_SCOPE_IMPORT",
      scopeBlockers.length
        ? "BLOCKED"
        : coverage.missingRegistryListingKeys.length
          ? "PENDING"
          : "READY",
      {
        manifestListings: coverage.manifestListings,
        exactRegistryListings: coverage.exactRegistryListings,
        missingRegistryListings: coverage.missingRegistryListingKeys.length,
        conflictingRegistryListings: coverage.conflictingRegistryListingKeys.length,
      },
      scopeBlockers,
      coverage.missingRegistryListingKeys.length
        ? "SEPARATE_OWNER_REVIEWED_WRITER_REQUIRED"
        : "READ_ONLY",
    ),
    stage(
      3,
      "CANONICAL_IDENTITY_CONTENT_REVIEW",
      counts.legacyUnverifiedDonors > 0 ? "REVIEW_REQUIRED" : "READY",
      {
        legacyUnverifiedDonors: counts.legacyUnverifiedDonors,
        exactConfirmedDonors: counts.exactConfirmedDonors,
        canonicalVariants: counts.canonicalVariants,
        contentObservations: counts.contentObservations,
      },
      [],
      counts.legacyUnverifiedDonors > 0
        ? "SEPARATE_OWNER_REVIEWED_WRITER_REQUIRED"
        : "READ_ONLY",
    ),
    stage(
      4,
      "CANONICAL_SCOPED_COST_RECOMPUTE",
      coverage.listingsWithoutCanonicalCostOutcome.length > 0
        ? "PENDING"
        : "READY",
      {
        listingsWithoutCanonicalCostOutcome:
          coverage.listingsWithoutCanonicalCostOutcome.length,
        legacyOrUnscopedSkuCosts: counts.legacyOrUnscopedSkuCosts,
        canonicalScopedSkuCosts: counts.canonicalScopedSkuCosts,
      },
      [],
      coverage.listingsWithoutCanonicalCostOutcome.length > 0
        ? "SEPARATE_OWNER_REVIEWED_WRITER_REQUIRED"
        : "READ_ONLY",
    ),
    stage(
      5,
      "READ_ONLY_INTEGRITY_VERIFICATION",
      integrityBlockers.length ? "BLOCKED" : "READY",
      {
        foreignKeyViolations: integrity.foreignKeyViolations,
        exactProjectionWithoutDecision: integrity.exactProjectionWithoutDecision,
        exactDecisionWithoutProjection: integrity.exactDecisionWithoutProjection,
      },
      integrityBlockers,
      "READ_ONLY",
    ),
  ];
  const blockers = sortedUnique([
    ...certificationBlockers,
    ...activityBlockers,
    ...scopeBlockers,
    ...integrityBlockers,
  ]);
  const readyForOwnerReviewedBackfill = blockers.length === 0;
  const readyForConsumerShadow = readyForOwnerReviewedBackfill
    && coverage.missingRegistryListingKeys.length === 0
    && coverage.exactRegistryListings === coverage.manifestListings
    && coverage.listingsWithoutCanonicalCostOutcome.length === 0;

  const body = {
    contractVersion: PRODUCT_TRUTH_BACKFILL_READINESS_VERSION,
    mode: "READ_ONLY_NO_PAID_PLAN" as const,
    capturedAt,
    databaseTargetFingerprint,
    authoritativeManifestSha256: manifestSha256,
    migrationCertification,
    catalogCounts: counts,
    scopeCoverage: coverage,
    writerActivity: activity,
    integrity,
    stages,
    blockers,
    readyForOwnerReviewedBackfill,
    readyForConsumerShadow,
    claims: {
      databaseWrites: false as const,
      providerCalls: false as const,
      paidCalls: false as const,
      marketplaceMutations: false as const,
      procurementMutations: false as const,
      legacyTruthPromotion: false as const,
    },
  };
  return {
    ...body,
    planSha256: productTruthOperationalSha256(body),
  };
}
