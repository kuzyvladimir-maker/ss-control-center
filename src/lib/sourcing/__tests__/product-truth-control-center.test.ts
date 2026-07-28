import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createClient, type Client } from "@libsql/client";

import {
  canAccessModule,
  moduleKeyForApiPath,
} from "../../rbac/access";
import {
  GRANTABLE_MODULE_KEYS,
  moduleForPath,
} from "../../rbac/modules";
import {
  PRODUCT_TRUTH_CONTROL_CENTER_CLAIMS,
  ProductTruthControlCenterReadError,
  assertProductTruthControlCenterReadSql,
  readProductTruthControlCenterListings,
  readProductTruthControlCenterOperations,
  readProductTruthControlCenterOverview,
  readProductTruthControlCenterVariants,
  summarizeProductTruthSnapshots,
} from "../product-truth-control-center";
import {
  PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV,
  ProductTruthControlCenterRuntimeError,
  expectedProductTruthControlCenterConfirmation,
  loadProductTruthControlCenterRuntime,
  openProductTruthControlCenterReadClient,
} from "../product-truth-control-center-runtime";
import { resolveProductTruthDatabaseTarget } from
  "../product-truth-database-target";
import type { ProductTruthSnapshot } from "../product-truth-read-contract";

const MANIFEST = "a".repeat(64);
const DATABASE_URL = "file::memory:";
const TARGET = resolveProductTruthDatabaseTarget(DATABASE_URL).fingerprint;

function runtimeEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    [PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.enabled]: "1",
    [PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.manifestSha256]: MANIFEST,
    [PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.databaseTargetFingerprint]: TARGET,
    [PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.maxPriceAgeMs]: "86400000",
    [PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.confirmation]:
      expectedProductTruthControlCenterConfirmation({
        authoritativeManifestSha256: MANIFEST,
        databaseTargetFingerprint: TARGET,
      }),
    DATABASE_URL,
    ...overrides,
  };
}

function runtimeCode(error: unknown): string | undefined {
  return error instanceof ProductTruthControlCenterRuntimeError
    ? error.code
    : undefined;
}

function readCode(error: unknown): string | undefined {
  return error instanceof ProductTruthControlCenterReadError
    ? error.code
    : undefined;
}

test("Control Center runtime is OFF unless the complete exact binding exists", () => {
  assert.deepEqual(loadProductTruthControlCenterRuntime({ env: {} }), {
    schemaVersion: "product-truth-control-center-runtime/1.0.0",
    status: "OFF",
    reason: "NO_READ_ONLY_RUNTIME_CONFIGURED",
  });
  assert.throws(
    () => loadProductTruthControlCenterRuntime({
      env: {
        [PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.enabled]: "1",
      },
    }),
    (error) => runtimeCode(error) === "CONTROL_CENTER_RUNTIME_CONFIG_INCOMPLETE",
  );
});

test("Control Center runtime pins manifest, database target, freshness and confirmation", () => {
  const runtime = loadProductTruthControlCenterRuntime({ env: runtimeEnv() });
  assert.equal(runtime.status, "READ_ONLY");
  if (runtime.status !== "READ_ONLY") return;
  assert.equal(runtime.authoritativeManifestSha256, MANIFEST);
  assert.equal(runtime.database.target.fingerprint, TARGET);
  assert.equal(runtime.maxPriceAgeMs, 86_400_000);
  assert.deepEqual(runtime.claims, {
    databaseWrites: false,
    providerCalls: false,
    paidCalls: false,
    marketplaceMutations: false,
  });

  assert.throws(
    () => loadProductTruthControlCenterRuntime({
      env: runtimeEnv({
        [PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.confirmation]: "wrong",
      }),
    }),
    (error) => runtimeCode(error) === "CONTROL_CENTER_RUNTIME_CONFIRMATION_INVALID",
  );
  assert.throws(
    () => loadProductTruthControlCenterRuntime({
      env: runtimeEnv({ DATABASE_URL: "file:other.db" }),
    }),
    (error) => runtimeCode(error)
      === "CONTROL_CENTER_RUNTIME_DATABASE_TARGET_MISMATCH",
  );
  assert.throws(
    () => loadProductTruthControlCenterRuntime({
      env: runtimeEnv({
        [PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.maxPriceAgeMs]:
          String(31 * 24 * 60 * 60 * 1_000),
      }),
    }),
    (error) => runtimeCode(error) === "CONTROL_CENTER_RUNTIME_CONFIG_INVALID",
  );
});

test("read-only runtime can open its exact local client without enabling any provider", async () => {
  const runtime = loadProductTruthControlCenterRuntime({ env: runtimeEnv() });
  assert.equal(runtime.status, "READ_ONLY");
  if (runtime.status !== "READ_ONLY") return;
  const db = await openProductTruthControlCenterReadClient(runtime);
  try {
    const result = await db.execute("SELECT 1 AS ok");
    assert.equal(Number(result.rows[0]?.ok), 1);
  } finally {
    db.close();
  }
});

test("Control Center SQL gate accepts reads and rejects writes hidden after WITH or separators", () => {
  assert.doesNotThrow(() =>
    assertProductTruthControlCenterReadSql(
      "WITH values_only AS (SELECT 1 AS value) SELECT value FROM values_only",
    ));
  assert.doesNotThrow(() =>
    assertProductTruthControlCenterReadSql(
      "-- inventory\nSELECT COUNT(*) FROM CanonicalProductVariant",
    ));
  for (const sql of [
    "INSERT INTO CanonicalProductVariant(id) VALUES ('x')",
    "UPDATE ProductTruthOperationalRun SET status='running'",
    "DELETE FROM ProductTruthListingScope",
    "WITH chosen AS (SELECT 1) UPDATE EnrichmentJob SET status='running'",
    "SELECT 1; DROP TABLE ProductTruthListingScope",
    "PRAGMA writable_schema=ON",
  ]) {
    assert.throws(
      () => assertProductTruthControlCenterReadSql(sql),
      (error) => readCode(error) === "CONTROL_CENTER_WRITE_SQL_FORBIDDEN",
      sql,
    );
  }
});

function snapshot(input: {
  sku: string;
  contentReady: boolean;
  procurementReady: boolean;
  costStatus: ProductTruthSnapshot["views"]["unitEconomics"]["status"];
}): ProductTruthSnapshot {
  return {
    contractVersion: "product-truth-read-contract/3.2.0",
    snapshot: {
      sku: input.sku,
      channel: "walmart",
      storeIndex: 1,
      listingKey: `walmart:1:${input.sku}`,
      asOf: "2026-07-25T12:00:00.000Z",
      maxPriceAgeMs: 86_400_000,
      skuCostId: null,
    },
    recipe: { components: [], blockers: [] },
    views: {
      bundleFactory: {
        consumer: "BUNDLE_FACTORY",
        ready: input.contentReady,
        components: [],
        blockers: input.contentReady ? [] : ["CONTENT_BLOCKED"],
      },
      listingImprovement: {
        consumer: "LISTING_IMPROVEMENT",
        ready: input.contentReady,
        components: [],
        blockers: input.contentReady ? [] : ["CONTENT_BLOCKED"],
      },
      unitEconomics: {
        consumer: "UNIT_ECONOMICS",
        status: input.costStatus,
        current: null,
        factualCost: null,
        estimatedCost: null,
        blockers: [],
      },
      procurement: {
        consumer: "PROCUREMENT",
        ready: input.procurementReady,
        components: [],
        blockers: input.procurementReady ? [] : ["NO_LOCAL_FACT"],
      },
    },
  };
}

test("overview readiness preserves independent content, cost and procurement axes", () => {
  const summary = summarizeProductTruthSnapshots([
    snapshot({
      sku: "FACT",
      contentReady: true,
      procurementReady: true,
      costStatus: "FACT",
    }),
    snapshot({
      sku: "EST",
      contentReady: true,
      procurementReady: false,
      costStatus: "ESTIMATE",
    }),
    snapshot({
      sku: "NONE",
      contentReady: false,
      procurementReady: false,
      costStatus: "UNSOURCEABLE",
    }),
    snapshot({
      sku: "MISS",
      contentReady: false,
      procurementReady: false,
      costStatus: "MISSING",
    }),
    snapshot({
      sku: "BAD",
      contentReady: false,
      procurementReady: false,
      costStatus: "INVALID",
    }),
  ]);
  assert.deepEqual(summary, {
    bundleFactory: { ready: 2, blocked: 3 },
    listingImprovement: { ready: 2, blocked: 3 },
    unitEconomics: {
      ready: 2,
      blocked: 3,
      fact: 1,
      estimate: 1,
      unsourceable: 1,
      missing: 1,
      invalid: 1,
    },
    procurement: { ready: 1, blocked: 4 },
  });
  assert.deepEqual(PRODUCT_TRUTH_CONTROL_CENTER_CLAIMS, {
    readOnly: true,
    databaseWrites: false,
    legacyFallback: false,
    providerCalls: false,
    paidCalls: false,
    marketplaceMutations: false,
    procurementMutations: false,
    consumerCutoverClaimed: false,
  });
});

test("Product Truth API is owned by the Catalog RBAC module", () => {
  assert.equal(
    moduleKeyForApiPath("/api/catalog/product-truth/overview"),
    "catalog",
  );
  assert.equal(moduleKeyForApiPath("/api/catalog-status"), "catalog");
  assert.equal(moduleKeyForApiPath("/api/cogs/catalog"), "catalog");
  assert.equal(moduleKeyForApiPath("/api/reference-catalog/detail"), "catalog");
  assert.equal(moduleForPath("/cogs")?.key, "catalog");
  assert.equal(moduleForPath("/reference-catalog")?.key, "catalog");
  assert.equal(GRANTABLE_MODULE_KEYS.includes("cogs"), false);
  assert.equal(GRANTABLE_MODULE_KEYS.includes("reference-catalog"), false);
  assert.equal(
    canAccessModule({ role: "legacy-cost-role", modules: ["cogs"] }, "catalog"),
    true,
  );
});

async function createIntegrationSchema(db: Client): Promise<void> {
  await db.execute("PRAGMA foreign_keys=ON");
  await db.execute(`CREATE TABLE DonorProduct (
    id TEXT PRIMARY KEY, identityKey TEXT UNIQUE, brand TEXT, productLine TEXT,
    flavor TEXT, containerType TEXT, size TEXT
  )`);
  await db.execute(`CREATE TABLE DonorOffer (
    id TEXT PRIMARY KEY, donorProductId TEXT NOT NULL, retailer TEXT NOT NULL,
    retailerProductId TEXT NOT NULL, via TEXT NOT NULL DEFAULT 'direct'
  )`);
  await db.execute(`CREATE UNIQUE INDEX donor_offer_dedup
    ON DonorOffer(retailer, retailerProductId)`);
  await db.execute("CREATE TABLE SkuComponent (id TEXT PRIMARY KEY, donorProductId TEXT)");
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
  await db.execute(`CREATE TABLE EnrichmentJob (
    id TEXT PRIMARY KEY,
    targetType TEXT NOT NULL,
    target TEXT NOT NULL,
    normalizedTarget TEXT,
    listingKey TEXT,
    idempotencyKey TEXT,
    requestedFields TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'queued',
    runId TEXT,
    approvalId TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    leaseToken TEXT,
    leaseExpiresAt DATETIME
  )`);
  for (const relative of [
    "20260718234500_product_truth_evidence_provenance/migration.sql",
    "20260719000000_metered_budget_ledger/migration.sql",
    "20260719002000_product_truth_listing_scope/migration.sql",
    "20260719004000_product_truth_operational_run/migration.sql",
  ]) {
    const migration = new URL(
      `../../../../prisma/migrations/${relative}`,
      import.meta.url,
    );
    await db.executeMultiple(await readFile(migration, "utf8"));
  }
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function seedIntegrationCatalog(db: Client): Promise<string> {
  await db.execute({
    sql: `INSERT INTO ProductTruthListingScope (
            listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
            manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
            sourceReportId,sourceContentSha256,sourceCapturedAt,createdAt
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      "walmart:1:SKU-ONE",
      "product-truth-listing-key/1.0.0",
      "walmart",
      1,
      "SKU-ONE",
      "AUTHORITATIVE_PHASE1_MANIFEST",
      "phase1-authoritative-scope-manifest/v3",
      MANIFEST,
      "2026-07-25T12:00:00.000Z",
      "owner-phase1-1",
      "walmart-report-1",
      "b".repeat(64),
      "2026-07-25T11:00:00.000Z",
      "2026-07-25T12:00:00.000Z",
    ],
  });
  const identityHash = sha("control-center-integration-variant");
  const variantId = `cpv1:${identityHash}`;
  await db.execute({
    sql: `INSERT INTO CanonicalProductVariant (
            id,variantKey,identityHash,keyVersion,normalizedBrand,
            normalizedProductLine,normalizedFlavor,normalizedModifiersJson,
            normalizedForm,sizeDimension,sizeBaseAmount,sizeBaseUnit,
            outerPackCount,identityJson,createdAt
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      variantId,
      variantId,
      identityHash,
      "canonical-product-variant-key/1.0.0",
      "acme",
      "crackers",
      "original",
      "[]",
      "box",
      "MASS",
      226.796,
      "g",
      1,
      JSON.stringify({
        brand: "acme",
        productLine: "crackers",
        flavor: "original",
        form: "box",
        size: "8 oz",
        outerPackCount: 1,
      }),
      "2026-07-25T12:00:00.000Z",
    ],
  });
  return variantId;
}

test("all four backend views execute against the real canonical schema using read transactions", async () => {
  const db = createClient({ url: "file::memory:?cache=shared" });
  try {
    await createIntegrationSchema(db);
    const variantId = await seedIntegrationCatalog(db);
    const runtime = loadProductTruthControlCenterRuntime({ env: runtimeEnv() });
    assert.equal(runtime.status, "READ_ONLY");
    if (runtime.status !== "READ_ONLY") return;
    const readAt = "2026-07-25T13:00:00.000Z";

    const overview = await readProductTruthControlCenterOverview(db, {
      runtime,
      readAt,
    });
    assert.equal(overview.scope.denominator, 1);
    assert.deepEqual(overview.readiness.unitEconomics, {
      ready: 0,
      blocked: 1,
      fact: 0,
      estimate: 0,
      unsourceable: 0,
      missing: 1,
      invalid: 0,
    });
    assert.equal(overview.catalog.canonicalVariants, 1);
    assert.equal(overview.operations.runs, 0);

    const listings = await readProductTruthControlCenterListings(db, {
      runtime,
      readAt,
      channel: "walmart",
      storeIndex: 1,
      limit: 25,
    });
    assert.equal(listings.snapshots.length, 1);
    assert.equal(listings.snapshots[0]?.snapshot.listingKey, "walmart:1:SKU-ONE");
    assert.equal(listings.snapshots[0]?.views.unitEconomics.status, "MISSING");

    const variants = await readProductTruthControlCenterVariants(db, {
      runtime,
      readAt,
      query: "acme",
      limit: 25,
    });
    assert.equal(variants.variants.length, 1);
    assert.equal(variants.variants[0]?.canonicalVariantId, variantId);
    assert.equal(variants.variants[0]?.latestContent, null);
    assert.deepEqual(variants.variants[0]?.offers, []);

    const operations = await readProductTruthControlCenterOperations(db, {
      runtime,
      readAt,
      limit: 20,
    });
    assert.deepEqual(operations.runs, []);
    assert.equal(operations.claims.databaseWrites, false);
  } finally {
    db.close();
  }
});

test("Catalog pages and seven UI tabs consume only the canonical Product Truth API", async () => {
  const root = new URL("../../../../", import.meta.url);
  const files = {
    component: await readFile(
      new URL("src/components/catalog/ProductTruthCatalog.tsx", root),
      "utf8",
    ),
    tabs: await readFile(
      new URL("src/components/catalog/CatalogTabs.tsx", root),
      "utf8",
    ),
    overviewPage: await readFile(new URL("src/app/catalog/page.tsx", root), "utf8"),
    costAlias: await readFile(new URL("src/app/cogs/page.tsx", root), "utf8"),
    contentAlias: await readFile(
      new URL("src/app/reference-catalog/page.tsx", root),
      "utf8",
    ),
  };
  for (const [name, source] of Object.entries(files)) {
    assert.doesNotMatch(
      source,
      /\/api\/(?:catalog-status|cogs\/catalog|reference-catalog)/,
      `${name} retained a legacy catalog read`,
    );
  }
  assert.match(files.component, /\/api\/catalog\/product-truth\/overview/);
  assert.match(files.component, /\/api\/catalog\/product-truth\/variants/);
  assert.match(files.component, /\/api\/catalog\/product-truth\/listings/);
  assert.match(files.component, /\/api\/catalog\/product-truth\/operations/);
  assert.doesNotMatch(files.component, /method:\s*["']POST["']/);
  for (const label of [
    "Overview",
    "Products",
    "SKU Recipes",
    "Offers & COGS",
    "Queue & Runs",
    "Quality Review",
    "Consumer Readiness",
  ]) {
    assert.match(files.tabs, new RegExp(label.replace("&", "\\&")));
  }
});
