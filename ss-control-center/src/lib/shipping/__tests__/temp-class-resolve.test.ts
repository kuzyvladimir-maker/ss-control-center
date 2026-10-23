import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideLineClass,
  decideOrderClass,
} from "../temp-class/resolve-class";

test("precedence: manual > legacy > tag > default", () => {
  // manual wins over everything
  assert.deepEqual(
    decideLineClass({ manual: "CHILLED", legacy: "Frozen", tags: ["dry"] }),
    { tempClass: "CHILLED", source: "manual", unknown: false },
  );
  // legacy (ProductTypeOverride) when no manual
  assert.deepEqual(decideLineClass({ legacy: "Frozen", tags: ["dry"] }), {
    tempClass: "FROZEN",
    source: "legacy",
    unknown: false,
  });
  // Veeqo tag when no manual/legacy
  assert.deepEqual(decideLineClass({ tags: ["dry", "grocery"] }), {
    tempClass: "DRY",
    source: "tag",
    unknown: false,
  });
  // nothing → FROZEN default, flagged unknown
  assert.deepEqual(decideLineClass({}), {
    tempClass: "FROZEN",
    source: "default",
    unknown: true,
  });
});

test("order class = strictest of its lines (mixed order)", () => {
  const r = decideOrderClass([
    { tags: ["dry"] }, // DRY
    { manual: "FROZEN" }, // FROZEN in line 2 — must drag the order to FROZEN
  ]);
  assert.equal(r.tempClass, "FROZEN");
  assert.equal(r.unknownAny, false);
});

test("untagged line → FROZEN default + unknown flag", () => {
  const r = decideOrderClass([{ sku: "x" } as never]);
  assert.equal(r.tempClass, "FROZEN");
  assert.equal(r.unknownAny, true);
});

test("Walmart stays DRY and flags a cold SKU conflict", () => {
  const r = decideOrderClass([{ manual: "CHILLED" }], { isWalmart: true });
  assert.equal(r.tempClass, "DRY");
  assert.equal(r.walmartColdConflict, true);

  const ok = decideOrderClass([{ tags: ["dry"] }], { isWalmart: true });
  assert.equal(ok.tempClass, "DRY");
  assert.equal(ok.walmartColdConflict, false);
});
