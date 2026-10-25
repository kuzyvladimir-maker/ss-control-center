import { test } from "node:test";
import assert from "node:assert/strict";
import { transitFacts } from "../transit";

// Owner, topic 42, 2026-10-25 (Diana, 111-7501764-0683435): the tracking fact
// must always carry the delivery verdict + last scan + location + "delayed".

const DIANA = [
  { date: "2026-10-13", time: "10:00", description: "Shipping label created", status: "M", location: "Portland, OR" },
  { date: "2026-10-13", time: "18:30", description: "Picked up", status: "P", location: "Portland, OR" },
  { date: "2026-10-16", time: "08:00", description: "In transit", status: "I", location: "Portland, OR" },
  { date: "2026-10-18", time: "09:00", description: "Arrived at facility", status: "I", location: "Indianapolis, IN" },
  { date: "2026-10-21", time: "12:00", description: "Package delayed in transit", status: "I", location: "Pontiac, MI" },
  { date: "2026-10-24", time: "22:55", description: "Arrived at a carrier facility", status: "I", location: "Flint, MI" },
];

test("undelivered circling package: not delivered, delayed, last scan + location, days counting", () => {
  const now = new Date("2026-10-25T20:00:00Z");
  const tf = transitFacts(DIANA, now);
  assert.equal(tf.delivered, null, "not delivered");
  assert.equal(tf.delayed, true, "carrier delay flagged");
  assert.equal(tf.lastScan, "2026-10-24 22:55");
  assert.equal(tf.lastLocation, "Flint, MI");
  assert.match(tf.lastStatus || "", /carrier facility/i);
  assert.equal(tf.firstCarrierScan, "2026-10-13 18:30", "label-created is not the acceptance scan");
  assert.equal(tf.daysInTransit, 12, "13 Oct pickup → 25 Oct now ≈ 12 days");
  assert.equal(
    tf.route,
    "Portland, OR → Indianapolis, IN → Pontiac, MI → Flint, MI",
    "distinct hubs in order (label-created Portland collapsed)",
  );
  assert.ok(tf.scanCount >= 4, "counts the movement scans");
});

test("delivered package: delivered date + detail, transit hours", () => {
  const delivered = [
    { date: "2026-10-13", time: "14:06", description: "Picked up", status: "P", location: "Clearwater, FL" },
    { date: "2026-10-15", time: "15:34", description: "Delivered, Left at front door", status: "D", location: "Davison, MI" },
  ];
  const tf = transitFacts(delivered, new Date("2026-10-16T00:00:00Z"));
  assert.equal(tf.delivered, "2026-10-15 15:34");
  assert.equal(tf.delayed, false);
  assert.ok((tf.deliveryDetail || "").includes("Davison"));
  assert.equal(tf.transitHours, 49);
});

test("label only: no carrier scan, no days-in-transit, not delayed", () => {
  const tf = transitFacts(
    [{ date: "2026-10-13", time: "10:00", description: "Shipping label created", status: "M" }],
    new Date("2026-10-25T00:00:00Z"),
  );
  assert.equal(tf.firstCarrierScan, null);
  assert.equal(tf.daysInTransit, null);
  assert.equal(tf.delayed, false);
});
