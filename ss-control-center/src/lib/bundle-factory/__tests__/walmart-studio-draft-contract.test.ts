import assert from "node:assert/strict";
import test from "node:test";

import {
  WALMART_STUDIO_DRAFT_BRIEF_SCHEMA,
  buildWalmartStudioDraftWorkItems,
  parseWalmartStudioDraftBrief,
  parseWalmartStudioDraftWorkItem,
  WalmartStudioDraftContractError,
} from "../walmart-studio-draft-contract";
import type {
  ProductTruthWalmartRequestCandidateDiagnostic,
} from "@/lib/sourcing/product-truth-read-contract";

function diagnostic(index: number, ready = true): ProductTruthWalmartRequestCandidateDiagnostic {
  return {
    donor_product_id: `donor-${index}`,
    canonical_variant_id: `variant-${index}`,
    title: `Campbell's soup ${index}`,
    brand: "Campbell's",
    flavor: `Flavor ${index}`,
    match_score: 50 - index,
    ready,
    missing: ready ? [] : ["MAIN_IMAGE"],
    blockers: ready ? [] : ["MAIN_IMAGE_MISSING"],
    candidate: ready
      ? {
          donor_product_id: `donor-${index}`,
          canonical_variant_id: `variant-${index}`,
          title: `Campbell's soup ${index}`,
          brand: "Campbell's",
          flavor: `Flavor ${index}`,
          manufacturer_upc: `0000000000${index}`,
          category: "Canned soup",
          storage_classification: "SHELF_STABLE",
          classification_evidence: {
            category_field: "category",
            storage_field: "storage",
            content_observation_id: `content-${index}`,
            source_api: "target",
          },
          content_observation_id: `content-${index}`,
          price_observation_id: `price-${index}`,
          observed_price: 2.99,
          price_observed_at: "2026-08-01T12:00:00.000Z",
          content_observed_at: "2026-08-01T12:00:00.000Z",
          image_count: 4,
          default_pack_counts: [2, 3],
          score: 108,
        }
      : null,
  };
}

test("admits exactly the requested number of donor-bound draft work items", () => {
  const items = buildWalmartStudioDraftWorkItems({
    candidates: [diagnostic(1), diagnostic(2), diagnostic(3), diagnostic(4), diagnostic(5)],
    listingCount: 5,
    packCount: 8,
    storeIndex: 1,
    shippingTemplateId: "default",
    shippingTemplateSha256: "a".repeat(64),
    targetMarginBps: 3_000,
    asOf: "2026-08-01T12:00:00.000Z",
    priceMaxAgeMs: 86_400_000,
    zip: "33765",
  });

  assert.equal(items.length, 5);
  assert.deepEqual(items.map((item) => item.spec_index), [0, 1, 2, 3, 4]);
  assert.ok(items.every((item) => item.pack_count === 8));
  assert.ok(items.every((item) => item.marketplace_mutation_allowed === false));
  assert.ok(items.every((item) => item.upc_reservation_allowed === false));
  assert.equal(new Set(items.map((item) => item.canonical_variant_id)).size, 5);
  assert.deepEqual(parseWalmartStudioDraftWorkItem(items[0]), items[0]);
});
test("fails closed instead of silently substituting fewer or duplicate variants", () => {
  const duplicate = diagnostic(2);
  duplicate.canonical_variant_id = "variant-1";
  assert.throws(
    () => buildWalmartStudioDraftWorkItems({
      candidates: [diagnostic(1), duplicate, diagnostic(3, false)],
      listingCount: 2,
      packCount: 8,
      storeIndex: 1,
      shippingTemplateId: "default",
      shippingTemplateSha256: "a".repeat(64),
      targetMarginBps: 3_000,
      asOf: "2026-08-01T12:00:00.000Z",
      priceMaxAgeMs: 86_400_000,
      zip: "33765",
    }),
    (error) =>
      error instanceof WalmartStudioDraftContractError &&
      error.code === "INSUFFICIENT_DISTINCT_READY_VARIANTS",
  );
});

test("detects any work-item mutation after admission", () => {
  const [item] = buildWalmartStudioDraftWorkItems({
    candidates: [diagnostic(1)],
    listingCount: 1,
    packCount: 8,
    storeIndex: 1,
    shippingTemplateId: "default",
    shippingTemplateSha256: "a".repeat(64),
    targetMarginBps: 3_000,
    asOf: "2026-08-01T12:00:00.000Z",
    priceMaxAgeMs: 86_400_000,
    zip: "33765",
  });
  // Changing the pack size alone now trips the composition check first — the
  // components still hold 8 units — which is a more specific refusal of the
  // same tampering.
  assert.throws(
    () => parseWalmartStudioDraftWorkItem({ ...item, pack_count: 6 }),
    (error) =>
      error instanceof WalmartStudioDraftContractError &&
      error.code === "WORK_ITEM_INVALID",
  );

  // A mutation that keeps the composition self-consistent has nothing left to
  // catch it but the seal, so the seal must still catch it.
  assert.throws(
    () => parseWalmartStudioDraftWorkItem({
      ...item,
      pack_count: 6,
      components: [{ ...item.components[0], quantity: 6 }],
    }),
    (error) =>
      error instanceof WalmartStudioDraftContractError &&
      error.code === "WORK_ITEM_HASH_MISMATCH",
  );

  // And so must a change to a field the composition never looks at.
  assert.throws(
    () => parseWalmartStudioDraftWorkItem({ ...item, zip: "90210" }),
    (error) =>
      error instanceof WalmartStudioDraftContractError &&
      error.code === "WORK_ITEM_HASH_MISMATCH",
  );
});

test("brief parser binds every work item to one template and zero write authority", () => {
  const [item] = buildWalmartStudioDraftWorkItems({
    candidates: [diagnostic(1)],
    listingCount: 1,
    packCount: 8,
    storeIndex: 1,
    shippingTemplateId: "default",
    shippingTemplateSha256: "a".repeat(64),
    targetMarginBps: 3_000,
    asOf: "2026-08-01T12:00:00.000Z",
    priceMaxAgeMs: 86_400_000,
    zip: "33765",
  });
  const brief = {
    studio_version: 5,
    workflow: "CANONICAL_WALMART_NEW_SKU",
    draft_schema_version: WALMART_STUDIO_DRAFT_BRIEF_SCHEMA,
    source: "prompt",
    prompt: "Create one Campbell's soup listing",
    channel: "WALMART",
    listing_count: 1,
    pack_count: 8,
    target_margin_pct: 30,
    photo_strategy: "reuse-donor",
    walmart_shipping: {
      store_index: 1,
      account_name: "SIRIUS",
      selected_at: "2026-08-01T12:00:00.000Z",
      template: {
        id: "default",
        template_sha256: "a".repeat(64),
      },
    },
    product_truth_admission: {
      as_of: "2026-08-01T12:00:00.000Z",
      price_max_age_ms: 86_400_000,
      zip: "33765",
      matched_variants: 1,
      ready_variants: 1,
    },
    pricing_inputs: {
      packaging_cost_cents: 150,
      shipping_label_cents: 878,
      referral_fee_bps: 1_500,
      target_margin_bps: 3_000,
    },
    execution_work_items: [item],
    operator_contract: {
      engine: "walmart-studio-draft-engine",
      marketplace_mutation_authorized: false,
      upc_reservation_authorized: false,
      next_step: "draft only",
    },
  };
  assert.deepEqual(parseWalmartStudioDraftBrief(brief), brief);
  assert.throws(
    () => parseWalmartStudioDraftBrief({
      ...brief,
      operator_contract: {
        ...brief.operator_contract,
        marketplace_mutation_authorized: true,
      },
    }),
    (error) =>
      error instanceof WalmartStudioDraftContractError &&
      error.code === "BRIEF_AUTHORITY_INVALID",
  );
});
