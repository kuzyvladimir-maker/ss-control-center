import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allLinesBoughtInNotes,
  isProcurementPlaced,
  procurementPlacedSource,
} from "../placed";

const block = (lines: string[]) =>
  `Label stuff\n[PROCUREMENT]\n${lines.join("\n")}\n[/PROCUREMENT]`;

test("Placed tag alone is enough (object and string tag shapes)", () => {
  assert.equal(procurementPlacedSource({ tags: [{ name: "Placed" }] }), "tag");
  assert.equal(procurementPlacedSource({ tags: ["placed"] }), "tag");
});

test("missing tag but every line bought in notes → placed via notes", () => {
  const order = {
    tags: [],
    line_items: [{ id: 111 }],
    employee_notes: block(["111 | Jimmy Dean | bought"]),
  };
  assert.equal(procurementPlacedSource(order), "notes");
  assert.equal(isProcurementPlaced(order), true);
});

test("notes as an array of note records are read too", () => {
  const order = {
    line_items: [{ id: "7" }],
    employee_notes: [{ text: "old" }, { text: block(["7 | Freshpet | bought"]) }],
  };
  assert.equal(allLinesBoughtInNotes(order), true);
});

test("partial purchase is not placed", () => {
  const order = {
    line_items: [{ id: 1 }, { id: 2 }],
    employee_notes: block(["1 | A | bought", "2 | B | remain:3"]),
  };
  assert.equal(isProcurementPlaced(order), false);
});

test("an untouched line keeps the order waiting", () => {
  const order = {
    line_items: [{ id: 1 }, { id: 2 }],
    employee_notes: block(["1 | A | bought"]),
  };
  assert.equal(isProcurementPlaced(order), false);
});

test("the LAST block wins — undo after bought means not placed", () => {
  const order = {
    line_items: [{ id: 1 }],
    employee_notes:
      block(["1 | A | bought"]) + "\n[PROCUREMENT]\n[/PROCUREMENT]",
  };
  assert.equal(isProcurementPlaced(order), false);
});

test("no tags, no notes, no lines → not placed", () => {
  assert.equal(procurementPlacedSource({}), null);
  assert.equal(procurementPlacedSource(null), null);
});
