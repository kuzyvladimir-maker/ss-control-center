import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTempClass,
  strictestClass,
  tempClassToProductType,
  isTempClass,
  DEFAULT_CLASS,
} from "../temp-class/classes";

test("parseTempClass maps synonyms", () => {
  assert.equal(parseTempClass("Frozen"), "FROZEN");
  assert.equal(parseTempClass("frozen food"), "FROZEN");
  assert.equal(parseTempClass("CHILLED"), "CHILLED");
  assert.equal(parseTempClass("refrigerated"), "CHILLED");
  assert.equal(parseTempClass("fridge"), "CHILLED");
  assert.equal(parseTempClass("Dry"), "DRY");
  assert.equal(parseTempClass("ambient"), "DRY");
  assert.equal(parseTempClass("shelf stable"), "DRY");
  assert.equal(parseTempClass(""), null);
  assert.equal(parseTempClass(null), null);
  assert.equal(parseTempClass("blue"), null);
});

test("strictest class wins (FROZEN > CHILLED > DRY)", () => {
  assert.equal(strictestClass(["DRY", "CHILLED", "FROZEN"]), "FROZEN");
  assert.equal(strictestClass(["DRY", "CHILLED"]), "CHILLED");
  assert.equal(strictestClass(["DRY", "DRY"]), "DRY");
  // empty → default (FROZEN)
  assert.equal(strictestClass([]), DEFAULT_CLASS);
  assert.equal(DEFAULT_CLASS, "FROZEN");
});

test("tempClassToProductType bridges to the summer two-value string", () => {
  assert.equal(tempClassToProductType("FROZEN"), "Frozen");
  assert.equal(tempClassToProductType("CHILLED"), "Frozen"); // chilled still freezes+ices
  assert.equal(tempClassToProductType("DRY"), "Dry");
});

test("isTempClass guards", () => {
  assert.ok(isTempClass("FROZEN"));
  assert.ok(!isTempClass("frozen"));
  assert.ok(!isTempClass("WARM"));
  assert.ok(!isTempClass(null));
});
