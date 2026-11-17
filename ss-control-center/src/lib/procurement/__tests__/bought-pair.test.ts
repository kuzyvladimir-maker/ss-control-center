import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProcurementCards, type VeeqoOrder } from "@/lib/veeqo/orders-procurement";
import { normalizeVeeqoResponse } from "@/lib/veeqo/normalize";
import { assertOrderReadable } from "../order-state-update";
import {
  findCardByKey,
  patchCard,
  procurementCardKey,
} from "../card-key";

// 2026-11-17 incident (topic 135): two Salutem orders, same SKU 743269739341.
const order = (
  id: number,
  number: string,
  customer: string,
  lines: Array<{ id: number; sku: string; qty: number }>,
): VeeqoOrder =>
  ({
    id,
    number,
    status: "awaiting_fulfillment",
    channel: { type_code: "direct", name: "Test channel" },
    customer: { full_name: customer },
    tags: [],
    employee_notes: [],
    line_items: lines.map((l) => ({
      id: l.id,
      quantity: l.qty,
      sellable: { sku_code: l.sku, product_title: `Product ${l.sku}`, product: { id: 1 } },
    })),
  }) as unknown as VeeqoOrder;

const orderA = () =>
  order(2277485341, "113-4365835-6488256", "Customer A", [
    { id: 2626000001, sku: "743269739341", qty: 1 },
  ]);
const orderB = () =>
  order(2277125420, "114-8255419-4685824", "Customer B", [
    { id: 2625865649, sku: "743269739341", qty: 2 },
  ]);

test("two orders with the same SKU → two cards with distinct (order, line) keys", () => {
  const { cards, warnings } = buildProcurementCards([orderA(), orderB()]);
  assert.equal(warnings.length, 0);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].sku, cards[1].sku);
  assert.notEqual(procurementCardKey(cards[0]), procurementCardKey(cards[1]));
});

test("Bought on one order flips only that order's card, even if the line id were shared", () => {
  const { cards } = buildProcurementCards([orderA(), orderB()]);
  const y = cards.find((c) => c.orderNumber === "114-8255419-4685824")!;
  const after = patchCard(cards, y.orderId, y.lineItemId, (c) => ({
    ...c,
    status: { kind: "bought" as const },
    remaining: 0,
  }));
  assert.deepEqual(
    after.map((c) => [c.orderNumber, c.status?.kind ?? null]),
    [
      ["113-4365835-6488256", null],
      ["114-8255419-4685824", "bought"],
    ],
  );

  // The page used to match by line id alone. Even with a (corrupted) shared
  // line id, the pair key keeps the other order untouched.
  const shared = cards.map((c) => ({ ...c, lineItemId: "2625865649" }));
  const flipped = patchCard(shared, y.orderId, "2625865649", (c) => ({
    ...c,
    status: { kind: "bought" as const },
  }));
  assert.equal(flipped.filter((c) => c.status?.kind === "bought").length, 1);
  assert.equal(findCardByKey(shared, `${y.orderId}:2625865649`)?.orderNumber, y.orderNumber);
});

test("normalised broken order (line_items = another order) gives NO card, only a warning", () => {
  const broken = {
    ...orderA(),
    line_items: orderB() as unknown,
  } as unknown as VeeqoOrder;
  const orders = normalizeVeeqoResponse("/orders?status=awaiting_fulfillment", [
    broken,
    orderB(),
  ]) as VeeqoOrder[];
  const { cards, warnings } = buildProcurementCards(orders);
  // Only order B's real card; order A never shows B's Taquitos line.
  assert.deepEqual(
    cards.map((c) => [c.orderNumber, c.lineItemId]),
    [["114-8255419-4685824", "2625865649"]],
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].orderNumber, "113-4365835-6488256");
  assert.match(warnings[0].message, /unreadable item list/);
});

test("a line id on two different orders is dropped from both and warned", () => {
  const clash = order(2277485341, "113-4365835-6488256", "Customer A", [
    { id: 2625865649, sku: "743269739341", qty: 2 },
  ]);
  const { cards, warnings } = buildProcurementCards([clash, orderB()]);
  assert.equal(cards.length, 0);
  assert.deepEqual(
    warnings.map((w) => w.orderNumber).sort(),
    ["113-4365835-6488256", "114-8255419-4685824"],
  );
});

test("Bought refuses to write on an unreadable or mismatched order", () => {
  const broken = normalizeVeeqoResponse("/orders/2277485341", {
    ...orderA(),
    line_items: orderB() as unknown,
  });
  assert.throws(() => assertOrderReadable(broken, "2277485341"), /unreadable item list or tags — nothing was saved/);
  assert.throws(
    () => assertOrderReadable(orderB(), "2277485341"),
    /different order \(asked 2277485341, got 2277125420\)/,
  );
  assert.doesNotThrow(() => assertOrderReadable(orderA(), "2277485341"));
});

test("junk in allocations[].line_items alone does not hide the order's cards", () => {
  // 2026-11-17 prod: 111-… had a feature-flag blob in allocations[0].line_items
  // while its own line_items were fine.
  const o = {
    ...orderA(),
    allocations: [{ id: 1, line_items: { groups: [], percentage: 0, users: [], feature: "x", data: [] } }],
  };
  const [normalised] = normalizeVeeqoResponse("/orders?page=1", [o]) as VeeqoOrder[];
  const { cards, warnings } = buildProcurementCards([normalised]);
  assert.equal(warnings.length, 0);
  assert.equal(cards.length, 1);
  assert.doesNotThrow(() => assertOrderReadable(normalised, "2277485341"));
});
