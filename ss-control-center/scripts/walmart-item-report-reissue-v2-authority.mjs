#!/usr/bin/env -S node --experimental-strip-types

/**
 * Offline authoring surface for the one-shot Walmart ITEM v6 reissue.
 *
 * This file has no credential, Walmart, database, provider, or model client. It
 * creates a replacement SessionAuthority, emits the exact Ed25519 signing
 * request, and assembles a verified disposition from a detached owner
 * signature. The live POST belongs to the separately frozen executor.
 */

import {
  createHash,
  randomUUID,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assembleWalmartItemReportReissueOwnerDispositionV2,
  buildWalmartItemReportReissueOwnerDispositionV2Body,
  buildWalmartItemReportReissueOwnerDispositionV2SigningRequest,
  buildWalmartItemReportReissueReplacementPlanV2,
} from "../src/lib/walmart/item-report-reissue-owner-disposition-v2.ts";
import {
  canonicalWalmartItemReportJson,
  walmartItemReportUtf8Sha256,
} from "../src/lib/walmart/item-report-published-source.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REPOSITORY_ROOT = path.resolve(PROJECT_ROOT, "..");
const CAPTURE_ROOT = path.join(PROJECT_ROOT, "data/audits/walmart-source-captures");
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 512 * 1024;

export const WALMART_ITEM_REPORT_REISSUE_V2_AUTHORITY_SCHEMA =
  "walmart-item-report-reissue-v2-authority-cli/1.0.0";

export class WalmartItemReportReissueV2AuthorityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalmartItemReportReissueV2AuthorityError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WalmartItemReportReissueV2AuthorityError(code, message);
}

function exactString(value, label, maximum = 2048) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_INPUT", `${label} is invalid`);
  }
  return value;
}

function exactSha256(value, label) {
  const parsed = exactString(value, label, 64);
  if (!SHA256.test(parsed)) fail("INVALID_INPUT", `${label} must be a lowercase SHA-256`);
  return parsed;
}

function exactInstant(value, label) {
  const parsed = exactString(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed)
    || !Number.isFinite(Date.parse(parsed))
    || new Date(Date.parse(parsed)).toISOString() !== parsed) {
    fail("INVALID_INPUT", `${label} must be canonical UTC milliseconds`);
  }
  return parsed;
}

function exactAbsolutePath(value, label) {
  const parsed = exactString(value, label, 4096);
  if (!path.isAbsolute(parsed) || path.normalize(parsed) !== parsed) {
    fail("INVALID_INPUT", `${label} must be an exact normalized absolute path`);
  }
  return parsed;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalBytes(value) {
  return Buffer.from(canonicalWalmartItemReportJson(value), "utf8");
}

function parseCanonicalJson(bytes, label) {
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail("INVALID_ARTIFACT", `${label} must be valid UTF-8 JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || text !== canonicalWalmartItemReportJson(value)) {
    fail("INVALID_ARTIFACT", `${label} must be one canonical compact JSON object`);
  }
  return value;
}

function sameFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino
    && before.mode === after.mode && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function readStableFile(filePath, label, maximumBytes = MAX_JSON_BYTES) {
  const exactPath = exactAbsolutePath(filePath, label);
  const beforePath = await lstat(exactPath).catch(() => fail(
    "ARTIFACT_NOT_FOUND",
    `${label} does not exist`,
  ));
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1) {
    fail("UNSAFE_ARTIFACT", `${label} must be a single-link regular file`);
  }
  if ((beforePath.mode & 0o022) !== 0 || (beforePath.mode & 0o400) === 0) {
    fail("UNSAFE_ARTIFACT", `${label} must not be group/other-writable and must be owner-readable`);
  }
  if (await realpath(exactPath) !== exactPath) {
    fail("UNSAFE_ARTIFACT", `${label} must not contain a symlink alias`);
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(exactPath, flags).catch(() => fail(
    "UNSAFE_ARTIFACT",
    `${label} could not be opened without following links`,
  ));
  let bytes;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximumBytes) {
      fail("UNSAFE_ARTIFACT", `${label} size or link count is invalid`);
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== before.size || !sameFile(before, after)) {
      fail("ARTIFACT_READ_RACE", `${label} changed while being read`);
    }
  } finally {
    await handle.close();
  }
  const afterPath = await lstat(exactPath).catch(() => fail(
    "ARTIFACT_READ_RACE",
    `${label} disappeared after read`,
  ));
  if (!sameFile(beforePath, afterPath) || await realpath(exactPath) !== exactPath) {
    fail("ARTIFACT_READ_RACE", `${label} path identity changed while being read`);
  }
  return Buffer.from(bytes);
}

async function readCanonicalJson(filePath, label) {
  return parseCanonicalJson(await readStableFile(filePath, label), label);
}

async function assertPrivateArtifactParent(filePath, label) {
  const exactPath = exactAbsolutePath(filePath, label);
  const parent = path.dirname(exactPath);
  const info = await lstat(parent).catch(() => fail(
    "UNSAFE_ARTIFACT",
    `${label} parent does not exist`,
  ));
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (info.mode & 0o500) !== 0o500 || await realpath(parent) !== parent) {
    fail("UNSAFE_ARTIFACT", `${label} parent must be a private real directory (0700)`);
  }
}

async function assertPrivateOutputParent(outputPath) {
  const parent = path.dirname(exactAbsolutePath(outputPath, "--out"));
  const info = await lstat(parent).catch(() => fail(
    "UNSAFE_OUTPUT_PARENT",
    "--out parent must already exist",
  ));
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (info.mode & 0o500) !== 0o500) {
    fail("UNSAFE_OUTPUT_PARENT", "--out parent must be a private real directory (0700)");
  }
  if (await realpath(parent) !== parent) {
    fail("UNSAFE_OUTPUT_PARENT", "--out parent must not contain a symlink alias");
  }
  return parent;
}

async function writeImmutableCanonical(outputPath, value) {
  const exactPath = exactAbsolutePath(outputPath, "--out");
  const parent = await assertPrivateOutputParent(exactPath);
  const bytes = canonicalBytes(value);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
    | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(exactPath, flags, 0o400).catch((error) => {
    if (error?.code === "EEXIST") fail("OUTPUT_EXISTS", "--out already exists");
    fail("OUTPUT_WRITE_FAILED", "--out could not be created exclusively");
  });
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o400);
  } finally {
    await handle.close();
  }
  const parentHandle = await open(parent, fsConstants.O_RDONLY);
  try {
    await parentHandle.sync();
  } finally {
    await parentHandle.close();
  }
  return {
    path: exactPath,
    sha256: sha256Bytes(bytes),
    byte_length: bytes.byteLength,
  };
}

function correlation(id) {
  return { id, sha256: walmartItemReportUtf8Sha256(id) };
}

export function createWalmartItemReportReissueReplacementPlanV2(input, injected = {}) {
  const sessionName = exactString(input.session_name, "session_name", 180);
  if (sessionName.includes("/") || sessionName.includes("\\")
    || sessionName === "." || sessionName === "..") {
    fail("INVALID_INPUT", "session_name must be one safe direct-child name");
  }
  const createdAt = exactInstant(input.created_at, "created_at");
  const accountFingerprint = exactSha256(input.account_fingerprint_sha256, "account fingerprint");
  const uuid = injected.random_uuid ?? randomUUID;
  const ids = Array.from({ length: 5 }, () => exactString(uuid(), "generated UUID", 128));
  if (new Set(ids).size !== ids.length) fail("RANDOMNESS_FAILURE", "generated UUIDs collided");
  return buildWalmartItemReportReissueReplacementPlanV2({
    session_name: sessionName,
    session_authority: {
      schema_version: "walmart-item-report-capture-session/v1",
      session_id: `${sessionName}-${ids[0]}`,
      created_at: createdAt,
      account_scope: {
        channel: "WALMART_US",
        store_index: 1,
        seller_account_fingerprint_sha256: accountFingerprint,
      },
      primary_correlations: {
        create: correlation(ids[1]),
        ready_status: correlation(ids[2]),
        download_locator: correlation(ids[3]),
        report_file: correlation(ids[4]),
      },
      trust_statement: {
        adapter_atomic_integrity: true,
        walmart_signature_claimed: false,
        tls_server_authenticity_claimed_by_artifact: false,
      },
    },
  });
}

export async function authorWalmartItemReportReissueReplacementPlanV2(input, injected = {}) {
  const replacement = createWalmartItemReportReissueReplacementPlanV2(input, injected);
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_V2_AUTHORITY_SCHEMA,
    command: "replacement-plan",
    artifact: await writeImmutableCanonical(input.out, replacement),
    replacement,
    network_calls: 0,
    database_calls: 0,
    model_calls: 0,
    walmart_content_writes: 0,
  };
}

export async function authorWalmartItemReportReissueDispositionRequestV2(input) {
  const [sourceBytes, replacement, ledger] = await Promise.all([
    readStableFile(input.source_evidence, "source evidence"),
    readCanonicalJson(input.replacement, "replacement plan"),
    readCanonicalJson(input.ledger_binding, "ledger binding"),
  ]);
  const expectedSourceSha = exactSha256(
    input.expected_source_evidence_sha256,
    "expected source evidence SHA-256",
  );
  if (sha256Bytes(sourceBytes) !== expectedSourceSha) {
    fail("SOURCE_EVIDENCE_SHA256_MISMATCH", "source evidence differs from expected SHA-256");
  }
  const signedBody = buildWalmartItemReportReissueOwnerDispositionV2Body({
    disposition_id: exactString(input.disposition_id, "disposition_id", 200),
    // CLI never exposes this field. Tests may inject TEST_FIXTURE_ONLY so the
    // production trust root remains fail-closed until its reviewed key is pinned.
    environment: input.environment ?? "PRODUCTION",
    approved_by: exactString(input.approved_by, "approved_by", 256),
    decision_ref: exactString(input.decision_ref, "decision_ref", 2048),
    engine_release_sha256: exactSha256(input.engine_release_sha256, "engine release SHA-256"),
    source_evidence_bytes: sourceBytes,
    expected_source_evidence_artifact_sha256: expectedSourceSha,
    replacement,
    consumption_ledger: ledger,
    issued_at: exactInstant(input.issued_at, "issued_at"),
    expires_at: exactInstant(input.expires_at, "expires_at"),
  });
  const request = buildWalmartItemReportReissueOwnerDispositionV2SigningRequest({
    key_id: exactString(input.key_id, "key_id", 200),
    signed_body: signedBody,
    env: input.env ?? process.env,
  });
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_V2_AUTHORITY_SCHEMA,
    command: "disposition-request",
    artifact: await writeImmutableCanonical(input.out, request),
    signing_message_sha256: sha256Bytes(Buffer.from(request.signing_message_base64, "base64")),
    network_calls: 0,
    database_calls: 0,
    model_calls: 0,
    walmart_content_writes: 0,
  };
}

export async function authorWalmartItemReportReissueDispositionV2(input) {
  const dispositionOut = exactAbsolutePath(input.out, "--out");
  if (isWithin(dispositionOut, REPOSITORY_ROOT) || isWithin(dispositionOut, CAPTURE_ROOT)) {
    fail(
      "OWNER_CUSTODY_REQUIRED",
      "assembled owner disposition must be written outside the repository and capture root",
    );
  }
  await assertPrivateArtifactParent(input.detached_signature, "detached signature");
  const [sourceBytes, replacement, ledger, signingRequest, signature] = await Promise.all([
    readStableFile(input.source_evidence, "source evidence"),
    readCanonicalJson(input.replacement, "replacement plan"),
    readCanonicalJson(input.ledger_binding, "ledger binding"),
    readCanonicalJson(input.signing_request, "signing request"),
    readStableFile(input.detached_signature, "detached signature", 64),
  ]);
  if (signature.byteLength !== 64) {
    fail("INVALID_SIGNATURE", "detached signature must be exactly 64 raw bytes");
  }
  const expectedSourceSha = exactSha256(
    input.expected_source_evidence_sha256,
    "expected source evidence SHA-256",
  );
  if (sha256Bytes(sourceBytes) !== expectedSourceSha) {
    fail("SOURCE_EVIDENCE_SHA256_MISMATCH", "source evidence differs from expected SHA-256");
  }
  const disposition = assembleWalmartItemReportReissueOwnerDispositionV2({
    signing_request: signingRequest,
    detached_signature: signature,
    expected_engine_release_sha256: exactSha256(
      input.engine_release_sha256,
      "engine release SHA-256",
    ),
    expected_source_evidence_bytes: sourceBytes,
    expected_source_evidence_artifact_sha256: expectedSourceSha,
    expected_replacement: replacement,
    expected_consumption_ledger: ledger,
    env: input.env ?? process.env,
    now: input.now ?? new Date(),
  });
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_V2_AUTHORITY_SCHEMA,
    command: "disposition-assemble",
    artifact: await writeImmutableCanonical(dispositionOut, disposition),
    authorization_sha256: disposition.authorization_sha256,
    network_calls: 0,
    database_calls: 0,
    model_calls: 0,
    walmart_content_writes: 0,
  };
}

function parseArgs(argv) {
  const command = argv[0] ?? "help";
  const values = {};
  for (const argument of argv.slice(1)) {
    if (!argument.startsWith("--") || !argument.includes("=")) {
      fail("INVALID_CLI", "all arguments must use --name=value");
    }
    const offset = argument.indexOf("=");
    const key = argument.slice(2, offset).replaceAll("-", "_");
    const value = argument.slice(offset + 1);
    if (!key || !value || Object.hasOwn(values, key)) {
      fail("INVALID_CLI", "CLI argument is empty or repeated");
    }
    values[key] = value;
  }
  return { command, values };
}

function required(values, names) {
  const actual = Object.keys(values).sort();
  const expected = [...names].sort();
  if (actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])) {
    fail("INVALID_CLI", `exact arguments required: ${expected.map((name) => `--${name.replaceAll("_", "-")}`).join(", ")}`);
  }
}

function help() {
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_V2_AUTHORITY_SCHEMA,
    commands: ["replacement-plan", "disposition-request", "disposition-assemble"],
    live_network_available: false,
    note: "Detached Ed25519 signing occurs outside this repository and outside Claude runtime.",
  };
}

export async function runWalmartItemReportReissueV2AuthorityCli(argv) {
  const { command, values } = parseArgs(argv);
  if (command === "help" || command === "--help") return help();
  if (command === "replacement-plan") {
    required(values, ["session_name", "created_at", "account_fingerprint_sha256", "out"]);
    return authorWalmartItemReportReissueReplacementPlanV2(values);
  }
  if (command === "disposition-request") {
    required(values, [
      "source_evidence", "expected_source_evidence_sha256", "replacement",
      "ledger_binding", "engine_release_sha256", "key_id", "disposition_id",
      "approved_by", "decision_ref", "issued_at", "expires_at", "out",
    ]);
    return authorWalmartItemReportReissueDispositionRequestV2(values);
  }
  if (command === "disposition-assemble") {
    required(values, [
      "source_evidence", "expected_source_evidence_sha256", "replacement",
      "ledger_binding", "engine_release_sha256", "signing_request",
      "detached_signature", "out",
    ]);
    return authorWalmartItemReportReissueDispositionV2(values);
  }
  fail("INVALID_CLI", "command must be replacement-plan, disposition-request, disposition-assemble, or help");
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  runWalmartItemReportReissueV2AuthorityCli(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${canonicalWalmartItemReportJson(result)}\n`),
    (error) => {
      process.stderr.write(`${error?.code ?? "WALMART_ITEM_REPORT_REISSUE_V2_AUTHORITY_ERROR"}: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

export const WALMART_ITEM_REPORT_REISSUE_V2_AUTHORITY_PROJECT_ROOT = PROJECT_ROOT;
