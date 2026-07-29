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
  assert.match(page, /Prepare collection plans/u);
  assert.match(page, /\/api\/bundle-factory\/walmart\/data-collection/u);
  assert.match(page, /pollWalmartCollection/u);
  assert.match(page, /continueAfterCollection/u);
  assert.match(page, /checkWalmartReadiness/u);
  assert.match(page, /collection\.status === "SUCCEEDED"/u);
  assert.match(page, /readiness\.diagnosis\.capability_gaps\.length > 0/u);
  assert.match(page, /Approve exact quote/u);
  assert.match(page, /PREPARE_OWNER_AUTHORIZATION/u);
  assert.match(page, /signed\.signature_base64/u);
  assert.match(page, /submitStudioGeneration/u);
  assert.match(page, /WALMART_COLLECTION_RECOVERY_KEY/u);
  assert.match(page, /sessionStorage\.setItem/u);
  assert.match(page, /Automatic retry[\s\S]*permanently disabled/u);
  assert.doesNotMatch(page, /automatically approve/iu);
});

test("readiness recommendation distinguishes targeted enrichment from broader demand discovery", async () => {
  const route = await readFile(
    new URL(
      "../../../app/api/bundle-factory/walmart/readiness/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(route, /Prepare the exact one-product plans now/u);
  assert.match(route, /maximum provider-credit cost/u);
  assert.match(route, /continues Generate automatically/u);
  assert.match(route, /PRODUCT_TRUTH_DEMAND_DISCOVERY/u);
  assert.match(route, /bounded Product Truth demand-discovery campaign/u);
  assert.doesNotMatch(route, /Include the verified compatibility fix in a new frozen/u);
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
