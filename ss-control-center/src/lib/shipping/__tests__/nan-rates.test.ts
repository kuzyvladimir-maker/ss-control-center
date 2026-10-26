import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nanAdminOrderUrl,
  normalizeNanRates,
  parseNanPayload,
  snapshotAge,
} from "../nan-rates";

test("collector payload: order #1374, rates sorted, cheapest/fastest flags honoured", () => {
  const p = parseNanPayload({
    captured_at: "2026-10-26T05:40:00Z",
    orders: [
      {
        order_name: "#1374",
        shopify_order_id: "6543210987",
        dest: { city: "Medina", state: "OH", country: "US" },
        package: { l: 12, w: 10, h: 6, in: true, weight_lb: 1.9 },
        rates: [
          { carrier: "UPS", service: "UPS Ground", price_usd: 8.67, eta_text: "2d", fastest: true },
          { carrier: "FedEx", service: "FedEx Ground Economy", price_usd: 6.98, eta_text: "4-5d", cheapest: true },
        ],
      },
      { order_name: "", rates: [] },
    ],
  });
  assert.equal(p.capturedAt?.toISOString(), "2026-10-26T05:40:00.000Z");
  assert.equal(p.orders.length, 1);
  const o = p.orders[0];
  assert.equal(o.orderNumber, "1374");
  assert.equal(o.shopifyOrderId, "6543210987");
  assert.deepEqual(o.rates.map((r) => [r.carrier, r.service, r.price, r.cheapest, r.fastest]), [
    ["FedEx", "Ground Economy", 6.98, true, false],
    ["UPS", "Ground", 8.67, false, true],
  ]);
});

test("old compact tuples: flags computed, media mail last and never 'cheapest'", () => {
  const r = normalizeNanRates([
    ["UPS Ground", 8.67, "2d"],
    ["FedEx Ground Economy", 6.98, "4-5d"],
    ["USPS Media Mail", 5.13, "media only"],
    ["UPS Next Day Air", 60.87, "1d"],
  ]);
  assert.equal(r[r.length - 1].service, "Media Mail");
  assert.equal(r.find((x) => x.cheapest)?.price, 6.98);
  assert.equal(r.find((x) => x.fastest)?.service, "Next Day Air");
});

test("snapshot age: minutes, hours, stale after 30 min, missing", () => {
  const now = new Date("2026-10-26T06:00:00Z");
  assert.deepEqual(snapshotAge("2026-10-26T05:57:00Z", now), { text: "3 мин назад", stale: false });
  assert.deepEqual(snapshotAge("2026-10-26T05:20:00Z", now), { text: "40 мин назад", stale: true });
  assert.deepEqual(snapshotAge("2026-10-26T03:00:00Z", now), { text: "3 ч назад", stale: true });
  assert.equal(snapshotAge(null, now).stale, true);
});

test("Shopify admin link: by order id, else a search by number", () => {
  assert.equal(nanAdminOrderUrl("6543210987", "#1374"), "https://admin.shopify.com/store/1bndby-p8/orders/6543210987");
  assert.equal(nanAdminOrderUrl(null, "#1374"), "https://admin.shopify.com/store/1bndby-p8/orders?query=1374");
});
