import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { createClient, type Client } from "@libsql/client";

import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../canonical-product-match-provenance";
import {
  harvestDonorDetail,
  persistCompleteExactContentObservation,
  persistScoredDonorOffer,
  type HarvestDonorDetailOptions,
  type HarvestResult,
} from "../donor-catalog";
import { executeDonorHarvestCandidate } from "../donor-harvest-executor";
import { normalizeEnrichmentTarget } from "../enrichment-queue";
import {
  resetMeteredCallUsageForTests,
  type MeteredRunPermit,
} from "../metered-call-guard";
import {
  withMeteredProviderCall,
  type MeteredProviderAuthorization,
} from "../metered-provider-call";
import { readProductTruthOperationalLedger } from "../product-truth-operational-ledger";
import {
  PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION,
  expectedProductTruthExecutionConfirmation,
  productTruthOperationalSha256,
  type ProductTruthOperationalApproval,
  type ValidatedProductTruthOperationalApproval,
} from "../product-truth-operational-run-contract";
import {
  acquireProductTruthOperationalRunLease,
  finishProductTruthOperationalRun,
  reapExpiredProductTruthTargetedEvidenceRun,
  seedProductTruthTargetedEvidenceControlRun,
} from "../product-truth-operational-run-store";
import { readWalmartPilotCandidate } from "../product-truth-new-sku-view";
import {
  PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION,
  PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REQUEST_VERSION,
  buildProductTruthTargetedWalmartEvidencePlan,
  buildProductTruthTargetedWalmartEvidenceRequest,
  validateProductTruthTargetedWalmartEvidenceApproval,
  type ProductTruthTargetedWalmartEvidencePlan,
  type ProductTruthTargetedWalmartEvidencePlanRequest,
} from "../product-truth-targeted-walmart-evidence-contract";
import {
  executeProductTruthTargetedWalmartEvidence,
  inspectProductTruthTargetedWalmartEvidenceRun,
  readTargetedWalmartLegacyDonorSnapshot,
  type ProductTruthTargetedWalmartEvidenceAdapter,
  type ProductTruthTargetedWalmartEvidenceReport,
} from "../product-truth-targeted-walmart-evidence";
import { type RetailOffer } from "../retail-fetch";

const migrationUrls = [
  new URL(
    "../../../../prisma/migrations/20260718233000_donor_harvest_lifecycle/migration.sql",
    import.meta.url,
  ),
  new URL(
    "../../../../prisma/migrations/20260718234500_product_truth_evidence_provenance/migration.sql",
    import.meta.url,
  ),
  new URL(
    "../../../../prisma/migrations/20260719000000_metered_budget_ledger/migration.sql",
    import.meta.url,
  ),
  new URL(
    "../../../../prisma/migrations/20260719001000_product_truth_metered_evidence_link/migration.sql",
    import.meta.url,
  ),
] as const;

const operationalMigrationUrl = new URL(
  "../../../../prisma/migrations/20260719004000_product_truth_operational_run/migration.sql",
  import.meta.url,
);

const TARGET_FINGERPRINT = "a".repeat(64);
const ENGINE_RELEASE = "b".repeat(64);
const SCHEMA_FINGERPRINT = "c".repeat(64);
const MIGRATION_SET = "d".repeat(64);
const WALMART_ITEM_ID = "123456789";
const WALMART_URL = `https://www.walmart.com/ip/${WALMART_ITEM_ID}`;

const scratchDirectories = new Set<string>();

afterEach(async () => {
  resetMeteredCallUsageForTests();
  await Promise.all([...scratchDirectories].map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
  scratchDirectories.clear();
});

function plusMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertCurrentMatcherTuple(
  value: {
    matcherVersion: unknown;
    matcherImplementationSha256: unknown;
    matcherReleaseSha256: unknown;
  },
  label: string,
): void {
  assert.equal(value.matcherVersion, CANONICAL_PRODUCT_MATCHER_VERSION, `${label} matcher version`);
  assert.equal(
    value.matcherImplementationSha256,
    CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    `${label} matcher implementation`,
  );
  assert.equal(
    value.matcherReleaseSha256,
    CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    `${label} matcher release`,
  );
}

function exactUnwrangleDetailPayload() {
  return {
    success: true,
    platform: "walmart_detail",
    detail: {
      id: WALMART_ITEM_ID,
      name: "Acme Potato Chips Original Bag, 8 oz",
      url: WALMART_URL,
      images: [
        "https://images.example.test/production-front.jpg",
        "https://images.example.test/production-nutrition.jpg",
      ],
      description: "Retailer-authored exact description.",
      key_features: ["One 8 oz bag", "Original flavor"],
      ingredients: "Potatoes, vegetable oil, salt.",
      nutrition_facts: { calories: 150 },
      allergens: [],
      categories: [{ name: "Snack Foods" }],
      specifications: [{ name: "Storage", value: "Shelf Stable" }],
      upc: "012345678905",
    },
  };
}

async function createBaseSchema(db: Client): Promise<void> {
  await db.executeMultiple(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE DonorProduct (
      id TEXT PRIMARY KEY,
      brand TEXT,
      productLine TEXT,
      flavor TEXT,
      containerType TEXT,
      size TEXT,
      unitMeasure TEXT,
      unitAmount REAL,
      category TEXT,
      upc TEXT,
      gtin TEXT,
      title TEXT,
      description TEXT,
      bullets TEXT,
      attributes TEXT,
      nutritionFacts TEXT,
      ingredients TEXT,
      mainImageUrl TEXT,
      imageUrls TEXT,
      bestPrice REAL,
      bestRetailer TEXT,
      pricePerMeasure REAL,
      currency TEXT NOT NULL DEFAULT 'USD',
      identityKey TEXT NOT NULL UNIQUE,
      confidence REAL,
      needsReview INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL,
      updatedAt DATETIME NOT NULL
    );
    CREATE TABLE DonorOffer (
      id TEXT PRIMARY KEY,
      donorProductId TEXT NOT NULL,
      retailer TEXT NOT NULL,
      retailerProductId TEXT NOT NULL,
      via TEXT NOT NULL DEFAULT 'direct',
      price REAL,
      packSizeSeen INTEGER,
      pricePerUnit REAL,
      currency TEXT NOT NULL DEFAULT 'USD',
      zip TEXT,
      inStock INTEGER,
      productUrl TEXT,
      sellerName TEXT,
      isFirstParty INTEGER NOT NULL DEFAULT 0,
      sourceApi TEXT,
      fetchedAt TEXT,
      createdAt DATETIME NOT NULL,
      updatedAt DATETIME NOT NULL,
      UNIQUE(retailer, retailerProductId),
      FOREIGN KEY(donorProductId) REFERENCES DonorProduct(id)
    );
    CREATE TABLE SkuComponent (
      id TEXT PRIMARY KEY,
      donorProductId TEXT
    );
    CREATE TABLE SkuCost (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      asin TEXT,
      effectiveDate TEXT,
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
      createdAt DATETIME NOT NULL,
      updatedAt DATETIME NOT NULL,
      UNIQUE(sku, source, effectiveDate)
    );
  `);
}

async function createOperationalDependencies(db: Client): Promise<void> {
  await db.executeMultiple(`
    CREATE TABLE "ProductTruthListingScope" (
      "listingKey" TEXT NOT NULL PRIMARY KEY,
      "keyVersion" TEXT NOT NULL,
      "channel" TEXT NOT NULL,
      "storeIndex" INTEGER NOT NULL,
      "sku" TEXT NOT NULL,
      "manifestSha256" TEXT NOT NULL
    );
    CREATE TABLE "EnrichmentJob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "targetType" TEXT NOT NULL,
      "target" TEXT NOT NULL,
      "normalizedTarget" TEXT,
      "listingKey" TEXT,
      "idempotencyKey" TEXT,
      "requestedFields" TEXT NOT NULL DEFAULT '[]',
      "status" TEXT NOT NULL DEFAULT 'queued',
      "source" TEXT NOT NULL DEFAULT 'manual',
      "priority" INTEGER NOT NULL DEFAULT 0,
      "requestedBy" TEXT,
      "runId" TEXT,
      "approvalId" TEXT,
      "estimatedSpendUnits" REAL NOT NULL DEFAULT 0,
      "actualSpendUnits" REAL NOT NULL DEFAULT 0,
      "attempts" INTEGER NOT NULL DEFAULT 0,
      "providerAttempts" TEXT,
      "result" TEXT,
      "error" TEXT,
      "terminalReason" TEXT,
      "completedFields" TEXT,
      "unavailableFields" TEXT,
      "checkpoint" TEXT,
      "nextEligibleAt" DATETIME,
      "leaseOwner" TEXT,
      "leaseToken" TEXT,
      "leaseExpiresAt" DATETIME,
      "heartbeatAt" DATETIME,
      "queuedAt" DATETIME,
      "startedAt" DATETIME,
      "finishedAt" DATETIME,
      "createdAt" DATETIME,
      "updatedAt" DATETIME,
      FOREIGN KEY ("listingKey") REFERENCES "ProductTruthListingScope"("listingKey")
        ON DELETE RESTRICT ON UPDATE RESTRICT
    );
  `);
}

interface Fixture {
  db: Client;
  directory: string;
  databaseUrl: string;
  initialAt: string;
  request: ProductTruthTargetedWalmartEvidencePlanRequest;
  plan: ProductTruthTargetedWalmartEvidencePlan;
  planSha256: string;
  approval: ValidatedProductTruthOperationalApproval;
  adapter: ProductTruthTargetedWalmartEvidenceAdapter;
  counters: { oxylabs: number; unwrangle: number };
  adapterCalls: { probeRuntime: number };
  reports: ProductTruthTargetedWalmartEvidenceReport[];
}

async function createFixture(input: {
  runId: string;
  initialAt?: string;
  planExpiresAt?: string;
}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "targeted-walmart-evidence-integration-"));
  scratchDirectories.add(directory);
  const databaseUrl = `file:${join(directory, "scratch.db")}`;
  const db = createClient({ url: databaseUrl, concurrency: 1 });
  await createBaseSchema(db);
  for (const migrationUrl of migrationUrls) {
    await db.executeMultiple(await readFile(migrationUrl, "utf8"));
  }
  await createOperationalDependencies(db);
  await db.executeMultiple(await readFile(operationalMigrationUrl, "utf8"));

  const initialAt = input.initialAt ?? new Date().toISOString();
  const createdAt = plusMilliseconds(initialAt, -60_000);
  const expiresAt = input.planExpiresAt ?? plusMilliseconds(initialAt, 60 * 60_000);
  const legacyAt = plusMilliseconds(createdAt, -60_000);
  const donorProductId = `legacy-${input.runId}`;
  const donorOfferId = `offer-${input.runId}`;
  await db.execute({
    sql: `INSERT INTO "DonorProduct"
          (id,brand,productLine,flavor,containerType,size,unitMeasure,unitAmount,title,
           currency,identityKey,identityStatus,needsReview,createdAt,updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,'USD',?,'legacy_unverified',0,?,?)`,
    args: [
      donorProductId,
      "Acme",
      "Potato Chips",
      "Original",
      "Bag",
      "8 oz",
      "oz",
      8,
      "Acme Potato Chips Original Bag, 8 oz",
      `legacy:${input.runId}`,
      legacyAt,
      legacyAt,
    ],
  });
  await db.execute({
    sql: `INSERT INTO "DonorOffer"
          (id,donorProductId,retailer,retailerProductId,via,price,packSizeSeen,
           pricePerUnit,currency,zip,localityEvidence,inStock,productUrl,sellerName,
           isFirstParty,sourceApi,fetchedAt,createdAt,updatedAt)
          VALUES (?,?,'walmart',?,'direct',4.49,1,4.49,'USD','33765',
                  'zip_scoped',1,?,'Walmart.com',1,'legacy',?,?,?)`,
    args: [donorOfferId, donorProductId, WALMART_ITEM_ID, WALMART_URL, legacyAt, legacyAt, legacyAt],
  });

  const snapshot = await readTargetedWalmartLegacyDonorSnapshot(
    db,
    donorProductId,
  );
  const request = buildProductTruthTargetedWalmartEvidenceRequest({
    runId: input.runId,
    createdAt,
    expiresAt,
    targetFingerprint: TARGET_FINGERPRINT,
    engineReleaseSha256: ENGINE_RELEASE,
    schemaFingerprintSha256: SCHEMA_FINGERPRINT,
    migrationSetSha256: MIGRATION_SET,
    query: "Acme Potato Chips Original Bag 8 oz",
    donorSnapshot: snapshot,
    unwrangleReserveFloor: 100,
  });
  assert.equal(
    request.schemaVersion,
    PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REQUEST_VERSION,
  );
  assertCurrentMatcherTuple(request, "targeted request");
  assertCurrentMatcherTuple(request.donorSnapshot, "targeted request donor snapshot");
  const plan = buildProductTruthTargetedWalmartEvidencePlan({
    request,
    actualTargetFingerprint: TARGET_FINGERPRINT,
    actualEngineReleaseSha256: ENGINE_RELEASE,
    actualSchemaFingerprintSha256: SCHEMA_FINGERPRINT,
    actualMigrationSetSha256: MIGRATION_SET,
    actualDonorSnapshot: snapshot,
    actualDetailHarvestStateAbsent: true,
  });
  assert.equal(
    plan.schemaVersion,
    PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION,
  );
  assertCurrentMatcherTuple(plan, "targeted plan");
  assertCurrentMatcherTuple(plan.targets[0], "targeted plan target");
  const planSha256 = productTruthOperationalSha256(plan);
  const approvalId = `approval-${input.runId}`;
  const providers = Object.fromEntries(plan.providerCeilings.map((ceiling) => [
    ceiling.provider,
    {
      operations: [...ceiling.operations],
      maxCalls: ceiling.maxCalls,
      maxUnits: ceiling.maxUnits ?? undefined,
    },
  ])) as MeteredRunPermit["providers"];
  const meteredPermit: MeteredRunPermit = {
    version: 1,
    runId: plan.runId,
    approvalId,
    approvedBy: "owner",
    issuedAt: createdAt,
    expiresAt,
    providers,
  };
  const rawApproval: ProductTruthOperationalApproval = {
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION,
    approvedBy: "owner",
    runId: plan.runId,
    approvalId,
    action: "EXECUTE_WAVE",
    planSha256,
    targetFingerprint: plan.targetFingerprint,
    issuedAt: createdAt,
    expiresAt,
    meteredPermit,
    balanceEvidence: [{
      provider: "unwrangle",
      observedAt: initialAt,
      balanceUnits: 1_000,
      reserveFloor: 100,
      evidenceSha256: "e".repeat(64),
    }],
  };
  const approval = validateProductTruthTargetedWalmartEvidenceApproval({
    plan,
    planSha256,
    approval: rawApproval,
    executionConfirmation: expectedProductTruthExecutionConfirmation(planSha256, approvalId),
    now: initialAt,
  });
  const counters = { oxylabs: 0, unwrangle: 0 };
  const adapterCalls = { probeRuntime: 0 };
  const reports: ProductTruthTargetedWalmartEvidenceReport[] = [];

  const fakeHarvestDetail = async (
    innerDb: Client,
    productId: string,
    options: HarvestDonorDetailOptions,
  ): Promise<HarvestResult> => {
    let authorization: MeteredProviderAuthorization | null = null;
    await withMeteredProviderCall({
      provider: "unwrangle",
      operation: "detail",
      units: 2.5,
      requestFingerprint: {
        platform: "walmart_detail",
        retailer: "walmart",
        url: options.productUrl,
      },
      onAuthorized: async (value) => {
        authorization = value;
        await options.onMeteredReservation?.(value);
      },
    }, async () => {
      counters.unwrangle += 1;
      return { exactItem: true };
    });
    const exactAuthorization = authorization as MeteredProviderAuthorization | null;
    assert.ok(exactAuthorization, "detail authorization must be captured");
    const guardedWriteAt = await options.beforeCatalogWrite?.();
    const writeAt = typeof guardedWriteAt === "string" ? guardedWriteAt : initialAt;
    const persisted = await persistCompleteExactContentObservation(innerDb, {
      donorProductId: productId,
      retailer: "walmart",
      retailerProductId: WALMART_ITEM_ID,
      sourceUrl: WALMART_URL,
      sourceApi: "unwrangle",
      observedAt: writeAt,
      processingNow: writeAt,
      provenance: {
        runId: exactAuthorization.runId,
        approvalId: exactAuthorization.approvalId,
        meteredReceiptId: exactAuthorization.receiptId,
      },
      detailIdentity: {
        title: "Acme Potato Chips Original Bag, 8 oz",
        retailerProductId: WALMART_ITEM_ID,
        productUrl: WALMART_URL,
      },
      requireBaseUnit: true,
      content: {
        description: "Exact Walmart description for the sealed 8 oz item.",
        bullets: ["One 8 oz bag", "Original flavor"],
        attributes: { packageType: "Bag", netContent: "8 oz" },
        nutritionFacts: { servingSize: "1 oz", calories: 150, sodiumMg: 170 },
        ingredients: "Potatoes, vegetable oil, salt.",
        allergens: ["milk"],
        mainImageUrl: "https://images.example.test/acme-front.jpg",
        imageUrls: [
          "https://images.example.test/acme-front.jpg",
          "https://images.example.test/acme-back.jpg",
          "https://images.example.test/acme-side.jpg",
          "https://images.example.test/acme-nutrition.jpg",
          "https://images.example.test/acme-ingredients.jpg",
        ],
        upc: "012345678905",
        category: "Snack Foods",
        storage: "Shelf Stable",
      },
      supplementalSources: {},
      upcConflictPolicy: "block",
    });
    return {
      ok: true,
      productId,
      images: persisted.imageCount,
      upc: persisted.upc,
      hasIngredients: true,
      merged: 0,
      upcConflicts: persisted.upcConflicts,
      imageFlagged: false,
    };
  };

  const adapter: ProductTruthTargetedWalmartEvidenceAdapter = {
    probeRuntime: async () => {
      adapterCalls.probeRuntime += 1;
      return {
        targetFingerprint: TARGET_FINGERPRINT,
        engineReleaseSha256: ENGINE_RELEASE,
        schemaFingerprintSha256: SCHEMA_FINGERPRINT,
        migrationSetSha256: MIGRATION_SET,
        canonicalMigrationsApplied: true,
      };
    },
    search: async (query) => {
      let authorization: MeteredProviderAuthorization | null = null;
      await withMeteredProviderCall({
        provider: "oxylabs",
        operation: "query",
        units: 1,
        requestFingerprint: { platform: "walmart", query, zip: "33765" },
        onAuthorized: (value) => { authorization = value; },
      }, async () => {
        counters.oxylabs += 1;
        return { exactItem: true };
      });
      const exactAuthorization = authorization as MeteredProviderAuthorization | null;
      assert.ok(exactAuthorization, "search authorization must be captured");
      const offer: RetailOffer = {
        retailer: "walmart",
        retailerProductId: WALMART_ITEM_ID,
        title: "Acme Potato Chips Original Bag, 8 oz",
        description: "Exact Walmart description for the sealed 8 oz item.",
        keyFeatures: ["One 8 oz bag", "Original flavor"],
        imageUrls: ["https://images.example.test/acme-search.jpg"],
        price: 4.49,
        currency: "USD",
        inStock: true,
        productUrl: WALMART_URL,
        zip: "33765",
        localityEvidence: "zip_scoped",
        observedAt: initialAt,
        packSizeSeen: 1,
        isMarketplaceItem: false,
        sellerName: "Walmart.com",
        sourceApi: "oxylabs",
        via: "direct",
        meteredReceiptId: exactAuthorization.receiptId,
        meteredRunId: exactAuthorization.runId,
        meteredApprovalId: exactAuthorization.approvalId,
      };
      return {
        offers: [offer],
        localityProven: true,
        responseZip: "33765",
        trialExhausted: false,
      };
    },
    persistOffer: (innerDb, offer, target, processingNow, options) => (
      persistScoredDonorOffer(innerDb, offer, target, processingNow, options)
    ),
    harvest: (innerDb, harvestInput) => executeDonorHarvestCandidate({
      ...harvestInput,
      db: innerDb,
      allowOpenFoodFactsSupplement: false,
      upcConflictPolicy: "block",
      harvestDetail: fakeHarvestDetail,
    }),
    readCandidate: readWalmartPilotCandidate,
  };

  return {
    db,
    directory,
    databaseUrl,
    initialAt,
    request,
    plan,
    planSha256,
    approval,
    adapter,
    counters,
    adapterCalls,
    reports,
  };
}

function artifactWriter(fixture: Fixture) {
  return async (report: ProductTruthTargetedWalmartEvidenceReport) => {
    fixture.reports.push(report);
    return {
      reportSha256: sha256(JSON.stringify(report)),
      artifactIndexSha256: sha256(`artifact-index\n${report.runId}\n${report.outcome}`),
    };
  };
}

function executionInput(
  fixture: Fixture,
  command: "execute" | "resume",
  overrides: {
    now?: () => string;
    monotonicNow?: () => number;
  } = {},
) {
  return {
    plan: fixture.plan,
    planSha256: fixture.planSha256,
    validatedApproval: fixture.approval,
    environment: "local-test" as const,
    command,
    leaseOwner: `worker-${fixture.plan.runId}`,
    meteredDatabase: {
      url: fixture.databaseUrl,
      targetFingerprint: TARGET_FINGERPRINT,
    },
    artifactWriter: artifactWriter(fixture),
    adapter: fixture.adapter,
    now: overrides.now ?? (() => fixture.initialAt),
    monotonicNow: overrides.monotonicNow ?? (() => 0),
  };
}

async function scalarCount(db: Client, table: string, where = ""): Promise<number> {
  const result = await db.execute(`SELECT COUNT(*) AS n FROM "${table}" ${where}`);
  return Number(result.rows[0]?.n ?? 0);
}

describe("targeted Walmart evidence executor integration", { concurrency: false }, () => {
  test("bootstrap deadline after price persistence resumes with detail only and no paid replay", async () => {
    const fixture = await createFixture({ runId: "targeted-bootstrap-crash" });
    try {
      let monotonicReads = 0;
      const interrupted = await executeProductTruthTargetedWalmartEvidence(
        fixture.db,
        executionInput(fixture, "execute", {
          monotonicNow: () => {
            monotonicReads += 1;
            return monotonicReads >= 8 ? 180_000 : 0;
          },
        }),
      );
      assert.equal(interrupted.status, "interrupted", interrupted.reason);
      assert.equal(interrupted.outcome, "INTERRUPTED");
      assert.equal(interrupted.reason, "TARGETED_EVIDENCE_WALL_CLOCK_EXHAUSTED_SAFE_TO_RESUME");
      assert.deepEqual(fixture.counters, { oxylabs: 1, unwrangle: 0 });

      const afterInterrupt = await inspectProductTruthTargetedWalmartEvidenceRun(
        fixture.db,
        fixture.plan.runId,
      );
      assert.ok(afterInterrupt.run);
      assert.equal(afterInterrupt.run.status, "interrupted");
      assert.equal(afterInterrupt.run.leaseOwner, null);
      assert.equal(afterInterrupt.run.leaseToken, null);
      assert.equal(afterInterrupt.run.leaseExpiresAt, null);
      assert.equal(afterInterrupt.job?.status, "running");
      assert.equal(afterInterrupt.job?.attempts, 1);
      assert.equal(afterInterrupt.job?.leaseOwner, null);
      assert.equal(afterInterrupt.job?.leaseToken, null);
      assert.equal(afterInterrupt.job?.leaseExpiresAt, null);
      assert.deepEqual(
        afterInterrupt.ledger.receipts.map((receipt) => [receipt.provider, receipt.operation, receipt.status]),
        [["oxylabs", "query", "succeeded"]],
      );
      assert.equal(await scalarCount(
        fixture.db,
        "MeteredReservationReceipt",
        "WHERE status='reserved'",
      ), 0);
      assert.deepEqual(
        afterInterrupt.events.map((event) => event.eventType),
        ["RUN_PREPARED", "RUN_LEASE_ACQUIRED", "RUN_FINISHED"],
      );

      const resumed = await executeProductTruthTargetedWalmartEvidence(
        fixture.db,
        executionInput(fixture, "resume"),
      );
      assert.equal(resumed.status, "completed");
      assert.equal(resumed.outcome, "COMPLETED");
      assert.equal(resumed.reason, "EXACT_PRICE_CONTENT_AND_WALMART_CANDIDATE_VERIFIED");
      assert.deepEqual(fixture.counters, { oxylabs: 1, unwrangle: 1 });

      const completed = await inspectProductTruthTargetedWalmartEvidenceRun(
        fixture.db,
        fixture.plan.runId,
      );
      assert.ok(completed.run);
      assert.equal(completed.run.status, "completed");
      assert.equal(completed.run.leaseOwner, null);
      assert.equal(completed.run.leaseToken, null);
      assert.equal(completed.job?.status, "done");
      assert.equal(completed.job?.attempts, 1);
      assert.equal(completed.job?.leaseOwner, null);
      assert.equal(completed.job?.leaseToken, null);
      assert.equal(completed.job?.leaseExpiresAt, null);
      assert.deepEqual(
        completed.ledger.receipts.map((receipt) => [
          receipt.provider,
          receipt.operation,
          receipt.status,
          receipt.units,
        ]),
        [
          ["oxylabs", "query", "succeeded", 1],
          ["unwrangle", "detail", "succeeded", 2.5],
        ],
      );
      assert.equal(completed.ledger.totals.calls, 2);
      assert.equal(completed.ledger.totals.units, 3.5);
      assert.equal(await scalarCount(
        fixture.db,
        "MeteredReservationReceipt",
        "WHERE status='reserved'",
      ), 0);
      const harvest = (await fixture.db.execute({
        sql: `SELECT status,attempts,leaseOwner,leaseToken,leaseExpiresAt
              FROM "DonorHarvestState" WHERE donorProductId=?`,
        args: [fixture.plan.targets[0].donorProductId],
      })).rows[0];
      assert.equal(harvest?.status, "complete");
      assert.equal(Number(harvest?.attempts), 1);
      assert.equal(harvest?.leaseOwner, null);
      assert.equal(harvest?.leaseToken, null);
      assert.equal(harvest?.leaseExpiresAt, null);

      const target = fixture.plan.targets[0];
      const decisionBeforeDrift = (await fixture.db.execute({
        sql: `SELECT id,matcherVersion,matcherImplementationSha256,matcherReleaseSha256,
                     evidenceHash,evidenceJson
              FROM "DonorProductVariantDecision" WHERE donorProductId=?`,
        args: [target.donorProductId],
      })).rows[0];
      assert.ok(decisionBeforeDrift);
      assertCurrentMatcherTuple({
        matcherVersion: decisionBeforeDrift.matcherVersion,
        matcherImplementationSha256: decisionBeforeDrift.matcherImplementationSha256,
        matcherReleaseSha256: decisionBeforeDrift.matcherReleaseSha256,
      }, "persisted variant decision");
      const decisionEvidence = JSON.parse(String(decisionBeforeDrift.evidenceJson)) as {
        matcherVersion: unknown;
        matcherImplementationSha256: unknown;
        matcherReleaseSha256: unknown;
      };
      assertCurrentMatcherTuple(decisionEvidence, "persisted variant decision evidence");
      assert.equal(
        decisionBeforeDrift.evidenceHash,
        sha256(String(decisionBeforeDrift.evidenceJson)),
      );

      const productProjection = (await fixture.db.execute({
        sql: `SELECT identityStatus,identityMatcherVersion,
                     identityMatcherImplementationSha256,identityMatcherReleaseSha256,
                     identityEvidenceJson
              FROM "DonorProduct" WHERE id=?`,
        args: [target.donorProductId],
      })).rows[0];
      assert.equal(productProjection?.identityStatus, "exact_confirmed");
      assertCurrentMatcherTuple({
        matcherVersion: productProjection?.identityMatcherVersion,
        matcherImplementationSha256: productProjection?.identityMatcherImplementationSha256,
        matcherReleaseSha256: productProjection?.identityMatcherReleaseSha256,
      }, "persisted donor projection");
      assert.deepEqual(
        JSON.parse(String(productProjection?.identityEvidenceJson)),
        decisionEvidence,
      );

      const driftedEvidence = JSON.stringify({
        ...decisionEvidence,
        matcherReleaseSha256: "f".repeat(64),
      });
      await assert.rejects(
        fixture.db.execute({
          sql: `UPDATE "DonorProductVariantDecision"
                SET matcherReleaseSha256=?,evidenceHash=?,evidenceJson=? WHERE id=?`,
          args: [
            "f".repeat(64),
            sha256(driftedEvidence),
            driftedEvidence,
            decisionBeforeDrift.id,
          ],
        }),
        /DONOR_PRODUCT_VARIANT_DECISION_IMMUTABLE/,
      );
      const decisionAfterDrift = (await fixture.db.execute({
        sql: `SELECT id,matcherVersion,matcherImplementationSha256,matcherReleaseSha256,
                     evidenceHash,evidenceJson
              FROM "DonorProductVariantDecision" WHERE donorProductId=?`,
        args: [target.donorProductId],
      })).rows[0];
      assert.deepEqual(decisionAfterDrift, decisionBeforeDrift);
      assert.deepEqual(
        completed.events.map((event) => event.eventType),
        [
          "RUN_PREPARED",
          "RUN_LEASE_ACQUIRED",
          "RUN_FINISHED",
          "RUN_LEASE_ACQUIRED",
          "RUN_FINISHED",
        ],
      );
      assert.equal(fixture.reports.length, 2);
      assert.equal(fixture.reports[0]?.outcome, "INTERRUPTED");
      assert.equal(fixture.reports[1]?.outcome, "COMPLETED");
    } finally {
      await fixture.db.close();
    }
  });

  test("a matcher tuple drift in the sealed plan fails before DB or provider work", async () => {
    const fixture = await createFixture({ runId: "targeted-matcher-tuple-drift" });
    try {
      assert.equal(
        fixture.request.schemaVersion,
        PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REQUEST_VERSION,
      );
      const driftedPlan = {
        ...fixture.plan,
        matcherImplementationSha256: "f".repeat(64),
      } as unknown as ProductTruthTargetedWalmartEvidencePlan;
      await assert.rejects(
        executeProductTruthTargetedWalmartEvidence(
          fixture.db,
          {
            ...executionInput(fixture, "execute"),
            plan: driftedPlan,
            planSha256: productTruthOperationalSha256(driftedPlan),
          },
        ),
        /TARGETED_EVIDENCE_MATCHER_PROVENANCE_MISMATCH/,
      );
      assert.deepEqual(fixture.counters, { oxylabs: 0, unwrangle: 0 });
      assert.equal(await scalarCount(fixture.db, "ProductTruthOperationalRun"), 0);
      assert.equal(await scalarCount(fixture.db, "EnrichmentJob"), 0);
      assert.equal(await scalarCount(fixture.db, "MeteredReservationReceipt"), 0);
      assert.equal(await scalarCount(fixture.db, "CanonicalProductVariant"), 0);
      assert.equal(await scalarCount(fixture.db, "DonorProductVariantDecision"), 0);
      assert.equal(await scalarCount(fixture.db, "DonorOfferObservation"), 0);
      assert.equal(await scalarCount(fixture.db, "ProductContentObservation"), 0);
    } finally {
      await fixture.db.close();
    }
  });

  test("decision evidence hash or JSON matcher drift fails before every adapter/provider call", async () => {
    for (const mode of ["HASH_MISMATCH", "JSON_MATCHER_MISMATCH"] as const) {
      const fixture = await createFixture({
        runId: `targeted-decision-evidence-${mode.toLowerCase()}`,
      });
      try {
        let monotonicReads = 0;
        const interrupted = await executeProductTruthTargetedWalmartEvidence(
          fixture.db,
          executionInput(fixture, "execute", {
            monotonicNow: () => {
              monotonicReads += 1;
              return monotonicReads >= 8 ? 180_000 : 0;
            },
          }),
        );
        assert.equal(interrupted.status, "interrupted", interrupted.reason);
        assert.deepEqual(fixture.counters, { oxylabs: 1, unwrangle: 0 });

        const decision = (await fixture.db.execute({
          sql: `SELECT id,evidenceJson FROM "DonorProductVariantDecision"
                WHERE donorProductId=?`,
          args: [fixture.plan.targets[0].donorProductId],
        })).rows[0];
        assert.ok(decision);
        await fixture.db.execute(`DROP TRIGGER "DonorProductVariantDecision_update_guard"`);
        if (mode === "HASH_MISMATCH") {
          await fixture.db.execute({
            sql: `UPDATE "DonorProductVariantDecision" SET evidenceHash=? WHERE id=?`,
            args: ["0".repeat(64), decision.id],
          });
        } else {
          const driftedEvidenceJson = JSON.stringify({
            ...JSON.parse(String(decision.evidenceJson)) as Record<string, unknown>,
            matcherReleaseSha256: "0".repeat(64),
          });
          await fixture.db.execute(`PRAGMA ignore_check_constraints=ON`);
          await fixture.db.execute({
            sql: `UPDATE "DonorProductVariantDecision"
                  SET evidenceHash=?,evidenceJson=? WHERE id=?`,
            args: [sha256(driftedEvidenceJson), driftedEvidenceJson, decision.id],
          });
        }

        const providerCallsBefore = { ...fixture.counters };
        const adapterCallsBefore = { ...fixture.adapterCalls };
        const receiptCountBefore = await scalarCount(
          fixture.db,
          "MeteredReservationReceipt",
        );
        await assert.rejects(
          executeProductTruthTargetedWalmartEvidence(
            fixture.db,
            executionInput(fixture, "resume"),
          ),
          mode === "HASH_MISMATCH"
            ? /TARGETED_EVIDENCE_DECISION_EVIDENCE_HASH_MISMATCH/
            : /TARGETED_EVIDENCE_DECISION_EVIDENCE_MATCHER_MISMATCH/,
        );
        assert.deepEqual(fixture.counters, providerCallsBefore);
        assert.deepEqual(fixture.adapterCalls, adapterCallsBefore);
        assert.equal(
          await scalarCount(fixture.db, "MeteredReservationReceipt"),
          receiptCountBefore,
        );
      } finally {
        await fixture.db.close();
      }
    }
  });

  test("a truly empty prepared control run is recoverable by resume", async () => {
    const fixture = await createFixture({ runId: "targeted-prepared-recovery" });
    try {
      const seeded = await seedProductTruthTargetedEvidenceControlRun(fixture.db, {
        plan: fixture.plan,
        planSha256: fixture.planSha256,
        approvalId: fixture.approval.approval.approvalId,
        environment: "local-test",
        at: fixture.initialAt,
      });
      assert.equal(seeded.created, true);
      assert.equal(seeded.run.status, "prepared");
      assert.equal(await scalarCount(fixture.db, "EnrichmentJob"), 0);
      assert.equal(await scalarCount(fixture.db, "MeteredReservationReceipt"), 0);
      assert.equal(await scalarCount(fixture.db, "DonorHarvestState"), 0);

      const result = await executeProductTruthTargetedWalmartEvidence(
        fixture.db,
        executionInput(fixture, "resume"),
      );
      assert.equal(result.status, "completed", result.reason);
      assert.deepEqual(fixture.counters, { oxylabs: 1, unwrangle: 1 });
      const inspection = await inspectProductTruthTargetedWalmartEvidenceRun(
        fixture.db,
        fixture.plan.runId,
      );
      assert.ok(inspection.run);
      const expectedJobId = `ptej_${sha256(`targeted-walmart-evidence-job/1\n${fixture.planSha256}`)}`;
      assert.equal(inspection.job?.id, expectedJobId);
      assert.equal(inspection.job?.status, "done");
      const storedJob = (await fixture.db.execute({
        sql: `SELECT source,target,requestedFields FROM "EnrichmentJob" WHERE id=?`,
        args: [expectedJobId],
      })).rows[0];
      assert.equal(storedJob?.source, `product-truth-targeted-walmart-evidence:${fixture.planSha256}`);
      assert.equal(storedJob?.target, fixture.plan.targets[0].donorProductId);
      assert.equal(storedJob?.requestedFields, JSON.stringify(["content", "offers"]));
    } finally {
      await fixture.db.close();
    }
  });

  test("the targeted expiry reaper releases only the deterministic job and exact expired leases", async () => {
    const fixture = await createFixture({ runId: "targeted-expired-lease-reaper" });
    try {
      await seedProductTruthTargetedEvidenceControlRun(fixture.db, {
        plan: fixture.plan,
        planSha256: fixture.planSha256,
        approvalId: fixture.approval.approval.approvalId,
        environment: "local-test",
        at: fixture.initialAt,
      });
      const leaseExpiresAt = plusMilliseconds(fixture.initialAt, 1_000);
      await acquireProductTruthOperationalRunLease(fixture.db, {
        runId: fixture.plan.runId,
        leaseOwner: "dead-targeted-run-worker",
        leaseToken: "dead-targeted-run-token",
        at: fixture.initialAt,
        leaseExpiresAt,
      });

      const deterministicJobId = `ptej_${sha256(`targeted-walmart-evidence-job/1\n${fixture.planSha256}`)}`;
      const deterministicIdempotencyKey = sha256(
        `targeted-walmart-evidence-job-idempotency/1\n${fixture.planSha256}`,
      );
      const target = fixture.plan.targets[0].donorProductId;
      await fixture.db.execute({
        sql: `INSERT INTO "EnrichmentJob"
              (id,targetType,target,normalizedTarget,listingKey,idempotencyKey,requestedFields,
               status,source,priority,requestedBy,attempts,runId,approvalId,
               estimatedSpendUnits,actualSpendUnits,nextEligibleAt,leaseOwner,leaseToken,
               leaseExpiresAt,heartbeatAt,queuedAt,startedAt,createdAt,updatedAt)
              VALUES (?,'product',?,?,NULL,?,?,'running',?,100,
                      'owner-approved-targeted-evidence',1,?,?,3.5,0,?,?,?,?,?,?,?,?,?)`,
        args: [
          deterministicJobId,
          target,
          normalizeEnrichmentTarget("product", target),
          deterministicIdempotencyKey,
          JSON.stringify(["content", "offers"]),
          `product-truth-targeted-walmart-evidence:${fixture.planSha256}`,
          fixture.plan.runId,
          fixture.approval.approval.approvalId,
          fixture.initialAt,
          "dead-targeted-job-worker",
          "dead-targeted-job-token",
          leaseExpiresAt,
          fixture.initialAt,
          fixture.initialAt,
          fixture.initialAt,
          fixture.initialAt,
          fixture.initialAt,
        ],
      });

      const reapedAt = plusMilliseconds(fixture.initialAt, 2_000);
      const reaped = await reapExpiredProductTruthTargetedEvidenceRun(fixture.db, {
        runId: fixture.plan.runId,
        at: reapedAt,
        disposition: "interrupted",
        reason: "TEST_EXPIRED_TARGETED_EVIDENCE_LEASE_SAFE_TO_RESUME",
      });
      assert.equal(reaped.status, "interrupted");
      assert.equal(reaped.run.status, "interrupted");
      assert.equal(reaped.run.leaseOwner, null);
      assert.equal(reaped.run.leaseToken, null);
      assert.equal(reaped.run.leaseExpiresAt, null);

      const inspection = await inspectProductTruthTargetedWalmartEvidenceRun(
        fixture.db,
        fixture.plan.runId,
      );
      assert.equal(inspection.job?.id, deterministicJobId);
      assert.equal(inspection.job?.status, "running");
      assert.equal(inspection.job?.attempts, 1);
      assert.equal(inspection.job?.leaseOwner, null);
      assert.equal(inspection.job?.leaseToken, null);
      assert.equal(inspection.job?.leaseExpiresAt, null);
      assert.deepEqual(
        inspection.events.map((event) => event.eventType),
        ["RUN_PREPARED", "RUN_LEASE_ACQUIRED", "RUN_LEASE_EXPIRED_TARGETED_SAFE"],
      );
      assert.equal(inspection.ledger.receipts.length, 0);
      assert.deepEqual(fixture.counters, { oxylabs: 0, unwrangle: 0 });
    } finally {
      await fixture.db.close();
    }
  });

  test("a forged deterministic run-owned product job blocks before either provider", async () => {
    const fixture = await createFixture({ runId: "targeted-forged-job" });
    try {
      await seedProductTruthTargetedEvidenceControlRun(fixture.db, {
        plan: fixture.plan,
        planSha256: fixture.planSha256,
        approvalId: fixture.approval.approval.approvalId,
        environment: "local-test",
        at: fixture.initialAt,
      });
      const manualLeaseToken = "manual-interrupted-run-lease";
      await acquireProductTruthOperationalRunLease(fixture.db, {
        runId: fixture.plan.runId,
        leaseOwner: "manual-test-worker",
        leaseToken: manualLeaseToken,
        at: fixture.initialAt,
        leaseExpiresAt: plusMilliseconds(fixture.initialAt, 240_000),
      });
      await finishProductTruthOperationalRun(fixture.db, {
        runId: fixture.plan.runId,
        leaseToken: manualLeaseToken,
        status: "interrupted",
        at: plusMilliseconds(fixture.initialAt, 1),
      });

      const deterministicJobId = `ptej_${sha256(`targeted-walmart-evidence-job/1\n${fixture.planSha256}`)}`;
      await fixture.db.execute({
        sql: `INSERT INTO "EnrichmentJob"
              (id,targetType,target,normalizedTarget,listingKey,idempotencyKey,requestedFields,
               status,source,priority,requestedBy,attempts,runId,approvalId,
               estimatedSpendUnits,actualSpendUnits,nextEligibleAt,queuedAt,createdAt,updatedAt)
              VALUES (?,'product','forged-donor','forged-donor',NULL,?,?,'queued',?,100,
                      'forged-test',0,?,?,3.5,0,?,?,?,?)`,
        args: [
          deterministicJobId,
          "f".repeat(64),
          JSON.stringify(["content", "offers"]),
          `product-truth-targeted-walmart-evidence:${fixture.planSha256}`,
          fixture.plan.runId,
          fixture.approval.approval.approvalId,
          fixture.initialAt,
          fixture.initialAt,
          fixture.initialAt,
          fixture.initialAt,
        ],
      });

      const result = await executeProductTruthTargetedWalmartEvidence(
        fixture.db,
        executionInput(fixture, "resume", {
          now: () => plusMilliseconds(fixture.initialAt, 2),
        }),
      );
      assert.equal(result.status, "blocked");
      assert.match(result.reason, /TARGETED_EVIDENCE_JOB_AMBIGUOUS/);
      assert.deepEqual(fixture.counters, { oxylabs: 0, unwrangle: 0 });
      const ledger = await readProductTruthOperationalLedger(fixture.db, fixture.plan.runId);
      assert.equal(ledger.receipts.length, 0);
      const storedRun = (await fixture.db.execute({
        sql: `SELECT status,leaseOwner,leaseToken,leaseExpiresAt
              FROM "ProductTruthOperationalRun" WHERE runId=?`,
        args: [fixture.plan.runId],
      })).rows[0];
      assert.equal(storedRun?.status, "blocked");
      assert.equal(storedRun?.leaseOwner, null);
      assert.equal(storedRun?.leaseToken, null);
      assert.equal(storedRun?.leaseExpiresAt, null);
      const forgedJob = (await fixture.db.execute({
        sql: `SELECT id,status,target,leaseOwner,leaseToken,leaseExpiresAt
              FROM "EnrichmentJob" WHERE id=?`,
        args: [deterministicJobId],
      })).rows[0];
      assert.equal(forgedJob?.id, deterministicJobId);
      assert.equal(forgedJob?.status, "queued");
      assert.equal(forgedJob?.target, "forged-donor");
      assert.equal(forgedJob?.leaseOwner, null);
      assert.equal(forgedJob?.leaseToken, null);
      assert.equal(forgedJob?.leaseExpiresAt, null);
      assert.equal(fixture.reports.at(-1)?.job, null);
      assert.equal(fixture.reports.at(-1)?.outcome, "BLOCKED");
    } finally {
      await fixture.db.close();
    }
  });

  test("near-expiry wall-clock rollback is explicit and releases the run before provider I/O", async () => {
    const initialAt = new Date().toISOString();
    const fixture = await createFixture({
      runId: "targeted-near-expiry-wall-rollback",
      initialAt,
      planExpiresAt: plusMilliseconds(initialAt, 10_000),
    });
    try {
      let wallReads = 0;
      const result = await executeProductTruthTargetedWalmartEvidence(
        fixture.db,
        executionInput(fixture, "execute", {
          now: () => {
            wallReads += 1;
            return wallReads < 4 ? initialAt : plusMilliseconds(initialAt, -1_000);
          },
        }),
      );
      assert.equal(result.status, "blocked");
      assert.equal(result.outcome, "BLOCKED");
      assert.match(result.reason, /TARGETED_EVIDENCE_WALL_CLOCK_ROLLBACK/);
      assert.deepEqual(fixture.counters, { oxylabs: 0, unwrangle: 0 });
      assert.equal(await scalarCount(fixture.db, "MeteredReservationReceipt"), 0);
      const inspection = await inspectProductTruthTargetedWalmartEvidenceRun(
        fixture.db,
        fixture.plan.runId,
      );
      assert.ok(inspection.run);
      assert.equal(inspection.run.status, "blocked");
      assert.equal(inspection.run.leaseOwner, null);
      assert.equal(inspection.run.leaseToken, null);
      assert.equal(inspection.job, null);
    } finally {
      await fixture.db.close();
    }
  });

  test("wall-clock rollback after Oxylabs settlement is ambiguous and performs no catalog write", async () => {
    const fixture = await createFixture({ runId: "targeted-post-search-wall-rollback" });
    try {
      const target = fixture.plan.targets[0];
      const beforeProduct = (await fixture.db.execute({
        sql: `SELECT * FROM "DonorProduct" WHERE id=?`,
        args: [target.donorProductId],
      })).rows[0];
      const beforeOffer = (await fixture.db.execute({
        sql: `SELECT * FROM "DonorOffer" WHERE id=?`,
        args: [target.donorOfferId],
      })).rows[0];

      const result = await executeProductTruthTargetedWalmartEvidence(
        fixture.db,
        executionInput(fixture, "execute", {
          now: () => fixture.counters.oxylabs === 0
            ? fixture.initialAt
            : plusMilliseconds(fixture.initialAt, -1_000),
        }),
      );
      assert.equal(result.status, "ambiguous");
      assert.equal(result.outcome, "AMBIGUOUS");
      assert.match(result.reason, /TARGETED_EVIDENCE_WALL_CLOCK_ROLLBACK/);
      assert.deepEqual(fixture.counters, { oxylabs: 1, unwrangle: 0 });

      const ledger = await readProductTruthOperationalLedger(fixture.db, fixture.plan.runId);
      assert.deepEqual(
        ledger.receipts.map((receipt) => [receipt.provider, receipt.operation, receipt.status]),
        [["oxylabs", "query", "succeeded"]],
      );
      assert.equal(await scalarCount(
        fixture.db,
        "MeteredReservationReceipt",
        "WHERE status='reserved'",
      ), 0);
      assert.equal(await scalarCount(fixture.db, "CanonicalProductVariant"), 0);
      assert.equal(await scalarCount(fixture.db, "DonorProductVariantDecision"), 0);
      assert.equal(await scalarCount(fixture.db, "DonorOfferObservation"), 0);
      assert.equal(await scalarCount(fixture.db, "ProductContentObservation"), 0);
      assert.deepEqual((await fixture.db.execute({
        sql: `SELECT * FROM "DonorProduct" WHERE id=?`,
        args: [target.donorProductId],
      })).rows[0], beforeProduct);
      assert.deepEqual((await fixture.db.execute({
        sql: `SELECT * FROM "DonorOffer" WHERE id=?`,
        args: [target.donorOfferId],
      })).rows[0], beforeOffer);

      const inspection = await inspectProductTruthTargetedWalmartEvidenceRun(
        fixture.db,
        fixture.plan.runId,
      );
      assert.ok(inspection.run);
      assert.equal(inspection.run.status, "ambiguous");
      assert.equal(inspection.run.leaseOwner, null);
      assert.equal(inspection.run.leaseToken, null);
      assert.equal(inspection.run.leaseExpiresAt, null);
      assert.equal(inspection.job?.status, "error");
      assert.equal(inspection.job?.leaseOwner, null);
      assert.equal(inspection.job?.leaseToken, null);
      assert.equal(inspection.job?.leaseExpiresAt, null);
      assert.equal(fixture.reports.at(-1)?.outcome, "AMBIGUOUS");
      assert.equal(fixture.reports.at(-1)?.candidate, null);
    } finally {
      await fixture.db.close();
    }
  });

  test("production detail adapter commits the exact guarded execution timestamp", async () => {
    const fixture = await createFixture({ runId: "targeted-production-detail-timestamp" });
    const previousFetch = globalThis.fetch;
    const previousUnwrangleKey = process.env.UNWRANGLE_API_KEY;
    try {
      process.env.UNWRANGLE_API_KEY = "test-unwrangle-key";
      globalThis.fetch = (async (request: string | URL | Request) => {
        assert.match(String(request), /^https:\/\/data\.unwrangle\.com\/api\/getter\//);
        fixture.counters.unwrangle += 1;
        return new Response(JSON.stringify(exactUnwrangleDetailPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      fixture.adapter.harvest = (innerDb, harvestInput) => executeDonorHarvestCandidate({
        ...harvestInput,
        db: innerDb,
        allowOpenFoodFactsSupplement: false,
        requireBaseUnit: true,
        upcConflictPolicy: "block",
        harvestDetail: harvestDonorDetail,
      });

      const result = await executeProductTruthTargetedWalmartEvidence(
        fixture.db,
        executionInput(fixture, "execute"),
      );
      assert.equal(result.status, "completed", result.reason);
      assert.deepEqual(fixture.counters, { oxylabs: 1, unwrangle: 1 });
      const exactContent = (await fixture.db.execute({
        sql: `SELECT observedAt,createdAt FROM "ProductContentObservation"
              WHERE donorProductId=? AND json_extract(contentJson,'$._capture')='exact_complete_v1'`,
        args: [fixture.plan.targets[0].donorProductId],
      })).rows;
      assert.equal(exactContent.length, 1);
      assert.equal(exactContent[0]?.observedAt, fixture.initialAt);
      assert.equal(exactContent[0]?.createdAt, fixture.initialAt);
      assert.equal((await fixture.db.execute({
        sql: `SELECT updatedAt FROM "DonorProduct" WHERE id=?`,
        args: [fixture.plan.targets[0].donorProductId],
      })).rows[0]?.updatedAt, fixture.initialAt);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousUnwrangleKey === undefined) delete process.env.UNWRANGLE_API_KEY;
      else process.env.UNWRANGLE_API_KEY = previousUnwrangleKey;
      await fixture.db.close();
    }
  });

  test("production detail adapter uses the guarded timestamp and rollback blocks exact content", async () => {
    const fixture = await createFixture({ runId: "targeted-production-detail-clock" });
    const previousFetch = globalThis.fetch;
    const previousUnwrangleKey = process.env.UNWRANGLE_API_KEY;
    let detailResponseReturned = false;
    let productAfterSearch: Record<string, unknown> | null = null;
    try {
      process.env.UNWRANGLE_API_KEY = "test-unwrangle-key";
      globalThis.fetch = (async (request: string | URL | Request) => {
        const url = String(request);
        assert.match(url, /^https:\/\/data\.unwrangle\.com\/api\/getter\//);
        detailResponseReturned = true;
        fixture.counters.unwrangle += 1;
        return new Response(JSON.stringify(exactUnwrangleDetailPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      const persistOffer = fixture.adapter.persistOffer;
      fixture.adapter.persistOffer = async (...args) => {
        const persisted = await persistOffer(...args);
        productAfterSearch = (await fixture.db.execute({
          sql: `SELECT * FROM "DonorProduct" WHERE id=?`,
          args: [fixture.plan.targets[0].donorProductId],
        })).rows[0] as Record<string, unknown>;
        return persisted;
      };
      fixture.adapter.harvest = (innerDb, harvestInput) => executeDonorHarvestCandidate({
        ...harvestInput,
        db: innerDb,
        allowOpenFoodFactsSupplement: false,
        requireBaseUnit: true,
        upcConflictPolicy: "block",
        harvestDetail: harvestDonorDetail,
      });

      const result = await executeProductTruthTargetedWalmartEvidence(
        fixture.db,
        executionInput(fixture, "execute", {
          now: () => detailResponseReturned
            ? plusMilliseconds(fixture.initialAt, -1_000)
            : fixture.initialAt,
        }),
      );
      assert.equal(result.status, "ambiguous");
      assert.equal(result.outcome, "AMBIGUOUS");
      assert.deepEqual(fixture.counters, { oxylabs: 1, unwrangle: 1 });
      assert.ok(productAfterSearch);
      assert.deepEqual((await fixture.db.execute({
        sql: `SELECT * FROM "DonorProduct" WHERE id=?`,
        args: [fixture.plan.targets[0].donorProductId],
      })).rows[0], productAfterSearch);
      assert.equal(Number((await fixture.db.execute({
        sql: `SELECT COUNT(*) AS n FROM "ProductContentObservation"
              WHERE donorProductId=? AND json_extract(contentJson,'$._capture')='exact_complete_v1'`,
        args: [fixture.plan.targets[0].donorProductId],
      })).rows[0]?.n), 0);
      const inspection = await inspectProductTruthTargetedWalmartEvidenceRun(
        fixture.db,
        fixture.plan.runId,
      );
      assert.deepEqual(
        inspection.ledger.receipts.map((receipt) => [receipt.provider, receipt.status]),
        [["oxylabs", "succeeded"], ["unwrangle", "succeeded"]],
      );
      const harvestState = (await fixture.db.execute({
        sql: `SELECT status,leaseOwner,leaseToken,leaseExpiresAt
              FROM "DonorHarvestState" WHERE donorProductId=?`,
        args: [fixture.plan.targets[0].donorProductId],
      })).rows[0];
      assert.equal(harvestState?.status, "error");
      assert.equal(harvestState?.leaseOwner, null);
      assert.equal(harvestState?.leaseToken, null);
      assert.equal(harvestState?.leaseExpiresAt, null);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousUnwrangleKey === undefined) delete process.env.UNWRANGLE_API_KEY;
      else process.env.UNWRANGLE_API_KEY = previousUnwrangleKey;
      await fixture.db.close();
    }
  });

  test("near-expiry monotonic budget stops before provider I/O even when wall time is static", async () => {
    const initialAt = new Date().toISOString();
    const fixture = await createFixture({
      runId: "targeted-near-expiry-monotonic",
      initialAt,
      planExpiresAt: plusMilliseconds(initialAt, 10_000),
    });
    try {
      let monotonicReads = 0;
      const result = await executeProductTruthTargetedWalmartEvidence(
        fixture.db,
        executionInput(fixture, "execute", {
          now: () => initialAt,
          monotonicNow: () => {
            monotonicReads += 1;
            return monotonicReads >= 4 ? 10_000 : 0;
          },
        }),
      );
      assert.equal(result.status, "interrupted");
      assert.equal(result.outcome, "INTERRUPTED");
      assert.equal(result.reason, "TARGETED_EVIDENCE_WALL_CLOCK_EXHAUSTED_SAFE_TO_RESUME");
      assert.deepEqual(fixture.counters, { oxylabs: 0, unwrangle: 0 });
      assert.equal(await scalarCount(fixture.db, "MeteredReservationReceipt"), 0);
      const inspection = await inspectProductTruthTargetedWalmartEvidenceRun(
        fixture.db,
        fixture.plan.runId,
      );
      assert.ok(inspection.run);
      assert.equal(inspection.run.status, "interrupted");
      assert.equal(inspection.run.leaseOwner, null);
      assert.equal(inspection.run.leaseToken, null);
      assert.equal(inspection.job, null);
    } finally {
      await fixture.db.close();
    }
  });
});
