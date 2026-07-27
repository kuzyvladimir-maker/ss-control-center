import assert from "node:assert/strict";
import { test } from "node:test";

import { getMerchantToken } from "../sellers";

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("cold seller-id lookup shares the observation AbortSignal and never retries", async () => {
  const originalFetch = globalThis.fetch;
  const envKeys = [
    "AMAZON_SP_REFRESH_TOKEN_STORE5",
    "AMAZON_SP_CLIENT_ID_STORE5",
    "AMAZON_SP_CLIENT_SECRET_STORE5",
  ] as const;
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.AMAZON_SP_REFRESH_TOKEN_STORE5 = "seller-abort-refresh";
  process.env.AMAZON_SP_CLIENT_ID_STORE5 = "seller-abort-client";
  process.env.AMAZON_SP_CLIENT_SECRET_STORE5 = "seller-abort-secret";

  let lwaCalls = 0;
  let sellersCalls = 0;
  let markSellersStarted!: () => void;
  const sellersStarted = new Promise<void>((resolve) => {
    markSellersStarted = resolve;
  });
  const controller = new AbortController();

  try {
    globalThis.fetch = (async (resource, init) => {
      assert.equal(init?.signal, controller.signal);
      if (String(resource).startsWith("https://api.amazon.com/")) {
        lwaCalls++;
        return jsonResponse({ access_token: "seller-abort-access-token" });
      }

      assert.match(
        String(resource),
        /\/sellers\/v1\/marketplaceParticipations/,
      );
      sellersCalls++;
      markSellersStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        const onAbort = () =>
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof fetch;

    const lookup = getMerchantToken(5, controller.signal);
    await sellersStarted;
    controller.abort(new DOMException("stop-cold-seller-lookup", "AbortError"));

    await assert.rejects(lookup, /stop-cold-seller-lookup/);
    assert.equal(lwaCalls, 1);
    assert.equal(sellersCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
