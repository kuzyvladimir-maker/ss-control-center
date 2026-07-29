#!/usr/bin/env node

/**
 * External-custody signer for one exact full-surface Walmart operation.
 *
 * The private key remains encrypted outside the repository and is unlocked
 * through the owner's macOS Login Keychain. This process has no Walmart,
 * database, provider, model, browser or other network client.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import authorityModule from
  "../src/lib/walmart/listing-integrity-full-surface-authority.ts";

const {
  WALMART_LISTING_FULL_SURFACE_PERMIT_ACTION,
  assembleWalmartListingFullSurfacePermit,
  walmartListingFullSurfacePermitSigningMessage,
} = authorityModule;

const REQUEST_SCHEMA =
  "walmart-listing-integrity-full-surface-signing-request/v1";
const ENROLLMENT_NAME = "walmart-owner-control-public-enrollment.json";
const PRIVATE_KEY_NAME = "walmart-owner-control-private-key.pem";
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_FILE_BYTES = 1024 * 1024;

function fail(code, message) {
  const error = new Error(`Walmart full-surface owner signer: ${message}`);
  error.code = code;
  throw error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("INVALID_JSON", "undefined is forbidden");
  return encoded;
}

function exactAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)
    || path.normalize(value) !== value) {
    fail("INVALID_ARGUMENT", `${label} must be an exact absolute path`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort())
      !== canonicalJson([...keys].sort())) {
    fail("INVALID_ARTIFACT", `${label} has missing or extra fields`);
  }
  return value;
}

async function readStable(filePath, label) {
  const exact = exactAbsolute(filePath, label);
  const beforePath = await lstat(exact).catch(() =>
    fail("ARTIFACT_NOT_FOUND", `${label} is missing`));
  if (!beforePath.isFile() || beforePath.isSymbolicLink()
    || beforePath.nlink !== 1 || (beforePath.mode & 0o022) !== 0
    || beforePath.size < 1 || beforePath.size > MAX_FILE_BYTES
    || await realpath(exact) !== exact) {
    fail("UNSAFE_ARTIFACT", `${label} is not a stable regular file`);
  }
  const handle = await open(
    exact,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || bytes.byteLength !== before.size) {
      fail("ARTIFACT_READ_RACE", `${label} changed during read`);
    }
    return Buffer.from(bytes);
  } finally {
    await handle.close();
  }
}

async function writeExclusive(filePath, bytes) {
  const handle = await open(
    exactAbsolute(filePath, "--out"),
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0),
    0o400,
  ).catch((error) => {
    if (error?.code === "EEXIST") fail("OUTPUT_EXISTS", "--out already exists");
    fail("OUTPUT_FAILED", "--out could not be created");
  });
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function runSecurity(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let length = 0;
    child.stdout.on("data", (chunk) => {
      length += chunk.byteLength;
      if (length > 4096) child.kill("SIGKILL");
      else chunks.push(Buffer.from(chunk));
    });
    child.once("error", () => reject(
      new Error("macOS Keychain command could not start"),
    ));
    child.once("close", (code) => {
      if (code !== 0 || length > 4096) {
        reject(new Error("macOS Keychain operation failed"));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("INVALID_ARTIFACT", `${label} is not UTF-8 JSON`);
  }
}

function parseArgs(argv) {
  if (argv[0] !== "sign") {
    fail("INVALID_ARGUMENT", "usage: sign --custody-dir=... --request=... "
      + "--expected-request-sha256=... --out=...");
  }
  const values = new Map();
  for (const argument of argv.slice(1)) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || values.has(match[1])) {
      fail("INVALID_ARGUMENT", `unsupported argument ${argument}`);
    }
    values.set(match[1], match[2]);
  }
  if (
    values.size !== 4
    || !values.has("custody-dir")
    || !values.has("request")
    || !values.has("expected-request-sha256")
    || !values.has("out")
  ) {
    fail("INVALID_ARGUMENT", "four exact sign arguments are required");
  }
  return {
    custody: exactAbsolute(values.get("custody-dir"), "--custody-dir"),
    request: exactAbsolute(values.get("request"), "--request"),
    expected: values.get("expected-request-sha256"),
    out: exactAbsolute(values.get("out"), "--out"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!SHA256.test(args.expected)) {
    fail("INVALID_ARGUMENT", "expected request SHA-256 is invalid");
  }
  const custodyInfo = await lstat(args.custody);
  if (!custodyInfo.isDirectory() || custodyInfo.isSymbolicLink()
    || (custodyInfo.mode & 0o077) !== 0
    || await realpath(args.custody) !== args.custody) {
    fail("UNSAFE_CUSTODY", "owner custody directory is not private");
  }
  if (path.dirname(args.out) !== args.custody) {
    fail("INVALID_OUTPUT", "--out must be a direct child of owner custody");
  }
  const enrollment = exactKeys(
    parseJson(
      await readStable(
        path.join(args.custody, ENROLLMENT_NAME),
        "owner enrollment",
      ),
      "owner enrollment",
    ),
    [
      "algorithm",
      "allowed_signing_domains",
      "created_at",
      "domain",
      "environment",
      "key_id",
      "keychain_account",
      "keychain_service",
      "private_key_created_outside_repository",
      "private_key_encrypted_at_rest",
      "private_key_export",
      "private_key_file",
      "private_key_unlock_provider",
      "public_key_spki_der_base64",
      "public_key_spki_sha256",
      "schema_version",
      "status",
      "user_managed_password_required",
    ],
    "owner enrollment",
  );
  if (
    enrollment.algorithm !== "Ed25519"
    || enrollment.domain !== "WALMART_OWNER_CONTROL"
    || enrollment.environment !== "PRODUCTION"
    || enrollment.status !== "ACTIVE"
    || enrollment.private_key_file !== PRIVATE_KEY_NAME
    || enrollment.private_key_encrypted_at_rest !== true
    || enrollment.private_key_created_outside_repository !== true
    || enrollment.private_key_unlock_provider !== "MACOS_LOGIN_KEYCHAIN"
    || !SHA256.test(enrollment.public_key_spki_sha256)
  ) {
    fail("INVALID_ENROLLMENT", "owner enrollment is not active production custody");
  }
  const requestBytes = await readStable(args.request, "signing request");
  if (sha256(requestBytes) !== args.expected) {
    fail("REQUEST_HASH_MISMATCH", "signing request SHA-256 differs");
  }
  const request = exactKeys(
    parseJson(requestBytes, "signing request"),
    [
      "schema_version",
      "action",
      "key_id",
      "owner_public_key_spki_sha256",
      "permit_envelope",
      "signing_message_base64",
    ],
    "signing request",
  );
  if (
    request.schema_version !== REQUEST_SCHEMA
    || request.action !== WALMART_LISTING_FULL_SURFACE_PERMIT_ACTION
    || request.key_id !== enrollment.key_id
    || request.owner_public_key_spki_sha256
      !== enrollment.public_key_spki_sha256
  ) {
    fail("INVALID_SIGNING_REQUEST", "request is outside the exact owner key/domain");
  }
  const expectedMessage = walmartListingFullSurfacePermitSigningMessage(
    request.permit_envelope,
  );
  if (
    request.signing_message_base64 !== expectedMessage.toString("base64")
  ) {
    fail("INVALID_SIGNING_REQUEST", "signing message does not bind the envelope");
  }
  const secretRaw = await runSecurity([
    "find-generic-password",
    "-a", enrollment.keychain_account,
    "-s", enrollment.keychain_service,
    "-w",
  ]);
  const secret = Buffer.from(
    secretRaw.at(-1) === 0x0a ? secretRaw.subarray(0, -1) : secretRaw,
  );
  let privateBytes;
  try {
    privateBytes = await readStable(
      path.join(args.custody, PRIVATE_KEY_NAME),
      "encrypted owner private key",
    );
    let privateKey;
    try {
      privateKey = createPrivateKey({
        key: privateBytes,
        format: "pem",
        passphrase: secret,
      });
    } catch {
      fail("PRIVATE_KEY_UNLOCK_FAILED", "owner private key could not be unlocked");
    }
    const publicDer = Buffer.from(
      createPublicKey(privateKey).export({ format: "der", type: "spki" }),
    );
    if (sha256(publicDer) !== enrollment.public_key_spki_sha256) {
      fail("PRIVATE_KEY_MISMATCH", "private key differs from enrollment");
    }
    const signature = sign(null, expectedMessage, privateKey);
    const permit = assembleWalmartListingFullSurfacePermit({
      envelope: request.permit_envelope,
      signature,
    });
    await writeExclusive(
      args.out,
      Buffer.from(`${canonicalJson(permit)}\n`, "utf8"),
    );
    process.stdout.write(`${JSON.stringify({
      status: "EXTERNAL_OWNER_PERMIT_SIGNED",
      permit_path: args.out,
      authorization_sha256: permit.authorization_sha256,
      request_sha256: sha256(requestBytes),
      signing_message_sha256: sha256(expectedMessage),
      key_id: enrollment.key_id,
      network_calls: 0,
      walmart_calls: 0,
      database_calls: 0,
      model_calls: 0,
    })}\n`);
  } finally {
    secret.fill(0);
    privateBytes?.fill(0);
    expectedMessage.fill(0);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
