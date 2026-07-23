import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createClient, type Client, type InStatement } from "@libsql/client";

import {
  ProductTruthSchemaNotReadyError,
  assertDonorHarvestSchema,
  assertProductTruthEvidenceSchema,
  assertProductTruthMeteredEvidenceSchema,
} from "../product-truth-schema-gate";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../canonical-product-match-provenance";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const VARIANT_1 = `cpv1:${HASH_A}`;
const VARIANT_2 = `cpv1:${HASH_B}`;
const MATCHER_VERSION = CANONICAL_PRODUCT_MATCHER_VERSION;
const MATCHER_IMPLEMENTATION_SHA256 = CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256;
const MATCHER_RELEASE_SHA256 = CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256;

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createBaseSchema(db: Client): Promise<void> {
  await db.executeMultiple(`
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
  `);
}

async function applyEvidenceMigration(db: Client): Promise<void> {
  const evidenceMigration = new URL(
    "../../../../prisma/migrations/20260718234500_product_truth_evidence_provenance/migration.sql",
    import.meta.url,
  );
  await db.executeMultiple(await readFile(evidenceMigration, "utf8"));
}

async function insertVariant(
  db: Client,
  id: string,
  hash: string,
  flavor: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO CanonicalProductVariant (
      id,variantKey,identityHash,keyVersion,normalizedBrand,normalizedProductLine,
      normalizedFlavor,normalizedModifiersJson,normalizedForm,sizeDimension,
      sizeBaseAmount,sizeBaseUnit,outerPackCount,identityJson,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      id, id, hash, "canonical-product-variant-key/1.0.0", "acme", "crunch chips",
      flavor, "[]", "bag", "MASS", 226.796185, "g", 1,
      JSON.stringify({ brand: "acme", productLine: "crunch chips", flavor }),
      "2026-07-18T18:00:00.000Z",
    ],
  });
}

async function confirmSource(
  db: Client,
  input: {
    donorProductId: string;
    decisionId: string;
    variantId: string;
    flavor?: string;
  },
): Promise<void> {
  const flavor = input.flavor ?? "barbecue";
  await db.execute({
    sql: `INSERT INTO DonorProduct (
      id,identityKey,brand,productLine,flavor,containerType,size,identityStatus
    ) VALUES (?,?,?,?,?,?,?,'candidate')`,
    args: [
      input.donorProductId, `${input.donorProductId}:source`, "Acme", "Crunch Chips",
      flavor, "bag", "8 oz",
    ],
  });
  await db.execute({
    sql: `INSERT INTO DonorProductVariantDecision (
      id,decisionKey,donorProductId,canonicalVariantId,decisionStatus,
      matcherVersion,matcherImplementationSha256,matcherReleaseSha256,
      evidenceHash,evidenceJson,decidedAt,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      input.decisionId, `decision:${input.decisionId}`, input.donorProductId,
      input.variantId, "exact_confirmed", MATCHER_VERSION,
      MATCHER_IMPLEMENTATION_SHA256, MATCHER_RELEASE_SHA256, HASH_C,
      JSON.stringify({
        verdict: "EXACT_IDENTITY",
        source: input.donorProductId,
        matcherVersion: MATCHER_VERSION,
        matcherImplementationSha256: MATCHER_IMPLEMENTATION_SHA256,
        matcherReleaseSha256: MATCHER_RELEASE_SHA256,
      }),
      "2026-07-18T18:30:00.000Z", "2026-07-18T18:30:00.000Z",
    ],
  });
  await db.execute({
    sql: `UPDATE DonorProduct SET
      identityStatus='exact_confirmed', identityMatcherVersion=?,
      identityMatcherImplementationSha256=?, identityMatcherReleaseSha256=?,
      identityEvidenceJson=?, identityConfirmedAt='2026-07-18T18:30:00.000Z'
      WHERE id=?`,
    args: [
      MATCHER_VERSION,
      MATCHER_IMPLEMENTATION_SHA256,
      MATCHER_RELEASE_SHA256,
      JSON.stringify({
        verdict: "EXACT_IDENTITY",
        matcherVersion: MATCHER_VERSION,
        matcherImplementationSha256: MATCHER_IMPLEMENTATION_SHA256,
        matcherReleaseSha256: MATCHER_RELEASE_SHA256,
      }),
      input.donorProductId,
    ],
  });
}

type ExactGraph = {
  contentId: string;
  priceId: string;
  offerId: string;
  contentDonorId: string;
  priceDonorId: string;
  contentDecisionId: string;
  priceDecisionId: string;
};

async function seedExactGraph(
  db: Client,
  prefix: string,
  observedAt = "2026-07-18T19:00:00.000Z",
): Promise<ExactGraph> {
  const contentDonorId = `${prefix}-content-donor`;
  const priceDonorId = `${prefix}-price-donor`;
  const contentDecisionId = `${prefix}-content-decision`;
  const priceDecisionId = `${prefix}-price-decision`;
  const contentId = `${prefix}-content`;
  const priceId = `${prefix}-price`;
  const offerId = `${prefix}-offer`;
  await confirmSource(db, {
    donorProductId: contentDonorId,
    decisionId: contentDecisionId,
    variantId: VARIANT_1,
  });
  await confirmSource(db, {
    donorProductId: priceDonorId,
    decisionId: priceDecisionId,
    variantId: VARIANT_1,
  });
  const contentJson = JSON.stringify({
    title: "Acme Crunch Chips Barbecue",
    ingredients: "Potatoes, oil, seasoning",
  });
  await db.execute({
    sql: `INSERT INTO ProductContentObservation (
      id,observationKey,donorProductId,canonicalVariantId,variantDecisionId,
      sourceUrl,sourceApi,contentHash,fieldHashesJson,contentJson,observedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      contentId, hashKey(`content:${prefix}`), contentDonorId, VARIANT_1,
      contentDecisionId, `https://content.example/${prefix}`, "test",
      hashKey(contentJson), JSON.stringify({ title: HASH_A }), contentJson, observedAt,
    ],
  });
  await db.execute({
    sql: `INSERT INTO DonorOffer(
      id,donorProductId,retailer,retailerProductId,via
    ) VALUES (?,?,?,?,?)`,
    args: [offerId, priceDonorId, "walmart", `${prefix}-item`, "direct"],
  });
  await db.execute({
    sql: `INSERT INTO DonorOfferObservation (
      id,observationKey,donorOfferId,donorProductId,canonicalVariantId,
      variantDecisionId,retailer,retailerProductId,via,price,pricePerUnit,
      currency,zip,localityEvidence,inStock,productUrl,sellerName,isFirstParty,
      sourceApi,observedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      priceId, hashKey(`price:${prefix}`), offerId, priceDonorId, VARIANT_1,
      priceDecisionId, "walmart", `${prefix}-item`, "direct", 3.99, 3.99,
      "USD", "33765", "zip_scoped", 1, `https://walmart.example/${prefix}`,
      "Walmart", 1, "test", observedAt,
    ],
  });
  return {
    contentId,
    priceId,
    offerId,
    contentDonorId,
    priceDonorId,
    contentDecisionId,
    priceDecisionId,
  };
}

function exactEvidenceStatement(input: {
  id: string;
  costId: string;
  index: number;
  contentId: string;
  priceId: string;
  perUnit?: number;
  qty?: number;
}): InStatement {
  const evidenceJson = JSON.stringify({
    evidenceStatus: "FACT",
    targetCanonicalVariantId: VARIANT_1,
    contentCanonicalVariantId: VARIANT_1,
    priceCanonicalVariantId: VARIANT_1,
    contentObservationId: input.contentId,
    priceObservationId: input.priceId,
    product: "Acme Crunch Chips",
    flavor: "barbecue",
    size: "8 oz",
    qty: input.qty ?? 1,
    perUnit: input.perUnit ?? 3.99,
    method: "exact",
    targetComparableUnitPrice: null,
    matchTier: "EXACT_IDENTITY",
    matcherVersion: MATCHER_VERSION,
    matcherImplementationSha256: MATCHER_IMPLEMENTATION_SHA256,
    matcherReleaseSha256: MATCHER_RELEASE_SHA256,
    pricePolicyVersion: "price-evidence-eligibility/1.0.0",
  });
  return {
    sql: `INSERT INTO SkuComponentEvidence (
      id,evidenceKey,skuCostId,componentIndex,evidenceStatus,
      targetCanonicalVariantId,contentCanonicalVariantId,priceCanonicalVariantId,
      contentObservationId,priceObservationId,matchTier,matcherVersion,
      matcherImplementationSha256,matcherReleaseSha256,
      pricePolicyVersion,evidenceHash,evidenceJson
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      input.id, hashKey(`evidence:${input.id}`), input.costId, input.index, "FACT",
      VARIANT_1, VARIANT_1, VARIANT_1, input.contentId, input.priceId,
      "EXACT_IDENTITY", MATCHER_VERSION,
      MATCHER_IMPLEMENTATION_SHA256, MATCHER_RELEASE_SHA256,
      "price-evidence-eligibility/1.0.0", hashKey(evidenceJson), evidenceJson,
    ],
  };
}

function costStatement(input: {
  id: string;
  sku: string;
  observationSeed: string;
  recipeSeed: string;
  effectiveDate?: string;
  evaluatedAt?: string;
  productCost?: number;
  packagingCost?: number | null;
  iceCost?: number | null;
  totalCost?: number;
  costPerUnit?: number;
  packSize?: number;
  components?: Array<{
    idx: number;
    priceEvidenceStatus: string;
    perUnit: number;
    qty: number;
    targetCanonicalVariantId?: string;
    contentCanonicalVariantId?: string | null;
    priceCanonicalVariantId?: string | null;
    contentObservationId?: string | null;
    priceEvidenceObservationId?: string | null;
  }>;
  source?: string;
  exactGraph?: ExactGraph;
}): InStatement {
  const effectiveDate = input.effectiveDate ?? "2026-07-18T19:05:00.000Z";
  const evaluatedAt = input.evaluatedAt ?? "2026-07-18T19:05:00.000Z";
  const productCost = input.productCost ?? 3.99;
  const totalCost = input.totalCost ?? productCost + (input.packagingCost ?? 0) + (input.iceCost ?? 0);
  const packSize = input.packSize ?? 1;
  const recipeHash = hashKey(input.recipeSeed);
  const components = (input.components ?? [
    { idx: 0, priceEvidenceStatus: "FACT", perUnit: productCost / packSize, qty: packSize },
  ]).map((component) => {
    const hasRetailPrice = component.priceEvidenceStatus === "FACT"
      || component.priceEvidenceStatus === "ESTIMATE";
    const hasExactContent = component.priceEvidenceStatus === "FACT";
    return {
      product: "Acme Crunch Chips",
      flavor: "barbecue",
      size: "8 oz",
      method: component.priceEvidenceStatus === "MANUAL_FACT" ? "own-brand"
        : component.priceEvidenceStatus === "REJECT" ? "unsourceable" : "exact",
      targetCanonicalVariantId: VARIANT_1,
      contentCanonicalVariantId: hasExactContent ? VARIANT_1 : null,
      priceCanonicalVariantId: hasRetailPrice ? VARIANT_1 : null,
      contentDonorProductId: hasExactContent
        ? input.exactGraph?.contentDonorId ?? null : null,
      priceEvidenceDonorProductId: hasRetailPrice
        ? input.exactGraph?.priceDonorId ?? null : null,
      priceEvidenceOfferId: hasRetailPrice
        ? input.exactGraph?.offerId ?? null : null,
      priceEvidenceObservationId: hasRetailPrice
        ? input.exactGraph?.priceId ?? null : null,
      contentObservationId: hasExactContent
        ? input.exactGraph?.contentId ?? null : null,
      priceVariantDecisionId: hasRetailPrice
        ? input.exactGraph?.priceDecisionId ?? null : null,
      matchTier: component.priceEvidenceStatus === "MANUAL_FACT" ? "MANUAL_COST"
        : component.priceEvidenceStatus === "REJECT" ? "REJECT" : "EXACT_IDENTITY",
      matcherVersion: MATCHER_VERSION,
      matcherImplementationSha256: MATCHER_IMPLEMENTATION_SHA256,
      matcherReleaseSha256: MATCHER_RELEASE_SHA256,
      pricePolicyVersion: component.priceEvidenceStatus === "MANUAL_FACT"
        ? "owner-manual-cost/1.0.0" : "price-evidence-eligibility/1.0.0",
      ...component,
    };
  });
  const evidenceJson = JSON.stringify({
    outcome: "FACT",
    recipeHash,
    evaluatedAt,
    matcherVersion: MATCHER_VERSION,
    matcherImplementationSha256: MATCHER_IMPLEMENTATION_SHA256,
    matcherReleaseSha256: MATCHER_RELEASE_SHA256,
    total: totalCost,
    costPerUnit: input.costPerUnit ?? totalCost / packSize,
    packSize,
    components,
  });
  return {
    sql: `INSERT INTO SkuCost (
      id,sku,effectiveDate,productCost,packagingCost,iceCost,totalCost,costPerUnit,
      packSize,source,observationKey,recipeHash,evidenceJson,evidenceOutcome,
      matcherVersion,matcherImplementationSha256,matcherReleaseSha256,
      pricePolicyVersion,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      input.id, input.sku, effectiveDate, productCost,
      input.packagingCost ?? null, input.iceCost ?? null, totalCost,
      input.costPerUnit ?? totalCost / packSize, packSize,
      input.source ?? "retail:batch", hashKey(input.observationSeed),
      recipeHash, evidenceJson, "FACT",
      MATCHER_VERSION, MATCHER_IMPLEMENTATION_SHA256, MATCHER_RELEASE_SHA256,
      "price-evidence-eligibility/1.0.0",
      "2026-07-18T19:06:00.000Z", "2026-07-18T19:06:00.000Z",
    ],
  };
}

test("evidence and harvest paths fail closed before their migrations", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await db.execute(`CREATE TABLE DonorOffer (id TEXT PRIMARY KEY)`);
    await db.execute(`CREATE TABLE SkuComponent (id TEXT PRIMARY KEY, donorProductId TEXT)`);
    await assert.rejects(
      assertProductTruthEvidenceSchema(db),
      (error) =>
        error instanceof ProductTruthSchemaNotReadyError
        && error.missing.includes("CanonicalProductVariant"),
    );
    await assert.rejects(
      assertDonorHarvestSchema(db),
      (error) =>
        error instanceof ProductTruthSchemaNotReadyError
        && error.missing.includes("DonorHarvestState"),
    );
  } finally {
    await db.close();
  }
});

test("matcher provenance tuple is exact and JSON-bound across canonical evidence", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await applyEvidenceMigration(db);
    await insertVariant(db, VARIANT_1, HASH_A, "barbecue");
    await db.execute(`INSERT INTO DonorProduct (
      id,identityKey,brand,productLine,flavor,containerType,size,identityStatus
    ) VALUES ('tuple-source','tuple-source:key','Acme','Crunch Chips','barbecue','bag','8 oz','candidate')`);

    const decisionEvidence = {
      verdict: "EXACT_IDENTITY",
      matcherVersion: MATCHER_VERSION,
      matcherImplementationSha256: MATCHER_IMPLEMENTATION_SHA256,
      matcherReleaseSha256: MATCHER_RELEASE_SHA256,
    };
    const decisionStatement = (
      id: string,
      matcherReleaseSha256: string,
      evidenceJson: string,
    ): InStatement => ({
      sql: `INSERT INTO DonorProductVariantDecision (
        id,decisionKey,donorProductId,canonicalVariantId,decisionStatus,
        matcherVersion,matcherImplementationSha256,matcherReleaseSha256,
        evidenceHash,evidenceJson,decidedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id, `decision:${id}`, "tuple-source", VARIANT_1, "exact_confirmed",
        MATCHER_VERSION, MATCHER_IMPLEMENTATION_SHA256, matcherReleaseSha256,
        HASH_C, evidenceJson, "2026-07-18T18:30:00.000Z",
      ],
    });
    await assert.rejects(
      db.execute(decisionStatement(
        "tuple-wrong-release",
        HASH_A,
        JSON.stringify({ ...decisionEvidence, matcherReleaseSha256: HASH_A }),
      )),
      /CHECK constraint failed/,
    );
    await assert.rejects(
      db.execute(decisionStatement(
        "tuple-json-mismatch",
        MATCHER_RELEASE_SHA256,
        JSON.stringify({ ...decisionEvidence, matcherReleaseSha256: HASH_A }),
      )),
      /CHECK constraint failed/,
    );
    await db.execute(decisionStatement(
      "tuple-decision",
      MATCHER_RELEASE_SHA256,
      JSON.stringify(decisionEvidence),
    ));

    await assert.rejects(
      db.execute({
        sql: `UPDATE DonorProduct SET
          identityStatus='exact_confirmed', identityMatcherVersion=?,
          identityMatcherImplementationSha256=?, identityMatcherReleaseSha256=?,
          identityEvidenceJson=?, identityConfirmedAt='2026-07-18T18:30:00.000Z'
          WHERE id='tuple-source'`,
        args: [
          MATCHER_VERSION,
          MATCHER_IMPLEMENTATION_SHA256,
          MATCHER_RELEASE_SHA256,
          JSON.stringify({ ...decisionEvidence, matcherReleaseSha256: HASH_A }),
        ],
      }),
      /DONOR_PRODUCT_EXACT_CONTRACT_INVALID/,
    );
    await db.execute({
      sql: `UPDATE DonorProduct SET
        identityStatus='exact_confirmed', identityMatcherVersion=?,
        identityMatcherImplementationSha256=?, identityMatcherReleaseSha256=?,
        identityEvidenceJson=?, identityConfirmedAt='2026-07-18T18:30:00.000Z'
        WHERE id='tuple-source'`,
      args: [
        MATCHER_VERSION,
        MATCHER_IMPLEMENTATION_SHA256,
        MATCHER_RELEASE_SHA256,
        JSON.stringify(decisionEvidence),
      ],
    });

    const graph = await seedExactGraph(db, "tuple");
    const badComponent = exactEvidenceStatement({
      id: "tuple-bad-component",
      costId: "tuple-bad-cost",
      index: 0,
      contentId: graph.contentId,
      priceId: graph.priceId,
    });
    if (typeof badComponent === "string") assert.fail("component evidence must be parameterized");
    const badComponentArgs = [...badComponent.args];
    const badComponentJson = JSON.parse(String(badComponentArgs[16])) as Record<string, unknown>;
    badComponentArgs[16] = JSON.stringify({
      ...badComponentJson,
      matcherImplementationSha256: HASH_A,
    });
    await assert.rejects(
      db.execute({ ...badComponent, args: badComponentArgs }),
      /SKU_COMPONENT_EVIDENCE_METADATA_INVALID/,
    );

    const badCost = costStatement({
      id: "tuple-cost-json-mismatch",
      sku: "SKU-TUPLE-MISMATCH",
      observationSeed: "tuple-cost-observation",
      recipeSeed: "tuple-cost-recipe",
      exactGraph: graph,
    });
    if (typeof badCost === "string") assert.fail("cost evidence must be parameterized");
    const badCostArgs = [...badCost.args];
    const badCostJson = JSON.parse(String(badCostArgs[12])) as Record<string, unknown>;
    badCostArgs[12] = JSON.stringify({
      ...badCostJson,
      matcherReleaseSha256: HASH_A,
    });
    await assert.rejects(
      db.batch([
        exactEvidenceStatement({
          id: "tuple-cost-child",
          costId: "tuple-cost-json-mismatch",
          index: 0,
          contentId: graph.contentId,
          priceId: graph.priceId,
        }),
        { ...badCost, args: badCostArgs },
      ], "write"),
      /SKU_COST_EVIDENCE_REQUIRED/,
    );
  } finally {
    await db.close();
  }
});

test("paid observations require a succeeded receipt for the same provider, run, and approval", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await applyEvidenceMigration(db);
    await assert.rejects(
      assertProductTruthMeteredEvidenceSchema(db),
      (error) => error instanceof ProductTruthSchemaNotReadyError
        && error.missing.includes("MeteredProviderBudget"),
    );

    const ledgerMigration = new URL(
      "../../../../prisma/migrations/20260719000000_metered_budget_ledger/migration.sql",
      import.meta.url,
    );
    await db.executeMultiple(await readFile(ledgerMigration, "utf8"));
    await assert.rejects(
      assertProductTruthMeteredEvidenceSchema(db),
      (error) => error instanceof ProductTruthSchemaNotReadyError
        && error.missing.includes(
          "trigger:DonorOfferObservation_metered_receipt_guard",
        ),
    );

    const linkMigration = new URL(
      "../../../../prisma/migrations/20260719001000_product_truth_metered_evidence_link/migration.sql",
      import.meta.url,
    );
    await db.executeMultiple(await readFile(linkMigration, "utf8"));
    await assertProductTruthMeteredEvidenceSchema(db);

    await insertVariant(db, VARIANT_1, HASH_A, "barbecue");
    await confirmSource(db, {
      donorProductId: "metered-source",
      decisionId: "metered-decision",
      variantId: VARIANT_1,
    });
    await db.execute(`INSERT INTO DonorOffer(
      id,donorProductId,retailer,retailerProductId,via
    ) VALUES ('metered-offer','metered-source','walmart','metered-item','direct')`);
    await db.execute({
      sql: `INSERT INTO MeteredProviderBudget (
        id,permitVersion,runId,approvalId,approvedBy,provider,issuedAt,expiresAt,
        operations,maxCalls,maxUnitsMicros,reservedCalls,reservedUnitsMicros,
        createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "metered-budget", 1, "metered-run", "owner-approval-1", "owner",
        "unwrangle", "2026-07-18T18:00:00.000Z", "2026-07-19T18:00:00.000Z",
        JSON.stringify(["search"]), 1, 1_000_000, 0, 0,
        "2026-07-18T18:00:00.000Z", "2026-07-18T18:00:00.000Z",
      ],
    });
    await db.execute({
      sql: `INSERT INTO MeteredReservationReceipt (
        id,budgetId,reservationKey,operation,unitsMicros,status,failureCode,
        createdAt,reservedAt,settledAt,updatedAt
      ) VALUES (?,?,?,?,?,'pending',NULL,?,NULL,NULL,?)`,
      args: [
        "metered-receipt", "metered-budget", "metered-search-1", "search",
        1_000_000, "2026-07-18T18:00:30.000Z", "2026-07-18T18:00:30.000Z",
      ],
    });
    await db.execute(`UPDATE MeteredProviderBudget
      SET reservedCalls=1,reservedUnitsMicros=1000000,
          updatedAt='2026-07-18T18:00:31.000Z'
      WHERE id='metered-budget'`);
    await db.execute(`UPDATE MeteredReservationReceipt
      SET status='reserved',reservedAt='2026-07-18T18:00:31.000Z',
          updatedAt='2026-07-18T18:00:31.000Z'
      WHERE id='metered-receipt'`);
    await db.execute(`INSERT INTO MeteredReservationSettlement(
      id,reservationId,outcome,detail,settledAt
    ) VALUES (
      'metered-settlement','metered-receipt','success',NULL,
      '2026-07-18T18:00:32.000Z'
    )`);

    const priceObservation = (
      id: string,
      runId: string,
      receiptId: string | null,
    ): InStatement => ({
      sql: `INSERT INTO DonorOfferObservation (
        id,observationKey,donorOfferId,donorProductId,canonicalVariantId,
        variantDecisionId,retailer,retailerProductId,via,price,pricePerUnit,
        currency,zip,localityEvidence,inStock,productUrl,sellerName,isFirstParty,
        sourceApi,observedAt,runId,approvalId,meteredReceiptId
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id, hashKey(`metered-price:${id}`), "metered-offer", "metered-source",
        VARIANT_1, "metered-decision", "walmart", "metered-item", "direct",
        3.99, 3.99, "USD", "33765", "zip_scoped", 1,
        "https://walmart.example/metered-item", "Walmart", 1, "unwrangle",
        "2026-07-18T19:00:00.000Z", runId, "owner-approval-1", receiptId,
      ],
    });
    await assert.rejects(
      db.execute(priceObservation("metered-price-missing", "metered-run", null)),
      /DONOR_OFFER_OBSERVATION_METERED_RECEIPT_INVALID/,
    );
    await assert.rejects(
      db.execute(priceObservation(
        "metered-price-wrong-run", "different-run", "metered-receipt",
      )),
      /DONOR_OFFER_OBSERVATION_METERED_RECEIPT_INVALID/,
    );
    await db.execute(priceObservation(
      "metered-price-valid", "metered-run", "metered-receipt",
    ));

    const contentJson = JSON.stringify({
      title: "Acme Crunch Chips Barbecue",
      ingredients: "Potatoes, oil, seasoning",
    });
    const contentObservation = (
      id: string,
      receiptId: string | null,
    ): InStatement => ({
      sql: `INSERT INTO ProductContentObservation (
        id,observationKey,donorProductId,canonicalVariantId,variantDecisionId,
        sourceUrl,sourceApi,contentHash,fieldHashesJson,contentJson,observedAt,
        runId,approvalId,meteredReceiptId
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id, hashKey(`metered-content:${id}`), "metered-source", VARIANT_1,
        "metered-decision", "https://walmart.example/metered-item", "unwrangle",
        hashKey(contentJson), JSON.stringify({ title: HASH_A }), contentJson,
        "2026-07-18T19:00:00.000Z", "metered-run", "owner-approval-1", receiptId,
      ],
    });
    await assert.rejects(
      db.execute(contentObservation("metered-content-missing", null)),
      /PRODUCT_CONTENT_OBSERVATION_METERED_RECEIPT_INVALID/,
    );
    await db.execute(contentObservation("metered-content-valid", "metered-receipt"));

    // The evidence link independently checks that the receipt operation still
    // belongs to the budget contract, even if an inconsistent legacy database
    // has lost its contract-immutability trigger.
    await db.execute(`DROP TRIGGER MeteredProviderBudget_contract_immutable`);
    await db.execute({
      sql: `UPDATE MeteredProviderBudget SET operations=? WHERE id='metered-budget'`,
      args: [JSON.stringify(["detail"])],
    });
    await assert.rejects(
      db.execute(priceObservation(
        "metered-price-operation-removed", "metered-run", "metered-receipt",
      )),
      /DONOR_OFFER_OBSERVATION_METERED_RECEIPT_INVALID/,
    );
    await assert.rejects(
      db.execute(contentObservation(
        "metered-content-operation-removed", "metered-receipt",
      )),
      /PRODUCT_CONTENT_OBSERVATION_METERED_RECEIPT_INVALID/,
    );
  } finally {
    await db.close();
  }
});

test("canonical variant schema permits different exact content and price sources", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    // A pre-migration row remains legacy; migration never blesses it as truth.
    await db.execute(`INSERT INTO DonorProduct(id,identityKey,brand) VALUES ('legacy','legacy','Old')`);
    await db.execute(`INSERT INTO SkuCost(id,sku,source,totalCost)
      VALUES ('legacy-cost','LEGACY-SKU','retail:batch',1)`);
    await applyEvidenceMigration(db);
    await assertProductTruthEvidenceSchema(db);

    const legacy = (await db.execute(
      `SELECT identityStatus FROM DonorProduct WHERE id='legacy'`,
    )).rows[0];
    assert.equal(legacy.identityStatus, "legacy_unverified");
    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) AS count FROM CanonicalProductVariant`)).rows[0]?.count),
      0,
    );
    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) AS count FROM SkuComponentEvidence`)).rows[0]?.count),
      0,
    );

    await insertVariant(db, VARIANT_1, HASH_A, "barbecue");
    await insertVariant(db, VARIANT_2, HASH_B, "sea salt");
    await confirmSource(db, {
      donorProductId: "target-content-source",
      decisionId: "decision-target",
      variantId: VARIANT_1,
    });
    await confirmSource(db, {
      donorProductId: "walmart-price-source",
      decisionId: "decision-walmart",
      variantId: VARIANT_1,
    });

    await assert.rejects(
      db.execute(`UPDATE DonorProduct SET flavor='Adjacent' WHERE id='target-content-source'`),
      /DONOR_PRODUCT_CONFIRMED_IDENTITY_IMMUTABLE/,
    );
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO DonorProductVariantDecision (
          id,decisionKey,donorProductId,canonicalVariantId,decisionStatus,
          matcherVersion,matcherImplementationSha256,matcherReleaseSha256,
          evidenceHash,evidenceJson,decidedAt
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          "decision-second", "decision:second", "target-content-source", VARIANT_2,
          "exact_confirmed", MATCHER_VERSION, MATCHER_IMPLEMENTATION_SHA256,
          MATCHER_RELEASE_SHA256, HASH_C,
          JSON.stringify({
            matcherVersion: MATCHER_VERSION,
            matcherImplementationSha256: MATCHER_IMPLEMENTATION_SHA256,
            matcherReleaseSha256: MATCHER_RELEASE_SHA256,
          }),
          "2026-07-18T19:00:00.000Z",
        ],
      }),
      /DONOR_PRODUCT_VARIANT_DECISION_ALREADY_EXISTS/,
    );

    await db.execute({
      sql: `INSERT INTO ProductContentObservation (
        id,observationKey,donorProductId,canonicalVariantId,variantDecisionId,
        sourceUrl,sourceApi,contentHash,fieldHashesJson,contentJson,observedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "content-target", hashKey("content:target"), "target-content-source", VARIANT_1,
        "decision-target", "https://target.example/item", "target", HASH_A,
        JSON.stringify({ title: HASH_B }),
        JSON.stringify({ title: "Acme Crunch Chips Barbecue", ingredients: "Potatoes" }),
        "2026-07-18T19:00:00.000Z",
      ],
    });
    await db.execute(`INSERT INTO DonorOffer(
      id,donorProductId,retailer,retailerProductId,via
    ) VALUES ('offer-walmart','walmart-price-source','walmart','item-1','direct')`);
    await db.execute({
      sql: `INSERT INTO DonorOfferObservation (
        id,observationKey,donorOfferId,donorProductId,canonicalVariantId,
        variantDecisionId,retailer,retailerProductId,via,price,pricePerUnit,
        currency,zip,localityEvidence,inStock,productUrl,sellerName,isFirstParty,
        sourceApi,observedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "price-walmart", hashKey("price:walmart"), "offer-walmart", "walmart-price-source",
        VARIANT_1, "decision-walmart", "walmart", "item-1", "direct", 3.99, 3.99,
        "USD", "33765", "zip_scoped", 1, "https://walmart.example/item",
        "Walmart", 1, "bluecart", "2026-07-18T19:05:00.000Z",
      ],
    });

    const factEvidence: InStatement = {
      sql: `INSERT INTO SkuComponentEvidence (
        id,evidenceKey,skuCostId,componentIndex,evidenceStatus,
        targetCanonicalVariantId,contentCanonicalVariantId,priceCanonicalVariantId,
        contentObservationId,priceObservationId,matchTier,matcherVersion,
        matcherImplementationSha256,matcherReleaseSha256,
        pricePolicyVersion,evidenceHash,evidenceJson
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "component-fact", hashKey("component:fact"), "cost-fact", 0, "FACT",
        VARIANT_1, VARIANT_1, VARIANT_1, "content-target", "price-walmart",
        "EXACT_IDENTITY", MATCHER_VERSION,
        MATCHER_IMPLEMENTATION_SHA256, MATCHER_RELEASE_SHA256,
        "price-evidence-eligibility/1.0.0", HASH_C,
        JSON.stringify({
          evidenceStatus: "FACT",
          targetCanonicalVariantId: VARIANT_1,
          contentCanonicalVariantId: VARIANT_1,
          priceCanonicalVariantId: VARIANT_1,
          contentObservationId: "content-target",
          priceObservationId: "price-walmart",
          product: "Acme Crunch Chips",
          flavor: "barbecue",
          size: "8 oz",
          qty: 1,
          perUnit: 3.99,
          method: "exact",
          targetComparableUnitPrice: null,
          matchTier: "EXACT_IDENTITY",
          matcherVersion: MATCHER_VERSION,
          matcherImplementationSha256: MATCHER_IMPLEMENTATION_SHA256,
          matcherReleaseSha256: MATCHER_RELEASE_SHA256,
          pricePolicyVersion: "price-evidence-eligibility/1.0.0",
        }),
      ],
    };
    const factCost: InStatement = {
      sql: `INSERT INTO SkuCost (
        id,sku,effectiveDate,productCost,totalCost,costPerUnit,packSize,source,
        observationKey,recipeHash,evidenceJson,evidenceOutcome,
        matcherVersion,matcherImplementationSha256,matcherReleaseSha256,
        pricePolicyVersion
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "cost-fact", "SKU-FACT", "2026-07-18", 3.99, 3.99, 3.99, 1,
        "retail:batch", HASH_A, HASH_B,
        JSON.stringify({
          outcome: "FACT",
          recipeHash: HASH_B,
          evaluatedAt: "2026-07-18T19:05:00.000Z",
          matcherVersion: MATCHER_VERSION,
          matcherImplementationSha256: MATCHER_IMPLEMENTATION_SHA256,
          matcherReleaseSha256: MATCHER_RELEASE_SHA256,
          total: 3.99,
          costPerUnit: 3.99,
          packSize: 1,
          components: [
            {
              idx: 0, priceEvidenceStatus: "FACT", perUnit: 3.99, qty: 1,
              product: "Acme Crunch Chips", flavor: "barbecue", size: "8 oz",
              method: "exact", matchTier: "EXACT_IDENTITY",
              targetCanonicalVariantId: VARIANT_1,
              contentCanonicalVariantId: VARIANT_1,
              priceCanonicalVariantId: VARIANT_1,
              contentDonorProductId: "target-content-source",
              priceEvidenceDonorProductId: "walmart-price-source",
              priceEvidenceOfferId: "offer-walmart",
              priceEvidenceObservationId: "price-walmart",
              contentObservationId: "content-target",
              priceVariantDecisionId: "decision-walmart",
              matcherVersion: MATCHER_VERSION,
              matcherImplementationSha256: MATCHER_IMPLEMENTATION_SHA256,
              matcherReleaseSha256: MATCHER_RELEASE_SHA256,
              pricePolicyVersion: "price-evidence-eligibility/1.0.0",
            },
          ],
        }),
        "FACT", MATCHER_VERSION, MATCHER_IMPLEMENTATION_SHA256,
        MATCHER_RELEASE_SHA256,
        "price-evidence-eligibility/1.0.0",
      ],
    };
    await db.batch([factEvidence, factCost], "write");

    const sources = (await db.execute(`
      SELECT content."donorProductId" AS contentSource,
             price."donorProductId" AS priceSource,
             evidence."targetCanonicalVariantId" AS targetVariant,
             evidence."contentCanonicalVariantId" AS contentVariant,
             evidence."priceCanonicalVariantId" AS priceVariant
      FROM SkuComponentEvidence evidence
      JOIN ProductContentObservation content ON content."id"=evidence."contentObservationId"
      JOIN DonorOfferObservation price ON price."id"=evidence."priceObservationId"
      WHERE evidence."id"='component-fact'
    `)).rows[0];
    assert.equal(sources.contentSource, "target-content-source");
    assert.equal(sources.priceSource, "walmart-price-source");
    assert.notEqual(sources.contentSource, sources.priceSource);
    assert.equal(sources.targetVariant, VARIANT_1);
    assert.equal(sources.contentVariant, VARIANT_1);
    assert.equal(sources.priceVariant, VARIANT_1);

    await assert.rejects(
      db.execute(`UPDATE ProductContentObservation SET sourceApi='mutated' WHERE id='content-target'`),
      /PRODUCT_CONTENT_OBSERVATION_IMMUTABLE/,
    );
    await assert.rejects(
      db.execute(`UPDATE DonorOfferObservation SET retailer='target' WHERE id='price-walmart'`),
      /DONOR_OFFER_OBSERVATION_IMMUTABLE/,
    );
    await assert.rejects(
      db.execute(`UPDATE SkuComponentEvidence SET matchTier='mutated' WHERE id='component-fact'`),
      /SKU_COMPONENT_EVIDENCE_IMMUTABLE/,
    );
  } finally {
    await db.close();
  }
});

test("FACT, ESTIMATE, REJECT, legacy-link and retail cost contracts fail closed", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await applyEvidenceMigration(db);
    await insertVariant(db, VARIANT_1, HASH_A, "barbecue");
    await insertVariant(db, VARIANT_2, HASH_B, "sea salt");
    await confirmSource(db, {
      donorProductId: "content-source",
      decisionId: "decision-content",
      variantId: VARIANT_1,
    });
    await confirmSource(db, {
      donorProductId: "price-source",
      decisionId: "decision-price",
      variantId: VARIANT_1,
    });
    await db.execute({
      sql: `INSERT INTO ProductContentObservation (
        id,observationKey,donorProductId,canonicalVariantId,variantDecisionId,
        sourceUrl,sourceApi,contentHash,fieldHashesJson,contentJson,observedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "content-1", hashKey("content:1"), "content-source", VARIANT_1,
        "decision-content", "https://content.example/1", "test", HASH_A,
        JSON.stringify({ title: HASH_B }),
        JSON.stringify({ title: "Barbecue" }), "2026-07-18T19:00:00.000Z",
      ],
    });
    await db.execute(`INSERT INTO DonorOffer(
      id,donorProductId,retailer,retailerProductId,via
    ) VALUES ('offer-1','price-source','walmart','item-1','direct')`);
    await db.execute({
      sql: `INSERT INTO DonorOfferObservation (
        id,observationKey,donorOfferId,donorProductId,canonicalVariantId,
        variantDecisionId,retailer,retailerProductId,via,price,pricePerUnit,
        zip,localityEvidence,inStock,productUrl,isFirstParty,sourceApi,observedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "price-1", hashKey("price:1"), "offer-1", "price-source", VARIANT_1,
        "decision-price", "walmart", "item-1", "direct", 3.99, 3.99,
        "33765", "zip_scoped", 1, "https://walmart.example/item-1", 1, "test",
        "2026-07-18T19:00:00.000Z",
      ],
    });

    const insertEvidence = (overrides: {
      id: string;
      status: "FACT" | "ESTIMATE" | "REJECT";
      target?: string;
      contentVariant?: string | null;
      priceVariant?: string | null;
      contentObservation?: string | null;
      priceObservation?: string | null;
    }) => db.execute({
      sql: `INSERT INTO SkuComponentEvidence (
        id,evidenceKey,skuCostId,componentIndex,evidenceStatus,
        targetCanonicalVariantId,contentCanonicalVariantId,priceCanonicalVariantId,
        contentObservationId,priceObservationId,matchTier,matcherVersion,
        matcherImplementationSha256,matcherReleaseSha256,
        pricePolicyVersion,evidenceHash,evidenceJson
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        overrides.id, hashKey(`evidence:${overrides.id}`), "future-cost", 0, overrides.status,
        overrides.target ?? VARIANT_1, overrides.contentVariant ?? null,
        overrides.priceVariant ?? null, overrides.contentObservation ?? null,
        overrides.priceObservation ?? null, "TEST", MATCHER_VERSION,
        MATCHER_IMPLEMENTATION_SHA256, MATCHER_RELEASE_SHA256,
        "price-evidence-eligibility/1.0.0",
        HASH_C, "{}",
      ],
    });

    await assert.rejects(
      insertEvidence({
        id: "bad-fact", status: "FACT", target: VARIANT_2,
        contentVariant: VARIANT_1, priceVariant: VARIANT_1,
        contentObservation: "content-1", priceObservation: "price-1",
      }),
      /SKU_COMPONENT_CONTENT_EXACT_CONTRACT_INVALID/,
    );
    await assert.rejects(
      insertEvidence({
        id: "bad-estimate", status: "ESTIMATE", contentVariant: VARIANT_1,
        priceVariant: VARIANT_1, contentObservation: "content-1",
        priceObservation: "price-1",
      }),
      /SKU_COMPONENT_ESTIMATE_PRICE_CONTRACT_INVALID/,
    );
    await assert.rejects(
      insertEvidence({
        id: "bad-reject", status: "REJECT", priceVariant: VARIANT_1,
        priceObservation: "price-1",
      }),
      /SKU_COMPONENT_REJECT_LINK_FORBIDDEN/,
    );
    await assert.rejects(
      db.execute(`INSERT INTO SkuComponent(id,donorProductId) VALUES ('legacy-new','content-source')`),
      /SKU_COMPONENT_LEGACY_EVIDENCE_FORBIDDEN/,
    );
    await assert.rejects(
      db.execute(`INSERT INTO SkuCost(id,sku,source,totalCost)
        VALUES ('missing-evidence','SKU-MISSING','retail:batch',3.99)`),
      /SKU_COST_EVIDENCE_REQUIRED/,
    );
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO SkuCost (
          id,sku,effectiveDate,productCost,totalCost,costPerUnit,packSize,source,
          observationKey,recipeHash,evidenceJson,evidenceOutcome,
          matcherVersion,matcherImplementationSha256,matcherReleaseSha256,
          pricePolicyVersion
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          "missing-child", "SKU-MISSING-CHILD", "2026-07-18", 3.99, 3.99,
          3.99, 1, "retail:batch", HASH_A, HASH_B,
          JSON.stringify({
            outcome: "FACT",
            recipeHash: HASH_B,
            evaluatedAt: "2026-07-18T19:00:00.000Z",
            matcherVersion: MATCHER_VERSION,
            matcherImplementationSha256: MATCHER_IMPLEMENTATION_SHA256,
            matcherReleaseSha256: MATCHER_RELEASE_SHA256,
            total: 3.99,
            costPerUnit: 3.99,
            packSize: 1,
            components: [
              {
                idx: 0,
                priceEvidenceStatus: "FACT",
                perUnit: 3.99,
                qty: 1,
                product: "Acme Crunch Chips",
                flavor: "barbecue",
                size: "8 oz",
                method: "exact",
                matchTier: "EXACT_IDENTITY",
                matcherVersion: MATCHER_VERSION,
                matcherImplementationSha256: MATCHER_IMPLEMENTATION_SHA256,
                matcherReleaseSha256: MATCHER_RELEASE_SHA256,
                pricePolicyVersion: "price-evidence-eligibility/1.0.0",
              },
            ],
          }),
          "FACT", MATCHER_VERSION, MATCHER_IMPLEMENTATION_SHA256,
          MATCHER_RELEASE_SHA256,
          "price-evidence-eligibility/1.0.0",
        ],
      }),
      /SKU_COST_COMPONENT_EVIDENCE_REQUIRED/,
    );
  } finally {
    await db.close();
  }
});

test("append-only guards survive OR REPLACE, preserve views, and allow a new observation in one period", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await db.execute(`CREATE VIEW EnrichedReadySku AS SELECT sku FROM SkuCost`);
    await applyEvidenceMigration(db);
    assert.deepEqual((await db.execute(`SELECT * FROM EnrichedReadySku`)).rows, []);
    const indexes = (await db.execute(`PRAGMA index_list('SkuCost')`)).rows;
    assert.equal(
      indexes.some((row) => String(row.name) === "SkuCost_sku_source_effectiveDate_key"),
      false,
    );

    await insertVariant(db, VARIANT_1, HASH_A, "barbecue");
    const graph = await seedExactGraph(db, "append");
    for (const suffix of ["one", "two"]) {
      const costId = `append-cost-${suffix}`;
      await db.batch([
        exactEvidenceStatement({
          id: `append-evidence-${suffix}`,
          costId,
          index: 0,
          contentId: graph.contentId,
          priceId: graph.priceId,
        }),
        costStatement({
          id: costId,
          sku: "SKU-SAME-PERIOD",
          observationSeed: `append-observation-${suffix}`,
          recipeSeed: `append-recipe-${suffix}`,
          effectiveDate: "2026-07-18T19:05:00.000Z",
          exactGraph: graph,
        }),
      ], "write");
    }
    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) n FROM SkuCost
        WHERE sku='SKU-SAME-PERIOD'`)).rows[0]?.n),
      2,
    );

    await db.execute(`PRAGMA recursive_triggers=OFF`);
    const immutableReplays: Array<[string, RegExp]> = [
      [
        `INSERT OR REPLACE INTO CanonicalProductVariant
         SELECT * FROM CanonicalProductVariant WHERE id='${VARIANT_1}'`,
        /CANONICAL_PRODUCT_VARIANT_ALREADY_EXISTS/,
      ],
      [
        `INSERT OR REPLACE INTO DonorProductVariantDecision
         SELECT * FROM DonorProductVariantDecision WHERE id='append-content-decision'`,
        /DONOR_PRODUCT_VARIANT_DECISION_ALREADY_EXISTS/,
      ],
      [
        `INSERT OR REPLACE INTO DonorProduct
         SELECT * FROM DonorProduct WHERE id='append-content-donor'`,
        /DONOR_PRODUCT_ALREADY_EXISTS/,
      ],
      [
        `INSERT OR REPLACE INTO DonorOffer
         SELECT * FROM DonorOffer WHERE id='append-offer'`,
        /DONOR_OFFER_ALREADY_EXISTS/,
      ],
      [
        `INSERT OR REPLACE INTO ProductContentObservation
         SELECT * FROM ProductContentObservation WHERE id='append-content'`,
        /PRODUCT_CONTENT_OBSERVATION_ALREADY_EXISTS/,
      ],
      [
        `INSERT OR REPLACE INTO DonorOfferObservation
         SELECT * FROM DonorOfferObservation WHERE id='append-price'`,
        /DONOR_OFFER_OBSERVATION_ALREADY_EXISTS/,
      ],
      [
        `INSERT OR REPLACE INTO SkuComponentEvidence
         SELECT * FROM SkuComponentEvidence WHERE id='append-evidence-one'`,
        /SKU_(COMPONENT_EVIDENCE_ALREADY_EXISTS|COST_COMPONENT_EVIDENCE_SEALED)/,
      ],
      [
        `INSERT OR REPLACE INTO SkuCost
         SELECT * FROM SkuCost WHERE id='append-cost-one'`,
        /SKU_COST_ALREADY_EXISTS/,
      ],
    ];
    for (const [sql, error] of immutableReplays) {
      await assert.rejects(db.execute(sql), error);
    }
    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) n FROM SkuCost
        WHERE sku='SKU-SAME-PERIOD'`)).rows[0]?.n),
      2,
    );
  } finally {
    await db.close();
  }
});

test("cost recipe is complete, sealed, integer-indexed, and arithmetically reconciled", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await applyEvidenceMigration(db);
    await insertVariant(db, VARIANT_1, HASH_A, "barbecue");
    const graph = await seedExactGraph(db, "recipe");

    await db.batch([
      exactEvidenceStatement({
        id: "valid-evidence", costId: "valid-cost", index: 0,
        contentId: graph.contentId, priceId: graph.priceId,
      }),
      costStatement({
        id: "valid-cost", sku: "SKU-VALID", observationSeed: "valid-observation",
        recipeSeed: "valid-recipe", exactGraph: graph,
      }),
    ], "write");
    await assert.rejects(
      db.execute(exactEvidenceStatement({
        id: "late-evidence", costId: "valid-cost", index: 1,
        contentId: graph.contentId, priceId: graph.priceId,
      })),
      /SKU_COST_COMPONENT_EVIDENCE_SEALED/,
    );

    await assert.rejects(
      db.batch([
        exactEvidenceStatement({
          id: "split-identity-evidence", costId: "split-identity-cost", index: 0,
          contentId: graph.contentId, priceId: graph.priceId,
        }),
        costStatement({
          id: "split-identity-cost", sku: "SKU-SPLIT-IDENTITY",
          observationSeed: "split-identity-observation",
          recipeSeed: "split-identity-recipe", exactGraph: graph,
          components: [{
            idx: 0, priceEvidenceStatus: "FACT", perUnit: 3.99, qty: 1,
            targetCanonicalVariantId: VARIANT_2,
            priceEvidenceObservationId: "nonexistent-price-observation",
          }],
        }),
      ], "write"),
      /SKU_COST_COMPONENT_METADATA_MISMATCH/,
    );

    await assert.rejects(
      db.batch([
        exactEvidenceStatement({
          id: "incomplete-evidence", costId: "incomplete-cost", index: 0,
          contentId: graph.contentId, priceId: graph.priceId,
        }),
        costStatement({
          id: "incomplete-cost", sku: "SKU-INCOMPLETE",
          observationSeed: "incomplete-observation", recipeSeed: "incomplete-recipe",
          productCost: 7.98, totalCost: 7.98, costPerUnit: 3.99, packSize: 2,
          exactGraph: graph,
          components: [
            { idx: 0, priceEvidenceStatus: "FACT", perUnit: 3.99, qty: 1 },
            { idx: 1, priceEvidenceStatus: "FACT", perUnit: 3.99, qty: 1 },
          ],
        }),
      ], "write"),
      /SKU_COST_COMPONENT_COUNT_MISMATCH/,
    );
    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) n FROM SkuComponentEvidence
        WHERE skuCostId='incomplete-cost'`)).rows[0]?.n),
      0,
      "failed parent verification must roll back its child evidence",
    );

    await assert.rejects(
      db.execute(exactEvidenceStatement({
        id: "fractional-child", costId: "fractional-child-cost", index: 0.5,
        contentId: graph.contentId, priceId: graph.priceId,
      })),
      /CHECK constraint failed/,
    );
    await assert.rejects(
      db.batch([
        exactEvidenceStatement({
          id: "fractional-recipe-evidence", costId: "fractional-recipe-cost", index: 0,
          contentId: graph.contentId, priceId: graph.priceId,
        }),
        costStatement({
          id: "fractional-recipe-cost", sku: "SKU-FRACTIONAL-RECIPE",
          observationSeed: "fractional-recipe-observation",
          recipeSeed: "fractional-recipe",
          exactGraph: graph,
          components: [
            { idx: 0.5, priceEvidenceStatus: "FACT", perUnit: 3.99, qty: 1 },
          ],
        }),
      ], "write"),
      /SKU_COST_COMPONENT_RECIPE_MISMATCH/,
    );

    await assert.rejects(
      db.batch([
        exactEvidenceStatement({
          id: "rollup-evidence", costId: "rollup-cost", index: 0,
          contentId: graph.contentId, priceId: graph.priceId,
        }),
        costStatement({
          id: "rollup-cost", sku: "SKU-ROLLUP", observationSeed: "rollup-observation",
          recipeSeed: "rollup-recipe", productCost: 4, exactGraph: graph,
          components: [
            { idx: 0, priceEvidenceStatus: "FACT", perUnit: 3.99, qty: 1 },
          ],
        }),
      ], "write"),
      /SKU_COST_COMPONENT_ROLLUP_MISMATCH/,
    );
    await assert.rejects(
      db.batch([
        exactEvidenceStatement({
          id: "pack-evidence", costId: "pack-cost", index: 0,
          contentId: graph.contentId, priceId: graph.priceId, perUnit: 7.98,
        }),
        costStatement({
          id: "pack-cost", sku: "SKU-PACK", observationSeed: "pack-observation",
          recipeSeed: "pack-recipe", productCost: 7.98, totalCost: 7.98,
          costPerUnit: 3.99, packSize: 2, exactGraph: graph,
          components: [
            { idx: 0, priceEvidenceStatus: "FACT", perUnit: 7.98, qty: 1 },
          ],
        }),
      ], "write"),
      /SKU_COST_PACK_SIZE_MISMATCH/,
    );
    await assert.rejects(
      db.execute(costStatement({
        id: "nonretail-no-evidence", sku: "SKU-NONRETAIL",
        observationSeed: "nonretail-observation", recipeSeed: "nonretail-recipe",
        source: "manual-import",
      })),
      /SKU_COST_COMPONENT_EVIDENCE_REQUIRED/,
    );
  } finally {
    await db.close();
  }
});

test("price and manual evidence fail closed on source quality, freshness, and typed provenance", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await applyEvidenceMigration(db);
    await insertVariant(db, VARIANT_1, HASH_A, "barbecue");
    const graph = await seedExactGraph(db, "quality");
    const decisionId = "quality-price-decision";

    const insertPriceVariant = async (input: {
      id: string;
      pricePerUnit: number | null;
      isFirstParty: number;
      localityEvidence: string;
      observedAt?: string;
    }) => {
      await db.execute({
        sql: `INSERT INTO DonorOfferObservation (
          id,observationKey,donorOfferId,donorProductId,canonicalVariantId,
          variantDecisionId,retailer,retailerProductId,via,price,pricePerUnit,
          currency,zip,localityEvidence,inStock,productUrl,sellerName,isFirstParty,
          sourceApi,observedAt
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          input.id, hashKey(`quality:${input.id}`), graph.offerId, graph.priceDonorId,
          VARIANT_1, decisionId, "walmart", "quality-item", "direct", 3.99,
          input.pricePerUnit, "USD", "33765", input.localityEvidence, 1,
          `https://walmart.example/${input.id}`, "Walmart", input.isFirstParty,
          "test", input.observedAt ?? "2026-07-18T19:00:00.000Z",
        ],
      });
    };
    await insertPriceVariant({
      id: "price-null", pricePerUnit: null, isFirstParty: 1,
      localityEvidence: "zip_scoped",
    });
    await insertPriceVariant({
      id: "price-third-party", pricePerUnit: 3.99, isFirstParty: 0,
      localityEvidence: "zip_scoped",
    });
    await insertPriceVariant({
      id: "price-unscoped", pricePerUnit: 3.99, isFirstParty: 1,
      localityEvidence: "national_unscoped",
    });
    for (const priceId of ["price-null", "price-third-party", "price-unscoped"]) {
      await assert.rejects(
        db.execute(exactEvidenceStatement({
          id: `evidence-${priceId}`, costId: `cost-${priceId}`, index: 0,
          contentId: graph.contentId, priceId,
        })),
        /SKU_COMPONENT_FACT_PRICE_CONTRACT_INVALID/,
      );
    }

    await insertPriceVariant({
      id: "price-stale", pricePerUnit: 3.99, isFirstParty: 1,
      localityEvidence: "zip_scoped", observedAt: "2026-07-10T19:00:00.000Z",
    });
    await assert.rejects(
      db.batch([
        exactEvidenceStatement({
          id: "evidence-stale", costId: "cost-stale", index: 0,
          contentId: graph.contentId, priceId: "price-stale",
        }),
        costStatement({
          id: "cost-stale", sku: "SKU-STALE", observationSeed: "stale-observation",
          recipeSeed: "stale-recipe",
          exactGraph: { ...graph, priceId: "price-stale" },
        }),
      ], "write"),
      /SKU_COST_PRICE_OBSERVATION_NOT_FRESH/,
    );

    const manualJson = (
      manualCostOverrides: Record<string, unknown> = {},
      evidenceOverrides: Record<string, unknown> = {},
    ) => JSON.stringify({
      evidenceStatus: "MANUAL_FACT",
      targetCanonicalVariantId: VARIANT_1,
      contentCanonicalVariantId: null,
      priceCanonicalVariantId: null,
      contentObservationId: null,
      priceObservationId: null,
      product: "Acme Crunch Chips",
      flavor: "barbecue",
      size: "8 oz",
      qty: 1,
      perUnit: 2.25,
      method: "own-brand",
      targetComparableUnitPrice: null,
      matchTier: "MANUAL_COST",
      matcherVersion: MATCHER_VERSION,
      matcherImplementationSha256: MATCHER_IMPLEMENTATION_SHA256,
      matcherReleaseSha256: MATCHER_RELEASE_SHA256,
      pricePolicyVersion: "owner-manual-cost/1.0.0",
      manualCost: {
        policyVersion: "owner-manual-cost/1.0.0",
        amount: 2.25,
        currency: "USD",
        effectiveAt: "2026-07-18T18:00:00.000Z",
        source: "owner-provided-cost-table",
        actor: "Vladimir",
        reason: "owner-approved landed cost",
        approvalRef: "owner:2026-07-18",
        ...manualCostOverrides,
      },
      ...evidenceOverrides,
    });
    const manualEvidence = (id: string, costId: string, evidenceJson: string): InStatement => ({
      sql: `INSERT INTO SkuComponentEvidence (
        id,evidenceKey,skuCostId,componentIndex,evidenceStatus,targetCanonicalVariantId,
        matchTier,matcherVersion,matcherImplementationSha256,matcherReleaseSha256,
        pricePolicyVersion,evidenceHash,evidenceJson
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id, hashKey(`manual:${id}`), costId, 0, "MANUAL_FACT", VARIANT_1,
        "MANUAL_COST", MATCHER_VERSION, MATCHER_IMPLEMENTATION_SHA256,
        MATCHER_RELEASE_SHA256, "owner-manual-cost/1.0.0",
        hashKey(evidenceJson), evidenceJson,
      ],
    });
    await assert.rejects(
      db.execute(manualEvidence(
        "manual-bad-actor", "manual-bad-actor-cost", manualJson({ actor: 7 }),
      )),
      /SKU_COMPONENT_MANUAL_FACT_CONTRACT_INVALID/,
    );
    await assert.rejects(
      db.execute(manualEvidence(
        "manual-bad-date", "manual-bad-date-cost",
        manualJson({ effectiveAt: "not-a-date" }),
      )),
      /SKU_COMPONENT_MANUAL_FACT_CONTRACT_INVALID/,
    );
    const validManualJson = manualJson();
    const badKey = manualEvidence("manual-bad-key", "manual-bad-key-cost", validManualJson);
    if (typeof badKey === "string") assert.fail("manual evidence must be a parameterized statement");
    (badKey.args as unknown[])[1] = "not-a-hash";
    await assert.rejects(db.execute(badKey), /CHECK constraint failed/);
    await assert.rejects(
      db.batch([
        manualEvidence(
          "manual-mismatch",
          "manual-mismatch-cost",
          manualJson({}, { perUnit: 2.5 }),
        ),
        costStatement({
          id: "manual-mismatch-cost", sku: "SKU-MANUAL-MISMATCH",
          observationSeed: "manual-mismatch-observation",
          recipeSeed: "manual-mismatch-recipe", productCost: 2.5, totalCost: 2.5,
          costPerUnit: 2.5,
          components: [
            { idx: 0, priceEvidenceStatus: "MANUAL_FACT", perUnit: 2.5, qty: 1 },
          ],
        }),
      ], "write"),
      /SKU_COST_MANUAL_AMOUNT_MISMATCH/,
    );
  } finally {
    await db.close();
  }
});

test("harvest gate passes only after its checked migration", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await applyEvidenceMigration(db);
    const harvestMigration = new URL(
      "../../../../prisma/migrations/20260718233000_donor_harvest_lifecycle/migration.sql",
      import.meta.url,
    );
    await db.executeMultiple(await readFile(harvestMigration, "utf8"));
    await assertDonorHarvestSchema(db);
    await db.execute(`DROP INDEX DonorHarvestState_claimable_idx`);
    await assert.rejects(
      assertDonorHarvestSchema(db),
      (error) => error instanceof ProductTruthSchemaNotReadyError
        && error.missing.includes("index:DonorHarvestState_claimable_idx"),
    );
  } finally {
    await db.close();
  }
});

test("metered schema gate rejects a named but structurally incomplete ledger", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await applyEvidenceMigration(db);
    const ledgerMigration = new URL(
      "../../../../prisma/migrations/20260719000000_metered_budget_ledger/migration.sql",
      import.meta.url,
    );
    const linkMigration = new URL(
      "../../../../prisma/migrations/20260719001000_product_truth_metered_evidence_link/migration.sql",
      import.meta.url,
    );
    await db.executeMultiple(await readFile(ledgerMigration, "utf8"));
    await db.executeMultiple(await readFile(linkMigration, "utf8"));
    await assertProductTruthMeteredEvidenceSchema(db);

    await db.execute(`DROP INDEX MeteredReservationReceipt_budget_status_idx`);
    await assert.rejects(
      assertProductTruthMeteredEvidenceSchema(db),
      (error) => error instanceof ProductTruthSchemaNotReadyError
        && error.missing.includes(
          "index:MeteredReservationReceipt_budget_status_idx",
        ),
    );
  } finally {
    await db.close();
  }
});
