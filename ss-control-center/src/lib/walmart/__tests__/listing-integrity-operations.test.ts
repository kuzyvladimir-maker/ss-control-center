import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWalmartListingIntegrityCatalogCensus,
  buildWalmartListingIntegrityScanPlan,
  walmartListingIntegrityCatalogSha256,
} from "../listing-integrity-catalog-orchestrator";
import {
  buildWalmartListingIntegrityControlledPool,
  parseWalmartListingIntegrityCompletedCase,
  verifyWalmartListingIntegrityControlledPool,
  type WalmartListingIntegrityPerformanceRow,
} from "../listing-integrity-operations";

function verification(qualificationPass = true) {
  const body = {
    schema_version: "walmart-listing-integrity-live-canary-verification/v1",
    status: "LIVE_SURFACE_PASS",
    listing: {
      listing_key: "walmart:1:done-sku",
      sku: "done-sku",
      item_id: "123456",
      store_index: 1,
    },
    feed_id: "feed-accepted-1",
    exact_payload_sha256: "a".repeat(64),
    before: { captured_at: "2026-07-26T10:00:00.000Z" },
    after: { captured_at: "2026-07-26T11:00:00.000Z" },
    checks: Object.fromEntries(
      Array.from({ length: 18 }, (_, index) => [`check_${String(index)}`, true]),
    ),
    qualification_boundary: {
      buyer_facing_live_surface_verified: true,
      frozen_sequence_gate_receipt_emitted: qualificationPass,
      next_sku_unblocked: qualificationPass,
    },
  };
  return { ...body, body_sha256: walmartListingIntegrityCatalogSha256(body) };
}

function noChangeVerification(noWriteBoundary = true) {
  const body = {
    schema_version: "walmart-listing-integrity-no-change-verification/v1",
    status: "LIVE_SURFACE_PASS",
    completion_mode: "AUDITED_NO_CHANGE",
    qualified_at: "2026-07-26T11:01:00.000Z",
    listing: {
      listing_key: "walmart:1:clean-sku",
      sku: "clean-sku",
      item_id: "654321",
      store_index: 1,
    },
    feed_id: null,
    exact_payload_sha256: null,
    before: { captured_at: "2026-07-26T11:00:00.000Z" },
    after: { captured_at: "2026-07-26T11:00:00.000Z" },
    checks: Object.fromEntries(
      Array.from({ length: 19 }, (_, index) => [`check_${String(index)}`, true]),
    ),
    qualification_boundary: {
      buyer_facing_live_surface_verified: true,
      source_aware_qualification_receipt_emitted: noWriteBoundary,
      no_walmart_write_required: noWriteBoundary,
      next_sku_unblocked: noWriteBoundary,
    },
  };
  return { ...body, body_sha256: walmartListingIntegrityCatalogSha256(body) };
}

function catalog() {
  const catalogRows = Array.from({ length: 12 }, (_, index) => ({
    sku: `sku-${String(index).padStart(2, "0")}`,
    itemId: `item-${String(index)}`,
    title: `Example Grocery Product (Pack of ${index % 3 + 2})`,
    lifecycleStatus: "ACTIVE",
    publishedStatus: "PUBLISHED",
    syncedAt: "2026-07-27T06:00:00.000Z",
    mainImageUrl: `https://i5.walmartimages.com/asr/${String(index)}.jpeg`,
  }));
  const remediationRows = catalogRows.map((row, index) => ({
    id: `repair-${String(index)}`,
    sku: row.sku,
    runAt: "2026-07-26T10:00:00.000Z",
    feedStatus: "PROCESSED",
    ok: 1,
    mainImageUrl: row.mainImageUrl,
    newTitle: row.title,
    packCount: index % 3 + 2,
    changeSummary: JSON.stringify({
      content: {
        productName: row.title,
        multipackQuantity: index === 3 ? 9 : index % 3 + 2,
        mainImageUrl: row.mainImageUrl,
      },
    }),
  }));
  const census = buildWalmartListingIntegrityCatalogCensus({
    store_index: 1,
    captured_at: "2026-07-27T12:00:00.000Z",
    catalog_rows: catalogRows,
    remediation_rows: remediationRows,
  });
  return { census, scanPlan: buildWalmartListingIntegrityScanPlan(census) };
}

function readiness(
  census: ReturnType<typeof catalog>["census"],
  sourceRequiredSkus: readonly string[] = [],
) {
  const blocked = new Set(sourceRequiredSkus);
  return census.rows.map((row) => ({
    listingKey: row.listing_key,
    storeIndex: row.store_index,
    sku: row.sku,
    listingImprovementReady: !blocked.has(row.sku),
    componentCount: blocked.has(row.sku) ? 0 : 1,
    blockers: blocked.has(row.sku) ? ["EXACT_COMPONENT_MISSING"] : [],
  }));
}

test("completed case requires exact body seal and final Qualification PASS", () => {
  const parsed = parseWalmartListingIntegrityCompletedCase({
    verification: verification(),
    verificationFileSha256: "b".repeat(64),
    galleryFileSha256: "c".repeat(64),
    verificationPath: "data/verification.json",
    galleryPath: "data/gallery.html",
  });
  assert.equal(parsed.sku, "done-sku");
  assert.equal(parsed.checksPassed, 18);
  assert.throws(
    () => parseWalmartListingIntegrityCompletedCase({
      verification: verification(false),
      verificationFileSha256: "b".repeat(64),
      galleryFileSha256: "c".repeat(64),
      verificationPath: "data/verification.json",
      galleryPath: "data/gallery.html",
    }),
    /not bound to final Qualification PASS/,
  );
});

test("audited no-change case requires source-aware Qualification and no fake feed", () => {
  const parsed = parseWalmartListingIntegrityCompletedCase({
    verification: noChangeVerification(),
    verificationFileSha256: "d".repeat(64),
    galleryFileSha256: "e".repeat(64),
    verificationPath: "data/no-change-verification.json",
    galleryPath: "data/no-change-gallery.html",
  });
  assert.equal(parsed.completionMode, "AUDITED_NO_CHANGE");
  assert.equal(parsed.feedId, null);
  assert.equal(parsed.payloadSha256, null);
  assert.throws(
    () => parseWalmartListingIntegrityCompletedCase({
      verification: noChangeVerification(false),
      verificationFileSha256: "d".repeat(64),
      galleryFileSha256: "e".repeat(64),
      verificationPath: "data/no-change-verification.json",
      galleryPath: "data/no-change-gallery.html",
    }),
    /not bound to final Qualification PASS/,
  );
});

test("controlled pool is read-only, excludes completed SKUs and prioritizes proven conflicts", () => {
  const { census, scanPlan } = catalog();
  const performanceRows: WalmartListingIntegrityPerformanceRow[] = census.rows.map(
    (row, index) => ({
      sku: row.sku,
      storeIndex: 1,
      units30: index,
      sales30: index * 10,
      orders30: index,
      returns30: index === 5 ? 2 : 0,
      units90: index * 3,
      sales90: index * 100,
      orders90: index * 2,
      returns90: index === 5 ? 5 : index === 3 ? 1 : 0,
      computedAt: "2026-07-27T11:00:00.000Z",
    }),
  );
  const pool = buildWalmartListingIntegrityControlledPool({
    census,
    scanPlan,
    censusFileSha256: "d".repeat(64),
    scanPlanFileSha256: "e".repeat(64),
    performanceRows,
    productTruthReadiness: readiness(census, ["sku-05"]).filter(
      (row) => row.sku !== "sku-00" && row.sku !== "sku-01" && row.sku !== "sku-02",
    ),
    authoritativeManifestSha256: "4".repeat(64),
    databaseReads: 2,
    completedCases: [{
      listingKey: "walmart:1:sku-00",
      sku: "sku-00",
      itemId: "item-0",
      storeIndex: 1,
      feedId: "feed-0",
      payloadSha256: "f".repeat(64),
      qualifiedAt: "2026-07-26T11:00:00.000Z",
      beforeCapturedAt: "2026-07-26T10:00:00.000Z",
      afterCapturedAt: "2026-07-26T11:00:00.000Z",
      checksPassed: 18,
      verificationBodySha256: "1".repeat(64),
      verificationFileSha256: "2".repeat(64),
      galleryFileSha256: "3".repeat(64),
      verificationPath: "verification.json",
      galleryPath: "gallery.html",
    }],
    processedControlListingKeys: ["walmart:1:sku-02"],
    reservedListingKeys: ["walmart:1:sku-01"],
    createdAt: "2026-07-27T12:30:00.000Z",
    requestedSize: 10,
  });
  assert.equal(pool.items.length, 8);
  assert.equal(pool.items[0]?.sku, "sku-03");
  assert.equal(pool.items.some((item) => item.sku === "sku-00"), false);
  assert.equal(pool.items.some((item) => item.sku === "sku-01"), false);
  assert.equal(pool.items.some((item) => item.sku === "sku-02"), false);
  assert.deepEqual(pool.processedControlListingKeys, ["walmart:1:sku-02"]);
  assert.deepEqual(pool.reservedListingKeys, ["walmart:1:sku-01"]);
  assert.equal(pool.items.every((item) => item.authority.productTruthReady), true);
  assert.equal(pool.sourceRequiredItems[0]?.sku, "sku-05");
  assert.equal(pool.sourceRequiredItems[0]?.nextAction, "ENRICH_EXACT_PRODUCT_TRUTH");
  assert.equal(pool.sourceReadiness.sourceRequiredCount, 1);
  assert.equal(pool.policy.maxApplyInFlight, 1);
  assert.equal(pool.policy.walmartWritesAllowed, false);
  assert.equal(pool.items.every((item) => !item.authority.walmartWriteAuthorized), true);
  assert.doesNotThrow(() => verifyWalmartListingIntegrityControlledPool(pool));
});

test("controlled pool seal and strict sequence fail closed", () => {
  const { census, scanPlan } = catalog();
  const pool = buildWalmartListingIntegrityControlledPool({
    census,
    scanPlan,
    censusFileSha256: "d".repeat(64),
    scanPlanFileSha256: "e".repeat(64),
    performanceRows: [],
    productTruthReadiness: readiness(census, ["sku-10", "sku-11"]),
    authoritativeManifestSha256: "4".repeat(64),
    databaseReads: 2,
    completedCases: [],
    createdAt: "2026-07-27T12:30:00.000Z",
    requestedSize: 10,
  });
  assert.throws(
    () => verifyWalmartListingIntegrityControlledPool({
      ...pool,
      policy: {
        ...pool.policy,
        walmartWritesAllowed: true,
      } as unknown as typeof pool.policy,
    }),
    /seal mismatch/,
  );
});

test("exact algorithm-fix readmission is sealed, prioritized, and selected once", () => {
  const { census, scanPlan } = catalog();
  const readmittedKey = "walmart:1:sku-01";
  const pool = buildWalmartListingIntegrityControlledPool({
    census,
    scanPlan,
    censusFileSha256: "d".repeat(64),
    scanPlanFileSha256: "e".repeat(64),
    performanceRows: [],
    productTruthReadiness: readiness(census),
    authoritativeManifestSha256: "4".repeat(64),
    databaseReads: 2,
    completedCases: [],
    processedControlListingKeys: [],
    readmission: {
      schemaVersion: "walmart-listing-integrity-controlled-pool-readmission/v1",
      artifactFileSha256: "8".repeat(64),
      artifactBodySha256: "9".repeat(64),
      items: [{
        listingKey: readmittedKey,
        priorStateBodySha256: "7".repeat(64),
        reasonCode: "ALGORITHM_FALSE_NEGATIVE_FIXED",
      }],
    },
    createdAt: "2026-07-27T12:30:00.000Z",
    requestedSize: 10,
  });
  assert.equal(pool.items[0]?.listingKey, readmittedKey);
  assert.equal(pool.readmission?.items[0]?.listingKey, readmittedKey);
  assert.doesNotThrow(() => verifyWalmartListingIntegrityControlledPool(pool));
  assert.throws(
    () => buildWalmartListingIntegrityControlledPool({
      census,
      scanPlan,
      censusFileSha256: "d".repeat(64),
      scanPlanFileSha256: "e".repeat(64),
      performanceRows: [],
      productTruthReadiness: readiness(census).filter((row) => row.listingKey !== readmittedKey),
      authoritativeManifestSha256: "4".repeat(64),
      databaseReads: 2,
      completedCases: [],
      processedControlListingKeys: [readmittedKey],
      readmission: pool.readmission,
      createdAt: "2026-07-27T12:30:00.000Z",
      requestedSize: 10,
    }),
    /still excluded/,
  );
});

test("full published denominator includes rows without a preliminary defect signal", () => {
  const census = buildWalmartListingIntegrityCatalogCensus({
    store_index: 1,
    captured_at: "2026-07-27T12:00:00.000Z",
    catalog_rows: [{
      sku: "plain-published-sku",
      itemId: "plain-item",
      title: "Example Grocery Product",
      lifecycleStatus: "ACTIVE",
      publishedStatus: "PUBLISHED",
      syncedAt: "2026-07-27T06:00:00.000Z",
      mainImageUrl: "https://i5.walmartimages.com/asr/plain.jpeg",
    }],
    remediation_rows: [],
  });
  assert.equal(census.rows[0]?.scan_disposition, "SOURCE_ACQUISITION_REQUIRED");
  assert.equal(census.rows[0]?.deterministic_findings.length, 0);
  const scanPlan = buildWalmartListingIntegrityScanPlan(census);
  const pool = buildWalmartListingIntegrityControlledPool({
    census,
    scanPlan,
    censusFileSha256: "d".repeat(64),
    scanPlanFileSha256: "e".repeat(64),
    performanceRows: [],
    productTruthReadiness: readiness(census),
    authoritativeManifestSha256: "4".repeat(64),
    databaseReads: 2,
    completedCases: [],
    createdAt: "2026-07-27T12:30:00.000Z",
    requestedSize: 10,
  });
  assert.equal(pool.sourceReadiness.candidateCount, 1);
  assert.equal(pool.items[0]?.sku, "plain-published-sku");
  assert.doesNotThrow(() => verifyWalmartListingIntegrityControlledPool(pool));
});
