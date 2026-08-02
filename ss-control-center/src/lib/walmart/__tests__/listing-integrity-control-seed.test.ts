import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  walmartListingIntegrityCatalogSha256,
} from "../listing-integrity-catalog-orchestrator.ts";
import {
  buildWalmartListingIntegrityControlSeedPlan,
  verifyWalmartListingIntegrityControlSeedPlan,
} from "../listing-integrity-control-seed.ts";
import type {
  WalmartListingIntegrityControlledPool,
  WalmartListingIntegrityControlledPoolItem,
} from "../listing-integrity-operations.ts";

const H = (value: string) => createHash("sha256").update(value).digest("hex");

function item(input: {
  ordinal: number;
  sku: string;
  itemId: string;
}): WalmartListingIntegrityControlledPoolItem {
  return {
    ordinal: input.ordinal,
    listingKey: `walmart:1:${input.sku}`,
    storeIndex: 1,
    sku: input.sku,
    itemId: input.itemId,
    title: `${input.sku} exact product`,
    stage: "PRODUCT_TRUTH_READY",
    nextAction: "FRESH_SOURCE_AWARE_AUDIT",
    titleOuterCount: 2,
    deterministicFindings: ["TITLE_COUNT_REVIEW"],
    reasonCodes: [],
    productTruthBlockers: [],
    performance: {
      computedAt: null,
      units30: 0,
      sales30: 0,
      orders30: 0,
      returns30: 0,
      units90: 0,
      sales90: 0,
      orders90: 0,
      returns90: 0,
      returnRate90: null,
    },
    authority: {
      productTruthReady: true,
      freshBuyerRereadReady: false,
      repairPlanReady: false,
      ownerPermitReady: false,
      walmartWriteAuthorized: false,
    },
  };
}

function pool(): WalmartListingIntegrityControlledPool {
  const items = [
    item({ ordinal: 0, sku: "RizwanX-2168", itemId: "3AX6ENJUV883" }),
    item({ ordinal: 1, sku: "FaisalX-1144", itemId: "3AVBUC6GCQH2" }),
  ];
  const body = {
    schemaVersion: "walmart-listing-integrity-controlled-pool/v3" as const,
    createdAt: "2026-08-01T14:32:09.102Z",
    storeIndex: 1,
    source: {
      censusId: "census-1",
      censusBodySha256: H("census-body"),
      censusFileSha256: H("census-file"),
      scanPlanId: "scan-1",
      scanPlanBodySha256: H("scan-body"),
      scanPlanFileSha256: H("scan-file"),
      authoritativeManifestSha256: H("manifest"),
    },
    policy: {
      mode: "READ_ONLY_CONTROLLED_POOL" as const,
      requestedSize: 2,
      sourceRequiredPreviewSize: 0,
      strictSequence: true as const,
      maxApplyInFlight: 1 as const,
      automaticRetryAllowed: false as const,
      unknownPostReplayAllowed: false as const,
      walmartWritesAllowed: false as const,
      modelCallsAllowed: false as const,
      paidProviderCallsAllowed: false as const,
      terminalFailureMayQuarantineAndAdvance: true as const,
    },
    completedListingKeys: [],
    quarantinedListingKeys: [],
    quarantinedItems: [],
    items,
    sourceRequiredItems: [],
    sourceReadiness: {
      candidateCount: 2,
      repairReadyCount: 2,
      sourceRequiredCount: 0,
      quarantinedCount: 0,
    },
    externalEffects: {
      databaseReads: 1,
      databaseWrites: 0 as const,
      walmartReads: 0 as const,
      walmartWrites: 0 as const,
      modelCalls: 0 as const,
      paidProviderCalls: 0 as const,
    },
  };
  const bodySha256 = walmartListingIntegrityCatalogSha256(body);
  return {
    ...body,
    poolId: `controlled-pool-${bodySha256.slice(0, 20)}`,
    bodySha256,
  };
}

test("sealed controlled pool becomes a deterministic one-based default-OFF queue", () => {
  const plan = buildWalmartListingIntegrityControlSeedPlan({
    pool: pool(),
    release_id_sha256: H("release"),
    manifest_sha256: H("release-manifest"),
    created_at: "2026-08-01T18:00:00.000Z",
  });
  verifyWalmartListingIntegrityControlSeedPlan(plan);
  assert.equal(plan.run.runtime_stage, "OFF");
  assert.equal(plan.fences.database_writes_authorized, false);
  assert.equal(plan.fences.walmart_writes_authorized, false);
  assert.deepEqual(plan.items.map((entry) => entry.identity.ordinal), [1, 2]);
  assert.deepEqual(plan.items.map((entry) => entry.identity.sku), [
    "RizwanX-2168",
    "FaisalX-1144",
  ]);
  assert.equal(plan.items[1]?.identity.item_id, "3AVBUC6GCQH2");
});

test("source-required-only pool becomes a bounded diagnostic queue", () => {
  const original = pool();
  const sourceItem: WalmartListingIntegrityControlledPoolItem = {
    ...original.items[0]!,
    ordinal: 0,
    stage: "SOURCE_REQUIRED",
    nextAction: "ENRICH_EXACT_PRODUCT_TRUTH",
    productTruthBlockers: ["EXACT_PRODUCT_TRUTH_REQUIRED"],
    authority: {
      ...original.items[0]!.authority,
      productTruthReady: false,
    },
  };
  const { poolId: _poolId, bodySha256: _bodySha256, ...originalBody } = original;
  const body = {
    ...originalBody,
    policy: {
      ...originalBody.policy,
      sourceRequiredPreviewSize: 1,
    },
    items: [],
    sourceRequiredItems: [sourceItem],
    sourceReadiness: {
      ...original.sourceReadiness,
      candidateCount: 1,
      repairReadyCount: 0,
      sourceRequiredCount: 1,
    },
  };
  const bodySha256 = walmartListingIntegrityCatalogSha256(body);
  const sourceOnlyPool: WalmartListingIntegrityControlledPool = {
    ...body,
    poolId: `controlled-pool-${bodySha256.slice(0, 20)}`,
    bodySha256,
  };
  const plan = buildWalmartListingIntegrityControlSeedPlan({
    pool: sourceOnlyPool,
    release_id_sha256: H("release"),
    manifest_sha256: H("release-manifest"),
    created_at: "2026-08-01T18:00:00.000Z",
  });
  verifyWalmartListingIntegrityControlSeedPlan(plan);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0]?.identity.listing_key, sourceItem.listingKey);
  assert.equal(plan.fences.walmart_writes_authorized, false);
});

test("seed plan rejects overlap with an external live predecessor", () => {
  assert.throws(
    () => buildWalmartListingIntegrityControlSeedPlan({
      pool: pool(),
      release_id_sha256: H("release"),
      manifest_sha256: H("release-manifest"),
      created_at: "2026-08-01T18:00:00.000Z",
      external_active_listing_keys: ["walmart:1:FaisalX-1144"],
    }),
    /overlaps external active predecessor: walmart:1:FaisalX-1144/,
  );
});

test("tampered queue plan fails closed", () => {
  const plan = buildWalmartListingIntegrityControlSeedPlan({
    pool: pool(),
    release_id_sha256: H("release"),
    manifest_sha256: H("release-manifest"),
    created_at: "2026-08-01T18:00:00.000Z",
  });
  const tampered = structuredClone(plan);
  tampered.items[0]!.identity.sku = "FaisalX-9999";
  assert.throws(
    () => verifyWalmartListingIntegrityControlSeedPlan(tampered),
    /seal or default-OFF policy differs/,
  );
});
