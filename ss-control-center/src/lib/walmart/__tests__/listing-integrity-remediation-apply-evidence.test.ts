import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  walmartListingIntegritySha256,
  type WalmartListingSurface,
} from "../listing-integrity-audit.ts";
import {
  verifyWalmartListingRepairCustodyLoadedApplyEvidence,
  type WalmartListingRepairCustodyLoadedApplyEvidence,
} from "../listing-integrity-remediation-apply-evidence.ts";
import {
  WALMART_LISTING_REPAIR_ONE_SKU_ACTION,
  WALMART_LISTING_REPAIR_ONE_SKU_PERMIT_SCHEMA,
  WALMART_LISTING_REPAIR_OWNER_ALGORITHM,
  WALMART_LISTING_REPAIR_SEQUENCE_ACTION,
  WALMART_LISTING_REPAIR_SEQUENCE_AUTHORIZATION_SCHEMA,
  type WalmartListingRepairConsumptionLedgerBinding,
  type WalmartListingRepairOneSkuPermit,
  type WalmartListingRepairSequenceAuthorization,
} from "../listing-integrity-remediation-authority.ts";
import {
  WALMART_LISTING_REPAIR_LEDGER_ACCEPTED_SCHEMA,
  WALMART_LISTING_REPAIR_LEDGER_CLAIM_SCHEMA,
  WALMART_LISTING_REPAIR_LEDGER_HEAD_SCHEMA,
  WALMART_LISTING_REPAIR_LEDGER_IDENTITY_SCHEMA,
  WALMART_LISTING_REPAIR_LEDGER_REQUESTING_SCHEMA,
  WALMART_LISTING_REPAIR_LEDGER_TERMINAL_SCHEMA,
  type WalmartListingRepairLedgerHeadEvent,
  type WalmartListingRepairPermitLedgerEvidence,
  type WalmartListingRepairPermitTerminalReceipt,
} from "../listing-integrity-remediation-ledger.ts";
import {
  WALMART_LISTING_REPAIR_IMAGE_CERTIFICATE_SCHEMA,
} from "../listing-integrity-remediation-image-certificate.ts";
import {
  WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION,
  WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA,
  WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA,
  WALMART_LISTING_SURGICAL_SCHEMA_CONTRACT_SCHEMA,
  buildWalmartListingSurgicalRequest,
  canonicalWalmartListingSurgicalJson,
  walmartListingSurgicalSha256,
  type WalmartListingSurgicalBaselineReference,
  type WalmartListingSurgicalGetSpecReceipt,
  type WalmartListingSurgicalLiveItemReceipt,
  type WalmartListingSurgicalSchemaContract,
} from "../listing-integrity-remediation-payload.ts";
import {
  WALMART_LISTING_REPAIR_PLAN_SCHEMA,
  type SealedWalmartListingRepairPlan,
} from "../listing-integrity-remediation-qualification.ts";

const H = (char: string): string => char.repeat(64);
const SELLER = H("a");
const SEQUENCE_AUTH = H("b");
const PERMIT_AUTH = H("c");
const PRODUCT_TYPE = "Food And Beverage";
const SPEC_VERSION = WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION;
const FEED_ID = "feed-123";

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalWalmartListingSurgicalJson(value), "utf8");
}

function seal<T extends Record<string, unknown>>(body: T): T & { body_sha256: string } {
  return { ...body, body_sha256: walmartListingSurgicalSha256(body) };
}

function ledgerBytes(schema: string, body: Record<string, unknown>): Uint8Array {
  return Buffer.from(`${canonicalWalmartListingSurgicalJson({
    schema_version: schema,
    body,
    body_sha256: sha256(canonicalWalmartListingSurgicalJson(body)),
  })}\n`, "utf8");
}

function maintenanceSchema() {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    required: ["MPItemFeedHeader", "MPItem"],
    properties: {
      MPItemFeedHeader: {
        type: "object",
        additionalProperties: false,
        required: ["businessUnit", "locale", "version"],
        properties: {
          businessUnit: { const: "WALMART_US" },
          locale: { const: "en" },
          version: { const: SPEC_VERSION },
        },
      },
      MPItem: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["Orderable", "Visible"],
          properties: {
            Orderable: {
              type: "object",
              additionalProperties: false,
              required: ["sku", "productIdentifiers"],
              properties: {
                sku: { const: "SKU-EXACT-1" },
                productIdentifiers: {
                  type: "object",
                  additionalProperties: false,
                  required: ["productIdType", "productId"],
                  properties: {
                    productIdType: { const: "UPC" },
                    productId: { const: "012345678905" },
                  },
                },
              },
            },
            Visible: {
              type: "object",
              additionalProperties: false,
              required: [PRODUCT_TYPE],
              properties: {
                [PRODUCT_TYPE]: {
                  type: "object",
                  additionalProperties: false,
                  minProperties: 1,
                  properties: {
                    productName: { type: "string", minLength: 1 },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

function planFixture(): {
  plan: SealedWalmartListingRepairPlan;
  baseline: WalmartListingSurgicalBaselineReference;
} {
  const baselineSurface: WalmartListingSurface = {
    title: "Exact Product Pack of 1",
    description: "Exact product description",
    bullets: ["Exact product", "Buyer-visible facts"],
    attribute_claims: [],
    unmapped_attributes: [],
  };
  const targetSurface: WalmartListingSurface = {
    ...baselineSurface,
    title: "Exact Product Pack of 6",
  };
  const images = [
    {
      slot: "main" as const,
      source_url: "https://images.example.test/exact-main.jpg",
      sha256: H("1"),
    },
    {
      slot: "gallery-1" as const,
      source_url: "https://images.example.test/exact-gallery.jpg",
      sha256: H("2"),
    },
  ];
  const target = { surface: targetSurface, images };
  const body = {
    schema_version: WALMART_LISTING_REPAIR_PLAN_SCHEMA,
    plan_id: "repair-plan-1",
    created_at: "2026-07-20T12:00:00.000Z",
    expires_at: "2026-07-20T13:00:00.000Z",
    verifier_engine_release_sha256: H("2"),
    apply_engine_release_sha256: H("3"),
    sequence: {
      authorization_sha256: SEQUENCE_AUTH,
      sequence_id: "sequence-1",
      sequence_epoch: "epoch-1",
      position: 0,
      population_artifact_sha256: H("4"),
    },
    listing: {
      channel: "WALMART_US" as const,
      store_index: 1,
      sku: "SKU-EXACT-1",
      listing_key: "walmart:1:SKU-EXACT-1",
      item_id: "123456789",
      published_status: "PUBLISHED" as const,
      lifecycle_status: "ACTIVE" as const,
      captured_at: "2026-07-20T11:55:00.000Z",
      composition: "same_product" as const,
    },
    baseline: {
      report_id: "baseline-report-1",
      report_body_sha256: H("5"),
      input_body_sha256: H("6"),
      captured_at: "2026-07-20T11:55:00.000Z",
      overall_verdict: "BAD" as const,
      surface_sha256: walmartListingIntegritySha256(baselineSurface),
      images_sha256: walmartListingIntegritySha256(images),
      buyer_payload_sha256: H("7"),
      surface_payload_sha256: H("8"),
      source_evidence_inventory_sha256: H("9"),
      live_capture_exchange_sha256: H("d"),
      authenticated_capture_nonce_sha256: H("e"),
    },
    product_truth: {
      expected_sha256: H("1"),
      product_truth_snapshot_id: "truth-snapshot-1",
      product_truth_snapshot_body_sha256: H("2"),
      product_truth_snapshot_file_sha256: H("3"),
      truth_revision_id: "truth-revision-1",
      truth_revision_body_sha256: H("4"),
      truth_approval_sha256: H("5"),
    },
    target: {
      ...target,
      target_sha256: walmartListingIntegritySha256(target),
    },
    changed_fields: ["title" as const],
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
    plan: seal(body) as SealedWalmartListingRepairPlan,
    baseline: { surface: baselineSurface, images },
  };
}

function targetImageCertificate(
  plan: SealedWalmartListingRepairPlan,
  variant?: "MUTATED_BODY" | "WRONG_SCHEMA" | "WRONG_PLAN",
  expiresAt = "2026-07-20T12:30:00.000Z",
): Record<string, unknown> {
  const workerBuild = `sha256:${H("6")}`;
  const reservationLedger = {
    schema_version: "vision-call-reservation-ledger-contract/v1",
    ledger_id: "ledger-certificate-fixture",
    ledger_epoch: "epoch-certificate-fixture",
    state_directory_path_sha256: H("7"),
    directory_identity_sha256: H("8"),
    identity_artifact_sha256: H("9"),
  };
  const body = {
    schema_version: WALMART_LISTING_REPAIR_IMAGE_CERTIFICATE_SCHEMA as string,
    created_at: "2026-07-20T12:02:00.000Z",
    expires_at: expiresAt,
    plan: {
      plan_id: plan.plan_id,
      body_sha256: plan.body_sha256,
      artifact_sha256: sha256(jsonBytes(plan)),
      target_sha256: plan.target.target_sha256,
    },
    listing: {
      channel: "WALMART_US",
      store_index: plan.listing.store_index,
      sku: plan.listing.sku,
      listing_key: plan.listing.listing_key,
      item_id: plan.listing.item_id,
      projection_artifact_sha256: sha256(jsonBytes(plan.target.surface)),
    },
    product_truth: {
      snapshot_id: plan.product_truth.product_truth_snapshot_id,
      snapshot_body_sha256: plan.product_truth.product_truth_snapshot_body_sha256,
      snapshot_artifact_sha256: plan.product_truth.product_truth_snapshot_file_sha256,
      revision_id: plan.product_truth.truth_revision_id,
      revision_body_sha256: plan.product_truth.truth_revision_body_sha256,
      approval_sha256: plan.product_truth.truth_approval_sha256,
      recipe_id: "recipe-certificate-fixture",
      composition: "same_product",
      outer_unit_count: 6,
    },
    worker_trust: {
      run_lock_sha256: H("1"),
      key_id: "certificate-worker-key",
      public_key_spki_sha256: H("2"),
      worker_build: workerBuild,
      reservation_ledger: reservationLedger,
    },
    targets: plan.target.images.map((image, index) => ({
      slot: image.slot,
      ordinal: index,
      url: image.source_url,
      asset_sha256: image.sha256,
      byte_size: 1_024,
      content_type: "image/jpeg",
      width: 1_500,
      height: 1_500,
      downloaded_at: "2026-07-20T12:01:00.000Z",
      fresh_until: "2026-07-20T12:30:00.000Z",
      derivation: "DIRECT_EXACT_ASSET",
      represented_outer_unit_count: 6,
      represented_component_id: "component-certificate-fixture",
      represented_canonical_variant_id: "variant-certificate-fixture",
      represented_content_observation_id: "content-certificate-fixture",
      product_truth_source_ref_id: `source-certificate-${index}`,
      exact_variant_image_observation_sha256: H("3"),
      exact_variant_image_observation_id: `observation-certificate-${index}`,
      rights_evidence_sha256: H("4"),
      rights_evidence_id: `rights-certificate-${index}`,
      rights_basis: "SOURCE_ALLOWED",
      vision_batch_artifact_sha256: H("5"),
      vision_batch_body_sha256: H("6"),
      vision_receipt_key_id: "certificate-worker-key",
      vision_receipt_public_key_spki_sha256: H("2"),
      vision_worker_build: workerBuild,
      vision_reservation_ledger_id: reservationLedger.ledger_id,
      vision_reservation_ledger_epoch: reservationLedger.ledger_epoch,
      vision_issued_at: "2026-07-20T12:01:00.000Z",
      deterministic_visual_verdict: "PASS",
      deterministic_visual_decision_sha256: H("7"),
    })),
    policy: {
      exact_downloaded_bytes_verified: true,
      exact_variant_lineage_verified: true,
      rights_evidence_verified: true,
      signed_worker_v2_receipts_verified: true,
      query_free_urls_verified: true,
      redirects_absent_verified: true,
      slots_unique_and_contiguous: true,
      mixed_bundle_supported: false,
      authority: "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY",
      owner_permit_must_bind_certificate_sha256: true,
    },
  };
  if (variant === "WRONG_SCHEMA") body.schema_version = "attacker-certificate/v1";
  if (variant === "WRONG_PLAN") body.plan.plan_id = "attacker-plan";
  const bodySha = walmartListingIntegritySha256(body);
  const certificate = {
    ...body,
    certificate_id: `walmart-image-certificate-${bodySha.slice(0, 20)}`,
    body_sha256: bodySha,
  };
  if (variant === "MUTATED_BODY") certificate.product_truth.outer_unit_count = 7;
  return certificate;
}

interface FixtureOptions {
  mutate_status_receipt?: (receipt: Record<string, unknown>) => void;
  omit_accepted?: boolean;
  omit_head_state?: "CLAIMED" | "REQUESTING" | "ACCEPTED" | "SUCCEEDED";
  mutate_request_payload?: boolean;
  post_captured_at?: string;
  terminal_state?: "SUCCEEDED" | "FAILED";
  terminal_response_hash?: string;
  corrupt_terminal_file_hash?: boolean;
  mutate_target_image_certificate?: boolean;
  target_image_certificate_variant?: "MUTATED_BODY" | "WRONG_SCHEMA" | "WRONG_PLAN";
  target_image_certificate_expires_at?: string;
  permit_expires_at?: string;
}

function fixture(options: FixtureOptions = {}) {
  const { plan, baseline } = planFixture();
  const targetImageCertificateBytes = jsonBytes(targetImageCertificate(
    plan,
    options.target_image_certificate_variant,
    options.target_image_certificate_expires_at,
  ));
  const targetImageCertificateSha = sha256(targetImageCertificateBytes);
  const schema = maintenanceSchema();
  const getSpecRequest = {
    feedType: "MP_MAINTENANCE",
    version: SPEC_VERSION,
    productTypes: [PRODUCT_TYPE],
  };
  const getSpecResponse = { schema };
  const getSpecRequestBytes = jsonBytes(getSpecRequest);
  const getSpecResponseBytes = jsonBytes(getSpecResponse);
  const getSpecReceipt = seal({
    schema_version: WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA,
    method: "POST",
    path: "/v3/items/spec",
    request_content_type: "application/json",
    response_content_type: "application/json",
    http_status: 200,
    correlation_id_sha256: H("6"),
    seller_account_fingerprint_sha256: SELLER,
    request_payload_sha256: sha256(getSpecRequestBytes),
    response_payload_sha256: sha256(getSpecResponseBytes),
    fetched_at: "2026-07-20T12:04:00.000Z",
  }) as WalmartListingSurgicalGetSpecReceipt;
  const liveItemResponse = {
    ItemResponse: [{
      sku: "SKU-EXACT-1",
      itemId: "123456789",
      productType: PRODUCT_TYPE,
      publishedStatus: "PUBLISHED",
      lifecycleStatus: "ACTIVE",
      upc: "012345678905",
    }],
  };
  const liveItemResponseBytes = jsonBytes(liveItemResponse);
  const liveItemReceipt = seal({
    schema_version: WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA,
    method: "GET",
    path: "/v3/items/SKU-EXACT-1",
    response_content_type: "application/json",
    http_status: 200,
    correlation_id_sha256: H("7"),
    seller_account_fingerprint_sha256: SELLER,
    response_payload_sha256: sha256(liveItemResponseBytes),
    captured_at: "2026-07-20T12:03:00.000Z",
  }) as WalmartListingSurgicalLiveItemReceipt;
  const contract = seal({
    schema_version: WALMART_LISTING_SURGICAL_SCHEMA_CONTRACT_SCHEMA,
    contract_id: "schema-contract-1",
    plan_id: plan.plan_id,
    plan_body_sha256: plan.body_sha256,
    target_sha256: plan.target.target_sha256,
    listing: {
      channel: "WALMART_US",
      store_index: 1,
      sku: "SKU-EXACT-1",
      listing_key: "walmart:1:SKU-EXACT-1",
      item_id: "123456789",
      product_identifier: { productIdType: "UPC", productId: "012345678905" },
      product_type: PRODUCT_TYPE,
      live_item_capture_sha256: sha256(liveItemResponseBytes),
      live_item_receipt_body_sha256: liveItemReceipt.body_sha256,
      live_item_captured_at: liveItemReceipt.captured_at,
    },
    spec: {
      feed_type: "MP_MAINTENANCE",
      business_unit: "WALMART_US",
      locale: "en",
      version: SPEC_VERSION,
      product_type: PRODUCT_TYPE,
      request_payload_sha256: sha256(getSpecRequestBytes),
      response_payload_sha256: sha256(getSpecResponseBytes),
      schema_sha256: walmartListingSurgicalSha256(schema),
      get_spec_receipt_body_sha256: getSpecReceipt.body_sha256,
      valid_until: "2026-07-20T12:25:00.000Z",
    },
    schema_mapping_approval_sha256: H("8"),
    attribute_mappings: [],
    claims: {
      exact_one_sku: true,
      changed_fields_only: true,
      full_target_is_qa_reference_only: true,
      audit_claims_are_not_write_schema: true,
      blank_or_null_clear_forbidden: true,
      preserve_unapproved_fields_by_omission: true,
      retries: 0,
      redirects: 0,
    },
  }) as WalmartListingSurgicalSchemaContract;
  const surgical = buildWalmartListingSurgicalRequest({
    plan,
    baseline,
    schema_contract: contract,
    get_spec_receipt: getSpecReceipt,
    live_item_receipt: liveItemReceipt,
    target_image_certificate_bytes: targetImageCertificateBytes,
    get_spec_request_bytes: getSpecRequestBytes,
    get_spec_response_bytes: getSpecResponseBytes,
    live_item_response_bytes: liveItemResponseBytes,
    request: {
      permit_id: "permit-1",
      target_image_certificate_sha256: targetImageCertificateSha,
      seller_account_fingerprint_sha256: SELLER,
      request_correlation_id_sha256: H("9"),
      prepared_at: "2026-07-20T12:05:00.000Z",
    },
  });

  const identityBody = {
    ledger_id: "ledger-1",
    ledger_epoch: "epoch-ledger-1",
    state_directory_path_sha256: H("1"),
    directory_identity_sha256: H("2"),
    created_at: "2026-07-20T11:40:00.000Z",
  };
  const identityBytes = ledgerBytes(
    WALMART_LISTING_REPAIR_LEDGER_IDENTITY_SCHEMA,
    identityBody,
  );
  const binding: WalmartListingRepairConsumptionLedgerBinding = {
    policy_id: "walmart-listing-repair-permit-consumption-ledger/1.0.0",
    ledger_id: identityBody.ledger_id,
    ledger_epoch: identityBody.ledger_epoch,
    state_directory_path_sha256: identityBody.state_directory_path_sha256,
    directory_identity_sha256: identityBody.directory_identity_sha256,
    identity_artifact_sha256: sha256(identityBytes),
    reservation_filename_policy: "authorization-sha256.json/exclusive-create/v1",
    trusted_single_custody_host_only: true,
    distributed_at_most_once_claimed: false,
  };
  const identity = {
    channel: "WALMART_US" as const,
    store_index: 1,
    sku: "SKU-EXACT-1",
    listing_key: "walmart:1:SKU-EXACT-1",
    item_id: "123456789",
  };
  const sequence: WalmartListingRepairSequenceAuthorization = {
    schema_version: WALMART_LISTING_REPAIR_SEQUENCE_AUTHORIZATION_SCHEMA,
    algorithm: WALMART_LISTING_REPAIR_OWNER_ALGORITHM,
    key_id: "fixture-key",
    owner_public_key_spki_sha256: H("3"),
    signed_body: {
      action: WALMART_LISTING_REPAIR_SEQUENCE_ACTION,
      environment: "TEST_FIXTURE_ONLY",
      sequence_id: "sequence-1",
      sequence_epoch: "epoch-1",
      issued_at: "2026-07-20T11:45:00.000Z",
      expires_at: "2026-07-20T14:00:00.000Z",
      approved_by: "owner-fixture",
      decision_ref: "decision-fixture",
      seller_account_fingerprint_sha256: SELLER,
      population_artifact_sha256: plan.sequence.population_artifact_sha256,
      frozen_verifier_engine_release_sha256: plan.verifier_engine_release_sha256,
      capture_authority_public_key_spki_sha256: H("4"),
      ordered_listings: [identity],
      claims: {
        exact_ordered_population: true,
        source_aware_rebuild_required: true,
        next_sku_requires_rebuilt_pass: true,
        marketplace_writes_authorized: false,
        sequence_is_not_a_write_permit: true,
        mass_apply_allowed: false,
      },
    },
    signature_base64: Buffer.alloc(64).toString("base64"),
    signature_sha256: H("5"),
    authorization_sha256: SEQUENCE_AUTH,
  };
  const requestPayloadBytes = options.mutate_request_payload
    ? Uint8Array.from([...surgical.payload_bytes.slice(0, -1), 0x20])
    : surgical.payload_bytes;
  const permit: WalmartListingRepairOneSkuPermit = {
    schema_version: WALMART_LISTING_REPAIR_ONE_SKU_PERMIT_SCHEMA,
    algorithm: WALMART_LISTING_REPAIR_OWNER_ALGORITHM,
    key_id: "fixture-key",
    owner_public_key_spki_sha256: H("3"),
    signed_body: {
      action: WALMART_LISTING_REPAIR_ONE_SKU_ACTION,
      environment: "TEST_FIXTURE_ONLY",
      permit_id: "permit-1",
      issued_at: "2026-07-20T12:06:00.000Z",
      expires_at: options.permit_expires_at ?? "2026-07-20T12:30:00.000Z",
      approved_by: "owner-fixture",
      decision_ref: "permit-decision-fixture",
      sequence_authorization_sha256: SEQUENCE_AUTH,
      sequence_id: "sequence-1",
      sequence_epoch: "epoch-1",
      sequence_position: 0,
      listing: identity,
      plan_id: plan.plan_id,
      plan_body_sha256: plan.body_sha256,
      target_sha256: plan.target.target_sha256,
      target_image_certificate_sha256: targetImageCertificateSha,
      baseline_capture_exchange_sha256: plan.baseline.live_capture_exchange_sha256,
      product_truth: {
        expected_sha256: plan.product_truth.expected_sha256,
        product_truth_snapshot_id: plan.product_truth.product_truth_snapshot_id,
        product_truth_snapshot_body_sha256: plan.product_truth.product_truth_snapshot_body_sha256,
        truth_revision_id: plan.product_truth.truth_revision_id,
        truth_revision_body_sha256: plan.product_truth.truth_revision_body_sha256,
        truth_approval_sha256: plan.product_truth.truth_approval_sha256,
      },
      apply_engine_release_sha256: plan.apply_engine_release_sha256,
      request_manifest_sha256: surgical.request_manifest_sha256,
      request_payload_sha256: surgical.payload_sha256,
      consumption_ledger: binding,
      claims: {
        exact_listing_count: 1,
        marketplace_write_calls: 1,
        retry_allowed: false,
        automatic_reapply_allowed: false,
        mass_apply_allowed: false,
        delist: false,
        reprice: false,
        purchase: false,
        schedule: false,
      },
    },
    signature_base64: Buffer.alloc(64).toString("base64"),
    signature_sha256: H("6"),
    authorization_sha256: PERMIT_AUTH,
  };

  const postResponseBytes = jsonBytes({ feedId: FEED_ID });
  const postReceiptBytes = jsonBytes({
    schema_version: "walmart-listing-repair-http-receipt/v2",
    operation: "MAINTENANCE_POST",
    method: "POST",
    path: "/v3/feeds",
    query: { feedType: "MP_MAINTENANCE" },
    feed_id: null,
    status: 200,
    content_type: "application/json",
    content_length: postResponseBytes.byteLength,
    request_correlation_id_sha256: H("9"),
    captured_at: options.post_captured_at ?? "2026-07-20T12:09:00.000Z",
  });
  const statusPayloadBytes = jsonBytes({
    feedId: FEED_ID,
    feedStatus: "PROCESSED",
    itemsReceived: 1,
    itemsSucceeded: 1,
    itemsFailed: 0,
    itemDetails: {
      itemIngestionStatus: [{ sku: "SKU-EXACT-1", ingestionStatus: "SUCCESS" }],
    },
  });
  const statusReceipt: Record<string, unknown> = {
    schema_version: "walmart-listing-repair-http-receipt/v2",
    operation: "FEED_STATUS_GET",
    method: "GET",
    path: `/v3/feeds/${encodeURIComponent(FEED_ID)}`,
    query: { includeDetails: "true" },
    feed_id: FEED_ID,
    status: 200,
    content_type: "application/json",
    content_length: statusPayloadBytes.byteLength,
    request_correlation_id_sha256: H("f"),
    captured_at: "2026-07-20T12:11:00.000Z",
  };
  options.mutate_status_receipt?.(statusReceipt);
  const statusReceiptBytes = jsonBytes(statusReceipt);

  const claimBody = {
    authorization_sha256: PERMIT_AUTH,
    state: "CLAIMED",
    claim_id: "claim-1",
    claimed_at: "2026-07-20T12:07:00.000Z",
    consumption_ledger: binding,
  };
  const claimBytes = ledgerBytes(WALMART_LISTING_REPAIR_LEDGER_CLAIM_SCHEMA, claimBody);
  const requestingBody = {
    authorization_sha256: PERMIT_AUTH,
    state: "REQUESTING",
    claim_id: "claim-1",
    claimed_at: claimBody.claimed_at,
    requesting_at: "2026-07-20T12:08:00.000Z",
    claim_file_sha256: sha256(claimBytes),
    request_manifest_sha256: surgical.request_manifest_sha256,
    request_payload_sha256: surgical.payload_sha256,
    consumption_ledger: binding,
  };
  const requestingBytes = ledgerBytes(
    WALMART_LISTING_REPAIR_LEDGER_REQUESTING_SCHEMA,
    requestingBody,
  );
  const acceptedBody = {
    authorization_sha256: PERMIT_AUTH,
    state: "ACCEPTED",
    claim_id: "claim-1",
    claimed_at: claimBody.claimed_at,
    requesting_at: requestingBody.requesting_at,
    accepted_at: "2026-07-20T12:10:00.000Z",
    requesting_file_sha256: sha256(requestingBytes),
    apply_id: "apply-1",
    feed_id: FEED_ID,
    response_http_receipt_sha256: sha256(postReceiptBytes),
    response_payload_sha256: sha256(postResponseBytes),
    exact_listing_count: 1,
    marketplace_write_calls: 1,
    consumption_ledger: binding,
  };
  const acceptedBytes = ledgerBytes(
    WALMART_LISTING_REPAIR_LEDGER_ACCEPTED_SCHEMA,
    acceptedBody,
  );
  const terminalState = options.terminal_state ?? "SUCCEEDED";
  const terminalBody = {
    authorization_sha256: PERMIT_AUTH,
    state: terminalState,
    consumption_id: "consumption-1",
    claim_id: "claim-1",
    claimed_at: claimBody.claimed_at,
    requesting_at: requestingBody.requesting_at,
    accepted_at: acceptedBody.accepted_at,
    terminal_at: statusReceipt.captured_at,
    prior_state: "ACCEPTED",
    prior_state_file_sha256: sha256(acceptedBytes),
    requesting_file_sha256: sha256(requestingBytes),
    accepted_file_sha256: sha256(acceptedBytes),
    apply_id: "apply-1",
    feed_id: FEED_ID,
    response_http_receipt_sha256:
      options.terminal_response_hash ?? sha256(postReceiptBytes),
    response_payload_sha256: sha256(postResponseBytes),
    feed_status_http_receipt_sha256: sha256(statusReceiptBytes),
    feed_status_payload_sha256: sha256(statusPayloadBytes),
    exact_listing_count: 1,
    marketplace_write_calls: 1,
    error_code: terminalState === "SUCCEEDED" ? null : "FAILED_FOR_TEST",
    consumption_ledger: binding,
  };
  const terminalBytes = ledgerBytes(
    WALMART_LISTING_REPAIR_LEDGER_TERMINAL_SCHEMA,
    terminalBody,
  );
  const terminalSha = sha256(terminalBytes);
  const unsortedEvents: WalmartListingRepairLedgerHeadEvent[] = [
    {
      file_name: `${PERMIT_AUTH}.json`,
      file_sha256: sha256(claimBytes),
      authorization_sha256: PERMIT_AUTH,
      state: "CLAIMED",
    },
    {
      file_name: `.${PERMIT_AUTH}.requesting.json`,
      file_sha256: sha256(requestingBytes),
      authorization_sha256: PERMIT_AUTH,
      state: "REQUESTING",
    },
    {
      file_name: `.${PERMIT_AUTH}.accepted.json`,
      file_sha256: sha256(acceptedBytes),
      authorization_sha256: PERMIT_AUTH,
      state: "ACCEPTED",
    },
    {
      file_name: `.${PERMIT_AUTH}.terminal.json`,
      file_sha256: terminalSha,
      authorization_sha256: PERMIT_AUTH,
      state: terminalState,
    },
  ];
  const events = unsortedEvents.filter((event) => event.state !== options.omit_head_state)
    .sort((left, right) => left.file_name.localeCompare(right.file_name));
  const headBody = {
    identity_artifact_sha256: sha256(identityBytes),
    previous_head_artifact_sha256: H("e"),
    event_count: events.length,
    events,
    events_sha256: sha256(canonicalWalmartListingSurgicalJson(events)),
    updated_at: "2026-07-20T12:12:00.000Z",
    at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY",
    hostile_same_uid_resistance_claimed: false,
    distributed_at_most_once_claimed: false,
  };
  const headBytes = ledgerBytes(WALMART_LISTING_REPAIR_LEDGER_HEAD_SCHEMA, headBody);
  const terminalReceipt: WalmartListingRepairPermitTerminalReceipt = {
    state: terminalState,
    authorization_sha256: PERMIT_AUTH,
    claim_id: "claim-1",
    claimed_at: claimBody.claimed_at,
    claim_path: "/fixture/claim.json",
    claim_file_sha256: sha256(claimBytes),
    consumption_ledger: binding,
    ledger_head_path: "/fixture/.ledger-head.json",
    ledger_head_sha256: sha256(headBytes),
    requesting_at: requestingBody.requesting_at,
    request_manifest_sha256: surgical.request_manifest_sha256,
    request_payload_sha256: surgical.payload_sha256,
    requesting_path: "/fixture/requesting.json",
    requesting_file_sha256: sha256(requestingBytes),
    consumption_id: "consumption-1",
    accepted_at: acceptedBody.accepted_at,
    terminal_at: String(statusReceipt.captured_at),
    prior_state: "ACCEPTED",
    prior_state_file_sha256: sha256(acceptedBytes),
    accepted_path: "/fixture/accepted.json",
    accepted_file_sha256: sha256(acceptedBytes),
    terminal_path: "/fixture/terminal.json",
    terminal_file_sha256: terminalSha,
    apply_id: "apply-1",
    feed_id: FEED_ID,
    response_http_receipt_sha256:
      options.terminal_response_hash ?? sha256(postReceiptBytes),
    response_payload_sha256: sha256(postResponseBytes),
    feed_status_http_receipt_sha256: sha256(statusReceiptBytes),
    feed_status_payload_sha256: sha256(statusPayloadBytes),
    exact_listing_count: 1,
    marketplace_write_calls: 1,
    error_code: terminalState === "SUCCEEDED" ? null : "FAILED_FOR_TEST",
  };
  const ledger: WalmartListingRepairPermitLedgerEvidence = {
    state: terminalState,
    receipt: terminalReceipt,
    identity_bytes: identityBytes,
    identity_sha256: sha256(identityBytes),
    head_bytes: headBytes,
    head_sha256: sha256(headBytes),
    exact_event_inventory: events,
    claim_bytes: claimBytes,
    claim_sha256: sha256(claimBytes),
    requesting_bytes: requestingBytes,
    requesting_sha256: sha256(requestingBytes),
    accepted_bytes: options.omit_accepted ? null : acceptedBytes,
    accepted_sha256: options.omit_accepted ? null : sha256(acceptedBytes),
    terminal_bytes: terminalBytes,
    terminal_sha256: options.corrupt_terminal_file_hash ? H("f") : terminalSha,
    at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY",
    hostile_same_uid_resistance_claimed: false,
    distributed_at_most_once_claimed: false,
  };
  const loaded: WalmartListingRepairCustodyLoadedApplyEvidence = {
    ledger,
    writer_artifacts: {
      request_manifest_bytes: surgical.request_manifest_bytes,
      request_payload_bytes: requestPayloadBytes,
      post_response_http_receipt_bytes: postReceiptBytes,
      post_response_payload_bytes: postResponseBytes,
      terminal_feed_status_http_receipt_bytes: statusReceiptBytes,
      terminal_feed_status_payload_bytes: statusPayloadBytes,
    },
    surgical_supporting: {
      target_image_certificate_bytes: options.mutate_target_image_certificate
        ? jsonBytes({ certificate_id: "attacker-certificate" })
        : targetImageCertificateBytes,
      schema_contract_bytes: jsonBytes(contract),
      get_spec_receipt_bytes: jsonBytes(getSpecReceipt),
      get_spec_request_bytes: getSpecRequestBytes,
      get_spec_response_bytes: getSpecResponseBytes,
      live_item_receipt_bytes: jsonBytes(liveItemReceipt),
      live_item_response_bytes: liveItemResponseBytes,
    },
  };
  return { loaded, sequence, permit, plan, baseline };
}

test("verifies exact surgical bytes, ACCEPTED custody, terminal feed, and current HEAD", () => {
  const result = verifyWalmartListingRepairCustodyLoadedApplyEvidence(fixture());
  assert.equal(result.apply_id, "apply-1");
  assert.equal(result.feed_id, FEED_ID);
  assert.equal(result.manifest_prepared_at, "2026-07-20T12:05:00.000Z");
  assert.equal(result.post_response_captured_at, "2026-07-20T12:09:00.000Z");
  assert.equal(result.accepted_at, "2026-07-20T12:10:00.000Z");
  assert.equal(result.feed_confirmed_at, "2026-07-20T12:11:00.000Z");
  assert.equal(Object.hasOwn(result, "applied_at"), false);
  assert.equal(result.exact_listing_count, 1);
  assert.equal(result.marketplace_write_calls, 1);
});

test("rejects a custody-consistent terminal receipt with the wrong GET route or feedId", () => {
  const wrongRoute = fixture({
    mutate_status_receipt: (receipt) => { receipt.path = "/v3/feeds/attacker"; },
  });
  assert.throws(
    () => verifyWalmartListingRepairCustodyLoadedApplyEvidence(wrongRoute),
    /feed-status receipt route/i,
  );
  const wrongFeed = fixture({
    mutate_status_receipt: (receipt) => { receipt.feed_id = "attacker-feed"; },
  });
  assert.throws(
    () => verifyWalmartListingRepairCustodyLoadedApplyEvidence(wrongFeed),
    /feed-status receipt route/i,
  );
});

test("rejects missing ACCEPTED bytes and a HEAD missing the ACCEPTED event", () => {
  assert.throws(
    () => verifyWalmartListingRepairCustodyLoadedApplyEvidence(fixture({ omit_accepted: true })),
    /must contain REQUESTING, ACCEPTED/i,
  );
  assert.throws(
    () => verifyWalmartListingRepairCustodyLoadedApplyEvidence(fixture({
      omit_head_state: "ACCEPTED",
    })),
    /exactly four events/i,
  );
});

test("rejects a one-byte surgical request payload mutation", () => {
  assert.throws(
    () => verifyWalmartListingRepairCustodyLoadedApplyEvidence(fixture({
      mutate_request_payload: true,
    })),
    /request bytes differ/i,
  );
});

test("rejects target image certificate bytes not bound by permit and manifest", () => {
  assert.throws(
    () => verifyWalmartListingRepairCustodyLoadedApplyEvidence(fixture({
      mutate_target_image_certificate: true,
    })),
    /target image certificate/i,
  );
});

test("rejects permit-bound target certificates with a broken seal, schema, or plan", () => {
  for (const variant of ["MUTATED_BODY", "WRONG_SCHEMA", "WRONG_PLAN"] as const) {
    assert.throws(
      () => verifyWalmartListingRepairCustodyLoadedApplyEvidence(fixture({
        target_image_certificate_variant: variant,
      })),
      /target image certificate semantic validation failed/i,
      variant,
    );
  }
});

test("rejects authoritative timestamp inversion", () => {
  assert.throws(
    () => verifyWalmartListingRepairCustodyLoadedApplyEvidence(fixture({
      post_captured_at: "2026-07-20T12:10:30.000Z",
    })),
    /timestamp chain/i,
  );
});

test("requires CLAIMED, REQUESTING, POST response, and ACCEPTED strictly before permit expiry", () => {
  const expiries = [
    ["CLAIMED", "2026-07-20T12:07:00.000Z"],
    ["REQUESTING", "2026-07-20T12:08:00.000Z"],
    ["POST response", "2026-07-20T12:09:00.000Z"],
    ["ACCEPTED", "2026-07-20T12:10:00.000Z"],
  ] as const;
  for (const [event, permitExpiresAt] of expiries) {
    assert.throws(
      () => verifyWalmartListingRepairCustodyLoadedApplyEvidence(fixture({
        permit_expires_at: permitExpiresAt,
      })),
      /timestamp chain/i,
      event,
    );
  }
});

test("rejects an image certificate that expires after prepare but by POST response capture", () => {
  assert.throws(
    () => verifyWalmartListingRepairCustodyLoadedApplyEvidence(fixture({
      target_image_certificate_expires_at: "2026-07-20T12:09:00.000Z",
    })),
    /not valid at POST response capture/i,
  );
});

test("allows terminal feed confirmation after permit expiry when ACCEPTED was still authorized", () => {
  const result = verifyWalmartListingRepairCustodyLoadedApplyEvidence(fixture({
    permit_expires_at: "2026-07-20T12:10:30.000Z",
  }));
  assert.equal(result.accepted_at, "2026-07-20T12:10:00.000Z");
  assert.equal(result.feed_confirmed_at, "2026-07-20T12:11:00.000Z");
});

test("rejects terminal file hash corruption, preserved POST hash drift, and FAILED state", () => {
  assert.throws(
    () => verifyWalmartListingRepairCustodyLoadedApplyEvidence(fixture({
      corrupt_terminal_file_hash: true,
    })),
    /terminal SHA differs/i,
  );
  assert.throws(
    () => verifyWalmartListingRepairCustodyLoadedApplyEvidence(fixture({
      terminal_response_hash: H("f"),
    })),
    /terminal SUCCEEDED chain/i,
  );
  assert.throws(
    () => verifyWalmartListingRepairCustodyLoadedApplyEvidence(fixture({
      terminal_state: "FAILED",
    })),
    /terminal SUCCEEDED/i,
  );
});
