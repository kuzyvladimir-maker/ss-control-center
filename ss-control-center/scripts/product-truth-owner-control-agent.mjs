#!/usr/bin/env node

/**
 * Local-only Product Truth owner authority.
 *
 * The production web app may ask this loopback service to sign one exact,
 * already displayed enrichment quote. The Ed25519 private key is encrypted
 * outside the repository and unlocked by macOS Login Keychain. The server,
 * worker, provider adapters and browser never receive private-key bytes.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRODUCT_TRUTH_CONTROL_ALGORITHM,
  PRODUCT_TRUTH_CONTROL_KEY_FAMILY,
  parseProductTruthControlEnvelope,
  productTruthControlRequestSha256,
  productTruthControlSigningMessage,
} from "../src/lib/sourcing/product-truth-control-plane.ts";
import {
  parseProductTruthWalmartEnrichmentQuote,
  productTruthWalmartEnrichmentQuoteSha256,
  renderProductTruthWalmartEnrichmentQuote,
} from "../src/lib/sourcing/product-truth-walmart-enrichment-quote.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REPOSITORY_ROOT = path.resolve(PROJECT_ROOT, "..");
const PRIVATE_KEY_NAME = "product-truth-owner-control-private-key.pem";
const ENROLLMENT_NAME = "product-truth-owner-control-public-enrollment.json";
const KEY_SCHEMA = "product-truth-owner-control-key-enrollment/1.0.0";
const KEYCHAIN_SERVICE = "com.ss-command-center.product-truth-owner-control.v1";
const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_PORT = 47321;
const MAX_REQUEST_BYTES = 1024 * 1024;

class OwnerAgentError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "OwnerAgentError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new OwnerAgentError(code, message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function exactEnv(name) {
  const value = process.env[name];
  if (!value || value !== value.trim()) fail("CONFIG_INVALID", `${name} is required`);
  return value;
}

function safeToken(value, label) {
  if (
    typeof value !== "string"
    || value.length < 8
    || value.length > 200
    || value !== value.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value)
  ) {
    fail("INPUT_INVALID", `${label} must be a safe token`);
  }
  return value;
}

async function exactExternalDirectory(value, mustExist) {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    fail("CUSTODY_INVALID", "custody directory must be an exact absolute path");
  }
  const relative = path.relative(REPOSITORY_ROOT, value);
  if (
    relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  ) {
    fail("CUSTODY_INVALID", "owner key custody must stay outside the repository");
  }
  if (mustExist) {
    const info = await lstat(value).catch(() =>
      fail("CUSTODY_INVALID", "custody directory is missing"));
    if (
      !info.isDirectory()
      || info.isSymbolicLink()
      || (info.mode & 0o077) !== 0
      || await realpath(value) !== value
    ) {
      fail("CUSTODY_INVALID", "custody directory is not a private real directory");
    }
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
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", () =>
      reject(new OwnerAgentError("KEYCHAIN_UNAVAILABLE", "security could not start")));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new OwnerAgentError(
          "KEYCHAIN_OPERATION_FAILED",
          Buffer.concat(stderr).toString("utf8").trim() || "Keychain operation failed",
        ));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

async function initKey(custodyDir, keyId) {
  await exactExternalDirectory(path.dirname(custodyDir), true);
  await exactExternalDirectory(custodyDir, false);
  const exists = await lstat(custodyDir).then(() => true).catch(() => false);
  if (exists) fail("CUSTODY_EXISTS", "custody directory already exists");
  safeToken(keyId, "key id");
  const secret = randomBytes(32).toString("base64url");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  const encryptedPrivate = Buffer.from(privateKey.export({
    format: "pem",
    type: "pkcs8",
    cipher: "aes-256-cbc",
    passphrase: secret,
  }));
  await runSecurity([
    "add-generic-password",
    "-a", keyId,
    "-s", KEYCHAIN_SERVICE,
    "-D", "SS Command Center Product Truth owner control key",
    "-l", `SS Command Center Product Truth owner control (${keyId})`,
    "-T", "/usr/bin/security",
    "-w", secret,
  ]);
  await mkdir(custodyDir, { mode: 0o700 });
  await chmod(custodyDir, 0o700);
  const enrollment = {
    schemaVersion: KEY_SCHEMA,
    keyFamily: PRODUCT_TRUTH_CONTROL_KEY_FAMILY,
    algorithm: PRODUCT_TRUTH_CONTROL_ALGORITHM,
    keyId,
    environment: "PRODUCTION",
    status: "ACTIVE",
    publicKeySpkiDerBase64: publicDer.toString("base64"),
    publicKeySpkiSha256: sha256(publicDer),
    privateKeyEncryptedAtRest: true,
    privateKeyCreatedOutsideRepository: true,
    privateKeyUnlockProvider: "MACOS_LOGIN_KEYCHAIN",
    userManagedPasswordRequired: false,
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(custodyDir, PRIVATE_KEY_NAME),
    encryptedPrivate,
    { flag: "wx", mode: 0o400 },
  );
  await writeFile(
    path.join(custodyDir, ENROLLMENT_NAME),
    `${canonicalJson(enrollment)}\n`,
    { flag: "wx", mode: 0o400 },
  );
  encryptedPrivate.fill(0);
  return {
    status: "OWNER_KEY_CREATED",
    custody_dir: custodyDir,
    public_enrollment_path: path.join(custodyDir, ENROLLMENT_NAME),
    key_id: keyId,
    public_key_spki_sha256: enrollment.publicKeySpkiSha256,
    user_managed_password_required: false,
  };
}

async function loadCustody(custodyDir) {
  await exactExternalDirectory(custodyDir, true);
  const enrollmentBytes = await readFile(path.join(custodyDir, ENROLLMENT_NAME));
  let enrollment;
  try {
    const text = enrollmentBytes.toString("utf8");
    enrollment = JSON.parse(text);
    if (text !== `${canonicalJson(enrollment)}\n`) throw new Error();
  } catch {
    fail("ENROLLMENT_INVALID", "public enrollment is not canonical JSON");
  }
  if (
    !isRecord(enrollment)
    || enrollment.schemaVersion !== KEY_SCHEMA
    || enrollment.keyFamily !== PRODUCT_TRUTH_CONTROL_KEY_FAMILY
    || enrollment.algorithm !== PRODUCT_TRUTH_CONTROL_ALGORITHM
    || enrollment.environment !== "PRODUCTION"
    || enrollment.status !== "ACTIVE"
    || enrollment.privateKeyEncryptedAtRest !== true
    || enrollment.privateKeyCreatedOutsideRepository !== true
    || enrollment.privateKeyUnlockProvider !== "MACOS_LOGIN_KEYCHAIN"
    || enrollment.userManagedPasswordRequired !== false
  ) {
    fail("ENROLLMENT_INVALID", "public enrollment is outside Product Truth authority");
  }
  safeToken(enrollment.keyId, "enrollment key id");
  const publicDer = Buffer.from(enrollment.publicKeySpkiDerBase64, "base64");
  if (
    publicDer.length < 1
    || publicDer.toString("base64") !== enrollment.publicKeySpkiDerBase64
    || sha256(publicDer) !== enrollment.publicKeySpkiSha256
  ) {
    fail("ENROLLMENT_INVALID", "public-key seal is invalid");
  }
  const publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("ENROLLMENT_INVALID", "owner key is not Ed25519");
  }
  return { custodyDir, enrollment };
}

async function signExactRequest(custody, value, pins) {
  if (!isRecord(value)) fail("REQUEST_INVALID", "request must be an object");
  const quote = parseProductTruthWalmartEnrichmentQuote(value.quote);
  const envelope = parseProductTruthControlEnvelope(value.envelope);
  const quoteSha = productTruthWalmartEnrichmentQuoteSha256(quote);
  const commandSha = productTruthControlRequestSha256(envelope);
  if (
    value.quote_sha256 !== quoteSha
    || value.command_sha256 !== commandSha
    || envelope.commandKind !== "EXECUTE"
    || envelope.gateClass !== "METERED_EXECUTE"
    || envelope.target.environment !== "PRODUCTION"
    || envelope.authority.ownerKeyId !== custody.enrollment.keyId
    || envelope.engine.releaseId !== pins.releaseId
    || envelope.engine.commitSha !== pins.commitSha
    || envelope.engine.treeSha !== pins.treeSha
    || envelope.engine.executableTreeSha256 !== pins.executableTreeSha256
    || envelope.target.databaseTargetFingerprint !== pins.databaseTargetFingerprint
    || envelope.target.manifestSha256 !== pins.manifestSha256
  ) {
    fail("REQUEST_SCOPE_MISMATCH", "request differs from the pinned production lane");
  }
  const quoteBytes = Buffer.from(
    renderProductTruthWalmartEnrichmentQuote(quote),
    "utf8",
  );
  if (!envelope.artifacts.some((artifact) =>
    artifact.role === "REQUEST"
    && artifact.sha256 === sha256(quoteBytes)
    && artifact.byteSize === quoteBytes.byteLength)) {
    fail("REQUEST_SCOPE_MISMATCH", "signed command does not bind the displayed quote");
  }
  const planReferences = envelope.artifacts.filter(
    (artifact) => artifact.role === "RUN_PLAN",
  );
  if (
    planReferences.length !== quote.actions.jobs.length
    || quote.totals.maximumProviderUnits !== 2.5 + quote.actions.jobs.length * 3.5
    || quote.actions.jobs.some((job) =>
      !planReferences.some((artifact) => artifact.sha256 === job.planSha256))
  ) {
    fail("REQUEST_SCOPE_MISMATCH", "signed command does not bind every exact plan");
  }
  const now = Date.now();
  if (
    Date.parse(envelope.authority.issuedAt ?? "") > now + 5 * 60_000
    || Date.parse(envelope.authority.expiresAt ?? "") <= now
  ) {
    fail("REQUEST_EXPIRED", "owner request is not current");
  }
  const secretOutput = await runSecurity([
    "find-generic-password",
    "-a", custody.enrollment.keyId,
    "-s", KEYCHAIN_SERVICE,
    "-w",
  ]);
  const secret = secretOutput.toString("utf8").trim();
  const privateBytes = await readFile(
    path.join(custody.custodyDir, PRIVATE_KEY_NAME),
  );
  let privateKey;
  try {
    privateKey = createPrivateKey({
      key: privateBytes,
      format: "pem",
      passphrase: secret,
    });
  } finally {
    privateBytes.fill(0);
  }
  const derivedPublic = Buffer.from(
    createPublicKey(privateKey).export({ format: "der", type: "spki" }),
  );
  if (sha256(derivedPublic) !== custody.enrollment.publicKeySpkiSha256) {
    fail("PRIVATE_KEY_MISMATCH", "private key differs from enrollment");
  }
  const message = productTruthControlSigningMessage(envelope);
  const signature = sign(null, message, privateKey);
  message.fill(0);
  if (signature.byteLength !== 64) fail("SIGNATURE_FAILED", "Ed25519 signature failed");
  return {
    schema_version: "product-truth-owner-agent-signature/1.0.0",
    command_id: envelope.commandId,
    command_sha256: commandSha,
    quote_sha256: quoteSha,
    key_id: custody.enrollment.keyId,
    public_key_spki_sha256: custody.enrollment.publicKeySpkiSha256,
    signature_base64: signature.toString("base64"),
    signature_sha256: sha256(signature),
    signed_at: new Date().toISOString(),
    private_key_disclosed: false,
    provider_calls: 0,
    marketplace_mutations: 0,
  };
}

function responseJson(response, status, body, origin) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    vary: "Origin",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function serve() {
  const custody = await loadCustody(exactEnv("PRODUCT_TRUTH_OWNER_CUSTODY_DIR"));
  const allowedOrigin = exactEnv("PRODUCT_TRUTH_OWNER_ALLOWED_ORIGIN");
  const parsedOrigin = new URL(allowedOrigin);
  if (parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== allowedOrigin) {
    fail("CONFIG_INVALID", "allowed origin must be one exact HTTPS origin");
  }
  const pins = {
    releaseId: exactEnv("PRODUCT_TRUTH_WORKER_RELEASE_ID"),
    commitSha: exactEnv("PRODUCT_TRUTH_WORKER_COMMIT_SHA"),
    treeSha: exactEnv("PRODUCT_TRUTH_WORKER_TREE_SHA"),
    executableTreeSha256:
      exactEnv("PRODUCT_TRUTH_WORKER_EXECUTABLE_TREE_SHA256"),
    databaseTargetFingerprint:
      exactEnv("PRODUCT_TRUTH_WEB_CONTROL_DATABASE_TARGET_FINGERPRINT"),
    manifestSha256: exactEnv("PRODUCT_TRUTH_WORKER_MANIFEST_SHA256"),
  };
  const server = createServer((request, response) => {
    const origin = request.headers.origin;
    if (origin !== allowedOrigin) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end('{"ok":false,"code":"ORIGIN_FORBIDDEN"}\n');
      return;
    }
    if (request.method === "OPTIONS") {
      responseJson(response, 204, {}, allowedOrigin);
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/sign") {
      responseJson(response, 404, { ok: false, code: "NOT_FOUND" }, allowedOrigin);
      return;
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > MAX_REQUEST_BYTES) request.destroy();
      else chunks.push(Buffer.from(chunk));
    });
    request.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = await signExactRequest(custody, body, pins);
        responseJson(response, 200, { ok: true, ...result }, allowedOrigin);
      } catch (error) {
        responseJson(response, 400, {
          ok: false,
          code: error?.code ?? "OWNER_AGENT_FAILED",
          message: error instanceof Error ? error.message : "owner agent failed",
        }, allowedOrigin);
      }
    });
  });
  server.listen(LOOPBACK_PORT, LOOPBACK_HOST, () => {
    process.stdout.write(`${JSON.stringify({
      status: "OWNER_AGENT_LISTENING",
      host: LOOPBACK_HOST,
      port: LOOPBACK_PORT,
      allowed_origin: allowedOrigin,
      key_id: custody.enrollment.keyId,
      public_key_spki_sha256: custody.enrollment.publicKeySpkiSha256,
    })}\n`);
  });
}

async function main() {
  const command = process.argv[2];
  if (command === "init") {
    const options = Object.fromEntries(process.argv.slice(3).map((entry) => {
      const match = /^--([^=]+)=(.+)$/u.exec(entry);
      if (!match) fail("CLI_INVALID", "init options must use --name=value");
      return [match[1], match[2]];
    }));
    if (
      Object.keys(options).sort().join(",") !== "custody-dir,key-id"
    ) {
      fail("CLI_INVALID", "init requires --custody-dir and --key-id");
    }
    const result = await initKey(options["custody-dir"], options["key-id"]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "serve" && process.argv.length === 3) {
    await serve();
    return;
  }
  fail("CLI_INVALID", "usage: init --custody-dir=... --key-id=... | serve");
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error?.code ?? "OWNER_AGENT_FAILED",
    message: error instanceof Error ? error.message : "owner agent failed",
  })}\n`);
  process.exitCode = 1;
});
