import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bootstrapWalmartItemReportReissueConsumptionLedgerV2,
  consumeWalmartItemReportReissueAuthorizationV2,
  openWalmartItemReportReissueConsumptionLedgerV2,
} from "../item-report-reissue-consumption-ledger-v2.ts";
import {
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE,
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENGINE_POLICY,
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENGINE_SCHEMA,
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENTRYPOINT,
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_EXACT_ARGV_ORDER,
  WalmartItemReportReissueExecutorV2Error,
  WalmartItemReportReissueExecutorV2ManualReviewError,
  executeWalmartItemReportReissueExecutorV2,
  preflightWalmartItemReportReissueExecutorV2,
} from "../item-report-reissue-executor-v2.ts";
import {
  assembleWalmartItemReportReissueOwnerDispositionV2,
  buildWalmartItemReportReissueDelegatedAuthorizationV1,
  buildWalmartItemReportReissueOwnerDispositionV2Body,
  buildWalmartItemReportReissueOwnerDispositionV2SigningRequest,
  buildWalmartItemReportReissueReplacementPlanV2,
  walmartItemReportReissueOwnerDispositionV2SigningMessage,
} from "../item-report-reissue-owner-disposition-v2.ts";
import {
  buildWalmartItemReportReissueSourceEvidenceV2,
  serializeWalmartItemReportReissueSourceEvidenceV2,
} from "../item-report-reissue-source-evidence-v2.ts";
import {
  runWalmartItemReportCapturePhase,
} from "../item-report-capture-session.ts";
import {
  canonicalWalmartItemReportJson,
  verifyWalmartItemReportPublishedSource,
  walmartItemReportUtf8Sha256,
} from "../item-report-published-source.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../../..");
const EVIDENCE_NAME = "item-v6-disposition-probe-store1-20260719-claude-v1";
const PRIOR_SESSION_NAME = "item-v6-store1-20260718-codex-v1";
const EXPECTED_FINGERPRINT =
  "a135315771d89961b51864ae27a80fc5e1f72c27ce9cbe1a4bf4ba7f93505127";
const NOW = new Date("2026-07-20T00:10:00.000Z");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(canonicalWalmartItemReportJson(value), "utf8");
}

function correlation(id) {
  return { id, sha256: walmartItemReportUtf8Sha256(id) };
}

function authority(sessionName) {
  return {
    schema_version: "walmart-item-report-capture-session/v1",
    session_id: `${sessionName}-authority`,
    created_at: "2026-07-19T23:50:00.000Z",
    account_scope: {
      channel: "WALMART_US",
      store_index: 1,
      seller_account_fingerprint_sha256: EXPECTED_FINGERPRINT,
    },
    primary_correlations: {
      create: correlation("20000000-0000-4000-8000-000000000001"),
      ready_status: correlation("20000000-0000-4000-8000-000000000002"),
      download_locator: correlation("20000000-0000-4000-8000-000000000003"),
      report_file: correlation("20000000-0000-4000-8000-000000000004"),
    },
    trust_statement: {
      adapter_atomic_integrity: true,
      walmart_signature_claimed: false,
      tls_server_authenticity_claimed_by_artifact: false,
    },
  };
}

async function engineArtifacts(captureRoot) {
  const bundleBytes = Buffer.from("fixture frozen one-shot executor bundle", "utf8");
  const sourcePaths = [
    WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENTRYPOINT,
    "scripts/capture-walmart-item-report-source.mjs",
    "src/lib/walmart/item-report-reissue-consumption-ledger-v2.ts",
    "src/lib/walmart/item-report-reissue-executor-v2.ts",
    "src/lib/walmart/item-report-reissue-owner-disposition-v2.ts",
    "src/lib/walmart/owner-control-trust-root.ts",
    "src/lib/walmart/item-report-reissue-permit.ts",
    "src/lib/walmart/item-report-reissue-absence-probe-evidence.ts",
    "src/lib/walmart/item-report-reissue-source-evidence-v2.ts",
    "src/lib/walmart/item-report-reissue-source-evidence-renewal-v1.ts",
    "src/lib/walmart/item-report-capture-session.ts",
    "src/lib/walmart/item-report-published-source.ts",
  ].sort();
  const sourceInputs = sourcePaths.map((relativePath, index) => ({
    relative_path: relativePath,
    byte_length: index + 1,
    sha256: (index + 1).toString(16).padStart(64, "0"),
  }));
  const certificationFiles = [
    ["CAPTURE_SESSION_TEST", "src/lib/walmart/__tests__/item-report-capture-session.test.mjs"],
    ["EXECUTOR_ENTRYPOINT", "scripts/walmart-item-report-reissue-v2-frozen-executor.mjs"],
    ["EXECUTOR_ENTRYPOINT_TEST", "scripts/__tests__/walmart-item-report-reissue-v2-frozen-executor.test.mjs"],
    ["EXECUTOR_FREEZER", "scripts/freeze-walmart-item-report-reissue-v2-executor-engine.mjs"],
    ["EXECUTOR_FREEZER_TEST", "scripts/__tests__/freeze-walmart-item-report-reissue-v2-executor-engine.test.mjs"],
    ["FREEZER_PRIMITIVE", "scripts/freeze-walmart-item-report-reissue-v2-engine.mjs"],
    ["FREEZER_PRIMITIVE_TEST", "scripts/__tests__/freeze-walmart-item-report-reissue-v2-engine.test.mjs"],
    ["EXECUTOR_MODULE", "src/lib/walmart/item-report-reissue-executor-v2.ts"],
    ["EXECUTOR_TEST", "src/lib/walmart/__tests__/item-report-reissue-executor-v2.test.mjs"],
    ["LEDGER_MODULE", "src/lib/walmart/item-report-reissue-consumption-ledger-v2.ts"],
    ["LEDGER_TEST", "src/lib/walmart/__tests__/item-report-reissue-consumption-ledger-v2.test.mjs"],
    ["OWNER_DISPOSITION_MODULE", "src/lib/walmart/item-report-reissue-owner-disposition-v2.ts"],
    ["OWNER_DISPOSITION_TEST", "src/lib/walmart/__tests__/item-report-reissue-owner-disposition-v2.test.mjs"],
    ["OWNER_CONTROL_TRUST_ROOT", "src/lib/walmart/owner-control-trust-root.ts"],
    ["ABSENCE_PROBE_EVIDENCE_MODULE", "src/lib/walmart/item-report-reissue-absence-probe-evidence.ts"],
    ["ABSENCE_PROBE_EVIDENCE_TEST", "scripts/__tests__/capture-walmart-item-v6-absence-probe.test.mjs"],
    ["SOURCE_EVIDENCE_MODULE", "src/lib/walmart/item-report-reissue-source-evidence-v2.ts"],
    ["SOURCE_EVIDENCE_TEST", "src/lib/walmart/__tests__/item-report-reissue-source-evidence-v2.test.mjs"],
    ["SOURCE_EVIDENCE_RENEWAL_MODULE", "src/lib/walmart/item-report-reissue-source-evidence-renewal-v1.ts"],
    ["SOURCE_EVIDENCE_RENEWAL_TEST", "src/lib/walmart/__tests__/item-report-reissue-source-evidence-renewal-v1.test.mjs"],
  ].sort(([leftRole, leftPath], [rightRole, rightPath]) => (
    leftRole < rightRole ? -1 : leftRole > rightRole ? 1
      : leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
  )).map(([role, relativePath], index) => ({
    relative_path: relativePath,
    byte_length: index + 1,
    role,
    sha256: (index + 10).toString(16).padStart(64, "0"),
  }));
  const nodePath = await realpath(process.execPath);
  const nodeBytes = await readFile(nodePath);
  const manifest = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENGINE_SCHEMA,
    policy_id: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENGINE_POLICY,
    project_root_realpath_sha256: "c".repeat(64),
    bundle: {
      file_name: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE,
      byte_length: bundleBytes.byteLength,
      sha256: sha256(bundleBytes),
    },
    runtime: {
      node_version: process.version,
      exec_path_realpath_sha256: sha256(Buffer.from(nodePath, "utf8")),
      exec_path_artifact_sha256: sha256(nodeBytes),
      platform: process.platform,
      arch: process.arch,
      required_exec_argv: [],
      node_options_required: "ABSENT",
      node_path_required: "ABSENT",
    },
    build: {
      tool: "esbuild",
      esbuild_version: "fixture",
      bundle: true,
      packages: "bundle",
      platform: "node",
      format: "esm",
      sourcemap: false,
      metafile: true,
      write: false,
      legal_comments: "none",
      charset: "utf8",
      tree_shaking: false,
      external_policy: "NODE_BUILTINS_ONLY",
    },
    capture: {
      canonical_root: captureRoot,
      canonical_root_realpath_sha256: sha256(Buffer.from(captureRoot, "utf8")),
      continuation_entrypoint: "scripts/capture-walmart-item-report-source.mjs",
      continuation_phases: ["poll", "download", "compile"],
      request_phase_retired_outside_this_executor: true,
    },
    entrypoint: {
      source_relative_path: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENTRYPOINT,
      bundle_file_name: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE,
      command: "execute-create",
      argument_style: "--name=value",
      exact_argv_order: [...WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_EXACT_ARGV_ORDER],
    },
    source_inputs: sourceInputs,
    source_inputs_sha256: sha256(canonicalBytes(sourceInputs)),
    certification_files: certificationFiles,
    certification_files_sha256: sha256(canonicalBytes(certificationFiles)),
    external_runtime_imports: ["node:crypto", "node:fs", "node:path"],
  };
  const manifestBytes = canonicalBytes(manifest);
  return { bundleBytes, manifest, manifestBytes };
}

let cachedEvidenceBytes;

async function sourceEvidenceBytes() {
  if (cachedEvidenceBytes) return Buffer.from(cachedEvidenceBytes);
  const release = await buildWalmartItemReportReissueSourceEvidenceV2({
    evidence_root: path.join(
      PROJECT_ROOT,
      "data/audits/walmart-source-intake",
      EVIDENCE_NAME,
    ),
    capture_root: path.join(PROJECT_ROOT, "data/audits/walmart-source-captures"),
    prior_session_name: PRIOR_SESSION_NAME,
    release_id: "walmart-item-v6-reissue-source-evidence-store1-20260719-v2",
    reviewed_at: "2026-07-19T23:26:39.000Z",
  });
  cachedEvidenceBytes = Buffer.from(
    serializeWalmartItemReportReissueSourceEvidenceV2(release),
  );
  return Buffer.from(cachedEvidenceBytes);
}

async function fixture({ delegated = false } = {}) {
  const temporary = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "item-reissue-executor-v2-")),
  );
  await chmod(temporary, 0o700);
  const captureRoot = path.join(temporary, "captures");
  await mkdir(captureRoot, { mode: 0o700 });
  await chmod(captureRoot, 0o700);
  const ledgerDirectory = path.join(temporary, "ledger");
  const bootstrapped = await bootstrapWalmartItemReportReissueConsumptionLedgerV2({
    state_directory: ledgerDirectory,
    now: new Date("2026-07-19T23:40:00.000Z"),
    random_uuid: () => "30000000-0000-4000-8000-000000000001",
  });
  const evidenceBytes = await sourceEvidenceBytes();
  const engine = await engineArtifacts(captureRoot);
  const sessionName = `item-v6-store1-reissue-v2-${randomUUID()}`;
  const replacement = buildWalmartItemReportReissueReplacementPlanV2({
    session_name: sessionName,
    session_authority: authority(sessionName),
  });
  const keys = generateKeyPairSync("ed25519");
  const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
  const env = {
    ...process.env,
    NODE_ENV: "test",
    WALMART_ITEM_REPORT_REISSUE_V2_TEST_MODE: "1",
    WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_KEY_ID: "item-reissue-executor-owner-test",
    WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64:
      publicDer.toString("base64"),
  };
  const body = buildWalmartItemReportReissueOwnerDispositionV2Body({
    disposition_id: `item-v6-reissue-executor-${randomUUID()}`,
    environment: "TEST_FIXTURE_ONLY",
    approved_by: "owner-test",
    decision_ref: `urn:ss-command-center:test:item-reissue:${randomUUID()}`,
    engine_release_sha256: sha256(engine.manifestBytes),
    source_evidence_bytes: evidenceBytes,
    expected_source_evidence_artifact_sha256: sha256(evidenceBytes),
    replacement,
    consumption_ledger: bootstrapped.binding,
    issued_at: "2026-07-20T00:00:00.000Z",
    expires_at: "2026-07-20T00:20:00.000Z",
  });
  const signingRequest = buildWalmartItemReportReissueOwnerDispositionV2SigningRequest({
    key_id: env.WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_KEY_ID,
    signed_body: body,
    env,
  });
  const envelope = {
    schema_version: signingRequest.schema_version,
    algorithm: signingRequest.algorithm,
    key_id: signingRequest.key_id,
    owner_public_key_spki_sha256: signingRequest.owner_public_key_spki_sha256,
    signed_body: signingRequest.signed_body,
  };
  const detachedSignature = sign(
    null,
    walmartItemReportReissueOwnerDispositionV2SigningMessage(envelope),
    keys.privateKey,
  );
  const signedDisposition = assembleWalmartItemReportReissueOwnerDispositionV2({
    signing_request: signingRequest,
    detached_signature: detachedSignature,
    expected_engine_release_sha256: sha256(engine.manifestBytes),
    expected_source_evidence_bytes: evidenceBytes,
    expected_source_evidence_artifact_sha256: sha256(evidenceBytes),
    expected_replacement: replacement,
    expected_consumption_ledger: bootstrapped.binding,
    env,
    now: NOW,
  });
  const disposition = delegated
    ? buildWalmartItemReportReissueDelegatedAuthorizationV1({
        environment: "TEST_FIXTURE_ONLY",
        disposition_id: `item-v6-reissue-delegated-executor-${randomUUID()}`,
        approved_by: "owner-test-delegated",
        decision_ref: `urn:ss-command-center:test:item-reissue-delegated:${randomUUID()}`,
        engine_release_sha256: sha256(engine.manifestBytes),
        source_evidence_bytes: evidenceBytes,
        expected_source_evidence_artifact_sha256: sha256(evidenceBytes),
        replacement,
        consumption_ledger: bootstrapped.binding,
        issued_at: "2026-07-20T00:00:00.000Z",
        expires_at: "2026-07-20T00:20:00.000Z",
      })
    : signedDisposition;
  const dispositionBytes = canonicalBytes(disposition);
  const input = {
    frozen_engine_manifest: {
      bytes: engine.manifestBytes,
      expected_artifact_sha256: sha256(engine.manifestBytes),
    },
    frozen_bundle: {
      bytes: engine.bundleBytes,
      expected_artifact_sha256: sha256(engine.bundleBytes),
    },
    source_evidence: {
      bytes: evidenceBytes,
      expected_artifact_sha256: sha256(evidenceBytes),
    },
    owner_disposition: {
      bytes: dispositionBytes,
      expected_artifact_sha256: sha256(dispositionBytes),
    },
    expected_environment: "TEST_FIXTURE_ONLY",
    owner_trust_env: env,
    active_account: {
      store_index: 1,
      seller_id: "10001624309",
      client_id: "synthetic-client-id-is-never-used-for-oauth",
      test_only_seller_account_fingerprint_sha256: EXPECTED_FINGERPRINT,
    },
    ledger_state_directory: ledgerDirectory,
    capture_root: captureRoot,
  };
  return {
    temporary,
    captureRoot,
    ledgerDirectory,
    ledgerBinding: bootstrapped.binding,
    disposition,
    input,
    engine,
  };
}

async function cleanup(item) {
  await rm(item.temporary, { recursive: true, force: true });
}

function successfulTransport(onSend = async () => {}, accountBinding = {
  channel: "WALMART_US",
  store_index: 1,
  seller_id: "10001624309",
  seller_account_fingerprint_sha256: EXPECTED_FINGERPRINT,
}) {
  const requests = [];
  const counts = {
    oauth_token_calls: 0,
    walmart_api_calls: 0,
    presigned_file_calls: 0,
    total_http_calls: 0,
  };
  return {
    requests,
    get_account_binding() {
      return { ...accountBinding };
    },
    get_http_call_counts() {
      return { ...counts };
    },
    async send(request) {
      await onSend(request);
      counts.oauth_token_calls += 1;
      counts.walmart_api_calls += 1;
      counts.total_http_calls += 2;
      requests.push(request);
      const body = Buffer.from(JSON.stringify({
        requestId: "replacement-request-001",
        requestSubmissionDate: "2026-07-20T00:05:00.000Z",
        reportType: "ITEM",
        reportVersion: "v6",
      }));
      return {
        status: 201,
        headers: {
          "content-type": "application/json",
          "content-length": String(body.byteLength),
          "set-cookie": "must-not-be-retained",
        },
        body,
      };
    },
  };
}

async function expectExecutorCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof WalmartItemReportReissueExecutorV2Error);
    assert.equal(error.code, code);
    return true;
  });
}

function replaceManifest(item, mutate) {
  const manifest = structuredClone(item.engine.manifest);
  mutate(manifest);
  const bytes = canonicalBytes(manifest);
  item.input.frozen_engine_manifest = {
    bytes,
    expected_artifact_sha256: sha256(bytes),
  };
}

test("offline preflight verifies every binding and performs zero writes/network", async () => {
  const item = await fixture();
  try {
    let opened = 0;
    const preflight = await preflightWalmartItemReportReissueExecutorV2(item.input, {
      now: NOW,
    });
    assert.equal(opened, 0);
    assert.equal(preflight.status, "READY_FOR_IRREVERSIBLE_SINGLE_EXECUTION");
    assert.equal(preflight.authorization_sha256, item.disposition.authorization_sha256);
    assert.equal(preflight.request.method, "POST");
    assert.deepEqual(preflight.request.query, { reportType: "ITEM", reportVersion: "v6" });
    assert.equal(preflight.external_effects.filesystem_writes, 0);
    assert.equal(preflight.external_effects.oauth_token_calls, 0);
    await assert.rejects(lstat(preflight.replacement_session_directory), { code: "ENOENT" });
  } finally {
    await cleanup(item);
  }
});

test("delegated pilot authorization preflights without password or owner key", async () => {
  const item = await fixture({ delegated: true });
  try {
    const preflight = await preflightWalmartItemReportReissueExecutorV2(item.input, {
      now: NOW,
    });
    assert.equal(preflight.status, "READY_FOR_IRREVERSIBLE_SINGLE_EXECUTION");
    assert.equal(preflight.authorization_sha256, item.disposition.authorization_sha256);
    assert.equal(item.disposition.authorization_mode, "OWNER_DELEGATED_AUTOMATION");
    assert.equal(preflight.external_effects.listing_content_writes, 0);
  } finally {
    await cleanup(item);
  }
});

test("delegated pilot authorization burns once and executes the same fixed POST", async () => {
  const item = await fixture({ delegated: true });
  try {
    const transport = successfulTransport();
    const result = await executeWalmartItemReportReissueExecutorV2(item.input, {
      now: () => NOW,
      open_transport: () => transport,
    });
    assert.equal(result.status, "REQUESTED");
    assert.equal(result.authorization_consumed_before_oauth, true);
    assert.equal(transport.requests.length, 1);
    assert.equal(transport.requests[0].method, "POST");
    assert.deepEqual(transport.requests[0].query, {
      reportType: "ITEM",
      reportVersion: "v6",
    });
    const ledger = await openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.ledgerDirectory,
      expected_binding: item.ledgerBinding,
    });
    assert.equal(ledger.authorizations[0]?.state, "SUCCEEDED");
    assert.equal(ledger.authorizations[0]?.authorization_sha256,
      item.disposition.authorization_sha256);
  } finally {
    await cleanup(item);
  }
});

test("burns authorization before transport/OAuth and issues exactly one fixed POST", async () => {
  const item = await fixture();
  try {
    const transport = successfulTransport(async () => {
      await assert.rejects(
        consumeWalmartItemReportReissueAuthorizationV2({
          state_directory: item.ledgerDirectory,
          expected_binding: item.ledgerBinding,
          authorization_sha256: item.disposition.authorization_sha256,
          claimed_at: NOW,
        }),
        (error) => error?.code === "AUTHORIZATION_ALREADY_CONSUMED",
      );
    });
    const result = await executeWalmartItemReportReissueExecutorV2(item.input, {
      now: () => NOW,
      open_transport: () => transport,
    });
    assert.equal(result.status, "REQUESTED");
    assert.equal(result.authorization_consumed_before_oauth, true);
    assert.deepEqual(result.http_calls, {
      oauth_token_calls: 1,
      walmart_api_calls: 1,
      presigned_file_calls: 0,
      total_http_calls: 2,
    });
    assert.equal(transport.requests.length, 1);
    const request = transport.requests[0];
    assert.equal(request.kind, "walmart-api");
    assert.equal(request.method, "POST");
    assert.equal(request.endpoint, "/v3/reports/reportRequests");
    assert.deepEqual(request.query, { reportType: "ITEM", reportVersion: "v6" });
    assert.equal(Buffer.from(request.body).toString("utf8"), "{}");
    assert.equal(request.redirect, "manual");
    assert.equal(request.timeout_ms, 60_000);
    const ledger = await openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.ledgerDirectory,
      expected_binding: item.ledgerBinding,
    });
    const terminal = ledger.authorizations.find(
      (entry) => entry.authorization_sha256 === item.disposition.authorization_sha256,
    );
    assert.equal(terminal?.state, "SUCCEEDED");
    assert.equal(terminal?.report_request_id_sha256, result.request_id_sha256);

    const session = result.replacement_session_directory;
    const complete = JSON.parse(await readFile(
      path.join(session, "checkpoints/19-request-complete.json"),
      "utf8",
    ));
    assert.equal(complete.request_id, "replacement-request-001");
    assert.equal(complete.request_id_origin, "REPLACEMENT_POST_RESPONSE_ONLY");
    assert.equal(complete.original_request_id_adopted, false);
    const http = JSON.parse(await readFile(
      path.join(session, "capture/12-create-response-http.json"),
      "utf8",
    ));
    assert.deepEqual(Object.keys(http).sort(), [
      "content_length",
      "content_type",
      "echoed_correlation_id_sha256",
      "echoed_report_request_id_sha256",
      "status",
    ]);
    assert.equal(JSON.stringify(http).includes("set-cookie"), false);
    for (const relativePath of [
      "trusted/00-session-authority.json",
      "trusted/01-owner-disposition.json",
      "trusted/02-consumption-receipt.json",
      "capture/10-create-request-manifest.json",
      "checkpoints/10-request-reserved.json",
      "checkpoints/19-request-complete.json",
    ]) {
      const stat = await lstat(path.join(session, relativePath));
      assert.equal(stat.mode & 0o777, 0o400);
      assert.equal(stat.nlink, 1);
    }
  } finally {
    await cleanup(item);
  }
});

test("network ambiguity burns permanently, writes manual-review, and never retries", async () => {
  const item = await fixture();
  try {
    let sends = 0;
    const transport = successfulTransport();
    transport.send = async (request) => {
      sends += 1;
      transport.requests.push(request);
      throw new Error("socket reset after write");
    };
    await assert.rejects(
      executeWalmartItemReportReissueExecutorV2(item.input, {
        now: () => NOW,
        open_transport: () => transport,
      }),
      (error) => {
        assert.ok(error instanceof WalmartItemReportReissueExecutorV2ManualReviewError);
        assert.equal(error.reason_code, "AMBIGUOUS_POST_NETWORK_OUTCOME");
        return true;
      },
    );
    assert.equal(sends, 1);
    const session = item.disposition.signed_body.replacement.session_name;
    const manual = JSON.parse(await readFile(path.join(
      item.captureRoot,
      session,
      "checkpoints/19-request-manual-review.json",
    ), "utf8"));
    assert.equal(manual.retry_forbidden, true);
    assert.equal(manual.authorization_consumed, true);
    const ledger = await openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.ledgerDirectory,
      expected_binding: item.ledgerBinding,
    });
    assert.equal(ledger.authorizations.find(
      (entry) => entry.authorization_sha256 === item.disposition.authorization_sha256,
    )?.state, "AMBIGUOUS");
    await expectExecutorCode(
      executeWalmartItemReportReissueExecutorV2(item.input, {
        now: () => NOW,
        open_transport: () => {
          throw new Error("must not open twice");
        },
      }),
      "AUTHORIZATION_ALREADY_CONSUMED",
    );
    assert.equal(sends, 1);
  } finally {
    await cleanup(item);
  }
});

test("non-success/redirect response is terminal and not followed", async () => {
  const item = await fixture();
  try {
    const transport = successfulTransport();
    transport.send = async (request) => {
      transport.requests.push(request);
      const counts = transport.get_http_call_counts;
      // Replace accounting accessor after this one fixed call.
      transport.get_http_call_counts = () => ({
        oauth_token_calls: 1,
        walmart_api_calls: 1,
        presigned_file_calls: 0,
        total_http_calls: 2,
      });
      void counts;
      return {
        status: 307,
        headers: { location: "https://example.invalid/forbidden", "content-length": "0" },
        body: new Uint8Array(),
      };
    };
    await assert.rejects(
      executeWalmartItemReportReissueExecutorV2(item.input, {
        now: () => NOW,
        open_transport: () => transport,
      }),
      (error) => error instanceof WalmartItemReportReissueExecutorV2ManualReviewError
        && error.reason_code === "POST_HTTP_FAILURE",
    );
    assert.equal(transport.requests.length, 1);
    assert.equal(transport.requests[0].redirect, "manual");
    const ledger = await openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.ledgerDirectory,
      expected_binding: item.ledgerBinding,
    });
    assert.equal(ledger.authorizations.find(
      (entry) => entry.authorization_sha256 === item.disposition.authorization_sha256,
    )?.state, "FAILED");
  } finally {
    await cleanup(item);
  }
});

test("successful executor artifacts continue through retired-request-safe poll/download/compile", async () => {
  const item = await fixture();
  try {
    const executed = await executeWalmartItemReportReissueExecutorV2(item.input, {
      now: () => NOW,
      open_transport: () => successfulTransport(),
    });
    const csv = [
      "SKU,ProductName,ProductId,ProductIdType,PublishedStatus,ProductCondition,Brand,LifecycleStatus",
      "SKU-A,Alpha Bread,111111111111,UPC,PUBLISHED,New,Alpha Brand,ACTIVE",
    ].join("\r\n") + "\r\n";
    const requests = [];
    const continuationTransport = {
      async send(request) {
        requests.push(request);
        let payload;
        let contentType = "application/json";
        if (request.kind === "walmart-api"
          && request.endpoint === "/v3/reports/reportRequests/replacement-request-001") {
          payload = JSON.stringify({
            requestId: "replacement-request-001",
            requestStatus: "READY",
            reportType: "ITEM",
            reportVersion: "v6",
            createdTime: "2026-07-20T00:05:00.000Z",
            reportGenerationDate: "2026-07-20T00:10:00.000Z",
          });
        } else if (request.kind === "walmart-api"
          && request.endpoint === "/v3/reports/downloadReport") {
          payload = JSON.stringify({
            requestId: "replacement-request-001",
            requestSubmissionDate: "2026-07-20T00:05:00.000Z",
            reportGenerationDate: "2026-07-20T00:10:00.000Z",
            downloadURL:
              "https://walmart-reports.s3.amazonaws.com/reports/item.csv?X-Amz-Signature=private-test",
            downloadURLExpirationTime: "2026-07-20T01:30:00.000Z",
          });
        } else if (request.kind === "presigned-file") {
          payload = csv;
          contentType = "text/csv";
        } else {
          throw new Error("unexpected continuation request");
        }
        const body = Buffer.from(payload, "utf8");
        const headers = {
          "content-type": contentType,
          "content-length": String(body.byteLength),
        };
        if (request.correlation_id !== null) {
          headers["wm_qos.correlation_id"] = request.correlation_id;
        }
        return { status: 200, headers, body };
      },
    };
    let tick = 0;
    const now = () => new Date(Date.parse("2026-07-20T00:15:00.000Z") + tick++ * 1000);
    const dependencies = {
      transport: continuationTransport,
      account_scope: {
        channel: "WALMART_US",
        store_index: 1,
        seller_account_fingerprint_sha256: EXPECTED_FINGERPRINT,
      },
      now,
      random_uuid: randomUUID,
    };
    const phaseInput = (phase) => ({
      execute: true,
      phase,
      store_index: 1,
      session_dir: executed.replacement_session_directory,
      allowed_capture_root: item.captureRoot,
    });
    const polled = await runWalmartItemReportCapturePhase(
      phaseInput("poll"),
      dependencies,
    );
    assert.equal(polled.state, "READY");
    const downloaded = await runWalmartItemReportCapturePhase(
      phaseInput("download"),
      dependencies,
    );
    assert.equal(downloaded.state, "DOWNLOADED");
    const compiled = await runWalmartItemReportCapturePhase(
      phaseInput("compile"),
      dependencies,
    );
    assert.equal(compiled.state, "COMPILED");
    assert.equal(compiled.network_calls, 0);
    const source = JSON.parse(await readFile(compiled.sanitized_source_path, "utf8"));
    const verified = verifyWalmartItemReportPublishedSource(source);
    assert.equal(verified.published_population_complete, true);
    assert.equal(verified.rows.length, 1);
    assert.equal(verified.rows[0].sku, "SKU-A");
    assert.equal(requests.filter((request) => request.kind === "walmart-api").length, 2);
    assert.equal(requests.filter((request) => request.kind === "presigned-file").length, 1);
  } finally {
    await cleanup(item);
  }
});

test("invalid content-length and missing requestId are terminal", async (context) => {
  for (const variant of ["CONTENT_LENGTH", "REQUEST_ID"]) {
    await context.test(variant, async () => {
      const item = await fixture();
      try {
        const transport = successfulTransport();
        transport.send = async (request) => {
          transport.requests.push(request);
          transport.get_http_call_counts = () => ({
            oauth_token_calls: 1,
            walmart_api_calls: 1,
            presigned_file_calls: 0,
            total_http_calls: 2,
          });
          const body = variant === "REQUEST_ID"
            ? Buffer.from("{}")
            : Buffer.from('{"requestId":"ok"}');
          return {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": variant === "CONTENT_LENGTH"
                ? String(body.byteLength + 1)
                : String(body.byteLength),
            },
            body,
          };
        };
        await assert.rejects(
          executeWalmartItemReportReissueExecutorV2(item.input, {
            now: () => NOW,
            open_transport: () => transport,
          }),
          (error) => error instanceof WalmartItemReportReissueExecutorV2ManualReviewError
            && error.reason_code === (variant === "CONTENT_LENGTH"
              ? "POST_RESPONSE_CAPTURE_INVALID"
              : "POST_RESPONSE_REQUEST_ID_INVALID"),
        );
        assert.equal(transport.requests.length, 1);
      } finally {
        await cleanup(item);
      }
    });
  }
});

test("artifact, account, expiry, and production-key failures happen before burn/network", async (context) => {
  const cases = [
    ["BUNDLE_HASH", (item) => {
      item.input.frozen_bundle.expected_artifact_sha256 = "f".repeat(64);
    }, "ARTIFACT_HASH_MISMATCH"],
    ["ACCOUNT", (item) => {
      item.input.active_account.seller_id = "other-seller";
    }, "ACCOUNT_BINDING_MISMATCH"],
    ["PRODUCTION_KEY", (item) => {
      item.input.expected_environment = "PRODUCTION";
      delete item.input.owner_trust_env;
    }, null],
  ];
  for (const [name, mutate, expectedCode] of cases) {
    await context.test(name, async () => {
      const item = await fixture();
      try {
        mutate(item);
        let opened = 0;
        await assert.rejects(
          executeWalmartItemReportReissueExecutorV2(item.input, {
            now: () => NOW,
            open_transport: () => {
              opened += 1;
              return successfulTransport();
            },
          }),
          (error) => expectedCode === null || error?.code === expectedCode,
        );
        assert.equal(opened, 0);
        await assert.rejects(lstat(path.join(
          item.captureRoot,
          item.disposition.signed_body.replacement.session_name,
        )), { code: "ENOENT" });
      } finally {
        await cleanup(item);
      }
    });
  }

  await context.test("EXPIRY", async () => {
    const item = await fixture();
    try {
      let opened = 0;
      await assert.rejects(
        executeWalmartItemReportReissueExecutorV2(item.input, {
          now: () => new Date("2026-07-20T00:20:00.000Z"),
          open_transport: () => {
            opened += 1;
            return successfulTransport();
          },
        }),
      );
      assert.equal(opened, 0);
    } finally {
      await cleanup(item);
    }
  });
});

test("test-only account override is impossible in production", async () => {
  const item = await fixture();
  try {
    item.input.expected_environment = "PRODUCTION";
    await assert.rejects(
      preflightWalmartItemReportReissueExecutorV2(item.input, { now: NOW }),
      (error) => typeof error?.code === "string",
    );
  } finally {
    await cleanup(item);
  }
});

test("manifest runtime, build, argv, certification, source, and builtin closure fail closed", async (context) => {
  const cases = [
    ["RUNTIME", (manifest) => { manifest.runtime = {}; }],
    ["BUILD", (manifest) => { manifest.build = {}; }],
    ["ARGV", (manifest) => { manifest.entrypoint.exact_argv_order = ["execute-create"]; }],
    ["CERT_PATH", (manifest) => {
      manifest.certification_files[0].relative_path = "scripts/arbitrary.test.mjs";
      manifest.certification_files_sha256 = sha256(canonicalBytes(manifest.certification_files));
    }],
    ["SOURCE_OMISSION", (manifest) => {
      manifest.source_inputs = manifest.source_inputs.filter(
        (row) => row.relative_path !== "src/lib/walmart/item-report-capture-session.ts",
      );
      manifest.source_inputs_sha256 = sha256(canonicalBytes(manifest.source_inputs));
    }],
    ["FAKE_BUILTIN", (manifest) => {
      manifest.external_runtime_imports = ["node:not-a-real-runtime-builtin"];
    }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const item = await fixture();
      try {
        replaceManifest(item, mutate);
        let opened = 0;
        await expectExecutorCode(
          preflightWalmartItemReportReissueExecutorV2(item.input, { now: NOW }),
          "INVALID_FROZEN_ENGINE",
        );
        assert.equal(opened, 0);
      } finally {
        await cleanup(item);
      }
    });
  }
});

test("transport credentials B cannot execute signed active account A", async () => {
  const item = await fixture();
  try {
    const transport = successfulTransport(async () => {
      assert.fail("transport B must be rejected before OAuth or POST");
    }, {
      channel: "WALMART_US",
      store_index: 1,
      seller_id: "seller-B",
      seller_account_fingerprint_sha256: "f".repeat(64),
    });
    await assert.rejects(
      executeWalmartItemReportReissueExecutorV2(item.input, {
        now: () => NOW,
        open_transport: () => transport,
      }),
      (error) => error instanceof WalmartItemReportReissueExecutorV2ManualReviewError
        && error.reason_code === "TRANSPORT_INITIALIZATION_FAILED_AFTER_AUTHORIZATION_BURN",
    );
    assert.equal(transport.requests.length, 0);
    const ledger = await openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.ledgerDirectory,
      expected_binding: item.ledgerBinding,
    });
    assert.equal(ledger.authorizations[0]?.state, "FAILED");
  } finally {
    await cleanup(item);
  }
});

test("full timeout plus margin is rechecked immediately before transport send", async () => {
  const item = await fixture();
  try {
    const instants = [
      NOW,
      NOW,
      NOW,
      new Date("2026-07-20T00:18:56.000Z"),
      new Date("2026-07-20T00:18:56.000Z"),
    ];
    let opened = 0;
    const transport = successfulTransport(async () => {
      assert.fail("insufficient final headroom must block before OAuth or POST");
    });
    await assert.rejects(
      executeWalmartItemReportReissueExecutorV2(item.input, {
        now: () => instants.shift() ?? instants.at(-1) ?? NOW,
        open_transport: () => {
          opened += 1;
          return transport;
        },
      }),
      (error) => error instanceof WalmartItemReportReissueExecutorV2ManualReviewError
        && error.reason_code === "FINAL_PRE_OAUTH_GATE_FAILED",
    );
    assert.equal(opened, 1);
    assert.equal(transport.requests.length, 0);
  } finally {
    await cleanup(item);
  }
});

test("final family re-read detects mutation of an earlier immutable response", async () => {
  const item = await fixture();
  try {
    const responsePath = path.join(
      item.captureRoot,
      item.disposition.signed_body.replacement.session_name,
      "capture/11-create-response.bin",
    );
    await assert.rejects(
      executeWalmartItemReportReissueExecutorV2(item.input, {
        now: () => NOW,
        open_transport: () => successfulTransport(),
        after_immutable_write: async (relativePath) => {
          if (relativePath !== "checkpoints/19-request-complete.json") return;
          await chmod(responsePath, 0o600);
          await writeFile(responsePath, Buffer.from("same-user-tamper-after-earlier-verification"));
          await chmod(responsePath, 0o400);
        },
      }),
      (error) => error instanceof WalmartItemReportReissueExecutorV2ManualReviewError
        && error.reason_code === "FINAL_SESSION_REVERIFY_FAILED",
    );
    const ledger = await openWalmartItemReportReissueConsumptionLedgerV2({
      state_directory: item.ledgerDirectory,
      expected_binding: item.ledgerBinding,
    });
    assert.equal(ledger.authorizations[0]?.state, "SUCCEEDED");
    const session = path.join(
      item.captureRoot,
      item.disposition.signed_body.replacement.session_name,
    );
    await Promise.all([
      lstat(path.join(session, "checkpoints/19-request-complete.json")),
      lstat(path.join(session, "checkpoints/19-request-manual-review.json")),
    ]);
    let continuationSends = 0;
    await assert.rejects(
      runWalmartItemReportCapturePhase({
        execute: true,
        phase: "poll",
        store_index: 1,
        session_dir: session,
        allowed_capture_root: item.captureRoot,
      }, {
        transport: {
          send: async () => {
            continuationSends += 1;
            throw new Error("manual-review session must never continue");
          },
        },
        account_scope: {
          channel: "WALMART_US",
          store_index: 1,
          seller_account_fingerprint_sha256: EXPECTED_FINGERPRINT,
        },
      }),
      (error) => error?.code === "MANUAL_REVIEW_REQUIRED",
    );
    assert.equal(continuationSends, 0);
  } finally {
    await cleanup(item);
  }
});
