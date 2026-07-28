import assert from "node:assert/strict";
import test from "node:test";

import {
  loadListingIntegrityOperationsState,
  readListingIntegrityGallery,
} from "../listing-integrity-operations.server";
import {
  createListingIntegrityOperationsFixture,
} from "./listing-integrity-operations-fixture";

test("loads only exact-byte verified qualified cases and the latest sealed pool", async () => {
  const fixture = await createListingIntegrityOperationsFixture();
  const state = await loadListingIntegrityOperationsState(
    fixture.operationsRoot,
    fixture.completedRoot,
  );
  assert.equal(state.status, "READ_ONLY_POOL_READY");
  assert.equal(state.poolId, fixture.pool.poolId);
  assert.equal(state.completed.length, 3);
  assert.deepEqual(
    state.completed.map((entry) => entry.sku).sort(),
    ["FaisalX-1148", "FaisalX-1181", "FaisalX-1183"],
  );
  assert.equal(state.completed.every((entry) => (
    entry.qualification === "PASS"
    && entry.publishedAndActive
    && entry.indexingPreserved
    && entry.checksPassed >= 18
  )), true);
  assert.equal(state.sourceCandidateCount, 1204);
  assert.equal(state.repairReadyCount, 14);
  assert.equal(state.sourceRequiredCount, 1190);
  assert.equal(state.quarantinedCount, 1);
  assert.equal(state.quarantined[0]?.sku, "FaisalX-2768");
  assert.equal(state.quarantined[0]?.listingRepairComplete, false);
  assert.equal(state.quarantined[0]?.samePayloadReapplyAllowed, false);
  assert.equal(state.pool.length, 10);
  assert.equal(state.pool[0]?.sku, "FaisalX-1140");
  assert.equal(state.pool.every((entry) => entry.stage === "PRODUCT_TRUTH_READY"), true);
  assert.equal(state.sourceRequired.length, 10);
  assert.equal(state.sourceRequired[0]?.sku, "FaisalX-1220");
  assert.equal(state.sourceRequired.every((entry) => (
    entry.stage === "SOURCE_REQUIRED"
    && entry.productTruthBlockers.length > 0
  )), true);
  assert.equal(state.pool.some((entry) => (
    ["FaisalX-1148", "FaisalX-1181", "FaisalX-1183"].includes(entry.sku)
  )), false);
  assert.equal(state.pool.every((entry) => !entry.walmartWriteAuthorized), true);
  assert.equal(state.maxApplyInFlight, 1);
  assert.equal(state.walmartWritesAllowed, false);
  assert.equal(state.modelCallsAllowed, false);
});

test("serves only a final Qualification-bound gallery by exact SKU", async () => {
  const fixture = await createListingIntegrityOperationsFixture();
  const gallery = await readListingIntegrityGallery(
    "FaisalX-1181",
    fixture.completedRoot,
  );
  assert.ok(gallery);
  assert.equal(
    gallery.sha256,
    fixture.gallerySha256BySku.get("FaisalX-1181"),
  );
  assert.match(gallery.bytes.toString("utf8"), /FaisalX-1181 · фактическое ДО → ПОСЛЕ/);
  assert.equal(
    await readListingIntegrityGallery("../FaisalX-1181", fixture.completedRoot),
    null,
  );
  assert.equal(
    await readListingIntegrityGallery("unknown-sku", fixture.completedRoot),
    null,
  );
});
