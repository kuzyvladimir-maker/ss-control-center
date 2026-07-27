import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_EMPTY_BODY_SHA256,
  WalmartItemReportReissueOwnerDispositionV2Error,
  assembleWalmartItemReportReissueOwnerDispositionV2,
  assertWalmartItemReportReissueAuthorizationCurrent,
  assertWalmartItemReportReissueOwnerDispositionV2Current,
  buildWalmartItemReportReissueDelegatedAuthorizationV1,
  buildWalmartItemReportReissueOwnerDispositionV2Body,
  buildWalmartItemReportReissueOwnerDispositionV2SigningRequest,
  buildWalmartItemReportReissueReplacementPlanV2,
  inspectWalmartItemReportReissueOwnerDispositionV2TrustRoot,
  verifyWalmartItemReportReissueOwnerDispositionV2,
  verifyWalmartItemReportReissueDelegatedAuthorizationV1,
  walmartItemReportReissueOwnerDispositionV2SigningMessage,
} from "../item-report-reissue-owner-disposition-v2.ts";
import {
  buildWalmartItemReportReissueSourceEvidenceV2,
  serializeWalmartItemReportReissueSourceEvidenceV2,
} from "../item-report-reissue-source-evidence-v2.ts";
import {
  buildWalmartItemReportReissueSourceEvidenceRenewalV1,
  serializeWalmartItemReportReissueSourceEvidenceRenewalV1,
} from "../item-report-reissue-source-evidence-renewal-v1.ts";
import {
  WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES,
} from "../item-report-reissue-absence-probe-evidence.ts";
import { walmartItemReportUtf8Sha256 } from "../item-report-published-source.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../../..");
const EVIDENCE_NAME = "item-v6-disposition-probe-store1-20260719-claude-v1";
const SESSION_NAME = "item-v6-store1-20260718-codex-v1";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function correlation(id) {
  return { id, sha256: walmartItemReportUtf8Sha256(id) };
}

function testAuthority() {
  return {
    schema_version: "walmart-item-report-capture-session/v1",
    session_id: "item-v6-store1-20260719-reissue-v2-session-01",
    created_at: "2026-07-19T23:50:00.000Z",
    account_scope: {
      channel: "WALMART_US",
      store_index: 1,
      seller_account_fingerprint_sha256:
        "a135315771d89961b51864ae27a80fc5e1f72c27ce9cbe1a4bf4ba7f93505127",
    },
    primary_correlations: {
      create: correlation("10000000-0000-4000-8000-000000000001"),
      ready_status: correlation("10000000-0000-4000-8000-000000000002"),
      download_locator: correlation("10000000-0000-4000-8000-000000000003"),
      report_file: correlation("10000000-0000-4000-8000-000000000004"),
    },
    trust_statement: {
      adapter_atomic_integrity: true,
      walmart_signature_claimed: false,
      tls_server_authenticity_claimed_by_artifact: false,
    },
  };
}

function ledger() {
  return {
    policy_id: "walmart-item-report-reissue-consumption-ledger/1.0.0",
    ledger_id: "ledger-item-reissue-v2-test-01",
    ledger_epoch: "epoch-item-reissue-v2-test-01",
    state_directory_path_sha256: "1".repeat(64),
    directory_identity_sha256: "2".repeat(64),
    identity_artifact_sha256: "3".repeat(64),
    reservation_filename_policy: "authorization-sha256.json/exclusive-create/v1",
    trusted_single_custody_host_only: true,
    distributed_at_most_once_claimed: false,
  };
}

async function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
  const env = {
    ...process.env,
    NODE_ENV: "test",
    WALMART_ITEM_REPORT_REISSUE_V2_TEST_MODE: "1",
    WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_KEY_ID: "item-reissue-v2-owner-test",
    WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64:
      publicDer.toString("base64"),
  };
  const release = await buildWalmartItemReportReissueSourceEvidenceV2({
    evidence_root: path.join(
      PROJECT_ROOT,
      "data/audits/walmart-source-intake",
      EVIDENCE_NAME,
    ),
    capture_root: path.join(PROJECT_ROOT, "data/audits/walmart-source-captures"),
    prior_session_name: SESSION_NAME,
    release_id: "walmart-item-v6-reissue-source-evidence-store1-20260719-v2",
    reviewed_at: "2026-07-19T23:26:39.000Z",
  });
  const releaseBytes = serializeWalmartItemReportReissueSourceEvidenceV2(release);
  const replacement = buildWalmartItemReportReissueReplacementPlanV2({
    session_name: "item-v6-store1-20260719-reissue-v2-codex-01",
    session_authority: testAuthority(),
  });
  const body = buildWalmartItemReportReissueOwnerDispositionV2Body({
    disposition_id: "item-v6-reissue-owner-disposition-20260719-01",
    environment: "TEST_FIXTURE_ONLY",
    approved_by: "owner-test",
    decision_ref: "urn:ss-command-center:test:item-v6-reissue:20260719:01",
    engine_release_sha256: "4".repeat(64),
    source_evidence_bytes: releaseBytes,
    expected_source_evidence_artifact_sha256: sha256(releaseBytes),
    replacement,
    consumption_ledger: ledger(),
    issued_at: "2026-07-20T00:00:00.000Z",
    expires_at: "2026-07-20T00:20:00.000Z",
  });
  const request = buildWalmartItemReportReissueOwnerDispositionV2SigningRequest({
    key_id: env.WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_KEY_ID,
    signed_body: body,
    env,
  });
  const envelope = {
    schema_version: request.schema_version,
    algorithm: request.algorithm,
    key_id: request.key_id,
    owner_public_key_spki_sha256: request.owner_public_key_spki_sha256,
    signed_body: request.signed_body,
  };
  const detached = sign(
    null,
    walmartItemReportReissueOwnerDispositionV2SigningMessage(envelope),
    keys.privateKey,
  );
  return { keys, env, releaseBytes, replacement, body, request, detached };
}

function expectedBindings(item, overrides = {}) {
  return {
    env: item.env,
    expected_environment: "TEST_FIXTURE_ONLY",
    expected_engine_release_sha256: "4".repeat(64),
    expected_source_evidence_bytes: item.releaseBytes,
    expected_source_evidence_artifact_sha256: sha256(item.releaseBytes),
    expected_replacement: item.replacement,
    expected_consumption_ledger: ledger(),
    ...overrides,
  };
}

function assembleFixture(item, overrides = {}) {
  return assembleWalmartItemReportReissueOwnerDispositionV2({
    signing_request: item.request,
    detached_signature: item.detached,
    ...expectedBindings(item, {
      now: new Date("2026-07-20T00:10:00.000Z"),
      ...overrides,
    }),
  });
}

function signBody(item, signedBody) {
  const request = buildWalmartItemReportReissueOwnerDispositionV2SigningRequest({
    key_id: item.env.WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_KEY_ID,
    signed_body: signedBody,
    env: item.env,
  });
  const envelope = {
    schema_version: request.schema_version,
    algorithm: request.algorithm,
    key_id: request.key_id,
    owner_public_key_spki_sha256: request.owner_public_key_spki_sha256,
    signed_body: request.signed_body,
  };
  return {
    request,
    detached: sign(
      null,
      walmartItemReportReissueOwnerDispositionV2SigningMessage(envelope),
      item.keys.privateKey,
    ),
  };
}

async function expectCode(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof WalmartItemReportReissueOwnerDispositionV2Error);
    assert.equal(error.code, code);
    return true;
  });
}

test("production trust root is intentionally fail-closed before owner enrollment", () => {
  assert.deepEqual(inspectWalmartItemReportReissueOwnerDispositionV2TrustRoot(), {
    ready: false,
    active_key_ids: [],
    active_key_fingerprints: [],
  });
});

test("assembles and verifies one exact domain-separated Ed25519 disposition", async () => {
  const item = await fixture();
  const disposition = assembleFixture(item);
  const verified = verifyWalmartItemReportReissueOwnerDispositionV2(disposition, {
    ...expectedBindings(item),
    now: new Date("2026-07-20T00:10:00.000Z"),
  });
  assert.equal(verified.signed_body.authorization.maximum_create_post_calls, 1);
  assert.equal(verified.signed_body.authorization.retry_attempts_allowed, 0);
  assert.equal(
    verified.signed_body.authorization.request_body_sha256,
    WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_EMPTY_BODY_SHA256,
  );
  assert.equal(verified.signed_body.prior_incident.consume_conflicting_final, false);
});

test("assembles and verifies against self-contained fresh renewal evidence", async () => {
  const item = await fixture();
  const repositoryRoot = path.dirname(PROJECT_ROOT);
  const baselineBytes = await readFile(path.join(
    repositoryRoot,
    "release-artifacts/walmart-item-report-reissue-v2-private-20260719",
    "evidence-release-r4-final-candidate/source-evidence-release.json",
  ));
  const probeRoot = path.join(
    PROJECT_ROOT,
    "data/audits/walmart-source-intake/item-v6-absence-probe-store1-20260722-codex-v2",
  );
  const probe = {};
  for (const name of WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES) {
    probe[name] = await readFile(path.join(probeRoot, name));
  }
  const renewal = buildWalmartItemReportReissueSourceEvidenceRenewalV1({
    release_id: "walmart-item-v6-reissue-source-renewal-store1-20260722-owner-test",
    reviewed_at: "2026-07-22T06:40:00.000Z",
    baseline_source_evidence_bytes: baselineBytes,
    fresh_probe_artifacts: probe,
    expected_probe_id: path.basename(probeRoot),
  });
  const renewalBytes = serializeWalmartItemReportReissueSourceEvidenceRenewalV1(renewal);
  const body = buildWalmartItemReportReissueOwnerDispositionV2Body({
    disposition_id: "item-v6-reissue-owner-disposition-renewal-test",
    environment: "TEST_FIXTURE_ONLY",
    approved_by: "owner-test",
    decision_ref: "urn:ss-command-center:test:item-v6-reissue:renewal",
    engine_release_sha256: "4".repeat(64),
    source_evidence_bytes: renewalBytes,
    expected_source_evidence_artifact_sha256: sha256(renewalBytes),
    replacement: item.replacement,
    consumption_ledger: ledger(),
    issued_at: "2026-07-22T06:45:00.000Z",
    expires_at: "2026-07-22T07:00:00.000Z",
  });
  const signed = signBody(item, body);
  const disposition = assembleWalmartItemReportReissueOwnerDispositionV2({
    signing_request: signed.request,
    detached_signature: signed.detached,
    env: item.env,
    expected_engine_release_sha256: "4".repeat(64),
    expected_source_evidence_bytes: renewalBytes,
    expected_source_evidence_artifact_sha256: sha256(renewalBytes),
    expected_replacement: item.replacement,
    expected_consumption_ledger: ledger(),
    now: new Date("2026-07-22T06:50:00.000Z"),
  });
  assert.equal(disposition.signed_body.source_evidence.release_id,
    renewal.body.release_id);
  assert.equal(disposition.signed_body.source_evidence.exact_probe_observed_at,
    "2026-07-22T06:39:07.290Z");
  assert.equal(disposition.signed_body.source_evidence.exact_probe_artifacts.length, 6);
  assert.equal(disposition.signed_body.evidence_fresh_until,
    "2026-07-23T06:39:07.290Z");
});

test("delegated source-only authorization needs no password or private key", async () => {
  const item = await fixture();
  const renewalBytes = await readFile(path.join(
    PROJECT_ROOT,
    "data/audits/walmart-source-intake",
    "item-v6-reissue-renewal-store1-20260722-codex-v1",
    "source-evidence-renewal.json",
  ));
  const authorization = buildWalmartItemReportReissueDelegatedAuthorizationV1({
    disposition_id: "item-v6-reissue-delegated-pilot-20260722-test",
    approved_by: "Walmart catalog owner delegated automation",
    decision_ref: "urn:ss-command-center:owner-delegation:walmart-listing-integrity:20260722",
    engine_release_sha256: "4".repeat(64),
    source_evidence_bytes: renewalBytes,
    expected_source_evidence_artifact_sha256: sha256(renewalBytes),
    replacement: item.replacement,
    consumption_ledger: ledger(),
    issued_at: "2026-07-22T06:45:00.000Z",
    expires_at: "2026-07-22T07:00:00.000Z",
  });
  const verified = verifyWalmartItemReportReissueDelegatedAuthorizationV1(
    authorization,
    {
      expected_environment: "PRODUCTION",
      expected_engine_release_sha256: "4".repeat(64),
      expected_source_evidence_bytes: renewalBytes,
      expected_source_evidence_artifact_sha256: sha256(renewalBytes),
      expected_replacement: item.replacement,
      expected_consumption_ledger: ledger(),
      now: new Date("2026-07-22T06:50:00.000Z"),
    },
  );
  assert.equal(verified.authorization_mode, "OWNER_DELEGATED_AUTOMATION");
  assert.equal(verified.signed_body.authorization.maximum_create_post_calls, 1);
  assert.equal(verified.signed_body.authorization.listing_content_writes_allowed, 0);
  assert.equal(
    assertWalmartItemReportReissueAuthorizationCurrent(
      verified,
      new Date("2026-07-22T06:50:00.000Z"),
    ),
    "2026-07-22T07:00:00.000Z",
  );
  assert.throws(
    () => verifyWalmartItemReportReissueDelegatedAuthorizationV1({
      ...authorization,
      body_sha256: "f".repeat(64),
    }, {
      expected_environment: "PRODUCTION",
      expected_engine_release_sha256: "4".repeat(64),
      expected_source_evidence_bytes: renewalBytes,
      expected_source_evidence_artifact_sha256: sha256(renewalBytes),
      expected_replacement: item.replacement,
      expected_consumption_ledger: ledger(),
    }),
    (error) => error?.code === "AUTHORIZATION_HASH_MISMATCH",
  );
});

test("rejects a signature from another domain/message", async () => {
  const item = await fixture();
  const wrongSignature = sign(null, Buffer.from("wrong-domain", "utf8"), item.keys.privateKey);
  expectCode(() => assembleWalmartItemReportReissueOwnerDispositionV2({
    signing_request: item.request,
    detached_signature: wrongSignature,
    ...expectedBindings(item, { now: new Date("2026-07-20T00:10:00.000Z") }),
  }), "INVALID_SIGNATURE");
});

test("rejects any source-evidence byte drift before building the signed body", async () => {
  const item = await fixture();
  const changed = Uint8Array.from(item.releaseBytes);
  changed[0] ^= 1;
  expectCode(() => buildWalmartItemReportReissueOwnerDispositionV2Body({
    disposition_id: "item-v6-reissue-owner-disposition-20260719-02",
    environment: "TEST_FIXTURE_ONLY",
    approved_by: "owner-test",
    decision_ref: "urn:ss-command-center:test:item-v6-reissue:20260719:02",
    engine_release_sha256: "4".repeat(64),
    source_evidence_bytes: changed,
    expected_source_evidence_artifact_sha256: sha256(item.releaseBytes),
    replacement: item.replacement,
    consumption_ledger: ledger(),
    issued_at: "2026-07-20T00:00:00.000Z",
    expires_at: "2026-07-20T00:20:00.000Z",
  }), "SOURCE_EVIDENCE_ARTIFACT_HASH_MISMATCH");
});

test("expiry is exclusive at the exact boundary", async () => {
  const item = await fixture();
  const disposition = assembleFixture(item);
  expectCode(
    () => assertWalmartItemReportReissueOwnerDispositionV2Current(
      disposition,
      new Date("2026-07-20T00:20:00.000Z"),
    ),
    "AUTHORIZATION_EXPIRED",
  );
});

test("bit-flipping a signed binding invalidates the signature", async () => {
  const item = await fixture();
  const disposition = assembleFixture(item);
  const changed = structuredClone(disposition);
  changed.signed_body.engine_release_sha256 = "5".repeat(64);
  expectCode(() => verifyWalmartItemReportReissueOwnerDispositionV2(changed, {
    ...expectedBindings(item),
  }), "INVALID_SIGNATURE");
});

test("rejects empty source-evidence and prior-incident objects before signing", async () => {
  const item = await fixture();
  const emptySource = structuredClone(item.body);
  emptySource.source_evidence = {};
  expectCode(() => buildWalmartItemReportReissueOwnerDispositionV2SigningRequest({
    key_id: item.env.WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_KEY_ID,
    signed_body: emptySource,
    env: item.env,
  }), "INVALID_DISPOSITION");

  const emptyPrior = structuredClone(item.body);
  emptyPrior.prior_incident = {};
  expectCode(() => buildWalmartItemReportReissueOwnerDispositionV2SigningRequest({
    key_id: item.env.WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_KEY_ID,
    signed_body: emptyPrior,
    env: item.env,
  }), "INVALID_DISPOSITION");
});

test("rejects a valid signature over source binding not derived from exact evidence bytes", async () => {
  const item = await fixture();
  const changedBody = structuredClone(item.body);
  changedBody.source_evidence.release_sha256 = "9".repeat(64);
  const changed = signBody(item, changedBody);
  expectCode(() => assembleWalmartItemReportReissueOwnerDispositionV2({
    signing_request: changed.request,
    detached_signature: changed.detached,
    ...expectedBindings(item, { now: new Date("2026-07-20T00:10:00.000Z") }),
  }), "BINDING_MISMATCH");
});

test("rejects a valid signature over prior incident not derived from exact evidence bytes", async () => {
  const item = await fixture();
  const changedBody = structuredClone(item.body);
  changedBody.prior_incident.session_id = "different-prior-session-id";
  const changed = signBody(item, changedBody);
  expectCode(() => assembleWalmartItemReportReissueOwnerDispositionV2({
    signing_request: changed.request,
    detached_signature: changed.detached,
    ...expectedBindings(item, { now: new Date("2026-07-20T00:10:00.000Z") }),
  }), "BINDING_MISMATCH");
});

test("production verification rejects every missing expected binding", async () => {
  const item = await fixture();
  const disposition = assembleFixture(item);
  for (const key of [
    "expected_engine_release_sha256",
    "expected_source_evidence_bytes",
    "expected_source_evidence_artifact_sha256",
    "expected_replacement",
    "expected_consumption_ledger",
  ]) {
    const incomplete = expectedBindings(item);
    delete incomplete[key];
    expectCode(
      () => verifyWalmartItemReportReissueOwnerDispositionV2(disposition, incomplete),
      "BINDING_REQUIRED",
    );
  }
  expectCode(
    () => verifyWalmartItemReportReissueOwnerDispositionV2(disposition),
    "BINDING_REQUIRED",
  );
});

test("rejects mismatched required engine, replacement, and ledger bindings", async () => {
  const item = await fixture();
  const disposition = assembleFixture(item);
  expectCode(() => verifyWalmartItemReportReissueOwnerDispositionV2(
    disposition,
    expectedBindings(item, { expected_engine_release_sha256: "5".repeat(64) }),
  ), "BINDING_MISMATCH");

  const otherReplacement = buildWalmartItemReportReissueReplacementPlanV2({
    session_name: "item-v6-store1-20260719-reissue-v2-codex-02",
    session_authority: testAuthority(),
  });
  expectCode(() => verifyWalmartItemReportReissueOwnerDispositionV2(
    disposition,
    expectedBindings(item, { expected_replacement: otherReplacement }),
  ), "BINDING_MISMATCH");

  const otherLedger = { ...ledger(), ledger_epoch: "epoch-item-reissue-v2-test-02" };
  expectCode(() => verifyWalmartItemReportReissueOwnerDispositionV2(
    disposition,
    expectedBindings(item, { expected_consumption_ledger: otherLedger }),
  ), "BINDING_MISMATCH");
});
