#!/usr/bin/env node

/**
 * Standalone, offline sealer for the frozen Walmart ITEM reissue v2 engine.
 *
 * The executable is bundled by the adjacent freezer.  It accepts only an
 * externally pinned bundle digest and an externally pinned canonical engine
 * manifest.  It has no network, credential, database, model, or marketplace
 * adapter.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { builtinModules } from "node:module";
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

import {
  WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_POLICY,
  WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_SCHEMA,
  buildWalmartItemReportReissueSourceEvidenceV2,
  serializeWalmartItemReportReissueSourceEvidenceV2,
} from "../src/lib/walmart/item-report-reissue-source-evidence-v2.ts";
import {
  inspectWalmartItemReportReissueOwnerDispositionV2TrustRoot,
} from "../src/lib/walmart/item-report-reissue-owner-disposition-v2.ts";
import { canonicalWalmartItemReportJson } from "../src/lib/walmart/item-report-published-source.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ENGINE_SCHEMA = "walmart-item-report-reissue-v2-frozen-engine/1.0.0";
const ENGINE_POLICY = "walmart-item-report-reissue-v2-engine-freeze-policy/1.0.0";
const BUNDLE_FILE_NAME = "walmart-item-report-reissue-v2-frozen-sealer.bundle.mjs";
const SOURCE_ENTRYPOINT = "scripts/walmart-item-report-reissue-v2-frozen-sealer.mjs";
const SEAL_REPORT_SCHEMA =
  "walmart-item-report-reissue-v2-frozen-evidence-seal-report/1.0.0";
const EXACT_ARGV_ORDER = Object.freeze([
  "evidence-seal",
  "--engine-manifest",
  "--expect-engine-manifest-sha256",
  "--expect-frozen-bundle-sha256",
  "--project-root",
  "--evidence-root",
  "--capture-root",
  "--prior-session-name",
  "--release-id",
  "--reviewed-at",
  "--out",
]);
const CERTIFICATION_FILES = Object.freeze([
  Object.freeze(["FREEZER_BUILDER", "scripts/freeze-walmart-item-report-reissue-v2-engine.mjs"]),
  Object.freeze(["FREEZER_TEST", "scripts/__tests__/freeze-walmart-item-report-reissue-v2-engine.test.mjs"]),
  Object.freeze(["FROZEN_SEALER", SOURCE_ENTRYPOINT]),
  Object.freeze(["FROZEN_SEALER_TEST", "scripts/__tests__/walmart-item-report-reissue-v2-frozen-sealer.test.mjs"]),
  Object.freeze(["OWNER_DISPOSITION_MODULE", "src/lib/walmart/item-report-reissue-owner-disposition-v2.ts"]),
  Object.freeze(["OWNER_DISPOSITION_TEST", "src/lib/walmart/__tests__/item-report-reissue-owner-disposition-v2.test.mjs"]),
  Object.freeze(["SOURCE_EVIDENCE_MODULE", "src/lib/walmart/item-report-reissue-source-evidence-v2.ts"]),
  Object.freeze(["SOURCE_EVIDENCE_TEST", "src/lib/walmart/__tests__/item-report-reissue-source-evidence-v2.test.mjs"]),
]);
const REQUIRED_SOURCE_INPUTS = Object.freeze([
  SOURCE_ENTRYPOINT,
  "src/lib/walmart/item-report-reissue-owner-disposition-v2.ts",
  "src/lib/walmart/item-report-reissue-source-evidence-v2.ts",
]);
const BUILTIN_MODULES = new Set(
  builtinModules.map((value) => value.startsWith("node:") ? value : `node:${value}`),
);

function fail(message) {
  const error = new Error(message);
  error.code = "WALMART_ITEM_REPORT_REISSUE_V2_FROZEN_SEALER_ERROR";
  throw error;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const wanted = [...expected].sort(codeUnitCompare);
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unexpected keys`);
  }
}

function exactString(value, label, maximum = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value !== value.trim() || value.includes("\0")) {
    fail(`${label} must be one exact non-empty string`);
  }
  return value;
}

function digest(value, label) {
  const parsed = exactString(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) fail(`${label} must be lowercase SHA-256`);
  return parsed;
}

function safeInteger(value, label, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    fail(`${label} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
  return value;
}

function normalizeMacAlias(absolutePath) {
  if (process.platform !== "darwin") return absolutePath;
  for (const [alias, canonical] of [["/var", "/private/var"], ["/tmp", "/private/tmp"]]) {
    if (absolutePath === alias || absolutePath.startsWith(`${alias}/`)) {
      return `${canonical}${absolutePath.slice(alias.length)}`;
    }
  }
  return absolutePath;
}

function exactAbsolute(value, label) {
  const candidate = exactString(value, label);
  if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) {
    fail(`${label} must be an exact normalized absolute path`);
  }
  return normalizeMacAlias(candidate);
}

function canonicalRelative(value, label) {
  const candidate = exactString(value, label);
  if (candidate.includes("\\") || path.posix.isAbsolute(candidate)
    || candidate === "." || candidate.startsWith("../")
    || path.posix.normalize(candidate) !== candidate) {
    fail(`${label} must be one canonical project-relative path`);
  }
  return candidate;
}

function sameStableFile(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameObjectIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

async function readStableRealFile(
  absolutePath,
  label,
  expectedIdentity = null,
  options = { singleLink: true },
) {
  const before = await lstat(absolutePath, { bigint: true }).catch(() => {
    fail(`${label} is missing`);
  });
  if (!before.isFile() || before.isSymbolicLink()
    || (options.singleLink ? before.nlink !== 1n : before.nlink < 1n)) {
    fail(`${label} must be a real regular file`);
  }
  if (await realpath(absolutePath) !== absolutePath) {
    fail(`${label} must not use a symlink alias`);
  }
  if (expectedIdentity && !sameStableFile(expectedIdentity, before)) {
    fail(`${label} identity changed`);
  }
  const handle = await open(
    absolutePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStableFile(before, opened)) fail(`${label} raced before read`);
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(absolutePath, { bigint: true });
    if (!sameStableFile(opened, afterHandle) || !sameStableFile(afterHandle, afterPath)
      || BigInt(bytes.byteLength) !== afterHandle.size) {
      fail(`${label} raced during read`);
    }
    return { bytes, identity: afterPath };
  } finally {
    await handle.close();
  }
}

async function realDirectoryIdentity(absolutePath, label) {
  const info = await lstat(absolutePath, { bigint: true }).catch(() => {
    fail(`${label} is missing`);
  });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolutePath) !== absolutePath) {
    fail(`${label} must be a real directory without aliases`);
  }
  return info;
}

function assertPrivateOwnedDirectory(info, label) {
  if (Number(info.mode & 0o777n) !== 0o700) {
    fail(`${label} must have exact mode 0700`);
  }
  if (typeof process.getuid === "function" && info.uid !== BigInt(process.getuid())) {
    fail(`${label} must be owned by the current uid`);
  }
}

function assertFrozenOwnedDirectory(info) {
  if (Number(info.mode & 0o777n) !== 0o500) {
    fail("frozen engine directory must have exact mode 0500");
  }
  if (typeof process.getuid === "function" && info.uid !== BigInt(process.getuid())) {
    fail("frozen engine directory must be owned by the current uid");
  }
}

async function assertDirectoryStable(absolutePath, identity, label) {
  const current = await realDirectoryIdentity(absolutePath, label);
  if (!sameObjectIdentity(identity, current)) fail(`${label} identity changed`);
}

function withinOrSame(candidate, ancestor) {
  const relative = path.relative(ancestor, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

function assertAncestryDisjoint(output, protectedPath, label) {
  if (withinOrSame(output, protectedPath) || withinOrSame(protectedPath, output)) {
    fail(`--out must be ancestry-disjoint from ${label}`);
  }
}

function parseExactArgv(argv) {
  if (argv.length !== EXACT_ARGV_ORDER.length || argv[0] !== "evidence-seal") {
    fail("CLI invocation must use the exact frozen evidence-seal argument order");
  }
  const values = new Map();
  for (let index = 1; index < EXACT_ARGV_ORDER.length; index += 1) {
    const name = EXACT_ARGV_ORDER[index];
    const prefix = `${name}=`;
    const argument = argv[index];
    if (!argument.startsWith(prefix) || argument.length === prefix.length) {
      fail(`CLI argument ${index + 1} must be ${name}=...`);
    }
    values.set(name.slice(2), argument.slice(prefix.length));
  }
  return values;
}

function parseCanonicalJson(bytes, label) {
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail(`${label} must be valid UTF-8 JSON`);
  }
  if (text !== canonicalWalmartItemReportJson(value)) {
    fail(`${label} bytes must be canonical compact JSON`);
  }
  return record(value, label);
}

function parseHashedFiles(value, label, sortKey) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be non-empty`);
  const parsed = value.map((entry, index) => {
    const item = record(entry, `${label}[${index}]`);
    const keys = label === "source_inputs"
      ? ["byte_length", "relative_path", "sha256"]
      : ["byte_length", "relative_path", "role", "sha256"];
    exactKeys(item, keys, `${label}[${index}]`);
    const result = {
      relative_path: canonicalRelative(item.relative_path, `${label}[${index}].relative_path`),
      byte_length: safeInteger(item.byte_length, `${label}[${index}].byte_length`, true),
      sha256: digest(item.sha256, `${label}[${index}].sha256`),
    };
    if (label !== "source_inputs") {
      result.role = exactString(item.role, `${label}[${index}].role`, 128);
    }
    return result;
  });
  const expected = [...parsed].sort((left, right) => {
    const primary = codeUnitCompare(left[sortKey], right[sortKey]);
    return primary || codeUnitCompare(left.relative_path, right.relative_path);
  });
  if (canonicalWalmartItemReportJson(parsed) !== canonicalWalmartItemReportJson(expected)) {
    fail(`${label} must be strictly sorted`);
  }
  if (new Set(parsed.map((entry) => entry[sortKey])).size !== parsed.length
    || new Set(parsed.map((entry) => entry.relative_path)).size !== parsed.length) {
    fail(`${label} contains duplicate identities`);
  }
  return parsed;
}

function validateEngineManifest(value, context) {
  exactKeys(value, [
    "build",
    "bundle",
    "certification_files",
    "certification_files_sha256",
    "entrypoint",
    "external_runtime_imports",
    "policy_id",
    "project_root_realpath_sha256",
    "runtime",
    "schema_version",
    "source_inputs",
    "source_inputs_sha256",
  ], "engine manifest");
  if (value.schema_version !== ENGINE_SCHEMA || value.policy_id !== ENGINE_POLICY) {
    fail("engine manifest schema or freeze policy is invalid");
  }
  if (digest(value.project_root_realpath_sha256, "project_root_realpath_sha256")
    !== sha256(Buffer.from(context.projectRoot, "utf8"))) {
    fail("engine manifest project-root binding is invalid");
  }

  const bundle = record(value.bundle, "engine manifest bundle");
  exactKeys(bundle, ["byte_length", "file_name", "sha256"], "engine manifest bundle");
  if (bundle.file_name !== BUNDLE_FILE_NAME || bundle.file_name !== path.basename(SCRIPT_PATH)
    || safeInteger(bundle.byte_length, "bundle.byte_length") !== context.bundleBytes.byteLength
    || digest(bundle.sha256, "bundle.sha256") !== context.bundleSha256) {
    fail("engine manifest bundle binding is invalid");
  }

  const runtime = record(value.runtime, "engine manifest runtime");
  exactKeys(runtime, [
    "arch",
    "exec_path_artifact_sha256",
    "exec_path_realpath_sha256",
    "node_options_required",
    "node_path_required",
    "node_version",
    "platform",
    "required_exec_argv",
  ], "engine manifest runtime");
  if (runtime.node_version !== process.version || runtime.platform !== process.platform
    || runtime.arch !== process.arch
    || runtime.exec_path_realpath_sha256 !== context.execPathRealpathSha256
    || runtime.exec_path_artifact_sha256 !== context.execPathArtifactSha256
    || !Array.isArray(runtime.required_exec_argv) || runtime.required_exec_argv.length !== 0
    || runtime.node_options_required !== "ABSENT" || runtime.node_path_required !== "ABSENT") {
    fail("engine manifest runtime binding is invalid");
  }

  const build = record(value.build, "engine manifest build");
  exactKeys(build, [
    "bundle", "charset", "esbuild_version", "external_policy", "format",
    "legal_comments", "metafile", "packages", "platform", "sourcemap", "tool",
    "tree_shaking", "write",
  ], "engine manifest build");
  if (build.tool !== "esbuild" || typeof build.esbuild_version !== "string"
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(build.esbuild_version)
    || build.bundle !== true || build.packages !== "bundle" || build.platform !== "node"
    || build.format !== "esm" || build.sourcemap !== false || build.metafile !== true
    || build.write !== false || build.legal_comments !== "none" || build.charset !== "utf8"
    || build.tree_shaking !== false || build.external_policy !== "NODE_BUILTINS_ONLY") {
    fail("engine manifest build policy is invalid");
  }

  const entrypoint = record(value.entrypoint, "engine manifest entrypoint");
  exactKeys(entrypoint, [
    "argument_style", "bundle_file_name", "command", "exact_argv_order",
    "source_relative_path",
  ], "engine manifest entrypoint");
  if (entrypoint.source_relative_path !== SOURCE_ENTRYPOINT
    || entrypoint.bundle_file_name !== BUNDLE_FILE_NAME
    || entrypoint.command !== "evidence-seal" || entrypoint.argument_style !== "--name=value"
    || canonicalWalmartItemReportJson(entrypoint.exact_argv_order)
      !== canonicalWalmartItemReportJson(EXACT_ARGV_ORDER)) {
    fail("engine manifest entrypoint contract is invalid");
  }

  const sourceInputs = parseHashedFiles(value.source_inputs, "source_inputs", "relative_path");
  if (digest(value.source_inputs_sha256, "source_inputs_sha256")
      !== sha256(Buffer.from(canonicalWalmartItemReportJson(sourceInputs), "utf8"))
    || REQUIRED_SOURCE_INPUTS.some((required) => !sourceInputs.some(
      (entry) => entry.relative_path === required,
    ))) {
    fail("engine manifest source-input binding is invalid");
  }

  const certificationFiles = parseHashedFiles(
    value.certification_files,
    "certification_files",
    "role",
  );
  if (digest(value.certification_files_sha256, "certification_files_sha256")
      !== sha256(Buffer.from(canonicalWalmartItemReportJson(certificationFiles), "utf8"))
    || certificationFiles.length !== CERTIFICATION_FILES.length
    || certificationFiles.some((entry, index) => (
      entry.role !== CERTIFICATION_FILES[index][0]
      || entry.relative_path !== CERTIFICATION_FILES[index][1]
    ))) {
    fail("engine manifest certification binding is invalid");
  }

  if (!Array.isArray(value.external_runtime_imports)
    || value.external_runtime_imports.length === 0
    || value.external_runtime_imports.some((entry) => typeof entry !== "string"
      || !entry.startsWith("node:") || !BUILTIN_MODULES.has(entry))
    || new Set(value.external_runtime_imports).size !== value.external_runtime_imports.length
    || canonicalWalmartItemReportJson(value.external_runtime_imports)
      !== canonicalWalmartItemReportJson([...value.external_runtime_imports].sort(codeUnitCompare))) {
    fail("engine manifest external imports must be sorted unique Node builtins only");
  }
  return value;
}

async function runtimeAttestation(values) {
  if (process.execArgv.length !== 0) fail("process.execArgv must be empty");
  if (Object.prototype.hasOwnProperty.call(process.env, "NODE_OPTIONS")) {
    fail("NODE_OPTIONS must be absent");
  }
  if (Object.prototype.hasOwnProperty.call(process.env, "NODE_PATH")) {
    fail("NODE_PATH must be absent");
  }
  if (path.resolve(process.argv[1] ?? "") !== SCRIPT_PATH
    || await realpath(SCRIPT_PATH).catch(() => null) !== SCRIPT_PATH) {
    fail("frozen bundle must be invoked through its exact real path");
  }

  const expectedBundleSha = digest(
    values.get("expect-frozen-bundle-sha256"),
    "--expect-frozen-bundle-sha256",
  );
  const bundle = await readStableRealFile(SCRIPT_PATH, "frozen bundle");
  const actualBundleSha = sha256(bundle.bytes);
  if (actualBundleSha !== expectedBundleSha) fail("frozen bundle SHA-256 mismatch");

  const execPath = await realpath(process.execPath).catch(() => fail("Node execPath is invalid"));
  const executable = await readStableRealFile(
    execPath,
    "Node executable",
    null,
    { singleLink: false },
  );
  const projectRoot = exactAbsolute(values.get("project-root"), "--project-root");
  const projectIdentity = await realDirectoryIdentity(projectRoot, "project root");

  const manifestPath = exactAbsolute(values.get("engine-manifest"), "--engine-manifest");
  if (path.basename(manifestPath) !== "engine-release.json"
    || path.dirname(manifestPath) !== path.dirname(SCRIPT_PATH)) {
    fail("engine manifest must be engine-release.json beside the frozen bundle");
  }
  const manifest = await readStableRealFile(manifestPath, "engine manifest");
  const expectedManifestSha = digest(
    values.get("expect-engine-manifest-sha256"),
    "--expect-engine-manifest-sha256",
  );
  const actualManifestSha = sha256(manifest.bytes);
  if (actualManifestSha !== expectedManifestSha) fail("engine manifest SHA-256 mismatch");

  const parsedManifest = parseCanonicalJson(manifest.bytes, "engine manifest");
  validateEngineManifest(parsedManifest, {
    projectRoot,
    bundleBytes: bundle.bytes,
    bundleSha256: actualBundleSha,
    execPathRealpathSha256: sha256(Buffer.from(execPath, "utf8")),
    execPathArtifactSha256: sha256(executable.bytes),
  });
  return {
    projectRoot,
    projectIdentity,
    frozenEngineDir: path.dirname(SCRIPT_PATH),
    bundleIdentity: bundle.identity,
    bundleBytes: bundle.bytes,
    bundleSha256: actualBundleSha,
    manifestPath,
    manifestIdentity: manifest.identity,
    manifestBytes: manifest.bytes,
    manifestSha256: actualManifestSha,
    manifest: parsedManifest,
    execPath,
    execPathIdentity: executable.identity,
    execPathArtifactSha256: sha256(executable.bytes),
  };
}

async function reverifyFrozenInputs(attestation) {
  const bundle = await readStableRealFile(
    SCRIPT_PATH,
    "frozen bundle",
    attestation.bundleIdentity,
  );
  if (sha256(bundle.bytes) !== attestation.bundleSha256) fail("frozen bundle drifted");
  const manifest = await readStableRealFile(
    attestation.manifestPath,
    "engine manifest",
    attestation.manifestIdentity,
  );
  if (sha256(manifest.bytes) !== attestation.manifestSha256
    || !manifest.bytes.equals(attestation.manifestBytes)) {
    fail("engine manifest drifted");
  }
  const executable = await readStableRealFile(
    attestation.execPath,
    "Node executable",
    attestation.execPathIdentity,
    { singleLink: false },
  );
  if (sha256(executable.bytes) !== attestation.execPathArtifactSha256) {
    fail("Node executable drifted");
  }
  await assertDirectoryStable(
    attestation.projectRoot,
    attestation.projectIdentity,
    "project root",
  );
}

async function assertNewDisjointOutput(values, attestation) {
  const output = exactAbsolute(values.get("out"), "--out");
  const exists = await lstat(output).then(() => true).catch((error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
  if (exists) fail("--out must name a nonexistent directory");
  const parent = path.dirname(output);
  const parentIdentity = await realDirectoryIdentity(parent, "--out parent");
  assertPrivateOwnedDirectory(parentIdentity, "--out parent");
  const prospective = path.join(await realpath(parent), path.basename(output));
  if (prospective !== output) fail("--out must use its exact real parent path");

  const evidenceRoot = exactAbsolute(values.get("evidence-root"), "--evidence-root");
  const captureRoot = exactAbsolute(values.get("capture-root"), "--capture-root");
  const evidenceIdentity = await realDirectoryIdentity(evidenceRoot, "evidence root");
  const captureIdentity = await realDirectoryIdentity(captureRoot, "capture root");
  for (const [protectedPath, label] of [
    [evidenceRoot, "evidence root"],
    [captureRoot, "capture root"],
    [attestation.projectRoot, "project root"],
    [attestation.frozenEngineDir, "frozen engine directory"],
  ]) {
    assertAncestryDisjoint(output, protectedPath, label);
  }
  return {
    output,
    parent,
    parentIdentity,
    evidenceRoot,
    evidenceIdentity,
    captureRoot,
    captureIdentity,
  };
}

async function assertProtectedBoundariesStable(boundary, attestation, frozenEngineIdentity) {
  await assertDirectoryStable(boundary.parent, boundary.parentIdentity, "--out parent");
  assertPrivateOwnedDirectory(
    await realDirectoryIdentity(boundary.parent, "--out parent"),
    "--out parent",
  );
  await assertDirectoryStable(boundary.evidenceRoot, boundary.evidenceIdentity, "evidence root");
  await assertDirectoryStable(boundary.captureRoot, boundary.captureIdentity, "capture root");
  await assertDirectoryStable(
    attestation.frozenEngineDir,
    frozenEngineIdentity,
    "frozen engine directory",
  );
  assertFrozenOwnedDirectory(
    await realDirectoryIdentity(attestation.frozenEngineDir, "frozen engine directory"),
  );
}

async function assertBoundaryStable(boundary, attestation, frozenEngineIdentity) {
  await assertProtectedBoundariesStable(boundary, attestation, frozenEngineIdentity);
  const exists = await lstat(boundary.output).then(() => true).catch((error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
  if (exists) fail("--out appeared during sealing");
}

async function writeSyncedExclusive(filePath, bytes) {
  const handle = await open(filePath, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o400);
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function evidenceSeal(argv) {
  const values = parseExactArgv(argv);
  const attestation = await runtimeAttestation(values);
  const boundary = await assertNewDisjointOutput(values, attestation);
  const frozenEngineIdentity = await realDirectoryIdentity(
    attestation.frozenEngineDir,
    "frozen engine directory",
  );
  assertFrozenOwnedDirectory(frozenEngineIdentity);

  const sourceEvidence = await buildWalmartItemReportReissueSourceEvidenceV2({
    evidence_root: boundary.evidenceRoot,
    capture_root: boundary.captureRoot,
    prior_session_name: values.get("prior-session-name"),
    release_id: values.get("release-id"),
    reviewed_at: values.get("reviewed-at"),
  });
  const sourceEvidenceBytes = Buffer.from(
    serializeWalmartItemReportReissueSourceEvidenceV2(sourceEvidence),
  );
  const sourceEvidenceArtifactSha = sha256(sourceEvidenceBytes);
  const productionOwnerTrustRoot = inspectWalmartItemReportReissueOwnerDispositionV2TrustRoot(
    Object.create(null),
    "PRODUCTION",
  );

  await reverifyFrozenInputs(attestation);
  await assertDirectoryStable(
    attestation.frozenEngineDir,
    frozenEngineIdentity,
    "frozen engine directory",
  );
  await assertBoundaryStable(boundary, attestation, frozenEngineIdentity);

  const sealReport = {
    schema_version: SEAL_REPORT_SCHEMA,
    reviewed_at: sourceEvidence.body.reviewed_at,
    source_evidence_artifact: {
      path: "source-evidence-release.json",
      byte_length: sourceEvidenceBytes.byteLength,
      artifact_sha256: sourceEvidenceArtifactSha,
      body_sha256: sourceEvidence.body_sha256,
      release_sha256: sourceEvidence.release_sha256,
    },
    engine_manifest_artifact: {
      path: "engine-release.json",
      byte_length: attestation.manifestBytes.byteLength,
      artifact_sha256: attestation.manifestSha256,
      schema_version: attestation.manifest.schema_version,
      policy_id: attestation.manifest.policy_id,
    },
    frozen_bundle: {
      file_name: path.basename(SCRIPT_PATH),
      byte_length: attestation.bundleBytes.byteLength,
      artifact_sha256: attestation.bundleSha256,
    },
    runtime: {
      node_version: process.version,
      exec_path_realpath_sha256: sha256(Buffer.from(attestation.execPath, "utf8")),
      exec_path_artifact_sha256: attestation.execPathArtifactSha256,
      platform: process.platform,
      arch: process.arch,
      exec_argv: [],
      node_options: "ABSENT",
      node_path: "ABSENT",
    },
    bundled_contracts: {
      source_evidence_schema: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_SCHEMA,
      source_evidence_policy: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_POLICY,
      production_owner_trust_root: productionOwnerTrustRoot,
    },
    output_safety: {
      ancestry_disjoint: true,
      stable_parent_identity: true,
      output_directory_mode: "0700",
      artifact_file_mode: "0400",
      project_root_realpath_sha256: sha256(Buffer.from(attestation.projectRoot, "utf8")),
      evidence_root_realpath_sha256: sha256(Buffer.from(boundary.evidenceRoot, "utf8")),
      capture_root_realpath_sha256: sha256(Buffer.from(boundary.captureRoot, "utf8")),
      frozen_engine_directory_realpath_sha256:
        sha256(Buffer.from(attestation.frozenEngineDir, "utf8")),
    },
    external_effects: {
      network_calls: 0,
      credential_reads: 0,
      database_calls: 0,
      model_calls: 0,
      walmart_calls: 0,
      walmart_content_writes: 0,
      quarantined_session_writes: 0,
    },
  };
  const sealReportBytes = Buffer.from(canonicalWalmartItemReportJson(sealReport), "utf8");
  const artifacts = [
    ["source-evidence-release.json", sourceEvidenceBytes],
    ["engine-release.json", attestation.manifestBytes],
    ["seal-report.json", sealReportBytes],
  ];
  const temporary = path.join(
    boundary.parent,
    `.walmart-item-reissue-v2-frozen-${randomUUID()}.tmp`,
  );
  assertAncestryDisjoint(temporary, boundary.evidenceRoot, "evidence root");
  assertAncestryDisjoint(temporary, boundary.captureRoot, "capture root");
  assertAncestryDisjoint(temporary, attestation.projectRoot, "project root");
  assertAncestryDisjoint(temporary, attestation.frozenEngineDir, "frozen engine directory");

  let published = false;
  await mkdir(temporary, { mode: 0o700 });
  await chmod(temporary, 0o700);
  try {
    for (const [fileName, bytes] of artifacts) {
      await writeSyncedExclusive(path.join(temporary, fileName), bytes);
      await writeSyncedExclusive(
        path.join(temporary, `${fileName}.sha256`),
        Buffer.from(`${sha256(bytes)}  ${fileName}\n`, "utf8"),
      );
    }
    await syncDirectory(temporary);

    // This is intentionally after review and after every artifact write, but
    // before the only publication rename.
    await reverifyFrozenInputs(attestation);
    await assertDirectoryStable(
      attestation.frozenEngineDir,
      frozenEngineIdentity,
      "frozen engine directory",
    );
    await assertBoundaryStable(boundary, attestation, frozenEngineIdentity);
    await rename(temporary, boundary.output);
    published = true;
    await syncDirectory(boundary.parent);
  } catch (error) {
    if (!published) {
      await chmod(temporary, 0o700).catch(() => {});
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }

  const outputInfo = await lstat(boundary.output, { bigint: true });
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()
    || Number(outputInfo.mode & 0o777n) !== 0o700
    || await realpath(boundary.output) !== boundary.output) {
    fail("published output directory is not private and real");
  }
  await reverifyFrozenInputs(attestation);
  await assertProtectedBoundariesStable(boundary, attestation, frozenEngineIdentity);
  for (const [fileName, bytes] of artifacts) {
    for (const [publishedName, expectedBytes] of [
      [fileName, bytes],
      [`${fileName}.sha256`, Buffer.from(`${sha256(bytes)}  ${fileName}\n`, "utf8")],
    ]) {
      const publishedArtifact = await readStableRealFile(
        path.join(boundary.output, publishedName),
        `published ${publishedName}`,
      );
      if (!publishedArtifact.bytes.equals(expectedBytes)
        || Number(publishedArtifact.identity.mode & 0o777n) !== 0o400) {
        fail(`published ${publishedName} failed exact byte/mode verification`);
      }
    }
  }
  return {
    status: "SEALED",
    output: boundary.output,
    source_evidence_artifact_sha256: sourceEvidenceArtifactSha,
    source_evidence_release_sha256: sourceEvidence.release_sha256,
    source_evidence_body_sha256: sourceEvidence.body_sha256,
    evidence_fresh_until: sourceEvidence.body.exact_probe.fresh_until,
    engine_manifest_artifact_sha256: attestation.manifestSha256,
    frozen_bundle_artifact_sha256: attestation.bundleSha256,
    production_owner_trust_root_ready: productionOwnerTrustRoot.ready,
    live_report_create_path_enabled: false,
    network_calls: 0,
  };
}

export async function runWalmartItemReportReissueV2FrozenSealerCli(argv) {
  return evidenceSeal(argv);
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  runWalmartItemReportReissueV2FrozenSealerCli(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => {
      process.stderr.write(`${error?.code ?? "ERROR"}: ${error?.message ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
