import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDeliveryBy } from "../delivery-by";

// Veeqo encodes a date as end-of-day Pacific = next day 06:59:59Z.
const veeqo = (ymd: string) => {
  const d = new Date(`${ymd}T06:59:59Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
};

test("order #1371: Shopify dry, ship-by = due = today → no 'deliver today' filter, 10-day window", () => {
  const r = resolveDeliveryBy({
    dueDate: veeqo("2026-10-23"),
    dispatchDate: veeqo("2026-10-23"),
    shipDay: "2026-10-23",
    enforcedDeadline: false,
  });
  assert.deepEqual(r, { deliveryBy: "2026-11-02", source: "window" });
});

test("Shopify due date already in the past → still a window from today, not the past", () => {
  const r = resolveDeliveryBy({
    dueDate: veeqo("2026-10-20"),
    dispatchDate: veeqo("2026-10-20"),
    shipDay: "2026-10-23",
    enforcedDeadline: false,
  });
  assert.equal(r.deliveryBy, "2026-11-02");
});

test("non-Amazon due date AFTER the ship day is a real promise → kept", () => {
  const r = resolveDeliveryBy({
    dueDate: veeqo("2026-10-28"),
    dispatchDate: veeqo("2026-10-23"),
    shipDay: "2026-10-23",
    enforcedDeadline: false,
  });
  assert.deepEqual(r, { deliveryBy: "2026-10-28", source: "due_date" });
});

test("Amazon/Walmart due date is enforced as-is, even when it is today", () => {
  const r = resolveDeliveryBy({
    dueDate: veeqo("2026-10-23"),
    dispatchDate: veeqo("2026-10-21"),
    shipDay: "2026-10-23",
    enforcedDeadline: true,
  });
  assert.deepEqual(r, { deliveryBy: "2026-10-23", source: "due_date" });
});

test("no due date at all → dispatch + 10 (unchanged behaviour)", () => {
  const r = resolveDeliveryBy({
    dueDate: null,
    dispatchDate: veeqo("2026-10-25"),
    shipDay: "2026-10-23",
    enforcedDeadline: false,
  });
  assert.equal(r.deliveryBy, "2026-11-04");
});
