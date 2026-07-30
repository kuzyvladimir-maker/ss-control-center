import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createClient, type Client } from "@libsql/client";

import {
  applyProductTruthConsensusReuseMaterialization,
  compileProductTruthConsensusReuseMaterializationPlan,
  preflightProductTruthConsensusReuseMaterialization,
  renderProductTruthConsensusReuseApplyPreflight,
  renderProductTruthConsensusReuseMaterializationPlan,
  type ProductTruthConsensusReuseMaterializationSources,
} from "../product-truth-consensus-reuse-materialization";
import type {
  ProductTruthConsensusReusePreflightReport,
} from "../product-truth-consensus-reuse-preflight";
import type {
  ProductTruthConsensusReuseScope,
} from "../product-truth-consensus-reuse-scope";
import type {
  ProductTruthLegacyBridgeStandingPolicy,
} from "../product-truth-legacy-bridge-apply";

const CREATED_AT = "2026-07-29T23:40:00.000Z";
const CHECKED_AT = "2026-07-29T23:41:00.000Z";
const STARTED_AT = "2026-07-29T23:42:00.000Z";
const EXPIRES_AT = "2026-07-30T23:40:00.000Z";

const MIGRATION_IDS = [
  "20260718230000_product_truth_queue_v2",
  "20260718233000_donor_harvest_lifecycle",
  "20260718234500_product_truth_evidence_provenance",
  "20260719000000_metered_budget_ledger",
  "20260719001000_product_truth_metered_evidence_link",
  "20260719002000_product_truth_listing_scope",
  "20260719003000_product_truth_queue_listing_scope",
  "20260719004000_product_truth_operational_run",
  "20260729010000_product_truth_listing_recipe",
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function jsonSource<T>(url: URL): Promise<{
  value: T;
  json: string;
  sha256: string;
}> {
  const json = await readFile(url, "utf8");
  return {
    value: JSON.parse(json) as T,
    json,
    sha256: sha256(json),
  };
}

async function sources(): Promise<ProductTruthConsensusReuseMaterializationSources> {
  const [scope, selectionPreflight, blindTask, standingPolicy] =
    await Promise.all([
      jsonSource<ProductTruthConsensusReuseScope>(new URL(
        "../../../../data/audits/product-truth-consensus-reuse/"
          + "20260729T232631Z-v4/consensus-reuse-scope.json",
        import.meta.url,
      )),
      jsonSource<ProductTruthConsensusReusePreflightReport>(new URL(
        "../../../../data/audits/product-truth-consensus-reuse-preflight/"
          + "20260729T233631Z-v2/preflight-report.json",
        import.meta.url,
      )),
      jsonSource<unknown>(new URL(
        "../../../../../release-artifacts/"
          + "product-truth-matcher-adjudication-2026-07-19/"
          + "prepared-v21-final/review-task-a.json",
        import.meta.url,
      )),
      jsonSource<ProductTruthLegacyBridgeStandingPolicy>(new URL(
        "../../../../data/audits/product-truth-legacy-bridge/"
          + "standing-policy-20260727-v1.json",
        import.meta.url,
      )),
    ]);
  return {
    scope: scope.value,
    scopeJson: scope.json,
    scopeSha256: scope.sha256,
    selectionPreflight: selectionPreflight.value,
    selectionPreflightJson: selectionPreflight.json,
    selectionPreflightSha256: selectionPreflight.sha256,
    blindTask: blindTask.value,
    blindTaskJson: blindTask.json,
    blindTaskSha256: blindTask.sha256,
    standingPolicy: standingPolicy.value,
    standingPolicyJson: standingPolicy.json,
    standingPolicySha256: standingPolicy.sha256,
  };
}

async function createBaseSchema(db: Client): Promise<void> {
  await db.execute("PRAGMA foreign_keys=ON");
  await db.executeMultiple(`
    CREATE TABLE EnrichmentJob (
      id TEXT PRIMARY KEY, targetType TEXT NOT NULL DEFAULT 'brand',
      target TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      source TEXT NOT NULL DEFAULT 'manual', priority INTEGER NOT NULL DEFAULT 0,
      requestedBy TEXT, attempts INTEGER NOT NULL DEFAULT 0, result TEXT,
      error TEXT, queuedAt DATETIME, startedAt DATETIME, finishedAt DATETIME,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE DonorProduct (
      id TEXT PRIMARY KEY, brand TEXT, productLine TEXT, flavor TEXT,
      containerType TEXT, size TEXT, unitMeasure TEXT, unitAmount REAL,
      category TEXT, upc TEXT, gtin TEXT, title TEXT, description TEXT,
      bullets TEXT, attributes TEXT, nutritionFacts TEXT, ingredients TEXT,
      mainImageUrl TEXT, imageUrls TEXT, bestPrice REAL, bestRetailer TEXT,
      pricePerMeasure REAL, currency TEXT NOT NULL DEFAULT 'USD',
      identityKey TEXT NOT NULL UNIQUE, confidence REAL,
      needsReview INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
    );
    CREATE TABLE DonorOffer (
      id TEXT PRIMARY KEY, donorProductId TEXT NOT NULL,
      retailer TEXT NOT NULL, retailerProductId TEXT NOT NULL, via TEXT NOT NULL,
      price REAL, packSizeSeen INTEGER, pricePerUnit REAL,
      currency TEXT NOT NULL DEFAULT 'USD', zip TEXT, inStock INTEGER,
      productUrl TEXT, sellerName TEXT, isFirstParty INTEGER NOT NULL DEFAULT 0,
      sourceApi TEXT, fetchedAt TEXT, createdAt DATETIME NOT NULL,
      updatedAt DATETIME NOT NULL,
      FOREIGN KEY (donorProductId) REFERENCES DonorProduct(id)
    );
    CREATE UNIQUE INDEX donor_offer_dedup
      ON DonorOffer(retailer, retailerProductId);
    CREATE TABLE SkuComponent (
      id TEXT PRIMARY KEY, sku TEXT NOT NULL, channel TEXT, idx INTEGER NOT NULL,
      product TEXT NOT NULL, flavor TEXT, size TEXT, qty INTEGER NOT NULL,
      perUnitCost REAL, lineCost REAL, currency TEXT NOT NULL DEFAULT 'USD',
      retailer TEXT, matchedTitle TEXT, costMethod TEXT, donorProductId TEXT,
      isBundleComponent INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL,
      UNIQUE(sku, idx)
    );
    CREATE TABLE SkuCost (
      id TEXT PRIMARY KEY, sku TEXT NOT NULL, asin TEXT, effectiveDate TEXT,
      productCost REAL, packagingCost REAL, iceCost REAL, totalCost REAL,
      costPerUnit REAL, packSize INTEGER,
      includesPackaging INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD', source TEXT NOT NULL,
      confidence REAL, needsReview INTEGER NOT NULL DEFAULT 0, notes TEXT,
      createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
    );
    CREATE INDEX SkuCost_sku_idx ON SkuCost(sku);
    CREATE TABLE SkuShippingData (
      id TEXT PRIMARY KEY, sku TEXT UNIQUE, marketplace TEXT,
      productIdentity TEXT, upc TEXT, upcSource TEXT,
      unitsInListing INTEGER, baseUnitDesc TEXT, source TEXT,
      createdAt DATETIME, updatedAt DATETIME
    );
    CREATE TABLE WalmartListingQualityItem (
      id TEXT PRIMARY KEY, storeIndex INTEGER NOT NULL, sku TEXT NOT NULL,
      gmv30d REAL, orders30d INTEGER, units30d INTEGER, scoredAt DATETIME,
      UNIQUE(storeIndex, sku)
    );
    CREATE TABLE MasterBundle (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, pack_count INTEGER NOT NULL,
      updated_at DATETIME NOT NULL
    );
    CREATE TABLE ChannelSKU (
      id TEXT PRIMARY KEY, master_bundle_id TEXT NOT NULL, sku TEXT NOT NULL UNIQUE,
      asin TEXT, title TEXT NOT NULL, updated_at DATETIME NOT NULL
    );
    CREATE TABLE BundleComponent (
      id TEXT PRIMARY KEY, master_bundle_id TEXT NOT NULL,
      product_name TEXT NOT NULL, manufacturer_brand TEXT NOT NULL,
      manufacturer_upc TEXT, flavor TEXT, variant TEXT, qty INTEGER NOT NULL,
      unit_weight_oz REAL, unit_weight_lb REAL, source_url TEXT,
      updated_at DATETIME NOT NULL
    );
  `);
}

async function seedLegacyRows(
  db: Client,
  input: ProductTruthConsensusReuseMaterializationSources,
  plan: ReturnType<
    typeof compileProductTruthConsensusReuseMaterializationPlan
  >,
): Promise<void> {
  const donorStateById = new Map(
    input.selectionPreflight.readyDonorStates.map(
      (state) => [state.donorProductId, state],
    ),
  );
  const candidateByDonor = new Map(
    input.scope.candidates.map(
      (candidate) => [candidate.donorProductId, candidate],
    ),
  );
  for (const donorProductId of plan.wave.donorProductIds) {
    const state = donorStateById.get(donorProductId)!;
    const candidate = candidateByDonor.get(donorProductId)!;
    await db.execute({
      sql: `INSERT INTO DonorProduct (
        id,brand,productLine,flavor,containerType,size,category,title,
        description,bullets,attributes,nutritionFacts,ingredients,
        mainImageUrl,imageUrls,identityKey,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        donorProductId,
        state.sourceIdentity.brand,
        state.sourceIdentity.productLine,
        state.sourceIdentity.flavor,
        state.sourceIdentity.containerType,
        state.sourceIdentity.size,
        "Dry",
        candidate.donorTitle,
        "Legacy exact donor content",
        "[]",
        "[]",
        null,
        null,
        null,
        "[]",
        state.sourceIdentity.identityKey,
        "2026-07-01T00:00:00.000Z",
        "2026-07-10T00:00:00.000Z",
      ],
    });
  }
  for (const target of plan.targets) {
    const component = target.components[0]!.sourceComponent;
    await db.execute({
      sql: `INSERT INTO SkuComponent (
        id,sku,channel,idx,product,flavor,size,qty,currency,donorProductId,
        isBundleComponent,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        component.id,
        component.sku,
        "walmart",
        component.idx,
        component.product,
        component.flavor,
        component.size,
        component.qty,
        "USD",
        component.donorProductId,
        0,
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      ],
    });
  }
}

async function applyMigrations(db: Client): Promise<void> {
  for (const migrationId of MIGRATION_IDS) {
    const migration = new URL(
      `../../../../prisma/migrations/${migrationId}/migration.sql`,
      import.meta.url,
    );
    await db.executeMultiple(await readFile(migration, "utf8"));
  }
}

async function seedListingScope(
  db: Client,
  plan: ReturnType<
    typeof compileProductTruthConsensusReuseMaterializationPlan
  >,
): Promise<void> {
  for (const target of plan.targets) {
    await db.execute({
      sql: `INSERT INTO ProductTruthListingScope (
        listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
        manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
        sourceReportId,sourceContentSha256,sourceCapturedAt,createdAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        target.listingKey,
        "product-truth-listing-key/1.0.0",
        target.channel,
        target.storeIndex,
        target.sku,
        "AUTHORITATIVE_PHASE1_MANIFEST",
        "phase1-authoritative-scope-manifest/v3",
        plan.source.manifestSha256,
        "2026-07-26T09:30:00.000Z",
        "owner-fixture",
        "report-fixture",
        "c".repeat(64),
        "2026-07-26T09:00:00.000Z",
        "2026-07-26T09:30:00.000Z",
      ],
    });
  }
}

test("compiles the real wave zero from immutable consensus evidence", async () => {
  const input = await sources();
  const plan = compileProductTruthConsensusReuseMaterializationPlan({
    sources: input,
    waveOrdinal: 0,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  });
  assert.equal(plan.targets.length, 5);
  assert.equal(plan.databaseWrites.maximumRows, 45);
  assert.equal(plan.databaseWrites.donorVariantDecisions, 5);
  assert.equal(plan.databaseWrites.productTruthListingRecipes, 5);
  assert.equal(plan.claims.historicalPricePromoted, false);
  assert.equal(plan.claims.marketplaceMutations, 0);
});

test("fails closed when the blind task bytes are rebound", async () => {
  const input = await sources();
  const alteredJson = `${input.blindTaskJson}\n`;
  assert.throws(
    () => compileProductTruthConsensusReuseMaterializationPlan({
      sources: {
        ...input,
        blindTaskJson: alteredJson,
        blindTaskSha256: sha256(alteredJson),
      },
      waveOrdinal: 0,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    }),
    /CONSENSUS_REUSE_MATERIALIZATION_SOURCE_INVALID/u,
  );
});

test("applies one complete donor-group wave atomically and is idempotent", async (t) => {
  const input = await sources();
  const plan = compileProductTruthConsensusReuseMaterializationPlan({
    sources: input,
    waveOrdinal: 0,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  });
  const planJson =
    renderProductTruthConsensusReuseMaterializationPlan(plan);
  const planSha256 = sha256(planJson);
  const directory = await mkdtemp(join(tmpdir(), "pt-consensus-reuse-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = createClient({
    url: `file:${join(directory, "fixture.sqlite")}`,
    concurrency: 1,
  });
  try {
    await createBaseSchema(db);
    await seedLegacyRows(db, input, plan);
    await applyMigrations(db);
    await seedListingScope(db, plan);
    const preflight =
      await preflightProductTruthConsensusReuseMaterialization({
        db,
        databaseTargetFingerprint: plan.databaseTargetFingerprint,
        plan,
        planJson,
        planSha256,
        sources: input,
        checkedAt: CHECKED_AT,
      });
    assert.equal(preflight.status, "READY_TO_APPLY");
    assert.equal(preflight.counts.absentRows, 45);
    const preflightJson =
      renderProductTruthConsensusReuseApplyPreflight(preflight);
    const report =
      await applyProductTruthConsensusReuseMaterialization({
        db,
        databaseTargetFingerprint: plan.databaseTargetFingerprint,
        plan,
        planJson,
        planSha256,
        sources: input,
        preflightReport: preflight,
        preflightReportJson: preflightJson,
        preflightReportSha256: sha256(preflightJson),
        startedAt: STARTED_AT,
      });
    assert.equal(report.status, "APPLIED");
    assert.equal(report.counts.insertedRows, 45);
    assert.equal(report.counts.donorIdentityTransitions, 5);
    assert.equal(report.verification.bundleFactoryReady, 0);
    assert.equal(report.verification.listingImprovementReady, 0);
    assert.equal(report.verification.unitEconomicsUnsourceable, 5);
    assert.equal(report.verification.procurementReady, 0);
    const post =
      await preflightProductTruthConsensusReuseMaterialization({
        db,
        databaseTargetFingerprint: plan.databaseTargetFingerprint,
        plan,
        planJson,
        planSha256,
        sources: input,
        checkedAt: "2026-07-29T23:43:00.000Z",
      });
    assert.equal(post.status, "ALREADY_APPLIED");
    assert.equal(post.counts.exactExistingRows, 45);
  } finally {
    db.close();
  }
});
