import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Walmart Studio exposes collection launch, progress, and readiness continuation", async () => {
  const page = await readFile(
    new URL(
      "../../../app/bundle-factory/new/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(page, /Collect missing product data/u);
  assert.match(page, /\/api\/bundle-factory\/walmart\/data-collection/u);
  assert.match(page, /pollWalmartCollection/u);
  assert.match(page, /continueAfterCollection/u);
  assert.match(page, /checkWalmartReadiness/u);
  assert.match(page, /collection\.status === "SUCCEEDED"/u);
  assert.match(page, /readiness\.diagnosis\.capability_gaps\.length > 0/u);
  assert.doesNotMatch(page, /automatically approve|automatic paid execution/iu);
});

test("collection route re-derives exact donors server-side and cannot call providers or Walmart", async () => {
  const route = await readFile(
    new URL(
      "../../../app/api/bundle-factory/walmart/data-collection/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(route, /diagnoseProductTruthWalmartPilotRequest/u);
  assert.match(route, /readTargetedWalmartDonorSnapshot/u);
  assert.match(route, /buildProductTruthWalmartCollectionBatch/u);
  assert.match(route, /admitProductTruthWalmartCollectionBatch/u);
  assert.doesNotMatch(
    route,
    /child_process|spawn\(|exec\(|MP_ITEM|SKU_TEMPLATE_MAP|WalmartClient/u,
  );
});
