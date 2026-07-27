import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveExactWalmartItemCandidate } from "../../src/lib/walmart/exact-item-resolution.ts";
import {
  buildExactItemProbeDryPlan,
  buildExactItemProbeReport,
  parseExactItemProbeArgs,
  verifyExactItemProbeReport,
  writeNewExactItemProbeReport,
} from "../probe-walmart-exact-item-resolution.ts";

const sku = "FaisalX-1130";

function resolution() {
  const title = "Pepperidge Farm Whole Grain Bread, 22 oz (Pack of 2)";
  const seller = {
    ItemResponse: [{
      sku,
      productName: title,
      upc: "684611898401",
      gtin: "00684611898401",
      wpid: "2IAXRO7DM5YP",
      publishedStatus: "PUBLISHED",
      lifecycleStatus: "ACTIVE",
    }],
  };
  const catalog = {
    items: [{
      itemId: "8412702942",
      standardUpc: ["00684611898401"],
      title,
      isMarketPlaceItem: true,
      images: [{ url: "https://i5.walmartimages.com/exact.png" }],
    }],
  };
  return {
    value: resolveExactWalmartItemCandidate(sku, seller, catalog),
    seller,
    catalog,
  };
}

function probeResponses() {
  const source = resolution();
  return {
    resolution: source.value,
    responses: {
      seller: {
        status: 200,
        correlation_id: "11111111-1111-4111-8111-111111111111",
        payload: source.seller,
      },
      catalog_search: {
        status: 200,
        correlation_id: "22222222-2222-4222-8222-222222222222",
        payload: source.catalog,
      },
    },
  };
}

test("requires explicit SKU and keeps network opt-in", () => {
  assert.throws(() => parseExactItemProbeArgs([]), /--sku must be explicit/);
  assert.throws(
    () => parseExactItemProbeArgs(["--sku", sku, "--unknown"]),
    /unsupported argument/,
  );
  assert.deepEqual(parseExactItemProbeArgs([`--sku=${sku}`]), {
    sku,
    store_index: 1,
    run: false,
  });
  assert.deepEqual(parseExactItemProbeArgs(["--sku", sku, "--store-index=2", "--run"]), {
    sku,
    store_index: 2,
    run: true,
  });
});

test("dry plan attests zero network execution and zero writes", () => {
  const args = parseExactItemProbeArgs([`--sku=${sku}`]);
  const plan = buildExactItemProbeDryPlan(args);
  assert.equal(plan.mode, "dry_validation");
  assert.equal(plan.run_authorized, false);
  assert.equal(plan.planned_walmart_logical_get_operations_if_run, 2);
  assert.equal(plan.walmart_http_get_attempts_max_if_run, 10);
  assert.equal(plan.oauth_token_posts_max_if_run, 3);
  assert.equal(plan.database_writes, 0);
  assert.equal(plan.walmart_writes, 0);
  assert.equal(plan.paid_api_calls, 0);
});

test("report seals replay-sufficient raw API evidence and honest transport bounds", () => {
  const source = probeResponses();
  const report = buildExactItemProbeReport(
    { sku, store_index: 1 },
    source.resolution,
    source.responses,
    new Date("2026-07-18T20:30:00.000Z"),
  );
  assert.equal(verifyExactItemProbeReport(report), true);
  assert.equal(report.execution.walmart_logical_get_operations, 2);
  assert.equal(report.execution.walmart_http_get_attempts_max, 10);
  assert.equal(report.execution.oauth_token_posts_max, 3);
  assert.equal(report.execution.actual_transport_attempts_observed, false);
  assert.equal(report.execution.buyer_pdp_gets, 0);
  assert.equal(report.execution.paid_api_calls, 0);
  assert.equal(report.resolution.buyer_facing_verified, false);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('"ItemResponse":'), true);
  assert.equal(serialized.includes('"items":'), true);
  assert.equal(
    report.source_payloads.seller.canonical_sha256,
    report.resolution.source_hashes.seller_payload_canonical_sha256,
  );

  const tampered = structuredClone(report);
  tampered.resolution.catalog_search_candidate.item_id = "999";
  assert.equal(verifyExactItemProbeReport(tampered), false);
});

test("immutable writer creates a new sealed file and never overwrites it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wm-exact-item-probe-test-"));
  try {
    const source = probeResponses();
    const report = buildExactItemProbeReport(
      { sku, store_index: 1 },
      source.resolution,
      source.responses,
      new Date("2026-07-18T20:30:00.000Z"),
    );
    const output = await writeNewExactItemProbeReport(report, root);
    const stored = JSON.parse(await readFile(output, "utf8"));
    assert.equal(verifyExactItemProbeReport(stored), true);
    await assert.rejects(
      () => writeNewExactItemProbeReport(report, root),
      (error) => error?.code === "EEXIST",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
