#!/usr/bin/env node

/**
 * Offline, fail-closed freezer for the Walmart ITEM reissue v2 evidence sealer.
 *
 * This builder has no Walmart, credential, database, model, or network client. It
 * bundles the already-reviewed frozen sealer, records every esbuild input byte,
 * pins the exact Node executable, and atomically publishes a private read-only
 * engine directory outside the project tree.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build as esbuildBuild, version as esbuildVersion } from "esbuild";

export const WALMART_ITEM_REPORT_REISSUE_V2_FROZEN_ENGINE_SCHEMA =
  "walmart-item-report-reissue-v2-frozen-engine/1.0.0";
export const WALMART_ITEM_REPORT_REISSUE_V2_ENGINE_FREEZE_POLICY =
  "walmart-item-report-reissue-v2-engine-freeze-policy/1.0.0";
export const WALMART_ITEM_REPORT_REISSUE_V2_ENGINE_FREEZE_REPORT_SCHEMA =
  "walmart-item-report-reissue-v2-engine-freeze-report/1.0.0";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const ENTRYPOINT_RELATIVE_PATH =
  "scripts/walmart-item-report-reissue-v2-frozen-sealer.mjs";
const BUNDLE_FILE_NAME =
  "walmart-item-report-reissue-v2-frozen-sealer.bundle.mjs";
const MANIFEST_FILE_NAME = "engine-release.json";
const REPORT_FILE_NAME = "freeze-report.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const EXACT_FROZEN_ARGV_ORDER = Object.freeze([
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

const CERTIFICATION_FILE_SPEC = Object.freeze([
  ["FREEZER_BUILDER", "scripts/freeze-walmart-item-report-reissue-v2-engine.mjs"],
  ["FREEZER_TEST", "scripts/__tests__/freeze-walmart-item-report-reissue-v2-engine.test.mjs"],
  ["FROZEN_SEALER", "scripts/walmart-item-report-reissue-v2-frozen-sealer.mjs"],
  ["FROZEN_SEALER_TEST", "scripts/__tests__/walmart-item-report-reissue-v2-frozen-sealer.test.mjs"],
  ["OWNER_DISPOSITION_MODULE", "src/lib/walmart/item-report-reissue-owner-disposition-v2.ts"],
  ["OWNER_DISPOSITION_TEST", "src/lib/walmart/__tests__/item-report-reissue-owner-disposition-v2.test.mjs"],
  ["ABSENCE_PROBE_EVIDENCE_MODULE", "src/lib/walmart/item-report-reissue-absence-probe-evidence.ts"],
  ["ABSENCE_PROBE_EVIDENCE_TEST", "scripts/__tests__/capture-walmart-item-v6-absence-probe.test.mjs"],
  ["SOURCE_EVIDENCE_MODULE", "src/lib/walmart/item-report-reissue-source-evidence-v2.ts"],
  ["SOURCE_EVIDENCE_TEST", "src/lib/walmart/__tests__/item-report-reissue-source-evidence-v2.test.mjs"],
  ["SOURCE_EVIDENCE_RENEWAL_MODULE", "src/lib/walmart/item-report-reissue-source-evidence-renewal-v1.ts"],
  ["SOURCE_EVIDENCE_RENEWAL_TEST", "src/lib/walmart/__tests__/item-report-reissue-source-evidence-renewal-v1.test.mjs"],
].sort(([leftRole, leftPath], [rightRole, rightPath]) => (
  codeUnitCompare(leftRole, rightRole) || codeUnitCompare(leftPath, rightPath)
)));

const ESBUILD_OPTIONS_MANIFEST = Object.freeze({
  tool: "esbuild",
  esbuild_version: esbuildVersion,
  bundle: true,
  packages: "bundle",
  platform: "node",
  format: "esm",
  sourcemap: false,
  metafile: true,
  write: false,
  legal_comments: "none",
  charset: "utf8",
  // Retain the complete owner-disposition verifier, not only the trust-root
  // inspection function currently called by the evidence-seal command.
  tree_shaking: false,
  external_policy: "NODE_BUILTINS_ONLY",
});

const KNOWN_IMPORT_KINDS = new Set([
  "entry-point",
  "import-statement",
  "dynamic-import",
  "require-call",
  "require-resolve",
  "import-rule",
  "url-token",
]);

function freezeError(message) {
  const error = new Error(message);
  error.code = "WALMART_ITEM_REPORT_REISSUE_V2_ENGINE_FREEZE_ERROR";
  return error;
}

function fail(message) {
  throw freezeError(message);
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalWalmartItemReportReissueV2EngineJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (
      canonicalWalmartItemReportReissueV2EngineJson(entry)
    )).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const fields = [];
    for (const key of Object.keys(value).sort(codeUnitCompare)) {
      const fieldValue = value[key];
      if (fieldValue === undefined || typeof fieldValue === "function"
        || typeof fieldValue === "symbol" || typeof fieldValue === "bigint") {
        fail(`canonical JSON rejects non-JSON field ${key}`);
      }
      fields.push(`${JSON.stringify(key)}:${
        canonicalWalmartItemReportReissueV2EngineJson(fieldValue)}`);
    }
    return `{${fields.join(",")}}`;
  }
  fail("canonical JSON rejects unsupported values");
}

function canonicalArraySha256(value) {
  return sha256(Buffer.from(
    canonicalWalmartItemReportReissueV2EngineJson(value),
    "utf8",
  ));
}

function jsonBytes(value) {
  return Buffer.from(canonicalWalmartItemReportReissueV2EngineJson(value), "utf8");
}

function sidecarBytes(digest, fileName) {
  if (!SHA256_PATTERN.test(digest)) fail("invalid internal SHA-256 sidecar digest");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(fileName)) {
    fail("invalid internal sidecar file name");
  }
  return Buffer.from(`${digest}  ${fileName}\n`, "utf8");
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

function exactAbsolutePath(value, label) {
  if (typeof value !== "string" || !value || value !== value.trim()
    || !path.isAbsolute(value) || path.normalize(value) !== value
    || value.includes("\0")) {
    fail(`${label} must be an exact normalized absolute path`);
  }
  return normalizeDarwinAlias(value);
}

function canonicalProjectRelative(value, label) {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.includes("\\") || value.includes("\0")
    || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || value === "." || value.startsWith("../")) {
    fail(`${label} must be a canonical project-relative path`);
  }
  return value;
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

function sameStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readStableRealFile(absolutePath, label, options = {}) {
  const before = await lstat(absolutePath, { bigint: true }).catch(() => {
    fail(`${label} is missing`);
  });
  if (!before.isFile() || before.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  if (options.single_link !== false && before.nlink !== 1n) {
    fail(`${label} must have exactly one hard link`);
  }
  if (await realpath(absolutePath) !== absolutePath) {
    fail(`${label} must have a fully real, non-symlink path`);
  }
  const handle = await open(
    absolutePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStat(before, opened)) fail(`${label} raced before read`);
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(absolutePath, { bigint: true });
    if (!sameStat(opened, afterHandle) || !sameStat(afterHandle, afterPath)
      || BigInt(bytes.byteLength) !== afterHandle.size) {
      fail(`${label} raced during read`);
    }
    return { bytes, stat: afterHandle };
  } finally {
    await handle.close();
  }
}

async function readStableProjectFile(projectRoot, relativePath, label) {
  const relative = canonicalProjectRelative(relativePath, label);
  const absolute = path.resolve(projectRoot, ...relative.split("/"));
  if (!isInside(absolute, projectRoot) || absolute === projectRoot) {
    fail(`${label} escapes the project root`);
  }
  return readStableRealFile(absolute, label);
}

function exactRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function validateImportRecord(importRecord, location, knownInputs, externals) {
  const value = exactRecord(importRecord, `${location} import`);
  if (typeof value.path !== "string" || !value.path) {
    fail(`${location} contains an import without a path`);
  }
  if (!KNOWN_IMPORT_KINDS.has(value.kind)) {
    fail(`${location} contains unknown import kind ${String(value.kind)}`);
  }
  const importPath = value.path;
  if (importPath.includes("\0") || importPath.includes("\\")
    || path.posix.isAbsolute(importPath) || importPath.startsWith("file:")
    || importPath.startsWith("#")) {
    fail(`${location} contains a forbidden absolute/file/# import: ${importPath}`);
  }
  if (value.external === true) {
    if (!/^node:[a-z0-9_./-]+$/u.test(importPath)) {
      fail(`${location} contains a non-node external import: ${importPath}`);
    }
    externals.add(importPath);
    return;
  }
  if (importPath.startsWith("node:") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(importPath)) {
    fail(`${location} contains an unresolved or unknown import: ${importPath}`);
  }
  const canonical = canonicalProjectRelative(importPath, `${location} resolved import`);
  if (!knownInputs.has(canonical)) {
    fail(`${location} resolved import is absent from metafile inputs: ${canonical}`);
  }
}

/**
 * Validate the complete esbuild metafile. This export intentionally permits
 * synthetic negative tests without allowing a different production entrypoint.
 */
export function validateWalmartItemReportReissueV2EngineMetafile(
  metafile,
  expectedOutputName = BUNDLE_FILE_NAME,
  expectedEntrypoint = ENTRYPOINT_RELATIVE_PATH,
) {
  const meta = exactRecord(metafile, "esbuild metafile");
  const inputs = exactRecord(meta.inputs, "esbuild metafile.inputs");
  const outputs = exactRecord(meta.outputs, "esbuild metafile.outputs");
  const inputNames = Object.keys(inputs).sort(codeUnitCompare);
  if (inputNames.length === 0) fail("esbuild metafile has no inputs");
  const knownInputs = new Set();
  for (const inputName of inputNames) {
    knownInputs.add(canonicalProjectRelative(inputName, "esbuild input path"));
  }
  const entrypoint = canonicalProjectRelative(
    expectedEntrypoint,
    "expected esbuild entrypoint",
  );
  if (!knownInputs.has(entrypoint)) {
    fail("esbuild metafile is missing the expected frozen entrypoint");
  }
  const externalRuntimeImports = new Set();
  for (const inputName of inputNames) {
    const input = exactRecord(inputs[inputName], `esbuild input ${inputName}`);
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) {
      fail(`esbuild input ${inputName} has invalid byte length`);
    }
    if (!Array.isArray(input.imports)) fail(`esbuild input ${inputName} has invalid imports`);
    for (const importRecord of input.imports) {
      validateImportRecord(importRecord, `esbuild input ${inputName}`, knownInputs, externalRuntimeImports);
    }
  }
  const outputNames = Object.keys(outputs);
  if (outputNames.length !== 1 || outputNames[0] !== expectedOutputName) {
    fail(`esbuild metafile output must be exactly ${expectedOutputName}`);
  }
  const output = exactRecord(outputs[expectedOutputName], "esbuild bundle output");
  if (!Array.isArray(output.imports)) fail("esbuild bundle output has invalid imports");
  for (const importRecord of output.imports) {
    validateImportRecord(importRecord, "esbuild bundle output", knownInputs, externalRuntimeImports);
  }
  if (output.entryPoint !== entrypoint) {
    fail("esbuild output entryPoint does not match the expected frozen entrypoint");
  }
  return Object.freeze({
    input_names: Object.freeze(inputNames),
    external_runtime_imports: Object.freeze(
      [...externalRuntimeImports].sort(codeUnitCompare),
    ),
  });
}

async function oneEsbuild(projectRoot, contract) {
  const result = await esbuildBuild({
    absWorkingDir: projectRoot,
    entryPoints: [contract.entrypoint_relative_path],
    outfile: contract.bundle_file_name,
    bundle: true,
    packages: "bundle",
    platform: "node",
    format: "esm",
    sourcemap: false,
    metafile: true,
    write: false,
    legalComments: "none",
    charset: "utf8",
    treeShaking: false,
    logLevel: "silent",
  });
  if (!result.metafile || result.outputFiles?.length !== 1
    || result.outputFiles[0].path !== path.join(projectRoot, contract.bundle_file_name)) {
    fail("esbuild did not produce the exact single in-memory bundle");
  }
  const validation = validateWalmartItemReportReissueV2EngineMetafile(
    result.metafile,
    contract.bundle_file_name,
    contract.entrypoint_relative_path,
  );
  return {
    bundle_bytes: Buffer.from(result.outputFiles[0].contents),
    metafile: result.metafile,
    validation,
  };
}

async function collectSourceInputs(projectRoot, buildResult) {
  const rows = [];
  for (const relativePath of buildResult.validation.input_names) {
    const artifact = await readStableProjectFile(
      projectRoot,
      relativePath,
      `esbuild input ${relativePath}`,
    );
    const expectedBytes = buildResult.metafile.inputs[relativePath].bytes;
    if (artifact.bytes.byteLength !== expectedBytes) {
      fail(`esbuild input byte length drifted: ${relativePath}`);
    }
    rows.push({
      relative_path: relativePath,
      byte_length: artifact.bytes.byteLength,
      sha256: sha256(artifact.bytes),
    });
  }
  return rows;
}

async function collectCertificationFiles(projectRoot, certificationFileSpec) {
  const rows = [];
  for (const [role, relativePath] of certificationFileSpec) {
    const artifact = await readStableProjectFile(
      projectRoot,
      relativePath,
      `certification file ${role}`,
    );
    rows.push({
      role,
      relative_path: relativePath,
      byte_length: artifact.bytes.byteLength,
      sha256: sha256(artifact.bytes),
    });
  }
  return rows;
}

function exactJsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function inspectPrivateOutput(outputDirectory, projectRoot) {
  const output = exactAbsolutePath(outputDirectory, "--out");
  const parent = path.dirname(output);
  if (output === parent) fail("--out cannot be a filesystem root");
  const parentStat = await lstat(parent, { bigint: true }).catch(() => {
    fail("--out parent must already exist");
  });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    fail("--out parent must be a real directory");
  }
  const parentReal = await realpath(parent);
  if (parentReal !== parent) fail("--out parent must not use symlinks");
  if ((Number(parentStat.mode) & 0o777) !== 0o700) {
    fail("--out parent must have exact private mode 0700");
  }
  if (typeof process.getuid === "function" && parentStat.uid !== BigInt(process.getuid())) {
    fail("--out parent must be owned by the current user");
  }
  if (isInside(parentReal, projectRoot) || isInside(projectRoot, parentReal)) {
    fail("--out parent must be disjoint from and outside the project root");
  }
  const existing = await lstat(output).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) fail("--out must not already exist");
  return {
    output,
    parent,
    parent_anchor: {
      dev: parentStat.dev,
      ino: parentStat.ino,
      mode: parentStat.mode,
      uid: parentStat.uid,
      gid: parentStat.gid,
    },
  };
}

async function verifyParentIdentity(output, expected, includeLinkCount, label) {
  const current = await lstat(output.parent, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink()
    || await realpath(output.parent) !== output.parent
    || current.dev !== expected.dev || current.ino !== expected.ino
    || current.mode !== expected.mode || current.uid !== expected.uid
    || current.gid !== expected.gid
    || (includeLinkCount && current.nlink !== expected.nlink)) {
    fail(`--out parent identity drifted ${label}`);
  }
  return current;
}

async function assertOutputStillAbsent(output, label) {
  const existing = await lstat(output.output).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) fail(`--out appeared ${label}`);
}

async function writeExactFile(directory, fileName, bytes) {
  const target = path.join(directory, fileName);
  const handle = await open(target, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(target, 0o400);
  const verified = await readStableRealFile(target, `published ${fileName}`);
  if (!verified.bytes.equals(bytes) || (Number(verified.stat.mode) & 0o777) !== 0o400) {
    fail(`published ${fileName} failed byte/mode verification`);
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertFrozenBuildEnvironment() {
  if (process.execArgv.length !== 0) {
    fail("freezer requires process.execArgv to be exactly empty");
  }
  for (const name of ["NODE_OPTIONS", "NODE_PATH"]) {
    if (Object.prototype.hasOwnProperty.call(process.env, name)) {
      fail(`${name} must be absent from the freezer environment`);
    }
  }
}

export function parseWalmartItemReportReissueV2EngineFreezeCli(argv) {
  if (!Array.isArray(argv) || argv[0] !== "freeze" || argv.length !== 2
    || typeof argv[1] !== "string" || !argv[1].startsWith("--out=")
    || argv[1].slice("--out=".length).length === 0) {
    fail("usage: freeze --out=/absolute/new-private-engine-directory");
  }
  return Object.freeze({
    command: "freeze",
    output_directory: exactAbsolutePath(argv[1].slice("--out=".length), "--out"),
  });
}

/** Build and atomically publish one immutable frozen engine. */
export async function freezeWalmartItemReportReissueV2Engine(input) {
  return freezeWalmartItemReportReissueV2EngineWithContract(input, {
    entrypoint_relative_path: ENTRYPOINT_RELATIVE_PATH,
    bundle_file_name: BUNDLE_FILE_NAME,
    command: "evidence-seal",
    exact_argv_order: EXACT_FROZEN_ARGV_ORDER,
    certification_file_spec: CERTIFICATION_FILE_SPEC,
    staging_prefix: ".walmart-item-report-reissue-v2-engine-freeze-",
  });
}

/** Shared hardened primitive used by separately certified v2 frozen entrypoints. */
export async function freezeWalmartItemReportReissueV2EngineWithContract(input, rawContract) {
  assertFrozenBuildEnvironment();
  const suppliedContract = exactRecord(rawContract, "freeze contract");
  const entrypointRelativePath = canonicalProjectRelative(
    suppliedContract.entrypoint_relative_path,
    "freeze contract entrypoint",
  );
  if (typeof suppliedContract.bundle_file_name !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(suppliedContract.bundle_file_name)) {
    fail("freeze contract bundle file name is invalid");
  }
  if (typeof suppliedContract.command !== "string" || !suppliedContract.command) {
    fail("freeze contract command is invalid");
  }
  if (!Array.isArray(suppliedContract.exact_argv_order)
    || suppliedContract.exact_argv_order[0] !== suppliedContract.command
    || !suppliedContract.exact_argv_order.every((value) => typeof value === "string" && value)) {
    fail("freeze contract argv order is invalid");
  }
  if (!Array.isArray(suppliedContract.certification_file_spec)
    || suppliedContract.certification_file_spec.length === 0) {
    fail("freeze contract certification file spec is invalid");
  }
  const certificationFileSpec = suppliedContract.certification_file_spec.map((row) => {
    if (!Array.isArray(row) || row.length !== 2
      || typeof row[0] !== "string" || !/^[A-Z][A-Z0-9_]*$/u.test(row[0])) {
      fail("freeze contract certification row is invalid");
    }
    return [row[0], canonicalProjectRelative(row[1], `certification ${row[0]}`)];
  }).sort(([leftRole, leftPath], [rightRole, rightPath]) => (
    codeUnitCompare(leftRole, rightRole) || codeUnitCompare(leftPath, rightPath)
  ));
  if (new Set(certificationFileSpec.map(([role]) => role)).size
    !== certificationFileSpec.length) {
    fail("freeze contract certification roles must be unique");
  }
  if (typeof suppliedContract.staging_prefix !== "string"
    || !/^\.[A-Za-z0-9][A-Za-z0-9._-]*-$/u.test(suppliedContract.staging_prefix)) {
    fail("freeze contract staging prefix is invalid");
  }
  let captureBinding = null;
  if (suppliedContract.capture_binding !== undefined) {
    const rawCapture = exactRecord(suppliedContract.capture_binding, "freeze capture binding");
    const actualKeys = Object.keys(rawCapture).sort(codeUnitCompare);
    const expectedKeys = [
      "canonical_root", "canonical_root_realpath_sha256", "continuation_entrypoint",
      "continuation_phases", "request_phase_retired_outside_this_executor",
    ].sort(codeUnitCompare);
    if (!exactJsonEqual(actualKeys, expectedKeys)) {
      fail("freeze capture binding has missing or extra fields");
    }
    const canonicalRoot = exactAbsolutePath(rawCapture.canonical_root, "canonical capture root");
    if (typeof rawCapture.canonical_root_realpath_sha256 !== "string"
      || !SHA256_PATTERN.test(rawCapture.canonical_root_realpath_sha256)
      || rawCapture.canonical_root_realpath_sha256
        !== sha256(Buffer.from(canonicalRoot, "utf8"))
      || rawCapture.continuation_entrypoint
        !== "scripts/capture-walmart-item-report-source.mjs"
      || !exactJsonEqual(rawCapture.continuation_phases, ["poll", "download", "compile"])
      || rawCapture.request_phase_retired_outside_this_executor !== true) {
      fail("freeze capture binding is invalid");
    }
    captureBinding = Object.freeze({
      canonical_root: canonicalRoot,
      canonical_root_realpath_sha256: rawCapture.canonical_root_realpath_sha256,
      continuation_entrypoint: rawCapture.continuation_entrypoint,
      continuation_phases: Object.freeze([...rawCapture.continuation_phases]),
      request_phase_retired_outside_this_executor: true,
    });
  }
  const contract = Object.freeze({
    entrypoint_relative_path: entrypointRelativePath,
    bundle_file_name: suppliedContract.bundle_file_name,
    command: suppliedContract.command,
    exact_argv_order: Object.freeze([...suppliedContract.exact_argv_order]),
    staging_prefix: suppliedContract.staging_prefix,
  });
  const projectRoot = await realpath(
    exactAbsolutePath(input?.project_root ?? DEFAULT_PROJECT_ROOT, "project root"),
  );
  if (projectRoot !== exactAbsolutePath(
    input?.project_root ?? DEFAULT_PROJECT_ROOT,
    "project root",
  )) {
    fail("project root must be an exact real path without symlinks");
  }
  const output = await inspectPrivateOutput(input?.output_directory, projectRoot);

  const nodeExecPath = await realpath(process.execPath);
  const nodeBefore = await readStableRealFile(nodeExecPath, "Node executable", {
    single_link: false,
  });
  const certificationBefore = await collectCertificationFiles(projectRoot, certificationFileSpec);
  const firstBuild = await oneEsbuild(projectRoot, contract);
  const sourceInputsBefore = await collectSourceInputs(projectRoot, firstBuild);

  const secondBuild = await oneEsbuild(projectRoot, contract);
  const sourceInputsAfter = await collectSourceInputs(projectRoot, secondBuild);
  const certificationAfter = await collectCertificationFiles(projectRoot, certificationFileSpec);
  const nodeAfter = await readStableRealFile(nodeExecPath, "Node executable", {
    single_link: false,
  });

  if (!firstBuild.bundle_bytes.equals(secondBuild.bundle_bytes)
    || !exactJsonEqual(firstBuild.metafile, secondBuild.metafile)
    || !exactJsonEqual(sourceInputsBefore, sourceInputsAfter)
    || !exactJsonEqual(certificationBefore, certificationAfter)
    || !nodeBefore.bytes.equals(nodeAfter.bytes)
    || !exactJsonEqual(
      firstBuild.validation.external_runtime_imports,
      secondBuild.validation.external_runtime_imports,
    )) {
    fail("source, build graph, bundle, certification, or Node executable drifted during freeze");
  }

  const bundleSha256 = sha256(firstBuild.bundle_bytes);
  const manifest = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_V2_FROZEN_ENGINE_SCHEMA,
    policy_id: WALMART_ITEM_REPORT_REISSUE_V2_ENGINE_FREEZE_POLICY,
    project_root_realpath_sha256: sha256(Buffer.from(projectRoot, "utf8")),
    bundle: {
      file_name: contract.bundle_file_name,
      byte_length: firstBuild.bundle_bytes.byteLength,
      sha256: bundleSha256,
    },
    runtime: {
      node_version: process.version,
      exec_path_realpath_sha256: sha256(Buffer.from(nodeExecPath, "utf8")),
      exec_path_artifact_sha256: sha256(nodeBefore.bytes),
      platform: process.platform,
      arch: process.arch,
      required_exec_argv: [],
      node_options_required: "ABSENT",
      node_path_required: "ABSENT",
    },
    build: { ...ESBUILD_OPTIONS_MANIFEST },
    entrypoint: {
      source_relative_path: contract.entrypoint_relative_path,
      bundle_file_name: contract.bundle_file_name,
      command: contract.command,
      argument_style: "--name=value",
      exact_argv_order: [...contract.exact_argv_order],
    },
    source_inputs: sourceInputsBefore,
    source_inputs_sha256: canonicalArraySha256(sourceInputsBefore),
    certification_files: certificationBefore,
    certification_files_sha256: canonicalArraySha256(certificationBefore),
    external_runtime_imports: [...firstBuild.validation.external_runtime_imports],
    ...(captureBinding === null ? {} : { capture: captureBinding }),
  };
  const manifestBytes = jsonBytes(manifest);
  const manifestSha256 = sha256(manifestBytes);
  const report = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_V2_ENGINE_FREEZE_REPORT_SCHEMA,
    status: "FROZEN_OFFLINE_ENGINE",
    atomic_publish: true,
    final_directory_mode: "0500",
    file_mode: "0400",
    network_calls: 0,
    database_calls: 0,
    model_calls: 0,
    walmart_calls: 0,
    bundle: {
      file_name: contract.bundle_file_name,
      byte_length: firstBuild.bundle_bytes.byteLength,
      sha256: bundleSha256,
    },
    engine_manifest: {
      file_name: MANIFEST_FILE_NAME,
      byte_length: manifestBytes.byteLength,
      sha256: manifestSha256,
    },
  };
  const reportBytes = jsonBytes(report);
  const reportSha256 = sha256(reportBytes);

  let stagingDirectory = null;
  try {
    stagingDirectory = await mkdtemp(
      path.join(output.parent, contract.staging_prefix),
    );
    await chmod(stagingDirectory, 0o700);
    await verifyParentIdentity(output, output.parent_anchor, false, "after staging creation");
    const publishParentStat = await lstat(output.parent, { bigint: true });
    const publishParentIdentity = {
      dev: publishParentStat.dev,
      ino: publishParentStat.ino,
      mode: publishParentStat.mode,
      uid: publishParentStat.uid,
      gid: publishParentStat.gid,
      nlink: publishParentStat.nlink,
    };
    await writeExactFile(stagingDirectory, contract.bundle_file_name, firstBuild.bundle_bytes);
    await writeExactFile(
      stagingDirectory,
      `${contract.bundle_file_name}.sha256`,
      sidecarBytes(bundleSha256, contract.bundle_file_name),
    );
    await writeExactFile(stagingDirectory, MANIFEST_FILE_NAME, manifestBytes);
    await writeExactFile(
      stagingDirectory,
      `${MANIFEST_FILE_NAME}.sha256`,
      sidecarBytes(manifestSha256, MANIFEST_FILE_NAME),
    );
    await writeExactFile(stagingDirectory, REPORT_FILE_NAME, reportBytes);
    await writeExactFile(
      stagingDirectory,
      `${REPORT_FILE_NAME}.sha256`,
      sidecarBytes(reportSha256, REPORT_FILE_NAME),
    );
    await syncDirectory(stagingDirectory);
    await chmod(stagingDirectory, 0o500);
    await verifyParentIdentity(output, publishParentIdentity, true, "before atomic publish");
    await assertOutputStillAbsent(output, "before atomic publish");
    await rename(stagingDirectory, output.output);
    stagingDirectory = null;
    await verifyParentIdentity(output, publishParentIdentity, true, "after atomic publish");
    const finalDirectory = await lstat(output.output, { bigint: true });
    if (!finalDirectory.isDirectory() || finalDirectory.isSymbolicLink()
      || (Number(finalDirectory.mode) & 0o777) !== 0o500
      || await realpath(output.output) !== output.output) {
      fail("atomically published engine directory failed final identity/mode verification");
    }
    await syncDirectory(output.parent);
  } catch (error) {
    if (stagingDirectory) {
      await chmod(stagingDirectory, 0o700).catch(() => {});
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }

  return Object.freeze({
    output_directory: output.output,
    bundle_sha256: bundleSha256,
    engine_manifest_sha256: manifestSha256,
    freeze_report_sha256: reportSha256,
    manifest,
    report,
  });
}

async function main() {
  const parsed = parseWalmartItemReportReissueV2EngineFreezeCli(process.argv.slice(2));
  const result = await freezeWalmartItemReportReissueV2Engine({
    output_directory: parsed.output_directory,
  });
  process.stdout.write(`${JSON.stringify({
    status: result.report.status,
    output_directory: result.output_directory,
    bundle_sha256: result.bundle_sha256,
    engine_manifest_sha256: result.engine_manifest_sha256,
    freeze_report_sha256: result.freeze_report_sha256,
  })}\n`);
}

const invokedPath = process.argv[1]
  ? await realpath(path.resolve(process.argv[1])).catch(() => null)
  : null;
if (invokedPath === await realpath(SCRIPT_PATH)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
