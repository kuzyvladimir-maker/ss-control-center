import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@libsql/client";

import type { CogsResult } from "../cogs";
import {
  compileProductTruthUnitEconomicsShadowReport,
  readLegacyCogsForProductTruthShadow,
  readLegacyIncludedListingKeysForProductTruthShadow,
  renderProductTruthUnitEconomicsShadowReportJson,
} from "../product-truth-shadow";
import type {
  ProductTruthConsumerGatewayReport,
  ProductTruthConsumerManifestScopePage,
} from "../../sourcing/product-truth-consumer-gateway";
import { PRODUCT_TRUTH_READ_CONTRACT_VERSION } from
  "../../sourcing/product-truth-read-contract-version";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../../sourcing/canonical-product-match-provenance";
import type { ProductTruthCostRecord } from
  "../../sourcing/product-truth-read-contract";

const READ_AT = "2026-07-19T12:30:00.000Z";
const MANIFEST = "a".repeat(64);
const TARGET = "b".repeat(64);

function legacy(overrides: Partial<CogsResult> = {}): CogsResult {
  return {
    skuCostId: "legacy-cost-1",
    cost: 5,
    perUnit: 5,
    packSize: 1,
    includesPackaging: false,
    source: "retail:batch",
    effectiveDate: "2026-07-19T12:00:00.000Z",
    stale: false,
    missing: false,
    outcome: "FACT",
    ...overrides,
  };
}

function cost(input: {
  sku: string;
  status: "FACT" | "ESTIMATE" | "UNSOURCEABLE";
  productCost: number | null;
  totalCost?: number | null;
}): ProductTruthCostRecord {
  return {
    id: `canonical-${input.sku}`,
    observationKey: "c".repeat(64),
    recipeHash: "d".repeat(64),
    sku: input.sku,
    effectiveDate: "2026-07-19T12:00:00.000Z",
    createdAt: "2026-07-19T12:00:00.000Z",
    source: "retail:batch",
    productCost: input.productCost,
    packagingCost: null,
    iceCost: null,
    totalCost: input.totalCost ?? input.productCost,
    costPerUnit: input.productCost,
    packSize: 1,
    currency: "USD",
    needsReview: input.status !== "FACT",
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    pricePolicyVersion: "price-evidence-eligibility/1.0.0",
    evidenceOutcome: input.status,
    evidence: {},
    runId: "run-1",
    approvalId: "approval-1",
    componentProvenance: [],
  };
}

function fixture(input: {
  channel?: "amazon" | "walmart";
  storeIndex?: number;
  sku?: string;
  status?: "FACT" | "ESTIMATE" | "UNSOURCEABLE" | "INVALID" | "MISSING";
  productCost?: number | null;
  totalCost?: number | null;
}) {
  const channel = input.channel ?? "amazon";
  const storeIndex = input.storeIndex ?? 1;
  const sku = input.sku ?? "SKU-1";
  const listingKey = `${channel}:${storeIndex}:${sku}`;
  const status = input.status ?? "FACT";
  const current = status === "FACT" || status === "ESTIMATE" || status === "UNSOURCEABLE"
    ? cost({
        sku,
        status,
        productCost: input.productCost === undefined ? 5 : input.productCost,
        totalCost: input.totalCost,
      })
    : null;
  const page: ProductTruthConsumerManifestScopePage = {
    authoritativeManifestSha256: MANIFEST,
    manifestInventory: {
      scopeCount: 1,
      partitions: [{ channel, storeIndex, scopeCount: 1 }],
    },
    channel,
    storeIndex,
    limit: 100,
    cursor: null,
    nextCursor: null,
    scopes: [{ listingKey, channel, storeIndex, sku }],
    claims: {
      readOnly: true,
      databaseWrites: false,
      providerCalls: false,
      marketplaceMutations: false,
    },
  };
  const gateway: ProductTruthConsumerGatewayReport = {
    schemaVersion: "product-truth-consumer-gateway/1.0.0",
    readContractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    activationSha256: "e".repeat(64),
    ownerApprovalId: "owner-shadow-1",
    mode: "SHADOW",
    outputUse: "COMPARE_ONLY",
    consumer: "UNIT_ECONOMICS",
    authoritativeManifestSha256: MANIFEST,
    databaseTargetFingerprint: TARGET,
    readAt: READ_AT,
    asOf: READ_AT,
    maxPriceAgeMs: 86_400_000,
    counts: {
      total: 1,
      ready: status === "FACT" || status === "ESTIMATE" ? 1 : 0,
      unsourceable: status === "UNSOURCEABLE" ? 1 : 0,
      blocked: status === "FACT" || status === "ESTIMATE" || status === "UNSOURCEABLE" ? 0 : 1,
      fact: status === "FACT" ? 1 : 0,
      estimate: status === "ESTIMATE" ? 1 : 0,
      missing: status === "MISSING" ? 1 : 0,
      invalid: status === "INVALID" ? 1 : 0,
    },
    entries: [{
      listingKey,
      channel,
      storeIndex,
      sku,
      disposition: status === "UNSOURCEABLE"
        ? "UNSOURCEABLE"
        : status === "FACT" || status === "ESTIMATE"
          ? "READY"
          : "BLOCKED",
      ready: status === "FACT" || status === "ESTIMATE",
      blockers: status === "MISSING" ? ["CURRENT_SCOPED_SKU_COST_MISSING"] : [],
      view: {
        consumer: "UNIT_ECONOMICS",
        status,
        current,
        factualCost: status === "FACT" ? current : null,
        estimatedCost: status === "ESTIMATE" ? current : null,
        blockers: status === "MISSING" ? ["CURRENT_SCOPED_SKU_COST_MISSING"] : [],
      },
    }],
    claims: {
      readOnly: true,
      legacyFallback: false,
      providerCalls: false,
      marketplaceMutations: false,
      procurementMutations: false,
    },
  };
  return { page, gateway, listingKey, sku };
}

test("exact typed scoped cost produces deterministic MATCH without changing business output", () => {
  const { page, gateway, listingKey, sku } = fixture({});
  const report = compileProductTruthUnitEconomicsShadowReport({
    page,
    gateway,
    legacyBySku: new Map([[sku, legacy()]]),
    legacyIncludedListingKeys: new Set([listingKey]),
    legacyCostListingKeys: new Map([["legacy-cost-1", listingKey]]),
  });
  assert.deepEqual(report.entries[0].mismatchClasses, ["MATCH"]);
  assert.equal(report.counts.match, 1);
  assert.equal(report.counts.mismatch, 0);
  assert.equal(report.claims.businessOutputChanged, false);
  assert.equal(report.claims.productTruthUsedAsAuthority, false);
  assert.match(report.payloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    compileProductTruthUnitEconomicsShadowReport({
      page,
      gateway,
      legacyBySku: new Map([[sku, legacy()]]),
      legacyIncludedListingKeys: new Set([listingKey]),
      legacyCostListingKeys: new Map([["legacy-cost-1", listingKey]]),
    }).payloadSha256,
    report.payloadSha256,
  );
  assert.equal(JSON.parse(renderProductTruthUnitEconomicsShadowReportJson(report)).payloadSha256,
    report.payloadSha256);
});

test("same raw SKU in another store exposes omitted, untyped and cross-scope legacy evidence", () => {
  const { page, gateway, listingKey, sku } = fixture({
    storeIndex: 3,
    sku: "SHARED-SKU",
    status: "ESTIMATE",
    productCost: 5,
  });
  const report = compileProductTruthUnitEconomicsShadowReport({
    page,
    gateway,
    legacyBySku: new Map([[sku, legacy({ outcome: "UNKNOWN" })]]),
    legacyIncludedListingKeys: new Set(),
    legacyCostListingKeys: new Map([["legacy-cost-1", "amazon:1:SHARED-SKU"]]),
  });
  assert.equal(report.entries[0].listingKey, listingKey);
  assert.deepEqual(report.entries[0].mismatchClasses, [
    "LEGACY_CROSS_SCOPE_COST",
    "LEGACY_SCOPE_OMITTED",
    "LEGACY_UNTYPED",
    "STATUS_MISMATCH",
  ]);
  assert.equal(report.counts.legacyCrossScopeCost, 1);
  assert.equal(report.counts.legacyScopeOmitted, 1);
  assert.equal(report.counts.legacyUntyped, 1);
});

test("canonical status never turns an unseparated total into product acquisition cost", () => {
  const { page, gateway, listingKey, sku } = fixture({
    status: "FACT",
    productCost: null,
    totalCost: 7,
  });
  const report = compileProductTruthUnitEconomicsShadowReport({
    page,
    gateway,
    legacyBySku: new Map([[sku, legacy({ cost: 7, perUnit: 7 })]]),
    legacyIncludedListingKeys: new Set([listingKey]),
    legacyCostListingKeys: new Map([["legacy-cost-1", listingKey]]),
  });
  assert.ok(report.entries[0].mismatchClasses.includes("CANONICAL_BLOCKED"));
  assert.ok(report.entries[0].mismatchClasses.includes(
    "CANONICAL_COST_BASIS_UNSEPARATED",
  ));
  assert.equal(report.entries[0].productTruth.productCost, null);
  assert.equal(report.counts.canonicalCostBasisUnseparated, 1);
});

test("missing legacy scope link is explicit and never inferred from raw SKU", () => {
  const { page, gateway, listingKey, sku } = fixture({});
  const report = compileProductTruthUnitEconomicsShadowReport({
    page,
    gateway,
    legacyBySku: new Map([[sku, legacy()]]),
    legacyIncludedListingKeys: new Set([listingKey]),
    legacyCostListingKeys: new Map(),
  });
  assert.ok(report.entries[0].mismatchClasses.includes("LEGACY_SCOPE_UNPROVEN"));
  assert.equal(report.entries[0].legacy.linkedListingKey, null);
  assert.equal(report.counts.legacyScopeUnproven, 1);
});

test("legacy SHADOW inputs share one transaction, as-of boundary and stable tie-break", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await db.executeMultiple(`
      CREATE TABLE SkuCost (
        id TEXT PRIMARY KEY, sku TEXT NOT NULL, totalCost REAL, costPerUnit REAL,
        packSize INTEGER, includesPackaging INTEGER NOT NULL, source TEXT NOT NULL,
        effectiveDate TEXT, evidenceOutcome TEXT, needsReview INTEGER NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE AmazonListingSnapshot (
        id TEXT PRIMARY KEY, storeIndex INTEGER NOT NULL, sku TEXT NOT NULL,
        price REAL, capturedAt TEXT NOT NULL
      );
      CREATE TABLE WalmartBuyBoxItem (
        id TEXT PRIMARY KEY, storeIndex INTEGER NOT NULL, sku TEXT NOT NULL,
        sellerItemPrice REAL, capturedAt TEXT NOT NULL, syncedAt TEXT NOT NULL
      );
    `);
    const shared = [
      "SKU-1", 5, 5, 1, 0, "retail:batch", "2026-07-19T12:00:00.000Z",
      "FACT", 0, "2026-07-19T12:00:00.000Z", "2026-07-19T12:00:00.000Z",
    ];
    await db.batch([
      {
        sql: `INSERT INTO SkuCost VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: ["cost-a", ...shared],
      },
      {
        sql: `INSERT INTO SkuCost VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: ["cost-b", "SKU-1", 6, 6, 1, 0, "retail:batch",
          "2026-07-19T12:00:00.000Z", "FACT", 0,
          "2026-07-19T12:00:00.000Z", "2026-07-19T12:00:00.000Z"],
      },
      {
        sql: `INSERT INTO SkuCost VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: ["cost-future", "SKU-1", 99, 99, 1, 0, "retail:batch",
          "2026-07-20T12:00:00.000Z", "FACT", 0,
          "2026-07-20T12:00:00.000Z", "2026-07-20T12:00:00.000Z"],
      },
      {
        sql: `INSERT INTO AmazonListingSnapshot VALUES (?,?,?,?,?)`,
        args: ["snapshot-now", 1, "SKU-1", 15, "2026-07-19T12:00:00.000Z"],
      },
      {
        sql: `INSERT INTO AmazonListingSnapshot VALUES (?,?,?,?,?)`,
        args: ["snapshot-future", 1, "SKU-FUTURE", 20, "2026-07-20T12:00:00.000Z"],
      },
    ], "write");
    const tx = await db.transaction("read");
    try {
      const cogs = await readLegacyCogsForProductTruthShadow(tx, {
        skus: ["SKU-1"],
        asOf: READ_AT,
      });
      assert.equal(cogs.get("SKU-1")?.skuCostId, "cost-b");
      assert.equal(cogs.get("SKU-1")?.cost, 6);

      const included = await readLegacyIncludedListingKeysForProductTruthShadow(tx, {
        channel: "amazon",
        storeIndex: 1,
        scopes: [
          { listingKey: "amazon:1:SKU-1", sku: "SKU-1" },
          { listingKey: "amazon:1:SKU-FUTURE", sku: "SKU-FUTURE" },
        ],
        asOf: READ_AT,
      });
      assert.deepEqual([...included], ["amazon:1:SKU-1"]);
    } finally {
      tx.close();
    }
  } finally {
    db.close();
  }
});
