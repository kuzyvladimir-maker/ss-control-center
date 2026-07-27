import assert from "node:assert/strict";
import test from "node:test";

import {
  GET as getOperations,
  POST as postOperations,
} from "@/app/api/walmart/growth/listing-integrity/route";
import {
  GET as getGallery,
  POST as postGallery,
} from "@/app/api/walmart/growth/listing-integrity/gallery/[sku]/route";
import { POST as postLegacyReview } from "@/app/api/walmart/growth/remediation/review/route";

test("operations API is read-only and returns the sealed pool", async () => {
  const getResponse = await getOperations();
  assert.equal(getResponse.status, 200);
  const body = await getResponse.json();
  assert.equal(body.ok, true);
  assert.equal(body.operations.poolId, "controlled-pool-010609ed49f99760f5a4");
  assert.equal(body.operations.pool.length, 10);

  const postResponse = await postOperations();
  assert.equal(postResponse.status, 405);
  assert.equal((await postResponse.json()).error, "READ_ONLY_LISTING_INTEGRITY_API");
});

test("gallery route serves exact qualified bytes and rejects mutations", async () => {
  const response = await getGallery(
    new Request("http://localhost/api/walmart/growth/listing-integrity/gallery/FaisalX-1181"),
    { params: Promise.resolve({ sku: "FaisalX-1181" }) },
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-walmart-listing-integrity-sha256"),
    "12d63964bc1300ecfa184b31f06c63c70ae7f90ab579c7f56886bac68e336c19",
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
