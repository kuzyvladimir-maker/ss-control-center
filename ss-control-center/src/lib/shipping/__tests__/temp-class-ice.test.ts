import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIcePlan,
  canFitExtraIce,
  coolerSizeFromBox,
  ICE_BASE,
  ICE_EXTRA_CAPACITY,
  iceExtraFromNotes,
  iceMarker,
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

test("coolerSizeFromBox: named coolers, and small custom boxes map to the cooler they fit", () => {
  assert.equal(coolerSizeFromBox("XL"), "XL");
  assert.equal(coolerSizeFromBox("m"), "M");
  assert.equal(coolerSizeFromBox("7×7×6"), "XS"); // fits inside XS (11×6×8)
  assert.equal(coolerSizeFromBox(null), null);
});

test("ice marker round-trips through plan notes; absent → 0", () => {
  const notes = `live: [temp-rate] picked UPS Ground 4d ${iceMarker(4)} | other`;
  assert.equal(iceExtraFromNotes(notes), 4);
  assert.equal(iceMarker(0), "");
  assert.equal(iceExtraFromNotes("today: [frozen-rate v3.5] picked FedEx"), 0);
  assert.equal(iceExtraFromNotes(null), 0);
});

test("cooler from DIMENSIONS (the 'engine not run' bug): presets in any orientation, others → smallest cooler that fits", () => {
  assert.equal(coolerSizeFromBox("11x6x8"), "XS");
  assert.equal(coolerSizeFromBox("11x8x6"), "XS");
  assert.equal(coolerSizeFromBox("12x12x10"), "S");
  assert.equal(coolerSizeFromBox("10x12x12"), "S");
  assert.equal(coolerSizeFromBox("13x13x15"), "M");
  assert.equal(coolerSizeFromBox("18×13×14"), "L");
  assert.equal(coolerSizeFromBox("24x13x16"), "XL");
  assert.equal(coolerSizeFromBox("12x12x6"), "S"); // fits inside S
  assert.equal(coolerSizeFromBox("10x8x8"), "S");
  assert.equal(coolerSizeFromBox("30x30x30"), null); // bigger than XL
  assert.equal(coolerSizeFromBox("M"), "M");
  assert.equal(coolerSizeFromBox(""), null);
});
