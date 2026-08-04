import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ListingIntegrityPanel } from "../ListingIntegrityPanel";
import { loadListingIntegrityShadowData } from "@/lib/walmart/listing-integrity-shadow.server";
import {
  createListingIntegrityOperationsFixture,
} from "@/lib/walmart/__tests__/listing-integrity-operations-fixture";

const ROOT = path.resolve(
  process.cwd(),
  "data/audits/walmart-listing-integrity-fresh-controls",
);
const OWNER_REVIEW_ROOT = path.resolve(
  process.cwd(),
  "data/audits/walmart-listing-integrity-single-calibration",
);

test("renders qualified canaries and the sealed controlled pool without mutation controls", async () => {
  const fixture = await createListingIntegrityOperationsFixture();
  const data = await loadListingIntegrityShadowData(
    ROOT,
    null,
    null,
    OWNER_REVIEW_ROOT,
    {
      operationsRoot: fixture.operationsRoot,
      completedRoot: fixture.completedRoot,
    },
  );
  data.catalog = {
    status: "CATALOG_PLAN_READY",
    capturedAt: "2026-07-28T12:00:00.000Z",
    catalogSyncedAt: "2026-07-28T06:00:01.809Z",
    censusId: "catalog-census-test",
    planId: "scan-plan-test",
    snapshotVerified: true,
    evidencePath: "immutable/catalog-test",
    censusFileSha256: "a".repeat(64),
    planFileSha256: "b".repeat(64),
    catalog: {
      total: 3566,
      published: 2644,
      active: 3471,
      withItemId: 3566,
      withTitle: 3566,
      exactOnce: true,
      duplicateSkus: 0,
    },
    queues: {
      visualTriageReady: 1298,
      sourceAcquisitionRequired: 1346,
      statusReview: 827,
      blockedSource: 92,
      doNotTouch: 3,
      deterministicConflicts: 17,
    },
    visualScan: {
      listings: 1298,
      tasks: 1738,
      partitions: 49,
      estimatedModelCallsMax: 293,
      capturedPartitions: 0,
      capturedAssets: 0,
      captureTechnicalErrors: 0,
      modelCallsCompleted: 0,
      walmartWrites: 0,
    },
    policy: {
      mode: "READ_ONLY_TRIAGE",
      imagesPerCallMax: 6,
      callsPerPartitionMax: 6,
      buyerVerifiedPassAllowed: false,
      walmartWritesAllowed: false,
    },
  };
  const html = renderToStaticMarkup(<ListingIntegrityPanel data={data} />);

  assert.match(html, /Standing Listing Integrity · supervised work/);
  assert.match(html, /Listing Integrity · production loop/);
  assert.match(html, /3 qualified/);
  assert.match(html, /10 repair-ready/);
  assert.match(html, /1190 source-required/);
  assert.match(html, /1 unresolved/);
  assert.match(html, /The closed loop is proven on 3 live SKUs/);
  assert.match(html, /FaisalX-1148/);
  assert.match(html, /FaisalX-1181/);
  assert.match(html, /FaisalX-1183/);
  assert.match(html, /18\/18 PASS/);
  assert.match(html, /20\/20 PASS/);
  assert.match(html, /Publication \/ indexing/);
  assert.match(html, /Open the actual BEFORE → AFTER gallery/);
  assert.match(
    html,
    /\/api\/walmart\/growth\/listing-integrity\/gallery\/FaisalX-1181/,
  );
  assert.match(html, /Product Truth-ready repair pool/);
  assert.match(html, /FaisalX-1140/);
  assert.match(html, /FaisalX-2768/);
  assert.match(html, /QUARANTINED · not repaired/);
  assert.match(html, /Content Ownership \/ Walmart Support/);
  assert.match(html, /FaisalX-1220/);
  assert.match(html, /Multipack audit/);
  assert.match(html, /SOURCE_REQUIRED/);
  assert.match(html, /1190 of 1204 candidates/);
  assert.match(html, /Write authority: false/);
  assert.match(html, new RegExp(fixture.pool.poolId));
  assert.match(html, /The current repair/);
  assert.match(html, /FaisalX-1228/);
  assert.match(html, /PACK OF 6/);
  assert.match(html, /EXACT_PRODUCT_DONOR/);
  assert.match(html, /Подтверждаю FaisalX-1228 и diff 4e81c7ca…6e58f/);
  assert.match(html, /The whole Walmart catalog/);
  assert.match(html, /3566\/3566 SKU/);
  assert.match(html, /1298/);
  assert.match(html, /1346/);
  assert.match(html, /827/);
  assert.match(html, /92/);
  assert.match(html, /1738/);
  assert.match(
    html,
    /Historical MAIN 1 → 6 control — evidence the detector works, not a current payload/,
  );
  assert.match(html, /FaisalX-1183/);
  assert.match(html, /Showing 1 pack out of 6/);
  assert.match(html, /All 6 packs are shown/);
  assert.match(html, /37\/37/);
  assert.match(html, /38\/38/);
  assert.match(html, /17\/17/);
  assert.match(html, /8\/8/);
  assert.match(html, /exact-byte custody verified/);
  assert.match(html, /Source-aware visual attestation/);
  assert.match(html, /Signed visual review complete/);
  assert.match(html, /proposed MAIN = PASS/);
  assert.match(html, /bad gallery images = 0/);
  assert.match(html, /The owner confirmed the manual review of the target MAIN and the gallery/);
  assert.match(html, /The owner approved the new MAIN and the extra images/);
  assert.match(html, /Owner visual review of target MAIN and gallery/);
  assert.match(html, /Owner approved/);
  assert.match(html, /not live yet/);
  assert.match(html, /Exact payload only/);
  assert.match(html, /Mass run locked/);
  assert.doesNotMatch(html, /method="post"/i);
  assert.doesNotMatch(html, /Publish now/i);
});
