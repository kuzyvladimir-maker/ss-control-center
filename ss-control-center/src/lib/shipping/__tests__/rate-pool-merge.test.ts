import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeMissingRates } from "../rate-pool-merge";
import { applyBuyOverride, type OverridableItem } from "../buy-override";
import { matchLiveRate, type LiveRate } from "../requote-match";

// Order 114-2900934-1081853, 2026-11-20 19:45 ET. The "ship today" quote
// (preferred_shipment_date 16:00Z, already past) came back without FedEx;
// the allocation pool still had it. Trimmed to the relevant rows.
const quoted: LiveRate[] = [
  { name: "q-usps", sub_carrier_id: "USPS", title: "USPS Ground Advantage Cubic", total_net_charge: "10.41", delivery_promise_date: "2026-11-28T07:59:59Z" },
  { name: "q-ups2", sub_carrier_id: "UPS", title: "UPS 2nd Day Air®", total_net_charge: "49.51", delivery_promise_date: "2026-11-25T07:59:59Z" },
];
const pool: LiveRate[] = [
  { name: "p-usps", sub_carrier_id: "USPS", title: "USPS Ground Advantage Cubic", total_net_charge: "10.41", delivery_promise_date: "2026-11-29T07:59:59Z" },
  { name: "p-fx1r", sub_carrier_id: "FEDEX", title: "FedEx 2Day® One Rate", total_net_charge: "17.52", delivery_promise_date: "2026-11-25T07:59:59Z", carrier: "amazon_shipping_v2", service_carrier: "FEDEX", base_rate: "17.52" },
  { name: "p-ups2", sub_carrier_id: "UPS", title: "UPS 2nd Day Air ®", total_net_charge: "49.51", delivery_promise_date: "2026-11-25T07:59:59Z" },
  { name: "p-fxhd", sub_carrier_id: "FEDEX", title: "FedEx Home Delivery®", total_net_charge: "25.88", delivery_promise_date: "2026-12-01T07:59:59Z" },
];

test("the reported case: FedEx rates missing from the quote are appended from the pool", () => {
  const merged = mergeMissingRates(quoted, pool);
  const titles = merged.map((r) => r.title);
  assert.ok(titles.includes("FedEx 2Day® One Rate"));
  assert.ok(titles.includes("FedEx Home Delivery®"));
  assert.equal(merged.length, 4);
  assert.equal(merged.find((r) => r.title === "FedEx 2Day® One Rate")?.source, "allocation");
});

test("a service in both keeps the quote's row (date-anchored EDD), no duplicate", () => {
  const merged = mergeMissingRates(quoted, pool);
  const usps = merged.filter((r) => r.title === "USPS Ground Advantage Cubic");
  assert.equal(usps.length, 1);
  assert.equal(usps[0].name, "q-usps");
  // "UPS 2nd Day Air ®" vs "UPS 2nd Day Air®" is the same service.
  assert.equal(merged.filter((r) => String(r.sub_carrier_id) === "UPS").length, 1);
  assert.equal(merged[0], quoted[0]);
});

test("empty pool → quote unchanged; empty quote → whole pool", () => {
  assert.deepEqual(mergeMissingRates(quoted, []), quoted);
  assert.equal(mergeMissingRates([], pool).length, 4);
});

test("picking the appended One Rate buys through the allocation pool re-quote", () => {
  const picked = mergeMissingRates(quoted, pool).find((r) => r.title === "FedEx 2Day® One Rate")!;
  // A stopped item (no planned rate) rescued by the override, as on the card.
  const stopped: OverridableItem = {
    carrierId: null, remoteShipmentId: null, serviceType: null, subCarrierId: null,
    serviceCarrier: null, totalNetCharge: null, baseRate: null, carrier: null,
    service: null, price: null, edd: null, physicalShipDate: "2026-11-20", actualShipDay: "2026-11-20",
  };
  const item = applyBuyOverride(stopped, {
    carrier: String(picked.sub_carrier_id),
    service: String(picked.title),
    serviceType: String(picked.name),
    subCarrierId: String(picked.sub_carrier_id),
    serviceCarrier: String(picked.service_carrier),
    carrierId: String(picked.carrier),
    totalNetCharge: String(picked.total_net_charge),
    baseRate: String(picked.base_rate),
    price: 17.52,
    edd: "2026-11-24",
  });
  const m = matchLiveRate(pool, {
    serviceType: item.serviceType,
    service: item.service,
    subCarrierId: item.subCarrierId,
    price: item.price,
    edd: item.edd,
  });
  assert.equal(m.rate?.name, "p-fx1r");
});
