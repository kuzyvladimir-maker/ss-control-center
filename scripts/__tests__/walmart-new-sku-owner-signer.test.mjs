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
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runWalmartNewSkuOwnerSignerCli,
} from "../walmart-new-sku-owner-signer.mjs";

const DOMAIN = Buffer.from(
  "SS_COMMAND_CENTER\0WALMART_NEW_SKU_OWNER_PERMIT\0v2\0",
  "utf8",
);
const FIXED_RANDOM = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writePrivateJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400 });
  await chmod(filePath, 0o400);
}

function signingRequest(enrollment, overrides = {}) {
  const issuedAt = "2026-07-23T03:00:00.000Z";
  const body = {
    permit_id: "owner-permit://walmart/pilot-1",
    action: "WALMART_MP_ITEM_SUBMIT",
    environment: "PRODUCTION",
    engine_release_sha256: "1".repeat(64),
    approval_sha256: "2".repeat(64),
    doctor_receipt_sha256: "3".repeat(64),
    apply_preview_receipt_sha256: "4".repeat(64),
    certification_sha256: "5".repeat(64),
    candidate_key: "candidate-ritz-bits-cheese-2pk",
    channel_sku_id: "channel-sku-walmart-pilot-1",
    sku: "WM-PILOT-RITZ-2PK",
    upc: "012345678905",
    payload_sha256: "6".repeat(64),
    store_index: 1,
    seller_account_fingerprint_sha256: "7".repeat(64),
    database_target_fingerprint_sha256: "8".repeat(64),
    pilot_slot: 1,
    max_pilot_skus: 2,
    issued_at: issuedAt,
    expires_at: "2026-07-23T03:20:00.000Z",
    approved_by: "owner-vladimir",
    decision_ref: "urn:ss-command-center:owner-decision:walmart-pilot-1",
    live_submission_authorized: true,
    claims: {
      exact_one_sku: true,
      marketplace_submission_max: 1,
      delist: false,
      reprice: false,
      purchase: false,
      schedule: false,
    },
    ...overrides,
  };
  const envelope = {
    schema_version: "walmart-new-sku-owner-permit/2.0.0",
    algorithm: "Ed25519",
    key_id: enrollment.key_id,
    owner_public_key_spki_sha256: enrollment.public_key_spki_sha256,
    signed_body: body,
  };
  const message = Buffer.concat([DOMAIN, Buffer.from(canonicalJson(envelope), "utf8")]);
  return {
    request: {
      ...envelope,
      signing_message_base64: message.toString("base64"),
      signature_base64: "TODO_EXTERNAL_OWNER_ED25519_SIGNATURE_BASE64",
      signature_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE",
      permit_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE",
    },
    message,
  };
}

async function fixture(t) {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), "walmart-new-sku-owner-signer-"));
  const root = await realpath(rawRoot);
  const custody = path.join(root, "custody");
  t.after(async () => {
    await chmod(custody, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const secrets = new Map();
  const init = await runWalmartNewSkuOwnerSignerCli([
    "init",
    `--custody-dir=${custody}`,
    "--key-id=walmart-new-sku-owner-2026-01",
  ], {
    random_bytes: () => Buffer.from(FIXED_RANDOM),
    store_secret: async (keyId, secret) => {
      secrets.set(keyId, Buffer.from(secret));
    },
    delete_secret: async (keyId) => {
      secrets.delete(keyId);
    },
    now: () => new Date("2026-07-23T02:55:00.000Z"),
  });
  const enrollment = JSON.parse(await readFile(init.public_enrollment_path, "utf8"));
  return { root, custody, init, enrollment, secrets };
}

test("help exposes only offline owner-custody operations", async () => {
  const result = await runWalmartNewSkuOwnerSignerCli(["help"]);
  assert.deepEqual(result.commands, ["init", "doctor", "inspect", "sign"]);
  assert.equal(result.private_key_via_argv_or_env_allowed, false);
  assert.equal(result.private_key_unlock_provider, "MACOS_LOGIN_KEYCHAIN");
  assert.equal(result.user_managed_password_required, false);
  assert.equal(result.network_available, false);
  assert.equal(result.walmart_credentials_available, false);
  assert.equal(result.database_available, false);
});

test("init keeps an encrypted key outside the repository and discloses only enrollment", async (t) => {
  const fx = await fixture(t);
  assert.equal(fx.init.status, "OWNER_KEY_CREATED");
  assert.equal(fx.init.private_key_encrypted_at_rest, true);
  assert.equal(fx.init.private_key_disclosed, false);
  assert.equal(fx.init.user_managed_password_required, false);
  assert.match(
    await readFile(path.join(fx.custody, "walmart-owner-control-private-key.pem"), "utf8"),
    /BEGIN ENCRYPTED PRIVATE KEY/u,
  );
  assert.equal(fx.enrollment.environment, "PRODUCTION");
  assert.equal(fx.enrollment.domain, "WALMART_OWNER_CONTROL");
  assert.equal(fx.enrollment.private_key_unlock_provider, "MACOS_LOGIN_KEYCHAIN");
  assert.equal(fx.enrollment.user_managed_password_required, false);
  assert.deepEqual(fx.enrollment.allowed_signing_domains, [
    "WALMART_ITEM_V6_CATALOG_ACTIVATE",
    "WALMART_ITEM_V6_REPORT_CREATE_REISSUE",
    "WALMART_MP_ITEM_SUBMIT",
  ]);
  assert.equal(fx.enrollment.public_key_spki_sha256, fx.init.public_key_spki_sha256);
  assert.equal(fx.init.network_calls, 0);
  assert.equal(fx.init.walmart_calls, 0);
  const doctor = await runWalmartNewSkuOwnerSignerCli([
    "doctor",
    `--custody-dir=${fx.custody}`,
  ], {
    read_secret: async (keyId) => Buffer.from(fx.secrets.get(keyId)),
  });
  assert.equal(doctor.status, "OWNER_CONTROL_READY");
  assert.equal(doctor.public_key_spki_sha256, fx.init.public_key_spki_sha256);
  assert.equal(doctor.user_managed_password_required, false);
});

test("inspect shows exact one-SKU risk and sign emits one valid raw signature", async (t) => {
  const fx = await fixture(t);
  const built = signingRequest(fx.enrollment);
  const requestPath = path.join(fx.root, "owner-permit-request.json");
  await writePrivateJson(requestPath, built.request);
  const requestBytes = await readFile(requestPath);
  const requestSha = sha256(requestBytes);

  const inspected = await runWalmartNewSkuOwnerSignerCli([
    "inspect",
    `--custody-dir=${fx.custody}`,
    `--request=${requestPath}`,
    `--expect-request-sha256=${requestSha}`,
  ], {
    now: () => new Date("2026-07-23T03:00:30.000Z"),
  });
  assert.equal(inspected.status, "OWNER_REVIEW_REQUIRED");
  assert.equal(inspected.summary.sku, "WM-PILOT-RITZ-2PK");
  assert.equal(inspected.summary.upc, "012345678905");
  assert.equal(inspected.summary.marketplace_submission_max, 1);
  assert.equal(inspected.summary.delist, false);
  assert.equal(inspected.summary.schedule, false);

  const signaturePath = path.join(fx.custody, "pilot-1-signature.bin");
  const signed = await runWalmartNewSkuOwnerSignerCli([
    "sign",
    `--custody-dir=${fx.custody}`,
    `--request=${requestPath}`,
    `--expect-request-sha256=${requestSha}`,
    `--out=${signaturePath}`,
    `--confirm=${inspected.required_confirmation}`,
  ], {
    read_secret: async (keyId) => Buffer.from(fx.secrets.get(keyId)),
    now: () => new Date("2026-07-23T03:00:30.000Z"),
  });
  const signature = await readFile(signaturePath);
  const publicKey = createPublicKey({
    key: Buffer.from(fx.enrollment.public_key_spki_der_base64, "base64"),
    format: "der",
    type: "spki",
  });
  assert.equal(signed.status, "DETACHED_SIGNATURE_CREATED");
  assert.equal(signature.byteLength, 64);
  assert.equal(signed.signature_sha256, sha256(signature));
  assert.equal(verify(null, built.message, publicKey, signature), true);
  assert.equal(signed.network_calls, 0);
  assert.equal(signed.walmart_calls, 0);
  assert.equal(signed.database_calls, 0);
});

test("modified scope, wrong request hash and repository custody fail closed", async (t) => {
  const fx = await fixture(t);
  const broadened = signingRequest(fx.enrollment, {
    claims: {
      exact_one_sku: true,
      marketplace_submission_max: 1,
      delist: false,
      reprice: false,
      purchase: false,
      schedule: true,
    },
  });
  const requestPath = path.join(fx.root, "broadened-request.json");
  await writePrivateJson(requestPath, broadened.request);
  const requestSha = sha256(await readFile(requestPath));

  await assert.rejects(
    runWalmartNewSkuOwnerSignerCli([
      "inspect",
      `--custody-dir=${fx.custody}`,
      `--request=${requestPath}`,
      `--expect-request-sha256=${requestSha}`,
    ]),
    /outside the exact Walmart one-SKU domain/u,
  );
  await assert.rejects(
    runWalmartNewSkuOwnerSignerCli([
      "inspect",
      `--custody-dir=${fx.custody}`,
      `--request=${requestPath}`,
      `--expect-request-sha256=${"f".repeat(64)}`,
    ]),
    /differs from expected/u,
  );

  const expired = signingRequest(fx.enrollment, {
    issued_at: "2026-07-23T01:00:00.000Z",
    expires_at: "2026-07-23T01:20:00.000Z",
  });
  const expiredPath = path.join(fx.root, "expired-request.json");
  await writePrivateJson(expiredPath, expired.request);
  await assert.rejects(
    runWalmartNewSkuOwnerSignerCli([
      "inspect",
      `--custody-dir=${fx.custody}`,
      `--request=${expiredPath}`,
      `--expect-request-sha256=${sha256(await readFile(expiredPath))}`,
    ], {
      now: () => new Date("2026-07-23T03:00:30.000Z"),
    }),
    /outside the exact Walmart one-SKU domain/u,
  );

  await assert.rejects(
    runWalmartNewSkuOwnerSignerCli([
      "init",
      `--custody-dir=${path.join(process.cwd(), "forbidden-owner-custody")}`,
      "--key-id=forbidden-owner-key",
    ]),
    /outside the repository/u,
  );
});
