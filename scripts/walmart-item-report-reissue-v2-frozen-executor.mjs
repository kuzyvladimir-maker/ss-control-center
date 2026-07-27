#!/usr/bin/env node

/**
 * Frozen operator entrypoint for exactly one owner-authorized Walmart ITEM v6
 * report-create. It is intentionally unusable from the mutable source tree:
 * the executor verifies that process.argv[1] is the exact manifest-bound bundle.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_EXACT_ARGV_ORDER,
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE,
  executeWalmartItemReportReissueExecutorV2,
} from "../src/lib/walmart/item-report-reissue-executor-v2.ts";
import {
  computeWalmartSellerAccountFingerprint,
} from "../src/lib/walmart/item-report-capture-session.ts";
import {
  createWalmartItemReportCliTransport,
} from "./capture-walmart-item-report-source.mjs";
import {
  canonicalWalmartItemReportJson,
} from "../src/lib/walmart/item-report-published-source.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const MANIFEST_FILE_NAME = "engine-release.json";
const PRIVATE_FILE_MODE = 0o400;
const PRIVATE_DIRECTORY_MODES = new Set([0o500, 0o700]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("INVALID_CLI_INPUT", `${label} must be one lowercase SHA-256`);
  }
  return value;
}

function normalizeDarwinAlias(value) {
  if (process.platform !== "darwin") return value;
  for (const [alias, canonical] of [["/tmp", "/private/tmp"], ["/var", "/private/var"]]) {
    if (value === alias || value.startsWith(`${alias}/`)) {
      return `${canonical}${value.slice(alias.length)}`;
    }
  }
  return value;
}

function exactAbsolute(value, label) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0")) {
    fail("INVALID_CLI_INPUT", `${label} must be an exact normalized absolute path`);
  }
  return normalizeDarwinAlias(value);
}

function positiveStoreIndex(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)
    || !Number.isSafeInteger(Number(value))) {
    fail("INVALID_CLI_INPUT", "--store-index must be a positive safe integer");
  }
  return Number(value);
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function inspectPrivateParent(filePath, label) {
  const parent = path.dirname(filePath);
  const before = await lstat(parent, { bigint: true }).catch(() => {
    fail("INVALID_ARTIFACT_CUSTODY", `${label} parent is missing`);
  });
  if (!before.isDirectory() || before.isSymbolicLink()
    || !PRIVATE_DIRECTORY_MODES.has(Number(before.mode & 0o777n))
    || await realpath(parent).catch(() => null) !== parent
    || (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))) {
    fail("INVALID_ARTIFACT_CUSTODY", `${label} parent must be current-user private and real`);
  }
  const handle = await open(
    parent,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(parent, { bigint: true });
    if (!sameStat(before, opened) || !sameStat(opened, after)) {
      fail("INVALID_ARTIFACT_CUSTODY", `${label} parent identity raced`);
    }
    return { parent, stat: opened };
  } finally {
    await handle.close();
  }
}

async function readImmutableArtifact(filePath, label) {
  const absolute = exactAbsolute(filePath, label);
  const parent = await inspectPrivateParent(absolute, label);
  const before = await lstat(absolute, { bigint: true }).catch(() => {
    fail("INVALID_ARTIFACT_CUSTODY", `${label} is missing`);
  });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || Number(before.mode & 0o777n) !== PRIVATE_FILE_MODE
    || await realpath(absolute).catch(() => null) !== absolute
    || (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))) {
    fail("INVALID_ARTIFACT_CUSTODY", `${label} must be current-user 0400 single-link real file`);
  }
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStat(before, opened)) fail("INVALID_ARTIFACT_CUSTODY", `${label} raced before read`);
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(absolute, { bigint: true });
    const parentAfter = await lstat(parent.parent, { bigint: true });
    if (!sameStat(opened, afterHandle) || !sameStat(afterHandle, afterPath)
      || !sameStat(parent.stat, parentAfter) || BigInt(bytes.byteLength) !== afterHandle.size) {
      fail("INVALID_ARTIFACT_CUSTODY", `${label} raced during descriptor read`);
    }
    return { path: absolute, bytes };
  } finally {
    await handle.close();
  }
}

export function parseWalmartItemReportReissueV2FrozenExecutorCli(argv) {
  if (!Array.isArray(argv) || argv.length !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_EXACT_ARGV_ORDER.length) {
    fail("INVALID_CLI_INPUT", "executor requires the exact frozen execute-create argv");
  }
  const actualOrder = [argv[0]];
  const values = new Map();
  for (const argument of argv.slice(1)) {
    if (typeof argument !== "string" || !argument.startsWith("--") || !argument.includes("=")) {
      fail("INVALID_CLI_INPUT", "all executor options must use --name=value");
    }
    const separator = argument.indexOf("=");
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (!value || values.has(name)) fail("INVALID_CLI_INPUT", "executor option is empty or repeated");
    actualOrder.push(name);
    values.set(name, value);
  }
  if (canonicalWalmartItemReportJson(actualOrder)
      !== canonicalWalmartItemReportJson(WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_EXACT_ARGV_ORDER)) {
    fail("INVALID_CLI_INPUT", "executor argv names/order differ from the frozen contract");
  }
  return Object.freeze({
    engine_manifest: exactAbsolute(values.get("--engine-manifest"), "--engine-manifest"),
    expected_engine_manifest_sha256: exactSha(
      values.get("--expect-engine-manifest-sha256"),
      "--expect-engine-manifest-sha256",
    ),
    expected_frozen_bundle_sha256: exactSha(
      values.get("--expect-frozen-bundle-sha256"),
      "--expect-frozen-bundle-sha256",
    ),
    source_evidence: exactAbsolute(values.get("--source-evidence"), "--source-evidence"),
    expected_source_evidence_sha256: exactSha(
      values.get("--expect-source-evidence-sha256"),
      "--expect-source-evidence-sha256",
    ),
    owner_disposition: exactAbsolute(values.get("--owner-disposition"), "--owner-disposition"),
    expected_owner_disposition_sha256: exactSha(
      values.get("--expect-owner-disposition-sha256"),
      "--expect-owner-disposition-sha256",
    ),
    ledger_state_directory: exactAbsolute(
      values.get("--ledger-state-directory"),
      "--ledger-state-directory",
    ),
    store_index: positiveStoreIndex(values.get("--store-index")),
  });
}

function parseCanonicalManifest(bytes) {
  let text;
  let parsed;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    fail("INVALID_FROZEN_ENGINE", "engine manifest is not UTF-8 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || text !== canonicalWalmartItemReportJson(parsed)) {
    fail("INVALID_FROZEN_ENGINE", "engine manifest is not canonical compact JSON");
  }
  return parsed;
}

function loadedCredentials(storeIndex, env) {
  const clientId = env[`WALMART_CLIENT_ID_STORE${storeIndex}`];
  const clientSecret = env[`WALMART_CLIENT_SECRET_STORE${storeIndex}`];
  const sellerId = env[`WALMART_STORE${storeIndex}_SELLER_ID`];
  for (const [label, value] of [
    ["Walmart client ID", clientId],
    ["Walmart client secret", clientSecret],
    ["Walmart seller ID", sellerId],
  ]) {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim()
      || /[\u0000-\u001f\u007f]/u.test(value)) {
      fail("MISSING_CREDENTIALS", `${label} is not configured exactly`);
    }
  }
  return Object.freeze({ client_id: clientId, client_secret: clientSecret, seller_id: sellerId });
}

export async function main(argv = process.argv.slice(2), injected = {}) {
  const parsed = parseWalmartItemReportReissueV2FrozenExecutorCli(argv);
  const loadedBundle = await readImmutableArtifact(
    normalizeDarwinAlias(path.resolve(process.argv[1] ?? SCRIPT_PATH)),
    "loaded frozen executor",
  );
  if (path.basename(loadedBundle.path) !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE
    || sha256(loadedBundle.bytes) !== parsed.expected_frozen_bundle_sha256) {
    fail("LOADED_CODE_BINDING_MISMATCH", "loaded code differs from externally pinned bundle");
  }
  const expectedManifestPath = path.join(path.dirname(loadedBundle.path), MANIFEST_FILE_NAME);
  if (parsed.engine_manifest !== expectedManifestPath) {
    fail("LOADED_CODE_BINDING_MISMATCH", "engine manifest must be beside the loaded bundle");
  }
  const manifestArtifact = await readImmutableArtifact(parsed.engine_manifest, "engine manifest");
  if (sha256(manifestArtifact.bytes) !== parsed.expected_engine_manifest_sha256) {
    fail("ARTIFACT_HASH_MISMATCH", "engine manifest differs from externally pinned SHA-256");
  }
  const manifest = parseCanonicalManifest(manifestArtifact.bytes);
  const captureRoot = exactAbsolute(manifest?.capture?.canonical_root, "manifest capture root");
  const sourceEvidence = await readImmutableArtifact(parsed.source_evidence, "source evidence");
  if (sha256(sourceEvidence.bytes) !== parsed.expected_source_evidence_sha256) {
    fail("ARTIFACT_HASH_MISMATCH", "source evidence differs from externally pinned SHA-256");
  }
  const ownerDisposition = await readImmutableArtifact(parsed.owner_disposition, "owner disposition");
  if (sha256(ownerDisposition.bytes) !== parsed.expected_owner_disposition_sha256) {
    fail("ARTIFACT_HASH_MISMATCH", "owner disposition differs from externally pinned SHA-256");
  }

  const credentials = loadedCredentials(parsed.store_index, injected.env ?? process.env);
  const accountBinding = Object.freeze({
    channel: "WALMART_US",
    store_index: parsed.store_index,
    seller_id: credentials.seller_id,
    seller_account_fingerprint_sha256: computeWalmartSellerAccountFingerprint({
      store_index: parsed.store_index,
      client_id: credentials.client_id,
      seller_id: credentials.seller_id,
    }),
  });
  const result = await executeWalmartItemReportReissueExecutorV2({
    frozen_engine_manifest: {
      bytes: manifestArtifact.bytes,
      expected_artifact_sha256: parsed.expected_engine_manifest_sha256,
    },
    frozen_bundle: {
      bytes: loadedBundle.bytes,
      expected_artifact_sha256: parsed.expected_frozen_bundle_sha256,
    },
    source_evidence: {
      bytes: sourceEvidence.bytes,
      expected_artifact_sha256: parsed.expected_source_evidence_sha256,
    },
    owner_disposition: {
      bytes: ownerDisposition.bytes,
      expected_artifact_sha256: parsed.expected_owner_disposition_sha256,
    },
    expected_environment: "PRODUCTION",
    active_account: {
      store_index: parsed.store_index,
      seller_id: credentials.seller_id,
      client_id: credentials.client_id,
    },
    ledger_state_directory: parsed.ledger_state_directory,
    capture_root: captureRoot,
  }, {
    now: injected.now,
    open_transport: () => {
      const underlying = createWalmartItemReportCliTransport({
        credentials,
        fetch_impl: injected.fetch_impl ?? globalThis.fetch,
        random_uuid: injected.random_uuid,
      });
      return Object.freeze({
        send: underlying.send,
        get_http_call_counts: underlying.get_http_call_counts,
        get_account_binding: () => ({ ...accountBinding }),
      });
    },
  });
  (injected.stdout ?? console.log)(JSON.stringify(result));
  return result;
}

const invokedPath = process.argv[1]
  ? await realpath(path.resolve(process.argv[1])).catch(() => null)
  : null;
if (invokedPath === await realpath(SCRIPT_PATH)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error_code: typeof error?.code === "string" ? error.code : "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : "execution failed",
    })}\n`);
    process.exitCode = 1;
  });
}
