import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { after, test } from "node:test";

import {
  createClient,
  type Client,
  type InStatement,
  type Transaction,
} from "@libsql/client";

import type { CostResult } from "../cogs-engine";
import type {
  ProductTruthDonorContentInspection,
  ProductTruthDonorHarvestOutcome,
} from "../product-truth-operational-domain";
import {
  PHASE1_SCOPE_DISPOSITION_VERSION,
  buildPhase1ScopeManifest,
  parsePhase1DelimitedText,
  renderPhase1ScopeManifestJson,
  sha256Hex,
  type Phase1ScopeManifest,
} from "../phase1-scope-manifest";
import { makeTestConnectedStoreCensus } from "./phase1-connected-store-census-fixture";
import {
  PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION,
  buildProductTruthOperationalPlan,
  expectedProductTruthExecutionConfirmation,
  productTruthOperationalSha256,
  validateProductTruthOperationalApproval,
  type ProductTruthOperationalApproval,
  type ProductTruthOperationalPlan,
  type ProductTruthOperationalTarget,
  type ValidatedProductTruthOperationalApproval,
} from "../product-truth-operational-run-contract";
import {
  ProductTruthOperationalRunnerError,
  executeProductTruthOperationalRun,
  type ProductTruthOperationalExecutionAdapter,
  type ProductTruthOperationalReport,
} from "../product-truth-operational-runner";
import type { ProductTruthSnapshot } from "../product-truth-read-contract";
import { PRODUCT_TRUTH_READ_CONTRACT_VERSION } from "../product-truth-read-contract-version";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../canonical-product-match-provenance";

const BASE_MS = Date.now();
const CENSUS_CAPTURED_AT = new Date(BASE_MS - 3 * 60_000).toISOString();
const CENSUS_ATTESTED_AT = new Date(BASE_MS - 2 * 60_000).toISOString();
const CREATED_AT = new Date(BASE_MS - 60_000).toISOString();
const NOW = new Date(BASE_MS).toISOString();
const EXPIRES_AT = new Date(BASE_MS + 60 * 60_000).toISOString();
const DATABASE_PATH = `/private/tmp/product-truth-operational-runner-adversarial-${process.pid}.db`;
const DATABASE_URL = `file:${DATABASE_PATH}`;
const TARGET_FINGERPRINT = "a".repeat(64);
const ARTIFACT_INDEX_SHA = "b".repeat(64);

after(async () => {
  await Promise.all(
    [DATABASE_PATH, `${DATABASE_PATH}-shm`, `${DATABASE_PATH}-wal`].map(async (path) => {
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }),
  );
});

const meteredMigrationUrl = new URL(
  "../../../../prisma/migrations/20260719000000_metered_budget_ledger/migration.sql",
  import.meta.url,
);
const queueMigrationUrl = new URL(
  "../../../../prisma/migrations/20260719003000_product_truth_queue_listing_scope/migration.sql",
  import.meta.url,
);
const operationalMigrationUrl = new URL(
  "../../../../prisma/migrations/20260719004000_product_truth_operational_run/migration.sql",
  import.meta.url,
);

function walmartReport(skus: readonly string[]): string {
  return [
    "SKU,Item ID,Product Name,Published Status,Lifecycle Status",
    ...skus.map((sku, index) => `${sku},${10_000 + index},Acme ${index + 1},Published,Active`),
  ].join("\n");
}

function authoritativeManifest(skus: readonly string[]): Phase1ScopeManifest {
  const content = walmartReport(skus);
  const amazonContent = [
    "item-name\tseller-sku\tasin1\tstatus\tfulfillment-channel",
    "Manifest coverage fixture\tAMAZON-MANIFEST-ONLY\tB000000001\tActive\tDEFAULT",
  ].join("\n");
  const manifest = buildPhase1ScopeManifest({
    asOf: CREATED_AT,
    connectedStoreCensus: makeTestConnectedStoreCensus({
      asOf: CREATED_AT,
      capturedAt: CENSUS_CAPTURED_AT,
      attestedAt: CENSUS_ATTESTED_AT,
      identityStyle: "index",
    }),
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [{
        channel: "amazon",
        scopeKey: "store1",
        storeIndex: 1,
        accountId: "amazon-account-1",
        storeId: "amazon-store-1",
        marketplaceId: "ATVPDKIKX0DER",
        disposition: "IN_SCOPE",
        decision: {
          authority: "OWNER",
          decisionId: `runner-test-amazon-decision-${skus.join("-")}`,
          decidedBy: "Vladimir",
          decidedAt: CREATED_AT,
          reason: "Offline operational runner adversarial fixture",
        },
        report: {
          reportType: "GET_MERCHANT_LISTINGS_ALL_DATA",
          reportId: `runner-test-amazon-report-${skus.join("-")}`,
          capturedAt: CREATED_AT,
          expectedRowCount: parsePhase1DelimitedText(amazonContent).rows.length,
          expectedContentSha256: sha256Hex(amazonContent),
        },
      }, {
        channel: "walmart",
        scopeKey: "store1",
        storeIndex: 1,
        accountId: "walmart-account-1",
        storeId: "walmart-store-1",
        marketplaceId: null,
        disposition: "IN_SCOPE",
        decision: {
          authority: "OWNER",
          decisionId: `runner-test-decision-${skus.join("-")}`,
          decidedBy: "Vladimir",
          decidedAt: CREATED_AT,
          reason: "Offline operational runner adversarial fixture",
        },
        report: {
          reportType: "ITEM_CATALOG",
          reportId: `runner-test-report-${skus.join("-")}`,
          capturedAt: CREATED_AT,
          expectedRowCount: parsePhase1DelimitedText(content).rows.length,
          expectedContentSha256: sha256Hex(content),
        },
      }],
    },
    reports: [{
      channel: "amazon",
      scopeKey: "store1",
      sourceName: "amazon-listings.tsv",
      content: amazonContent,
    }, {
      channel: "walmart",
      scopeKey: "store1",
      sourceName: "walmart-item-catalog.csv",
      content,
    }],
  });
  assert.equal(manifest.authoritative, true, JSON.stringify(manifest.blockers));
  return manifest;
}

function plan(runId: string, skus: readonly string[]): ProductTruthOperationalPlan {
  const manifest = authoritativeManifest(skus);
  return buildProductTruthOperationalPlan({
    runId,
    mode: "WAVE",
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    targetFingerprint: TARGET_FINGERPRINT,
    manifest,
    manifestSha256: sha256Hex(renderPhase1ScopeManifestJson(manifest)),
    listingKeys: manifest.listings
      .filter((listing) => listing.channel === "walmart")
      .map((listing) => listing.listingKey),
    sourcePolicy: {
      procurementZip: "33765",
      retailers: ["walmart", "target", "publix"],
      allowClubs: false,
      allowBjs: false,
      listingConcurrency: 1,
      componentConcurrency: 1,
      maxAttemptsPerListing: 1,
    },
    providerCeilings: [{
      provider: "oxylabs",
      operations: ["query"],
      maxCalls: 10,
      maxUnits: 10,
      reserveFloor: null,
    }, {
      provider: "unwrangle",
      operations: ["detail", "search"],
      maxCalls: 20,
      maxUnits: 40,
      reserveFloor: 1_000,
    }],
    verificationPolicy: {
      maxPriceAgeMs: 24 * 60 * 60_000,
      minGalleryImages: 5,
    },
    maxWallClockMs: 30 * 60_000,
  });
}

function validatedApproval(
  value: ProductTruthOperationalPlan,
): ValidatedProductTruthOperationalApproval {
  const planSha256 = productTruthOperationalSha256(value);
  const approvalId = `approval-${value.runId}`;
  const approval: ProductTruthOperationalApproval = {
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION,
    approvedBy: "owner",
    runId: value.runId,
    approvalId,
    action: "EXECUTE_WAVE",
    planSha256,
    targetFingerprint: value.targetFingerprint,
    issuedAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    meteredPermit: {
      version: 1,
      runId: value.runId,
      approvalId,
      approvedBy: "owner",
      issuedAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      providers: {
        oxylabs: { operations: ["query"], maxCalls: 10, maxUnits: 10 },
        unwrangle: { operations: ["detail", "search"], maxCalls: 20, maxUnits: 40 },
      },
    },
    balanceEvidence: [{
      provider: "unwrangle",
      observedAt: NOW,
      balanceUnits: 2_000,
      reserveFloor: 1_000,
      evidenceSha256: "c".repeat(64),
    }],
  };
  return validateProductTruthOperationalApproval({
    plan: value,
    planSha256,
    approval,
    executionConfirmation: expectedProductTruthExecutionConfirmation(planSha256, approvalId),
    now: NOW,
  });
}

async function migratedDb(): Promise<Client> {
  const db = createClient({ url: DATABASE_URL, concurrency: 1 });
  await db.execute("PRAGMA foreign_keys=OFF");
  await db.executeMultiple(`
    DROP TABLE IF EXISTS "ProductTruthOperationalEvent";
    DROP TABLE IF EXISTS "ProductTruthOperationalRunItem";
    DROP TABLE IF EXISTS "ProductTruthOperationalRun";
    DROP TABLE IF EXISTS "EnrichmentJob";
    DROP TABLE IF EXISTS "ProductTruthListingScope";
    DROP TABLE IF EXISTS "MeteredReservationSettlement";
    DROP TABLE IF EXISTS "MeteredReservationReceipt";
    DROP TABLE IF EXISTS "MeteredProviderBudget";

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
      "updatedAt" DATETIME
    );
  `);
  await db.execute("PRAGMA foreign_keys=ON");
  await db.executeMultiple(await readFile(meteredMigrationUrl, "utf8"));
  await db.executeMultiple(await readFile(queueMigrationUrl, "utf8"));
  await db.executeMultiple(await readFile(operationalMigrationUrl, "utf8"));
  return db;
}

async function registerScope(db: Client, value: ProductTruthOperationalPlan): Promise<void> {
  for (const target of value.targets) {
    await db.execute({
      sql: `INSERT INTO "ProductTruthListingScope"
            ("listingKey","keyVersion","channel","storeIndex","sku","manifestSha256")
            VALUES (?,?,?,?,?,?)`,
      args: [
        target.listingKey,
        target.listingKeyVersion,
        target.channel,
        target.storeIndex,
        target.sku,
        value.manifest.sha256,
      ],
    });
  }
}

function snapshot(target: ProductTruthOperationalTarget): ProductTruthSnapshot {
  const donorProductId = `donor-${target.sku}`;
  const content = {
    canonicalVariantId: `variant-${target.sku}`,
    identity: {
      variantKey: `variant-key-${target.sku}`,
      identityHash: "d".repeat(64),
      keyVersion: "canonical-product-variant/v1" as const,
      brand: "Acme",
      productLine: "Snack",
      flavor: "Original",
      modifiers: [],
      form: "box",
      sizeDimension: "COUNT" as const,
      sizeBaseAmount: 1,
      sizeBaseUnit: "count" as const,
      outerPackCount: 1,
      identity: {},
    },
    facts: {
      title: `Acme ${target.sku}`,
      description: "Exact product description",
      bullets: ["Exact product"],
      attributes: { flavor: "Original" },
      nutritionFacts: { calories: 100 },
      ingredients: "Food",
      mainImageUrl: `https://example.com/${target.sku}/main.jpg`,
      imageUrls: Array.from(
        { length: 5 },
        (_, index) => `https://example.com/${target.sku}/${index}.jpg`,
      ),
    },
    provenance: {
      contentObservationId: `content-${target.sku}`,
      observationKey: "e".repeat(64),
      donorProductId,
      variantDecisionId: `decision-${target.sku}`,
      matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
      matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      decisionEvidenceHash: "f".repeat(64),
      contentHash: "1".repeat(64),
      fieldHashes: {},
      sourceUrl: `https://walmart.com/ip/${target.sku}`,
      sourceApi: "unwrangle",
      observedAt: NOW,
      runId: "prior-run",
      approvalId: "prior-approval",
      meteredReceiptId: "prior-receipt",
    },
  };
  return {
    contractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    snapshot: {
      sku: target.sku,
      channel: target.channel,
      storeIndex: target.storeIndex,
      listingKey: target.listingKey,
      asOf: NOW,
      maxPriceAgeMs: 24 * 60 * 60_000,
      skuCostId: `cost-${target.sku}`,
    },
    recipe: {
      blockers: [],
      components: [{
        componentEvidenceId: `component-${target.sku}`,
        componentIndex: 0,
        product: `Acme ${target.sku}`,
        flavor: "Original",
        size: "1 count",
        qty: 1,
        targetCanonicalVariantId: `variant-${target.sku}`,
        evidenceStatus: "FACT",
        content,
        contentBlockers: [],
      }],
    },
    views: {
      bundleFactory: {
        consumer: "BUNDLE_FACTORY",
        ready: true,
        components: [],
        blockers: [],
      },
      listingImprovement: {
        consumer: "LISTING_IMPROVEMENT",
        ready: true,
        components: [],
        blockers: [],
      },
      unitEconomics: {
        consumer: "UNIT_ECONOMICS",
        status: "FACT",
        current: null,
        factualCost: null,
        estimatedCost: null,
        blockers: [],
      },
      procurement: {
        consumer: "PROCUREMENT",
        ready: true,
        blockers: [],
        components: [{
          componentIndex: 0,
          product: `Acme ${target.sku}`,
          requiredQuantity: 1,
          factualOptions: [{ rank: 1 }] as never[],
          estimateOptions: [],
          manualCost: null,
          blockers: [],
        }],
      },
    },
  };
}

function inspection(
  target: ProductTruthOperationalTarget,
  complete: boolean,
): ProductTruthDonorContentInspection {
  const donorProductId = `donor-${target.sku}`;
  return {
    donorProductId,
    fullContentComplete: complete,
    missingFields: complete ? [] : ["nutrition"],
    plan: {
      donorProductId,
      disposition: complete ? "already_complete" : "terminal_source_unavailable",
      completedFields: complete
        ? ["attributes", "bullets", "description", "gallery", "ingredients", "nutrition", "title", "upc"]
        : ["attributes", "bullets", "description", "gallery", "ingredients", "title", "upc"],
      requestedFields: complete ? [] : ["nutrition"],
      source: null,
      retailer: null,
      retailerProductId: null,
      productUrl: null,
      targetOnly: false,
      terminalReason: complete ? null : "NO_DIRECT_FIRST_PARTY_DETAIL_SOURCE",
      maxAttempts: 1,
      estimatedCallsFirstAttempt: 0,
      estimatedUnitsFirstAttempt: 0,
      maximumCallsAtAttemptCap: 0,
      maximumUnitsAtAttemptCap: 0,
    },
  };
}

function costResult(target: ProductTruthOperationalTarget): CostResult {
  return {
    sku: target.sku,
    status: "costed",
    total: 4.99,
    perUnit: 4.99,
    packSize: 1,
    needsReview: false,
    methods: ["exact"],
    logs: ["offline fake adapter"],
  };
}

function successfulArtifactWriter(report: ProductTruthOperationalReport) {
  return Promise.resolve({
    reportSha256: productTruthOperationalSha256(report),
    artifactIndexSha256: ARTIFACT_INDEX_SHA,
  });
}

async function execute(
  db: Client,
  value: ProductTruthOperationalPlan,
  adapter: ProductTruthOperationalExecutionAdapter,
  artifactWriter = successfulArtifactWriter,
  command: "execute" | "resume" = "execute",
  now: () => string = () => NOW,
) {
  return executeProductTruthOperationalRun(db, {
    plan: value,
    validatedApproval: validatedApproval(value),
    environment: "local-test",
    command,
    leaseOwner: "offline-runner-adversarial-test",
    meteredDatabase: {
      url: DATABASE_URL,
      targetFingerprint: value.targetFingerprint,
    },
    artifactWriter,
    adapter,
    now,
    heartbeatIntervalMs: 10,
  });
}

/** Simulate a remote commit whose durable success response was lost in transit. */
function commitUnknownWhen(
  db: Client,
  matchesTransactionSql: (sql: string) => boolean,
): {
  client: Client;
  wasInjected: () => boolean;
} {
  let injected = false;
  const client = new Proxy(db, {
    get(target, property) {
      if (property !== "transaction") {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: Parameters<Client["transaction"]>): Promise<Transaction> => {
        const transaction = await target.transaction(...args);
        let targetTransaction = false;
        return new Proxy(transaction, {
          get(transactionTarget, transactionProperty) {
            if (transactionProperty === "execute") {
              return async (statement: InStatement) => {
                const sql = typeof statement === "string" ? statement : statement.sql;
                if (matchesTransactionSql(sql)) targetTransaction = true;
                return transactionTarget.execute(statement);
              };
            }
            if (transactionProperty === "commit") {
              return async () => {
                const shouldInject = targetTransaction && !injected;
                await transactionTarget.commit();
                if (shouldInject) {
                  injected = true;
                  throw new Error("synthetic commit response lost after durable attempt start");
                }
              };
            }
            const value = Reflect.get(
              transactionTarget,
              transactionProperty,
              transactionTarget,
            ) as unknown;
            return typeof value === "function" ? value.bind(transactionTarget) : value;
          },
        });
      };
    },
  });
  return { client, wasInjected: () => injected };
}

function commitUnknownAtAttemptBoundary(db: Client) {
  return commitUnknownWhen(
    db,
    (sql) => sql.includes(`SET "status"='running', "attempts"=1`),
  );
}

function commitUnknownAfterAttemptTerminalization(db: Client) {
  return commitUnknownWhen(
    db,
    (sql) => sql.includes(`SET "status"=?, "finishedAt"=?, "result"=?`)
      && sql.includes(`"actualSpendUnits"=?`)
      && sql.includes(`AND "status"='running' AND "attempts"=1`),
  );
}

test("fully reusable truth completes with zero attempts and no queue row", async () => {
  const db = await migratedDb();
  try {
    const value = plan("runner-reuse-a", ["REUSE-SKU"]);
    await registerScope(db, value);
    let costCalls = 0;
    let harvestCalls = 0;
    const adapter: ProductTruthOperationalExecutionAdapter = {
      async cost() {
        costCalls += 1;
        throw new Error("reusable truth must not cross the attempt boundary");
      },
      async readSnapshot(_db, { target }) {
        return snapshot(target);
      },
      async inspectDonors(_db, { snapshot: current }) {
        const target = value.targets.find((candidate) => candidate.listingKey === current.snapshot.listingKey);
        assert.ok(target);
        return [inspection(target, true)];
      },
      async harvestDonors() {
        harvestCalls += 1;
        return [];
      },
    };

    const result = await execute(db, value, adapter);
    assert.equal(result.status, "completed");
    assert.equal(result.report.outcome, "COMPLETED");
    assert.equal(costCalls, 0);
    assert.equal(harvestCalls, 0);

    const item = await db.execute(
      `SELECT "status","attempts","queueJobId","resultJson"
       FROM "ProductTruthOperationalRunItem" WHERE "runId"='runner-reuse-a'`,
    );
    assert.equal(item.rows[0]?.status, "done");
    assert.equal(Number(item.rows[0]?.attempts), 0);
    assert.equal(item.rows[0]?.queueJobId, null);
    assert.equal(JSON.parse(String(item.rows[0]?.resultJson)).reused, true);
    const queueCount = await db.execute(`SELECT COUNT(*) AS n FROM "EnrichmentJob"`);
    assert.equal(Number(queueCount.rows[0]?.n), 0);
  } finally {
    await db.close();
  }
});

test("incomplete targets execute sequentially and atomically close exactly one attempt each", async () => {
  const db = await migratedDb();
  try {
    const value = plan("runner-attempt-a", ["GAP-SKU-1", "GAP-SKU-2"]);
    await registerScope(db, value);
    let activeCosts = 0;
    let maximumActiveCosts = 0;
    let costCalls = 0;
    let harvestCalls = 0;
    const adapter: ProductTruthOperationalExecutionAdapter = {
      async cost(_db, { target }) {
        costCalls += 1;
        activeCosts += 1;
        maximumActiveCosts = Math.max(maximumActiveCosts, activeCosts);
        try {
          await new Promise<void>((resolve) => setImmediate(resolve));
          return costResult(target);
        } finally {
          activeCosts -= 1;
        }
      },
      async readSnapshot(_db, { target }) {
        return snapshot(target);
      },
      async inspectDonors(_db, { snapshot: current, cost }) {
        const target = value.targets.find((candidate) => candidate.listingKey === current.snapshot.listingKey);
        assert.ok(target);
        return [inspection(target, cost !== null)];
      },
      async harvestDonors(): Promise<ProductTruthDonorHarvestOutcome[]> {
        harvestCalls += 1;
        return [];
      },
    };

    const result = await execute(db, value, adapter);
    assert.equal(result.status, "completed");
    assert.equal(result.report.outcome, "COMPLETED");
    assert.equal(costCalls, 2);
    assert.equal(harvestCalls, 2);
    assert.equal(maximumActiveCosts, 1);

    const terminal = await db.execute(
      `SELECT item."listingKey", item."status" AS itemStatus,
              item."attempts" AS itemAttempts, item."leaseToken" AS itemLease,
              job."status" AS queueStatus, job."attempts" AS queueAttempts,
              job."leaseToken" AS queueLease
       FROM "ProductTruthOperationalRunItem" item
       JOIN "EnrichmentJob" job ON job."id"=item."queueJobId"
       WHERE item."runId"='runner-attempt-a'
       ORDER BY item."ordinal"`,
    );
    assert.equal(terminal.rows.length, 2);
    for (const row of terminal.rows) {
      assert.equal(row.itemStatus, "done");
      assert.equal(Number(row.itemAttempts), 1);
      assert.equal(row.itemLease, null);
      assert.equal(row.queueStatus, "done");
      assert.equal(Number(row.queueAttempts), 1);
      assert.equal(row.queueLease, null);
    }
  } finally {
    await db.close();
  }
});

test("an adapter failure after attempt terminalizes failed/error and cannot replay", async () => {
  const db = await migratedDb();
  try {
    const value = plan("runner-failure-a", ["FAIL-SKU"]);
    await registerScope(db, value);
    let costCalls = 0;
    const adapter: ProductTruthOperationalExecutionAdapter = {
      async cost() {
        costCalls += 1;
        throw new Error("synthetic post-attempt adapter failure");
      },
      async readSnapshot(_db, { target }) {
        return snapshot(target);
      },
      async inspectDonors(_db, { snapshot: current }) {
        const target = value.targets.find((candidate) => candidate.listingKey === current.snapshot.listingKey);
        assert.ok(target);
        return [inspection(target, false)];
      },
      async harvestDonors() {
        throw new Error("harvest must not run after costing failure");
      },
    };

    const result = await execute(db, value, adapter);
    assert.equal(result.status, "failed");
    assert.equal(result.report.outcome, "FAILED");
    assert.equal(costCalls, 1);
    const terminal = await db.execute(
      `SELECT item."status" AS itemStatus, item."attempts" AS itemAttempts,
              item."leaseToken" AS itemLease, job."status" AS queueStatus,
              job."attempts" AS queueAttempts, job."leaseToken" AS queueLease
       FROM "ProductTruthOperationalRunItem" item
       JOIN "EnrichmentJob" job ON job."id"=item."queueJobId"
       WHERE item."runId"='runner-failure-a'`,
    );
    assert.equal(terminal.rows[0]?.itemStatus, "failed");
    assert.equal(Number(terminal.rows[0]?.itemAttempts), 1);
    assert.equal(terminal.rows[0]?.itemLease, null);
    assert.equal(terminal.rows[0]?.queueStatus, "error");
    assert.equal(Number(terminal.rows[0]?.queueAttempts), 1);
    assert.equal(terminal.rows[0]?.queueLease, null);

    await assert.rejects(
      execute(db, value, adapter),
      (error: unknown) => error instanceof ProductTruthOperationalRunnerError
        && error.code === "OPERATIONAL_EXECUTE_STATE_INVALID",
    );
    assert.equal(costCalls, 1);
  } finally {
    await db.close();
  }
});

test("artifact writer must return the exact canonical report hash before run finalization", async () => {
  const db = await migratedDb();
  try {
    const value = plan("runner-artifact-a", ["ARTIFACT-SKU"]);
    await registerScope(db, value);
    const adapter: ProductTruthOperationalExecutionAdapter = {
      async cost() {
        throw new Error("reusable fixture must not cost");
      },
      async readSnapshot(_db, { target }) {
        return snapshot(target);
      },
      async inspectDonors(_db, { snapshot: current }) {
        const target = value.targets.find((candidate) => candidate.listingKey === current.snapshot.listingKey);
        assert.ok(target);
        return [inspection(target, true)];
      },
      async harvestDonors() {
        return [];
      },
    };

    await assert.rejects(
      execute(db, value, adapter, async () => ({
        reportSha256: "0".repeat(64),
        artifactIndexSha256: ARTIFACT_INDEX_SHA,
      })),
      (error: unknown) => error instanceof ProductTruthOperationalRunnerError
        && error.code === "OPERATIONAL_ARTIFACT_HASH_INVALID",
    );
    const run = await db.execute(
      `SELECT "status","reportSha256","artifactIndexSha256"
       FROM "ProductTruthOperationalRun" WHERE "runId"='runner-artifact-a'`,
    );
    assert.equal(run.rows[0]?.status, "running");
    assert.equal(run.rows[0]?.reportSha256, null);
    assert.equal(run.rows[0]?.artifactIndexSha256, null);
  } finally {
    await db.close();
  }
});

test("resume after a post-terminal pre-report crash only finalizes and never spends again", async () => {
  const db = await migratedDb();
  try {
    const value = plan("runner-report-recovery-a", ["REPORT-RECOVERY-SKU"]);
    await registerScope(db, value);
    let clockMs = BASE_MS;
    let costCalls = 0;
    let harvestCalls = 0;
    const adapter: ProductTruthOperationalExecutionAdapter = {
      async cost(_db, { target }) {
        costCalls += 1;
        return costResult(target);
      },
      async readSnapshot(_db, { target }) {
        return snapshot(target);
      },
      async inspectDonors(_db, { snapshot: current, cost }) {
        const target = value.targets.find((candidate) => candidate.listingKey === current.snapshot.listingKey);
        assert.ok(target);
        return [inspection(target, cost !== null)];
      },
      async harvestDonors() {
        harvestCalls += 1;
        return [];
      },
    };

    await assert.rejects(
      execute(
        db,
        value,
        adapter,
        async () => {
          throw new Error("synthetic crash after terminal item before report persistence");
        },
        "execute",
        () => new Date(clockMs).toISOString(),
      ),
      /synthetic crash after terminal item/,
    );
    assert.equal(costCalls, 1);
    assert.equal(harvestCalls, 1);

    clockMs += 5 * 60_000;
    const resumed = await execute(
      db,
      value,
      adapter,
      successfulArtifactWriter,
      "resume",
      () => new Date(clockMs).toISOString(),
    );
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.report.outcome, "COMPLETED");
    assert.equal(costCalls, 1);
    assert.equal(harvestCalls, 1);
    const terminal = await db.execute(
      `SELECT item."status" AS itemStatus, item."attempts" AS itemAttempts,
              job."status" AS queueStatus, job."attempts" AS queueAttempts
       FROM "ProductTruthOperationalRunItem" item
       JOIN "EnrichmentJob" job ON job."id"=item."queueJobId"
       WHERE item."runId"='runner-report-recovery-a'`,
    );
    assert.equal(terminal.rows[0]?.itemStatus, "done");
    assert.equal(Number(terminal.rows[0]?.itemAttempts), 1);
    assert.equal(terminal.rows[0]?.queueStatus, "done");
    assert.equal(Number(terminal.rows[0]?.queueAttempts), 1);
  } finally {
    await db.close();
  }
});

test("resume after terminal failure and report crash never spends a pending target", async () => {
  const db = await migratedDb();
  try {
    const value = plan("runner-failed-report-recovery-a", ["FAIL-FIRST-SKU", "MUST-STAY-PENDING-SKU"]);
    await registerScope(db, value);
    let clockMs = BASE_MS;
    let costCalls = 0;
    const adapter: ProductTruthOperationalExecutionAdapter = {
      async cost() {
        costCalls += 1;
        throw new Error("synthetic first-target execution failure");
      },
      async readSnapshot(_db, { target }) {
        return snapshot(target);
      },
      async inspectDonors(_db, { snapshot: current }) {
        const target = value.targets.find((candidate) => candidate.listingKey === current.snapshot.listingKey);
        assert.ok(target);
        return [inspection(target, false)];
      },
      async harvestDonors() {
        return [];
      },
    };

    await assert.rejects(
      execute(
        db,
        value,
        adapter,
        async () => {
          throw new Error("synthetic crash while persisting failed run report");
        },
        "execute",
        () => new Date(clockMs).toISOString(),
      ),
      /synthetic crash while persisting failed run report/,
    );
    assert.equal(costCalls, 1);

    clockMs += 5 * 60_000;
    const resumed = await execute(
      db,
      value,
      adapter,
      successfulArtifactWriter,
      "resume",
      () => new Date(clockMs).toISOString(),
    );
    assert.equal(resumed.status, "failed");
    assert.equal(resumed.report.outcome, "FAILED");
    assert.equal(costCalls, 1);
    const items = await db.execute(
      `SELECT "ordinal","status","attempts","queueJobId"
       FROM "ProductTruthOperationalRunItem"
       WHERE "runId"='runner-failed-report-recovery-a'
       ORDER BY "ordinal"`,
    );
    assert.equal(items.rows[0]?.status, "failed");
    assert.equal(Number(items.rows[0]?.attempts), 1);
    assert.ok(items.rows[0]?.queueJobId);
    assert.equal(items.rows[1]?.status, "pending");
    assert.equal(Number(items.rows[1]?.attempts), 0);
    assert.equal(items.rows[1]?.queueJobId, null);
  } finally {
    await db.close();
  }
});

test("commit-unknown at the attempt boundary never reaches the adapter or becomes replayable", async () => {
  const db = await migratedDb();
  try {
    const value = plan("runner-commit-unknown-a", ["COMMIT-UNKNOWN-SKU"]);
    await registerScope(db, value);
    let clockMs = BASE_MS;
    let costCalls = 0;
    const adapter: ProductTruthOperationalExecutionAdapter = {
      async cost(_db, { target }) {
        costCalls += 1;
        return costResult(target);
      },
      async readSnapshot(_db, { target }) {
        return snapshot(target);
      },
      async inspectDonors(_db, { snapshot: current }) {
        const target = value.targets.find((candidate) => candidate.listingKey === current.snapshot.listingKey);
        assert.ok(target);
        return [inspection(target, false)];
      },
      async harvestDonors() {
        return [];
      },
    };
    const uncertain = commitUnknownAtAttemptBoundary(db);

    await assert.rejects(
      execute(
        uncertain.client,
        value,
        adapter,
        successfulArtifactWriter,
        "execute",
        () => new Date(clockMs).toISOString(),
      ),
      (error: unknown) => error instanceof ProductTruthOperationalRunnerError
        && error.code === "OPERATIONAL_RECOVERY_REQUIRED",
    );
    assert.equal(uncertain.wasInjected(), true);
    assert.equal(costCalls, 0);
    const crossed = await db.execute(
      `SELECT run."status" AS runStatus, item."status" AS itemStatus,
              item."attempts" AS itemAttempts, job."status" AS queueStatus,
              job."attempts" AS queueAttempts
       FROM "ProductTruthOperationalRun" run
       JOIN "ProductTruthOperationalRunItem" item ON item."runId"=run."runId"
       JOIN "EnrichmentJob" job ON job."id"=item."queueJobId"
       WHERE run."runId"='runner-commit-unknown-a'`,
    );
    assert.equal(crossed.rows[0]?.runStatus, "running");
    assert.equal(crossed.rows[0]?.itemStatus, "costing");
    assert.equal(Number(crossed.rows[0]?.itemAttempts), 1);
    assert.equal(crossed.rows[0]?.queueStatus, "running");
    assert.equal(Number(crossed.rows[0]?.queueAttempts), 1);

    clockMs += 5 * 60_000;
    await assert.rejects(
      execute(
        db,
        value,
        adapter,
        successfulArtifactWriter,
        "resume",
        () => new Date(clockMs).toISOString(),
      ),
      (error: unknown) => error instanceof ProductTruthOperationalRunnerError
        && error.code === "OPERATIONAL_RESUME_STATE_INVALID",
    );
    assert.equal(costCalls, 0);
    const quarantined = await db.execute(
      `SELECT run."status" AS runStatus, item."status" AS itemStatus,
              job."status" AS queueStatus, job."attempts" AS queueAttempts
       FROM "ProductTruthOperationalRun" run
       JOIN "ProductTruthOperationalRunItem" item ON item."runId"=run."runId"
       JOIN "EnrichmentJob" job ON job."id"=item."queueJobId"
       WHERE run."runId"='runner-commit-unknown-a'`,
    );
    assert.equal(quarantined.rows[0]?.runStatus, "ambiguous");
    assert.equal(quarantined.rows[0]?.itemStatus, "ambiguous");
    assert.equal(quarantined.rows[0]?.queueStatus, "error");
    assert.equal(Number(quarantined.rows[0]?.queueAttempts), 1);
  } finally {
    await db.close();
  }
});

test("terminalization commit-unknown honors durable success instead of downgrading it", async () => {
  const db = await migratedDb();
  try {
    const value = plan("runner-terminal-commit-unknown-a", ["TERMINAL-COMMIT-UNKNOWN-SKU"]);
    await registerScope(db, value);
    let costCalls = 0;
    let activeCosts = 0;
    let maximumActiveCosts = 0;
    const adapter: ProductTruthOperationalExecutionAdapter = {
      async cost(_db, { target }) {
        costCalls += 1;
        activeCosts += 1;
        maximumActiveCosts = Math.max(maximumActiveCosts, activeCosts);
        try {
          return costResult(target);
        } finally {
          activeCosts -= 1;
        }
      },
      async readSnapshot(_db, { target }) {
        return snapshot(target);
      },
      async inspectDonors(_db, { snapshot: current, cost }) {
        const target = value.targets.find((candidate) => candidate.listingKey === current.snapshot.listingKey);
        assert.ok(target);
        return [inspection(target, cost !== null)];
      },
      async harvestDonors() {
        return [];
      },
    };
    const uncertain = commitUnknownAfterAttemptTerminalization(db);

    const result = await execute(uncertain.client, value, adapter);
    assert.equal(uncertain.wasInjected(), true);
    assert.equal(result.status, "completed");
    assert.equal(result.report.outcome, "COMPLETED");
    assert.equal(costCalls, 1);
    assert.equal(maximumActiveCosts, 1);
    const durable = await db.execute(
      `SELECT item."status" AS itemStatus, item."attempts" AS itemAttempts,
              job."status" AS queueStatus, job."attempts" AS queueAttempts,
              run."status" AS runStatus
       FROM "ProductTruthOperationalRunItem" item
       JOIN "ProductTruthOperationalRun" run ON run."runId"=item."runId"
       JOIN "EnrichmentJob" job ON job."id"=item."queueJobId"
       WHERE item."runId"='runner-terminal-commit-unknown-a'`,
    );
    assert.equal(durable.rows[0]?.itemStatus, "done");
    assert.equal(Number(durable.rows[0]?.itemAttempts), 1);
    assert.equal(durable.rows[0]?.queueStatus, "done");
    assert.equal(Number(durable.rows[0]?.queueAttempts), 1);
    assert.equal(durable.rows[0]?.runStatus, "completed");
  } finally {
    await db.close();
  }
});

test("a live environment owner blocks before seed, while an expired owner is reaped", async () => {
  const db = await migratedDb();
  try {
    const runA = plan("runner-environment-owner-a", ["ENVIRONMENT-OWNER-A"]);
    const runB = plan("runner-environment-owner-b", ["ENVIRONMENT-OWNER-B"]);
    await registerScope(db, runA);
    await registerScope(db, runB);
    let clockMs = BASE_MS;
    let runBAdapterCalls = 0;
    const reusableAdapter = (
      value: ProductTruthOperationalPlan,
      onRead?: () => void,
    ): ProductTruthOperationalExecutionAdapter => ({
      async cost() {
        throw new Error("reusable environment-lock fixture must not cost");
      },
      async readSnapshot(_db, { target }) {
        onRead?.();
        return snapshot(target);
      },
      async inspectDonors(_db, { snapshot: current }) {
        const target = value.targets.find((candidate) => candidate.listingKey === current.snapshot.listingKey);
        assert.ok(target);
        return [inspection(target, true)];
      },
      async harvestDonors() {
        return [];
      },
    });

    await assert.rejects(
      execute(
        db,
        runA,
        reusableAdapter(runA),
        async () => {
          throw new Error("synthetic owner A crash before run finalization");
        },
        "execute",
        () => new Date(clockMs).toISOString(),
      ),
      /synthetic owner A crash/,
    );

    await assert.rejects(
      execute(
        db,
        runB,
        reusableAdapter(runB, () => { runBAdapterCalls += 1; }),
        successfulArtifactWriter,
        "execute",
        () => new Date(clockMs).toISOString(),
      ),
      (error: unknown) => error instanceof ProductTruthOperationalRunnerError
        && error.code === "OPERATIONAL_RUN_LOCK_HELD",
    );
    assert.equal(runBAdapterCalls, 0);
    const absent = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM "ProductTruthOperationalRun" WHERE "runId"=?`,
      args: [runB.runId],
    });
    assert.equal(Number(absent.rows[0]?.n), 0);

    clockMs += 5 * 60_000;
    const completedB = await execute(
      db,
      runB,
      reusableAdapter(runB, () => { runBAdapterCalls += 1; }),
      successfulArtifactWriter,
      "execute",
      () => new Date(clockMs).toISOString(),
    );
    assert.equal(completedB.status, "completed");
    assert.equal(runBAdapterCalls, 1);
    const states = await db.execute(
      `SELECT "runId","status" FROM "ProductTruthOperationalRun"
       WHERE "runId" IN ('runner-environment-owner-a','runner-environment-owner-b')
       ORDER BY "runId"`,
    );
    assert.deepEqual(
      states.rows.map((row) => [String(row.runId), String(row.status)]),
      [
        ["runner-environment-owner-a", "interrupted"],
        ["runner-environment-owner-b", "completed"],
      ],
    );
  } finally {
    await db.close();
  }
});
