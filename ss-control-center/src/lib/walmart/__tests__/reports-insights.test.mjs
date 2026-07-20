import assert from "node:assert/strict";
import test from "node:test";

import { requestReport } from "../reports-insights.ts";

test("requestReport rejects ITEM before the generic client or network can run", async () => {
  let calls = 0;
  const client = {
    async requestRaw() {
      calls += 1;
      throw new Error("transport must not run");
    },
  };

  await assert.rejects(
    requestReport(client, "ITEM"),
    /UNAUTHORIZED_WALMART_REPORT_TYPE/u,
  );
  assert.equal(calls, 0);
});

for (const reportType of ["BUYBOX", "ITEM_PERFORMANCE"]) {
  test(`requestReport permits the bounded insights type ${reportType}`, async () => {
    const requests = [];
    const client = {
      async requestRaw(method, path, options) {
        requests.push({ method, path, options });
        return {
          status: 200,
          ok: true,
          body: { requestId: `request-${reportType}` },
          correlationId: "test-correlation",
        };
      },
    };

    assert.equal(await requestReport(client, reportType), `request-${reportType}`);
    assert.deepEqual(requests, [{
      method: "POST",
      path: "/reports/reportRequests",
      options: {
        params: { reportType, reportVersion: "v1" },
        body: {},
        headers: { "Content-Type": "application/json" },
        noRetryOn429: true,
      },
    }]);
  });
}
