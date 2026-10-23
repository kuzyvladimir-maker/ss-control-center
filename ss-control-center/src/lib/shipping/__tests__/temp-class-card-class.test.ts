import { test } from "node:test";
import assert from "node:assert/strict";
import { applyManualClass, strictestCardClass } from "../temp-class/card-class";

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
