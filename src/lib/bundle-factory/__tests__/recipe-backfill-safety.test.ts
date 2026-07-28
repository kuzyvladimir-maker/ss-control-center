import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertRecipeBackfillDigest,
  recipeBackfillAuditEvent,
  recipeBackfillChannelSkuInvalidation,
  recipeBackfillDraftInvalidation,
  recipeBackfillGeneratedContentInvalidation,
  recipeBackfillOptimisticDigest,
  recipeBackfillPublicationDigest,
  type RecipeBackfillOptimisticSnapshot,
  type RecipeBackfillPublicationSnapshot,
} from "@/lib/bundle-factory/recipe-backfill-safety";

function optimisticSnapshot(): RecipeBackfillOptimisticSnapshot {
  return {
    draft: {
      id: "draft-1",
      updated_at: "2026-07-17T12:00:00.000Z",
      status: "PUBLISHED",
      published_at: "2026-07-10T12:00:00.000Z",
      draft_components: "[]",
      variation_matrix: {
        id: "matrix-1",
        updated_at: "2026-07-17T11:00:00.000Z",
        selected_variant_idx: 0,
        variants_json: "[{\"idx\":0}]",
      },
      generated_content: [
        { id: "content-b", updated_at: "2026-07-17T11:30:00.000Z" },
        { id: "content-a", updated_at: "2026-07-17T11:20:00.000Z" },
      ],
    },
    master: {
      id: "master-1",
      updated_at: "2026-07-17T12:00:00.000Z",
      lifecycle_status: "LIVE",
      components: [
        { id: "component-b", updated_at: "2026-07-17T10:00:00.000Z", qty: 12 },
        { id: "component-a", updated_at: "2026-07-17T10:00:00.000Z", qty: 12 },
      ],
      channel_skus: [
        {
          id: "sku-b",
          updated_at: "2026-07-17T12:00:00.000Z",
          lifecycle_status: "ERROR",
          listing_status: "FAILED",
          asin: "B000000002",
        },
        {
          id: "sku-a",
          updated_at: "2026-07-17T12:00:00.000Z",
          lifecycle_status: "LIVE",
          listing_status: "LIVE",
          asin: "B000000001",
        },
      ],
    },
  };
}

function publicationSnapshot(): RecipeBackfillPublicationSnapshot & {
  draft: RecipeBackfillPublicationSnapshot["draft"] & Record<string, unknown>;
  master: NonNullable<RecipeBackfillPublicationSnapshot["master"]> &
    Record<string, unknown>;
} {
  const sku = {
    id: "sku-1",
    channel: "AMAZON_SALUTEM",
    sku: "AA-ASAA-AAAA",
    upc: "012345678905",
    asin: "B000000001",
    walmart_item_id: null,
    ebay_item_id: null,
    tiktok_product_id: null,
    lifecycle_status: "LIVE",
    listing_status: "LIVE",
    submission_id: "submission-1",
    submitted_at: "2026-07-10T11:00:00.000Z",
    processing_at: "2026-07-10T11:30:00.000Z",
    live_at: "2026-07-10T12:00:00.000Z",
    live_url: "https://www.amazon.com/dp/B000000001",
    published_at: "2026-07-10T12:00:00.000Z",
    last_status_check_at: "2026-07-17T12:00:00.000Z",
    distribution_attempt_count: 2,
    distribution_errors: null,
    last_error_at: null,
    errors: null,
    validation_status: "PASSED",
    available_quantity: 5,
    compliance_status: "CAN_PUBLISH",
  };
  return {
    draft: {
      id: "draft-1",
      master_bundle_id: "master-1",
      status: "PUBLISHED",
      published_at: "2026-07-10T12:00:00.000Z",
      approved_at: "2026-07-09T12:00:00.000Z",
      compliance_status: "CAN_PUBLISH",
    },
    master: {
      id: "master-1",
      lifecycle_status: "LIVE",
      channel_skus: [sku],
      estimated_cost_cents: 1000,
    },
  };
}

test("optimistic digest is stable across unordered relation rows", () => {
  const original = optimisticSnapshot();
  const reordered = structuredClone(original);
  reordered.draft.generated_content?.reverse();
  reordered.master?.components?.reverse();
  reordered.master?.channel_skus?.reverse();
  assert.equal(
    recipeBackfillOptimisticDigest(reordered),
    recipeBackfillOptimisticDigest(original),
  );
});

test("optimistic digest catches drift in every guarded relation", () => {
  const expected = recipeBackfillOptimisticDigest(optimisticSnapshot());
  const mutations: Array<(value: RecipeBackfillOptimisticSnapshot) => void> = [
    (value) => {
      value.draft.status = "PUBLISHING";
    },
    (value) => {
      (value.draft.variation_matrix as Record<string, unknown>).variants_json = "[]";
    },
    (value) => {
      value.draft.generated_content![0].updated_at = "2026-07-18T00:00:00.000Z";
    },
    (value) => {
      value.master!.lifecycle_status = "PROCESSING";
    },
    (value) => {
      value.master!.components![0].qty = 99;
    },
    (value) => {
      value.master!.channel_skus![0].listing_status = "PENDING_REVIEW";
    },
    (value) => {
      value.master!.channel_skus!.push({ id: "sku-c" });
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(optimisticSnapshot());
    mutate(changed);
    assert.notEqual(recipeBackfillOptimisticDigest(changed), expected);
  }
});

test("digest guard fails closed with an actionable rollback error", () => {
  assert.throws(
    () => assertRecipeBackfillDigest("Draft draft-1", "expected", "actual"),
    /changed after the read-only plan; transaction rolled back/,
  );
  assert.doesNotThrow(() =>
    assertRecipeBackfillDigest("Draft draft-1", "same", "same"),
  );
});

test("publication digest ignores invalidated gates but protects factual state", () => {
  const original = publicationSnapshot();
  const expected = recipeBackfillPublicationDigest(original);
  const invalidated = structuredClone(original);
  Object.assign(invalidated.draft, recipeBackfillDraftInvalidation(), {
    draft_components: "[{\"qty\":24}]",
  });
  Object.assign(
    invalidated.master.channel_skus[0],
    recipeBackfillChannelSkuInvalidation(),
    { attributes: "{\"new\":true}", price_cents: 7699 },
  );
  invalidated.master.estimated_cost_cents = 2000;
  assert.equal(recipeBackfillPublicationDigest(invalidated), expected);

  const factualMutations: Array<
    (value: ReturnType<typeof publicationSnapshot>) => void
  > = [
    (value) => {
      value.draft.status = "GENERATED";
    },
    (value) => {
      value.master.lifecycle_status = "GENERATED";
    },
    (value) => {
      value.master.channel_skus[0].lifecycle_status = "GENERATED";
    },
    (value) => {
      value.master.channel_skus[0].listing_status = "FAILED";
    },
    (value) => {
      value.master.channel_skus[0].asin = "B000000099";
    },
    (value) => {
      value.master.channel_skus[0].published_at = null;
    },
    (value) => {
      value.master.channel_skus[0].distribution_attempt_count += 1;
    },
  ];
  for (const mutate of factualMutations) {
    const changed = structuredClone(publicationSnapshot());
    mutate(changed);
    assert.notEqual(recipeBackfillPublicationDigest(changed), expected);
  }
});

test("invalidation helpers expose only the reviewed downstream keys", () => {
  assert.deepEqual(Object.keys(recipeBackfillDraftInvalidation()).sort(), [
    "approval_notes",
    "approved_at",
    "approved_by",
    "compliance_blocked_at",
    "compliance_blocked_reasons",
    "compliance_check_id",
    "compliance_status",
  ]);
  assert.deepEqual(Object.keys(recipeBackfillChannelSkuInvalidation()).sort(), [
    "available_quantity",
    "compliance_blocked_at",
    "compliance_blocked_reasons",
    "compliance_check_id",
    "compliance_status",
    "inventory_checked_at",
    "validated_at",
    "validation_check_id",
    "validation_errors",
    "validation_status",
  ]);
  assert.deepEqual(Object.keys(recipeBackfillGeneratedContentInvalidation()).sort(), [
    "compliance_check_id",
    "compliance_status",
    "failed_rule_ids",
    "manual_review_required",
  ]);

  const protectedKeys = new Set([
    "status",
    "lifecycle_status",
    "listing_status",
    "asin",
    "published_at",
    "live_at",
    "submitted_at",
    "submission_id",
  ]);
  for (const update of [
    recipeBackfillDraftInvalidation(),
    recipeBackfillChannelSkuInvalidation(),
    recipeBackfillGeneratedContentInvalidation(),
  ]) {
    assert.deepEqual(
      Object.keys(update).filter((key) => protectedKeys.has(key)),
      [],
    );
  }
});

test("audit event records RECIPE_BACKFILLED without a fake transition", () => {
  const event = recipeBackfillAuditEvent({
    currentStatus: "PUBLISHED",
    oldDraftSignature: null,
    oldMasterSignature: "old",
    canonicalSignature: "new",
    componentCount: 2,
    packCount: 24,
  });
  assert.equal(event.trigger, "RECIPE_BACKFILLED");
  assert.equal(event.from_status, "PUBLISHED");
  assert.equal(event.to_status, "PUBLISHED");
  assert.equal(event.details.publication_state_preserved, true);
  assert.equal(event.details.compliance_invalidated, true);
});
