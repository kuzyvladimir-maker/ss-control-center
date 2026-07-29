import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWalmartListingFullSurfacePlan,
} from "../listing-integrity-full-surface.ts";
import {
  WalmartListingFullSurfaceTransportError,
  createWalmartListingFullSurfaceTransportForTest,
} from "../listing-integrity-full-surface-transport.ts";

const H = (char: string): string => char.repeat(64);

function planFixture() {
  const payload = Buffer.from(JSON.stringify({
    sku: "FaisalX-1433",
    pricing: [{
      currentPriceType: "BASE",
      currentPrice: { currency: "USD", amount: 42.99 },
    }],
  }), "utf8");
  const plan = buildWalmartListingFullSurfacePlan({
    plan_id: "transport-plan-1",
    owner_decision_id: "owner-decision-1",
    owner_decision_sha256: H("1"),
    created_at: "2026-07-29T16:00:00.000Z",
    expires_at: "2026-07-29T17:00:00.000Z",
    seller_account_fingerprint_sha256: H("2"),
    product_truth_snapshot_sha256: H("3"),
    exact_listings: [{
      channel: "WALMART_US",
      store_index: 1,
      sku: "FaisalX-1433",
      listing_key: "walmart:1:FaisalX-1433",
      item_id: "1209518230",
    }],
    operations: [{
      operation_id: "price-1433",
      operation_kind: "PRICE",
      exact_skus: ["FaisalX-1433"],
      request_payload_bytes: payload,
      content_type: "application/json",
      evidence_sha256: H("4"),
      account_scope_receipt_sha256: H("5"),
      baseline_state_sha256: H("6"),
      expected_state_sha256: H("7"),
    }],
  });
  return { plan, payload };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("sends one exact mutation, reuses one token for readback and never retries", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url).endsWith("/v3/token")) {
      return jsonResponse({ access_token: "test-access-token" });
    }
    if (String(url).includes("/v3/price") && init?.method === "PUT") {
      assert.equal(init?.method, "PUT");
      assert.equal(
        new TextDecoder().decode(init?.body as Uint8Array),
        planFixture().payload.toString("utf8"),
      );
      return jsonResponse({ message: "accepted" });
    }
    assert.equal(init?.method, "GET");
    return jsonResponse({ sku: "FaisalX-1433", price: 42.99 });
  };
  const transport = createWalmartListingFullSurfaceTransportForTest({
    store_index: 1,
    credentials: {
      client_id: "client-id",
      client_secret: "client-secret",
      seller_id: "seller-id",
    },
    fetch_impl: fetchImpl as typeof fetch,
    random_uuid: () => "00000000-0000-4000-8000-000000000001",
  });
  const { plan, payload } = planFixture();
  const response = await transport.mutate({
    operation: plan.operations[0],
    request_payload_bytes: payload,
    correlation_id: "00000000-0000-4000-8000-000000000002",
  });
  assert.equal(response.status, 200);
  const readback = await transport.read({
    path: "/v3/price",
    query: { sku: "FaisalX-1433" },
    correlation_id: "00000000-0000-4000-8000-000000000003",
  });
  assert.equal(readback.status, 200);
  assert.deepEqual(transport.counts(), {
    oauth_token_calls: 1,
    mutation_calls: 1,
    readback_get_calls: 1,
    semantic_read_post_calls: 0,
    total_http_calls: 3,
  });
  assert.equal(calls.length, 3);
  await assert.rejects(
    transport.mutate({
      operation: plan.operations[0],
      request_payload_bytes: payload,
      correlation_id: "00000000-0000-4000-8000-000000000004",
    }),
    (error: unknown) => (
      error instanceof WalmartListingFullSurfaceTransportError
      && error.code === "MUTATION_SLOT_CONSUMED"
    ),
  );
  assert.equal(calls.length, 3);
});

test("classifies a mutation network exception as unknown and does not retry", async () => {
  let calls = 0;
  const fetchImpl = async (url: string | URL | Request) => {
    calls += 1;
    if (String(url).endsWith("/v3/token")) {
      return jsonResponse({ access_token: "test-access-token" });
    }
    throw new Error("socket closed after dispatch");
  };
  const transport = createWalmartListingFullSurfaceTransportForTest({
    store_index: 1,
    credentials: {
      client_id: "client-id",
      client_secret: "client-secret",
      seller_id: "seller-id",
    },
    fetch_impl: fetchImpl as typeof fetch,
    random_uuid: () => "00000000-0000-4000-8000-000000000001",
  });
  const { plan, payload } = planFixture();
  await assert.rejects(
    transport.mutate({
      operation: plan.operations[0],
      request_payload_bytes: payload,
      correlation_id: "00000000-0000-4000-8000-000000000002",
    }),
    (error: unknown) => (
      error instanceof WalmartListingFullSurfaceTransportError
      && error.code === "MUTATION_OUTCOME_UNKNOWN"
    ),
  );
  assert.equal(calls, 2);
  assert.deepEqual(transport.counts(), {
    oauth_token_calls: 1,
    mutation_calls: 1,
    readback_get_calls: 0,
    semantic_read_post_calls: 0,
    total_http_calls: 2,
  });
});
