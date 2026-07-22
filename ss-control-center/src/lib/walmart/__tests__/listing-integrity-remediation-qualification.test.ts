import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import test from "node:test";

import {
  WALMART_LISTING_REPAIR_LEDGER_CLAIM_SCHEMA,
  WALMART_LISTING_REPAIR_LEDGER_IDENTITY_SCHEMA,
  WALMART_LISTING_REPAIR_LEDGER_REQUESTING_SCHEMA,
  WALMART_LISTING_REPAIR_LEDGER_TERMINAL_SCHEMA,
  WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA,
  WALMART_LISTING_REPAIR_REQUEST_MANIFEST_SCHEMA,
} from "../listing-integrity-remediation-evidence.ts";
import {
  WALMART_LISTING_REPAIR_ONE_SKU_ACTION,
  WALMART_LISTING_REPAIR_SEQUENCE_ACTION,
  assembleWalmartListingRepairOwnerAuthorization,
  verifyCurrentWalmartListingRepairOneSkuPermitForTest,
  verifyWalmartListingRepairOneSkuPermitHistoricalForTest,
  walmartListingRepairAuthoritySha256,
  walmartListingRepairOneSkuPermitSigningEnvelope,
  walmartListingRepairOwnerSigningMessage,
  walmartListingRepairSequenceSigningEnvelope,
  type WalmartListingRepairOneSkuPermitSignedBody,
  type WalmartListingRepairConsumptionLedgerBinding,
  type WalmartListingRepairOwnerAuthorization,
  type WalmartListingRepairOwnerSigningEnvelope,
  type WalmartListingRepairSequenceSignedBody,
} from "../listing-integrity-remediation-authority.ts";
import {
  WALMART_LISTING_REPAIR_APPLY_EVIDENCE_REFERENCE_SCHEMA,
} from "../listing-integrity-remediation-apply-evidence-adapter.ts";
import type {
  VerifiedWalmartListingRepairCustodyApplyEvidence,
} from "../listing-integrity-remediation-apply-evidence.ts";
import {
  buildWalmartListingRepairPlanForTest,
  evaluateWalmartListingRepairSequence,
  evaluateWalmartListingRepairSequenceForTest,
  inspectWalmartListingRepairQualificationProductionReadiness,
  walmartListingRepairTestRuntime,
  type WalmartListingRepairQualificationEvidencePackage,
  type WalmartListingRepairTargetImage,
} from "../listing-integrity-remediation-qualification.ts";
import {
  WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
  WALMART_LISTING_INTEGRITY_REPORT_SCHEMA,
  walmartListingIntegritySha256,
  type WalmartListingSurface,
} from "../listing-integrity-audit.ts";

process.env.NODE_ENV = "test";
process.env.WALMART_LISTING_REPAIR_TEST_MODE = "1";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_DER = publicKey.export({ format: "der", type: "spki" });
const OWNER_FINGERPRINT = createHash("sha256").update(PUBLIC_DER).digest("hex");
const OWNER_KEY_ID = "repair-owner-test-key";
process.env.WALMART_LISTING_REPAIR_TEST_OWNER_KEY_ID = OWNER_KEY_ID;
process.env.WALMART_LISTING_REPAIR_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64 =
  PUBLIC_DER.toString("base64");

const TEST_ENV = { ...process.env };
const RELEASE_SHA = "a".repeat(64);
const APPLY_SHA = "b".repeat(64);
const CAPTURE_FINGERPRINT = "c".repeat(64);
const SELLER_FINGERPRINT = "d".repeat(64);
const BASE_CAPTURE = "2026-07-19T12:00:00.000Z";
const PLAN_AT = "2026-07-19T12:05:00.000Z";
const PERMIT_AT = "2026-07-19T12:06:00.000Z";
const APPLY_AT = "2026-07-19T12:10:00.000Z";
const FEED_AT = "2026-07-19T12:15:00.000Z";
const POST_CAPTURE = "2026-07-19T12:20:00.000Z";
const QUALIFIED_AT = "2026-07-19T12:25:00.000Z";
const LATE_CAPTURE = "2026-07-19T18:20:00.000Z";
const LATE_QUALIFIED_AT = "2026-07-19T18:25:00.000Z";

const LISTING_ONE = Object.freeze({
  channel: "WALMART_US",
  store_index: 1,
  sku: "ACME-BREAD-2PK",
  listing_key: "walmart:1:ACME-BREAD-2PK",
  item_id: "123456789",
});
const LISTING_TWO = Object.freeze({
  channel: "WALMART_US",
  store_index: 1,
  sku: "NEXT-SKU",
  listing_key: "walmart:1:NEXT-SKU",
  item_id: "987654321",
});

const PRODUCT_TRUTH_BYTES = jsonBytes({ snapshot_id: "truth-snapshot-1", exact_variant: true });
const BASE_ASSETS = new Map([
  ["main", Buffer.from("wrong-main-image", "utf8")],
  ["gallery-1", Buffer.from("wrong-gallery-image", "utf8")],
]);
const TARGET_ASSETS = new Map([
  ["main", Buffer.from("correct-main-image-with-two-loaves", "utf8")],
  ["gallery-1", Buffer.from("correct-gallery-image", "utf8")],
]);

function rawSha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function clone(value) {
  return structuredClone(value);
}

function sealLedger(schema, body) {
  return jsonBytes({
    schema_version: schema,
    body,
    body_sha256: walmartListingIntegritySha256(body),
  });
}

function signEnvelope<TBody>(
  envelope: WalmartListingRepairOwnerSigningEnvelope<TBody>,
): WalmartListingRepairOwnerAuthorization<TBody> {
  const signature = sign(
    null,
    walmartListingRepairOwnerSigningMessage(envelope),
    privateKey,
  );
  return assembleWalmartListingRepairOwnerAuthorization({
    envelope,
    signature_base64: signature.toString("base64"),
  });
}

function sequenceAuthorization() {
  const signedBody: WalmartListingRepairSequenceSignedBody = {
    action: WALMART_LISTING_REPAIR_SEQUENCE_ACTION,
    environment: "TEST_FIXTURE_ONLY" as const,
    sequence_id: "repair-sequence-1",
    sequence_epoch: "repair-sequence-epoch-1",
    issued_at: "2026-07-19T11:55:00.000Z",
    expires_at: "2026-07-20T11:55:00.000Z",
    approved_by: "owner-test-fixture",
    decision_ref: "test://owner/reviewed-sequence",
    seller_account_fingerprint_sha256: SELLER_FINGERPRINT,
    population_artifact_sha256: walmartListingIntegritySha256([LISTING_ONE, LISTING_TWO]),
    frozen_verifier_engine_release_sha256: RELEASE_SHA,
    capture_authority_public_key_spki_sha256: CAPTURE_FINGERPRINT,
    ordered_listings: [LISTING_ONE, LISTING_TWO],
    claims: {
      exact_ordered_population: true,
      source_aware_rebuild_required: true,
      next_sku_requires_rebuilt_pass: true,
      marketplace_writes_authorized: false,
      sequence_is_not_a_write_permit: true,
      mass_apply_allowed: false,
    },
  };
  return signEnvelope(walmartListingRepairSequenceSigningEnvelope({
    key_id: OWNER_KEY_ID,
    owner_public_key_spki_sha256: OWNER_FINGERPRINT,
    signed_body: signedBody,
  }));
}

function expectedTruth() {
  return {
    title: "Acme Golden Bread, 20 oz (Pack of 2)",
    outer_units: 2,
    identity: {
      brand_aliases: ["acme"],
      product_marker_groups: [["bread"]],
      variant_marker_groups: [["golden"]],
      forbidden_markers: [{ role: "variant", aliases: ["rye"] }],
    },
    package_facts: [
      { kind: "net_content", value: 20, unit: "oz", requirement: "required" },
    ],
    truth_source: "manual_verified",
  };
}

function targetSurface(): WalmartListingSurface {
  return {
    title: "Acme Golden Bread, 20 oz (Pack of 2)",
    description: "Acme Golden Bread is supplied as a Pack of 2; each loaf is 20 oz.",
    bullets: [
      "Acme Golden Bread Pack of 2",
      "Two 20 oz loaves of Acme Golden Bread",
    ],
    attribute_claims: [
      { field_path: "brand", kind: "brand", text: "Acme" },
      { field_path: "product", kind: "product", text: "Bread" },
      { field_path: "variant", kind: "variant", text: "Golden" },
      { field_path: "multipackQuantity", kind: "outer_units", value: 2, unit: "count" },
      { field_path: "netContent", kind: "net_content", value: 20, unit: "oz" },
    ],
    unmapped_attributes: [],
  };
}

function targetImages(): WalmartListingRepairTargetImage[] {
  return [
    {
      slot: "main",
      source_url: "https://images.example.test/acme-main-2pk.jpg",
      sha256: rawSha(TARGET_ASSETS.get("main")),
    },
    {
      slot: "gallery-1",
      source_url: "https://images.example.test/acme-gallery-2pk.jpg",
      sha256: rawSha(TARGET_ASSETS.get("gallery-1")),
    },
  ];
}

function baselineSurface(): WalmartListingSurface {
  return {
    title: "Acme Rye Bread, 20 oz",
    description: "One loaf of Acme Rye Bread.",
    bullets: ["Acme Rye Bread"],
    attribute_claims: [
      { field_path: "variant", kind: "variant", text: "Rye" },
      { field_path: "multipackQuantity", kind: "outer_units", value: 1, unit: "count" },
    ],
    unmapped_attributes: [],
  };
}

function imageProjection(surfaceKind) {
  const target = surfaceKind === "target";
  const images = target ? targetImages() : [
    {
      slot: "main",
      source_url: "https://images.example.test/wrong-main.jpg",
      sha256: rawSha(BASE_ASSETS.get("main")),
    },
    {
      slot: "gallery-1",
      source_url: "https://images.example.test/wrong-gallery.jpg",
      sha256: rawSha(BASE_ASSETS.get("gallery-1")),
    },
  ];
  return images.map((row, index) => ({
    ...row,
    byte_length: (target ? TARGET_ASSETS : BASE_ASSETS).get(row.slot).byteLength,
    decoded_width: 1_500,
    decoded_height: 1_500,
    dhash64: `${index + (target ? 3 : 1)}`.repeat(16),
    buyer_facing_verified: true,
    surface: "buyer_pdp",
  }));
}

function reportChecks(passing) {
  const match = passing ? "MATCH" : "MISMATCH";
  return {
    title_identity: match,
    title_outer_units: match,
    title_package_facts: "MATCH",
    body_identity: match,
    body_outer_units: match,
    body_package_facts: "MATCH",
    attributes_identity: match,
    attributes_outer_units: match,
    attributes_package_facts: "MATCH",
  };
}

function auditReport(input, verdict, reportId) {
  const passing = verdict === "PASS";
  const body = {
    schema_version: WALMART_LISTING_INTEGRITY_REPORT_SCHEMA,
    report_id: reportId,
    input_body_sha256: walmartListingIntegritySha256(input),
    listing: input.listing,
    source_bindings: input.source_bindings,
    text_decision: {
      verdict: passing ? "PASS" : "BAD",
      checks: reportChecks(passing),
      hard_failures: passing ? [] : ["wrong variant and pack count"],
      review_reasons: [],
    },
    main_decision: {
      verdict: passing ? "PASS" : "BAD",
      hard_failures: passing ? [] : ["wrong product"],
      review_reasons: [],
    },
    gallery_decisions: [{
      slot: "gallery-1",
      verdict: passing ? "PASS" : "BAD",
      hard_failures: passing ? [] : ["wrong product"],
      review_reasons: [],
    }],
    duplicate_summary: null,
    engine_versions: {
      listing_engine: "fixture-listing-engine/v2",
      blind_prompt: "fixture-blind/v1",
      main_comparator: "fixture-main/v1",
      gallery_comparator: "fixture-gallery/v1",
    },
    overall_verdict: verdict,
    blocking_reasons: passing ? [] : ["wrong product and pack count"],
    review_reasons: [],
    provenance: {
      run_lock_sha256: "1".repeat(64),
      code_bundle_id: `sha256:${RELEASE_SHA}`,
      code_bundle_manifest_sha256: "2".repeat(64),
      worker_receipt_key_id: "fixture-worker",
      worker_receipt_public_key_sha256: "3".repeat(64),
      observation_artifacts: [],
    },
    assurance: {
      compilation_mode: "source_aware",
      source_artifacts_verified: true,
      surface_snapshot_verified: true,
      asset_bytes_verified: true,
      observation_artifacts_verified: true,
      caller_verdicts_accepted: false,
      image_decisions_recomputed: true,
      unknown_promoted_to_pass: false,
      network_calls: 0,
      model_calls: 0,
      marketplace_writes: 0,
      database_writes: 0,
    },
  };
  return { ...body, body_sha256: walmartListingIntegritySha256(body) };
}

function makeSource({
  surfaceKind,
  capturedAt,
  runLockCreatedAt,
  nonce,
  verdict,
}) {
  const target = surfaceKind === "target";
  const surface = target ? targetSurface() : baselineSurface();
  const buyerPayload = { surface_kind: surfaceKind, surface };
  const surfaceSnapshot = { surface_kind: surfaceKind, surface };
  const sellerPayload = { sku: LISTING_ONE.sku, surface_kind: surfaceKind };
  const bindings = {
    product_truth_snapshot_id: "truth-snapshot-1",
    product_truth_snapshot_body_sha256: "4".repeat(64),
    catalog_truth_export_id: "catalog-export-1",
    catalog_truth_export_body_sha256: "5".repeat(64),
    catalog_truth_case_id: "catalog-case-1",
    catalog_truth_preflight_sha256: "6".repeat(64),
    truth_revision_id: "truth-revision-1",
    truth_revision_body_sha256: "7".repeat(64),
    truth_approval_sha256: "8".repeat(64),
    buyer_index_id: `buyer-index-${surfaceKind}`,
    buyer_index_body_sha256: walmartListingIntegritySha256({ surfaceKind }),
    buyer_snapshot_id: `buyer-snapshot-${surfaceKind}`,
    buyer_snapshot_body_sha256: walmartListingIntegritySha256(buyerPayload),
    buyer_payload_sha256: walmartListingIntegritySha256(buyerPayload),
    surface_snapshot_id: `surface-snapshot-${surfaceKind}`,
    surface_snapshot_body_sha256: walmartListingIntegritySha256(surfaceSnapshot),
    surface_payload_sha256: walmartListingIntegritySha256(surfaceSnapshot),
  };
  const input = {
    schema_version: WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
    listing: {
      ...LISTING_ONE,
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
      captured_at: capturedAt,
      composition: "same_product",
    },
    source_bindings: bindings,
    expected: expectedTruth(),
    surface,
    images: {
      assets: imageProjection(surfaceKind),
      evidence: [],
      duplicate_summary: null,
    },
  };
  const report = auditReport(input, verdict, `report-${surfaceKind}-${nonce}`);
  const runLock = {
    run_id: `run-${nonce}`,
    created_at: runLockCreatedAt,
    authenticated_capture_nonce_sha256: walmartListingIntegritySha256(`nonce:${nonce}`),
  };
  const assets = target ? TARGET_ASSETS : BASE_ASSETS;
  const bundle = {
    run_lock_bytes: jsonBytes(runLock),
    code_bundle_manifest_bytes: jsonBytes({ bundle_id: `sha256:${RELEASE_SHA}` }),
    preflight_certificate_bytes: jsonBytes({ certificate_id: `preflight-${nonce}` }),
    execution_permit_bytes: [jsonBytes({ permit_id: `capture-permit-${nonce}` })],
    product_truth_snapshot_bytes: PRODUCT_TRUTH_BYTES,
    buyer_snapshot_index_bytes: jsonBytes({ id: bindings.buyer_index_id }),
    catalog_truth_export_bytes: jsonBytes({ id: "catalog-export-1" }),
    buyer_snapshot_manifest_bytes: jsonBytes({ id: bindings.buyer_snapshot_id }),
    seller_item_payload_bytes: jsonBytes(sellerPayload),
    catalog_search_payload_bytes: jsonBytes({ item_id: LISTING_ONE.item_id }),
    buyer_pdp_payload_bytes: jsonBytes(buyerPayload),
    surface_snapshot_bytes: jsonBytes(surfaceSnapshot),
    input_bytes: jsonBytes(input),
    report_bytes: jsonBytes(report),
    asset_bytes: new Map([...assets.entries()].map(([slot, bytes]) => [slot, Buffer.from(bytes)])),
    observation_batch_bytes: [],
  };
  return { bundle, input, report };
}

function controlVerifier(
  rawRunLock,
  runLockBytes,
  _rawCodeManifest,
  codeManifestBytes,
) {
  return {
    run_lock: rawRunLock,
    run_lock_sha256: rawSha(runLockBytes),
    code_bundle_id: `sha256:${RELEASE_SHA}`,
    code_bundle_manifest_sha256: rawSha(codeManifestBytes),
    capture_authority_key_id: "capture-owner-test-key",
    capture_authority_public_key_spki_sha256: CAPTURE_FINGERPRINT,
    worker_receipt_key_id: "worker-test-key",
    worker_receipt_public_key_sha256: "9".repeat(64),
    authenticated_capture_nonce_sha256: rawRunLock.authenticated_capture_nonce_sha256,
  };
}

const sourceVerifier = async (report, input) => {
  assert.equal(report.input_body_sha256, walmartListingIntegritySha256(input));
  return report;
};

const VERIFIED_APPLY_BY_PERMIT = new Map<
string,
VerifiedWalmartListingRepairCustodyApplyEvidence
>();

const RUNTIME = walmartListingRepairTestRuntime({
  verifier_engine_release_sha256: RELEASE_SHA,
  sourceVerifier,
  controlVerifier,
  verifyApply: async ({ reference }) => {
    const proof = VERIFIED_APPLY_BY_PERMIT.get(reference.permit_authorization_sha256);
    if (!proof) throw new Error("fixture verified apply proof is missing");
    return clone(proof);
  },
  env: TEST_ENV,
});

function exactVisible(plan) {
  const attributes = Object.fromEntries(plan.target.surface.attribute_claims.map((claim) => [
    claim.field_path,
    typeof claim.text === "string" ? claim.text : { value: claim.value, unit: claim.unit },
  ]));
  return {
    productName: plan.target.surface.title,
    shortDescription: plan.target.surface.description,
    keyFeatures: plan.target.surface.bullets,
    mainImageUrl: plan.target.images[0].source_url,
    productSecondaryImageURL: plan.target.images.slice(1).map((row) => row.source_url),
    ...attributes,
  };
}

function oneSkuPayload(plan) {
  return {
    MPItem: [{
      Orderable: { sku: LISTING_ONE.sku },
      Visible: { Grocery: exactVisible(plan) },
    }],
  };
}

function signPermitBody(signedBody) {
  return signEnvelope(walmartListingRepairOneSkuPermitSigningEnvelope({
    key_id: OWNER_KEY_ID,
    owner_public_key_spki_sha256: OWNER_FINGERPRINT,
    signed_body: signedBody,
  }));
}

function buildApplyEvidence({
  sequence,
  plan,
}) {
  const identityBody = {
    ledger_id: "repair-ledger-test",
    ledger_epoch: "repair-ledger-epoch-test",
    state_directory_path_sha256: "1".repeat(64),
    directory_identity_sha256: "2".repeat(64),
    created_at: "2026-07-19T11:00:00.000Z",
  };
  const identityBytes = sealLedger(WALMART_LISTING_REPAIR_LEDGER_IDENTITY_SCHEMA, identityBody);
  const ledger: WalmartListingRepairConsumptionLedgerBinding = {
    policy_id: "walmart-listing-repair-permit-consumption-ledger/1.0.0",
    ledger_id: identityBody.ledger_id,
    ledger_epoch: identityBody.ledger_epoch,
    state_directory_path_sha256: identityBody.state_directory_path_sha256,
    directory_identity_sha256: identityBody.directory_identity_sha256,
    identity_artifact_sha256: rawSha(identityBytes),
    reservation_filename_policy: "authorization-sha256.json/exclusive-create/v1",
    trusted_single_custody_host_only: true,
    distributed_at_most_once_claimed: false,
  };
  const payload = oneSkuPayload(plan);
  const requestBytes = jsonBytes(payload);
  const requestCorrelationSha = walmartListingIntegritySha256("correlation-1");
  const manifest = {
    schema_version: WALMART_LISTING_REPAIR_REQUEST_MANIFEST_SCHEMA,
    method: "POST",
    path: "/v3/feeds",
    feed_type: "MP_MAINTENANCE",
    store_index: 1,
    seller_account_fingerprint_sha256: SELLER_FINGERPRINT,
    listing: LISTING_ONE,
    plan_id: plan.plan_id,
    plan_body_sha256: plan.body_sha256,
    permit_id: "one-sku-permit-1",
    apply_engine_release_sha256: APPLY_SHA,
    request_correlation_id_sha256: requestCorrelationSha,
    request_payload_sha256: rawSha(requestBytes),
    created_at: APPLY_AT,
  };
  const manifestBytes = jsonBytes(manifest);
  const permitBody: WalmartListingRepairOneSkuPermitSignedBody = {
    action: WALMART_LISTING_REPAIR_ONE_SKU_ACTION,
    environment: "TEST_FIXTURE_ONLY" as const,
    permit_id: manifest.permit_id,
    issued_at: PERMIT_AT,
    expires_at: "2026-07-19T12:30:00.000Z",
    approved_by: "owner-test-fixture",
    decision_ref: "test://owner/reviewed-one-sku-payload",
    sequence_authorization_sha256: sequence.authorization_sha256,
    sequence_id: sequence.signed_body.sequence_id,
    sequence_epoch: sequence.signed_body.sequence_epoch,
    sequence_position: 0,
    listing: LISTING_ONE,
    plan_id: plan.plan_id,
    plan_body_sha256: plan.body_sha256,
    target_sha256: plan.target.target_sha256,
    target_image_certificate_sha256: "a".repeat(64),
    baseline_capture_exchange_sha256: plan.baseline.live_capture_exchange_sha256,
    product_truth: {
      expected_sha256: plan.product_truth.expected_sha256,
      product_truth_snapshot_id: plan.product_truth.product_truth_snapshot_id,
      product_truth_snapshot_body_sha256: plan.product_truth.product_truth_snapshot_body_sha256,
      truth_revision_id: plan.product_truth.truth_revision_id,
      truth_revision_body_sha256: plan.product_truth.truth_revision_body_sha256,
      truth_approval_sha256: plan.product_truth.truth_approval_sha256,
    },
    apply_engine_release_sha256: APPLY_SHA,
    request_manifest_sha256: rawSha(manifestBytes),
    request_payload_sha256: rawSha(requestBytes),
    consumption_ledger: ledger,
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
  };
  const permit = signPermitBody(permitBody);
  const claimBody = {
    authorization_sha256: permit.authorization_sha256,
    state: "CLAIMED",
    claim_id: "claim-1",
    claimed_at: "2026-07-19T12:07:00.000Z",
    consumption_ledger: ledger,
  };
  const claimBytes = sealLedger(WALMART_LISTING_REPAIR_LEDGER_CLAIM_SCHEMA, claimBody);
  const requestingBody = {
    authorization_sha256: permit.authorization_sha256,
    state: "REQUESTING",
    claim_id: claimBody.claim_id,
    claimed_at: claimBody.claimed_at,
    requesting_at: "2026-07-19T12:09:00.000Z",
    claim_file_sha256: rawSha(claimBytes),
    request_manifest_sha256: rawSha(manifestBytes),
    request_payload_sha256: rawSha(requestBytes),
    consumption_ledger: ledger,
  };
  const requestingBytes = sealLedger(
    WALMART_LISTING_REPAIR_LEDGER_REQUESTING_SCHEMA,
    requestingBody,
  );
  const responseBytes = jsonBytes({ feedId: "feed-1" });
  const responseHttpBytes = jsonBytes({
    schema_version: WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA,
    operation: "MAINTENANCE_POST",
    method: "POST",
    path: "/v3/feeds",
    query: { feedType: "MP_MAINTENANCE" },
    feed_id: null,
    status: 202,
    content_type: "application/json",
    content_length: responseBytes.byteLength,
    request_correlation_id_sha256: requestCorrelationSha,
    captured_at: "2026-07-19T12:11:00.000Z",
  });
  const feedStatusBytes = jsonBytes({
    feedId: "feed-1",
    feedStatus: "PROCESSED",
    itemsReceived: 1,
    itemsSucceeded: 1,
    itemsFailed: 0,
    itemDetails: {
      itemIngestionStatus: [{ sku: LISTING_ONE.sku, ingestionStatus: "SUCCESS" }],
    },
  });
  const feedStatusHttpBytes = jsonBytes({
    schema_version: WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA,
    operation: "FEED_STATUS_GET",
    method: "GET",
    path: "/v3/feeds/feed-1",
    query: { includeDetails: "true" },
    feed_id: "feed-1",
    status: 200,
    content_type: "application/json",
    content_length: feedStatusBytes.byteLength,
    request_correlation_id_sha256: requestCorrelationSha,
    captured_at: FEED_AT,
  });
  const terminalBody = {
    authorization_sha256: permit.authorization_sha256,
    state: "SUCCEEDED",
    consumption_id: "consumption-1",
    claim_id: claimBody.claim_id,
    claimed_at: claimBody.claimed_at,
    requesting_at: requestingBody.requesting_at,
    terminal_at: FEED_AT,
    requesting_file_sha256: rawSha(requestingBytes),
    apply_id: "apply-1",
    feed_id: "feed-1",
    response_http_receipt_sha256: rawSha(responseHttpBytes),
    response_payload_sha256: rawSha(responseBytes),
    feed_status_http_receipt_sha256: rawSha(feedStatusHttpBytes),
    feed_status_payload_sha256: rawSha(feedStatusBytes),
    exact_listing_count: 1,
    marketplace_write_calls: 1,
    consumption_ledger: ledger,
  };
  const terminalBytes = sealLedger(WALMART_LISTING_REPAIR_LEDGER_TERMINAL_SCHEMA, terminalBody);
  const ledgerHeadSha = rawSha(jsonBytes({ head: "succeeded", permit: permit.authorization_sha256 }));
  const reference = {
    schema_version: WALMART_LISTING_REPAIR_APPLY_EVIDENCE_REFERENCE_SCHEMA,
    permit_authorization_sha256: permit.authorization_sha256,
    ledger_identity_sha256: rawSha(identityBytes),
    ledger_terminal_sha256: rawSha(terminalBytes),
    ledger_head_sha256: ledgerHeadSha,
    artifact_custody_identity_sha256: rawSha(jsonBytes({ custody: "identity" })),
    artifact_custody_inventory_sha256: rawSha(jsonBytes({ custody: "inventory" })),
  };
  const proof: VerifiedWalmartListingRepairCustodyApplyEvidence = {
    apply_id: terminalBody.apply_id,
    consumption_id: terminalBody.consumption_id,
    permit_authorization_sha256: permit.authorization_sha256,
    feed_id: terminalBody.feed_id,
    apply_engine_release_sha256: APPLY_SHA,
    target_image_certificate_sha256: permitBody.target_image_certificate_sha256,
    manifest_prepared_at: APPLY_AT,
    post_response_captured_at: "2026-07-19T12:11:00.000Z",
    accepted_at: "2026-07-19T12:12:00.000Z",
    feed_confirmed_at: FEED_AT,
    request_manifest_sha256: rawSha(manifestBytes),
    request_payload_sha256: rawSha(requestBytes),
    post_response_http_receipt_sha256: rawSha(responseHttpBytes),
    post_response_payload_sha256: rawSha(responseBytes),
    terminal_feed_status_http_receipt_sha256: rawSha(feedStatusHttpBytes),
    terminal_feed_status_payload_sha256: rawSha(feedStatusBytes),
    schema_contract_sha256: rawSha(jsonBytes({ artifact: "schema-contract" })),
    get_spec_receipt_sha256: rawSha(jsonBytes({ artifact: "get-spec-receipt" })),
    get_spec_request_sha256: rawSha(jsonBytes({ artifact: "get-spec-request" })),
    get_spec_response_sha256: rawSha(jsonBytes({ artifact: "get-spec-response" })),
    live_item_receipt_sha256: rawSha(jsonBytes({ artifact: "live-item-receipt" })),
    live_item_response_sha256: rawSha(jsonBytes({ artifact: "live-item-response" })),
    ledger_identity_sha256: reference.ledger_identity_sha256,
    ledger_claim_sha256: rawSha(claimBytes),
    ledger_requesting_sha256: rawSha(requestingBytes),
    ledger_accepted_sha256: rawSha(jsonBytes({ ledger: "accepted" })),
    ledger_terminal_sha256: reference.ledger_terminal_sha256,
    ledger_head_sha256: reference.ledger_head_sha256,
    ledger_head_events_sha256: rawSha(jsonBytes({ ledger: "head-events" })),
    ledger_head_updated_at: FEED_AT,
    at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY",
    hostile_same_uid_resistance_claimed: false,
    distributed_at_most_once_claimed: false,
    exact_listing_count: 1,
    marketplace_write_calls: 1,
  };
  VERIFIED_APPLY_BY_PERMIT.set(permit.authorization_sha256, proof);
  return {
    permit,
    permitBody,
    reference,
    proof,
    bundle: {
      ledger_identity_bytes: identityBytes,
      ledger_claim_bytes: claimBytes,
      ledger_requesting_bytes: requestingBytes,
      ledger_terminal_bytes: terminalBytes,
      request_manifest_bytes: manifestBytes,
      request_payload_bytes: requestBytes,
      response_http_receipt_bytes: responseHttpBytes,
      response_payload_bytes: responseBytes,
      feed_status_http_receipt_bytes: feedStatusHttpBytes,
      feed_status_payload_bytes: feedStatusBytes,
    },
  };
}

async function fixture() {
  const sequence = sequenceAuthorization();
  const baseline = makeSource({
    surfaceKind: "baseline",
    capturedAt: BASE_CAPTURE,
    runLockCreatedAt: "2026-07-19T12:01:00.000Z",
    nonce: "baseline",
    verdict: "BAD",
  });
  const plan = await buildWalmartListingRepairPlanForTest({
    sequence_authorization: sequence,
    sequence_position: 0,
    baseline_source_bundle: baseline.bundle,
    plan_id: "repair-plan-acme-1",
    created_at: PLAN_AT,
    expires_at: "2026-07-19T13:00:00.000Z",
    apply_engine_release_sha256: APPLY_SHA,
    target_surface: targetSurface(),
    target_images: targetImages(),
    now: new Date(PLAN_AT),
  }, RUNTIME);
  const apply = buildApplyEvidence({ sequence, plan });
  const post = makeSource({
    surfaceKind: "target",
    capturedAt: POST_CAPTURE,
    runLockCreatedAt: "2026-07-19T12:21:00.000Z",
    nonce: "post",
    verdict: "PASS",
  });
  const evidence: WalmartListingRepairQualificationEvidencePackage = {
    plan,
    baseline_source_bundle: baseline.bundle,
    one_sku_permit: apply.permit,
    apply_evidence_reference: apply.reference,
    post_source_bundle: post.bundle,
  };
  return {
    sequence,
    baseline,
    plan,
    apply,
    post,
    evidence,
  };
}

async function evaluate(sequence, evidencePackages, at = QUALIFIED_AT, runtime = RUNTIME) {
  return evaluateWalmartListingRepairSequenceForTest({
    sequence_authorization: sequence,
    evidence_packages: evidencePackages,
    evaluated_at: new Date(at),
  }, runtime);
}

test("production verifier is pinned and still rejects an owner key outside the production trust root", async () => {
  assert.deepEqual(inspectWalmartListingRepairQualificationProductionReadiness(), {
    verifier_release_pinned: true,
    verifier_engine_release_sha256:
      "632bb723353b9e8ae28024631158a6ba4bbd1061efc1195e222b77ae838cc8d8",
    walmart_native_payload_validator_ready: true,
    frozen_apply_writer_attestation_ready: true,
  });
  await assert.rejects(
    evaluateWalmartListingRepairSequence({
      sequence_authorization: sequenceAuthorization(),
      evidence_packages: [],
    }),
    /owner authorization key is untrusted or revoked/,
  );
});

test("signed sequence releases only its exact first plan position and never a write", async () => {
  const sequence = sequenceAuthorization();
  const gate = await evaluate(sequence, []);
  assert.equal(gate.status, "READY_FOR_ONE_SKU_PLAN");
  assert.equal(gate.next_listing_key, LISTING_ONE.listing_key);
  assert.equal(gate.next_sku_released_for_plan_only, true);
  assert.equal(gate.marketplace_write_authorized, false);
  assert.equal(gate.mass_apply_allowed, false);

  const forged = clone(sequence);
  forged.signed_body.ordered_listings.reverse();
  const unsigned = { ...forged };
  delete unsigned.authorization_sha256;
  forged.authorization_sha256 = walmartListingRepairAuthoritySha256(unsigned);
  await assert.rejects(evaluate(forged, []), /signature is invalid/);
});

test("repair planning rejects a target that contradicts Product Truth before any permit", async () => {
  const sequence = sequenceAuthorization();
  const baseline = makeSource({
    surfaceKind: "baseline",
    capturedAt: BASE_CAPTURE,
    runLockCreatedAt: "2026-07-19T12:01:00.000Z",
    nonce: "bad-target-baseline",
    verdict: "BAD",
  });
  const wrongTarget = targetSurface();
  wrongTarget.title = "Acme Rye Bread, 20 oz (Pack of 2)";
  await assert.rejects(
    buildWalmartListingRepairPlanForTest({
      sequence_authorization: sequence,
      sequence_position: 0,
      baseline_source_bundle: baseline.bundle,
      plan_id: "repair-plan-bad-target",
      created_at: PLAN_AT,
      expires_at: "2026-07-19T13:00:00.000Z",
      apply_engine_release_sha256: APPLY_SHA,
      target_surface: wrongTarget,
      target_images: targetImages(),
      now: new Date(PLAN_AT),
    }, RUNTIME),
    /target title does not express exact Product Truth identity\/count/,
  );
});

test("gate rebuilds PASS from exact evidence and ignores a forged cached PASS/actor", async () => {
  const fx = await fixture();
  fx.evidence.cached_qualification = {
    verdict: "PASS",
    next_sku_unblocked: true,
    verifier_actor_id: "owner-or-admin-string-does-not-confer-authority",
    body_sha256: walmartListingIntegritySha256("forged-cache"),
  };
  const gate = await evaluate(fx.sequence, [fx.evidence]);
  assert.equal(gate.status, "READY_FOR_ONE_SKU_PLAN");
  assert.equal(gate.completed_pass_count, 1);
  assert.equal(gate.next_listing_key, LISTING_TWO.listing_key);
  assert.equal(gate.rebuilt_qualifications[0].verdict, "PASS");
  assert.equal(gate.rebuilt_qualifications[0].qualified_at, QUALIFIED_AT);
  assert.equal(gate.rebuilt_qualifications[0].facets.published_and_indexed, "PASS");
  assert.equal(
    gate.rebuilt_qualifications[0].exact_evidence
      .post_catalog_search_payload_file_sha256,
    rawSha(fx.post.bundle.catalog_search_payload_bytes),
  );
  assert.equal(gate.rebuilt_qualifications[0].authority.cached_qualification_used_as_authority, false);
  assert.equal(
    gate.rebuilt_qualifications[0].exact_evidence.response_payload_sha256,
    fx.apply.proof.post_response_payload_sha256,
  );
  assert.equal(
    gate.rebuilt_qualifications[0].exact_evidence.request_manifest_sha256,
    fx.apply.proof.request_manifest_sha256,
  );
  assert.equal(
    gate.rebuilt_qualifications[0].exact_evidence.post_response_http_receipt_sha256,
    fx.apply.proof.post_response_http_receipt_sha256,
  );
  assert.equal(
    gate.rebuilt_qualifications[0].exact_evidence.terminal_feed_status_http_receipt_sha256,
    fx.apply.proof.terminal_feed_status_http_receipt_sha256,
  );
  assert.equal(
    gate.rebuilt_qualifications[0].exact_evidence.feed_status_payload_sha256,
    fx.apply.proof.terminal_feed_status_payload_sha256,
  );
  assert.equal(
    gate.rebuilt_qualifications[0].exact_evidence.target_image_certificate_sha256,
    fx.apply.proof.target_image_certificate_sha256,
  );
  assert.equal(
    gate.rebuilt_qualifications[0].exact_evidence.ledger_terminal_sha256,
    fx.apply.reference.ledger_terminal_sha256,
  );
  assert.equal(
    gate.rebuilt_qualifications[0].exact_evidence.ledger_head_sha256,
    fx.apply.reference.ledger_head_sha256,
  );
  assert.equal(
    gate.rebuilt_qualifications[0].exact_evidence.artifact_custody_identity_sha256,
    fx.apply.reference.artifact_custody_identity_sha256,
  );
  assert.equal(
    gate.rebuilt_qualifications[0].exact_evidence.artifact_custody_inventory_sha256,
    fx.apply.reference.artifact_custody_inventory_sha256,
  );
  assert.equal(gate.marketplace_write_authorized, false);

  await assert.rejects(
    evaluate(fx.sequence, [{
      plan: fx.plan,
      cached_qualification: fx.evidence.cached_qualification,
    }]),
    /MISSING_AUTHENTICATED_APPLY_EVIDENCE/,
  );
});

test("even valid owner signatures cannot substitute a permit for another position, plan, target, or truth", async () => {
  const fx = await fixture();
  const mutations = [
    (body) => { body.sequence_position = 1; },
    (body) => { body.plan_body_sha256 = "e".repeat(64); },
    (body) => { body.target_sha256 = "f".repeat(64); },
    (body) => { body.product_truth.expected_sha256 = "0".repeat(64); },
  ];
  for (const mutate of mutations) {
    const body = clone(fx.apply.permitBody);
    mutate(body);
    const evidence = { ...fx.evidence, one_sku_permit: signPermitBody(body) };
    await assert.rejects(
      evaluate(fx.sequence, [evidence]),
      /differs from sequence\/plan\/Product Truth target/,
    );
  }
});

test("qualification rejects legacy raw apply bundles and caller-authored qualified_at", async () => {
  const fx = await fixture();
  const rawOnly = { ...fx.evidence } as Record<string, unknown>;
  delete rawOnly.apply_evidence_reference;
  rawOnly.apply_bundle = fx.apply.bundle;
  await assert.rejects(
    evaluate(fx.sequence, [rawOnly]),
    /MISSING_AUTHENTICATED_APPLY_EVIDENCE/,
  );
  await assert.rejects(
    evaluate(fx.sequence, [{ ...fx.evidence, apply_bundle: fx.apply.bundle }]),
    /legacy or extra fields/,
  );
  await assert.rejects(
    evaluate(fx.sequence, [{ ...fx.evidence, qualified_at: LATE_QUALIFIED_AT }]),
    /legacy or extra fields/,
  );
});

test("apply reference and independently returned verified-proof drift fail closed", async () => {
  const fx = await fixture();
  await assert.rejects(
    evaluate(fx.sequence, [{
      ...fx.evidence,
      apply_evidence_reference: {
        ...fx.apply.reference,
        ledger_terminal_sha256: "f".repeat(64),
      },
    }]),
    /differs from reference\/permit\/plan\/release/,
  );

  const driftingRuntime = {
    ...RUNTIME,
    verifyApply: async (input: Parameters<typeof RUNTIME.verifyApply>[0]) => ({
      ...await RUNTIME.verifyApply(input),
      request_payload_sha256: "f".repeat(64),
    }),
  };
  await assert.rejects(
    evaluate(fx.sequence, [fx.evidence], QUALIFIED_AT, driftingRuntime),
    /differs from reference\/permit\/plan\/release/,
  );
});

test("baseline capture reuse is rejected; unchanged authenticated buyer surface becomes FAIL after six hours", async () => {
  const fx = await fixture();
  await assert.rejects(
    evaluate(fx.sequence, [{ ...fx.evidence, post_source_bundle: fx.baseline.bundle }]),
    /reuses baseline exchange\/authorization nonce|not authenticated after feed confirmation/,
  );

  const staleLate = makeSource({
    surfaceKind: "baseline",
    capturedAt: LATE_CAPTURE,
    runLockCreatedAt: "2026-07-19T18:21:00.000Z",
    nonce: "late-still-unchanged",
    verdict: "BAD",
  });
  const gate = await evaluate(fx.sequence, [{
    ...fx.evidence,
    post_source_bundle: staleLate.bundle,
  }], LATE_QUALIFIED_AT);
  assert.equal(gate.status, "HALTED_ON_FAILURE");
  assert.equal(gate.rebuilt_qualifications[0].verdict, "FAIL");
  assert.equal(gate.rebuilt_qualifications[0].facets.propagation_window_complete, "PASS");
  assert.equal(gate.rebuilt_qualifications[0].qualified_at, LATE_QUALIFIED_AT);
  assert.equal(gate.marketplace_write_authorized, false);
});

test("historical qualification can inspect an expired permit, but a writer cannot consume it", async () => {
  const fx = await fixture();
  assert.equal(
    verifyWalmartListingRepairOneSkuPermitHistoricalForTest(fx.apply.permit, TEST_ENV)
      .authorization_sha256,
    fx.apply.permit.authorization_sha256,
  );
  assert.throws(
    () => verifyCurrentWalmartListingRepairOneSkuPermitForTest(
      fx.apply.permit,
      new Date("2026-07-19T12:31:00.000Z"),
      TEST_ENV,
    ),
    /one-SKU permit is not current/,
  );
});
