import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchWalmartItemSpecSchema,
  validateWalmartPayloadAgainstFetchedSpec,
  validateWalmartPayloadAgainstLiveSpec,
} from "@/lib/bundle-factory/distribution/walmart-item-spec";
import {
  sha256WalmartJson,
  WALMART_PUBLIC_CONTRACT_SCHEMA,
  type WalmartPublicListingContract,
} from "@/lib/bundle-factory/walmart-listing-contract";
import { WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION } from
  "@/lib/bundle-factory/validation/walmart-prepublication-policy";

function contractFor(schema: Record<string, unknown>): WalmartPublicListingContract {
  return {
    contract_version: WALMART_PUBLIC_CONTRACT_SCHEMA,
    spec_version: WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
    spec_schema_hash: sha256WalmartJson(schema),
    spec_fetched_at: "2026-07-18T12:00:00.000Z",
    product_type: "Food And Beverage",
    country_of_origin_substantial_transformation: "US",
    secondary_image_urls: ["https://example.com/secondary.png"],
    public_attributes: {},
    offer_handoff: {
      mode: "STAGED_AFTER_ITEM_SETUP",
      quantity: 5,
      fulfillment_center_id: "DEFAULT",
      fulfillment_lag_time: 1,
    },
  };
}

test("read-only Get Spec bootstrap returns hash, timestamp, and required paths", async () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    required: ["MPItem"],
    properties: {
      MPItem: {
        type: "array",
        items: {
          type: "object",
          required: ["Orderable", "Visible"],
          properties: {
            Orderable: { $ref: "#/$defs/orderable" },
            Visible: { type: "object" },
          },
          allOf: [
            {
              if: { properties: { preorder: { const: true } } },
              then: { required: ["inventory"] },
            },
          ],
        },
      },
    },
    $defs: {
      orderable: { type: "object", required: ["sku"] },
    },
  };
  const result = await fetchWalmartItemSpecSchema(
    {
      async requestRaw() {
        return {
          status: 200,
          ok: true,
          body: { schema: JSON.stringify(schema) },
          correlationId: "cid-bootstrap",
        };
      },
    },
    {
      version: WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
      productType: "Food And Beverage",
      now: new Date("2026-07-18T11:30:00.000Z"),
    },
  );

  assert.equal(result.schema_sha256, sha256WalmartJson(schema));
  assert.equal(result.fetched_at, "2026-07-18T11:30:00.000Z");
  assert.deepEqual(result.required_paths, [
    "$.MPItem",
    "$.MPItem[*].Orderable",
    "$.MPItem[*].Orderable.sku",
    "$.MPItem[*].Visible",
  ]);
  assert.deepEqual(result.conditional_required_paths, [
    "$.MPItem[*].inventory",
  ]);
});

test("Get Spec bootstrap refuses a non-current version before network", async () => {
  let calls = 0;
  await assert.rejects(
    fetchWalmartItemSpecSchema(
      {
        async requestRaw() {
          calls += 1;
          throw new Error("must not be called");
        },
      },
      { version: "4.7", productType: "Food And Beverage" },
    ),
    /not configured current version/i,
  );
  assert.equal(calls, 0);
});

test("live Get Spec validates the full payload and exact request coordinates", async () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    required: ["MPItemFeedHeader", "MPItem"],
    properties: {
      MPItemFeedHeader: { type: "object" },
      MPItem: { type: "array", minItems: 1 },
    },
  };
  const calls: Array<{ method: string; path: string; options: unknown }> = [];
  const result = await validateWalmartPayloadAgainstLiveSpec({
    contract: contractFor(schema),
    payload: { MPItemFeedHeader: {}, MPItem: [{}] },
    now: new Date("2026-07-18T13:00:00.000Z"),
    client: {
      async requestRaw(method, path, options) {
        calls.push({ method, path, options });
        return {
          status: 200,
          ok: true,
          body: { schema },
          correlationId: "cid-spec",
        };
      },
    },
  });

  assert.equal(result.valid, true);
  assert.equal(result.schema_sha256, sha256WalmartJson(schema));
  assert.equal(result.fetched_at, "2026-07-18T13:00:00.000Z");
  assert.deepEqual(calls, [
    {
      method: "POST",
      path: "/items/spec",
      options: {
        body: {
          feedType: "MP_ITEM",
          version: WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
          productTypes: ["Food And Beverage"],
        },
        noRetryOn429: true,
      },
    },
  ]);
});

test("one Get Spec response can be reused for network-free full-payload validation", async () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    required: ["MPItemFeedHeader", "MPItem"],
    properties: {
      MPItemFeedHeader: { type: "object" },
      MPItem: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["sku"],
          properties: { sku: { type: "string", minLength: 1 } },
        },
      },
    },
  };
  let networkCalls = 0;
  const fetchedSpec = await fetchWalmartItemSpecSchema(
    {
      async requestRaw() {
        networkCalls += 1;
        return {
          status: 200,
          ok: true,
          body: { schema },
          correlationId: "cid-one-call",
        };
      },
    },
    {
      version: WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
      productType: "Food And Beverage",
      now: new Date("2026-07-18T13:10:00.000Z"),
    },
  );
  const contract = contractFor(schema);

  const accepted = validateWalmartPayloadAgainstFetchedSpec({
    fetchedSpec,
    contract,
    payload: { MPItemFeedHeader: {}, MPItem: [{ sku: "SKU-1" }] },
  });
  const rejected = validateWalmartPayloadAgainstFetchedSpec({
    fetchedSpec,
    contract,
    payload: { MPItemFeedHeader: {}, MPItem: [{}] },
  });

  assert.equal(networkCalls, 1);
  assert.equal(accepted.valid, true);
  assert.equal(rejected.valid, false);
  assert.equal(rejected.issues[0]?.code, "WALMART_SPEC_VALIDATION_FAILED");
});

test("network-free validation rejects a tampered fetched-schema envelope", () => {
  const schema = { type: "object", required: ["sku"] };
  const result = validateWalmartPayloadAgainstFetchedSpec({
    fetchedSpec: {
      schema,
      schema_sha256: sha256WalmartJson({ type: "object" }),
      fetched_at: "2026-07-18T13:20:00.000Z",
      required_paths: ["$.sku"],
      conditional_required_paths: [],
    },
    contract: contractFor(schema),
    payload: { sku: "SKU-1" },
  });

  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "WALMART_FETCHED_SPEC_HASH_MISMATCH");
  assert.equal(result.schema_sha256, sha256WalmartJson(schema));
});

test("Walmart minEntries extension is enforced rather than ignored", async () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    required: ["images"],
    properties: {
      images: { type: "array", minEntries: 2, items: { type: "string" } },
    },
  };
  const result = await validateWalmartPayloadAgainstLiveSpec({
    contract: contractFor(schema),
    payload: { images: ["https://example.com/one.png"] },
    client: {
      async requestRaw() {
        return {
          status: 200,
          ok: true,
          body: schema,
          correlationId: "cid-min-entries",
        };
      },
    },
  });

  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "WALMART_SPEC_VALIDATION_FAILED");
});

test("live schema hash drift blocks publication", async () => {
  const pinnedSchema = { type: "object", required: ["one"] };
  const liveSchema = { type: "object", required: ["two"] };
  const result = await validateWalmartPayloadAgainstLiveSpec({
    contract: contractFor(pinnedSchema),
    payload: { two: true },
    client: {
      async requestRaw() {
        return {
          status: 200,
          ok: true,
          body: { schema: liveSchema },
          correlationId: "cid-drift",
        };
      },
    },
  });

  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "WALMART_SPEC_HASH_MISMATCH");
  assert.equal(result.schema_sha256, sha256WalmartJson(liveSchema));
});

test("Get Spec failures are fail-closed", async () => {
  const schema = { type: "object" };
  const result = await validateWalmartPayloadAgainstLiveSpec({
    contract: contractFor(schema),
    payload: {},
    client: {
      async requestRaw() {
        return {
          status: 429,
          ok: false,
          body: { error: "REQUEST_THRESHOLD_VIOLATED" },
          correlationId: "cid-throttle",
        };
      },
    },
  });

  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "WALMART_GET_SPEC_HTTP_ERROR");
});
