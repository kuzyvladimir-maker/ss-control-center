import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isMalformedVeeqoOrder,
  malformedFields,
  normalizeVeeqoResponse,
  repairMalformedOrders,
} from "../normalize";

const li = (id: number, sku = `S${id}`) => ({ id, quantity: 1, sellable: { sku_code: sku } });

// The real 2026-11-17 body: order A (2277485341) came back with
// `line_items` = another customer's whole order (order B, 2277125420, whose
// line 2625865649 is Taquitos 743269739341).
const orderB = () => ({
  id: 2277125420,
  number: "114-8255419-4685824",
  cancel_reason: null,
  line_items: [{ id: 2625865649, quantity: 2, sellable: { sku_code: "743269739341" } }],
});
const orderABroken = () => ({
  id: 2277485341,
  number: "113-4365835-6488256",
  line_items: orderB() as unknown,
  tags: [{ id: 13274001, name: "Placed" }],
});
const orderAHealthy = () => ({
  id: 2277485341,
  number: "113-4365835-6488256",
  line_items: [{ id: 2626000001, quantity: 1, sellable: { sku_code: "714671746159" } }],
  tags: [],
});

test("arrays are left exactly as they are; a healthy order is not marked", () => {
  const orders = [{ id: 1, line_items: [li(1)], tags: [{ id: 9, name: "Placed" }] }];
  const out = normalizeVeeqoResponse("/orders?status=awaiting_fulfillment", orders) as typeof orders;
  assert.equal(out, orders);
  assert.deepEqual(out[0].line_items, [li(1)]);
  assert.equal(isMalformedVeeqoOrder(out[0]), false);
});

test("2026-11-17: a nested order inside line_items is NEVER read as this order's items", () => {
  const orders = [orderAHealthy(), orderABroken()] as Array<Record<string, unknown>>;
  normalizeVeeqoResponse("/orders?status=awaiting_fulfillment&page=1", orders);
  // Iteration no longer crashes…
  const ids: number[] = [];
  for (const o of orders) for (const x of o.line_items as Array<{ id: number }>) ids.push(x.id);
  // …and order B's line 2625865649 does not leak into order A.
  assert.deepEqual(ids, [2626000001]);
  assert.deepEqual(orders[1].line_items, []);
  assert.equal(isMalformedVeeqoOrder(orders[1]), true);
  assert.deepEqual(malformedFields(orders[1]), ["line_items"]);
});

test("keyed maps / single records / junk are not guessed either", () => {
  for (const bad of [{ "11": li(11), "12": li(12) }, li(5), { data: [li(1)] }, "x", 7]) {
    const order = { id: 3, line_items: bad as unknown };
    normalizeVeeqoResponse("/orders/3", order);
    assert.deepEqual(order.line_items, []);
    assert.equal(isMalformedVeeqoOrder(order), true);
  }
});

test("single order: null stays null; broken allocation line_items marks the order", () => {
  const order = {
    id: 3,
    line_items: null,
    allocations: [{ id: 4, line_items: { "1": li(1) } as unknown }],
  };
  normalizeVeeqoResponse("/orders/3", order);
  assert.equal(order.line_items, null);
  assert.deepEqual(order.allocations[0].line_items, []);
  assert.deepEqual(malformedFields(order), ["allocations.line_items"]);
});

test("non-order paths are untouched", () => {
  const body = { line_items: { a: 1 } };
  assert.equal(normalizeVeeqoResponse("/products/5", body), body);
  assert.deepEqual(body.line_items, { a: 1 });
});

test("repair: a broken order in a list is replaced by a healthy re-read of the SAME id", async () => {
  const list = normalizeVeeqoResponse("/orders?page=1", [orderABroken()]) as unknown[];
  const asked: string[] = [];
  await repairMalformedOrders(list, async (id) => {
    asked.push(id);
    return normalizeVeeqoResponse(`/orders/${id}`, orderAHealthy());
  });
  assert.deepEqual(asked, ["2277485341"]);
  assert.equal(isMalformedVeeqoOrder(list[0]), false);
  assert.deepEqual(
    (list[0] as { line_items: Array<{ id: number }> }).line_items.map((x) => x.id),
    [2626000001],
  );
});

test("repair: still broken, a different id, or a failed re-read keeps the order marked", async () => {
  for (const refetch of [
    async () => normalizeVeeqoResponse("/orders/2277485341", orderABroken()),
    async () => normalizeVeeqoResponse("/orders/2277125420", orderB()),
    async () => {
      throw new Error("Veeqo API error 502");
    },
  ]) {
    const single = normalizeVeeqoResponse("/orders/2277485341", orderABroken());
    const out = await repairMalformedOrders(single, refetch);
    assert.equal(isMalformedVeeqoOrder(out), true);
    assert.deepEqual((out as { line_items: unknown[] }).line_items, []);
  }
});

test("repair: healthy bodies are never re-read", async () => {
  let calls = 0;
  await repairMalformedOrders([orderAHealthy()], async () => {
    calls++;
    return null;
  });
  assert.equal(calls, 0);
});
