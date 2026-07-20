import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";

import {
  BLIND_OBSERVATION_SCHEMA,
  BLIND_PROMPT_VERSION,
} from "../../src/lib/walmart/catalog-visual-audit.ts";
import { VISUAL_PREPROCESS_VERSION } from "../../src/lib/walmart/catalog-visual-preprocess.ts";
import {
  WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
  WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA,
  WALMART_LISTING_OBSERVER_VERSION,
  WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
  WALMART_LISTING_WORKER_RECEIPT_SCHEMA,
  WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA,
  WALMART_LISTING_WORKER_REQUEST_SCHEMA,
  canonicalWalmartListingObservationJson,
  verifyWalmartListingObservationArtifact,
  verifyWalmartListingObservationBatch,
  walmartListingObservationImageId,
  walmartListingObservationPromptSha256,
  walmartListingObservationSha256,
} from "../../src/lib/walmart/listing-integrity-observation.ts";
import { LOCAL_VISUAL_OCR_ENGINE } from "../../src/lib/walmart/local-visual-ocr.ts";
import {
  WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
  WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_SCHEMA,
  assembleWalmartListingIntegrityOwnerExecutionAuthorization,
  buildWalmartListingIntegrityAllowanceReservation,
  buildWalmartListingIntegrityExecutionPermitBody,
  buildWalmartListingIntegrityOwnerExecutionAuthorizationBody,
  buildWalmartListingIntegritySourceFreshness,
  walmartListingIntegrityOwnerAuthorizationSigningMessage,
} from "../walmart-listing-integrity-engine.mjs";
import {
  attestLocalOcrRuntime,
  buildLocalOcrChildEnv,
  buildWorkerRequestBody,
  inspectObserverExecutionState,
  parseObserverCliArgs,
  runObserverExecute,
  runObserverPlan,
} from "../walmart-listing-integrity-observer.mjs";

function stdoutCapture() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    json() { return JSON.parse(value); },
  };
}

function response(status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return name.toLowerCase() === "content-length" ? String(Buffer.byteLength(text)) : null; } },
    async text() { return text; },
  };
}

function blindObservation(imageId) {
  return {
    image_id: imageId,
    visual_role: "single_product_front",
    visible_brand_text: "Brand",
    visible_product_text: "Bread",
    visible_variant_text: "White",
    visible_size_texts: ["20 oz"],
    external_package_count: { mode: "exact", value: 1, min: null, max: null },
    outer_package_claims: [],
    inner_contents_claims: [],
    case_package_claims: [],
    unclear_quantity_claims: [],
    grid_cell_kind: "not_a_grid",
    front_visibility: "all",
    background: "white",
    multiple_distinct_products: "no",
    readable_identity: "clear",
    evidence: ["Brand Bread White"],
    flags: [],
  };
}

function emptyOcr(image, scriptSha) {
  const output = {
    schema_version: WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
    engine: LOCAL_VISUAL_OCR_ENGINE,
    views: [{
      view_role: "full",
      view_sha256: image.model_view_sha256,
      width: 100,
      height: 100,
      observations: [],
    }],
  };
  return {
    image_id: image.image_id,
    asset_sha256: image.asset_sha256,
    full_view_sha256: image.model_view_sha256,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
    ocr_script_sha256: scriptSha,
    ocr_output_sha256: walmartListingObservationSha256(output),
    ocr_output: output,
    truncated: false,
    auxiliary_ocr: { ocr_texts: [] },
  };
}

function testKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey,
    publicDer,
    publicBase64: publicDer.toString("base64"),
    publicSha: walmartListingObservationSha256(Buffer.from(publicDer).toString("base64")),
  };
}

// The contract fingerprint is SHA-256 of raw DER bytes, not canonical JSON.
import { createHash } from "node:crypto";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function reservationLedger() {
  return {
    schema_version: WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA,
    ledger_id: "ledger-11111111-1111-4111-8111-111111111111",
    ledger_epoch: "epoch-22222222-2222-4222-8222-222222222222",
    state_directory_path_sha256: "3".repeat(64),
    directory_identity_sha256: "4".repeat(64),
    identity_artifact_sha256: "5".repeat(64),
  };
}

const OWNER_KEYS = generateKeyPairSync("ed25519");
const OWNER_PUBLIC_DER = OWNER_KEYS.publicKey.export({ format: "der", type: "spki" });
const OWNER_PUBLIC_SHA = sha256(OWNER_PUBLIC_DER);

function ownerExecutionAuthority() {
  return {
    algorithm: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
    key_id: "fixture-owner-key",
    public_key_spki_der_base64: OWNER_PUBLIC_DER.toString("base64"),
    public_key_spki_sha256: OWNER_PUBLIC_SHA,
  };
}

function signedOwnerAuthorization({ runLock, runLockSha, preflightSha, issuedAt, partitionIds }) {
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

async function fixture({
  shards = 1,
  permitCreatedAt = "2026-07-18T21:00:00.000Z",
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "observer-runner-test-"));
  await mkdir(path.join(directory, "observations"), { mode: 0o700 });
  const key = testKey();
  key.publicSha = sha256(key.publicDer);
  const runLockSha = "a".repeat(64);
  const workerBuildSha = "b".repeat(64);
  const scriptSha = "c".repeat(64);
  const listingKey = "walmart:1:SKU-1";
  const itemId = "123";
  const shardRows = [];
  const assets = [];
  for (let index = 0; index < shards; index += 1) {
    const slot = index === 0 ? "main" : `gallery-${index}`;
    const assetSha = String((index + 1) % 10).repeat(64);
    const modelSha = sha256(Buffer.from(`model-${index}`, "utf8"));
    const imageId = walmartListingObservationImageId(assetSha, slot, listingKey);
    const image = {
      listing_key: listingKey,
      item_id: itemId,
      slot,
      asset_sha256: assetSha,
      model_view_sha256: modelSha,
      image_id: imageId,
    };
    assets.push({ slot, image_id: imageId });
    shardRows.push({
      shard_id: `shard-${index}`,
      call_index: index,
      observation_batch_path: `observations/shard-${index}.json`,
      prompt_sha256: walmartListingObservationPromptSha256([imageId]),
      images: [image],
    });
  }
  const context = {
    lock_directory: directory,
    run_lock_sha256: runLockSha,
    preflight_certificate_sha256: "7".repeat(64),
    run_lock: {
      run_id: "observer-test-run",
      created_at: "2026-07-17T20:00:00.000Z",
      listings: [{ listing_key: listingKey, item_id: itemId, assets }],
      shards: shardRows,
      observer_partitions: Array.from(
        { length: Math.ceil(shards / 6) },
        (_, partitionIndex) => {
          const shardIds = shardRows.slice(partitionIndex * 6, (partitionIndex + 1) * 6)
            .map((row) => row.shard_id);
          return {
            partition_id: `partition-${partitionIndex}`,
            partition_index: partitionIndex,
            shard_ids: shardIds,
          };
        },
      ),
      observer_contract: {
        provider: "claude_cli_subscription",
        model: "sonnet",
        observer_version: WALMART_LISTING_OBSERVER_VERSION,
        observation_schema_version: WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
        prompt_version: BLIND_PROMPT_VERSION,
        preprocessor_version: VISUAL_PREPROCESS_VERSION,
        local_ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
        local_ocr_script_sha256: scriptSha,
        worker_build_sha256: workerBuildSha,
        reservation_ledger: reservationLedger(),
        worker_receipt_key_id: "test-key-1",
        worker_receipt_public_key_sha256: key.publicSha,
        cli_version: "claude-test",
        node_version: "v24.0.0",
        platform: "darwin",
        arch: "arm64",
        health_attestation_required: true,
        response_attestation_required: true,
        attempt_count: 1,
        fallback_allowed: false,
        max_images_per_call: 6,
        worker_analyze_url: "http://127.0.0.1:8791/analyze-claude",
        vision_timeout_ms: 180_000,
        observer_response_margin_ms: 30_000,
        swift_executable_sha256: "d".repeat(64),
        xcrun_executable_sha256: "e".repeat(64),
        swift_version_output_sha256: "f".repeat(64),
        macos_sdk_version: "26.5",
        macos_sdk_path_sha256: "9".repeat(64),
      },
      owner_execution_authority: ownerExecutionAuthority(),
      hard_source_freshness: buildWalmartListingIntegritySourceFreshness({
        authoritative_scope_captured_at: "2026-07-18T22:00:00.000Z",
        product_truth_snapshot_captured_at: "2026-07-18T22:00:00.000Z",
        buyer_index_captured_at: "2026-07-18T22:00:00.000Z",
        locked_buyer_snapshot_captured_ats: ["2026-07-18T22:00:00.000Z"],
      }),
      observer_execution_constraints: {
        network_target: "locked_worker_only",
        worker_health_calls_per_execute: 1,
        subscription_calls_total: shards,
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
      },
    },
  };
  const partition = context.run_lock.observer_partitions[0];
  const ownerAuthorization = signedOwnerAuthorization({
    runLock: context.run_lock,
    runLockSha,
    preflightSha: context.preflight_certificate_sha256,
    issuedAt: permitCreatedAt,
    partitionIds: [partition.partition_id],
  });
  const allowanceReservation = buildWalmartListingIntegrityAllowanceReservation({
    owner_authorization: ownerAuthorization,
    sequence: 0,
    previous_reservation_sha256: ownerAuthorization.authorization_sha256,
    reserved_at: permitCreatedAt,
  });
  const permitBody = buildWalmartListingIntegrityExecutionPermitBody({
    run_lock: context.run_lock,
    run_lock_sha256: runLockSha,
    run_id: context.run_lock.run_id,
    partition,
    preflight_certificate_sha256: context.preflight_certificate_sha256,
    created_at: permitCreatedAt,
    owner_authorization: ownerAuthorization,
    allowance_reservation: allowanceReservation,
  });
  const permit = {
    sha256: walmartListingObservationSha256(permitBody),
    body: permitBody,
  };
  return {
    context, directory, key, scriptSha, workerBuildSha, partition, permit,
    permitExactByteSha: "8".repeat(64),
  };
}

function observerOptions(fx, extra = {}) {
  return {
    run_lock: "/unused/run-lock.json",
    expect_run_lock_sha256: fx.context.run_lock_sha256,
    partition_id: fx.partition.partition_id,
    execution_permit: "/unused/execution-permit.json",
    expect_execution_permit_sha256: fx.permitExactByteSha,
    preflight_certificate: "/unused/preflight-certificate.json",
    expect_preflight_certificate_sha256: fx.context.preflight_certificate_sha256,
    ...extra,
  };
}

function fakeWorker(fx, {
  postStatus = 200,
  healthVisionTimeoutMs,
  mutateHealth,
  mutateResponse,
} = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const observer = fx.context.run_lock.observer_contract;
    if (options.method === "GET") {
      if (options.headers?.authorization !== "Bearer secret-test-token") {
        return response(401, {
          ok: false,
          error: "unauthorized",
          health_authorization_verified: false,
        });
      }
      const healthBody = {
        ok: true,
        health_authorization_verified: true,
        worker_build: `sha256:${fx.workerBuildSha}`,
        vision_providers: ["claude_cli_subscription"],
        vision_contracts: {
          claude_cli_subscription: {
            model: "sonnet",
            reasoning_effort: null,
            cli_version: observer.cli_version,
            node_version: observer.node_version,
            platform: observer.platform,
            arch: observer.arch,
          },
        },
        vision_timeout_ms: healthVisionTimeoutMs ?? observer.vision_timeout_ms,
        signed_vision_receipts: {
          schema_version: WALMART_LISTING_WORKER_RECEIPT_SCHEMA,
          key_id: observer.worker_receipt_key_id,
          public_key_spki_sha256: fx.key.publicSha,
        },
        durable_call_key_reservations: true,
        reservation_ledger: structuredClone(observer.reservation_ledger),
      };
      mutateHealth?.(healthBody);
      return response(200, healthBody);
    }
    if (postStatus !== 200) return response(postStatus, { ok: false, error: "simulated failure" });
    const request = JSON.parse(options.body);
    const shard = fx.context.run_lock.shards.find((row) => (
      row.call_index === request.request_attestation.call_index
    ));
    const result = {
      schema_version: BLIND_OBSERVATION_SCHEMA,
      observations: shard.images.map((image) => blindObservation(image.image_id)),
    };
    const receiptBody = {
      issued_at: "2026-07-18T22:00:01.000Z",
      reservation_reserved_at: "2026-07-18T22:00:00.100Z",
      request_attestation: request.request_attestation,
      result_canonical_sha256: walmartListingObservationSha256(result),
      worker_contract: {
        input_image_count: shard.images.length,
        vision_provider: "claude_cli_subscription",
        vision_model: "sonnet",
        vision_reasoning_effort: null,
        cli_version: observer.cli_version,
        node_version: observer.node_version,
        runtime_platform: observer.platform,
        runtime_arch: observer.arch,
        worker_build: `sha256:${fx.workerBuildSha}`,
        vision_timeout_ms: observer.vision_timeout_ms,
        reservation_ledger: structuredClone(observer.reservation_ledger),
      },
      subscription_policy: {
        auth_mode: "claude_subscription_oauth",
        paid_api_environment_absent: true,
        alternate_cloud_routing_absent: true,
      },
    };
    const signature = sign(
      null,
      Buffer.from(canonicalWalmartListingObservationJson(receiptBody), "utf8"),
      fx.key.privateKey,
    );
    const responseBody = {
      ok: true,
      result,
      input_image_count: shard.images.length,
      vision_provider: "claude_cli_subscription",
      vision_model: "sonnet",
      vision_reasoning_effort: null,
      cli_version: observer.cli_version,
      node_version: observer.node_version,
      runtime_platform: observer.platform,
      runtime_arch: observer.arch,
      worker_build: `sha256:${fx.workerBuildSha}`,
      vision_timeout_ms: observer.vision_timeout_ms,
      reservation_ledger: structuredClone(observer.reservation_ledger),
      request_attestation_verified: true,
      worker_receipt: {
        schema_version: WALMART_LISTING_WORKER_RECEIPT_SCHEMA,
        key_id: observer.worker_receipt_key_id,
        public_key_spki_der_base64: fx.key.publicBase64,
        public_key_spki_sha256: fx.key.publicSha,
        body: receiptBody,
        signature_base64: signature.toString("base64"),
      },
    };
    mutateResponse?.(responseBody);
    return response(200, responseBody);
  };
  return { calls, fetch };
}

function injections(fx, worker, capture, overrides = {}) {
  return {
    stdout: capture.stream,
    load_context: async () => fx.context,
    validate_preflight_certificate: async () => true,
    load_execution_permit: async () => ({
      exact_byte_sha256: fx.permitExactByteSha,
      permit: fx.permit,
    }),
    fetch: worker.fetch,
    env: { CODEX_IMAGE_WORKER_TOKEN: "secret-test-token" },
    attest_local_ocr_runtime: async () => ({
      exec_file: async () => { throw new Error("unused"); },
      sdk_path: "/locked/MacOSX.sdk",
    }),
    prepare_local_ocr_batches: async (_context, shards) => new Map(shards.map((shard) => [
      shard.shard_id,
      shard.images.map((image) => emptyOcr(image, fx.scriptSha)),
    ])),
    load_model_images: async (_context, shard) => shard.images.map(() => (
      Buffer.from(`model-${shard.call_index}`, "utf8").toString("base64")
    )),
    now: () => "2026-07-18T22:00:00.000Z",
    ...overrides,
  };
}

test("strict CLI exposes only plan and bounded execute flags", () => {
  const lock = "/tmp/run-lock.json";
  const sha = "a".repeat(64);
  const common = [
    `--run-lock=${lock}`,
    `--expect-run-lock-sha256=${sha}`,
    "--partition-id=partition-0",
    "--execution-permit=/tmp/execution-permit.json",
    `--expect-execution-permit-sha256=${"b".repeat(64)}`,
    "--preflight-certificate=/tmp/preflight-certificate.json",
    `--expect-preflight-certificate-sha256=${"c".repeat(64)}`,
  ];
  assert.deepEqual(parseObserverCliArgs([
    "execute", ...common,
    "--from-call=0", "--call-budget=6",
  ]), {
    help: false, command: "execute", run_lock: lock,
    expect_run_lock_sha256: sha,
    partition_id: "partition-0",
    execution_permit: "/tmp/execution-permit.json",
    expect_execution_permit_sha256: "b".repeat(64),
    preflight_certificate: "/tmp/preflight-certificate.json",
    expect_preflight_certificate_sha256: "c".repeat(64),
    from_call: 0, call_budget: 6,
  });
  assert.throws(() => parseObserverCliArgs([
    "execute", ...common,
    "--from-call=0", "--call-budget=7",
  ]), /1\.\.6/);
  assert.throws(() => parseObserverCliArgs([
    "execute", ...common,
    "--from-call=0", "--call-budget=1", "--provider=codex",
  ]), /unsupported flag/);
});

test("local OCR runtime attestation binds executable bytes, Swift stdout, and SDK version/path", async () => {
  const fx = await fixture();
  const swiftBytes = Buffer.from("swift-binary");
  const xcrunBytes = Buffer.from("xcrun-binary");
  const swiftVersionBytes = Buffer.from("Swift exact version\nTarget exact\n");
  const sdkPath = "/Library/Developer/Locked/MacOSX.sdk";
  Object.assign(fx.context.run_lock.observer_contract, {
    swift_executable_sha256: sha256(swiftBytes),
    xcrun_executable_sha256: sha256(xcrunBytes),
    swift_version_output_sha256: sha256(swiftVersionBytes),
    macos_sdk_version: "26.5",
    macos_sdk_path_sha256: sha256(Buffer.from(sdkPath, "utf8")),
  });
  const exec_file = async (binary, args) => {
    if (binary === "/usr/bin/swift") return { stdout: swiftVersionBytes };
    if (args.at(-1) === "--show-sdk-version") return { stdout: "26.5\n" };
    return { stdout: `${sdkPath}\n` };
  };
  const read_file = async (file) => file.endsWith("swift") ? swiftBytes : xcrunBytes;
  const attested = await attestLocalOcrRuntime(fx.context, {
    exec_file, read_file, platform: "darwin",
  });
  assert.equal(attested.sdk_path, sdkPath);
  fx.context.run_lock.observer_contract.swift_version_output_sha256 = "0".repeat(64);
  await assert.rejects(() => attestLocalOcrRuntime(fx.context, {
    exec_file, read_file, platform: "darwin",
  }), /swift --version exact stdout/);
});

test("worker request bytes and body cap are proven before reservation", async () => {
  const fx = await fixture();
  const shard = fx.context.run_lock.shards[0];
  const bytes = Buffer.from("model-0", "utf8");
  const attempt = {
    request_attestation: {
      schema_version: WALMART_LISTING_WORKER_REQUEST_SCHEMA,
      run_lock_sha256: fx.context.run_lock_sha256,
      shard_id: shard.shard_id,
      call_index: shard.call_index,
      call_key: "1".repeat(64),
      prompt_sha256: shard.prompt_sha256,
      execution_permit_sha256: fx.permit.sha256,
      partition_id: fx.partition.partition_id,
      image_sha256: [shard.images[0].model_view_sha256],
    },
  };
  const encoded = bytes.toString("base64");
  assert.doesNotThrow(() => buildWorkerRequestBody(shard, attempt, [encoded]));
  assert.throws(
    () => buildWorkerRequestBody(shard, attempt, [Buffer.from("wrong").toString("base64")]),
    /differs from locked bytes/,
  );
  assert.throws(
    () => buildWorkerRequestBody(shard, attempt, [encoded], 10),
    /body cap/,
  );
});

test("local OCR child gets a minimal allowlisted env with no worker/provider secrets or toolchain overrides", () => {
  const env = buildLocalOcrChildEnv({
    sdk_path: "/locked/MacOSX.sdk",
    module_cache: "/tmp/locked-module-cache",
    staging_directory: "/tmp/locked-staging",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
    SDKROOT: "/locked/MacOSX.sdk",
    CLANG_MODULE_CACHE_PATH: "/tmp/locked-module-cache",
    TMPDIR: "/tmp/locked-staging",
  });
  for (const forbidden of [
    "CODEX_IMAGE_WORKER_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
    "AWS_ACCESS_KEY_ID", "GOOGLE_APPLICATION_CREDENTIALS", "DEVELOPER_DIR",
    "TOOLCHAINS", "SWIFT_EXEC", "HOME",
  ]) assert.equal(Object.hasOwn(env, forbidden), false, forbidden);
});

test("plan performs no writes or network calls", async () => {
  const fx = await fixture();
  const before = await readdir(path.join(fx.directory, "observations"));
  const capture = stdoutCapture();
  await runObserverPlan(observerOptions(fx), {
    stdout: capture.stream,
    load_context: async () => fx.context,
    validate_preflight_certificate: async () => true,
    load_execution_permit: async () => ({
      exact_byte_sha256: fx.permitExactByteSha,
      permit: fx.permit,
    }),
    now: () => "2026-07-18T22:00:00.000Z",
  });
  const after = await readdir(path.join(fx.directory, "observations"));
  assert.deepEqual(after, before);
  assert.equal(capture.json().execution_state.next_state, "PENDING");
  assert.equal(capture.json().assurance.network_calls, 0);
});

test("permit predating the immutable family is rejected before state, network, or writes", async () => {
  const fx = await fixture();
  fx.context.run_lock.created_at = "2026-07-18T21:00:00.001Z";
  let stateCalls = 0;
  await assert.rejects(() => runObserverPlan(observerOptions(fx), {
    stdout: stdoutCapture().stream,
    load_context: async () => fx.context,
    validate_preflight_certificate: async () => true,
    load_execution_permit: async () => ({
      exact_byte_sha256: fx.permitExactByteSha,
      permit: fx.permit,
    }),
    inspect_state: async () => {
      stateCalls += 1;
      throw new Error("must not inspect state");
    },
    now: () => "2026-07-18T22:00:00.000Z",
  }), /predates (?:its|the) immutable family/);
  assert.equal(stateCalls, 0);
  assert.deepEqual(await readdir(path.join(fx.directory, "observations")), []);
});

test("execute reserves before one POST, seals output, and advances exact prefix", async () => {
  const fx = await fixture();
  const worker = fakeWorker(fx);
  const capture = stdoutCapture();
  await runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 1 }),
    injections(fx, worker, capture),
  );

  assert.equal(worker.calls.length, 2);
  assert.equal(worker.calls[0].options.method, "GET");
  assert.equal(worker.calls[0].options.redirect, "error");
  assert.equal(worker.calls[1].options.method, "POST");
  assert.equal(worker.calls[1].options.redirect, "error");
  const attemptPath = path.join(fx.directory, "observations/shard-0.json.attempt.json");
  const observationPath = path.join(fx.directory, "observations/shard-0.json");
  assert.equal((await stat(attemptPath)).mode & 0o777, 0o444);
  assert.equal((await stat(observationPath)).mode & 0o777, 0o444);
  const attempt = JSON.parse(await readFile(attemptPath, "utf8"));
  assert.equal(attempt.execution_permit.sha256, fx.permit.sha256);
  assert.equal(attempt.request_attestation.execution_permit_sha256, fx.permit.sha256);
  assert.equal(attempt.request_attestation.partition_id, fx.partition.partition_id);
  assert.deepEqual(
    attempt.worker_contract.reservation_ledger,
    fx.context.run_lock.observer_contract.reservation_ledger,
  );
  const observation = verifyWalmartListingObservationBatch(JSON.parse(
    await readFile(observationPath, "utf8"),
  ));
  assert.equal(attempt.reserved_at, "2026-07-18T22:00:00.000Z");
  assert.equal(observation.created_at, "2026-07-18T22:00:00.100Z");
  assert.equal(
    observation.created_at,
    observation.worker_receipt.body.reservation_reserved_at,
  );
  assert.deepEqual(
    observation.worker_contract.reservation_ledger,
    fx.context.run_lock.observer_contract.reservation_ledger,
  );
  assert.deepEqual(
    observation.worker_receipt.body.worker_contract.reservation_ledger,
    fx.context.run_lock.observer_contract.reservation_ledger,
  );
  const state = await inspectObserverExecutionState(fx.context, fx.partition);
  assert.equal(state.completed_prefix, 1);
  assert.equal(state.next_state, "DONE");
  assert.equal(capture.json().subscription_calls_consumed, 1);
});

test("completed success becomes INVALID when its sealed attempt no longer binds local OCR", async () => {
  const fx = await fixture();
  const worker = fakeWorker(fx);
  await runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 1 }),
    injections(fx, worker, stdoutCapture()),
  );
  const attemptPath = path.join(fx.directory, "observations/shard-0.json.attempt.json");
  const attempt = JSON.parse(await readFile(attemptPath, "utf8"));
  attempt.local_ocr_sha256 = "0".repeat(64);
  const body = { ...attempt };
  delete body.body_sha256;
  attempt.body_sha256 = walmartListingObservationSha256(body);
  await unlink(attemptPath);
  await writeFile(attemptPath, `${JSON.stringify(attempt)}\n`, { mode: 0o444, flag: "wx" });
  await chmod(attemptPath, 0o444);

  const state = await inspectObserverExecutionState(fx.context, fx.partition);
  assert.equal(state.sequence_valid, false);
  assert.equal(state.rows[0].state, "INVALID");
  assert.match(state.rows[0].reason, /does not bind its reservation\/run-lock/);
});

test("concurrent executors atomically publish one reservation and allow only one POST", async () => {
  const fx = await fixture();
  const worker = fakeWorker(fx);
  const options = observerOptions(fx, { from_call: 0, call_budget: 1 });
  const results = await Promise.allSettled([
    runObserverExecute(options, injections(fx, worker, stdoutCapture())),
    runObserverExecute(options, injections(fx, worker, stdoutCapture())),
  ]);
  assert.equal(results.filter((row) => row.status === "fulfilled").length, 1);
  assert.equal(results.filter((row) => row.status === "rejected").length, 1);
  assert.match(String(results.find((row) => row.status === "rejected").reason), /EEXIST/);
  assert.equal(worker.calls.filter((row) => row.options.method === "POST").length, 1);
  const files = await readdir(path.join(fx.directory, "observations"));
  assert.equal(files.some((name) => name.includes(".staging-")), false);
  const state = await inspectObserverExecutionState(fx.context, fx.partition);
  assert.equal(state.completed_prefix, 1);
  assert.equal(state.next_state, "DONE");
});

test("a staggered executor preserves a still-healthy first POST during in-flight grace", async () => {
  const fx = await fixture();
  const worker = fakeWorker(fx);
  let announcePost;
  const postStarted = new Promise((resolve) => { announcePost = resolve; });
  let releasePost;
  const postReleased = new Promise((resolve) => { releasePost = resolve; });
  const gatedWorker = {
    calls: worker.calls,
    fetch: async (url, options) => {
      if (options.method === "POST") {
        announcePost();
        await postReleased;
      }
      return worker.fetch(url, options);
    },
  };
  const firstCapture = stdoutCapture();
  const first = runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 1 }),
    injections(fx, gatedWorker, firstCapture),
  );
  await postStarted;
  try {
    const planCapture = stdoutCapture();
    await runObserverPlan(
      observerOptions(fx),
      injections(fx, gatedWorker, planCapture, {
        now: () => "2026-07-18T22:00:01.000Z",
      }),
    );
    const plan = planCapture.json();
    assert.equal(plan.execution_state.next_state, "IN_FLIGHT_GRACE");
    assert.equal(plan.execution_state.shards[0].grace_expires_at, "2026-07-18T22:03:30.000Z");
    assert.equal(plan.execution_state.shards[0].grace_remaining_ms, 209_000);
    assert.equal(plan.in_flight_grace, true);
    assert.equal(plan.execution_allowed, false);

    const secondCapture = stdoutCapture();
    const filesBeforeSecondExecute = await readdir(path.join(fx.directory, "observations"));
    await runObserverExecute(
      observerOptions(fx, { from_call: 1, call_budget: 1 }),
      injections(fx, gatedWorker, secondCapture, {
        now: () => "2026-07-18T22:00:01.000Z",
        env: {},
        fetch: async () => { throw new Error("IN_FLIGHT_GRACE must not fetch"); },
        attest_local_ocr_runtime: async () => {
          throw new Error("IN_FLIGHT_GRACE must not attest OCR");
        },
        prepare_local_ocr_batches: async () => {
          throw new Error("IN_FLIGHT_GRACE must not run OCR");
        },
        load_model_images: async () => {
          throw new Error("IN_FLIGHT_GRACE must not load model bytes");
        },
      }),
    );
    const second = secondCapture.json();
    assert.equal(second.action, "IN_FLIGHT_GRACE");
    assert.equal(second.subscription_calls_consumed, 0);
    assert.equal(second.assurance.writes, 0);
    assert.equal(second.assurance.health_gets, 0);
    assert.equal(second.assurance.worker_posts, 0);
    assert.deepEqual(
      await readdir(path.join(fx.directory, "observations")),
      filesBeforeSecondExecute,
    );
    assert.equal(worker.calls.length, 1, "only the first executor's health GET may have completed");
    await assert.rejects(
      () => stat(path.join(fx.directory, "observations/shard-0.json")),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    releasePost();
  }
  await first;
  assert.equal(firstCapture.json().action, "OBSERVE");
  assert.equal(worker.calls.filter((row) => row.options.method === "POST").length, 1);
  const state = await inspectObserverExecutionState(
    fx.context,
    fx.partition,
    "2026-07-18T22:00:02.000Z",
  );
  assert.equal(state.rows[0].state, "COMPLETE");
  assert.equal(state.completed_prefix, 1);
});

test("definitive failed POST is terminalized immediately in the owning process without retry", async () => {
  const fx = await fixture();
  const worker = fakeWorker(fx, { postStatus: 502 });
  const capture = stdoutCapture();
  await runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 1 }),
    injections(fx, worker, capture),
  );
  assert.equal(worker.calls.length, 2);
  assert.equal(capture.json().action, "DEFINITIVE_FAILURE_TERMINALIZE_TECH_ERROR");
  const state = await inspectObserverExecutionState(
    fx.context,
    fx.partition,
    "2026-07-18T22:00:01.000Z",
  );
  assert.equal(state.rows[0].state, "TECH_ERROR_TERMINAL");
  assert.equal(await stat(path.join(fx.directory, "observations/shard-0.json.attempt.json")).then(() => true), true);
  const terminal = verifyWalmartListingObservationArtifact(JSON.parse(
    await readFile(path.join(fx.directory, "observations/shard-0.json"), "utf8"),
  ));
  assert.equal(terminal.schema_version, WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA);
  assert.equal(terminal.execution.pass_eligible, false);
  const terminalState = await inspectObserverExecutionState(fx.context, fx.partition);
  assert.equal(terminalState.rows[0].state, "TECH_ERROR_TERMINAL");
  assert.equal(terminalState.completed_prefix, 1);
});

test("ambiguous transport cannot be terminalized until the full in-flight grace elapses", async () => {
  const fx = await fixture();
  const baseWorker = fakeWorker(fx);
  const calls = [];
  const worker = {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (options.method === "POST") throw new Error("simulated socket reset");
      return baseWorker.fetch(url, options);
    },
  };
  await assert.rejects(() => runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 1 }),
    injections(fx, worker, stdoutCapture()),
  ), /ended ambiguously/);
  assert.equal(calls.length, 2);

  const beforeBoundary = await inspectObserverExecutionState(
    fx.context,
    fx.partition,
    "2026-07-18T22:03:29.999Z",
  );
  assert.equal(beforeBoundary.next_state, "IN_FLIGHT_GRACE");
  assert.equal(beforeBoundary.rows[0].grace_remaining_ms, 1);
  const graceCapture = stdoutCapture();
  await runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 1 }),
    injections(fx, worker, graceCapture, {
      now: () => "2026-07-18T22:03:29.999Z",
    }),
  );
  assert.equal(graceCapture.json().action, "IN_FLIGHT_GRACE");
  assert.equal(calls.length, 2, "grace handling must not issue health or POST calls");

  const terminalCapture = stdoutCapture();
  await runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 1 }),
    injections(fx, worker, terminalCapture, {
      now: () => "2026-07-18T22:03:30.000Z",
    }),
  );
  assert.equal(terminalCapture.json().action, "OFFLINE_TERMINALIZE_TECH_ERROR");
  assert.equal(terminalCapture.json().assurance.model_calls, 0);
  assert.equal(calls.length, 2, "offline terminalization must not issue health or POST calls");
});

test("observation without reservation is INVALID", async () => {
  const fx = await fixture();
  const file = path.join(fx.directory, "observations/shard-0.json");
  await writeFile(file, "{}\n", { mode: 0o444, flag: "wx" });
  await chmod(file, 0o444);
  const state = await inspectObserverExecutionState(fx.context, fx.partition);
  assert.equal(state.sequence_valid, false);
  assert.equal(state.rows[0].state, "INVALID");
  assert.equal(state.rows[0].reason, "observation_without_reservation");
});

test("invalid reservation beyond a pending gap invalidates the whole sequence", async () => {
  const fx = await fixture({ shards: 2 });
  const file = path.join(fx.directory, "observations/shard-1.json.attempt.json");
  await writeFile(file, "reserved\n", { mode: 0o444, flag: "wx" });
  await chmod(file, 0o444);
  const state = await inspectObserverExecutionState(fx.context, fx.partition);
  assert.equal(state.completed_prefix, 0);
  assert.equal(state.sequence_valid, false);
  assert.match(state.sequence_error, /invalid observer artifact state/);
});

test("observer state and prefix are isolated to the selected deterministic partition", async () => {
  const fx = await fixture({ shards: 7 });
  const secondPartition = fx.context.run_lock.observer_partitions[1];
  const attempt = path.join(fx.directory, "observations/shard-6.json.attempt.json");
  await writeFile(attempt, "reserved\n", { mode: 0o444, flag: "wx" });
  await chmod(attempt, 0o444);
  const first = await inspectObserverExecutionState(fx.context, fx.partition);
  assert.equal(first.rows.length, 6);
  assert.equal(first.sequence_valid, true);
  assert.equal(first.next_state, "PENDING");
  const second = await inspectObserverExecutionState(fx.context, secondPartition);
  assert.equal(second.rows.length, 1);
  assert.equal(second.next_state, "INVALID");
  assert.equal(second.sequence_valid, false);
});

test("from-call must equal the completed prefix before health or OCR", async () => {
  const fx = await fixture();
  const worker = fakeWorker(fx);
  await assert.rejects(() => runObserverExecute(
    observerOptions(fx, { from_call: 1, call_budget: 1 }),
    injections(fx, worker, stdoutCapture()),
  ), /must equal exact completed prefix 0/);
  assert.equal(worker.calls.length, 0);
});

test("expired permit blocks execute but plan remains read-only and reports execution_allowed=false", async () => {
  const fx = await fixture({ permitCreatedAt: "2026-07-17T21:00:00.000Z" });
  const worker = fakeWorker(fx);
  await assert.rejects(() => runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 1 }),
    injections(fx, worker, stdoutCapture()),
  ), /permit window has expired/);
  assert.equal(worker.calls.length, 0);
  assert.deepEqual(await readdir(path.join(fx.directory, "observations")), []);
  const capture = stdoutCapture();
  await runObserverPlan(
    observerOptions(fx),
    injections(fx, worker, capture),
  );
  assert.equal(capture.json().execution_allowed, false);
  assert.equal(capture.json().permit_window.reason, "permit_window_expired");
  assert.equal(worker.calls.length, 0);
});

test("209999ms permit headroom blocks plan and execute before health, writes, or model work", async () => {
  const fx = await fixture();
  const worker = fakeWorker(fx);
  const nearExpiry = "2026-07-19T20:56:30.001Z";
  await assert.rejects(() => runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 1 }),
    injections(fx, worker, stdoutCapture(), { now: () => nearExpiry }),
  ), /209999ms remaining; at least 210000ms is required/);
  assert.equal(worker.calls.length, 0);
  assert.deepEqual(await readdir(path.join(fx.directory, "observations")), []);

  const capture = stdoutCapture();
  await runObserverPlan(
    observerOptions(fx),
    injections(fx, worker, capture, { now: () => nearExpiry }),
  );
  const plan = capture.json();
  assert.equal(plan.execution_allowed, false);
  assert.equal(plan.permit_window.reason, "permit_headroom_insufficient");
  assert.equal(plan.permit_window.remaining_ms, 209_999);
  assert.equal(plan.permit_window.required_headroom_ms, 210_000);
  assert.equal(plan.permit_window.headroom_sufficient, false);
  assert.equal(worker.calls.length, 0);
});

test("permit headroom is rechecked before every shard reservation", async () => {
  const fx = await fixture({ shards: 2 });
  const worker = fakeWorker(fx);
  const times = [
    "2026-07-18T22:00:00.000Z",
    "2026-07-18T22:00:00.000Z",
    "2026-07-18T22:00:00.000Z",
    "2026-07-19T20:56:30.001Z",
  ];
  await assert.rejects(() => runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 2 }),
    injections(fx, worker, stdoutCapture(), {
    now: () => times.shift(),
    }),
  ), /209999ms remaining; at least 210000ms is required/);
  assert.equal(worker.calls.length, 2, "one health and only shard-0 POST are allowed");
  const state = await inspectObserverExecutionState(
    fx.context,
    fx.partition,
    "2026-07-19T20:56:30.001Z",
  );
  assert.equal(state.completed_prefix, 1);
  assert.equal(state.rows[0].state, "COMPLETE");
  assert.equal(state.rows[1].state, "PENDING");
  assert.equal(await readdir(path.join(fx.directory, "observations")).then((rows) => (
    rows.some((name) => name.startsWith("shard-1"))
  )), false);
});

test("permit headroom is rechecked after reservation immediately before POST", async () => {
  const fx = await fixture();
  const worker = fakeWorker(fx);
  const times = [
    "2026-07-18T22:00:00.000Z",
    "2026-07-19T20:56:29.999Z",
    "2026-07-19T20:56:30.001Z",
  ];
  await assert.rejects(() => runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 1 }),
    injections(fx, worker, stdoutCapture(), { now: () => times.shift() }),
  ), /209999ms remaining; at least 210000ms is required/);
  assert.equal(worker.calls.length, 1, "only health may run; the model POST is forbidden");
  const files = await readdir(path.join(fx.directory, "observations"));
  assert.deepEqual(files, ["shard-0.json.attempt.json"]);
  const state = await inspectObserverExecutionState(
    fx.context,
    fx.partition,
    "2026-07-19T20:56:30.001Z",
  );
  assert.equal(state.next_state, "IN_FLIGHT_GRACE");
  assert.equal(state.rows[0].grace_remaining_ms, 209_998);
});

test("all selected OCR must succeed before health-complete execution writes a reservation", async () => {
  const fx = await fixture({ shards: 2 });
  const worker = fakeWorker(fx);
  await assert.rejects(() => runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 2 }),
    injections(fx, worker, stdoutCapture(), {
    prepare_local_ocr_batches: async () => { throw new Error("OCR shard 2 failed"); },
    }),
  ), /OCR shard 2 failed/);
  assert.equal(worker.calls.length, 1, "only the single health GET is allowed");
  assert.deepEqual(await readdir(path.join(fx.directory, "observations")), []);
});

test("all selected model request bytes are preflighted before the first reservation or POST", async () => {
  const fx = await fixture({ shards: 2 });
  const worker = fakeWorker(fx);
  await assert.rejects(() => runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 2 }),
    injections(fx, worker, stdoutCapture(), {
    load_model_images: async (_context, shard) => [
      Buffer.from(shard.call_index === 0 ? "model-0" : "wrong-shard-1", "utf8").toString("base64"),
    ],
    }),
  ), /differs from locked bytes/);
  assert.equal(worker.calls.length, 1, "only authenticated health is allowed before request preflight");
  assert.deepEqual(await readdir(path.join(fx.directory, "observations")), []);
});

test("wrong worker token stops at authenticated health before OCR, reservation, or model POST", async () => {
  const fx = await fixture();
  const worker = fakeWorker(fx);
  let ocrCalls = 0;
  await assert.rejects(() => runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 1 }),
    injections(fx, worker, stdoutCapture(), {
    env: { CODEX_IMAGE_WORKER_TOKEN: "wrong-token" },
    prepare_local_ocr_batches: async () => {
      ocrCalls += 1;
      throw new Error("must not run");
    },
    }),
  ), /worker health differs/);
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.calls[0].options.method, "GET");
  assert.equal(ocrCalls, 0);
  assert.deepEqual(await readdir(path.join(fx.directory, "observations")), []);
});

test("old run-lock without a reservation-ledger contract is rejected before any I/O", async () => {
  const fx = await fixture();
  delete fx.context.run_lock.observer_contract.reservation_ledger;
  const worker = fakeWorker(fx);
  await assert.rejects(() => runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 1 }),
    injections(fx, worker, stdoutCapture()),
  ), /run_lock\.observer_contract\.reservation_ledger/);
  assert.equal(worker.calls.length, 0);
  assert.deepEqual(await readdir(path.join(fx.directory, "observations")), []);
});

test("authenticated health rejects every ledger-field, missing/extra object, and build mismatch", async () => {
  const fx = await fixture();
  const mutations = [
    ["old schema", (body) => {
      body.reservation_ledger.schema_version = "vision-call-reservation-ledger-contract/v0";
    }],
    ["ledger id", (body) => {
      body.reservation_ledger.ledger_id = "ledger-33333333-3333-4333-8333-333333333333";
    }],
    ["epoch", (body) => {
      body.reservation_ledger.ledger_epoch = "epoch-44444444-4444-4444-8444-444444444444";
    }],
    ["path", (body) => {
      body.reservation_ledger.state_directory_path_sha256 = "6".repeat(64);
    }],
    ["directory", (body) => {
      body.reservation_ledger.directory_identity_sha256 = "7".repeat(64);
    }],
    ["identity artifact", (body) => {
      body.reservation_ledger.identity_artifact_sha256 = "8".repeat(64);
    }],
    ["missing", (body) => { delete body.reservation_ledger; }],
    ["extra", (body) => { body.reservation_ledger.unexpected = true; }],
    ["build", (body) => { body.worker_build = `sha256:${"9".repeat(64)}`; }],
  ];
  for (const [label, mutateHealth] of mutations) {
    const worker = fakeWorker(fx, { mutateHealth });
    await assert.rejects(() => runObserverExecute(
      observerOptions(fx, { from_call: 0, call_budget: 1 }),
      injections(fx, worker, stdoutCapture()),
    ), /reservation_ledger|worker health differs/, label);
    assert.equal(worker.calls.length, 1, label);
    assert.equal(worker.calls[0].options.method, "GET", label);
    assert.deepEqual(await readdir(path.join(fx.directory, "observations")), [], label);
  }
});

test("POST response ledger path/epoch/build/missing/extra mismatches terminalize fail-closed", async () => {
  const mutations = [
    ["epoch", (body) => {
      body.reservation_ledger.ledger_epoch = "epoch-44444444-4444-4444-8444-444444444444";
    }],
    ["path", (body) => {
      body.reservation_ledger.state_directory_path_sha256 = "6".repeat(64);
    }],
    ["build", (body) => { body.worker_build = `sha256:${"9".repeat(64)}`; }],
    ["missing", (body) => { delete body.reservation_ledger; }],
    ["extra", (body) => { body.reservation_ledger.unexpected = true; }],
  ];
  for (const [label, mutateResponse] of mutations) {
    const fx = await fixture();
    const worker = fakeWorker(fx, { mutateResponse });
    const capture = stdoutCapture();
    await runObserverExecute(
      observerOptions(fx, { from_call: 0, call_budget: 1 }),
      injections(fx, worker, capture),
    );
    assert.equal(capture.json().action, "DEFINITIVE_FAILURE_TERMINALIZE_TECH_ERROR", label);
    assert.equal(worker.calls.length, 2, label);
    const terminal = verifyWalmartListingObservationArtifact(JSON.parse(
      await readFile(path.join(fx.directory, "observations/shard-0.json"), "utf8"),
    ));
    assert.equal(terminal.schema_version, WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA, label);
    assert.equal(terminal.execution.pass_eligible, false, label);
    assert.deepEqual(
      terminal.worker_contract.reservation_ledger,
      fx.context.run_lock.observer_contract.reservation_ledger,
      label,
    );
  }
});

test("worker health must expose the exact locked vision timeout", async () => {
  const fx = await fixture();
  const worker = fakeWorker(fx, { healthVisionTimeoutMs: 179_999 });
  await assert.rejects(() => runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 1 }),
    injections(fx, worker, stdoutCapture()),
  ), /worker health differs/);
  assert.equal(worker.calls.length, 1);
  assert.deepEqual(await readdir(path.join(fx.directory, "observations")), []);
});

test("real HTTP 307 cannot redirect or replay the one-shot model POST", async (t) => {
  const fx = await fixture();
  const counts = { health: 0, analyze: 0, sink: 0 };
  const observer = fx.context.run_lock.observer_contract;
  const server = http.createServer((request, reply) => {
    if (request.url === "/health") {
      counts.health += 1;
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify({
        ok: true,
        health_authorization_verified: request.headers.authorization === "Bearer secret-test-token",
        worker_build: `sha256:${fx.workerBuildSha}`,
        vision_providers: ["claude_cli_subscription"],
        vision_contracts: {
          claude_cli_subscription: {
            model: "sonnet", reasoning_effort: null,
            cli_version: observer.cli_version, node_version: observer.node_version,
            platform: observer.platform, arch: observer.arch,
          },
        },
        vision_timeout_ms: observer.vision_timeout_ms,
        signed_vision_receipts: {
          schema_version: WALMART_LISTING_WORKER_RECEIPT_SCHEMA,
          key_id: observer.worker_receipt_key_id,
          public_key_spki_sha256: fx.key.publicSha,
        },
        durable_call_key_reservations: true,
        reservation_ledger: structuredClone(observer.reservation_ledger),
      }));
      return;
    }
    if (request.url === "/analyze-claude") {
      counts.analyze += 1;
      request.resume();
      reply.writeHead(307, { location: "/sink" });
      reply.end();
      return;
    }
    counts.sink += 1;
    request.resume();
    reply.writeHead(500).end();
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("sandbox does not permit a loopback test server");
      return;
    }
    throw error;
  }
  t.after(() => server.close());
  const address = server.address();
  fx.context.run_lock.observer_contract.worker_analyze_url =
    `http://127.0.0.1:${address.port}/analyze-claude`;
  await assert.rejects(() => runObserverExecute(
    observerOptions(fx, { from_call: 0, call_budget: 1 }),
    injections(fx, { fetch: globalThis.fetch, calls: [] }, stdoutCapture()),
  ), /ended ambiguously/);
  assert.deepEqual(counts, { health: 1, analyze: 1, sink: 0 });
  const state = await inspectObserverExecutionState(
    fx.context,
    fx.partition,
    "2026-07-18T22:00:01.000Z",
  );
  assert.equal(state.next_state, "IN_FLIGHT_GRACE");
});
