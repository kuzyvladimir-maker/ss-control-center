import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createClient, type Client, type InStatement } from "@libsql/client";

import { CANONICAL_PRODUCT_MATCHER_VERSION } from "../canonical-product-match";
import { PRICE_EVIDENCE_POLICY_VERSION } from "../price-evidence-policy";
import {
  buildProductTruthConsumerActivation,
  expectedProductTruthConsumerActivationConfirmation,
  productTruthConsumerActivationSha256,
  validateProductTruthConsumerActivation,
} from "../product-truth-consumer-activation";
import { readProductTruthConsumerBatch } from "../product-truth-consumer-gateway";
import {
  PRODUCT_TRUTH_MAX_BATCH_SCOPES,
  ProductTruthReadInputError,
  PRODUCT_TRUTH_READ_CONTRACT_VERSION,
  readProductTruthSnapshot,
  readProductTruthSnapshots,
} from "../product-truth-read-contract";
import { ProductTruthSchemaNotReadyError } from "../product-truth-schema-gate";

const AS_OF = "2026-07-18T20:00:00.000Z";
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalVariantId(label: string): string {
  return label.startsWith("cpv1:") ? label : `cpv1:${hash(label)}`;
}

async function createBaseSchema(db: Client): Promise<void> {
  await db.execute(`PRAGMA foreign_keys=ON`);
  await db.execute(`CREATE TABLE DonorProduct (
    id TEXT PRIMARY KEY, identityKey TEXT, brand TEXT, productLine TEXT,
    flavor TEXT, containerType TEXT, size TEXT
  )`);
  await db.execute(`CREATE TABLE DonorOffer (
    id TEXT PRIMARY KEY, donorProductId TEXT NOT NULL, retailer TEXT NOT NULL,
    retailerProductId TEXT NOT NULL, via TEXT NOT NULL DEFAULT 'direct'
  )`);
  await db.execute(`CREATE UNIQUE INDEX donor_offer_dedup
    ON DonorOffer(retailer, retailerProductId)`);
  await db.execute(`CREATE TABLE SkuComponent (
    id TEXT PRIMARY KEY, donorProductId TEXT
  )`);
  await db.execute(`CREATE TABLE SkuCost (
    id TEXT PRIMARY KEY, sku TEXT NOT NULL, asin TEXT, effectiveDate TEXT,
    productCost REAL, packagingCost REAL, iceCost REAL, totalCost REAL,
    costPerUnit REAL, packSize INTEGER, includesPackaging INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD', source TEXT NOT NULL,
    confidence REAL, needsReview INTEGER NOT NULL DEFAULT 0, notes TEXT,
    createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
  )`);
  await db.execute(`CREATE UNIQUE INDEX SkuCost_sku_source_effectiveDate_key
    ON SkuCost(sku, source, effectiveDate)`);
}

async function applyCanonicalMigration(db: Client): Promise<void> {
  const migration = new URL(
    "../../../../prisma/migrations/20260718234500_product_truth_evidence_provenance/migration.sql",
    import.meta.url,
  );
  await db.executeMultiple(await readFile(migration, "utf8"));
  const scopeMigration = new URL(
    "../../../../prisma/migrations/20260719002000_product_truth_listing_scope/migration.sql",
    import.meta.url,
  );
  await db.executeMultiple(await readFile(scopeMigration, "utf8"));
}

type VariantSeed = {
  id: string;
  brand: string;
  productLine: string;
  flavor: string;
  createdAt?: string;
};

async function insertVariant(db: Client, seed: VariantSeed): Promise<void> {
  const identity = {
    brand: seed.brand,
    productLine: seed.productLine,
    flavor: seed.flavor,
    form: "bag",
    size: "8 oz",
    outerPackCount: 1,
  };
  const identityHash = hash(seed.id);
  await db.execute({
    sql: `INSERT INTO CanonicalProductVariant (
      id,variantKey,identityHash,keyVersion,normalizedBrand,normalizedProductLine,
      normalizedFlavor,normalizedModifiersJson,normalizedForm,sizeDimension,
      sizeBaseAmount,sizeBaseUnit,outerPackCount,identityJson,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      canonicalVariantId(seed.id), canonicalVariantId(seed.id), identityHash,
      "canonical-product-variant-key/1.0.0", seed.brand.toLowerCase(),
      seed.productLine.toLowerCase(), seed.flavor.toLowerCase(), "[]", "bag",
      "MASS", 226.796, "g", 1, JSON.stringify(identity),
      seed.createdAt ?? "2026-07-18T16:00:00.000Z",
    ],
  });
}

async function insertExactSource(
  db: Client,
  input: { donorProductId: string; decisionId: string; variantId: string; flavor: string },
): Promise<void> {
  const decisionEvidence = JSON.stringify({ exact: true });
  await db.execute({
    sql: `INSERT INTO DonorProduct (
      id,identityKey,brand,productLine,flavor,containerType,size,identityStatus
    ) VALUES (?,?,?,?,?,?,?,'candidate')`,
    args: [
      input.donorProductId, `source:${input.donorProductId}`, "Acme", "Crunch Chips",
      input.flavor, "bag", "8 oz",
    ],
  });
  await db.execute({
    sql: `INSERT INTO DonorProductVariantDecision (
      id,decisionKey,donorProductId,canonicalVariantId,decisionStatus,matcherVersion,
      evidenceHash,evidenceJson,decidedAt,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [
      input.decisionId, `decision:${input.decisionId}`, input.donorProductId,
      canonicalVariantId(input.variantId), "exact_confirmed", CANONICAL_PRODUCT_MATCHER_VERSION,
      hash(decisionEvidence), decisionEvidence,
      "2026-07-18T17:00:00.000Z", "2026-07-18T17:00:00.000Z",
    ],
  });
  await db.execute({
    sql: `UPDATE DonorProduct SET
      identityStatus='exact_confirmed', identityMatcherVersion=?,
      identityEvidenceJson=?, identityConfirmedAt=?
      WHERE id=?`,
    args: [
      CANONICAL_PRODUCT_MATCHER_VERSION, JSON.stringify({ exact: true }),
      "2026-07-18T17:00:00.000Z", input.donorProductId,
    ],
  });
}

async function insertContent(
  db: Client,
  input: {
    id: string;
    donorProductId: string;
    variantId: string;
    decisionId: string;
    observedAt: string;
    title: string;
  },
): Promise<void> {
  const content = {
    title: input.title,
    description: `${input.title} exact description`,
    bullets: ["Crispy", "Source backed"],
    attributes: { form: "chips" },
    nutritionFacts: { calories: 150 },
    ingredients: "Potatoes, oil, seasoning",
    mainImageUrl: `https://images.example.test/${input.id}-main.jpg`,
    imageUrls: [
      `https://images.example.test/${input.id}-main.jpg`,
      `https://images.example.test/${input.id}-nutrition.jpg`,
    ],
  };
  await db.execute({
    sql: `INSERT INTO ProductContentObservation (
      id,observationKey,donorProductId,canonicalVariantId,variantDecisionId,
      sourceUrl,sourceApi,contentHash,fieldHashesJson,contentJson,observedAt,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      input.id, hash(`content:${input.id}`), input.donorProductId,
      canonicalVariantId(input.variantId),
      input.decisionId, `https://retailer.example.test/content/${input.id}`,
      "integration-test", hash(JSON.stringify(content)),
      JSON.stringify({ title: hash(input.title), imageUrls: hash("images") }),
      JSON.stringify(content), input.observedAt, input.observedAt,
    ],
  });
}

async function insertPrice(
  db: Client,
  input: {
    id: string;
    offerId: string;
    donorProductId: string;
    variantId: string;
    decisionId: string;
    retailer: string;
    retailerProductId: string;
    price: number;
    observedAt: string;
    via?: "direct" | "instacart";
  },
): Promise<void> {
  const via = input.via ?? "direct";
  const existingOffer = (await db.execute({
    sql: `SELECT donorProductId,retailer,retailerProductId,via
          FROM DonorOffer WHERE id=?`,
    args: [input.offerId],
  })).rows[0];
  if (existingOffer) {
    assert.deepEqual(
      [existingOffer.donorProductId, existingOffer.retailer,
        existingOffer.retailerProductId, existingOffer.via].map(String),
      [input.donorProductId, input.retailer, input.retailerProductId, via],
    );
  } else {
    await db.execute({
      sql: `INSERT INTO DonorOffer(
        id,donorProductId,retailer,retailerProductId,via
      ) VALUES (?,?,?,?,?)`,
      args: [
        input.offerId, input.donorProductId, input.retailer,
        input.retailerProductId, via,
      ],
    });
  }
  await db.execute({
    sql: `INSERT INTO DonorOfferObservation (
      id,observationKey,donorOfferId,donorProductId,canonicalVariantId,
      variantDecisionId,retailer,retailerProductId,via,title,price,packSizeSeen,
      pricePerUnit,currency,zip,localityEvidence,inStock,productUrl,sellerName,
      isFirstParty,sourceApi,observedAt,runId,approvalId,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      input.id, hash(`price:${input.id}`), input.offerId, input.donorProductId,
      canonicalVariantId(input.variantId), input.decisionId, input.retailer, input.retailerProductId,
      via, "Acme Crunch Chips Barbecue 8 oz", input.price, 1,
      input.price, "USD", "33765", "zip_scoped", 1,
      `https://${input.retailer.toLowerCase()}.example.test/${input.id}`,
      input.retailer, 1, "integration-test", input.observedAt,
      "run-approved", "approval-owner", input.observedAt,
    ],
  });
}

type ComponentSeed = {
  index: number;
  status: "FACT" | "MANUAL_FACT" | "ESTIMATE" | "REJECT";
  targetVariantId: string;
  contentVariantId?: string | null;
  priceVariantId?: string | null;
  contentObservationId?: string | null;
  priceObservationId?: string | null;
  matchTier: string;
  pricePolicyVersion?: string;
  evidence: Record<string, unknown>;
};

async function insertCanonicalCost(
  db: Client,
  input: {
    id: string;
    sku: string;
    channel: string;
    storeIndex?: number;
    outcome: "FACT" | "ESTIMATE" | "UNSOURCEABLE";
    totalCost: number | null;
    effectiveDate: string;
    createdAt: string;
    components: ComponentSeed[];
    manifestSha256?: string;
    pricePolicyVersion?: string;
    needsReview?: boolean;
  },
): Promise<void> {
  const storeIndex = input.storeIndex ?? 1;
  const listingKey = `${input.channel}:${storeIndex}:${input.sku}`;
  const scopeCreatedAt = new Date(Date.parse(input.createdAt) - 2_000).toISOString();
  if (!(await db.execute({
    sql: `SELECT 1 FROM ProductTruthListingScope WHERE listingKey=?`,
    args: [listingKey],
  })).rows.length) {
    await db.execute({
      sql: `INSERT INTO ProductTruthListingScope (
        listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
        manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
        sourceReportId,sourceContentSha256,sourceCapturedAt,createdAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        listingKey, "product-truth-listing-key/1.0.0", input.channel, storeIndex,
        input.sku, "AUTHORITATIVE_PHASE1_MANIFEST",
        "phase1-authoritative-scope-manifest/v3",
        input.manifestSha256 ?? hash(`manifest:${listingKey}`),
        scopeCreatedAt, `decision:${listingKey}`, `report:${listingKey}`,
        hash(`report:${listingKey}`), scopeCreatedAt, scopeCreatedAt,
      ],
    });
  }
  const recipeHash = hash(`recipe:${input.id}`);
  const preparedComponents = await Promise.all(input.components.map(async (component) => {
    const contentSource = component.contentObservationId
      ? (await db.execute({
          sql: `SELECT donorProductId FROM ProductContentObservation WHERE id=?`,
          args: [component.contentObservationId],
        })).rows[0] ?? null
      : null;
    const priceSource = component.priceObservationId
      ? (await db.execute({
          sql: `SELECT donorProductId,donorOfferId,variantDecisionId
                FROM DonorOfferObservation WHERE id=?`,
          args: [component.priceObservationId],
        })).rows[0] ?? null
      : null;
    const manual = component.evidence.manualCost as Record<string, unknown> | undefined;
    const comparable = component.evidence.targetComparableUnitPrice;
    const perUnit = typeof manual?.amount === "number"
      ? manual.amount
      : typeof comparable === "number"
        ? comparable
        : input.totalCost;
    const qty = typeof component.evidence.qty === "number" ? component.evidence.qty : 1;
    const matcherVersion = CANONICAL_PRODUCT_MATCHER_VERSION;
    const pricePolicyVersion = component.pricePolicyVersion ?? PRICE_EVIDENCE_POLICY_VERSION;
    const targetCanonicalVariantId = canonicalVariantId(component.targetVariantId);
    const contentCanonicalVariantId = component.contentVariantId
      ? canonicalVariantId(component.contentVariantId) : null;
    const priceCanonicalVariantId = component.priceVariantId
      ? canonicalVariantId(component.priceVariantId) : null;
    const method = typeof component.evidence.method === "string"
      ? component.evidence.method
      : component.status === "FACT" ? "exact"
        : component.status === "MANUAL_FACT" ? "own-brand"
          : component.status === "ESTIMATE" ? "typed-estimate" : "unsourceable";
    const childEvidence = {
      ...component.evidence,
      evidenceStatus: component.status,
      targetCanonicalVariantId,
      contentCanonicalVariantId,
      priceCanonicalVariantId,
      contentObservationId: component.contentObservationId ?? null,
      priceObservationId: component.priceObservationId ?? null,
      product: component.evidence.product,
      flavor: component.evidence.flavor ?? null,
      size: component.evidence.size ?? null,
      qty,
      perUnit,
      method,
      targetComparableUnitPrice: component.status === "ESTIMATE" ? perUnit : null,
      matchTier: component.matchTier,
      matcherVersion,
      pricePolicyVersion,
    };
    return {
      component,
      childEvidence,
      recipe: {
        idx: component.index,
        priceEvidenceStatus: component.status,
        targetCanonicalVariantId,
        contentCanonicalVariantId,
        priceCanonicalVariantId,
        contentObservationId: component.contentObservationId ?? null,
        priceEvidenceObservationId: component.priceObservationId ?? null,
        contentDonorProductId: contentSource?.donorProductId ?? null,
        priceEvidenceDonorProductId: priceSource?.donorProductId ?? null,
        priceEvidenceOfferId: priceSource?.donorOfferId ?? null,
        priceVariantDecisionId: priceSource?.variantDecisionId ?? null,
        matchTier: component.matchTier,
        matcherVersion,
        pricePolicyVersion,
        product: component.evidence.product,
        flavor: component.evidence.flavor ?? null,
        size: component.evidence.size ?? null,
        perUnit,
        qty,
        method,
      },
    };
  }));
  const statements: InStatement[] = [{
    sql: `INSERT INTO SkuCostListingScopeLink
      (skuCostId,listingKey,linkVersion,createdAt) VALUES (?,?,?,?)`,
    args: [input.id, listingKey, "sku-cost-listing-scope-link/1.0.0", input.createdAt],
  }, ...preparedComponents.map(({ component, childEvidence }) => ({
    sql: `INSERT INTO SkuComponentEvidence (
      id,evidenceKey,skuCostId,componentIndex,evidenceStatus,targetCanonicalVariantId,
      contentCanonicalVariantId,priceCanonicalVariantId,contentObservationId,
      priceObservationId,matchTier,matcherVersion,pricePolicyVersion,evidenceHash,
      evidenceJson,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      `sce:${input.id}:${component.index}`,
      hash(`evidence:${input.id}:${component.index}`),
      input.id, component.index, component.status, canonicalVariantId(component.targetVariantId),
      component.contentVariantId ? canonicalVariantId(component.contentVariantId) : null,
      component.priceVariantId ? canonicalVariantId(component.priceVariantId) : null,
      component.contentObservationId ?? null, component.priceObservationId ?? null,
      component.matchTier, CANONICAL_PRODUCT_MATCHER_VERSION,
      component.pricePolicyVersion ?? PRICE_EVIDENCE_POLICY_VERSION,
      hash(JSON.stringify(childEvidence)), JSON.stringify(childEvidence),
      new Date(Date.parse(input.createdAt) - 1_000).toISOString(),
    ],
  }))];
  statements.push({
    sql: `INSERT INTO SkuCost (
      id,sku,effectiveDate,productCost,totalCost,costPerUnit,packSize,
      includesPackaging,currency,source,needsReview,observationKey,recipeHash,
      evidenceJson,evidenceOutcome,matcherVersion,pricePolicyVersion,runId,
      approvalId,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      input.id, input.sku, input.effectiveDate, input.totalCost, input.totalCost,
      input.totalCost, input.totalCost === null ? null : 1, 0, "USD", "retail:batch",
      input.needsReview ? 1 : 0, hash(`cost:${input.id}`), recipeHash,
      JSON.stringify({
        schemaVersion: "product-truth-sku-cost-evidence/2.0.0",
        channel: input.channel,
        storeIndex,
        listingKey,
        listingKeyVersion: "product-truth-listing-key/1.0.0",
        outcome: input.outcome,
        recipeHash,
        evaluatedAt: input.createdAt,
        ...(input.totalCost === null ? {} : {
          total: input.totalCost,
          costPerUnit: input.totalCost,
          packSize: 1,
        }),
        components: preparedComponents.map((entry) => entry.recipe),
      }),
      input.outcome, CANONICAL_PRODUCT_MATCHER_VERSION,
      input.pricePolicyVersion ?? PRICE_EVIDENCE_POLICY_VERSION,
      "run-approved", "approval-owner", input.createdAt, input.createdAt,
    ],
  });
  await db.batch(statements, "write");
}

function exactComponent(input: {
  variantId: string;
  contentObservationId: string;
  priceObservationId: string;
}): ComponentSeed {
  return {
    index: 0,
    status: "FACT",
    targetVariantId: input.variantId,
    contentVariantId: input.variantId,
    priceVariantId: input.variantId,
    contentObservationId: input.contentObservationId,
    priceObservationId: input.priceObservationId,
    matchTier: "EXACT_IDENTITY",
    evidence: { qty: 1, product: "Acme Crunch Chips", flavor: "Barbecue", size: "8 oz" },
  };
}

test("read contract fails closed before canonical identity/content/evidence migration", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await assert.rejects(
      readProductTruthSnapshot(db, {
        sku: "SKU-1", channel: "walmart", storeIndex: 1,
        asOf: AS_OF, maxPriceAgeMs: MAX_AGE_MS,
      }),
      (error) => error instanceof ProductTruthSchemaNotReadyError,
    );
  } finally {
    await db.close();
  }
});

test("one canonical snapshot serves four views and permits different exact content/price donors", async () => {
  const db = createClient({ url: "file::memory:" });
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("read contract must not call network");
  }) as typeof fetch;
  try {
    await createBaseSchema(db);
    await applyCanonicalMigration(db);
    await insertVariant(db, {
      id: "variant-bbq", brand: "Acme", productLine: "Crunch Chips", flavor: "Barbecue",
    });
    await insertExactSource(db, {
      donorProductId: "dp-content", decisionId: "decision-content",
      variantId: "variant-bbq", flavor: "Barbecue",
    });
    await insertExactSource(db, {
      donorProductId: "dp-price", decisionId: "decision-price",
      variantId: "variant-bbq", flavor: "Barbecue",
    });
    await insertExactSource(db, {
      donorProductId: "dp-price-alt", decisionId: "decision-price-alt",
      variantId: "variant-bbq", flavor: "Barbecue",
    });
    await insertContent(db, {
      id: "content-current", donorProductId: "dp-content", variantId: "variant-bbq",
      decisionId: "decision-content", observedAt: "2026-07-18T19:00:00.000Z",
      title: "Acme Crunch Chips Barbecue 8 oz",
    });
    await insertPrice(db, {
      id: "price-a-old", offerId: "offer-a", donorProductId: "dp-price",
      variantId: "variant-bbq", decisionId: "decision-price", retailer: "Publix",
      retailerProductId: "publix-a", price: 1, observedAt: "2026-07-18T18:00:00.000Z",
    });
    await insertPrice(db, {
      id: "price-a-current", offerId: "offer-a", donorProductId: "dp-price",
      variantId: "variant-bbq", decisionId: "decision-price", retailer: "Publix",
      retailerProductId: "publix-a", price: 4.99,
      observedAt: "2026-07-18T19:30:00.000Z",
    });
    await insertPrice(db, {
      id: "price-b-current", offerId: "offer-b", donorProductId: "dp-price-alt",
      variantId: "variant-bbq", decisionId: "decision-price-alt", retailer: "Walmart",
      retailerProductId: "walmart-b", price: 4.25,
      observedAt: "2026-07-18T19:20:00.000Z",
    });
    await insertPrice(db, {
      id: "price-c-instacart", offerId: "offer-c", donorProductId: "dp-price-alt",
      variantId: "variant-bbq", decisionId: "decision-price-alt", retailer: "Target",
      retailerProductId: "target-c", price: 3.5,
      observedAt: "2026-07-18T19:40:00.000Z", via: "instacart",
    });
    const component = exactComponent({
      variantId: "variant-bbq", contentObservationId: "content-current",
      priceObservationId: "price-a-current",
    });
    const oldComponent = exactComponent({
      variantId: "variant-bbq", contentObservationId: "content-current",
      priceObservationId: "price-a-old",
    });
    await insertCanonicalCost(db, {
      id: "cost-old", sku: "SKU-EXACT", channel: "walmart", outcome: "FACT",
      totalCost: 1, effectiveDate: "2026-07-18T19:01:00.000Z",
      createdAt: "2026-07-18T19:01:00.000Z", components: [oldComponent],
    });
    await insertCanonicalCost(db, {
      id: "cost-current", sku: "SKU-EXACT", channel: "walmart", outcome: "FACT",
      totalCost: 4.99, effectiveDate: "2026-07-18T19:31:00.000Z",
      createdAt: "2026-07-18T19:31:00.000Z", components: [component],
    });

    const snapshot = await readProductTruthSnapshot(db, {
      sku: "SKU-EXACT", channel: "walmart", storeIndex: 1,
      asOf: AS_OF, maxPriceAgeMs: MAX_AGE_MS,
    });
    assert.equal(snapshot.contractVersion, PRODUCT_TRUTH_READ_CONTRACT_VERSION);
    assert.equal(snapshot.snapshot.skuCostId, "cost-current");
    assert.equal(snapshot.views.bundleFactory.ready, true);
    assert.equal(snapshot.views.listingImprovement.ready, true);
    const content = snapshot.views.bundleFactory.components[0].content;
    assert.equal(content?.canonicalVariantId, canonicalVariantId("variant-bbq"));
    assert.equal(content?.provenance.donorProductId, "dp-content");
    assert.equal(content?.facts.title, "Acme Crunch Chips Barbecue 8 oz");
    assert.equal(snapshot.views.unitEconomics.status, "FACT");
    assert.equal(snapshot.views.unitEconomics.current?.id, "cost-current");
    assert.equal(snapshot.views.unitEconomics.factualCost?.totalCost, 4.99);
    assert.deepEqual(
      snapshot.views.unitEconomics.current?.componentProvenance.map((entry) => entry.kind),
      ["RETAILER"],
    );
    const procurement = snapshot.views.procurement.components[0];
    assert.equal(snapshot.views.procurement.ready, true);
    assert.deepEqual(
      procurement.factualOptions.map((option) =>
        [option.rank, option.observationId, option.observedUnitPrice]),
      [[1, "price-b-current", 4.25], [2, "price-a-current", 4.99]],
    );
    assert.equal(procurement.factualOptions[1].donorProductId, "dp-price");
    assert.notEqual(
      content?.provenance.donorProductId,
      procurement.factualOptions[1].donorProductId,
      "content and price source donors may differ when canonical variant is identical",
    );
    assert.equal(
      procurement.factualOptions[0].canonicalVariantId,
      canonicalVariantId("variant-bbq"),
    );
    assert.equal(procurement.factualOptions[0].locality.zip, "33765");
    assert.equal(procurement.factualOptions[0].productUrl, "https://walmart.example.test/price-b-current");
    assert.deepEqual(
      procurement.estimateOptions.map((option) => option.observationId),
      ["price-c-instacart"],
    );
    assert.equal(
      procurement.factualOptions.some((option) => option.observationId === "price-a-old"),
      false,
    );
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await db.close();
  }
});

test("typed estimate proxy content cannot leak into the target variant", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await applyCanonicalMigration(db);
    await insertVariant(db, {
      id: "variant-bbq", brand: "Acme", productLine: "Crunch Chips", flavor: "Barbecue",
    });
    await insertVariant(db, {
      id: "variant-ranch", brand: "Acme", productLine: "Crunch Chips", flavor: "Ranch",
    });
    await insertExactSource(db, {
      donorProductId: "dp-ranch", decisionId: "decision-ranch",
      variantId: "variant-ranch", flavor: "Ranch",
    });
    await insertContent(db, {
      id: "content-ranch", donorProductId: "dp-ranch", variantId: "variant-ranch",
      decisionId: "decision-ranch", observedAt: "2026-07-18T19:00:00.000Z",
      title: "Acme Crunch Chips Ranch 8 oz",
    });
    await insertPrice(db, {
      id: "price-ranch", offerId: "offer-ranch", donorProductId: "dp-ranch",
      variantId: "variant-ranch", decisionId: "decision-ranch", retailer: "Publix",
      retailerProductId: "publix-ranch", price: 5,
      observedAt: "2026-07-18T19:10:00.000Z",
    });
    await insertCanonicalCost(db, {
      id: "cost-estimate", sku: "SKU-ESTIMATE", channel: "amazon", outcome: "ESTIMATE",
      totalCost: 5.5, effectiveDate: "2026-07-18T19:11:00.000Z",
      createdAt: "2026-07-18T19:11:00.000Z", needsReview: true,
      components: [{
        index: 0, status: "ESTIMATE", targetVariantId: "variant-bbq",
        priceVariantId: "variant-ranch", priceObservationId: "price-ranch",
        matchTier: "SIBLING_ESTIMATE",
        evidence: {
          qty: 1, product: "Acme Crunch Chips", flavor: "Barbecue", size: "8 oz",
          targetComparableUnitPrice: 5.5,
        },
      }],
    });

    const snapshot = await readProductTruthSnapshot(db, {
      sku: "SKU-ESTIMATE", channel: "amazon", storeIndex: 1,
      asOf: AS_OF, maxPriceAgeMs: MAX_AGE_MS,
    });
    assert.equal(snapshot.views.bundleFactory.ready, false);
    assert.equal(snapshot.views.listingImprovement.ready, false);
    assert.equal(snapshot.views.bundleFactory.components[0].content, null);
    assert.equal(snapshot.views.unitEconomics.status, "ESTIMATE");
    assert.equal(snapshot.views.unitEconomics.factualCost, null);
    assert.equal(snapshot.views.unitEconomics.estimatedCost?.totalCost, 5.5);
    assert.deepEqual(snapshot.views.procurement.components[0].factualOptions, []);
    assert.equal(snapshot.views.procurement.components[0].estimateOptions.length, 1);
    assert.equal(
      snapshot.views.procurement.components[0].estimateOptions[0].targetComparableUnitPrice,
      5.5,
    );
    assert.equal(snapshot.views.procurement.ready, false);
  } finally {
    await db.close();
  }
});

test("exact target content remains ready with a cross-size ESTIMATE price", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await applyCanonicalMigration(db);
    await insertVariant(db, {
      id: "variant-bbq", brand: "Acme", productLine: "Crunch Chips", flavor: "Barbecue",
    });
    await insertVariant(db, {
      id: "variant-bbq-large", brand: "Acme", productLine: "Crunch Chips", flavor: "Barbecue",
    });
    await insertExactSource(db, {
      donorProductId: "dp-bbq-content", decisionId: "decision-bbq-content",
      variantId: "variant-bbq", flavor: "Barbecue",
    });
    await insertContent(db, {
      id: "content-bbq", donorProductId: "dp-bbq-content", variantId: "variant-bbq",
      decisionId: "decision-bbq-content", observedAt: "2026-07-18T19:00:00.000Z",
      title: "Acme Crunch Chips Barbecue 8 oz",
    });
    await insertExactSource(db, {
      donorProductId: "dp-bbq-large", decisionId: "decision-bbq-large",
      variantId: "variant-bbq-large", flavor: "Barbecue",
    });
    await insertPrice(db, {
      id: "price-bbq-large", offerId: "offer-bbq-large",
      donorProductId: "dp-bbq-large", variantId: "variant-bbq-large",
      decisionId: "decision-bbq-large", retailer: "Publix",
      retailerProductId: "publix-bbq-large", price: 3.5,
      observedAt: "2026-07-18T19:10:00.000Z",
    });
    await insertCanonicalCost(db, {
      id: "cost-cross-size", sku: "SKU-CROSS-SIZE", channel: "amazon",
      outcome: "ESTIMATE", totalCost: 4.25,
      effectiveDate: "2026-07-18T19:11:00.000Z",
      createdAt: "2026-07-18T19:11:00.000Z", needsReview: true,
      components: [{
        index: 0, status: "ESTIMATE", targetVariantId: "variant-bbq",
        contentVariantId: "variant-bbq", contentObservationId: "content-bbq",
        priceVariantId: "variant-bbq-large", priceObservationId: "price-bbq-large",
        matchTier: "CROSS_SIZE_ESTIMATE",
        evidence: {
          qty: 1, product: "Acme Crunch Chips", flavor: "Barbecue", size: "8 oz",
          targetComparableUnitPrice: 4.25,
        },
      }],
    });

    const snapshot = await readProductTruthSnapshot(db, {
      sku: "SKU-CROSS-SIZE", channel: "amazon", storeIndex: 1, asOf: AS_OF,
      maxPriceAgeMs: MAX_AGE_MS,
    });
    assert.equal(snapshot.views.bundleFactory.ready, true);
    assert.equal(snapshot.views.listingImprovement.ready, true);
    assert.equal(
      snapshot.views.bundleFactory.components[0].content?.provenance.contentObservationId,
      "content-bbq",
    );
    assert.equal(snapshot.views.unitEconomics.status, "ESTIMATE");
    assert.equal(snapshot.views.unitEconomics.estimatedCost?.totalCost, 4.25);
    assert.deepEqual(snapshot.views.procurement.components[0].factualOptions, []);
    assert.equal(snapshot.views.procurement.components[0].estimateOptions.length, 1);
    assert.equal(snapshot.views.procurement.ready, false);
  } finally {
    await db.close();
  }
});

test("factual price remains FACT when exact content is not available", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await applyCanonicalMigration(db);
    await insertVariant(db, {
      id: "variant-no-content", brand: "Acme", productLine: "Crunch Chips",
      flavor: "Barbecue",
    });
    await insertExactSource(db, {
      donorProductId: "dp-no-content", decisionId: "decision-no-content",
      variantId: "variant-no-content", flavor: "Barbecue",
    });
    await insertPrice(db, {
      id: "price-no-content", offerId: "offer-no-content",
      donorProductId: "dp-no-content", variantId: "variant-no-content",
      decisionId: "decision-no-content", retailer: "Walmart",
      retailerProductId: "walmart-no-content", price: 3.99,
      observedAt: "2026-07-18T19:10:00.000Z",
    });
    await insertCanonicalCost(db, {
      id: "cost-no-content", sku: "SKU-NO-CONTENT", channel: "walmart",
      outcome: "FACT", totalCost: 3.99,
      effectiveDate: "2026-07-18T19:11:00.000Z",
      createdAt: "2026-07-18T19:11:00.000Z",
      components: [{
        index: 0, status: "FACT", targetVariantId: "variant-no-content",
        priceVariantId: "variant-no-content", priceObservationId: "price-no-content",
        matchTier: "EXACT_IDENTITY",
        evidence: {
          qty: 1, product: "Acme Crunch Chips", flavor: "Barbecue", size: "8 oz",
        },
      }],
    });

    const snapshot = await readProductTruthSnapshot(db, {
      sku: "SKU-NO-CONTENT", channel: "walmart", storeIndex: 1, asOf: AS_OF,
      maxPriceAgeMs: MAX_AGE_MS,
    });
    assert.equal(snapshot.views.unitEconomics.status, "FACT");
    assert.equal(snapshot.views.unitEconomics.factualCost?.totalCost, 3.99);
    assert.equal(snapshot.views.procurement.ready, true);
    assert.equal(snapshot.views.bundleFactory.ready, false);
    assert.equal(snapshot.views.listingImprovement.ready, false);
    assert.equal(snapshot.views.bundleFactory.components[0].content, null);
    assert.match(
      snapshot.views.bundleFactory.components[0].contentBlockers.join(" "),
      /CURRENT_CONTENT_OBSERVATION_MISSING/,
    );
  } finally {
    await db.close();
  }
});

test("exact identity can remain ESTIMATE when the price source is typed as non-factual", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await applyCanonicalMigration(db);
    await insertVariant(db, {
      id: "variant-exact-estimate", brand: "Acme", productLine: "Crunch Chips",
      flavor: "Barbecue",
    });
    await insertExactSource(db, {
      donorProductId: "dp-exact-estimate", decisionId: "decision-exact-estimate",
      variantId: "variant-exact-estimate", flavor: "Barbecue",
    });
    await insertPrice(db, {
      id: "price-exact-instacart", offerId: "offer-exact-instacart",
      donorProductId: "dp-exact-estimate", variantId: "variant-exact-estimate",
      decisionId: "decision-exact-estimate", retailer: "Publix",
      retailerProductId: "publix-exact-instacart", price: 4.5,
      observedAt: "2026-07-18T19:10:00.000Z", via: "instacart",
    });
    await insertCanonicalCost(db, {
      id: "cost-exact-estimate", sku: "SKU-EXACT-ESTIMATE", channel: "walmart",
      outcome: "ESTIMATE", totalCost: 4.5,
      effectiveDate: "2026-07-18T19:11:00.000Z",
      createdAt: "2026-07-18T19:11:00.000Z", needsReview: true,
      components: [{
        index: 0, status: "ESTIMATE", targetVariantId: "variant-exact-estimate",
        priceVariantId: "variant-exact-estimate",
        priceObservationId: "price-exact-instacart", matchTier: "EXACT_IDENTITY",
        evidence: {
          qty: 1, product: "Acme Crunch Chips", flavor: "Barbecue", size: "8 oz",
          targetComparableUnitPrice: 4.5,
        },
      }],
    });

    const snapshot = await readProductTruthSnapshot(db, {
      sku: "SKU-EXACT-ESTIMATE", channel: "walmart", storeIndex: 1, asOf: AS_OF,
      maxPriceAgeMs: MAX_AGE_MS,
    });
    assert.equal(snapshot.views.unitEconomics.status, "ESTIMATE");
    assert.equal(snapshot.views.unitEconomics.estimatedCost?.totalCost, 4.5);
    assert.equal(snapshot.views.bundleFactory.components[0].content, null);
    assert.equal(snapshot.views.procurement.components[0].factualOptions.length, 0);
    assert.equal(snapshot.views.procurement.components[0].estimateOptions.length, 1);
  } finally {
    await db.close();
  }
});

test("manual fact is explicit accounting provenance and never a retailer buy option", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await applyCanonicalMigration(db);
    await insertVariant(db, {
      id: "variant-own", brand: "Salutem", productLine: "House Granola", flavor: "Original",
    });
    const manualPolicy = "manual-cost-policy/1.0.0";
    await insertCanonicalCost(db, {
      id: "cost-manual", sku: "SKU-MANUAL", channel: "walmart", outcome: "FACT",
      totalCost: 2.25, effectiveDate: "2026-07-18T19:00:00.000Z",
      createdAt: "2026-07-18T19:00:00.000Z", pricePolicyVersion: manualPolicy,
      components: [{
        index: 0, status: "MANUAL_FACT", targetVariantId: "variant-own",
        matchTier: "MANUAL_COST", pricePolicyVersion: manualPolicy,
        evidence: {
          qty: 1, product: "Salutem House Granola", flavor: "Original", size: "8 oz",
          manualCost: {
            amount: 2.25, currency: "USD", effectiveAt: "2026-07-18T18:00:00.000Z",
            source: "owner-approved landed cost", approvalRef: "owner-2026-07-18",
            policyVersion: manualPolicy, actor: "Vladimir",
            reason: "owner-approved landed cost fixture",
          },
        },
      }],
    });

    const snapshot = await readProductTruthSnapshot(db, {
      sku: "SKU-MANUAL", channel: "walmart", storeIndex: 1,
      asOf: AS_OF, maxPriceAgeMs: MAX_AGE_MS,
    });
    assert.equal(snapshot.views.unitEconomics.status, "FACT");
    assert.deepEqual(
      snapshot.views.unitEconomics.current?.componentProvenance.map((entry) => entry.kind),
      ["MANUAL"],
    );
    const procurement = snapshot.views.procurement.components[0];
    assert.equal(procurement.manualCost?.kind, "MANUAL");
    assert.equal(procurement.manualCost?.amount, 2.25);
    assert.deepEqual(procurement.factualOptions, []);
    assert.deepEqual(procurement.estimateOptions, []);
    assert.match(procurement.blockers.join(" "), /MANUAL_COST_NOT_RETAILER_BUY_OPTION/);
    assert.equal(snapshot.views.procurement.ready, false);
  } finally {
    await db.close();
  }
});

test("latest UNSOURCEABLE cost wins over an older positive legacy cost", async () => {
  const directory = await mkdtemp(join(tmpdir(), "product-truth-unsourceable-"));
  const db = createClient({ url: `file:${join(directory, "unsourceable.db")}` });
  try {
    await createBaseSchema(db);
    // This row represents pre-canonical history. New post-migration writes must
    // carry canonical evidence; the migration intentionally does not rewrite it.
    await db.execute({
      sql: `INSERT INTO SkuCost (
        id,sku,effectiveDate,totalCost,costPerUnit,packSize,currency,source,
        needsReview,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "legacy-positive", "SKU-NONE", "2026-07-18T18:00:00.000Z", 9.99, 9.99,
        1, "USD", "retail:batch", 0, "2026-07-18T18:00:00.000Z",
        "2026-07-18T18:00:00.000Z",
      ],
    });
    await db.execute({
      sql: `INSERT INTO SkuCost (
        id,sku,effectiveDate,totalCost,costPerUnit,packSize,currency,source,
        needsReview,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "newer-non-retail", "SKU-NONE", "2026-07-18T19:30:00.000Z",
        7.77, 7.77, 1, "USD", "sellerboard", 0,
        "2026-07-18T19:30:00.000Z", "2026-07-18T19:30:00.000Z",
      ],
    });
    await applyCanonicalMigration(db);
    await db.execute({
      sql: `INSERT INTO ProductTruthListingScope (
        listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
        manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
        sourceReportId,sourceContentSha256,sourceCapturedAt,createdAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "walmart:2:SKU-NONE", "product-truth-listing-key/1.0.0", "walmart", 2,
        "SKU-NONE", "AUTHORITATIVE_PHASE1_MANIFEST",
        "phase1-authoritative-scope-manifest/v3", hash("manifest:walmart:2:SKU-NONE"),
        "2026-07-18T18:00:00.000Z", "decision:walmart:2:SKU-NONE",
        "report:walmart:2:SKU-NONE", hash("report:walmart:2:SKU-NONE"),
        "2026-07-18T18:00:00.000Z", "2026-07-18T18:00:00.000Z",
      ],
    });
    await insertVariant(db, {
      id: "variant-none", brand: "Acme", productLine: "Unknown Item", flavor: "Original",
    });
    await insertExactSource(db, {
      donorProductId: "dp-none-content", decisionId: "decision-none-content",
      variantId: "variant-none", flavor: "Original",
    });
    await insertContent(db, {
      id: "content-none", donorProductId: "dp-none-content", variantId: "variant-none",
      decisionId: "decision-none-content", observedAt: "2026-07-18T18:30:00.000Z",
      title: "Acme Unknown Item Original 8 oz",
    });
    await insertCanonicalCost(db, {
      id: "cost-unsourceable", sku: "SKU-NONE", channel: "walmart",
      outcome: "UNSOURCEABLE", totalCost: null,
      effectiveDate: "2026-07-18T19:00:00.000Z",
      createdAt: "2026-07-18T19:00:00.000Z", needsReview: true,
      components: [{
        index: 0, status: "REJECT", targetVariantId: "variant-none",
        contentVariantId: "variant-none", contentObservationId: "content-none",
        matchTier: "REJECT",
        evidence: { qty: 1, product: "Acme Unknown Item", flavor: "Original", size: "8 oz" },
      }],
    });

    const snapshot = await readProductTruthSnapshot(db, {
      sku: "SKU-NONE", channel: "walmart", storeIndex: 1,
      asOf: AS_OF, maxPriceAgeMs: MAX_AGE_MS,
    });
    assert.equal(snapshot.views.unitEconomics.status, "UNSOURCEABLE");
    assert.equal(snapshot.views.unitEconomics.current?.id, "cost-unsourceable");
    assert.equal(snapshot.views.unitEconomics.current?.totalCost, null);
    assert.equal(snapshot.views.unitEconomics.factualCost, null);
    assert.equal(snapshot.views.bundleFactory.ready, true);
    assert.equal(snapshot.views.listingImprovement.ready, true);
    assert.equal(
      snapshot.views.bundleFactory.components[0].content?.provenance.contentObservationId,
      "content-none",
    );
    assert.equal(snapshot.views.procurement.ready, false);
    assert.deepEqual(snapshot.views.procurement.components[0].factualOptions, []);
    assert.deepEqual(snapshot.views.procurement.components[0].estimateOptions, []);
    const unscopedLegacyMustNotFallback = await readProductTruthSnapshot(db, {
      sku: "SKU-NONE", channel: "walmart", storeIndex: 2,
      asOf: AS_OF, maxPriceAgeMs: MAX_AGE_MS,
    });
    assert.equal(unscopedLegacyMustNotFallback.views.unitEconomics.status, "MISSING");
    assert.equal(unscopedLegacyMustNotFallback.snapshot.skuCostId, null);
    assert.ok(unscopedLegacyMustNotFallback.views.unitEconomics.blockers.includes(
      "CURRENT_SCOPED_SKU_COST_MISSING",
    ));
  } finally {
    await db.close();
  }
});

test("exact listing scope isolates cross-channel and same-channel account collisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "product-truth-scope-"));
  const db = createClient({ url: `file:${join(directory, "scope.db")}` });
  try {
    await createBaseSchema(db);
    await applyCanonicalMigration(db);
    await insertVariant(db, {
      id: "variant-collision", brand: "Acme", productLine: "Crunch Chips", flavor: "Barbecue",
    });
    await insertExactSource(db, {
      donorProductId: "dp-collision", decisionId: "decision-collision",
      variantId: "variant-collision", flavor: "Barbecue",
    });
    await insertContent(db, {
      id: "content-collision", donorProductId: "dp-collision",
      variantId: "variant-collision", decisionId: "decision-collision",
      observedAt: "2026-07-18T18:00:00.000Z", title: "Acme Crunch Chips Barbecue 8 oz",
    });
    await insertPrice(db, {
      id: "price-collision", offerId: "offer-collision", donorProductId: "dp-collision",
      variantId: "variant-collision", decisionId: "decision-collision", retailer: "Walmart",
      retailerProductId: "collision-item", price: 3.99,
      observedAt: "2026-07-18T18:30:00.000Z",
    });
    const component = exactComponent({
      variantId: "variant-collision", contentObservationId: "content-collision",
      priceObservationId: "price-collision",
    });
    const authoritativeManifestSha256 = hash("manifest:shared-phase1-scope");
    const exactScopes = [
      { id: "cost-amazon-1", channel: "amazon", storeIndex: 1 },
      { id: "cost-amazon-3", channel: "amazon", storeIndex: 3 },
      { id: "cost-walmart-1", channel: "walmart", storeIndex: 1 },
    ];
    for (const scope of exactScopes) {
      await insertCanonicalCost(db, {
        ...scope, sku: "SHARED-SKU", outcome: "FACT", totalCost: 3.99,
        effectiveDate: "2026-07-18T19:00:00.000Z",
        createdAt: "2026-07-18T19:00:00.000Z", components: [component],
        manifestSha256: authoritativeManifestSha256,
      });
    }
    const singleByListingKey = new Map<string, Awaited<ReturnType<typeof readProductTruthSnapshot>>>();
    for (const expected of exactScopes) {
      const snapshot = await readProductTruthSnapshot(db, {
        sku: "SHARED-SKU", channel: expected.channel, storeIndex: expected.storeIndex,
        expectedManifestSha256: authoritativeManifestSha256,
        asOf: AS_OF, maxPriceAgeMs: MAX_AGE_MS,
      });
      assert.equal(snapshot.snapshot.skuCostId, expected.id);
      assert.equal(snapshot.snapshot.listingKey,
        `${expected.channel}:${expected.storeIndex}:SHARED-SKU`);
      singleByListingKey.set(snapshot.snapshot.listingKey, snapshot);
    }
    const requestedOrder = [exactScopes[2], exactScopes[0], exactScopes[1]];
    const batch = await readProductTruthSnapshots(db, {
      scopes: requestedOrder.map(({ channel, storeIndex }) => ({
        sku: "SHARED-SKU", channel, storeIndex,
      })),
      expectedManifestSha256: authoritativeManifestSha256,
      asOf: AS_OF,
      maxPriceAgeMs: MAX_AGE_MS,
    });
    assert.deepEqual(
      batch,
      requestedOrder.map(({ channel, storeIndex }) =>
        singleByListingKey.get(`${channel}:${storeIndex}:SHARED-SKU`)),
      "set-based batch must preserve caller order and point-read semantics",
    );
    const activation = buildProductTruthConsumerActivation({
      approvalId: "owner-read-contract-integration",
      mode: "SHADOW",
      authoritativeManifestSha256,
      databaseTargetFingerprint: hash("read-contract-integration-db"),
      consumers: ["UNIT_ECONOMICS"],
      issuedAt: "2026-07-18T19:00:00.000Z",
      expiresAt: "2026-07-19T19:00:00.000Z",
      maxPriceAgeMs: MAX_AGE_MS,
      maxListingsPerBatch: 3,
    });
    const activationSha256 = productTruthConsumerActivationSha256(activation);
    const validatedActivation = validateProductTruthConsumerActivation({
      activation,
      activationSha256,
      confirmation: expectedProductTruthConsumerActivationConfirmation(
        activationSha256,
        activation.ownerApproval.approvalId,
        activation.mode,
      ),
      runtimeBinding: {
        mode: "SHADOW",
        readContractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
        authoritativeManifestSha256,
        databaseTargetFingerprint: activation.databaseTargetFingerprint,
        consumers: ["UNIT_ECONOMICS"],
        maxPriceAgeMs: MAX_AGE_MS,
        maxListingsPerBatch: 3,
      },
      now: AS_OF,
    });
    const gateway = await readProductTruthConsumerBatch(db, {
      validatedActivation,
      consumer: "UNIT_ECONOMICS",
      scopes: requestedOrder.map(({ channel, storeIndex }) => ({
        sku: "SHARED-SKU", channel, storeIndex,
      })),
      readAt: AS_OF,
    });
    assert.equal(gateway.outputUse, "COMPARE_ONLY");
    assert.equal(gateway.counts.ready, 3);
    assert.deepEqual(
      gateway.entries.map((entry) =>
        entry.view.consumer === "UNIT_ECONOMICS" ? entry.view.current?.id : null),
      requestedOrder.map((entry) => entry.id),
    );
    const manifestBound = await readProductTruthSnapshot(db, {
      sku: "SHARED-SKU", channel: "amazon", storeIndex: 1,
      expectedManifestSha256: authoritativeManifestSha256,
      asOf: AS_OF, maxPriceAgeMs: MAX_AGE_MS,
    });
    assert.equal(manifestBound.views.unitEconomics.status, "FACT");
    const staleManifest = await readProductTruthSnapshot(db, {
      sku: "SHARED-SKU", channel: "amazon", storeIndex: 1,
      expectedManifestSha256: hash("superseded-authoritative-manifest"),
      asOf: AS_OF, maxPriceAgeMs: MAX_AGE_MS,
    });
    assert.equal(staleManifest.views.bundleFactory.ready, false);
    assert.equal(staleManifest.views.listingImprovement.ready, false);
    assert.equal(staleManifest.views.unitEconomics.status, "INVALID");
    assert.equal(staleManifest.views.procurement.ready, false);
    for (const blockers of [
      staleManifest.views.bundleFactory.blockers,
      staleManifest.views.listingImprovement.blockers,
      staleManifest.views.unitEconomics.blockers,
      staleManifest.views.procurement.blockers,
    ]) assert.ok(blockers.includes("LISTING_SCOPE_MANIFEST_MISMATCH"));
    const staleManifestBatch = await readProductTruthSnapshots(db, {
      scopes: exactScopes.map(({ channel, storeIndex }) => ({
        sku: "SHARED-SKU", channel, storeIndex,
      })),
      expectedManifestSha256: hash("superseded-authoritative-manifest"),
      asOf: AS_OF,
      maxPriceAgeMs: MAX_AGE_MS,
    });
    assert.equal(staleManifestBatch.length, exactScopes.length);
    for (const snapshot of staleManifestBatch) {
      assert.equal(snapshot.views.bundleFactory.ready, false);
      assert.equal(snapshot.views.listingImprovement.ready, false);
      assert.equal(snapshot.views.unitEconomics.status, "INVALID");
      assert.equal(snapshot.views.procurement.ready, false);
      assert.ok(snapshot.recipe.blockers.includes("LISTING_SCOPE_MANIFEST_MISMATCH"));
    }
    await assert.rejects(
      readProductTruthSnapshot(db, {
        sku: "SHARED-SKU", channel: "amazon", storeIndex: 1,
        expectedManifestSha256: "not-a-sha",
        asOf: AS_OF, maxPriceAgeMs: MAX_AGE_MS,
      }),
      (error) => error instanceof ProductTruthReadInputError,
    );
    await assert.rejects(
      readProductTruthSnapshots(db, {
        scopes: [
          { sku: "SHARED-SKU", channel: "amazon", storeIndex: 1 },
          { sku: "SHARED-SKU", channel: "amazon", storeIndex: 1 },
        ],
        expectedManifestSha256: authoritativeManifestSha256,
        asOf: AS_OF,
        maxPriceAgeMs: MAX_AGE_MS,
      }),
      (error) => error instanceof ProductTruthReadInputError &&
        /duplicate exact listing scope/.test(error.message),
    );
    assert.equal(PRODUCT_TRUTH_MAX_BATCH_SCOPES, 100);
    await assert.rejects(
      readProductTruthSnapshots(db, {
        scopes: Array.from({ length: PRODUCT_TRUTH_MAX_BATCH_SCOPES + 1 }, (_, index) => ({
          sku: `BATCH-LIMIT-${index}`, channel: "amazon", storeIndex: 1,
        })),
        expectedManifestSha256: authoritativeManifestSha256,
        asOf: AS_OF,
        maxPriceAgeMs: MAX_AGE_MS,
      }),
      (error) => error instanceof ProductTruthReadInputError &&
        /scopes must contain 1-100/.test(error.message),
    );
    const mismatch = await readProductTruthSnapshot(db, {
      sku: "SHARED-SKU", channel: "amazon", storeIndex: 2,
      asOf: AS_OF, maxPriceAgeMs: MAX_AGE_MS,
    });
    assert.equal(mismatch.views.bundleFactory.ready, false);
    assert.equal(mismatch.views.listingImprovement.ready, false);
    assert.equal(mismatch.views.unitEconomics.status, "MISSING");
    assert.equal(mismatch.views.procurement.ready, false);
    for (const blockers of [
      mismatch.views.bundleFactory.blockers,
      mismatch.views.listingImprovement.blockers,
      mismatch.views.unitEconomics.blockers,
      mismatch.views.procurement.blockers,
    ]) assert.ok(blockers.includes("LISTING_SCOPE_NOT_REGISTERED"));
  } finally {
    await db.close();
  }
});
