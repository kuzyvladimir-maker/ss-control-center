import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveBundleInventory } from "@/lib/bundle-factory/validation/validators/validator-inventory";
import {
  INVENTORY_MAX_AGE_MS,
  inventoryIsFresh,
} from "@/lib/bundle-factory/inventory-policy";

test("bundle inventory is the limiting component stock divided by recipe qty", async () => {
  const stock = new Map([["A", 100], ["B", 45]]);
  const result = await deriveBundleInventory(
    [
      { manufacturer_upc: "A", qty: 23 },
      { manufacturer_upc: "B", qty: 22 },
    ],
    async (upc) => stock.get(upc) ?? null,
  );
  assert.equal(result.available_quantity, 2); // min(floor(100/23), floor(45/22))
});

test("duplicate component UPC quantities are aggregated", async () => {
  const result = await deriveBundleInventory(
    [
      { manufacturer_upc: "A", qty: 10 },
      { manufacturer_upc: "A", qty: 5 },
    ],
    async () => 31,
  );
  assert.equal(result.available_quantity, 2);
  assert.equal(result.component_stock[0].required_per_bundle, 15);
});

test("missing or inconclusive stock yields unknown rather than an invented quantity", async () => {
  const missingUpc = await deriveBundleInventory(
    [{ manufacturer_upc: null, qty: 24 }],
    async () => 100,
  );
  assert.equal(missingUpc.available_quantity, null);

  const inconclusive = await deriveBundleInventory(
    [{ manufacturer_upc: "A", qty: 24 }],
    async () => null,
  );
  assert.equal(inconclusive.available_quantity, null);
  assert.deepEqual(inconclusive.inconclusive_upcs, ["A"]);
});

test("publication inventory expires instead of remaining valid indefinitely", () => {
  const now = Date.parse("2026-07-17T12:00:00.000Z");
  assert.equal(inventoryIsFresh(new Date(now - INVENTORY_MAX_AGE_MS), now), true);
  assert.equal(inventoryIsFresh(new Date(now - INVENTORY_MAX_AGE_MS - 1), now), false);
  assert.equal(inventoryIsFresh(null, now), false);
});
