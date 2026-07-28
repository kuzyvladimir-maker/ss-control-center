import assert from "node:assert/strict";
import test from "node:test";

import {
  walmartListingIntegritySha256,
  type WalmartListingSurface,
} from "../listing-integrity-audit.ts";
import {
  canonicalWalmartListingSurgicalJson,
} from "../listing-integrity-remediation-payload.ts";
import type {
  SealedWalmartListingRepairPlan,
} from "../listing-integrity-remediation-qualification.ts";
import {
  WALMART_LISTING_REPAIR_REVIEWED_MAIN_CERTIFICATE_SCHEMA,
  verifyWalmartListingRepairReviewedMainCertificateBytes,
} from "../listing-integrity-remediation-reviewed-main-certificate.ts";

const baselineSurface: WalmartListingSurface = {
  title: "Exact Hot Dog Buns, 14 oz, Pack of 2",
  description: "Old ambiguous description",
  bullets: ["Old ambiguous bullet"],
  attribute_claims: [],
  unmapped_attributes: [],
};

const targetSurface: WalmartListingSurface = {
  ...baselineSurface,
  description: "PACK OF 2: Two exact 14 oz packages.",
  bullets: ["PACK OF 2: Two exact packages."],
};

const baselineImages = [{
  slot: "main" as const,
  source_url: "https://i5.walmartimages.com/old-main.png",
  sha256: "1".repeat(64),
}, {
  slot: "gallery-1" as const,
  source_url: "https://i5.walmartimages.com/gallery.png",
  sha256: "2".repeat(64),
}];

const targetImages = [{
  slot: "main" as const,
  source_url: `https://assets.example.invalid/${"3".repeat(64)}.png`,
  sha256: "3".repeat(64),
}, baselineImages[1]!];

function repairPlan(): SealedWalmartListingRepairPlan {
  const target = {
    surface: targetSurface,
    images: targetImages,
    target_sha256: walmartListingIntegritySha256({
      surface: targetSurface,
      images: targetImages,
    }),
  };
  const body = {
    schema_version: "walmart-listing-repair-plan/v2" as const,
    plan_id: "reviewed-main-plan-1",
    created_at: "2026-07-27T12:00:00.000Z",
    expires_at: "2026-07-27T13:00:00.000Z",
    verifier_engine_release_sha256: "4".repeat(64),
    apply_engine_release_sha256: "5".repeat(64),
    sequence: {
      authorization_sha256: "6".repeat(64),
      sequence_id: "sequence-1",
      sequence_epoch: "epoch-1",
      position: 0,
      population_artifact_sha256: "7".repeat(64),
    },
    listing: {
      channel: "WALMART_US" as const,
      store_index: 1,
      sku: "SKU-2",
      listing_key: "walmart:1:SKU-2",
      item_id: "123456789",
      captured_at: "2026-07-27T11:55:00.000Z",
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
      composition: "same_product" as const,
    },
    baseline: {
      report_id: "report-1",
      report_body_sha256: "8".repeat(64),
      input_body_sha256: "9".repeat(64),
      captured_at: "2026-07-27T11:55:00.000Z",
      overall_verdict: "BAD" as const,
      surface_sha256: walmartListingIntegritySha256(baselineSurface),
      images_sha256: walmartListingIntegritySha256(baselineImages),
      buyer_payload_sha256: "a".repeat(64),
      surface_payload_sha256: "b".repeat(64),
      source_evidence_inventory_sha256: "c".repeat(64),
      live_capture_exchange_sha256: "d".repeat(64),
      authenticated_capture_nonce_sha256: "e".repeat(64),
    },
    product_truth: {
      expected_sha256: "f".repeat(64),
      product_truth_snapshot_id: "snapshot-1",
      product_truth_snapshot_body_sha256: "0".repeat(64),
      product_truth_snapshot_file_sha256: "1".repeat(64),
      truth_revision_id: "revision-1",
      truth_revision_body_sha256: "2".repeat(64),
      truth_approval_sha256: "3".repeat(64),
    },
    target,
    changed_fields: ["description", "bullets", "main"] as const,
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

function certificate(plan: SealedWalmartListingRepairPlan) {
  const body = {
    schema_version: WALMART_LISTING_REPAIR_REVIEWED_MAIN_CERTIFICATE_SCHEMA,
    created_at: "2026-07-27T12:01:00.000Z",
    expires_at: "2026-07-27T12:31:00.000Z",
    plan: {
      plan_id: plan.plan_id,
      body_sha256: plan.body_sha256,
      target_sha256: plan.target.target_sha256,
    },
    listing: {
      channel: plan.listing.channel,
      store_index: plan.listing.store_index,
      sku: plan.listing.sku,
      listing_key: plan.listing.listing_key,
      item_id: plan.listing.item_id,
    },
    product_truth: {
      artifact_sha256: "4".repeat(64),
      expected_sha256: plan.product_truth.expected_sha256,
      canonical_variant_id: "variant-hot-dog-buns-14oz",
      content_observation_id: "observation-1",
      outer_units: 2,
    },
    changed_main: {
      source_url: targetImages[0]!.source_url,
      asset_sha256: targetImages[0]!.sha256,
      byte_size: 2_000_000,
      width: 2_200,
      height: 2_200,
      content_type: "image/png" as const,
      derivation: "DETERMINISTIC_EXACT_SINGLE_UNIT_TILE" as const,
      single_unit_source_artifact_sha256: "5".repeat(64),
      single_unit_source_sha256: "6".repeat(64),
      candidate_manifest_artifact_sha256: "7".repeat(64),
      candidate_manifest_body_sha256: "8".repeat(64),
      qualification_artifact_sha256: "9".repeat(64),
      qualification_body_sha256: "a".repeat(64),
      observer_plan_artifact_sha256: "b".repeat(64),
      observer_plan_body_sha256: "c".repeat(64),
      observer_request_artifact_sha256: "d".repeat(64),
      observer_response_artifact_sha256: "e".repeat(64),
      worker_receipt_key_id: "worker-key-1",
      worker_receipt_public_key_spki_sha256: "f".repeat(64),
      worker_build: `sha256:${"0".repeat(64)}` as const,
      blind_decision_sha256: "1".repeat(64),
      r2_staging_artifact_sha256: "2".repeat(64),
      r2_staging_body_sha256: "3".repeat(64),
    },
    unchanged_gallery: {
      exact_projection_sha256: walmartListingIntegritySha256(
        targetImages.slice(1),
      ),
      slot_count: 1,
    },
    owner_review: {
      compilation_request_file_sha256: "4".repeat(64),
      compilation_request_body_sha256: "5".repeat(64),
      exact_confirmation_sha256: "6".repeat(64),
    },
    policy: {
      changed_fields_exactly_description_bullets_main: true as const,
      exact_product_truth_verified: true as const,
      deterministic_candidate_bytes_verified: true as const,
      signed_blind_worker_receipt_verified: true as const,
      blind_visual_decision_passed: true as const,
      content_addressed_public_bytes_verified: true as const,
      gallery_preserved_exactly: true as const,
      authority: "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY" as const,
      owner_permit_must_bind_certificate_sha256: true as const,
    },
  };
  const bodySha = walmartListingIntegritySha256(body);
  return {
    ...body,
    certificate_id: `walmart-reviewed-main-${bodySha.slice(0, 24)}`,
    body_sha256: bodySha,
  };
}

function bytes(value: unknown): Buffer {
  return Buffer.from(canonicalWalmartListingSurgicalJson(value), "utf8");
}

test("reviewed-MAIN certificate binds exact plan, MAIN, gallery, and policy", () => {
  const plan = repairPlan();
  const verified = verifyWalmartListingRepairReviewedMainCertificateBytes({
    certificate_bytes: bytes(certificate(plan)),
    plan,
    at: "2026-07-27T12:02:00.000Z",
  });
  assert.equal(verified.changed_main.asset_sha256, targetImages[0]!.sha256);
  assert.equal(verified.unchanged_gallery.slot_count, 1);
  assert.equal(verified.policy.owner_permit_must_bind_certificate_sha256, true);
});

test("reviewed-MAIN certificate rejects extra fields and plan/MAIN drift", () => {
  const plan = repairPlan();
  const extra = {
    ...certificate(plan),
    unreviewed_authority: true,
  };
  assert.throws(
    () => verifyWalmartListingRepairReviewedMainCertificateBytes({
      certificate_bytes: bytes(extra),
      plan,
      at: "2026-07-27T12:02:00.000Z",
    }),
    /fields are not exact/u,
  );

  const changedPlan = structuredClone(plan);
  changedPlan.target.images[0]!.sha256 = "9".repeat(64);
  assert.throws(
    () => verifyWalmartListingRepairReviewedMainCertificateBytes({
      certificate_bytes: bytes(certificate(plan)),
      plan: changedPlan,
      at: "2026-07-27T12:02:00.000Z",
    }),
    /does not bind the exact reviewed plan/u,
  );
});
