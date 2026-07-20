import assert from "node:assert/strict";
import test from "node:test";

import { createClient } from "@libsql/client";

import {
  PRODUCT_TRUTH_READ_CONTRACT_VERSION,
  type ProductTruthBatchReadOptions,
  type ProductTruthNewSkuRecipeComponentEvidence,
  type ProductTruthSnapshot,
} from "@/lib/sourcing/product-truth-read-contract";
import {
  inspectWalmartSellerCatalogRecipeNovelty,
  loadWalmartSellerCatalogNoveltyIndex,
} from "../walmart-new-sku-novelty";

function component(): ProductTruthNewSkuRecipeComponentEvidence {
  return {
    donor_product_id: "donor-target",
    canonical_variant_id: "variant-target",
    manufacturer_upc: "012345678905",
    qty: 2,
    canonical_identity: {
      brand: "Example Brand",
      productLine: "Crunchy Snack",
      flavor: "Sea Salt",
      modifiers: [],
      form: "bag",
      sizeBaseAmount: 226.796,
      sizeBaseUnit: "g",
      outerPackCount: 1,
    },
  } as unknown as ProductTruthNewSkuRecipeComponentEvidence;
}

async function schema() {
  const db = createClient({ url: "file::memory:" });
  await db.executeMultiple(`
    CREATE TABLE WalmartCatalogItem (
      id TEXT PRIMARY KEY,storeIndex INTEGER NOT NULL,sku TEXT NOT NULL,itemId TEXT,
      title TEXT,lifecycleStatus TEXT,publishedStatus TEXT,syncedAt TEXT NOT NULL
    );
    CREATE TABLE WalmartReport (
      id TEXT PRIMARY KEY,storeIndex INTEGER NOT NULL,reportType TEXT NOT NULL,
      requestId TEXT NOT NULL,status TEXT NOT NULL,requestedAt TEXT NOT NULL,
      downloadedAt TEXT,rowCount INTEGER
    );
    CREATE TABLE SkuComponent (
      id TEXT PRIMARY KEY,sku TEXT NOT NULL,channel TEXT,idx INTEGER NOT NULL,
      qty INTEGER NOT NULL,donorProductId TEXT,contentDonorProductId TEXT
    );
    CREATE TABLE SkuShippingData (
      id TEXT PRIMARY KEY,sku TEXT NOT NULL,productIdentity TEXT,unitsInListing INTEGER
    );
    CREATE TABLE MasterBundle (id TEXT PRIMARY KEY,pack_count INTEGER NOT NULL);
    CREATE TABLE ChannelSKU (
      id TEXT PRIMARY KEY,master_bundle_id TEXT NOT NULL,channel TEXT NOT NULL,
      sku TEXT NOT NULL,upc TEXT NOT NULL,title TEXT NOT NULL,lifecycle_status TEXT,
      listing_status TEXT,attributes TEXT NOT NULL
    );
    CREATE TABLE BundleComponent (
      id TEXT PRIMARY KEY,master_bundle_id TEXT NOT NULL,qty INTEGER NOT NULL,
      manufacturer_upc TEXT
    );
    CREATE TABLE DonorProductVariantDecision (
      donorProductId TEXT NOT NULL,canonicalVariantId TEXT,decisionStatus TEXT NOT NULL
    );
    CREATE TABLE ProductTruthListingScope (
      listingKey TEXT PRIMARY KEY,channel TEXT NOT NULL,storeIndex INTEGER NOT NULL,
      sku TEXT NOT NULL,manifestSha256 TEXT NOT NULL
    );
  `);
  return db;
}

function snapshotReader(
  resolutions: Record<string, { canonicalVariantId: string; qty: number }>,
) {
  return async (
    _db: Awaited<ReturnType<typeof schema>>,
    options: ProductTruthBatchReadOptions,
  ): Promise<ProductTruthSnapshot[]> => options.scopes.map((scope) => {
    const resolution = resolutions[scope.sku];
    if (!resolution) throw new Error(`missing mock resolution for ${scope.sku}`);
    const components = [{
      componentEvidenceId: `evidence-${scope.sku}`,
      componentIndex: 0,
      product: "Canonical product",
      flavor: null,
      size: null,
      qty: resolution.qty,
      targetCanonicalVariantId: resolution.canonicalVariantId,
      evidenceStatus: "FACT",
      content: null,
      contentBlockers: ["CONTENT_NOT_NEEDED_FOR_IDENTITY_TEST"],
    }];
    return {
      contractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
      snapshot: {
        sku: scope.sku,
        channel: scope.channel,
        storeIndex: scope.storeIndex,
        listingKey: `${scope.channel}:${scope.storeIndex}:${scope.sku}`,
        asOf: new Date(options.asOf).toISOString(),
        maxPriceAgeMs: options.maxPriceAgeMs,
        skuCostId: `cost-${scope.sku}`,
      },
      recipe: { components, blockers: [] },
      views: {
        bundleFactory: {
          consumer: "BUNDLE_FACTORY",
          ready: false,
          components,
          blockers: ["CONTENT_NOT_NEEDED_FOR_IDENTITY_TEST"],
        },
      },
    } as unknown as ProductTruthSnapshot;
  });
}

async function seedAuthoritativeSnapshot(input: {
  db: Awaited<ReturnType<typeof schema>>;
  syncedAt: string;
  rows: Array<{ sku: string; title: string }>;
  resolveAsDifferent?: boolean;
}) {
  for (const [index, row] of input.rows.entries()) {
    await input.db.execute({
      sql: `INSERT INTO WalmartCatalogItem
            (id,storeIndex,sku,itemId,title,lifecycleStatus,publishedStatus,syncedAt)
            VALUES (?,1,?,?,?,'ACTIVE','PUBLISHED',?)`,
      args: [`catalog-${index}`, row.sku, `item-${index}`, row.title, input.syncedAt],
    });
    await input.db.execute({
      sql: `INSERT INTO ProductTruthListingScope
            (listingKey,channel,storeIndex,sku,manifestSha256)
            VALUES (?,'walmart',1,?,?)`,
      args: [`walmart:1:${row.sku}`, row.sku, "a".repeat(64)],
    });
  }
  if (input.resolveAsDifferent !== false) {
    for (const [index, row] of input.rows.entries()) {
      await input.db.execute({
        sql: `INSERT INTO SkuShippingData
              (id,sku,productIdentity,unitsInListing) VALUES (?,?,?,1)`,
        args: [
          `shipping-${index}`,
          row.sku,
          JSON.stringify({
            brand: "Different Brand",
            product_line: "Tomato Soup",
            flavor: "Classic",
            form: "can",
            size: "15 oz",
            units_in_listing: 1,
          }),
        ],
      });
    }
  }
  await input.db.execute({
    sql: `INSERT INTO WalmartReport
          (id,storeIndex,reportType,requestId,status,requestedAt,downloadedAt,rowCount)
          VALUES ('report-1',1,'ITEM_CATALOG','request-1','DOWNLOADED',?,?,?)`,
    args: [input.syncedAt, input.syncedAt, input.rows.length],
  });
}

test("novelty requires authoritative full ITEM_CATALOG provenance", async (t) => {
  const db = await schema();
  t.after(() => db.close());
  const now = new Date("2026-07-19T12:00:00.000Z");
  const syncedAt = "2026-07-19T11:55:00.000Z";
  await db.execute({
    sql: `INSERT INTO WalmartCatalogItem
          (id,storeIndex,sku,itemId,title,lifecycleStatus,publishedStatus,syncedAt)
          VALUES ('fallback-row',1,'UNRELATED-1','item-1',
                  'Different Brand Tomato Soup 15 oz','ACTIVE','PUBLISHED',?)`,
    args: [syncedAt],
  });
  await db.execute({
    sql: `INSERT INTO SkuShippingData
          (id,sku,productIdentity,unitsInListing) VALUES ('shipping-fallback',?,?,1)`,
    args: [
      "UNRELATED-1",
      JSON.stringify({
        brand: "Different Brand",
        product_line: "Tomato Soup",
        flavor: "Classic",
        form: "can",
        size: "15 oz",
        units_in_listing: 1,
      }),
    ],
  });
  await db.execute({
    sql: `INSERT INTO ProductTruthListingScope
          (listingKey,channel,storeIndex,sku,manifestSha256)
          VALUES ('walmart:1:UNRELATED-1','walmart',1,'UNRELATED-1',?)`,
    args: ["a".repeat(64)],
  });
  const reader = snapshotReader({
    "UNRELATED-1": { canonicalVariantId: "variant-different", qty: 1 },
  });
  await assert.rejects(
    loadWalmartSellerCatalogNoveltyIndex({
      db,
      storeIndex: 1,
      now,
      readProductTruthSnapshotsImpl: reader,
    }),
    /SELLER_CATALOG_AUTHORITATIVE_ITEM_REPORT_UNPROVEN/,
  );

  await db.execute({
    sql: `INSERT INTO WalmartReport
          (id,storeIndex,reportType,requestId,status,requestedAt,downloadedAt,rowCount)
          VALUES ('report-1',1,'ITEM_CATALOG','request-1','DOWNLOADED',?,?,1)`,
    args: [syncedAt, syncedAt],
  });
  const index = await loadWalmartSellerCatalogNoveltyIndex({
    db,
    storeIndex: 1,
    now,
    readProductTruthSnapshotsImpl: reader,
  });
  assert.equal(index.seller_catalog_row_count, 1);
  assert.match(index.authoritative_item_report_request_id_sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    inspectWalmartSellerCatalogRecipeNovelty({ index, component: component(), now }).novel,
    true,
  );
});

test("existing seller recipe under another UPC and legacy donor link blocks", async (t) => {
  const db = await schema();
  t.after(() => db.close());
  const now = new Date("2026-07-19T12:00:00.000Z");
  const syncedAt = "2026-07-19T11:55:00.000Z";
  await seedAuthoritativeSnapshot({
    db,
    syncedAt,
    rows: [{
      sku: "LEGACY-EXACT-PACK",
      title: "Legacy marketing copy that does not equal the new deterministic title",
    }],
    resolveAsDifferent: false,
  });
  await db.execute(
    `INSERT INTO DonorProductVariantDecision
     (donorProductId,canonicalVariantId,decisionStatus)
     VALUES ('donor-alias','variant-target','exact_confirmed')`,
  );
  await db.execute(
    `INSERT INTO SkuComponent
     (id,sku,channel,idx,qty,donorProductId,contentDonorProductId)
     VALUES ('component-legacy','LEGACY-EXACT-PACK','walmart',0,2,'donor-alias',NULL)`,
  );
  const index = await loadWalmartSellerCatalogNoveltyIndex({
    db,
    storeIndex: 1,
    now,
    readProductTruthSnapshotsImpl: snapshotReader({
      "LEGACY-EXACT-PACK": { canonicalVariantId: "variant-target", qty: 2 },
    }),
  });
  const inspection = inspectWalmartSellerCatalogRecipeNovelty({
    index,
    component: component(),
    now,
  });
  assert.equal(inspection.novel, false);
  assert.ok(inspection.collisions.some((collision) =>
    collision.sku === "LEGACY-EXACT-PACK" &&
    collision.basis === "SELLER_CATALOG_EXACT_DONOR_ALIAS"
  ));
  assert.ok(inspection.collisions.some((collision) =>
    collision.sku === "LEGACY-EXACT-PACK" &&
    collision.basis === "SELLER_CATALOG_PRODUCT_TRUTH_RECIPE"
  ));
});

test("legacy nullable-draft ChannelSKU manifest blocks a different new UPC", async (t) => {
  const db = await schema();
  t.after(() => db.close());
  const now = new Date("2026-07-19T12:00:00.000Z");
  const syncedAt = "2026-07-19T11:55:00.000Z";
  await seedAuthoritativeSnapshot({
    db,
    syncedAt,
    rows: [{ sku: "UNRELATED-1", title: "Different Brand Tomato Soup 15 oz" }],
  });
  await db.execute(`INSERT INTO MasterBundle (id,pack_count) VALUES ('master-1',2)`);
  await db.execute({
    sql: `INSERT INTO ChannelSKU
          (id,master_bundle_id,channel,sku,upc,title,lifecycle_status,
           listing_status,attributes)
          VALUES ('channel-old','master-1','WALMART','OLD-EXACT-PACK',
                  '099999999999','Old title','LIVE','LIVE',?)`,
    args: [JSON.stringify({
      product_truth_manifest: {
        listing_scope: { store_index: 1 },
        components: [{ canonical_variant_id: "variant-target", qty: 2 }],
      },
    })],
  });
  await db.execute(
    `INSERT INTO BundleComponent
     (id,master_bundle_id,qty,manufacturer_upc)
     VALUES ('bundle-component-1','master-1',2,'012345678905')`,
  );
  const index = await loadWalmartSellerCatalogNoveltyIndex({
    db,
    storeIndex: 1,
    now,
    readProductTruthSnapshotsImpl: snapshotReader({
      "UNRELATED-1": { canonicalVariantId: "variant-different", qty: 1 },
    }),
  });
  const blocked = inspectWalmartSellerCatalogRecipeNovelty({
    index,
    component: component(),
    now,
  });
  assert.equal(blocked.novel, false);
  assert.ok(blocked.collisions.some(
    (collision) => collision.basis === "CHANNEL_SKU_PRODUCT_TRUTH_MANIFEST",
  ));
  assert.ok(blocked.collisions.some(
    (collision) => collision.basis === "CHANNEL_SKU_EXACT_COMPONENT_UPC",
  ));
  assert.ok(blocked.collisions.some(
    (collision) => collision.basis === "CHANNEL_SKU_IDENTITY_UNRESOLVED",
  ));

  const retry = inspectWalmartSellerCatalogRecipeNovelty({
    index,
    component: component(),
    allowedChannelSkuId: "channel-old",
    now,
  });
  assert.equal(retry.novel, true);
});

test("catalog title non-match cannot replace canonical identity resolution", async (t) => {
  const db = await schema();
  t.after(() => db.close());
  const now = new Date("2026-07-19T12:00:00.000Z");
  const syncedAt = "2026-07-19T11:55:00.000Z";
  await db.execute({
    sql: `INSERT INTO WalmartCatalogItem
          (id,storeIndex,sku,itemId,title,lifecycleStatus,publishedStatus,syncedAt)
          VALUES ('catalog-unresolved',1,'UNRESOLVED-1','item-unresolved',
                  'Definitely different marketing title','ACTIVE','PUBLISHED',?)`,
    args: [syncedAt],
  });
  await db.execute({
    sql: `INSERT INTO WalmartReport
          (id,storeIndex,reportType,requestId,status,requestedAt,downloadedAt,rowCount)
          VALUES ('report-1',1,'ITEM_CATALOG','request-1','DOWNLOADED',?,?,1)`,
    args: [syncedAt, syncedAt],
  });
  await assert.rejects(
    loadWalmartSellerCatalogNoveltyIndex({
      db,
      storeIndex: 1,
      now,
      readProductTruthSnapshotsImpl: snapshotReader({}),
    }),
    /SELLER_CATALOG_IDENTITY_RESOLUTION_INCOMPLETE/,
  );
});

test("archived lifecycle remains in the all-status identity population", async (t) => {
  const db = await schema();
  t.after(() => db.close());
  const now = new Date("2026-07-19T12:00:00.000Z");
  const syncedAt = "2026-07-19T11:55:00.000Z";
  await seedAuthoritativeSnapshot({
    db,
    syncedAt,
    rows: [{ sku: "ARCHIVED-1", title: "Old unrelated product" }],
  });
  await db.execute(
    `UPDATE WalmartCatalogItem SET lifecycleStatus='ARCHIVED'
     WHERE sku='ARCHIVED-1'`,
  );
  const index = await loadWalmartSellerCatalogNoveltyIndex({
    db,
    storeIndex: 1,
    now,
    readProductTruthSnapshotsImpl: snapshotReader({
      "ARCHIVED-1": { canonicalVariantId: "variant-different", qty: 1 },
    }),
  });
  assert.equal(index.seller_catalog_row_count, 1);
  assert.equal(index.seller_catalog_active_row_count, 0);
  assert.equal(
    inspectWalmartSellerCatalogRecipeNovelty({ index, component: component(), now }).novel,
    true,
  );
});

test("ChannelSKU needs an exact current-store scope; other-store rows are excluded", async (t) => {
  const db = await schema();
  t.after(() => db.close());
  const now = new Date("2026-07-19T12:00:00.000Z");
  const syncedAt = "2026-07-19T11:55:00.000Z";
  await seedAuthoritativeSnapshot({
    db,
    syncedAt,
    rows: [{ sku: "CATALOG-1", title: "Unrelated catalog item" }],
  });
  await db.execute(`INSERT INTO MasterBundle (id,pack_count) VALUES ('master-2',1)`);
  await db.execute({
    sql: `INSERT INTO ChannelSKU
          (id,master_bundle_id,channel,sku,upc,title,lifecycle_status,
           listing_status,attributes)
          VALUES ('channel-store-2','master-2','WALMART','OTHER-STORE-SKU',
                  '088888888888','Other store item','LIVE','LIVE','{}')`,
  });
  await db.execute({
    sql: `INSERT INTO ProductTruthListingScope
          (listingKey,channel,storeIndex,sku,manifestSha256)
          VALUES ('walmart:2:OTHER-STORE-SKU','walmart',2,'OTHER-STORE-SKU',?)`,
    args: ["b".repeat(64)],
  });
  const index = await loadWalmartSellerCatalogNoveltyIndex({
    db,
    storeIndex: 1,
    now,
    readProductTruthSnapshotsImpl: snapshotReader({
      "CATALOG-1": { canonicalVariantId: "variant-different", qty: 1 },
    }),
  });
  assert.equal(index.channelSkus.length, 0);
  assert.equal(
    inspectWalmartSellerCatalogRecipeNovelty({ index, component: component(), now }).novel,
    true,
  );
});
