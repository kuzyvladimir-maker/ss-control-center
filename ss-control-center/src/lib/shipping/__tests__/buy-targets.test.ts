import { test } from "node:test";
import assert from "node:assert/strict";
import { groupBuyTargets } from "../buy-targets";

test("re-quoted item is bought under ITS plan, not the batch plan", () => {
  // The bug: after a package Save the row's item came from a new single-order
  // plan, but Buy sent the batch planId → the server found nothing → zeros.
  const requoted = { id: "item-new", orderNumber: "113-1", planId: "plan-single" };
  const groups = groupBuyTargets([requoted], "plan-batch");
  assert.deepEqual(groups, [{ planId: "plan-single", items: [requoted] }]);
});

test("items without their own plan fall back to the batch plan", () => {
  const a = { id: "a", orderNumber: "1" };
  const b = { id: "b", orderNumber: "2", planId: null };
  assert.deepEqual(groupBuyTargets([a, b], "plan-batch"), [
    { planId: "plan-batch", items: [a, b] },
  ]);
});

test("bulk selection mixing batch and re-quoted rows → one group per plan", () => {
  const a = { id: "a", orderNumber: "1" };
  const b = { id: "b", orderNumber: "2", planId: "p2" };
  const c = { id: "c", orderNumber: "3", planId: "p3" };
  const d = { id: "d", orderNumber: "4" };
  const groups = groupBuyTargets([a, b, c, d], "batch");
  assert.deepEqual(
    groups.map((g) => [g.planId, g.items.map((i) => i.id)]),
    [
      ["batch", ["a", "d"]],
      ["p2", ["b"]],
      ["p3", ["c"]],
    ],
  );
  // Every selected item is bought exactly once.
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), 4);
});

test("no plan at all → nothing to buy (caller re-plans)", () => {
  assert.deepEqual(groupBuyTargets([{ id: "a", orderNumber: "1" }], null), []);
});
