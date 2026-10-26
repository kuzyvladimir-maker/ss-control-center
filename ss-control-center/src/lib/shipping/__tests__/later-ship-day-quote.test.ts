import { test } from "node:test";
import assert from "node:assert/strict";

// Veeqo's Rate Shopping API is mocked: every call returns the same quote (as
// Veeqo does when it ignores preferred_shipment_date). Owner rule 2026-10-25:
// the carrier's EDD is shown exactly as quoted — never moved.
process.env.VEEQO_API_KEY = process.env.VEEQO_API_KEY || "test-key";
const EDD = "2026-10-29T06:59:59Z"; // = 10/28 Pacific (end of day)
globalThis.fetch = (async () =>
  new Response(
    JSON.stringify({
      quotes: [
        { rate_id: "r1", service_name: "Fedex 2Day® One Rate", total_charge: "24.15", delivery_estimate: EDD, carrier_id: "fedex" },
        { rate_id: "r2", service_name: "UPS® Ground", total_charge: "14.10", delivery_estimate: "2026-11-01T06:59:59Z", carrier_id: "ups" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

const order = { number: "111-0144634-8326602", allocations: [{ warehouse: {}, allocation_package: {} }], deliver_to: {}, line_items: [] };

test("Sun 10/25 → Mon 10/26: same pickup day, quote is for the ship day, EDD untouched", async () => {
  const { getRatesForLaterShipDay } = await import("../../veeqo/client");
  const r = await getRatesForLaterShipDay(order, "2026-10-26", "2026-10-25");
  assert.equal(r.anchorHonored, true);
  assert.equal(r.quoteAnchorYmd, "2026-10-26");
  assert.equal(r.available[0].delivery_promise_date, EDD);
});

test("Fri 10/23 → Mon 10/26 with identical EDDs: flagged, EDDs NOT moved, anchor = Fri", async () => {
  const { getRatesForLaterShipDay } = await import("../../veeqo/client");
  const r = await getRatesForLaterShipDay(order, "2026-10-26", "2026-10-23");
  assert.equal(r.anchorHonored, false);
  assert.equal(r.quoteAnchorYmd, "2026-10-23");
  // Every service — 2Day and Ground alike — keeps the carrier's date.
  assert.deepEqual(
    r.available.map((x) => x.delivery_promise_date),
    [EDD, "2026-11-01T06:59:59Z"],
  );
});
