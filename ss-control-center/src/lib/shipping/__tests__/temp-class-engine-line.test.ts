import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEngineLine } from "../temp-class/engine-line";

const base = {
  originMaxC: 28.4,
  routeMaxC: 9.2,
  allowedDays: 3,
  extraIce: 0,
  noForecast: false,
  destCity: "Columbus",
  destState: "WI",
  destMaxC: 4.1,
};

test("frozen with forecast: origin → destination, route max, class, day cap", () => {
  assert.deepEqual(formatEngineLine({ tempClass: "FROZEN", shadow: base }), {
    text: "Clearwater 28°C → Columbus, WI 4°C · route max 9°C · Frozen · max 3 days",
    mode: "rules",
  });
});

test("extra ice is shown; route max hidden when it equals the destination", () => {
  const r = formatEngineLine({
    tempClass: "CHILLED",
    shadow: { ...base, routeMaxC: 4.4, allowedDays: 4, extraIce: 2 },
  });
  assert.equal(r?.text, "Clearwater 28°C → Columbus, WI 4°C · Chilled · max 4 days · +2 ice");
});

test("no forecast → explicit summer rules", () => {
  assert.deepEqual(
    formatEngineLine({ tempClass: "FROZEN", shadow: { ...base, noForecast: true } }),
    { text: "Frozen · no forecast — summer rules", mode: "summer" },
  );
});

test("cold order the engine could not run on → summer rules, not silence", () => {
  assert.equal(formatEngineLine({ tempClass: "FROZEN", shadow: null })?.mode, "summer");
});

test("dry → no temperature limit; engine off → nothing", () => {
  assert.equal(formatEngineLine({ tempClass: "DRY" })?.text, "Dry · no temperature limit · cheapest rate");
  assert.equal(formatEngineLine({ tempClass: null }), null);
});

test("unknown city / temps degrade readably", () => {
  const r = formatEngineLine({
    tempClass: "FROZEN",
    shadow: { ...base, destCity: null, destState: null, destMaxC: null, originMaxC: null },
  });
  assert.equal(r?.text, "Clearwater ?°C → destination ?°C · route max 9°C · Frozen · max 3 days");
});
