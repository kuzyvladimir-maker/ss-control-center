import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";

import sharp from "sharp";

import {
  PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
  WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
  catalogTruthCanonicalSha256,
  compileWalmartCatalogTruthExport,
} from "../catalog-truth-export.ts";
import { fingerprintGalleryImage } from "../catalog-gallery-audit.ts";
import { preprocessCatalogVisual, VISUAL_PREPROCESS_VERSION } from "../catalog-visual-preprocess.ts";
import { BLIND_OBSERVATION_SCHEMA, BLIND_PROMPT_VERSION } from "../catalog-visual-audit.ts";
import { LOCAL_VISUAL_OCR_ENGINE } from "../local-visual-ocr.ts";
import { resolveExactBuyerPdp } from "../buyer-facing-snapshot.ts";
import { resolveExactWalmartItemCandidate } from "../exact-item-resolution.ts";
import {
  WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
  WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA,
  WALMART_LISTING_EXECUTION_PERMIT_SCHEMA,
  WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
  WALMART_LISTING_OBSERVER_VERSION,
  WALMART_LISTING_WORKER_RECEIPT_SCHEMA,
  WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA,
  WALMART_LISTING_WORKER_REQUEST_SCHEMA,
  canonicalWalmartListingObservationJson,
  sealWalmartListingObservationBatch,
  sealWalmartListingObservationTechnicalErrorTerminal,
  walmartListingObservationCallKey,
  walmartListingObservationPromptSha256,
  walmartListingObservationSha256,
} from "../listing-integrity-observation.ts";
import {
  WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
  WALMART_LISTING_SURFACE_SNAPSHOT_SCHEMA,
  compileWalmartListingIntegrityReport,
  compileWalmartListingIntegrityReportAgainstSources,
  projectWalmartListingSurfaceFromBuyerPdp,
  sealWalmartListingSurfaceSnapshot,
  verifyWalmartListingIntegrityReportAgainstInput,
  verifyWalmartListingIntegrityReportAgainstSources,
  walmartListingIntegrityImageId,
  walmartListingIntegritySha256,
} from "../listing-integrity-audit.ts";

const CAPTURED_AT = "2026-07-18T20:00:00.000Z";
const LISTING_KEY = "walmart:1:ACME-BREAD-2";
const MAIN_SHA = "a".repeat(64);
const GALLERY_SHA = "b".repeat(64);
const WORKER_KEYS = generateKeyPairSync("ed25519");
const WORKER_PUBLIC_DER = WORKER_KEYS.publicKey.export({ format: "der", type: "spki" });
const WORKER_PUBLIC_SHA = createHash("sha256").update(WORKER_PUBLIC_DER).digest("hex");

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

function signedWorkerReceipt({
  runLockSha, shardId, callIndex, callKey, promptSha, resultSha, workerContract,
  imageBindings, executionPermit,
}) {
  const body = {
    issued_at: "2026-07-18T20:00:01.000Z",
    reservation_reserved_at: CAPTURED_AT,
    request_attestation: {
      schema_version: WALMART_LISTING_WORKER_REQUEST_SCHEMA,
      run_lock_sha256: runLockSha,
      shard_id: shardId,
      call_index: callIndex,
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

function expected(overrides = {}) {
  return {
    title: "Acme Golden Sandwich Bread, 20 oz, 12 Count (Pack of 2)",
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
    ...overrides,
  };
}

function mainObservation(assetSha = MAIN_SHA, overrides = {}) {
  return {
    image_id: walmartListingIntegrityImageId(assetSha, "main", LISTING_KEY),
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
    ...overrides,
  };
}

function galleryObservation(slot = "gallery-1", assetSha = GALLERY_SHA, overrides = {}) {
  return {
    image_id: walmartListingIntegrityImageId(assetSha, slot, LISTING_KEY),
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
    ...overrides,
  };
}

function sourceBindings() {
  return {
    product_truth_snapshot_id: "product-truth-fixture",
    product_truth_snapshot_body_sha256: "1".repeat(64),
    catalog_truth_export_id: "catalog-truth-fixture",
    catalog_truth_export_body_sha256: "2".repeat(64),
    catalog_truth_case_id: "catalog-case-fixture",
    catalog_truth_preflight_sha256: "3".repeat(64),
    truth_revision_id: "truth-revision-fixture",
    truth_revision_body_sha256: "4".repeat(64),
    truth_approval_sha256: "5".repeat(64),
    buyer_index_id: "buyer-index-fixture",
    buyer_index_body_sha256: "6".repeat(64),
    buyer_snapshot_id: "buyer-snapshot-fixture",
    buyer_snapshot_body_sha256: "7".repeat(64),
    buyer_payload_sha256: "8".repeat(64),
    surface_snapshot_id: "surface-snapshot-fixture",
    surface_snapshot_body_sha256: "9".repeat(64),
    surface_payload_sha256: "8".repeat(64),
  };
}

function surface(title = expected().title) {
  return {
    title,
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

function asset(slot, sha256, dhash64 = "0000000000000000") {
  return {
    slot,
    source_url: `https://i5.walmartimages.com/${slot}-${sha256.slice(0, 4)}.png`,
    sha256,
    byte_length: 1_234,
    decoded_width: 1_200,
    decoded_height: 1_200,
    dhash64,
    buyer_facing_verified: true,
    surface: "buyer_pdp",
  };
}

function observedEvidence(slot, sha256, observation) {
  return {
    slot,
    asset_sha256: sha256,
    state: "observed",
    observation,
    auxiliary_ocr: { ocr_texts: [] },
    local_ocr_truncated: false,
  };
}

function validInput() {
  const truth = expected();
  return {
    schema_version: WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
    listing: {
      channel: "WALMART_US",
      store_index: 1,
      sku: "ACME-BREAD-2",
      listing_key: "walmart:1:ACME-BREAD-2",
      item_id: "123456789",
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
      captured_at: CAPTURED_AT,
      composition: "same_product",
    },
    source_bindings: sourceBindings(),
    expected: truth,
    surface: surface(truth.title),
    images: {
      assets: [asset("main", MAIN_SHA), asset("gallery-1", GALLERY_SHA)],
      evidence: [
        observedEvidence("main", MAIN_SHA, mainObservation()),
        observedEvidence("gallery-1", GALLERY_SHA, galleryObservation()),
      ],
      duplicate_summary: null,
    },
  };
}

function compile(mutator = () => {}) {
  const input = validInput();
  mutator(input);
  return { input, report: compileWalmartListingIntegrityReport(input) };
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

function sealCatalogTruthFixture() {
  const identity = expected().identity;
  const packageFacts = expected().package_facts;
  const component = {
    component_id: "ACME-GOLDEN-BREAD-20OZ",
    quantity: 2,
    identity,
    package_facts: packageFacts,
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
      identity,
      package_facts: packageFacts,
      truth_source: "manual_verified",
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
    approval: { ...approvalBody, approval_sha256: catalogTruthCanonicalSha256(approvalBody) },
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
      sku: "ACME-BREAD-2",
      listing_key: "walmart:1:ACME-BREAD-2",
      item_id: "123456789",
      revision,
    }],
  };
  const bodySha = catalogTruthCanonicalSha256(body);
  return { ...body, snapshot_id: `product-truth-${bodySha.slice(0, 16)}`, body_sha256: bodySha };
}

function sealBuyerSnapshot(assets, rawSources) {
  const resolution = resolveExactWalmartItemCandidate(
    "ACME-BREAD-2",
    rawSources.seller_item_payload,
    rawSources.catalog_search_payload,
  );
  const rebuiltBuyer = resolveExactBuyerPdp(
    rawSources.buyer_pdp_payload,
    { sku: "ACME-BREAD-2", item_id: "123456789" },
  );
  const body = {
    schema_version: "walmart-buyer-facing-snapshot/v3",
    captured_at: CAPTURED_AT,
    target: { sku: "ACME-BREAD-2", item_id: "123456789" },
    identity: {
      exact_sku_match: true,
      exact_item_id_match: true,
      buyer_facing_verified: true,
      seller: resolution.seller,
      catalog_search_candidate: resolution.catalog_search_candidate,
      buyer: {
        item_id: rebuiltBuyer.item_id,
        title: rebuiltBuyer.title,
        identity_evidence: rebuiltBuyer.identity_evidence,
      },
      chain_evidence: {
        seller_to_catalog: resolution.identity_evidence,
        catalog_to_buyer_pdp: rebuiltBuyer.identity_evidence,
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
      sku: "ACME-BREAD-2",
      listing_key: "walmart:1:ACME-BREAD-2",
      item_id: "123456789",
      snapshot,
    }],
  };
  const bodySha = catalogTruthCanonicalSha256(body);
  return { ...body, index_id: `walmart-buyer-index-${bodySha.slice(0, 16)}`, body_sha256: bodySha };
}

let sourceFixturePromise;
async function sourceAwareFixture() {
  sourceFixturePromise ??= (async () => {
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
    const galleryBytes = await sharp(galleryRaw, { raw: { width: 14, height: 10, channels: 3 } }).png().toBuffer();
    const mainFingerprint = await fingerprintGalleryImage("gallery-1", mainBytes);
    const galleryFingerprint = await fingerprintGalleryImage("gallery-1", galleryBytes);
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
          sku: "ACME-BREAD-2",
          productName: expected().title,
          upc: "123456789012",
          gtin: "00123456789012",
          wpid: "ACME-WPID",
          publishedStatus: "PUBLISHED",
          lifecycleStatus: "ACTIVE",
        }],
      },
      catalog_search_payload: {
        items: [{
          standardUpc: ["123456789012"],
          itemId: "123456789",
          title: expected().title,
          images: [{ url: buyerAssets[0].source_url }],
          isMarketPlaceItem: true,
        }],
      },
      buyer_pdp_payload: {
        product: {
          item_id: "123456789",
          title: expected().title,
          main_image: buyerAssets[0].source_url,
          images: [buyerAssets[0].source_url, buyerAssets[1].source_url],
          description: surface().description,
          feature_bullets: surface().bullets,
          brand: "Acme",
          product_type: "Sandwich Bread",
          variant: "Golden",
          multipack_quantity: 2,
          net_content: { value: 20, unit: "oz" },
          inner_item_count: 12,
        },
      },
    };
    const truth = sealCatalogTruthFixture();
    const buyerSnapshot = sealBuyerSnapshot(buyerAssets, rawSources);
    const buyers = sealBuyerIndex(buyerSnapshot);
    const catalogExport = compileWalmartCatalogTruthExport(truth, buyers);
    const auditCase = catalogExport.cases[0];
    const surfaceSnapshot = sealWalmartListingSurfaceSnapshot({
      schema_version: WALMART_LISTING_SURFACE_SNAPSHOT_SCHEMA,
      captured_at: CAPTURED_AT,
      listing: {
        channel: "WALMART_US",
        store_index: 1,
        sku: "ACME-BREAD-2",
        listing_key: "walmart:1:ACME-BREAD-2",
        item_id: "123456789",
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
      surface: surface(auditCase.preflight.expected.title),
    });
    const input = validInput();
    input.expected = structuredClone(auditCase.preflight.expected);
    input.surface = structuredClone(surfaceSnapshot.surface);
    input.source_bindings = {
      product_truth_snapshot_id: truth.snapshot_id,
      product_truth_snapshot_body_sha256: truth.body_sha256,
      catalog_truth_export_id: catalogExport.export_id,
      catalog_truth_export_body_sha256: catalogExport.body_sha256,
      catalog_truth_case_id: auditCase.case_id,
      catalog_truth_preflight_sha256: auditCase.preflight_sha256,
      truth_revision_id: auditCase.truth_revision.revision_id,
      truth_revision_body_sha256: auditCase.truth_revision.body_sha256,
      truth_approval_sha256: auditCase.truth_revision.approval_sha256,
      buyer_index_id: buyers.index_id,
      buyer_index_body_sha256: buyers.body_sha256,
      buyer_snapshot_id: buyerSnapshot.snapshot_id,
      buyer_snapshot_body_sha256: buyerSnapshot.body_sha256,
      buyer_payload_sha256: buyerSnapshot.payload_hashes.buyer_payload_canonical_sha256,
      surface_snapshot_id: surfaceSnapshot.snapshot_id,
      surface_snapshot_body_sha256: surfaceSnapshot.body_sha256,
      surface_payload_sha256: surfaceSnapshot.buyer_source.buyer_payload_sha256,
    };
    input.images.assets = [
      {
        ...asset("main", mainFingerprint.sha256, mainFingerprint.dhash64),
        source_url: buyerAssets[0].final_url,
        byte_length: mainBytes.byteLength,
        decoded_width: mainFingerprint.width,
        decoded_height: mainFingerprint.height,
      },
      {
        ...asset("gallery-1", galleryFingerprint.sha256, galleryFingerprint.dhash64),
        source_url: buyerAssets[1].final_url,
        byte_length: galleryBytes.byteLength,
        decoded_width: galleryFingerprint.width,
        decoded_height: galleryFingerprint.height,
      },
    ];
    input.images.evidence = [
      observedEvidence("main", mainFingerprint.sha256, mainObservation(mainFingerprint.sha256)),
      observedEvidence(
        "gallery-1",
        galleryFingerprint.sha256,
        galleryObservation("gallery-1", galleryFingerprint.sha256),
      ),
    ];
    const [mainPreprocessed, galleryPreprocessed] = await Promise.all([
      preprocessCatalogVisual(mainBytes),
      preprocessCatalogVisual(galleryBytes),
    ]);
    const fullView = (preprocessed) => preprocessed.views.find((view) => view.role === "full").sha256;
    const runLockSha = "d".repeat(64);
    const imageBindings = input.images.assets.map((row, index) => ({
      listing_key: LISTING_KEY,
      item_id: input.listing.item_id,
      slot: row.slot,
      asset_sha256: row.sha256,
      model_view_sha256: fullView(index === 0 ? mainPreprocessed : galleryPreprocessed),
      image_id: input.images.evidence[index].observation.image_id,
    }));
    const result = {
      schema_version: BLIND_OBSERVATION_SCHEMA,
      observations: input.images.evidence.map((row) => structuredClone(row.observation)),
    };
    const workerContract = {
      worker_build: `sha256:${"c".repeat(64)}`,
      model: "sonnet",
      reasoning_effort: null,
      cli_version: "2.1.202",
      node_version: "v22.1.0",
      runtime_platform: "darwin",
      runtime_arch: "arm64",
      vision_timeout_ms: 180_000,
      reservation_ledger: workerReservationLedgerContract(),
    };
    const permitCore = {
      schema_version: WALMART_LISTING_EXECUTION_PERMIT_SCHEMA,
      run_lock_sha256: runLockSha,
      run_id: "source-aware-fixture",
      partition_id: "partition-000000",
      partition_index: 0,
      shard_ids: ["shard-000001"],
      preflight_certificate_sha256: "f".repeat(64),
      created_at: "2026-07-18T19:00:00.000Z",
      expires_at: "2026-07-19T19:00:00.000Z",
      owner_authorization: { fixture: "source-aware-owner-authorization" },
      authorization_binding: { fixture: "source-aware-authorization-binding" },
      allowance_reservation: { fixture: "source-aware-allowance-reservation" },
    };
    const permitBody = {
      ...permitCore,
      permit_id: `permit-000000-${walmartListingObservationSha256(permitCore).slice(0, 20)}`,
    };
    const executionPermit = {
      sha256: walmartListingObservationSha256(permitBody),
      body: permitBody,
    };
    const promptSha = walmartListingObservationPromptSha256(imageBindings.map((row) => row.image_id));
    const callIdentity = {
      run_lock_sha256: runLockSha,
      shard_id: "shard-000001",
      call_index: 0,
      worker_contract: workerContract,
      prompt_sha256: promptSha,
      image_bindings: imageBindings,
    };
    const callKey = walmartListingObservationCallKey(callIdentity);
    const resultSha = walmartListingObservationSha256(result);
    const observationBatch = sealWalmartListingObservationBatch({
      schema_version: WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
      observer_version: WALMART_LISTING_OBSERVER_VERSION,
      run_lock_sha256: runLockSha,
      shard_id: callIdentity.shard_id,
      call_index: callIdentity.call_index,
      call_key: callKey,
      created_at: CAPTURED_AT,
      provider: "claude_cli_subscription",
      worker_contract: workerContract,
      execution_permit: executionPermit,
      worker_receipt: signedWorkerReceipt({
        runLockSha,
        shardId: callIdentity.shard_id,
        callIndex: callIdentity.call_index,
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
      local_ocr: imageBindings.map((binding, index) => {
        const preprocessed = index === 0 ? mainPreprocessed : galleryPreprocessed;
        const full = preprocessed.views.find((view) => view.role === "full");
        const ocrOutput = {
          schema_version: WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
          engine: LOCAL_VISUAL_OCR_ENGINE,
          views: [{
            view_role: "full",
            view_sha256: full.sha256,
            width: full.width,
            height: full.height,
            observations: [],
          }],
        };
        return {
          image_id: binding.image_id,
          asset_sha256: binding.asset_sha256,
          full_view_sha256: binding.model_view_sha256,
          preprocessor_version: VISUAL_PREPROCESS_VERSION,
          ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
          ocr_script_sha256: "e".repeat(64),
          ocr_output_sha256: walmartListingObservationSha256(ocrOutput),
          ocr_output: ocrOutput,
          truncated: false,
          auxiliary_ocr: { ocr_texts: [] },
        };
      }),
    });
    const sources = {
      product_truth_snapshot: truth,
      buyer_snapshot_index: buyers,
      catalog_truth_export: catalogExport,
      buyer_snapshot_manifest: buyerSnapshot,
      ...rawSources,
      surface_snapshot: surfaceSnapshot,
      asset_bytes: new Map([
        ["main", new Uint8Array(mainBytes)],
        ["gallery-1", new Uint8Array(galleryBytes)],
      ]),
      run_lock_sha256: runLockSha,
      code_bundle_id: `sha256:${"9".repeat(64)}`,
      code_bundle_manifest_sha256: "8".repeat(64),
      worker_receipt_key_id: "fixture-worker-key",
      worker_receipt_public_key_sha256: WORKER_PUBLIC_SHA,
      observation_batches: [observationBatch],
    };
    return { input, sources };
  })();
  const fixture = await sourceFixturePromise;
  return structuredClone(fixture);
}

test("input-only compilation recomputes green component decisions but can never issue PASS", () => {
  const { report } = compile();
  assert.equal(report.text_decision.verdict, "PASS");
  assert.equal(report.main_decision.verdict, "PASS");
  assert.deepEqual(report.gallery_decisions.map((row) => row.verdict), ["PASS"]);
  assert.equal(report.overall_verdict, "REVIEW");
  assert.match(report.review_reasons.join(" "), /source artifacts.*not independently verified/);
  assert.deepEqual(report.assurance, {
    compilation_mode: "input_only",
    source_artifacts_verified: false,
    surface_snapshot_verified: false,
    asset_bytes_verified: false,
    observation_artifacts_verified: false,
    caller_verdicts_accepted: false,
    image_decisions_recomputed: true,
    unknown_promoted_to_pass: false,
    network_calls: 0,
    model_calls: 0,
    marketplace_writes: 0,
    database_writes: 0,
  });
});

test("title and body outer-quantity contradictions are independently BAD", () => {
  const title = compile((input) => {
    input.expected.title = "Acme Golden Sandwich Bread, 20 oz, 12 Count (Pack of 3)";
    input.surface.title = input.expected.title;
  }).report;
  assert.equal(title.text_decision.checks.title_outer_units, "MISMATCH");
  assert.equal(title.overall_verdict, "BAD");

  const body = compile((input) => {
    input.surface.description = "Acme Golden Sandwich Bread. Each package has net weight 20 oz and contains 12 slices. Pack of 3.";
  }).report;
  assert.equal(body.text_decision.checks.body_outer_units, "MISMATCH");
  assert.equal(body.overall_verdict, "BAD");
});

test("inner item language is not misclassified as an outer-pack claim", () => {
  const { report } = compile((input) => {
    input.surface.description = "Acme Golden Sandwich Bread. Each package has net weight 20 oz and contains 12 units. Pack of 2.";
  });
  assert.equal(report.text_decision.checks.body_outer_units, "MATCH");
  assert.equal(report.text_decision.checks.body_package_facts, "MATCH");
  assert.equal(report.text_decision.verdict, "PASS");
});

test("typed attributes fail closed on outer quantity, package fact, identity, and unmapped coverage", () => {
  const outer = compile((input) => {
    input.surface.attribute_claims.find((row) => row.kind === "outer_units").value = 3;
  }).report;
  assert.equal(outer.text_decision.checks.attributes_outer_units, "MISMATCH");
  assert.equal(outer.overall_verdict, "BAD");

  const size = compile((input) => {
    input.surface.attribute_claims.find((row) => row.kind === "net_content").value = 24;
  }).report;
  assert.equal(size.text_decision.checks.attributes_package_facts, "MISMATCH");
  assert.equal(size.overall_verdict, "BAD");

  const identity = compile((input) => {
    input.surface.attribute_claims.find((row) => row.kind === "variant").text = "Rye";
  }).report;
  assert.equal(identity.text_decision.checks.attributes_identity, "MISMATCH");
  assert.equal(identity.overall_verdict, "BAD");

  const unmapped = compile((input) => {
    input.surface.unmapped_attributes.push({ field_path: "legacyPackSize", value_sha256: "f".repeat(64) });
  }).report;
  assert.equal(unmapped.text_decision.verdict, "REVIEW");
  assert.match(unmapped.text_decision.review_reasons.join(" "), /not covered by the deterministic mapper/);
});

test("brand-only Product Truth, observer flags, OCR pack conflicts, and gallery count drift cannot PASS", () => {
  const brandOnly = compile((input) => {
    input.expected.identity.product_marker_groups = [];
    input.expected.identity.variant_marker_groups = [];
  }).report;
  assert.equal(brandOnly.text_decision.verdict, "REVIEW");
  assert.match(brandOnly.review_reasons.join(" "), /brand-only identity cannot PASS/);

  const warnings = compile((input) => {
    input.images.evidence[0].observation.flags = ["label partially occluded"];
    input.images.evidence[0].auxiliary_ocr.ocr_texts = [{
      text: "PACK OF 12",
      confidence: 1,
      view_role: "full",
      view_sha256: "1".repeat(64),
      bounding_box: { x: 0.1, y: 0.1, width: 0.4, height: 0.1 },
    }];
    input.images.evidence[1].observation.external_package_count = {
      mode: "exact", value: 9, min: null, max: null,
    };
  }).report;
  assert.match(warnings.review_reasons.join(" "), /observer flags require review/);
  assert.match(warnings.review_reasons.join(" "), /local OCR contains an unresolved or contradictory/);
  assert.match(warnings.review_reasons.join(" "), /visible package count differs/);
});

test("MAIN external count and explicit outer/case claims cannot disagree with Product Truth", () => {
  const external = compile((input) => {
    input.images.evidence[0].observation.external_package_count.value = 3;
  }).report;
  assert.equal(external.main_decision.verdict, "BAD");
  assert.equal(external.overall_verdict, "BAD");

  const outer = compile((input) => {
    input.images.evidence[0].observation.outer_package_claims = ["Pack of 3"];
  }).report;
  assert.equal(outer.main_decision.verdict, "PASS");
  assert.match(outer.blocking_reasons.join(" "), /MAIN outer-package text contradicts 2/);
  assert.equal(outer.overall_verdict, "BAD");

  const caseClaim = compile((input) => {
    input.images.evidence[0].observation.case_package_claims = ["Case of 3 packages"];
  }).report;
  assert.match(caseClaim.blocking_reasons.join(" "), /MAIN case-package text contradicts 2/);
  assert.equal(caseClaim.overall_verdict, "BAD");
});

test("unparsed and unclear MAIN quantity claims remain REVIEW and never PASS", () => {
  const unparsed = compile((input) => {
    input.images.evidence[0].observation.outer_package_claims = ["Family bundle" ];
  }).report;
  assert.equal(unparsed.overall_verdict, "REVIEW");
  assert.match(unparsed.review_reasons.join(" "), /unparsed outer-package claim/);

  const unclear = compile((input) => {
    input.images.evidence[0].observation.unclear_quantity_claims = ["2 x 12 unclear whether units or cases"];
  }).report;
  assert.equal(unclear.overall_verdict, "REVIEW");
  assert.match(unclear.review_reasons.join(" "), /unresolved quantity claims/);

  const matchingCase = compile((input) => {
    input.images.evidence[0].observation.case_package_claims = ["Case of 2 packages"];
  }).report;
  assert.equal(matchingCase.overall_verdict, "REVIEW");
  assert.match(matchingCase.review_reasons.join(" "), /case-package claim requiring human confirmation/);
});

test("gallery foreign identity and explicit quantity/package contradictions are BAD", () => {
  const foreign = compile((input) => {
    input.images.evidence[1].observation.visible_variant_text = "Rye";
  }).report;
  assert.equal(foreign.gallery_decisions[0].verdict, "BAD");
  assert.equal(foreign.overall_verdict, "BAD");

  const quantity = compile((input) => {
    input.images.evidence[1].observation.outer_package_claims = ["Pack of 4"];
  }).report;
  assert.equal(quantity.gallery_decisions[0].verdict, "PASS");
  assert.match(quantity.blocking_reasons.join(" "), /gallery-1 outer-package text contradicts 2/);
  assert.equal(quantity.overall_verdict, "BAD");

  const packageFact = compile((input) => {
    input.images.evidence[1].observation.visible_size_texts = ["NET WT 24 OZ"];
  }).report;
  assert.equal(packageFact.gallery_decisions[0].verdict, "BAD");
  assert.equal(packageFact.overall_verdict, "BAD");
});

test("missing gallery is BAD while a technical error remains REVIEW with separate accounting", () => {
  const missing = compile((input) => {
    input.images.evidence[1] = {
      slot: "gallery-1", asset_sha256: GALLERY_SHA, state: "missing", reason: "PDP slot returned no bytes",
    };
  }).report;
  assert.equal(missing.gallery_decisions[0].verdict, "MISSING");
  assert.equal(missing.duplicate_summary.missing_assets, 1);
  assert.equal(missing.overall_verdict, "BAD");

  const technical = compile((input) => {
    input.images.evidence[1] = {
      slot: "gallery-1", asset_sha256: GALLERY_SHA, state: "technical_error", error: "decoder timeout",
    };
  }).report;
  assert.equal(technical.gallery_decisions[0].verdict, "TECH_ERROR");
  assert.equal(technical.duplicate_summary.technical_errors, 1);
  assert.equal(technical.overall_verdict, "REVIEW");
});

test("exact and near gallery duplicates are recomputed from bound asset fingerprints", () => {
  const { report } = compile((input) => {
    const shaC = "c".repeat(64);
    input.images.assets = [
      input.images.assets[0],
      asset("gallery-1", GALLERY_SHA, "0000000000000000"),
      asset("gallery-2", GALLERY_SHA, "0000000000000000"),
      asset("gallery-3", shaC, "0000000000000001"),
    ];
    input.images.evidence = [
      input.images.evidence[0],
      observedEvidence("gallery-1", GALLERY_SHA, galleryObservation("gallery-1", GALLERY_SHA)),
      observedEvidence("gallery-2", GALLERY_SHA, galleryObservation("gallery-2", GALLERY_SHA)),
      observedEvidence("gallery-3", shaC, galleryObservation("gallery-3", shaC)),
    ];
  });
  assert.equal(report.duplicate_summary.exact_duplicate_groups, 1);
  assert.equal(report.duplicate_summary.near_duplicate_pairs, 2);
  assert.match(report.review_reasons.join(" "), /exact duplicate groups/);
  assert.match(report.review_reasons.join(" "), /near-duplicate pairs/);
  assert.equal(report.overall_verdict, "REVIEW");
});

test("caller-supplied duplicate verdict is rejected instead of trusted", () => {
  const input = validInput();
  input.images.duplicate_summary = {
    source_binding_sha256: "f".repeat(64),
    dhash_distance_threshold: 5,
    exact_duplicate_groups: 0,
    near_duplicate_pairs: 0,
    missing_assets: 0,
    technical_errors: 0,
  };
  assert.throws(() => compileWalmartListingIntegrityReport(input), /duplicate_summary must be null/);
});

test("mixed bundles and variety packs are explicitly UNSUPPORTED by the same-product engine", () => {
  for (const composition of ["mixed_bundle", "variety_pack"]) {
    const { report } = compile((input) => { input.listing.composition = composition; });
    assert.equal(report.overall_verdict, "UNSUPPORTED", composition);
    assert.notEqual(report.overall_verdict, "PASS", composition);
  }
});

test("asset/evidence slot and SHA swaps fail before any image decision", () => {
  const wrongSha = validInput();
  wrongSha.images.evidence[1].asset_sha256 = MAIN_SHA;
  assert.throws(() => compileWalmartListingIntegrityReport(wrongSha), /asset_sha256 mismatch/);

  const swappedSlot = validInput();
  swappedSlot.images.evidence[1].slot = "main";
  assert.throws(
    () => compileWalmartListingIntegrityReport(swappedSlot),
    /asset_sha256 mismatch|every supplied image_id|duplicate slots/,
  );
});

test("sealed report verification rejects field tamper even after attacker recomputes a body hash", () => {
  const input = validInput();
  const report = compileWalmartListingIntegrityReport(input);
  assert.deepEqual(verifyWalmartListingIntegrityReportAgainstInput(report, input), report);

  const tampered = structuredClone(report);
  tampered.overall_verdict = "PASS";
  const body = structuredClone(tampered);
  delete body.report_id;
  delete body.body_sha256;
  tampered.body_sha256 = walmartListingIntegritySha256(body);
  tampered.report_id = `walmart-integrity-1-${tampered.body_sha256.slice(0, 16)}`;
  assert.throws(
    () => verifyWalmartListingIntegrityReportAgainstInput(tampered, input),
    /does not exactly rebuild/,
  );
});

test("surface snapshot seal is deterministic, payload-sensitive, and validates exact listing scope", () => {
  const body = {
    schema_version: WALMART_LISTING_SURFACE_SNAPSHOT_SCHEMA,
    captured_at: CAPTURED_AT,
    listing: {
      channel: "WALMART_US",
      store_index: 1,
      sku: "ACME-BREAD-2",
      listing_key: "walmart:1:ACME-BREAD-2",
      item_id: "123456789",
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
    },
    buyer_source: {
      contract: "walmart_buyer_pdp_exact_item_get",
      buyer_snapshot_id: "buyer-snapshot-fixture",
      buyer_snapshot_body_sha256: "7".repeat(64),
      buyer_payload_sha256: "8".repeat(64),
      exact_item_id_echo: true,
      complete_attribute_inventory: true,
    },
    surface: surface(),
  };
  const first = sealWalmartListingSurfaceSnapshot(body);
  const second = sealWalmartListingSurfaceSnapshot(structuredClone(body));
  assert.deepEqual(second, first);
  assert.equal(first.body_sha256, walmartListingIntegritySha256(body));
  assert.equal(first.snapshot_id, `walmart-surface-1-${first.body_sha256.slice(0, 16)}`);

  const changed = structuredClone(body);
  changed.surface.description += " Buyer-visible update.";
  assert.notEqual(sealWalmartListingSurfaceSnapshot(changed).body_sha256, first.body_sha256);

  const wrongScope = structuredClone(body);
  wrongScope.listing.listing_key = "walmart:2:ACME-BREAD-2";
  assert.throws(() => sealWalmartListingSurfaceSnapshot(wrongScope), /listing binding is invalid/);
});

test("raw buyer PDP projection preserves known text and hashes every unknown surface field", () => {
  const payload = {
    product: {
      item_id: "123456789",
      title: "Acme Golden Bread, Pack of 2",
      main_image: "https://i5.walmartimages.com/main.png",
      images: ["https://i5.walmartimages.com/main.png"],
      description: "<p>Acme &amp; Golden</p><p>Pack of 2</p>",
      feature_bullets: ["Two retail packages"],
      specifications: [
        { name: "Brand", value: "Acme" },
        { name: "Multipack Quantity", value: "2" },
        { name: "Uncalibrated Label", value: "opaque" },
      ],
      provider_score: 0.98,
    },
  };
  const projected = projectWalmartListingSurfaceFromBuyerPdp(payload, {
    sku: "ACME-BREAD-2",
    item_id: "123456789",
  });
  assert.equal(projected.description, "Acme & Golden Pack of 2");
  assert.deepEqual(projected.bullets, ["Two retail packages"]);
  assert.deepEqual(projected.attribute_claims, [
    { field_path: "product.specifications[0].Brand", kind: "brand", text: "Acme" },
    {
      field_path: "product.specifications[1].Multipack Quantity",
      kind: "outer_units",
      value: 2,
      unit: "count",
    },
  ]);
  assert.deepEqual(projected.unmapped_attributes, [
    {
      field_path: "product.provider_score",
      value_sha256: walmartListingIntegritySha256(0.98),
    },
    {
      field_path: "product.specifications[2].Uncalibrated Label",
      value_sha256: walmartListingIntegritySha256("opaque"),
    },
  ]);
});

test("only a full source/bytes/Claude-observation rebuild can issue PASS", async () => {
  const { input, sources } = await sourceAwareFixture();
  const inputOnly = compileWalmartListingIntegrityReport(input);
  assert.equal(inputOnly.overall_verdict, "REVIEW");

  const sourceAware = await compileWalmartListingIntegrityReportAgainstSources(input, sources);
  assert.equal(sourceAware.overall_verdict, "PASS");
  assert.equal(sourceAware.assurance.compilation_mode, "source_aware");
  assert.equal(sourceAware.assurance.source_artifacts_verified, true);
  assert.equal(sourceAware.assurance.surface_snapshot_verified, true);
  assert.equal(sourceAware.assurance.asset_bytes_verified, true);
  assert.equal(sourceAware.assurance.observation_artifacts_verified, true);
  assert.equal(sourceAware.provenance.run_lock_sha256, sources.run_lock_sha256);
  assert.equal(sourceAware.provenance.worker_receipt_public_key_sha256, WORKER_PUBLIC_SHA);
  assert.equal(sourceAware.provenance.observation_artifacts.length, 1);
  assert.deepEqual(sourceAware.review_reasons, []);
  assert.deepEqual(
    await verifyWalmartListingIntegrityReportAgainstSources(sourceAware, input, sources),
    sourceAware,
  );

  const withoutObservationArtifact = await sourceAwareFixture();
  withoutObservationArtifact.sources.observation_batches = [];
  await assert.rejects(
    () => compileWalmartListingIntegrityReportAgainstSources(
      withoutObservationArtifact.input,
      withoutObservationArtifact.sources,
    ),
    /source-verified observation artifact is missing/,
  );
});

test("sealed ambiguous terminal can only produce source-verified TECH_ERROR/REVIEW", async () => {
  const { input, sources } = await sourceAwareFixture();
  const batch = sources.observation_batches[0];
  const terminal = sealWalmartListingObservationTechnicalErrorTerminal({
    schema_version: WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA,
    observer_version: WALMART_LISTING_OBSERVER_VERSION,
    run_lock_sha256: batch.run_lock_sha256,
    shard_id: batch.shard_id,
    call_index: batch.call_index,
    call_key: batch.call_key,
    reserved_at: batch.created_at,
    terminalized_at: "2026-07-18T20:05:00.000Z",
    terminal_state: "BLOCKED_AMBIGUOUS",
    audit_outcome: "TECH_ERROR",
    reason_code: "attempt_reserved_without_verifiable_worker_result",
    attempt_body_sha256: "6".repeat(64),
    execution_permit: batch.execution_permit,
    worker_contract: batch.worker_contract,
    prompt: batch.prompt,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    image_bindings: batch.image_bindings,
    image_outcomes: batch.image_bindings.map((binding) => ({
      image_id: binding.image_id,
      outcome: "TECH_ERROR",
      required_action: "REVIEW",
    })),
    execution: {
      subscription_calls_consumed: "unknown_0_or_1",
      transport_attempts_maximum: 1,
      retries: 0,
      fallbacks: 0,
      paid_api_calls: 0,
      openai_model_calls: 0,
      worker_result_present: false,
      worker_receipt_present: false,
      pass_eligible: false,
    },
  });
  const error = `immutable terminal ${terminal.artifact_id}/${terminal.body_sha256}; ambiguous attempt ${terminal.attempt_body_sha256}; model result unavailable and retry forbidden`;
  input.images.evidence = input.images.evidence.map((row) => ({
    slot: row.slot,
    asset_sha256: row.asset_sha256,
    state: "technical_error",
    error,
  }));
  sources.observation_batches = [];
  sources.observation_terminal_artifacts = [terminal];
  const report = await compileWalmartListingIntegrityReportAgainstSources(input, sources);
  assert.equal(report.overall_verdict, "REVIEW");
  assert.equal(report.assurance.observation_artifacts_verified, false);
  assert.notEqual(report.main_decision.verdict, "PASS");
  assert.notEqual(report.gallery_decisions[0].verdict, "PASS");
  assert.match(report.review_reasons.join(" "), /model result unavailable|TECH_ERROR|technical/i);

  input.images.evidence[0].error = "caller-authored technical error";
  await assert.rejects(
    () => compileWalmartListingIntegrityReportAgainstSources(input, sources),
    /TECH_ERROR differs from its sealed terminal artifact/,
  );
});

test("source-aware verdict is destroyed by frozen-byte, surface, binding, or report tamper", async () => {
  const pristine = await sourceAwareFixture();
  const report = await compileWalmartListingIntegrityReportAgainstSources(pristine.input, pristine.sources);

  const bytesTamper = await sourceAwareFixture();
  bytesTamper.sources.asset_bytes.get("gallery-1")[0] ^= 0xff;
  await assert.rejects(
    () => compileWalmartListingIntegrityReportAgainstSources(bytesTamper.input, bytesTamper.sources),
    /SHA\/dimensions\/dHash do not rebuild|image decode failed|unsupported image format/,
  );

  const surfaceTamper = await sourceAwareFixture();
  surfaceTamper.input.surface.description += " Unsealed change.";
  await assert.rejects(
    () => compileWalmartListingIntegrityReportAgainstSources(surfaceTamper.input, surfaceTamper.sources),
    /surface snapshot does not exactly bind/,
  );

  const resealedSurfaceForgery = await sourceAwareFixture();
  const forgedSurfaceBody = structuredClone(resealedSurfaceForgery.sources.surface_snapshot);
  delete forgedSurfaceBody.snapshot_id;
  delete forgedSurfaceBody.body_sha256;
  forgedSurfaceBody.surface.description += " Caller-authored but resealed text.";
  const forgedSurfaceSnapshot = sealWalmartListingSurfaceSnapshot(forgedSurfaceBody);
  resealedSurfaceForgery.sources.surface_snapshot = forgedSurfaceSnapshot;
  resealedSurfaceForgery.input.surface = structuredClone(forgedSurfaceSnapshot.surface);
  resealedSurfaceForgery.input.source_bindings.surface_snapshot_id = forgedSurfaceSnapshot.snapshot_id;
  resealedSurfaceForgery.input.source_bindings.surface_snapshot_body_sha256 =
    forgedSurfaceSnapshot.body_sha256;
  await assert.rejects(
    () => compileWalmartListingIntegrityReportAgainstSources(
      resealedSurfaceForgery.input,
      resealedSurfaceForgery.sources,
    ),
    /surface snapshot does not exactly bind/,
  );

  const rawBuyerTamper = await sourceAwareFixture();
  rawBuyerTamper.sources.buyer_pdp_payload.product.title = "A different bread";
  await assert.rejects(
    () => compileWalmartListingIntegrityReportAgainstSources(
      rawBuyerTamper.input,
      rawBuyerTamper.sources,
    ),
    /raw seller\/catalog\/buyer payload hashes differ|identity chain does not rebuild/,
  );

  const rawSellerTamper = await sourceAwareFixture();
  rawSellerTamper.sources.seller_item_payload.ItemResponse[0].upc = "999999999999";
  await assert.rejects(
    () => compileWalmartListingIntegrityReportAgainstSources(
      rawSellerTamper.input,
      rawSellerTamper.sources,
    ),
    /raw seller\/catalog\/buyer payload rebuild failed/,
  );

  const bindingTamper = await sourceAwareFixture();
  bindingTamper.input.source_bindings.truth_approval_sha256 = "f".repeat(64);
  await assert.rejects(
    () => compileWalmartListingIntegrityReportAgainstSources(bindingTamper.input, bindingTamper.sources),
    /source_bindings differ/,
  );

  const reportTamper = structuredClone(report);
  reportTamper.overall_verdict = "REVIEW";
  await assert.rejects(
    () => verifyWalmartListingIntegrityReportAgainstSources(
      reportTamper,
      pristine.input,
      pristine.sources,
    ),
    /does not exactly rebuild/,
  );
});

test("source-aware verification rejects OCR dimensions not rebuilt from the exact source pixels", async () => {
  const dimensionTamper = await sourceAwareFixture();
  const body = structuredClone(dimensionTamper.sources.observation_batches[0]);
  delete body.artifact_id;
  delete body.body_sha256;
  body.local_ocr[0].ocr_output.views[0].width += 1;
  body.local_ocr[0].ocr_output_sha256 = walmartListingObservationSha256(
    body.local_ocr[0].ocr_output,
  );
  dimensionTamper.sources.observation_batches = [
    sealWalmartListingObservationBatch(body),
  ];

  await assert.rejects(
    () => compileWalmartListingIntegrityReportAgainstSources(
      dimensionTamper.input,
      dimensionTamper.sources,
    ),
    /local OCR output does not bind exact rebuilt views/,
  );
});
