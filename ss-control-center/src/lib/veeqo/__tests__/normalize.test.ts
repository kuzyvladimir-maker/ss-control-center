import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceList, normalizeVeeqoResponse } from "../normalize";

const li = (id: number) => ({ id, quantity: 1, sellable: { sku_code: `S${id}` } });

test("arrays are left exactly as they are", () => {
  const orders = [{ id: 1, line_items: [li(1)], tags: [{ id: 9, name: "Placed" }] }];
  const out = normalizeVeeqoResponse("/orders?status=awaiting_fulfillment", orders) as typeof orders;
  assert.equal(out, orders);
  assert.deepEqual(out[0].line_items, [li(1)]);
});

test("2026-11-17: an order whose line_items is an object no longer breaks iteration", () => {
  const orders: Array<Record<string, unknown>> = [
    { id: 1, number: "A-1", line_items: [li(1)] },
    { id: 2, number: "B-2", line_items: { "11": li(11), "12": li(12) } },
  ];
  normalizeVeeqoResponse("/orders?status=awaiting_fulfillment&page=1", orders);
  const ids: number[] = [];
  for (const o of orders) for (const x of o.line_items as Array<{ id: number }>) ids.push(x.id);
  assert.deepEqual(ids, [1, 11, 12]);
});

test("coerceList: envelope, single record, keyed map, junk", () => {
  assert.deepEqual(coerceList({ data: [li(1)] }), [li(1)]);
  assert.deepEqual(coerceList(li(5)), [li(5)]);
  assert.deepEqual(coerceList({ a: li(1), b: li(2) }), [li(1), li(2)]);
  assert.deepEqual(coerceList({}), []);
  assert.deepEqual(coerceList("x"), []);
  assert.deepEqual(coerceList(7), []);
});

test("single order body and allocation line_items are normalised; null stays null", () => {
  const order = {
    id: 3,
    line_items: null,
    allocations: [{ id: 4, line_items: { "1": li(1) } }],
  };
  normalizeVeeqoResponse("/orders/3", order);
  assert.equal(order.line_items, null);
  assert.deepEqual(order.allocations[0].line_items, [li(1)]);
});

test("non-order paths are untouched", () => {
  const body = { line_items: { a: 1 } };
  assert.equal(normalizeVeeqoResponse("/products/5", body), body);
  assert.deepEqual(body.line_items, { a: 1 });
});
