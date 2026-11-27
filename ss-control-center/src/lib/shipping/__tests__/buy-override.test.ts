import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyBuyOverride,
  buildBuyOverrideWithDates,
  hasRateFields,
  retainFailedOrderKeys,
  retainFailedOverrides,
  type OverridableItem,
} from "../buy-override";
import { matchLiveRate, type LiveRate } from "../requote-match";

// Veeqo encodes an EDD as end-of-day Pacific = next day 06:59:59Z.
const eddIso = (ymd: string) => {
  const d = new Date(`${ymd}T06:59:59Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
};

// The algorithm's plan: UPS Ground at $6.74.
const planItem = (): OverridableItem & { id: string } => ({
  id: "item-1",
  carrierId: "c-ups",
  remoteShipmentId: null,
  serviceType: "algo-rate-id",
  subCarrierId: "UPS",
  serviceCarrier: "UPS",
  totalNetCharge: "6.74",
  baseRate: "6.74",
  carrier: "UPS",
  service: "UPS® Ground",
  price: 6.74,
  edd: "2026-11-26",
  physicalShipDate: "2026-11-21",
  actualShipDay: "2026-11-21",
  labelDate: "2026-11-21",
});

// Operator picked UPS 2nd Day Air® at $11.40 in PickRateDialog.
const override = {
  carrier: "UPS",
  service: "UPS 2nd Day Air®",
  serviceType: "picked-rate-id", // new-API id, never in the GET pool
  subCarrierId: "UPS",
  serviceCarrier: "UPS",
  carrierId: "c-ups",
  remoteShipmentId: null,
  totalNetCharge: "11.40",
  baseRate: "11.40",
  edd: "2026-11-24",
  price: 11.4,
};

// The planned service as the route builds it (`want`).
const wantOf = (item: OverridableItem) => ({
  serviceType: item.serviceType,
  service: item.service,
  subCarrierId: item.subCarrierId,
  price:
    item.price ??
    (Number.isFinite(parseFloat(item.totalNetCharge ?? ""))
      ? parseFloat(item.totalNetCharge!)
      : null),
  edd: item.edd,
});

const pool = (twoDayCharge: string): LiveRate[] => [
  { name: "g", sub_carrier_id: "UPS", title: "UPS® Ground", total_net_charge: "6.74", delivery_promise_date: eddIso("2026-11-26") },
  { name: "2da", sub_carrier_id: "UPS", title: "UPS 2nd Day Air®", total_net_charge: twoDayCharge, delivery_promise_date: eddIso("2026-11-24") },
];

test("override replaces price and edd, not just the service", () => {
  const item = applyBuyOverride(planItem(), override);
  assert.equal(item.price, 11.4);
  assert.equal(item.edd, "2026-11-24");
  assert.equal(item.service, "UPS 2nd Day Air®");
  assert.equal(item.id, "item-1");
});

test("override without price falls back to its totalNetCharge, never the plan's price", () => {
  const item = applyBuyOverride(planItem(), { ...override, price: null });
  assert.equal(item.price, 11.4);
});

test("override without price/charge/edd keeps the plan values", () => {
  const item = applyBuyOverride(planItem(), { physicalShipDate: "2026-11-23" });
  assert.equal(item.price, 6.74);
  assert.equal(item.edd, "2026-11-26");
  assert.equal(item.physicalShipDate, "2026-11-23");
  assert.equal(item.actualShipDay, "2026-11-23");
});

test("no override → item unchanged", () => {
  const raw = planItem();
  assert.equal(applyBuyOverride(raw, undefined), raw);
});

test("the reported case: override pricier than plan buys at live = override price", () => {
  const m = matchLiveRate(pool("11.40"), wantOf(applyBuyOverride(planItem(), override)));
  assert.equal(m.rate?.name, "2da");
});

test("live price within override + tolerance still buys", () => {
  // 11.40 + max($1, 5%) = 12.40
  const m = matchLiveRate(pool("12.30"), wantOf(applyBuyOverride(planItem(), override)));
  assert.equal(m.rate?.name, "2da");
});

test("live price above override + tolerance is refused", () => {
  const m = matchLiveRate(pool("12.60"), wantOf(applyBuyOverride(planItem(), override)));
  assert.equal(m.rate, null);
});

test("regression guard: with the plan's price the same live rate was refused", () => {
  const broken = { ...applyBuyOverride(planItem(), override), price: 6.74, edd: "2026-11-26" };
  const m = matchLiveRate(pool("11.40"), wantOf(broken));
  assert.equal(m.rate, null);
});

test("all failed buys keep their manual overrides", () => {
  const overrides = { a: "UPS Ground", b: "FedEx 2Day" };
  const orderNumbers = new Map([["a", "order-a"], ["b", "order-b"]]);

  assert.deepEqual(retainFailedOverrides(overrides, new Set(), orderNumbers), overrides);
});

test("a partial buy clears only the purchased order's override", () => {
  const overrides = { a: "UPS Ground", b: "FedEx 2Day" };
  const orderNumbers = new Map([["a", "order-a"], ["b", "order-b"]]);

  assert.deepEqual(
    retainFailedOverrides(overrides, new Set(["order-a"]), orderNumbers),
    { b: "FedEx 2Day" },
  );
  assert.deepEqual(overrides, { a: "UPS Ground", b: "FedEx 2Day" });
});

test("overrides outside the selection and without a known order number stay intact", () => {
  const overrides = { a: "UPS Ground", b: "FedEx 2Day", c: "USPS Ground Advantage" };
  const orderNumbers = new Map([["a", "order-a"], ["b", "order-b"]]);

  assert.deepEqual(
    retainFailedOverrides(overrides, new Set(["unrelated-order"]), orderNumbers),
    overrides,
  );
});

// ── Dual dates: Label date vs Physical ship date ─────────────────────────

test("labelDate overrides independently of physicalShipDate", () => {
  const item = applyBuyOverride(planItem(), { labelDate: "2026-11-20" });
  assert.equal(item.labelDate, "2026-11-20");
  // Ship day untouched → still the plan's, and the legacy alias follows it.
  assert.equal(item.physicalShipDate, "2026-11-21");
  assert.equal(item.actualShipDay, "2026-11-21");
});

test("both dates overridden: actualShipDay always mirrors physicalShipDate", () => {
  const item = applyBuyOverride(planItem(), {
    labelDate: "2026-11-21",
    physicalShipDate: "2026-11-24",
  });
  assert.equal(item.labelDate, "2026-11-21");
  assert.equal(item.physicalShipDate, "2026-11-24");
  assert.equal(item.actualShipDay, "2026-11-24");
});

test("a date-only override keeps every planned carrier/service/price field", () => {
  const raw = planItem();
  const item = applyBuyOverride(raw, {
    labelDate: "2026-11-20",
    physicalShipDate: "2026-11-23",
  });
  for (const k of [
    "carrierId",
    "remoteShipmentId",
    "serviceType",
    "subCarrierId",
    "serviceCarrier",
    "totalNetCharge",
    "baseRate",
    "carrier",
    "service",
    "price",
    "edd",
  ] as const) {
    assert.equal(item[k], raw[k], `${k} must stay the plan's`);
  }
});

test("no labelDate in the override keeps the plan's labelDate", () => {
  const item = applyBuyOverride(planItem(), override);
  assert.equal(item.labelDate, "2026-11-21");
});

test("buildBuyOverrideWithDates: nothing to override → undefined", () => {
  assert.equal(buildBuyOverrideWithDates(undefined, {}), undefined);
  assert.equal(buildBuyOverrideWithDates(null, { labelDate: "", physicalShipDate: null }), undefined);
  assert.equal(buildBuyOverrideWithDates(undefined, { labelDate: "  " }), undefined);
});

test("buildBuyOverrideWithDates: rate override alone passes through unchanged", () => {
  const merged = buildBuyOverrideWithDates(override, {});
  assert.deepEqual(merged, override);
  // Never mutates the stored override.
  assert.equal("labelDate" in override, false);
});

test("buildBuyOverrideWithDates: dates without a rate pick → date-only override", () => {
  assert.deepEqual(
    buildBuyOverrideWithDates(undefined, { labelDate: "2026-11-20" }),
    { labelDate: "2026-11-20" },
  );
  assert.deepEqual(
    buildBuyOverrideWithDates(undefined, { physicalShipDate: "2026-11-24" }),
    { physicalShipDate: "2026-11-24" },
  );
  const ov = buildBuyOverrideWithDates(undefined, {
    labelDate: "2026-11-20",
    physicalShipDate: "2026-11-24",
  });
  assert.equal(hasRateFields(ov), false);
  const item = applyBuyOverride(planItem(), ov);
  assert.equal(item.service, "UPS® Ground");
  assert.equal(item.labelDate, "2026-11-20");
  assert.equal(item.actualShipDay, "2026-11-24");
});

test("buildBuyOverrideWithDates: explicit manual dates win over the rate override's", () => {
  const rateOv = { ...override, labelDate: "2026-11-21", physicalShipDate: "2026-11-21" };
  const merged = buildBuyOverrideWithDates(rateOv, {
    labelDate: "2026-11-20",
    physicalShipDate: "2026-11-24",
  });
  assert.equal(merged?.labelDate, "2026-11-20");
  assert.equal(merged?.physicalShipDate, "2026-11-24");
  assert.equal(merged?.service, "UPS 2nd Day Air®");
  assert.equal(merged?.price, 11.4);
  assert.equal(hasRateFields(merged), true);
});

test("buildBuyOverrideWithDates: falls back to the rate override's dates", () => {
  const rateOv = { ...override, labelDate: "2026-11-21", physicalShipDate: "2026-11-24" };
  const merged = buildBuyOverrideWithDates(rateOv, { labelDate: undefined, physicalShipDate: "" });
  assert.equal(merged?.labelDate, "2026-11-21");
  assert.equal(merged?.physicalShipDate, "2026-11-24");
});

test("hasRateFields: only a real rate pick counts", () => {
  assert.equal(hasRateFields(undefined), false);
  assert.equal(hasRateFields(null), false);
  assert.equal(hasRateFields({ labelDate: "2026-11-20", physicalShipDate: "2026-11-24" }), false);
  assert.equal(hasRateFields(override), true);
});

test("retainFailedOrderKeys clears only the bought order numbers", () => {
  const dates = { "order-a": "2026-11-20", "order-b": "2026-11-24", "order-c": "2026-11-25" };
  assert.deepEqual(retainFailedOrderKeys(dates, new Set(["order-a", "order-c"])), {
    "order-b": "2026-11-24",
  });
  // Input untouched.
  assert.deepEqual(dates, { "order-a": "2026-11-20", "order-b": "2026-11-24", "order-c": "2026-11-25" });
});

test("retainFailedOrderKeys: nothing bought → same object; unrelated numbers → no change", () => {
  const dates = { "order-a": "2026-11-20" };
  assert.equal(retainFailedOrderKeys(dates, new Set()), dates);
  assert.deepEqual(retainFailedOrderKeys(dates, new Set(["order-z"])), dates);
});
