import assert from "node:assert/strict";
import test from "node:test";

import { computeWalmartSellerAccountFingerprint } from "../item-report-capture-session.ts";
import {
  createWalmartListingRepairNativeTransportForTest,
  WalmartListingRepairNativeTransportError,
} from "../listing-integrity-remediation-transport.ts";
import {
  WALMART_LISTING_REPAIR_MAX_FEED_STATUS_BYTES,
  WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES,
} from "../listing-integrity-remediation-writer.ts";

Object.assign(process.env, {
  NODE_ENV: "test",
  WALMART_LISTING_REPAIR_TEST_MODE: "1",
});

const CREDENTIALS = Object.freeze({
  client_id: "fixture-client-id",
  client_secret: "fixture-client-secret",
  seller_id: "fixture-seller-id",
});

const UUIDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
];

function uuidSource(): () => string {
  let index = 0;
  return () => UUIDS[index++] ?? `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function tokenResponse(status = 200): Response {
  return new Response(
    status === 200 ? JSON.stringify({ access_token: "fixture-access-token" }) : "denied",
    { status, headers: { "content-type": "application/json" } },
  );
}

function postInput() {
  return {
    path: "/v3/feeds" as const,
    query: { feedType: "MP_MAINTENANCE" as const },
    request_payload_bytes: Buffer.from('{"MPItem":[{"sku":"SKU-1"}]}', "utf8"),
    filename: "SKU-1-maintenance.json",
    content_type: "application/json" as const,
    correlation_id: "repair-post-correlation-1",
    redirect: "error" as const,
    retries: 0 as const,
    timeout_ms: 1000,
    max_response_bytes: WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES,
  };
}

function getInput(feedId = "feed-123") {
  return {
    path: `/v3/feeds/${encodeURIComponent(feedId)}`,
    query: { includeDetails: "true" as const },
    feed_id: feedId,
    correlation_id: "repair-get-correlation-1",
    redirect: "error" as const,
    retries: 0 as const,
    timeout_ms: 1000,
    max_response_bytes: WALMART_LISTING_REPAIR_MAX_FEED_STATUS_BYTES,
  };
}

function errorCode(error: unknown): string | null {
  return error instanceof WalmartListingRepairNativeTransportError ? error.code : null;
}

test("constructor is zero-network and account binding comes from exact OAuth credentials", () => {
  let calls = 0;
  const transport = createWalmartListingRepairNativeTransportForTest({
    store_index: 7,
    credentials: CREDENTIALS,
    fetch_impl: (async () => {
      calls += 1;
      throw new Error("must not fetch during construction");
    }) as typeof fetch,
    random_uuid: uuidSource(),
  });

  assert.equal(calls, 0);
  assert.deepEqual(transport.getCallCounts(), {
    oauth_token_calls: 0,
    maintenance_post_calls: 0,
    feed_status_get_calls: 0,
    total_http_calls: 0,
  });
  assert.deepEqual(transport.getAccountBinding(), {
    channel: "WALMART_US",
    store_index: 7,
    seller_id: CREDENTIALS.seller_id,
    seller_account_fingerprint_sha256: computeWalmartSellerAccountFingerprint({
      store_index: 7,
      client_id: CREDENTIALS.client_id,
      seller_id: CREDENTIALS.seller_id,
    }),
  });
});

test("one token is reused for one POST and bounded GETs; every native call forbids redirects", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(request), init: init ?? {} });
    if (calls.length === 1) return tokenResponse();
    if (calls.length === 2) {
      return new Response(JSON.stringify({ feedId: "feed-123" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ feedId: "feed-123", feedStatus: "RECEIVED" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const transport = createWalmartListingRepairNativeTransportForTest({
    store_index: 1,
    credentials: CREDENTIALS,
    fetch_impl: fetchImpl as typeof fetch,
    random_uuid: uuidSource(),
  });

  const post = await transport.postMaintenance(postInput());
  const get = await transport.getFeedStatus(getInput());

  assert.equal(post.status, 201);
  assert.equal(get.status, 200);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(({ init }) => init.redirect), ["error", "error", "error"]);
  assert.deepEqual(calls.map(({ url }) => url), [
    "https://marketplace.walmartapis.com/v3/token",
    "https://marketplace.walmartapis.com/v3/feeds?feedType=MP_MAINTENANCE",
    "https://marketplace.walmartapis.com/v3/feeds/feed-123?includeDetails=true",
  ]);
  assert.equal(calls[1]?.init.method, "POST");
  const multipart = Buffer.from(calls[1]?.init.body as Uint8Array).toString("utf8");
  assert.match(multipart, /name="file"; filename="SKU-1-maintenance\.json"/u);
  assert.match(multipart, /\{"MPItem":\[\{"sku":"SKU-1"\}\]\}/u);
  assert.deepEqual(transport.getCallCounts(), {
    oauth_token_calls: 1,
    maintenance_post_calls: 1,
    feed_status_get_calls: 1,
    total_http_calls: 3,
  });
});

test("a second POST is impossible even after the first POST returned", async () => {
  let calls = 0;
  const transport = createWalmartListingRepairNativeTransportForTest({
    store_index: 1,
    credentials: CREDENTIALS,
    fetch_impl: (async () => {
      calls += 1;
      return calls === 1
        ? tokenResponse()
        : new Response(JSON.stringify({ feedId: "feed-123" }), { status: 201 });
    }) as typeof fetch,
    random_uuid: uuidSource(),
  });

  await transport.postMaintenance(postInput());
  await assert.rejects(
    transport.postMaintenance(postInput()),
    (error: unknown) => errorCode(error) === "SECOND_POST_FORBIDDEN",
  );
  assert.equal(calls, 2);
  assert.equal(transport.getCallCounts().maintenance_post_calls, 1);
});

test("OAuth failure is attempted once and never reaches maintenance POST", async () => {
  let calls = 0;
  const transport = createWalmartListingRepairNativeTransportForTest({
    store_index: 1,
    credentials: CREDENTIALS,
    fetch_impl: (async () => {
      calls += 1;
      return tokenResponse(401);
    }) as typeof fetch,
    random_uuid: uuidSource(),
  });

  await assert.rejects(
    transport.postMaintenance(postInput()),
    (error: unknown) => errorCode(error) === "OAUTH_HTTP_FAILURE",
  );
  assert.equal(calls, 1);
  assert.deepEqual(transport.getCallCounts(), {
    oauth_token_calls: 1,
    maintenance_post_calls: 0,
    feed_status_get_calls: 0,
    total_http_calls: 1,
  });
});

test("HTTP 429 is returned once without refresh or retry", async () => {
  let calls = 0;
  const transport = createWalmartListingRepairNativeTransportForTest({
    store_index: 1,
    credentials: CREDENTIALS,
    fetch_impl: (async () => {
      calls += 1;
      return calls === 1 ? tokenResponse() : new Response("limited", { status: 429 });
    }) as typeof fetch,
    random_uuid: uuidSource(),
  });

  const response = await transport.postMaintenance(postInput());
  assert.equal(response.status, 429);
  assert.equal(calls, 2);
  assert.deepEqual(transport.getCallCounts(), {
    oauth_token_calls: 1,
    maintenance_post_calls: 1,
    feed_status_get_calls: 0,
    total_http_calls: 2,
  });
});

test("unknown POST network outcome is counted exactly once and never retried", async () => {
  let calls = 0;
  const transport = createWalmartListingRepairNativeTransportForTest({
    store_index: 1,
    credentials: CREDENTIALS,
    fetch_impl: (async () => {
      calls += 1;
      if (calls === 1) return tokenResponse();
      throw new TypeError("socket closed");
    }) as typeof fetch,
    random_uuid: uuidSource(),
  });

  await assert.rejects(
    transport.postMaintenance(postInput()),
    (error: unknown) => errorCode(error) === "MAINTENANCE_POST_NETWORK_FAILURE",
  );
  assert.equal(calls, 2);
  assert.equal(transport.getCallCounts().maintenance_post_calls, 1);
});

test("streaming response cap fails closed after the single HTTP attempt", async () => {
  let calls = 0;
  const oversized = new Uint8Array(WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES + 1);
  const transport = createWalmartListingRepairNativeTransportForTest({
    store_index: 1,
    credentials: CREDENTIALS,
    fetch_impl: (async () => {
      calls += 1;
      return calls === 1 ? tokenResponse() : new Response(oversized, { status: 201 });
    }) as typeof fetch,
    random_uuid: uuidSource(),
  });

  await assert.rejects(
    transport.postMaintenance(postInput()),
    (error: unknown) => errorCode(error) === "RESPONSE_SIZE_CAP",
  );
  assert.equal(calls, 2);
  assert.equal(transport.getCallCounts().maintenance_post_calls, 1);
});

test("feed GET path must be the exact encoded accepted feed ID", async () => {
  let calls = 0;
  const transport = createWalmartListingRepairNativeTransportForTest({
    store_index: 1,
    credentials: CREDENTIALS,
    fetch_impl: (async () => {
      calls += 1;
      return tokenResponse();
    }) as typeof fetch,
    random_uuid: uuidSource(),
  });
  const wrong = { ...getInput("feed/with/slash"), path: "/v3/feeds/feed/with/slash" };

  await assert.rejects(
    transport.getFeedStatus(wrong),
    (error: unknown) => errorCode(error) === "INVALID_TRANSPORT_REQUEST",
  );
  assert.equal(calls, 0);
  assert.deepEqual(transport.getCallCounts(), {
    oauth_token_calls: 0,
    maintenance_post_calls: 0,
    feed_status_get_calls: 0,
    total_http_calls: 0,
  });
});
