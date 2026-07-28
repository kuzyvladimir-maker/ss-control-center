import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  computeWalmartSellerAccountFingerprint,
  runWalmartItemReportCapturePhase,
} from "../item-report-capture-session.ts";
import {
  WalmartItemReportRequestReconciliationError,
  runWalmartItemReportRequestReconciliation,
} from "../item-report-request-reconciliation.ts";
import {
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
  main as reconciliationCliMain,
  parseWalmartItemReportReconciliationCliArgs,
} from "../../../../scripts/reconcile-walmart-item-report-request.mjs";

const encoder = new TextEncoder();
const START = "2026-07-19T03:57:17Z";
const END = "2026-07-19T03:57:18Z";
const SUBMITTED = "2026-07-19T03:57:17.500Z";

function bytes(value) {
  return value instanceof Uint8Array ? value : encoder.encode(value);
}

function json(value) {
  return JSON.stringify(value);
}

function uuidSequence(prefix = "reconcile-id") {
  let counter = 0;
  return () => `${prefix}-${String(++counter).padStart(4, "0")}`;
}

function originalClock() {
  let tick = 0;
  const epoch = Date.parse("2026-07-19T03:57:17.100Z");
  return () => new Date(epoch + tick++ * 10);
}

function reconciliationClock() {
  let tick = 0;
  const epoch = Date.parse("2026-07-19T03:58:00.000Z");
  return () => new Date(epoch + tick++ * 10);
}

function httpResponse(value, request, overrides = {}) {
  const body = bytes(typeof value === "string" ? value : json(value));
  return {
    status: overrides.status ?? 200,
    headers: {
      "content-type": overrides.contentType ?? "application/json",
      "content-length": String(body.byteLength),
      "wm_qos.correlation_id": request.correlation_id,
      ...(overrides.headers ?? {}),
    },
    body,
  };
}

function accountScope(fingerprint = "a".repeat(64)) {
  return {
    channel: "WALMART_US",
    store_index: 1,
    seller_account_fingerprint_sha256: fingerprint,
  };
}

function requestPermit(session, scope) {
  const correlation = (id) => ({ id, sha256: walmartItemReportUtf8Sha256(id) });
  const authority = {
    schema_version: "walmart-item-report-capture-session/v1",
    session_id: "test-original-session-authority",
    created_at: "2026-07-19T03:56:50.000Z",
    account_scope: scope,
    primary_correlations: {
      create: correlation("test-original-create-correlation"),
      ready_status: correlation("test-original-ready-correlation"),
      download_locator: correlation("test-original-locator-correlation"),
      report_file: correlation("test-original-file-correlation"),
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
  const prior = {
    session_name: "test-prior-session",
    session_id: "test-prior-session-id",
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
    reconciliation_completed_at: "2026-07-19T03:56:00.000Z",
    outcome: "ABSENCE_ONLY",
    observed_row_count: 0,
    candidate_count: 0,
    exact_correlation_match_count: 0,
    duplicate_request_id_count: 0,
    request_id_adopted: false,
    original_request_complete_written: false,
  };
  const permit = buildWalmartItemReportReissuePermit({
    permit_id: "test-reconciliation-original-request-permit",
    approved_by: "test-owner",
    decision_ref: "urn:sscc:test-owner-decision:reconciliation-original",
    source_evidence_release_sha256: "c".repeat(64),
    account_scope: scope,
    prior_absence_only: prior,
    replacement_session_name: path.basename(session),
    replacement_session_authority: authority,
    replacement_create_request_manifest: manifest,
    issued_at: "2026-07-19T03:57:00.000Z",
    expires_at: "2026-07-19T04:20:00.000Z",
    prior_evidence_fresh_until: "2026-07-20T03:56:00.000Z",
  });
  const artifactBytes = canonicalWalmartItemReportReissuePermitBytes(permit);
  return {
    artifact_bytes: artifactBytes,
    expected_artifact_sha256: walmartItemReportReissuePermitArtifactSha256(artifactBytes),
    expected_permit_sha256: permit.permit_sha256,
    expected_source_evidence_release_sha256: "c".repeat(64),
    owner_confirmation: walmartItemReportReissueOwnerConfirmation(permit),
    prior_absence_only: prior,
  };
}

async function makeAmbiguousSession(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wm-item-reconcile-test-"));
  await chmod(root, 0o700);
  const session = path.join(root, "session-1");
  const scope = options.account_scope ?? accountScope();
  t.after(async () => rm(root, { recursive: true, force: true }));
  let createCalls = 0;
  await assert.rejects(
    () => runWalmartItemReportCapturePhase({
      execute: true,
      phase: "request",
      store_index: 1,
      session_dir: session,
      allowed_capture_root: root,
      owner_reissue_permit: requestPermit(session, scope),
    }, {
      transport: {
        async send() {
          createCalls += 1;
          throw new Error("simulated ambiguous network outcome");
        },
      },
      account_scope: scope,
      now: originalClock(),
      random_uuid: uuidSequence("original-correlation"),
    }),
    (error) => error.code === "MANUAL_REVIEW_REQUIRED",
  );
  assert.equal(createCalls, 1);
  const authority = JSON.parse(await readFile(
    path.join(session, "trusted/00-session-authority.json"),
    "utf8",
  ));
  return { root, session, scope, authority };
}

function liveInput(fixture, overrides = {}) {
  return {
    execute: true,
    store_index: 1,
    session_dir: fixture.session,
    allowed_capture_root: fixture.root,
    request_submission_start_date: START,
    request_submission_end_date: END,
    ...overrides,
  };
}

function transportWith(handler) {
  const requests = [];
  return {
    requests,
    async send(request) {
      requests.push(request);
      return handler(request, requests.length);
    },
  };
}

function dependencies(fixture, transport, overrides = {}) {
  return {
    transport,
    account_scope: fixture.scope,
    now: reconciliationClock(),
    random_uuid: uuidSequence(),
    ...overrides,
  };
}

function requestRow(id, overrides = {}) {
  return {
    requestId: id,
    requestStatus: "RECEIVED",
    requestSubmissionDate: SUBMITTED,
    reportType: "ITEM",
    reportVersion: "v6",
    ...overrides,
  };
}

async function allReconciliationFiles(session) {
  const files = [];
  for (const child of ["capture", "trusted", "checkpoints"]) {
    for (const name of await readdir(path.join(session, child))) {
      if (name.includes("item-request-reconcile")) files.push(path.join(session, child, name));
    }
  }
  return files.sort();
}

test("default plan and CLI plan perform exactly zero network and zero writes", async (t) => {
  const absentRoot = path.join(os.tmpdir(), `wm-reconcile-absent-${Date.now()}`);
  t.after(async () => rm(absentRoot, { recursive: true, force: true }));
  let calls = 0;
  const plan = await runWalmartItemReportRequestReconciliation({
    execute: false,
    store_index: 1,
    session_dir: path.join(absentRoot, "session"),
    allowed_capture_root: absentRoot,
    request_submission_start_date: null,
    request_submission_end_date: null,
  }, {
    transport: { send: async () => { calls += 1; throw new Error("must not run"); } },
  });
  assert.equal(plan.mode, "PLAN");
  assert.equal(plan.network_calls, 0);
  assert.equal(plan.filesystem_writes, 0);
  assert.equal(calls, 0);
  await assert.rejects(() => lstat(absentRoot), /ENOENT/);

  let cliCalls = 0;
  let stdout = "";
  const cliPlan = await reconciliationCliMain([], {
    fetch_impl: async () => { cliCalls += 1; throw new Error("must not fetch"); },
    stdout: (line) => { stdout += line; },
  });
  assert.equal(cliPlan.mode, "PLAN");
  assert.equal(cliCalls, 0);
  assert.equal(JSON.parse(stdout).marketplace_mutations, 0);
  assert.throws(
    () => parseWalmartItemReportReconciliationCliArgs(["--execute", "--store-index=1"]),
    /requires explicit/,
  );
  assert.throws(
    () => parseWalmartItemReportReconciliationCliArgs(["--session-dir=relative"]),
    /absolute/,
  );
});

test("zero rows is ABSENCE_ONLY and preserves original manual-review bytes", async (t) => {
  const fixture = await makeAmbiguousSession(t);
  const manualPath = path.join(fixture.session, "checkpoints/19-request-manual-review.json");
  const before = await readFile(manualPath);
  const transport = transportWith((request) => httpResponse({
    page: 1,
    totalCount: 0,
    limit: 10,
    nextCursor: null,
    requests: [],
  }, request));
  const result = await runWalmartItemReportRequestReconciliation(
    liveInput(fixture),
    dependencies(fixture, transport),
  );
  assert.equal(result.outcome, "ABSENCE_ONLY");
  assert.equal(result.candidate_count, 0);
  assert.equal(result.network_calls, 1);
  assert.equal(transport.requests.length, 1);
  assert.deepEqual(transport.requests[0].query, {
    reportType: "ITEM",
    reportVersion: "v6",
    src: "API",
    requestSubmissionStartDate: START,
    requestSubmissionEndDate: END,
  });
  assert.equal(transport.requests[0].method, "GET");
  assert.equal(transport.requests[0].endpoint, "/v3/reports/reportRequests");
  assert.equal(transport.requests[0].redirect, "manual");
  assert.deepEqual(await readFile(manualPath), before);
  await assert.rejects(
    () => stat(path.join(fixture.session, "checkpoints/19-request-complete.json")),
    /ENOENT/,
  );
  for (const file of await allReconciliationFiles(fixture.session)) {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

test("sanitized US zero-result envelope accepts limit zero and an absent nextCursor", async (t) => {
  const fixture = await makeAmbiguousSession(t);
  const transport = transportWith((request) => httpResponse({
    page: 1,
    totalCount: 0,
    limit: 0,
    requests: [],
  }, request));
  const first = await runWalmartItemReportRequestReconciliation(
    liveInput(fixture), dependencies(fixture, transport),
  );
  assert.equal(first.outcome, "ABSENCE_ONLY");
  assert.equal(first.observed_row_count, 0);
  assert.equal(first.page_count, 1);
  assert.equal(first.network_calls, 1);
  assert.equal(transport.requests.length, 1);

  const rederived = await runWalmartItemReportRequestReconciliation(
    liveInput(fixture), dependencies(fixture, transport),
  );
  assert.equal(rederived.outcome, "ABSENCE_ONLY");
  assert.equal(rederived.network_calls, 0);
  assert.equal(transport.requests.length, 1);
});

test("page zero is rejected because the US numeric sequence starts at page one", async (t) => {
  const fixture = await makeAmbiguousSession(t);
  const transport = transportWith((request) => httpResponse({
    page: 0,
    totalCount: 0,
    limit: 10,
    nextCursor: null,
    requests: [],
  }, request));
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(fixture), dependencies(fixture, transport),
    ),
    (error) => error.code === "PAGINATION_INVALID",
  );
  assert.equal(transport.requests.length, 1);
});

test("near-miss empty sentinels and retained terminal failures never unlock replay", async (t) => {
  for (const body of [
    { page: 2, totalCount: 0, limit: 0, requests: [] },
    { page: 1, totalCount: 1, limit: 0, requests: [] },
    { page: 1, totalCount: 0, limit: 0, nextCursor: "unexpected", requests: [] },
    { page: 1, totalCount: 0, limit: 10, requests: [] },
    { page: 0, totalCount: 0, limit: 0, requests: [] },
  ]) {
    const fixture = await makeAmbiguousSession(t);
    const transport = transportWith((request) => httpResponse(body, request));
    await assert.rejects(
      () => runWalmartItemReportRequestReconciliation(
        liveInput(fixture), dependencies(fixture, transport),
      ),
      WalmartItemReportRequestReconciliationError,
    );
    assert.equal(transport.requests.length, 1);
    await assert.rejects(
      () => runWalmartItemReportRequestReconciliation(
        liveInput(fixture), dependencies(fixture, transport),
      ),
      WalmartItemReportRequestReconciliationError,
    );
    assert.equal(transport.requests.length, 1);
  }

  const nonterminalFixture = await makeAmbiguousSession(t);
  const nonterminalTransport = transportWith((request) => httpResponse({
    page: 1,
    totalCount: 2,
    limit: 1,
    requests: [requestRow("0f5cf5d4-df8a-4eed-8064-8937717a9d10")],
  }, request));
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(nonterminalFixture),
      dependencies(nonterminalFixture, nonterminalTransport),
    ),
    (error) => error.code === "PAGINATION_INCOMPLETE",
  );
  assert.equal(nonterminalTransport.requests.length, 1);
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(nonterminalFixture),
      dependencies(nonterminalFixture, nonterminalTransport),
    ),
    (error) => error.code === "PAGINATION_INCOMPLETE",
  );
  assert.equal(nonterminalTransport.requests.length, 1);
});

test("one uncorrelated row remains CANDIDATE_ONLY and requestId is never adopted", async (t) => {
  const fixture = await makeAmbiguousSession(t);
  const requestId = "11111111-1111-4111-8111-111111111111";
  const transport = transportWith((request) => httpResponse({
    page: 1, totalCount: 1, limit: 10, nextCursor: null,
    requests: [requestRow(requestId)],
  }, request));
  const result = await runWalmartItemReportRequestReconciliation(
    liveInput(fixture), dependencies(fixture, transport),
  );
  assert.equal(result.outcome, "CANDIDATE_ONLY");
  assert.equal(result.request_id_adopted, false);
  const retained = await readFile(result.result_artifact_path, "utf8");
  assert.equal(retained.includes(requestId), false);
  assert.equal(JSON.parse(retained).disposition.owner_disposition_generated, false);
});

test("EXACT_MATCH requires one row echoing the exact original correlation ID", async (t) => {
  const fixture = await makeAmbiguousSession(t);
  const originalCorrelation = fixture.authority.primary_correlations.create.id;
  const transport = transportWith((request) => httpResponse({
    page: 1, totalCount: 1, limit: 10, nextCursor: null,
    requests: [requestRow("22222222-2222-4222-8222-222222222222", {
      requestCorrelationId: originalCorrelation,
    })],
  }, request));
  const result = await runWalmartItemReportRequestReconciliation(
    liveInput(fixture), dependencies(fixture, transport),
  );
  assert.equal(result.outcome, "EXACT_MATCH");
  assert.equal(result.exact_correlation_match_count, 1);
});

test("multiple candidates and duplicate requestId collisions are AMBIGUOUS", async (t) => {
  for (const rows of [
    [requestRow("33333333-3333-4333-8333-333333333333"),
      requestRow("44444444-4444-4444-8444-444444444444")],
    [requestRow("55555555-5555-4555-8555-555555555555"),
      requestRow("55555555-5555-4555-8555-555555555555", {
        requestStatus: "READY",
        requestSubmissionDate: "2026-07-19T03:57:17.600Z",
      })],
  ]) {
    const fixture = await makeAmbiguousSession(t);
    const transport = transportWith((request) => httpResponse({
      page: 1, totalCount: rows.length, limit: 10, nextCursor: null, requests: rows,
    }, request));
    const result = await runWalmartItemReportRequestReconciliation(
      liveInput(fixture), dependencies(fixture, transport),
    );
    assert.equal(result.outcome, "AMBIGUOUS");
    if (rows[0].requestId === rows[1].requestId) {
      assert.equal(result.duplicate_request_id_count, 1);
    }
  }
});

test("numeric page pagination is exhaustive and exactly accounted", async (t) => {
  const fixture = await makeAmbiguousSession(t);
  const transport = transportWith((request, attempt) => {
    if (attempt === 1) {
      return httpResponse({
        page: 1, totalCount: 2, limit: 1, nextCursor: null,
        requests: [requestRow("66666666-6666-4666-8666-666666666666")],
      }, request);
    }
    assert.equal(request.query.page, "2");
    assert.equal(request.query.limit, "1");
    return httpResponse({
      page: 2, totalCount: 2, limit: 1, nextCursor: null,
      requests: [requestRow("77777777-7777-4777-8777-777777777777")],
    }, request);
  });
  const result = await runWalmartItemReportRequestReconciliation(
    liveInput(fixture), dependencies(fixture, transport),
  );
  assert.equal(result.page_count, 2);
  assert.equal(result.observed_row_count, 2);
  assert.equal(result.network_calls, 2);
  assert.equal(transport.requests.length, 2);
  for (const request of transport.requests) {
    for (const [key, value] of Object.entries({
      reportType: "ITEM", reportVersion: "v6", src: "API",
      requestSubmissionStartDate: START, requestSubmissionEndDate: END,
    })) assert.equal(request.query[key], value);
  }
});

test("US nextCursor cycles and page-number drift fail closed", async (t) => {
  const cursorFixture = await makeAmbiguousSession(t);
  const cursorTransport = transportWith((request) => httpResponse({
    page: 1, totalCount: 2, limit: 1,
    nextCursor: "reportType=ITEM&reportVersion=v6&src=API&page=1",
    requests: [requestRow("88888888-8888-4888-8888-888888888888")],
  }, request));
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(cursorFixture), dependencies(cursorFixture, cursorTransport),
    ),
    (error) => error.code === "UNSUPPORTED_US_CURSOR",
  );
  assert.equal(cursorTransport.requests.length, 1);

  const cycleFixture = await makeAmbiguousSession(t);
  const cycleTransport = transportWith((request, attempt) => httpResponse({
    page: 1,
    totalCount: 3,
    limit: 1,
    nextCursor: null,
    requests: [requestRow(attempt === 1
      ? "99999999-9999-4999-8999-999999999999"
      : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")],
  }, request));
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(cycleFixture), dependencies(cycleFixture, cycleTransport),
    ),
    (error) => error.code === "PAGINATION_DRIFT",
  );
  assert.equal(cycleTransport.requests.length, 2);
});

test("response scope mismatch and malformed JSON are terminal without a second GET", async (t) => {
  for (const responder of [
    (request) => httpResponse({
      page: 1, totalCount: 1, limit: 10, nextCursor: null,
      requests: [requestRow("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { reportVersion: "v5" })],
    }, request),
    (request) => httpResponse("{not-json", request),
    (request) => httpResponse({ page: 1, totalCount: 1, limit: 10 }, request),
  ]) {
    const fixture = await makeAmbiguousSession(t);
    const transport = transportWith(responder);
    await assert.rejects(
      () => runWalmartItemReportRequestReconciliation(
        liveInput(fixture), dependencies(fixture, transport),
      ),
      WalmartItemReportRequestReconciliationError,
    );
    assert.equal(transport.requests.length, 1);
    await assert.rejects(
      () => runWalmartItemReportRequestReconciliation(
        liveInput(fixture), dependencies(fixture, transport),
      ),
      WalmartItemReportRequestReconciliationError,
    );
    assert.equal(transport.requests.length, 1);
  }
});

test("active account scope and exact time bounds gate all writes and network", async (t) => {
  for (const setup of [
    { scope: { ...accountScope(), seller_account_fingerprint_sha256: "b".repeat(64) } },
    { input: { request_submission_start_date: "2026-07-19T03:57:18Z" } },
    { input: { request_submission_start_date: "2026-07-19T03:40:00Z" } },
  ]) {
    const fixture = await makeAmbiguousSession(t);
    const transport = transportWith(() => { throw new Error("must not run"); });
    await assert.rejects(
      () => runWalmartItemReportRequestReconciliation(
        liveInput(fixture, setup.input),
        dependencies(fixture, transport, setup.scope ? { account_scope: setup.scope } : {}),
      ),
      WalmartItemReportRequestReconciliationError,
    );
    assert.equal(transport.requests.length, 0);
    assert.deepEqual(await allReconciliationFiles(fixture.session), []);
  }
});

test("crash after GET reservation never replays an ambiguous GET", async (t) => {
  const fixture = await makeAmbiguousSession(t);
  const transport = transportWith((request) => httpResponse({
    page: 1, totalCount: 0, limit: 10, nextCursor: null, requests: [],
  }, request));
  let crashed = false;
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(fixture),
      dependencies(fixture, transport, {
        after_immutable_write(relativePath) {
          if (!crashed && relativePath.includes("page-0001-reserved.json")) {
            crashed = true;
            throw new Error("simulated crash after reservation");
          }
        },
      }),
    ),
    /simulated crash/,
  );
  assert.equal(transport.requests.length, 0);
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(fixture), dependencies(fixture, transport),
    ),
    (error) => error.code === "AMBIGUOUS_GET_ATTEMPT",
  );
  assert.equal(transport.requests.length, 0);
});

test("crash after full seal resumes offline, while pre-reservation crash sends once", async (t) => {
  const sealedFixture = await makeAmbiguousSession(t);
  const sealedTransport = transportWith((request) => httpResponse({
    page: 1, totalCount: 0, limit: 10, nextCursor: null, requests: [],
  }, request));
  let sealCrash = false;
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(sealedFixture),
      dependencies(sealedFixture, sealedTransport, {
        after_immutable_write(relativePath) {
          if (!sealCrash && relativePath.includes("page-0001-seal.json")) {
            sealCrash = true;
            throw new Error("simulated crash after full seal");
          }
        },
      }),
    ),
    /simulated crash/,
  );
  assert.equal(sealedTransport.requests.length, 1);
  const recovered = await runWalmartItemReportRequestReconciliation(
    liveInput(sealedFixture), dependencies(sealedFixture, sealedTransport),
  );
  assert.equal(recovered.outcome, "ABSENCE_ONLY");
  assert.equal(recovered.network_calls, 0);
  assert.equal(sealedTransport.requests.length, 1);

  const manifestFixture = await makeAmbiguousSession(t);
  const manifestTransport = transportWith((request) => httpResponse({
    page: 1, totalCount: 0, limit: 10, nextCursor: null, requests: [],
  }, request));
  let manifestCrash = false;
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(manifestFixture),
      dependencies(manifestFixture, manifestTransport, {
        after_immutable_write(relativePath) {
          if (!manifestCrash && relativePath.includes("page-0001-request.json")) {
            manifestCrash = true;
            throw new Error("simulated crash before reservation");
          }
        },
      }),
    ),
    /simulated crash/,
  );
  assert.equal(manifestTransport.requests.length, 0);
  const resumed = await runWalmartItemReportRequestReconciliation(
    liveInput(manifestFixture), dependencies(manifestFixture, manifestTransport),
  );
  assert.equal(resumed.outcome, "ABSENCE_ONLY");
  assert.equal(manifestTransport.requests.length, 1);
});

test("timeout is terminal and restart does not duplicate the GET", async (t) => {
  const fixture = await makeAmbiguousSession(t);
  const transport = transportWith(() => new Promise(() => {}));
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(fixture), dependencies(fixture, transport, { request_timeout_ms: 5 }),
    ),
    (error) => error.code === "REQUEST_TIMEOUT",
  );
  assert.equal(transport.requests.length, 1);
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(fixture), dependencies(fixture, transport, { request_timeout_ms: 5 }),
    ),
    (error) => error.code === "AMBIGUOUS_GET_ATTEMPT",
  );
  assert.equal(transport.requests.length, 1);
});

test("redirects, oversized bodies, unsafe modes, and symlinks fail closed", async (t) => {
  const redirectFixture = await makeAmbiguousSession(t);
  const redirectTransport = transportWith((request) => httpResponse("private-body", request, {
    status: 307,
    contentType: "text/plain",
    headers: { location: "https://example.invalid/file?token=private-url" },
  }));
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(redirectFixture), dependencies(redirectFixture, redirectTransport),
    ),
    (error) => error.code === "REDIRECT_FORBIDDEN"
      && !error.message.includes("private-url") && !error.message.includes("private-body"),
  );

  const oversizedFixture = await makeAmbiguousSession(t);
  const oversizedTransport = transportWith(() => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: new Uint8Array(2 * 1024 * 1024 + 1),
  }));
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(oversizedFixture), dependencies(oversizedFixture, oversizedTransport),
    ),
    (error) => error.code === "INVALID_HTTP_RESPONSE",
  );

  const modeFixture = await makeAmbiguousSession(t);
  await chmod(path.join(modeFixture.session, "checkpoints/19-request-manual-review.json"), 0o644);
  const noNetwork = transportWith(() => { throw new Error("must not run"); });
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(modeFixture), dependencies(modeFixture, noNetwork),
    ),
    (error) => error.code === "UNSAFE_ARTIFACT",
  );
  assert.equal(noNetwork.requests.length, 0);

  const symlinkFixture = await makeAmbiguousSession(t);
  const manual = path.join(symlinkFixture.session, "checkpoints/19-request-manual-review.json");
  const backup = path.join(symlinkFixture.session, "checkpoints/manual-review-backup.json");
  await rename(manual, backup);
  await symlink(backup, manual);
  const symlinkTransport = transportWith(() => { throw new Error("must not run"); });
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(symlinkFixture), dependencies(symlinkFixture, symlinkTransport),
    ),
    (error) => ["UNSAFE_ARTIFACT", "MISSING_ARTIFACT"].includes(error.code),
  );
  assert.equal(symlinkTransport.requests.length, 0);
});

test("CLI uses only OAuth POST plus bounded reportRequests GET and leaks no secret URL/body", async (t) => {
  const credentials = {
    client_id: "client-id-for-test",
    client_secret: "private-client-secret",
    seller_id: "seller-id-for-test",
  };
  const fingerprint = computeWalmartSellerAccountFingerprint({
    store_index: 1,
    client_id: credentials.client_id,
    seller_id: credentials.seller_id,
  });
  const fixture = await makeAmbiguousSession(t, { account_scope: accountScope(fingerprint) });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method });
    if (url.endsWith("/v3/token")) {
      return new Response(json({ access_token: "private-access-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("private-response-body", {
      status: 307,
      headers: {
        "content-type": "text/plain",
        location: "https://example.invalid/report?signature=private-location",
      },
    });
  };
  let stdout = "";
  let observedError;
  try {
    await reconciliationCliMain([
      "--execute",
      "--store-index=1",
      `--session-dir=${fixture.session}`,
      `--request-submission-start-date=${START}`,
      `--request-submission-end-date=${END}`,
    ], {
      credentials,
      allowed_capture_root: fixture.root,
      fetch_impl: fetchImpl,
      now: reconciliationClock(),
      random_uuid: uuidSequence("cli-correlation"),
      stdout: (line) => { stdout += line; },
    });
  } catch (error) {
    observedError = error;
  }
  assert.equal(observedError.code, "REDIRECT_FORBIDDEN");
  const publicText = `${stdout}\n${observedError.message}`;
  for (const secret of [
    credentials.client_secret,
    "private-access-token",
    "private-location",
    "private-response-body",
  ]) assert.equal(publicText.includes(secret), false);
  assert.deepEqual(calls.map((call) => call.method), ["POST", "GET"]);
  const getUrl = new URL(calls[1].url);
  assert.equal(getUrl.pathname, "/v3/reports/reportRequests");
  assert.deepEqual(Object.fromEntries(getUrl.searchParams), {
    reportType: "ITEM",
    reportVersion: "v6",
    src: "API",
    requestSubmissionStartDate: START,
    requestSubmissionEndDate: END,
  });
});

test("successful CLI accounting is OAuth=1 GET=1 and completed rerun is network=0", async (t) => {
  const credentials = {
    client_id: "accounting-client-id",
    client_secret: "accounting-client-secret",
    seller_id: "accounting-seller-id",
  };
  const fingerprint = computeWalmartSellerAccountFingerprint({
    store_index: 1,
    client_id: credentials.client_id,
    seller_id: credentials.seller_id,
  });
  const fixture = await makeAmbiguousSession(t, { account_scope: accountScope(fingerprint) });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method });
    if (url.endsWith("/v3/token")) {
      return new Response(json({ access_token: "accounting-private-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const responseBody = json({
      page: 1, totalCount: 0, limit: 10, nextCursor: null, requests: [],
    });
    return new Response(responseBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const argv = [
    "--execute",
    "--store-index=1",
    `--session-dir=${fixture.session}`,
    `--request-submission-start-date=${START}`,
    `--request-submission-end-date=${END}`,
  ];
  let stdout = "";
  const first = await reconciliationCliMain(argv, {
    credentials,
    allowed_capture_root: fixture.root,
    fetch_impl: fetchImpl,
    now: reconciliationClock(),
    random_uuid: uuidSequence("accounting-correlation"),
    stdout: (line) => { stdout += line; },
  });
  assert.equal(first.outcome, "ABSENCE_ONLY");
  assert.deepEqual(first.http_calls, {
    oauth_token_calls: 1,
    walmart_api_calls: 1,
    presigned_file_calls: 0,
    total_http_calls: 2,
  });
  assert.equal(first.network_calls, 2);
  assert.equal(JSON.parse(stdout).network_calls, 2);
  assert.deepEqual(calls.map((call) => [new URL(call.url).pathname, call.method]), [
    ["/v3/token", "POST"],
    ["/v3/reports/reportRequests", "GET"],
  ]);

  const callsBeforeRerun = calls.length;
  const second = await reconciliationCliMain(argv, {
    credentials,
    allowed_capture_root: fixture.root,
    fetch_impl: fetchImpl,
    now: reconciliationClock(),
    random_uuid: uuidSequence("unused-correlation"),
    stdout: () => {},
  });
  assert.equal(second.outcome, "ABSENCE_ONLY");
  assert.equal(second.network_calls, 0);
  assert.deepEqual(second.http_calls, {
    oauth_token_calls: 0,
    walmart_api_calls: 0,
    presigned_file_calls: 0,
    total_http_calls: 0,
  });
  assert.equal(calls.length, callsBeforeRerun);
});

test("adversarial: response without completeness metadata cannot produce a terminal outcome", async (t) => {
  for (const requests of [
    [],
    [requestRow("dddddddd-dddd-4ddd-8ddd-dddddddddddd", {
      requestCorrelationId: "ORIGINAL_CORRELATION_PLACEHOLDER",
    })],
  ]) {
    const fixture = await makeAmbiguousSession(t);
    if (requests.length === 1) {
      requests[0].requestCorrelationId = fixture.authority.primary_correlations.create.id;
    }
    const transport = transportWith((request) => httpResponse({ requests }, request));
    await assert.rejects(
      () => runWalmartItemReportRequestReconciliation(
        liveInput(fixture), dependencies(fixture, transport),
      ),
      (error) => error.code === "PAGINATION_INCOMPLETE",
    );
    assert.equal(transport.requests.length, 1);
    await assert.rejects(
      () => runWalmartItemReportRequestReconciliation(
        liveInput(fixture), dependencies(fixture, transport),
      ),
      (error) => error.code === "PAGINATION_INCOMPLETE",
    );
    assert.equal(transport.requests.length, 1);
  }
});

test("adversarial: retained Content-Length mismatch remains terminal after restart", async (t) => {
  const fixture = await makeAmbiguousSession(t);
  const transport = transportWith((request) => httpResponse({
    page: 1, totalCount: 0, limit: 10, nextCursor: null, requests: [],
  }, request, {
    headers: { "content-length": "999999" },
  }));
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(fixture), dependencies(fixture, transport),
    ),
    (error) => error.code === "CONTENT_LENGTH_MISMATCH",
  );
  assert.equal(transport.requests.length, 1);
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(fixture), dependencies(fixture, transport),
    ),
    (error) => error.code === "CONTENT_LENGTH_MISMATCH",
  );
  assert.equal(transport.requests.length, 1);
});

test("adversarial: uncheckpointed final result is rederived instead of trusted after tamper", async (t) => {
  const fixture = await makeAmbiguousSession(t);
  const transport = transportWith((request) => httpResponse({
    page: 1, totalCount: 0, limit: 10, nextCursor: null, requests: [],
  }, request));
  let resultRelativePath = null;
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(fixture),
      dependencies(fixture, transport, {
        after_immutable_write(relativePath) {
          if (relativePath.includes("-result.json")) {
            resultRelativePath = relativePath;
            throw new Error("simulated crash after uncheckpointed final result");
          }
        },
      }),
    ),
    /simulated crash after uncheckpointed final result/,
  );
  assert.equal(transport.requests.length, 1);
  assert.notEqual(resultRelativePath, null);
  const resultPath = path.join(fixture.session, resultRelativePath);
  const tampered = JSON.parse(await readFile(resultPath, "utf8"));
  tampered.outcome = "EXACT_MATCH";
  tampered.candidate_set.exact_correlation_match_count = 1;
  await writeFile(resultPath, JSON.stringify(tampered), { mode: 0o600 });

  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(fixture), dependencies(fixture, transport),
    ),
    (error) => error.code === "INVALID_FINAL_RESULT",
  );
  assert.equal(transport.requests.length, 1);
});

test("adversarial: original manual-review cannot change after its pre-commit check", async (t) => {
  const fixture = await makeAmbiguousSession(t);
  const transport = transportWith((request) => httpResponse({
    page: 1, totalCount: 0, limit: 10, nextCursor: null, requests: [],
  }, request));
  let changed = false;
  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(fixture),
      dependencies(fixture, transport, {
        async after_immutable_write(relativePath) {
          if (!changed && relativePath.includes("-result.json")) {
            changed = true;
            await writeFile(
              path.join(fixture.session, "checkpoints/19-request-manual-review.json"),
              JSON.stringify({ tampered_after_precommit_check: true }),
              { mode: 0o600 },
            );
          }
        },
      }),
    ),
    (error) => error.code === "ORIGINAL_STATE_MUTATED",
  );
  assert.equal(changed, true);
  assert.equal(transport.requests.length, 1);
});

test("adversarial: completed rederive requires its durable page reservation", async (t) => {
  const fixture = await makeAmbiguousSession(t);
  const transport = transportWith((request) => httpResponse({
    page: 1, totalCount: 0, limit: 10, nextCursor: null, requests: [],
  }, request));
  await runWalmartItemReportRequestReconciliation(
    liveInput(fixture), dependencies(fixture, transport),
  );
  const checkpoints = await readdir(path.join(fixture.session, "checkpoints"));
  const reservation = checkpoints.find((name) => name.includes("page-0001-reserved.json"));
  assert.notEqual(reservation, undefined);
  await rm(path.join(fixture.session, "checkpoints", reservation));

  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(fixture), dependencies(fixture, transport),
    ),
    (error) => error.code === "INVALID_PAGE_CHECKPOINT",
  );
  assert.equal(transport.requests.length, 1);
});

test("adversarial: completed rederive validates the full CAPTURED checkpoint", async (t) => {
  const fixture = await makeAmbiguousSession(t);
  const transport = transportWith((request) => httpResponse({
    page: 1, totalCount: 0, limit: 10, nextCursor: null, requests: [],
  }, request));
  await runWalmartItemReportRequestReconciliation(
    liveInput(fixture), dependencies(fixture, transport),
  );
  const checkpoints = await readdir(path.join(fixture.session, "checkpoints"));
  const completed = checkpoints.find((name) => name.includes("page-0001-complete.json"));
  assert.notEqual(completed, undefined);
  const completedPath = path.join(fixture.session, "checkpoints", completed);
  const tampered = JSON.parse(await readFile(completedPath, "utf8"));
  tampered.response_body_sha256 = "0".repeat(64);
  tampered.unexpected_field = "canonical-shape-drift";
  await writeFile(completedPath, JSON.stringify(tampered), { mode: 0o600 });

  await assert.rejects(
    () => runWalmartItemReportRequestReconciliation(
      liveInput(fixture), dependencies(fixture, transport),
    ),
    (error) => error.code === "INVALID_PAGE_CHECKPOINT",
  );
  assert.equal(transport.requests.length, 1);
});
