import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_TRUTH_WALMART_COLLECTION_JOB_VERSION,
  ProductTruthWalmartCollectionContractError,
  buildProductTruthWalmartCollectionBatch,
  parseProductTruthWalmartCollectionBatch,
  productTruthWalmartCollectionBatchSha256,
  renderProductTruthWalmartCollectionBatch,
} from "../product-truth-walmart-collection-contract";

const REQUESTED_AT = "2026-07-28T20:00:00.000Z";

function candidates(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    donorProductId: `donor-${index + 1}`,
    canonicalVariantId: `variant-${index + 1}`,
    title: `Campbell Soup Variant ${index + 1}`,
    query: `Campbell Soup Variant ${index + 1} exact Walmart product`,
    missingFields: ["FRESH_LOCAL_PRICE", "NUTRITION"],
  }));
}

function isContractError(code: string) {
  return (error: unknown) =>
    error instanceof ProductTruthWalmartCollectionContractError
    && error.code === code;
}

test("builds deterministic UI grouping with independent one-donor jobs", () => {
  const input = {
    requestedByUserId: "owner-1",
    requestedAt: REQUESTED_AT,
    prompt: "Create Campbell canned soup listings",
    listingCount: 2,
    packCount: 3,
    unwrangleReserveFloor: 100,
    candidates: candidates(),
  };
  const first = buildProductTruthWalmartCollectionBatch(input);
  const second = buildProductTruthWalmartCollectionBatch(input);

  assert.deepEqual(first, second);
  assert.equal(first.jobs.length, 2);
  assert.equal(new Set(first.jobs.map((job) => job.runId)).size, 2);
  assert.deepEqual(
    first.jobs.map((job) => job.target.donorProductId),
    ["donor-1", "donor-2"],
  );
  for (const job of first.jobs) {
    assert.equal(job.schemaVersion, PRODUCT_TRUTH_WALMART_COLLECTION_JOB_VERSION);
    assert.deepEqual(job.noSpendSequence, ["DOCTOR", "RUN_PLAN"]);
    assert.equal(job.policy.maxAttempts, 1);
    assert.equal(job.meteredStep.maximumProviderUnits, 3.5);
    assert.equal(job.meteredStep.status, "REQUIRES_EXACT_OWNER_AUTHORITY");
    assert.equal(job.claims.noAutomaticPaidExecution, true);
    assert.equal(job.claims.noMarketplaceMutation, true);
  }
});

test("canonical render and digest are stable", () => {
  const batch = buildProductTruthWalmartCollectionBatch({
    requestedByUserId: "owner-1",
    requestedAt: REQUESTED_AT,
    prompt: "Create Campbell canned soup listings",
    listingCount: 1,
    packCount: 2,
    unwrangleReserveFloor: 100,
    candidates: candidates(1),
  });
  const rendered = renderProductTruthWalmartCollectionBatch(batch);
  assert.equal(rendered.endsWith("\n"), true);
  assert.equal(
    productTruthWalmartCollectionBatchSha256(JSON.parse(rendered)),
    productTruthWalmartCollectionBatchSha256(batch),
  );
  assert.deepEqual(parseProductTruthWalmartCollectionBatch(JSON.parse(rendered)), batch);
});

test("rejects a hidden multi-target provider job", () => {
  const batch = buildProductTruthWalmartCollectionBatch({
    requestedByUserId: "owner-1",
    requestedAt: REQUESTED_AT,
    prompt: "Create Campbell canned soup listings",
    listingCount: 2,
    packCount: 2,
    unwrangleReserveFloor: 100,
    candidates: candidates(),
  });
  const tampered = structuredClone(batch) as unknown as {
    jobs: Array<{ policy: { listingConcurrency: number } }>;
  };
  tampered.jobs[0].policy.listingConcurrency = 2;
  assert.throws(
    () => parseProductTruthWalmartCollectionBatch(tampered),
    isContractError("COLLECTION_POLICY_INVALID"),
  );
});

test("rejects duplicate donor targets and more than five UI jobs", () => {
  assert.throws(
    () =>
      buildProductTruthWalmartCollectionBatch({
        requestedByUserId: "owner-1",
        requestedAt: REQUESTED_AT,
        prompt: "Create Campbell canned soup listings",
        listingCount: 6,
        packCount: 2,
        unwrangleReserveFloor: 100,
        candidates: candidates(6),
      }),
    isContractError("COLLECTION_INPUT_INVALID"),
  );

  const duplicate = candidates();
  duplicate[1] = {
    ...duplicate[1],
    donorProductId: duplicate[0].donorProductId,
  };
  assert.throws(
    () =>
      buildProductTruthWalmartCollectionBatch({
        requestedByUserId: "owner-1",
        requestedAt: REQUESTED_AT,
        prompt: "Create Campbell canned soup listings",
        listingCount: 2,
        packCount: 2,
        unwrangleReserveFloor: 100,
        candidates: duplicate,
      }),
    isContractError("COLLECTION_INPUT_INVALID"),
  );
});

test("paid execution cannot be marked automatic or silently replayable", () => {
  const batch = buildProductTruthWalmartCollectionBatch({
    requestedByUserId: "owner-1",
    requestedAt: REQUESTED_AT,
    prompt: "Create Campbell canned soup listings",
    listingCount: 1,
    packCount: 2,
    unwrangleReserveFloor: 100,
    candidates: candidates(1),
  });
  const tampered = structuredClone(batch) as unknown as {
    jobs: Array<{
      claims: {
        noAutomaticPaidExecution: boolean;
        noAutomaticReplay: boolean;
      };
    }>;
  };
  tampered.jobs[0].claims.noAutomaticPaidExecution = false;
  tampered.jobs[0].claims.noAutomaticReplay = false;
  assert.throws(
    () => parseProductTruthWalmartCollectionBatch(tampered),
    isContractError("COLLECTION_POLICY_INVALID"),
  );
});
