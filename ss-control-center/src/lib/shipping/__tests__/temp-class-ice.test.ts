import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIcePlan,
  canFitExtraIce,
  coolerSizeFromBox,
  ICE_BASE,
  ICE_EXTRA_CAPACITY,
} from "../temp-class/ice";

test("ice bases match the owner's numbers", () => {
  assert.deepEqual(ICE_BASE, { XS: 3, S: 5, M: 9, L: 11, XL: 19 });
});

test("extra-ice capacity matches the owner's numbers (steps cancelled)", () => {
  assert.deepEqual(ICE_EXTRA_CAPACITY, { XS: 0, S: 0, M: 2, L: 1, XL: 4 });
});

test("buildIcePlan totals, weight delta (+1 lb/piece) and cost ($0.10/piece)", () => {
  const xl = buildIcePlan("XL", 4);
  assert.deepEqual(
    { total: xl.total, w: xl.weightDeltaLb, c: xl.extraCostUsd },
    { total: 23, w: 4, c: 0.4 },
  );
  const m = buildIcePlan("M", 2);
  assert.deepEqual({ total: m.total, w: m.weightDeltaLb }, { total: 11, w: 2 });
});

test("buildIcePlan clamps extra to what fits (defence-in-depth)", () => {
  // Asking for 5 extra on an S (capacity 0) → clamped to 0.
  const s = buildIcePlan("S", 5);
  assert.equal(s.extra, 0);
  assert.equal(s.total, ICE_BASE.S);
});

test("canFitExtraIce honours capacity", () => {
  assert.ok(canFitExtraIce("XL", 4));
  assert.ok(!canFitExtraIce("XL", 5));
  assert.ok(!canFitExtraIce("XS", 1));
});

test("coolerSizeFromBox recognises named coolers only", () => {
  assert.equal(coolerSizeFromBox("XL"), "XL");
  assert.equal(coolerSizeFromBox("m"), "M");
  assert.equal(coolerSizeFromBox("7×7×6"), null);
  assert.equal(coolerSizeFromBox(null), null);
});
