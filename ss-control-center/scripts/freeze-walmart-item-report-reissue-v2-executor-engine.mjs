#!/usr/bin/env node

/** Offline freezer for the one-shot ITEM v6 execute-create operator runtime. */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  freezeWalmartItemReportReissueV2EngineWithContract,
} from "./freeze-walmart-item-report-reissue-v2-engine.mjs";
import {
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_EXACT_ARGV_ORDER,
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE,
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENTRYPOINT,
} from "../src/lib/walmart/item-report-reissue-executor-v2.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DIRECTORY_MODE = 0o700;

const CERTIFICATION_FILE_SPEC = Object.freeze([
  ["CAPTURE_SESSION_TEST", "src/lib/walmart/__tests__/item-report-capture-session.test.mjs"],
  ["EXECUTOR_ENTRYPOINT", WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENTRYPOINT],
  ["EXECUTOR_ENTRYPOINT_TEST", "scripts/__tests__/walmart-item-report-reissue-v2-frozen-executor.test.mjs"],
  ["EXECUTOR_FREEZER", "scripts/freeze-walmart-item-report-reissue-v2-executor-engine.mjs"],
  ["EXECUTOR_FREEZER_TEST", "scripts/__tests__/freeze-walmart-item-report-reissue-v2-executor-engine.test.mjs"],
  ["EXECUTOR_MODULE", "src/lib/walmart/item-report-reissue-executor-v2.ts"],
  ["EXECUTOR_TEST", "src/lib/walmart/__tests__/item-report-reissue-executor-v2.test.mjs"],
  ["FREEZER_PRIMITIVE", "scripts/freeze-walmart-item-report-reissue-v2-engine.mjs"],
  ["FREEZER_PRIMITIVE_TEST", "scripts/__tests__/freeze-walmart-item-report-reissue-v2-engine.test.mjs"],
  ["LEDGER_MODULE", "src/lib/walmart/item-report-reissue-consumption-ledger-v2.ts"],
  ["LEDGER_TEST", "src/lib/walmart/__tests__/item-report-reissue-consumption-ledger-v2.test.mjs"],
  ["OWNER_DISPOSITION_MODULE", "src/lib/walmart/item-report-reissue-owner-disposition-v2.ts"],
  ["OWNER_DISPOSITION_TEST", "src/lib/walmart/__tests__/item-report-reissue-owner-disposition-v2.test.mjs"],
  ["SOURCE_EVIDENCE_MODULE", "src/lib/walmart/item-report-reissue-source-evidence-v2.ts"],
  ["SOURCE_EVIDENCE_TEST", "src/lib/walmart/__tests__/item-report-reissue-source-evidence-v2.test.mjs"],
]);

function fail(message) {
  const error = new Error(message);
  error.code = "WALMART_ITEM_REPORT_REISSUE_V2_EXECUTOR_FREEZE_ERROR";
  throw error;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
    fail(`${label} must be an exact normalized absolute path`);
  }
  return normalizeDarwinAlias(value);
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function inspectCanonicalCaptureRoot(rawPath) {
  const captureRoot = exactAbsolute(rawPath, "--capture-root");
  const before = await lstat(captureRoot, { bigint: true }).catch(() => {
    fail("--capture-root does not exist");
  });
  if (!before.isDirectory() || before.isSymbolicLink()
    || Number(before.mode & 0o777n) !== DIRECTORY_MODE
    || await realpath(captureRoot).catch(() => null) !== captureRoot
    || (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))) {
    fail("--capture-root must be an exact current-user real 0700 directory");
  }
  if (captureRoot === PROJECT_ROOT || captureRoot.startsWith(`${PROJECT_ROOT}${path.sep}`) === false) {
    fail("--capture-root must be the canonical capture directory inside the source project");
  }
  const expected = path.join(PROJECT_ROOT, "data/audits/walmart-source-captures");
  if (captureRoot !== expected) {
    fail("--capture-root must equal the canonical Walmart source-capture root");
  }
  const handle = await open(
    captureRoot,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(captureRoot, { bigint: true });
    if (!sameStat(before, opened) || !sameStat(opened, after)) {
      fail("--capture-root identity raced during freeze preflight");
    }
  } finally {
    await handle.close();
  }
  return captureRoot;
}

export function parseWalmartItemReportReissueV2ExecutorFreezeCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv[0] !== "freeze-executor"
    || !argv[1].startsWith("--capture-root=") || !argv[2].startsWith("--out=")) {
    fail("usage: freeze-executor --capture-root=/exact/canonical/root --out=/absolute/new/private/release");
  }
  return Object.freeze({
    capture_root: exactAbsolute(argv[1].slice("--capture-root=".length), "--capture-root"),
    output_directory: exactAbsolute(argv[2].slice("--out=".length), "--out"),
  });
}

export async function freezeWalmartItemReportReissueV2ExecutorEngine(input) {
  const captureRoot = await inspectCanonicalCaptureRoot(input?.capture_root);
  return freezeWalmartItemReportReissueV2EngineWithContract({
    project_root: PROJECT_ROOT,
    output_directory: input?.output_directory,
  }, {
    entrypoint_relative_path: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENTRYPOINT,
    bundle_file_name: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE,
    command: "execute-create",
    exact_argv_order: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_EXACT_ARGV_ORDER,
    certification_file_spec: CERTIFICATION_FILE_SPEC,
    staging_prefix: ".walmart-item-report-reissue-v2-executor-freeze-",
    capture_binding: {
      canonical_root: captureRoot,
      canonical_root_realpath_sha256: sha256(Buffer.from(captureRoot, "utf8")),
      continuation_entrypoint: "scripts/capture-walmart-item-report-source.mjs",
      continuation_phases: ["poll", "download", "compile"],
      request_phase_retired_outside_this_executor: true,
    },
  });
}

async function main() {
  const input = parseWalmartItemReportReissueV2ExecutorFreezeCli(process.argv.slice(2));
  const result = await freezeWalmartItemReportReissueV2ExecutorEngine(input);
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
