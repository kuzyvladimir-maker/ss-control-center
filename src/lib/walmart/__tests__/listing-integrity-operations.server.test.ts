import assert from "node:assert/strict";
import test from "node:test";

import {
  loadListingIntegrityOperationsState,
  readListingIntegrityGallery,
} from "../listing-integrity-operations.server";

test("loads only exact-byte verified qualified cases and the latest sealed pool", async () => {
  const state = await loadListingIntegrityOperationsState();
  assert.equal(state.status, "READ_ONLY_POOL_READY");
  assert.equal(state.poolId, "controlled-pool-010609ed49f99760f5a4");
  assert.equal(state.completed.length, 3);
  assert.deepEqual(
    state.completed.map((entry) => entry.sku),
    ["FaisalX-1148", "FaisalX-1181", "FaisalX-1183"],
  );
  assert.equal(state.completed.every((entry) => (
    entry.qualification === "PASS"
    && entry.publishedAndActive
    && entry.indexingPreserved
    && entry.checksPassed >= 18
  )), true);
  assert.equal(state.sourceCandidateCount, 1391);
  assert.equal(state.repairReadyCount, 15);
  assert.equal(state.sourceRequiredCount, 1376);
  assert.equal(state.pool.length, 10);
  assert.equal(state.pool[0]?.sku, "FaisalX-2768");
  assert.equal(state.pool.every((entry) => entry.stage === "PRODUCT_TRUTH_READY"), true);
  assert.equal(state.sourceRequired.length, 10);
  assert.equal(state.sourceRequired[0]?.sku, "FaisalX-1633");
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
  const gallery = await readListingIntegrityGallery("FaisalX-1181");
  assert.ok(gallery);
  assert.equal(
    gallery.sha256,
    "12d63964bc1300ecfa184b31f06c63c70ae7f90ab579c7f56886bac68e336c19",
  );
  assert.match(gallery.bytes.toString("utf8"), /FaisalX-1181 · фактическое ДО → ПОСЛЕ/);
  assert.equal(await readListingIntegrityGallery("../FaisalX-1181"), null);
  assert.equal(await readListingIntegrityGallery("unknown-sku"), null);
});
