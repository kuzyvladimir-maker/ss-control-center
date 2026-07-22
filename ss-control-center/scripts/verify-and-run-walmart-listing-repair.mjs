#!/usr/bin/env node

/** Verify one frozen Walmart Listing Repair release before invoking its operator. */

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_SCHEMA = "walmart-listing-repair-frozen-release/v1";
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const WRAPPER_PATH = "scripts/verify-and-run-walmart-listing-repair.mjs";
const OPERATOR_PATH = "scripts/walmart-listing-repair-operator.ts";
const WRITER_PATH = "src/lib/walmart/listing-integrity-remediation-writer.ts";
const QUALIFICATION_PATH = "src/lib/walmart/listing-integrity-remediation-qualification.ts";
const ALLOWED_COMMANDS = Object.freeze([
  "doctor", "plan", "execute", "resume", "status", "report",
]);

export class WalmartListingRepairReleaseVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalmartListingRepairReleaseVerificationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WalmartListingRepairReleaseVerificationError(code, message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("NON_CANONICAL_MANIFEST", "manifest rejects undefined");
  return encoded;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_MANIFEST", `${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(record(value, label)).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((entry, index) => entry !== keys[index])) {
    fail("INVALID_MANIFEST", `${label} has missing or extra fields`);
  }
}

function exactSha(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("INVALID_SHA256", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function exactAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) {
    fail("INVALID_CLI", `${label} must be an absolute normalized path`);
  }
  return value;
}

function safeRelative(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.includes("\\")
    || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || value === ".." || value.startsWith("../")) {
    fail("INVALID_MANIFEST", `${label} must be a normalized repository-relative path`);
  }
  return value;
}

function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return fail("GIT_VERIFICATION_FAILED", `git ${args.join(" ")} failed`);
  }
}

async function readSingleRegularFile(absolute, label, maximum = Number.MAX_SAFE_INTEGER) {
  const metadata = await lstat(absolute).catch(() => fail("MISSING_FILE", `${label} is missing`));
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.size < 1 || metadata.size > maximum || await realpath(absolute) !== absolute) {
    fail("UNSAFE_FILE", `${label} must be one canonical regular non-hardlinked file`);
  }
  return readFile(absolute);
}

export function parseWalmartListingRepairReleaseWrapperArgs(argv) {
  const delimiter = argv.indexOf("--");
  if (delimiter < 0 || argv.lastIndexOf("--") !== delimiter) {
    fail("INVALID_CLI", "one exact -- delimiter is required before the operator command");
  }
  const wrapperArgs = argv.slice(0, delimiter);
  const operatorArgs = argv.slice(delimiter + 1);
  const values = new Map();
  const allowed = new Set([
    "engine-root", "manifest", "manifest-sha256", "release-id-sha256",
  ]);
  for (let index = 0; index < wrapperArgs.length; index += 1) {
    const token = wrapperArgs[index];
    if (!token.startsWith("--") || token.includes("=")) {
      fail("INVALID_CLI", `unsupported wrapper argument ${token}`);
    }
    const key = token.slice(2);
    if (!allowed.has(key) || values.has(key)) {
      fail("INVALID_CLI", `wrapper flag --${key} is forbidden or repeated`);
    }
    const value = wrapperArgs[index + 1];
    if (!value || value.startsWith("--")) fail("INVALID_CLI", `--${key} needs a value`);
    values.set(key, value);
    index += 1;
  }
  if (values.size !== allowed.size) fail("INVALID_CLI", "all four wrapper trust inputs are required");
  if (!ALLOWED_COMMANDS.includes(operatorArgs[0]) || operatorArgs.length < 1) {
    fail("INVALID_CLI", "operator command is missing or forbidden");
  }
  return Object.freeze({
    engine_root: exactAbsolutePath(values.get("engine-root"), "--engine-root"),
    manifest_path: exactAbsolutePath(values.get("manifest"), "--manifest"),
    expected_manifest_sha256: exactSha(values.get("manifest-sha256"), "--manifest-sha256"),
    expected_release_id_sha256: exactSha(
      values.get("release-id-sha256"),
      "--release-id-sha256",
    ),
    operator_args: Object.freeze([...operatorArgs]),
  });
}

export async function verifyFrozenWalmartListingRepairRelease(input) {
  const engineRoot = exactAbsolutePath(input.engine_root, "engine_root");
  const manifestPath = exactAbsolutePath(input.manifest_path, "manifest_path");
  const expectedManifestSha = exactSha(
    input.expected_manifest_sha256,
    "expected_manifest_sha256",
  );
  const expectedReleaseId = exactSha(
    input.expected_release_id_sha256,
    "expected_release_id_sha256",
  );
  const rootStat = await lstat(engineRoot).catch(() => fail("INVALID_ENGINE_ROOT", "engine root is missing"));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(engineRoot) !== engineRoot) {
    fail("INVALID_ENGINE_ROOT", "engine root must be one canonical directory");
  }
  if (input.launcher_path) {
    const launcher = exactAbsolutePath(input.launcher_path, "launcher_path");
    const expectedLauncher = path.join(engineRoot, WRAPPER_PATH);
    if (launcher !== expectedLauncher || await realpath(launcher) !== expectedLauncher) {
      fail("UNTRUSTED_LAUNCHER", "the wrapper must execute from the verified engine root");
    }
  }

  const manifestStat = await lstat(manifestPath).catch(() => fail("MISSING_FILE", "manifest is missing"));
  if ((manifestStat.mode & 0o077) !== 0) {
    fail("UNSAFE_MANIFEST", "manifest must not be group/world accessible");
  }
  const manifestBytes = await readSingleRegularFile(
    manifestPath,
    "release manifest",
    MAX_MANIFEST_BYTES,
  );
  if (sha256(manifestBytes) !== expectedManifestSha) {
    fail("MANIFEST_SHA256_MISMATCH", "release manifest differs from the external expected hash");
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    return fail("INVALID_MANIFEST", "release manifest is not exact UTF-8 JSON");
  }
  exactKeys(manifest, [
    "schema_version", "created_at", "release_id_sha256", "git", "runtime",
    "certification", "source_inventory", "owner_gate", "body_sha256",
  ], "release manifest");
  const canonicalBytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  if (!manifestBytes.equals(canonicalBytes)) {
    fail("NON_CANONICAL_MANIFEST", "release manifest bytes are not canonical JSON plus LF");
  }
  if (manifest.schema_version !== MANIFEST_SCHEMA
    || exactSha(manifest.release_id_sha256, "manifest release_id_sha256") !== expectedReleaseId) {
    fail("RELEASE_ID_MISMATCH", "manifest schema or release identity is not the expected release");
  }
  const body = { ...manifest };
  delete body.body_sha256;
  if (exactSha(manifest.body_sha256, "manifest body_sha256") !== sha256(canonicalJson(body))) {
    fail("MANIFEST_BODY_MISMATCH", "manifest body hash is invalid");
  }

  exactKeys(manifest.git, ["commit", "tree", "clean_checkout"], "manifest git");
  if (manifest.git.clean_checkout !== true
    || !GIT_OBJECT_ID.test(manifest.git.commit) || !GIT_OBJECT_ID.test(manifest.git.tree)) {
    fail("INVALID_MANIFEST", "manifest Git identity is invalid");
  }
  exactKeys(manifest.runtime, [
    "entrypoints", "normalized_closure_file_count", "pinned_apply_release_matches",
    "pinned_verifier_release_matches", "caller_dependency_injection_allowed",
    "automatic_retry_allowed", "marketplace_write_calls_maximum",
  ], "manifest runtime");
  const entries = manifest.runtime.entrypoints;
  if (!Array.isArray(entries) || !entries.includes(WRAPPER_PATH) || !entries.includes(OPERATOR_PATH)
    || manifest.runtime.pinned_apply_release_matches !== true
    || manifest.runtime.pinned_verifier_release_matches !== true
    || manifest.runtime.caller_dependency_injection_allowed !== false
    || manifest.runtime.automatic_retry_allowed !== false
    || manifest.runtime.marketplace_write_calls_maximum !== 1) {
    fail("INVALID_MANIFEST", "runtime safety claims or entrypoints are invalid");
  }

  const gitRoot = git(engineRoot, ["rev-parse", "--show-toplevel"]);
  const engineWithinGit = path.relative(gitRoot, engineRoot);
  if (!path.isAbsolute(gitRoot) || path.resolve(gitRoot) !== gitRoot
    || await realpath(gitRoot) !== gitRoot || engineWithinGit.startsWith("..")
    || path.isAbsolute(engineWithinGit)
    || git(engineRoot, ["status", "--porcelain=v1", "--untracked-files=all"]) !== ""
    || git(engineRoot, ["rev-parse", "HEAD"]) !== manifest.git.commit
    || git(engineRoot, ["rev-parse", "HEAD^{tree}"]) !== manifest.git.tree) {
    fail("DIRTY_OR_WRONG_CHECKOUT", "engine checkout is dirty or differs from the sealed Git identity");
  }

  if (!Array.isArray(manifest.source_inventory) || manifest.source_inventory.length < 1) {
    fail("INVALID_MANIFEST", "source_inventory must be non-empty");
  }
  const inventoryPaths = new Set();
  let previousPath = "";
  for (const [index, row] of manifest.source_inventory.entries()) {
    exactKeys(row, ["path", "byte_length", "sha256"], `source_inventory[${index}]`);
    const relative = safeRelative(row.path, `source_inventory[${index}].path`);
    if (inventoryPaths.has(relative) || relative <= previousPath
      || !Number.isSafeInteger(row.byte_length) || row.byte_length < 1) {
      fail("INVALID_MANIFEST", "source inventory must be unique, sorted, and have positive lengths");
    }
    previousPath = relative;
    inventoryPaths.add(relative);
    const absolute = path.join(engineRoot, ...relative.split("/"));
    const bytes = await readSingleRegularFile(absolute, relative);
    if (bytes.byteLength !== row.byte_length
      || sha256(bytes) !== exactSha(row.sha256, `${relative} sha256`)) {
      fail("SOURCE_INVENTORY_MISMATCH", `${relative} differs from the frozen source inventory`);
    }
  }
  for (const required of [
    WRAPPER_PATH, OPERATOR_PATH, WRITER_PATH, QUALIFICATION_PATH, "package.json", "package-lock.json",
  ]) {
    if (!inventoryPaths.has(required)) fail("INCOMPLETE_INVENTORY", `${required} is not sealed`);
  }
  for (const relative of [WRITER_PATH, QUALIFICATION_PATH]) {
    const source = await readFile(path.join(engineRoot, relative), "utf8");
    const declaration = relative === WRITER_PATH
      ? "PINNED_PRODUCTION_APPLY_ENGINE_RELEASE_SHA256"
      : "PINNED_PRODUCTION_VERIFIER_ENGINE_RELEASE_SHA256";
    const exactPin = new RegExp(
      `const ${declaration}:\\s*string \\| null\\s*=\\s*"${expectedReleaseId}";`,
      "u",
    );
    if (!exactPin.test(source)) {
      fail("RELEASE_PIN_MISMATCH", `${relative} does not pin the expected frozen release`);
    }
  }
  return Object.freeze({
    status: "VERIFIED",
    release_id_sha256: expectedReleaseId,
    manifest_sha256: expectedManifestSha,
    git_commit: manifest.git.commit,
    git_tree: manifest.git.tree,
    source_file_count: manifest.source_inventory.length,
  });
}

function cleanProductionEnvironment(releaseId, manifestSha) {
  const env = { ...process.env };
  for (const key of [
    "NODE_OPTIONS", "NODE_PATH", "WALMART_LISTING_REPAIR_TEST_MODE",
    "WALMART_LISTING_REPAIR_TEST_OWNER_KEY_ID",
    "WALMART_LISTING_REPAIR_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64",
  ]) delete env[key];
  env.NODE_ENV = "production";
  env.NO_COLOR = "1";
  env.WALMART_LISTING_REPAIR_FROZEN_RELEASE_ID_SHA256 = releaseId;
  env.WALMART_LISTING_REPAIR_FROZEN_RELEASE_MANIFEST_SHA256 = manifestSha;
  return env;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseWalmartListingRepairReleaseWrapperArgs(argv);
  const launcher = await realpath(path.resolve(process.argv[1]));
  const verified = await verifyFrozenWalmartListingRepairRelease({
    ...parsed,
    launcher_path: launcher,
  });
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor < 24 || nodeMajor > 25) fail("UNSUPPORTED_NODE", "frozen engine requires Node 24 or 25");
  const result = spawnSync(process.execPath, [
    "--import", "tsx", OPERATOR_PATH, ...parsed.operator_args,
  ], {
    cwd: parsed.engine_root,
    env: cleanProductionEnvironment(
      verified.release_id_sha256,
      verified.manifest_sha256,
    ),
    stdio: "inherit",
  });
  if (result.error) fail("OPERATOR_LAUNCH_FAILED", result.error.message);
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${canonicalJson({
      schema_version: "walmart-listing-repair-release-wrapper-error/v1",
      status: "ERROR",
      error_code: error instanceof WalmartListingRepairReleaseVerificationError
        ? error.code : "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : "unknown error",
      marketplace_write_authorized: false,
    })}\n`);
    process.exitCode = 1;
  });
}
