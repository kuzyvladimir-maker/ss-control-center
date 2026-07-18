import assert from "node:assert/strict";
import { test } from "node:test";

import { spApiGet } from "../client";

function jsonResponse(
  body: Record<string, unknown>,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

test("SP-API AbortSignal is terminal across auth, fetch, and 429 backoff", async (t) => {
  const originalFetch = globalThis.fetch;
  const envKeys = [
    "AMAZON_SP_REFRESH_TOKEN_STORE1",
    "AMAZON_SP_CLIENT_ID_STORE1",
    "AMAZON_SP_CLIENT_SECRET_STORE1",
  ] as const;
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.AMAZON_SP_REFRESH_TOKEN_STORE1 = "test-refresh";
  process.env.AMAZON_SP_CLIENT_ID_STORE1 = "test-client";
  process.env.AMAZON_SP_CLIENT_SECRET_STORE1 = "test-secret";

  try {
    await t.test("an already-aborted cold-token request makes zero fetches", async () => {
      let fetches = 0;
      globalThis.fetch = (async () => {
        fetches++;
        throw new Error("fetch must not run");
      }) as typeof fetch;
      const controller = new AbortController();
      controller.abort(new DOMException("pre-aborted", "AbortError"));
      await assert.rejects(
        spApiGet("/abort-before-auth", {
          storeId: "store1",
          retries: 3,
          signal: controller.signal,
        }),
        /pre-aborted/,
      );
      assert.equal(fetches, 0);
    });

    await t.test("a successful request primes the token cache and forwards signal", async () => {
      let lwaCalls = 0;
      let spCalls = 0;
      const controller = new AbortController();
      let forwardedSignal: AbortSignal | null | undefined;
      globalThis.fetch = (async (resource, init) => {
        if (String(resource).startsWith("https://api.amazon.com/")) {
          lwaCalls++;
          assert.equal(init?.signal, controller.signal);
          return jsonResponse({ access_token: "cached-test-token" });
        }
        spCalls++;
        forwardedSignal = init?.signal;
        return jsonResponse({ ok: true });
      }) as typeof fetch;
      const response = await spApiGet("/prime-token", {
        storeId: "store1",
        retries: 1,
        signal: controller.signal,
      });
      assert.deepEqual(response, { ok: true });
      assert.equal(lwaCalls, 1);
      assert.equal(spCalls, 1);
      assert.equal(forwardedSignal, controller.signal);
    });

    await t.test("an already-aborted cached-token request makes zero fetches", async () => {
      let fetches = 0;
      globalThis.fetch = (async () => {
        fetches++;
        throw new Error("cached abort must stop before fetch");
      }) as typeof fetch;
      const controller = new AbortController();
      controller.abort(new DOMException("cached-pre-abort", "AbortError"));
      await assert.rejects(
        spApiGet("/cached-pre-abort", {
          storeId: "store1",
          retries: 3,
          signal: controller.signal,
        }),
        /cached-pre-abort/,
      );
      assert.equal(fetches, 0);
    });

    await t.test("abort of an in-flight SP GET is never retried", async () => {
      let spCalls = 0;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      globalThis.fetch = (async (_resource, init) => {
        spCalls++;
        markStarted();
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          assert.ok(signal);
          const onAbort = () =>
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      }) as typeof fetch;
      const controller = new AbortController();
      const request = spApiGet("/pending", {
        storeId: "store1",
        retries: 3,
        signal: controller.signal,
      });
      await started;
      controller.abort(new DOMException("stop-pending", "AbortError"));
      await assert.rejects(request, /stop-pending/);
      assert.equal(spCalls, 1);
    });

    await t.test("abort interrupts Retry-After sleep and prevents retry", async () => {
      let spCalls = 0;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      globalThis.fetch = (async () => {
        spCalls++;
        markStarted();
        return jsonResponse(
          { message: "rate limited" },
          { status: 429, headers: { "retry-after": "30" } },
        );
      }) as typeof fetch;
      const controller = new AbortController();
      const request = spApiGet("/rate-limited", {
        storeId: "store1",
        retries: 3,
        signal: controller.signal,
      });
      await started;
      await Promise.resolve();
      controller.abort(new DOMException("stop-backoff", "AbortError"));
      await assert.rejects(request, /stop-backoff/);
      assert.equal(spCalls, 1);
    });

    await t.test("a synthetic AbortError is terminal even before signal flips", async () => {
      let spCalls = 0;
      globalThis.fetch = (async () => {
        spCalls++;
        throw new DOMException("synthetic-abort", "AbortError");
      }) as typeof fetch;
      await assert.rejects(
        spApiGet("/synthetic-abort", {
          storeId: "store1",
          retries: 3,
          signal: new AbortController().signal,
        }),
        /synthetic-abort/,
      );
      assert.equal(spCalls, 1);
    });

    await t.test("a final 429 throws instead of returning undefined", async () => {
      let spCalls = 0;
      globalThis.fetch = (async () => {
        spCalls++;
        return jsonResponse({ message: "still limited" }, { status: 429 });
      }) as typeof fetch;
      await assert.rejects(
        spApiGet("/final-rate-limit", { storeId: "store1", retries: 1 }),
        /rate limited on final attempt 1\/1/,
      );
      assert.equal(spCalls, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
