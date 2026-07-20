import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createClient, type Client } from "@libsql/client";

import {
  ExactContentSnapshotBlockedError,
  persistCompleteExactContentObservation,
  persistScoredDonorOffer,
  scoredDonorOfferCanonicalVariantId,
} from "../donor-catalog";
import { listProductTruthWalmartPilotCandidates } from "../product-truth-read-contract";
import { renderProductTruthOperationalJson } from "../product-truth-operational-run-contract";
import { expectedMeteredRunConfirmation } from "../metered-call-guard";
import { readTargetedWalmartDonorSnapshot } from "../product-truth-targeted-walmart-evidence";
import {
  scoreOffer,
  type CanonicalProduct,
  type RetailOffer,
  type ScoredOffer,
} from "../retail-fetch";

const NOW = "2026-07-18T20:30:00.000Z";
const DETAIL_OBSERVED_AT = "2026-07-18T20:35:00.000Z";
const DETAIL_PROCESSING_NOW = "2026-07-18T20:40:00.000Z";

const EIGHT_OZ: CanonicalProduct = {
  brand: "Acme",
  product_line: "Potato Chips",
  flavor: "Original",
  base_unit: "Bag",
  size: "8 oz",
  outer_pack_count: 1,
};

const TWELVE_OZ: CanonicalProduct = {
  ...EIGHT_OZ,
  size: "12 oz",
};

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
  const migration = new URL(
    "../../../../prisma/migrations/20260718234500_product_truth_evidence_provenance/migration.sql",
    import.meta.url,
  );
  await db.executeMultiple(await readFile(migration, "utf8"));
}

function sourceOffer(input: {
  target: CanonicalProduct;
  retailer: string;
  retailerProductId: string;
  title: string;
  price?: number;
  observedAt?: string;
  metered?: { receiptId: string; runId: string; approvalId: string };
}): ScoredOffer {
  const offer: RetailOffer = {
    retailer: input.retailer,
    retailerProductId: input.retailerProductId,
    price: input.price ?? 3.99,
    currency: "USD",
    inStock: true,
    productUrl: `https://${input.retailer}.example.test/item/${input.retailerProductId}`,
    zip: "33765",
    localityEvidence: "zip_scoped",
    observedAt: input.observedAt ?? "2026-07-18T20:00:00.000Z",
    title: input.title,
    description: `Source description for ${input.title}`,
    keyFeatures: ["Source bullet"],
    imageUrls: [`https://images.example.test/${input.retailerProductId}.jpg`],
    packSizeSeen: 1,
    isMarketplaceItem: false,
    sellerName: input.retailer === "walmart" ? "Walmart.com" : input.retailer,
    sourceApi: "scratch-test",
    via: "direct",
    ...(input.metered ? {
      meteredReceiptId: input.metered.receiptId,
      meteredRunId: input.metered.runId,
      meteredApprovalId: input.metered.approvalId,
    } : {}),
  };
  const scored = scoreOffer(offer, input.target);
  assert.equal(scored.accepted, true, scored.rejectReason ?? "offer rejected");
  return scored;
}

async function withScratchDb(run: (db: Client) => Promise<void>): Promise<void> {
  // Interactive libSQL transactions may use a second SQLite connection; a
  // named scratch file keeps both connections on the same isolated database.
  const directory = await mkdtemp(join(tmpdir(), "donor-canonical-persistence-"));
  const db = createClient({ url: `file:${join(directory, "scratch.db")}` });
  try {
    await createBaseSchema(db);
    await run(db);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("sealed exact scope rolls back before any write when target row bytes drift", async () => {
  await withScratchDb(async (db) => {
    const base = sourceOffer({
      target: EIGHT_OZ,
      retailer: "walmart",
      retailerProductId: "123456789",
      title: "Acme Potato Chips Original Bag, 8 oz",
    });
    const offer: ScoredOffer = {
      ...base,
      productUrl: "https://www.walmart.com/ip/acme/123456789",
      sellerName: "Walmart.com",
      sourceApi: "oxylabs",
      meteredReceiptId: "receipt-strict-1",
      meteredRunId: "run-strict-1",
      meteredApprovalId: "approval-strict-1",
    };
    const initial = await persistScoredDonorOffer(db, offer, EIGHT_OZ, NOW);
    assert.ok(initial.variantDecisionId);
    assert.ok(initial.canonicalVariantId);
    const productRow = (await db.execute({
      sql: `SELECT * FROM DonorProduct WHERE id=?`,
      args: [initial.donorProductId],
    })).rows[0] as Record<string, unknown>;
    const offerRow = (await db.execute({
      sql: `SELECT * FROM DonorOffer WHERE id=?`,
      args: [initial.donorOfferId],
    })).rows[0] as Record<string, unknown>;
    await db.execute({
      sql: `UPDATE DonorProduct SET title='concurrent drift' WHERE id=?`,
      args: [initial.donorProductId],
    });
    const before = (await db.execute(`SELECT
      (SELECT COUNT(*) FROM DonorProduct) AS products,
      (SELECT COUNT(*) FROM DonorOffer) AS offers,
      (SELECT COUNT(*) FROM CanonicalProductVariant) AS variants,
      (SELECT COUNT(*) FROM DonorProductVariantDecision) AS decisions,
      (SELECT COUNT(*) FROM DonorOfferObservation) AS priceObservations,
      (SELECT COUNT(*) FROM ProductContentObservation) AS contentObservations`)).rows[0]!;

    const permit = {
      version: 1 as const,
      runId: "run-strict-1",
      approvalId: "approval-strict-1",
      approvedBy: "owner" as const,
      issuedAt: "2026-07-18T20:00:00.000Z",
      expiresAt: "2026-07-18T21:00:00.000Z",
      providers: {
        oxylabs: { operations: ["query"], maxCalls: 1, maxUnits: 1 },
      },
    };
    const previousPermit = process.env.SS_METERED_RUN_PERMIT;
    const previousConfirmation = process.env.SS_METERED_RUN_CONFIRM;
    process.env.SS_METERED_RUN_PERMIT = Buffer.from(JSON.stringify(permit)).toString("base64url");
    process.env.SS_METERED_RUN_CONFIRM = expectedMeteredRunConfirmation(permit);
    try {
      await assert.rejects(
        persistScoredDonorOffer(db, offer, EIGHT_OZ, NOW, {
        exactScope: {
          donorProductId: initial.donorProductId,
          donorOfferId: initial.donorOfferId,
          retailer: "walmart",
          retailerProductId: "123456789",
          canonicalVariantId: initial.canonicalVariantId!,
          variantDecisionId: initial.variantDecisionId!,
          canonicalVariantMustBeAbsent: false,
          normalizedProductUrl: "https://www.walmart.com/ip/123456789",
          expectedLegacyRows: {
            donorProductRowJson: renderProductTruthOperationalJson(productRow),
            donorOfferRowJson: renderProductTruthOperationalJson(offerRow),
          },
        },
      }),
        /DONOR_EXACT_SCOPE_SEALED_ROW_BYTES_MISMATCH/,
      );
    } finally {
      if (previousPermit === undefined) delete process.env.SS_METERED_RUN_PERMIT;
      else process.env.SS_METERED_RUN_PERMIT = previousPermit;
      if (previousConfirmation === undefined) delete process.env.SS_METERED_RUN_CONFIRM;
      else process.env.SS_METERED_RUN_CONFIRM = previousConfirmation;
    }
    const after = (await db.execute(`SELECT
      (SELECT COUNT(*) FROM DonorProduct) AS products,
      (SELECT COUNT(*) FROM DonorOffer) AS offers,
      (SELECT COUNT(*) FROM CanonicalProductVariant) AS variants,
      (SELECT COUNT(*) FROM DonorProductVariantDecision) AS decisions,
      (SELECT COUNT(*) FROM DonorOfferObservation) AS priceObservations,
      (SELECT COUNT(*) FROM ProductContentObservation) AS contentObservations`)).rows[0]!;
    assert.deepEqual(after, before);
  });
});

test("existing exact Walmart alias rejects a contradictory non-Walmart.com seller before writes", async () => {
  await withScratchDb(async (db) => {
    const base = sourceOffer({
      target: EIGHT_OZ,
      retailer: "walmart",
      retailerProductId: "123456789",
      title: "Acme Potato Chips Original Bag, 8 oz",
    });
    const offer: ScoredOffer = {
      ...base,
      productUrl: "https://www.walmart.com/ip/acme/123456789",
      sellerName: "Walmart.com",
      sourceApi: "oxylabs",
      meteredReceiptId: "receipt-seller-1",
      meteredRunId: "run-seller-1",
      meteredApprovalId: "approval-seller-1",
    };
    const initial = await persistScoredDonorOffer(db, offer, EIGHT_OZ, NOW);
    assert.ok(initial.variantDecisionId);
    assert.ok(initial.canonicalVariantId);
    await db.execute({
      sql: `UPDATE DonorOffer SET sellerName='Third Party Seller' WHERE id=?`,
      args: [initial.donorOfferId],
    });
    await assert.rejects(
      readTargetedWalmartDonorSnapshot(db, initial.donorProductId),
      /TARGETED_EVIDENCE_DONOR_GRAPH_AMBIGUOUS/,
    );
    const before = (await db.execute(`SELECT
      (SELECT COUNT(*) FROM DonorProduct) AS products,
      (SELECT COUNT(*) FROM DonorOffer) AS offers,
      (SELECT COUNT(*) FROM CanonicalProductVariant) AS variants,
      (SELECT COUNT(*) FROM DonorProductVariantDecision) AS decisions,
      (SELECT COUNT(*) FROM DonorOfferObservation) AS priceObservations,
      (SELECT COUNT(*) FROM ProductContentObservation) AS contentObservations`)).rows[0]!;
    const permit = {
      version: 1 as const,
      runId: "run-seller-1",
      approvalId: "approval-seller-1",
      approvedBy: "owner" as const,
      issuedAt: "2026-07-18T20:00:00.000Z",
      expiresAt: "2026-07-18T21:00:00.000Z",
      providers: { oxylabs: { operations: ["query"], maxCalls: 1, maxUnits: 1 } },
    };
    const previousPermit = process.env.SS_METERED_RUN_PERMIT;
    const previousConfirmation = process.env.SS_METERED_RUN_CONFIRM;
    process.env.SS_METERED_RUN_PERMIT = Buffer.from(JSON.stringify(permit)).toString("base64url");
    process.env.SS_METERED_RUN_CONFIRM = expectedMeteredRunConfirmation(permit);
    try {
      await assert.rejects(
        persistScoredDonorOffer(db, offer, EIGHT_OZ, NOW, {
          exactScope: {
            donorProductId: initial.donorProductId,
            donorOfferId: initial.donorOfferId,
            retailer: "walmart",
            retailerProductId: "123456789",
            canonicalVariantId: initial.canonicalVariantId!,
            variantDecisionId: initial.variantDecisionId!,
            canonicalVariantMustBeAbsent: false,
            normalizedProductUrl: "https://www.walmart.com/ip/123456789",
            expectedLegacyRows: null,
          },
        }),
        /DONOR_EXACT_SCOPE_EXISTING_ALIAS_MISMATCH/,
      );
    } finally {
      if (previousPermit === undefined) delete process.env.SS_METERED_RUN_PERMIT;
      else process.env.SS_METERED_RUN_PERMIT = previousPermit;
      if (previousConfirmation === undefined) delete process.env.SS_METERED_RUN_CONFIRM;
      else process.env.SS_METERED_RUN_CONFIRM = previousConfirmation;
    }
    const after = (await db.execute(`SELECT
      (SELECT COUNT(*) FROM DonorProduct) AS products,
      (SELECT COUNT(*) FROM DonorOffer) AS offers,
      (SELECT COUNT(*) FROM CanonicalProductVariant) AS variants,
      (SELECT COUNT(*) FROM DonorProductVariantDecision) AS decisions,
      (SELECT COUNT(*) FROM DonorOfferObservation) AS priceObservations,
      (SELECT COUNT(*) FROM ProductContentObservation) AS contentObservations`)).rows[0]!;
    assert.deepEqual(after, before);
  });
});

test("owner bootstrap exact scope accepts identical pretty canonical legacy row bytes", async () => {
  await withScratchDb(async (db) => {
    await db.execute({
      sql: `INSERT INTO DonorProduct
            (id,brand,title,size,unitMeasure,unitAmount,currency,identityKey,
             identityStatus,needsReview,createdAt,updatedAt)
            VALUES (?,?,?,?,?,?,'USD',?,'legacy_unverified',0,?,?)`,
      args: [
        "legacy-donor-1", "Acme", "Acme Potato Chips Original Bag, 8 oz",
        "8 oz", "oz", 8, "legacy:acme:chips:8oz", NOW, NOW,
      ],
    });
    await db.execute({
      sql: `INSERT INTO DonorOffer
            (id,donorProductId,retailer,retailerProductId,via,price,packSizeSeen,
             pricePerUnit,currency,zip,localityEvidence,inStock,productUrl,sellerName,
             isFirstParty,sourceApi,fetchedAt,createdAt,updatedAt)
            VALUES (?,?, 'walmart','123456789','direct',4.49,1,4.49,'USD','33765',
                    'zip_scoped',1,'https://www.walmart.com/ip/acme/123456789',
                    'Walmart.com',1,'legacy',?,?,?)`,
      args: ["legacy-offer-1", "legacy-donor-1", NOW, NOW, NOW],
    });
    const productRow = (await db.execute(`SELECT * FROM DonorProduct WHERE id='legacy-donor-1'`))
      .rows[0] as Record<string, unknown>;
    const offerRow = (await db.execute(`SELECT * FROM DonorOffer WHERE id='legacy-offer-1'`))
      .rows[0] as Record<string, unknown>;
    const base = sourceOffer({
      target: EIGHT_OZ,
      retailer: "walmart",
      retailerProductId: "123456789",
      title: "Acme Potato Chips Original Bag, 8 oz",
    });
    const offer: ScoredOffer = {
      ...base,
      productUrl: "https://www.walmart.com/ip/acme/123456789",
      sellerName: "Walmart.com",
      sourceApi: "oxylabs",
      meteredReceiptId: "receipt-bootstrap-1",
      meteredRunId: "run-bootstrap-1",
      meteredApprovalId: "approval-bootstrap-1",
    };
    const canonicalVariantId = scoredDonorOfferCanonicalVariantId(offer);
    assert.ok(canonicalVariantId);
    const permit = {
      version: 1 as const,
      runId: "run-bootstrap-1",
      approvalId: "approval-bootstrap-1",
      approvedBy: "owner" as const,
      issuedAt: "2026-07-18T20:00:00.000Z",
      expiresAt: "2026-07-18T21:00:00.000Z",
      providers: { oxylabs: { operations: ["query"], maxCalls: 1, maxUnits: 1 } },
    };
    const previousPermit = process.env.SS_METERED_RUN_PERMIT;
    const previousConfirmation = process.env.SS_METERED_RUN_CONFIRM;
    process.env.SS_METERED_RUN_PERMIT = Buffer.from(JSON.stringify(permit)).toString("base64url");
    process.env.SS_METERED_RUN_CONFIRM = expectedMeteredRunConfirmation(permit);
    try {
      await assert.rejects(
        persistScoredDonorOffer(db, offer, EIGHT_OZ, NOW, {
          exactScope: {
            donorProductId: "legacy-donor-1",
            donorOfferId: "legacy-offer-1",
            retailer: "walmart",
            retailerProductId: "123456789",
            canonicalVariantId,
            variantDecisionId: null,
            canonicalVariantMustBeAbsent: true,
            normalizedProductUrl: "https://www.walmart.com/ip/123456789",
            expectedLegacyRows: null,
          },
        }),
        /DONOR_EXACT_SCOPE_BOOTSTRAP_BINDING_INVALID/,
      );
      assert.equal(
        Number((await db.execute(`SELECT COUNT(*) AS n FROM CanonicalProductVariant`)).rows[0]?.n),
        0,
      );
      assert.equal(
        Number((await db.execute(`SELECT COUNT(*) AS n FROM DonorProductVariantDecision`)).rows[0]?.n),
        0,
      );
      assert.equal(
        Number((await db.execute(`SELECT COUNT(*) AS n FROM DonorOfferObservation`)).rows[0]?.n),
        0,
      );
      const result = await persistScoredDonorOffer(db, offer, EIGHT_OZ, NOW, {
        exactScope: {
          donorProductId: "legacy-donor-1",
          donorOfferId: "legacy-offer-1",
          retailer: "walmart",
          retailerProductId: "123456789",
          canonicalVariantId,
          variantDecisionId: null,
          canonicalVariantMustBeAbsent: true,
          normalizedProductUrl: "https://www.walmart.com/ip/123456789",
          expectedLegacyRows: {
            donorProductRowJson: renderProductTruthOperationalJson(productRow),
            donorOfferRowJson: renderProductTruthOperationalJson(offerRow),
          },
        },
      });
      assert.equal(result.productCreated, false);
      assert.equal(result.aliasConflict, false);
      assert.equal(result.donorProductId, "legacy-donor-1");
      assert.equal(result.donorOfferId, "legacy-offer-1");
      assert.equal(result.canonicalVariantId, canonicalVariantId);
      assert.ok(result.variantDecisionId);
      assert.equal(
        Number((await db.execute(`SELECT COUNT(*) AS n FROM CanonicalProductVariant`)).rows[0]?.n),
        1,
      );
      assert.equal(
        Number((await db.execute(`SELECT COUNT(*) AS n FROM DonorProductVariantDecision`)).rows[0]?.n),
        1,
      );
    } finally {
      if (previousPermit === undefined) delete process.env.SS_METERED_RUN_PERMIT;
      else process.env.SS_METERED_RUN_PERMIT = previousPermit;
      if (previousConfirmation === undefined) delete process.env.SS_METERED_RUN_CONFIRM;
      else process.env.SS_METERED_RUN_CONFIRM = previousConfirmation;
    }
  });
});

test("two exact retailer source rows remain separate and alias one canonical variant", async () => {
  await withScratchDb(async (db) => {
    const walmart = await persistScoredDonorOffer(db, sourceOffer({
      target: EIGHT_OZ,
      retailer: "walmart",
      retailerProductId: "wm-8",
      title: "Acme Potato Chips Original Bag, 8 oz",
    }), EIGHT_OZ, NOW);
    const target = await persistScoredDonorOffer(db, sourceOffer({
      target: EIGHT_OZ,
      retailer: "target",
      retailerProductId: "tg-8",
      title: "Acme Potato Chips Original Bag, 8 oz",
    }), EIGHT_OZ, NOW);

    assert.notEqual(walmart.donorProductId, target.donorProductId);
    assert.equal(walmart.canonicalVariantId, target.canonicalVariantId);
    assert.ok(walmart.variantDecisionId);
    assert.ok(target.variantDecisionId);
    assert.equal(walmart.aliasConflict, false);
    assert.equal(target.aliasConflict, false);
    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) AS n FROM CanonicalProductVariant`)).rows[0]?.n),
      1,
    );
    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) AS n FROM DonorProductVariantDecision WHERE decisionStatus='exact_confirmed'`)).rows[0]?.n),
      2,
    );
    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) AS n FROM ProductContentObservation`)).rows[0]?.n),
      2,
    );
    assert.deepEqual(
      (await db.execute(`SELECT DISTINCT identityStatus FROM DonorProduct`)).rows.map((row) => row.identityStatus),
      ["exact_confirmed"],
    );
  });
});

test("cross-size source owns a different variant and never receives target size/content", async () => {
  await withScratchDb(async (db) => {
    const exact = await persistScoredDonorOffer(db, sourceOffer({
      target: EIGHT_OZ,
      retailer: "walmart",
      retailerProductId: "wm-exact-8",
      title: "Acme Potato Chips Original Bag, 8 oz",
    }), EIGHT_OZ, NOW);
    const crossOffer = sourceOffer({
      target: EIGHT_OZ,
      retailer: "target",
      retailerProductId: "tg-cross-12",
      title: "Acme Potato Chips Original Bag, 12 oz",
    });
    assert.equal(crossOffer.identityMatch?.verdict, "CROSS_SIZE_ESTIMATE");
    const cross = await persistScoredDonorOffer(db, crossOffer, EIGHT_OZ, NOW);

    assert.notEqual(cross.canonicalVariantId, exact.canonicalVariantId);
    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) AS n FROM CanonicalProductVariant`)).rows[0]?.n),
      2,
    );
    const source = (await db.execute({
      sql: `SELECT size, identityEvidenceJson FROM DonorProduct WHERE id=?`,
      args: [cross.donorProductId],
    })).rows[0];
    assert.equal(source.size, "12 oz");
    const identityEvidence = JSON.parse(String(source.identityEvidenceJson));
    assert.equal(identityEvidence.targetComparisonVerdict, "CROSS_SIZE_ESTIMATE");
    assert.equal(identityEvidence.sourceCanonicalIdentity.size.baseAmount > 300, true);

    const content = (await db.execute({
      sql: `SELECT canonicalVariantId, contentJson FROM ProductContentObservation WHERE id=?`,
      args: [cross.contentObservationId],
    })).rows[0];
    assert.equal(content.canonicalVariantId, cross.canonicalVariantId);
    const contentJson = JSON.parse(String(content.contentJson));
    assert.match(contentJson.title, /12 oz/);
    assert.doesNotMatch(contentJson.title, /8 oz/);
  });
});

test("size-unknown source remains candidate and cannot create content truth", async () => {
  await withScratchDb(async (db) => {
    const unknownOffer = sourceOffer({
      target: EIGHT_OZ,
      retailer: "target",
      retailerProductId: "tg-unknown",
      title: "Acme Potato Chips Original Bag",
    });
    assert.equal(unknownOffer.identityMatch?.verdict, "SIZE_UNKNOWN_ESTIMATE");
    const persisted = await persistScoredDonorOffer(db, unknownOffer, EIGHT_OZ, NOW);

    assert.equal(persisted.canonicalVariantId, null);
    assert.equal(persisted.variantDecisionId, null);
    assert.equal(persisted.contentObservationId, null);
    assert.equal(
      (await db.execute({
        sql: `SELECT identityStatus FROM DonorProduct WHERE id=?`,
        args: [persisted.donorProductId],
      })).rows[0]?.identityStatus,
      "candidate",
    );
    const observation = (await db.execute({
      sql: `SELECT canonicalVariantId, variantDecisionId FROM DonorOfferObservation WHERE id=?`,
      args: [persisted.offerObservationId],
    })).rows[0];
    assert.equal(observation.canonicalVariantId, null);
    assert.equal(observation.variantDecisionId, null);
    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) AS n FROM ProductContentObservation`)).rows[0]?.n),
      0,
    );
  });
});

test("existing exact alias conflict is immutable, quarantined, and observed unlinked", async () => {
  await withScratchDb(async (db) => {
    const first = await persistScoredDonorOffer(db, sourceOffer({
      target: EIGHT_OZ,
      retailer: "walmart",
      retailerProductId: "stable-item",
      title: "Acme Potato Chips Original Bag, 8 oz",
      price: 3.99,
      observedAt: "2026-07-18T19:00:00.000Z",
    }), EIGHT_OZ, NOW);
    const conflicting = await persistScoredDonorOffer(db, sourceOffer({
      target: TWELVE_OZ,
      retailer: "walmart",
      retailerProductId: "stable-item",
      title: "Acme Potato Chips Original Bag, 12 oz",
      price: 4.99,
      observedAt: "2026-07-18T20:00:00.000Z",
    }), TWELVE_OZ, NOW);

    assert.equal(conflicting.donorProductId, first.donorProductId);
    assert.equal(conflicting.donorOfferId, first.donorOfferId);
    assert.equal(conflicting.aliasConflict, true);
    assert.equal(conflicting.canonicalVariantId, null);
    assert.equal(conflicting.variantDecisionId, null);
    assert.equal(conflicting.contentObservationId, null);

    const exactDecision = (await db.execute({
      sql: `SELECT id, canonicalVariantId FROM DonorProductVariantDecision
            WHERE donorProductId=? AND decisionStatus='exact_confirmed'`,
      args: [first.donorProductId],
    })).rows;
    assert.equal(exactDecision.length, 1);
    assert.equal(exactDecision[0].canonicalVariantId, first.canonicalVariantId);
    assert.equal(
      Number((await db.execute({
        sql: `SELECT COUNT(*) AS n FROM DonorProductVariantDecision
              WHERE donorProductId=? AND decisionStatus='rejected'`,
        args: [first.donorProductId],
      })).rows[0]?.n),
      1,
    );
    const currentOffer = (await db.execute({
      sql: `SELECT donorProductId, price FROM DonorOffer WHERE id=?`,
      args: [first.donorOfferId],
    })).rows[0];
    assert.equal(currentOffer.donorProductId, first.donorProductId);
    assert.equal(Number(currentOffer.price), 3.99);

    const conflictObservation = (await db.execute({
      sql: `SELECT canonicalVariantId, variantDecisionId, price
            FROM DonorOfferObservation WHERE id=?`,
      args: [conflicting.offerObservationId],
    })).rows[0];
    assert.equal(conflictObservation.canonicalVariantId, null);
    assert.equal(conflictObservation.variantDecisionId, null);
    assert.equal(Number(conflictObservation.price), 4.99);
    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) AS n FROM ProductContentObservation`)).rows[0]?.n),
      1,
    );
    await assert.rejects(
      db.execute({
        sql: `UPDATE DonorProductVariantDecision SET canonicalVariantId=? WHERE id=?`,
        args: [conflicting.canonicalVariantId, exactDecision[0].id],
      }),
      /DONOR_PRODUCT_VARIANT_DECISION_IMMUTABLE/,
    );
  });
});

test("exact replay preflights immutable rows and performs no duplicate insert", async () => {
  await withScratchDb(async (db) => {
    const scored = sourceOffer({
      target: EIGHT_OZ,
      retailer: "walmart",
      retailerProductId: "idempotent-item",
      title: "Acme Potato Chips Original Bag, 8 oz",
      observedAt: "2026-07-18T20:00:00.000Z",
    });
    const first = await persistScoredDonorOffer(db, scored, EIGHT_OZ, NOW);
    const replay = await persistScoredDonorOffer(db, scored, EIGHT_OZ, NOW);

    assert.equal(replay.donorProductId, first.donorProductId);
    assert.equal(replay.donorOfferId, first.donorOfferId);
    assert.equal(replay.canonicalVariantId, first.canonicalVariantId);
    assert.equal(replay.variantDecisionId, first.variantDecisionId);
    assert.equal(replay.contentObservationId, first.contentObservationId);
    assert.equal(replay.offerObservationId, first.offerObservationId);
    const counts = (await db.execute(`
      SELECT
        (SELECT COUNT(*) FROM CanonicalProductVariant) AS variants,
        (SELECT COUNT(*) FROM DonorProduct) AS products,
        (SELECT COUNT(*) FROM DonorProductVariantDecision) AS decisions,
        (SELECT COUNT(*) FROM DonorOffer) AS offers,
        (SELECT COUNT(*) FROM DonorOfferObservation) AS offerObservations,
        (SELECT COUNT(*) FROM ProductContentObservation) AS contentObservations
    `)).rows[0];
    assert.deepEqual(
      [
        counts.variants, counts.products, counts.decisions, counts.offers,
        counts.offerObservations, counts.contentObservations,
      ].map(Number),
      [1, 1, 1, 1, 1, 1],
    );
  });
});

test("paid search receipt is sealed into price and content observations", async () => {
  await withScratchDb(async (db) => {
    const provenance = {
      receiptId: `receipt-${"a".repeat(32)}`,
      runId: "run-paid-search",
      approvalId: "approval-owner-paid-search",
    };
    const offer = sourceOffer({
      target: EIGHT_OZ,
      retailer: "walmart",
      retailerProductId: "wm-paid-8",
      title: "Acme Potato Chips Original Bag, 8 oz",
      metered: provenance,
    });
    const first = await persistScoredDonorOffer(db, offer, EIGHT_OZ, NOW);
    const replay = await persistScoredDonorOffer(db, offer, EIGHT_OZ, NOW);
    assert.equal(replay.offerObservationId, first.offerObservationId);
    assert.equal(replay.contentObservationId, first.contentObservationId);

    const price = (await db.execute({
      sql: `SELECT runId,approvalId,meteredReceiptId
            FROM DonorOfferObservation WHERE id=?`,
      args: [first.offerObservationId],
    })).rows[0];
    const content = (await db.execute({
      sql: `SELECT runId,approvalId,meteredReceiptId
            FROM ProductContentObservation WHERE id=?`,
      args: [first.contentObservationId],
    })).rows[0];
    for (const row of [price, content]) {
      assert.equal(row.runId, provenance.runId);
      assert.equal(row.approvalId, provenance.approvalId);
      assert.equal(row.meteredReceiptId, provenance.receiptId);
    }
  });
});

test("production writers create one complete exact snapshot consumed by the Walmart candidate view", async () => {
  await withScratchDb(async (db) => {
    const networkFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new Error("network is forbidden in writer regression");
    }) as typeof fetch;
    try {
      const search = await persistScoredDonorOffer(db, sourceOffer({
        target: EIGHT_OZ,
        retailer: "walmart",
        retailerProductId: "wm-complete-8",
        title: "Acme Potato Chips Original Bag, 8 oz",
        price: 3.99,
        observedAt: "2026-07-18T20:00:00.000Z",
      }), EIGHT_OZ, NOW);
      const completeInput = {
        donorProductId: search.donorProductId,
        retailer: "walmart",
        retailerProductId: "wm-complete-8",
        sourceUrl: "https://walmart.example.test/item/wm-complete-8",
        sourceApi: "retailer-detail-fixture",
        observedAt: DETAIL_OBSERVED_AT,
        processingNow: DETAIL_PROCESSING_NOW,
        provenance: {
          runId: null,
          approvalId: null,
          meteredReceiptId: null,
        },
        detailIdentity: {
          title: "Acme Potato Chips Original Bag, 8 oz",
          retailerProductId: "wm-complete-8",
          productUrl: null,
        },
        content: {
          description: "Exact retailer detail description",
          bullets: ["One 8 oz bag", "Original flavor"],
          attributes: {
            packageType: "Bag",
            netContent: "8 oz",
          },
          nutritionFacts: {
            servingSize: "1 oz",
            calories: 150,
            sodiumMg: 170,
          },
          ingredients: "Potatoes, vegetable oil, salt.",
          allergens: ["milk"],
          mainImageUrl: "https://images.example.test/wm-complete-8-front.jpg",
          imageUrls: [
            "https://images.example.test/wm-complete-8-front.jpg",
            "https://images.example.test/wm-complete-8-nutrition.jpg",
          ],
          upc: "012345678905",
          category: "Snack Foods",
          storage: "Shelf Stable",
        },
        supplementalSources: {
          nutritionFacts: {
            binding: "EXACT_UPC" as const,
            upc: "012345678905",
            sourceApi: "openfoodfacts-fixture",
            sourceUrl: "https://world.openfoodfacts.org/product/012345678905",
            observedAt: "2026-07-18T20:34:00.000Z",
          },
        },
      };
      const beforeSellerDrift = (await db.execute({
        sql: `SELECT title,description,bullets,attributes,nutritionFacts,ingredients,
                     mainImageUrl,imageUrls,upc,updatedAt
              FROM DonorProduct WHERE id=?`,
        args: [search.donorProductId],
      })).rows[0]!;
      await db.execute({
        sql: `UPDATE DonorOffer SET sellerName='Third Party Seller' WHERE id=?`,
        args: [search.donorOfferId],
      });
      await assert.rejects(
        persistCompleteExactContentObservation(db, completeInput),
        (error: unknown) => error instanceof ExactContentSnapshotBlockedError
          && error.blockers.includes("EXACT_SOURCE_ALIAS_MISSING"),
      );
      assert.equal(
        Number((await db.execute({
          sql: `SELECT COUNT(*) AS n FROM ProductContentObservation WHERE donorProductId=?`,
          args: [search.donorProductId],
        })).rows[0]?.n),
        1,
      );
      assert.deepEqual((await db.execute({
        sql: `SELECT title,description,bullets,attributes,nutritionFacts,ingredients,
                     mainImageUrl,imageUrls,upc,updatedAt
              FROM DonorProduct WHERE id=?`,
        args: [search.donorProductId],
      })).rows[0]!, beforeSellerDrift);
      await db.execute({
        sql: `UPDATE DonorOffer SET sellerName='Walmart.com' WHERE id=?`,
        args: [search.donorOfferId],
      });
      const beforeWrongDetail = (await db.execute({
        sql: `SELECT title,description,bullets,attributes,nutritionFacts,ingredients,
                     mainImageUrl,imageUrls,upc,updatedAt
              FROM DonorProduct WHERE id=?`,
        args: [search.donorProductId],
      })).rows[0]!;
      await assert.rejects(
        persistCompleteExactContentObservation(db, {
          ...completeInput,
          detailIdentity: {
            title: "Other Brand Tortilla Chips 12 oz",
            retailerProductId: "999999999",
            productUrl: "https://www.walmart.com/ip/999999999",
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof ExactContentSnapshotBlockedError);
          assert.deepEqual(error.blockers, [
            "DETAIL_RESPONSE_ITEM_ID_MISMATCH",
            "DETAIL_RESPONSE_TITLE_IDENTITY_MISMATCH",
            "DETAIL_RESPONSE_URL_MISMATCH",
          ]);
          return true;
        },
      );
      assert.equal(
        Number((await db.execute({
          sql: `SELECT COUNT(*) AS n FROM ProductContentObservation WHERE donorProductId=?`,
          args: [search.donorProductId],
        })).rows[0]?.n),
        1,
      );
      assert.deepEqual((await db.execute({
        sql: `SELECT title,description,bullets,attributes,nutritionFacts,ingredients,
                     mainImageUrl,imageUrls,upc,updatedAt
              FROM DonorProduct WHERE id=?`,
        args: [search.donorProductId],
      })).rows[0]!, beforeWrongDetail);
      const complete = await persistCompleteExactContentObservation(db, completeInput);
      const completeReplay = await persistCompleteExactContentObservation(db, completeInput);

      assert.equal(networkCalls, 0);
      assert.equal(completeReplay.contentObservationId, complete.contentObservationId);
      assert.equal(complete.donorProductId, search.donorProductId);
      assert.equal(complete.canonicalVariantId, search.canonicalVariantId);
      assert.equal(complete.variantDecisionId, search.variantDecisionId);
      assert.equal(complete.title, "Acme Potato Chips Original Bag, 8 oz");
      assert.equal(complete.upc, "012345678905");
      assert.equal(complete.imageCount, 2);

      const candidates = await listProductTruthWalmartPilotCandidates(db, {
        asOf: "2026-07-18T21:00:00.000Z",
        maxPriceAgeMs: 24 * 60 * 60 * 1_000,
        zip: "33765",
        limit: 5,
      });
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].donor_product_id, search.donorProductId);
      assert.equal(candidates[0].canonical_variant_id, search.canonicalVariantId);
      assert.equal(candidates[0].title, "Acme Potato Chips Original Bag, 8 oz");
      assert.equal(candidates[0].manufacturer_upc, "012345678905");
      assert.equal(candidates[0].category, "Snack Foods");
      assert.equal(candidates[0].storage_classification, "SHELF_STABLE");
      assert.equal(candidates[0].image_count, 2);
      assert.equal(candidates[0].content_observation_id, complete.contentObservationId);
      assert.equal(candidates[0].price_observation_id, search.offerObservationId);

      const observation = (await db.execute({
        sql: `SELECT contentJson,fieldHashesJson,sourceUrl,sourceApi
              FROM ProductContentObservation WHERE id=?`,
        args: [complete.contentObservationId],
      })).rows[0];
      const content = JSON.parse(String(observation.contentJson));
      const fieldHashes = JSON.parse(String(observation.fieldHashesJson));
      assert.equal(content._capture, "exact_complete_v1");
      assert.equal(content.title, "Acme Potato Chips Original Bag, 8 oz");
      assert.equal(content.mainImageUrl, "https://images.example.test/wm-complete-8-front.jpg");
      assert.deepEqual(content.allergens, ["milk"]);
      assert.equal(content.storageTemp, "Shelf Stable");
      assert.equal(content.upc, "012345678905");
      assert.equal(content.category, "Snack Foods");
      assert.equal(content._fieldSources.title.binding, "EXACT_VARIANT_SEARCH");
      assert.equal(content._fieldSources.mainImageUrl.binding, "EXACT_RETAILER_ITEM");
      assert.equal(content._fieldSources.nutritionFacts.binding, "EXACT_UPC");
      assert.equal(content._fieldSources.nutritionFacts.upc, "012345678905");
      assert.equal(
        content._fieldSources.title.observationId,
        search.contentObservationId,
      );
      for (const field of [
        "title", "mainImageUrl", "imageUrls", "ingredients",
        "nutritionFacts", "allergens", "upc", "category", "storageTemp",
      ]) {
        assert.match(fieldHashes[field], /^[a-f0-9]{64}$/, field);
        assert.ok(content._fieldSources[field], `${field} provenance missing`);
      }
      assert.equal(
        Number((await db.execute({
          sql: `SELECT COUNT(*) AS n FROM ProductContentObservation WHERE donorProductId=?`,
          args: [search.donorProductId],
        })).rows[0]?.n),
        2,
      );

      const refreshedSearch = await persistScoredDonorOffer(db, sourceOffer({
        target: EIGHT_OZ,
        retailer: "walmart",
        retailerProductId: "wm-complete-8",
        title: "Acme Potato Chips Original Bag, 8 oz",
        price: 3.79,
        observedAt: "2026-07-18T20:50:00.000Z",
      }), EIGHT_OZ, "2026-07-18T20:55:00.000Z");
      const afterSearchRefresh = await listProductTruthWalmartPilotCandidates(db, {
        asOf: "2026-07-18T21:00:00.000Z",
        maxPriceAgeMs: 24 * 60 * 60 * 1_000,
        zip: "33765",
        limit: 5,
      });
      assert.equal(afterSearchRefresh.length, 1);
      assert.equal(
        afterSearchRefresh[0].content_observation_id,
        complete.contentObservationId,
      );
      assert.equal(
        afterSearchRefresh[0].price_observation_id,
        refreshedSearch.offerObservationId,
      );
      assert.equal(afterSearchRefresh[0].observed_price, 3.79);
      assert.equal(networkCalls, 0);
    } finally {
      globalThis.fetch = networkFetch;
    }
  });
});

test("complete content writer fails closed on missing facts and cross-variant source mixing", async () => {
  await withScratchDb(async (db) => {
    const eight = await persistScoredDonorOffer(db, sourceOffer({
      target: EIGHT_OZ,
      retailer: "walmart",
      retailerProductId: "wm-blocked-8",
      title: "Acme Potato Chips Original Bag, 8 oz",
    }), EIGHT_OZ, NOW);
    const twelve = await persistScoredDonorOffer(db, sourceOffer({
      target: TWELVE_OZ,
      retailer: "walmart",
      retailerProductId: "wm-blocked-12",
      title: "Acme Potato Chips Original Bag, 12 oz",
    }), TWELVE_OZ, NOW);
    const completeInput = {
      donorProductId: eight.donorProductId,
      retailer: "walmart",
      retailerProductId: "wm-blocked-8",
      sourceUrl: "https://walmart.example.test/item/wm-blocked-8",
      sourceApi: "retailer-detail-fixture",
      observedAt: DETAIL_OBSERVED_AT,
      processingNow: DETAIL_PROCESSING_NOW,
      detailIdentity: {
        title: "Acme Potato Chips Original Bag, 8 oz",
        retailerProductId: "wm-blocked-8",
        productUrl: null,
      },
      content: {
        attributes: {},
        nutritionFacts: { calories: 150 },
        ingredients: "Potatoes, oil, salt.",
        allergens: ["milk"],
        imageUrls: ["https://images.example.test/wm-blocked-8.jpg"],
        upc: "012345678905",
        category: "Snack Foods",
        storage: "Shelf Stable",
      },
    };

    await assert.rejects(
      persistCompleteExactContentObservation(db, {
        ...completeInput,
        content: { ...completeInput.content, allergens: null },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ExactContentSnapshotBlockedError);
        assert.deepEqual(error.blockers, ["ALLERGENS_MISSING"]);
        return true;
      },
    );
    assert.equal(
      Number((await db.execute({
        sql: `SELECT COUNT(*) AS n FROM ProductContentObservation WHERE donorProductId=?`,
        args: [eight.donorProductId],
      })).rows[0]?.n),
      1,
    );

    for (const nutritionFacts of [false, 0] as const) {
      await assert.rejects(
        persistCompleteExactContentObservation(db, {
          ...completeInput,
          content: { ...completeInput.content, nutritionFacts },
        }),
        (error: unknown) => {
          assert.ok(error instanceof ExactContentSnapshotBlockedError);
          assert.deepEqual(error.blockers, ["NUTRITION_MISSING"]);
          return true;
        },
      );
    }
    for (const allergens of [false, { foo: [] }, [[]]] as const) {
      await assert.rejects(
        persistCompleteExactContentObservation(db, {
          ...completeInput,
          content: { ...completeInput.content, allergens },
        }),
        (error: unknown) => {
          assert.ok(error instanceof ExactContentSnapshotBlockedError);
          assert.deepEqual(error.blockers, ["ALLERGENS_MISSING"]);
          return true;
        },
      );
    }

    await assert.rejects(
      persistCompleteExactContentObservation(db, {
        ...completeInput,
        supplementalSources: {
          nutritionFacts: {
            binding: "EXACT_UPC",
            upc: "999999999999",
            sourceApi: "openfoodfacts-fixture",
            sourceUrl: "https://world.openfoodfacts.org/product/999999999999",
            observedAt: "2026-07-18T20:34:00.000Z",
          },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ExactContentSnapshotBlockedError);
        assert.deepEqual(error.blockers, ["SUPPLEMENTAL_NUTRITIONFACTS_UPC_MISMATCH"]);
        return true;
      },
    );

    await assert.rejects(
      persistCompleteExactContentObservation(db, {
        ...completeInput,
        retailerProductId: "wm-blocked-12",
        sourceUrl: "https://walmart.example.test/item/wm-blocked-12",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ExactContentSnapshotBlockedError);
        assert.deepEqual(error.blockers, ["EXACT_SOURCE_ALIAS_MISSING"]);
        return true;
      },
    );
    assert.notEqual(eight.canonicalVariantId, twelve.canonicalVariantId);
    assert.equal(
      Number((await db.execute(`SELECT COUNT(*) AS n FROM ProductContentObservation`)).rows[0]?.n),
      2,
    );

    const explicitNoAllergens = await persistCompleteExactContentObservation(db, {
      ...completeInput,
      content: { ...completeInput.content, allergens: [] },
    });
    assert.ok(explicitNoAllergens.contentObservationId);
    const storedExplicitNoAllergens = (await db.execute({
      sql: `SELECT contentJson FROM ProductContentObservation WHERE id=?`,
      args: [explicitNoAllergens.contentObservationId],
    })).rows[0]?.contentJson;
    assert.equal(typeof storedExplicitNoAllergens, "string");
    assert.deepEqual(
      JSON.parse(String(storedExplicitNoAllergens)).allergens,
      [],
    );
  });
});

test("detail harvest is exact-alias-only and seals run/approval/receipt provenance", async () => {
  const source = await readFile(new URL("../donor-catalog.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function harvestDonorDetail");
  const end = source.indexOf("async function quarantineUpcConflicts", start);
  const harvest = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(harvest, /exact source alias required/);
  assert.match(harvest, /harvest source URL mismatch/);
  assert.match(harvest, /persistCompleteExactContentObservation\(db/);
  assert.match(harvest, /runId:\s*authorization\.runId/);
  assert.match(harvest, /approvalId:\s*authorization\.approvalId/);
  assert.match(harvest, /meteredReceiptId:\s*authorization\.receiptId/);
  assert.match(harvest, /ExactContentSnapshotBlockedError/);
  assert.doesNotMatch(harvest, /retailer_detail_partial/);
  assert.doesNotMatch(harvest, /classifyTemperature\(/);
  assert.doesNotMatch(harvest, /UPDATE\s+"DonorProduct"\s+SET[^`]*identityStatus/i);
});
