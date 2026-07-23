#!/usr/bin/env node

/** Freeze/certify the clean-checkout Walmart Listing Integrity repair release. */

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_SCHEMA = "walmart-listing-repair-frozen-release/v1";
const NORMALIZED_PIN = "__WALMART_LISTING_REPAIR_RELEASE_ID__";
const RUNTIME_ENTRYPOINTS = Object.freeze([
  "scripts/verify-and-run-walmart-listing-repair.mjs",
  "scripts/walmart-listing-repair-operator.ts",
]);
const TEST_ENTRYPOINTS = Object.freeze([
  "scripts/__tests__/walmart-listing-repair-operator.test.ts",
  "scripts/__tests__/verify-and-run-walmart-listing-repair.test.mjs",
  "src/lib/walmart/__tests__/listing-integrity-remediation-ledger.test.mjs",
  "src/lib/walmart/__tests__/listing-integrity-remediation-artifacts.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-qualification.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-ledger-adapter.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-transport.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-payload.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-closed-loop.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-image-certificate.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-apply-evidence.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-apply-evidence-adapter.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-writer.test.ts",
]);
const TARGETED_LINT = Object.freeze([
  "scripts/verify-and-run-walmart-listing-repair.mjs",
  "scripts/walmart-listing-repair-operator.ts",
  "scripts/freeze-walmart-listing-repair-release.mjs",
  "scripts/__tests__/walmart-listing-repair-operator.test.ts",
  "scripts/__tests__/verify-and-run-walmart-listing-repair.test.mjs",
  "src/lib/walmart/listing-integrity-remediation-authority.ts",
  "src/lib/walmart/listing-integrity-remediation-qualification.ts",
  "src/lib/walmart/listing-integrity-remediation-writer.ts",
  "src/lib/walmart/listing-integrity-remediation-transport.ts",
  "src/lib/walmart/listing-integrity-remediation-production-dependencies.ts",
  "src/lib/walmart/listing-integrity-remediation-execution-package.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-transport.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-closed-loop.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-writer.test.ts",
]);
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/gu;

class FreezeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalmartListingRepairReleaseFreezeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new FreezeError(code, message);
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
  if (encoded === undefined) fail("NON_CANONICAL", "release manifest rejects undefined");
  return encoded;
}

function parseArgs(argv) {
  let mode = "compute-id";
  let root = process.cwd();
  let out = null;
  let createdAt = null;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!["--mode", "--root", "--out", "--created-at"].includes(token) || seen.has(token)) {
      fail("INVALID_CLI", `unsupported or repeated flag ${token}`);
    }
    seen.add(token);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail("INVALID_CLI", `${token} needs a value`);
    if (token === "--mode") mode = value;
    if (token === "--root") root = value;
    if (token === "--out") out = value;
    if (token === "--created-at") createdAt = value;
    index += 1;
  }
  if (!["compute-id", "certify"].includes(mode)) fail("INVALID_CLI", "mode must be compute-id or certify");
  root = path.resolve(root);
  if (mode === "certify" && (!out || !path.isAbsolute(out) || path.resolve(out) !== out)) {
    fail("INVALID_CLI", "certify requires absolute normalized --out");
  }
  if (mode === "certify" && (!createdAt
    || new Date(createdAt).toISOString() !== createdAt)) {
    fail("INVALID_CLI", "certify requires canonical --created-at");
  }
  return { mode, root, out, createdAt };
}

async function safeFile(root, relative) {
  const absolute = path.join(root, relative);
  if (path.relative(root, absolute).startsWith("..")) fail("PATH_ESCAPE", `path escaped: ${relative}`);
  const metadata = await lstat(absolute).catch(() => fail("MISSING_FILE", `missing ${relative}`));
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    fail("UNSAFE_FILE", `release input is not one regular file: ${relative}`);
  }
  if (await realpath(absolute) !== absolute) fail("UNSAFE_FILE", `release path is not canonical: ${relative}`);
  return { absolute, bytes: await readFile(absolute) };
}

async function resolveImport(root, importer, specifier) {
  const base = specifier.startsWith("@/")
    ? path.resolve(root, "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(root, path.dirname(importer), specifier)
      : null;
  if (!base) return null;
  const candidates = path.extname(base)
    ? [base]
    : [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, path.join(base, "index.ts")];
  for (const candidate of candidates) {
    if (path.relative(root, candidate).startsWith("..")) fail("PATH_ESCAPE", `import escaped: ${specifier}`);
    try {
      await access(candidate, fsConstants.R_OK);
      const metadata = await lstat(candidate);
      if (metadata.isFile()) return path.relative(root, candidate).split(path.sep).join("/");
    } catch {
      // Try the next exact extension candidate.
    }
  }
  fail("UNRESOLVED_IMPORT", `${importer} cannot resolve ${specifier}`);
}

async function dependencyClosure(root, entries) {
  const pending = [...entries];
  const found = new Set();
  while (pending.length) {
    const relative = pending.pop();
    if (found.has(relative)) continue;
    const { bytes } = await safeFile(root, relative);
    found.add(relative);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    IMPORT_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const resolved = await resolveImport(root, relative, match[1]);
      if (resolved && !found.has(resolved)) pending.push(resolved);
    }
  }
  return [...found].sort();
}

function normalizedRuntimeBytes(relative, bytes) {
  if (!relative.endsWith("listing-integrity-remediation-writer.ts")
    && !relative.endsWith("listing-integrity-remediation-qualification.ts")) return bytes;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const normalized = text.replace(
    /const (PINNED_PRODUCTION_(?:APPLY|VERIFIER)_ENGINE_RELEASE_SHA256):\s*string \| null\s*=\s*(?:null|"[a-f0-9]{64}");/gu,
    `const $1: string | null = "${NORMALIZED_PIN}";`,
  );
  if (normalized === text) fail("PIN_NORMALIZATION_FAILED", `release pin declaration not found in ${relative}`);
  return Buffer.from(normalized, "utf8");
}

async function inventory(root, paths) {
  const rows = [];
  for (const relative of paths) {
    const { bytes } = await safeFile(root, relative);
    rows.push({ path: relative, byte_length: bytes.byteLength, sha256: sha256(bytes) });
  }
  return rows;
}

async function releaseIdentity(root, runtimePaths) {
  const rows = [];
  for (const relative of runtimePaths) {
    const { bytes } = await safeFile(root, relative);
    const normalized = normalizedRuntimeBytes(relative, bytes);
    rows.push({
      path: relative,
      normalized_byte_length: normalized.byteLength,
      normalized_sha256: sha256(normalized),
    });
  }
  return sha256(canonicalJson({
    schema_version: "walmart-listing-repair-normalized-runtime-closure/v1",
    runtime_entrypoints: RUNTIME_ENTRYPOINTS,
    files: rows,
  }));
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function writePrivate(pathname, bytes) {
  const handle = await open(pathname, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function runCertification(root, name, command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = Buffer.from(
    `command=${JSON.stringify([command, ...args])}\nexit=${String(result.status)}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
    "utf8",
  );
  if (result.error || result.status !== 0) {
    fail("CERTIFICATION_FAILED", `${name} failed with exit ${String(result.status)}`);
  }
  return { name, command: [command, ...args], output };
}

async function certify(input, runtimePaths, allPaths, releaseId) {
  if (git(input.root, ["status", "--porcelain"]) !== "") {
    fail("DIRTY_CHECKOUT", "certification root must be a clean Git checkout");
  }
  const commit = git(input.root, ["rev-parse", "HEAD"]);
  const tree = git(input.root, ["rev-parse", "HEAD^{tree}"]);
  const outputRoot = input.out;
  await mkdir(outputRoot, { mode: 0o700 });
  const logs = [
    runCertification(input.root, "remediation-suite", process.execPath, [
      "--import", "tsx", "--test", ...TEST_ENTRYPOINTS,
    ]),
    runCertification(input.root, "targeted-eslint", process.execPath, [
      "node_modules/eslint/bin/eslint.js", ...TARGETED_LINT,
    ]),
    runCertification(input.root, "git-diff-check", "git", ["diff", "--check"]),
  ];
  const logRows = [];
  for (const log of logs) {
    const filename = `${log.name}.log`;
    await writePrivate(path.join(outputRoot, filename), log.output);
    logRows.push({
      name: log.name,
      filename,
      command: log.command,
      byte_length: log.output.byteLength,
      sha256: sha256(log.output),
      exit_code: 0,
    });
  }
  const sourceInventory = await inventory(input.root, allPaths);
  const body = {
    schema_version: MANIFEST_SCHEMA,
    created_at: input.createdAt,
    release_id_sha256: releaseId,
    git: { commit, tree, clean_checkout: true },
    runtime: {
      entrypoints: RUNTIME_ENTRYPOINTS,
      normalized_closure_file_count: runtimePaths.length,
      pinned_apply_release_matches: true,
      pinned_verifier_release_matches: true,
      caller_dependency_injection_allowed: false,
      automatic_retry_allowed: false,
      marketplace_write_calls_maximum: 1,
    },
    certification: {
      test_entrypoints: TEST_ENTRYPOINTS,
      expected_test_count: 109,
      logs: logRows,
    },
    source_inventory: sourceInventory,
    owner_gate: {
      owner_public_trust_root_enrolled: true,
      live_canary_authorized: false,
      mass_run_authorized: false,
    },
  };
  const manifest = { ...body, body_sha256: sha256(canonicalJson(body)) };
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  await writePrivate(path.join(outputRoot, "release-manifest.json"), manifestBytes);
  const shaBytes = Buffer.from(`${sha256(manifestBytes)}  release-manifest.json\n`, "utf8");
  await writePrivate(path.join(outputRoot, "release-manifest.sha256"), shaBytes);
  return {
    release_id_sha256: releaseId,
    manifest_sha256: sha256(manifestBytes),
    commit,
    tree,
    output_root: outputRoot,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const input = parseArgs(argv);
  if (await realpath(input.root) !== input.root) fail("INVALID_ROOT", "root must be canonical");
  const runtimePaths = await dependencyClosure(input.root, RUNTIME_ENTRYPOINTS);
  const testPaths = await dependencyClosure(input.root, TEST_ENTRYPOINTS);
  const allPaths = [...new Set([
    ...runtimePaths,
    ...testPaths,
    "package.json",
    "package-lock.json",
    "scripts/freeze-walmart-listing-repair-release.mjs",
  ])].sort();
  const releaseId = await releaseIdentity(input.root, runtimePaths);
  if (input.mode === "compute-id") {
    process.stdout.write(`${canonicalJson({
      schema_version: "walmart-listing-repair-release-id/v1",
      release_id_sha256: releaseId,
      runtime_file_count: runtimePaths.length,
      runtime_entrypoints: RUNTIME_ENTRYPOINTS,
    })}\n`);
    return;
  }
  const writer = await readFile(path.join(
    input.root,
    "src/lib/walmart/listing-integrity-remediation-writer.ts",
  ), "utf8");
  const qualification = await readFile(path.join(
    input.root,
    "src/lib/walmart/listing-integrity-remediation-qualification.ts",
  ), "utf8");
  for (const [label, declaration, source] of [
    ["writer", "PINNED_PRODUCTION_APPLY_ENGINE_RELEASE_SHA256", writer],
    ["qualification", "PINNED_PRODUCTION_VERIFIER_ENGINE_RELEASE_SHA256", qualification],
  ]) {
    const exactPin = new RegExp(
      `const ${declaration}:\\s*string \\| null\\s*=\\s*"${releaseId}";`,
      "u",
    );
    if (!exactPin.test(source)) {
      fail("RELEASE_PIN_MISMATCH", `${label} does not pin computed normalized release ID`);
    }
  }
  const result = await certify(input, runtimePaths, allPaths, releaseId);
  process.stdout.write(`${canonicalJson(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${canonicalJson({
      status: "ERROR",
      error_code: error instanceof FreezeError ? error.code : "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : "unknown error",
    })}\n`);
    process.exitCode = 1;
  });
}
