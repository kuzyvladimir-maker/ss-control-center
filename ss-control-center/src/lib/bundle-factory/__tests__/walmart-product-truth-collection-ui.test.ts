import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Walmart Studio automatically prepares collection, exposes approval, and resumes readiness", async () => {
  const page = await readFile(
    new URL(
      "../../../app/bundle-factory/new/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(page, /await startWalmartDataCollection\(\)/u);
  assert.match(page, /Preparing the exact no-spend collection plan/u);
  assert.match(page, /Approve exact quote/u);
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
  assert.match(page, /complete request is preserved/u);
  assert.match(page, /separate protected work item/u);
  assert.doesNotMatch(page, /current verified pilot can prepare 1–2 listings/u);
  assert.doesNotMatch(page, /supports only packs of 2 or 3/u);
  assert.match(page, /channel !== "WALMART"[\s\S]*house_brand: houseBrand/u);
  assert.doesNotMatch(page, /text_model:/u);
  assert.match(page, /channel === "WALMART"[\s\S]*exact manufacturer brand/u);
  assert.doesNotMatch(page, /automatically approve/iu);
});

test("Walmart route never parses or persists Amazon-only Advanced controls", async () => {
  const route = await readFile(
    new URL(
      "../../../app/api/bundle-factory/studio/generate/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const walmartBranch = route.slice(
    route.indexOf('if (studioChannelRoute(channel) === "CANONICAL_WALMART_OPERATOR_REQUIRED")'),
    route.indexOf("// These controls belong to the Amazon/own-brand branch only."),
  );
  assert.doesNotMatch(
    walmartBranch,
    /body\.(?:house_brand|text_model|photo_strategy|image_quality|uncrustables_image_mode)/u,
  );
  assert.doesNotMatch(
    walmartBranch,
    /house_brand:|text_model:|image_quality:|uncrustables_image_mode:/u,
  );
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
