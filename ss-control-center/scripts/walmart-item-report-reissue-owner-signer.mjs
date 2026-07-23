#!/usr/bin/env node

/**
 * Owner-only Walmart control-key custody and detached signer for
 * the exact ITEM-v6 reissue authorization domain. The same public key may be
 * pinned for other Walmart owner actions, but domain separation makes their
 * signatures non-interchangeable.
 *
 * The private key is encrypted at rest, created outside the repository, never
 * accepted via argv/env, and never printed. This tool has no credentials,
 * Walmart, database, provider, or model client.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REPOSITORY_ROOT = path.resolve(PROJECT_ROOT, "..");
const CAPTURE_ROOT = path.join(PROJECT_ROOT, "data/audits/walmart-source-captures");
const PRIVATE_KEY_NAME = "walmart-owner-control-private-key.pem";
const ENROLLMENT_NAME = "walmart-owner-control-public-enrollment.json";
const KEY_SCHEMA = "walmart-owner-control-key-enrollment/1.0.0";
const KEY_DOMAIN = "WALMART_OWNER_CONTROL";
const KEYCHAIN_SERVICE = "com.ss-command-center.walmart-owner-control.v1";
const ALLOWED_SIGNING_DOMAINS = Object.freeze([
  "WALMART_ITEM_V6_CATALOG_ACTIVATE",
  "WALMART_ITEM_V6_REPORT_CREATE_REISSUE",
  "WALMART_MP_ITEM_SUBMIT",
]);
const REQUEST_SCHEMA = "walmart-item-report-reissue-owner-disposition/v2";
const ACTION = "WALMART_ITEM_V6_REPORT_CREATE_REISSUE";
const DOMAIN = Buffer.from(
  "SS_COMMAND_CENTER\0WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION\0v2\0",
  "utf8",
);
const SHA256 = /^[a-f0-9]{64}$/u;

export class WalmartItemReportReissueOwnerSignerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalmartItemReportReissueOwnerSignerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WalmartItemReportReissueOwnerSignerError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_JSON", "non-finite number is forbidden");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("INVALID_JSON", `canonical JSON does not support ${typeof value}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactString(value, label, maximum = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_INPUT", `${label} is invalid`);
  }
  return value;
}

function identifier(value, label) {
  const parsed = exactString(value, label, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(parsed)
    || parsed.includes("//") || parsed.endsWith("/")) {
    fail("INVALID_INPUT", `${label} is not a safe identifier`);
  }
  return parsed;
}

function exactAbsolute(value, label) {
  const parsed = exactString(value, label);
  if (!path.isAbsolute(parsed) || path.normalize(parsed) !== parsed) {
    fail("INVALID_INPUT", `${label} must be an exact normalized absolute path`);
  }
  return parsed;
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

async function assertRealDirectory(directory, label, privateMode = false) {
  const info = await lstat(directory).catch(() => fail(
    "UNSAFE_PATH",
    `${label} does not exist`,
  ));
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory
    || (privateMode && ((info.mode & 0o077) !== 0 || (info.mode & 0o500) !== 0o500))) {
    fail("UNSAFE_PATH", `${label} must be a ${privateMode ? "private " : ""}real directory`);
  }
  return info;
}

async function assertExternalCustodyPath(custodyDir, mustExist) {
  const exact = exactAbsolute(custodyDir, "--custody-dir");
  if (isWithin(exact, REPOSITORY_ROOT) || isWithin(exact, CAPTURE_ROOT)) {
    fail("OWNER_CUSTODY_REQUIRED", "owner key custody must be outside repository and capture roots");
  }
  const parent = path.dirname(exact);
  await assertRealDirectory(parent, "custody parent");
  const exists = await lstat(exact).then(() => true).catch((error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
  if (mustExist && !exists) fail("CUSTODY_NOT_FOUND", "owner custody directory does not exist");
  if (!mustExist && exists) fail("CUSTODY_EXISTS", "owner custody directory already exists");
  if (mustExist) await assertRealDirectory(exact, "owner custody directory", true);
  return exact;
}

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusive(filePath, bytes, mode = 0o400) {
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0),
    mode,
  ).catch((error) => {
    if (error?.code === "EEXIST") fail("OUTPUT_EXISTS", `${path.basename(filePath)} already exists`);
    fail("OUTPUT_WRITE_FAILED", `${path.basename(filePath)} could not be created`);
  });
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readStable(filePath, label, maximumBytes = 512 * 1024) {
  const exact = exactAbsolute(filePath, label);
  const beforePath = await lstat(exact).catch(() => fail("ARTIFACT_NOT_FOUND", `${label} is missing`));
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1
    || (beforePath.mode & 0o022) !== 0 || (beforePath.mode & 0o400) === 0
    || beforePath.size < 1 || beforePath.size > maximumBytes || await realpath(exact) !== exact) {
    fail("UNSAFE_ARTIFACT", `${label} is not a stable owner-readable regular file`);
  }
  const handle = await open(exact, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!sameFile(beforePath, before)) fail("ARTIFACT_READ_RACE", `${label} raced before read`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const afterPath = await lstat(exact);
    if (bytes.byteLength !== before.size || !sameFile(before, after)
      || !sameFile(after, afterPath) || await realpath(exact) !== exact) {
      fail("ARTIFACT_READ_RACE", `${label} changed while being read`);
    }
    return Buffer.from(bytes);
  } finally {
    await handle.close();
  }
}

function parseCanonical(bytes, label) {
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail("INVALID_ARTIFACT", `${label} is not UTF-8 JSON`);
  }
  if (!isRecord(value) || text !== canonicalJson(value)) {
    fail("NON_CANONICAL_ARTIFACT", `${label} must be one canonical JSON object`);
  }
  return value;
}

function parseArgs(argv) {
  const command = argv[0] ?? "help";
  const values = new Map();
  for (const argument of argv.slice(1)) {
    if (!argument.startsWith("--") || !argument.includes("=")) {
      fail("INVALID_CLI", "arguments must use exact --name=value form");
    }
    const offset = argument.indexOf("=");
    const name = argument.slice(2, offset);
    const value = argument.slice(offset + 1);
    if (!name || !value || values.has(name)) fail("INVALID_CLI", "argument is empty or repeated");
    values.set(name, value);
  }
  return { command, values };
}

function exactOptions(values, names) {
  const actual = [...values.keys()].sort();
  const expected = [...names].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail("INVALID_CLI", `exact options required: ${expected.map((name) => `--${name}`).join(", ")}`);
  }
}

function validateMachineSecret(value) {
  if (!Buffer.isBuffer(value) || value.byteLength < 32 || value.byteLength > 256
    || value.includes(0) || /[\u0000-\u001f\u007f]/u.test(value.toString("utf8"))) {
    fail("INVALID_KEYCHAIN_SECRET", "macOS Keychain returned an invalid machine secret");
  }
  return value;
}

function runSecurity(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const collect = (target, maximum, chunk, label) => {
      const bytes = Buffer.from(chunk);
      const next = (label === "stdout" ? stdoutBytes : stderrBytes) + bytes.byteLength;
      if (next > maximum) {
        child.kill("SIGKILL");
        return;
      }
      if (label === "stdout") stdoutBytes = next;
      else stderrBytes = next;
      target.push(bytes);
    };
    child.stdout.on("data", (chunk) => collect(stdout, 4096, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, 4096, chunk, "stderr"));
    child.once("error", () => reject(
      new WalmartItemReportReissueOwnerSignerError(
        "KEYCHAIN_UNAVAILABLE",
        "macOS Keychain command could not start",
      ),
    ));
    child.once("close", (code) => {
      if (code !== 0 || stdoutBytes > 4096 || stderrBytes > 4096) {
        reject(new WalmartItemReportReissueOwnerSignerError(
          "KEYCHAIN_OPERATION_FAILED",
          "macOS Keychain operation failed",
        ));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

async function storeMachineSecret(keyId, secret) {
  await runSecurity([
    "add-generic-password",
    "-a", keyId,
    "-s", KEYCHAIN_SERVICE,
    "-D", "SS Command Center Walmart owner control key",
    "-l", `SS Command Center Walmart owner control (${keyId})`,
    "-T", "/usr/bin/security",
    "-X", secret.toString("hex"),
  ]);
}

async function readMachineSecret(keyId) {
  const output = await runSecurity([
    "find-generic-password",
    "-a", keyId,
    "-s", KEYCHAIN_SERVICE,
    "-w",
  ]);
  const bytes = output.at(-1) === 0x0a ? output.subarray(0, -1) : output;
  return validateMachineSecret(Buffer.from(bytes));
}

async function deleteMachineSecret(keyId) {
  await runSecurity([
    "delete-generic-password",
    "-a", keyId,
    "-s", KEYCHAIN_SERVICE,
  ]);
}

function keyEnrollment(keyId, publicDer, createdAt) {
  return {
    schema_version: KEY_SCHEMA,
    domain: KEY_DOMAIN,
    allowed_signing_domains: ALLOWED_SIGNING_DOMAINS,
    algorithm: "Ed25519",
    key_id: keyId,
    status: "ACTIVE",
    environment: "PRODUCTION",
    public_key_spki_der_base64: publicDer.toString("base64"),
    public_key_spki_sha256: sha256(publicDer),
    private_key_file: PRIVATE_KEY_NAME,
    private_key_export: "PKCS8_PEM_AES_256_CBC",
    private_key_encrypted_at_rest: true,
    private_key_created_outside_repository: true,
    private_key_unlock_provider: "MACOS_LOGIN_KEYCHAIN",
    keychain_service: KEYCHAIN_SERVICE,
    keychain_account: keyId,
    user_managed_password_required: false,
    created_at: createdAt,
  };
}

async function initKey(input, injected) {
  const custodyDir = await assertExternalCustodyPath(input.custody_dir, false);
  const keyId = identifier(input.key_id, "key_id");
  const randomSecretBytes = Buffer.from((injected.random_bytes ?? randomBytes)(32));
  const machineSecret = validateMachineSecret(
    Buffer.from(randomSecretBytes.toString("base64url"), "utf8"),
  );
  randomSecretBytes.fill(0);
  const storeSecret = injected.store_secret ?? storeMachineSecret;
  const deleteSecret = injected.delete_secret ?? deleteMachineSecret;
  let secretStored = false;
  let custodyPublished = false;
  try {
    const { publicKey, privateKey } = (injected.generate_key_pair ?? generateKeyPairSync)("ed25519");
    const publicDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
    const encryptedPrivate = Buffer.from(privateKey.export({
      format: "pem",
      type: "pkcs8",
      cipher: "aes-256-cbc",
      passphrase: machineSecret,
    }));
    const enrollment = keyEnrollment(
      keyId,
      publicDer,
      (injected.now ?? (() => new Date()))().toISOString(),
    );
    const parent = path.dirname(custodyDir);
    const temporary = path.join(parent, `.walmart-item-owner-key-${randomUUID()}.tmp`);
    await storeSecret(keyId, machineSecret);
    secretStored = true;
    try {
      await mkdir(temporary, { mode: 0o700 });
      await chmod(temporary, 0o700);
      await writeExclusive(path.join(temporary, PRIVATE_KEY_NAME), encryptedPrivate, 0o400);
      await writeExclusive(
        path.join(temporary, ENROLLMENT_NAME),
        Buffer.from(canonicalJson(enrollment), "utf8"),
        0o400,
      );
      await syncDirectory(temporary);
      await rename(temporary, custodyDir);
      custodyPublished = true;
      await syncDirectory(parent);
    } catch (error) {
      const cleanupTarget = custodyPublished ? custodyDir : temporary;
      await chmod(cleanupTarget, 0o700).catch(() => {});
      await rm(cleanupTarget, { recursive: true, force: true }).catch(() => {});
      if (secretStored) await deleteSecret(keyId).catch(() => {});
      throw error;
    } finally {
      encryptedPrivate.fill(0);
    }
    return {
      command: "init",
      status: "OWNER_KEY_CREATED",
      custody_dir: custodyDir,
      public_enrollment_path: path.join(custodyDir, ENROLLMENT_NAME),
      key_id: keyId,
      public_key_spki_sha256: enrollment.public_key_spki_sha256,
      private_key_encrypted_at_rest: true,
      private_key_disclosed: false,
      private_key_unlock_provider: "MACOS_LOGIN_KEYCHAIN",
      user_managed_password_required: false,
      network_calls: 0,
      walmart_calls: 0,
      model_calls: 0,
    };
  } finally {
    machineSecret.fill(0);
  }
}

function parseEnrollment(bytes) {
  const value = parseCanonical(bytes, "owner public enrollment");
  const publicDer = Buffer.from(exactString(
    value.public_key_spki_der_base64,
    "public key base64",
    4096,
  ), "base64");
  if (publicDer.byteLength < 1 || publicDer.toString("base64") !== value.public_key_spki_der_base64
    || value.schema_version !== KEY_SCHEMA || value.domain !== KEY_DOMAIN
    || canonicalJson(value.allowed_signing_domains) !== canonicalJson(ALLOWED_SIGNING_DOMAINS)
    || value.algorithm !== "Ed25519" || value.environment !== "PRODUCTION"
    || value.status !== "ACTIVE" || value.private_key_file !== PRIVATE_KEY_NAME
    || value.private_key_export !== "PKCS8_PEM_AES_256_CBC"
    || value.private_key_encrypted_at_rest !== true
    || value.private_key_created_outside_repository !== true
    || value.private_key_unlock_provider !== "MACOS_LOGIN_KEYCHAIN"
    || value.keychain_service !== KEYCHAIN_SERVICE
    || value.keychain_account !== value.key_id
    || value.user_managed_password_required !== false
    || !SHA256.test(String(value.public_key_spki_sha256))
    || sha256(publicDer) !== value.public_key_spki_sha256) {
    fail("INVALID_ENROLLMENT", "owner public enrollment is invalid");
  }
  const publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") fail("INVALID_ENROLLMENT", "owner key is not Ed25519");
  return {
    value,
    publicDer,
    key_id: identifier(value.key_id, "enrollment key_id"),
    fingerprint: String(value.public_key_spki_sha256),
  };
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

function parseSigningRequest(bytes, enrollment) {
  const request = parseCanonical(bytes, "owner signing request");
  const body = isRecord(request.signed_body) ? request.signed_body : fail(
    "INVALID_SIGNING_REQUEST",
    "signed_body is invalid",
  );
  if (request.schema_version !== REQUEST_SCHEMA || request.algorithm !== "Ed25519"
    || request.key_id !== enrollment.key_id
    || request.owner_public_key_spki_sha256 !== enrollment.fingerprint
    || request.signature_base64 !== "TODO_EXTERNAL_OWNER_ED25519_SIGNATURE_BASE64"
    || request.signature_sha256 !== "TODO_AFTER_EXTERNAL_SIGNATURE"
    || request.authorization_sha256 !== "TODO_AFTER_EXTERNAL_SIGNATURE"
    || body.action !== ACTION || body.environment !== "PRODUCTION"
    || !isRecord(body.account_scope) || body.account_scope.channel !== "WALMART_US"
    || body.account_scope.store_index !== 1 || body.account_scope.seller_id !== "10001624309"
    || !isRecord(body.source_evidence) || !isRecord(body.replacement)
    || !isRecord(body.consumption_ledger)
    || canonicalJson(body.authorization) !== canonicalJson(fixedAuthorization())
    || canonicalJson(body.owner_risk_acknowledgement) !== canonicalJson(fixedRisk())) {
    fail("INVALID_SIGNING_REQUEST", "signing request is outside the exact ITEM-v6 owner domain");
  }
  const envelope = {
    schema_version: request.schema_version,
    algorithm: request.algorithm,
    key_id: request.key_id,
    owner_public_key_spki_sha256: request.owner_public_key_spki_sha256,
    signed_body: body,
  };
  const message = Buffer.concat([DOMAIN, Buffer.from(canonicalJson(envelope), "utf8")]);
  if (request.signing_message_base64 !== message.toString("base64")) {
    fail("INVALID_SIGNING_REQUEST", "signing_message does not bind the exact envelope");
  }
  const messageSha = sha256(message);
  return {
    request,
    body,
    message,
    message_sha256: messageSha,
    confirmation: `SIGN_ITEM_V6_REISSUE_${messageSha.slice(0, 16).toUpperCase()}`,
    summary: {
      action: body.action,
      environment: body.environment,
      approved_by: body.approved_by,
      decision_ref: body.decision_ref,
      disposition_id: body.disposition_id,
      account_scope: body.account_scope,
      engine_release_sha256: body.engine_release_sha256,
      source_evidence_artifact_sha256: body.source_evidence.artifact_sha256,
      source_evidence_release_id: body.source_evidence.release_id,
      evidence_fresh_until: body.evidence_fresh_until,
      replacement_session_name: body.replacement.session_name,
      ledger_id: body.consumption_ledger.ledger_id,
      maximum_create_post_calls: body.authorization.maximum_create_post_calls,
      retries_allowed: body.authorization.retry_attempts_allowed,
      duplicate_report_request_risk: body.owner_risk_acknowledgement.duplicate_report_request_risk_is_non_zero,
      duplicate_risk_accepted: body.owner_risk_acknowledgement.duplicate_report_request_risk_accepted,
    },
  };
}

async function loadCustody(custodyDir) {
  const exact = await assertExternalCustodyPath(custodyDir, true);
  const enrollment = parseEnrollment(await readStable(
    path.join(exact, ENROLLMENT_NAME),
    "owner public enrollment",
  ));
  return { custodyDir: exact, enrollment };
}

async function inspect(input) {
  const { enrollment } = await loadCustody(input.custody_dir);
  const requestBytes = await readStable(input.request, "signing request");
  if (sha256(requestBytes) !== input.expected_request_sha256) {
    fail("REQUEST_HASH_MISMATCH", "signing request differs from expected SHA-256");
  }
  const parsed = parseSigningRequest(requestBytes, enrollment);
  return {
    command: "inspect",
    status: "OWNER_REVIEW_REQUIRED",
    key_id: enrollment.key_id,
    public_key_spki_sha256: enrollment.fingerprint,
    request_sha256: sha256(requestBytes),
    signing_message_sha256: parsed.message_sha256,
    required_confirmation: parsed.confirmation,
    summary: parsed.summary,
    network_calls: 0,
    walmart_calls: 0,
    model_calls: 0,
  };
}

async function signRequest(input, injected) {
  const { custodyDir, enrollment } = await loadCustody(input.custody_dir);
  const output = exactAbsolute(input.out, "--out");
  if (path.dirname(output) !== custodyDir || path.basename(output) === PRIVATE_KEY_NAME
    || path.basename(output) === ENROLLMENT_NAME) {
    fail("INVALID_OUTPUT", "signature --out must be a new direct child of owner custody");
  }
  const exists = await lstat(output).then(() => true).catch((error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
  if (exists) fail("OUTPUT_EXISTS", "signature output already exists");
  const requestBytes = await readStable(input.request, "signing request");
  if (!SHA256.test(input.expected_request_sha256)
    || sha256(requestBytes) !== input.expected_request_sha256) {
    fail("REQUEST_HASH_MISMATCH", "signing request differs from expected SHA-256");
  }
  const parsed = parseSigningRequest(requestBytes, enrollment);
  if (input.confirm !== parsed.confirmation) {
    fail("CONFIRMATION_MISMATCH", `exact confirmation required: ${parsed.confirmation}`);
  }
  const readSecret = injected.read_secret ?? readMachineSecret;
  const machineSecret = validateMachineSecret(await readSecret(enrollment.key_id));
  try {
    const privateBytes = await readStable(
      path.join(custodyDir, PRIVATE_KEY_NAME),
      "encrypted owner private key",
    );
    let privateKey;
    try {
      privateKey = createPrivateKey({ key: privateBytes, format: "pem", passphrase: machineSecret });
    } catch {
      fail("PRIVATE_KEY_UNLOCK_FAILED", "owner private key could not be unlocked");
    } finally {
      privateBytes.fill(0);
    }
    const publicDer = Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" }));
    if (sha256(publicDer) !== enrollment.fingerprint) {
      fail("PRIVATE_KEY_MISMATCH", "unlocked private key does not match enrolled public key");
    }
    const signature = sign(null, parsed.message, privateKey);
    if (signature.byteLength !== 64) fail("SIGNATURE_FAILED", "Ed25519 signature is not 64 bytes");
    await writeExclusive(output, signature, 0o400);
    await syncDirectory(custodyDir);
    return {
      command: "sign",
      status: "DETACHED_SIGNATURE_CREATED",
      signature_path: output,
      signature_sha256: sha256(signature),
      signature_byte_length: signature.byteLength,
      request_sha256: sha256(requestBytes),
      signing_message_sha256: parsed.message_sha256,
      key_id: enrollment.key_id,
      public_key_spki_sha256: enrollment.fingerprint,
      network_calls: 0,
      walmart_calls: 0,
      model_calls: 0,
    };
  } finally {
    machineSecret.fill(0);
    parsed.message.fill(0);
  }
}

export async function runWalmartItemReportReissueOwnerSignerCli(argv, injected = {}) {
  const { command, values } = parseArgs(argv);
  if (command === "help" || command === "--help") {
    exactOptions(values, []);
    return {
      commands: ["init", "inspect", "sign"],
      private_key_via_argv_or_env_allowed: false,
      private_key_unlock_provider: "MACOS_LOGIN_KEYCHAIN",
      user_managed_password_required: false,
      network_available: false,
    };
  }
  if (command === "init") {
    exactOptions(values, ["custody-dir", "key-id"]);
    return initKey({
      custody_dir: values.get("custody-dir"),
      key_id: values.get("key-id"),
    }, injected);
  }
  if (command === "inspect") {
    exactOptions(values, ["custody-dir", "request", "expect-request-sha256"]);
    return inspect({
      custody_dir: values.get("custody-dir"),
      request: values.get("request"),
      expected_request_sha256: values.get("expect-request-sha256"),
    });
  }
  if (command === "sign") {
    exactOptions(values, [
      "custody-dir", "request", "expect-request-sha256", "out", "confirm",
    ]);
    return signRequest({
      custody_dir: values.get("custody-dir"),
      request: values.get("request"),
      expected_request_sha256: values.get("expect-request-sha256"),
      out: values.get("out"),
      confirm: values.get("confirm"),
    }, injected);
  }
  fail("INVALID_CLI", "command must be init, inspect, sign, or help");
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  runWalmartItemReportReissueOwnerSignerCli(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${canonicalJson(result)}\n`),
    (error) => {
      const code = typeof error?.code === "string" ? error.code : "UNEXPECTED_ERROR";
      const message = error instanceof Error ? error.message : "owner signer failed";
      process.stderr.write(`${canonicalJson({ ok: false, error_code: code, message })}\n`);
      process.exitCode = 1;
    },
  );
}
