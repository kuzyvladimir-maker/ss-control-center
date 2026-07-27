import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { createClient, type Client } from "@libsql/client";

import {
  applyProductTruthLegacyBridgeCanary,
  expectedProductTruthLegacyBridgeConfirmation,
  planProductTruthLegacyBridgeApply,
  preflightProductTruthLegacyBridgeCanary,
  renderProductTruthLegacyBridgeApplyPlan,
  renderProductTruthLegacyBridgeApproval,
  PRODUCT_TRUTH_LEGACY_BRIDGE_MATERIALIZATION_SOURCE,
  type ProductTruthLegacyBridgeApproval,
} from "../product-truth-legacy-bridge-apply";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  compileProductTruthLegacyBridgePlan,
  productTruthLegacyBridgeBytesSha256,
  renderProductTruthLegacyBridgePlan,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeSnapshot,
} from "../product-truth-legacy-bridge";
import { readProductTruthSnapshot } from "../product-truth-read-contract";

const CAPTURED_AT = "2026-07-26T10:00:00.000Z";
const PLAN_CREATED_AT = "2026-07-26T12:00:00.000Z";
const PLAN_EXPIRES_AT = "2026-07-27T12:00:00.000Z";
const APPLY_AT = "2026-07-26T13:00:00.000Z";
const TARGET_FINGERPRINT = "b".repeat(64);
const MANIFEST_SHA256 = "a".repeat(64);
const VALID_UPC = "036000291452";
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

function sourceFixture(): {
  snapshot: ProductTruthLegacyBridgeSnapshot;
  snapshotJson: string;
  snapshotSha256: string;
  bridgePlanJson: string;
  bridgePlanSha256: string;
  bridgePlan: ReturnType<typeof compileProductTruthLegacyBridgePlan>;
  listingKeys: string[];
} {
  const listings = Array.from({ length: 5 }, (_, index) => {
    const number = index + 1;
    return {
      listingKey: `walmart:1:SKU-${number}`,
      channel: "walmart" as const,
      storeIndex: 1,
      sku: `SKU-${number}`,
      listingUpc: null,
      listingUpcSource: null,
      priorityGmv30d: 0,
      priorityOrders30d: 0,
      priorityUnits30d: 0,
      priorityObservedAt: "2026-07-26T09:00:00.000Z",
      productIdentityJson: JSON.stringify({
        brand: `Acme Brand ${number}`,
        product_line: "Crunch Chips",
        flavor: "Original",
        size: "8 oz",
        container_type: "bag",
        units_in_listing: number,
        is_bundle: false,
        components: [],
      }),
      productIdentityUpdatedAt: "2026-07-25T09:00:00.000Z",
    };
  });
  const components = listings.map((listing, index) => ({
    id: `legacy-component-${index + 1}`,
    sku: listing.sku,
    idx: 0,
    product: "Crunch Chips",
    flavor: "Original",
    size: "8 oz",
    qty: index + 1,
    costMethod: "exact",
    retailer: "walmart",
    matchedTitle: `Acme Brand ${index + 1} Crunch Chips Original, 8 oz Bag`,
    perUnitCost: 2.99,
    lineCost: 2.99 * (index + 1),
    donorProductId: `donor-${index + 1}`,
    contentDonorProductId: null,
    priceEvidenceDonorProductId: null,
    priceEvidenceOfferId: null,
  }));
  const donors = listings.map((listing, index) => {
    const number = index + 1;
    const main = `https://images.example.test/${number}/main.jpg`;
    return {
      id: `donor-${number}`,
      brand: `Acme Brand ${number}`,
      productLine: "Crunch Chips",
      flavor: "Original",
      containerType: "bag",
      size: "8 oz",
      category: "Dry",
      upc: VALID_UPC,
      gtin: null,
      title: `Acme Brand ${number} Crunch Chips Original, 8 oz Bag`,
      description: `Complete exact description ${number}`,
      bullets: JSON.stringify(["One", "Two"]),
      attributes: JSON.stringify([
        { name: "Food condition", value: "Shelf-Stable" },
      ]),
      nutritionFacts: JSON.stringify({
        calories: 120,
        allergens: ["milk"],
      }),
      ingredients: "Corn, oil. Contains: Milk.",
      mainImageUrl: main,
      imageUrls: JSON.stringify([
        main,
        `https://images.example.test/${number}/ingredients.jpg`,
        `https://images.example.test/${number}/nutrition.jpg`,
      ]),
      identityKey: `legacy-identity-${number}`,
      identityStatus: "legacy_unverified",
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-01T10:05:00.000Z",
    };
  });
  const offers = donors.map((donor, index) => {
    const number = index + 1;
    return {
      id: `offer-${number}`,
      donorProductId: donor.id,
      retailer: "walmart",
      retailerProductId: `item-${number}`,
      via: "direct",
      price: 2.99,
      packSizeSeen: 1,
      pricePerUnit: 2.99,
      currency: "USD",
      zip: "33765",
      localityEvidence: "zip_scoped",
      inStock: true,
      productUrl: `https://www.walmart.com/ip/item-${number}/${number}`,
      isFirstParty: true,
      sourceApi: "oxylabs",
      fetchedAt: "2026-07-01T10:00:00.000Z",
    };
  });
  const snapshot: ProductTruthLegacyBridgeSnapshot = {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
    capturedAt: CAPTURED_AT,
    targetFingerprint: TARGET_FINGERPRINT,
    manifest: {
      schemaVersion: "phase1-authoritative-scope-manifest/v3",
      sha256: MANIFEST_SHA256,
      asOf: "2026-07-26T09:30:00.000Z",
      listingCount: listings.length,
    },
    listings,
    components,
    donors,
    offers,
  };
  const snapshotJson = renderProductTruthLegacyBridgeSnapshot(snapshot);
  const snapshotSha256 = productTruthLegacyBridgeBytesSha256(snapshotJson);
  const bridgePlan = compileProductTruthLegacyBridgePlan({
    snapshot,
    snapshotJson,
    snapshotSha256,
    generatedAt: CAPTURED_AT,
  });
  assert.equal(bridgePlan.counts.contentOnlyCanonicalizationCandidates, 5);
  const bridgePlanJson = renderProductTruthLegacyBridgePlan(bridgePlan);
  return {
    snapshot,
    snapshotJson,
    snapshotSha256,
    bridgePlan,
    bridgePlanJson,
    bridgePlanSha256: productTruthLegacyBridgeBytesSha256(bridgePlanJson),
    listingKeys: listings.map((listing) => listing.listingKey),
  };
}

function applyPlan(fixture = sourceFixture()) {
  const plan = planProductTruthLegacyBridgeApply({
    ...fixture,
    createdAt: PLAN_CREATED_AT,
    expiresAt: PLAN_EXPIRES_AT,
  });
  const planJson = renderProductTruthLegacyBridgeApplyPlan(plan);
  const planSha256 = productTruthLegacyBridgeBytesSha256(planJson);
  return { fixture, plan, planJson, planSha256 };
}

function approval(input: ReturnType<typeof applyPlan>) {
  const value: ProductTruthLegacyBridgeApproval = {
    schemaVersion: "product-truth-legacy-bridge-approval/1.0.0",
    decision: "APPROVE_NO_PAID_LEGACY_BRIDGE_CANARY",
    approvedBy: "owner",
    approvalId: input.plan.expectedApprovalId,
    planId: input.plan.planId,
    planSha256: input.planSha256,
    databaseTargetFingerprint: input.plan.databaseTargetFingerprint,
    sourceSnapshotSha256: input.plan.source.snapshotSha256,
    bridgePlanSha256: input.plan.source.bridgePlanSha256,
    targetsSha256: input.plan.targetsSha256,
    listingKeys: input.plan.targets.map((target) => target.listingKey),
    maximumDatabaseRows: input.plan.databaseWrites.maximumRows,
    allowCanonicalMaterialization: true,
    allowProviderCalls: false,
    allowPaidCalls: false,
    allowMarketplaceMutations: false,
    allowProcurementMutations: false,
    allowConsumerCutover: false,
    issuedAt: PLAN_CREATED_AT,
    expiresAt: PLAN_EXPIRES_AT,
  };
  const json = renderProductTruthLegacyBridgeApproval(value);
  return {
    value,
    json,
    sha256: productTruthLegacyBridgeBytesSha256(json),
  };
}

async function createSchema(db: Client): Promise<void> {
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
      brand TEXT, productLine TEXT, flavor TEXT, containerType TEXT, size TEXT,
      unitMeasure TEXT, unitAmount REAL, category TEXT, upc TEXT, gtin TEXT,
      title TEXT, description TEXT, bullets TEXT, attributes TEXT,
      nutritionFacts TEXT, ingredients TEXT, mainImageUrl TEXT, imageUrls TEXT,
      bestPrice REAL, bestRetailer TEXT, pricePerMeasure REAL,
      currency TEXT NOT NULL DEFAULT 'USD',
      identityKey TEXT NOT NULL UNIQUE,
      confidence REAL, needsReview INTEGER NOT NULL DEFAULT 0,
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
  `);
  for (const migrationId of MIGRATION_IDS) {
    const migration = new URL(
      `../../../../prisma/migrations/${migrationId}/migration.sql`,
      import.meta.url,
    );
    await db.executeMultiple(await readFile(migration, "utf8"));
  }
}

async function seededDatabase(
  t: TestContext,
  fixture = sourceFixture(),
): Promise<Client> {
  const directory = await mkdtemp(join(tmpdir(), "legacy-bridge-apply-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = createClient({
    url: `file:${join(directory, "fixture.sqlite")}`,
    concurrency: 1,
  });
  await createSchema(db);
  for (const listing of fixture.snapshot.listings) {
    await db.execute({
      sql: `INSERT INTO ProductTruthListingScope (
        listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
        manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
        sourceReportId,sourceContentSha256,sourceCapturedAt,createdAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        listing.listingKey, "product-truth-listing-key/1.0.0",
        listing.channel, listing.storeIndex, listing.sku,
        "AUTHORITATIVE_PHASE1_MANIFEST",
        "phase1-authoritative-scope-manifest/v3", MANIFEST_SHA256,
        "2026-07-26T09:30:00.000Z", "owner-fixture", "report-fixture",
        "c".repeat(64), "2026-07-26T09:00:00.000Z",
        "2026-07-26T09:30:00.000Z",
      ],
    });
    await db.execute({
      sql: `INSERT INTO SkuShippingData (
        id,sku,marketplace,productIdentity,upc,upcSource,unitsInListing,
        baseUnitDesc,source,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        `shipping-${listing.sku}`, listing.sku, "Walmart",
        listing.productIdentityJson, listing.listingUpc, listing.listingUpcSource,
        1, "bag", "fixture", "2026-07-25T09:00:00.000Z",
        listing.productIdentityUpdatedAt,
      ],
    });
    await db.execute({
      sql: `INSERT INTO WalmartListingQualityItem (
        id,storeIndex,sku,gmv30d,orders30d,units30d,scoredAt
      ) VALUES (?,?,?,?,?,?,?)`,
      args: [
        `quality-${listing.sku}`, listing.storeIndex, listing.sku,
        listing.priorityGmv30d, listing.priorityOrders30d,
        listing.priorityUnits30d, listing.priorityObservedAt,
      ],
    });
  }
  for (const donor of fixture.snapshot.donors) {
    await db.execute({
      sql: `INSERT INTO DonorProduct (
        id,brand,productLine,flavor,containerType,size,category,upc,gtin,
        title,description,bullets,attributes,nutritionFacts,ingredients,
        mainImageUrl,imageUrls,identityKey,identityStatus,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        donor.id, donor.brand, donor.productLine, donor.flavor,
        donor.containerType, donor.size, donor.category, donor.upc, donor.gtin,
        donor.title, donor.description, donor.bullets, donor.attributes,
        donor.nutritionFacts, donor.ingredients, donor.mainImageUrl,
        donor.imageUrls, donor.identityKey, donor.identityStatus,
        donor.createdAt, donor.updatedAt,
      ],
    });
  }
  for (const offer of fixture.snapshot.offers) {
    await db.execute({
      sql: `INSERT INTO DonorOffer (
        id,donorProductId,retailer,retailerProductId,via,price,packSizeSeen,
        pricePerUnit,currency,zip,localityEvidence,inStock,productUrl,
        isFirstParty,sourceApi,fetchedAt,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        offer.id, offer.donorProductId, offer.retailer, offer.retailerProductId,
        offer.via, offer.price, offer.packSizeSeen, offer.pricePerUnit,
        offer.currency, offer.zip, offer.localityEvidence, offer.inStock,
        offer.productUrl, offer.isFirstParty, offer.sourceApi, offer.fetchedAt,
        offer.fetchedAt, offer.fetchedAt,
      ],
    });
  }
  // The fixture represents rows that existed before the evidence migration.
  // Temporarily remove only the two legacy-write guards while recreating that
  // pre-migration state, then restore their exact migration definitions.
  await db.execute("DROP TRIGGER SkuComponent_evidence_contract_insert");
  await db.execute("DROP TRIGGER SkuComponent_evidence_contract_update");
  for (const component of fixture.snapshot.components) {
    await db.execute({
      sql: `INSERT INTO SkuComponent (
        id,sku,channel,idx,product,flavor,size,qty,perUnitCost,lineCost,
        currency,retailer,matchedTitle,costMethod,donorProductId,isBundleComponent,
        createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        component.id, component.sku, "walmart", component.idx,
        component.product, component.flavor, component.size, component.qty,
        component.perUnitCost, component.lineCost, "USD", component.retailer,
        component.matchedTitle, component.costMethod, component.donorProductId, 0,
        "2026-07-01T10:00:00.000Z", "2026-07-01T10:00:00.000Z",
      ],
    });
  }
  const migration = new URL(
    "../../../../prisma/migrations/20260718234500_product_truth_evidence_provenance/migration.sql",
    import.meta.url,
  );
  const migrationSql = await readFile(migration, "utf8");
  const triggerSql = migrationSql.slice(
    migrationSql.indexOf('CREATE TRIGGER "SkuComponent_evidence_contract_insert"'),
    migrationSql.indexOf('CREATE TRIGGER "DonorOffer_delete_guard"'),
  );
  await db.executeMultiple(triggerSql);
  return db;
}

async function executeApproved(
  db: Client,
  input: ReturnType<typeof applyPlan>,
  confirmation = expectedProductTruthLegacyBridgeConfirmation(input.plan, input.planSha256),
) {
  const permit = approval(input);
  return applyProductTruthLegacyBridgeCanary({
    db,
    databaseTargetFingerprint: TARGET_FINGERPRINT,
    plan: input.plan,
    planJson: input.planJson,
    planSha256: input.planSha256,
    approval: permit.value,
    approvalJson: permit.json,
    approvalSha256: permit.sha256,
    confirmation,
    startedAt: APPLY_AT,
    completedAt: APPLY_AT,
  });
}

test("legacy bridge apply plan is byte-deterministic and limited to five existing catalog graphs", () => {
  const first = applyPlan();
  const second = applyPlan(first.fixture);
  assert.equal(first.planJson, second.planJson);
  assert.equal(first.planSha256, second.planSha256);
  assert.equal(first.plan.targets.length, 5);
  assert.equal(first.plan.databaseWrites.maximumRows, 35);
  assert.equal(first.plan.claims.createsAdditionalCatalog, false);
  assert.equal(first.plan.claims.paidCalls, 0);
  assert.equal(first.plan.claims.marketplaceMutations, 0);
});

test("approved canary atomically materializes exact content with an honest UNSOURCEABLE cost and is idempotent", async (t) => {
  const input = applyPlan();
  const db = await seededDatabase(t, input.fixture);
  t.after(() => db.close());
  const before = await preflightProductTruthLegacyBridgeCanary({
    db,
    databaseTargetFingerprint: TARGET_FINGERPRINT,
    plan: input.plan,
    planJson: input.planJson,
    planSha256: input.planSha256,
    checkedAt: APPLY_AT,
  });
  assert.equal(before.status, "READY_TO_APPLY");
  assert.equal(before.counts.absentRows, 35);
  const first = await executeApproved(db, input);
  assert.equal(first.status, "APPLIED");
  assert.equal(first.counts.insertedRows, 35);
  const second = await executeApproved(db, input);
  assert.equal(second.status, "ALREADY_APPLIED");
  assert.equal(second.counts.exactExistingRows, 35);
  const after = await preflightProductTruthLegacyBridgeCanary({
    db,
    databaseTargetFingerprint: TARGET_FINGERPRINT,
    plan: input.plan,
    planJson: input.planJson,
    planSha256: input.planSha256,
    checkedAt: APPLY_AT,
  });
  assert.equal(after.status, "ALREADY_APPLIED");
  assert.equal(after.counts.exactExistingRows, 35);

  for (const target of input.plan.targets) {
    const contentRow = (await db.execute({
      sql: `SELECT sourceApi,meteredReceiptId,contentJson
            FROM ProductContentObservation WHERE id=?`,
      args: [target.content.id],
    })).rows[0];
    assert.equal(
      contentRow.sourceApi,
      PRODUCT_TRUTH_LEGACY_BRIDGE_MATERIALIZATION_SOURCE,
    );
    assert.equal(contentRow.meteredReceiptId, null);
    const contentJson = JSON.parse(String(contentRow.contentJson)) as {
      sourceBinding: {
        materializationRoute: string;
        originalSourceApi: string;
      };
    };
    assert.equal(
      contentJson.sourceBinding.materializationRoute,
      PRODUCT_TRUTH_LEGACY_BRIDGE_MATERIALIZATION_SOURCE,
    );
    assert.equal(contentJson.sourceBinding.originalSourceApi, "oxylabs");

    const snapshot = await readProductTruthSnapshot(db, {
      sku: target.sku,
      channel: target.channel,
      storeIndex: target.storeIndex,
      expectedManifestSha256: MANIFEST_SHA256,
      asOf: APPLY_AT,
      maxPriceAgeMs: 24 * 60 * 60 * 1_000,
    });
    assert.equal(snapshot.views.bundleFactory.ready, true);
    assert.equal(snapshot.views.listingImprovement.ready, true);
    assert.equal(snapshot.views.unitEconomics.status, "UNSOURCEABLE");
    assert.equal(snapshot.views.procurement.ready, false);
    assert.equal(snapshot.views.bundleFactory.components[0].content?.provenance.sourceUrl,
      input.plan.targets.find((item) => item.listingKey === target.listingKey)?.content.sourceUrl);
  }
});

test("approval or source drift fails before any canonical write", async (t) => {
  const input = applyPlan();
  const db = await seededDatabase(t, input.fixture);
  t.after(() => db.close());
  await assert.rejects(
    executeApproved(db, input, "WRONG_CONFIRMATION"),
    /LEGACY_BRIDGE_CONFIRMATION_MISMATCH/,
  );
  assert.equal(
    Number((await db.execute("SELECT COUNT(*) AS count FROM CanonicalProductVariant")).rows[0].count),
    0,
  );
  await db.execute({
    sql: "UPDATE DonorProduct SET description=? WHERE id=?",
    args: ["drifted", input.plan.targets[0].donorProductId],
  });
  await assert.rejects(
    executeApproved(db, input),
    /LEGACY_BRIDGE_SOURCE_DRIFT/,
  );
  assert.equal(
    Number((await db.execute("SELECT COUNT(*) AS count FROM CanonicalProductVariant")).rows[0].count),
    0,
  );
});

test("an injected database failure rolls the entire canary back", async (t) => {
  const input = applyPlan();
  const db = await seededDatabase(t, input.fixture);
  t.after(() => db.close());
  await db.execute(`
    CREATE TRIGGER test_legacy_bridge_abort
    BEFORE INSERT ON SkuCost
    WHEN NEW.sku='SKU-3'
    BEGIN
      SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE');
    END
  `);
  await assert.rejects(
    executeApproved(db, input),
    /LEGACY_BRIDGE_TRANSACTION_FAILED.*TEST_INJECTED_FAILURE/,
  );
  for (const table of [
    "CanonicalProductVariant",
    "DonorProductVariantDecision",
    "ProductContentObservation",
    "SkuCostListingScopeLink",
    "SkuComponentEvidence",
    "SkuCost",
  ]) {
    const count = Number((await db.execute(`SELECT COUNT(*) AS count FROM "${table}"`)).rows[0].count);
    assert.equal(count, 0, table);
  }
  const confirmed = Number((await db.execute(
    "SELECT COUNT(*) AS count FROM DonorProduct WHERE identityStatus='exact_confirmed'",
  )).rows[0].count);
  assert.equal(confirmed, 0);
});
