import assert from "node:assert/strict";
import test from "node:test";

import {
  WALMART_CHANNEL_SUSPENDED,
  assertWalmartChannelActive,
} from "@/lib/walmart/channel-state";
import { WalmartClient } from "@/lib/walmart/client";

test("Walmart channel is source-controlled fail-closed", () => {
  assert.equal(WALMART_CHANNEL_SUSPENDED, true);
  assert.throws(
    () => assertWalmartChannelActive("test operation"),
    /WALMART_CHANNEL_SUSPENDED.*test operation/u,
  );
});

test("production cannot use the non-production transport-test escape hatch", () => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(
      () => assertWalmartChannelActive("test operation", { allowNonProductionTest: true }),
      /WALMART_CHANNEL_SUSPENDED/u,
    );
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
});

test("WalmartClient refuses before OAuth or any network request", async () => {
  const keys = [
    "WALMART_CLIENT_ID_STORE98",
    "WALMART_CLIENT_SECRET_STORE98",
    "WALMART_STORE98_SELLER_ID",
  ] as const;
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const priorFetch = globalThis.fetch;
  let networkCalls = 0;
  process.env.WALMART_CLIENT_ID_STORE98 = "test-client";
  process.env.WALMART_CLIENT_SECRET_STORE98 = "test-secret";
  process.env.WALMART_STORE98_SELLER_ID = "test-seller";
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("network must not run");
  }) as typeof fetch;
  try {
    const client = new WalmartClient(98);
    await assert.rejects(client.getAccessToken(), /WALMART_CHANNEL_SUSPENDED/u);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = priorFetch;
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
});
