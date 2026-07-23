import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import { createClient } from "@libsql/client";

import {
  applyProductTruthMigrations,
  buildProductTruthMigrationConfirmationToken,
  canonicalProductTruthMigrationArtifact,
  loadProductTruthMigrationFiles,
  migrationSetSha256,
  planProductTruthMigrations,
  type ProductTruthMigrationApprovalV2,
  type ProductTruthMigrationPlan,
  ProductTruthMigrationPlanError,
  productTruthMigrationArtifactSha256,
  PRODUCT_TRUTH_CHECK_CONSTRAINT_ENFORCEMENT_QUERY,
  recoverProductTruthMigrationReport,
  runProductTruthMigrationCli,
  writeProductTruthMigrationPlanArtifact,
} from "../../../../scripts/product-truth-migration-plan";

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

const SOURCE_MIGRATIONS_ROOT = fileURLToPath(
  new URL("../../../../prisma/migrations/", import.meta.url),
);
const PLAN_TIME = "2026-07-19T03:00:00.000Z";
const APPLY_TIME = "2026-07-19T03:05:00.000Z";

test("check-constraint enforcement uses the Turso-safe table-valued pragma", async () => {
  assert.equal(
    PRODUCT_TRUTH_CHECK_CONSTRAINT_ENFORCEMENT_QUERY,
    "SELECT ignore_check_constraints FROM pragma_ignore_check_constraints",
  );
  assert.equal(/^PRAGMA\b/i.test(PRODUCT_TRUTH_CHECK_CONSTRAINT_ENFORCEMENT_QUERY), false);
  const db = createClient({ url: ":memory:" });
  const transaction = await db.transaction("write");
  try {
    const result = await transaction.execute(
      PRODUCT_TRUTH_CHECK_CONSTRAINT_ENFORCEMENT_QUERY,
    );
    assert.equal(Number(result.rows[0]?.ignore_check_constraints ?? -1), 0);
  } finally {
    if (!transaction.closed) await transaction.rollback();
    transaction.close();
    await db.close();
  }
});

async function createBaseProductTruthSchema(url: string): Promise<void> {
  const db = createClient({ url });
  try {
    await db.executeMultiple(`
      CREATE TABLE "_prisma_migrations" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "checksum" TEXT NOT NULL,
        "finished_at" DATETIME,
        "migration_name" TEXT NOT NULL,
        "logs" TEXT,
        "rolled_back_at" DATETIME,
        "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
        "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
      );
      CREATE TABLE EnrichmentJob (
        id TEXT PRIMARY KEY,
        targetType TEXT NOT NULL DEFAULT 'brand',
        target TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        queuedAt DATETIME,
        finishedAt DATETIME,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE DonorProduct (
        id TEXT PRIMARY KEY,
        identityKey TEXT,
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
      CREATE TABLE SkuComponent (
        id TEXT PRIMARY KEY,
        donorProductId TEXT
      );
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
    `);
  } finally {
    await db.close();
  }
}

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function temporaryDatabase(t: TestContext): Promise<string> {
  const directory = await temporaryDirectory(t, "product-truth-migration-db-");
  return `file:${join(directory, "product-truth.db")}`;
}

async function copyMigrationSet(t: TestContext): Promise<string> {
  const root = await temporaryDirectory(t, "product-truth-migrations-");
  for (const migrationId of MIGRATION_IDS) {
    const targetDirectory = join(root, migrationId);
    const targetPath = join(targetDirectory, "migration.sql");
    await mkdir(targetDirectory, { recursive: true });
    await copyFile(
      join(SOURCE_MIGRATIONS_ROOT, migrationId, "migration.sql"),
      targetPath,
    );
    // Frozen release inputs are deliberately 0444. This disposable test copy
    // must be writable so adversarial rollback/COMMIT mutations stay in tmp.
    await chmod(targetPath, 0o600);
  }
  return root;
}

async function sealJson(
  directory: string,
  basename: string,
  value: unknown,
): Promise<{ jsonPath: string; sha256Path: string; sha256: string }> {
  await mkdir(directory, { recursive: true });
  const bytes = canonicalProductTruthMigrationArtifact(value);
  const digest = productTruthMigrationArtifactSha256(value);
  const jsonPath = join(directory, `${basename}.json`);
  const sha256Path = join(directory, `${basename}.sha256`);
  await writeFile(jsonPath, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await writeFile(sha256Path, `${digest}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { jsonPath, sha256Path, sha256: digest };
}

async function makeApproval(
  directory: string,
  plan: ProductTruthMigrationPlan,
  planSha256: string,
  options: { issuedAt?: string; expiresAt?: string } = {},
): Promise<{
  approval: ProductTruthMigrationApprovalV2;
  approvalPath: string;
  approvalSha256Path: string;
  approvalSha256: string;
}> {
  assert.ok(plan.database && plan.schema && plan.queueImpact && plan.writerActivity);
  assert.ok(plan.runId && plan.approvalId);
  const approval: ProductTruthMigrationApprovalV2 = {
    contractVersion: "product-truth-migration-approval/2",
    decision: "APPROVE_PRODUCT_TRUTH_MIGRATIONS",
    approvedBy: "owner",
    runId: plan.runId,
    approvalId: plan.approvalId,
    planSha256,
    migrationSetSha256: plan.migrationSetSha256,
    activationContractSha256: plan.activationContractSha256,
    targetFingerprint: plan.database.targetFingerprint,
    schemaBeforeSha256: plan.schema.sha256,
    queueImpactSha256: plan.queueImpact.sha256,
    writerActivitySha256: plan.writerActivity.sha256,
    writersQuiesced: true,
    backupReference: "snapshot:test-product-truth-before-activation",
    issuedAt: options.issuedAt ?? PLAN_TIME,
    expiresAt: options.expiresAt ?? "2026-07-19T03:20:00.000Z",
  };
  const artifact = await sealJson(directory, "approval", approval);
  return {
    approval,
    approvalPath: artifact.jsonPath,
    approvalSha256Path: artifact.sha256Path,
    approvalSha256: artifact.sha256,
  };
}

async function prepareActivation(
  t: TestContext,
  url: string,
  options: { migrationsRoot?: string; name?: string } = {},
) {
  const plan = await planProductTruthMigrations({
    databaseUrl: url,
    runId: `owner-run-${options.name ?? "test"}`,
    approvalId: `owner-approval-${options.name ?? "test"}`,
    migrationsRoot: options.migrationsRoot,
    now: () => new Date(PLAN_TIME),
  });
  const root = await temporaryDirectory(t, `product-truth-activation-${options.name ?? "test"}-`);
  const planArtifact = await writeProductTruthMigrationPlanArtifact(plan, join(root, "plan"));
  const approvalArtifact = await makeApproval(join(root, "approval"), plan, planArtifact.planSha256);
  const confirmationToken = buildProductTruthMigrationConfirmationToken({
    runId: approvalArtifact.approval.runId,
    approvalId: approvalArtifact.approval.approvalId,
    activationContractSha256: approvalArtifact.approval.activationContractSha256,
    planSha256: planArtifact.planSha256,
    approvalSha256: approvalArtifact.approvalSha256,
    targetFingerprint: approvalArtifact.approval.targetFingerprint,
  });
  return {
    root,
    plan,
    ...planArtifact,
    ...approvalArtifact,
    confirmationToken,
    reportDirectory: join(root, "report"),
  };
}

function applyOptions(
  url: string,
  activation: Awaited<ReturnType<typeof prepareActivation>>,
  migrationsRoot?: string,
) {
  return {
    databaseUrl: url,
    planPath: activation.planPath,
    planSha256Path: activation.planSha256Path,
    approvalPath: activation.approvalPath,
    approvalSha256Path: activation.approvalSha256Path,
    confirmationToken: activation.confirmationToken,
    outputDirectory: activation.reportDirectory,
    migrationsRoot,
    now: () => new Date(APPLY_TIME),
  };
}

async function schemaAndDataDigest(url: string): Promise<string> {
  const db = createClient({ url });
  try {
    const schema = await db.execute(
      `SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name`,
    );
    const queue = await db.execute(`SELECT * FROM EnrichmentJob ORDER BY id`);
    const prisma = await db.execute(`SELECT * FROM "_prisma_migrations" ORDER BY id`);
    return createHash("sha256")
      .update(JSON.stringify([
        schema.rows.map((row) => ({ ...row })),
        queue.rows.map((row) => ({ ...row })),
        prisma.rows.map((row) => ({ ...row })),
      ]))
      .digest("hex");
  } finally {
    await db.close();
  }
}

async function assertActivationAbsent(url: string): Promise<void> {
  const db = createClient({ url });
  try {
    const receipt = await db.execute(
      `SELECT COUNT(*) AS count FROM sqlite_schema
       WHERE type='table' AND name='ProductTruthMigrationReceipt'`,
    );
    const columns = await db.execute(`PRAGMA table_xinfo("EnrichmentJob")`);
    const prisma = await db.execute({
      sql: `SELECT COUNT(*) AS count FROM "_prisma_migrations"
            WHERE migration_name IN (${MIGRATION_IDS.map(() => "?").join(",")})`,
      args: [...MIGRATION_IDS],
    });
    assert.equal(Number(receipt.rows[0]?.count), 0);
    assert.equal(columns.rows.some((row) => row.name === "normalizedTarget"), false);
    assert.equal(Number(prisma.rows[0]?.count), 0);
  } finally {
    await db.close();
  }
}

test("canonical release is exactly eight deterministic migrations", async () => {
  const first = await loadProductTruthMigrationFiles();
  const second = await loadProductTruthMigrationFiles();
  assert.deepEqual(first.map((file) => file.id), [...MIGRATION_IDS]);
  assert.deepEqual(first.map((file) => file.sha256), second.map((file) => file.sha256));
  assert.equal(first.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)), true);
  assert.equal(first.every((file) => file.expectedDefinitions.length > 0), true);
  assert.equal(first.some((file) => file.id.toLowerCase().includes("walmart")), false);
  assert.equal(
    migrationSetSha256(first),
    createHash("sha256")
      .update(first.map((file) => `${file.id}\0${file.sha256}`).join("\n"))
      .digest("hex"),
  );

  const firstPlan = await planProductTruthMigrations();
  const secondPlan = await planProductTruthMigrations();
  assert.deepEqual(firstPlan, secondPlan);
  assert.equal(firstPlan.contractVersion, "product-truth-migration-plan/2");
  assert.equal(firstPlan.generatedAt, "1970-01-01T00:00:00.000Z");
  assert.equal(firstPlan.canApply, false);
  assert.equal(firstPlan.database, null);
});

test("sealed planning is read-only, exact, and non-overwriting", async (t) => {
  const url = await temporaryDatabase(t);
  await createBaseProductTruthSchema(url);
  const db = createClient({ url });
  try {
    await db.execute(`INSERT INTO EnrichmentJob
      (id,targetType,target,status,queuedAt,createdAt,updatedAt)
      VALUES ('brand-queued','brand','Acme','queued',?, ?, ?)` , [PLAN_TIME, PLAN_TIME, PLAN_TIME]);
    await db.execute(`INSERT INTO EnrichmentJob
      (id,targetType,target,status,queuedAt,createdAt,updatedAt)
      VALUES ('sku-unscoped','sku','SKU-1','queued',?, ?, ?)` , [PLAN_TIME, PLAN_TIME, PLAN_TIME]);
  } finally {
    await db.close();
  }
  const before = await schemaAndDataDigest(url);
  const activation = await prepareActivation(t, url, { name: "readonly" });
  const after = await schemaAndDataDigest(url);
  assert.equal(after, before);
  assert.equal(activation.plan.canApply, true);
  assert.equal(activation.plan.receiptLedger, "absent");
  assert.equal(activation.plan.prismaLedger, "ready");
  assert.equal(activation.plan.queueImpact?.queueV2CompatibilityBackfill.count, 2);
  assert.deepEqual(
    activation.plan.queueImpact?.queueV3Cancellation.rowIds,
    ["sku-unscoped"],
  );
  assert.equal(activation.plan.writerActivity?.externalWriterQuiescenceRequired, true);
  assert.equal(
    createHash("sha256").update(await readFile(activation.planPath)).digest("hex"),
    (await readFile(activation.planSha256Path, "utf8")).trim(),
  );
  await assert.rejects(
    writeProductTruthMigrationPlanArtifact(activation.plan, join(activation.root, "plan")),
    (error: unknown) => error instanceof ProductTruthMigrationPlanError
      && error.code === "ARTIFACT_DIRECTORY_EXISTS",
  );
});

test("read-only planning refuses to create a missing local database", async (t) => {
  const root = await temporaryDirectory(t, "product-truth-missing-db-");
  const databasePath = join(root, "must-not-be-created.sqlite");
  await assert.rejects(
    planProductTruthMigrations({
      databaseUrl: `file:${databasePath}`,
      runId: "owner-run-missing-db",
      approvalId: "owner-approval-missing-db",
    }),
    (error: unknown) => error instanceof ProductTruthMigrationPlanError
      && error.code === "LOCAL_DATABASE_MUST_EXIST",
  );
  await assert.rejects(readFile(databasePath));
});

test("V2 apply registers exact immutable dual ledgers and a sealed report", async (t) => {
  const url = await temporaryDatabase(t);
  await createBaseProductTruthSchema(url);
  const db = createClient({ url });
  try {
    await db.execute(`INSERT INTO EnrichmentJob
      (id,targetType,target,status,queuedAt,createdAt,updatedAt)
      VALUES ('sku-to-cancel','sku','SKU-2','queued',?, ?, ?)` , [PLAN_TIME, PLAN_TIME, PLAN_TIME]);
  } finally {
    await db.close();
  }
  const activation = await prepareActivation(t, url, { name: "success" });
  assert.equal(activation.plan.canApply, true);
  const result = await applyProductTruthMigrations(applyOptions(url, activation));
  assert.equal(result.contractVersion, "product-truth-migration-apply/2");
  assert.deepEqual(result.actions.map((action) => action.id), [...MIGRATION_IDS]);
  assert.equal(result.actions.every((action) => action.action === "applied"), true);
  assert.equal(
    result.finalPlan.migrations.every((migration) =>
      migration.state === "applied" && migration.tracking === "tracked"),
    true,
  );
  assert.equal(result.finalPlan.receiptLedger, "ready");
  assert.equal(result.finalPlan.prismaLedger, "ready");
  assert.equal(
    createHash("sha256").update(await readFile(result.reportPath)).digest("hex"),
    result.reportSha256,
  );
  assert.equal((await readFile(result.reportSha256Path, "utf8")).trim(), result.reportSha256);
  const recovered = await recoverProductTruthMigrationReport({
    databaseUrl: url,
    planSha256: result.planSha256,
    outputDirectory: join(activation.root, "recovered-report"),
  });
  assert.equal(recovered.reportSha256, result.reportSha256);
  assert.equal(
    recovered.migrationCertificationSha256,
    result.migrationCertificationSha256,
  );
  assert.equal(
    await readFile(recovered.reportPath, "utf8"),
    await readFile(result.reportPath, "utf8"),
  );
  const cliRecovered = await runProductTruthMigrationCli([
    "recover-report",
    "--url", url,
    "--plan", activation.planPath,
    "--plan-sha", activation.planSha256Path,
    "--out", join(activation.root, "cli-recovered-report"),
  ], {}) as { reportSha256: string };
  assert.equal(cliRecovered.reportSha256, result.reportSha256);
  const migrationCertification = JSON.parse(
    await readFile(result.migrationCertificationPath, "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(migrationCertification, {
    allMigrationsApplied: true,
    allReceiptsTracked: true,
    contractVersion: "product-truth-migration-certification/1.0.0",
    databaseTargetFingerprint: result.targetFingerprint,
    migrationReportSha256: result.reportSha256,
    migrationSetSha256: result.migrationSetSha256,
    receiptLedgerReady: true,
    schemaFingerprintSha256: result.schemaAfterSha256,
  });
  assert.equal(
    createHash("sha256")
      .update(await readFile(result.migrationCertificationPath))
      .digest("hex"),
    result.migrationCertificationSha256,
  );
  assert.equal(
    (await readFile(result.migrationCertificationSha256Path, "utf8")).trim(),
    result.migrationCertificationSha256,
  );

  const verified = createClient({ url });
  try {
    const productTruth = await verified.execute(
      `SELECT migrationId,migrationSha256,migrationSetSha256,runId,approvalId,
              targetFingerprint,planSha256,approvalSha256,schemaBeforeSha256,
              schemaAfterSha256,queueImpactSha256,action,appliedAt
       FROM ProductTruthMigrationReceipt
       ORDER BY migrationId`,
    );
    const prisma = await verified.execute(
      `SELECT migration_name,checksum,finished_at,rolled_back_at,applied_steps_count
       FROM "_prisma_migrations" ORDER BY migration_name`,
    );
    const queue = await verified.execute(
      `SELECT status,listingKey,terminalReason FROM EnrichmentJob WHERE id='sku-to-cancel'`,
    );
    const activationReceipt = await verified.execute(
      `SELECT reportSha256 FROM ProductTruthMigrationActivationReceipt
       WHERE planSha256=?`,
      [result.planSha256],
    );
    const foreignKeys = await verified.execute(`PRAGMA foreign_key_check`);
    assert.deepEqual(productTruth.rows.map((row) => String(row.migrationId)), [...MIGRATION_IDS]);
    assert.deepEqual(prisma.rows.map((row) => String(row.migration_name)), [...MIGRATION_IDS]);
    const actionShaById = new Map(result.actions.map((action) => [action.id, action.sha256]));
    assert.equal(productTruth.rows.every((row) =>
      row.migrationSha256 === actionShaById.get(String(row.migrationId))
      && row.migrationSetSha256 === result.migrationSetSha256
      && row.runId === result.runId
      && row.approvalId === result.approvalId
      && row.targetFingerprint === result.targetFingerprint
      && row.planSha256 === result.planSha256
      && row.approvalSha256 === result.approvalSha256
      && row.schemaBeforeSha256 === result.schemaBeforeSha256
      && row.schemaAfterSha256 === result.schemaAfterSha256
      && row.queueImpactSha256 === result.queueImpactSha256
      && row.action === "applied"
      && row.appliedAt === APPLY_TIME), true);
    assert.equal(prisma.rows.every((row) =>
      row.checksum === actionShaById.get(String(row.migration_name))), true);
    assert.equal(prisma.rows.every((row) =>
      row.finished_at != null && row.rolled_back_at == null && Number(row.applied_steps_count) === 1), true);
    assert.equal(queue.rows[0]?.status, "cancelled");
    assert.equal(queue.rows[0]?.listingKey, null);
    assert.equal(foreignKeys.rows.length, 0);
    assert.equal(activationReceipt.rows[0]?.reportSha256, result.reportSha256);
    await assert.rejects(
      verified.execute(`UPDATE ProductTruthMigrationReceipt SET action='x'
                        WHERE migrationId='${MIGRATION_IDS[0]}'`),
      /PRODUCT_TRUTH_MIGRATION_RECEIPT_IMMUTABLE/,
    );
    await assert.rejects(
      verified.execute(`DELETE FROM "_prisma_migrations"
                        WHERE migration_name='${MIGRATION_IDS[0]}'`),
      /PRODUCT_TRUTH_PRISMA_MIGRATION_RECEIPT_IMMUTABLE/,
    );
    await assert.rejects(
      verified.execute({
        sql: `INSERT INTO "_prisma_migrations"
              (id,checksum,finished_at,migration_name,started_at,applied_steps_count)
              VALUES ('duplicate-test',?,?,?, ?,1)`,
        args: [
          String(prisma.rows[0]?.checksum),
          APPLY_TIME,
          MIGRATION_IDS[0],
          APPLY_TIME,
        ],
      }),
      /PRODUCT_TRUTH_PRISMA_MIGRATION_RECEIPT_DUPLICATE/,
    );
    await assert.rejects(
      verified.execute(`UPDATE ProductTruthMigrationActivationReceipt
                        SET reportSha256='${"0".repeat(64)}'
                        WHERE planSha256='${result.planSha256}'`),
      /PRODUCT_TRUTH_MIGRATION_ACTIVATION_RECEIPT_IMMUTABLE/,
    );
  } finally {
    await verified.close();
  }

  await assert.rejects(
    applyProductTruthMigrations(applyOptions(url, activation)),
    (error: unknown) => error instanceof ProductTruthMigrationPlanError
      && error.code === "ARTIFACT_DIRECTORY_EXISTS",
  );
});

test("a newly sealed post-activation plan is idempotent without rewriting receipts", async (t) => {
  const url = await temporaryDatabase(t);
  await createBaseProductTruthSchema(url);
  const firstActivation = await prepareActivation(t, url, { name: "idempotent-first" });
  await applyProductTruthMigrations(applyOptions(url, firstActivation));

  const before = createClient({ url });
  let productTruthReceipts: Array<Record<string, unknown>>;
  let prismaReceipts: Array<Record<string, unknown>>;
  try {
    const [productTruth, prisma] = await Promise.all([
      before.execute(`SELECT * FROM ProductTruthMigrationReceipt ORDER BY migrationId`),
      before.execute(`SELECT * FROM "_prisma_migrations" ORDER BY migration_name`),
    ]);
    productTruthReceipts = productTruth.rows.map((row) => ({ ...row }));
    prismaReceipts = prisma.rows.map((row) => ({ ...row }));
  } finally {
    await before.close();
  }

  const secondActivation = await prepareActivation(t, url, { name: "idempotent-second" });
  assert.equal(secondActivation.plan.canApply, true);
  assert.equal(secondActivation.plan.migrations.every((migration) =>
    migration.state === "applied" && migration.tracking === "tracked"), true);
  const secondResult = await applyProductTruthMigrations(applyOptions(url, secondActivation));
  assert.equal(secondResult.actions.every((action) => action.action === "already_applied"), true);

  const after = createClient({ url });
  try {
    const [productTruth, prisma] = await Promise.all([
      after.execute(`SELECT * FROM ProductTruthMigrationReceipt ORDER BY migrationId`),
      after.execute(`SELECT * FROM "_prisma_migrations" ORDER BY migration_name`),
    ]);
    assert.deepEqual(productTruth.rows.map((row) => ({ ...row })), productTruthReceipts);
    assert.deepEqual(prisma.rows.map((row) => ({ ...row })), prismaReceipts);
  } finally {
    await after.close();
  }
});

test("historical receipt schemaAfter detects post-activation schema drift", async (t) => {
  const url = await temporaryDatabase(t);
  await createBaseProductTruthSchema(url);
  const activation = await prepareActivation(t, url, { name: "receipt-schema-drift" });
  const result = await applyProductTruthMigrations(applyOptions(url, activation));
  const db = createClient({ url });
  try {
    await db.execute(`CREATE VIEW PostActivationDrift AS SELECT id FROM EnrichmentJob`);
  } finally {
    await db.close();
  }
  const plan = await planProductTruthMigrations({
    databaseUrl: url,
    runId: "owner-run-post-activation-drift",
    approvalId: "owner-approval-post-activation-drift",
  });
  assert.equal(plan.canApply, false);
  assert.equal(
    plan.blockers.some((blocker) => blocker.includes("MIGRATION_RECEIPT_SCHEMA_AFTER_DRIFT")),
    true,
  );
  await assert.rejects(
    recoverProductTruthMigrationReport({
      databaseUrl: url,
      planSha256: result.planSha256,
      outputDirectory: join(activation.root, "drifted-recovery"),
    }),
    (error: unknown) => error instanceof ProductTruthMigrationPlanError
      && error.code === "MIGRATION_REPORT_RECOVERY_DATABASE_DRIFT",
  );
});

test("tampered or expired sealed gates fail before database mutation", async (t) => {
  const tamperedPlanUrl = await temporaryDatabase(t);
  await createBaseProductTruthSchema(tamperedPlanUrl);
  const tamperedPlan = await prepareActivation(t, tamperedPlanUrl, { name: "tampered-plan" });
  await appendFile(tamperedPlan.planPath, " \n");
  await assert.rejects(
    applyProductTruthMigrations(applyOptions(tamperedPlanUrl, tamperedPlan)),
    (error: unknown) => error instanceof ProductTruthMigrationPlanError
      && error.code === "SEALED_ARTIFACT_HASH_MISMATCH",
  );
  await assertActivationAbsent(tamperedPlanUrl);

  const tamperedApprovalUrl = await temporaryDatabase(t);
  await createBaseProductTruthSchema(tamperedApprovalUrl);
  const tamperedApproval = await prepareActivation(t, tamperedApprovalUrl, {
    name: "tampered-approval",
  });
  await appendFile(tamperedApproval.approvalPath, " \n");
  await assert.rejects(
    applyProductTruthMigrations(applyOptions(tamperedApprovalUrl, tamperedApproval)),
    (error: unknown) => error instanceof ProductTruthMigrationPlanError
      && error.code === "SEALED_ARTIFACT_HASH_MISMATCH",
  );
  await assertActivationAbsent(tamperedApprovalUrl);

  const expiredUrl = await temporaryDatabase(t);
  await createBaseProductTruthSchema(expiredUrl);
  const plan = await planProductTruthMigrations({
    databaseUrl: expiredUrl,
    runId: "owner-run-expired",
    approvalId: "owner-approval-expired",
    now: () => new Date(PLAN_TIME),
  });
  const root = await temporaryDirectory(t, "product-truth-expired-");
  const planArtifact = await writeProductTruthMigrationPlanArtifact(plan, join(root, "plan"));
  const approval = await makeApproval(join(root, "approval"), plan, planArtifact.planSha256, {
    issuedAt: "2026-07-19T02:00:00.000Z",
    expiresAt: "2026-07-19T02:20:00.000Z",
  });
  const confirmationToken = buildProductTruthMigrationConfirmationToken({
    runId: approval.approval.runId,
    approvalId: approval.approval.approvalId,
    activationContractSha256: approval.approval.activationContractSha256,
    targetFingerprint: approval.approval.targetFingerprint,
    planSha256: planArtifact.planSha256,
    approvalSha256: approval.approvalSha256,
  });
  await assert.rejects(
    applyProductTruthMigrations({
      databaseUrl: expiredUrl,
      ...planArtifact,
      approvalPath: approval.approvalPath,
      approvalSha256Path: approval.approvalSha256Path,
      confirmationToken,
      outputDirectory: join(root, "report"),
      now: () => new Date(APPLY_TIME),
    }),
    (error: unknown) => error instanceof ProductTruthMigrationPlanError
      && error.code === "OWNER_APPROVAL_EXPIRED",
  );
  await assertActivationAbsent(expiredUrl);
});

test("owner approval cannot cross an activation-engine revision", async (t) => {
  const url = await temporaryDatabase(t);
  await createBaseProductTruthSchema(url);
  const original = await planProductTruthMigrations({
    databaseUrl: url,
    runId: "owner-run-engine-drift",
    approvalId: "owner-approval-engine-drift",
    now: () => new Date(PLAN_TIME),
  });
  const root = await temporaryDirectory(t, "product-truth-engine-drift-");
  const driftedPlan: ProductTruthMigrationPlan = {
    ...original,
    activationContractSha256: "f".repeat(64),
  };
  const planArtifact = await sealJson(join(root, "plan"), "plan", driftedPlan);
  const approval = await makeApproval(
    join(root, "approval"),
    driftedPlan,
    planArtifact.sha256,
  );
  const confirmationToken = buildProductTruthMigrationConfirmationToken({
    runId: approval.approval.runId,
    approvalId: approval.approval.approvalId,
    activationContractSha256: approval.approval.activationContractSha256,
    planSha256: planArtifact.sha256,
    approvalSha256: approval.approvalSha256,
    targetFingerprint: approval.approval.targetFingerprint,
  });
  await assert.rejects(
    applyProductTruthMigrations({
      databaseUrl: url,
      planPath: planArtifact.jsonPath,
      planSha256Path: planArtifact.sha256Path,
      approvalPath: approval.approvalPath,
      approvalSha256Path: approval.approvalSha256Path,
      confirmationToken,
      outputDirectory: join(root, "report"),
      now: () => new Date(APPLY_TIME),
    }),
    (error: unknown) => error instanceof ProductTruthMigrationPlanError
      && error.code === "SEALED_PLAN_RELEASE_MISMATCH",
  );
  await assertActivationAbsent(url);
});

test("schema and exact queue-effect drift abort before activation", async (t) => {
  const schemaUrl = await temporaryDatabase(t);
  await createBaseProductTruthSchema(schemaUrl);
  const schemaActivation = await prepareActivation(t, schemaUrl, { name: "schema-drift" });
  const schemaDb = createClient({ url: schemaUrl });
  try {
    await schemaDb.execute(
      `CREATE VIEW UnplannedWriterSchema AS SELECT id FROM EnrichmentJob`,
    );
  } finally {
    await schemaDb.close();
  }
  await assert.rejects(
    applyProductTruthMigrations(applyOptions(schemaUrl, schemaActivation)),
    (error: unknown) => error instanceof ProductTruthMigrationPlanError
      && error.code === "MIGRATION_SCHEMA_DRIFT",
  );
  await assertActivationAbsent(schemaUrl);

  const effectUrl = await temporaryDatabase(t);
  await createBaseProductTruthSchema(effectUrl);
  const effectActivation = await prepareActivation(t, effectUrl, { name: "effect-drift" });
  const effectDb = createClient({ url: effectUrl });
  try {
    await effectDb.execute(`INSERT INTO EnrichmentJob
      (id,targetType,target,status,queuedAt,createdAt,updatedAt)
      VALUES ('late-row','brand','Late','queued',?, ?, ?)` , [PLAN_TIME, PLAN_TIME, PLAN_TIME]);
  } finally {
    await effectDb.close();
  }
  await assert.rejects(
    applyProductTruthMigrations(applyOptions(effectUrl, effectActivation)),
    (error: unknown) => error instanceof ProductTruthMigrationPlanError
      && error.code === "MIGRATION_EFFECT_DRIFT",
  );
  await assertActivationAbsent(effectUrl);
});

test("running writers are inspectable blockers and cannot be approved away", async (t) => {
  const url = await temporaryDatabase(t);
  await createBaseProductTruthSchema(url);
  const db = createClient({ url });
  try {
    await db.execute(`INSERT INTO EnrichmentJob
      (id,targetType,target,status,queuedAt,createdAt,updatedAt)
      VALUES ('running-job','brand','Acme','running',?, ?, ?)` , [PLAN_TIME, PLAN_TIME, PLAN_TIME]);
  } finally {
    await db.close();
  }
  const plan = await planProductTruthMigrations({
    databaseUrl: url,
    runId: "owner-run-writer",
    approvalId: "owner-approval-writer",
    now: () => new Date(PLAN_TIME),
  });
  assert.equal(plan.canApply, false);
  assert.equal(plan.queueImpact?.runningQueueJobs.count, 1);
  assert.deepEqual(plan.queueImpact?.runningQueueJobs.rowIds, ["running-job"]);
  assert.equal(plan.writerActivity?.enrichmentRunning, 1);
  assert.deepEqual(
    plan.writerActivity?.blockerSets.enrichmentRunning.rowIds,
    ["running-job"],
  );
  assert.equal(
    plan.blockers.some((blocker) => blocker.includes("MIGRATION_REQUIRES_QUEUE_QUIESCENCE")),
    true,
  );
});

test("an already-present canonical artifact is never auto-adopted", async (t) => {
  const url = await temporaryDatabase(t);
  await createBaseProductTruthSchema(url);
  const files = await loadProductTruthMigrationFiles();
  const db = createClient({ url });
  try {
    await db.executeMultiple(files[0]!.sql);
  } finally {
    await db.close();
  }
  const activation = await prepareActivation(t, url, { name: "no-adopt" });
  assert.equal(activation.plan.canApply, false);
  assert.equal(activation.plan.migrations[0]?.state, "applied");
  assert.equal(activation.plan.migrations[0]?.tracking, "untracked");
  await assert.rejects(
    applyProductTruthMigrations(applyOptions(url, activation)),
    (error: unknown) => error instanceof ProductTruthMigrationPlanError
      && error.code === "MIGRATION_PREFLIGHT_BLOCKED",
  );
  const verify = createClient({ url });
  try {
    const receipts = await verify.execute(
      `SELECT COUNT(*) AS count FROM sqlite_schema
       WHERE type='table' AND name='ProductTruthMigrationReceipt'`,
    );
    const prisma = await verify.execute({
      sql: `SELECT COUNT(*) AS count FROM "_prisma_migrations"
            WHERE migration_name IN (${MIGRATION_IDS.map(() => "?").join(",")})`,
      args: [...MIGRATION_IDS],
    });
    assert.equal(Number(receipts.rows[0]?.count), 0);
    assert.equal(Number(prisma.rows[0]?.count), 0);
  } finally {
    await verify.close();
  }
});

test("a final-migration failure rolls back schema, queue effects, and both ledgers", async (t) => {
  const url = await temporaryDatabase(t);
  await createBaseProductTruthSchema(url);
  const migrationsRoot = await copyMigrationSet(t);
  await appendFile(
    join(migrationsRoot, MIGRATION_IDS.at(-1)!, "migration.sql"),
    "\nUPDATE ProductTruthMissingRollbackSentinel SET id=id;\n",
  );
  const activation = await prepareActivation(t, url, {
    migrationsRoot,
    name: "rollback",
  });
  assert.equal(activation.plan.canApply, true);
  await assert.rejects(
    applyProductTruthMigrations(applyOptions(url, activation, migrationsRoot)),
    /no such table|SQLITE|UNKNOWN/i,
  );
  await assertActivationAbsent(url);
  assert.deepEqual(await readdir(activation.reportDirectory), []);
});

test("migration files cannot escape the outer transaction", async (t) => {
  const migrationsRoot = await copyMigrationSet(t);
  await appendFile(
    join(migrationsRoot, MIGRATION_IDS.at(-1)!, "migration.sql"),
    "\nCOMMIT;\n",
  );
  await assert.rejects(
    loadProductTruthMigrationFiles(migrationsRoot),
    (error: unknown) => error instanceof ProductTruthMigrationPlanError
      && error.code === "MIGRATION_STATEMENT_FORBIDDEN",
  );
});

test("definition drift is detected even when every artifact name still exists", async (t) => {
  const url = await temporaryDatabase(t);
  await createBaseProductTruthSchema(url);
  const activation = await prepareActivation(t, url, { name: "definition" });
  await applyProductTruthMigrations(applyOptions(url, activation));
  const db = createClient({ url });
  try {
    await db.execute(`DROP INDEX CanonicalProductVariant_brand_line_idx`);
    await db.execute(`CREATE INDEX CanonicalProductVariant_brand_line_idx
                      ON CanonicalProductVariant(normalizedBrand)`);
  } finally {
    await db.close();
  }
  const plan = await planProductTruthMigrations({
    databaseUrl: url,
    runId: "owner-run-definition-check",
    approvalId: "owner-approval-definition-check",
    now: () => new Date(PLAN_TIME),
  });
  const migration = plan.migrations.find((item) =>
    item.id === "20260718234500_product_truth_evidence_provenance");
  assert.equal(migration?.state, "applied");
  assert.equal(
    migration?.blockers.some((blocker) => blocker.includes("SQL definition drift")),
    true,
  );
  assert.equal(plan.canApply, false);

  const receiptDb = createClient({ url });
  try {
    await receiptDb.execute(
      `DROP TRIGGER ProductTruthPrismaMigrationReceipt_duplicate_guard`,
    );
    await receiptDb.execute(`CREATE TRIGGER ProductTruthPrismaMigrationReceipt_duplicate_guard
      BEFORE INSERT ON "_prisma_migrations"
      BEGIN SELECT 1; END`);
  } finally {
    await receiptDb.close();
  }
  const receiptPlan = await planProductTruthMigrations({
    databaseUrl: url,
    runId: "owner-run-receipt-definition-check",
    approvalId: "owner-approval-receipt-definition-check",
    now: () => new Date(PLAN_TIME),
  });
  assert.equal(receiptPlan.receiptLedger, "invalid");
  assert.equal(
    receiptPlan.blockers.some((blocker) => blocker.includes("SQL definition drift")),
    true,
  );
});

test("CLI accepts only a named environment secret and never overwrites output", async (t) => {
  const secret = "TOP-SECRET-RAW-TOKEN-DO-NOT-PRINT";
  let rawError: unknown;
  try {
    await runProductTruthMigrationCli(["plan", `--auth-token=${secret}`], {});
  } catch (error) {
    rawError = error;
  }
  assert.ok(rawError instanceof ProductTruthMigrationPlanError);
  assert.equal(String(rawError).includes(secret), false);
  assert.equal(rawError.code, "CLI_ARGUMENT_UNKNOWN");

  const url = await temporaryDatabase(t);
  await createBaseProductTruthSchema(url);
  const root = await temporaryDirectory(t, "product-truth-cli-");
  const outputDirectory = join(root, "plan");
  const args = [
    "plan",
    "--url", url,
    "--auth-token-env", "PRODUCT_TRUTH_TEST_TOKEN",
    "--run-id", "owner-run-cli",
    "--approval-id", "owner-approval-cli",
    "--out", outputDirectory,
  ];
  const result = await runProductTruthMigrationCli(args, {
    PRODUCT_TRUTH_TEST_TOKEN: secret,
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal((await readFile(join(outputDirectory, "plan.json"), "utf8")).includes(secret), false);
  await assert.rejects(
    runProductTruthMigrationCli(args, { PRODUCT_TRUTH_TEST_TOKEN: secret }),
    (error: unknown) => error instanceof ProductTruthMigrationPlanError
      && error.code === "ARTIFACT_DIRECTORY_EXISTS"
      && !String(error).includes(secret),
  );

  const source = await readFile(
    fileURLToPath(new URL("../../../../scripts/product-truth-migration-plan.ts", import.meta.url)),
    "utf8",
  );
  const librarySource = source.slice(0, source.indexOf("const invokedAsScript"));
  assert.doesNotMatch(librarySource, /process\.env|\bfetch\s*\(/);
  assert.match(source.slice(source.indexOf("const invokedAsScript")), /process\.env/);

  await assert.rejects(
    planProductTruthMigrations({
      databaseUrl: "http://database.example.invalid",
      allowRemote: true,
      authToken: secret,
      runId: "owner-run-insecure",
      approvalId: "owner-approval-insecure",
    }),
    (error: unknown) => error instanceof ProductTruthMigrationPlanError
      && error.code === "DATABASE_URL_SCHEME_FORBIDDEN"
      && !String(error).includes(secret),
  );
  await assert.rejects(
    planProductTruthMigrations({
      databaseUrl: `libsql://database.example.invalid?authToken=${secret}`,
      allowRemote: true,
      authToken: secret,
      runId: "owner-run-query-secret",
      approvalId: "owner-approval-query-secret",
    }),
    (error: unknown) => error instanceof ProductTruthMigrationPlanError
      && error.code === "DATABASE_URL_CREDENTIALS_FORBIDDEN"
      && !String(error).includes(secret),
  );
});
