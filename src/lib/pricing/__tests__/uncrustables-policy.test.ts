import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyReprice,
  classifyCanonicalBase,
  parsePricingSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
} from "../uncrustables";
import { blockLegacyUncrustablesPriceMutation } from "../uncrustables-policy";

test("canonical base classification treats any direct price drift as a mismatch", () => {
  assert.equal(classifyCanonicalBase(76.99, 76.99), "OK");
  assert.equal(classifyCanonicalBase(77, 76.99), "HIGH");
  assert.equal(classifyCanonicalBase(66.95, 76.99), "LOW");
  assert.equal(classifyCanonicalBase(null, 76.99), "UNKNOWN");
});

test("legacy Uncrustables applyReprice is permanently non-mutating", async () => {
  const result = await applyReprice(1, "TEST-SKU", 66.95);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /disabled|locked/i);
});

test("legacy standalone price writers are blocked before side effects", () => {
  assert.throws(
    () => blockLegacyUncrustablesPriceMutation("test-script"),
    /DISABLED test-script.*coupon-only/i,
  );
});

test("legacy pricing cache is rejected instead of restoring stale targets", () => {
  assert.equal(parsePricingSnapshot(JSON.stringify({ updatedAt: "2026-01-01", rows: [] })), null);
  const current = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    updatedAt: "2026-07-18T00:00:00.000Z",
    stores: [1],
    counts: { total: 0, high: 0, low: 0, ok: 0, unknown: 0 },
    rows: [],
  };
  assert.deepEqual(parsePricingSnapshot(JSON.stringify(current)), current);
});
