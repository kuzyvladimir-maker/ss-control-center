import assert from "node:assert/strict";
import test from "node:test";

import {
  WALMART_LISTING_INTEGRITY_MAX_IMAGES_PER_PARTITION,
  buildWalmartListingIntegrityCatalogCensus,
  buildWalmartListingIntegrityScanPlan,
  verifyWalmartListingIntegrityCatalogArtifacts,
  verifyWalmartListingIntegrityCatalogFreshness,
} from "../listing-integrity-catalog-orchestrator.ts";

const capturedAt = "2026-07-23T12:00:00.000Z";
const syncedAt = "2026-07-23T11:30:00.000Z";

function catalog(sku, overrides = {}) {
  return {
    sku,
    itemId: "123456789",
    title: `${sku} Product (Pack of 6)`,
    lifecycleStatus: "ACTIVE",
    publishedStatus: "PUBLISHED",
    syncedAt,
    mainImageUrl: null,
    ...overrides,
  };
}

function remediation(sku, overrides = {}) {
  return {
    id: `r-${sku}`,
    sku,
    runAt: "2026-07-22T10:00:00.000Z",
    feedStatus: "APPLIED",
    ok: 1,
    mainImageUrl: `https://images.example.test/${sku}.png`,
    newTitle: null,
    packCount: 6,
    changeSummary: null,
    ...overrides,
  };
}

function sourceReport(overrides = {}) {
  return {
    id: "report-row-1",
    storeIndex: 1,
    reportType: "ITEM_CATALOG",
    requestId: "request-1",
    status: "DOWNLOADED",
    requestedAt: "2026-07-23T11:00:00.000Z",
    readyAt: "2026-07-23T11:25:00.000Z",
    downloadedAt: syncedAt,
    rowCount: 1,
    error: null,
    ...overrides,
  };
}

test("full catalog is reconciled exactly once and every SKU gets a disposition", () => {
  const census = buildWalmartListingIntegrityCatalogCensus({
    store_index: 1,
    captured_at: capturedAt,
    catalog_rows: [
      catalog("A"),
      catalog("B"),
      catalog("C", { publishedStatus: "SYSTEM_PROBLEM" }),
      catalog("D", { lifecycleStatus: "RETIRED" }),
      catalog("E", { itemId: null }),
    ],
    remediation_rows: [remediation("A")],
  });
  assert.equal(census.reconciliation.catalog_rows, 5);
  assert.equal(census.reconciliation.distinct_skus, 5);
  assert.equal(census.reconciliation.output_rows, 5);
  assert.equal(census.reconciliation.exact_once, true);
  assert.deepEqual(census.summary.disposition_counts, {
    VISUAL_TRIAGE_READY: 1,
    SOURCE_ACQUISITION_REQUIRED: 1,
    STATUS_REVIEW: 1,
    BLOCKED_SOURCE: 1,
    DO_NOT_TOUCH: 1,
  });
  assert.equal(census.source_contract.may_issue_pass, false);
  assert.equal(census.source_contract.may_authorize_walmart_write, false);
});

test("title/content quantity conflict is deterministic and never becomes PASS", () => {
  const census = buildWalmartListingIntegrityCatalogCensus({
    store_index: 1,
    captured_at: capturedAt,
    catalog_rows: [catalog("A")],
    remediation_rows: [
      remediation("A"),
      remediation("A", {
        id: "content-A",
        runAt: "2026-07-22T09:00:00.000Z",
        feedStatus: "SUBMITTED",
        changeSummary: JSON.stringify({
          content: {
            productName: "A Product (Pack of 4)",
            multipackQuantity: 4,
            mainImageUrl: "https://images.example.test/A-content.png",
            productSecondaryImageURL: ["https://images.example.test/A-gallery.png"],
          },
        }),
      }),
    ],
  });
  assert.deepEqual(census.rows[0].deterministic_findings, [
    "CATALOG_TITLE_VS_SENT_TITLE_OUTER_COUNT_CONFLICT",
    "TITLE_VS_SENT_CONTENT_OUTER_COUNT_CONFLICT",
  ]);
  assert.equal(census.rows[0].scan_disposition, "VISUAL_TRIAGE_READY");
  assert.equal(census.rows[0].scan_priority, 0);
  assert.equal(census.summary.deterministic_conflicts, 1);
});

test("scan plan is exhaustive for reusable assets, bounded, and exactly rebuildable", () => {
  const catalogRows = [];
  const remediationRows = [];
  for (let index = 0; index < 50; index += 1) {
    const sku = `SKU-${String(index).padStart(3, "0")}`;
    catalogRows.push(catalog(sku));
    remediationRows.push(remediation(sku));
  }
  const census = buildWalmartListingIntegrityCatalogCensus({
    store_index: 1,
    captured_at: capturedAt,
    catalog_rows: catalogRows,
    remediation_rows: remediationRows,
  });
  const plan = buildWalmartListingIntegrityScanPlan(census);
  assert.equal(plan.coverage.catalog_listings, 50);
  assert.equal(plan.coverage.visual_tasks, 50);
  assert.equal(plan.coverage.listings_with_visual_tasks, 50);
  assert.equal(plan.partitions.length, 2);
  assert.equal(plan.partitions.every((row) => (
    row.task_count <= WALMART_LISTING_INTEGRITY_MAX_IMAGES_PER_PARTITION
    && row.estimated_model_calls_max <= 6
  )), true);
  assert.deepEqual(verifyWalmartListingIntegrityCatalogArtifacts({ census, plan }), {
    verified: true,
    listings: 50,
    tasks: 50,
    partitions: 2,
  });
});

test("partition boundaries never split the images of one listing", () => {
  const catalogRows = [];
  const remediationRows = [];
  for (let index = 0; index < 31; index += 1) {
    const sku = `A-${String(index).padStart(3, "0")}`;
    catalogRows.push(catalog(sku));
    remediationRows.push(remediation(sku));
  }
  catalogRows.push(catalog("Z-GROUP"));
  remediationRows.push(remediation("Z-GROUP", {
    feedStatus: "PROCESSED",
    changeSummary: JSON.stringify({
      content: {
        productName: "Z Product (Pack of 6)",
        multipackQuantity: 6,
        mainImageUrl: "https://images.example.test/Z-main.png",
        productSecondaryImageURL: Array.from(
          { length: 6 },
          (_, index) => `https://images.example.test/Z-gallery-${index + 1}.png`,
        ),
      },
    }),
  }));
  const census = buildWalmartListingIntegrityCatalogCensus({
    store_index: 1,
    captured_at: capturedAt,
    catalog_rows: catalogRows,
    remediation_rows: remediationRows,
  });
  const plan = buildWalmartListingIntegrityScanPlan(census);
  const locations = plan.partitions.filter((partition) => (
    partition.tasks.some((task) => task.listing_key === "walmart:1:Z-GROUP")
  ));
  assert.equal(locations.length, 1);
  assert.equal(locations[0].tasks.filter((task) => (
    task.listing_key === "walmart:1:Z-GROUP"
  )).length, 7);
  assert.equal(locations[0].task_count, 7);
  assert.equal(plan.partitions[0].task_count, 31);
  assert.deepEqual(verifyWalmartListingIntegrityCatalogArtifacts({ census, plan }), {
    verified: true,
    listings: 32,
    tasks: 38,
    partitions: 2,
  });
});

test("duplicate catalog SKU and non-atomic mirror fail closed", () => {
  assert.throws(() => buildWalmartListingIntegrityCatalogCensus({
    store_index: 1,
    captured_at: capturedAt,
    catalog_rows: [catalog("A"), catalog("A")],
    remediation_rows: [],
  }), /duplicate catalog SKU/);
  assert.throws(() => buildWalmartListingIntegrityCatalogCensus({
    store_index: 1,
    captured_at: capturedAt,
    catalog_rows: [catalog("A"), catalog("B", { syncedAt: "2026-07-23T11:31:00.000Z" })],
    remediation_rows: [],
  }), /not one atomic catalog snapshot/);
});

test("authoritative census binds exact ITEM_CATALOG provenance and expires closed", () => {
  const census = buildWalmartListingIntegrityCatalogCensus({
    store_index: 1,
    captured_at: capturedAt,
    catalog_rows: [catalog("A")],
    remediation_rows: [],
    source_report: sourceReport(),
  });
  assert.equal(census.schema_version, "walmart-listing-integrity-catalog-census/v2");
  assert.equal(
    census.source_contract.authority,
    "AUTHORITATIVE_ITEM_CATALOG_REPORT_MIRROR",
  );
  assert.equal(census.source_report.request_id, "request-1");
  assert.deepEqual(verifyWalmartListingIntegrityCatalogFreshness({
    census,
    as_of: "2026-07-23T12:01:00.000Z",
  }), {
    verified: true,
    authority: "AUTHORITATIVE_ITEM_CATALOG_REPORT_MIRROR",
    report_request_id: "request-1",
    report_downloaded_at: syncedAt,
    report_age_ms: 31 * 60 * 1_000,
    snapshot_age_ms: 60 * 1_000,
    catalog_rows: 1,
  });
  assert.throws(() => verifyWalmartListingIntegrityCatalogFreshness({
    census,
    as_of: "2026-07-24T12:00:01.000Z",
  }), /report is stale/u);
  assert.throws(() => verifyWalmartListingIntegrityCatalogFreshness({
    census,
    as_of: "2026-07-23T12:16:00.000Z",
  }), /snapshot is stale/u);
});

test("authoritative census rejects report/mirror count or timestamp mismatch", () => {
  for (const report of [
    sourceReport({ rowCount: 2 }),
    sourceReport({ downloadedAt: "2026-07-23T11:29:59.000Z" }),
    sourceReport({ status: "READY" }),
  ]) {
    assert.throws(() => buildWalmartListingIntegrityCatalogCensus({
      store_index: 1,
      captured_at: capturedAt,
      catalog_rows: [catalog("A")],
      remediation_rows: [],
      source_report: report,
    }), /does not exactly reconcile/u);
  }
});
