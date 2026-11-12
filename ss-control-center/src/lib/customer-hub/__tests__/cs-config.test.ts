import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_CS_STORES,
  ALL_CS_STORES,
  BLOCKED_CS_STORES,
  isActiveCsStore,
  assertActiveCsStore,
} from "../config";

// Owner, topic 42, 2026-11-04: only store 1 is live; stores 2-5 are blocked by
// Amazon. One config list drives every CS path; add an index back to re-enable.

test("only store 1 is active; 2-5 are blocked", () => {
  assert.deepEqual(ACTIVE_CS_STORES, [1]);
  assert.deepEqual(BLOCKED_CS_STORES, [2, 3, 4, 5]);
});

test("active and blocked partition the full store set with no overlap", () => {
  const union = [...ACTIVE_CS_STORES, ...BLOCKED_CS_STORES].sort((a, b) => a - b);
  assert.deepEqual(union, ALL_CS_STORES);
  for (const s of ACTIVE_CS_STORES) assert.ok(!BLOCKED_CS_STORES.includes(s));
});

test("isActiveCsStore / assertActiveCsStore gate on the active list", () => {
  assert.equal(isActiveCsStore(1), true);
  assert.equal(isActiveCsStore(3), false);
  assert.doesNotThrow(() => assertActiveCsStore(1));
  for (const s of BLOCKED_CS_STORES) assert.throws(() => assertActiveCsStore(s));
});
