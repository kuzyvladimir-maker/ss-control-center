import { test } from "node:test";
import assert from "node:assert/strict";
import { applyBuyOverride, type OverridableItem } from "../buy-override";
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
