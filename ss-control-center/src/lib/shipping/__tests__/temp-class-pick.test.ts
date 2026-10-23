import { test } from "node:test";
import assert from "node:assert/strict";
import type { VeeqoRate } from "../rate-selection";
import { selectTempAwareRate, isNextDay } from "../temp-class/pick-rate";
import { buildShadowResult } from "../temp-class/shadow";

const SHIP = "2026-10-23";
// 20:00Z = 13:00 PDT, so the PT calendar date equals the ymd we encode.
const edd = (ymd: string) => `${ymd}T20:00:00Z`;

function rate(p: {
  title: string;
  price: number;
  eddYmd: string;
  name?: string;
}): VeeqoRate {
  return {
    carrier: "amazon_shipping_v2",
    name: p.name ?? `amazon_shipping_v2-${p.title}`,
    title: p.title,
    short_title: p.title,
    total_net_charge: p.price.toFixed(2),
    base_rate: p.price.toFixed(2),
    delivery_promise_date: edd(p.eddYmd),
    sub_carrier_id: p.title.toUpperCase().includes("FEDEX") ? "FEDEX" : "UPS",
    service_carrier: "ups",
    remote_shipment_id: "rs-1",
    service_id: "svc-1",
  };
}

const DEADLINE = "2026-11-01"; // comfortably far — the cold-chain cap is the gate

test("isNextDay flags overnight services", () => {
  assert.ok(isNextDay({ title: "UPS Next Day Air", name: "" }));
  assert.ok(isNextDay({ title: "FedEx Priority Overnight", name: "" }));
  assert.ok(!isNextDay({ title: "UPS Ground", name: "" }));
});

test("FROZEN XL / COOL (cap 4): takes cheapest Ground, excludes Next Day", () => {
  const rates = [
    rate({ title: "UPS Ground", price: 14, eddYmd: "2026-10-27" }), // 4d
    rate({ title: "FedEx 2Day", price: 30, eddYmd: "2026-10-25" }), // 2d
    rate({ title: "UPS Next Day Air", price: 80, eddYmd: "2026-10-24" }), // 1d
  ];
  const sel = selectTempAwareRate({
    rates,
    tempClass: "FROZEN",
    size: "XL",
    deliveryBy: DEADLINE,
    shipDay: SHIP,
    weather: { originMaxC: 20, routeMaxC: 5 },
  });
  assert.equal(sel.allowedDays, 4);
  assert.equal(sel.extraIce, 4);
  assert.equal(sel.rate?.title, "UPS Ground");
  assert.equal(sel.rate?.price, 14);
});

test("speed premium: $1 default picks a faster near-equal rate", () => {
  const rates = [
    rate({ title: "UPS Ground", price: 14, eddYmd: "2026-10-26" }), // 3d
    rate({ title: "UPS 3 Day Select", price: 14.5, eddYmd: "2026-10-25" }), // 2d, +$0.50
  ];
  const sel = selectTempAwareRate({
    rates,
    tempClass: "FROZEN",
    size: "XL",
    deliveryBy: DEADLINE,
    shipDay: SHIP,
    weather: { originMaxC: 20, routeMaxC: 5 }, // cool, tol = $1
  });
  assert.equal(sel.rate?.calDays, 2); // faster wins within $1
});

test("speed premium: a $2.50 faster rate is NOT taken when cool ($1 tol) but IS when hot ($3 tol)", () => {
  const rates = [
    rate({ title: "UPS Ground", price: 14, eddYmd: "2026-10-25" }), // 2d
    rate({ title: "FedEx 2Day", price: 16.5, eddYmd: "2026-10-24" }), // 1d, +$2.50
  ];
  const cool = selectTempAwareRate({
    rates,
    tempClass: "FROZEN",
    size: "M",
    deliveryBy: DEADLINE,
    shipDay: SHIP,
    weather: { originMaxC: 20, routeMaxC: 5 }, // tol $1
  });
  assert.equal(cool.rate?.price, 14); // stays cheapest

  const hot = selectTempAwareRate({
    rates,
    tempClass: "FROZEN",
    size: "M",
    deliveryBy: DEADLINE,
    shipDay: SHIP,
    weather: { originMaxC: 24, routeMaxC: 25 }, // M>20 → tol $3 (cap 2 days)
  });
  assert.equal(hot.rate?.calDays, 1); // faster within $3
});

test("cold-chain cap can empty the pool → null", () => {
  const rates = [rate({ title: "UPS Ground", price: 10, eddYmd: "2026-10-27" })]; // 4d
  const sel = selectTempAwareRate({
    rates,
    tempClass: "FROZEN",
    size: "XS", // HOT cap would be 2; here COOL cap 3
    deliveryBy: DEADLINE,
    shipDay: SHIP,
    weather: { originMaxC: 20, routeMaxC: 5 }, // XS cap 3; 4d rate excluded
  });
  assert.equal(sel.rate, null);
  assert.equal(sel.noForecast, false);
});

test("only a Next Day rate available → null (never auto-bought)", () => {
  const rates = [rate({ title: "UPS Next Day Air", price: 80, eddYmd: "2026-10-24" })];
  const sel = selectTempAwareRate({
    rates,
    tempClass: "FROZEN",
    size: "M",
    deliveryBy: DEADLINE,
    shipDay: SHIP,
    weather: { originMaxC: 20, routeMaxC: 5 },
  });
  assert.equal(sel.rate, null);
});

test("DRY takes the cheapest on-time rate regardless of transit days", () => {
  const rates = [
    rate({ title: "UPS Ground", price: 8, eddYmd: "2026-10-30" }), // 7d
    rate({ title: "FedEx 2Day", price: 25, eddYmd: "2026-10-25" }), // 2d
  ];
  const sel = selectTempAwareRate({
    rates,
    tempClass: "DRY",
    size: "M",
    deliveryBy: DEADLINE,
    shipDay: SHIP,
    weather: { originMaxC: 30, routeMaxC: 30 },
  });
  assert.equal(sel.rate?.price, 8);
  assert.equal(sel.allowedDays, Infinity);
});

test("no forecast → noForecast=true, no pick (caller uses summer)", () => {
  const rates = [rate({ title: "UPS Ground", price: 10, eddYmd: "2026-10-25" })];
  const sel = selectTempAwareRate({
    rates,
    tempClass: "FROZEN",
    size: "M",
    deliveryBy: DEADLINE,
    shipDay: SHIP,
    weather: { originMaxC: null, routeMaxC: null },
  });
  assert.equal(sel.noForecast, true);
  assert.equal(sel.rate, null);
});

test("buildShadowResult: savings vs summer, ice note, longer-transit prices", () => {
  const rates = [
    rate({ title: "UPS Ground", price: 14, eddYmd: "2026-10-27" }), // 4d
    rate({ title: "FedEx 2Day", price: 32, eddYmd: "2026-10-25" }), // 2d (summer pick)
  ];
  const summerRate = rates[1]; // summer capped at 3d → bought the $32 2Day
  const shadow = buildShadowResult({
    rates,
    tempClass: "FROZEN",
    size: "XL",
    deliveryBy: DEADLINE,
    shipDay: SHIP,
    weather: { originMaxC: 20, routeMaxC: 5 }, // cap 4 → Ground 4d becomes legal
    summerRate,
  });
  assert.equal(shadow.pick?.price, 14);
  assert.equal(shadow.summerPrice, 32);
  assert.equal(shadow.savingsUsd, 18);
  assert.equal(shadow.iceTotal, 23); // 19 base + 4 extra
  assert.match(shadow.iceNote, /XL cooler/);
  // 4-day price is surfaced (summer never quoted it)
  assert.ok(shadow.longerTransitPrices.some((p) => p.calDays === 4 && p.price === 14));
});
