import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  parseWalmartItemReportReissueV2ExecutorFreezeCli,
} from "../freeze-walmart-item-report-reissue-v2-executor-engine.mjs";
import {
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_EXACT_ARGV_ORDER,
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE,
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENTRYPOINT,
} from "../../src/lib/walmart/item-report-reissue-executor-v2.ts";

const execFile = promisify(execFileCallback);
const TEST_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(TEST_PATH), "../..");
const FREEZER = path.join(
  PROJECT_ROOT,
  "scripts/freeze-walmart-item-report-reissue-v2-executor-engine.mjs",
);
const CAPTURE_ROOT = path.join(PROJECT_ROOT, "data/audits/walmart-source-captures");
const EXPECTED_FILES = [
  "engine-release.json",
  "engine-release.json.sha256",
  "freeze-report.json",
  "freeze-report.json.sha256",
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE,
  `${WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE}.sha256`,
].sort();

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
}

async function privateTemp(prefix) {
  const raw = await mkdtemp(path.join(os.tmpdir(), prefix));
  const exact = await realpath(raw);
  await chmod(exact, 0o700);
  return exact;
}

async function cleanup(directory) {
  const visit = async (current) => {
    await chmod(current, 0o700).catch(() => {});
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else await chmod(target, 0o600).catch(() => {});
    }
  };
  await visit(directory).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}

test("executor freezer CLI requires exact capture-root then output order", () => {
  assert.deepEqual(
    parseWalmartItemReportReissueV2ExecutorFreezeCli([
      "freeze-executor",
      `--capture-root=${CAPTURE_ROOT}`,
      "--out=/private/tmp/new-item-reissue-v2-executor",
    ]),
    {
      capture_root: CAPTURE_ROOT,
      output_directory: "/private/tmp/new-item-reissue-v2-executor",
    },
  );
  assert.throws(
    () => parseWalmartItemReportReissueV2ExecutorFreezeCli([
      "freeze-executor",
      "--out=/private/tmp/new-item-reissue-v2-executor",
      `--capture-root=${CAPTURE_ROOT}`,
    ]),
    /usage:/,
  );
});

test("actual executor freezer emits one private self-bound execute release", async (t) => {
  const parent = await privateTemp("walmart-reissue-v2-executor-freeze-");
  t.after(() => cleanup(parent));
  const output = path.join(parent, "executor-release");
  await execFile(process.execPath, [
    FREEZER,
    "freeze-executor",
    `--capture-root=${CAPTURE_ROOT}`,
    `--out=${output}`,
  ], {
    cwd: PROJECT_ROOT,
    env: cleanEnv(),
    maxBuffer: 8 * 1024 * 1024,
  });

  assert.deepEqual((await readdir(output)).sort(), EXPECTED_FILES);
  assert.equal((await stat(output)).mode & 0o777, 0o500);
  for (const name of EXPECTED_FILES) {
    assert.equal((await stat(path.join(output, name))).mode & 0o777, 0o400);
  }
  const manifestBytes = await readFile(path.join(output, "engine-release.json"));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.entrypoint.source_relative_path,
    WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENTRYPOINT);
  assert.equal(manifest.entrypoint.bundle_file_name,
    WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE);
  assert.equal(manifest.entrypoint.command, "execute-create");
  assert.deepEqual(manifest.entrypoint.exact_argv_order,
    [...WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_EXACT_ARGV_ORDER]);
  assert.equal(manifest.capture.canonical_root, CAPTURE_ROOT);
  assert.equal(
    manifest.capture.canonical_root_realpath_sha256,
    sha256(Buffer.from(CAPTURE_ROOT, "utf8")),
  );
  assert.deepEqual(manifest.capture.continuation_phases, ["poll", "download", "compile"]);
  assert.equal(manifest.capture.request_phase_retired_outside_this_executor, true);
  assert.ok(manifest.source_inputs.some(
    (row) => row.relative_path === "src/lib/walmart/item-report-reissue-executor-v2.ts",
  ));
  assert.ok(manifest.source_inputs.some(
    (row) => row.relative_path === "scripts/capture-walmart-item-report-source.mjs",
  ));
  assert.ok(manifest.certification_files.some(
    (row) => row.role === "EXECUTOR_ENTRYPOINT_TEST"
      && row.relative_path
        === "scripts/__tests__/walmart-item-report-reissue-v2-frozen-executor.test.mjs",
  ));
  assert.ok(manifest.external_runtime_imports.every((value) => value.startsWith("node:")));
  const bundleBytes = await readFile(path.join(
    output,
    WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE,
  ));
  assert.equal(manifest.bundle.sha256, sha256(bundleBytes));
  assert.equal(
    await readFile(path.join(output, "engine-release.json.sha256"), "utf8"),
    `${sha256(manifestBytes)}  engine-release.json\n`,
  );
  await execFile(process.execPath, [
    "--check",
    path.join(output, WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE),
  ], { env: cleanEnv() });

  const bundlePath = path.join(
    output,
    WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE,
  );
  const missingSource = path.join(parent, "missing-source-evidence.json");
  const missingDisposition = path.join(parent, "missing-owner-disposition.json");
  const ledgerDirectory = path.join(parent, "not-opened-ledger");
  await assert.rejects(
    execFile(process.execPath, [
      bundlePath,
      "execute-create",
      `--engine-manifest=${path.join(output, "engine-release.json")}`,
      `--expect-engine-manifest-sha256=${sha256(manifestBytes)}`,
      `--expect-frozen-bundle-sha256=${sha256(bundleBytes)}`,
      `--source-evidence=${missingSource}`,
      `--expect-source-evidence-sha256=${"0".repeat(64)}`,
      `--owner-disposition=${missingDisposition}`,
      `--expect-owner-disposition-sha256=${"1".repeat(64)}`,
      `--ledger-state-directory=${ledgerDirectory}`,
      "--store-index=1",
    ], {
      cwd: PROJECT_ROOT,
      env: cleanEnv(),
      maxBuffer: 8 * 1024 * 1024,
    }),
    (error) => {
      const line = String(error?.stderr ?? "").trim().split("\n").at(-1);
      const failure = JSON.parse(line);
      assert.equal(failure.ok, false);
      assert.equal(failure.error_code, "INVALID_ARTIFACT_CUSTODY");
      assert.notEqual(failure.error_code, "LOADED_CODE_BINDING_MISMATCH");
      return true;
    },
  );
});
