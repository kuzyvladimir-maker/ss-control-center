/**
 * These rules decide whether unattended marketplace writes happen at all.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateFactoryRails,
  ERROR_RATE_MIN_SAMPLE,
  UPC_POOL_FLOOR,
} from "../walmart-factory-rails";

const HEALTHY = {
  paused: false,
  recentPublished: 20,
  recentRefused: 1,
  freeUpcs: 4_000,
};

test("a healthy factory runs", () => {
  const verdict = evaluateFactoryRails(HEALTHY);
  assert.equal(verdict.allowed, true);
  assert.deepEqual(verdict.blocks, []);
});

test("a pause stops it whatever else is true", () => {
  const verdict = evaluateFactoryRails({ ...HEALTHY, paused: true });
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.blocks, ["PAUSED"]);
});

test("half the submissions refused stops the schedule", () => {
  const verdict = evaluateFactoryRails({
    ...HEALTHY,
    recentPublished: 5,
    recentRefused: 5,
  });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.blocks.includes("ERROR_RATE"));
  assert.match(verdict.reasons.join(" "), /50%/);
});

test("a bad run too small to mean anything does not stop it", () => {
  // Two refusals out of two is 100% and still proves nothing.
  const verdict = evaluateFactoryRails({
    ...HEALTHY,
    recentPublished: 0,
    recentRefused: ERROR_RATE_MIN_SAMPLE - 1,
  });
  assert.equal(verdict.allowed, true);
});

test("the last product IDs are not spent unattended", () => {
  const verdict = evaluateFactoryRails({ ...HEALTHY, freeUpcs: UPC_POOL_FLOOR - 1 });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.blocks.includes("UPC_POOL_FLOOR"));
});

test("every block that applies is reported, not just the first", () => {
  const verdict = evaluateFactoryRails({
    paused: true,
    recentPublished: 1,
    recentRefused: 9,
    freeUpcs: 0,
  });
  assert.deepEqual(verdict.blocks, ["PAUSED", "ERROR_RATE", "UPC_POOL_FLOOR"]);
  assert.equal(verdict.reasons.length, 3);
});

test("a quiet window with no outcomes at all is not a failure", () => {
  const verdict = evaluateFactoryRails({
    ...HEALTHY,
    recentPublished: 0,
    recentRefused: 0,
  });
  assert.equal(verdict.allowed, true);
});
