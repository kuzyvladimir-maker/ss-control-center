import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  WALMART_ITEM_REPORT_REISSUE_ACTION,
  WALMART_ITEM_REPORT_REISSUE_EMPTY_BODY_SHA256,
  WALMART_ITEM_REPORT_REISSUE_PERMIT_SCHEMA,
  WalmartItemReportReissuePermitError,
  assertWalmartItemReportReissueOwnerConfirmation,
  buildWalmartItemReportReissuePermit,
  canonicalWalmartItemReportReissuePermitBytes,
  parseWalmartItemReportReissuePermit,
  parseWalmartItemReportReissuePermitBytes,
  verifyWalmartItemReportReissuePermit,
  verifyWalmartItemReportReissuePermitBytes,
  walmartItemReportReissueOwnerConfirmation,
  walmartItemReportReissuePermitArtifactSha256,
} from "../item-report-reissue-permit.ts";
import {
  buildWalmartItemReportV6CreateRequestManifest,
  walmartItemReportSha256,
  walmartItemReportUtf8Sha256,
} from "../item-report-published-source.ts";

const NOW = new Date("2026-07-19T05:05:00.000Z");
const SOURCE_EVIDENCE_RELEASE_SHA256 = "c".repeat(64);

function accountScope(fingerprint = "a135315771d89961b51864ae27a80fc5e1f72c27ce9cbe1a4bf4ba7f93505127") {
  return {
    channel: "WALMART_US",
    store_index: 1,
    seller_account_fingerprint_sha256: fingerprint,
  };
}

function correlation(id) {
  return { id, sha256: walmartItemReportUtf8Sha256(id) };
}

function replacementAuthority(scope = accountScope()) {
  return {
    schema_version: "walmart-item-report-capture-session/v1",
    session_id: "replacement-session-id-0001",
    created_at: "2026-07-19T04:55:00.000Z",
    account_scope: scope,
    primary_correlations: {
      create: correlation("replacement-create-correlation-0001"),
      ready_status: correlation("replacement-ready-correlation-0001"),
      download_locator: correlation("replacement-locator-correlation-0001"),
      report_file: correlation("replacement-file-correlation-0001"),
    },
    trust_statement: {
      adapter_atomic_integrity: true,
      walmart_signature_claimed: false,
      tls_server_authenticity_claimed_by_artifact: false,
    },
  };
}

function priorAbsenceOnly(overrides = {}) {
  return {
    session_name: "item-v6-store1-20260718-codex-v1",
    session_id: "688864bd-e1f4-44fb-b97e-167060754931",
    session_authority_sha256: "ec2072fce757fabb0c7cb4ef8e995c9df7be46c127a9c618334aded0a9dcd86e",
    create_manifest_sha256: "fdd21b9cd0028845d96d0b395443195334d37dfbd0809ac75a44931fe85011b9",
    request_reserved_sha256: "21a099d748e9efa214c251c44f708412a8094932f226a2095314eda817ae6eb9",
    manual_review_sha256: "91db33f675c07f8b91fe56f33d2d447cf2510d43d48a157778bb4058b900eeb2",
    manual_review_reason_code: "AMBIGUOUS_POST_NETWORK_OUTCOME",
    manual_review_retry_forbidden: true,
    reconciliation_id: "8e1f6dc39d35a577f7620c9b",
    reconciliation_scope_sha256: "be7c292fed5080d1fad8d6c426f19abdb950d02762af6f2201f27e602332a83e",
    reconciliation_result_sha256: "d0a18766a6509d83467d9b8bac4def2e9c7551c9019c782fc46bd23f65950d1a",
    reconciliation_complete_sha256: "d2b1aef9e5d0fc6be9b6e5d5ef3b73a43a5ab27e14589fedeec34b2773a063a4",
    response_set_sha256: "87abaf66c976f805363316ec153ff8213270212ed646e6afe439765a2ac3d54e",
    reconciliation_completed_at: "2026-07-19T04:41:24.009Z",
    outcome: "ABSENCE_ONLY",
    observed_row_count: 0,
    candidate_count: 0,
    exact_correlation_match_count: 0,
    duplicate_request_id_count: 0,
    request_id_adopted: false,
    original_request_complete_written: false,
    ...overrides,
  };
}

function buildFixture(overrides = {}) {
  const scope = overrides.scope ?? accountScope();
  const authority = overrides.authority ?? replacementAuthority(scope);
  const manifest = overrides.manifest ?? buildWalmartItemReportV6CreateRequestManifest({
    account_scope: scope,
    request_correlation_id_sha256: authority.primary_correlations.create.sha256,
  });
  const prior = overrides.prior ?? priorAbsenceOnly();
  const replacementSessionName = overrides.replacementSessionName
    ?? "item-v6-store1-20260719-owner-reissue-01";
  const permit = buildWalmartItemReportReissuePermit({
    permit_id: overrides.permitId ?? "wm-item-v6-reissue-20260719-0001",
    approved_by: overrides.approvedBy ?? "Vladimir Kuznetsov",
    decision_ref: overrides.decisionRef ?? "urn:sscc:owner-decision:wm-item-v6-reissue-20260719-0001",
    source_evidence_release_sha256:
      overrides.sourceEvidenceReleaseSha256 ?? SOURCE_EVIDENCE_RELEASE_SHA256,
    account_scope: scope,
    prior_absence_only: prior,
    replacement_session_name: replacementSessionName,
    replacement_session_authority: authority,
    replacement_create_request_manifest: manifest,
    issued_at: overrides.issuedAt ?? "2026-07-19T05:00:00.000Z",
    expires_at: overrides.expiresAt ?? "2026-07-19T05:20:00.000Z",
    prior_evidence_fresh_until: overrides.evidenceFreshUntil ?? "2026-07-20T04:00:00.000Z",
  });
  const context = {
    expected_permit_sha256: permit.permit_sha256,
    expected_source_evidence_release_sha256:
      overrides.sourceEvidenceReleaseSha256 ?? SOURCE_EVIDENCE_RELEASE_SHA256,
    now: overrides.now ?? NOW,
    account_scope: scope,
    prior_absence_only: prior,
    replacement_session_name: replacementSessionName,
    replacement_session_authority: authority,
    replacement_create_request_manifest: manifest,
  };
  return { authority, context, manifest, permit, prior, scope };
}

function clone(value) {
  return structuredClone(value);
}

function resealPermit(permit) {
  const bodySha256 = walmartItemReportSha256(permit.body);
  const preimage = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_PERMIT_SCHEMA,
    body: permit.body,
    body_sha256: bodySha256,
  };
  return {
    ...preimage,
    permit_sha256: walmartItemReportSha256(preimage),
  };
}

function artifactSha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function throwsCode(action, code) {
  assert.throws(action, (error) => (
    error instanceof WalmartItemReportReissuePermitError && error.code === code
  ));
}

test("build binds the exact live ABSENCE_ONLY evidence and one replacement ITEM v6 POST", () => {
  const fixture = buildFixture();
  const parsed = parseWalmartItemReportReissuePermit(fixture.permit);
  assert.equal(parsed.schema_version, WALMART_ITEM_REPORT_REISSUE_PERMIT_SCHEMA);
  assert.equal(parsed.body.action, WALMART_ITEM_REPORT_REISSUE_ACTION);
  assert.deepEqual(parsed.body.account_scope, fixture.scope);
  assert.deepEqual(parsed.body.prior_absence_only, fixture.prior);
  assert.equal(parsed.body.replacement.session_id, fixture.authority.session_id);
  assert.deepEqual(parsed.body.replacement.session_authority, fixture.authority);
  assert.deepEqual(parsed.body.replacement.create_request_manifest, fixture.manifest);
  assert.equal(
    parsed.body.replacement.session_authority_sha256,
    walmartItemReportSha256(fixture.authority),
  );
  assert.equal(
    parsed.body.replacement.create_request_manifest_sha256,
    walmartItemReportSha256(fixture.manifest),
  );
  assert.equal(parsed.body.authorization.maximum_create_post_calls, 1);
  assert.equal(parsed.body.authorization.maximum_oauth_token_calls, 1);
  assert.equal(parsed.body.authorization.maximum_walmart_api_calls, 1);
  assert.equal(parsed.body.authorization.maximum_request_timeout_ms, 60_000);
  assert.equal(parsed.body.authorization.retry_attempts_allowed, 0);
  assert.equal(parsed.body.authorization.automatic_replay_allowed, false);
  assert.equal(parsed.body.authorization.paid_provider_calls_allowed, false);
  assert.equal(parsed.body.authorization.report_type, "ITEM");
  assert.equal(parsed.body.authorization.report_version, "v6");
  assert.equal(
    parsed.body.authorization.request_body_sha256,
    WALMART_ITEM_REPORT_REISSUE_EMPTY_BODY_SHA256,
  );
  assert.equal(parsed.body.authorization.request_id_adoption_from_prior, false);
  assert.equal(parsed.body.authorization.original_session_mutation_allowed, false);
  assert.equal(
    parsed.body.owner_risk_acknowledgement.absence_only_is_not_proof_original_post_failed,
    true,
  );
  assert.equal(
    parsed.body.owner_risk_acknowledgement.duplicate_report_request_risk_accepted,
    true,
  );
  assert.equal(parsed.body.trust_boundary.external_owner_custody_required, true);
  assert.equal(parsed.body.trust_boundary.cryptographic_owner_authentication, false);
  assert.equal(parsed.body.trust_boundary.artifact_alone_proves_owner_authorship, false);
  assert.deepEqual(verifyWalmartItemReportReissuePermit(parsed, fixture.context), parsed);
  const confirmation = walmartItemReportReissueOwnerConfirmation(parsed);
  assert.equal(
    confirmation,
    `REISSUE_WALMART_ITEM_REPORT_V1:${parsed.permit_sha256}:${parsed.body.permit_id}`,
  );
  assert.doesNotThrow(() => assertWalmartItemReportReissueOwnerConfirmation(parsed, confirmation));
  throwsCode(
    () => assertWalmartItemReportReissueOwnerConfirmation(parsed, `${confirmation}-wrong`),
    "OWNER_CONFIRMATION_MISMATCH",
  );
});

test("canonical bytes and both independently supplied custody hashes are mandatory", () => {
  const fixture = buildFixture();
  const bytes = canonicalWalmartItemReportReissuePermitBytes(fixture.permit);
  const expectedArtifactSha = walmartItemReportReissuePermitArtifactSha256(bytes);
  assert.equal(expectedArtifactSha, artifactSha(bytes));
  assert.deepEqual(parseWalmartItemReportReissuePermitBytes(bytes), fixture.permit);
  assert.deepEqual(verifyWalmartItemReportReissuePermitBytes(bytes, {
    ...fixture.context,
    expected_artifact_sha256: expectedArtifactSha,
  }), fixture.permit);

  throwsCode(() => verifyWalmartItemReportReissuePermitBytes(bytes, {
    ...fixture.context,
    expected_artifact_sha256: "f".repeat(64),
  }), "EXTERNAL_CUSTODY_ARTIFACT_HASH_MISMATCH");
  throwsCode(() => verifyWalmartItemReportReissuePermit(fixture.permit, {
    ...fixture.context,
    expected_permit_sha256: "f".repeat(64),
  }), "EXTERNAL_CUSTODY_HASH_MISMATCH");
});

test("non-canonical formatting, newline, BOM, malformed UTF-8, and extra fields fail closed", () => {
  const fixture = buildFixture();
  const bytes = canonicalWalmartItemReportReissuePermitBytes(fixture.permit);
  for (const changed of [
    Buffer.concat([bytes, Buffer.from("\n")]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
    Buffer.from(JSON.stringify(fixture.permit, null, 2)),
  ]) {
    throwsCode(() => parseWalmartItemReportReissuePermitBytes(changed), "NON_CANONICAL_PERMIT_BYTES");
  }
  throwsCode(
    () => parseWalmartItemReportReissuePermitBytes(Buffer.from([0xff, 0xfe, 0xfd])),
    "INVALID_PERMIT_BYTES",
  );
  const extra = clone(fixture.permit);
  extra.body.untrusted_extension = true;
  throwsCode(() => parseWalmartItemReportReissuePermit(extra), "INVALID_PERMIT");
});

test("coherent or incoherent edits cannot cross an externally retained permit hash", () => {
  const fixture = buildFixture();
  const incoherent = clone(fixture.permit);
  incoherent.body.approved_by = "Claude Code";
  throwsCode(() => parseWalmartItemReportReissuePermit(incoherent), "PERMIT_HASH_MISMATCH");

  const coherentlyResealed = resealPermit(incoherent);
  assert.equal(parseWalmartItemReportReissuePermit(coherentlyResealed).body.approved_by, "Claude Code");
  throwsCode(() => verifyWalmartItemReportReissuePermit(coherentlyResealed, fixture.context),
    "EXTERNAL_CUSTODY_HASH_MISMATCH");
});

test("the unsigned boundary is explicit and never masquerades as owner authentication", () => {
  const fixture = buildFixture();
  const selfAuthored = clone(fixture.permit);
  selfAuthored.body.approved_by = "self-asserted-actor";
  const resealed = resealPermit(selfAuthored);
  const selfContext = {
    ...fixture.context,
    expected_permit_sha256: resealed.permit_sha256,
  };
  const verified = verifyWalmartItemReportReissuePermit(resealed, selfContext);
  assert.equal(verified.body.trust_boundary.cryptographic_owner_authentication, false);
  assert.equal(verified.body.trust_boundary.artifact_alone_proves_owner_authorship, false);

  const falseCryptoClaim = clone(fixture.permit);
  falseCryptoClaim.body.trust_boundary.cryptographic_owner_authentication = true;
  throwsCode(() => parseWalmartItemReportReissuePermit(falseCryptoClaim), "BINDING_MISMATCH");
});

test("active account, store, prior evidence, replacement session, authority, and manifest are exact", () => {
  const fixture = buildFixture();
  const cases = [
    [{ account_scope: accountScope("b".repeat(64)) }, "ACCOUNT_SCOPE_MISMATCH"],
    [{ account_scope: { ...fixture.scope, store_index: 2 } }, "ACCOUNT_SCOPE_MISMATCH"],
    [{ prior_absence_only: priorAbsenceOnly({ manual_review_sha256: "b".repeat(64) }) }, "BINDING_MISMATCH"],
    [{ replacement_session_name: "different-replacement-session" }, "BINDING_MISMATCH"],
    [{
      replacement_session_authority: {
        ...fixture.authority,
        session_id: "different-replacement-session-id",
      },
    }, "BINDING_MISMATCH"],
  ];
  for (const [changed, code] of cases) {
    throwsCode(() => verifyWalmartItemReportReissuePermit(fixture.permit, {
      ...fixture.context,
      ...changed,
    }), code);
  }

  throwsCode(() => verifyWalmartItemReportReissuePermit(fixture.permit, {
    ...fixture.context,
    expected_source_evidence_release_sha256: "b".repeat(64),
  }), "SOURCE_EVIDENCE_RELEASE_MISMATCH");

  const differentManifest = clone(fixture.manifest);
  differentManifest.query.reportVersion = "v5";
  throwsCode(() => verifyWalmartItemReportReissuePermit(fixture.permit, {
    ...fixture.context,
    replacement_create_request_manifest: differentManifest,
  }), "BINDING_MISMATCH");
});

test("builder rejects a mismatched SessionAuthority, correlation, create manifest, or reused session", () => {
  const fixture = buildFixture();
  const differentScopeAuthority = replacementAuthority(accountScope("b".repeat(64)));
  throwsCode(() => buildFixture({ authority: differentScopeAuthority }), "ACCOUNT_SCOPE_MISMATCH");

  const badCorrelationAuthority = clone(fixture.authority);
  badCorrelationAuthority.primary_correlations.create.sha256 = "b".repeat(64);
  throwsCode(() => buildFixture({ authority: badCorrelationAuthority }), "INVALID_SESSION_AUTHORITY");

  const wrongManifest = clone(fixture.manifest);
  wrongManifest.endpoint = "/v3/reports/reportRequests/other";
  throwsCode(() => buildFixture({ manifest: wrongManifest }), "BINDING_MISMATCH");

  throwsCode(() => buildFixture({
    replacementSessionName: fixture.prior.session_name,
  }), "REPLACEMENT_NOT_DISTINCT");
});

test("ABSENCE_ONLY semantics are literal: every neighboring state and nonzero count is rejected", () => {
  const mutations = [
    { outcome: "CANDIDATE_ONLY" },
    { observed_row_count: 1 },
    { candidate_count: 1 },
    { exact_correlation_match_count: 1 },
    { duplicate_request_id_count: 1 },
    { request_id_adopted: true },
    { original_request_complete_written: true },
    { manual_review_retry_forbidden: false },
    { manual_review_reason_code: "POST_HTTP_FAILURE" },
  ];
  for (const mutation of mutations) {
    assert.throws(() => buildFixture({ prior: priorAbsenceOnly(mutation) }),
      WalmartItemReportReissuePermitError);
  }
});

test("one-POST and no-side-effect claims cannot be widened even with coherent resealing", () => {
  const fixture = buildFixture();
  const mutations = [
    ["maximum_create_post_calls", 2],
    ["maximum_oauth_token_calls", 2],
    ["automatic_replay_allowed", true],
    ["report_version", "v5"],
    ["report_type", "INVENTORY"],
    ["request_id_adoption_from_prior", true],
    ["original_session_mutation_allowed", true],
    ["database_writes_allowed", true],
    ["listing_mutations_allowed", true],
    ["scheduled_execution_allowed", true],
  ];
  for (const [field, value] of mutations) {
    const changed = clone(fixture.permit);
    changed.body.authorization[field] = value;
    const resealed = resealPermit(changed);
    throwsCode(() => parseWalmartItemReportReissuePermit(resealed), "BINDING_MISMATCH");
  }
});

test("freshness is bounded at build time and rechecked at execution time", () => {
  assert.throws(() => buildFixture({
    expiresAt: "2026-07-19T06:00:00.000Z",
  }), (error) => error.code === "INVALID_FRESHNESS");
  assert.throws(() => buildFixture({
    issuedAt: "2026-07-20T04:42:00.000Z",
    expiresAt: "2026-07-20T04:43:00.000Z",
    evidenceFreshUntil: "2026-07-20T04:41:24.009Z",
  }), (error) => error.code === "INVALID_FRESHNESS");
  assert.throws(() => buildFixture({
    evidenceFreshUntil: "2026-07-20T04:41:24.010Z",
  }), (error) => error.code === "INVALID_FRESHNESS");

  const fixture = buildFixture();
  for (const now of [
    new Date("2026-07-19T04:54:59.999Z"),
    new Date("2026-07-19T05:20:00.001Z"),
    new Date("invalid"),
  ]) {
    assert.throws(() => verifyWalmartItemReportReissuePermit(fixture.permit, {
      ...fixture.context,
      now,
    }), WalmartItemReportReissuePermitError);
  }
});
