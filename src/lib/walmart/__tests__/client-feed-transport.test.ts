import assert from "node:assert/strict";
import { test } from "node:test";

import { WalmartClient } from "@/lib/walmart/client";

test("Walmart feed transport sends a multipart file without a manual boundary", async () => {
  const envKeys = [
    "WALMART_CLIENT_ID_STORE99",
    "WALMART_CLIENT_SECRET_STORE99",
    "WALMART_STORE99_SELLER_ID",
  ] as const;
  const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const priorFetch = globalThis.fetch;
  const priorLog = console.log;
  const requests: Array<{ input: string; init: RequestInit }> = [];

  process.env.WALMART_CLIENT_ID_STORE99 = "test-client";
  process.env.WALMART_CLIENT_SECRET_STORE99 = "test-secret";
  process.env.WALMART_STORE99_SELLER_ID = "test-seller";
  console.log = () => undefined;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ input: String(input), init: init ?? {} });
    if (requests.length === 1) {
      return new Response(
        JSON.stringify({ access_token: "token-99", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ feedId: "feed-99", status: "RECEIVED" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const client = new WalmartClient(99);
    const response = await client.requestRaw("POST", "/feeds", {
      params: { feedType: "MP_ITEM" },
      // A stale caller override must not suppress fetch's multipart boundary.
      headers: { "Content-Type": "application/json" },
      file: {
        content: JSON.stringify({ MPItem: [{ sku: "SKU-99" }] }),
        filename: "SKU-99-mp-item.json",
        contentType: "application/json",
      },
    });

    assert.equal(response.ok, true);
    assert.equal(requests.length, 2);
    assert.match(requests[1].input, /\/v3\/feeds\?feedType=MP_ITEM$/);
    const init = requests[1].init;
    assert.ok(init.body instanceof FormData);
    const headers = new Headers(init.headers);
    assert.equal(headers.has("content-type"), false);
    assert.equal(headers.get("wm_global_version"), "3.1");
    assert.equal(headers.get("wm_market"), "us");
    const file = (init.body as FormData).get("file");
    assert.ok(file instanceof Blob);
    assert.equal(file.type, "application/json");
    assert.equal(await file.text(), JSON.stringify({ MPItem: [{ sku: "SKU-99" }] }));
    assert.equal((file as Blob & { name?: string }).name, "SKU-99-mp-item.json");

    await assert.rejects(
      client.requestRaw("POST", "/feeds", {
        body: {},
        file: { content: "{}", filename: "item.json" },
      }),
      /cannot contain both body and file/i,
    );
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = priorFetch;
    console.log = priorLog;
    for (const key of envKeys) {
      const value = priorEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
