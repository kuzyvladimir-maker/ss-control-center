import assert from "node:assert/strict";
import { test } from "node:test";

import { selectCurrentCogsRows, type CogsSourceRow } from "../cogs";
import {
  ECONOMICS_COGS_BLOCKER,
  computeProfitWithProductTruthGuard,
} from "../product-truth-profit-guard";

const NOW = new Date("2026-07-19T12:00:00.000Z");

function row(overrides: Partial<CogsSourceRow> = {}): CogsSourceRow {
  return {
    sku: "SKU-1",
    totalCost: 10,
    costPerUnit: 10,
    packSize: 1,
    includesPackaging: false,
    source: "retail:batch",
    effectiveDate: "2026-07-19",
    ...overrides,
  };
}

test("a current NULL cost wins over an older positive row", () => {
  const selected = selectCurrentCogsRows([
    "SKU-1",
  ], [
    row({ totalCost: null, costPerUnit: null, effectiveDate: "2026-07-19" }),
    row({ totalCost: 8, costPerUnit: 8, effectiveDate: "2026-07-01" }),
  ], NOW).get("SKU-1");

  assert.equal(selected?.missing, true);
  assert.equal(selected?.cost, null);
  assert.equal(selected?.effectiveDate, "2026-07-19");
});

test("newest-first selection is one row per requested SKU", () => {
  const selected = selectCurrentCogsRows([
    "A", "B", "MISSING",
  ], [
    row({ sku: "A", totalCost: 11 }),
    row({ sku: "A", totalCost: 9, effectiveDate: "2026-07-01" }),
    row({ sku: "B", totalCost: 4 }),
    row({ sku: "NOT-REQUESTED", totalCost: 99 }),
  ], NOW);

  assert.equal(selected.get("A")?.cost, 11);
  assert.equal(selected.get("B")?.cost, 4);
  assert.equal(selected.get("MISSING")?.missing, true);
  assert.equal(selected.has("NOT-REQUESTED"), false);
});

test("declared UNSOURCEABLE cannot expose an inconsistent positive legacy value", () => {
  const selected = selectCurrentCogsRows([
    "SKU-1",
  ], [
    row({
      totalCost: 10,
      costPerUnit: 10,
      evidenceOutcome: "UNSOURCEABLE",
    }),
  ], NOW).get("SKU-1");

  assert.equal(selected?.outcome, "UNSOURCEABLE");
  assert.equal(selected?.missing, true);
  assert.equal(selected?.cost, null);
  assert.equal(selected?.perUnit, null);
});

const profitInput = {
  sku: "SKU-1",
  marketplace: "amazon" as const,
  itemPrice: 30,
  shippingCharged: 5,
  packaging: 2,
  ownShipping: 7,
  category: "grocery_food" as const,
};

test("unknown or non-positive COGS blocks profit instead of becoming zero", () => {
  for (const cogs of [null, 0, -1, Number.NaN]) {
    const guarded = computeProfitWithProductTruthGuard({ ...profitInput, cogs });
    assert.equal(guarded.status, "BLOCKED");
    assert.equal(guarded.result, null);
    assert.deepEqual(guarded.blockers, [ECONOMICS_COGS_BLOCKER]);
  }
});

test("a positive COGS value preserves the canonical profit formula", () => {
  const guarded = computeProfitWithProductTruthGuard({ ...profitInput, cogs: 10 });
  assert.equal(guarded.status, "CALCULATED");
  assert.equal(guarded.result?.breakdown.cogs, 10);
  assert.equal(guarded.result?.profit, 10.75);
});
