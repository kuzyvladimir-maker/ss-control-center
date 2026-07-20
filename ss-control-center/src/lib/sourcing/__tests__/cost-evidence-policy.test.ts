import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { contentDonorIdForCostMethod } from "../cost-evidence-policy";

test("only exact price evidence may become legacy content truth", () => {
  assert.equal(contentDonorIdForCostMethod("exact", "donor-1"), "donor-1");
  for (const method of ["line-price", "google", "unsourceable", "own-brand", "none", null, undefined]) {
    assert.equal(contentDonorIdForCostMethod(method, "proxy-donor"), null, String(method));
  }
  assert.equal(contentDonorIdForCostMethod("exact", null), null);
});

test("COGS recost no longer deletes prior effective periods", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, "../cogs-engine.ts"), "utf8");
  assert.doesNotMatch(source, /DELETE\s+FROM\s+["']?SkuCost/i);
  assert.match(source, /append-only by effectiveDate/);
});
