import { test } from "node:test";
import assert from "node:assert/strict";
import { normOrderNumber, normalizeSnapshotRates } from "../rate-snapshot";

test("Jackie's #1374 snapshot format → sorted, split carrier/service, Media Mail last", () => {
  const r = normalizeSnapshotRates([
    ["UPS Ground", 8.67, "2d"],
    ["FedEx Ground Economy", 6.98, "4-5d"],
    ["USPS Media Mail", 5.13, "media only"],
    ["USPS Ground Advantage", 7.58, "3d"],
  ]);
  assert.deepEqual(r.map((x) => `${x.carrier}|${x.service}|${x.price}|${x.transit}`), [
    "FedEx|Ground Economy|6.98|4-5d",
    "USPS|Ground Advantage|7.58|3d",
    "UPS|Ground|8.67|2d",
    "USPS|Media Mail|5.13|media only",
  ]);
});

test("object form and junk rows", () => {
  const r = normalizeSnapshotRates([
    { carrier: "UPS", service: "UPS Ground Saver", price: "8.23" },
    { service: "", price: 3 },
    ["Broken", "abc"],
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].price, 8.23);
  assert.equal(normalizeSnapshotRates("nope").length, 0);
});

test("order numbers match with or without #", () => {
  assert.equal(normOrderNumber("#1374"), "1374");
  assert.equal(normOrderNumber(" 1374 "), "1374");
});
