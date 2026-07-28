import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WalmartItemReportReissueEvidenceError,
  loadWalmartItemReportReissuePriorAbsenceOnly,
} from "../item-report-reissue-evidence.ts";
import {
  buildWalmartItemReportV6CreateRequestManifest,
  canonicalWalmartItemReportJson,
  walmartItemReportUtf8Sha256,
} from "../item-report-published-source.ts";
import {
  WALMART_ITEM_REPORT_RECONCILIATION_CHECKPOINT_SCHEMA,
  WALMART_ITEM_REPORT_RECONCILIATION_LIMITS,
  WALMART_ITEM_REPORT_RECONCILIATION_PAGE_SCHEMA,
  WALMART_ITEM_REPORT_RECONCILIATION_SCHEMA,
  WALMART_ITEM_REPORT_RECONCILIATION_SEAL_POLICY,
} from "../item-report-request-reconciliation.ts";

const SESSION_NAME = "item-v6-store1-20260718-codex-v1";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Canonical(value) {
  return createHash("sha256")
    .update(canonicalWalmartItemReportJson(value), "utf8")
    .digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(canonicalWalmartItemReportJson(value), "utf8");
}

function correlation(id) {
  return { id, sha256: walmartItemReportUtf8Sha256(id) };
}

async function writePrivate(filePath, bytes) {
  await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
}

async function writeCanonical(sessionDir, relativePath, value) {
  const bytes = canonicalBytes(value);
  await writePrivate(path.join(sessionDir, relativePath), bytes);
  return { bytes, sha256: sha256(bytes) };
}

async function rewriteCanonical(sessionDir, relativePath, value) {
  const bytes = canonicalBytes(value);
  await writeFile(path.join(sessionDir, relativePath), bytes);
  await chmod(path.join(sessionDir, relativePath), 0o600);
  return { bytes, sha256: sha256(bytes) };
}

function names(id) {
  const base = `item-request-reconcile-${id}`;
  return {
    scope: `capture/60-${base}-scope.json`,
    pageRequest: `capture/61-${base}-page-0001-request.json`,
    pageResponse: `capture/62-${base}-page-0001-response.bin`,
    pageHttp: `capture/63-${base}-page-0001-http.json`,
    pageReserved: `checkpoints/61-${base}-page-0001-reserved.json`,
    pageFailed: `checkpoints/64-${base}-page-0001-failed.json`,
    pageSeal: `trusted/64-${base}-page-0001-seal.json`,
    pageComplete: `checkpoints/65-${base}-page-0001-complete.json`,
    result: `trusted/68-${base}-result.json`,
    complete: `checkpoints/69-${base}-complete.json`,
  };
}

async function buildFixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "wm-reissue-evidence-"));
  await chmod(root, 0o700);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, SESSION_NAME);
  await mkdir(sessionDir, { mode: 0o700 });
  for (const child of ["capture", "trusted", "checkpoints", "sanitized"]) {
    await mkdir(path.join(sessionDir, child), { mode: 0o700 });
  }

  const accountScope = {
    channel: "WALMART_US",
    store_index: 1,
    seller_account_fingerprint_sha256: "a".repeat(64),
  };
  const authority = {
    schema_version: "walmart-item-report-capture-session/v1",
    session_id: "retained-ambiguous-session-0001",
    created_at: "2026-07-19T03:57:17.107Z",
    account_scope: accountScope,
    primary_correlations: {
      create: correlation("ambiguous-create-correlation-0001"),
      ready_status: correlation("ambiguous-ready-correlation-0001"),
      download_locator: correlation("ambiguous-locator-correlation-0001"),
      report_file: correlation("ambiguous-file-correlation-0001"),
    },
    trust_statement: {
      adapter_atomic_integrity: true,
      walmart_signature_claimed: false,
      tls_server_authenticity_claimed_by_artifact: false,
    },
  };
  const authorityArtifact = await writeCanonical(
    sessionDir,
    "trusted/00-session-authority.json",
    authority,
  );
  const createManifest = buildWalmartItemReportV6CreateRequestManifest({
    account_scope: accountScope,
    request_correlation_id_sha256: authority.primary_correlations.create.sha256,
  });
  const createArtifact = await writeCanonical(
    sessionDir,
    "capture/10-create-request-manifest.json",
    createManifest,
  );
  const reserved = {
    schema_version: "walmart-item-report-capture-checkpoint/v1",
    phase: "request",
    state: "RESERVED",
    observed_at: "2026-07-19T03:57:17.129Z",
    attempt: 1,
    post_attempt_limit: 1,
    request_manifest_sha256: createArtifact.sha256,
    request_correlation_id_sha256: authority.primary_correlations.create.sha256,
  };
  const reservedArtifact = await writeCanonical(
    sessionDir,
    "checkpoints/10-request-reserved.json",
    reserved,
  );
  const manualReview = {
    schema_version: "walmart-item-report-capture-checkpoint/v1",
    phase: "request",
    state: "MANUAL_REVIEW",
    observed_at: "2026-07-19T03:57:17.185Z",
    reason_code: "AMBIGUOUS_POST_NETWORK_OUTCOME",
    retry_forbidden: true,
  };
  const manualArtifact = await writeCanonical(
    sessionDir,
    "checkpoints/19-request-manual-review.json",
    manualReview,
  );

  const query = {
    reportType: "ITEM",
    reportVersion: "v6",
    src: "API",
    requestSubmissionStartDate: "2026-07-19T03:55:00Z",
    requestSubmissionEndDate: "2026-07-19T04:00:00Z",
  };
  const reconciliationId = sha256Canonical({
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_SCHEMA,
    session_id: authority.session_id,
    account_scope: accountScope,
    original_create_correlation_sha256: authority.primary_correlations.create.sha256,
    query,
  }).slice(0, 24);
  const artifactNames = names(reconciliationId);
  const originalScopeBinding = {
    session_authority_sha256: authorityArtifact.sha256,
    create_manifest_sha256: createArtifact.sha256,
    request_reserved_sha256: reservedArtifact.sha256,
    manual_review_sha256: manualArtifact.sha256,
    create_correlation_id_sha256: authority.primary_correlations.create.sha256,
    retry_forbidden: true,
  };
  const scope = {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_SCHEMA,
    reconciliation_id: reconciliationId,
    created_at: "2026-07-19T04:34:55.704Z",
    account_scope: accountScope,
    query_scope: query,
    original_ambiguous_post: originalScopeBinding,
    limits: WALMART_ITEM_REPORT_RECONCILIATION_LIMITS,
    safety: {
      report_create_post_allowed: false,
      walmart_mutation_allowed: false,
      database_allowed: false,
      model_allowed: false,
      request_id_adoption_allowed: false,
      only_list_report_requests_get: true,
    },
  };
  const scopeArtifact = await writeCanonical(sessionDir, artifactNames.scope, scope);

  const pageCorrelation = correlation("reconciliation-get-correlation-0001");
  const pageRequest = {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_PAGE_SCHEMA,
    reconciliation_id: reconciliationId,
    page_index: 1,
    method: "GET",
    endpoint: "/v3/reports/reportRequests",
    query,
    headers: { accept: "application/json", "accept-encoding": "identity" },
    body: null,
    authority: {
      account_scope: accountScope,
      original_create_correlation_id_sha256: authority.primary_correlations.create.sha256,
      request_correlation_id: pageCorrelation.id,
      request_correlation_id_sha256: pageCorrelation.sha256,
    },
    safety: { report_create_post: false, request_id_adoption: false },
  };
  const pageRequestArtifact = await writeCanonical(
    sessionDir,
    artifactNames.pageRequest,
    pageRequest,
  );
  const pageReserved = {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_CHECKPOINT_SCHEMA,
    reconciliation_id: reconciliationId,
    page_index: 1,
    state: "RESERVED",
    observed_at: "2026-07-19T04:34:55.714Z",
    get_attempt_limit: 1,
    retry_forbidden: true,
    request_manifest_sha256: pageRequestArtifact.sha256,
    request_correlation_id_sha256: pageCorrelation.sha256,
  };
  await writeCanonical(sessionDir, artifactNames.pageReserved, pageReserved);
  const responseBytes = Buffer.from(
    '{"page":1,"totalCount":0,"limit":0,"requests":[]}',
    "utf8",
  );
  await writePrivate(path.join(sessionDir, artifactNames.pageResponse), responseBytes);
  const responseArtifact = { bytes: responseBytes, sha256: sha256(responseBytes) };
  const http = {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_PAGE_SCHEMA,
    observed_at: "2026-07-19T04:34:56.455Z",
    status: 200,
    headers: {
      "content-length": String(responseBytes.byteLength),
      "content-type": "application/json",
    },
    response_body_byte_length: responseBytes.byteLength,
    response_body_sha256: responseArtifact.sha256,
    request_correlation_id_sha256: pageCorrelation.sha256,
    echoed_correlation_id_sha256: null,
  };
  const httpArtifact = await writeCanonical(sessionDir, artifactNames.pageHttp, http);
  const sealBody = {
    policy_id: WALMART_ITEM_REPORT_RECONCILIATION_SEAL_POLICY,
    request_manifest_sha256: pageRequestArtifact.sha256,
    request_manifest_byte_length: pageRequestArtifact.bytes.byteLength,
    request_correlation_id_sha256: pageCorrelation.sha256,
    response_body_sha256: responseArtifact.sha256,
    response_body_byte_length: responseBytes.byteLength,
    response_http_sha256: httpArtifact.sha256,
    response_http_byte_length: httpArtifact.bytes.byteLength,
  };
  const seal = { ...sealBody, seal_sha256: sha256Canonical(sealBody) };
  const sealArtifact = await writeCanonical(sessionDir, artifactNames.pageSeal, seal);
  const failure = {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_CHECKPOINT_SCHEMA,
    reconciliation_id: reconciliationId,
    page_index: 1,
    state: "PARSE_REVIEW_REQUIRED",
    observed_at: http.observed_at,
    reason_code: "PAGINATION_INCOMPLETE",
    retry_forbidden: true,
  };
  let failureArtifact = null;
  if (options.withRecoveryFailure === true) {
    failureArtifact = await writeCanonical(sessionDir, artifactNames.pageFailed, failure);
  }
  const pageEvidence = {
    page_index: 1,
    request_manifest_path: artifactNames.pageRequest,
    request_manifest_sha256: pageRequestArtifact.sha256,
    response_body_path: artifactNames.pageResponse,
    response_body_sha256: responseArtifact.sha256,
    response_http_path: artifactNames.pageHttp,
    response_http_sha256: httpArtifact.sha256,
    exchange_seal_path: artifactNames.pageSeal,
    exchange_seal_sha256: sealArtifact.sha256,
  };
  const pageComplete = {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_CHECKPOINT_SCHEMA,
    reconciliation_id: reconciliationId,
    page_index: 1,
    state: "CAPTURED",
    observed_at: http.observed_at,
    request_manifest_sha256: pageEvidence.request_manifest_sha256,
    response_body_sha256: pageEvidence.response_body_sha256,
    response_http_sha256: pageEvidence.response_http_sha256,
    exchange_seal_sha256: pageEvidence.exchange_seal_sha256,
    recovered_without_network: failureArtifact !== null,
    ...(failureArtifact === null
      ? {} : { recovered_from_failure_sha256: failureArtifact.sha256 }),
  };
  await writeCanonical(sessionDir, artifactNames.pageComplete, pageComplete);

  const result = {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_SCHEMA,
    reconciliation_id: reconciliationId,
    completed_at: "2026-07-19T04:41:24.009Z",
    outcome: "ABSENCE_ONLY",
    account_scope: accountScope,
    query_scope: query,
    original_ambiguous_post: {
      ...originalScopeBinding,
      manual_review_preserved: true,
    },
    evidence: {
      pages: [pageEvidence],
      page_count: 1,
      observed_row_count: 0,
      response_set_sha256: sha256Canonical([pageEvidence]),
    },
    candidate_set: {
      candidate_count: 0,
      exact_correlation_match_count: 0,
      duplicate_request_id_count: 0,
      excluded_different_correlation_count: 0,
      candidates: [],
    },
    disposition: {
      request_id_adopted: false,
      request_complete_written: false,
      owner_disposition_generated: false,
      manual_disposition_generated: false,
    },
    safety: {
      report_create_post_calls: 0,
      marketplace_mutations: 0,
      database_calls: 0,
      model_calls: 0,
    },
  };
  const resultArtifact = await writeCanonical(sessionDir, artifactNames.result, result);
  const complete = {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_CHECKPOINT_SCHEMA,
    reconciliation_id: reconciliationId,
    state: "COMPLETE",
    observed_at: result.completed_at,
    result_path: artifactNames.result,
    result_sha256: resultArtifact.sha256,
    recovered_without_network: false,
  };
  const completeArtifact = await writeCanonical(sessionDir, artifactNames.complete, complete);

  return {
    root,
    sessionDir,
    authority,
    artifactNames,
    result,
    complete,
    expected: {
      session_name: SESSION_NAME,
      session_id: authority.session_id,
      session_authority_sha256: authorityArtifact.sha256,
      create_manifest_sha256: createArtifact.sha256,
      request_reserved_sha256: reservedArtifact.sha256,
      manual_review_sha256: manualArtifact.sha256,
      manual_review_reason_code: "AMBIGUOUS_POST_NETWORK_OUTCOME",
      manual_review_retry_forbidden: true,
      reconciliation_id: reconciliationId,
      reconciliation_scope_sha256: scopeArtifact.sha256,
      reconciliation_result_sha256: resultArtifact.sha256,
      reconciliation_complete_sha256: completeArtifact.sha256,
      response_set_sha256: result.evidence.response_set_sha256,
      reconciliation_completed_at: result.completed_at,
      outcome: "ABSENCE_ONLY",
      observed_row_count: 0,
      candidate_count: 0,
      exact_correlation_match_count: 0,
      duplicate_request_id_count: 0,
      request_id_adopted: false,
      original_request_complete_written: false,
    },
  };
}

async function captureTree(sessionDir) {
  const snapshot = {};
  for (const directory of ["capture", "trusted", "checkpoints", "sanitized"]) {
    const entries = (await readdir(path.join(sessionDir, directory))).sort();
    for (const name of entries) {
      const absolute = path.join(sessionDir, directory, name);
      const stat = await lstat(absolute);
      snapshot[`${directory}/${name}`] = {
        mode: stat.mode & 0o777,
        bytes_sha256: stat.isFile() ? sha256(await readFile(absolute)) : null,
        symlink: stat.isSymbolicLink(),
      };
    }
  }
  return snapshot;
}

function rejectsCode(promise, code) {
  return assert.rejects(promise, (error) => (
    error instanceof WalmartItemReportReissueEvidenceError && error.code === code
  ));
}

test("accepts a direct one-page zero-row capture and performs zero writes", async (t) => {
  const fixture = await buildFixture(t);
  const before = await captureTree(fixture.sessionDir);
  const actual = await loadWalmartItemReportReissuePriorAbsenceOnly({
    allowed_capture_root: fixture.root,
    prior_session_name: SESSION_NAME,
  });
  const after = await captureTree(fixture.sessionDir);
  assert.deepEqual(actual, fixture.expected);
  assert.deepEqual(after, before);
});

test("rejects historical offline recovery despite later CAPTURED and ABSENCE_ONLY artifacts", async (t) => {
  const fixture = await buildFixture(t, { withRecoveryFailure: true });
  const before = await captureTree(fixture.sessionDir);
  await rejectsCode(loadWalmartItemReportReissuePriorAbsenceOnly({
    allowed_capture_root: fixture.root,
    prior_session_name: SESSION_NAME,
  }), "RETAINED_TERMINAL_PAGE_FAILURE");
  assert.deepEqual(await captureTree(fixture.sessionDir), before);
});

test("REQUEST_COMPLETE or retained create-response artifacts make reissue evidence illegal", async (t) => {
  const fixture = await buildFixture(t);
  await writeCanonical(fixture.sessionDir, "checkpoints/19-request-complete.json", {
    schema_version: "walmart-item-report-capture-checkpoint/v1",
    phase: "request",
    state: "COMPLETE",
  });
  await rejectsCode(loadWalmartItemReportReissuePriorAbsenceOnly({
    allowed_capture_root: fixture.root,
    prior_session_name: SESSION_NAME,
  }), "ORIGINAL_STATE_MUTATED");
});

test("coherently resealed neighboring outcomes and nonzero candidate evidence fail closed", async (t) => {
  for (const mutate of [
    (result) => { result.outcome = "CANDIDATE_ONLY"; },
    (result) => { result.evidence.observed_row_count = 1; },
    (result) => { result.candidate_set.candidate_count = 1; },
    (result) => { result.candidate_set.exact_correlation_match_count = 1; },
    (result) => { result.candidate_set.duplicate_request_id_count = 1; },
    (result) => { result.disposition.request_id_adopted = true; },
  ]) {
    const fixture = await buildFixture(t);
    mutate(fixture.result);
    const rewritten = await rewriteCanonical(
      fixture.sessionDir,
      fixture.artifactNames.result,
      fixture.result,
    );
    fixture.complete.result_sha256 = rewritten.sha256;
    await rewriteCanonical(
      fixture.sessionDir,
      fixture.artifactNames.complete,
      fixture.complete,
    );
    await assert.rejects(loadWalmartItemReportReissuePriorAbsenceOnly({
      allowed_capture_root: fixture.root,
      prior_session_name: SESSION_NAME,
    }), WalmartItemReportReissueEvidenceError);
  }
});

test("response-set, result, and final checkpoint hashes are all independently enforced", async (t) => {
  const fixture = await buildFixture(t);
  fixture.result.evidence.response_set_sha256 = "f".repeat(64);
  const rewritten = await rewriteCanonical(
    fixture.sessionDir,
    fixture.artifactNames.result,
    fixture.result,
  );
  fixture.complete.result_sha256 = rewritten.sha256;
  await rewriteCanonical(fixture.sessionDir, fixture.artifactNames.complete, fixture.complete);
  await rejectsCode(loadWalmartItemReportReissuePriorAbsenceOnly({
    allowed_capture_root: fixture.root,
    prior_session_name: SESSION_NAME,
  }), "EVIDENCE_BINDING_MISMATCH");
});

test("a second, malformed, or newer reconciliation family is rejected", async (t) => {
  const fixture = await buildFixture(t);
  await writeCanonical(
    fixture.sessionDir,
    `capture/60-item-request-reconcile-${"f".repeat(24)}-scope.json`,
    {},
  );
  await rejectsCode(loadWalmartItemReportReissuePriorAbsenceOnly({
    allowed_capture_root: fixture.root,
    prior_session_name: SESSION_NAME,
  }), "CONFLICTING_RECONCILIATION");
});

test("unexpected same-family page artifacts cannot be ignored", async (t) => {
  const fixture = await buildFixture(t);
  await writeCanonical(
    fixture.sessionDir,
    `capture/61-item-request-reconcile-${fixture.expected.reconciliation_id}-page-0002-request.json`,
    {},
  );
  await rejectsCode(loadWalmartItemReportReissuePriorAbsenceOnly({
    allowed_capture_root: fixture.root,
    prior_session_name: SESSION_NAME,
  }), "CONFLICTING_RECONCILIATION");
});

test("symlink artifacts and group/world-readable evidence are rejected", async (t) => {
  const symlinkFixture = await buildFixture(t);
  const resultPath = path.join(symlinkFixture.sessionDir, symlinkFixture.artifactNames.result);
  const copyPath = path.join(symlinkFixture.sessionDir, "trusted/result-copy.json");
  await writePrivate(copyPath, await readFile(resultPath));
  await unlink(resultPath);
  await symlink("result-copy.json", resultPath);
  await assert.rejects(loadWalmartItemReportReissuePriorAbsenceOnly({
    allowed_capture_root: symlinkFixture.root,
    prior_session_name: SESSION_NAME,
  }), WalmartItemReportReissueEvidenceError);

  const modeFixture = await buildFixture(t);
  await chmod(path.join(modeFixture.sessionDir, modeFixture.artifactNames.result), 0o644);
  await rejectsCode(loadWalmartItemReportReissuePriorAbsenceOnly({
    allowed_capture_root: modeFixture.root,
    prior_session_name: SESSION_NAME,
  }), "UNSAFE_EVIDENCE");
});

test("path traversal and noncanonical local evidence are rejected", async (t) => {
  const fixture = await buildFixture(t);
  await rejectsCode(loadWalmartItemReportReissuePriorAbsenceOnly({
    allowed_capture_root: fixture.root,
    prior_session_name: "../item-v6-store1-20260718-codex-v1",
  }), "UNSAFE_SESSION_NAME");

  const manualPath = path.join(fixture.sessionDir, "checkpoints/19-request-manual-review.json");
  await writeFile(manualPath, Buffer.concat([await readFile(manualPath), Buffer.from("\n")]));
  await chmod(manualPath, 0o600);
  await rejectsCode(loadWalmartItemReportReissuePriorAbsenceOnly({
    allowed_capture_root: fixture.root,
    prior_session_name: SESSION_NAME,
  }), "NON_CANONICAL_EVIDENCE");
});
