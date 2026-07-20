import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  ProductTruthBackfillReadinessError,
  planProductTruthBackfillReadiness,
  type ProductTruthMigrationCertification,
} from "../product-truth-backfill-readiness";

const CAPTURED_AT = "2026-07-19T12:00:00.000Z";
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

function disposition(
  channel: Phase1Channel,
  content: string,
): Phase1ScopeDispositionEntry {
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
      reason: "Backfill readiness fixture",
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
  const result = buildPhase1ScopeManifest({
    asOf: CAPTURED_AT,
    connectedStoreCensus: makeTestConnectedStoreCensus({
      asOf: CAPTURED_AT,
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
      {
        channel: "amazon",
        scopeKey: "store1",
        sourceName: "amazon.tsv",
        content: amazonReport,
      },
      {
        channel: "walmart",
        scopeKey: "store1",
        sourceName: "walmart.csv",
        content: walmartReport,
      },
    ],
  });
  assert.equal(result.authoritative, true);
  assert.equal(result.blockers.length, 0);
  return result;
}

function certification(
  overrides: Partial<ProductTruthMigrationCertification> = {},
): ProductTruthMigrationCertification {
  return {
    contractVersion: PRODUCT_TRUTH_MIGRATION_CERTIFICATION_VERSION,
    migrationSetSha256: "2".repeat(64),
    migrationReportSha256: "3".repeat(64),
    schemaFingerprintSha256: "4".repeat(64),
    databaseTargetFingerprint: TARGET_FINGERPRINT,
    allMigrationsApplied: true,
    allReceiptsTracked: true,
    receiptLedgerReady: true,
    ...overrides,
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
}

async function migratedDb(t: TestContext): Promise<Client> {
  const directory = await mkdtemp(join(tmpdir(), "product-truth-backfill-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = createClient({
    url: `file:${join(directory, "product-truth.sqlite")}`,
    concurrency: 1,
  });
  await createBaseSchema(db);
  for (const migrationId of MIGRATION_IDS) {
    const migrationUrl = new URL(
      `../../../../prisma/migrations/${migrationId}/migration.sql`,
      import.meta.url,
    );
    await db.executeMultiple(await readFile(migrationUrl, "utf8"));
  }
  return db;
}

async function buildPlan(db: Client) {
  const scope = manifest();
  const manifestJson = renderPhase1ScopeManifestJson(scope);
  return planProductTruthBackfillReadiness(db, {
    manifest: scope,
    manifestJson,
    expectedManifestSha256: sha256Hex(manifestJson),
    databaseTargetFingerprint: TARGET_FINGERPRINT,
    migrationCertification: certification(),
    capturedAt: CAPTURED_AT,
  });
}

function code(error: unknown): string | undefined {
  return error instanceof ProductTruthBackfillReadinessError
    ? error.code
    : undefined;
}

test("builds a deterministic read-only no-paid plan and reports exact missing work", async (t) => {
  const db = await migratedDb(t);
  try {
    const before = await db.execute("SELECT total_changes() AS count");
    const first = await buildPlan(db);
    const second = await buildPlan(db);
    const after = await db.execute("SELECT total_changes() AS count");

    assert.equal(first.mode, "READ_ONLY_NO_PAID_PLAN");
    assert.equal(first.planSha256, second.planSha256);
    assert.match(first.planSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(first.claims, {
      databaseWrites: false,
      providerCalls: false,
      paidCalls: false,
      marketplaceMutations: false,
      procurementMutations: false,
      legacyTruthPromotion: false,
    });
    assert.equal(first.scopeCoverage.manifestListings, 2);
    assert.equal(first.scopeCoverage.exactRegistryListings, 0);
    assert.deepEqual(first.scopeCoverage.missingRegistryListingKeys, [
      "amazon:1:AMZ-1",
      "walmart:1:WM-1",
    ]);
    assert.deepEqual(first.scopeCoverage.listingsWithoutCanonicalCostOutcome, [
      "amazon:1:AMZ-1",
      "walmart:1:WM-1",
    ]);
    assert.equal(first.readyForOwnerReviewedBackfill, true);
    assert.equal(first.readyForConsumerShadow, false);
    assert.equal(first.stages[2]?.status, "PENDING");
    assert.equal(first.stages[2]?.execution, "SEPARATE_OWNER_REVIEWED_WRITER_REQUIRED");
    assert.equal(after.rows[0]?.count, before.rows[0]?.count);
  } finally {
    await db.close();
  }
});

test("an immutable registry row from a different manifest blocks backfill", async (t) => {
  const db = await migratedDb(t);
  try {
    const scope = manifest();
    const listing = scope.listings[0]!;
    const decision = scope.scopeDispositions.find((item) =>
      item.channel === listing.channel && item.scopeKey === listing.scopeKey);
    await db.execute({
      sql: `INSERT INTO ProductTruthListingScope (
        listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
        manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
        sourceReportId,sourceContentSha256,sourceCapturedAt,createdAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        listing.listingKey,
        "product-truth-listing-key/1.0.0",
        listing.channel,
        listing.storeIndex,
        listing.sku,
        "AUTHORITATIVE_PHASE1_MANIFEST",
        "phase1-authoritative-scope-manifest/v3",
        "9".repeat(64),
        scope.asOf,
        decision?.decisionId ?? "missing-decision",
        listing.sourceReportId,
        listing.sourceContentSha256,
        listing.sourceCapturedAt,
        CAPTURED_AT,
      ],
    });
    const plan = await buildPlan(db);
    assert.deepEqual(plan.scopeCoverage.conflictingRegistryListingKeys, [
      listing.listingKey,
    ]);
    assert.equal(plan.blockers.includes("LISTING_SCOPE_REGISTRY_CONFLICT"), true);
    assert.equal(plan.readyForOwnerReviewedBackfill, false);
    assert.equal(plan.stages[2]?.status, "BLOCKED");
  } finally {
    await db.close();
  }
});

test("migration certification and schema mismatches fail before any backfill claim", async (t) => {
  const db = await migratedDb(t);
  try {
    const scope = manifest();
    const manifestJson = renderPhase1ScopeManifestJson(scope);
    await assert.rejects(
      planProductTruthBackfillReadiness(db, {
        manifest: scope,
        manifestJson,
        expectedManifestSha256: sha256Hex(manifestJson),
        databaseTargetFingerprint: TARGET_FINGERPRINT,
        migrationCertification: certification({
          databaseTargetFingerprint: "8".repeat(64),
        }),
        capturedAt: CAPTURED_AT,
      }),
      (error) => code(error) === "BACKFILL_DATABASE_TARGET_MISMATCH",
    );
  } finally {
    await db.close();
  }

  const absent = createClient({ url: "file::memory:" });
  try {
    const scope = manifest();
    const manifestJson = renderPhase1ScopeManifestJson(scope);
    await assert.rejects(
      planProductTruthBackfillReadiness(absent, {
        manifest: scope,
        manifestJson,
        expectedManifestSha256: sha256Hex(manifestJson),
        databaseTargetFingerprint: TARGET_FINGERPRINT,
        migrationCertification: certification(),
        capturedAt: CAPTURED_AT,
      }),
      (error) => code(error) === "BACKFILL_SCHEMA_NOT_READY",
    );
  } finally {
    await absent.close();
  }
});

test("backfill planner source contains no write, provider, or ambient credential path", async () => {
  const source = await readFile(
    new URL("../product-truth-backfill-readiness.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b\s+(?:INTO|FROM|[A-Za-z"])/i);
  assert.doesNotMatch(source, /\bfetch\s*\(|process\.env|unwrangle|oxylabs|anthropic|gemini/i);
  assert.match(source, /transaction\("read"\)/);
});
