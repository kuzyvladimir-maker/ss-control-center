import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import sharp from "sharp";

const originalFetch = globalThis.fetch;
const tracePath = process.env.WALMART_NEW_SKU_FAKE_HTTP_TRACE;

function trace(entry) {
  if (!tracePath) return;
  appendFileSync(tracePath, `${JSON.stringify(entry)}\n`, "utf8");
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...extraHeaders,
    },
  });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

const pngBytes = await sharp({
  create: {
    width: 2200,
    height: 2200,
    channels: 3,
    background: { r: 255, g: 255, b: 255 },
  },
}).png().toBuffer();

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = String(init.method ?? (typeof input === "string" ? "GET" : input.method))
    .toUpperCase();
  trace({ method, url: url.toString() });

  if (url.hostname === "walmart.fixture.test") {
    if (url.pathname === "/v3/token" && method === "POST") {
      return json({ access_token: "fixture-access-token", expires_in: 3600 });
    }
    if (url.pathname === "/v3/items/walmart/search" && method === "GET") {
      return json(
        { items: [] },
        200,
        { "wm_qos.correlation_id": "fixture-catalog-cid" },
      );
    }
    if (/^\/v3\/items\/WM-[A-F0-9]{4}-[A-F0-9]{4}$/.test(url.pathname) && method === "GET") {
      if (process.env.WALMART_NEW_SKU_TEST_EXISTING_SELLER_SKU === "1") {
        return json(
          { ItemResponse: [{ sku: url.pathname.split("/").at(-1), upc: "099999999999" }] },
          200,
          { "wm_qos.correlation_id": "fixture-seller-sku-exists-cid" },
        );
      }
      return json(
        { errors: [{ code: "ITEM_NOT_FOUND", description: "fixture absent SKU" }] },
        404,
        { "wm_qos.correlation_id": "fixture-seller-sku-absent-cid" },
      );
    }
    if (url.pathname === "/v3/items/spec" && method === "POST") {
      return json(
        {
          schema: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            required: ["MPItemFeedHeader", "MPItem"],
            properties: {
              MPItemFeedHeader: { type: "object" },
              MPItem: {
                type: "array",
                minItems: 1,
                maxItems: 1,
                items: { type: "object" },
              },
            },
            additionalProperties: false,
          },
        },
        200,
        { "wm_qos.correlation_id": "fixture-spec-cid" },
      );
    }
    if (url.pathname === "/v3/feeds" && method === "POST") {
      if (process.env.WALMART_NEW_SKU_TEST_ALLOW_FEED_POST === "1") {
        const file = init.body instanceof FormData ? init.body.get("file") : null;
        if (!(file instanceof Blob)) {
          throw new Error("TEST_FEED_CONTRACT: multipart file part is missing");
        }
        const payloadText = await file.text();
        const payload = JSON.parse(payloadText);
        trace({
          kind: "feed-payload",
          url: url.toString(),
          filename: typeof file.name === "string" ? file.name : null,
          content_type: file.type,
          byte_length: Buffer.byteLength(payloadText),
          canonical_payload_sha256: createHash("sha256")
            .update(JSON.stringify(canonical(payload)))
            .digest("hex"),
        });
        return json(
          { feedId: "fixture-feed-id-1", status: "RECEIVED" },
          200,
          { "wm_qos.correlation_id": "fixture-feed-cid" },
        );
      }
      throw new Error("TEST_SAFETY_FENCE: Walmart feed POST is forbidden");
    }
    if (
      url.pathname === "/v3/feeds/fixture-feed-id-1" &&
      method === "GET" &&
      process.env.WALMART_NEW_SKU_TEST_POLL_READY === "1"
    ) {
      const sku = process.env.WALMART_NEW_SKU_TEST_POLL_SKU;
      const itemId = process.env.WALMART_NEW_SKU_TEST_POLL_ITEM_ID;
      if (!sku || !itemId) {
        throw new Error("TEST_POLL_FIXTURE: exact SKU and item ID are required");
      }
      return json({
        feedStatus: "PROCESSED",
        itemDetails: {
          itemDetails: [{
            sku,
            ingestionStatus: "SUCCESS",
            martId: itemId,
          }],
        },
      });
    }
    if (
      url.pathname === "/v3/items" &&
      method === "GET" &&
      process.env.WALMART_NEW_SKU_TEST_POLL_READY === "1"
    ) {
      const sku = process.env.WALMART_NEW_SKU_TEST_POLL_SKU;
      const itemId = process.env.WALMART_NEW_SKU_TEST_POLL_ITEM_ID;
      if (!sku || !itemId || url.searchParams.get("sku") !== sku) {
        throw new Error("TEST_POLL_FIXTURE: seller query must target exact SKU");
      }
      return json({
        ItemResponse: [{
          sku,
          publishedStatus: "PUBLISHED",
          lifecycleStatus: "ACTIVE",
          mart: { itemId },
        }],
      });
    }
    throw new Error(`Unexpected fake Walmart request: ${method} ${url.pathname}`);
  }

  if (url.hostname === "veeqo.fixture.test") {
    if (method !== "GET" || url.pathname !== "/products") {
      throw new Error(`Unexpected fake Veeqo request: ${method} ${url.pathname}`);
    }
    return json([{ product_variants: [{ sellable_stock_level: 100 }] }]);
  }

  if (url.hostname === "images.fixture.test") {
    if (!/\.(?:png|jpe?g)$/i.test(url.pathname)) {
      throw new Error(`Unexpected fake image request: ${method} ${url.pathname}`);
    }
    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(pngBytes.length),
        },
      });
    }
    if (method === "GET") {
      return new Response(pngBytes, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(pngBytes.length),
        },
      });
    }
  }

  if (process.env.WALMART_NEW_SKU_ALLOW_UNEXPECTED_NETWORK === "1") {
    return originalFetch(input, init);
  }
  throw new Error(`TEST_SAFETY_FENCE: unexpected external request ${method} ${url}`);
};
