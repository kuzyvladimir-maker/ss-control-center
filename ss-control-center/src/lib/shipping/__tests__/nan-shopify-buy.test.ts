import { test } from "node:test";
import assert from "node:assert/strict";
import { purchaseNanLabel, waitNanPurchase, nanShopifyConfigured } from "../nan-shopify-buy";

// Read at call time, so setting them after the import is fine.
process.env.NANHEALTH_SHOP = "nan-test.myshopify.com";
process.env.NANHEALTH_CLIENT_ID = "id";
process.env.NANHEALTH_CLIENT_SECRET = "secret";

type Call = { url: string; body: string };
function mockShopify(answer: (query: string, n: number) => unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/oauth/access_token")) {
      return Response.json({ access_token: "tok", expires_in: 86399 });
    }
    const q = JSON.parse(body).query as string;
    return Response.json({ data: answer(q, calls.length) });
  }) as typeof fetch;
  return calls;
}

const input = {
  fulfillmentOrderId: "gid://shopify/FulfillmentOrder/1",
  carrierCode: "ups_shipping",
  serviceCode: "93",
  pkg: { l: 12, w: 10, h: 6, weightLb: 2.3 },
};

test("configured when the three env vars are set", () => {
  assert.equal(nanShopifyConfigured(), true);
});

test("sends the chosen rate, the quoted box and the total weight", async () => {
  const calls = mockShopify(() => ({
    shippingLabelPurchase: { shippingLabelPurchaseResult: { id: "gid://shopify/ShippingLabelPurchaseResult/9", status: "PENDING_PURCHASE" }, userErrors: [] },
  }));
  assert.deepEqual(await purchaseNanLabel(input), { resultId: "gid://shopify/ShippingLabelPurchaseResult/9" });
  const sent = calls.filter((c) => c.url.includes("graphql"));
  assert.equal(sent.length, 1);
  const v = JSON.parse(sent[0].body).variables.i;
  assert.deepEqual(v.preferredRateSelection, { carrierCode: "ups_shipping", serviceCode: "93" });
  assert.deepEqual(v.totalWeight, { value: 2.3, unit: "POUNDS" });
  assert.deepEqual(v.packageInfo.customPackage.dimensions, { length: 12, width: 10, height: 6, unit: "INCHES" });
  assert.ok(Date.parse(v.shippingDatetime) > Date.now());
});

test("a synchronous refusal comes back as errors (nothing bought)", async () => {
  mockShopify(() => ({
    shippingLabelPurchase: { shippingLabelPurchaseResult: null, userErrors: [{ field: ["x"], code: "RATES_NOT_FOUND", message: "no such rate" }] },
  }));
  assert.deepEqual(await purchaseNanLabel(input), { errors: ["RATES_NOT_FOUND: no such rate"] });
});

test("polling only READS the result and returns tracking + PDF once PURCHASED", async () => {
  const calls = mockShopify((_q, n) => ({
    node:
      n < 4
        ? { status: "PENDING_PURCHASE", errors: [], shippingLabels: [] }
        : {
            status: "PURCHASED",
            errors: [],
            shippingLabels: [{
              trackingInfo: { number: "1Z999", company: "UPS", url: "https://ups/1Z999" },
              shippingDocuments: [{ documentType: "LABEL", format: "PDF", url: "https://cdn/label.pdf" }],
            }],
          },
  }));
  const r = await waitNanPurchase("gid://shopify/ShippingLabelPurchaseResult/9", 10_000);
  assert.equal(r.status, "PURCHASED");
  assert.deepEqual(r.labels[0], { trackingNumber: "1Z999", company: "UPS", trackingUrl: "https://ups/1Z999", pdfUrl: "https://cdn/label.pdf" });
  assert.equal(calls.filter((c) => c.body.includes("shippingLabelPurchase(")).length, 0);
});
