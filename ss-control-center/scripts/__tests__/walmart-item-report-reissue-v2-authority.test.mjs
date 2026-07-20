import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  authorWalmartItemReportReissueDispositionRequestV2,
  authorWalmartItemReportReissueDispositionV2,
  authorWalmartItemReportReissueReplacementPlanV2,
  createWalmartItemReportReissueReplacementPlanV2,
} from "../walmart-item-report-reissue-v2-authority.mjs";
import {
  buildWalmartItemReportReissueSourceEvidenceV2,
  serializeWalmartItemReportReissueSourceEvidenceV2,
} from "../../src/lib/walmart/item-report-reissue-source-evidence-v2.ts";
import { canonicalWalmartItemReportJson } from "../../src/lib/walmart/item-report-published-source.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const INCIDENT_SESSION = "item-v6-store1-20260718-codex-v1";
const ACCOUNT_FINGERPRINT =
  "a135315771d89961b51864ae27a80fc5e1f72c27ce9cbe1a4bf4ba7f93505127";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function privateTemp(t) {
  const created = await mkdtemp(path.join(os.tmpdir(), "walmart-item-reissue-authority-"));
  const root = await realpath(created);
  await chmod(root, 0o700);
  t.after(async () => {
    // Evidence is intentionally immutable during the test. The test runner's
    // temporary root cleanup is outside the production authoring surface.
    const { rm } = await import("node:fs/promises");
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function writePrivate(filePath, bytes) {
  await writeFile(filePath, bytes, { flag: "wx", mode: 0o400 });
  await chmod(filePath, 0o400);
}

function deterministicUuids() {
  let index = 0;
  return () => `20000000-0000-4000-8000-${String(++index).padStart(12, "0")}`;
}

function ledgerBinding() {
  return {
    policy_id: "walmart-item-report-reissue-consumption-ledger/1.0.0",
    ledger_id: "ledger-item-reissue-v2-authority-test",
    ledger_epoch: "epoch-item-reissue-v2-authority-test",
    state_directory_path_sha256: "1".repeat(64),
    directory_identity_sha256: "2".repeat(64),
    identity_artifact_sha256: "3".repeat(64),
    reservation_filename_policy: "authorization-sha256.json/exclusive-create/v1",
    trusted_single_custody_host_only: true,
    distributed_at_most_once_claimed: false,
  };
}

async function sourceEvidenceBytes() {
  const release = await buildWalmartItemReportReissueSourceEvidenceV2({
    evidence_root: path.join(
      PROJECT_ROOT,
      "data/audits/walmart-source-intake/item-v6-disposition-probe-store1-20260719-claude-v1",
    ),
    capture_root: path.join(PROJECT_ROOT, "data/audits/walmart-source-captures"),
    prior_session_name: INCIDENT_SESSION,
    release_id: "walmart-item-v6-reissue-source-evidence-store1-20260719-v2",
    reviewed_at: "2026-07-19T23:26:39.000Z",
  });
  return serializeWalmartItemReportReissueSourceEvidenceV2(release);
}

test("replacement authoring writes one immutable canonical plan with distinct correlations", async (t) => {
  const root = await privateTemp(t);
  const out = path.join(root, "replacement.json");
  const result = await authorWalmartItemReportReissueReplacementPlanV2({
    session_name: "item-v6-store1-20260720-reissue-v2-authority-test",
    created_at: "2026-07-20T02:05:00.000Z",
    account_fingerprint_sha256: ACCOUNT_FINGERPRINT,
    out,
  }, { random_uuid: deterministicUuids() });

  const bytes = await readFile(out);
  const parsed = JSON.parse(bytes);
  assert.equal(bytes.toString("utf8"), canonicalWalmartItemReportJson(parsed));
  assert.equal(result.artifact.sha256, sha256(bytes));
  assert.equal(result.network_calls, 0);
  assert.equal(new Set(Object.values(parsed.session_authority.primary_correlations)
    .map((entry) => entry.sha256)).size, 4);

  await assert.rejects(
    authorWalmartItemReportReissueReplacementPlanV2({
      session_name: "item-v6-store1-20260720-reissue-v2-authority-test",
      created_at: "2026-07-20T02:05:00.000Z",
      account_fingerprint_sha256: ACCOUNT_FINGERPRINT,
      out,
    }, { random_uuid: deterministicUuids() }),
    (error) => error?.code === "OUTPUT_EXISTS",
  );
  assert.throws(
    () => createWalmartItemReportReissueReplacementPlanV2({
      session_name: "..",
      created_at: "2026-07-20T02:05:00.000Z",
      account_fingerprint_sha256: ACCOUNT_FINGERPRINT,
    }, { random_uuid: deterministicUuids() }),
    (error) => error?.code === "INVALID_INPUT",
  );
});

test("request and assembly bind exact evidence, release, replacement, ledger, and owner signature", async (t) => {
  const root = await privateTemp(t);
  const keys = generateKeyPairSync("ed25519");
  const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
  const env = {
    ...process.env,
    NODE_ENV: "test",
    WALMART_ITEM_REPORT_REISSUE_V2_TEST_MODE: "1",
    WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_KEY_ID: "item-reissue-v2-owner-authority-test",
    WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64:
      publicDer.toString("base64"),
  };
  const sourceBytes = await sourceEvidenceBytes();
  const sourcePath = path.join(root, "source-evidence.json");
  const replacementPath = path.join(root, "replacement.json");
  const ledgerPath = path.join(root, "ledger.json");
  await writePrivate(sourcePath, sourceBytes);
  const replacement = createWalmartItemReportReissueReplacementPlanV2({
    session_name: "item-v6-store1-20260720-reissue-v2-authority-test-2",
    created_at: "2026-07-20T02:05:00.000Z",
    account_fingerprint_sha256: ACCOUNT_FINGERPRINT,
  }, { random_uuid: deterministicUuids() });
  await writePrivate(replacementPath, Buffer.from(canonicalWalmartItemReportJson(replacement)));
  await writePrivate(ledgerPath, Buffer.from(canonicalWalmartItemReportJson(ledgerBinding())));

  const requestPath = path.join(root, "signing-request.json");
  const requestResult = await authorWalmartItemReportReissueDispositionRequestV2({
    source_evidence: sourcePath,
    expected_source_evidence_sha256: sha256(sourceBytes),
    replacement: replacementPath,
    ledger_binding: ledgerPath,
    engine_release_sha256: "4".repeat(64),
    key_id: env.WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_KEY_ID,
    disposition_id: "item-v6-reissue-owner-disposition-authority-test",
    approved_by: "owner-test",
    decision_ref: "urn:ss-command-center:test:item-v6-reissue:authority",
    issued_at: "2026-07-20T02:10:00.000Z",
    expires_at: "2026-07-20T02:30:00.000Z",
    environment: "TEST_FIXTURE_ONLY",
    out: requestPath,
    env,
  });
  assert.equal(requestResult.network_calls, 0);
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const signature = sign(
    null,
    Buffer.from(request.signing_message_base64, "base64"),
    keys.privateKey,
  );
  const signaturePath = path.join(root, "owner-signature.bin");
  await writePrivate(signaturePath, signature);

  const dispositionPath = path.join(root, "owner-disposition.json");
  const assembled = await authorWalmartItemReportReissueDispositionV2({
    source_evidence: sourcePath,
    expected_source_evidence_sha256: sha256(sourceBytes),
    replacement: replacementPath,
    ledger_binding: ledgerPath,
    engine_release_sha256: "4".repeat(64),
    signing_request: requestPath,
    detached_signature: signaturePath,
    out: dispositionPath,
    env,
    now: new Date("2026-07-20T02:11:00.000Z"),
  });
  const disposition = JSON.parse(await readFile(dispositionPath, "utf8"));
  assert.equal(assembled.authorization_sha256, disposition.authorization_sha256);
  assert.equal(disposition.signed_body.replacement.session_name, replacement.session_name);
  assert.equal(disposition.signed_body.consumption_ledger.ledger_id, ledgerBinding().ledger_id);
  assert.equal(disposition.signed_body.engine_release_sha256, "4".repeat(64));
  assert.equal(assembled.network_calls, 0);
});
