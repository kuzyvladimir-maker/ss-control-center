import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { createClient, type Client } from "@libsql/client";

import {
  applyWalmartNewSkuSchemaActivation,
  buildWalmartSchemaActivationConfirmation,
  canonicalJson,
  parseWalmartSchemaActivationCli,
  planWalmartNewSkuSchemaActivation,
  walmartNewSkuSchemaActivationUsage,
  WALMART_SCHEMA_ACTIVATION_CLAIMS,
  WalmartSchemaActivationError,
  type WalmartSchemaActivationApproval,
  type WalmartSchemaActivationPlan,
} from "../walmart-new-sku-schema-activation";

test("owner CLI help exposes only the current V3 confirmation contract", () => {
  const help = walmartNewSkuSchemaActivationUsage();
  assert.match(help, /EXACT_V3_CONFIRMATION/);
  assert.doesNotMatch(help, /EXACT_V2_CONFIRMATION/);
});

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIRECTORY, "..", "..");
const MIGRATION_PATH = resolve(
  PROJECT_ROOT,
  "prisma",
  "migrations",
  "20260719003000_walmart_publish_lifecycle_safety",
  "migration.sql",
);
const PLAN_NOW = new Date("2026-07-19T03:00:00.000Z");
const APPROVED_AT = "2026-07-19T03:05:00.000Z";
const APPLY_NOW = new Date("2026-07-19T03:10:00.000Z");
const PLAN_EXPIRES = "2026-07-19T04:00:00.000Z";
const APPROVAL_EXPIRES = "2026-07-19T03:50:00.000Z";

interface Fixture {
  root: string;
  dbPath: string;
  databaseUrl: string;
  client: Client;
}

async function makeFixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "walmart-schema-activation-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const dbPath = resolve(root, "database.sqlite");
  const databaseUrl = pathToFileURL(dbPath).href;
  const client = createClient({ url: databaseUrl });
  t.after(() => client.close());
  await client.executeMultiple(`
    CREATE TABLE "_prisma_migrations" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
    );
    CREATE TABLE "ChannelSKU" (
      "id" TEXT NOT NULL PRIMARY KEY
    );
    CREATE TABLE "UPCPool" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "reserved_for_id" TEXT
    );
  `);
  return { root, dbPath, databaseUrl, client };
}

async function schemaRows(client: Client): Promise<string> {
  const result = await client.execute(
    `SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name`,
  );
  return canonicalJson(result.rows);
}

async function makePlan(
  fixture: Fixture,
  options: {
    outputName?: string;
    expiresAt?: string;
    migrationPath?: string;
  } = {},
) {
  return planWalmartNewSkuSchemaActivation({
    databaseUrl: fixture.databaseUrl,
    environment: "production",
    expiresAt: options.expiresAt ?? PLAN_EXPIRES,
    outputDirectory: resolve(fixture.root, options.outputName ?? "plan"),
    now: () => PLAN_NOW,
    migrationPath: options.migrationPath,
  });
}

async function writeApproval(
  fixture: Fixture,
  plan: WalmartSchemaActivationPlan,
  planSha256: string,
  name = "owner-approval.json",
): Promise<{
  path: string;
  approval: WalmartSchemaActivationApproval;
  sha256: string;
}> {
  const approval: WalmartSchemaActivationApproval = {
    contractVersion: "walmart-new-sku-schema-activation-approval/3",
    decision: "APPROVE",
    approvalId: "owner-approval-001",
    approvedBy: "vladimir",
    approvedAt: APPROVED_AT,
    expiresAt: APPROVAL_EXPIRES,
    planSha256,
    migrationSha256: plan.migration.sha256,
    targetFingerprint: plan.database.targetFingerprint,
    schemaSha256: plan.schemaSha256,
    preflightSha256: plan.preflightSha256,
    environment: plan.environment,
    claims: WALMART_SCHEMA_ACTIVATION_CLAIMS,
  };
  const bytes = canonicalJson(approval);
  const path = resolve(fixture.root, name);
  await writeFile(path, bytes, "utf8");
  return {
    path,
    approval,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function applySealed(
  fixture: Fixture,
  planResult: Awaited<ReturnType<typeof makePlan>>,
  options: {
    outputName?: string;
    approvalName?: string;
    databaseUrl?: string;
    environment?: string;
    migrationPath?: string;
    now?: Date;
    testHooks?: Parameters<typeof applyWalmartNewSkuSchemaActivation>[0]["testHooks"];
  } = {},
) {
  const approval = await writeApproval(
    fixture,
    planResult.plan,
    planResult.planSha256,
    options.approvalName,
  );
  const confirmation = buildWalmartSchemaActivationConfirmation({
    planSha256: planResult.planSha256,
    approvalSha256: approval.sha256,
    targetFingerprint: planResult.plan.database.targetFingerprint,
    environment: planResult.plan.environment,
  });
  return applyWalmartNewSkuSchemaActivation({
    planPath: resolve(planResult.outputDirectory, "plan.json"),
    planShaPath: resolve(planResult.outputDirectory, "plan.sha256"),
    approvalPath: approval.path,
    confirmation,
    databaseUrl: options.databaseUrl ?? fixture.databaseUrl,
    environment: options.environment ?? "production",
    outputDirectory: resolve(fixture.root, options.outputName ?? "apply"),
    now: () => options.now ?? APPLY_NOW,
    migrationPath: options.migrationPath,
    testHooks: options.testHooks,
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WalmartSchemaActivationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("plan inspects online read-only and seals exact schema/preflight artifacts", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.client.execute({
    sql: `INSERT INTO "UPCPool" (id, reserved_for_id) VALUES (?, NULL), (?, ?)`,
    args: ["upc-1", "upc-2", "draft-1"],
  });
  const beforeSchema = await schemaRows(fixture.client);
  const beforeHistory = await fixture.client.execute(
    `SELECT COUNT(*) AS count FROM "_prisma_migrations"`,
  );

  const result = await makePlan(fixture);

  assert.equal(result.plan.eligibleForApply, true);
  assert.equal(result.plan.preflight.duplicateNonNullUpcReservationCount, 0);
  assert.equal(result.plan.preflight.artifacts.state, "pending");
  assert.equal(result.plan.preflight.prismaHistory.state, "clear");
  assert.equal(result.plan.preflight.activationReceipt.state, "absent");
  assert.equal(result.plan.claims.callsWalmartApis, false);
  assert.equal(result.plan.claims.performsBackfill, false);
  assert.match(result.plan.schemaSha256, /^[a-f0-9]{64}$/);
  assert.match(result.plan.preflightSha256, /^[a-f0-9]{64}$/);
  assert.match(result.plan.migration.sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.plan.migration.indexes.includes("MarketplaceSubmissionAttempt_pilot_permit_sha256_key"));
  assert.ok(result.plan.migration.indexes.includes("MarketplaceSubmissionAttempt_pilot_slot_key"));
  assert.ok(result.plan.migration.columns.MarketplaceSubmissionAttempt?.includes("pilot_permit_sha256"));
  assert.ok(result.plan.migration.columns.MarketplaceSubmissionAttempt?.includes("pilot_slot"));
  assert.ok(result.plan.migration.columns.MarketplaceSubmissionAttempt?.includes("pilot_approval_sha256"));
  assert.ok(result.plan.migration.columns.MarketplaceSubmissionAttempt?.includes("certification_sha256"));
  assert.ok(result.plan.migration.columns.MarketplaceSubmissionAttempt?.includes("seller_account_fingerprint_sha256"));
  assert.ok(result.plan.migration.triggers.includes("MarketplaceSubmissionAttempt_pilot_global_cap"));
  assert.ok(result.plan.migration.triggers.includes("WalmartBuyerPublicationEvidence_attempt_sku_guard"));

  const planBytes = await readFile(resolve(result.outputDirectory, "plan.json"), "utf8");
  const sidecar = await readFile(resolve(result.outputDirectory, "plan.sha256"), "utf8");
  const template = JSON.parse(
    await readFile(resolve(result.outputDirectory, "owner-approval.template.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(planBytes, canonicalJson(result.plan));
  assert.equal(sidecar, `${result.planSha256}\n`);
  assert.equal(template.decision, "REPLACE_WITH_APPROVE");

  assert.equal(await schemaRows(fixture.client), beforeSchema);
  const afterHistory = await fixture.client.execute(
    `SELECT COUNT(*) AS count FROM "_prisma_migrations"`,
  );
  assert.equal(afterHistory.rows[0]?.count, beforeHistory.rows[0]?.count);
});

test("apply verifies postconditions and atomically registers receipt plus Prisma history", async (t) => {
  const fixture = await makeFixture(t);
  const plan = await makePlan(fixture);
  const result = await applySealed(fixture, plan);

  assert.equal(result.report.status, "applied");
  assert.equal(result.report.planSha256, plan.planSha256);
  assert.equal(result.report.migrationSha256, plan.plan.migration.sha256);
  assert.equal(result.report.claims.publishesListings, false);
  assert.notEqual(result.report.schemaSha256After, result.report.schemaSha256Before);
  assert.equal(
    await readFile(resolve(result.outputDirectory, "report.json"), "utf8"),
    canonicalJson(result.report),
  );
  assert.equal(
    await readFile(resolve(result.outputDirectory, "report.sha256"), "utf8"),
    `${result.reportSha256}\n`,
  );

  const objects = await fixture.client.execute(
    `SELECT type, name FROM sqlite_schema
     WHERE name IN (
       'MarketplaceSubmissionAttempt',
       'WalmartBuyerPublicationEvidence',
       'UPCPool_reserved_for_id_key',
       'MarketplaceSubmissionAttempt_pilot_global_cap',
       'WalmartBuyerPublicationEvidence_attempt_sku_guard',
       'WalmartNewSkuSchemaActivationReceipt',
       'WalmartNewSkuSchemaActivationReceipt_no_update',
       'WalmartNewSkuSchemaActivationReceipt_no_delete'
     ) ORDER BY name`,
  );
  assert.equal(objects.rows.length, 8);
  const history = await fixture.client.execute({
    sql: `SELECT id, checksum, finished_at, rolled_back_at, applied_steps_count
          FROM "_prisma_migrations" WHERE migration_name = ?`,
    args: ["20260719003000_walmart_publish_lifecycle_safety"],
  });
  assert.equal(history.rows.length, 1);
  assert.equal(history.rows[0]?.id, result.report.prismaMigrationId);
  assert.equal(history.rows[0]?.checksum, plan.plan.migration.sha256);
  assert.notEqual(history.rows[0]?.finished_at, null);
  assert.equal(history.rows[0]?.rolled_back_at, null);
  assert.equal(history.rows[0]?.applied_steps_count, 1);
  const receipt = await fixture.client.execute(
    `SELECT * FROM "WalmartNewSkuSchemaActivationReceipt"`,
  );
  assert.equal(receipt.rows.length, 1);
  assert.equal(receipt.rows[0]?.id, result.report.receiptId);
  assert.equal(receipt.rows[0]?.plan_sha256, plan.planSha256);
  await assert.rejects(
    fixture.client.execute(
      `UPDATE "WalmartNewSkuSchemaActivationReceipt" SET environment='staging'`,
    ),
    /IMMUTABLE/,
  );
});

test("a failure after migration SQL rolls every schema/history/receipt write back", async (t) => {
  const fixture = await makeFixture(t);
  const plan = await makePlan(fixture);
  await assert.rejects(
    applySealed(fixture, plan, {
      testHooks: {
        afterMigrationSql: async () => {
          throw new Error("injected post-DDL failure");
        },
      },
    }),
    /injected post-DDL failure/,
  );
  const objects = await fixture.client.execute(
    `SELECT name FROM sqlite_schema
     WHERE name IN (
       'MarketplaceSubmissionAttempt',
       'WalmartBuyerPublicationEvidence',
       'UPCPool_reserved_for_id_key',
       'WalmartNewSkuSchemaActivationReceipt'
     )`,
  );
  assert.equal(objects.rows.length, 0);
  const history = await fixture.client.execute({
    sql: `SELECT COUNT(*) AS count FROM "_prisma_migrations" WHERE migration_name = ?`,
    args: ["20260719003000_walmart_publish_lifecycle_safety"],
  });
  assert.equal(history.rows[0]?.count, 0);
});

test("tampered plan bytes or sidecar cannot reach apply", async (t) => {
  const fixture = await makeFixture(t);
  const plan = await makePlan(fixture);
  const planPath = resolve(plan.outputDirectory, "plan.json");
  const parsed = JSON.parse(await readFile(planPath, "utf8")) as WalmartSchemaActivationPlan;
  parsed.environment = "staging";
  await writeFile(planPath, canonicalJson(parsed), "utf8");
  await expectCode(applySealed(fixture, plan), "PLAN_SHA_SIDECAR_MISMATCH");
});

test("expired owner-sealed plan is rejected before database mutation", async (t) => {
  const fixture = await makeFixture(t);
  const plan = await makePlan(fixture, { expiresAt: "2026-07-19T03:30:00.000Z" });
  await expectCode(
    applySealed(fixture, plan, { now: new Date("2026-07-19T03:31:00.000Z") }),
    "PLAN_EXPIRED",
  );
});

test("exact target binding rejects a different database", async (t) => {
  const fixture = await makeFixture(t);
  const second = await makeFixture(t);
  const plan = await makePlan(fixture);
  await expectCode(
    applySealed(fixture, plan, { databaseUrl: second.databaseUrl }),
    "TARGET_FINGERPRINT_MISMATCH",
  );
});

test("schema drift inside the sealed window blocks apply", async (t) => {
  const fixture = await makeFixture(t);
  const plan = await makePlan(fixture);
  await fixture.client.execute(`CREATE TABLE "UnexpectedSchemaDrift" ("id" TEXT PRIMARY KEY)`);
  await expectCode(applySealed(fixture, plan), "SCHEMA_PREFLIGHT_DRIFT");
  const artifacts = await fixture.client.execute(
    `SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='MarketplaceSubmissionAttempt'`,
  );
  assert.equal(artifacts.rows[0]?.count, 0);
});

test("duplicate non-null UPC reservations added after plan block apply", async (t) => {
  const fixture = await makeFixture(t);
  const plan = await makePlan(fixture);
  await fixture.client.execute({
    sql: `INSERT INTO "UPCPool" (id, reserved_for_id) VALUES (?, ?), (?, ?)`,
    args: ["upc-a", "same-draft", "upc-b", "same-draft"],
  });
  await expectCode(applySealed(fixture, plan), "DUPLICATE_UPC_RESERVATIONS");
});

test("partial lifecycle artifacts fail closed and are never completed opportunistically", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.client.execute(
    `CREATE UNIQUE INDEX "UPCPool_reserved_for_id_key" ON "UPCPool"("reserved_for_id")`,
  );
  const plan = await makePlan(fixture, { outputName: "partial-plan" });
  assert.equal(plan.plan.eligibleForApply, false);
  assert.equal(plan.plan.preflight.artifacts.state, "partial");
  assert.ok(plan.plan.blockers.includes("MIGRATION_ARTIFACTS_PARTIAL"));
  await expectCode(applySealed(fixture, plan), "PLAN_NOT_ELIGIBLE");
});

test("fully present but untracked migration is reported and never auto-adopted", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.client.executeMultiple(await readFile(MIGRATION_PATH, "utf8"));
  const plan = await makePlan(fixture, { outputName: "untracked-plan" });
  assert.equal(plan.plan.eligibleForApply, false);
  assert.equal(plan.plan.preflight.artifacts.state, "applied");
  assert.ok(plan.plan.blockers.includes("MIGRATION_ARTIFACTS_UNTRACKED_APPLIED"));
  assert.equal(plan.plan.preflight.prismaHistory.matchingRows.length, 0);
  assert.equal(plan.plan.preflight.activationReceipt.matchingRows.length, 0);
  await expectCode(applySealed(fixture, plan), "PLAN_NOT_ELIGIBLE");
});

test("migration bytes are rehashed after owner approval", async (t) => {
  const fixture = await makeFixture(t);
  const copiedMigration = resolve(fixture.root, "migration.sql");
  await writeFile(copiedMigration, await readFile(MIGRATION_PATH, "utf8"), "utf8");
  const plan = await makePlan(fixture, {
    outputName: "migration-drift-plan",
    migrationPath: copiedMigration,
  });
  await writeFile(
    copiedMigration,
    `${await readFile(copiedMigration, "utf8")}\n-- owner-approved bytes changed\n`,
    "utf8",
  );
  await expectCode(
    applySealed(fixture, plan, { migrationPath: copiedMigration }),
    "MIGRATION_OR_TARGET_DRIFT",
  );
});

test("remote access requires both explicit gate and a named non-empty token env", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "walmart-schema-remote-gate-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const base = {
    databaseUrl: "libsql://example.invalid",
    environment: "production",
    expiresAt: PLAN_EXPIRES,
    outputDirectory: resolve(root, "plan"),
    now: () => PLAN_NOW,
  };
  await expectCode(
    planWalmartNewSkuSchemaActivation(base),
    "REMOTE_DATABASE_REQUIRES_EXPLICIT_FLAG",
  );
  await expectCode(
    planWalmartNewSkuSchemaActivation({ ...base, allowRemote: true }),
    "REMOTE_AUTH_TOKEN_ENV_REQUIRED",
  );
  await expectCode(
    planWalmartNewSkuSchemaActivation({
      ...base,
      allowRemote: true,
      authTokenEnvName: "TURSO_TEST_TOKEN",
      env: { NODE_ENV: "test" },
    }),
    "REMOTE_AUTH_TOKEN_ENV_EMPTY",
  );
  assert.throws(
    () => parseWalmartSchemaActivationCli([
      "plan",
      "--url",
      "libsql://example.invalid",
      "--auth-token",
      "secret-must-not-be-accepted",
    ]),
    (error: unknown) => error instanceof WalmartSchemaActivationError
      && error.code === "CLI_ARGUMENT_UNKNOWN",
  );
});

test("plan and apply artifact directories are exclusive and never overwritten", async (t) => {
  const fixture = await makeFixture(t);
  const plan = await makePlan(fixture);
  await expectCode(
    makePlan(fixture),
    "OUTPUT_DIRECTORY_NOT_NEW",
  );
  const occupiedApply = resolve(fixture.root, "occupied-apply");
  await mkdir(occupiedApply);
  await writeFile(resolve(occupiedApply, "sentinel"), "preserve", "utf8");
  await expectCode(
    applySealed(fixture, plan, { outputName: "occupied-apply" }),
    "OUTPUT_DIRECTORY_NOT_NEW",
  );
  assert.equal(await readFile(resolve(occupiedApply, "sentinel"), "utf8"), "preserve");
});
