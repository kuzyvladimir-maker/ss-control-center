import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { createClient, type Client } from "@libsql/client";

import {
  PHASE1_SCOPE_DISPOSITION_VERSION,
  buildPhase1ScopeManifest,
  parsePhase1DelimitedText,
  renderPhase1ScopeManifestJson,
  sha256Hex,
  type Phase1Channel,
  type Phase1ScopeDispositionEntry,
  type Phase1ScopeManifest,
} from "../phase1-scope-manifest";
import { makeTestConnectedStoreCensus } from "./phase1-connected-store-census-fixture";
import {
  PRODUCT_TRUTH_MIGRATION_CERTIFICATION_VERSION,
  type ProductTruthMigrationCertification,
} from "../product-truth-backfill-readiness";
import {
  PRODUCT_TRUTH_OWNER_BACKFILL_APPROVAL_VERSION,
  ProductTruthBackfillWriterError,
  applyProductTruthOwnerBackfill,
  expectedProductTruthBackfillConfirmation,
  planProductTruthOwnerBackfill,
  verifyProductTruthBackfillScopeImport,
  writeProductTruthBackfillPlanArtifacts,
  writeProductTruthBackfillReportArtifacts,
  type ProductTruthOwnerBackfillApproval,
  type ProductTruthOwnerBackfillPlan,
} from "../../../../scripts/product-truth-backfill-writer";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "../product-truth-operational-run-contract";
import {
  parseProductTruthRunnerArguments,
  runProductTruthRunnerCli,
} from "../../../../scripts/product-truth-runner";
import {
  applyProductTruthMigrations,
  buildProductTruthMigrationConfirmationToken,
  canonicalProductTruthMigrationArtifact,
  planProductTruthMigrations,
  productTruthMigrationArtifactSha256,
  writeProductTruthMigrationPlanArtifact,
  type ProductTruthMigrationApprovalV2,
} from "../../../../scripts/product-truth-migration-plan";

const CREATED_AT = "2026-07-19T12:05:00.000Z";
const APPLY_AT = "2026-07-19T12:10:00.000Z";
const TARGET_FINGERPRINT = "1".repeat(64);
const MIGRATION_IDS = [
  "20260718230000_product_truth_queue_v2",
  "20260718233000_donor_harvest_lifecycle",
  "20260718234500_product_truth_evidence_provenance",
  "20260719000000_metered_budget_ledger",
  "20260719001000_product_truth_metered_evidence_link",
  "20260719002000_product_truth_listing_scope",
  "20260719003000_product_truth_queue_listing_scope",
  "20260719004000_product_truth_operational_run",
] as const;

const amazonReport = [
  "item-name\tseller-sku\tasin1\tstatus\tfulfillment-channel",
  "Acme One\tAMZ-1\tB000000001\tActive\tDEFAULT",
].join("\n");
const walmartReport = [
  "SKU,Item ID,Product Name,Published Status,Lifecycle Status",
  "WM-1,10001,Acme Two,Published,Active",
].join("\n");

function disposition(channel: Phase1Channel, content: string): Phase1ScopeDispositionEntry {
  return {
    channel,
    scopeKey: "store1",
    storeIndex: 1,
    accountId: `${channel}-account-1`,
    storeId: `${channel}-store-1`,
    marketplaceId: channel === "amazon" ? "ATVPDKIKX0DER" : null,
    disposition: "IN_SCOPE",
    decision: {
      authority: "OWNER",
      decisionId: `${channel}-owner-decision-1`,
      decidedBy: "Vladimir",
      decidedAt: "2026-07-19T10:00:00.000Z",
      reason: "Owner-reviewed backfill fixture",
    },
    report: {
      reportType: channel === "amazon"
        ? "GET_MERCHANT_LISTINGS_ALL_DATA"
        : "ITEM_CATALOG",
      reportId: `${channel}-report-1`,
      capturedAt: "2026-07-19T11:00:00.000Z",
      expectedRowCount: parsePhase1DelimitedText(content).rows.length,
      expectedContentSha256: sha256Hex(content),
    },
  };
}

function manifest(): Phase1ScopeManifest {
  const value = buildPhase1ScopeManifest({
    asOf: "2026-07-19T12:00:00.000Z",
    connectedStoreCensus: makeTestConnectedStoreCensus({
      asOf: "2026-07-19T12:00:00.000Z",
      identityStyle: "index",
    }),
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [
        disposition("amazon", amazonReport),
        disposition("walmart", walmartReport),
      ],
    },
    reports: [
      { channel: "amazon", scopeKey: "store1", sourceName: "amazon.tsv", content: amazonReport },
      { channel: "walmart", scopeKey: "store1", sourceName: "walmart.csv", content: walmartReport },
    ],
  });
  assert.equal(value.authoritative, true);
  assert.deepEqual(value.blockers, []);
  return value;
}

function certification(): ProductTruthMigrationCertification {
  return {
    contractVersion: PRODUCT_TRUTH_MIGRATION_CERTIFICATION_VERSION,
    migrationSetSha256: "2".repeat(64),
    migrationReportSha256: "3".repeat(64),
    schemaFingerprintSha256: "4".repeat(64),
    databaseTargetFingerprint: TARGET_FINGERPRINT,
    allMigrationsApplied: true,
    allReceiptsTracked: true,
    receiptLedgerReady: true,
  };
}

async function createBaseSchema(db: Client): Promise<void> {
  await db.execute("PRAGMA foreign_keys=ON");
  await db.executeMultiple(`
    CREATE TABLE EnrichmentJob (
      id TEXT PRIMARY KEY,
      targetType TEXT NOT NULL DEFAULT 'brand',
      target TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      source TEXT NOT NULL DEFAULT 'manual',
      priority INTEGER NOT NULL DEFAULT 0,
      requestedBy TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      queuedAt DATETIME,
      startedAt DATETIME,
      finishedAt DATETIME,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE DonorProduct (
      id TEXT PRIMARY KEY,
      identityKey TEXT UNIQUE,
      brand TEXT,
      productLine TEXT,
      flavor TEXT,
      containerType TEXT,
      size TEXT
    );
    CREATE TABLE DonorOffer (
      id TEXT PRIMARY KEY,
      donorProductId TEXT NOT NULL,
      retailer TEXT NOT NULL,
      retailerProductId TEXT NOT NULL,
      via TEXT NOT NULL DEFAULT 'direct'
    );
    CREATE UNIQUE INDEX DonorOffer_retailer_retailerProductId_key
      ON DonorOffer(retailer, retailerProductId);
    CREATE TABLE SkuComponent (id TEXT PRIMARY KEY, donorProductId TEXT);
    CREATE TABLE SkuCost (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      asin TEXT,
      effectiveDate DATETIME,
      productCost REAL,
      packagingCost REAL,
      iceCost REAL,
      totalCost REAL,
      costPerUnit REAL,
      packSize INTEGER,
      includesPackaging INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      source TEXT NOT NULL,
      confidence REAL,
      needsReview INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX SkuCost_sku_source_effectiveDate_key
      ON SkuCost(sku, source, effectiveDate);
    CREATE TABLE "_prisma_migrations" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    );
  `);
  // A pre-migration positive legacy cost must remain legacy. The writer may
  // neither scope it nor copy it into canonical evidence.
  await db.execute(`
    INSERT INTO SkuCost (
      id,sku,effectiveDate,totalCost,costPerUnit,packSize,source,createdAt,updatedAt
    ) VALUES (
      'legacy-cost-1','AMZ-1','2026-07-18T00:00:00.000Z',9.99,9.99,1,
      'legacy:manual','2026-07-18T00:00:00.000Z','2026-07-18T00:00:00.000Z'
    )
  `);
}

async function baseDatabase(t: TestContext): Promise<{ db: Client; url: string }> {
  const directory = await mkdtemp(join(tmpdir(), "product-truth-backfill-writer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const url = `file:${join(directory, "product-truth.sqlite")}`;
  const db = createClient({ url, concurrency: 1 });
  await createBaseSchema(db);
  return { db, url };
}

async function migratedDatabase(t: TestContext): Promise<{ db: Client; url: string }> {
  const base = await baseDatabase(t);
  for (const migrationId of MIGRATION_IDS) {
    const migrationUrl = new URL(
      `../../../../prisma/migrations/${migrationId}/migration.sql`,
      import.meta.url,
    );
    await base.db.executeMultiple(await readFile(migrationUrl, "utf8"));
  }
  return base;
}

async function migratedDb(t: TestContext): Promise<Client> {
  return (await migratedDatabase(t)).db;
}

async function activateCanonicalMigrations(input: {
  databaseUrl: string;
  artifactRoot: string;
}): Promise<Awaited<ReturnType<typeof applyProductTruthMigrations>>> {
  const runId = "migration-run-backfill-cli-1";
  const approvalId = "migration-approval-backfill-cli-1";
  const migrationPlan = await planProductTruthMigrations({
    databaseUrl: input.databaseUrl,
    runId,
    approvalId,
    now: () => new Date("2026-07-19T11:40:00.000Z"),
  });
  assert.equal(migrationPlan.canApply, true, migrationPlan.blockers.join("; "));
  assert.ok(migrationPlan.database);
  assert.ok(migrationPlan.schema);
  assert.ok(migrationPlan.queueImpact);
  assert.ok(migrationPlan.writerActivity);
  const sealedPlan = await writeProductTruthMigrationPlanArtifact(
    migrationPlan,
    join(input.artifactRoot, "migration-plan"),
  );
  const migrationApproval: ProductTruthMigrationApprovalV2 = {
    contractVersion: "product-truth-migration-approval/2",
    decision: "APPROVE_PRODUCT_TRUTH_MIGRATIONS",
    approvedBy: "owner",
    runId,
    approvalId,
    planSha256: sealedPlan.planSha256,
    migrationSetSha256: migrationPlan.migrationSetSha256,
    activationContractSha256: migrationPlan.activationContractSha256,
    targetFingerprint: migrationPlan.database.targetFingerprint,
    schemaBeforeSha256: migrationPlan.schema.sha256,
    queueImpactSha256: migrationPlan.queueImpact.sha256,
    writerActivitySha256: migrationPlan.writerActivity.sha256,
    writersQuiesced: true,
    backupReference: "local-test:snapshot-before-canonical-migrations",
    issuedAt: "2026-07-19T11:41:00.000Z",
    expiresAt: "2026-07-19T11:59:00.000Z",
  };
  const approvalPath = join(input.artifactRoot, "migration-approval.json");
  const approvalShaPath = join(input.artifactRoot, "migration-approval.sha256");
  await writeFile(
    approvalPath,
    canonicalProductTruthMigrationArtifact(migrationApproval),
    "utf8",
  );
  const approvalSha256 = productTruthMigrationArtifactSha256(migrationApproval);
  await writeFile(approvalShaPath, `${approvalSha256}\n`, "utf8");
  return applyProductTruthMigrations({
    databaseUrl: input.databaseUrl,
    planPath: sealedPlan.planPath,
    planSha256Path: sealedPlan.planSha256Path,
    approvalPath,
    approvalSha256Path: approvalShaPath,
    confirmationToken: buildProductTruthMigrationConfirmationToken({
      runId,
      approvalId,
      activationContractSha256: migrationPlan.activationContractSha256,
      planSha256: sealedPlan.planSha256,
      approvalSha256,
      targetFingerprint: migrationPlan.database.targetFingerprint,
    }),
    outputDirectory: join(input.artifactRoot, "migration-apply"),
    now: () => new Date("2026-07-19T11:45:00.000Z"),
  });
}

async function buildPlan(db: Client): Promise<{
  plan: ProductTruthOwnerBackfillPlan;
  scope: Phase1ScopeManifest;
  manifestJson: string;
  manifestSha256: string;
}> {
  const scope = manifest();
  const manifestJson = renderPhase1ScopeManifestJson(scope);
  const manifestSha256 = sha256Hex(manifestJson);
  const plan = await planProductTruthOwnerBackfill(db, {
    planId: "owner-backfill-test-1",
    manifest: scope,
    manifestJson,
    manifestSha256,
    databaseTargetFingerprint: TARGET_FINGERPRINT,
    migrationCertification: certification(),
    createdAt: CREATED_AT,
    expiresAt: "2026-07-19T13:00:00.000Z",
  });
  return { plan, scope, manifestJson, manifestSha256 };
}

function approval(plan: ProductTruthOwnerBackfillPlan): ProductTruthOwnerBackfillApproval {
  return {
    schemaVersion: PRODUCT_TRUTH_OWNER_BACKFILL_APPROVAL_VERSION,
    decision: "APPROVE_AUTHORITATIVE_SCOPE_IMPORT_ONLY",
    approvedBy: "owner",
    approvalId: "owner-approval-test-1",
    ownerDecisionId: "owner-backfill-decision-test-1",
    planId: plan.planId,
    planSha256: plan.planSha256,
    databaseTargetFingerprint: plan.databaseTargetFingerprint,
    manifestSha256: plan.manifest.sha256,
    preconditionStateSha256: plan.preconditions.stateSha256,
    allowScopeImport: true,
    allowCanonicalCostRecompute: false,
    allowLegacyTruthPromotion: false,
    backupReference: "local-test:snapshot-before-scope-import",
    issuedAt: "2026-07-19T12:06:00.000Z",
    expiresAt: "2026-07-19T12:30:00.000Z",
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof ProductTruthBackfillWriterError ? error.code : undefined;
}

test("seals exact scope imports and artifact-only owner review work without writes", async (t) => {
  const db = await migratedDb(t);
  try {
    const before = await db.execute(`
      SELECT
        (SELECT COUNT(*) FROM ProductTruthListingScope) AS scopes,
        (SELECT COUNT(*) FROM EnrichmentJob) AS jobs,
        (SELECT COUNT(*) FROM SkuCost) AS costs
    `);
    const first = await buildPlan(db);
    const second = await buildPlan(db);
    const after = await db.execute(`
      SELECT
        (SELECT COUNT(*) FROM ProductTruthListingScope) AS scopes,
        (SELECT COUNT(*) FROM EnrichmentJob) AS jobs,
        (SELECT COUNT(*) FROM SkuCost) AS costs
    `);

    assert.equal(first.plan.planSha256, second.plan.planSha256);
    assert.equal(first.plan.operations.scopeImports.length, 2);
    assert.equal(first.plan.operations.reviewTasks.length, 2);
    assert.deepEqual(first.plan.operations.canonicalCostRecomputes, []);
    assert.equal(first.plan.claims.databaseWritesLimitedToListingScope, true);
    assert.equal(first.plan.claims.canonicalCostWrites, false);
    assert.equal(first.plan.claims.legacyTruthPromotion, false);
    assert.equal(first.plan.claims.providerCalls, false);
    assert.equal(first.plan.claims.paidCalls, false);
    assert.equal(first.plan.operations.reviewTasks.every((task) =>
      task.execution === "ARTIFACT_ONLY_MANUAL_REVIEW"
      && task.automaticExecution === false
      && task.legacyInferencePermitted === false), true);
    assert.deepEqual({ ...after.rows[0] }, { ...before.rows[0] });

    const parent = await mkdtemp(join(tmpdir(), "product-truth-backfill-artifacts-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const output = join(await realpath(parent), "sealed-plan");
    await writeProductTruthBackfillPlanArtifacts(output, first.plan);
    assert.deepEqual((await readdir(output)).sort(), [
      "approval-instructions.json",
      "plan.json",
      "plan.sha256",
    ]);
    await assert.rejects(
      writeProductTruthBackfillPlanArtifacts(output, first.plan),
      (error) => errorCode(error) === "BACKFILL_ARTIFACT_EXISTS",
    );
  } finally {
    await db.close();
  }
});

test("owner-approved apply is atomic, verified, idempotent, and never scopes legacy cost", async (t) => {
  const db = await migratedDb(t);
  try {
    const prepared = await buildPlan(db);
    const approved = approval(prepared.plan);
    const approvalSha256 = productTruthOperationalSha256(approved);
    const confirmation = expectedProductTruthBackfillConfirmation(
      prepared.plan.planSha256,
      approved.approvalId,
    );
    const input = {
      plan: prepared.plan,
      expectedPlanSha256: prepared.plan.planSha256,
      manifest: prepared.scope,
      manifestJson: prepared.manifestJson,
      manifestSha256: prepared.manifestSha256,
      databaseTargetFingerprint: TARGET_FINGERPRINT,
      approval: approved,
      expectedApprovalSha256: approvalSha256,
      confirmation,
      appliedAt: APPLY_AT,
    };
    const report = await applyProductTruthOwnerBackfill(db, input);
    assert.equal(report.status, "APPLIED");
    assert.equal(report.counts.insertedScopeRows, 2);
    assert.equal(report.counts.canonicalCostRecomputes, 0);
    assert.equal(report.verification.verified, true);

    const rows = await db.execute("SELECT listingKey,manifestSha256 FROM ProductTruthListingScope ORDER BY listingKey");
    assert.deepEqual(rows.rows.map((row) => String(row.listingKey)), [
      "amazon:1:AMZ-1",
      "walmart:1:WM-1",
    ]);
    assert.equal(rows.rows.every((row) => row.manifestSha256 === prepared.manifestSha256), true);
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM SkuCostListingScopeLink")).rows[0]?.n, 0);
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM SkuComponentEvidence")).rows[0]?.n, 0);
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM EnrichmentJob")).rows[0]?.n, 0);
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM SkuCost")).rows[0]?.n, 1);

    const replay = await applyProductTruthOwnerBackfill(db, input);
    assert.equal(replay.status, "ALREADY_APPLIED");
    assert.equal(replay.counts.insertedScopeRows, 0);
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM ProductTruthListingScope")).rows[0]?.n, 2);

    const verification = await verifyProductTruthBackfillScopeImport(db, {
      manifest: prepared.scope,
      manifestJson: prepared.manifestJson,
      manifestSha256: prepared.manifestSha256,
    });
    assert.equal(verification.verified, true);

    const parent = await mkdtemp(join(tmpdir(), "product-truth-backfill-report-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const artifact = await writeProductTruthBackfillReportArtifacts(
      join(await realpath(parent), "report"),
      report,
    );
    assert.match(artifact.reportSha256, /^[a-f0-9]{64}$/);
    assert.match(artifact.artifactIndexSha256, /^[a-f0-9]{64}$/);
  } finally {
    await db.close();
  }
});

test("approval, target, and state drift fail closed before any scope write", async (t) => {
  const db = await migratedDb(t);
  try {
    const prepared = await buildPlan(db);
    const approved = approval(prepared.plan);
    const approvalSha256 = productTruthOperationalSha256(approved);
    const common = {
      plan: prepared.plan,
      expectedPlanSha256: prepared.plan.planSha256,
      manifest: prepared.scope,
      manifestJson: prepared.manifestJson,
      manifestSha256: prepared.manifestSha256,
      databaseTargetFingerprint: TARGET_FINGERPRINT,
      approval: approved,
      expectedApprovalSha256: approvalSha256,
      confirmation: expectedProductTruthBackfillConfirmation(
        prepared.plan.planSha256,
        approved.approvalId,
      ),
      appliedAt: APPLY_AT,
    };
    await assert.rejects(
      applyProductTruthOwnerBackfill(db, { ...common, confirmation: `${common.confirmation}:wrong` }),
      (error) => errorCode(error) === "BACKFILL_CONFIRMATION_MISMATCH",
    );
    await assert.rejects(
      applyProductTruthOwnerBackfill(db, {
        ...common,
        databaseTargetFingerprint: "9".repeat(64),
      }),
      (error) => errorCode(error) === "BACKFILL_TARGET_MISMATCH",
    );

    await db.execute({
      sql: `INSERT INTO EnrichmentJob (
        id,targetType,target,normalizedTarget,idempotencyKey,requestedFields,status,
        source,priority,attempts,estimatedSpendUnits,actualSpendUnits,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "active-writer", "brand", "acme", "acme", "a".repeat(64), "[\"identity\"]",
        "running", "manual", 0, 0, 0, 0, APPLY_AT, APPLY_AT,
      ],
    });
    await assert.rejects(
      applyProductTruthOwnerBackfill(db, common),
      (error) => errorCode(error) === "BACKFILL_PRECONDITION_CHANGED",
    );
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM ProductTruthListingScope")).rows[0]?.n, 0);
  } finally {
    await db.close();
  }
});

test("an insert failure rolls the entire scope import transaction back", async (t) => {
  const db = await migratedDb(t);
  try {
    const prepared = await buildPlan(db);
    const approved = approval(prepared.plan);
    await db.executeMultiple(`
      CREATE TRIGGER test_abort_second_scope
      BEFORE INSERT ON ProductTruthListingScope
      WHEN NEW.channel='walmart'
      BEGIN
        SELECT RAISE(ABORT, 'TEST_ABORT_SECOND_SCOPE');
      END;
    `);
    await assert.rejects(
      applyProductTruthOwnerBackfill(db, {
        plan: prepared.plan,
        expectedPlanSha256: prepared.plan.planSha256,
        manifest: prepared.scope,
        manifestJson: prepared.manifestJson,
        manifestSha256: prepared.manifestSha256,
        databaseTargetFingerprint: TARGET_FINGERPRINT,
        approval: approved,
        expectedApprovalSha256: productTruthOperationalSha256(approved),
        confirmation: expectedProductTruthBackfillConfirmation(
          prepared.plan.planSha256,
          approved.approvalId,
        ),
        appliedAt: APPLY_AT,
      }),
    );
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM ProductTruthListingScope")).rows[0]?.n, 0);
  } finally {
    await db.close();
  }
});

test("canonical CLI exposes explicit sealed backfill-plan and backfill-apply steps", async (t) => {
  const preparedDb = await baseDatabase(t);
  await preparedDb.db.close();
  const root = await realpath(await mkdtemp(join(tmpdir(), "product-truth-backfill-cli-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const migrationActivation = await activateCanonicalMigrations({
    databaseUrl: preparedDb.url,
    artifactRoot: root,
  });
  const scope = manifest();
  const manifestJson = renderPhase1ScopeManifestJson(scope);
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, manifestJson, "utf8");

  const parsedPlan = parseProductTruthRunnerArguments([
    "backfill-plan",
    "--manifest", manifestPath,
    "--migration-certification", migrationActivation.migrationCertificationPath,
    "--migration-certification-sha", migrationActivation.migrationCertificationSha256Path,
    "--migration-report", migrationActivation.reportPath,
    "--migration-report-sha", migrationActivation.reportSha256Path,
    "--plan-id", "owner-backfill-cli-1",
    "--expires-at", "2026-07-19T13:00:00.000Z",
    "--url", preparedDb.url,
    "--out", join(root, "plan"),
  ]);
  assert.equal(parsedPlan.command, "backfill-plan");

  const planStdout: string[] = [];
  assert.equal(await runProductTruthRunnerCli([
    "backfill-plan",
    "--manifest", manifestPath,
    "--migration-certification", migrationActivation.migrationCertificationPath,
    "--migration-certification-sha", migrationActivation.migrationCertificationSha256Path,
    "--migration-report", migrationActivation.reportPath,
    "--migration-report-sha", migrationActivation.reportSha256Path,
    "--plan-id", "owner-backfill-cli-1",
    "--expires-at", "2026-07-19T13:00:00.000Z",
    "--url", preparedDb.url,
    "--out", join(root, "plan"),
  ], {
    cwd: root,
    now: () => CREATED_AT,
    stdout: (text) => planStdout.push(text),
    stderr: assert.fail,
  }), 0);
  const planResult = JSON.parse(planStdout.join("")) as Record<string, unknown>;
  assert.equal(planResult.command, "backfill-plan");
  assert.equal(planResult.providerCalls, 0);
  assert.equal(planResult.databaseWrites, 0);
  assert.equal(planResult.canonicalCostRecomputes, 0);
  assert.equal(planResult.migrationReportSha256, migrationActivation.reportSha256);
  assert.equal(
    planResult.migrationCertificationSha256,
    migrationActivation.migrationCertificationSha256,
  );
  assert.deepEqual(planResult.migrationLedgers, { productTruth: "ready", prisma: "ready" });

  const planPath = join(root, "plan", "plan.json");
  const planShaPath = join(root, "plan", "plan.sha256");
  const sealedPlan = JSON.parse(
    await readFile(planPath, "utf8"),
  ) as ProductTruthOwnerBackfillPlan;
  const sealedApproval = approval(sealedPlan);
  const approvalPath = join(root, "approval.json");
  const approvalShaPath = join(root, "approval.sha256");
  const approvalJson = renderProductTruthOperationalJson(sealedApproval);
  await writeFile(approvalPath, approvalJson, "utf8");
  await writeFile(
    approvalShaPath,
    `${productTruthOperationalSha256(sealedApproval)}\n`,
    "utf8",
  );
  const confirmation = expectedProductTruthBackfillConfirmation(
    sealedPlan.planSha256,
    sealedApproval.approvalId,
  );
  const applyStdout: string[] = [];
  assert.equal(await runProductTruthRunnerCli([
    "backfill-apply",
    "--plan", planPath,
    "--plan-sha", planShaPath,
    "--manifest", manifestPath,
    "--approval", approvalPath,
    "--approval-sha", approvalShaPath,
    "--confirm", confirmation,
    "--url", preparedDb.url,
    "--out", join(root, "apply"),
  ], {
    cwd: root,
    now: () => APPLY_AT,
    stdout: (text) => applyStdout.push(text),
    stderr: assert.fail,
  }), 0);
  const applyResult = JSON.parse(applyStdout.join("")) as Record<string, unknown>;
  assert.equal(applyResult.command, "backfill-apply");
  assert.equal(applyResult.status, "APPLIED");
  assert.equal(applyResult.providerCalls, 0);
  assert.equal(applyResult.paidCalls, 0);
  assert.equal(applyResult.canonicalCostRecomputes, 0);
  assert.deepEqual((await readdir(join(root, "apply"))).sort(), [
    "artifact-index.json",
    "artifact-index.sha256",
    "report.json",
    "report.sha256",
  ]);

  const verifyDb = createClient({ url: preparedDb.url, concurrency: 1 });
  try {
    assert.equal(
      (await verifyDb.execute("SELECT COUNT(*) AS n FROM ProductTruthListingScope")).rows[0]?.n,
      2,
    );
    assert.equal(
      (await verifyDb.execute("SELECT COUNT(*) AS n FROM SkuCostListingScopeLink")).rows[0]?.n,
      0,
    );
    assert.equal((await verifyDb.execute("SELECT COUNT(*) AS n FROM EnrichmentJob")).rows[0]?.n, 0);
  } finally {
    await verifyDb.close();
  }

  const forgedReport = JSON.parse(
    await readFile(migrationActivation.reportPath, "utf8"),
  ) as Record<string, unknown>;
  forgedReport.approvalId = "forged-migration-approval";
  const forgedReportJson = canonicalProductTruthMigrationArtifact(forgedReport);
  const forgedReportSha256 = productTruthMigrationArtifactSha256(forgedReport);
  const forgedReportPath = join(root, "forged-migration-report.json");
  const forgedReportShaPath = join(root, "forged-migration-report.sha256");
  await writeFile(forgedReportPath, forgedReportJson, "utf8");
  await writeFile(forgedReportShaPath, `${forgedReportSha256}\n`, "utf8");
  const forgedCertification = JSON.parse(
    await readFile(migrationActivation.migrationCertificationPath, "utf8"),
  ) as Record<string, unknown>;
  forgedCertification.migrationReportSha256 = forgedReportSha256;
  const forgedCertificationPath = join(root, "forged-migration-certification.json");
  const forgedCertificationShaPath = join(root, "forged-migration-certification.sha256");
  await writeFile(
    forgedCertificationPath,
    canonicalProductTruthMigrationArtifact(forgedCertification),
    "utf8",
  );
  await writeFile(
    forgedCertificationShaPath,
    `${productTruthMigrationArtifactSha256(forgedCertification)}\n`,
    "utf8",
  );
  const forgedStderr: string[] = [];
  assert.equal(await runProductTruthRunnerCli([
    "backfill-plan",
    "--manifest", manifestPath,
    "--migration-certification", forgedCertificationPath,
    "--migration-certification-sha", forgedCertificationShaPath,
    "--migration-report", forgedReportPath,
    "--migration-report-sha", forgedReportShaPath,
    "--plan-id", "forged-backfill-plan",
    "--expires-at", "2026-07-19T13:00:00.000Z",
    "--url", preparedDb.url,
    "--out", join(root, "forged-backfill-plan"),
  ], {
    cwd: root,
    now: () => CREATED_AT,
    stdout: assert.fail,
    stderr: (text) => forgedStderr.push(text),
  }), 1);
  assert.match(forgedStderr.join(""), /MIGRATION_ACTIVATION_RECEIPT_MISMATCH/);

  const remoteStderr: string[] = [];
  assert.equal(await runProductTruthRunnerCli([
    "backfill-plan",
    "--manifest", manifestPath,
    "--migration-certification", migrationActivation.migrationCertificationPath,
    "--migration-certification-sha", migrationActivation.migrationCertificationSha256Path,
    "--migration-report", migrationActivation.reportPath,
    "--migration-report-sha", migrationActivation.reportSha256Path,
    "--plan-id", "remote-denied",
    "--expires-at", "2026-07-19T13:00:00.000Z",
    "--url", "libsql://catalog.example.invalid",
    "--allow-remote",
    "--out", join(root, "remote-plan"),
  ], {
    cwd: root,
    env: { NODE_ENV: "test" },
    stdout: assert.fail,
    stderr: (text) => remoteStderr.push(text),
  }), 64);
  assert.match(remoteStderr.join(""), /REMOTE_DATABASE_AUTH_ENV_REQUIRED/);
});

test("writer source has no provider, marketplace, credential, or cost mutation path", async () => {
  const source = await readFile(
    new URL("../../../../scripts/product-truth-backfill-writer.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bfetch\s*\(|process\.env|unwrangle|oxylabs|anthropic|gemini|sp-api|walmart.*feed/i);
  assert.doesNotMatch(source, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?(?:SkuCost|SkuComponentEvidence|DonorProduct|DonorOffer)/i);
  assert.match(source, /INSERT INTO ProductTruthListingScope/);
  assert.match(source, /transaction\("write"\)/);
});
