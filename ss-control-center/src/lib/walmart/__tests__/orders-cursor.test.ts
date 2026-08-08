/**
 * Walmart /v3/orders pagination contract.
 *
 *   node --import tsx --test src/lib/walmart/__tests__/orders-cursor.test.ts
 *
 * Regression guard for the bug that capped every deep order walk at ~2 pages:
 * `meta.nextCursor` is a ready-made query string that must be APPENDED TO THE
 * PATH. Sent as `?nextCursor=<urlencoded>` Walmart answers 200 and silently
 * re-serves page 1, so callers saw duplicates and an early null cursor.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { WalmartOrdersApi } from "../orders";

const CURSOR =
  "?limit=200&hasMoreElements=true&soIndex=3016&cursor=QW9K&poIndex=200&createdStartDate=2026-02-09T16:23:20.668Z";

/** Minimal WalmartClient stand-in that records the call it was handed. */
function stubClient() {
  const calls: Array<{ method: string; path: string; params: unknown }> = [];
  const client = {
    request: async (method: string, path: string, opts?: { params?: unknown }) => {
      calls.push({ method, path, params: opts?.params });
      return { list: { meta: { totalCount: 3016, nextCursor: null }, elements: { order: [] } } };
    },
  };
  return { calls, api: new WalmartOrdersApi(client as never) };
}

test("a cursor page appends the cursor to the path and sends no params", async () => {
  const { calls, api } = stubClient();
  await api.getAllOrders({ nextCursor: CURSOR });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/orders${CURSOR}`);
  assert.deepEqual(calls[0].params, {});
});

test("a cursor missing its leading '?' still produces a valid query string", async () => {
  const { calls, api } = stubClient();
  await api.getAllOrders({ nextCursor: CURSOR.slice(1) });
  assert.equal(calls[0].path, `/orders${CURSOR}`);
});

test("released orders paginate the same way", async () => {
  const { calls, api } = stubClient();
  await api.getReleasedOrders({ nextCursor: CURSOR });
  assert.equal(calls[0].path, `/orders/released${CURSOR}`);
});

test("a first page sends its filters and no cursor", async () => {
  const { calls, api } = stubClient();
  await api.getAllOrders({ createdStartDate: "2026-07-01T00:00:00Z", status: "Shipped", limit: 200 });
  assert.equal(calls[0].path, "/orders");
  assert.deepEqual(calls[0].params, {
    createdStartDate: "2026-07-01T00:00:00Z",
    status: "Shipped",
    limit: 200,
  });
});

test("the cursor wins over any filter passed alongside it", async () => {
  // Walmart rejects/ignores filters sent with a cursor — the cursor already
  // encodes them. Callers that pass both must not corrupt the request.
  const { calls, api } = stubClient();
  await api.getAllOrders({ nextCursor: CURSOR, createdStartDate: "2026-01-01", limit: 50 });
  assert.equal(calls[0].path, `/orders${CURSOR}`);
  assert.deepEqual(calls[0].params, {});
});
