import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedDays } from "../temp-class/days-table";
import type { CoolerSize } from "../temp-class/ice";

// Convenience: run the table for a frozen line at moderate origin (A=20°C,
// ≤25 and ≥15 so neither the hot-origin nor the cold-A branch fires).
function frozen(size: CoolerSize, routeMaxC: number, originMaxC = 20) {
  const r = allowedDays({
    tempClass: "FROZEN",
    size,
    weather: { originMaxC, routeMaxC },
  });
  return { days: r.allowedDays, ice: r.extraIce };
}

test("FROZEN table — HOT route (M>20): 2 days, no extra ice, every size", () => {
  for (const s of ["XS", "S", "M", "L", "XL"] as CoolerSize[]) {
    assert.deepEqual(frozen(s, 25), { days: 2, ice: 0 }, `HOT ${s}`);
  }
});

test("FROZEN table — WARM route (10-20)", () => {
  assert.deepEqual(frozen("XS", 15), { days: 2, ice: 0 });
  assert.deepEqual(frozen("S", 15), { days: 2, ice: 0 });
  assert.deepEqual(frozen("M", 15), { days: 3, ice: 2 });
  assert.deepEqual(frozen("L", 15), { days: 3, ice: 1 });
  assert.deepEqual(frozen("XL", 15), { days: 3, ice: 4 });
});

test("FROZEN table — COOL route (0-10)", () => {
  assert.deepEqual(frozen("XS", 5), { days: 3, ice: 0 });
  assert.deepEqual(frozen("S", 5), { days: 3, ice: 0 });
  assert.deepEqual(frozen("M", 5), { days: 4, ice: 2 });
  assert.deepEqual(frozen("L", 5), { days: 3, ice: 0 });
  assert.deepEqual(frozen("XL", 5), { days: 4, ice: 4 });
});

test("FROZEN table — COLD route (-5..0), moderate origin (A≥15)", () => {
  assert.deepEqual(frozen("XS", -2), { days: 3, ice: 0 });
  assert.deepEqual(frozen("S", -2), { days: 3, ice: 0 });
  assert.deepEqual(frozen("M", -2), { days: 4, ice: 0 }); // 5 only when A<15
  assert.deepEqual(frozen("L", -2), { days: 4, ice: 0 });
  assert.deepEqual(frozen("XL", -2), { days: 5, ice: 4 });
});

test("FROZEN COLD — M reaches 5 days with ice only when Clearwater is also cold (A<15)", () => {
  assert.deepEqual(frozen("M", -2, 10), { days: 5, ice: 2 }); // A=10 <15
  assert.deepEqual(frozen("M", -2, 20), { days: 4, ice: 0 }); // A=20 → no-ice fallback
});

test("FROZEN FRIGID route (<-5) mirrors COLD", () => {
  assert.deepEqual(frozen("XL", -10), { days: 5, ice: 4 });
  assert.deepEqual(frozen("M", -10, 10), { days: 5, ice: 2 });
  assert.deepEqual(frozen("L", -10), { days: 4, ice: 0 });
});

test("hot Clearwater (A>25) caps the window: 2 days when M>10, else 3", () => {
  // WARM route (M=15) but hot origin → cap 2
  assert.deepEqual(frozen("XL", 15, 30), { days: 2, ice: 0 });
  // COOL route (M=5) hot origin → cap 3
  assert.deepEqual(frozen("XL", 5, 30), { days: 3, ice: 0 });
  assert.deepEqual(frozen("M", 5, 30), { days: 3, ice: 0 });
});

test("XS/S hard cap of 3 days", () => {
  // Chilled would push XS to 4 in COOL (3+1), capped back to 3.
  const r = allowedDays({
    tempClass: "CHILLED",
    size: "XS",
    weather: { originMaxC: 10, routeMaxC: 5 },
  });
  assert.equal(r.allowedDays, 3);
});

test("prior-incident SKU gets one day less", () => {
  const base = allowedDays({
    tempClass: "FROZEN",
    size: "XL",
    weather: { originMaxC: 20, routeMaxC: 5 },
  });
  assert.equal(base.allowedDays, 4);
  const incident = allowedDays({
    tempClass: "FROZEN",
    size: "XL",
    weather: { originMaxC: 20, routeMaxC: 5 },
    hasIncident: true,
  });
  assert.equal(incident.allowedDays, 3);
});

test("CHILLED = frozen +1 day, capped at 5", () => {
  // COOL M: frozen 4 → chilled 5 (cap)
  const m = allowedDays({
    tempClass: "CHILLED",
    size: "M",
    weather: { originMaxC: 20, routeMaxC: 5 },
  });
  assert.equal(m.allowedDays, 5);
  // COLD XL: frozen 5 → chilled would be 6 but capped at 5
  const xl = allowedDays({
    tempClass: "CHILLED",
    size: "XL",
    weather: { originMaxC: 20, routeMaxC: -2 },
  });
  assert.equal(xl.allowedDays, 5);
});

test("CHILLED heat (M>20): 3 days with +1 ice; a cooler that can't take ice → 2 days", () => {
  const m = allowedDays({
    tempClass: "CHILLED",
    size: "M",
    weather: { originMaxC: 24, routeMaxC: 25 },
  });
  assert.deepEqual({ d: m.allowedDays, ice: m.extraIce }, { d: 3, ice: 1 });
  // XS has zero extra-ice capacity → "unavailable ice → cell without ice" → 2 days
  const xs = allowedDays({
    tempClass: "CHILLED",
    size: "XS",
    weather: { originMaxC: 24, routeMaxC: 25 },
  });
  assert.deepEqual({ d: xs.allowedDays, ice: xs.extraIce }, { d: 2, ice: 0 });
});

test("CHILLED extreme heat (A>30 AND M>25): 2 days", () => {
  const r = allowedDays({
    tempClass: "CHILLED",
    size: "M",
    weather: { originMaxC: 35, routeMaxC: 28 },
  });
  assert.equal(r.allowedDays, 2);
});

test("DRY — no cold-chain cap, no ice", () => {
  const r = allowedDays({
    tempClass: "DRY",
    size: "M",
    weather: { originMaxC: 35, routeMaxC: 35 },
  });
  assert.equal(r.allowedDays, Infinity);
  assert.equal(r.extraIce, 0);
});

test("no forecast → NaN (caller falls back to summer)", () => {
  assert.ok(
    Number.isNaN(
      allowedDays({
        tempClass: "FROZEN",
        size: "M",
        weather: { originMaxC: null, routeMaxC: 5 },
      }).allowedDays,
    ),
  );
  assert.ok(
    Number.isNaN(
      allowedDays({
        tempClass: "FROZEN",
        size: "M",
        weather: { originMaxC: 20, routeMaxC: null },
      }).allowedDays,
    ),
  );
});
