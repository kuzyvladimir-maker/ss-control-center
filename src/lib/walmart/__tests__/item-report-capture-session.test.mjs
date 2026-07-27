import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES,
  WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_CHAIN_BYTES,
  WalmartItemReportManualReviewRequiredError,
  computeWalmartSellerAccountFingerprint,
  runWalmartItemReportCapturePhase,
} from "../item-report-capture-session.ts";
import {
  verifyWalmartItemReportCatalogSource,
  verifyWalmartItemReportPublishedSource,
  walmartItemReportTrustedExchangeSha256,
  buildWalmartItemReportV6CreateRequestManifest,
  walmartItemReportUtf8Sha256,
} from "../item-report-published-source.ts";
import {
  buildWalmartItemReportReissuePermit,
  canonicalWalmartItemReportReissuePermitBytes,
  walmartItemReportReissueOwnerConfirmation,
  walmartItemReportReissuePermitArtifactSha256,
} from "../item-report-reissue-permit.ts";
import {
  DEFAULT_CAPTURE_ROOT,
  WALMART_ITEM_REPORT_REISSUE_V1_RETIRED_CODE,
  createWalmartItemReportCliTransport,
  isWalmartItemReportCaptureDirectEntrypoint,
  main as cliMain,
  parseWalmartItemReportCaptureCliArgs,
} from "../../../../scripts/capture-walmart-item-report-source.mjs";

const encoder = new TextEncoder();
const REQUEST_ID = "item-report-request-1";
const INITIAL_URL = "https://walmart-reports.s3.amazonaws.com/reports/item.csv?X-Amz-Signature=secret-a";
const FINAL_URL = "https://item-report.cloudfront.net/reports/item.csv?token=secret-b";
const CSV_A = [
  "SKU,ProductName,ProductId,ProductIdType,PublishedStatus,ProductCondition,Brand,LifecycleStatus",
  "SKU-A,Alpha Bread,111111111111,UPC,PUBLISHED,New,Alpha Brand,ACTIVE",
  "SKU-HIDDEN,Hidden Bread,222222222222,UPC,UNPUBLISHED,New,Hidden Brand,ARCHIVED",
].join("\r\n") + "\r\n";
const CSV_B = CSV_A.replace("SKU-A", "SKU-B");

function bytes(value) {
  return typeof value === "string" ? encoder.encode(value) : value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function presignedTransportRequest(overrides = {}) {
  return {
    kind: "presigned-file",
    method: "GET",
    endpoint: null,
    query: {},
    url: INITIAL_URL,
    headers: { accept: "application/octet-stream", "accept-encoding": "identity" },
    body: null,
    correlation_id: null,
    redirect: "manual",
    max_response_bytes: 1024,
    max_redirect_response_bytes: WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES,
    timeout_ms: 50,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function walmartTransportRequest(overrides = {}) {
  return {
    kind: "walmart-api",
    method: "GET",
    endpoint: "/v3/reports/reportRequests/request-1",
    query: {},
    url: null,
    headers: { accept: "application/json", "accept-encoding": "identity" },
    body: null,
    correlation_id: "request-correlation",
    redirect: "manual",
    max_response_bytes: 1024,
    max_redirect_response_bytes: WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES,
    timeout_ms: 50,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function crashOnceAt(relativePath) {
  let crashed = false;
  return async (writtenPath) => {
    if (!crashed && writtenPath === relativePath) {
      crashed = true;
      throw new Error(`simulated crash after ${relativePath}`);
    }
  };
}

function response(body, { status = 200, contentType = "application/json", headers = {} } = {}) {
  const payload = bytes(body);
  return {
    status,
    headers: {
      "content-type": contentType,
      "content-length": String(payload.byteLength),
      ...headers,
    },
    body: payload,
  };
}

function json(value) {
  return JSON.stringify(value);
}

function fixturePayloads() {
  return {
    create: json({
      requestId: REQUEST_ID,
      requestSubmissionDate: "2026-07-18T10:00:00.000Z",
      reportType: "ITEM",
      reportVersion: "v6",
    }),
    ready: json({
      requestId: REQUEST_ID,
      requestStatus: "READY",
      reportType: "ITEM",
      reportVersion: "v6",
      createdTime: "2026-07-18T10:00:00.000Z",
      reportGenerationDate: "2026-07-18T10:03:00.000Z",
    }),
    locator: json({
      requestId: REQUEST_ID,
      requestSubmissionDate: "2026-07-18T10:00:00.000Z",
      reportGenerationDate: "2026-07-18T10:03:00.000Z",
      downloadURL: INITIAL_URL,
      downloadURLExpirationTime: "2026-07-18T11:30:00.000Z",
    }),
  };
}

function makeClock() {
  let tick = 0;
  const start = Date.parse("2026-07-18T10:05:00.000Z");
  return () => new Date(start + tick++ * 1000);
}

function makeUuid() {
  let value = 0;
  return () => `capture-id-${String(++value).padStart(4, "0")}`;
}

async function ensureDefaultCaptureRoot() {
  await mkdir(DEFAULT_CAPTURE_ROOT, { recursive: true, mode: 0o700 });
  await chmod(DEFAULT_CAPTURE_ROOT, 0o700);
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wm-item-capture-test-"));
  await chmod(root, 0o700);
  const session = path.join(root, "session-1");
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { root, session };
}

function input(root, session, phase, execute = true) {
  const value = {
    execute,
    phase,
    store_index: 1,
    session_dir: session,
    allowed_capture_root: root,
  };
  if (execute && phase === "request") {
    value.owner_reissue_permit = testRequestPermit(session);
  }
  return value;
}

function accountScope() {
  return {
    channel: "WALMART_US",
    store_index: 1,
    seller_account_fingerprint_sha256: "a".repeat(64),
  };
}

const TEST_SOURCE_EVIDENCE_RELEASE_SHA256 = "c".repeat(64);

function testPriorAbsenceOnly() {
  return {
    session_name: "prior-ambiguous-session",
    session_id: "prior-ambiguous-session-id",
    session_authority_sha256: "1".repeat(64),
    create_manifest_sha256: "2".repeat(64),
    request_reserved_sha256: "3".repeat(64),
    manual_review_sha256: "4".repeat(64),
    manual_review_reason_code: "AMBIGUOUS_POST_NETWORK_OUTCOME",
    manual_review_retry_forbidden: true,
    reconciliation_id: "5".repeat(24),
    reconciliation_scope_sha256: "6".repeat(64),
    reconciliation_result_sha256: "7".repeat(64),
    reconciliation_complete_sha256: "8".repeat(64),
    response_set_sha256: "9".repeat(64),
    reconciliation_completed_at: "2026-07-18T09:50:00.000Z",
    outcome: "ABSENCE_ONLY",
    observed_row_count: 0,
    candidate_count: 0,
    exact_correlation_match_count: 0,
    duplicate_request_id_count: 0,
    request_id_adopted: false,
    original_request_complete_written: false,
  };
}

function testCorrelation(id) {
  return { id, sha256: walmartItemReportUtf8Sha256(id) };
}

function testRequestPermit(session, scope = accountScope()) {
  const sessionName = path.basename(path.resolve(session));
  const identity = sha256(sessionName).slice(0, 20);
  const authority = {
    schema_version: "walmart-item-report-capture-session/v1",
    session_id: `test-session-${identity}`,
    created_at: "2026-07-18T09:59:00.000Z",
    account_scope: scope,
    primary_correlations: {
      create: testCorrelation(`test-create-${identity}`),
      ready_status: testCorrelation(`test-ready-${identity}`),
      download_locator: testCorrelation(`test-locator-${identity}`),
      report_file: testCorrelation(`test-file-${identity}`),
    },
    trust_statement: {
      adapter_atomic_integrity: true,
      walmart_signature_claimed: false,
      tls_server_authenticity_claimed_by_artifact: false,
    },
  };
  const manifest = buildWalmartItemReportV6CreateRequestManifest({
    account_scope: scope,
    request_correlation_id_sha256: authority.primary_correlations.create.sha256,
  });
  const permit = buildWalmartItemReportReissuePermit({
    permit_id: `test-permit-${identity}`,
    approved_by: "test-owner",
    decision_ref: `urn:sscc:test-owner-decision:${identity}`,
    source_evidence_release_sha256: TEST_SOURCE_EVIDENCE_RELEASE_SHA256,
    account_scope: scope,
    prior_absence_only: testPriorAbsenceOnly(),
    replacement_session_name: sessionName,
    replacement_session_authority: authority,
    replacement_create_request_manifest: manifest,
    issued_at: "2026-07-18T10:00:00.000Z",
    expires_at: "2026-07-18T10:30:00.000Z",
    prior_evidence_fresh_until: "2026-07-19T09:50:00.000Z",
  });
  const artifactBytes = canonicalWalmartItemReportReissuePermitBytes(permit);
  return {
    artifact_bytes: artifactBytes,
    expected_artifact_sha256: walmartItemReportReissuePermitArtifactSha256(artifactBytes),
    expected_permit_sha256: permit.permit_sha256,
    expected_source_evidence_release_sha256: TEST_SOURCE_EVIDENCE_RELEASE_SHA256,
    owner_confirmation: walmartItemReportReissueOwnerConfirmation(permit),
    prior_absence_only: testPriorAbsenceOnly(),
  };
}

function happyTransport({ redirect = true } = {}) {
  const requests = [];
  const payloads = fixturePayloads();
  let fileHop = 0;
  return {
    requests,
    async send(request) {
      requests.push(request);
      if (request.method === "POST") {
        return response(payloads.create, {
          headers: { "wm_qos.correlation_id": request.correlation_id },
        });
      }
      if (request.kind === "walmart-api" && request.endpoint.includes("reportRequests/")) {
        return response(payloads.ready, {
          headers: { "wm_qos.correlation_id": request.correlation_id },
        });
      }
      if (request.kind === "walmart-api" && request.endpoint === "/v3/reports/downloadReport") {
        return response(payloads.locator, {
          headers: { "wm_qos.correlation_id": request.correlation_id },
        });
      }
      if (request.kind === "presigned-file") {
        fileHop += 1;
        if (redirect && fileHop === 1) {
          return response(new Uint8Array(), {
            status: 307,
            contentType: "application/octet-stream",
            headers: { location: FINAL_URL },
          });
        }
        return response(CSV_A, { contentType: "text/csv" });
      }
      throw new Error("unexpected request");
    },
  };
}

function refreshingTransport({ firstLocatorExpired = false, firstFileFails = false } = {}) {
  const requests = [];
  const payloads = fixturePayloads();
  let locatorAttempt = 0;
  let fileAttempt = 0;
  return {
    requests,
    get locatorAttempts() { return locatorAttempt; },
    get fileAttempts() { return fileAttempt; },
    async send(request) {
      requests.push(request);
      if (request.method === "POST") {
        return response(payloads.create, { headers: { "wm_qos.correlation_id": request.correlation_id } });
      }
      if (request.kind === "walmart-api" && request.endpoint.includes("reportRequests/")) {
        return response(payloads.ready, { headers: { "wm_qos.correlation_id": request.correlation_id } });
      }
      if (request.kind === "walmart-api") {
        locatorAttempt += 1;
        const locator = JSON.parse(payloads.locator);
        locator.downloadURL = `https://walmart-reports.s3.amazonaws.com/reports/item-${locatorAttempt}.csv?X-Amz-Signature=private-${locatorAttempt}`;
        locator.downloadURLExpirationTime = firstLocatorExpired && locatorAttempt === 1
          ? "2026-07-18T10:04:00.000Z"
          : "2026-07-18T11:30:00.000Z";
        return response(json(locator), { headers: { "wm_qos.correlation_id": request.correlation_id } });
      }
      fileAttempt += 1;
      if (firstFileFails && fileAttempt === 1) throw new Error("transient presigned failure");
      return response(CSV_A, { contentType: "text/csv" });
    },
  };
}

async function runRefreshThroughDownload(t, options) {
  const { root, session } = await workspace(t);
  const transport = refreshingTransport(options);
  const dependencies = {
    transport,
    account_scope: accountScope(),
    now: makeClock(),
    random_uuid: makeUuid(),
  };
  await runWalmartItemReportCapturePhase(input(root, session, "request"), dependencies);
  await runWalmartItemReportCapturePhase(input(root, session, "poll"), dependencies);
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "download"), dependencies),
    options.firstLocatorExpired ? /expired/ : /retry requires a new invocation/,
  );
  const downloaded = await runWalmartItemReportCapturePhase(
    input(root, session, "download"),
    dependencies,
  );
  return { root, session, transport, dependencies, downloaded };
}

async function runHappyThroughDownload(t, options = {}) {
  const { root, session } = await workspace(t);
  const transport = happyTransport(options);
  const dependencies = {
    transport,
    account_scope: accountScope(),
    now: makeClock(),
    random_uuid: makeUuid(),
  };
  await runWalmartItemReportCapturePhase(input(root, session, "request"), dependencies);
  await runWalmartItemReportCapturePhase(input(root, session, "poll"), dependencies);
  await runWalmartItemReportCapturePhase(input(root, session, "download"), dependencies);
  return { root, session, transport, dependencies };
}

test("default plan and CLI default perform zero network and zero filesystem writes", async (t) => {
  const { root, session } = await workspace(t);
  await rm(root, { recursive: true, force: true });
  let networkCalls = 0;
  const result = await runWalmartItemReportCapturePhase(input(root, session, "request", false), {
    transport: { send: async () => { networkCalls += 1; throw new Error("must not run"); } },
  });
  assert.equal(result.mode, "PLAN");
  assert.equal(result.network_calls, 0);
  assert.equal(networkCalls, 0);
  await assert.rejects(() => stat(root), /ENOENT/);

  let stdout = "";
  const cliResult = await cliMain([], {
    fetch_impl: async () => { throw new Error("default CLI must not fetch"); },
    stdout: (value) => { stdout += value; },
  });
  assert.equal(cliResult.mode, "PLAN");
  assert.equal(JSON.parse(stdout).network_calls, 0);
  assert.throws(
    () => parseWalmartItemReportCaptureCliArgs(["--execute", "--phase=request"]),
    (error) => error.code === WALMART_ITEM_REPORT_REISSUE_V1_RETIRED_CODE,
  );
  assert.throws(
    () => parseWalmartItemReportCaptureCliArgs(["--session-dir=relative/session"]),
    /absolute path before normalization/,
  );

  const liveRoot = await mkdtemp(path.join(os.tmpdir(), "wm-item-missing-permit-"));
  await chmod(liveRoot, 0o700);
  const liveSession = path.join(liveRoot, "must-not-be-created");
  t.after(async () => rm(liveRoot, { recursive: true, force: true }));
  let liveCalls = 0;
  await assert.rejects(
    () => runWalmartItemReportCapturePhase({
      execute: true,
      phase: "request",
      store_index: 1,
      session_dir: liveSession,
      allowed_capture_root: liveRoot,
    }, {
      transport: { send: async () => { liveCalls += 1; throw new Error("must not run"); } },
      account_scope: accountScope(),
    }),
    (error) => error.code === "MISSING_OWNER_REISSUE_PERMIT",
  );
  assert.equal(liveCalls, 0);
  await assert.rejects(() => stat(liveSession), /ENOENT/);
  assert.throws(
    () => parseWalmartItemReportCaptureCliArgs([
      "--execute",
      "--phase=request",
      "--store-index=1",
      `--session-dir=${liveSession}`,
    ]),
    (error) => error.code === WALMART_ITEM_REPORT_REISSUE_V1_RETIRED_CODE,
  );
});

test("bundled helper never mistakes the frozen executor for its own CLI", () => {
  const frozenBundle = "/private/tmp/release/walmart-item-report-reissue-v2-frozen-executor.bundle.mjs";
  assert.equal(
    isWalmartItemReportCaptureDirectEntrypoint(frozenBundle, frozenBundle),
    false,
  );
  const direct = "/private/tmp/release/capture-walmart-item-report-source.mjs";
  assert.equal(isWalmartItemReportCaptureDirectEntrypoint(direct, direct), true);
});

test("full phased capture follows manual redirects without auth and compiles through strongest verifier", async (t) => {
  const { session, transport, dependencies, root } = await runHappyThroughDownload(t);
  const result = await runWalmartItemReportCapturePhase(input(root, session, "compile"), dependencies);
  assert.equal(result.state, "COMPILED");
  assert.equal(result.network_calls, 0);
  assert.equal(JSON.stringify(result).includes("secret-"), false);

  const fileRequests = transport.requests.filter((request) => request.kind === "presigned-file");
  assert.equal(fileRequests.length, 2);
  assert.deepEqual(fileRequests.map((request) => request.url), [INITIAL_URL, FINAL_URL]);
  for (const request of fileRequests) {
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers["accept-encoding"], "identity");
    const headerNames = Object.keys(request.headers).map((name) => name.toLowerCase());
    assert.equal(headerNames.includes("authorization"), false);
    assert.equal(headerNames.includes("wm_sec.access_token"), false);
  }

  const sanitizedBytes = await readFile(result.sanitized_source_path);
  const sanitized = sanitizedBytes.toString("utf8");
  assert.equal(sanitized.includes(INITIAL_URL), false);
  assert.equal(sanitized.includes(FINAL_URL), false);
  assert.equal(sanitized.includes("secret-a"), false);
  assert.equal(sanitized.includes("secret-b"), false);
  const publishedSource = verifyWalmartItemReportPublishedSource(
    JSON.parse(sanitized),
  );
  assert.equal(publishedSource.rows.length, 1);
  assert.equal(publishedSource.rows[0].sku, "SKU-A");

  const sanitizedCatalogBytes = await readFile(
    result.sanitized_catalog_source_path,
  );
  const sanitizedCatalog = sanitizedCatalogBytes.toString("utf8");
  assert.equal(sanitizedCatalog.includes(INITIAL_URL), false);
  assert.equal(sanitizedCatalog.includes(FINAL_URL), false);
  assert.equal(sanitizedCatalog.includes("secret-a"), false);
  assert.equal(sanitizedCatalog.includes("secret-b"), false);
  const catalogSource = verifyWalmartItemReportCatalogSource(
    JSON.parse(sanitizedCatalog),
  );
  assert.deepEqual(
    catalogSource.rows.map((row) => [
      row.sku,
      row.reported_brand,
      row.published_status,
      row.reported_lifecycle_status,
    ]),
    [
      ["SKU-A", "Alpha Brand", "PUBLISHED", "ACTIVE"],
      ["SKU-HIDDEN", "Hidden Brand", "UNPUBLISHED", "ARCHIVED"],
    ],
  );
  assert.equal(catalogSource.published_source.source_id, publishedSource.source_id);
  assert.equal(
    catalogSource.published_source.body_sha256,
    publishedSource.body_sha256,
  );
  assert.equal(result.published_source_id, publishedSource.source_id);
  assert.equal(result.published_source_body_sha256, publishedSource.body_sha256);
  assert.equal(result.sanitized_source_sha256, sha256(sanitizedBytes));
  assert.equal(result.catalog_source_id, catalogSource.source_id);
  assert.equal(result.catalog_source_body_sha256, catalogSource.body_sha256);
  assert.equal(
    result.sanitized_catalog_source_sha256,
    sha256(sanitizedCatalogBytes),
  );
  const compileCheckpoint = JSON.parse(await readFile(
    path.join(session, "checkpoints/99-compile-complete.json"),
    "utf8",
  ));
  assert.equal(compileCheckpoint.strongest_capture_aware_verifier, true);
  assert.equal(compileCheckpoint.source_id, publishedSource.source_id);
  assert.equal(compileCheckpoint.body_sha256, publishedSource.body_sha256);
  assert.equal(compileCheckpoint.sanitized_source_sha256, sha256(sanitizedBytes));
  assert.equal(compileCheckpoint.catalog_source_id, catalogSource.source_id);
  assert.equal(compileCheckpoint.catalog_body_sha256, catalogSource.body_sha256);
  assert.equal(compileCheckpoint.catalog_strongest_capture_aware_verifier, true);
  assert.equal(
    compileCheckpoint.sanitized_catalog_source_path,
    "sanitized/item-report-catalog-source.json",
  );
  assert.equal(
    compileCheckpoint.sanitized_catalog_source_sha256,
    sha256(sanitizedCatalogBytes),
  );
  assert.equal(result.compile_checkpoint_path, path.join(
    result.session_dir,
    "checkpoints/99-compile-complete.json",
  ));
  assert.equal(
    result.compile_checkpoint_sha256,
    sha256(await readFile(result.compile_checkpoint_path)),
  );
  assert.equal((await stat(result.sanitized_source_path)).mode & 0o777, 0o600);
  assert.equal(
    (await stat(result.sanitized_catalog_source_path)).mode & 0o777,
    0o600,
  );

  const locatorPrivate = await readFile(
    path.join(session, "capture/30-locator-0001-response-private.bin"),
    "utf8",
  );
  assert.equal(locatorPrivate.includes(INITIAL_URL), true);
  assert.equal((await stat(path.join(session, "capture/30-locator-0001-response-private.bin"))).mode & 0o777, 0o600);
});

test("retained trusted exchange seal rejects body A/B swap and a recomputed loose seal", async (t) => {
  const { root, session, dependencies } = await runHappyThroughDownload(t, { redirect: false });
  const selection = JSON.parse(await readFile(path.join(session, "trusted/49-file-selection.json"), "utf8"));
  const bodyPath = path.join(session, selection.response_body_path);
  assert.equal(bytes(CSV_A).byteLength, bytes(CSV_B).byteLength);
  await writeFile(bodyPath, bytes(CSV_B), { mode: 0o600 });

  const manifest = new Uint8Array(await readFile(path.join(session, selection.request_manifest_path)));
  const http = JSON.parse(await readFile(path.join(session, selection.response_http_path), "utf8"));
  const forgedLooseSeal = walmartItemReportTrustedExchangeSha256({
    request_manifest_bytes: manifest,
    request_correlation_id_sha256: selection.request_correlation_id_sha256,
    response_payload_bytes: bytes(CSV_B),
    http,
  });
  await writeFile(
    path.join(session, "capture/forged-loose-exchange-seal.json"),
    JSON.stringify({ sha256: forgedLooseSeal }),
    { mode: 0o600, flag: "wx" },
  );
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "compile"), dependencies),
    /response bytes and trusted seal/,
  );
  await assert.rejects(() => stat(path.join(session, "sanitized/90-item-report-published-source.json")), /ENOENT/);
  await assert.rejects(
    () => stat(path.join(session, "sanitized/item-report-catalog-source.json")),
    /ENOENT/,
  );
});

test("ambiguous or partially checkpointed POST becomes terminal manual-review with no retry", async (t) => {
  const first = await workspace(t);
  let calls = 0;
  const dependencies = {
    transport: { send: async () => { calls += 1; throw new Error("ambiguous"); } },
    account_scope: accountScope(),
    now: makeClock(),
    random_uuid: makeUuid(),
  };
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(first.root, first.session, "request"), dependencies),
    WalmartItemReportManualReviewRequiredError,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(first.root, first.session, "request"), dependencies),
    WalmartItemReportManualReviewRequiredError,
  );
  assert.equal(calls, 1);

  const second = await workspace(t);
  let partialCalls = 0;
  const partial = {
    transport: { send: async () => { partialCalls += 1; throw new Error("must not run"); } },
    account_scope: accountScope(),
    now: makeClock(),
    random_uuid: makeUuid(),
    after_immutable_write: (relativePath) => {
      if (relativePath === "checkpoints/10-request-reserved.json") throw new Error("simulated process death");
    },
  };
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(second.root, second.session, "request"), partial),
    /simulated process death/,
  );
  assert.equal(partialCalls, 0);
  delete partial.after_immutable_write;
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(second.root, second.session, "request"), partial),
    WalmartItemReportManualReviewRequiredError,
  );
  assert.equal(partialCalls, 0);
});

test("concurrent request invocations consume one exclusive POST reservation", async (t) => {
  const { root, session } = await workspace(t);
  const transport = happyTransport({ redirect: false });
  let releaseFirstManifest;
  const firstManifestReleased = new Promise((resolve) => { releaseFirstManifest = resolve; });
  let firstManifestWritten;
  const firstManifestObserved = new Promise((resolve) => { firstManifestWritten = resolve; });
  const shared = {
    transport,
    account_scope: accountScope(),
    now: makeClock(),
    random_uuid: makeUuid(),
  };
  const first = runWalmartItemReportCapturePhase(input(root, session, "request"), {
    ...shared,
    after_immutable_write: async (relativePath) => {
      if (relativePath === "capture/10-create-request-manifest.json") {
        firstManifestWritten();
        await firstManifestReleased;
      }
    },
  });
  await firstManifestObserved;
  const second = runWalmartItemReportCapturePhase(input(root, session, "request"), shared);
  const secondResult = await second;
  releaseFirstManifest();
  const firstResult = await Promise.allSettled([first]);

  assert.equal(secondResult.state, "REQUESTED");
  assert.equal(firstResult[0].status, "rejected");
  assert.equal(firstResult[0].reason.code, "REQUEST_ATTEMPT_ALREADY_RESERVED");
  assert.equal(transport.requests.filter((request) => request.method === "POST").length, 1);
});

test("permit expiry after reservation writes manual review and sends zero POSTs", async (t) => {
  const { root, session } = await workspace(t);
  const transport = happyTransport();
  let currentTime = Date.parse("2026-07-18T10:05:00.000Z");
  const dependencies = {
    transport,
    account_scope: accountScope(),
    now: () => new Date(currentTime),
    random_uuid: makeUuid(),
    after_immutable_write: (relativePath) => {
      if (relativePath === "checkpoints/10-request-reserved.json") {
        currentTime = Date.parse("2026-07-18T10:30:00.001Z");
      }
    },
  };

  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "request"), dependencies),
    (error) => error instanceof WalmartItemReportManualReviewRequiredError,
  );
  assert.equal(transport.requests.length, 0);
  const manualReview = JSON.parse(await readFile(
    path.join(session, "checkpoints/19-request-manual-review.json"),
    "utf8",
  ));
  assert.equal(manualReview.reason_code, "OWNER_REISSUE_PERMIT_EXPIRED_AFTER_RESERVATION");
  assert.equal(manualReview.retry_forbidden, true);
  await stat(path.join(session, "checkpoints/10-request-reserved.json"));
  await assert.rejects(() => stat(path.join(session, "capture/11-create-response.raw")), /ENOENT/u);
});

test("illegal transitions and duplicate invocations fail before extra network calls", async (t) => {
  const { root, session } = await workspace(t);
  const transport = happyTransport({ redirect: false });
  const dependencies = {
    transport,
    account_scope: accountScope(),
    now: makeClock(),
    random_uuid: makeUuid(),
  };
  await runWalmartItemReportCapturePhase(input(root, session, "request"), dependencies);
  const calls = transport.requests.length;
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "request"), dependencies),
    /request phase is already complete/,
  );
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "download"), dependencies),
    /download requires a captured READY response/,
  );
  assert.equal(transport.requests.length, calls);
});

test("active credential scope gates every network phase while compile remains offline", async (t) => {
  const { root, session } = await workspace(t);
  const transport = happyTransport({ redirect: false });
  const dependencies = {
    transport,
    account_scope: accountScope(),
    now: makeClock(),
    random_uuid: makeUuid(),
  };
  await runWalmartItemReportCapturePhase(input(root, session, "request"), dependencies);
  const wrongScope = {
    ...dependencies,
    account_scope: { ...accountScope(), seller_account_fingerprint_sha256: "b".repeat(64) },
  };
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "request"), wrongScope),
    (error) => error.code === "ACCOUNT_SCOPE_MISMATCH",
  );
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "poll"), wrongScope),
    (error) => error.code === "ACTIVE_ACCOUNT_SCOPE_MISMATCH",
  );
  assert.equal(transport.requests.length, 1);
  assert.equal((await readdir(path.join(session, "capture"))).some((name) => name.startsWith("20-poll")), false);

  await runWalmartItemReportCapturePhase(input(root, session, "poll"), dependencies);
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "download"), wrongScope),
    (error) => error.code === "ACTIVE_ACCOUNT_SCOPE_MISMATCH",
  );
  assert.equal(transport.requests.length, 2);
  await runWalmartItemReportCapturePhase(input(root, session, "download"), dependencies);

  const compiled = await runWalmartItemReportCapturePhase(input(root, session, "compile"), {
    transport: { send: async () => { throw new Error("offline compile must not use transport"); } },
    now: makeClock(),
  });
  assert.equal(compiled.state, "COMPILED");
  assert.equal(compiled.http_calls.total_http_calls, 0);
});

test("configured root, session, and artifact child symlinks are rejected before network", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "wm-item-symlink-test-"));
  await chmod(parent, 0o700);
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const realRoot = path.join(parent, "real-root");
  const rootLink = path.join(parent, "root-link");
  await mkdir(realRoot, { mode: 0o700 });
  await symlink(realRoot, rootLink);
  let calls = 0;
  const dependencies = {
    transport: { send: async () => { calls += 1; throw new Error("must not run"); } },
    account_scope: accountScope(),
    now: makeClock(),
    random_uuid: makeUuid(),
  };
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(
      input(rootLink, path.join(rootLink, "session"), "request"),
      dependencies,
    ),
    (error) => error.code === "UNSAFE_CAPTURE_ROOT",
  );

  const outsideParent = path.join(parent, "outside-parent");
  const nominalParent = path.join(parent, "nominal-parent");
  await mkdir(outsideParent, { mode: 0o700 });
  await symlink(outsideParent, nominalParent);
  const ancestorLinkedRoot = path.join(nominalParent, "captures");
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(
      input(ancestorLinkedRoot, path.join(ancestorLinkedRoot, "session"), "request"),
      dependencies,
    ),
    (error) => error.code === "UNSAFE_CAPTURE_ROOT",
  );
  await assert.rejects(() => stat(path.join(outsideParent, "captures")), /ENOENT/);

  const sessionTarget = path.join(parent, "session-target");
  const sessionLink = path.join(realRoot, "session-link");
  await mkdir(sessionTarget, { mode: 0o700 });
  await symlink(sessionTarget, sessionLink);
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(realRoot, sessionLink, "request"), dependencies),
    (error) => error.code === "UNSAFE_SESSION_DIRECTORY",
  );

  const cleanSession = path.join(realRoot, "clean-session");
  const transport = happyTransport({ redirect: false });
  const cleanDependencies = { ...dependencies, transport };
  await runWalmartItemReportCapturePhase(input(realRoot, cleanSession, "request"), cleanDependencies);
  const childTarget = path.join(parent, "child-target");
  await mkdir(childTarget, { mode: 0o700 });
  await rm(path.join(cleanSession, "capture"), { recursive: true });
  await symlink(childTarget, path.join(cleanSession, "capture"));
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(realRoot, cleanSession, "poll"), cleanDependencies),
    (error) => error.code === "UNSAFE_SESSION_DIRECTORY",
  );
  assert.equal(calls, 0);
  assert.equal(transport.requests.length, 1);

  if (process.platform === "darwin") {
    const privateTmpParent = await mkdtemp("/private/tmp/wm-item-canonical-test-");
    await chmod(privateTmpParent, 0o700);
    t.after(async () => rm(privateTmpParent, { recursive: true, force: true }));
    const privateRoot = path.join(privateTmpParent, "captures");
    const privateSession = path.join(privateRoot, "session");
    const privateTransport = happyTransport({ redirect: false });
    const created = await runWalmartItemReportCapturePhase(
      input(privateRoot, privateSession, "request"),
      { ...dependencies, transport: privateTransport },
    );
    assert.equal(created.state, "REQUESTED");
  }
});

test("non-identity Content-Encoding and response caps are fail-closed", async (t) => {
  const { root, session } = await workspace(t);
  let calls = 0;
  const encoded = {
    async send(request) {
      calls += 1;
      const payload = response(fixturePayloads().create, {
        headers: {
          "content-encoding": "gzip",
          "wm_qos.correlation_id": request.correlation_id,
        },
      });
      return payload;
    },
  };
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "request"), {
      transport: encoded,
      account_scope: accountScope(),
      now: makeClock(),
      random_uuid: makeUuid(),
    }),
    WalmartItemReportManualReviewRequiredError,
  );
  assert.equal(calls, 1);

  const second = await workspace(t);
  const oversized = new Uint8Array(1024 * 1024 + 1).fill(0x20);
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(second.root, second.session, "request"), {
      transport: { send: async () => response(oversized) },
      account_scope: accountScope(),
      now: makeClock(),
      random_uuid: makeUuid(),
    }),
    WalmartItemReportManualReviewRequiredError,
  );
});

test("CLI raw transport never forwards auth to presigned hosts and refuses encoded responses", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response("abc", {
      status: 200,
      headers: { "content-length": "3", "content-type": "text/plain" },
    });
  };
  const transport = createWalmartItemReportCliTransport({
    credentials: { client_id: "client", client_secret: "secret", seller_id: "seller" },
    fetch_impl: fetchImpl,
    random_uuid: () => "token-correlation",
  });
  await transport.send({
    kind: "presigned-file",
    method: "GET",
    endpoint: null,
    query: {},
    url: INITIAL_URL,
    headers: { accept: "application/octet-stream", "accept-encoding": "identity" },
    body: null,
    correlation_id: null,
    redirect: "manual",
    max_response_bytes: 100,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[0].options.headers["wm_sec.access_token"], undefined);

  const encodedTransport = createWalmartItemReportCliTransport({
    credentials: { client_id: "client", client_secret: "secret", seller_id: "seller" },
    fetch_impl: async () => new Response("abc", {
      status: 200,
      headers: { "content-length": "3", "content-encoding": "gzip" },
    }),
  });
  await assert.rejects(
    () => encodedTransport.send({
      kind: "presigned-file",
      method: "GET",
      endpoint: null,
      query: {},
      url: INITIAL_URL,
      headers: { accept: "application/octet-stream", "accept-encoding": "identity" },
      body: null,
      correlation_id: null,
      redirect: "manual",
      max_response_bytes: 100,
    }),
    /ignored Accept-Encoding: identity/,
  );
});

test("hard deadlines cover token, Walmart fetch, presigned fetch, and stalled body reads", async () => {
  const credentials = { client_id: "client", client_secret: "secret", seller_id: "seller" };
  const tokenResponse = () => {
    const body = JSON.stringify({ access_token: "access-token" });
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(bytes(body).byteLength), "content-type": "application/json" },
    });
  };

  const tokenHang = createWalmartItemReportCliTransport({
    credentials,
    request_timeout_ms: 20,
    fetch_impl: async () => new Promise(() => {}),
  });
  await assert.rejects(
    () => tokenHang.send(walmartTransportRequest({ timeout_ms: 20 })),
    (error) => error.code === "REQUEST_TIMEOUT",
  );
  assert.deepEqual(tokenHang.get_http_call_counts(), {
    oauth_token_calls: 1, walmart_api_calls: 0, presigned_file_calls: 0, total_http_calls: 1,
  });

  let walmartFetches = 0;
  const walmartHang = createWalmartItemReportCliTransport({
    credentials,
    request_timeout_ms: 20,
    fetch_impl: async () => {
      walmartFetches += 1;
      if (walmartFetches === 1) return tokenResponse();
      return new Promise(() => {});
    },
  });
  await assert.rejects(
    () => walmartHang.send(walmartTransportRequest({ timeout_ms: 20 })),
    (error) => error.code === "REQUEST_TIMEOUT",
  );
  assert.deepEqual(walmartHang.get_http_call_counts(), {
    oauth_token_calls: 1, walmart_api_calls: 1, presigned_file_calls: 0, total_http_calls: 2,
  });

  const presignedHang = createWalmartItemReportCliTransport({
    credentials,
    request_timeout_ms: 20,
    fetch_impl: async () => new Promise(() => {}),
  });
  await assert.rejects(
    () => presignedHang.send(presignedTransportRequest({ timeout_ms: 20 })),
    (error) => error.code === "REQUEST_TIMEOUT",
  );
  assert.deepEqual(presignedHang.get_http_call_counts(), {
    oauth_token_calls: 0, walmart_api_calls: 0, presigned_file_calls: 1, total_http_calls: 1,
  });

  const stalledBody = createWalmartItemReportCliTransport({
    credentials,
    request_timeout_ms: 20,
    fetch_impl: async () => new Response(new ReadableStream({ pull() {} }), {
      status: 200,
      headers: { "content-type": "text/csv" },
    }),
  });
  await assert.rejects(
    () => stalledBody.send(presignedTransportRequest({ timeout_ms: 20 })),
    (error) => error.code === "REQUEST_TIMEOUT",
  );
});

test("POST timeout is terminal while GET timeout is retryable on a new append-only attempt", async (t) => {
  const post = await workspace(t);
  let postCalls = 0;
  const postDependencies = {
    transport: { send: async () => { postCalls += 1; return new Promise(() => {}); } },
    account_scope: accountScope(),
    now: makeClock(),
    random_uuid: makeUuid(),
    request_timeout_ms: 20,
  };
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(post.root, post.session, "request"), postDependencies),
    WalmartItemReportManualReviewRequiredError,
  );
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(post.root, post.session, "request"), postDependencies),
    WalmartItemReportManualReviewRequiredError,
  );
  assert.equal(postCalls, 1);

  const get = await workspace(t);
  const initial = happyTransport({ redirect: false });
  const clock = makeClock();
  const uuid = makeUuid();
  const baseDependencies = {
    transport: initial,
    account_scope: accountScope(),
    now: clock,
    random_uuid: uuid,
    request_timeout_ms: 20,
  };
  await runWalmartItemReportCapturePhase(input(get.root, get.session, "request"), baseDependencies);
  let getCalls = 0;
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(get.root, get.session, "poll"), {
      ...baseDependencies,
      transport: { send: async () => { getCalls += 1; return new Promise(() => {}); } },
    }),
    (error) => error.code === "GET_ATTEMPT_FAILED",
  );
  const retry = happyTransport({ redirect: false });
  const ready = await runWalmartItemReportCapturePhase(input(get.root, get.session, "poll"), {
    ...baseDependencies,
    transport: retry,
  });
  assert.equal(ready.state, "READY");
  assert.equal(getCalls, 1);
  assert.equal(retry.requests.length, 1);
  assert.equal((await readdir(path.join(get.session, "checkpoints")))
    .filter((name) => /^20-poll-\d{4}-reserved\.json$/u.test(name)).length, 2);
});

test("poll dynamic attempt correlation survives an attempt-2 manifest crash without path conflict", async (t) => {
  const { root, session } = await workspace(t);
  const initial = happyTransport({ redirect: false });
  const dependencies = {
    transport: initial,
    account_scope: accountScope(),
    now: makeClock(),
    random_uuid: makeUuid(),
  };
  await runWalmartItemReportCapturePhase(input(root, session, "request"), dependencies);
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "poll"), {
      ...dependencies,
      transport: { send: async () => { throw new Error("attempt-1 GET failure"); } },
    }),
    (error) => error.code === "GET_ATTEMPT_FAILED",
  );

  const retryTransport = happyTransport({ redirect: false });
  dependencies.transport = retryTransport;
  dependencies.after_immutable_write = crashOnceAt("capture/20-poll-0002-request-manifest.json");
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "poll"), dependencies),
    /simulated crash/,
  );
  assert.equal(retryTransport.requests.length, 0);
  delete dependencies.after_immutable_write;
  const ready = await runWalmartItemReportCapturePhase(input(root, session, "poll"), dependencies);
  assert.equal(ready.state, "READY");
  assert.equal(retryTransport.requests.length, 1);
  const selection = JSON.parse(await readFile(path.join(session, "trusted/29-ready-selection.json"), "utf8"));
  assert.equal(selection.attempt, 3);
});

test("locator dynamic attempt correlation survives an attempt-2 manifest crash without path conflict", async (t) => {
  const { root, session } = await workspace(t);
  const initial = happyTransport({ redirect: false });
  const dependencies = {
    transport: initial,
    account_scope: accountScope(),
    now: makeClock(),
    random_uuid: makeUuid(),
  };
  await runWalmartItemReportCapturePhase(input(root, session, "request"), dependencies);
  await runWalmartItemReportCapturePhase(input(root, session, "poll"), dependencies);
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "download"), {
      ...dependencies,
      transport: { send: async () => { throw new Error("attempt-1 locator GET failure"); } },
    }),
    (error) => error.code === "GET_ATTEMPT_FAILED",
  );

  const retryTransport = happyTransport({ redirect: false });
  dependencies.transport = retryTransport;
  dependencies.after_immutable_write = crashOnceAt("capture/30-locator-0002-request-manifest.json");
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "download"), dependencies),
    /simulated crash/,
  );
  assert.equal(retryTransport.requests.length, 0);
  delete dependencies.after_immutable_write;
  const downloaded = await runWalmartItemReportCapturePhase(
    input(root, session, "download"),
    dependencies,
  );
  assert.equal(downloaded.state, "DOWNLOADED");
  assert.equal(retryTransport.requests.length, 2);
  const fileSelection = JSON.parse(await readFile(path.join(session, "trusted/49-file-selection.json"), "utf8"));
  assert.equal(fileSelection.locator_binding.attempt, 3);
  assert.equal(fileSelection.locator_binding.selection_path, "trusted/39-locator-selection-0003.json");
});

test("CLI reports exact HTTP attempts for retained poll, download, and compile phases", async (t) => {
  await ensureDefaultCaptureRoot();
  const session = path.join(
    DEFAULT_CAPTURE_ROOT,
    `cli-accounting-${process.pid}-${Date.now()}`,
  );
  t.after(async () => rm(session, { recursive: true, force: true }));
  const credentials = { client_id: "client", client_secret: "secret", seller_id: "seller" };
  const cliAccountScope = {
    channel: "WALMART_US",
    store_index: 1,
    seller_account_fingerprint_sha256: computeWalmartSellerAccountFingerprint({
      store_index: 1,
      client_id: credentials.client_id,
      seller_id: credentials.seller_id,
    }),
  };
  const uuid = makeUuid();
  const cliClock = makeClock();
  const seedTransport = happyTransport({ redirect: false });
  await runWalmartItemReportCapturePhase({
    execute: true,
    phase: "request",
    store_index: 1,
    session_dir: session,
    allowed_capture_root: DEFAULT_CAPTURE_ROOT,
    owner_reissue_permit: testRequestPermit(session, cliAccountScope),
  }, {
    transport: seedTransport,
    account_scope: cliAccountScope,
    random_uuid: uuid,
    now: cliClock,
  });
  assert.equal(seedTransport.requests.filter((request) => request.method === "POST").length, 1);
  const payloads = fixturePayloads();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/v3/token")) {
      const body = JSON.stringify({ access_token: "access-token" });
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(bytes(body).byteLength), "content-type": "application/json" },
      });
    }
    const correlation = options.headers["wm_qos.correlation_id"];
    if (url.includes(`/v3/reports/reportRequests/${REQUEST_ID}`)) {
      return new Response(payloads.ready, {
        status: 200,
        headers: {
          "content-length": String(bytes(payloads.ready).byteLength),
          "content-type": "application/json",
          "wm_qos.correlation_id": correlation,
        },
      });
    }
    if (url.includes("/v3/reports/downloadReport?")) {
      return new Response(payloads.locator, {
        status: 200,
        headers: {
          "content-length": String(bytes(payloads.locator).byteLength),
          "content-type": "application/json",
          "wm_qos.correlation_id": correlation,
        },
      });
    }
    if (url === INITIAL_URL) {
      return new Response(CSV_A, {
        status: 200,
        headers: { "content-length": String(bytes(CSV_A).byteLength), "content-type": "text/csv" },
      });
    }
    throw new Error("unexpected injected URL");
  };
  const stdout = [];
  const runCliPhase = (phase) => cliMain([
    "--execute",
    `--phase=${phase}`,
    "--store-index=1",
    `--session-dir=${session}`,
  ], {
    credentials,
    fetch_impl: fetchImpl,
    random_uuid: uuid,
    now: cliClock,
    stdout: (value) => stdout.push(value),
  });

  const polled = await runCliPhase("poll");
  const downloaded = await runCliPhase("download");
  const compiled = await runCliPhase("compile");
  assert.deepEqual(polled.http_calls, {
    oauth_token_calls: 1, walmart_api_calls: 1, presigned_file_calls: 0, total_http_calls: 2,
  });
  assert.deepEqual(downloaded.http_calls, {
    oauth_token_calls: 1, walmart_api_calls: 1, presigned_file_calls: 1, total_http_calls: 3,
  });
  assert.deepEqual(compiled.http_calls, {
    oauth_token_calls: 0, walmart_api_calls: 0, presigned_file_calls: 0, total_http_calls: 0,
  });
  assert.deepEqual(
    [polled.network_calls, downloaded.network_calls, compiled.network_calls],
    [2, 3, 0],
  );
  assert.equal(calls.length, 5);
  assert.equal(calls.some(({ url, options }) => (
    url.includes("/v3/reports/reportRequests?") && options.method === "POST"
  )), false);
  assert.equal(stdout.join("\n").includes("secret-a"), false);
  assert.equal(stdout.join("\n").includes(INITIAL_URL), false);
});

test("CLI retires request before owner files, credentials, session writes, or network", async (t) => {
  await ensureDefaultCaptureRoot();
  const ownerPermitDirectory = await realpath(await mkdtemp(path.join(
    os.tmpdir(),
    "wm-retired-owner-file-test-",
  )));
  await chmod(ownerPermitDirectory, 0o700);
  t.after(async () => rm(ownerPermitDirectory, { recursive: true, force: true }));
  const session = path.join(
    DEFAULT_CAPTURE_ROOT,
    `cli-forbidden-owner-location-${process.pid}-${Date.now()}`,
  );
  t.after(async () => rm(session, { recursive: true, force: true }));
  const ownerPermitPath = path.join(ownerPermitDirectory, "must-not-be-read.json");
  const injectedReads = { credentials: 0, fetch_impl: 0, load_prior_absence_only: 0 };
  const injected = {};
  for (const name of Object.keys(injectedReads)) {
    Object.defineProperty(injected, name, {
      get() {
        injectedReads[name] += 1;
        throw new Error(`${name} must not be read`);
      },
    });
  }

  await assert.rejects(
    () => cliMain([
      "--execute",
      "--phase=request",
      "--store-index=1",
      `--session-dir=${session}`,
      `--owner-reissue-permit=${ownerPermitPath}`,
      `--expect-owner-reissue-artifact-sha256=${"a".repeat(64)}`,
      `--expect-owner-reissue-permit-sha256=${"b".repeat(64)}`,
      `--expect-source-evidence-release-sha256=${"c".repeat(64)}`,
      "--owner-reissue-confirmation=must-not-be-consumed",
    ], injected),
    (error) => error.code === WALMART_ITEM_REPORT_REISSUE_V1_RETIRED_CODE,
  );
  assert.deepEqual(injectedReads, {
    credentials: 0,
    fetch_impl: 0,
    load_prior_absence_only: 0,
  });
  await assert.rejects(() => stat(ownerPermitPath), /ENOENT/u);
  await assert.rejects(() => stat(session), /ENOENT/u);
});

test("unapproved redirect host fails without leaking URL in the error", async (t) => {
  const { root, session } = await workspace(t);
  const base = happyTransport({ redirect: false });
  let fileHop = 0;
  base.send = async function send(request) {
    this.requests.push(request);
    if (request.method === "POST") {
      return response(fixturePayloads().create, { headers: { "wm_qos.correlation_id": request.correlation_id } });
    }
    if (request.kind === "walmart-api" && request.endpoint.includes("reportRequests/")) {
      return response(fixturePayloads().ready, { headers: { "wm_qos.correlation_id": request.correlation_id } });
    }
    if (request.kind === "walmart-api") {
      return response(fixturePayloads().locator, { headers: { "wm_qos.correlation_id": request.correlation_id } });
    }
    fileHop += 1;
    return response(new Uint8Array(), {
      status: 307,
      headers: { location: `https://evil.example/report-${fileHop}.csv?secret=do-not-print` },
    });
  };
  const dependencies = {
    transport: base,
    account_scope: accountScope(),
    now: makeClock(),
    random_uuid: makeUuid(),
  };
  await runWalmartItemReportCapturePhase(input(root, session, "request"), dependencies);
  await runWalmartItemReportCapturePhase(input(root, session, "poll"), dependencies);
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "download"), dependencies),
    (error) => {
      assert.match(error.message, /hostname is not approved/);
      assert.equal(error.message.includes("do-not-print"), false);
      return true;
    },
  );
  assert.equal(fileHop, 1);
});

test("manual redirect chain stops exactly at the configured cap", async (t) => {
  const { root, session } = await workspace(t);
  const transport = happyTransport({ redirect: false });
  let fileHop = 0;
  transport.send = async function send(request) {
    this.requests.push(request);
    if (request.method === "POST") {
      return response(fixturePayloads().create, { headers: { "wm_qos.correlation_id": request.correlation_id } });
    }
    if (request.kind === "walmart-api" && request.endpoint.includes("reportRequests/")) {
      return response(fixturePayloads().ready, { headers: { "wm_qos.correlation_id": request.correlation_id } });
    }
    if (request.kind === "walmart-api") {
      return response(fixturePayloads().locator, { headers: { "wm_qos.correlation_id": request.correlation_id } });
    }
    fileHop += 1;
    return response(new Uint8Array(), {
      status: 307,
      headers: {
        location: `https://walmart-reports.s3.amazonaws.com/reports/redirect-${fileHop}.csv?private=hidden`,
      },
    });
  };
  const dependencies = {
    transport,
    account_scope: accountScope(),
    now: makeClock(),
    random_uuid: makeUuid(),
  };
  await runWalmartItemReportCapturePhase(input(root, session, "request"), dependencies);
  await runWalmartItemReportCapturePhase(input(root, session, "poll"), dependencies);
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "download"), dependencies),
    (error) => {
      assert.equal(error.code, "REDIRECT_CAP");
      assert.equal(error.message.includes("hidden"), false);
      return true;
    },
  );
  assert.equal(fileHop, 9);
  const fileRequests = transport.requests.filter((request) => request.kind === "presigned-file");
  assert.equal(fileRequests.length, 9);
  for (const request of fileRequests) {
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers["accept-encoding"], "identity");
    assert.equal(Object.keys(request.headers).some((name) => name.toLowerCase() === "authorization"), false);
  }
});

test("redirect responses have distinct per-hop and aggregate byte caps", async (t) => {
  const run = async (redirectBody) => {
    const { root, session } = await workspace(t);
    const transport = happyTransport({ redirect: false });
    let fileHop = 0;
    transport.send = async function send(request) {
      this.requests.push(request);
      if (request.method === "POST") {
        return response(fixturePayloads().create, { headers: { "wm_qos.correlation_id": request.correlation_id } });
      }
      if (request.kind === "walmart-api" && request.endpoint.includes("reportRequests/")) {
        return response(fixturePayloads().ready, { headers: { "wm_qos.correlation_id": request.correlation_id } });
      }
      if (request.kind === "walmart-api") {
        return response(fixturePayloads().locator, { headers: { "wm_qos.correlation_id": request.correlation_id } });
      }
      fileHop += 1;
      return response(redirectBody, {
        status: 307,
        headers: {
          location: `https://walmart-reports.s3.amazonaws.com/reports/bytes-${fileHop}.csv?private=yes`,
        },
      });
    };
    const dependencies = {
      transport,
      account_scope: accountScope(),
      now: makeClock(),
      random_uuid: makeUuid(),
    };
    await runWalmartItemReportCapturePhase(input(root, session, "request"), dependencies);
    await runWalmartItemReportCapturePhase(input(root, session, "poll"), dependencies);
    return {
      fileHop: () => fileHop,
      promise: runWalmartItemReportCapturePhase(input(root, session, "download"), dependencies),
    };
  };

  const oversizedHop = await run(new Uint8Array(WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES + 1));
  await assert.rejects(oversizedHop.promise, (error) => error.code === "REDIRECT_BODY_CAP");
  assert.equal(oversizedHop.fileHop(), 1);

  const perHop = Math.floor(WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_CHAIN_BYTES / 6);
  assert.equal(perHop < WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES, true);
  const oversizedChain = await run(new Uint8Array(perHop));
  await assert.rejects(oversizedChain.promise, (error) => error.code === "REDIRECT_CHAIN_BYTE_CAP");
  assert.equal(oversizedChain.fileHop(), 7);
});

test("expired locators and transient file failures refresh append-only locator attempt 2 and compile", async (t) => {
  for (const options of [
    { firstLocatorExpired: true, firstFileFails: false },
    { firstLocatorExpired: false, firstFileFails: true },
  ]) {
    const scenario = await runRefreshThroughDownload(t, options);
    assert.equal(scenario.downloaded.state, "DOWNLOADED");
    assert.equal(scenario.transport.locatorAttempts, 2);
    const selectionNames = (await readdir(path.join(scenario.session, "trusted")))
      .filter((name) => name.startsWith("39-locator-selection-"));
    assert.deepEqual(selectionNames.sort(), [
      "39-locator-selection-0001.json",
      "39-locator-selection-0002.json",
    ]);
    const fileSelection = JSON.parse(await readFile(
      path.join(scenario.session, "trusted/49-file-selection.json"),
      "utf8",
    ));
    assert.equal(fileSelection.locator_binding.attempt, 2);
    assert.equal(fileSelection.locator_binding.selection_path, "trusted/39-locator-selection-0002.json");
    const compiled = await runWalmartItemReportCapturePhase(
      input(scenario.root, scenario.session, "compile"),
      { transport: { send: async () => { throw new Error("offline"); } }, now: makeClock() },
    );
    assert.equal(compiled.state, "COMPILED");
  }
});

test("compile rejects FILE_SELECTION back-reference changed from locator attempt 2 to attempt 1", async (t) => {
  const scenario = await runRefreshThroughDownload(t, {
    firstLocatorExpired: false,
    firstFileFails: true,
  });
  const fileSelectionPath = path.join(scenario.session, "trusted/49-file-selection.json");
  const fileSelection = JSON.parse(await readFile(fileSelectionPath, "utf8"));
  const locatorOnePath = path.join(scenario.session, "trusted/39-locator-selection-0001.json");
  const locatorOneBytes = await readFile(locatorOnePath);
  const locatorOne = JSON.parse(locatorOneBytes.toString("utf8"));
  fileSelection.locator_binding = {
    attempt: 1,
    selection_path: "trusted/39-locator-selection-0001.json",
    selection_sha256: sha256(locatorOneBytes),
    request_manifest_path: locatorOne.request_manifest_path,
    response_body_path: locatorOne.response_body_path,
    response_http_path: locatorOne.response_http_path,
    exchange_seal_path: locatorOne.exchange_seal_path,
    request_correlation_id: locatorOne.request_correlation_id,
    request_correlation_id_sha256: locatorOne.request_correlation_id_sha256,
    response_body_sha256: locatorOne.response_body_sha256,
    exchange_seal_sha256: locatorOne.exchange_seal_sha256,
    request_id_sha256: locatorOne.request_id_sha256,
    download_url_sha256: locatorOne.download_url_sha256,
    download_url_expiration_at: locatorOne.download_url_expiration_at,
  };
  await writeFile(fileSelectionPath, JSON.stringify(fileSelection), { mode: 0o600 });
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(
      input(scenario.root, scenario.session, "compile"),
      { transport: { send: async () => { throw new Error("offline"); } } },
    ),
    /file reservation does not bind the exact retained locator selection/,
  );
});

test("restart resumes exact deterministic artifacts across each distinct state transition", async (t) => {
  const { root, session } = await workspace(t);
  const transport = happyTransport({ redirect: false });
  const dependencies = {
    transport,
    account_scope: accountScope(),
    now: makeClock(),
    random_uuid: makeUuid(),
    after_immutable_write: crashOnceAt("capture/10-create-request-manifest.json"),
  };
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "request"), dependencies),
    /simulated crash/,
  );
  assert.equal(transport.requests.length, 0);
  delete dependencies.after_immutable_write;
  await runWalmartItemReportCapturePhase(input(root, session, "request"), dependencies);
  assert.equal(transport.requests.length, 1);

  dependencies.after_immutable_write = crashOnceAt("capture/20-poll-0001-request-manifest.json");
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "poll"), dependencies),
    /simulated crash/,
  );
  assert.equal(transport.requests.length, 1);
  delete dependencies.after_immutable_write;
  await runWalmartItemReportCapturePhase(input(root, session, "poll"), dependencies);
  assert.equal(transport.requests.length, 2);

  dependencies.after_immutable_write = crashOnceAt("capture/30-locator-0001-request-manifest.json");
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "download"), dependencies),
    /simulated crash/,
  );
  assert.equal(transport.requests.length, 2);
  delete dependencies.after_immutable_write;
  await runWalmartItemReportCapturePhase(input(root, session, "download"), dependencies);
  assert.equal(transport.requests.length, 4);

  const compileDependencies = {
    transport: { send: async () => { throw new Error("compile is offline"); } },
    now: dependencies.now,
    after_immutable_write: crashOnceAt("trusted/90-compile-context.json"),
  };
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "compile"), compileDependencies),
    /simulated crash/,
  );
  compileDependencies.after_immutable_write = crashOnceAt(
    "sanitized/90-item-report-published-source.json",
  );
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "compile"), compileDependencies),
    /simulated crash/,
  );
  compileDependencies.after_immutable_write = crashOnceAt(
    "sanitized/item-report-catalog-source.json",
  );
  await assert.rejects(
    () => runWalmartItemReportCapturePhase(input(root, session, "compile"), compileDependencies),
    /simulated crash/,
  );
  delete compileDependencies.after_immutable_write;
  const completed = await runWalmartItemReportCapturePhase(
    input(root, session, "compile"),
    compileDependencies,
  );
  assert.equal(completed.state, "COMPILED");
  const replayed = await runWalmartItemReportCapturePhase(
    input(root, session, "compile"),
    compileDependencies,
  );
  assert.equal(replayed.state, "COMPILED");
  assert.equal(
    replayed.sanitized_catalog_source_sha256,
    completed.sanitized_catalog_source_sha256,
  );
  assert.equal(
    replayed.compile_checkpoint_sha256,
    completed.compile_checkpoint_sha256,
  );
});

test("custody boundary: a same-user full raw plus trusted-seal reseal can pass strongest local verification", async (t) => {
  const { root, session } = await runHappyThroughDownload(t, { redirect: false });
  const selectionPath = path.join(session, "trusted/49-file-selection.json");
  const selection = JSON.parse(await readFile(selectionPath, "utf8"));
  const manifest = new Uint8Array(await readFile(path.join(session, selection.request_manifest_path)));
  const http = JSON.parse(await readFile(path.join(session, selection.response_http_path), "utf8"));
  const resealed = walmartItemReportTrustedExchangeSha256({
    request_manifest_bytes: manifest,
    request_correlation_id_sha256: selection.request_correlation_id_sha256,
    response_payload_bytes: bytes(CSV_B),
    http,
  });
  await writeFile(path.join(session, selection.response_body_path), bytes(CSV_B), { mode: 0o600 });
  const sealPath = path.join(session, selection.exchange_seal_path);
  const seal = JSON.parse(await readFile(sealPath, "utf8"));
  seal.sha256 = resealed;
  await writeFile(sealPath, JSON.stringify(seal), { mode: 0o600 });
  selection.response_body_sha256 = sha256(bytes(CSV_B));
  selection.exchange_seal_sha256 = resealed;
  await writeFile(selectionPath, JSON.stringify(selection), { mode: 0o600 });

  const compiled = await runWalmartItemReportCapturePhase(input(root, session, "compile"), {
    transport: { send: async () => { throw new Error("offline"); } },
    now: makeClock(),
  });
  assert.equal(compiled.state, "COMPILED");
  const sanitized = await readFile(compiled.sanitized_source_path, "utf8");
  assert.equal(sanitized.includes("SKU-B"), true);
  const sanitizedCatalog = await readFile(
    compiled.sanitized_catalog_source_path,
    "utf8",
  );
  assert.equal(sanitizedCatalog.includes("SKU-B"), true);
  // This is intentionally not a Walmart signature or wire/TLS proof. Exclusive
  // local custody (plus external retention) remains an operational prerequisite.
});
