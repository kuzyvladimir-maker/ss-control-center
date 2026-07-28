import assert from "node:assert/strict";
import test from "node:test";

import {
  buildListingIntegrityOperationsResponse,
  POST as postOperations,
} from "@/app/api/walmart/growth/listing-integrity/route";
import {
  buildListingIntegrityGalleryResponse,
  POST as postGallery,
} from "@/app/api/walmart/growth/listing-integrity/gallery/[sku]/route";
import { POST as postLegacyReview } from "@/app/api/walmart/growth/remediation/review/route";
import {
  createListingIntegrityOperationsFixture,
} from "./listing-integrity-operations-fixture";
import {
  loadListingIntegrityOperationsState,
  readListingIntegrityGallery,
} from "../listing-integrity-operations.server";

test("operations API is read-only and returns the sealed pool", async () => {
  const fixture = await createListingIntegrityOperationsFixture();
  const getResponse = await buildListingIntegrityOperationsResponse(
    () => loadListingIntegrityOperationsState(
      fixture.operationsRoot,
      fixture.completedRoot,
    ),
  );
  assert.equal(getResponse.status, 200);
  const body = await getResponse.json();
  assert.equal(body.ok, true);
  assert.equal(body.operations.poolId, fixture.pool.poolId);
  assert.equal(body.operations.pool.length, 10);
  assert.equal(body.operations.quarantined[0]?.sku, "FaisalX-2768");

  const postResponse = await postOperations();
  assert.equal(postResponse.status, 405);
  assert.equal((await postResponse.json()).error, "READ_ONLY_LISTING_INTEGRITY_API");
});

test("gallery route serves exact qualified bytes and rejects mutations", async () => {
  const fixture = await createListingIntegrityOperationsFixture();
  const response = await buildListingIntegrityGalleryResponse(
    "FaisalX-1181",
    (sku) => readListingIntegrityGallery(sku, fixture.completedRoot),
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-walmart-listing-integrity-sha256"),
    fixture.gallerySha256BySku.get("FaisalX-1181"),
  );
  assert.match(await response.text(), /LIVE SURFACE PASS/);

  const postResponse = await postGallery();
  assert.equal(postResponse.status, 405);
});

test("legacy QC full A-to-Z requeue is retired", async () => {
  const response = await postLegacyReview();
  assert.equal(response.status, 410);
  const body = await response.json();
  assert.equal(body.retired, true);
  assert.equal(body.code, "LEGACY_WALMART_QC_REQUEUE_RETIRED");
});
