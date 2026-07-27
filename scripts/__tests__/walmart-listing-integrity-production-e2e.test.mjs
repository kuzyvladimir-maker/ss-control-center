import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

import {
  PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
  WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
  catalogTruthCanonicalSha256,
  compileWalmartCatalogTruthExport,
} from "../../src/lib/walmart/catalog-truth-export.ts";
import { fingerprintGalleryImage } from "../../src/lib/walmart/catalog-gallery-audit.ts";
import {
  BLIND_OBSERVATION_SCHEMA,
  BLIND_PROMPT_VERSION,
} from "../../src/lib/walmart/catalog-visual-audit.ts";
import {
  VISUAL_PREPROCESS_VERSION,
  preprocessCatalogVisual,
} from "../../src/lib/walmart/catalog-visual-preprocess.ts";
import { resolveExactBuyerPdp } from "../../src/lib/walmart/buyer-facing-snapshot.ts";
import { resolveExactWalmartItemCandidate } from "../../src/lib/walmart/exact-item-resolution.ts";
import {
  buildWalmartItemReportDownloadLocatorRequestManifest,
  buildWalmartItemReportFileRequestManifest,
  buildWalmartItemReportReadyRequestManifest,
  buildWalmartItemReportV6CreateRequestManifest,
  compileWalmartItemReportPublishedSource,
  compileWalmartShadowPublishedCatalogSourceFromItemReport,
  walmartItemReportTrustedExchangeSha256,
  walmartItemReportUtf8Sha256,
} from "../../src/lib/walmart/item-report-published-source.ts";
import {
  WALMART_LISTING_INTEGRITY_ENGINE_VERSION,
  WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
  WALMART_LISTING_INTEGRITY_REPORT_SCHEMA,
  WALMART_LISTING_SURFACE_SNAPSHOT_SCHEMA,
  sealWalmartListingSurfaceSnapshot,
  walmartListingIntegritySha256,
} from "../../src/lib/walmart/listing-integrity-audit.ts";
import {
  WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
  WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
  WALMART_LISTING_OBSERVER_VERSION,
  WALMART_LISTING_WORKER_RECEIPT_SCHEMA,
  WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA,
  WALMART_LISTING_WORKER_REQUEST_SCHEMA,
  canonicalWalmartListingObservationJson,
  sealWalmartListingObservationBatch,
  walmartListingObservationCallKey,
  walmartListingObservationImageId,
  walmartListingObservationPromptSha256,
  walmartListingObservationSha256,
} from "../../src/lib/walmart/listing-integrity-observation.ts";
import { LOCAL_VISUAL_OCR_ENGINE } from "../../src/lib/walmart/local-visual-ocr.ts";
import {
  WALMART_LISTING_INTEGRITY_BASE_INPUT_MODE,
  WALMART_LISTING_INTEGRITY_EXECUTOR_VERSION,
  WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
  WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_SCHEMA,
  WALMART_LISTING_INTEGRITY_RUN_LOCK_SCHEMA,
  assembleWalmartListingIntegrityOwnerExecutionAuthorization,
  buildWalmartListingIntegrityAllowanceReservation,
  buildWalmartListingIntegrityExecutionPermitBody,
  buildWalmartListingIntegrityOwnerExecutionAuthorizationBody,
  buildWalmartListingIntegritySourceFreshness,
  buildCurrentCodeBundleManifest,
  main as runEngine,
  parseWalmartListingIntegrityExecutionPermit,
  reportFilename,
  walmartListingIntegrityAllowanceReservationRelativePath,
  walmartListingIntegrityObserverPartitionId,
  walmartListingIntegrityOwnerAuthorizationSigningMessage,
} from "../walmart-listing-integrity-engine.mjs";

const CAPTURED_AT = "2026-07-18T20:00:00.000Z";
const RUN_LOCK_CREATED_AT = "2026-07-18T20:05:00.000Z";
const EXECUTION_NOW = new Date("2026-07-18T20:06:00.000Z");
const LISTING_KEY = "walmart:1:ACME-BREAD-2";
const SKU = "ACME-BREAD-2";
const ITEM_ID = "123456789";
const UPC = "123456789012";
const TITLE = "Acme Golden Sandwich Bread, 20 oz, 12 Count (Pack of 2)";
const WORKER_BUILD_SHA = "c".repeat(64);
const OCR_SCRIPT_SHA = "e".repeat(64);
const WORKER_KEYS = generateKeyPairSync("ed25519");
const WORKER_PUBLIC_DER = WORKER_KEYS.publicKey.export({ format: "der", type: "spki" });
const WORKER_PUBLIC_SHA = createHash("sha256").update(WORKER_PUBLIC_DER).digest("hex");
const OWNER_KEYS = generateKeyPairSync("ed25519");
const OWNER_PUBLIC_DER = OWNER_KEYS.publicKey.export({ format: "der", type: "spki" });
const OWNER_PUBLIC_SHA = createHash("sha256").update(OWNER_PUBLIC_DER).digest("hex");
const ENCODER = new TextEncoder();

function ownerExecutionAuthority() {
  return {
    algorithm: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
    key_id: "fixture-owner-key",
    public_key_spki_der_base64: OWNER_PUBLIC_DER.toString("base64"),
    public_key_spki_sha256: OWNER_PUBLIC_SHA,
  };
}

function workerReservationLedgerContract() {
  return {
    schema_version: WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA,
    ledger_id: "ledger-11111111-1111-4111-8111-111111111111",
    ledger_epoch: "epoch-22222222-2222-4222-8222-222222222222",
    state_directory_path_sha256: "3".repeat(64),
    directory_identity_sha256: "4".repeat(64),
    identity_artifact_sha256: "5".repeat(64),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJson(file, value) {
  const bytes = jsonBytes(value);
  await writeFile(file, bytes);
  return { path: file, sha256: sha256(bytes) };
}

async function writeBytes(file, bytes) {
  const exact = Buffer.from(bytes);
  await writeFile(file, exact);
  return { path: file, sha256: sha256(exact) };
}

function relativeRef(root, written) {
  return {
    path: path.relative(root, written.path).split(path.sep).join("/"),
    sha256: written.sha256,
  };
}

function stdoutCapture() {
  return {
    text: "",
    write(value) {
      this.text += String(value);
      return true;
    },
  };
}

function exactTruth() {
  return {
    title: TITLE,
    outer_units: 2,
    identity: {
      brand_aliases: ["acme"],
      product_marker_groups: [["sandwich bread", "bread"]],
      variant_marker_groups: [["golden"]],
      forbidden_markers: [
        { role: "variant", aliases: ["rye"] },
        { role: "product", aliases: ["hamburger buns"] },
      ],
    },
    package_facts: [
      { kind: "net_content", value: 20, unit: "oz", requirement: "required" },
      { kind: "inner_item_count", value: 12, unit: "count", requirement: "required" },
    ],
    truth_source: "manual_verified",
  };
}

function listingSurface() {
  return {
    title: TITLE,
    description: "Acme Golden Sandwich Bread. Each package has net weight 20 oz and contains 12 slices. Pack of 2.",
    bullets: ["Acme Golden sandwich bread for everyday meals"],
    attribute_claims: [
      { field_path: "product.brand", kind: "brand", text: "Acme" },
      { field_path: "product.inner_item_count", kind: "inner_item_count", value: 12, unit: "count" },
      { field_path: "product.multipack_quantity", kind: "outer_units", value: 2, unit: "count" },
      { field_path: "product.net_content", kind: "net_content", value: 20, unit: "oz" },
      { field_path: "product.product_type", kind: "product", text: "Sandwich Bread" },
      { field_path: "product.variant", kind: "variant", text: "Golden" },
    ],
    unmapped_attributes: [],
  };
}

function truthEvidence(sourceRefId, sourceKind, supports) {
  return {
    source_ref_id: sourceRefId,
    source_kind: sourceKind,
    locator: `product-truth://${sourceRefId}`,
    captured_at: CAPTURED_AT,
    payload_sha256: catalogTruthCanonicalSha256(`payload:${sourceRefId}`),
    supports,
  };
}

function sealProductTruth() {
  const truth = exactTruth();
  const component = {
    component_id: "ACME-GOLDEN-BREAD-20OZ",
    quantity: 2,
    identity: truth.identity,
    package_facts: truth.package_facts,
    source_ref_ids: ["recipe"],
  };
  const revisionBody = {
    revision_id: "truth-revision-acme-1",
    listing_kind: "multipack",
    category: "Bread",
    recipe: {
      recipe_id: "truth-revision-acme-1-recipe",
      composition: "same_product",
      outer_units: 2,
      components: [component],
      source_ref_ids: ["recipe"],
    },
    structured_record: {
      outer_units: 2,
      components: [{ component_id: component.component_id, quantity: 2 }],
      source_ref_ids: ["structured"],
    },
    proposed_truth: {
      outer_units: 2,
      identity: truth.identity,
      package_facts: truth.package_facts,
      truth_source: truth.truth_source,
      source_ref_ids: ["truth"],
    },
    source_evidence: [
      truthEvidence("recipe", "recipe_record", ["outer_units", "component_truth"]),
      truthEvidence("structured", "sku_reference_catalog", ["outer_units", "component_truth"]),
      truthEvidence("truth", "sku_reference_catalog", ["outer_units", "identity", "package_facts"]),
    ],
  };
  const revisionSha = catalogTruthCanonicalSha256(revisionBody);
  const approvalBody = {
    decision: "approved",
    revision_body_sha256: revisionSha,
    approved_at: CAPTURED_AT,
    approved_by: "owner-fixture",
    approval_authority: "product_truth_platform_owner_gate",
    approval_method: "trusted_platform_record",
  };
  const revision = {
    revision_id: revisionBody.revision_id,
    body_sha256: revisionSha,
    approval: {
      ...approvalBody,
      approval_sha256: catalogTruthCanonicalSha256(approvalBody),
    },
    superseded_by_revision_id: null,
    listing_kind: revisionBody.listing_kind,
    category: revisionBody.category,
    recipe: revisionBody.recipe,
    structured_record: revisionBody.structured_record,
    proposed_truth: revisionBody.proposed_truth,
    source_evidence: revisionBody.source_evidence,
  };
  const body = {
    schema_version: PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
    captured_at: CAPTURED_AT,
    producer: "shared_product_truth_platform",
    rows: [{
      channel: "WALMART_US",
      store_index: 1,
      sku: SKU,
      listing_key: LISTING_KEY,
      item_id: ITEM_ID,
      revision,
    }],
  };
  const bodySha = catalogTruthCanonicalSha256(body);
  return {
    ...body,
    snapshot_id: `product-truth-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

function sealBuyerSnapshot(assets, rawSources) {
  const resolution = resolveExactWalmartItemCandidate(
    SKU,
    rawSources.seller_item_payload,
    rawSources.catalog_search_payload,
  );
  const buyer = resolveExactBuyerPdp(
    rawSources.buyer_pdp_payload,
    { sku: SKU, item_id: ITEM_ID },
  );
  const body = {
    schema_version: "walmart-buyer-facing-snapshot/v3",
    captured_at: CAPTURED_AT,
    target: { sku: SKU, item_id: ITEM_ID },
    identity: {
      exact_sku_match: true,
      exact_item_id_match: true,
      buyer_facing_verified: true,
      seller: resolution.seller,
      catalog_search_candidate: resolution.catalog_search_candidate,
      buyer: {
        item_id: buyer.item_id,
        title: buyer.title,
        identity_evidence: buyer.identity_evidence,
      },
      chain_evidence: {
        seller_to_catalog: resolution.identity_evidence,
        catalog_to_buyer_pdp: buyer.identity_evidence,
      },
    },
    source_contract: {
      seller: "walmart_marketplace_exact_sku_get",
      candidate: "walmart_catalog_search_exact_upc",
      buyer: "walmart_buyer_pdp_exact_item_get",
      positional_or_fuzzy_fallbacks: 0,
      database_writes: 0,
      walmart_writes: 0,
      r2_writes: 0,
    },
    payload_hashes: {
      seller_payload_canonical_sha256:
        walmartListingIntegritySha256(rawSources.seller_item_payload),
      catalog_search_payload_canonical_sha256:
        walmartListingIntegritySha256(rawSources.catalog_search_payload),
      resolution_canonical_sha256: walmartListingIntegritySha256(resolution),
      buyer_payload_canonical_sha256:
        walmartListingIntegritySha256(rawSources.buyer_pdp_payload),
    },
    assets,
  };
  const bodySha = catalogTruthCanonicalSha256(body);
  return {
    ...body,
    snapshot_id: `walmart-buyer-20260718T200000Z-${bodySha.slice(0, 12)}`,
    body_sha256: bodySha,
  };
}

function sealBuyerIndex(snapshot) {
  const body = {
    schema_version: WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
    captured_at: CAPTURED_AT,
    entries: [{
      channel: "WALMART_US",
      store_index: 1,
      sku: SKU,
      listing_key: LISTING_KEY,
      item_id: ITEM_ID,
      snapshot,
    }],
  };
  const bodySha = catalogTruthCanonicalSha256(body);
  return {
    ...body,
    index_id: `walmart-buyer-index-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

function reportBytes() {
  const header = "SKU,ProductName,ProductId,ProductIdType,PublishedStatus,ProductCondition,LifecycleStatus";
  const escapedTitle = `"${TITLE.replaceAll('"', '""')}"`;
  return ENCODER.encode(`${header}\r\n${SKU},${escapedTitle},${UPC},UPC,PUBLISHED,New,ACTIVE\r\n`);
}

function itemReportCapture() {
  const requestId = "request-item-v6-production-e2e";
  const downloadUrl = "https://walmart-reports.s3.amazonaws.com/reports/item-v6.csv?X-Amz-Signature=fixture";
  const accountScope = {
    channel: "WALMART_US",
    store_index: 1,
    seller_account_fingerprint_sha256: "a".repeat(64),
  };
  const correlations = {
    create_sha256: walmartItemReportUtf8Sha256("e2e-create"),
    ready_status_sha256: walmartItemReportUtf8Sha256("e2e-ready"),
    download_locator_sha256: walmartItemReportUtf8Sha256("e2e-locator"),
    report_file_sha256: walmartItemReportUtf8Sha256("e2e-file"),
  };
  const binding = (correlation) => ({
    account_scope: accountScope,
    request_correlation_id_sha256: correlation,
  });
  const createRequest = ENCODER.encode(JSON.stringify(
    buildWalmartItemReportV6CreateRequestManifest(binding(correlations.create_sha256)),
  ));
  const createResponse = ENCODER.encode(JSON.stringify({
    requestId,
    requestSubmissionDate: "2026-07-18T19:55:00.000Z",
    reportType: "ITEM",
    reportVersion: "v6",
  }));
  const readyRequest = ENCODER.encode(JSON.stringify(
    buildWalmartItemReportReadyRequestManifest(
      requestId,
      binding(correlations.ready_status_sha256),
    ),
  ));
  const readyPayload = ENCODER.encode(JSON.stringify({
    requestId,
    requestStatus: "READY",
    reportType: "ITEM",
    reportVersion: "v6",
    createdTime: "2026-07-18T19:55:00.000Z",
    reportGenerationDate: "2026-07-18T19:59:00.000Z",
  }));
  const locatorRequest = ENCODER.encode(JSON.stringify(
    buildWalmartItemReportDownloadLocatorRequestManifest(
      requestId,
      binding(correlations.download_locator_sha256),
    ),
  ));
  const locatorResponse = ENCODER.encode(JSON.stringify({
    requestId,
    requestSubmissionDate: "2026-07-18T19:55:00.000Z",
    reportGenerationDate: "2026-07-18T19:59:00.000Z",
    downloadURL: downloadUrl,
    downloadURLExpirationTime: "2026-07-18T21:30:00.000Z",
  }));
  const fileRequest = ENCODER.encode(JSON.stringify(
    buildWalmartItemReportFileRequestManifest({
      ...binding(correlations.report_file_sha256),
      locator_url: downloadUrl,
    }),
  ));
  const downloadedBody = reportBytes();
  const requestIdSha = walmartItemReportUtf8Sha256(requestId);
  const capture = {
    create_request_manifest_bytes: createRequest,
    create_response_payload_bytes: createResponse,
    ready_status_request_manifest_bytes: readyRequest,
    ready_status_payload_bytes: readyPayload,
    download_locator_request_manifest_bytes: locatorRequest,
    download_locator_response_payload_bytes: locatorResponse,
    report_file_request_manifest_bytes: fileRequest,
    downloaded_body_bytes: downloadedBody,
    http: {
      create_response: {
        status: 200,
        content_type: "application/json",
        content_length: createResponse.byteLength,
        echoed_correlation_id_sha256: correlations.create_sha256,
        echoed_report_request_id_sha256: requestIdSha,
      },
      ready_status_response: {
        status: 200,
        content_type: "application/json",
        content_length: readyPayload.byteLength,
        echoed_correlation_id_sha256: correlations.ready_status_sha256,
        echoed_report_request_id_sha256: requestIdSha,
      },
      download_locator_response: {
        status: 200,
        content_type: "application/json",
        content_length: locatorResponse.byteLength,
        echoed_correlation_id_sha256: correlations.download_locator_sha256,
        echoed_report_request_id_sha256: requestIdSha,
      },
      download_response: {
        status: 200,
        content_type: "application/octet-stream",
        content_length: downloadedBody.byteLength,
        echoed_correlation_id_sha256: null,
        echoed_report_request_id_sha256: null,
      },
    },
  };
  const correlationFor = (manifestBytes) => (
    JSON.parse(new TextDecoder().decode(manifestBytes)).authority.request_correlation_id_sha256
  );
  const seal = (requestBytes, responseBytes, http) => (
    walmartItemReportTrustedExchangeSha256({
      request_manifest_bytes: requestBytes,
      request_correlation_id_sha256: correlationFor(requestBytes),
      response_payload_bytes: responseBytes,
      http,
    })
  );
  const trustedContext = {
    account_scope: accountScope,
    request_correlations: correlations,
    ready_at: CAPTURED_AT,
    download_locator_at: "2026-07-18T20:01:00.000Z",
    report_file_requested_at: "2026-07-18T20:02:00.000Z",
    downloaded_at: "2026-07-18T20:03:00.000Z",
    trusted_exchange_seals: {
      create_response_sha256: seal(
        createRequest,
        createResponse,
        capture.http.create_response,
      ),
      ready_status_response_sha256: seal(
        readyRequest,
        readyPayload,
        capture.http.ready_status_response,
      ),
      download_locator_response_sha256: seal(
        locatorRequest,
        locatorResponse,
        capture.http.download_locator_response,
      ),
      download_response_sha256: seal(
        fileRequest,
        downloadedBody,
        capture.http.download_response,
      ),
    },
  };
  return { capture, trustedContext };
}

function mainObservation(imageId) {
  return {
    image_id: imageId,
    visual_role: "tiled_main",
    visible_brand_text: "Acme",
    visible_product_text: "Sandwich Bread",
    visible_variant_text: "Golden",
    visible_size_texts: ["NET WT 20 OZ", "12 COUNT"],
    external_package_count: { mode: "exact", value: 2, min: null, max: null },
    outer_package_claims: ["Pack of 2"],
    inner_contents_claims: ["12 COUNT"],
    case_package_claims: [],
    unclear_quantity_claims: [],
    grid_cell_kind: "single_sellable_package",
    front_visibility: "all",
    background: "white",
    multiple_distinct_products: "no",
    readable_identity: "clear",
    evidence: ["Acme", "Golden", "Sandwich Bread", "20 OZ", "12 COUNT", "Pack of 2"],
    flags: [],
  };
}

function galleryObservation(imageId) {
  return {
    image_id: imageId,
    visual_role: "lifestyle",
    visible_brand_text: "Acme",
    visible_product_text: "Sandwich Bread",
    visible_variant_text: "Golden",
    visible_size_texts: [],
    external_package_count: { mode: "unknown", value: null, min: null, max: null },
    outer_package_claims: [],
    inner_contents_claims: [],
    case_package_claims: [],
    unclear_quantity_claims: [],
    grid_cell_kind: "not_a_grid",
    front_visibility: "none",
    background: "lifestyle",
    multiple_distinct_products: "no",
    readable_identity: "clear",
    evidence: ["Acme", "Golden", "Sandwich Bread"],
    flags: [],
  };
}

function signedWorkerReceipt({
  runLockSha,
  shardId,
  callKey,
  promptSha,
  resultSha,
  workerContract,
  imageBindings,
  executionPermit,
}) {
  const body = {
    issued_at: "2026-07-18T20:06:01.000Z",
    reservation_reserved_at: "2026-07-18T20:06:00.100Z",
    request_attestation: {
      schema_version: WALMART_LISTING_WORKER_REQUEST_SCHEMA,
      run_lock_sha256: runLockSha,
      shard_id: shardId,
      call_index: 0,
      call_key: callKey,
      prompt_sha256: promptSha,
      execution_permit_sha256: executionPermit.sha256,
      partition_id: executionPermit.body.partition_id,
      image_sha256: imageBindings.map((row) => row.model_view_sha256),
    },
    result_canonical_sha256: resultSha,
    worker_contract: {
      input_image_count: imageBindings.length,
      vision_provider: "claude_cli_subscription",
      vision_model: "sonnet",
      vision_reasoning_effort: null,
      cli_version: workerContract.cli_version,
      node_version: workerContract.node_version,
      runtime_platform: workerContract.runtime_platform,
      runtime_arch: workerContract.runtime_arch,
      worker_build: workerContract.worker_build,
      vision_timeout_ms: workerContract.vision_timeout_ms,
      reservation_ledger: workerContract.reservation_ledger,
    },
    subscription_policy: {
      auth_mode: "claude_subscription_oauth",
      paid_api_environment_absent: true,
      alternate_cloud_routing_absent: true,
    },
  };
  return {
    schema_version: WALMART_LISTING_WORKER_RECEIPT_SCHEMA,
    key_id: "fixture-worker-key",
    public_key_spki_der_base64: WORKER_PUBLIC_DER.toString("base64"),
    public_key_spki_sha256: WORKER_PUBLIC_SHA,
    body,
    signature_base64: sign(
      null,
      Buffer.from(canonicalWalmartListingObservationJson(body), "utf8"),
      WORKER_KEYS.privateKey,
    ).toString("base64"),
  };
}

function adjudicatorConstraints() {
  return {
    network_calls: 0,
    model_calls: 0,
    database_reads: 0,
    database_writes: 0,
    marketplace_reads: 0,
    marketplace_writes: 0,
    coverage: "exactly_once",
    output_write_policy: "immutable_wx_reports_only",
    observations: "precomputed_source_verified_only",
  };
}

function observerExecutionConstraints() {
  return {
    network_target: "locked_worker_only",
    worker_health_calls_per_execute: 1,
    subscription_calls_total: 1,
    calls_per_shard: 1,
    max_calls_per_execute: 6,
    transport_attempts_per_shard: 1,
    retries: 0,
    fallbacks: 0,
    paid_api_calls: 0,
    openai_model_calls: 0,
    database_reads: 0,
    database_writes: 0,
    marketplace_reads: 0,
    marketplace_writes: 0,
    local_ocr_required: true,
    execution_order: "partition_contiguous_prefix",
    ambiguous_attempt_policy: "offline_terminalize_technical_error_no_retry_then_resume",
    output_write_policy: "immutable_wx_attempt_and_observation_only",
  };
}

async function buildFixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wm-integrity-production-e2e-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  for (const directory of [
    "sources",
    "listing",
    "assets",
    "views",
    "observations",
  ]) {
    await mkdir(path.join(root, directory));
  }

  const mainBytes = await sharp({
    create: { width: 16, height: 12, channels: 3, background: "#d49a42" },
  }).png().toBuffer();
  const galleryRaw = Buffer.alloc(14 * 10 * 3);
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 14; x += 1) {
      const value = 255 - x * 18;
      galleryRaw.fill(value, (y * 14 + x) * 3, (y * 14 + x) * 3 + 3);
    }
  }
  const galleryBytes = await sharp(
    galleryRaw,
    { raw: { width: 14, height: 10, channels: 3 } },
  ).png().toBuffer();
  const [mainFingerprint, galleryFingerprint, mainPreprocessed, galleryPreprocessed] =
    await Promise.all([
      fingerprintGalleryImage("gallery-1", mainBytes),
      fingerprintGalleryImage("gallery-1", galleryBytes),
      preprocessCatalogVisual(mainBytes),
      preprocessCatalogVisual(galleryBytes),
    ]);
  const fullView = (preprocessed) => {
    const view = preprocessed.views.find((candidate) => candidate.role === "full");
    assert.ok(view, "preprocessor must produce exactly one full view");
    return view;
  };
  const mainView = fullView(mainPreprocessed);
  const galleryView = fullView(galleryPreprocessed);
  const buyerAssets = [
    {
      slot: "MAIN",
      source_url: "https://i5.walmartimages.com/acme-main.png",
      final_url: "https://i5.walmartimages.com/acme-main.png",
      sha256: mainFingerprint.sha256,
      bytes: mainBytes.byteLength,
      media_type: "image/png",
      extension: "png",
      decoded_format: "png",
      decoded_width: mainFingerprint.width,
      decoded_height: mainFingerprint.height,
      local_path: `assets/${mainFingerprint.sha256}.png`,
    },
    {
      slot: "GALLERY_1",
      source_url: "https://i5.walmartimages.com/acme-gallery.png",
      final_url: "https://i5.walmartimages.com/acme-gallery.png",
      sha256: galleryFingerprint.sha256,
      bytes: galleryBytes.byteLength,
      media_type: "image/png",
      extension: "png",
      decoded_format: "png",
      decoded_width: galleryFingerprint.width,
      decoded_height: galleryFingerprint.height,
      local_path: `assets/${galleryFingerprint.sha256}.png`,
    },
  ];
  const rawSources = {
    seller_item_payload: {
      ItemResponse: [{
        sku: SKU,
        productName: TITLE,
        upc: UPC,
        gtin: `00${UPC}`,
        wpid: "ACME-WPID",
        publishedStatus: "PUBLISHED",
        lifecycleStatus: "ACTIVE",
      }],
    },
    catalog_search_payload: {
      items: [{
        standardUpc: [UPC],
        itemId: ITEM_ID,
        title: TITLE,
        images: [{ url: buyerAssets[0].source_url }],
        isMarketPlaceItem: true,
      }],
    },
    buyer_pdp_payload: {
      product: {
        item_id: ITEM_ID,
        title: TITLE,
        main_image: buyerAssets[0].source_url,
        images: buyerAssets.map((row) => row.source_url),
        description: listingSurface().description,
        feature_bullets: listingSurface().bullets,
        brand: "Acme",
        product_type: "Sandwich Bread",
        variant: "Golden",
        multipack_quantity: 2,
        net_content: { value: 20, unit: "oz" },
        inner_item_count: 12,
      },
    },
  };

  const truth = sealProductTruth();
  const buyerSnapshot = sealBuyerSnapshot(buyerAssets, rawSources);
  const buyerIndex = sealBuyerIndex(buyerSnapshot);
  const catalogExport = compileWalmartCatalogTruthExport(truth, buyerIndex);
  const auditCase = catalogExport.cases[0];
  const surfaceSnapshot = sealWalmartListingSurfaceSnapshot({
    schema_version: WALMART_LISTING_SURFACE_SNAPSHOT_SCHEMA,
    captured_at: CAPTURED_AT,
    listing: {
      channel: "WALMART_US",
      store_index: 1,
      sku: SKU,
      listing_key: LISTING_KEY,
      item_id: ITEM_ID,
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
    },
    buyer_source: {
      contract: "walmart_buyer_pdp_exact_item_get",
      buyer_snapshot_id: buyerSnapshot.snapshot_id,
      buyer_snapshot_body_sha256: buyerSnapshot.body_sha256,
      buyer_payload_sha256: buyerSnapshot.payload_hashes.buyer_payload_canonical_sha256,
      exact_item_id_echo: true,
      complete_attribute_inventory: true,
    },
    surface: listingSurface(),
  });

  const sourceBindings = {
    product_truth_snapshot_id: truth.snapshot_id,
    product_truth_snapshot_body_sha256: truth.body_sha256,
    catalog_truth_export_id: catalogExport.export_id,
    catalog_truth_export_body_sha256: catalogExport.body_sha256,
    catalog_truth_case_id: auditCase.case_id,
    catalog_truth_preflight_sha256: auditCase.preflight_sha256,
    truth_revision_id: auditCase.truth_revision.revision_id,
    truth_revision_body_sha256: auditCase.truth_revision.body_sha256,
    truth_approval_sha256: auditCase.truth_revision.approval_sha256,
    buyer_index_id: buyerIndex.index_id,
    buyer_index_body_sha256: buyerIndex.body_sha256,
    buyer_snapshot_id: buyerSnapshot.snapshot_id,
    buyer_snapshot_body_sha256: buyerSnapshot.body_sha256,
    buyer_payload_sha256: buyerSnapshot.payload_hashes.buyer_payload_canonical_sha256,
    surface_snapshot_id: surfaceSnapshot.snapshot_id,
    surface_snapshot_body_sha256: surfaceSnapshot.body_sha256,
    surface_payload_sha256: surfaceSnapshot.buyer_source.buyer_payload_sha256,
  };
  const inputAssets = [
    {
      slot: "main",
      source_url: buyerAssets[0].final_url,
      sha256: mainFingerprint.sha256,
      byte_length: mainBytes.byteLength,
      decoded_width: mainFingerprint.width,
      decoded_height: mainFingerprint.height,
      dhash64: mainFingerprint.dhash64,
      buyer_facing_verified: true,
      surface: "buyer_pdp",
    },
    {
      slot: "gallery-1",
      source_url: buyerAssets[1].final_url,
      sha256: galleryFingerprint.sha256,
      byte_length: galleryBytes.byteLength,
      decoded_width: galleryFingerprint.width,
      decoded_height: galleryFingerprint.height,
      dhash64: galleryFingerprint.dhash64,
      buyer_facing_verified: true,
      surface: "buyer_pdp",
    },
  ];
  const baseInput = {
    schema_version: WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
    listing: {
      channel: "WALMART_US",
      store_index: 1,
      sku: SKU,
      listing_key: LISTING_KEY,
      item_id: ITEM_ID,
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
      captured_at: CAPTURED_AT,
      composition: "same_product",
    },
    source_bindings: sourceBindings,
    expected: structuredClone(auditCase.preflight.expected),
    surface: structuredClone(surfaceSnapshot.surface),
    images: {
      assets: inputAssets,
      evidence: [],
      duplicate_summary: null,
    },
  };

  const { capture, trustedContext } = itemReportCapture();
  const itemReportSource = compileWalmartItemReportPublishedSource(capture, trustedContext);
  const authoritativeScope = compileWalmartShadowPublishedCatalogSourceFromItemReport(
    itemReportSource,
  );

  const sourceFiles = {
    product_truth_snapshot: await writeJson(path.join(root, "sources/product-truth.json"), truth),
    buyer_snapshot_index: await writeJson(path.join(root, "sources/buyer-index.json"), buyerIndex),
    catalog_truth_export: await writeJson(path.join(root, "sources/catalog-truth.json"), catalogExport),
    authoritative_item_report_source: await writeJson(
      path.join(root, "sources/authoritative-item-report.json"),
      itemReportSource,
    ),
    authoritative_published_scope: await writeJson(
      path.join(root, "sources/authoritative-scope.json"),
      authoritativeScope,
    ),
    code_bundle_manifest: await writeJson(
      path.join(root, "sources/code-bundle-manifest.json"),
      await buildCurrentCodeBundleManifest(),
    ),
  };
  const captureFiles = {
    create_request_manifest: await writeBytes(
      path.join(root, "sources/item-create-request.json"),
      capture.create_request_manifest_bytes,
    ),
    create_response_payload: await writeBytes(
      path.join(root, "sources/item-create-response.json"),
      capture.create_response_payload_bytes,
    ),
    ready_status_request_manifest: await writeBytes(
      path.join(root, "sources/item-ready-request.json"),
      capture.ready_status_request_manifest_bytes,
    ),
    ready_status_payload: await writeBytes(
      path.join(root, "sources/item-ready-response.json"),
      capture.ready_status_payload_bytes,
    ),
    download_locator_request_manifest: await writeBytes(
      path.join(root, "sources/item-locator-request.json"),
      capture.download_locator_request_manifest_bytes,
    ),
    download_locator_response_payload: await writeBytes(
      path.join(root, "sources/item-locator-response.json"),
      capture.download_locator_response_payload_bytes,
    ),
    report_file_request_manifest: await writeBytes(
      path.join(root, "sources/item-file-request.json"),
      capture.report_file_request_manifest_bytes,
    ),
    downloaded_body: await writeBytes(
      path.join(root, "sources/item-v6.csv"),
      capture.downloaded_body_bytes,
    ),
    http_create_response: await writeJson(
      path.join(root, "sources/item-create-http.json"),
      capture.http.create_response,
    ),
    http_ready_status_response: await writeJson(
      path.join(root, "sources/item-ready-http.json"),
      capture.http.ready_status_response,
    ),
    http_download_locator_response: await writeJson(
      path.join(root, "sources/item-locator-http.json"),
      capture.http.download_locator_response,
    ),
    http_download_response: await writeJson(
      path.join(root, "sources/item-download-http.json"),
      capture.http.download_response,
    ),
    trusted_context: await writeJson(
      path.join(root, "sources/item-trusted-context.json"),
      trustedContext,
    ),
  };

  const listingFiles = {
    base_input: await writeJson(path.join(root, "listing/base-input.json"), baseInput),
    surface_snapshot: await writeJson(path.join(root, "listing/surface.json"), surfaceSnapshot),
    buyer_snapshot_manifest: await writeJson(path.join(root, "listing/buyer.json"), buyerSnapshot),
    seller_item_payload: await writeJson(
      path.join(root, "listing/seller-payload.json"),
      rawSources.seller_item_payload,
    ),
    catalog_search_payload: await writeJson(
      path.join(root, "listing/catalog-payload.json"),
      rawSources.catalog_search_payload,
    ),
    buyer_pdp_payload: await writeJson(
      path.join(root, "listing/buyer-payload.json"),
      rawSources.buyer_pdp_payload,
    ),
  };
  const assetFiles = [
    {
      slot: "main",
      buyer_asset: await writeBytes(path.join(root, "assets/main.png"), mainBytes),
      model_view: await writeBytes(path.join(root, "views/main.png"), mainView.bytes),
      image_id: walmartListingObservationImageId(mainFingerprint.sha256, "main", LISTING_KEY),
    },
    {
      slot: "gallery-1",
      buyer_asset: await writeBytes(path.join(root, "assets/gallery-1.png"), galleryBytes),
      model_view: await writeBytes(path.join(root, "views/gallery-1.png"), galleryView.bytes),
      image_id: walmartListingObservationImageId(
        galleryFingerprint.sha256,
        "gallery-1",
        LISTING_KEY,
      ),
    },
  ];
  const imageBindings = assetFiles.map((row) => ({
    listing_key: LISTING_KEY,
    item_id: ITEM_ID,
    slot: row.slot,
    asset_sha256: row.buyer_asset.sha256,
    model_view_sha256: row.model_view.sha256,
    image_id: row.image_id,
  }));
  const promptSha = walmartListingObservationPromptSha256(
    imageBindings.map((row) => row.image_id),
  );
  const runLock = {
    schema_version: WALMART_LISTING_INTEGRITY_RUN_LOCK_SCHEMA,
    run_id: "production-e2e-fixture",
    created_at: RUN_LOCK_CREATED_AT,
    purpose: "walmart_listing_integrity_frozen_family",
    engine_contract: {
      executor_version: WALMART_LISTING_INTEGRITY_EXECUTOR_VERSION,
      listing_engine_version: WALMART_LISTING_INTEGRITY_ENGINE_VERSION,
      input_schema_version: WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
      report_schema_version: WALMART_LISTING_INTEGRITY_REPORT_SCHEMA,
      base_input_mode: WALMART_LISTING_INTEGRITY_BASE_INPUT_MODE,
      source_aware_required: true,
      observation_artifacts_required: true,
    },
    observer_contract: {
      provider: "claude_cli_subscription",
      model: "sonnet",
      observer_version: WALMART_LISTING_OBSERVER_VERSION,
      observation_schema_version: WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
      prompt_version: BLIND_PROMPT_VERSION,
      preprocessor_version: VISUAL_PREPROCESS_VERSION,
      local_ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
      local_ocr_script_sha256: OCR_SCRIPT_SHA,
      worker_build_sha256: WORKER_BUILD_SHA,
      worker_receipt_key_id: "fixture-worker-key",
      worker_receipt_public_key_sha256: WORKER_PUBLIC_SHA,
      worker_analyze_url: "https://worker.example.test/codex-image/analyze-claude",
      vision_timeout_ms: 180_000,
      observer_response_margin_ms: 30_000,
      swift_executable_sha256: "1".repeat(64),
      xcrun_executable_sha256: "2".repeat(64),
      swift_version_output_sha256: "3".repeat(64),
      macos_sdk_path_sha256: "4".repeat(64),
      macos_sdk_version: "26.5",
      cli_version: "claude-fixture",
      node_version: "v24.0.0",
      platform: "darwin",
      arch: "arm64",
      health_attestation_required: true,
      response_attestation_required: true,
      attempt_count: 1,
      fallback_allowed: false,
      max_images_per_call: 6,
      reservation_ledger: workerReservationLedgerContract(),
    },
    owner_execution_authority: ownerExecutionAuthority(),
    hard_source_freshness: buildWalmartListingIntegritySourceFreshness({
      authoritative_scope_captured_at: CAPTURED_AT,
      product_truth_snapshot_captured_at: CAPTURED_AT,
      buyer_index_captured_at: CAPTURED_AT,
      locked_buyer_snapshot_captured_ats: [CAPTURED_AT],
    }),
    code_bundle_manifest: relativeRef(root, sourceFiles.code_bundle_manifest),
    source_artifacts: {
      authoritative_published_scope: relativeRef(
        root,
        sourceFiles.authoritative_published_scope,
      ),
      authoritative_item_report_source: relativeRef(
        root,
        sourceFiles.authoritative_item_report_source,
      ),
      authoritative_item_report_capture: Object.fromEntries(
        Object.entries(captureFiles).map(([key, value]) => [key, relativeRef(root, value)]),
      ),
      product_truth_snapshot: relativeRef(root, sourceFiles.product_truth_snapshot),
      buyer_snapshot_index: relativeRef(root, sourceFiles.buyer_snapshot_index),
      catalog_truth_export: relativeRef(root, sourceFiles.catalog_truth_export),
    },
    shards: [{
      shard_id: "shard-000000",
      call_index: 0,
      observation_batch_path: "observations/call-000000.json",
      prompt_sha256: promptSha,
      images: imageBindings,
    }],
    listings: [{
      listing_key: LISTING_KEY,
      item_id: ITEM_ID,
      base_input: relativeRef(root, listingFiles.base_input),
      surface_snapshot: relativeRef(root, listingFiles.surface_snapshot),
      buyer_snapshot_manifest: relativeRef(root, listingFiles.buyer_snapshot_manifest),
      seller_item_payload: relativeRef(root, listingFiles.seller_item_payload),
      catalog_search_payload: relativeRef(root, listingFiles.catalog_search_payload),
      buyer_pdp_payload: relativeRef(root, listingFiles.buyer_pdp_payload),
      assets: assetFiles.map((row) => ({
        slot: row.slot,
        buyer_asset: relativeRef(root, row.buyer_asset),
        model_view: relativeRef(root, row.model_view),
        image_id: row.image_id,
      })),
      shard_ids: ["shard-000000"],
    }],
    observer_partitions: [{
      partition_id: walmartListingIntegrityObserverPartitionId(0, ["shard-000000"]),
      partition_index: 0,
      shard_ids: ["shard-000000"],
    }],
    adjudicator_constraints: adjudicatorConstraints(),
    observer_execution_constraints: observerExecutionConstraints(),
  };
  const runLockFile = await writeJson(path.join(root, "run-lock.json"), runLock);
  const certificateStdout = stdoutCapture();
  await runEngine([
    "plan",
    `--run-lock=${runLockFile.path}`,
    `--expect-run-lock-sha256=${runLockFile.sha256}`,
  ], { stdout: certificateStdout, now: () => EXECUTION_NOW });
  const preflightCertificate = await writeJson(
    path.join(root, "preflight-certificate.json"),
    JSON.parse(certificateStdout.text).preflight_certificate,
  );
  await chmod(preflightCertificate.path, 0o444);
  const permitCreatedAt = "2026-07-18T20:05:30.000Z";
  const authorizationBody = buildWalmartListingIntegrityOwnerExecutionAuthorizationBody({
    run_lock: runLock,
    run_lock_sha256: runLockFile.sha256,
    preflight_certificate_sha256: preflightCertificate.sha256,
    approval_id: "owner-approval-production-e2e",
    partition_ids: [runLock.observer_partitions[0].partition_id],
    issued_at: "2026-07-18T20:05:15.000Z",
    expires_at: runLock.hard_source_freshness.hard_deadline,
    source_freshness_deadline: runLock.hard_source_freshness.hard_deadline,
  });
  const authority = ownerExecutionAuthority();
  const authorizationEnvelope = {
    schema_version: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_SCHEMA,
    algorithm: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
    key_id: authority.key_id,
    owner_public_key_spki_sha256: authority.public_key_spki_sha256,
    signed_body: authorizationBody,
  };
  const authorizationSignature = sign(
    null,
    walmartListingIntegrityOwnerAuthorizationSigningMessage(authorizationEnvelope),
    OWNER_KEYS.privateKey,
  );
  const ownerAuthorization = assembleWalmartListingIntegrityOwnerExecutionAuthorization({
    owner_execution_authority: authority,
    signed_body: authorizationBody,
    signature_base64: authorizationSignature.toString("base64"),
    expected: {
      run_lock: runLock,
      run_lock_sha256: runLockFile.sha256,
      run_id: runLock.run_id,
      preflight_certificate_sha256: preflightCertificate.sha256,
      now: new Date(permitCreatedAt),
    },
  });
  const allowanceReservation = buildWalmartListingIntegrityAllowanceReservation({
    owner_authorization: ownerAuthorization,
    sequence: 0,
    previous_reservation_sha256: ownerAuthorization.authorization_sha256,
    reserved_at: permitCreatedAt,
  });
  const allowanceRelativePath = walmartListingIntegrityAllowanceReservationRelativePath(
    ownerAuthorization.authorization_sha256,
    allowanceReservation,
  );
  const allowancePath = path.join(root, ...allowanceRelativePath.split("/"));
  await mkdir(path.dirname(allowancePath), { recursive: true });
  await writeJson(allowancePath, allowanceReservation);
  await chmod(allowancePath, 0o444);
  const executionPermitBody = buildWalmartListingIntegrityExecutionPermitBody({
    run_lock: runLock,
    run_lock_sha256: runLockFile.sha256,
    run_id: runLock.run_id,
    partition: runLock.observer_partitions[0],
    preflight_certificate_sha256: preflightCertificate.sha256,
    created_at: permitCreatedAt,
    owner_authorization: ownerAuthorization,
    allowance_reservation: allowanceReservation,
  });
  const executionPermit = parseWalmartListingIntegrityExecutionPermit({
    sha256: walmartListingObservationSha256(executionPermitBody),
    body: executionPermitBody,
  }, {
    run_lock: runLock,
    owner_execution_authority: authority,
    run_lock_sha256: runLockFile.sha256,
    run_id: runLock.run_id,
    partition: runLock.observer_partitions[0],
    preflight_certificate_sha256: preflightCertificate.sha256,
    family_created_at: runLock.created_at,
  });

  const workerContract = {
    worker_build: `sha256:${WORKER_BUILD_SHA}`,
    model: "sonnet",
    reasoning_effort: null,
    cli_version: "claude-fixture",
    node_version: "v24.0.0",
    runtime_platform: "darwin",
    runtime_arch: "arm64",
    vision_timeout_ms: 180_000,
    reservation_ledger: workerReservationLedgerContract(),
  };
  const result = {
    schema_version: BLIND_OBSERVATION_SCHEMA,
    observations: [
      mainObservation(assetFiles[0].image_id),
      galleryObservation(assetFiles[1].image_id),
    ],
  };
  const callIdentity = {
    run_lock_sha256: runLockFile.sha256,
    shard_id: "shard-000000",
    call_index: 0,
    worker_contract: workerContract,
    prompt_sha256: promptSha,
    image_bindings: imageBindings,
  };
  const callKey = walmartListingObservationCallKey(callIdentity);
  const resultSha = walmartListingObservationSha256(result);
  const localOcr = imageBindings.map((binding, index) => {
    const view = index === 0 ? mainView : galleryView;
    const ocrOutput = {
      schema_version: WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
      engine: LOCAL_VISUAL_OCR_ENGINE,
      views: [{
        view_role: "full",
        view_sha256: view.sha256,
        width: view.width,
        height: view.height,
        observations: [],
      }],
    };
    return {
      image_id: binding.image_id,
      asset_sha256: binding.asset_sha256,
      full_view_sha256: binding.model_view_sha256,
      preprocessor_version: VISUAL_PREPROCESS_VERSION,
      ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
      ocr_script_sha256: OCR_SCRIPT_SHA,
      ocr_output_sha256: walmartListingObservationSha256(ocrOutput),
      ocr_output: ocrOutput,
      truncated: false,
      auxiliary_ocr: { ocr_texts: [] },
    };
  });
  const attemptReservedAt = "2026-07-18T20:06:00.000Z";
  const requestAttestation = {
    schema_version: WALMART_LISTING_WORKER_REQUEST_SCHEMA,
    run_lock_sha256: runLockFile.sha256,
    shard_id: callIdentity.shard_id,
    call_index: 0,
    call_key: callKey,
    prompt_sha256: promptSha,
    execution_permit_sha256: executionPermit.sha256,
    partition_id: executionPermit.body.partition_id,
    image_sha256: imageBindings.map((image) => image.model_view_sha256),
  };
  const attemptBody = {
    schema_version: "walmart-listing-observation-attempt/v3",
    executor_version: "walmart-listing-observer-executor/v3",
    run_lock_sha256: runLockFile.sha256,
    shard_id: callIdentity.shard_id,
    call_index: 0,
    call_key: callKey,
    reserved_at: attemptReservedAt,
    observation_batch_path: runLock.shards[0].observation_batch_path,
    provider: "claude_cli_subscription",
    worker_contract: workerContract,
    execution_permit: executionPermit,
    prompt: { version: BLIND_PROMPT_VERSION, sha256: promptSha },
    image_bindings: imageBindings,
    local_ocr_sha256: walmartListingObservationSha256(localOcr),
    request_attestation: requestAttestation,
    execution_policy: {
      transport_attempts: 1,
      retries: 0,
      fallbacks: 0,
      paid_api_calls: 0,
      openai_model_calls: 0,
      output_write_policy: "immutable_wx_0444",
    },
  };
  const attempt = {
    ...attemptBody,
    body_sha256: walmartListingObservationSha256(attemptBody),
  };
  const attemptPath = path.join(root, "observations/call-000000.json.attempt.json");
  await writeJson(attemptPath, attempt);
  await chmod(attemptPath, 0o444);
  const observation = sealWalmartListingObservationBatch({
    schema_version: WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
    observer_version: WALMART_LISTING_OBSERVER_VERSION,
    run_lock_sha256: runLockFile.sha256,
    shard_id: callIdentity.shard_id,
    call_index: 0,
    call_key: callKey,
    created_at: "2026-07-18T20:06:00.100Z",
    provider: "claude_cli_subscription",
    worker_contract: workerContract,
    execution_permit: executionPermit,
    worker_receipt: signedWorkerReceipt({
      runLockSha: runLockFile.sha256,
      shardId: callIdentity.shard_id,
      callKey,
      promptSha,
      resultSha,
      workerContract,
      imageBindings,
      executionPermit,
    }),
    execution: {
      subscription_calls_consumed: 1,
      transport_attempts: 1,
      retries: 0,
      fallbacks: 0,
      paid_api_calls: 0,
      openai_model_calls: 0,
      input_image_count_attested: true,
      worker_contract_attested: true,
    },
    prompt: { version: BLIND_PROMPT_VERSION, sha256: promptSha },
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    image_bindings: imageBindings,
    result_canonical_sha256: resultSha,
    result,
    local_ocr: localOcr,
  });
  const observationPath = path.join(root, "observations/call-000000.json");
  await writeJson(observationPath, observation);
  await chmod(observationPath, 0o444);

  return {
    root,
    runLockPath: runLockFile.path,
    runLockSha: runLockFile.sha256,
    preflightCertificatePath: preflightCertificate.path,
    preflightCertificateSha: preflightCertificate.sha256,
  };
}

test("production offline path runs real ITEM bridge and source compilers through plan, audit, verify", async (t) => {
  const fixture = await buildFixture(t);
  const reportsDir = path.join(fixture.root, "reports");
  const planStdout = stdoutCapture();
  await runEngine([
    "plan",
    `--run-lock=${fixture.runLockPath}`,
    `--expect-run-lock-sha256=${fixture.runLockSha}`,
  ], { stdout: planStdout, now: () => EXECUTION_NOW });
  const plan = JSON.parse(planStdout.text);
  assert.equal(plan.mode, "PLAN");
  assert.equal(plan.listing_count, 1);
  assert.equal(plan.authoritative_population.exact_population_reconciliation, true);
  assert.equal(plan.assurance.semantic_source_preflight_verified, true);
  assert.equal(plan.assurance.network_calls, 0);
  assert.equal(plan.assurance.model_calls, 0);
  assert.equal(plan.assurance.database_reads, 0);
  assert.equal(plan.assurance.marketplace_reads, 0);

  const auditStdout = stdoutCapture();
  await runEngine([
    "audit",
    `--run-lock=${fixture.runLockPath}`,
    `--expect-run-lock-sha256=${fixture.runLockSha}`,
    `--preflight-certificate=${fixture.preflightCertificatePath}`,
    `--expect-preflight-certificate-sha256=${fixture.preflightCertificateSha}`,
    `--output-dir=${reportsDir}`,
  ], { stdout: auditStdout, now: () => EXECUTION_NOW });
  const audit = JSON.parse(auditStdout.text);
  assert.equal(audit.mode, "AUDIT");
  assert.equal(audit.reports_written, 1);
  assert.equal(audit.verdict_counts.PASS, 1);
  assert.equal(audit.authoritative_population.auditable_count, 1);
  assert.equal(audit.assurance.network_calls, 0);
  assert.equal(audit.assurance.model_calls, 0);
  assert.equal(audit.assurance.database_reads, 0);
  assert.equal(audit.assurance.marketplace_reads, 0);

  const reportPath = path.join(reportsDir, reportFilename(0, LISTING_KEY));
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.overall_verdict, "PASS");
  assert.equal(report.assurance.source_artifacts_verified, true);
  assert.equal(report.assurance.surface_snapshot_verified, true);
  assert.equal(report.assurance.asset_bytes_verified, true);
  assert.equal(report.assurance.observation_artifacts_verified, true);
  assert.equal((await stat(reportPath)).mode & 0o222, 0);

  const verifyStdout = stdoutCapture();
  await runEngine([
    "verify",
    `--run-lock=${fixture.runLockPath}`,
    `--expect-run-lock-sha256=${fixture.runLockSha}`,
    `--preflight-certificate=${fixture.preflightCertificatePath}`,
    `--expect-preflight-certificate-sha256=${fixture.preflightCertificateSha}`,
    `--reports-dir=${reportsDir}`,
    "--require-complete",
  ], { stdout: verifyStdout, now: () => EXECUTION_NOW });
  const verification = JSON.parse(verifyStdout.text);
  assert.equal(verification.mode, "VERIFY");
  assert.equal(verification.complete, true);
  assert.equal(verification.reports_verified, 1);
  assert.equal(verification.verdict_counts.PASS, 1);
  assert.equal(verification.authoritative_population.exact_population_reconciliation, true);
  assert.equal(verification.assurance.source_aware_rebuild, true);
  assert.equal(verification.assurance.network_calls, 0);
  assert.equal(verification.assurance.model_calls, 0);
  assert.equal(verification.assurance.database_reads, 0);
  assert.equal(verification.assurance.marketplace_reads, 0);
});
