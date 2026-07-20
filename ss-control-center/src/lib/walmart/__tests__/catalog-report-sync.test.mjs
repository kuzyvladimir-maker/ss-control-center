import assert from "node:assert/strict";
import test from "node:test";

import {
  ITEM_REPORT_CREATE_RETIRED_REASON,
  driveItemCatalogReport,
} from "../catalog-report-sync.ts";

test("legacy ITEM drive never POSTs or creates a DB row when a fresh request is needed", async (t) => {
  const staleRequestedAt = new Date("2026-01-01T00:00:00.000Z");
  for (const [label, latest] of [
    ["missing report", null],
    ["stale downloaded report", {
      id: "downloaded-report",
      requestId: "downloaded-request-id",
      requestedAt: staleRequestedAt,
      status: "DOWNLOADED",
    }],
    ["stale errored report", {
      id: "errored-report",
      requestId: "errored-request-id",
      requestedAt: staleRequestedAt,
      status: "ERROR",
    }],
  ]) {
    await t.test(label, async () => {
      let transportCalls = 0;
      let reportCreateCalls = 0;
      const prisma = {
        walmartReport: {
          findFirst: async () => latest,
          create: async () => {
            reportCreateCalls += 1;
            throw new Error("legacy drive must not create WalmartReport rows");
          },
        },
      };
      const client = {
        requestRaw: async () => {
          transportCalls += 1;
          throw new Error("legacy drive must not call Walmart transport");
        },
      };

      const result = await driveItemCatalogReport(prisma, client, 1);

      assert.equal(result.action, "idle");
      assert.equal(result.status, latest?.status);
      assert.equal(result.reason, ITEM_REPORT_CREATE_RETIRED_REASON);
      assert.equal(
        result.message,
        "legacy ITEM report creation is retired; an owner-permitted canonical capture is required",
      );
      assert.equal(transportCalls, 0);
      assert.equal(reportCreateCalls, 0);
    });
  }
});

test("legacy ITEM drive may poll an existing in-flight request but still never POSTs", async () => {
  const methods = [];
  let reportCreateCalls = 0;
  let reportUpdateCalls = 0;
  const prisma = {
    walmartReport: {
      findFirst: async () => ({
        id: "existing-report",
        requestId: "existing-request-id",
        requestedAt: new Date("2026-01-01T00:00:00.000Z"),
        status: "INPROGRESS",
      }),
      create: async () => {
        reportCreateCalls += 1;
        throw new Error("legacy drive must not create WalmartReport rows");
      },
      update: async () => {
        reportUpdateCalls += 1;
      },
    },
  };
  const client = {
    requestRaw: async (method) => {
      methods.push(method);
      return {
        ok: true,
        status: 200,
        body: { requestStatus: "INPROGRESS" },
      };
    },
  };

  const result = await driveItemCatalogReport(prisma, client, 1);

  assert.equal(result.action, "polled");
  assert.deepEqual(methods, ["GET"]);
  assert.equal(reportCreateCalls, 0);
  assert.equal(reportUpdateCalls, 1);
});
