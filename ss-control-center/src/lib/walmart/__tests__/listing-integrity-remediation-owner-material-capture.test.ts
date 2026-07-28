import assert from "node:assert/strict";
import { test } from "node:test";

import {
  captureWalmartListingRepairOwnerMaterials,
} from "../listing-integrity-remediation-owner-material-capture.ts";
import {
  WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION,
  canonicalWalmartListingSurgicalJson,
} from "../listing-integrity-remediation-payload.ts";

const LEDGER = {
  policy_id: "walmart-listing-repair-permit-consumption-ledger/1.0.0",
  ledger_id: "ledger-11111111-1111-4111-8111-111111111111",
  ledger_epoch: "epoch-22222222-2222-4222-8222-222222222222",
  state_directory_path_sha256: "1".repeat(64),
  directory_identity_sha256: "2".repeat(64),
  identity_artifact_sha256: "3".repeat(64),
  reservation_filename_policy: "authorization-sha256.json/exclusive-create/v1",
  trusted_single_custody_host_only: true,
  distributed_at_most_once_claimed: false,
} as const;

test("material capture performs only three exact non-retrying read attempts", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const exactItem = {
    ItemResponse: [{
      sku: "capture-pack-6",
      mart: "WALMART_US",
      wpid: "157F37H8RG4R",
      productType: "Bakery",
      publishedStatus: "PUBLISHED",
      lifecycleStatus: "ACTIVE",
      upc: "012345678905",
    }],
  };
  const getSpec = {
    schema: {
      type: "object",
      properties: { MPItem: { type: "array" } },
    },
  };
  const responses = [
    new Response(JSON.stringify({ access_token: "fixture-token" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(canonicalWalmartListingSurgicalJson(exactItem), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(canonicalWalmartListingSurgicalJson(getSpec), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ];
  const moments = [
    new Date("2026-07-25T12:00:00.000Z"),
    new Date("2026-07-25T12:00:01.000Z"),
  ];
  const correlations = ["oauth-correlation", "item-correlation", "spec-correlation"];
  const result = await captureWalmartListingRepairOwnerMaterials({
    store_index: 1,
    sku: "capture-pack-6",
    credentials: {
      client_id: "fixture-client",
      client_secret: "fixture-secret",
      seller_id: "fixture-seller",
    },
    capture_authority_public_key_spki_sha256: "a".repeat(64),
    consumption_ledger: LEDGER,
    ledger_state_directory: "/private/tmp/listing-repair-ledger",
    artifact_custody_root: "/private/tmp/listing-repair-artifacts",
    fetch_impl: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      const response = responses.shift();
      assert(response, "unexpected extra HTTP attempt");
      return response;
    }) as typeof fetch,
    now: () => moments.shift() ?? new Date("2026-07-25T12:00:02.000Z"),
    random_uuid: () => correlations.shift() ?? "unexpected-correlation",
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => [
    call.init.method,
    new URL(call.url).pathname,
    call.init.redirect,
  ]), [
    ["POST", "/v3/token", "error"],
    ["GET", "/v3/items/capture-pack-6", "error"],
    ["POST", "/v3/items/spec", "error"],
  ]);
  assert.equal(
    Buffer.from(calls[2]!.init.body as Uint8Array).toString("utf8"),
    canonicalWalmartListingSurgicalJson({
      feedType: "MP_MAINTENANCE",
      version: WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION,
      productTypes: ["Bakery"],
    }),
  );
  assert.equal(result.product_type, "Bakery");
  assert.deepEqual(result.call_counts, {
    oauth_token_calls: 1,
    exact_item_get_calls: 1,
    variant_group_all_items_get_calls: 0,
    get_spec_post_calls: 1,
    total_http_calls: 3,
    retries: 0,
    redirects: 0,
    walmart_content_writes: 0,
  });
  assert.deepEqual(
    result.materials.live_item_response_bytes,
    Buffer.from(canonicalWalmartListingSurgicalJson(exactItem), "utf8"),
  );
  assert.deepEqual(
    result.materials.get_spec_response_bytes,
    Buffer.from(canonicalWalmartListingSurgicalJson(getSpec), "utf8"),
  );
});

test("attribute lane captures the exact complete variant group with one extra GET", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const exactItem = {
    ItemResponse: [{
      sku: "capture-pack-6",
      mart: "WALMART_US",
      wpid: "157F37H8RG4R",
      productType: "Bakery",
      publishedStatus: "PUBLISHED",
      lifecycleStatus: "ACTIVE",
      upc: "012345678905",
      variantGroupId: "bread-pack-group",
      variantGroupInfo: {
        isPrimary: false,
        groupingAttributes: [{ name: "flavor", value: "qty 6" }],
      },
    }],
  };
  const allItems = {
    ItemResponse: exactItem.ItemResponse,
    totalItems: 1,
  };
  const getSpec = {
    schema: {
      type: "object",
      properties: { MPItem: { type: "array" } },
    },
  };
  const responses = [
    new Response(JSON.stringify({ access_token: "fixture-token" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(canonicalWalmartListingSurgicalJson(exactItem), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(canonicalWalmartListingSurgicalJson(allItems), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(canonicalWalmartListingSurgicalJson(getSpec), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ];
  const result = await captureWalmartListingRepairOwnerMaterials({
    store_index: 1,
    sku: "capture-pack-6",
    credentials: {
      client_id: "fixture-client",
      client_secret: "fixture-secret",
      seller_id: "fixture-seller",
    },
    capture_authority_public_key_spki_sha256: "a".repeat(64),
    consumption_ledger: LEDGER,
    ledger_state_directory: "/private/tmp/listing-repair-ledger",
    artifact_custody_root: "/private/tmp/listing-repair-artifacts",
    capture_variant_group: true,
    fetch_impl: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      const response = responses.shift();
      assert(response, "unexpected extra HTTP attempt");
      return response;
    }) as typeof fetch,
    now: () => new Date("2026-07-25T12:00:00.000Z"),
    random_uuid: () => `correlation-${calls.length}`,
  });

  assert.equal(calls.length, 4);
  const groupUrl = new URL(calls[2]!.url);
  assert.equal(groupUrl.pathname, "/v3/items");
  assert.equal(groupUrl.searchParams.get("variantGroupId"), "bread-pack-group");
  assert.equal(groupUrl.searchParams.get("limit"), "200");
  assert.equal(groupUrl.searchParams.get("offset"), "0");
  assert.equal(
    result.materials.variant_group_all_items_receipt?.query.variantGroupId,
    "bread-pack-group",
  );
  assert.deepEqual(
    result.materials.variant_group_all_items_response_bytes,
    Buffer.from(canonicalWalmartListingSurgicalJson(allItems), "utf8"),
  );
  assert.deepEqual(result.call_counts, {
    oauth_token_calls: 1,
    exact_item_get_calls: 1,
    variant_group_all_items_get_calls: 1,
    get_spec_post_calls: 1,
    total_http_calls: 4,
    retries: 0,
    redirects: 0,
    walmart_content_writes: 0,
  });
});

test("material capture never retries an unknown network outcome", async () => {
  let attempts = 0;
  await assert.rejects(
    captureWalmartListingRepairOwnerMaterials({
      store_index: 1,
      sku: "capture-pack-6",
      credentials: {
        client_id: "fixture-client",
        client_secret: "fixture-secret",
        seller_id: "fixture-seller",
      },
      capture_authority_public_key_spki_sha256: "a".repeat(64),
      consumption_ledger: LEDGER,
      ledger_state_directory: "/private/tmp/listing-repair-ledger",
      artifact_custody_root: "/private/tmp/listing-repair-artifacts",
      fetch_impl: (async () => {
        attempts += 1;
        throw new Error("ambiguous transport failure");
      }) as typeof fetch,
    }),
    /must not be retried/u,
  );
  assert.equal(attempts, 1);
});
