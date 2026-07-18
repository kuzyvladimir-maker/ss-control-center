import assert from "node:assert/strict";
import { test } from "node:test";

import { patchListing } from "../listings";

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("real Listings PATCH is single-attempt while validation preview may retry", async () => {
  const originalFetch = globalThis.fetch;
  const envKeys = [
    "AMAZON_SP_REFRESH_TOKEN_STORE4",
    "AMAZON_SP_CLIENT_ID_STORE4",
    "AMAZON_SP_CLIENT_SECRET_STORE4",
  ] as const;
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.AMAZON_SP_REFRESH_TOKEN_STORE4 = "patch-once-refresh";
  process.env.AMAZON_SP_CLIENT_ID_STORE4 = "patch-once-client";
  process.env.AMAZON_SP_CLIENT_SECRET_STORE4 = "patch-once-secret";

  let lwaCalls = 0;
  let patchCalls = 0;
  try {
    globalThis.fetch = (async (resource, init) => {
      if (String(resource).startsWith("https://api.amazon.com/")) {
        lwaCalls++;
        return jsonResponse({ access_token: "patch-once-access-token" });
      }
      patchCalls++;
      assert.equal(init?.method, "PATCH");
      assert.doesNotMatch(String(resource), /[?&]mode=VALIDATION_PREVIEW(?:&|$)/);
      throw new TypeError("simulated lost PATCH response");
    }) as typeof fetch;

    await assert.rejects(
      patchListing(
        4,
        "A1PATCHONCE",
        "SKU-PATCH-ONCE",
        "GROCERY",
        [
          {
            op: "merge",
            path: "/attributes/purchasable_offer",
            value: [],
          },
        ],
        { validationPreview: false, retries: 1 },
      ),
      /simulated lost PATCH response/,
    );
    assert.equal(lwaCalls, 1);
    assert.equal(patchCalls, 1);

    let abortPatchCalls = 0;
    let markAbortPatchStarted!: () => void;
    const abortPatchStarted = new Promise<void>((resolve) => {
      markAbortPatchStarted = resolve;
    });
    const controller = new AbortController();
    globalThis.fetch = (async (_resource, init) => {
      abortPatchCalls++;
      assert.equal(init?.method, "PATCH");
      assert.equal(init?.signal, controller.signal);
      markAbortPatchStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        const onAbort = () =>
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof fetch;
    const boundedPatch = patchListing(
      4,
      "A1PATCHONCE",
      "SKU-PATCH-ABORT",
      "GROCERY",
      [
        {
          op: "merge",
          path: "/attributes/purchasable_offer",
          value: [],
        },
      ],
      { validationPreview: false, retries: 1, signal: controller.signal },
    );
    await abortPatchStarted;
    controller.abort(new DOMException("bounded-patch-timeout", "AbortError"));
    await assert.rejects(boundedPatch, /bounded-patch-timeout/);
    assert.equal(abortPatchCalls, 1);

    let previewCalls = 0;
    globalThis.fetch = (async (resource, init) => {
      previewCalls++;
      assert.equal(init?.method, "PATCH");
      assert.match(String(resource), /[?&]mode=VALIDATION_PREVIEW(?:&|$)/);
      if (previewCalls === 1) {
        return new Response(JSON.stringify({ message: "rate limited" }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "0",
          },
        });
      }
      return jsonResponse({ status: "VALID" });
    }) as typeof fetch;

    const preview = await patchListing(
      4,
      "A1PATCHONCE",
      "SKU-PREVIEW-RETRY",
      "GROCERY",
      [
        {
          op: "merge",
          path: "/attributes/purchasable_offer",
          value: [],
        },
      ],
      { validationPreview: true, retries: 2 },
    );
    assert.equal(preview.status, "VALID");
    assert.equal(previewCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("physical PATCH guard runs after cold token refresh and before SP-API fetch", async () => {
  const originalFetch = globalThis.fetch;
  const envKeys = [
    "AMAZON_SP_REFRESH_TOKEN_STORE5",
    "AMAZON_SP_CLIENT_ID_STORE5",
    "AMAZON_SP_CLIENT_SECRET_STORE5",
  ] as const;
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.AMAZON_SP_REFRESH_TOKEN_STORE5 = "guard-refresh";
  process.env.AMAZON_SP_CLIENT_ID_STORE5 = "guard-client";
  process.env.AMAZON_SP_CLIENT_SECRET_STORE5 = "guard-secret";

  let lwaCalls = 0;
  let spCalls = 0;
  let guardCalls = 0;
  try {
    globalThis.fetch = (async (resource) => {
      if (String(resource).startsWith("https://api.amazon.com/")) {
        lwaCalls++;
        return jsonResponse({ access_token: "guard-access-token" });
      }
      spCalls++;
      return jsonResponse({ status: "ACCEPTED" });
    }) as typeof fetch;

    await assert.rejects(
      patchListing(
        5,
        "A1GUARDSELLER",
        "SKU-GUARD",
        "GROCERY",
        [
          {
            op: "merge",
            path: "/attributes/purchasable_offer",
            value: [],
          },
        ],
        {
          validationPreview: false,
          retries: 1,
          beforeRequest: () => {
            guardCalls++;
            throw new Error("launch authorization expired during token refresh");
          },
        },
      ),
      /expired during token refresh/,
    );
    assert.equal(lwaCalls, 1);
    assert.equal(guardCalls, 1);
    assert.equal(spCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
