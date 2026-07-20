import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const TEST_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(TEST_PATH), "../..");
const FREEZER_PATH = path.join(
  PROJECT_ROOT,
  "scripts/freeze-walmart-item-report-reissue-v2-engine.mjs",
);
const EVIDENCE_ROOT = path.join(
  PROJECT_ROOT,
  "data/audits/walmart-source-intake/item-v6-disposition-probe-store1-20260719-claude-v1",
);
const CAPTURE_ROOT = path.join(PROJECT_ROOT, "data/audits/walmart-source-captures");
const BUNDLE_NAME = "walmart-item-report-reissue-v2-frozen-sealer.bundle.mjs";

let suiteRoot;
let frozenEngine;
let bundlePath;
let manifestPath;
let bundleSha256;
let manifestSha256;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function cleanNodeEnv() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
}

async function makeWritable(directory) {
  await chmod(directory, 0o700).catch(() => {});
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeWritable(target);
    else await chmod(target, 0o600).catch(() => {});
  }
}

function exactArgs(output, overrides = {}) {
  return [
    "evidence-seal",
    `--engine-manifest=${manifestPath}`,
    `--expect-engine-manifest-sha256=${overrides.manifestSha256 ?? manifestSha256}`,
    `--expect-frozen-bundle-sha256=${overrides.bundleSha256 ?? bundleSha256}`,
    `--project-root=${PROJECT_ROOT}`,
    `--evidence-root=${EVIDENCE_ROOT}`,
    `--capture-root=${CAPTURE_ROOT}`,
    "--prior-session-name=item-v6-store1-20260718-codex-v1",
    "--release-id=walmart-item-v6-reissue-source-evidence-store1-20260719-v2",
    "--reviewed-at=2026-07-19T23:26:39.000Z",
    `--out=${output}`,
  ];
}

async function runSealer(args, nodeFlags = []) {
  return execFile(
    process.execPath,
    [...nodeFlags, bundlePath, ...args],
    {
      cwd: PROJECT_ROOT,
      env: cleanNodeEnv(),
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

async function expectFailure(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.match(`${error.stderr ?? ""}\n${error.message ?? ""}`, pattern);
    return true;
  });
}

test.before(async () => {
  suiteRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "walmart-v2-frozen-sealer-")));
  await chmod(suiteRoot, 0o700);
  frozenEngine = path.join(suiteRoot, "frozen-engine");
  await execFile(
    process.execPath,
    [FREEZER_PATH, "freeze", `--out=${frozenEngine}`],
    {
      cwd: PROJECT_ROOT,
      env: cleanNodeEnv(),
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  bundlePath = path.join(frozenEngine, BUNDLE_NAME);
  manifestPath = path.join(frozenEngine, "engine-release.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  bundleSha256 = manifest.bundle.sha256;
  manifestSha256 = sha256(manifestBytes);
}, { timeout: 120_000 });

test.after(async () => {
  if (!suiteRoot) return;
  await makeWritable(suiteRoot);
  await rm(suiteRoot, { recursive: true, force: true });
});

test("frozen sealer rejects output inside the evidence root before writing", async () => {
  const forbiddenOutput = path.join(EVIDENCE_ROOT, "frozen-sealer-must-not-create");
  await expectFailure(
    runSealer(exactArgs(forbiddenOutput)),
    /ancestry-disjoint from evidence root/,
  );
  await assert.rejects(lstat(forbiddenOutput), /ENOENT/);
});

test("frozen sealer rejects externally pinned bundle or manifest hash drift", async () => {
  const output = path.join(suiteRoot, "bundle-hash-drift-output");
  await expectFailure(
    runSealer(exactArgs(output, { bundleSha256: "0".repeat(64) })),
    /frozen bundle SHA-256 mismatch/,
  );
  await assert.rejects(lstat(output), /ENOENT/);
  const manifestOutput = path.join(suiteRoot, "manifest-hash-drift-output");
  await expectFailure(
    runSealer(exactArgs(manifestOutput, { manifestSha256: "0".repeat(64) })),
    /engine manifest SHA-256 mismatch/,
  );
  await assert.rejects(lstat(manifestOutput), /ENOENT/);
});

test("frozen sealer rejects non-empty Node runtime flags", async () => {
  const output = path.join(suiteRoot, "runtime-flags-output");
  await expectFailure(
    runSealer(exactArgs(output), ["--no-warnings"]),
    /process\.execArgv must be empty/,
  );
  await assert.rejects(lstat(output), /ENOENT/);
});

test("frozen sealer publishes the benign evidence seal atomically and privately", async () => {
  const output = path.join(suiteRoot, "benign-seal");
  const { stdout } = await runSealer(exactArgs(output));
  const result = JSON.parse(stdout);
  assert.equal(result.status, "SEALED");
  assert.equal(result.engine_manifest_artifact_sha256, manifestSha256);
  assert.equal(result.frozen_bundle_artifact_sha256, bundleSha256);
  assert.equal(result.production_owner_trust_root_ready, false);
  assert.equal(result.live_report_create_path_enabled, false);
  assert.equal(result.network_calls, 0);
  assert.equal(Number((await lstat(output)).mode) & 0o777, 0o700);

  const expected = [
    "engine-release.json",
    "engine-release.json.sha256",
    "seal-report.json",
    "seal-report.json.sha256",
    "source-evidence-release.json",
    "source-evidence-release.json.sha256",
  ].sort();
  assert.deepEqual((await readdir(output)).sort(), expected);
  for (const fileName of expected) {
    const info = await lstat(path.join(output, fileName));
    assert.equal(info.isFile(), true);
    assert.equal(info.nlink, 1);
    assert.equal(info.mode & 0o777, 0o400);
  }
  assert.deepEqual(
    await readFile(path.join(output, "engine-release.json")),
    await readFile(manifestPath),
  );
  const report = JSON.parse(await readFile(path.join(output, "seal-report.json"), "utf8"));
  assert.equal(report.output_safety.ancestry_disjoint, true);
  assert.equal(report.output_safety.stable_parent_identity, true);
  assert.equal(report.runtime.node_version, process.version);
  assert.equal(report.runtime.exec_argv.length, 0);
  assert.equal(report.bundled_contracts.production_owner_trust_root.ready, false);
  assert.equal(report.external_effects.network_calls, 0);
  assert.equal(report.external_effects.credential_reads, 0);
}, { timeout: 120_000 });
