import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
import { walmartListingIntegritySha256 } from "../../src/lib/walmart/listing-integrity-audit.ts";
import {
  walmartListingObservationImageId,
  walmartListingObservationPromptSha256,
} from "../../src/lib/walmart/listing-integrity-observation.ts";
import {
  WALMART_LISTING_INTEGRITY_FREEZE_SPEC_SCHEMA,
  assembleWalmartListingIntegrityOwnerAuthorization,
  buildWalmartListingIntegrityShards,
  createWalmartListingIntegrityOwnerAuthorizationRequest,
  freezeWalmartListingIntegrityBundle,
  freezeWalmartListingIntegrityBundleForTest,
  issueWalmartListingIntegrityExecutionPermit,
  parseWalmartListingIntegrityFreezerCli,
  parseWalmartListingIntegrityFreezeSpec,
} from "../freeze-walmart-listing-integrity-bundle.mjs";
import {
  WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
  walmartListingIntegrityOwnerAuthorizationSigningMessage,
  parseRunLock,
  runPlan,
  sha256Bytes,
} from "../walmart-listing-integrity-engine.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const CAPTURED_AT = "2026-07-18T20:00:00.000Z";
const OWNER_KEYS = generateKeyPairSync("ed25519");
const OWNER_PUBLIC_DER = OWNER_KEYS.publicKey.export({ format: "der", type: "spki" });
const OWNER_PUBLIC_SHA = createHash("sha256").update(OWNER_PUBLIC_DER).digest("hex");

function ownerExecutionAuthority() {
  return {
    algorithm: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
    key_id: "fixture-owner-key",
    public_key_spki_der_base64: OWNER_PUBLIC_DER.toString("base64"),
    public_key_spki_sha256: OWNER_PUBLIC_SHA,
  };
}

test("freezer CLI separates freeze, external authorization, and one-shot partition permits", () => {
  assert.deepEqual(
    parseWalmartListingIntegrityFreezerCli([
      "freeze", "--spec=/tmp/spec.json", "--output-dir=/tmp/family",
    ]),
    {
      help: false,
      command: "freeze",
      spec_path: "/tmp/spec.json",
      output_dir: "/tmp/family",
    },
  );
  assert.deepEqual(
    parseWalmartListingIntegrityFreezerCli([
      "permit", "--bundle-dir=/tmp/family", "--partition-id=partition-000001",
      "--owner-authorization=/tmp/owner-authorization.json",
    ]),
    {
      help: false,
      command: "permit",
      bundle_dir: "/tmp/family",
      partition_id: "partition-000001",
      owner_authorization: "/tmp/owner-authorization.json",
    },
  );
  assert.throws(
    () => parseWalmartListingIntegrityFreezerCli([
      "permit", "--bundle-dir=relative", "--partition-id=partition-000001",
      "--owner-authorization=/tmp/owner-authorization.json",
    ]),
    /absolute normalized path/,
  );
  assert.throws(
    () => parseWalmartListingIntegrityFreezerCli([
      "permit", "--bundle-dir=/tmp/family", "--partition-id=partition-000001",
      "--partition-id=partition-000002",
      "--owner-authorization=/tmp/owner-authorization.json",
    ]),
    /was repeated/,
  );
  assert.throws(
    () => parseWalmartListingIntegrityFreezerCli([
      "permit", "--bundle-dir=/tmp/family", "--partition-id=partition-000001",
      "--owner-authorization=/tmp/owner-authorization.json",
      "--spec=/tmp/spec.json",
    ]),
    /unsupported flag for permit/,
  );
  assert.deepEqual(
    parseWalmartListingIntegrityFreezerCli([
      "authorization-request", "--bundle-dir=/tmp/family", "--approval-id=approval-001",
      "--partition-ids=partition-000001,partition-000002",
      "--issued-at=2026-07-18T20:00:00.000Z",
      "--expires-at=2026-07-20T20:00:00.000Z",
      "--source-freshness-deadline=2026-07-19T20:00:00.000Z",
      "--output=/tmp/request.json",
    ]),
    {
      help: false,
      command: "authorization-request",
      bundle_dir: "/tmp/family",
      approval_id: "approval-001",
      partition_ids: ["partition-000001", "partition-000002"],
      issued_at: "2026-07-18T20:00:00.000Z",
      expires_at: "2026-07-20T20:00:00.000Z",
      source_freshness_deadline: "2026-07-19T20:00:00.000Z",
      output: "/tmp/request.json",
    },
  );
});

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeBytes(file, bytes) {
  await writeFile(file, bytes);
  return { path: file, sha256: sha(bytes) };
}

async function writeJson(file, value) {
  return writeBytes(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

async function makeWritable(directory) {
  try { await chmod(directory, 0o700); } catch { return; }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeWritable(path.join(directory, entry.name));
  }
}

function observerWorker() {
  return {
    analyze_url: "https://worker.example.test/codex-image/analyze-claude",
    build_sha256: SHA_A,
    receipt_key_id: "fixture-worker-key",
    receipt_public_key_sha256: SHA_B,
    cli_version: "claude-fixture-1",
    node_version: "v25.8.1",
    platform: "darwin",
    arch: "arm64",
    vision_timeout_ms: 180_000,
    reservation_ledger: {
      schema_version: "vision-call-reservation-ledger-contract/v1",
      ledger_id: "ledger-11111111-1111-4111-8111-111111111111",
      ledger_epoch: "epoch-22222222-2222-4222-8222-222222222222",
      state_directory_path_sha256: "3".repeat(64),
      directory_identity_sha256: "4".repeat(64),
      identity_artifact_sha256: "5".repeat(64),
    },
  };
}

function runtimePins() {
  return {
    swift_executable_sha256: "1".repeat(64),
    xcrun_executable_sha256: "2".repeat(64),
    swift_version_output_sha256: "3".repeat(64),
    macos_sdk_path_sha256: "4".repeat(64),
    macos_sdk_version: "26.5",
  };
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
    package_facts: [{ kind: "net_content", value: 20, unit: "oz", requirement: "required" }],
    truth_source: "manual_verified",
  };
}

function sealProductTruth(capturedAt) {
  const truth = expectedTruth();
  const evidence = (sourceRefId, sourceKind, supports) => ({
    source_ref_id: sourceRefId,
    source_kind: sourceKind,
    locator: `product-truth://${sourceRefId}`,
    captured_at: capturedAt,
    payload_sha256: catalogTruthCanonicalSha256(`payload:${sourceRefId}`),
    supports,
  });
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
      evidence("recipe", "recipe_record", ["outer_units", "component_truth"]),
      evidence("structured", "sku_reference_catalog", ["outer_units", "component_truth"]),
      evidence("truth", "sku_reference_catalog", ["outer_units", "identity", "package_facts"]),
    ],
  };
  const revisionSha = catalogTruthCanonicalSha256(revisionBody);
  const approvalBody = {
    decision: "approved",
    revision_body_sha256: revisionSha,
    approved_at: capturedAt,
    approved_by: "owner-fixture",
    approval_authority: "product_truth_platform_owner_gate",
    approval_method: "trusted_platform_record",
  };
  const body = {
    schema_version: PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
    captured_at: capturedAt,
    producer: "shared_product_truth_platform",
    rows: [{
      channel: "WALMART_US",
      store_index: 1,
      sku: "ACME-BREAD-2",
      listing_key: "walmart:1:ACME-BREAD-2",
      item_id: "123456789",
      revision: {
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
      },
    }],
  };
  const bodySha = catalogTruthCanonicalSha256(body);
  return {
    ...body,
    snapshot_id: `product-truth-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

function itemReportCapture(capturedAt) {
  const encoder = new TextEncoder();
  const at = (deltaMs) => new Date(Date.parse(capturedAt) + deltaMs).toISOString();
  const requestId = "request-item-v6-freezer-e2e";
  const downloadUrl = "https://walmart-reports.s3.amazonaws.com/reports/item-v6.csv?X-Amz-Signature=fixture";
  const accountScope = {
    channel: "WALMART_US",
    store_index: 1,
    seller_account_fingerprint_sha256: SHA_A,
  };
  const correlations = {
    create_sha256: walmartItemReportUtf8Sha256("freezer-create"),
    ready_status_sha256: walmartItemReportUtf8Sha256("freezer-ready"),
    download_locator_sha256: walmartItemReportUtf8Sha256("freezer-locator"),
    report_file_sha256: walmartItemReportUtf8Sha256("freezer-file"),
  };
  const binding = (correlation) => ({
    account_scope: accountScope,
    request_correlation_id_sha256: correlation,
  });
  const createRequest = encoder.encode(JSON.stringify(
    buildWalmartItemReportV6CreateRequestManifest(binding(correlations.create_sha256)),
  ));
  const createResponse = encoder.encode(JSON.stringify({
    requestId,
    requestSubmissionDate: at(-5 * 60_000),
    reportType: "ITEM",
    reportVersion: "v6",
  }));
  const readyRequest = encoder.encode(JSON.stringify(
    buildWalmartItemReportReadyRequestManifest(requestId, binding(correlations.ready_status_sha256)),
  ));
  const readyPayload = encoder.encode(JSON.stringify({
    requestId,
    requestStatus: "READY",
    reportType: "ITEM",
    reportVersion: "v6",
    createdTime: at(-5 * 60_000),
    reportGenerationDate: at(-60_000),
  }));
  const locatorRequest = encoder.encode(JSON.stringify(
    buildWalmartItemReportDownloadLocatorRequestManifest(
      requestId,
      binding(correlations.download_locator_sha256),
    ),
  ));
  const locatorResponse = encoder.encode(JSON.stringify({
    requestId,
    requestSubmissionDate: at(-5 * 60_000),
    reportGenerationDate: at(-60_000),
    downloadURL: downloadUrl,
    downloadURLExpirationTime: at(90 * 60_000),
  }));
  const fileRequest = encoder.encode(JSON.stringify(
    buildWalmartItemReportFileRequestManifest({
      ...binding(correlations.report_file_sha256),
      locator_url: downloadUrl,
    }),
  ));
  const title = expectedTruth().title.replaceAll('"', '""');
  const downloadedBody = encoder.encode(
    `SKU,ProductName,ProductId,ProductIdType,PublishedStatus,ProductCondition,LifecycleStatus\r\n`
    + `ACME-BREAD-2,"${title}",123456789012,UPC,PUBLISHED,New,ACTIVE\r\n`,
  );
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
  const correlationFor = (bytes) => (
    JSON.parse(new TextDecoder().decode(bytes)).authority.request_correlation_id_sha256
  );
  const seal = (requestBytes, responseBytes, http) => walmartItemReportTrustedExchangeSha256({
    request_manifest_bytes: requestBytes,
    request_correlation_id_sha256: correlationFor(requestBytes),
    response_payload_bytes: responseBytes,
    http,
  });
  const trustedContext = {
    account_scope: accountScope,
    request_correlations: correlations,
    ready_at: capturedAt,
    download_locator_at: at(60_000),
    report_file_requested_at: at(2 * 60_000),
    downloaded_at: at(3 * 60_000),
    trusted_exchange_seals: {
      create_response_sha256: seal(createRequest, createResponse, capture.http.create_response),
      ready_status_response_sha256: seal(readyRequest, readyPayload, capture.http.ready_status_response),
      download_locator_response_sha256: seal(
        locatorRequest,
        locatorResponse,
        capture.http.download_locator_response,
      ),
      download_response_sha256: seal(fileRequest, downloadedBody, capture.http.download_response),
    },
  };
  return { capture, trustedContext };
}

async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wm-freezer-")));
  const input = path.join(root, "input");
  const output = path.join(root, "bundle");
  await mkdir(input);
  t.after(async () => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  });

  const capturedAt = overrides.captured_at
    ?? new Date(Date.now() - 10 * 60_000).toISOString();
  const productTruthCapturedAt = overrides.product_truth_captured_at ?? capturedAt;
  const buyerSnapshotCapturedAt = overrides.buyer_snapshot_captured_at ?? capturedAt;
  const listingKey = "walmart:1:ACME-BREAD-2";
  const itemId = "123456789";
  const imageBytes = await sharp({
    create: { width: 24, height: 16, channels: 3, background: "#bc864d" },
  }).png().toBuffer();
  const fingerprint = await fingerprintGalleryImage("gallery-1", imageBytes);
  const imageUrl = "https://i5.walmartimages.com/acme-main.png";
  const sellerPayload = {
    ItemResponse: [{
      sku: "ACME-BREAD-2",
      productName: expectedTruth().title,
      upc: "123456789012",
      gtin: "00123456789012",
      wpid: "ACME-WPID",
      publishedStatus: "PUBLISHED",
      lifecycleStatus: "ACTIVE",
    }],
  };
  const catalogPayload = {
    items: [{
      standardUpc: ["123456789012"],
      itemId,
      title: expectedTruth().title,
      images: [{ url: imageUrl }],
      isMarketPlaceItem: true,
    }],
  };
  const buyerPayload = {
    product: {
      item_id: itemId,
      title: expectedTruth().title,
      main_image: imageUrl,
      images: [imageUrl],
      description: "Acme Golden Bread. Net weight 20 oz. Pack of 2.",
      feature_bullets: ["Acme Golden Bread"],
      brand: "Acme",
      product_type: "Bread",
      variant: "Golden",
      multipack_quantity: 2,
      net_content: { value: 20, unit: "oz" },
    },
  };
  const resolution = resolveExactWalmartItemCandidate(
    "ACME-BREAD-2",
    sellerPayload,
    catalogPayload,
  );
  const buyer = resolveExactBuyerPdp(
    buyerPayload,
    { sku: "ACME-BREAD-2", item_id: itemId },
  );
  const buyerAsset = {
    slot: "MAIN",
    source_url: imageUrl,
    final_url: imageUrl,
    sha256: fingerprint.sha256,
    bytes: imageBytes.byteLength,
    media_type: "image/png",
    extension: "png",
    decoded_format: "png",
    decoded_width: fingerprint.width,
    decoded_height: fingerprint.height,
    local_path: `assets/${fingerprint.sha256}.png`,
  };
  const snapshotBody = {
    schema_version: "walmart-buyer-facing-snapshot/v3",
    captured_at: buyerSnapshotCapturedAt,
    target: { sku: "ACME-BREAD-2", item_id: itemId },
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
      seller_payload_canonical_sha256: walmartListingIntegritySha256(sellerPayload),
      catalog_search_payload_canonical_sha256: walmartListingIntegritySha256(catalogPayload),
      resolution_canonical_sha256: walmartListingIntegritySha256(resolution),
      buyer_payload_canonical_sha256: walmartListingIntegritySha256(buyerPayload),
    },
    assets: [buyerAsset],
  };
  const snapshotSha = catalogTruthCanonicalSha256(snapshotBody);
  const buyerSnapshot = {
    ...snapshotBody,
    snapshot_id: `walmart-buyer-${buyerSnapshotCapturedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${snapshotSha.slice(0, 12)}`,
    body_sha256: snapshotSha,
  };
  const buyerIndexBody = {
    schema_version: WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
    captured_at: capturedAt,
    entries: [{
      channel: "WALMART_US",
      store_index: 1,
      sku: "ACME-BREAD-2",
      listing_key: listingKey,
      item_id: itemId,
      snapshot: buyerSnapshot,
    }],
  };
  const buyerIndexSha = catalogTruthCanonicalSha256(buyerIndexBody);
  const buyerIndex = {
    ...buyerIndexBody,
    index_id: `walmart-buyer-index-${buyerIndexSha.slice(0, 16)}`,
    body_sha256: buyerIndexSha,
  };
  const productTruth = sealProductTruth(productTruthCapturedAt);
  const catalogExport = compileWalmartCatalogTruthExport(productTruth, buyerIndex);
  assert.equal(catalogExport.cases[0].disposition, "auditable");

  const { capture, trustedContext } = itemReportCapture(capturedAt);
  const itemReportSource = compileWalmartItemReportPublishedSource(capture, trustedContext);
  const authoritativeScope = compileWalmartShadowPublishedCatalogSourceFromItemReport(
    itemReportSource,
  );

  const refs = {
    productTruth: await writeJson(path.join(input, "product-truth.json"), productTruth),
    buyerIndex: await writeJson(path.join(input, "buyer-index.json"), buyerIndex),
    catalogExport: await writeJson(path.join(input, "catalog-export.json"), catalogExport),
    buyerSnapshot: await writeJson(path.join(input, "buyer-snapshot.json"), buyerSnapshot),
    sellerPayload: await writeJson(path.join(input, "seller.json"), sellerPayload),
    catalogPayload: await writeJson(path.join(input, "catalog.json"), catalogPayload),
    buyerPayload: await writeJson(path.join(input, "buyer.json"), buyerPayload),
    image: await writeBytes(path.join(input, "main.png"), imageBytes),
    authoritativeScope: await writeJson(
      path.join(input, "authoritative-scope.json"),
      authoritativeScope,
    ),
    itemReportSource: await writeJson(
      path.join(input, "item-report-source.json"),
      itemReportSource,
    ),
  };
  const captureRefs = {
    create_request_manifest: await writeBytes(
      path.join(input, "item-create-request.json"), capture.create_request_manifest_bytes,
    ),
    create_response_payload: await writeBytes(
      path.join(input, "item-create-response.json"), capture.create_response_payload_bytes,
    ),
    ready_status_request_manifest: await writeBytes(
      path.join(input, "item-ready-request.json"), capture.ready_status_request_manifest_bytes,
    ),
    ready_status_payload: await writeBytes(
      path.join(input, "item-ready-response.json"), capture.ready_status_payload_bytes,
    ),
    download_locator_request_manifest: await writeBytes(
      path.join(input, "item-locator-request.json"), capture.download_locator_request_manifest_bytes,
    ),
    download_locator_response_payload: await writeBytes(
      path.join(input, "item-locator-response.json"), capture.download_locator_response_payload_bytes,
    ),
    report_file_request_manifest: await writeBytes(
      path.join(input, "item-file-request.json"), capture.report_file_request_manifest_bytes,
    ),
    downloaded_body: await writeBytes(
      path.join(input, "item-v6.csv"), capture.downloaded_body_bytes,
    ),
    http_create_response: await writeJson(
      path.join(input, "item-create-http.json"), capture.http.create_response,
    ),
    http_ready_status_response: await writeJson(
      path.join(input, "item-ready-http.json"), capture.http.ready_status_response,
    ),
    http_download_locator_response: await writeJson(
      path.join(input, "item-locator-http.json"), capture.http.download_locator_response,
    ),
    http_download_response: await writeJson(
      path.join(input, "item-download-http.json"), capture.http.download_response,
    ),
    trusted_context: await writeJson(
      path.join(input, "item-trusted-context.json"), trustedContext,
    ),
  };
  const spec = {
    schema_version: WALMART_LISTING_INTEGRITY_FREEZE_SPEC_SCHEMA,
    run_id: "freeze-fixture-001",
    created_at: overrides.run_created_at ?? new Date(Date.now() - 60_000).toISOString(),
    observer_worker: observerWorker(),
    owner_execution_authority: ownerExecutionAuthority(),
    source_artifacts: {
      authoritative_published_scope: refs.authoritativeScope,
      authoritative_item_report_source: refs.itemReportSource,
      authoritative_item_report_capture: captureRefs,
      product_truth_snapshot: refs.productTruth,
      buyer_snapshot_index: refs.buyerIndex,
      catalog_truth_export: refs.catalogExport,
    },
    listings: [{
      listing_key: listingKey,
      item_id: itemId,
      buyer_snapshot_manifest: refs.buyerSnapshot,
      seller_item_payload: refs.sellerPayload,
      catalog_search_payload: refs.catalogPayload,
      buyer_pdp_payload: refs.buyerPayload,
      buyer_assets: [{ slot: "main", file: refs.image }],
    }],
  };
  const specRef = await writeJson(path.join(input, "freeze-spec.json"), spec);
  return { root, output, spec, specRef, catalogExport };
}

test("strict freeze spec rejects unknown fields and normalizes deterministic listing order", () => {
  const base = {
    schema_version: WALMART_LISTING_INTEGRITY_FREEZE_SPEC_SCHEMA,
    run_id: "run-1",
    created_at: CAPTURED_AT,
    observer_worker: observerWorker(),
    owner_execution_authority: ownerExecutionAuthority(),
    source_artifacts: {
      authoritative_published_scope: { path: "/tmp/a", sha256: SHA_A },
      authoritative_item_report_source: { path: "/tmp/a", sha256: SHA_A },
      authoritative_item_report_capture: Object.fromEntries([
        "create_request_manifest", "create_response_payload",
        "ready_status_request_manifest", "ready_status_payload",
        "download_locator_request_manifest", "download_locator_response_payload",
        "report_file_request_manifest", "downloaded_body",
        "http_create_response", "http_ready_status_response",
        "http_download_locator_response", "http_download_response", "trusted_context",
      ].map((key) => [key, { path: "/tmp/a", sha256: SHA_A }])),
      product_truth_snapshot: { path: "/tmp/a", sha256: SHA_A },
      buyer_snapshot_index: { path: "/tmp/a", sha256: SHA_A },
      catalog_truth_export: { path: "/tmp/a", sha256: SHA_A },
    },
    listings: ["B", "A"].map((sku) => ({
      listing_key: `walmart:1:${sku}`,
      item_id: sku === "A" ? "1" : "2",
      buyer_snapshot_manifest: { path: "/tmp/a", sha256: SHA_A },
      seller_item_payload: { path: "/tmp/a", sha256: SHA_A },
      catalog_search_payload: { path: "/tmp/a", sha256: SHA_A },
      buyer_pdp_payload: { path: "/tmp/a", sha256: SHA_A },
      buyer_assets: [{ slot: "main", file: { path: "/tmp/a", sha256: SHA_A } }],
    })),
  };
  assert.deepEqual(
    parseWalmartListingIntegrityFreezeSpec(base).listings.map((row) => row.listing_key),
    ["walmart:1:A", "walmart:1:B"],
  );
  assert.throws(
    () => parseWalmartListingIntegrityFreezeSpec({ ...base, extra: true }),
    /keys must be exactly/,
  );
  const traversing = structuredClone(base);
  traversing.listings[0].buyer_assets[0].file.path = "/tmp/../tmp/a";
  assert.throws(() => parseWalmartListingIntegrityFreezeSpec(traversing), /absolute normalized path/);
});

test("deterministic certified batch-4 sharding covers exactly 24 images in six calls", () => {
  const rows = Array.from({ length: 24 }, (_, index) => {
    const slot = index === 0 ? "main" : `gallery-${index}`;
    const assetSha = String(index + 1).padStart(64, "0");
    return {
      listing_key: "walmart:1:SKU",
      item_id: "123",
      slot,
      asset_sha256: assetSha,
      model_view_sha256: SHA_A,
      image_id: walmartListingObservationImageId(assetSha, slot, "walmart:1:SKU"),
    };
  });
  const first = buildWalmartListingIntegrityShards(rows);
  const second = buildWalmartListingIntegrityShards(structuredClone(rows));
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((row) => row.images.length), [4, 4, 4, 4, 4, 4]);
  assert.deepEqual(first.flatMap((row) => row.images), rows);
  const observerArtifactPaths = first.flatMap((shard) => [
    shard.observation_batch_path,
    `${shard.observation_batch_path}.attempt.json`,
  ]);
  assert.equal(new Set(observerArtifactPaths).size, observerArtifactPaths.length);
  first.forEach((shard) => assert.equal(
    shard.prompt_sha256,
    walmartListingObservationPromptSha256(shard.images.map((row) => row.image_id)),
  ));
});

test("explicit test harness exercises core but cannot emit READY and refuses overwrite", async (t) => {
  const built = await fixture(t);
  let planCalls = 0;
  const result = await freezeWalmartListingIntegrityBundleForTest({
    spec_path: built.specRef.path,
    output_dir: built.output,
  }, {
    capture_runtime_pins: async () => runtimePins(),
    verify_catalog_export: () => built.catalogExport,
    run_plan: async (options, injected) => {
      planCalls += 1;
      const bytes = await readFile(options.run_lock);
      assert.equal(sha256Bytes(bytes), options.expect_run_lock_sha256);
      await runPlan(options, injected);
    },
  });
  assert.equal(planCalls, 1);
  assert.equal(result.status, "TEST_ONLY_NOT_READY");
  assert.equal(freezeWalmartListingIntegrityBundle.length, 1);
  assert.equal(result.listing_count, 1);
  assert.equal(result.image_count, 1);
  assert.equal(result.shard_count, 1);
  await assert.rejects(
    () => readFile(path.join(built.output, "READY.json")),
    (error) => error?.code === "ENOENT",
  );
  const ready = JSON.parse(
    await readFile(path.join(built.output, "TEST_ONLY_NOT_READY.json"), "utf8"),
  );
  assert.equal(ready.source_aware_plan.sha256, sha(await readFile(path.join(built.output, "source-aware-plan.json"))));
  const lockBytes = await readFile(path.join(built.output, "run-lock.json"));
  const lock = parseRunLock(JSON.parse(lockBytes.toString("utf8")));
  assert.equal(Object.hasOwn(lock, "execution_expires_at"), false);
  assert.equal(lock.observer_partitions.length, 1);
  assert.deepEqual(lock.observer_partitions[0].shard_ids, [lock.shards[0].shard_id]);
  assert.equal(lock.shards[0].images.length, 1);
  assert.equal((await stat(path.join(built.output, "TEST_ONLY_NOT_READY.json"))).mode & 0o222, 0);
  await assert.rejects(
    () => freezeWalmartListingIntegrityBundle({
      spec_path: built.specRef.path,
      output_dir: built.output,
    }),
    /must not already exist/,
  );
});

test("freezer never emits READY when the mandatory source-aware plan fails", async (t) => {
  const built = await fixture(t);
  await assert.rejects(
    () => freezeWalmartListingIntegrityBundleForTest({
      spec_path: built.specRef.path,
      output_dir: built.output,
    }, {
      capture_runtime_pins: async () => runtimePins(),
      verify_catalog_export: () => built.catalogExport,
      run_plan: async () => { throw new Error("semantic preflight rejected fixture"); },
    }),
    /semantic preflight rejected fixture/,
  );
  await assert.rejects(
    () => readFile(path.join(built.output, "READY.json")),
    (error) => error?.code === "ENOENT",
  );
  await assert.rejects(
    () => stat(built.output),
    (error) => error?.code === "ENOENT",
  );
});

test("atomic publish never replaces a target directory created at the commit boundary", async (t) => {
  const built = await fixture(t);
  await assert.rejects(
    () => freezeWalmartListingIntegrityBundleForTest({
      spec_path: built.specRef.path,
      output_dir: built.output,
    }, {
      capture_runtime_pins: async () => runtimePins(),
      verify_catalog_export: () => built.catalogExport,
      run_plan: async (options, injected) => {
        await runPlan(options, injected);
      },
      before_publish: async () => { await mkdir(built.output); },
    }),
    /appeared at atomic commit/,
  );
  assert.deepEqual(await readdir(built.output), []);
});

async function rejectStaleFreeze(built) {
  return assert.rejects(
    () => freezeWalmartListingIntegrityBundleForTest({
      spec_path: built.specRef.path,
      output_dir: built.output,
    }, {
      capture_runtime_pins: async () => runtimePins(),
      verify_catalog_export: () => built.catalogExport,
    }),
    /future-dated|hard 24h deadline already expired|captured_at/i,
  );
}

test("freezer rejects a backdated timeless family whose exact source deadline already expired", async (t) => {
  const stale = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
  const built = await fixture(t, { captured_at: stale, run_created_at: stale });
  await rejectStaleFreeze(built);
});

test("freezer includes Product Truth freshness and rejects a stale or missing timestamp", async (t) => {
  const staleProductTruth = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
  const staleBuilt = await fixture(t, { product_truth_captured_at: staleProductTruth });
  await rejectStaleFreeze(staleBuilt);

  const missingBuilt = await fixture(t);
  const productTruthPath = missingBuilt.spec.source_artifacts.product_truth_snapshot.path;
  const productTruth = JSON.parse(await readFile(productTruthPath, "utf8"));
  delete productTruth.captured_at;
  missingBuilt.spec.source_artifacts.product_truth_snapshot = await writeJson(
    productTruthPath,
    productTruth,
  );
  missingBuilt.specRef = await writeJson(missingBuilt.specRef.path, missingBuilt.spec);
  await rejectStaleFreeze(missingBuilt);
});

test("freezer rejects one stale locked buyer-facing snapshot even when common sources are fresh", async (t) => {
  const staleBuyer = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
  const built = await fixture(t, { buyer_snapshot_captured_at: staleBuyer });
  await rejectStaleFreeze(built);
});

test("production freezer E2E reaches READY through real catalog verifier and real source-aware runPlan", async (t) => {
  const built = await fixture(t);
  const result = await freezeWalmartListingIntegrityBundle({
    spec_path: built.specRef.path,
    output_dir: built.output,
  });
  assert.equal(result.status, "READY");
  assert.equal((await stat(built.output)).mode & 0o777, 0o500);
  const ready = JSON.parse(await readFile(path.join(built.output, "READY.json"), "utf8"));
  assert.equal(ready.schema_version, "walmart-listing-integrity-ready/v3");
  assert.equal(ready.status, "READY");
  assert.equal(ready.assurance.successful_observation_attempt_required, true);
  assert.equal(ready.assurance.observer_attempt_mode, "0444");
  assert.equal((await stat(path.join(built.output, "READY.json"))).mode & 0o777, 0o444);
  assert.equal((await stat(path.join(built.output, "observations"))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(built.output, "permits"))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(path.join(built.output, "observations")), []);
  assert.deepEqual(await readdir(path.join(built.output, "permits")), []);
  await assert.rejects(
    () => readFile(path.join(built.output, "TEST_ONLY_NOT_READY.json")),
    (error) => error?.code === "ENOENT",
  );
  assert.equal(
    ready.freezer_source.sha256,
    sha(await readFile(path.join(built.output, ready.freezer_source.path))),
  );
  const plan = JSON.parse(
    await readFile(path.join(built.output, "source-aware-plan.json"), "utf8"),
  );
  assert.equal(plan.assurance.semantic_source_preflight_verified, true);
  assert.equal(plan.authoritative_population.exact_population_reconciliation, true);
  assert.equal(plan.authoritative_population.authoritative_published_count, 1);
  assert.equal(plan.authoritative_population.auditable_count, 1);

  const partitionId = plan.observer_partitions[0].partition_id;
  const firstCreatedAt = new Date().toISOString();
  const hardDeadline = ready.hard_source_freshness.hard_deadline;
  const requestPath = path.join(built.root, "owner-authorization-request.json");
  const signaturePath = path.join(built.root, "owner-authorization-signature.bin");
  const forgedSignaturePath = path.join(built.root, "forged-owner-authorization-signature.bin");
  const authorizationPath = path.join(built.root, "owner-authorization.json");
  await assert.rejects(
    () => createWalmartListingIntegrityOwnerAuthorizationRequest({
      bundle_dir: built.output,
      approval_id: "owner-approval-future-deadline",
      partition_ids: [partitionId],
      issued_at: firstCreatedAt,
      expires_at: new Date(Date.parse(hardDeadline) + 1).toISOString(),
      source_freshness_deadline: new Date(Date.parse(hardDeadline) + 1).toISOString(),
      output: path.join(built.root, "forbidden-future-deadline-request.json"),
    }, { now: () => new Date(firstCreatedAt) }),
    /exceeds the immutable family hard deadline/,
  );
  const requestResult = await createWalmartListingIntegrityOwnerAuthorizationRequest({
    bundle_dir: built.output,
    approval_id: "owner-approval-freezer-e2e",
    partition_ids: [partitionId],
    issued_at: firstCreatedAt,
    expires_at: hardDeadline,
    source_freshness_deadline: hardDeadline,
    output: requestPath,
  }, { now: () => new Date(firstCreatedAt) });
  assert.equal(requestResult.status, "OWNER_SIGNATURE_REQUIRED");
  assert.equal(
    requestResult.signing_request.human_review_summary.total_subscription_calls_authorized,
    plan.observer_partitions[0].shard_ids.length,
  );
  assert.equal(
    requestResult.signing_request.human_review_summary.family_hard_source_freshness_deadline,
    hardDeadline,
  );
  await writeBytes(forgedSignaturePath, Buffer.alloc(64));
  await chmod(forgedSignaturePath, 0o444);
  await assert.rejects(
    () => assembleWalmartListingIntegrityOwnerAuthorization({
      bundle_dir: built.output,
      request: requestPath,
      signature: forgedSignaturePath,
      output: path.join(built.root, "forged-owner-authorization.json"),
    }, { now: () => new Date(firstCreatedAt) }),
    /Ed25519 signature is invalid/,
  );
  const signature = sign(
    null,
    Buffer.from(requestResult.signing_request.signing_message_base64, "base64"),
    OWNER_KEYS.privateKey,
  );
  await writeBytes(signaturePath, signature);
  await chmod(signaturePath, 0o444);
  const authorizationResult = await assembleWalmartListingIntegrityOwnerAuthorization({
    bundle_dir: built.output,
    request: requestPath,
    signature: signaturePath,
    output: authorizationPath,
  }, { now: () => new Date(firstCreatedAt) });
  assert.equal(authorizationResult.status, "OWNER_AUTHORIZATION_READY");
  const firstPermit = await issueWalmartListingIntegrityExecutionPermit({
    bundle_dir: built.output,
    partition_id: partitionId,
    owner_authorization: authorizationPath,
  }, { now: () => new Date(firstCreatedAt) });
  await assert.rejects(
    () => issueWalmartListingIntegrityExecutionPermit({
      bundle_dir: built.output,
      partition_id: partitionId,
      owner_authorization: authorizationPath,
    }, { now: () => new Date(firstCreatedAt) }),
    /already reserved and may never be reissued/,
  );
  assert.equal(firstPermit.run_lock_sha256, ready.run_lock.sha256);
  assert.equal(firstPermit.partition_id, partitionId);
  assert.equal(firstPermit.permit.body.created_at, firstCreatedAt);
  assert.equal(
    firstPermit.permit.body.expires_at,
    hardDeadline,
  );
  assert.equal(firstPermit.permit.body.owner_authorization.authorization_sha256,
    authorizationResult.authorization_sha256);
  assert.deepEqual(firstPermit.call_indexes, [0]);
  assert.equal(firstPermit.call_ceiling, 1);
  const artifact = path.join(built.output, ...firstPermit.permit_artifact.path.split("/"));
  assert.equal((await stat(artifact)).mode & 0o777, 0o444);
  assert.equal(sha(await readFile(artifact)), firstPermit.permit_artifact.sha256);
  const reservationArtifact = path.join(
    built.output,
    ...firstPermit.allowance_reservation_artifact.path.split("/"),
  );
  assert.equal((await stat(reservationArtifact)).mode & 0o777, 0o444);
  await assert.rejects(
    () => issueWalmartListingIntegrityExecutionPermit({
      bundle_dir: built.output,
      partition_id: partitionId,
      owner_authorization: authorizationPath,
    }, { now: () => new Date(hardDeadline) }),
    /authorization or source freshness deadline has expired/,
  );
});

test("freezer source has no network, model, database, marketplace, or R2 client call", async () => {
  const source = await readFile(
    new URL("../freeze-walmart-listing-integrity-bundle.mjs", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    /\bfetch\s*\(/u,
    /from\s+["'](?:node:)?https?["']/u,
    /new\s+PrismaClient\s*\(/u,
    /createClient\s*\(/u,
    /walmart\/client/u,
    /r2-client/u,
  ]) assert.doesNotMatch(source, forbidden);
});
