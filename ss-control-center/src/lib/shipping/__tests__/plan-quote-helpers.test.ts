import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_RATES_RETRY_DELAYS_MS,
  alignRateToReweightedQuote,
  effectiveBuyWeightLbs,
  findMatchingRateByCarrierAndTitle,
  hasRates,
  retryIfEmptyRates,
  type QuotedRate,
} from "../plan-quote-helpers";

// ── retryIfEmptyRates ───────────────────────────────────────────────────

type Resp = { available: QuotedRate[] };
const empty: Resp = { available: [] };
const full: Resp = {
  available: [{ sub_carrier_id: "UPS", title: "UPS® Ground", total_net_charge: "12.10" }],
};

function scripted(answers: Resp[]) {
  let calls = 0;
  const fn = async () => answers[Math.min(calls++, answers.length - 1)];
  return { fn, calls: () => calls };
}

function recordingSleep() {
  const waits: number[] = [];
  return { sleep: async (ms: number) => void waits.push(ms), waits };
}

test("hasRates: only a non-empty `available` array counts", () => {
  assert.equal(hasRates(full), true);
  assert.equal(hasRates(empty), false);
  assert.equal(hasRates(null), false);
  assert.equal(hasRates(undefined), false);
  assert.equal(hasRates({}), false);
  assert.equal(hasRates({ available: "x" }), false);
});

test("retryIfEmptyRates: non-empty first answer → one call, no sleep", async () => {
  const s = scripted([full]);
  const z = recordingSleep();
  const r = await retryIfEmptyRates(s.fn, { sleep: z.sleep });
  assert.equal(r, full);
  assert.equal(s.calls(), 1);
  assert.deepEqual(z.waits, []);
});

test("retryIfEmptyRates: the 2026-11-27 flicker — empty then full is recovered", async () => {
  const s = scripted([empty, full]);
  const z = recordingSleep();
  const r = await retryIfEmptyRates(s.fn, { sleep: z.sleep });
  assert.equal(r, full);
  assert.equal(s.calls(), 2);
  assert.deepEqual(z.waits, [600]);
});

test("retryIfEmptyRates: default delays are 600ms then 1400ms; gives up with the empty answer", async () => {
  assert.deepEqual([...EMPTY_RATES_RETRY_DELAYS_MS], [600, 1400]);
  const s = scripted([empty, empty, empty, full]);
  const z = recordingSleep();
  const retries: Array<[number, number]> = [];
  const r = await retryIfEmptyRates(s.fn, {
    sleep: z.sleep,
    onRetry: (a, d) => retries.push([a, d]),
  });
  assert.equal(r, empty);
  assert.equal(s.calls(), 3); // 1 + 2 retries, never a 4th
  assert.deepEqual(z.waits, [600, 1400]);
  assert.deepEqual(retries, [[1, 600], [2, 1400]]);
});

test("retryIfEmptyRates: custom delays and custom isEmpty", async () => {
  const s = scripted([empty, empty, full]);
  const z = recordingSleep();
  const r = await retryIfEmptyRates(s.fn, { sleep: z.sleep, retryDelaysMs: [1, 2, 3] });
  assert.equal(r, full);
  assert.deepEqual(z.waits, [1, 2]);

  let n = 0;
  const counted = await retryIfEmptyRates(async () => ++n, {
    sleep: async () => {},
    isEmpty: (v) => v < 3,
  });
  assert.equal(counted, 3);
});

test("retryIfEmptyRates: zero retries configured → single call", async () => {
  const s = scripted([empty, full]);
  const r = await retryIfEmptyRates(s.fn, { sleep: async () => {}, retryDelaysMs: [] });
  assert.equal(r, empty);
  assert.equal(s.calls(), 1);
});

test("retryIfEmptyRates: a thrown error propagates without retry", async () => {
  let calls = 0;
  await assert.rejects(
    retryIfEmptyRates(
      async () => {
        calls++;
        throw new Error("Veeqo 400");
      },
      { sleep: async () => {} },
    ),
    /Veeqo 400/,
  );
  assert.equal(calls, 1);
});

test("retryIfEmptyRates: a null / malformed answer counts as empty", async () => {
  const answers: unknown[] = [null, { foo: 1 }, full];
  let i = 0;
  const r = await retryIfEmptyRates(async () => answers[i++] as Resp, {
    sleep: async () => {},
  });
  assert.equal(r, full);
});

// ── effectiveBuyWeightLbs ───────────────────────────────────────────────

test("effectiveBuyWeightLbs: plain service, no ice → base weight", () => {
  assert.equal(
    effectiveBuyWeightLbs({ baseWeightLbs: 10, liveIceExtra: 0, serviceTitle: "UPS® Ground" }),
    10,
  );
  assert.equal(effectiveBuyWeightLbs({ baseWeightLbs: 10 }), 10);
  assert.equal(
    effectiveBuyWeightLbs({ baseWeightLbs: 10, liveIceExtra: null, serviceTitle: null }),
    10,
  );
});

test("effectiveBuyWeightLbs: extra ice only → + 1 lb per piece", () => {
  assert.equal(
    effectiveBuyWeightLbs({ baseWeightLbs: 10, liveIceExtra: 2, serviceTitle: "FedEx Home Delivery®" }),
    12,
  );
  // Negative ice is ignored, never subtracts weight.
  assert.equal(effectiveBuyWeightLbs({ baseWeightLbs: 10, liveIceExtra: -3 }), 10);
});

test("effectiveBuyWeightLbs: FedEx One Rate only → ×1.20", () => {
  assert.equal(
    effectiveBuyWeightLbs({ baseWeightLbs: 10, serviceTitle: "FedEx 2Day® One Rate" }),
    12,
  );
  assert.equal(
    effectiveBuyWeightLbs({ baseWeightLbs: 16.75, serviceTitle: "fedex 2day one rate" }),
    20.1,
  );
});

test("effectiveBuyWeightLbs: ice AND One Rate → ice first, then ×1.20 (buy order)", () => {
  // buy/route.ts: item.weight = 10 + 2 ice = 12 → ×1.2 = 14.4
  assert.equal(
    effectiveBuyWeightLbs({ baseWeightLbs: 10, liveIceExtra: 2, serviceTitle: "FedEx 2Day® One Rate" }),
    14.4,
  );
  // Not (10 × 1.2) + 2 = 14 — order matters.
  assert.notEqual(
    effectiveBuyWeightLbs({ baseWeightLbs: 10, liveIceExtra: 2, serviceTitle: "FedEx 2Day® One Rate" }),
    14,
  );
  // 7.3 + 1 = 8.3 → 9.96
  assert.equal(
    effectiveBuyWeightLbs({ baseWeightLbs: 7.3, liveIceExtra: 1, serviceTitle: "FedEx Standard Overnight® One Rate" }),
    9.96,
  );
});

// ── findMatchingRateByCarrierAndTitle ───────────────────────────────────

// Re-quote at the buy weight for 113-8220504-0305829-style order (trimmed).
const requote: QuotedRate[] = [
  { name: "rq-usps", sub_carrier_id: "USPS", title: "USPS Ground Advantage Cubic", total_net_charge: "11.02", delivery_promise_date: "2026-12-02T07:59:59Z" },
  { name: "rq-fx1r", sub_carrier_id: "FEDEX", title: "FedEx 2Day® One Rate", total_net_charge: "32.61", base_rate: "32.61", delivery_promise_date: "2026-12-01T07:59:59Z", remote_shipment_id: "rs-1" },
  { name: "rq-fx1r-sat", sub_carrier_id: "FEDEX", title: "FedEx 2Day® One Rate (Saturday)", total_net_charge: "41.00", delivery_promise_date: "2026-11-29T07:59:59Z" },
  { name: "rq-ups2", sub_carrier_id: "UPS", title: "UPS 2nd Day Air ®", total_net_charge: "49.51", delivery_promise_date: "2026-12-01T07:59:59Z" },
];

test("findMatchingRateByCarrierAndTitle: same carrier + same title (®/case/spacing-insensitive)", () => {
  assert.equal(
    findMatchingRateByCarrierAndTitle(requote, { sub_carrier_id: "FEDEX", title: "FedEx 2Day® One Rate" })?.name,
    "rq-fx1r",
  );
  assert.equal(
    findMatchingRateByCarrierAndTitle(requote, { sub_carrier_id: "fedex", title: "fedex 2day one  rate" })?.name,
    "rq-fx1r",
  );
  assert.equal(
    findMatchingRateByCarrierAndTitle(requote, { sub_carrier_id: "UPS", title: "UPS 2nd Day Air®" })?.name,
    "rq-ups2",
  );
});

test("findMatchingRateByCarrierAndTitle: a '(Saturday)' variant is a different service", () => {
  assert.equal(
    findMatchingRateByCarrierAndTitle(requote, { sub_carrier_id: "FEDEX", title: "FedEx 2Day® One Rate (Saturday)" })?.name,
    "rq-fx1r-sat",
  );
});

test("findMatchingRateByCarrierAndTitle: wrong carrier / missing service / empty target → null", () => {
  assert.equal(findMatchingRateByCarrierAndTitle(requote, { sub_carrier_id: "UPS", title: "FedEx 2Day® One Rate" }), null);
  assert.equal(findMatchingRateByCarrierAndTitle(requote, { sub_carrier_id: "FEDEX", title: "FedEx Home Delivery®" }), null);
  assert.equal(findMatchingRateByCarrierAndTitle(requote, { sub_carrier_id: "", title: "FedEx 2Day® One Rate" }), null);
  assert.equal(findMatchingRateByCarrierAndTitle(requote, { sub_carrier_id: "FEDEX", title: "" }), null);
  assert.equal(findMatchingRateByCarrierAndTitle([], { sub_carrier_id: "FEDEX", title: "FedEx 2Day® One Rate" }), null);
});

test("findMatchingRateByCarrierAndTitle: unpriced rows skipped; duplicates → cheapest", () => {
  const rows: QuotedRate[] = [
    { name: "a", sub_carrier_id: "FEDEX", title: "FedEx 2Day® One Rate", total_net_charge: "" },
    { name: "b", sub_carrier_id: "FEDEX", title: "FedEx 2Day® One Rate", total_net_charge: "18.00" },
    { name: "c", sub_carrier_id: "FEDEX", title: "FedEx 2Day One Rate", total_net_charge: "17.52" },
    { name: "d", sub_carrier_id: "FEDEX", title: "FedEx 2Day® One Rate", total_net_charge: "0" },
  ];
  assert.equal(
    findMatchingRateByCarrierAndTitle(rows, { sub_carrier_id: "FEDEX", title: "FedEx 2Day® One Rate" })?.name,
    "c",
  );
});

// ── alignRateToReweightedQuote ──────────────────────────────────────────

const picked = {
  name: "q-fx1r",
  carrier: "amazon_shipping_v2",
  sub_carrier_id: "FEDEX",
  service_carrier: "fedex",
  title: "FedEx 2Day® One Rate",
  total_net_charge: "27.78",
  base_rate: "27.78",
  delivery_promise_date: "2026-12-01T07:59:59Z",
  remote_shipment_id: "",
};

test("alignRateToReweightedQuote: takes the buy-weight price, keeps the service", () => {
  const a = alignRateToReweightedQuote(picked, requote);
  assert.equal(a.changed, true);
  assert.equal(a.reason, null);
  assert.equal(a.rate.total_net_charge, "32.61");
  assert.equal(a.rate.base_rate, "32.61");
  assert.equal(a.rate.name, "rq-fx1r");
  assert.equal(a.rate.remote_shipment_id, "rs-1");
  // Service identity untouched.
  assert.equal(a.rate.title, picked.title);
  assert.equal(a.rate.sub_carrier_id, "FEDEX");
  assert.equal(a.rate.carrier, "amazon_shipping_v2");
  assert.equal(a.rate.service_carrier, "fedex");
  // Original not mutated.
  assert.equal(picked.total_net_charge, "27.78");
});

test("alignRateToReweightedQuote: base_rate falls back to the new total when missing", () => {
  const a = alignRateToReweightedQuote(
    { ...picked, title: "USPS Ground Advantage Cubic", sub_carrier_id: "USPS", delivery_promise_date: "2026-12-02T07:59:59Z" },
    requote,
  );
  assert.equal(a.changed, true);
  assert.equal(a.rate.total_net_charge, "11.02");
  assert.equal(a.rate.base_rate, "11.02");
});

test("alignRateToReweightedQuote: service missing (ship-today after 11:00 ET, no FedEx) → original kept", () => {
  const noFedex = requote.filter((r) => r.sub_carrier_id !== "FEDEX");
  const a = alignRateToReweightedQuote(picked, noFedex);
  assert.equal(a.changed, false);
  assert.equal(a.rate, picked);
  assert.match(a.reason ?? "", /not in the re-quote/);
});

test("alignRateToReweightedQuote: re-quote delivering LATER is refused (deadline/food-safety stay valid)", () => {
  const later: QuotedRate[] = [
    { ...requote[1], delivery_promise_date: "2026-12-03T07:59:59Z" },
  ];
  const a = alignRateToReweightedQuote(picked, later);
  assert.equal(a.changed, false);
  assert.equal(a.rate, picked);
  assert.match(a.reason ?? "", /later/);
});

test("alignRateToReweightedQuote: same-day EDD with a different time is accepted", () => {
  const sameDay: QuotedRate[] = [
    { ...requote[1], delivery_promise_date: "2026-12-01T03:00:00Z" },
  ];
  const a = alignRateToReweightedQuote(picked, sameDay);
  assert.equal(a.changed, true);
  assert.equal(a.rate.total_net_charge, "32.61");
});
