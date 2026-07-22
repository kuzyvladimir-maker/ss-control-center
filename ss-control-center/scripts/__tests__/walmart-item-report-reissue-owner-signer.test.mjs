import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WALMART_ITEM_REPORT_REISSUE_OWNER_SIGNER_INIT_CONFIRMATION,
  runWalmartItemReportReissueOwnerSignerCli,
} from "../walmart-item-report-reissue-owner-signer.mjs";
import { canonicalWalmartItemReportJson } from "../../src/lib/walmart/item-report-published-source.ts";

const PASSPHRASE = "correct horse battery staple owner key";
const DOMAIN = Buffer.from(
  "SS_COMMAND_CENTER\0WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION\0v2\0",
  "utf8",
);

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "walmart-owner-signer-")));
  await chmod(root, 0o700);
  t.after(async () => {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    custody: path.join(root, "owner-custody"),
    request: path.join(root, "signing-request.json"),
  };
}

function secretSequence(values) {
  let index = 0;
  return async () => Buffer.from(values[index++], "utf8");
}

function fixedAuthorization() {
  return {
    report_create_post_authorized: true,
    maximum_create_post_calls: 1,
    maximum_oauth_token_calls: 1,
    maximum_walmart_report_api_calls: 1,
    maximum_total_http_calls: 2,
    maximum_request_timeout_ms: 60_000,
    retry_attempts_allowed: 0,
    fallbacks_allowed: 0,
    redirects_followed_allowed: 0,
    automatic_replay_allowed: false,
    method: "POST",
    endpoint: "/v3/reports/reportRequests",
    report_type: "ITEM",
    report_version: "v6",
    request_body_sha256: createHash("sha256").update("{}", "utf8").digest("hex"),
    request_id_adoption_from_prior: false,
    original_session_writes_allowed: 0,
    database_calls_allowed: 0,
    model_calls_allowed: 0,
    paid_provider_calls_allowed: 0,
    listing_content_writes_allowed: 0,
    scheduled_execution_allowed: false,
  };
}

function fixedRisk() {
  return {
    exact_probe_observed_no_api_visible_v6_request: true,
    exact_probe_does_not_prove_original_post_failed: true,
    original_post_may_have_reached_walmart: true,
    duplicate_report_request_risk_is_non_zero: true,
    duplicate_report_request_risk_accepted: true,
    exact_probe_account_match_is_operator_asserted_not_machine_verified: true,
  };
}

async function init(fx) {
  return runWalmartItemReportReissueOwnerSignerCli([
    "init",
    `--custody-dir=${fx.custody}`,
    "--key-id=walmart-item-v6-reissue-owner-test",
    `--confirm=${WALMART_ITEM_REPORT_REISSUE_OWNER_SIGNER_INIT_CONFIRMATION}`,
  ], {
    read_secret: secretSequence([PASSPHRASE, PASSPHRASE]),
    now: () => new Date("2026-07-22T07:00:00.000Z"),
  });
}

async function writeRequest(fx, enrollment) {
  const body = {
    disposition_id: "item-v6-reissue-owner-test-disposition",
    action: "WALMART_ITEM_V6_REPORT_CREATE_REISSUE",
    environment: "PRODUCTION",
    approved_by: "owner-test",
    decision_ref: "urn:ss-command-center:test:item-reissue-owner-signer",
    engine_release_sha256: "1".repeat(64),
    source_evidence: {
      artifact_sha256: "2".repeat(64),
      release_id: "renewal-test",
    },
    account_scope: {
      channel: "WALMART_US",
      store_index: 1,
      seller_id: "10001624309",
      seller_account_fingerprint_sha256: "3".repeat(64),
    },
    prior_incident: { terminal_failure_retained: true },
    replacement: { session_name: "replacement-session-test" },
    consumption_ledger: { ledger_id: "ledger-test" },
    issued_at: "2026-07-22T07:01:00.000Z",
    expires_at: "2026-07-22T07:20:00.000Z",
    evidence_fresh_until: "2026-07-23T06:39:07.290Z",
    authorization: fixedAuthorization(),
    owner_risk_acknowledgement: fixedRisk(),
  };
  const envelope = {
    schema_version: "walmart-item-report-reissue-owner-disposition/v2",
    algorithm: "Ed25519",
    key_id: enrollment.key_id,
    owner_public_key_spki_sha256: enrollment.public_key_spki_sha256,
    signed_body: body,
  };
  const message = Buffer.concat([
    DOMAIN,
    Buffer.from(canonicalWalmartItemReportJson(envelope), "utf8"),
  ]);
  const request = {
    ...envelope,
    signing_message_base64: message.toString("base64"),
    signature_base64: "TODO_EXTERNAL_OWNER_ED25519_SIGNATURE_BASE64",
    signature_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE",
    authorization_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE",
  };
  const bytes = Buffer.from(canonicalWalmartItemReportJson(request), "utf8");
  await writeFile(fx.request, bytes, { flag: "wx", mode: 0o400 });
  await chmod(fx.request, 0o400);
  return { request, bytes, message };
}

test("init creates only an encrypted private key and public enrollment outside repo", async (t) => {
  const fx = await fixture(t);
  const result = await init(fx);
  assert.equal(result.status, "OWNER_KEY_CREATED");
  assert.equal(result.private_key_disclosed, false);
  assert.equal(result.network_calls, 0);
  const privatePath = path.join(fx.custody, "owner-private-key.pem");
  const enrollmentPath = path.join(fx.custody, "owner-public-enrollment.json");
  assert.equal((await stat(fx.custody)).mode & 0o777, 0o700);
  assert.equal((await stat(privatePath)).mode & 0o777, 0o400);
  assert.equal((await stat(enrollmentPath)).mode & 0o777, 0o400);
  const privateText = await readFile(privatePath, "utf8");
  assert.match(privateText, /BEGIN ENCRYPTED PRIVATE KEY/);
  assert.equal(privateText.includes(PASSPHRASE), false);
  const enrollmentBytes = await readFile(enrollmentPath);
  assert.equal(enrollmentBytes.toString("utf8"),
    canonicalWalmartItemReportJson(JSON.parse(enrollmentBytes)));
});

test("inspect exposes exact risk summary and sign emits one raw valid Ed25519 signature", async (t) => {
  const fx = await fixture(t);
  await init(fx);
  const enrollment = JSON.parse(await readFile(
    path.join(fx.custody, "owner-public-enrollment.json"),
    "utf8",
  ));
  const request = await writeRequest(fx, enrollment);
  const requestSha = createHash("sha256").update(request.bytes).digest("hex");
  const inspection = await runWalmartItemReportReissueOwnerSignerCli([
    "inspect",
    `--custody-dir=${fx.custody}`,
    `--request=${fx.request}`,
    `--expect-request-sha256=${requestSha}`,
  ]);
  assert.equal(inspection.status, "OWNER_REVIEW_REQUIRED");
  assert.equal(inspection.summary.maximum_create_post_calls, 1);
  assert.equal(inspection.summary.retries_allowed, 0);
  assert.equal(inspection.summary.duplicate_report_request_risk, true);
  const signaturePath = path.join(fx.custody, "owner-signature-test.bin");
  const signed = await runWalmartItemReportReissueOwnerSignerCli([
    "sign",
    `--custody-dir=${fx.custody}`,
    `--request=${fx.request}`,
    `--expect-request-sha256=${requestSha}`,
    `--out=${signaturePath}`,
    `--confirm=${inspection.required_confirmation}`,
  ], { read_secret: secretSequence([PASSPHRASE]) });
  assert.equal(signed.status, "DETACHED_SIGNATURE_CREATED");
  assert.equal(signed.signature_byte_length, 64);
  assert.equal(signed.network_calls, 0);
  const signature = await readFile(signaturePath);
  assert.equal((await stat(signaturePath)).mode & 0o777, 0o400);
  const publicKey = createPublicKey({
    key: Buffer.from(enrollment.public_key_spki_der_base64, "base64"),
    format: "der",
    type: "spki",
  });
  assert.equal(verify(null, request.message, publicKey, signature), true);
});

test("wrong confirmation never unlocks the key or creates a signature", async (t) => {
  const fx = await fixture(t);
  await init(fx);
  const enrollment = JSON.parse(await readFile(
    path.join(fx.custody, "owner-public-enrollment.json"),
    "utf8",
  ));
  const request = await writeRequest(fx, enrollment);
  const requestSha = createHash("sha256").update(request.bytes).digest("hex");
  let prompts = 0;
  const output = path.join(fx.custody, "must-not-exist.bin");
  await assert.rejects(
    runWalmartItemReportReissueOwnerSignerCli([
      "sign",
      `--custody-dir=${fx.custody}`,
      `--request=${fx.request}`,
      `--expect-request-sha256=${requestSha}`,
      `--out=${output}`,
      "--confirm=WRONG",
    ], { read_secret: async () => { prompts += 1; return Buffer.from(PASSPHRASE); } }),
    (error) => error?.code === "CONFIRMATION_MISMATCH",
  );
  assert.equal(prompts, 0);
  await assert.rejects(stat(output), /ENOENT/);
});
