// Phase 3 — Jackie MCP walmart_inventory_update unit tests.
//
//   npx tsx --test src/lib/jackie-mcp/__tests__/walmart-inventory.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { tools } from "../tools/walmart-inventory";

const tool = tools[0];

test("walmart_inventory_update — tool shape (name, write, required args)", () => {
  assert.equal(tool.name, "walmart_inventory_update");
  assert.equal(tool.write, true);
  assert.deepEqual(tool.input_schema.required, ["sku", "quantity"]);
  assert.equal(tool.input_schema.additionalProperties, false);
});

test("walmart_inventory_update — dry_run returns preview payload, no network", async () => {
  const out = (await tool.handler(
    { sku: "GW-6SN0-SSZN", quantity: 0, dry_run: true },
    { actor: "test" },
  )) as Record<string, unknown>;
  assert.equal(out.dry_run, true);
  assert.match(String(out.endpoint), /PUT https:\/\/marketplace\.walmartapis\.com\/v3\/inventory\?sku=GW-6SN0-SSZN/);
  assert.deepEqual(out.body, {
    sku: "GW-6SN0-SSZN",
    quantity: { unit: "EACH", amount: 0 },
  });
  assert.match(String(out.note), /No changes made/);
});

test("walmart_inventory_update — dry_run includes shipNode in preview when provided", async () => {
  const out = (await tool.handler(
    { sku: "ABC-123", quantity: 5, ship_node: "10001234", dry_run: true },
    { actor: "test" },
  )) as Record<string, unknown>;
  assert.match(String(out.endpoint), /shipNode=10001234/);
});

test("walmart_inventory_update — non-integer quantity is floored", async () => {
  const out = (await tool.handler(
    { sku: "ABC", quantity: 3.9, dry_run: true },
    { actor: "test" },
  )) as Record<string, unknown>;
  const body = out.body as { quantity: { amount: number } };
  assert.equal(body.quantity.amount, 3);
});

test("walmart_inventory_update — missing sku rejected", async () => {
  await assert.rejects(
    () => tool.handler({ quantity: 0, dry_run: true }, { actor: "test" }),
    /sku.*required/i,
  );
});

test("walmart_inventory_update — non-numeric quantity rejected", async () => {
  await assert.rejects(
    () => tool.handler({ sku: "X", quantity: "ten", dry_run: true }, { actor: "test" }),
    /quantity.*number/i,
  );
});

test("walmart_inventory_update — negative quantity rejected", async () => {
  await assert.rejects(
    () => tool.handler({ sku: "X", quantity: -1, dry_run: true }, { actor: "test" }),
    /quantity.*≥ 0/,
  );
});

test("walmart_inventory_update — quantity required (missing)", async () => {
  await assert.rejects(
    () => tool.handler({ sku: "X", dry_run: true }, { actor: "test" }),
    /quantity.*number/i,
  );
});
