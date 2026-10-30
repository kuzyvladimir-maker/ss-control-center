import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WALMART_COLD_REASON,
  isWalmartChannel,
  parseManualClass,
} from "../temp-class/manual-class";
import { cardItemClass, strictestCardClass } from "../temp-class/card-class";
import { decideOrderClass } from "../temp-class/resolve-class";

test("Set product type: Frozen / Chilled / Dry accepted in any case, never turned into Frozen", () => {
  assert.deepEqual(parseManualClass("Chilled"), { ok: true, klass: "CHILLED" });
  assert.deepEqual(parseManualClass("CHILLED"), { ok: true, klass: "CHILLED" });
  assert.deepEqual(parseManualClass(" chilled "), { ok: true, klass: "CHILLED" });
  assert.deepEqual(parseManualClass("Frozen"), { ok: true, klass: "FROZEN" });
  assert.deepEqual(parseManualClass("Dry"), { ok: true, klass: "DRY" });
});

test("junk class is refused with the three valid names", () => {
  for (const bad of ["", null, undefined, "Cold", "ambient", 3]) {
    const r = parseManualClass(bad);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Frozen.*Chilled.*Dry/);
  }
});

test("Walmart order: Chilled and Frozen refused with the reason, Dry allowed", () => {
  assert.deepEqual(parseManualClass("Chilled", { isWalmart: true }), {
    ok: false,
    error: WALMART_COLD_REASON,
  });
  assert.deepEqual(parseManualClass("Frozen", { isWalmart: true }), {
    ok: false,
    error: WALMART_COLD_REASON,
  });
  assert.deepEqual(parseManualClass("Dry", { isWalmart: true }), { ok: true, klass: "DRY" });
  assert.equal(isWalmartChannel("Walmart"), true);
  assert.equal(isWalmartChannel(undefined), false);
});

test("a saved manual CHILLED shows Chilled on the card and keeps the cold chain", () => {
  const manualBySku = new Map([["SKU-C", "CHILLED"]]);
  const line = cardItemClass({ tagType: "Dry", isWalmart: false, sku: "SKU-C ", manualBySku });
  assert.deepEqual(line, { knownType: "Frozen", tempClass: "Chilled" });
  // Mixed order: chilled + dry line → Chilled chip; a frozen line would win.
  assert.equal(strictestCardClass([line, { tempClass: "Dry" }]), "Chilled");
  assert.equal(strictestCardClass([line, { tempClass: "Frozen" }]), "Frozen");
});

test("plan: manual CHILLED drives the order class (chilled rules); Walmart stays DRY + flags the conflict", () => {
  assert.equal(decideOrderClass([{ manual: "CHILLED", legacy: "Frozen" }]).tempClass, "CHILLED");
  const wm = decideOrderClass([{ manual: "CHILLED" }], { isWalmart: true });
  assert.equal(wm.tempClass, "DRY");
  assert.equal(wm.walmartColdConflict, true);
});
