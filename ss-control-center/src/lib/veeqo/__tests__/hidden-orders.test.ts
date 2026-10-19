import { test } from "node:test";
import assert from "node:assert/strict";
import { isHiddenVeeqoOrder, withoutHiddenOrders } from "../hidden-orders";

test("StillFrozen technical order is hidden by id or by number", () => {
  assert.equal(isHiddenVeeqoOrder({ id: 2164588032 }), true);
  assert.equal(isHiddenVeeqoOrder({ id: "2164588032" }), true);
  assert.equal(isHiddenVeeqoOrder({ number: "TEST-RATE-DELETE-ME-2" }), true);
});

test("real orders pass through untouched", () => {
  const real = [{ id: 2205444731, number: "112-0584771-5549011" }];
  const mixed = [...real, { id: 2164588032, number: "TEST-RATE-DELETE-ME-2" }];
  assert.deepEqual(withoutHiddenOrders(mixed), real);
  assert.equal(isHiddenVeeqoOrder(null), false);
  assert.equal(isHiddenVeeqoOrder({}), false);
});
