import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createClient, type Client } from "@libsql/client";

import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../canonical-product-match-provenance";
import {
  PRICE_EVIDENCE_POLICY_VERSION,
} from "../price-evidence-policy";
import {
  buildProductTruthSiblingEstimate,
  materializeProductTruthSiblingEstimate,
  type ProductTruthSiblingEstimateInput,
} from "../product-truth-sibling-estimate";

const MANIFEST = "a".repeat(64);
const ARTIFACT = "b".repeat(64);
const TARGET_VARIANT = `cpv1:${"c".repeat(64)}`;
const PRICE_VARIANT = `cpv1:${"d".repeat(64)}`;
const CONTENT_DONOR = "content-donor";
const PRICE_DONOR = "price-donor";
const CONTENT_DECISION = "content-decision";
const PRICE_DECISION = "price-decision";
const CONTENT_OBSERVATION = "pco:content";
const PRICE_OBSERVATION = "doo:price";
const PRICE_OFFER = "do:walmart:10450893";
const CREATED_AT = "2026-07-29T16:00:00.000Z";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function input(
  overrides: Partial<ProductTruthSiblingEstimateInput> = {},
): ProductTruthSiblingEstimateInput {
  return {
    listingKey: "walmart:1:FaisalX-1433",
    manifestSha256: MANIFEST,
    sku: "FaisalX-1433",
    quantity: 24,
    product: "Maruchan Instant Lunch",
    flavor: "Roast Chicken",
    size: "2.25 oz cup",
    targetCanonicalVariantId: TARGET_VARIANT,
    contentDonorProductId: CONTENT_DONOR,
    contentVariantDecisionId: CONTENT_DECISION,
    contentObservationId: CONTENT_OBSERVATION,
    priceCanonicalVariantId: PRICE_VARIANT,
    priceDonorProductId: PRICE_DONOR,
    priceVariantDecisionId: PRICE_DECISION,
    priceOfferId: PRICE_OFFER,
    priceObservationId: PRICE_OBSERVATION,
    pricePerUnit: 0.64,
    packagingCost: 1.5,
    sourceArtifactSha256: ARTIFACT,
    evaluatedAt: CREATED_AT,
    createdAt: CREATED_AT,
    effectiveDate: "2026-07-29",
    runId: "maruchan-repair-run",
    approvalId: "owner-decision-g8a",
    sourceEvidence: {
      exactContent: "Roast Chicken",
      priceProxy: "Chicken",
    },
    ...overrides,
  };
}

async function createBaseSchema(db: Client): Promise<void> {
  await db.executeMultiple(`
    PRAGMA foreign_keys=ON;
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
    CREATE UNIQUE INDEX donor_offer_dedup
      ON DonorOffer(retailer, retailerProductId);
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
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX SkuCost_sku_source_effectiveDate_key
      ON SkuCost(sku, source, effectiveDate);
    CREATE TABLE ProductTruthMigrationReceipt (
      migrationId TEXT PRIMARY KEY,
      migrationSha256 TEXT NOT NULL,
      targetFingerprint TEXT NOT NULL,
      action TEXT NOT NULL,
      appliedAt DATETIME NOT NULL
    );
  `);
  for (const relative of [
    "../../../../prisma/migrations/20260718234500_product_truth_evidence_provenance/migration.sql",
    "../../../../prisma/migrations/20260719002000_product_truth_listing_scope/migration.sql",
    "../../../../prisma/migrations/20260729010000_product_truth_listing_recipe/migration.sql",
  ]) {
    await db.executeMultiple(await readFile(new URL(relative, import.meta.url), "utf8"));
  }
}

async function insertVariant(db: Client, id: string, flavor: string): Promise<void> {
  const identityHash = id.replace(/^cpv1:/u, "");
  await db.execute({
    sql: `INSERT INTO CanonicalProductVariant (
      id,variantKey,identityHash,keyVersion,normalizedBrand,
      normalizedProductLine,normalizedFlavor,normalizedModifiersJson,
      normalizedForm,sizeDimension,sizeBaseAmount,sizeBaseUnit,outerPackCount,
      identityJson,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      id, id, identityHash, "canonical-product-variant-key/1.0.0",
      "maruchan", "instant lunch", flavor, "[]", "cup", "MASS",
      63.78642703125, "g", 1,
      JSON.stringify({ brand: "maruchan", flavor, size: "2.25 oz" }),
      CREATED_AT,
    ],
  });
}

async function insertDecision(
  db: Client,
  id: string,
  donorProductId: string,
  variantId: string,
): Promise<string> {
  const evidenceJson = JSON.stringify({
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  });
  await db.execute({
    sql: `INSERT INTO DonorProductVariantDecision (
      id,decisionKey,donorProductId,canonicalVariantId,decisionStatus,
      matcherVersion,matcherImplementationSha256,matcherReleaseSha256,
      evidenceHash,evidenceJson,decidedAt,runId,approvalId,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      id, id, donorProductId, variantId, "exact_confirmed",
      CANONICAL_PRODUCT_MATCHER_VERSION,
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      hash(evidenceJson), evidenceJson, CREATED_AT, null, null, CREATED_AT,
    ],
  });
  return evidenceJson;
}

async function seedGraph(db: Client): Promise<void> {
  await db.execute({
    sql: `INSERT INTO ProductTruthListingScope (
      listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
      manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
      sourceReportId,sourceContentSha256,sourceCapturedAt,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      "walmart:1:FaisalX-1433", "product-truth-listing-key/1.0.0",
      "walmart", 1, "FaisalX-1433", "AUTHORITATIVE_PHASE1_MANIFEST",
      "phase1-authoritative-scope-manifest/v3", MANIFEST, CREATED_AT,
      "owner-scope", "source-report", "e".repeat(64), CREATED_AT, CREATED_AT,
    ],
  });
  await insertVariant(db, TARGET_VARIANT, "chicken roast");
  await insertVariant(db, PRICE_VARIANT, "chicken");
  for (const [id, flavor] of [
    [CONTENT_DONOR, "Roast Chicken"],
    [PRICE_DONOR, "Chicken"],
  ] as const) {
    await db.execute({
      sql: `INSERT INTO DonorProduct (
        id,identityKey,brand,productLine,flavor,containerType,size,identityStatus
      ) VALUES (?,?,?,?,?,?,?,'candidate')`,
      args: [
        id, id, "Maruchan", "Instant Lunch", flavor, "cup", "2.25 oz",
      ],
    });
  }
  const contentDecisionEvidence = await insertDecision(
    db,
    CONTENT_DECISION,
    CONTENT_DONOR,
    TARGET_VARIANT,
  );
  const priceDecisionEvidence = await insertDecision(
    db,
    PRICE_DECISION,
    PRICE_DONOR,
    PRICE_VARIANT,
  );
  for (const [id, evidence] of [
    [CONTENT_DONOR, contentDecisionEvidence],
    [PRICE_DONOR, priceDecisionEvidence],
  ] as const) {
    await db.execute({
      sql: `UPDATE DonorProduct SET
        identityStatus='exact_confirmed',
        identityMatcherVersion=?,
        identityMatcherImplementationSha256=?,
        identityMatcherReleaseSha256=?,
        identityEvidenceJson=?,
        identityConfirmedAt=?
        WHERE id=?`,
      args: [
        CANONICAL_PRODUCT_MATCHER_VERSION,
        CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
        CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
        evidence,
        CREATED_AT,
        id,
      ],
    });
  }
  await db.execute({
    sql: `INSERT INTO DonorOffer
      (id,donorProductId,retailer,retailerProductId,via)
      VALUES (?,?,?,?,?)`,
    args: [PRICE_OFFER, PRICE_DONOR, "walmart", "10450893", "direct"],
  });
  const contentJson = JSON.stringify({
    title: "Maruchan Instant Lunch Roast Chicken Flavor, 2.25 oz Cup",
  });
  await db.execute({
    sql: `INSERT INTO ProductContentObservation (
      id,observationKey,donorProductId,canonicalVariantId,variantDecisionId,
      sourceUrl,sourceApi,contentHash,fieldHashesJson,contentJson,observedAt,
      runId,approvalId,meteredReceiptId,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      CONTENT_OBSERVATION, hash("content-observation"), CONTENT_DONOR,
      TARGET_VARIANT, CONTENT_DECISION,
      "https://maruchan.com/products/instant-lunch/roast-chicken-flavor-ramen-cup",
      "official_maruchan", hash(contentJson),
      JSON.stringify({ title: hash(JSON.stringify("title")) }),
      contentJson, CREATED_AT, null, null, null, CREATED_AT,
    ],
  });
  await db.execute({
    sql: `INSERT INTO DonorOfferObservation (
      id,observationKey,donorOfferId,donorProductId,canonicalVariantId,
      variantDecisionId,retailer,retailerProductId,via,title,price,packSizeSeen,
      pricePerUnit,currency,zip,localityEvidence,inStock,productUrl,sellerName,
      isFirstParty,sourceApi,observedAt,runId,approvalId,meteredReceiptId,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      PRICE_OBSERVATION, hash("price-observation"), PRICE_OFFER, PRICE_DONOR,
      PRICE_VARIANT, PRICE_DECISION, "walmart", "10450893", "direct",
      "Maruchan Instant Lunch Chicken Flavor, 2.25 oz Cup", 0.64, 1, 0.64,
      "USD", "33765", "zip_scoped", 1, "https://www.walmart.com/ip/10450893",
      "Walmart.com", 1, "owner_accepted_composite_walmart_evidence",
      CREATED_AT, null, null, null, CREATED_AT,
    ],
  });
}

test("builds a typed sibling estimate with separate product and packaging cost", () => {
  const result = buildProductTruthSiblingEstimate(input());
  assert.equal(result.cost.evidenceOutcome, "ESTIMATE");
  assert.equal(result.componentEvidence.evidenceStatus, "ESTIMATE");
  assert.equal(result.componentEvidence.matchTier, "SIBLING_ESTIMATE");
  assert.equal(result.cost.productCost, 15.36);
  assert.equal(result.cost.packagingCost, 1.5);
  assert.equal(result.cost.totalCost, 16.86);
  assert.equal(result.cost.costPerUnit, 0.7025);
  assert.notEqual(
    result.componentEvidence.targetCanonicalVariantId,
    result.componentEvidence.priceCanonicalVariantId,
  );
});

test("rejects a same-variant input instead of mislabelling it as sibling", () => {
  assert.throws(
    () => buildProductTruthSiblingEstimate(input({
      priceCanonicalVariantId: TARGET_VARIANT,
    })),
    /price variant must be a sibling/u,
  );
});

test("passes immutable Product Truth database triggers and is idempotent", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await seedGraph(db);
    const first = await materializeProductTruthSiblingEstimate(db, input());
    assert.equal(first.status, "APPLIED");
    assert.equal(first.totalCost, 16.86);
    const second = await materializeProductTruthSiblingEstimate(db, input());
    assert.equal(second.status, "ALREADY_APPLIED");
    const current = (await db.execute({
      sql: `SELECT cost.evidenceOutcome,cost.productCost,cost.packagingCost,
                   cost.totalCost,evidence.evidenceStatus,evidence.matchTier
            FROM SkuCost cost
            JOIN SkuComponentEvidence evidence ON evidence.skuCostId=cost.id`,
    })).rows[0];
    assert.deepEqual(
      {
        evidenceOutcome: current?.evidenceOutcome,
        productCost: Number(current?.productCost),
        packagingCost: Number(current?.packagingCost),
        totalCost: Number(current?.totalCost),
        evidenceStatus: current?.evidenceStatus,
        matchTier: current?.matchTier,
      },
      {
        evidenceOutcome: "ESTIMATE",
        productCost: 15.36,
        packagingCost: 1.5,
        totalCost: 16.86,
        evidenceStatus: "ESTIMATE",
        matchTier: "SIBLING_ESTIMATE",
      },
    );
  } finally {
    db.close();
  }
});
