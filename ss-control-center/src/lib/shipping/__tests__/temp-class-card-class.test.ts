import { test } from "node:test";
import assert from "node:assert/strict";
import { applyManualClass, cardItemClass, isStaleBuild, strictestCardClass } from "../temp-class/card-class";

test("AT-943E-XUUS: Veeqo tag says Frozen, manual class CHILLED → card shows Chilled, cold chain kept", () => {
  assert.deepEqual(applyManualClass("Frozen", "CHILLED"), { knownType: "Frozen", tempClass: "Chilled" });
});

test("manual DRY beats a Frozen tag; manual FROZEN beats a Dry tag", () => {
  assert.deepEqual(applyManualClass("Frozen", "DRY"), { knownType: "Dry", tempClass: "Dry" });
  assert.deepEqual(applyManualClass("Dry", "FROZEN"), { knownType: "Frozen", tempClass: "Frozen" });
});

test("no manual class → old tag unchanged; untagged stays untyped", () => {
  assert.deepEqual(applyManualClass("Frozen", null), { knownType: "Frozen", tempClass: "Frozen" });
  assert.deepEqual(applyManualClass(null, undefined), { knownType: null, tempClass: null });
  assert.deepEqual(applyManualClass("Dry", "garbage"), { knownType: "Dry", tempClass: "Dry" });
});

test("order chip = strictest item: Frozen > Chilled > Dry", () => {
  assert.equal(strictestCardClass([{ tempClass: "Dry" }, { tempClass: "Chilled" }]), "Chilled");
  assert.equal(strictestCardClass([{ tempClass: "Chilled" }, { knownType: "Frozen" }]), "Frozen");
  assert.equal(strictestCardClass([{ knownType: null }]), null);
});

test("real scenario: order with no plan, AT-943E-XUUS CHILLED in the table, Veeqo tag Frozen → chip Chilled", () => {
  const manualBySku = new Map([["AT-943E-XUUS", "CHILLED"]]);
  // The dashboard's own mapping for the line (sku as Veeqo sends it).
  const item = cardItemClass({ tagType: "Frozen", isWalmart: false, sku: "AT-943E-XUUS", manualBySku });
  assert.deepEqual(item, { knownType: "Frozen", tempClass: "Chilled" });
  // The card chip for the order (no plan involved).
  assert.equal(strictestCardClass([item]), "Chilled");
  // Stray whitespace in the Veeqo SKU still matches.
  assert.equal(cardItemClass({ tagType: "Frozen", isWalmart: false, sku: " AT-943E-XUUS ", manualBySku }).tempClass, "Chilled");
  // Walmart stays Dry regardless.
  assert.equal(cardItemClass({ tagType: "Frozen", isWalmart: true, sku: "AT-943E-XUUS", manualBySku }).tempClass, "Dry");
});

test("stale tab detection: reload only when both builds are known and differ", () => {
  assert.equal(isStaleBuild("aaa", "bbb"), true);
  assert.equal(isStaleBuild("aaa", "aaa"), false);
  assert.equal(isStaleBuild("", "bbb"), false);
  assert.equal(isStaleBuild("aaa", null), false);
});
