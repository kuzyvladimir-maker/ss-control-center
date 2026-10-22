import { test } from "node:test";
import assert from "node:assert/strict";
import { baseTitle, matchLiveRate, maxAcceptablePrice, type LiveRate } from "../requote-match";

// Veeqo encodes an EDD as end-of-day Pacific = next day 06:59:59Z.
const eddIso = (ymd: string) => {
  const d = new Date(`${ymd}T06:59:59Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
};
const rate = (i: number, o: Partial<LiveRate> & { edd?: string }): LiveRate => ({
  name: `live-${i}`,
  sub_carrier_id: "UPS",
  title: `Filler service ${i}`,
  total_net_charge: String(30 + i),
  remote_shipment_id: "prb-same-for-all",
  delivery_promise_date: eddIso(o.edd ?? "2026-10-28"),
  ...o,
});

// The live pool of order 111-5099040-5027461 as the buy saw it: 23 rates, the
// pool anchored to the later Amazon ship-by, so no "(Saturday)" variant.
const poolWithoutSaturday = (): LiveRate[] => {
  const rs: LiveRate[] = [];
  for (let i = 0; i < 21; i++) rs.push(rate(i, {}));
  rs.push(rate(21, { sub_carrier_id: "FEDEX", title: "FedEx 2Day® One Rate", total_net_charge: "17.04", edd: "2026-10-30" }));
  rs.push(rate(22, { sub_carrier_id: "FEDEX", title: "FedEx Home Delivery®", total_net_charge: "14.10", edd: "2026-10-30" }));
  return rs;
};
const planned = {
  serviceType: "7b833a80-9702-4998-b5a1-86286706eb59", // new-API rate_id, never in the old pool
  service: "Fedex 2Day® One Rate (Saturday)",
  subCarrierId: "FEDEX",
  price: 17.04,
  edd: "2026-10-24",
};

test("the reported case: id not in pool, no Saturday variant → no silent buy, clear reason + alternatives", () => {
  const live = poolWithoutSaturday();
  assert.equal(live.length, 23);
  const m = matchLiveRate(live, planned);
  // The non-Saturday 2Day arrives 10/30, later than the planned 10/24 → refused.
  assert.equal(m.rate, null);
  assert.match(m.reason!, /not among the 23 live rates/);
  assert.ok(m.alternatives.length > 0);
});

test("after re-anchoring to the ship day the Saturday variant is matched despite casing", () => {
  const live = poolWithoutSaturday();
  live.push(rate(23, { sub_carrier_id: "FEDEX", title: "FedEx 2Day® One Rate (Saturday)", total_net_charge: "17.04", edd: "2026-10-24" }));
  const m = matchLiveRate(live, planned);
  assert.equal(m.tier, "title");
  assert.equal(m.rate?.name, "live-23");
});

test("same quote id wins outright", () => {
  const live = poolWithoutSaturday();
  live.push(rate(99, { name: planned.serviceType, sub_carrier_id: "FEDEX", title: "anything" }));
  assert.equal(matchLiveRate(live, planned).tier, "id");
});

test("base-title fallback only when it arrives no later than planned", () => {
  const live = [rate(1, { sub_carrier_id: "FEDEX", title: "FedEx 2Day® One Rate", total_net_charge: "17.04", edd: "2026-10-24" })];
  const m = matchLiveRate(live, planned);
  assert.equal(m.tier, "base");
});

test("price guard: same service but pricier than max($1, 5%) → refused with the numbers", () => {
  const live = [rate(1, { sub_carrier_id: "FEDEX", title: "FedEx 2Day® One Rate (Saturday)", total_net_charge: "19.50", edd: "2026-10-24" })];
  const m = matchLiveRate(live, planned);
  assert.equal(m.rate, null);
  assert.match(m.reason!, /\$19\.50/);
  // Within tolerance it is accepted.
  const ok = [rate(1, { sub_carrier_id: "FEDEX", title: "FedEx 2Day® One Rate (Saturday)", total_net_charge: "17.90", edd: "2026-10-24" })];
  assert.equal(matchLiveRate(ok, planned).tier, "title");
});

test("never matches on remote_shipment_id (same for every rate in an allocation)", () => {
  const live = poolWithoutSaturday();
  const m = matchLiveRate(live, { ...planned, serviceType: null });
  assert.equal(m.rate, null);
});

test("helpers", () => {
  assert.equal(baseTitle("Fedex 2Day® One Rate (Saturday)"), "fedex 2day one rate");
  assert.equal(maxAcceptablePrice(10), 11);
  assert.equal(maxAcceptablePrice(40), 42);
});
