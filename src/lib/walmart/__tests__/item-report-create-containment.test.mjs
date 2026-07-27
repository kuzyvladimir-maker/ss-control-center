import assert from "node:assert/strict";
import test from "node:test";

import { WalmartClient } from "../client.ts";

for (const methodName of ["request", "requestRaw"]) {
  test(`WalmartClient.${methodName} blocks ITEM report creation before OAuth`, async () => {
    let oauthCalls = 0;
    const client = Object.create(WalmartClient.prototype);
    client.getAccessToken = async () => {
      oauthCalls += 1;
      throw new Error("OAuth must not run");
    };

    await assert.rejects(
      WalmartClient.prototype[methodName].call(
        client,
        "POST",
        "/reports/reportRequests",
        { params: { reportType: "ITEM", reportVersion: "v6" }, body: {} },
      ),
      /LEGACY_ITEM_REPORT_CREATE_RETIRED_OWNER_PERMIT_REQUIRED/u,
    );
    assert.equal(oauthCalls, 0);
  });
}

const bypassShapes = [
  {
    label: "no leading slash",
    path: "reports/reportRequests",
    options: { params: { reportType: "ITEM", reportVersion: "v6" }, body: {} },
  },
  {
    label: "explicit v3 prefix",
    path: "/v3/reports/reportRequests",
    options: { params: { reportType: "item", reportVersion: "v6" }, body: {} },
  },
  {
    label: "embedded query",
    path: "/reports/reportRequests?reportType=%49%54%45%4d&reportVersion=v6",
    options: { body: {} },
  },
  {
    label: "conflicting embedded and params",
    path: "/reports/reportRequests?reportType=BUYBOX&reportVersion=v1",
    options: { params: { reportType: "ITEM" }, body: {} },
  },
  {
    label: "boxed runtime value",
    path: "/reports/reportRequests",
    options: { params: { reportType: new String("ITEM") }, body: {} },
  },
  {
    label: "dot segment normalized by URL",
    path: "/reports/../reports/reportRequests",
    options: { params: { reportType: "ITEM" }, body: {} },
  },
  {
    label: "encoded dot segment normalized by URL",
    path: "/reports/%2e%2e/reports/reportRequests",
    options: { params: { reportType: "ITEM" }, body: {} },
  },
  {
    label: "parent segment before explicit v3",
    path: "/../v3/reports/reportRequests",
    options: { params: { reportType: "ITEM" }, body: {} },
  },
  {
    label: "repeated and trailing slash",
    path: "//reports///reportRequests/",
    options: { params: { reportType: "ITEM" }, body: {} },
  },
];

for (const shape of bypassShapes) {
  test(`WalmartClient blocks ITEM create bypass shape: ${shape.label}`, async () => {
    let oauthCalls = 0;
    const client = Object.create(WalmartClient.prototype);
    client.getAccessToken = async () => {
      oauthCalls += 1;
      throw new Error("OAuth must not run");
    };

    await assert.rejects(
      WalmartClient.prototype.requestRaw.call(
        client,
        "post",
        shape.path,
        shape.options,
      ),
      /(LEGACY_ITEM_REPORT_CREATE_RETIRED_OWNER_PERMIT_REQUIRED|AMBIGUOUS_WALMART_REPORT_TYPE)/u,
    );
    assert.equal(oauthCalls, 0);
  });
}

test("WalmartClient rejects conflicting non-ITEM report type sources before OAuth", async () => {
  let oauthCalls = 0;
  const client = Object.create(WalmartClient.prototype);
  client.getAccessToken = async () => {
    oauthCalls += 1;
    throw new Error("OAuth must not run");
  };
  await assert.rejects(
    WalmartClient.prototype.requestRaw.call(
      client,
      "POST",
      "/reports/reportRequests?reportType=BUYBOX",
      { params: { reportType: "ITEM_PERFORMANCE" }, body: {} },
    ),
    /AMBIGUOUS_WALMART_REPORT_TYPE/u,
  );
  assert.equal(oauthCalls, 0);
});

test("WalmartClient snapshots the authorized query before deferred OAuth", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(JSON.stringify({ requestId: "buybox-request" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let releaseToken;
  const tokenPromise = new Promise((resolve) => { releaseToken = resolve; });
  const client = Object.create(WalmartClient.prototype);
  client.storeIndex = 1;
  client.rateLimitWaitUntil = null;
  client.token = null;
  client.getAccessToken = () => tokenPromise;
  const params = { reportType: "BUYBOX", reportVersion: "v1" };

  const pending = WalmartClient.prototype.requestRaw.call(
    client,
    "POST",
    "/reports/reportRequests",
    { params, body: {}, noRetryOn429: true },
  );
  params.reportType = "ITEM";
  releaseToken({ accessToken: "test-token", expiresAt: new Date("2026-07-18T11:00:00.000Z") });
  await pending;

  assert.equal(fetched.length, 1);
  assert.match(fetched[0], /reportType=BUYBOX/u);
  assert.doesNotMatch(fetched[0], /reportType=ITEM(?:&|$)/u);
});

test("WalmartClient reads a reportType getter once into the guarded query snapshot", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(JSON.stringify({ requestId: "buybox-request" }), { status: 200 });
  };
  let reads = 0;
  const params = { reportVersion: "v1" };
  Object.defineProperty(params, "reportType", {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? "BUYBOX" : "ITEM";
    },
  });
  const client = Object.create(WalmartClient.prototype);
  client.storeIndex = 1;
  client.rateLimitWaitUntil = null;
  client.token = null;
  client.getAccessToken = async () => ({
    accessToken: "test-token",
    expiresAt: new Date("2026-07-18T11:00:00.000Z"),
  });

  await WalmartClient.prototype.requestRaw.call(
    client,
    "POST",
    "/reports/reportRequests",
    { params, body: {}, noRetryOn429: true },
  );
  assert.equal(reads, 1);
  assert.equal(fetched.length, 1);
  assert.match(fetched[0], /reportType=BUYBOX/u);
});

test("WalmartClient snapshots stateful method and path coercions before OAuth", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const fetched = [];
  globalThis.fetch = async (url, options) => {
    fetched.push({ url: String(url), method: String(options.method) });
    return new Response(JSON.stringify({ requestId: "buybox-request" }), { status: 200 });
  };
  let methodReads = 0;
  const statefulMethod = {
    toString() {
      methodReads += 1;
      return methodReads === 1 ? "POST" : "DELETE";
    },
  };
  let pathReads = 0;
  const statefulPath = {
    toString() {
      pathReads += 1;
      return pathReads === 1
        ? "/reports/reportRequests?reportType=BUYBOX&reportVersion=v1"
        : "/reports/reportRequests?reportType=ITEM&reportVersion=v6";
    },
    startsWith() {
      return true;
    },
  };
  const client = Object.create(WalmartClient.prototype);
  client.storeIndex = 1;
  client.rateLimitWaitUntil = null;
  client.token = null;
  client.getAccessToken = async () => ({
    accessToken: "test-token",
    expiresAt: new Date("2026-07-18T11:00:00.000Z"),
  });

  await WalmartClient.prototype.requestRaw.call(
    client,
    statefulMethod,
    statefulPath,
    { body: {}, noRetryOn429: true },
  );
  assert.equal(methodReads, 1);
  assert.equal(pathReads, 1);
  assert.deepEqual(fetched, [{
    url: "https://marketplace.walmartapis.com/v3/reports/reportRequests?reportType=BUYBOX&reportVersion=v1",
    method: "POST",
  }]);
});
