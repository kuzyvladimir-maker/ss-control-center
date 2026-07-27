import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

import {
  BLIND_PROMPT_VERSION,
  BLIND_OBSERVATION_SCHEMA,
} from "../../src/lib/walmart/catalog-visual-audit.ts";
import {
  VISUAL_PREPROCESS_VERSION,
  preprocessCatalogVisual,
} from "../../src/lib/walmart/catalog-visual-preprocess.ts";
import {
  WALMART_LISTING_INTEGRITY_ENGINE_VERSION,
  WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
  WALMART_LISTING_INTEGRITY_REPORT_SCHEMA,
} from "../../src/lib/walmart/listing-integrity-audit.ts";
import { LOCAL_VISUAL_OCR_ENGINE } from "../../src/lib/walmart/local-visual-ocr.ts";
import {
  WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
  WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA,
  WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
  WALMART_LISTING_OBSERVER_VERSION,
  WALMART_LISTING_WORKER_RECEIPT_SCHEMA,
  WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA,
  WALMART_LISTING_WORKER_REQUEST_SCHEMA,
  canonicalWalmartListingObservationJson,
  sealWalmartListingObservationBatch,
  sealWalmartListingObservationTechnicalErrorTerminal,
  walmartListingObservationCallKey,
  walmartListingObservationImageId,
  walmartListingObservationPromptSha256,
  walmartListingObservationSha256,
} from "../../src/lib/walmart/listing-integrity-observation.ts";
import {
  WALMART_LISTING_INTEGRITY_BASE_INPUT_MODE,
  WALMART_LISTING_INTEGRITY_EXECUTOR_VERSION,
  WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
  WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_SCHEMA,
  WALMART_LISTING_INTEGRITY_RUN_LOCK_SCHEMA,
  assertExecutionPermitWindow,
  assembleWalmartListingIntegrityOwnerExecutionAuthorization,
  buildWalmartListingIntegrityAllowanceReservation,
  buildWalmartListingIntegrityExecutionPermitBody,
  buildWalmartListingIntegrityOwnerExecutionAuthorizationBody,
  buildWalmartListingIntegritySourceFreshness,
  buildCurrentCodeBundleManifest,
  loadPinnedObserverPartitionContext,
  parseCliArgs,
  parseRunLock,
  parseWalmartListingIntegrityExecutionPermit,
  reportFilename,
  runAudit,
  runPlan,
  runVerify,
  sha256Bytes,
  walmartListingIntegrityAllowanceReservationRelativePath,
  walmartListingIntegrityObserverPartitionId,
  walmartListingIntegrityOwnerAuthorizationSigningMessage,
} from "../walmart-listing-integrity-engine.mjs";

const SHA_A = "a".repeat(64);
const WORKER_KEYS = generateKeyPairSync("ed25519");
const WORKER_PUBLIC_DER = WORKER_KEYS.publicKey.export({ format: "der", type: "spki" });
const WORKER_PUBLIC_SHA = createHash("sha256").update(WORKER_PUBLIC_DER).digest("hex");
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
  imageBindings, executionPermit, reservationReservedAt, issuedAt,
}) {
  const body = {
    issued_at: issuedAt,
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
    reservation_reserved_at: reservationReservedAt,
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

function signedOwnerAuthorization({
  runLock,
  runLockSha,
  preflightSha,
  issuedAt,
  partitionIds = runLock.observer_partitions.map((row) => row.partition_id),
}) {
  const signedBody = buildWalmartListingIntegrityOwnerExecutionAuthorizationBody({
    run_lock: runLock,
    run_lock_sha256: runLockSha,
    preflight_certificate_sha256: preflightSha,
    approval_id: "owner-approval-fixture-001",
    partition_ids: partitionIds,
    issued_at: issuedAt,
    expires_at: runLock.hard_source_freshness.hard_deadline,
    source_freshness_deadline: runLock.hard_source_freshness.hard_deadline,
  });
  const authority = ownerExecutionAuthority();
  const envelope = {
    schema_version: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_SCHEMA,
    algorithm: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
    key_id: authority.key_id,
    owner_public_key_spki_sha256: authority.public_key_spki_sha256,
    signed_body: signedBody,
  };
  const signature = sign(
    null,
    walmartListingIntegrityOwnerAuthorizationSigningMessage(envelope),
    OWNER_KEYS.privateKey,
  );
  return assembleWalmartListingIntegrityOwnerExecutionAuthorization({
    owner_execution_authority: authority,
    signed_body: signedBody,
    signature_base64: signature.toString("base64"),
    expected: {
      run_lock: runLock,
      run_lock_sha256: runLockSha,
      run_id: runLock.run_id,
      preflight_certificate_sha256: preflightSha,
      now: new Date(issuedAt),
    },
  });
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
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

async function writeJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(file, bytes);
  return { path: file, sha256: sha(bytes) };
}

function relativeRef(root, written) {
  return {
    path: path.relative(root, written.path).split(path.sep).join("/"),
    sha256: written.sha256,
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

function observerExecutionConstraints(shardCount = 1) {
  return {
    network_target: "locked_worker_only",
    worker_health_calls_per_execute: 1,
    subscription_calls_total: shardCount,
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

async function fixture(t, { writeObservation = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wm-integrity-cli-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  for (const directory of ["sources", "listing", "assets", "views", "observations"]) {
    await mkdir(path.join(root, directory));
  }

  const listingKey = "walmart:1:SKU-001";
  const itemId = "123456789";
  const createdAt = new Date(Date.now() - 60_000);
  const capturedAt = createdAt.toISOString();
  const buyerBytes = await sharp({
    create: { width: 18, height: 12, channels: 3, background: "#b7793c" },
  }).png().toBuffer();
  const preprocessed = await preprocessCatalogVisual(buyerBytes);
  const modelView = preprocessed.views.find((view) => view.role === "full");
  const modelViewBytes = modelView.bytes;
  const buyerSha = sha(buyerBytes);
  const modelViewSha = sha(modelViewBytes);
  const imageId = walmartListingObservationImageId(buyerSha, "main", listingKey);
  const buyerAssetPath = path.join(root, "assets/main.bin");
  const modelViewPath = path.join(root, "views/main.bin");
  await writeFile(buyerAssetPath, buyerBytes);
  await writeFile(modelViewPath, modelViewBytes);

  const productTruth = await writeJson(
    path.join(root, "sources/product-truth.json"),
    { source: "truth", captured_at: capturedAt },
  );
  const buyerIndex = await writeJson(
    path.join(root, "sources/buyer-index.json"),
    { source: "buyer-index", captured_at: capturedAt },
  );
  const catalogTruth = await writeJson(path.join(root, "sources/catalog-truth.json"), { source: "catalog-export" });
  const authoritativeScope = await writeJson(
    path.join(root, "sources/authoritative-scope.json"),
    { source: "authoritative-published-scope", captured_at: capturedAt },
  );
  const authoritativeItemReport = await writeJson(
    path.join(root, "sources/authoritative-item-report.json"),
    { source: "authoritative-item-report" },
  );
  const captureDummy = await writeJson(
    path.join(root, "sources/authoritative-capture-dummy.json"),
    {},
  );
  const codeBundleManifest = await writeJson(
    path.join(root, "sources/code-bundle-manifest.json"),
    await buildCurrentCodeBundleManifest(),
  );
  const surface = await writeJson(path.join(root, "listing/surface.json"), { source: "surface" });
  const buyerManifest = await writeJson(
    path.join(root, "listing/buyer.json"),
    { source: "buyer-manifest", captured_at: capturedAt },
  );
  const sellerPayload = await writeJson(path.join(root, "listing/seller-payload.json"), { source: "seller" });
  const catalogPayload = await writeJson(path.join(root, "listing/catalog-payload.json"), { source: "catalog" });
  const buyerPayload = await writeJson(path.join(root, "listing/buyer-payload.json"), { source: "buyer" });

  const baseInputValue = {
    schema_version: WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
    listing: { listing_key: listingKey, item_id: itemId },
    source_bindings: {},
    expected: {},
    surface: {},
    images: {
      assets: [{ slot: "main", sha256: buyerSha }],
      evidence: [],
      duplicate_summary: null,
    },
  };
  const baseInput = await writeJson(path.join(root, "listing/base-input.json"), baseInputValue);
  const observationPath = path.join(root, "observations/call-000000.json");
  const attemptPath = `${observationPath}.attempt.json`;
  let observationValue = null;
  let attemptValue = null;

  const runLock = {
    schema_version: WALMART_LISTING_INTEGRITY_RUN_LOCK_SCHEMA,
    run_id: "run-fixture-001",
    created_at: createdAt.toISOString(),
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
      local_ocr_script_sha256: "e".repeat(64),
      worker_build_sha256: SHA_A,
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
      authoritative_scope_captured_at: createdAt.toISOString(),
      product_truth_snapshot_captured_at: createdAt.toISOString(),
      buyer_index_captured_at: createdAt.toISOString(),
      locked_buyer_snapshot_captured_ats: [createdAt.toISOString()],
    }),
    code_bundle_manifest: relativeRef(root, codeBundleManifest),
    source_artifacts: {
      authoritative_published_scope: relativeRef(root, authoritativeScope),
      authoritative_item_report_source: relativeRef(root, authoritativeItemReport),
      authoritative_item_report_capture: {
        create_request_manifest: relativeRef(root, captureDummy),
        create_response_payload: relativeRef(root, captureDummy),
        ready_status_request_manifest: relativeRef(root, captureDummy),
        ready_status_payload: relativeRef(root, captureDummy),
        download_locator_request_manifest: relativeRef(root, captureDummy),
        download_locator_response_payload: relativeRef(root, captureDummy),
        report_file_request_manifest: relativeRef(root, captureDummy),
        downloaded_body: relativeRef(root, captureDummy),
        http_create_response: relativeRef(root, captureDummy),
        http_ready_status_response: relativeRef(root, captureDummy),
        http_download_locator_response: relativeRef(root, captureDummy),
        http_download_response: relativeRef(root, captureDummy),
        trusted_context: relativeRef(root, captureDummy),
      },
      product_truth_snapshot: relativeRef(root, productTruth),
      buyer_snapshot_index: relativeRef(root, buyerIndex),
      catalog_truth_export: relativeRef(root, catalogTruth),
    },
    shards: [{
      shard_id: "shard-000000",
      call_index: 0,
      observation_batch_path: "observations/call-000000.json",
      prompt_sha256: walmartListingObservationPromptSha256([imageId]),
      images: [{
        listing_key: listingKey,
        item_id: itemId,
        slot: "main",
        asset_sha256: buyerSha,
        model_view_sha256: modelViewSha,
        image_id: imageId,
      }],
    }],
    listings: [{
      listing_key: listingKey,
      item_id: itemId,
      base_input: relativeRef(root, baseInput),
      surface_snapshot: relativeRef(root, surface),
      buyer_snapshot_manifest: relativeRef(root, buyerManifest),
      seller_item_payload: relativeRef(root, sellerPayload),
      catalog_search_payload: relativeRef(root, catalogPayload),
      buyer_pdp_payload: relativeRef(root, buyerPayload),
      assets: [{
        slot: "main",
        buyer_asset: { path: "assets/main.bin", sha256: buyerSha },
        model_view: { path: "views/main.bin", sha256: modelViewSha },
        image_id: imageId,
      }],
      shard_ids: ["shard-000000"],
    }],
    observer_partitions: [{
      partition_id: walmartListingIntegrityObserverPartitionId(0, ["shard-000000"]),
      partition_index: 0,
      shard_ids: ["shard-000000"],
    }],
    adjudicator_constraints: adjudicatorConstraints(),
    observer_execution_constraints: observerExecutionConstraints(1),
  };
  const lockPath = path.join(root, "run-lock.json");

  async function rewriteRunLock(mutator = () => {}) {
    mutator(runLock);
    const written = await writeJson(lockPath, runLock);
    return written.sha256;
  }

  const runLockSha = await rewriteRunLock();
  const certificateStdout = stdoutCapture();
  await runPlan({
    command: "plan",
    run_lock: lockPath,
    expect_run_lock_sha256: runLockSha,
  }, {
    stdout: certificateStdout,
    ...populationInjection(),
    async preflight_against_sources() {
      return {
        overall_verdict: "REVIEW",
        assurance: {
          source_artifacts_verified: true,
          surface_snapshot_verified: true,
          asset_bytes_verified: true,
          observation_artifacts_verified: false,
        },
      };
    },
  });
  const generatedPlan = JSON.parse(certificateStdout.text);
  const preflightCertificate = await writeJson(
    path.join(root, "preflight-certificate.json"),
    generatedPlan.preflight_certificate,
  );
  await chmod(preflightCertificate.path, 0o444);
  const permitCreatedAt = new Date(createdAt.getTime() + 30_000).toISOString();
  const ownerAuthorization = signedOwnerAuthorization({
    runLock,
    runLockSha,
    preflightSha: preflightCertificate.sha256,
    issuedAt: permitCreatedAt,
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
    run_lock_sha256: runLockSha,
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
    owner_execution_authority: runLock.owner_execution_authority,
    run_lock_sha256: runLockSha,
    run_id: runLock.run_id,
    partition: runLock.observer_partitions[0],
    preflight_certificate_sha256: preflightCertificate.sha256,
    family_created_at: runLock.created_at,
  });
  const executionPermitFile = await writeJson(
    path.join(root, "execution-permit.json"),
    executionPermit,
  );
  await chmod(executionPermitFile.path, 0o444);
  if (writeObservation) {
    const imageBindings = structuredClone(runLock.shards[0].images);
    const result = {
      schema_version: BLIND_OBSERVATION_SCHEMA,
      observations: [{
        image_id: imageId,
        visual_role: "other",
        visible_brand_text: null,
        visible_product_text: null,
        visible_variant_text: null,
        visible_size_texts: [],
        external_package_count: { mode: "unknown", value: null, min: null, max: null },
        outer_package_claims: [],
        inner_contents_claims: [],
        case_package_claims: [],
        unclear_quantity_claims: [],
        grid_cell_kind: "unknown",
        front_visibility: "unknown",
        background: "unknown",
        multiple_distinct_products: "unknown",
        readable_identity: "none",
        evidence: [],
        flags: [],
      }],
    };
    const workerContract = {
      worker_build: `sha256:${SHA_A}`,
      model: "sonnet",
      reasoning_effort: null,
      cli_version: "claude-fixture",
      node_version: "v24.0.0",
      runtime_platform: "darwin",
      runtime_arch: "arm64",
      vision_timeout_ms: 180_000,
      reservation_ledger: workerReservationLedgerContract(),
    };
    const promptSha = runLock.shards[0].prompt_sha256;
    const callIdentity = {
      run_lock_sha256: runLockSha,
      shard_id: "shard-000000",
      call_index: 0,
      worker_contract: workerContract,
      prompt_sha256: promptSha,
      image_bindings: imageBindings,
    };
    const callKey = walmartListingObservationCallKey(callIdentity);
    const resultSha = walmartListingObservationSha256(result);
    const ocrOutput = {
      schema_version: WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
      engine: LOCAL_VISUAL_OCR_ENGINE,
      views: [{
        view_role: "full",
        view_sha256: modelViewSha,
        width: modelView.width,
        height: modelView.height,
        observations: [],
      }],
    };
    const localOcr = [{
      image_id: imageId,
      asset_sha256: buyerSha,
      full_view_sha256: modelViewSha,
      preprocessor_version: VISUAL_PREPROCESS_VERSION,
      ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
      ocr_script_sha256: "e".repeat(64),
      ocr_output_sha256: walmartListingObservationSha256(ocrOutput),
      ocr_output: ocrOutput,
      truncated: false,
      auxiliary_ocr: { ocr_texts: [] },
    }];
    const successfulReservationAt = new Date(
      Date.parse(permitCreatedAt) + 100,
    ).toISOString();
    const requestAttestation = {
      schema_version: WALMART_LISTING_WORKER_REQUEST_SCHEMA,
      run_lock_sha256: runLockSha,
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
      run_lock_sha256: runLockSha,
      shard_id: callIdentity.shard_id,
      call_index: 0,
      call_key: callKey,
      reserved_at: permitCreatedAt,
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
    attemptValue = {
      ...attemptBody,
      body_sha256: walmartListingObservationSha256(attemptBody),
    };
    await writeJson(attemptPath, attemptValue);
    await chmod(attemptPath, 0o444);
    observationValue = sealWalmartListingObservationBatch({
      schema_version: WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
      observer_version: WALMART_LISTING_OBSERVER_VERSION,
      run_lock_sha256: runLockSha,
      shard_id: callIdentity.shard_id,
      call_index: 0,
      call_key: callKey,
      created_at: successfulReservationAt,
      provider: "claude_cli_subscription",
      worker_contract: workerContract,
      worker_receipt: signedWorkerReceipt({
        runLockSha,
        shardId: callIdentity.shard_id,
        callIndex: 0,
        callKey,
        promptSha,
        resultSha,
        workerContract,
        imageBindings,
        executionPermit,
        reservationReservedAt: successfulReservationAt,
        issuedAt: new Date(Date.parse(permitCreatedAt) + 1_000).toISOString(),
      }),
      execution_permit: executionPermit,
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
    await writeJson(observationPath, observationValue);
    await chmod(observationPath, 0o444);
  }
  return {
    root,
    listingKey,
    itemId,
    imageId,
    runLock,
    lockPath,
    runLockSha,
    preflightCertificate,
    ownerAuthorization,
    allowanceReservation,
    allowancePath,
    executionPermit,
    executionPermitFile,
    rewriteRunLock,
    observationPath,
    observationValue,
    attemptPath,
    attemptValue,
  };
}

function planOptions(fx, expectedSha = fx.runLockSha) {
  return {
    command: "plan",
    run_lock: fx.lockPath,
    expect_run_lock_sha256: expectedSha,
  };
}

function auditOptions(fx, outputDir) {
  return {
    command: "audit",
    run_lock: fx.lockPath,
    expect_run_lock_sha256: fx.runLockSha,
    preflight_certificate: fx.preflightCertificate.path,
    expect_preflight_certificate_sha256: fx.preflightCertificate.sha256,
    output_dir: outputDir,
  };
}

function verifyOptions(fx, reportsDir) {
  return {
    command: "verify",
    run_lock: fx.lockPath,
    expect_run_lock_sha256: fx.runLockSha,
    preflight_certificate: fx.preflightCertificate.path,
    expect_preflight_certificate_sha256: fx.preflightCertificate.sha256,
    reports_dir: reportsDir,
    require_complete: true,
  };
}

function reviewReport(listingKey) {
  return {
    schema_version: WALMART_LISTING_INTEGRITY_REPORT_SCHEMA,
    report_id: `report-${sha(Buffer.from(listingKey)).slice(0, 16)}`,
    body_sha256: SHA_A,
    listing: { listing_key: listingKey },
    overall_verdict: "REVIEW",
    assurance: { observation_artifacts_verified: false },
  };
}

function populationInjection() {
  return {
    population_reconciler() {
      return {
        scope_snapshot_id: "scope-fixture",
        scope_body_sha256: SHA_A,
        scope_captured_at: "2026-07-18T12:00:00.000Z",
        authoritative_published_count: 1,
        auditable_count: 1,
        truth_review_count: 0,
        unsupported_count: 0,
        exact_population_reconciliation: true,
      };
    },
  };
}

test("CLI parser exposes help and rejects unknown, repeated, relative, or incomplete arguments", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { help: true });
  assert.deepEqual(parseCliArgs(["audit", "--help"]), { help: true });
  assert.throws(() => parseCliArgs(["wat"]), /first argument/);
  assert.throws(() => parseCliArgs([
    "plan", "--run-lock=relative.json", `--expect-run-lock-sha256=${SHA_A}`,
  ]), /must be absolute/);
  assert.throws(() => parseCliArgs([
    "plan", "--run-lock=/tmp/lock.json", `--expect-run-lock-sha256=${SHA_A}`, "--mystery=1",
  ]), /unsupported flag/);
  assert.throws(() => parseCliArgs([
    "plan", "--run-lock=/tmp/lock.json", "--run-lock=/tmp/lock.json",
    `--expect-run-lock-sha256=${SHA_A}`,
  ]), /repeated/);
  assert.throws(() => parseCliArgs([
    "verify", "--run-lock=/tmp/lock.json", `--expect-run-lock-sha256=${SHA_A}`,
    "--preflight-certificate=/tmp/preflight.json",
    `--expect-preflight-certificate-sha256=${SHA_A}`,
    "--reports-dir=/tmp/reports",
  ]), /requires --require-complete/);
});

test("strict run-lock rejects unknown keys, traversal, relaxed safety, and duplicate asset coverage", async (t) => {
  const fx = await fixture(t, { writeObservation: false });
  const unknown = structuredClone(fx.runLock);
  unknown.extra = true;
  assert.throws(() => parseRunLock(unknown), /keys must be exactly/);

  const traversal = structuredClone(fx.runLock);
  traversal.listings[0].base_input.path = "../base-input.json";
  assert.throws(() => parseRunLock(traversal), /traversal/);

  const relaxed = structuredClone(fx.runLock);
  relaxed.adjudicator_constraints.network_calls = 1;
  assert.throws(() => parseRunLock(relaxed), /may not relax offline safety/);

  const noncanonicalPath = structuredClone(fx.runLock);
  noncanonicalPath.shards[0].observation_batch_path = "observations/Call-000000.json";
  assert.throws(() => parseRunLock(noncanonicalPath), /not canonical for call_index/);

  const duplicate = structuredClone(fx.runLock);
  duplicate.shards.push({
    ...structuredClone(duplicate.shards[0]),
    shard_id: "shard-000001",
    call_index: 1,
    observation_batch_path: "observations/call-000001.json",
  });
  assert.throws(() => parseRunLock(duplicate), /coverage is not exactly once/);
});

test("full-family partitions are deterministic, bounded to six, disjoint, and exhaustive", async (t) => {
  const fx = await fixture(t, { writeObservation: false });
  const family = structuredClone(fx.runLock);
  for (let index = 1; index < 7; index += 1) {
    const listingKey = `walmart:1:SKU-${String(index + 1).padStart(3, "0")}`;
    const itemId = String(123456789 + index);
    const asset = structuredClone(family.listings[0].assets[0]);
    asset.image_id = walmartListingObservationImageId(
      asset.buyer_asset.sha256,
      "main",
      listingKey,
    );
    const shardId = `shard-${String(index).padStart(6, "0")}`;
    family.listings.push({
      ...structuredClone(family.listings[0]),
      listing_key: listingKey,
      item_id: itemId,
      assets: [asset],
      shard_ids: [shardId],
    });
    family.shards.push({
      shard_id: shardId,
      call_index: index,
      observation_batch_path: `observations/call-${String(index).padStart(6, "0")}.json`,
      prompt_sha256: walmartListingObservationPromptSha256([asset.image_id]),
      images: [{
        listing_key: listingKey,
        item_id: itemId,
        slot: "main",
        asset_sha256: asset.buyer_asset.sha256,
        model_view_sha256: asset.model_view.sha256,
        image_id: asset.image_id,
      }],
    });
  }
  family.observer_execution_constraints = observerExecutionConstraints(7);
  family.hard_source_freshness = buildWalmartListingIntegritySourceFreshness({
    authoritative_scope_captured_at: family.created_at,
    product_truth_snapshot_captured_at: family.created_at,
    buyer_index_captured_at: family.created_at,
    locked_buyer_snapshot_captured_ats: Array.from(
      { length: family.listings.length },
      () => family.created_at,
    ),
  });
  const firstSix = family.shards.slice(0, 6).map((row) => row.shard_id);
  const seventh = [family.shards[6].shard_id];
  family.observer_partitions = [firstSix, seventh].map((shardIds, partitionIndex) => ({
    partition_id: walmartListingIntegrityObserverPartitionId(partitionIndex, shardIds),
    partition_index: partitionIndex,
    shard_ids: shardIds,
  }));
  const parsed = parseRunLock(family);
  assert.deepEqual(parsed.observer_partitions.map((row) => row.shard_ids.length), [6, 1]);
  assert.deepEqual(
    parsed.observer_partitions.flatMap((row) => row.shard_ids),
    parsed.shards.map((row) => row.shard_id),
  );

  const samePartitionCollision = structuredClone(family);
  samePartitionCollision.shards[1].observation_batch_path =
    `${samePartitionCollision.shards[0].observation_batch_path}.attempt.json`;
  assert.throws(
    () => parseRunLock(samePartitionCollision),
    /(?:observer artifact path collision|not canonical for call_index)/,
  );

  const crossPartitionCollision = structuredClone(family);
  crossPartitionCollision.shards[6].observation_batch_path =
    `${crossPartitionCollision.shards[0].observation_batch_path}.attempt.json`;
  assert.throws(
    () => parseRunLock(crossPartitionCollision),
    /(?:observer artifact path collision|not canonical for call_index)/,
  );

  const reordered = structuredClone(family);
  [reordered.observer_partitions[0].shard_ids[0], reordered.observer_partitions[0].shard_ids[1]] =
    [reordered.observer_partitions[0].shard_ids[1], reordered.observer_partitions[0].shard_ids[0]];
  reordered.observer_partitions[0].partition_id = walmartListingIntegrityObserverPartitionId(
    0,
    reordered.observer_partitions[0].shard_ids,
  );
  assert.throws(() => parseRunLock(reordered), /exact deterministic global shard-order chunk/);
});

test("10k-shard family stays linear and exact signed grants cannot change family/call identity", async (t) => {
  const fx = await fixture(t, { writeObservation: false });
  const family = structuredClone(fx.runLock);
  const listingTemplate = structuredClone(family.listings[0]);
  const shardTemplate = structuredClone(family.shards[0]);
  family.listings = [];
  family.shards = [];
  for (let index = 0; index < 10_000; index += 1) {
    const listingKey = `walmart:1:MASS-${String(index).padStart(5, "0")}`;
    const itemId = String(900000000 + index);
    const shardId = `shard-${String(index).padStart(6, "0")}`;
    const asset = structuredClone(listingTemplate.assets[0]);
    asset.image_id = walmartListingObservationImageId(
      asset.buyer_asset.sha256,
      "main",
      listingKey,
    );
    family.listings.push({
      ...structuredClone(listingTemplate),
      listing_key: listingKey,
      item_id: itemId,
      assets: [asset],
      shard_ids: [shardId],
    });
    family.shards.push({
      ...structuredClone(shardTemplate),
      shard_id: shardId,
      call_index: index,
      observation_batch_path: `observations/call-${String(index).padStart(6, "0")}.json`,
      prompt_sha256: walmartListingObservationPromptSha256([asset.image_id]),
      images: [{
        listing_key: listingKey,
        item_id: itemId,
        slot: "main",
        asset_sha256: asset.buyer_asset.sha256,
        model_view_sha256: asset.model_view.sha256,
        image_id: asset.image_id,
      }],
    });
  }
  family.observer_execution_constraints = observerExecutionConstraints(10_000);
  family.hard_source_freshness = buildWalmartListingIntegritySourceFreshness({
    authoritative_scope_captured_at: family.created_at,
    product_truth_snapshot_captured_at: family.created_at,
    buyer_index_captured_at: family.created_at,
    locked_buyer_snapshot_captured_ats: Array.from({ length: 10_000 }, () => family.created_at),
  });
  family.observer_partitions = [];
  for (let offset = 0, partitionIndex = 0; offset < family.shards.length;
    offset += 6, partitionIndex += 1) {
    const shardIds = family.shards.slice(offset, offset + 6).map((row) => row.shard_id);
    family.observer_partitions.push({
      partition_id: walmartListingIntegrityObserverPartitionId(partitionIndex, shardIds),
      partition_index: partitionIndex,
      shard_ids: shardIds,
    });
  }
  const familyBytes = Buffer.from(JSON.stringify(family), "utf8");
  assert.ok(
    familyBytes.byteLength <= 64 * 1024 * 1024,
    `10k-shard minimal family exceeds loader cap: ${familyBytes.byteLength}`,
  );
  const familyShaBeforeRenewal = sha(familyBytes);
  const parsed = parseRunLock(family);
  const flattened = parsed.observer_partitions.flatMap((row) => row.shard_ids);
  assert.equal(parsed.shards.length, 10_000);
  assert.equal(parsed.observer_partitions.length, Math.ceil(10_000 / 6));
  assert.equal(new Set(flattened).size, 10_000);
  assert.deepEqual(flattened, parsed.shards.map((row) => row.shard_id));
  assert.equal(parsed.observer_partitions.every((row) => row.shard_ids.length <= 6), true);

  const firstPartition = parsed.observer_partitions[0];
  const authorization = signedOwnerAuthorization({
    runLock: parsed,
    runLockSha: familyShaBeforeRenewal,
    preflightSha: fx.preflightCertificate.sha256,
    issuedAt: parsed.created_at,
    partitionIds: [firstPartition.partition_id],
  });
  const reservation = buildWalmartListingIntegrityAllowanceReservation({
    owner_authorization: authorization,
    sequence: 0,
    previous_reservation_sha256: authorization.authorization_sha256,
    reserved_at: parsed.created_at,
  });
  const firstPermit = buildWalmartListingIntegrityExecutionPermitBody({
    run_lock: parsed,
    run_lock_sha256: familyShaBeforeRenewal,
    run_id: parsed.run_id,
    partition: firstPartition,
    preflight_certificate_sha256: fx.preflightCertificate.sha256,
    created_at: parsed.created_at,
    owner_authorization: authorization,
    allowance_reservation: reservation,
  });
  assert.deepEqual(firstPermit.allowance_reservation.body.call_indexes, [0, 1, 2, 3, 4, 5]);
  assert.equal(firstPermit.allowance_reservation.body.call_ceiling, 6);
  assert.equal(sha(Buffer.from(JSON.stringify(family), "utf8")), familyShaBeforeRenewal);
  const firstShard = parsed.shards[0];
  const workerContract = {
    worker_build: `sha256:${SHA_A}`,
    model: "sonnet",
    reasoning_effort: null,
    cli_version: "claude-fixture",
    node_version: "v24.0.0",
    runtime_platform: "darwin",
    runtime_arch: "arm64",
    vision_timeout_ms: 180_000,
    reservation_ledger: workerReservationLedgerContract(),
  };
  const callIdentity = {
    run_lock_sha256: familyShaBeforeRenewal,
    shard_id: firstShard.shard_id,
    call_index: firstShard.call_index,
    worker_contract: workerContract,
    prompt_sha256: firstShard.prompt_sha256,
    image_bindings: firstShard.images,
  };
  const callKeyBeforeRenewal = walmartListingObservationCallKey(callIdentity);
  const callKeyAfterRenewal = walmartListingObservationCallKey(callIdentity);
  assert.equal(callKeyAfterRenewal, callKeyBeforeRenewal);
});

test("signed partition permits are SHA-bound, freshness-bounded, and only gate reservation time", async (t) => {
  const fx = await fixture(t, { writeObservation: false });
  const parsed = assertExecutionPermitWindow(
    fx.executionPermit,
    new Date(Date.parse(fx.executionPermit.body.created_at) + 1),
  );
  assert.equal(parsed.body.partition_id, fx.runLock.observer_partitions[0].partition_id);
  assert.throws(
    () => assertExecutionPermitWindow(
      fx.executionPermit,
      new Date(fx.executionPermit.body.expires_at),
    ),
    /expired/,
  );
  const tampered = structuredClone(fx.executionPermit);
  tampered.body.preflight_certificate_sha256 = "0".repeat(64);
  assert.throws(() => parseWalmartListingIntegrityExecutionPermit(tampered, {
    run_lock: fx.runLock,
    owner_execution_authority: fx.runLock.owner_execution_authority,
    run_lock_sha256: fx.runLockSha,
    run_id: fx.runLock.run_id,
    partition: fx.runLock.observer_partitions[0],
    preflight_certificate_sha256: fx.preflightCertificate.sha256,
  }), /authorization|preflight|permit_id|sha256/i);
});

test("lightweight partition bootstrap trusts the sealed full preflight and reads no common sources", async (t) => {
  const fx = await fixture(t, { writeObservation: false });
  await writeFile(path.join(fx.root, "sources/product-truth.json"), "deliberately changed\n");
  const context = await loadPinnedObserverPartitionContext({
    run_lock: fx.lockPath,
    expect_run_lock_sha256: fx.runLockSha,
    partition_id: fx.runLock.observer_partitions[0].partition_id,
    execution_permit: fx.executionPermitFile.path,
    expect_execution_permit_sha256: fx.executionPermitFile.sha256,
    preflight_certificate: fx.preflightCertificate.path,
    expect_preflight_certificate_sha256: fx.preflightCertificate.sha256,
  }, {
    // Loading/inspection and offline terminalization remain available after
    // expiry; the observer gates only a new reservation/POST.
    now: () => new Date(Date.parse(fx.executionPermit.body.expires_at) + 1_000),
  });
  assert.equal(context.common_sources_read, false);
  assert.equal(context.shards.length, 1);
  assert.equal(context.listings.length, 1);
  assert.equal(context.selected_model_views.size, 1);
  assert.equal(context.execution_permit.body.partition_id, context.partition.partition_id);

  await chmod(fx.allowancePath, 0o644);
  await assert.rejects(
    () => loadPinnedObserverPartitionContext({
      run_lock: fx.lockPath,
      expect_run_lock_sha256: fx.runLockSha,
      partition_id: fx.runLock.observer_partitions[0].partition_id,
      execution_permit: fx.executionPermitFile.path,
      expect_execution_permit_sha256: fx.executionPermitFile.sha256,
      preflight_certificate: fx.preflightCertificate.path,
      expect_preflight_certificate_sha256: fx.preflightCertificate.sha256,
    }),
    /allowance ledger event 0 mode must be exactly 0444/,
  );
});

test("partition bootstrap rejects a forged durable allowance reservation before observer use", async (t) => {
  const fx = await fixture(t, { writeObservation: false });
  const forged = JSON.parse(await readFile(fx.allowancePath, "utf8"));
  forged.body.call_ceiling += 1;
  await chmod(fx.allowancePath, 0o644);
  await writeJson(fx.allowancePath, forged);
  await chmod(fx.allowancePath, 0o444);
  await assert.rejects(
    () => loadPinnedObserverPartitionContext({
      run_lock: fx.lockPath,
      expect_run_lock_sha256: fx.runLockSha,
      partition_id: fx.runLock.observer_partitions[0].partition_id,
      execution_permit: fx.executionPermitFile.path,
      expect_execution_permit_sha256: fx.executionPermitFile.sha256,
      preflight_certificate: fx.preflightCertificate.path,
      expect_preflight_certificate_sha256: fx.preflightCertificate.sha256,
    }),
    /allowance_reservation differs from the signed grant|allowance_reservation seal mismatch/,
  );
});

test("plan verifies every pinned byte, permits pending observations, and writes nothing", async (t) => {
  const fx = await fixture(t, { writeObservation: false });
  const before = (await readdir(fx.root, { recursive: true })).sort();
  const stdout = stdoutCapture();
  let semanticCalls = 0;
  await runPlan(planOptions(fx), {
    stdout,
    ...populationInjection(),
    async preflight_against_sources(input, sources) {
      semanticCalls += 1;
      assert.equal(input.images.evidence[0].state, "technical_error");
      assert.equal(sources.observation_batches.length, 0);
      return {
        overall_verdict: "REVIEW",
        assurance: {
          source_artifacts_verified: true,
          surface_snapshot_verified: true,
          asset_bytes_verified: true,
          observation_artifacts_verified: false,
        },
      };
    },
  });
  const after = (await readdir(fx.root, { recursive: true })).sort();
  assert.deepEqual(after, before);
  const result = JSON.parse(stdout.text);
  assert.equal(result.mode, "PLAN");
  assert.equal(result.listing_count, 1);
  assert.equal(result.shard_count, 1);
  assert.equal(result.partition_count, 1);
  assert.deepEqual(result.preflight_certificate.body.observer_partitions, fx.runLock.observer_partitions);
  assert.equal(result.preflight_certificate.body.run_lock_sha256, fx.runLockSha);
  assert.equal(result.assurance.observation_batches_read, false);
  assert.equal(result.assurance.semantic_source_preflight_verified, true);
  assert.equal(result.assurance.bounded_listing_loader, true);
  assert.equal(semanticCalls, 1);
  assert.equal(result.assurance.reports_written, 0);
  assert.equal(result.assurance.network_calls, 0);
  assert.equal(result.deterministic_listing_order[0].report_file, reportFilename(0, fx.listingKey));
});

test("plan rejects a changed lock hash, changed source bytes, and source symlinks", async (t) => {
  const fx = await fixture(t, { writeObservation: false });
  await assert.rejects(runPlan(planOptions(fx, SHA_A), { stdout: stdoutCapture() }), /SHA-256 differs/);

  await writeFile(path.join(fx.root, "sources/product-truth.json"), "changed\n");
  await assert.rejects(runPlan(planOptions(fx), { stdout: stdoutCapture() }), /exact-byte SHA-256 mismatch/);

  const restored = await writeJson(path.join(fx.root, "sources/product-truth.json"), { source: "truth" });
  const link = path.join(fx.root, "sources/product-truth-link.json");
  await symlink(restored.path, link);
  fx.runLock.source_artifacts.product_truth_snapshot = {
    path: "sources/product-truth-link.json",
    sha256: restored.sha256,
  };
  fx.runLockSha = await fx.rewriteRunLock();
  await assert.rejects(runPlan(planOptions(fx), { stdout: stdoutCapture() }), /may not contain symlinks/);
});

test("code-bundle manifest binds the exact executing engine, observer, OCR, and worker bytes", async (t) => {
  const fx = await fixture(t, { writeObservation: false });
  const manifestPath = path.join(fx.root, fx.runLock.code_bundle_manifest.path);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files[0].sha256 = "0".repeat(64);
  const body = { ...manifest };
  delete body.bundle_id;
  manifest.bundle_id = `sha256:${walmartListingObservationSha256(body)}`;
  const rewritten = await writeJson(manifestPath, manifest);
  fx.runLock.code_bundle_manifest.sha256 = rewritten.sha256;
  fx.runLockSha = await fx.rewriteRunLock();
  await assert.rejects(
    runPlan(planOptions(fx), { stdout: stdoutCapture() }),
    /code_bundle_manifest does not match executing bytes/,
  );
});

test("audit assembles evidence in memory, writes one read-only wx report, and refuses reuse", async (t) => {
  const fx = await fixture(t);
  const reportsDir = path.join(fx.root, "reports");
  const stdout = stdoutCapture();
  let compileCalls = 0;
  await runAudit(auditOptions(fx, reportsDir), {
    stdout,
    ...populationInjection(),
    async compile_against_sources(input, sources) {
      compileCalls += 1;
      assert.equal(input.images.evidence.length, 1);
      assert.equal(input.images.evidence[0].slot, "main");
      assert.equal(input.images.evidence[0].observation.image_id, fx.imageId);
      assert.equal(sources.run_lock_sha256, fx.runLockSha);
      assert.equal(sources.observation_batches.length, 1);
      assert.equal(sources.observation_shards.length, 1);
      return reviewReport(fx.listingKey);
    },
  });
  assert.equal(compileCalls, 1);
  const summary = JSON.parse(stdout.text);
  assert.equal(summary.mode, "AUDIT");
  assert.equal(summary.reports_written, 1);
  assert.equal(summary.verdict_counts.REVIEW, 1);
  const files = await readdir(reportsDir);
  assert.deepEqual(files, [reportFilename(0, fx.listingKey)]);
  const reportPath = path.join(reportsDir, files[0]);
  const reportMode = (await stat(reportPath)).mode;
  assert.equal(reportMode & 0o222, 0, "report must have no write bits");
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).overall_verdict, "REVIEW");

  await assert.rejects(runAudit(auditOptions(fx, reportsDir), {
    stdout: stdoutCapture(),
    ...populationInjection(),
    compile_against_sources: async () => reviewReport(fx.listingKey),
  }), /must not already exist/);
});

test("offline audit remains reproducible after the partition permit has expired", async (t) => {
  const fx = await fixture(t);
  const reportsDir = path.join(fx.root, "expired-permit-offline-reports");
  await runAudit(auditOptions(fx, reportsDir), {
    stdout: stdoutCapture(),
    // Deliberately far after permit expiry. audit/verify validate historical
    // signed reservation timing, not the current wall clock.
    now: () => new Date(Date.parse(fx.executionPermit.body.expires_at) + 365 * 86_400_000),
    ...populationInjection(),
    compile_against_sources: async () => reviewReport(fx.listingKey),
  });
  const stdout = stdoutCapture();
  await runVerify(verifyOptions(fx, reportsDir), {
    stdout,
    now: () => new Date(Date.parse(fx.executionPermit.body.expires_at) + 730 * 86_400_000),
    ...populationInjection(),
    verify_against_sources: async (report) => report,
  });
  assert.equal(JSON.parse(stdout.text).complete, true);
});

test("successful observation requires one exact immutable pre-POST attempt", async (t) => {
  const fx = await fixture(t);
  let caseIndex = 0;
  async function rejectBeforeCompile(pattern) {
    caseIndex += 1;
    const reportsDir = path.join(fx.root, `successful-attempt-negative-${caseIndex}`);
    let compileCalls = 0;
    await assert.rejects(runAudit(auditOptions(fx, reportsDir), {
      stdout: stdoutCapture(),
      ...populationInjection(),
      async compile_against_sources() {
        compileCalls += 1;
        return reviewReport(fx.listingKey);
      },
    }), pattern);
    assert.equal(compileCalls, 0);
    await assert.rejects(access(reportsDir), /ENOENT/);
  }
  async function replaceAttempt(value, mode = 0o444) {
    try { await unlink(fx.attemptPath); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await writeJson(fx.attemptPath, value);
    await chmod(fx.attemptPath, mode);
  }

  await unlink(fx.attemptPath);
  await rejectBeforeCompile(/ENOENT/);

  const extra = structuredClone(fx.attemptValue);
  extra.unexpected = true;
  await replaceAttempt(extra);
  await rejectBeforeCompile(/successful attempt.*keys must be exactly/);

  const tampered = structuredClone(fx.attemptValue);
  tampered.local_ocr_sha256 = "0".repeat(64);
  const tamperedBody = { ...tampered };
  delete tamperedBody.body_sha256;
  tampered.body_sha256 = walmartListingObservationSha256(tamperedBody);
  await replaceAttempt(tampered);
  await rejectBeforeCompile(/does not exactly bind its immutable pre-POST attempt/);

  const requestTampered = structuredClone(fx.attemptValue);
  requestTampered.request_attestation.call_key = "0".repeat(64);
  const requestTamperedBody = { ...requestTampered };
  delete requestTamperedBody.body_sha256;
  requestTampered.body_sha256 = walmartListingObservationSha256(requestTamperedBody);
  await replaceAttempt(requestTampered);
  await rejectBeforeCompile(/differs from the immutable call contract/);

  const late = structuredClone(fx.attemptValue);
  late.reserved_at = new Date(
    Date.parse(fx.observationValue.worker_receipt.body.reservation_reserved_at) + 1,
  ).toISOString();
  const lateBody = { ...late };
  delete lateBody.body_sha256;
  late.body_sha256 = walmartListingObservationSha256(lateBody);
  await replaceAttempt(late);
  await rejectBeforeCompile(/timing does not satisfy the required pre-POST ordering/);

  await replaceAttempt(fx.attemptValue);
  await chmod(fx.observationPath, 0o644);
  await rejectBeforeCompile(/observation batch mode must be exactly 0444/);
  await chmod(fx.observationPath, 0o444);

  await replaceAttempt(fx.attemptValue, 0o644);
  await rejectBeforeCompile(/successful attempt sibling mode must be exactly 0444/);
});

test("sealed ambiguous terminal gives exact technical-error coverage and can never PASS", async (t) => {
  const fx = await fixture(t);
  await unlink(fx.attemptPath);
  const shard = fx.runLock.shards[0];
  const workerContract = structuredClone(fx.observationValue.worker_contract);
  const attemptBody = {
    schema_version: "walmart-listing-observation-attempt/v3",
    executor_version: "walmart-listing-observer-executor/v3",
    run_lock_sha256: fx.runLockSha,
    shard_id: shard.shard_id,
    call_index: shard.call_index,
    call_key: fx.observationValue.call_key,
    reserved_at: fx.executionPermit.body.created_at,
    observation_batch_path: shard.observation_batch_path,
    provider: "claude_cli_subscription",
    worker_contract: workerContract,
    execution_permit: fx.executionPermit,
    prompt: { version: BLIND_PROMPT_VERSION, sha256: shard.prompt_sha256 },
    image_bindings: structuredClone(shard.images),
    local_ocr_sha256: walmartListingObservationSha256(fx.observationValue.local_ocr),
    request_attestation: {
      schema_version: WALMART_LISTING_WORKER_REQUEST_SCHEMA,
      run_lock_sha256: fx.runLockSha,
      shard_id: shard.shard_id,
      call_index: shard.call_index,
      call_key: fx.observationValue.call_key,
      prompt_sha256: shard.prompt_sha256,
      execution_permit_sha256: fx.executionPermit.sha256,
      partition_id: fx.executionPermit.body.partition_id,
      image_sha256: shard.images.map((image) => image.model_view_sha256),
    },
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
  const attemptPath = `${fx.observationPath}.attempt.json`;
  await writeJson(attemptPath, attempt);
  await chmod(attemptPath, 0o444);
  const terminal = sealWalmartListingObservationTechnicalErrorTerminal({
    schema_version: WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA,
    observer_version: WALMART_LISTING_OBSERVER_VERSION,
    run_lock_sha256: fx.runLockSha,
    shard_id: shard.shard_id,
    call_index: shard.call_index,
    call_key: fx.observationValue.call_key,
    reserved_at: fx.executionPermit.body.created_at,
    terminalized_at: new Date(Date.parse(fx.executionPermit.body.created_at) + 5_000).toISOString(),
    terminal_state: "BLOCKED_AMBIGUOUS",
    audit_outcome: "TECH_ERROR",
    reason_code: "attempt_reserved_without_verifiable_worker_result",
    attempt_body_sha256: attempt.body_sha256,
    execution_permit: fx.executionPermit,
    worker_contract: workerContract,
    prompt: { version: BLIND_PROMPT_VERSION, sha256: shard.prompt_sha256 },
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    image_bindings: structuredClone(shard.images),
    image_outcomes: shard.images.map((image) => ({
      image_id: image.image_id,
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
  await unlink(fx.observationPath);
  await writeJson(fx.observationPath, terminal);
  await chmod(fx.observationPath, 0o444);
  const reportsDir = path.join(fx.root, "technical-terminal-reports");
  const stdout = stdoutCapture();
  await runAudit(auditOptions(fx, reportsDir), {
    stdout,
    ...populationInjection(),
    async compile_against_sources(input, sources) {
      assert.equal(input.images.evidence[0].state, "technical_error");
      assert.equal(sources.observation_batches.length, 0);
      assert.equal(sources.observation_terminal_artifacts.length, 1);
      return reviewReport(fx.listingKey);
    },
  });
  assert.equal(JSON.parse(stdout.text).technical_terminal_shards, 1);

  await assert.rejects(runAudit(auditOptions(fx, path.join(fx.root, "terminal-pass")), {
    stdout: stdoutCapture(),
    ...populationInjection(),
    compile_against_sources: async () => ({
      ...reviewReport(fx.listingKey),
      overall_verdict: "PASS",
      assurance: { observation_artifacts_verified: true },
    }),
  }), /PASS is forbidden when an image has a technical terminal/);

  await unlink(attemptPath);
  let verifyCalls = 0;
  await assert.rejects(runVerify(verifyOptions(fx, reportsDir), {
    stdout: stdoutCapture(),
    ...populationInjection(),
    async verify_against_sources(report) {
      verifyCalls += 1;
      return report;
    },
  }), /ENOENT/);
  assert.equal(verifyCalls, 0, "verify must reject a missing attempt before rebuilding reports");
  const missingReports = path.join(fx.root, "missing-attempt-reports");
  let missingCompileCalls = 0;
  await assert.rejects(runAudit(auditOptions(fx, missingReports), {
    stdout: stdoutCapture(),
    ...populationInjection(),
    async compile_against_sources() {
      missingCompileCalls += 1;
      return reviewReport(fx.listingKey);
    },
  }), /ENOENT/);
  assert.equal(missingCompileCalls, 0);
  await assert.rejects(access(missingReports), /ENOENT/);

  const fabricatedAttempt = structuredClone(attempt);
  fabricatedAttempt.call_key = "0".repeat(64);
  const fabricatedBody = { ...fabricatedAttempt };
  delete fabricatedBody.body_sha256;
  fabricatedAttempt.body_sha256 = walmartListingObservationSha256(fabricatedBody);
  await writeJson(attemptPath, fabricatedAttempt);
  await chmod(attemptPath, 0o444);
  const fabricatedReports = path.join(fx.root, "fabricated-attempt-reports");
  let fabricatedCompileCalls = 0;
  await assert.rejects(runAudit(auditOptions(fx, fabricatedReports), {
    stdout: stdoutCapture(),
    ...populationInjection(),
    async compile_against_sources() {
      fabricatedCompileCalls += 1;
      return reviewReport(fx.listingKey);
    },
  }), /terminal attempt differs from the immutable call contract/);
  assert.equal(fabricatedCompileCalls, 0);
  await assert.rejects(access(fabricatedReports), /ENOENT/);

  await unlink(attemptPath);
  await writeJson(attemptPath, attempt);
  await chmod(attemptPath, 0o644);
  const writableReports = path.join(fx.root, "writable-attempt-reports");
  await assert.rejects(runAudit(auditOptions(fx, writableReports), {
    stdout: stdoutCapture(),
    ...populationInjection(),
    compile_against_sources: async () => reviewReport(fx.listingKey),
  }), /terminal attempt sibling mode must be exactly 0444/);
  await assert.rejects(access(writableReports), /ENOENT/);

  await unlink(attemptPath);
  const symlinkTarget = path.join(fx.root, "attempt-target.json");
  await writeJson(symlinkTarget, attempt);
  await chmod(symlinkTarget, 0o444);
  await symlink(symlinkTarget, attemptPath);
  const symlinkReports = path.join(fx.root, "symlink-attempt-reports");
  await assert.rejects(runAudit(auditOptions(fx, symlinkReports), {
    stdout: stdoutCapture(),
    ...populationInjection(),
    compile_against_sources: async () => reviewReport(fx.listingKey),
  }), /may not contain symlinks/);
  await assert.rejects(access(symlinkReports), /ENOENT/);
});

test("audit refuses an unverified PASS before creating its output directory", async (t) => {
  const fx = await fixture(t);
  const reportsDir = path.join(fx.root, "forbidden-pass-reports");
  await assert.rejects(runAudit(auditOptions(fx, reportsDir), {
    stdout: stdoutCapture(),
    ...populationInjection(),
    compile_against_sources: async () => ({
      ...reviewReport(fx.listingKey),
      overall_verdict: "PASS",
      assurance: { observation_artifacts_verified: false },
    }),
  }), /PASS is forbidden/);
  await assert.rejects(access(reportsDir), /ENOENT/);
});

test("verify requires exact complete coverage and source-aware rebuild for every report", async (t) => {
  const fx = await fixture(t);
  const reportsDir = path.join(fx.root, "reports-for-verify");
  await runAudit(auditOptions(fx, reportsDir), {
    stdout: stdoutCapture(),
    ...populationInjection(),
    compile_against_sources: async () => reviewReport(fx.listingKey),
  });
  let verifyCalls = 0;
  const stdout = stdoutCapture();
  await runVerify(verifyOptions(fx, reportsDir), {
    stdout,
    ...populationInjection(),
    async verify_against_sources(rawReport, input, sources) {
      verifyCalls += 1;
      assert.equal(rawReport.overall_verdict, "REVIEW");
      assert.equal(input.images.evidence[0].observation.image_id, fx.imageId);
      assert.equal(sources.observation_batches.length, 1);
      return rawReport;
    },
  });
  assert.equal(verifyCalls, 1);
  const summary = JSON.parse(stdout.text);
  assert.equal(summary.complete, true);
  assert.equal(summary.reports_verified, 1);
  assert.equal(summary.assurance.source_aware_rebuild, true);

  await writeFile(path.join(reportsDir, "unexpected.json"), "{}\n");
  await assert.rejects(runVerify(verifyOptions(fx, reportsDir), {
    stdout: stdoutCapture(),
    ...populationInjection(),
    verify_against_sources: async (report) => report,
  }), /unexpected file/);
  await unlink(path.join(reportsDir, "unexpected.json"));
  await unlink(path.join(reportsDir, reportFilename(0, fx.listingKey)));
  await assert.rejects(runVerify(verifyOptions(fx, reportsDir), {
    stdout: stdoutCapture(),
    ...populationInjection(),
    verify_against_sources: async (report) => report,
  }), /incomplete/);
});

test("sha256Bytes is exact-byte stable", () => {
  assert.equal(sha256Bytes(Buffer.from("abc", "utf8")), sha(Buffer.from("abc", "utf8")));
  assert.notEqual(sha256Bytes(Buffer.from("abc", "utf8")), sha256Bytes(Buffer.from("abc\n", "utf8")));
});
