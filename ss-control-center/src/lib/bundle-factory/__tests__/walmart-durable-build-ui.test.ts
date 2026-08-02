import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseWalmartDurableBuildPreparationBrief,
  rankWalmartDurableCollectionCandidates,
  WALMART_DURABLE_BUILD_PREPARATION_SCHEMA,
  WALMART_DURABLE_BUILD_PREPARATION_WORKFLOW,
} from "../walmart-durable-build";
import type {
  ProductTruthWalmartRequestDiagnostic,
} from "../../sourcing/product-truth-read-contract";

function preparationBrief() {
  return {
    studio_version: 6,
    workflow: WALMART_DURABLE_BUILD_PREPARATION_WORKFLOW,
    build_schema_version: WALMART_DURABLE_BUILD_PREPARATION_SCHEMA,
    source: "prompt",
    prompt: "Create 5 exact Campbell's soup listings",
    channel: "WALMART",
    listing_count: 5,
    pack_count: 8,
    target_margin_pct: 30,
    photo_strategy: "reuse-donor",
    walmart_shipping: {
      store_index: 1,
      account_name: "SIRIUS TRADING INTERNATIONAL LLC",
      selected_at: "2026-08-02T04:00:00.000Z",
      template: {
        id: "default",
        name: "Default Template",
        type: "CUSTOM",
        status: "ACTIVE",
        rate_model_type: "PER_SHIPMENT_PRICING",
        shipping_type: null,
        created_at: null,
        modified_at: null,
        configurations: [],
        is_free_shipping: true,
        template_sha256: "a".repeat(64),
      },
    },
    product_truth_collection: {
      batch_id: "ptbfw-1234567890abcdef12345678",
      requested_at: "2026-08-02T04:00:00.000Z",
      admitted_jobs: 3,
      attempts: [{
        batch_id: "ptbfw-1234567890abcdef12345678",
        requested_at: "2026-08-02T04:00:00.000Z",
        admitted_jobs: 3,
        donor_product_ids: ["donor-1", "donor-2", "donor-3"],
      }],
    },
    operator_contract: {
      marketplace_mutation_authorized: false,
      upc_reservation_authorized: false,
      paid_execution_requires_exact_owner_click: true,
    },
  } as const;
}

test("durable Walmart preparation brief preserves one build and exact owner gate", () => {
  const parsed = parseWalmartDurableBuildPreparationBrief(preparationBrief());
  assert.equal(parsed.listing_count, 5);
  assert.equal(parsed.pack_count, 8);
  assert.equal(parsed.product_truth_collection.admitted_jobs, 3);
  assert.deepEqual(
    parsed.product_truth_collection.attempts[0]?.donor_product_ids,
    ["donor-1", "donor-2", "donor-3"],
  );
  assert.equal(parsed.operator_contract.paid_execution_requires_exact_owner_click, true);
});

test("replacement selection excludes attempted donors and prefers the smallest safe gap", () => {
  const candidate = (
    donor: string,
    missing: ProductTruthWalmartRequestDiagnostic["candidates"][number]["missing"],
    matchScore: number,
  ): ProductTruthWalmartRequestDiagnostic["candidates"][number] => ({
    donor_product_id: donor,
    canonical_variant_id: `variant-${donor}`,
    title: donor,
    brand: "Campbell's",
    flavor: null,
    match_score: matchScore,
    ready: false,
    missing,
    blockers: [],
    candidate: null,
  });
  const diagnostic = {
    contractVersion: "product-truth-read-contract/4.0.0",
    query: "Campbell's soup",
    as_of: "2026-08-02T04:00:00.000Z",
    price_max_age_ms: 86_400_000,
    zip: "33765",
    matched_variants: 4,
    ready_variants: 0,
    candidates: [
      candidate("attempted", ["FRESH_LOCAL_PRICE"], 100),
      candidate("content-heavy", ["INGREDIENTS", "NUTRITION", "ALLERGENS"], 99),
      candidate("price-only", ["FRESH_LOCAL_PRICE"], 80),
      candidate("two-gaps", ["FRESH_LOCAL_PRICE", "ALLERGENS"], 90),
    ],
  } as unknown as ProductTruthWalmartRequestDiagnostic;
  assert.deepEqual(
    rankWalmartDurableCollectionCandidates(diagnostic, ["attempted"])
      .map((entry) => entry.donor_product_id),
    ["price-only", "two-gaps", "content-heavy"],
  );
});

test("attempts are distinct batches, and may retry the very same donors", () => {
  const brief = preparationBrief();
  const withRetry = (batchId: string) => ({
    ...brief,
    product_truth_collection: {
      batch_id: batchId,
      requested_at: "2026-08-02T04:01:00.000Z",
      admitted_jobs: 1,
      attempts: [
        ...brief.product_truth_collection.attempts,
        {
          batch_id: batchId,
          requested_at: "2026-08-02T04:01:00.000Z",
          admitted_jobs: 1,
          donor_product_ids: ["donor-1"],
        },
      ],
    },
  });
  // Retrying the SAME donor after an unknown paid outcome is the owner's
  // explicit choice; paying twice is prevented by the doctor harvest-state
  // gate, not by this brief.
  const parsed = parseWalmartDurableBuildPreparationBrief(
    withRetry("ptbfw-abcdefabcdefabcdefabcdef"),
  );
  assert.equal(parsed.product_truth_collection.attempts.length, 2);
  assert.deepEqual(
    parsed.product_truth_collection.attempts[1]?.donor_product_ids,
    ["donor-1"],
  );
  // Two attempts sharing one batch identity is still drift.
  assert.throws(
    () => parseWalmartDurableBuildPreparationBrief(
      withRetry(brief.product_truth_collection.attempts[0]!.batch_id),
    ),
    /attempt drifted/u,
  );
});

test("Walmart Generate creates a durable GenerationJob before Product Truth completion", async () => {
  const route = await readFile(
    new URL("../../../app/api/bundle-factory/studio/generate/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /prepareWalmartDurableBuildCollection/u);
  assert.match(route, /const buildId = `wbf-\$\{prepared\.batch\.batchId\}`/u);
  assert.match(route, /current_stage: "WALMART_PRODUCT_TRUTH"/u);
  assert.match(route, /user_id: auth\.id/u);
  assert.match(route, /paid_execution_requires_exact_owner_click: true/u);
});

test("Walmart start page navigates to one durable build instead of driving ephemeral collection", async () => {
  const page = await readFile(
    new URL("../../../app/bundle-factory/new/page.tsx", import.meta.url),
    "utf8",
  );
  const generate = page.slice(
    page.indexOf("async function onGenerate()"),
    page.indexOf("return (", page.indexOf("async function onGenerate()")),
  );
  assert.match(generate, /channel === "WALMART"[\s\S]*await submitStudioGeneration\(\)/u);
  assert.doesNotMatch(generate, /startWalmartDataCollection/u);
  assert.doesNotMatch(generate, /checkWalmartReadiness/u);
  assert.match(page, /Durable Walmart builds[\s\S]*GenerationJob id/u);
});

test("durable build page owns Product Truth approval and atomically continues the same job", async () => {
  const [component, finalize] = await Promise.all([
    readFile(
      new URL("../../../components/bundle-factory/WalmartDurableBuildProgress.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../app/api/bundle-factory/walmart/builds/[id]/finalize/route.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(component, /collectionBatchId/u);
  assert.match(component, /Approve exact quote/u);
  // Every terminal collection status must hand control to finalization —
  // including AMBIGUOUS (dead paid attempt, never auto-retried) and DECLINED.
  assert.match(
    component,
    /next\.status === "SUCCEEDED"[\s\S]*next\.status === "FAILED"[\s\S]*next\.status === "AMBIGUOUS"[\s\S]*next\.status === "DECLINED"/u,
  );
  assert.match(component, /window\.location\.reload\(\)/u);
  assert.doesNotMatch(component, /sessionStorage/u);
  assert.match(finalize, /collection\.status !== "SUCCEEDED"/u);
  assert.match(finalize, /where: \{ id \}/u);
  assert.match(finalize, /current_stage: "WALMART_DRAFT_QUEUE"/u);
  assert.match(finalize, /generationWorkItem\.createMany/u);
  assert.match(finalize, /excludedDonorProductIds/u);
  assert.match(finalize, /PRODUCT_TRUTH_REPLACEMENT/u);
  assert.match(finalize, /attempts\.length >= 5/u);
});

test("an ambiguous paid attempt needs an explicit owner decision, never an auto-retry", async () => {
  const route = await readFile(
    new URL(
      "../../../app/api/bundle-factory/walmart/builds/[id]/finalize/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  // The server refuses to replace an ambiguous attempt unless the owner
  // explicitly acknowledged it, and it reports what that attempt spent.
  assert.match(route, /AMBIGUOUS_ATTEMPT_REQUIRES_OWNER_ACKNOWLEDGEMENT/u);
  assert.match(route, /owner_acknowledged_ambiguous_attempt === true/u);
  assert.match(route, /provider_units_used/u);
  // The acknowledged retry keeps the same products: only earlier attempts are
  // excluded, and the doctor harvest-state gate remains the paid-once guard.
  assert.match(
    route,
    /ownerAcknowledgedAmbiguous[\s\S]*attempts\.slice\(0, -1\)/u,
  );

  const component = await readFile(
    new URL(
      "../../../components/bundle-factory/WalmartDurableBuildProgress.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  // The owner sees the decision instead of a dead end, and the acknowledgement
  // travels only on that explicit click.
  assert.match(component, /Start a new attempt/u);
  assert.match(
    component,
    /finalizeBuild\(\{ ownerAcknowledgedAmbiguousAttempt: true \}\)/u,
  );
});

test("a screen left open through a worker death repairs itself", async () => {
  const component = await readFile(
    new URL(
      "../../../components/bundle-factory/WalmartDurableBuildProgress.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  // Terminal statuses must keep a slow poll alive; otherwise a page that was
  // open while the worker died keeps rendering "Enriching…" forever.
  assert.match(component, /void poll\(\), 15_000/u);
  // And the ambiguous decision must come from the authoritative status, not
  // only from a finalize round-trip that may never happen on a stale screen.
  assert.match(
    component,
    /ambiguousAttempt \|\| collection\?\.status === "AMBIGUOUS"/u,
  );
});
