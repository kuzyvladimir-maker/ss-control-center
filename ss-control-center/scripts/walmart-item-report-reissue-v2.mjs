#!/usr/bin/env -S node --experimental-strip-types

/**
 * Owner/Codex-only offline tooling for Walmart ITEM reissue v2.
 *
 * This entrypoint intentionally has no credentials, fetch, DB, model, or
 * marketplace mutation imports.  The Claude operator receives no executable
 * POST command until a dedicated production owner key and one-shot ledger are
 * separately certified.
 */

import { createHash, randomUUID } from "node:crypto";
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
import ts from "typescript";

import {
  buildWalmartItemReportReissueSourceEvidenceV2,
  serializeWalmartItemReportReissueSourceEvidenceV2,
} from "../src/lib/walmart/item-report-reissue-source-evidence-v2.ts";
import {
  inspectWalmartItemReportReissueOwnerDispositionV2TrustRoot,
} from "../src/lib/walmart/item-report-reissue-owner-disposition-v2.ts";
import { canonicalWalmartItemReportJson } from "../src/lib/walmart/item-report-published-source.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const ENGINE_ENTRYPOINTS = Object.freeze([
  "scripts/walmart-item-report-reissue-v2.mjs",
  "src/lib/walmart/item-report-reissue-owner-disposition-v2.ts",
  "src/lib/walmart/item-report-reissue-source-evidence-v2.ts",
]);
const ENGINE_CONTROL_FILES = Object.freeze(["package.json", "package-lock.json"]);
const ENGINE_DEPENDENCY_POLICY =
  "typescript-ast/all-static-local-imports-including-type-and-dynamic-literals/v1";
export const WALMART_ITEM_REPORT_REISSUE_V2_IN_PROCESS_SEAL_RETIRED = true;

function fail(message) {
  const error = new Error(message);
  error.code = "WALMART_ITEM_REPORT_REISSUE_V2_CLI_ERROR";
  throw error;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parse(argv) {
  const command = argv[0] ?? "help";
  const values = new Map();
  for (const argument of argv.slice(1)) {
    if (!argument.startsWith("--") || !argument.includes("=")) {
      fail("arguments must use exact --name=value form");
    }
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (!name || !value || values.has(name)) fail("CLI argument is empty or repeated");
    values.set(name, value);
  }
  return { command, values };
}

function exactAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)
    || path.normalize(value) !== value || value !== value.trim()) {
    fail(`${label} must be an exact normalized absolute path`);
  }
  if (process.platform === "darwin") {
    for (const [alias, canonical] of [["/var", "/private/var"], ["/tmp", "/private/tmp"]]) {
      if (value === alias || value.startsWith(`${alias}/`)) {
        return `${canonical}${value.slice(alias.length)}`;
      }
    }
  }
  return value;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) fail(`--${name}=... is required`);
  return value;
}

function exactOptions(values, allowed) {
  for (const name of values.keys()) {
    if (!allowed.includes(name)) fail(`unsupported option --${name}`);
  }
}

function canonicalProjectRelative(relativePath, label = "project-relative path") {
  if (typeof relativePath !== "string" || relativePath.length === 0
    || relativePath !== relativePath.trim() || relativePath.includes("\\")
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath === "." || relativePath.startsWith("../")
    || path.posix.isAbsolute(relativePath)) {
    fail(`${label} is not canonical`);
  }
  return relativePath;
}

function projectAbsolute(projectRoot, relativePath) {
  const exactRelative = canonicalProjectRelative(relativePath);
  const absolute = path.resolve(projectRoot, ...exactRelative.split("/"));
  const back = path.relative(projectRoot, absolute);
  if (!back || back.startsWith(`..${path.sep}`) || back === ".." || path.isAbsolute(back)) {
    fail("engine dependency escapes or aliases the project root");
  }
  return absolute;
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

async function readStableProjectFile(projectRoot, relativePath) {
  const absolute = projectAbsolute(projectRoot, relativePath);
  const before = await lstat(absolute, { bigint: true }).catch(() => {
    fail(`engine dependency is missing: ${relativePath}`);
  });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    fail(`engine dependency must be a single-link regular file: ${relativePath}`);
  }
  if (await realpath(absolute) !== absolute) {
    fail(`engine dependency uses a symlinked path: ${relativePath}`);
  }
  const handle = await open(
    absolute,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStableFile(before, opened)) fail(`engine dependency raced before read: ${relativePath}`);
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(absolute, { bigint: true });
    if (!sameStableFile(opened, afterHandle) || !sameStableFile(afterHandle, afterPath)
      || BigInt(bytes.byteLength) !== afterHandle.size) {
      fail(`engine dependency raced during read: ${relativePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function moduleSpecifiers(sourceText, relativePath) {
  const scriptKind = relativePath.endsWith(".ts") || relativePath.endsWith(".mts")
    ? ts.ScriptKind.TS
    : ts.ScriptKind.JS;
  const source = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  if (source.parseDiagnostics?.length) {
    fail(`engine dependency has TypeScript parse diagnostics: ${relativePath}`);
  }
  const found = new Set();
  const addLiteral = (value, label) => {
    if (!ts.isStringLiteralLike(value) || value.text.length === 0) {
      fail(`${label} must use one exact string-literal module specifier in ${relativePath}`);
    }
    found.add(value.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) addLiteral(node.moduleSpecifier, "static import/export");
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) {
      addLiteral(node.moduleReference.expression, "import-equals");
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length !== 1) {
        fail(`dynamic import must have one literal argument in ${relativePath}`);
      }
      addLiteral(node.arguments[0], "dynamic import");
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === "require") {
      if (node.arguments.length !== 1) {
        fail(`require must have one literal argument in ${relativePath}`);
      }
      addLiteral(node.arguments[0], "require");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const reference of source.referencedFiles ?? []) {
    if (!reference.fileName) fail(`empty triple-slash reference in ${relativePath}`);
    found.add(reference.fileName);
  }
  return [...found].sort();
}

function resolveLocalModule(projectRoot, fromRelativePath, specifier) {
  if (!specifier.startsWith(".")) return null;
  if (specifier.includes("\\") || specifier.includes("\0")) {
    fail(`noncanonical local module specifier in ${fromRelativePath}`);
  }
  const fromAbsolute = projectAbsolute(projectRoot, fromRelativePath);
  const resolved = ts.resolveModuleName(
    specifier,
    fromAbsolute,
    {
      allowImportingTsExtensions: true,
      allowJs: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      resolveJsonModule: true,
    },
    ts.sys,
  ).resolvedModule;
  if (!resolved || resolved.isExternalLibraryImport) {
    fail(`local engine dependency cannot be resolved: ${fromRelativePath} -> ${specifier}`);
  }
  const absolute = path.resolve(resolved.resolvedFileName);
  const relative = path.relative(projectRoot, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    fail(`local engine dependency escapes the project root: ${fromRelativePath} -> ${specifier}`);
  }
  return canonicalProjectRelative(relative.split(path.sep).join("/"), "resolved module path");
}

export async function collectWalmartItemReportReissueV2EngineClosure(input = {}) {
  const projectRoot = path.resolve(input.project_root ?? PROJECT_ROOT);
  if (await realpath(projectRoot) !== projectRoot) fail("engine project root must be a real path");
  const entrypoints = [...(input.entrypoints ?? ENGINE_ENTRYPOINTS)]
    .map((value) => canonicalProjectRelative(value, "engine entrypoint"))
    .sort();
  if (entrypoints.length === 0 || new Set(entrypoints).size !== entrypoints.length) {
    fail("engine entrypoints must be a non-empty unique list");
  }
  const pending = [...entrypoints];
  const seen = new Set();
  const externalImports = new Set();
  const moduleFiles = [];
  while (pending.length > 0) {
    pending.sort();
    const relativePath = pending.shift();
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    const bytes = await readStableProjectFile(projectRoot, relativePath);
    moduleFiles.push({
      path: relativePath,
      byte_length: bytes.byteLength,
      sha256: sha256(bytes),
    });
    if (!/\.(?:[cm]?[jt]s)$/.test(relativePath)) continue;
    for (const specifier of moduleSpecifiers(bytes.toString("utf8"), relativePath)) {
      const local = resolveLocalModule(projectRoot, relativePath, specifier);
      if (local) {
        if (!seen.has(local)) pending.push(local);
      } else {
        externalImports.add(specifier);
      }
    }
  }
  const controlFiles = [];
  for (const relativePath of ENGINE_CONTROL_FILES) {
    const bytes = await readStableProjectFile(projectRoot, relativePath);
    controlFiles.push({
      path: relativePath,
      byte_length: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  const files = [...moduleFiles, ...controlFiles]
    .sort((left, right) => codeUnitCompare(left.path, right.path));
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    fail("engine dependency closure contains duplicate files");
  }
  return {
    entrypoints,
    control_files: [...ENGINE_CONTROL_FILES],
    external_imports: [...externalImports].sort(),
    files,
  };
}

export async function buildWalmartItemReportReissueV2EngineRelease(input = {}) {
  const closure = await collectWalmartItemReportReissueV2EngineClosure(input);
  const filesSha256 = sha256(canonicalWalmartItemReportJson(closure.files));
  return {
    schema_version: "walmart-item-report-reissue-v2-engine-release/2.0.0",
    status: "EVIDENCE_AND_DISPOSITION_CONTRACT_ONLY",
    production_owner_trust_root_ready:
      inspectWalmartItemReportReissueOwnerDispositionV2TrustRoot().ready,
    live_report_create_path_enabled: false,
    network_calls_authorized: 0,
    dependency_closure_policy: ENGINE_DEPENDENCY_POLICY,
    entrypoints: closure.entrypoints,
    control_files: closure.control_files,
    external_imports: closure.external_imports,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      typescript: ts.version,
    },
    files: closure.files,
    files_sha256: filesSha256,
  };
}

export async function verifyWalmartItemReportReissueV2EngineRelease(
  candidate,
  input = {},
) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    fail("engine release must be an object");
  }
  const expected = await buildWalmartItemReportReissueV2EngineRelease(input);
  if (canonicalWalmartItemReportJson(candidate) !== canonicalWalmartItemReportJson(expected)) {
    fail("engine release does not exactly match the current transitive dependency closure");
  }
  return expected;
}

async function writeSyncedExclusive(filePath, bytes, mode = 0o400) {
  const handle = await open(filePath, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, mode);
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertNewOutput(output) {
  const found = await lstat(output).then(() => true).catch((error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (found) fail("--out must name a nonexistent directory");
  const parent = path.dirname(output);
  const info = await lstat(parent).catch(() => fail("--out parent must already exist"));
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== parent) {
    fail("--out parent must be a real directory without symlink aliases");
  }
  return parent;
}

async function evidenceSeal(values) {
  const allowed = [
    "capture-root", "evidence-root", "out", "prior-session-name", "release-id",
    "reviewed-at",
  ];
  exactOptions(values, allowed);
  const evidenceRoot = exactAbsolute(required(values, "evidence-root"), "--evidence-root");
  const captureRoot = exactAbsolute(required(values, "capture-root"), "--capture-root");
  const output = exactAbsolute(required(values, "out"), "--out");
  const parent = await assertNewOutput(output);
  const release = await buildWalmartItemReportReissueSourceEvidenceV2({
    evidence_root: evidenceRoot,
    capture_root: captureRoot,
    prior_session_name: required(values, "prior-session-name"),
    release_id: required(values, "release-id"),
    reviewed_at: required(values, "reviewed-at"),
  });
  const releaseBytes = serializeWalmartItemReportReissueSourceEvidenceV2(release);
  const artifactSha = sha256(releaseBytes);
  const engineRelease = await buildWalmartItemReportReissueV2EngineRelease();
  await verifyWalmartItemReportReissueV2EngineRelease(engineRelease);
  const engineReleaseBytes = Buffer.from(canonicalWalmartItemReportJson(engineRelease), "utf8");
  const engineReleaseArtifactSha = sha256(engineReleaseBytes);
  const sealReport = {
    schema_version: "walmart-item-report-reissue-v2-evidence-seal-report/1.0.0",
    source_evidence_artifact: {
      path: "source-evidence-release.json",
      byte_length: releaseBytes.byteLength,
      artifact_sha256: artifactSha,
      body_sha256: release.body_sha256,
      release_sha256: release.release_sha256,
    },
    engine_release_artifact: {
      path: "engine-release.json",
      byte_length: engineReleaseBytes.byteLength,
      artifact_sha256: engineReleaseArtifactSha,
      files_sha256: engineRelease.files_sha256,
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
  const temporary = path.join(parent, `.item-reissue-v2-${randomUUID()}.tmp`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await writeSyncedExclusive(path.join(temporary, "source-evidence-release.json"), releaseBytes);
    await writeSyncedExclusive(
      path.join(temporary, "source-evidence-release.json.sha256"),
      Buffer.from(`${artifactSha}  source-evidence-release.json\n`, "utf8"),
    );
    await writeSyncedExclusive(path.join(temporary, "engine-release.json"), engineReleaseBytes);
    await writeSyncedExclusive(
      path.join(temporary, "engine-release.json.sha256"),
      Buffer.from(`${engineReleaseArtifactSha}  engine-release.json\n`, "utf8"),
    );
    await writeSyncedExclusive(path.join(temporary, "seal-report.json"), sealReportBytes);
    await writeSyncedExclusive(
      path.join(temporary, "seal-report.json.sha256"),
      Buffer.from(`${sha256(sealReportBytes)}  seal-report.json\n`, "utf8"),
    );
    await syncDirectory(temporary);
    await rename(temporary, output);
    await syncDirectory(parent);
  } catch (error) {
    await chmod(temporary, 0o700).catch(() => {});
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    status: "SEALED",
    output,
    source_evidence_artifact_sha256: artifactSha,
    source_evidence_release_sha256: release.release_sha256,
    source_evidence_body_sha256: release.body_sha256,
    evidence_fresh_until: release.body.exact_probe.fresh_until,
    engine_release_artifact_sha256: engineReleaseArtifactSha,
    engine_files_sha256: engineRelease.files_sha256,
    production_owner_trust_root_ready: false,
    live_report_create_path_enabled: false,
  };
}

function help() {
  return {
    command: "walmart-item-report-reissue-v2",
    commands: {
      "trust-root-status": "read-only dedicated owner-key enrollment status",
    },
    retired_commands: {
      "evidence-seal": "superseded by separately frozen content-addressed sealer",
    },
    unavailable_until_owner_key_enrollment_and_execution_certification: [
      "owner-disposition-request",
      "owner-disposition-assemble",
      "execute-create",
    ],
    network_calls: 0,
  };
}

export async function runWalmartItemReportReissueV2Cli(argv) {
  const { command, values } = parse(argv);
  if (command === "help" || command === "--help") return help();
  if (command === "trust-root-status") {
    exactOptions(values, []);
    return {
      status: "READ_ONLY",
      trust_root: inspectWalmartItemReportReissueOwnerDispositionV2TrustRoot(),
      live_report_create_path_enabled: false,
      network_calls: 0,
    };
  }
  if (command === "evidence-seal") {
    if (WALMART_ITEM_REPORT_REISSUE_V2_IN_PROCESS_SEAL_RETIRED) {
      fail("in-process evidence-seal is retired; use the separately frozen content-addressed sealer");
    }
    return evidenceSeal(values);
  }
  fail("unsupported or not-yet-certified command");
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  runWalmartItemReportReissueV2Cli(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => {
      process.stderr.write(`${error?.code ?? "ERROR"}: ${error?.message ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
