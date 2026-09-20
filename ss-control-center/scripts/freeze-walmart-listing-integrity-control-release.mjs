#!/usr/bin/env node

/** Build and certify a minimal frozen supervisor release from one clean snapshot. */

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access, chmod, copyFile, lstat, mkdir, open, readFile, realpath, symlink,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_SCHEMA = "walmart-listing-integrity-control-frozen-release/v1";
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/gu;

const RUNTIME_ENTRYPOINTS = Object.freeze([
  "ops/codex-image-worker/vision-contract.js",
  "scripts/verify-and-run-walmart-listing-integrity-control.mjs",
  "scripts/walmart-listing-integrity-successor-worker.ts",
  "scripts/walmart-listing-integrity-catalog.mjs",
  "scripts/walmart-listing-integrity-control-worker.ts",
  "scripts/walmart-listing-integrity-control-seed.ts",
  "scripts/build-walmart-listing-integrity-controlled-pool.ts",
  "scripts/walmart-listing-integrity-process.ts",
  "scripts/walmart-listing-repair-owner-package.ts",
  "scripts/build-walmart-listing-main-candidate.ts",
  "scripts/build-walmart-listing-main-compilation-request.ts",
  "scripts/build-walmart-listing-image-set-candidate.ts",
  "scripts/verify-walmart-listing-image-set-candidate.ts",
  "scripts/curate-walmart-listing-image-set-candidate.ts",
  "scripts/build-walmart-listing-image-set-repair-preview.ts",
  "scripts/build-walmart-listing-integrity-live-gallery.mjs",
  "scripts/build-walmart-listing-image-set-compilation-request.ts",
  "scripts/build-walmart-listing-attribute-compilation-request.ts",
  "scripts/build-walmart-listing-variant-group-evidence.ts",
  "scripts/build-walmart-listing-text-review-candidate.ts",
  "scripts/build-walmart-listing-non-image-repair-candidate.ts",
  "scripts/capture-walmart-listing-integrity-terminal-failure.ts",
  "scripts/stage-walmart-listing-main-candidate-r2.ts",
  "scripts/verify-walmart-listing-main-candidate.ts",
]);

const TS_TESTS = Object.freeze([
  "scripts/__tests__/verify-and-run-walmart-listing-integrity-control.test.mjs",
  "scripts/__tests__/walmart-listing-repair-operator.test.ts",
  "scripts/__tests__/verify-and-run-walmart-listing-repair.test.mjs",
  "src/lib/walmart/__tests__/listing-integrity-remediation-artifacts.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-qualification.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-live-qualification.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-ledger-adapter.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-transport.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-payload.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-variant-group-evidence.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-closed-loop.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-image-certificate.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-apply-evidence.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-apply-evidence-adapter.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-writer.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-owner-compiler.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-owner-material-capture.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-reviewed-main-certificate.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-reviewed-image-set-certificate.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-unchanged-image-certificate.test.ts",
  "src/lib/walmart/__tests__/catalog-visual-audit-rounding.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-single-pipeline.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-monitor-lifecycle.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-terminal-failure.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-global-admission.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-main-failure-disposition.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-operations.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-operations.server.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-routes.test.ts",
  "scripts/__tests__/walmart-listing-integrity-control-seed.test.ts",
  "scripts/__tests__/walmart-listing-integrity-control-worker.test.ts",
  "scripts/__tests__/walmart-listing-integrity-successor-worker.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-control-installer.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-control-plane-stage-a.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-control-plane.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-control-run-completion.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-control-seed.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-control-store.server.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-control-transition-store.server.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-control-worker.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-control-writer.server.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-diagnosis-process-adapter.server.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-frozen-operator-worker.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-frozen-process-adapter.server.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-frozen-work-order.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-operator-admission.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-process-adapter.server.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-remediation-route.test.ts",
  "src/lib/walmart/__tests__/listing-integrity-runtime-authority.test.ts",
]);

const NATIVE_E2E = "scripts/__tests__/walmart-listing-integrity-production-e2e.test.mjs";
const CATALOG_NATIVE =
  "src/lib/walmart/__tests__/listing-integrity-catalog-orchestrator.test.mjs";
const LEDGER_TEST = "src/lib/walmart/__tests__/listing-integrity-remediation-ledger.test.mjs";
const LINT_ENTRYPOINTS = Object.freeze([
  "scripts/verify-and-run-walmart-listing-integrity-control.mjs",
  "scripts/freeze-walmart-listing-integrity-control-release.mjs",
  "scripts/walmart-listing-integrity-successor-worker.ts",
  "scripts/walmart-listing-integrity-catalog.mjs",
  "scripts/walmart-listing-integrity-control-worker.ts",
  "scripts/walmart-listing-integrity-control-seed.ts",
  "scripts/__tests__/walmart-listing-integrity-control-worker.test.ts",
  "scripts/__tests__/walmart-listing-integrity-successor-worker.test.ts",
  "scripts/__tests__/verify-and-run-walmart-listing-integrity-control.test.mjs",
  "src/lib/walmart/listing-integrity-production-cycle.server.ts",
  "src/lib/walmart/listing-integrity-control-run-completion.ts",
  "src/lib/walmart/listing-integrity-control-writer.server.ts",
  "src/lib/walmart/listing-integrity-main-failure-disposition.ts",
  "src/lib/walmart/listing-integrity-production-diagnosis.server.ts",
  "src/lib/walmart/listing-integrity-diagnosis-process-adapter.server.ts",
  "src/lib/walmart/listing-integrity-production-remediation.server.ts",
  "scripts/build-walmart-listing-non-image-repair-candidate.ts",
  "src/lib/walmart/listing-integrity-single-clean-qualification.server.ts",
]);

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonical(value[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("NON_CANONICAL", "undefined is forbidden");
  return encoded;
}

function parseArgs(argv) {
  const allowed = new Set([
    "root", "out", "created-at", "workspace-root", "node-modules-root",
    "writer-manifest", "writer-manifest-sha256",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith("--") || token.includes("=") || !value || value.startsWith("--")) {
      fail("INVALID_CLI", "flags must be exact --name value pairs");
    }
    const key = token.slice(2);
    if (!allowed.has(key) || values.has(key)) fail("INVALID_CLI", `forbidden flag ${token}`);
    values.set(key, value);
  }
  if (values.size !== allowed.size || [...allowed].some((key) => !values.has(key))) {
    fail("INVALID_CLI", "all release bindings are required");
  }
  const absolute = (key) => {
    const value = values.get(key);
    if (!path.isAbsolute(value) || path.resolve(value) !== value) {
      fail("INVALID_CLI", `--${key} must be absolute and normalized`);
    }
    return value;
  };
  const createdAt = values.get("created-at");
  if (new Date(createdAt).toISOString() !== createdAt) {
    fail("INVALID_CLI", "--created-at must be canonical ISO-8601");
  }
  const writerSha = values.get("writer-manifest-sha256");
  if (!/^[a-f0-9]{64}$/u.test(writerSha)) fail("INVALID_CLI", "writer SHA is invalid");
  return {
    root: absolute("root"), out: absolute("out"), created_at: createdAt,
    workspace_root: absolute("workspace-root"),
    node_modules_root: absolute("node-modules-root"),
    writer_manifest: absolute("writer-manifest"), writer_manifest_sha256: writerSha,
  };
}

async function safeFile(root, relative) {
  const absolute = path.join(root, relative);
  if (!absolute.startsWith(`${root}${path.sep}`)) fail("PATH_ESCAPE", relative);
  const metadata = await lstat(absolute).catch(() => fail("MISSING_FILE", relative));
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || await realpath(absolute) !== absolute) fail("UNSAFE_FILE", relative);
  return { absolute, metadata, bytes: await readFile(absolute) };
}

async function resolveImport(root, importer, specifier) {
  const base = specifier.startsWith("@/")
    ? path.resolve(root, "src", specifier.slice(2))
    : specifier.startsWith(".") ? path.resolve(root, path.dirname(importer), specifier) : null;
  if (!base) return null;
  const candidates = /\.(?:ts|tsx|mjs|js)$/u.test(base)
    ? [base] : [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, path.join(base, "index.ts")];
  for (const candidate of candidates) {
    if (!candidate.startsWith(`${root}${path.sep}`)) fail("PATH_ESCAPE", specifier);
    try {
      await access(candidate, fsConstants.R_OK);
      if ((await lstat(candidate)).isFile()) {
        return path.relative(root, candidate).split(path.sep).join("/");
      }
    } catch {
      // Try the next exact candidate.
    }
  }
  fail("UNRESOLVED_IMPORT", `${importer} -> ${specifier}`);
}

async function dependencyClosure(root, entries) {
  const pending = [...entries];
  const found = new Set();
  while (pending.length) {
    const relative = pending.pop();
    if (found.has(relative)) continue;
    const { bytes } = await safeFile(root, relative);
    found.add(relative);
    const source = new TextDecoder("utf8", { fatal: true }).decode(bytes);
    IMPORT_PATTERN.lastIndex = 0;
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const resolved = await resolveImport(root, relative, match[1]);
      if (resolved && !found.has(resolved)) pending.push(resolved);
    }
  }
  return [...found].sort();
}

function run(root, name, command, args, expectedTests = null) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const bytes = Buffer.from(
    `command=${JSON.stringify([command, ...args])}\nexit=${String(result.status)}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
  );
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(-4_000);
    fail("CERTIFICATION_FAILED", `${name} failed: ${detail}`);
  }
  const testMatch = (result.stdout ?? "").match(/(?:^|\n)[ℹ#]\s+tests\s+(\d+)(?:\n|$)/u);
  if (expectedTests !== null && Number(testMatch?.[1]) !== expectedTests) {
    fail("CERTIFICATION_COUNT_MISMATCH", `${name} expected ${expectedTests}`);
  }
  return { name, command: [command, ...args], bytes, tests: expectedTests };
}

async function writePrivate(file, bytes) {
  const handle = await open(file, "wx", 0o400);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function build(argv = process.argv.slice(2)) {
  const input = parseArgs(argv);
  if (await realpath(input.root) !== input.root || git(input.root, ["status", "--porcelain"]) !== "") {
    fail("DIRTY_CHECKOUT", "release root must be one clean canonical Git snapshot");
  }
  if (await realpath(input.workspace_root) !== input.workspace_root
    || await realpath(input.node_modules_root) !== input.node_modules_root) {
    fail("INVALID_BINDING", "workspace or node_modules binding is not canonical");
  }
  const writerBytes = await readFile(input.writer_manifest);
  if (sha256(writerBytes) !== input.writer_manifest_sha256) {
    fail("WRITER_RELEASE_MISMATCH", "V50 manifest differs");
  }
  const writer = JSON.parse(writerBytes.toString("utf8"));
  const runtimePaths = await dependencyClosure(input.root, RUNTIME_ENTRYPOINTS);
  const testPaths = await dependencyClosure(
    input.root,
    [...TS_TESTS, NATIVE_E2E, CATALOG_NATIVE, LEDGER_TEST],
  );
  const allPaths = [...new Set([
    ...runtimePaths, ...testPaths, ...LINT_ENTRYPOINTS,
    "package.json", "package-lock.json", "tsconfig.json", "eslint.config.mjs",
    "scripts/freeze-walmart-listing-integrity-control-release.mjs",
  ])].sort();
  const logs = [
    run(input.root, "tsx-production-suite", process.execPath, ["--import", "tsx", "--test", ...TS_TESTS], 301),
    run(input.root, "native-production-e2e", process.execPath, ["--experimental-strip-types", "--test", NATIVE_E2E], 1),
    run(input.root, "catalog-native-suite", process.execPath, [
      "--experimental-strip-types", "--test", CATALOG_NATIVE,
    ], 7),
    run(input.root, "ledger-suite", process.execPath, ["--import", "tsx", "--test", LEDGER_TEST], 17),
    run(input.root, "full-typescript", "npx", ["tsc", "-p", "tsconfig.json", "--noEmit"]),
    run(input.root, "targeted-eslint", process.execPath, ["node_modules/eslint/bin/eslint.js", ...LINT_ENTRYPOINTS]),
    run(input.root, "git-diff-check", "git", ["diff", "--check"]),
  ];
  await mkdir(input.out, { mode: 0o700 });
  const engineRoot = path.join(input.out, "engine", "ss-control-center");
  await mkdir(engineRoot, { recursive: true, mode: 0o700 });
  const inventory = [];
  for (const relative of allPaths) {
    const source = await safeFile(input.root, relative);
    const destination = path.join(engineRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source.absolute, destination, fsConstants.COPYFILE_EXCL);
    await chmod(destination, 0o400);
    inventory.push({ path: relative, byte_length: source.bytes.byteLength, sha256: sha256(source.bytes) });
  }
  await symlink(input.node_modules_root, path.join(engineRoot, "node_modules"), "dir");
  // Catalog inputs are deliberately not pinned into the release. The frozen
  // successor creates a new immutable read-only census at each pool boundary
  // and accepts it only when it exactly reconciles with a fresh DOWNLOADED
  // ITEM_CATALOG report. Static catalog pins would silently age while the
  // release kept running.
  const pinnedInputs = [];
  const releaseId = sha256(Buffer.from(canonical({
    schema_version: "walmart-listing-integrity-control-runtime/v1",
    runtime_entrypoints: RUNTIME_ENTRYPOINTS,
    runtime_files: inventory.filter((row) => runtimePaths.includes(row.path)),
    writer_release_id_sha256: writer.release_id_sha256,
    pinned_inputs: pinnedInputs,
  }), "utf8"));
  const logRows = [];
  for (const log of logs) {
    const filename = `${log.name}.log`;
    await writePrivate(path.join(input.out, filename), log.bytes);
    logRows.push({ name: log.name, filename, sha256: sha256(log.bytes), byte_length: log.bytes.byteLength, exit_code: 0, tests: log.tests });
  }
  const body = {
    schema_version: MANIFEST_SCHEMA,
    created_at: input.created_at,
    release_id_sha256: releaseId,
    git: { commit: git(input.root, ["rev-parse", "HEAD"]), tree: git(input.root, ["rev-parse", "HEAD^{tree}"]), clean_checkout: true },
    runtime: {
      entrypoints: RUNTIME_ENTRYPOINTS,
      runtime_closure_file_count: runtimePaths.length,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      node_modules_realpath: input.node_modules_root,
      automatic_retry_allowed: false,
      automatic_replay_allowed: false,
      max_audits_per_run: 10,
      marketplace_write_calls_per_active_sku_maximum: 1,
    },
    writer_release: {
      release_id_sha256: writer.release_id_sha256,
      manifest_path: input.writer_manifest,
      manifest_sha256: input.writer_manifest_sha256,
    },
    workspace: {
      root_path_sha256: sha256(input.workspace_root),
      pinned_inputs: pinnedInputs,
      dynamic_catalog_contract:
        "fresh exact ITEM_CATALOG report mirror; max report age 24h; max snapshot age 15m",
      completed_root_relative_path: "data/audits/walmart-listing-integrity-post-canary",
      quarantine_root_relative_path: "data/audits/walmart-listing-integrity-quarantine",
    },
    certification: { expected_test_count: 326, logs: logRows },
    source_inventory: inventory,
    owner_gate: { one_sku_continuous_policy_enrolled: true, mass_run_authorized: false },
  };
  const manifest = { ...body, body_sha256: sha256(Buffer.from(canonical(body), "utf8")) };
  const manifestBytes = Buffer.from(`${canonical(manifest)}\n`, "utf8");
  await writePrivate(path.join(input.out, "release-manifest.json"), manifestBytes);
  await writePrivate(path.join(input.out, "release-manifest.sha256"), Buffer.from(
    `${sha256(manifestBytes)}  release-manifest.json\n`,
  ));
  process.stdout.write(`${JSON.stringify({
    status: "CONTROL_RELEASE_CERTIFIED",
    release_id_sha256: releaseId,
    manifest_sha256: sha256(manifestBytes),
    runtime_file_count: runtimePaths.length,
    source_file_count: inventory.length,
    test_count: 326,
    output_root: input.out,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  build().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { build, dependencyClosure, parseArgs };
