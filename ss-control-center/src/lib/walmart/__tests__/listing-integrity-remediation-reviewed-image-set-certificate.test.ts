import assert from "node:assert/strict";
import { test } from "node:test";

import { walmartListingIntegritySha256 } from "../listing-integrity-audit.ts";
import { canonicalWalmartListingSurgicalJson } from "../listing-integrity-remediation-payload.ts";
import {
  WALMART_LISTING_REPAIR_REVIEWED_IMAGE_SET_CERTIFICATE_SCHEMA,
  verifyWalmartListingRepairReviewedImageSetCertificateBytes,
} from "../listing-integrity-remediation-reviewed-image-set-certificate.ts";
import type {
  SealedWalmartListingRepairPlan,
} from "../listing-integrity-remediation-qualification.ts";

const TARGET_IMAGES = [{
  slot: "main" as const,
  source_url: `https://assets.example.test/main/${"a".repeat(64)}.png`,
  sha256: "a".repeat(64),
}, {
  slot: "gallery-1" as const,
  source_url: `https://assets.example.test/gallery/${"b".repeat(64)}.jpg`,
  sha256: "b".repeat(64),
}, {
  slot: "gallery-2" as const,
  source_url: `https://assets.example.test/gallery/${"c".repeat(64)}.jpg`,
  sha256: "c".repeat(64),
}];

function plan(): SealedWalmartListingRepairPlan {
  const body = {
    schema_version: "walmart-listing-integrity-repair-plan/v2" as const,
    plan_id: "image-set-certificate-test",
    created_at: "2026-07-28T12:00:00.000Z",
    expires_at: "2026-07-28T13:00:00.000Z",
    verifier_engine_release_sha256: "d".repeat(64),
    apply_engine_release_sha256: "e".repeat(64),
    sequence: {
      authorization_sha256: "f".repeat(64),
      sequence_id: "sequence-test",
      sequence_epoch: "epoch-test",
      position: 0,
      population_artifact_sha256: "0".repeat(64),
    },
    listing: {
      channel: "WALMART_US" as const,
      store_index: 1,
      sku: "image-set-test",
      listing_key: "walmart:1:image-set-test",
      item_id: "123456789",
      captured_at: "2026-07-28T11:55:00.000Z",
      published_status: "PUBLISHED" as const,
      lifecycle_status: "ACTIVE" as const,
      composition: "same_product" as const,
    },
    baseline: {
      report_id: "report-test",
      report_body_sha256: "1".repeat(64),
      input_body_sha256: "2".repeat(64),
      captured_at: "2026-07-28T11:55:00.000Z",
      overall_verdict: "BAD" as const,
      surface_sha256: "3".repeat(64),
      images_sha256: "4".repeat(64),
      buyer_payload_sha256: "5".repeat(64),
      surface_payload_sha256: "6".repeat(64),
      source_evidence_inventory_sha256: "7".repeat(64),
      live_capture_exchange_sha256: "8".repeat(64),
      authenticated_capture_nonce_sha256: "9".repeat(64),
    },
    product_truth: {
      expected_sha256: "a".repeat(64),
      product_truth_snapshot_id: "truth-test",
      product_truth_snapshot_body_sha256: "b".repeat(64),
      product_truth_snapshot_file_sha256: "c".repeat(64),
      truth_revision_id: "revision-test",
      truth_revision_body_sha256: "d".repeat(64),
      truth_approval_sha256: "e".repeat(64),
    },
    target: {
      surface: {
        title: "Pepperidge Farm White Sandwich Bread, 16 oz (Pack of 4)",
        description: "PACK OF 4: Pepperidge Farm White Sandwich Bread.",
        bullets: ["PACK OF 4: Four 16 oz loaves."],
        attribute_claims: [],
        unmapped_attributes: [],
      },
      images: TARGET_IMAGES,
      target_sha256: walmartListingIntegritySha256({
        surface: {
          title: "Pepperidge Farm White Sandwich Bread, 16 oz (Pack of 4)",
          description: "PACK OF 4: Pepperidge Farm White Sandwich Bread.",
          bullets: ["PACK OF 4: Four 16 oz loaves."],
          attribute_claims: [],
          unmapped_attributes: [],
        },
        images: TARGET_IMAGES,
      }),
    },
    changed_fields: ["description", "bullets", "main", "gallery"],
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
      propagation_failure_not_before_ms: 21_600_000 as const,
    },
  };
  return {
    ...body,
    body_sha256: walmartListingIntegritySha256(body),
  };
}

function certificate(planValue: SealedWalmartListingRepairPlan) {
  const body = {
    schema_version: WALMART_LISTING_REPAIR_REVIEWED_IMAGE_SET_CERTIFICATE_SCHEMA,
    created_at: "2026-07-28T12:05:00.000Z",
    expires_at: "2026-07-28T12:30:00.000Z",
    plan: {
      plan_id: planValue.plan_id,
      body_sha256: planValue.body_sha256,
      target_sha256: planValue.target.target_sha256,
    },
    listing: {
      channel: planValue.listing.channel,
      store_index: planValue.listing.store_index,
      sku: planValue.listing.sku,
      listing_key: planValue.listing.listing_key,
      item_id: planValue.listing.item_id,
    },
    product_truth: {
      artifact_sha256: "1".repeat(64),
      expected_sha256: planValue.product_truth.expected_sha256,
      canonical_variant_id: "variant-test",
      content_observation_id: "observation-test",
      outer_units: 4,
    },
    target_image_set: {
      exact_projection_sha256: walmartListingIntegritySha256(planValue.target.images),
      slot_count: planValue.target.images.length,
      main_source_url: planValue.target.images[0]!.source_url,
      main_asset_sha256: planValue.target.images[0]!.sha256,
      main_derivation: "DETERMINISTIC_EXACT_SINGLE_UNIT_TILE" as const,
      source_candidate_manifest_artifact_sha256: "2".repeat(64),
      source_candidate_manifest_body_sha256: "3".repeat(64),
      source_qualification_artifact_sha256: "4".repeat(64),
      source_qualification_body_sha256: "5".repeat(64),
      observer_plan_artifact_sha256: "6".repeat(64),
      observer_plan_body_sha256: "7".repeat(64),
      observer_request_artifact_sha256: ["8".repeat(64)],
      observer_response_artifact_sha256: ["9".repeat(64)],
      worker_receipt_sha256: ["a".repeat(64)],
      curated_manifest_artifact_sha256: "b".repeat(64),
      curated_manifest_body_sha256: "c".repeat(64),
      r2_staging_artifact_sha256: "d".repeat(64),
      r2_staging_body_sha256: "e".repeat(64),
    },
    owner_review: {
      compilation_request_file_sha256: "f".repeat(64),
      compilation_request_body_sha256: "0".repeat(64),
      exact_confirmation_sha256: "1".repeat(64),
    },
    policy: {
      changed_fields_exactly_description_bullets_main_gallery: true as const,
      exact_product_truth_verified: true as const,
      deterministic_main_bytes_verified: true as const,
      signed_blind_worker_receipts_verified: true as const,
      every_published_target_passed: true as const,
      content_addressed_public_main_verified: true as const,
      authority: "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY" as const,
      owner_permit_must_bind_certificate_sha256: true as const,
    },
  };
  const bodySha = walmartListingIntegritySha256(body);
  return {
    ...body,
    certificate_id: `walmart-reviewed-image-set-${bodySha.slice(0, 24)}`,
    body_sha256: bodySha,
  };
}

test("reviewed image-set certificate binds the exact MAIN+gallery plan", () => {
  const planValue = plan();
  const value = certificate(planValue);
  const bytes = Buffer.from(canonicalWalmartListingSurgicalJson(value), "utf8");
  const verified = verifyWalmartListingRepairReviewedImageSetCertificateBytes({
    certificate_bytes: bytes,
    plan: planValue,
    at: "2026-07-28T12:10:00.000Z",
  });
  assert.equal(verified.target_image_set.slot_count, 3);
  assert.equal(verified.target_image_set.main_asset_sha256, "a".repeat(64));
});

test("reviewed image-set certificate rejects a plan with different gallery bytes", () => {
  const planValue = plan();
  const value = certificate(planValue);
  const bytes = Buffer.from(canonicalWalmartListingSurgicalJson(value), "utf8");
  const changedPlan = structuredClone(planValue);
  changedPlan.target.images[1]!.sha256 = "f".repeat(64);
  assert.throws(
    () => verifyWalmartListingRepairReviewedImageSetCertificateBytes({
      certificate_bytes: bytes,
      plan: changedPlan,
      at: "2026-07-28T12:10:00.000Z",
    }),
    /exact reviewed plan\/image-set policy/u,
  );
});

test("reviewed image-set certificate rejects a false PASS policy bit", () => {
  const planValue = plan();
  const value = certificate(planValue);
  const tampered = structuredClone(value);
  tampered.policy.every_published_target_passed = false as true;
  const body = structuredClone(tampered) as Record<string, unknown>;
  delete body.certificate_id;
  delete body.body_sha256;
  const bodySha = walmartListingIntegritySha256(body);
  tampered.body_sha256 = bodySha;
  tampered.certificate_id = `walmart-reviewed-image-set-${bodySha.slice(0, 24)}`;
  assert.throws(
    () => verifyWalmartListingRepairReviewedImageSetCertificateBytes({
      certificate_bytes: Buffer.from(
        canonicalWalmartListingSurgicalJson(tampered),
        "utf8",
      ),
      plan: planValue,
      at: "2026-07-28T12:10:00.000Z",
    }),
    /exact reviewed plan\/image-set policy/u,
  );
});
