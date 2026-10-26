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

test("no speed premium: the cheapest rate inside the limit wins, faster only on a price tie", () => {
  const rates = [
    rate({ title: "UPS Ground", price: 14, eddYmd: "2026-10-26" }), // 3d
    rate({ title: "UPS 3 Day Select", price: 14.5, eddYmd: "2026-10-25" }), // 2d, +$0.50
  ];
  const sel = selectTempAwareRate({
    rates, tempClass: "FROZEN", size: "XL", deliveryBy: DEADLINE, shipDay: SHIP,
    weather: { originMaxC: 20, routeMaxC: 5 },
  });
  assert.equal(sel.rate?.title, "UPS Ground"); // cheapest, not the faster one
  const tie = selectTempAwareRate({
    rates: [
      rate({ title: "UPS Ground", price: 14, eddYmd: "2026-10-26" }), // 3d
      rate({ title: "FedEx Home", price: 14, eddYmd: "2026-10-25" }), // 2d, same price
    ],
    tempClass: "FROZEN", size: "XL", deliveryBy: DEADLINE, shipDay: SHIP,
    weather: { originMaxC: 20, routeMaxC: 5 },
  });
  assert.equal(tie.rate?.calDays, 2);
});

test("owner's Freshpet case: hot route, 3-day limit → the $10.48 3-day rate, not the $13.18 2-day Ground", () => {
  const mon = "2026-10-26";
  const rates = [
    rate({ title: "UPS Ground", price: 13.18, eddYmd: "2026-10-28" }), // 2d
    rate({ title: "UPS Ground Saver", price: 10.48, eddYmd: "2026-10-29" }), // 3d
    rate({ title: "FedEx Home Delivery", price: 15.2, eddYmd: "2026-10-30" }), // 4d — over the limit
  ];
  const sel = selectTempAwareRate({
    rates, tempClass: "FROZEN", size: "XS", deliveryBy: "2026-10-30", shipDay: mon,
    weather: { originMaxC: 28, routeMaxC: 28 }, summerCapDays: 3,
  });
  assert.equal(sel.allowedDays, 3);
  assert.equal(sel.rate?.title, "UPS Ground Saver");
  assert.equal(sel.rate?.price, 10.48);
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

test("Thu ship, UPS Ground arrives Mon (4 calendar days over the weekend): allowed when the table allows 4", () => {
  const thu = "2026-10-29";
  const rates = [
    rate({ title: "FedEx 2Day", price: 32.61, eddYmd: "2026-10-31" }), // Sat, 2d
    rate({ title: "UPS Ground", price: 13.18, eddYmd: "2026-11-02" }), // Mon, 4d
  ];
  // Cold route (−2°C), Clearwater 20°C, M cooler → table: 4 days.
  const cold = selectTempAwareRate({
    rates, tempClass: "FROZEN", size: "M", deliveryBy: "2026-11-05", shipDay: thu,
    weather: { originMaxC: 20, routeMaxC: -2 },
  });
  assert.equal(cold.allowedDays, 4);
  assert.equal(cold.rate?.title, "UPS Ground"); // the weekend inside the window does not drop it
  // Warm route (24°C) → table: 2 days → Ground is (correctly) not allowed.
  const warm = selectTempAwareRate({
    rates, tempClass: "FROZEN", size: "M", deliveryBy: "2026-11-05", shipDay: thu,
    weather: { originMaxC: 20, routeMaxC: 24 },
  });
  assert.equal(warm.rate?.title, "FedEx 2Day");
});

test("summer floor: hot weather (Clearwater 28°C, route 24°C) never makes Live stricter than summer's 3 days", () => {
  const mon = "2026-10-26";
  const rates = [
    rate({ title: "FedEx 2Day", price: 40.33, eddYmd: "2026-10-28" }), // 2d
    rate({ title: "UPS Ground", price: 18.12, eddYmd: "2026-10-29" }), // 3d
  ];
  const hot = { originMaxC: 28, routeMaxC: 24 };
  // Table alone says 2 days → the pricey 2Day (the +$22.21 case).
  const tableOnly = selectTempAwareRate({ rates, tempClass: "FROZEN", size: "M", deliveryBy: DEADLINE, shipDay: mon, weather: hot });
  assert.equal(tableOnly.rate?.title, "FedEx 2Day");
  // With the summer cap (3, no heat alert) → the same 3-day Ground summer buys.
  const floored = selectTempAwareRate({ rates, tempClass: "FROZEN", size: "M", deliveryBy: DEADLINE, shipDay: mon, weather: hot, summerCapDays: 3 });
  assert.equal(floored.allowedDays, 3);
  assert.equal(floored.rate?.title, "UPS Ground");
  assert.match(floored.reasonRu ?? "", /как летом: 3 дн\./);
  // A Frozen Analytics heat alert (summer cap 2) still keeps it at 2.
  const alert = selectTempAwareRate({ rates, tempClass: "FROZEN", size: "M", deliveryBy: DEADLINE, shipDay: mon, weather: hot, summerCapDays: 2 });
  assert.equal(alert.rate?.title, "FedEx 2Day");
  // The table can still ADD days above summer in the cold.
  const cold = selectTempAwareRate({ rates, tempClass: "FROZEN", size: "M", deliveryBy: DEADLINE, shipDay: mon, weather: { originMaxC: 20, routeMaxC: -2 }, summerCapDays: 3 });
  assert.equal(cold.allowedDays, 4);
});
