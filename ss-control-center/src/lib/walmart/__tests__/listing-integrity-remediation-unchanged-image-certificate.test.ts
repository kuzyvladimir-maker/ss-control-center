import assert from "node:assert/strict";
import test from "node:test";

import {
  walmartListingIntegritySha256,
  type WalmartListingSurface,
} from "../listing-integrity-audit.ts";
import type {
  SealedWalmartListingRepairPlan,
} from "../listing-integrity-remediation-qualification.ts";
import {
  certifyWalmartListingRepairUnchangedImages,
  verifyWalmartListingRepairUnchangedImageCertificateBytes,
} from "../listing-integrity-remediation-unchanged-image-certificate.ts";

const images = [
  {
    slot: "main" as const,
    source_url: "https://i5.walmartimages.com/main.png",
    sha256: "1".repeat(64),
  },
  {
    slot: "gallery-1" as const,
    source_url: "https://i5.walmartimages.com/gallery.jpeg",
    sha256: "2".repeat(64),
  },
];

const baselineSurface: WalmartListingSurface = {
  title: "Exact buns Pack of 6",
  description: "Old exact description",
  bullets: ["Old exact bullet"],
  attribute_claims: [{
    field_path: "review.outer_units",
    kind: "outer_units",
    value: 6,
    unit: "count",
  }],
  unmapped_attributes: [],
};

const targetSurface: WalmartListingSurface = {
  ...baselineSurface,
  description: "PACK OF 6: Exact description",
  bullets: ["PACK OF 6: Exact bullet"],
};

function repairPlan(
  changedFields: SealedWalmartListingRepairPlan["changed_fields"] =
    ["description", "bullets"],
): SealedWalmartListingRepairPlan {
  const target = {
    surface: targetSurface,
    images,
    target_sha256: walmartListingIntegritySha256({
      surface: targetSurface,
      images,
    }),
  };
  const body = {
    schema_version: "walmart-listing-repair-plan/v2" as const,
    plan_id: "unchanged-image-fixture",
    created_at: "2026-07-25T12:00:00.000Z",
    expires_at: "2026-07-25T13:00:00.000Z",
    verifier_engine_release_sha256: "3".repeat(64),
    apply_engine_release_sha256: "4".repeat(64),
    sequence: {
      authorization_sha256: "5".repeat(64),
      sequence_id: "sequence-1",
      sequence_epoch: "epoch-1",
      position: 0,
      population_artifact_sha256: "6".repeat(64),
    },
    listing: {
      channel: "WALMART_US" as const,
      store_index: 1,
      sku: "SKU-6",
      listing_key: "walmart:1:SKU-6",
      item_id: "123456789",
      captured_at: "2026-07-25T11:55:00.000Z",
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
      composition: "same_product" as const,
    },
    baseline: {
      report_id: "report-1",
      report_body_sha256: "7".repeat(64),
      input_body_sha256: "8".repeat(64),
      captured_at: "2026-07-25T11:55:00.000Z",
      overall_verdict: "BAD" as const,
      surface_sha256: walmartListingIntegritySha256(baselineSurface),
      images_sha256: walmartListingIntegritySha256(images),
      buyer_payload_sha256: "9".repeat(64),
      surface_payload_sha256: "a".repeat(64),
      source_evidence_inventory_sha256: "b".repeat(64),
      live_capture_exchange_sha256: "c".repeat(64),
      authenticated_capture_nonce_sha256: "d".repeat(64),
    },
    product_truth: {
      expected_sha256: "e".repeat(64),
      product_truth_snapshot_id: "snapshot-1",
      product_truth_snapshot_body_sha256: "f".repeat(64),
      product_truth_snapshot_file_sha256: "0".repeat(64),
      truth_revision_id: "revision-1",
      truth_revision_body_sha256: "1".repeat(64),
      truth_approval_sha256: "2".repeat(64),
    },
    target,
    changed_fields: changedFields,
    execution_policy: {
      signed_one_sku_permit_required: true as const,
      durable_permit_consumption_required: true as const,
      exact_raw_walmart_exchange_required: true as const,
      exact_listing_count: 1 as const,
      max_marketplace_write_calls: 1 as const,
      fresh_live_reread_required: true as const,
      async_source_aware_rebuild_required: true as const,
      cached_qualification_is_authority: false as const,
      next_sku_requires_rebuilt_pass: true as const,
      mass_apply_allowed: false as const,
      automatic_reapply_allowed: false as const,
      propagation_failure_not_before_ms: 7_200_000 as const,
    },
  };
  return {
    ...body,
    body_sha256: walmartListingIntegritySha256(body),
  } as unknown as SealedWalmartListingRepairPlan;
}

test("unchanged-image certificate binds an exact non-image repair", () => {
  const plan = repairPlan();
  const certificate = certifyWalmartListingRepairUnchangedImages({
    plan,
    created_at: "2026-07-25T12:01:00.000Z",
    expires_at: "2026-07-25T12:31:00.000Z",
    compilation_request_file_sha256: "3".repeat(64),
    compilation_request_body_sha256: "4".repeat(64),
    proposal_file_sha256: "5".repeat(64),
    review_certification_file_sha256: "6".repeat(64),
    baseline_images: images,
  });
  const bytes = Buffer.from(`${JSON.stringify(certificate)}\n`, "utf8");
  const verified = verifyWalmartListingRepairUnchangedImageCertificateBytes({
    certificate_bytes: bytes,
    plan,
    at: new Date("2026-07-25T12:02:00.000Z"),
  });
  assert.equal(verified.policy.images_changed, false);
  assert.deepEqual(verified.images, images);
});

test("unchanged-image certificate rejects image-changing or tampered plans", () => {
  assert.throws(
    () => certifyWalmartListingRepairUnchangedImages({
      plan: repairPlan(["main"]),
      created_at: "2026-07-25T12:01:00.000Z",
      expires_at: "2026-07-25T12:31:00.000Z",
      compilation_request_file_sha256: "3".repeat(64),
      compilation_request_body_sha256: "4".repeat(64),
      proposal_file_sha256: "5".repeat(64),
      review_certification_file_sha256: "6".repeat(64),
      baseline_images: images,
    }),
    /cannot authorize an image-changing plan/u,
  );
  const plan = repairPlan();
  const tampered = structuredClone(plan);
  tampered.target.images[0]!.sha256 = "f".repeat(64);
  assert.throws(
    () => certifyWalmartListingRepairUnchangedImages({
      plan: tampered,
      created_at: "2026-07-25T12:01:00.000Z",
      expires_at: "2026-07-25T12:31:00.000Z",
      compilation_request_file_sha256: "3".repeat(64),
      compilation_request_body_sha256: "4".repeat(64),
      proposal_file_sha256: "5".repeat(64),
      review_certification_file_sha256: "6".repeat(64),
      baseline_images: images,
    }),
    /repair plan body SHA mismatch/u,
  );
});
