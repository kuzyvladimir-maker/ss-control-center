import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createClient } from "@libsql/client";

import {
  COGS_COMPONENT_CONCURRENCY,
  DEFAULT_COST_SOURCE_POLICY,
  costOneSku,
  costSourcePolicyAllowsRetailer,
  resolveCostSourcePolicy,
  runCostComponentsSequentially,
  type CostRetailer,
} from "../cogs-engine";
import { buildCanonicalProductVariantKey } from "../canonical-product-variant";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../canonical-product-match-provenance";
import {
  UNWRANGLE_DETAIL_CREDIT_UNITS,
  unwrangleDetailCreditUnits,
} from "../donor-catalog";
import { readProductTruthSnapshot } from "../product-truth-read-contract";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createMinimalCogsSchema(db: ReturnType<typeof createClient>) {
  await db.executeMultiple(`
    CREATE TABLE DonorProduct (
      id TEXT PRIMARY KEY, identityKey TEXT, brand TEXT, productLine TEXT,
      flavor TEXT, containerType TEXT, size TEXT, title TEXT
    );
    CREATE TABLE DonorOffer (
      id TEXT PRIMARY KEY, donorProductId TEXT NOT NULL, retailer TEXT NOT NULL,
      retailerProductId TEXT NOT NULL, via TEXT NOT NULL DEFAULT 'direct'
    );
    CREATE UNIQUE INDEX donor_offer_dedup ON DonorOffer(retailer, retailerProductId);
    CREATE TABLE SkuComponent (
      id TEXT PRIMARY KEY, sku TEXT NOT NULL, channel TEXT, idx INTEGER NOT NULL DEFAULT 0,
      product TEXT NOT NULL, flavor TEXT, size TEXT, qty INTEGER NOT NULL DEFAULT 1,
      perUnitCost REAL, lineCost REAL, currency TEXT NOT NULL DEFAULT 'USD',
      retailer TEXT, matchedTitle TEXT, costMethod TEXT, donorProductId TEXT,
      isBundleComponent INTEGER NOT NULL DEFAULT 0, createdAt DATETIME NOT NULL,
      updatedAt DATETIME NOT NULL, UNIQUE(sku, idx)
    );
    CREATE TABLE SkuCost (
      id TEXT PRIMARY KEY, sku TEXT NOT NULL, asin TEXT, effectiveDate TEXT,
      productCost REAL, packagingCost REAL, iceCost REAL, totalCost REAL,
      costPerUnit REAL, packSize INTEGER,
      includesPackaging INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
      source TEXT NOT NULL, confidence REAL, needsReview INTEGER NOT NULL DEFAULT 0,
      notes TEXT, createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
    );
    CREATE UNIQUE INDEX SkuCost_sku_source_effectiveDate_key
      ON SkuCost(sku, source, effectiveDate);
    CREATE TABLE SkuShippingData (
      id TEXT PRIMARY KEY, sku TEXT UNIQUE, marketplace TEXT, productIdentity TEXT,
      unitsInListing INTEGER, baseUnitDesc TEXT, source TEXT,
      createdAt DATETIME, updatedAt DATETIME
    );
  `);
  const migration = new URL(
    "../../../../prisma/migrations/20260718234500_product_truth_evidence_provenance/migration.sql",
    import.meta.url,
  );
  await db.executeMultiple(await readFile(migration, "utf8"));
  await applyListingScopeMigration(db);
}

async function applyListingScopeMigration(db: ReturnType<typeof createClient>) {
  const migration = new URL(
    "../../../../prisma/migrations/20260719002000_product_truth_listing_scope/migration.sql",
    import.meta.url,
  );
  await db.executeMultiple(await readFile(migration, "utf8"));
}

async function registerListingScope(
  db: ReturnType<typeof createClient>,
  channel: "amazon" | "walmart",
  storeIndex: number,
  sku: string,
  createdAt: string,
) {
  const listingKey = `${channel}:${storeIndex}:${sku}`;
  await db.execute({
    sql: `INSERT INTO ProductTruthListingScope (
      listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
      manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
      sourceReportId,sourceContentSha256,sourceCapturedAt,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      listingKey, "product-truth-listing-key/1.0.0", channel, storeIndex, sku,
      "AUTHORITATIVE_PHASE1_MANIFEST", "phase1-authoritative-scope-manifest/v3",
      hashKey(`manifest:${listingKey}`), createdAt, `decision:${listingKey}`,
      `report:${listingKey}`, hashKey(`report:${listingKey}`), createdAt, createdAt,
    ],
  });
}

test("COGS reuses immutable exact local evidence, separates donor roles, and appends idempotently", async () => {
  const db = createClient({ url: "file::memory:" });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("provider network must not be reached when fresh evidence exists");
  }) as typeof fetch;
  try {
    await db.execute(`CREATE TABLE DonorProduct (
      id TEXT PRIMARY KEY,
      identityKey TEXT, brand TEXT, productLine TEXT, flavor TEXT, containerType TEXT, size TEXT, title TEXT
    )`);
    await db.execute(`CREATE TABLE DonorOffer (
      id TEXT PRIMARY KEY,
      donorProductId TEXT NOT NULL,
      retailer TEXT NOT NULL,
      retailerProductId TEXT NOT NULL,
      via TEXT NOT NULL DEFAULT 'direct'
    )`);
    await db.execute(`CREATE UNIQUE INDEX donor_offer_dedup
      ON DonorOffer(retailer, retailerProductId)`);
    await db.execute(`CREATE TABLE SkuComponent (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      channel TEXT,
      idx INTEGER NOT NULL DEFAULT 0,
      product TEXT NOT NULL,
      flavor TEXT,
      size TEXT,
      qty INTEGER NOT NULL DEFAULT 1,
      perUnitCost REAL,
      lineCost REAL,
      currency TEXT NOT NULL DEFAULT 'USD',
      retailer TEXT,
      matchedTitle TEXT,
      costMethod TEXT,
      donorProductId TEXT,
      isBundleComponent INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL,
      updatedAt DATETIME NOT NULL,
      UNIQUE(sku, idx)
    )`);
    await db.execute(`CREATE TABLE SkuCost (
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
      updatedAt DATETIME NOT NULL
    )`);
    await db.execute(`CREATE UNIQUE INDEX SkuCost_sku_source_effectiveDate_key
      ON SkuCost(sku, source, effectiveDate)`);
    await db.execute(`CREATE TABLE SkuShippingData (
      id TEXT PRIMARY KEY,
      sku TEXT UNIQUE,
      marketplace TEXT,
      productIdentity TEXT,
      unitsInListing INTEGER,
      baseUnitDesc TEXT,
      source TEXT,
      createdAt DATETIME,
      updatedAt DATETIME
    )`);
    const migration = new URL(
      "../../../../prisma/migrations/20260718234500_product_truth_evidence_provenance/migration.sql",
      import.meta.url,
    );
    await db.executeMultiple(await readFile(migration, "utf8"));

    const now = new Date().toISOString();
    await applyListingScopeMigration(db);
    await registerListingScope(db, "walmart", 1, "SKU-1", now);
    const older = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const identity = {
      brand: "Acme",
      product_line: "Crunch Chips",
      flavor: "Barbecue",
      size: "8 oz",
      container_type: "bag",
      base_unit: "one bag",
      units_in_listing: 1,
      unit_basis: "listing",
      is_bundle: false,
      components: [],
      confidence: 0.99,
      retail_search_query: "Acme Crunch Chips Barbecue 8 oz",
      notes: "test identity",
    };
    await db.execute({
      sql: `INSERT INTO SkuShippingData
        (id,sku,marketplace,productIdentity,unitsInListing,baseUnitDesc,source,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      args: ["ssd-1", "SKU-1", "Walmart", JSON.stringify(identity), 1, "one bag", "test", now, now],
    });
    const variant = buildCanonicalProductVariantKey({
      brand: "Acme",
      productLine: "Crunch Chips",
      flavor: "Barbecue",
      form: "bag",
      size: "8 oz",
      outerPackCount: 1,
    });
    await db.execute({
      sql: `INSERT INTO CanonicalProductVariant (
        id,variantKey,identityHash,keyVersion,normalizedBrand,normalizedProductLine,
        normalizedFlavor,normalizedModifiersJson,normalizedForm,sizeDimension,
        sizeBaseAmount,sizeBaseUnit,outerPackCount,identityJson,createdAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        variant.db.id, variant.db.variantKey, variant.db.identityHash,
        variant.db.keyVersion, variant.db.normalizedBrand,
        variant.db.normalizedProductLine, variant.db.normalizedFlavor,
        variant.db.normalizedModifiersJson, variant.db.normalizedForm,
        variant.db.sizeDimension, variant.db.sizeBaseAmount,
        variant.db.sizeBaseUnit, variant.db.outerPackCount,
        variant.db.identityJson, now,
      ],
    });

    const confirmSource = async (input: {
      donorProductId: string;
      decisionId: string;
      identityKey: string;
      title: string;
    }) => {
      const decisionEvidence = JSON.stringify({
        verdict: "EXACT_IDENTITY",
        source: input.donorProductId,
        matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
        matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
        matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      });
      await db.execute({
        sql: `INSERT INTO DonorProduct
          (id,identityKey,brand,productLine,flavor,containerType,size,title,identityStatus)
          VALUES (?,?,?,?,?,?,?,?,?)`,
        args: [
          input.donorProductId, input.identityKey, "Acme", "Crunch Chips",
          "Barbecue", "bag", "8 oz", input.title, "candidate",
        ],
      });
      await db.execute({
        sql: `INSERT INTO DonorProductVariantDecision
          (id,decisionKey,donorProductId,canonicalVariantId,decisionStatus,
           matcherVersion,matcherImplementationSha256,matcherReleaseSha256,
           evidenceHash,evidenceJson,decidedAt,createdAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          input.decisionId, `key:${input.decisionId}`, input.donorProductId,
          variant.canonicalVariantId, "exact_confirmed",
          CANONICAL_PRODUCT_MATCHER_VERSION,
          CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
          CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
          hashKey(decisionEvidence),
          decisionEvidence,
          now, now,
        ],
      });
      const projectedEvidence = JSON.stringify({
        verdict: "EXACT_IDENTITY",
        matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
        matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
        matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      });
      await db.execute({
        sql: `UPDATE DonorProduct SET identityStatus='exact_confirmed',
          identityMatcherVersion=?, identityMatcherImplementationSha256=?,
          identityMatcherReleaseSha256=?,
          identityEvidenceJson=?,identityConfirmedAt=? WHERE id=?`,
        args: [
          CANONICAL_PRODUCT_MATCHER_VERSION,
          CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
          CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
          projectedEvidence,
          now,
          input.donorProductId,
        ],
      });
    };

    await confirmSource({
      donorProductId: "target-content-donor",
      decisionId: "decision-target-content",
      identityKey: "target|acme|crunch-chips|barbecue|8oz",
      title: "Acme Crunch Chips Barbecue 8 oz",
    });
    await confirmSource({
      donorProductId: "publix-price-donor",
      decisionId: "decision-publix-price",
      identityKey: "publix|acme|crunch-chips|barbecue|8oz",
      title: "Acme Crunch Chips Barbecue 8 oz",
    });
    const contentPayload = JSON.stringify({
      title: "Acme Crunch Chips Barbecue 8 oz",
      description: "Target content description",
      ingredients: "Potatoes, oil, seasoning",
      imageUrls: ["https://target.example.test/front.jpg"],
    });
    await db.execute({
      sql: `INSERT INTO ProductContentObservation
        (id,observationKey,donorProductId,canonicalVariantId,variantDecisionId,
         sourceUrl,sourceApi,contentHash,fieldHashesJson,contentJson,observedAt,createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "content-target", hashKey("content:target"), "target-content-donor",
        variant.canonicalVariantId, "decision-target-content",
        "https://target.example.test/item", "target", hashKey(contentPayload),
        JSON.stringify({ title: HASH_A, ingredients: HASH_B }),
        contentPayload,
        older, older,
      ],
    });
    await db.execute(`INSERT INTO DonorOffer(
      id,donorProductId,retailer,retailerProductId,via
    ) VALUES ('offer-1','publix-price-donor','Publix','publix-item-1','direct')`);
    await db.execute({
      sql: `INSERT INTO DonorOfferObservation
        (id,observationKey,donorOfferId,donorProductId,canonicalVariantId,variantDecisionId,retailer,retailerProductId,
         via,title,price,packSizeSeen,pricePerUnit,currency,zip,localityEvidence,
         inStock,productUrl,sellerName,isFirstParty,sourceApi,observedAt,createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "observation-1", hashKey("offer-observation:1"), "offer-1", "publix-price-donor",
        variant.canonicalVariantId, "decision-publix-price", "Publix", "publix-item-1",
        "direct", "Acme Crunch Chips Barbecue 8 oz", 3.99, 1, 3.99, "USD", "33765",
        "zip_scoped", 1, "https://publix.example.test/item-old", "Publix", 1, "test", older, older,
      ],
    });
    await db.execute({
      sql: `INSERT INTO DonorOfferObservation
        (id,observationKey,donorOfferId,donorProductId,canonicalVariantId,variantDecisionId,retailer,retailerProductId,
         via,title,price,packSizeSeen,pricePerUnit,currency,zip,localityEvidence,
         inStock,productUrl,sellerName,isFirstParty,sourceApi,observedAt,createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "observation-2", hashKey("offer-observation:2"), "offer-1", "publix-price-donor",
        variant.canonicalVariantId, "decision-publix-price", "Publix", "publix-item-1",
        "direct", "Acme Crunch Chips Barbecue 8 oz", 4.99, 1, 4.99, "USD", "33765",
        "zip_scoped", 1, "https://publix.example.test/item-current", "Publix", 1, "test", now, now,
      ],
    });

    // A cheaper cached club observation must not leak around the default
    // non-club source policy during readback.
    await confirmSource({
      donorProductId: "costco-price-donor",
      decisionId: "decision-costco-price",
      identityKey: "costco|acme|crunch-chips|barbecue|8oz",
      title: "Acme Crunch Chips Barbecue 8 oz",
    });
    await db.execute(`INSERT INTO DonorOffer(
      id,donorProductId,retailer,retailerProductId,via
    ) VALUES ('offer-costco','costco-price-donor','Costco','costco-item-1','direct')`);
    await db.execute({
      sql: `INSERT INTO DonorOfferObservation
        (id,observationKey,donorOfferId,donorProductId,canonicalVariantId,variantDecisionId,retailer,retailerProductId,
         via,title,price,packSizeSeen,pricePerUnit,currency,zip,localityEvidence,
         inStock,productUrl,sellerName,isFirstParty,sourceApi,observedAt,createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "observation-costco", hashKey("offer-observation:costco"), "offer-costco",
        "costco-price-donor", variant.canonicalVariantId, "decision-costco-price",
        "Costco", "costco-item-1", "direct", "Acme Crunch Chips Barbecue 8 oz",
        0.99, 1, 0.99, "USD", "33765", "zip_scoped", 1,
        "https://costco.example.test/item", "Costco", 1, "test", now, now,
      ],
    });

    const first = await costOneSku(db, { sku: "SKU-1", channel: "walmart", storeIndex: 1 });
    const second = await costOneSku(db, { sku: "SKU-1", channel: "walmart", storeIndex: 1 });

    assert.equal(first.status, "costed", JSON.stringify(first));
    assert.equal(first.total, 4.99);
    assert.deepEqual(first.methods, ["exact"]);
    assert.equal(second.status, "costed", JSON.stringify(second));
    assert.equal(fetchCalls, 0);

    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) AS n FROM SkuComponent WHERE sku='SKU-1'`)).rows[0]?.n),
      0,
      "scoped canonical writer must not mutate raw-SKU legacy SkuComponent",
    );

    const authoritative = (await db.execute(`
      SELECT evidence.*, content.donorProductId AS contentDonorProductId,
             price.donorProductId AS priceDonorProductId
      FROM SkuComponentEvidence evidence
      JOIN ProductContentObservation content ON content.id=evidence.contentObservationId
      JOIN DonorOfferObservation price ON price.id=evidence.priceObservationId
    `)).rows[0];
    assert.equal(authoritative.evidenceStatus, "FACT");
    assert.equal(authoritative.targetCanonicalVariantId, variant.canonicalVariantId);
    assert.equal(authoritative.contentCanonicalVariantId, variant.canonicalVariantId);
    assert.equal(authoritative.priceCanonicalVariantId, variant.canonicalVariantId);
    assert.equal(authoritative.contentObservationId, "content-target");
    assert.equal(authoritative.priceObservationId, "observation-2");
    assert.equal(authoritative.contentDonorProductId, "target-content-donor");
    assert.equal(authoritative.priceDonorProductId, "publix-price-donor");
    assert.notEqual(authoritative.contentDonorProductId, authoritative.priceDonorProductId);
    assert.equal(authoritative.matchTier, "EXACT_IDENTITY");
    assert.equal(
      authoritative.matcherImplementationSha256,
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    );
    assert.equal(
      authoritative.matcherReleaseSha256,
      CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    );
    const persistedComponentEvidence = JSON.parse(String(authoritative.evidenceJson));
    assert.equal(
      persistedComponentEvidence.matcherImplementationSha256,
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    );
    assert.equal(
      persistedComponentEvidence.matcherReleaseSha256,
      CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    );

    const costs = await db.execute(`SELECT * FROM SkuCost WHERE sku='SKU-1'`);
    assert.equal(costs.rows.length, 1, "same immutable evidence must not append a duplicate cost row");
    assert.equal(costs.rows[0].totalCost, 4.99);
    assert.equal(costs.rows[0].evidenceOutcome, "FACT");
    assert.equal(costs.rows[0].needsReview, 0);
    assert.match(String(costs.rows[0].observationKey), /^[a-f0-9]{64}$/);
    assert.match(String(costs.rows[0].recipeHash), /^[a-f0-9]{64}$/);
    assert.equal(costs.rows[0].matcherVersion, CANONICAL_PRODUCT_MATCHER_VERSION);
    assert.equal(
      costs.rows[0].matcherImplementationSha256,
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    );
    assert.equal(
      costs.rows[0].matcherReleaseSha256,
      CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    );
    assert.equal(costs.rows[0].pricePolicyVersion, "price-evidence-eligibility/1.0.0");
    const persistedCostEvidence = JSON.parse(String(costs.rows[0].evidenceJson));
    assert.deepEqual(persistedCostEvidence.sourcePolicy, {
      policyVersion: "product-truth-cost-source-policy/1.0.0",
      retailerAllowlist: ["walmart", "target", "publix"],
      allowClubRetailers: false,
    });
    assert.equal(
      persistedCostEvidence.matcherImplementationSha256,
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    );
    assert.equal(
      persistedCostEvidence.matcherReleaseSha256,
      CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    );
    assert.match(String(costs.rows[0].evidenceJson), /observation-2/);
    assert.doesNotMatch(String(costs.rows[0].evidenceJson), /observation-1/);
    assert.match(String(costs.rows[0].evidenceJson), /https:\/\/publix\.example\.test\/item-current/);
    assert.match(String(costs.rows[0].evidenceJson), /content-target/);
    assert.doesNotMatch(String(costs.rows[0].evidenceJson), /observation-costco/);
    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) AS n FROM SkuComponentEvidence`)).rows[0]?.n),
      1,
      "same immutable recipe must not append duplicate component evidence",
    );

    const snapshot = await readProductTruthSnapshot(db, {
      sku: "SKU-1",
      channel: "walmart",
      storeIndex: 1,
      asOf: new Date(Date.now() + 1_000).toISOString(),
      maxPriceAgeMs: 48 * 60 * 60 * 1000,
    });
    assert.equal(snapshot.views.bundleFactory.ready, true);
    assert.equal(snapshot.views.listingImprovement.ready, true);
    assert.equal(snapshot.views.unitEconomics.status, "FACT");
    assert.equal(snapshot.views.procurement.ready, true);
    assert.equal(snapshot.views.bundleFactory.components[0].qty, 1);
    assert.equal(
      snapshot.views.unitEconomics.current?.matcherImplementationSha256,
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    );
    assert.equal(
      snapshot.views.unitEconomics.current?.matcherReleaseSha256,
      CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    );
    assert.equal(
      snapshot.views.bundleFactory.components[0].content?.facts.ingredients,
      "Potatoes, oil, seasoning",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await db.close();
  }
});

test("own-brand landed cost is immutable MANUAL_FACT, never a retailer offer", async () => {
  const db = createClient({ url: "file::memory:" });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("manual cost must not reach a provider");
  }) as typeof fetch;
  try {
    await createMinimalCogsSchema(db);
    const now = new Date().toISOString();
    await registerListingScope(db, "walmart", 1, "OWN-1", now);
    const identity = {
      brand: "Starfit",
      product_line: "Jump Rope",
      flavor: "Speed",
      size: null,
      container_type: "rope",
      base_unit: "one jump rope",
      units_in_listing: 1,
      unit_basis: "listing",
      is_bundle: false,
      components: [],
      confidence: 1,
      retail_search_query: "Starfit Speed Jump Rope",
      notes: "owner product",
    };
    await db.execute({
      sql: `INSERT INTO SkuShippingData
        (id,sku,marketplace,productIdentity,unitsInListing,baseUnitDesc,source,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [
        "ssd-own", "OWN-1", "Walmart", JSON.stringify(identity), 1,
        "one jump rope", "test", now, now,
      ],
    });

    const first = await costOneSku(db, { sku: "OWN-1", channel: "walmart", storeIndex: 1 });
    const second = await costOneSku(db, { sku: "OWN-1", channel: "walmart", storeIndex: 1 });
    assert.equal(first.status, "costed", JSON.stringify(first));
    assert.equal(first.total, 0.8);
    assert.equal(second.status, "costed", JSON.stringify(second));
    assert.equal(fetchCalls, 0);

    const cost = (await db.execute(`SELECT * FROM SkuCost WHERE sku='OWN-1'`)).rows[0];
    assert.equal(cost.evidenceOutcome, "FACT");
    assert.equal(cost.pricePolicyVersion, "owner-manual-cost/1.0.0");
    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) AS n FROM SkuCost WHERE sku='OWN-1'`)).rows[0]?.n),
      1,
    );

    const evidence = (await db.execute(`SELECT * FROM SkuComponentEvidence`)).rows[0];
    assert.equal(evidence.evidenceStatus, "MANUAL_FACT");
    assert.match(String(evidence.targetCanonicalVariantId), /^cpv1:[a-f0-9]{64}$/);
    assert.equal(evidence.contentCanonicalVariantId, null);
    assert.equal(evidence.priceCanonicalVariantId, null);
    assert.equal(evidence.contentObservationId, null);
    assert.equal(evidence.priceObservationId, null);
    assert.match(String(evidence.evidenceJson), /owner:vladimir:2026-07-04/);
    assert.match(String(evidence.evidenceJson), /owner-provided-cost-table/);

    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) AS n FROM SkuComponent WHERE sku='OWN-1'`)).rows[0]?.n),
      0,
      "scoped canonical writer must not mutate raw-SKU legacy SkuComponent",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await db.close();
  }
});

test("default COGS source policy is immutable, non-club, and excludes unavailable sources", () => {
  const policy = resolveCostSourcePolicy();

  assert.equal(Object.isFrozen(DEFAULT_COST_SOURCE_POLICY), true);
  assert.equal(Object.isFrozen(DEFAULT_COST_SOURCE_POLICY.retailerAllowlist), true);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.retailerAllowlist), true);
  assert.deepEqual(policy.retailerAllowlist, ["walmart", "target", "publix"]);
  assert.equal(policy.allowClubRetailers, false);
  assert.deepEqual(policy.unwrangleRetailers, ["target"]);
  assert.deepEqual(policy.openClawRetailers, ["publix"]);
  assert.equal(policy.retailerAllowlist.includes("samsclub"), false);
  assert.equal(policy.retailerAllowlist.includes("costco"), false);
  assert.equal((policy.retailerAllowlist as readonly string[]).includes("bjs"), false);
  assert.equal((policy.retailerAllowlist as readonly string[]).includes("bluecart"), false);
  assert.equal(costSourcePolicyAllowsRetailer(policy, "Target"), true);
  assert.equal(costSourcePolicyAllowsRetailer(policy, "Sam's Club"), false);
  assert.equal(costSourcePolicyAllowsRetailer(policy, "BJ's"), false);
});

test("clubs need an explicit per-run gate while BJ's and BlueCart remain impossible", () => {
  assert.throws(
    () => resolveCostSourcePolicy({
      retailerAllowlist: ["walmart", "samsclub"],
      allowClubRetailers: false,
    }),
    /COST_SOURCE_POLICY_CLUBS_DISABLED:samsclub/,
  );
  assert.throws(
    () => resolveCostSourcePolicy({
      retailerAllowlist: ["walmart", "bjs"] as unknown as readonly CostRetailer[],
      allowClubRetailers: true,
    }),
    /COST_SOURCE_POLICY_RETAILER_UNSUPPORTED:bjs/,
  );
  assert.throws(
    () => resolveCostSourcePolicy({
      retailerAllowlist: ["walmart", "bluecart"] as unknown as readonly CostRetailer[],
      allowClubRetailers: true,
    }),
    /COST_SOURCE_POLICY_RETAILER_UNSUPPORTED:bluecart/,
  );

  const explicitlyApproved = resolveCostSourcePolicy({
    retailerAllowlist: ["walmart", "target", "samsclub", "costco"],
    allowClubRetailers: true,
  });
  assert.deepEqual(explicitlyApproved.unwrangleRetailers, [
    "target",
    "samsclub",
    "costco",
  ]);
  assert.equal(costSourcePolicyAllowsRetailer(explicitlyApproved, "Sam's Club"), true);
  assert.equal(costSourcePolicyAllowsRetailer(explicitlyApproved, "Costco"), true);
  assert.equal(costSourcePolicyAllowsRetailer(explicitlyApproved, "BJ's"), false);
});

test("source policy is snapshotted before async work and cannot change by alias", () => {
  const retailerAllowlist: CostRetailer[] = ["walmart", "target"];
  const policy = resolveCostSourcePolicy({ retailerAllowlist, allowClubRetailers: false });

  retailerAllowlist.push("costco");
  assert.deepEqual(policy.retailerAllowlist, ["walmart", "target"]);
  assert.deepEqual(policy.unwrangleRetailers, ["target"]);
  assert.equal(Object.isFrozen(policy.unwrangleRetailers), true);
  assert.equal(Object.isFrozen(policy.openClawRetailers), true);
});

test("operational component execution has exactly one active task", async () => {
  assert.equal(COGS_COMPONENT_CONCURRENCY, 1);
  let active = 0;
  let maxActive = 0;
  const trace: string[] = [];

  await runCostComponentsSequentially(["a", "b", "c"], async (component) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    trace.push(`start:${component}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    trace.push(`end:${component}`);
    active -= 1;
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(trace, [
    "start:a", "end:a",
    "start:b", "end:b",
    "start:c", "end:c",
  ]);
});

test("COGS operational path has no Promise.all paid-component fanout or ambient club flag", async () => {
  const source = await readFile(new URL("../cogs-engine.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /Promise\.all\s*\(\s*targets\.map/);
  assert.match(source, /runCostComponentsSequentially\(targets,/);
  assert.match(source, /COGS_COMPONENT_CONCURRENCY\s*=\s*1/);
  assert.doesNotMatch(source, /SS_SKIP_CLUBS/);
  assert.doesNotMatch(source, /bluecartWalmartSearch|fetchBluecartDetail|provider:\s*["']bluecart["']/);
});

test("Unwrangle detail reservations use the retailer's actual credit tier", () => {
  assert.equal(Object.isFrozen(UNWRANGLE_DETAIL_CREDIT_UNITS), true);
  assert.deepEqual(UNWRANGLE_DETAIL_CREDIT_UNITS, {
    walmart: 2.5,
    target: 2.5,
    samsclub: 10,
    costco: 10,
  });
  assert.equal(unwrangleDetailCreditUnits("walmart"), 2.5);
  assert.equal(unwrangleDetailCreditUnits("target"), 2.5);
  assert.equal(unwrangleDetailCreditUnits("samsclub"), 10);
  assert.equal(unwrangleDetailCreditUnits("costco"), 10);
  assert.equal(unwrangleDetailCreditUnits("bjs"), null);
});
