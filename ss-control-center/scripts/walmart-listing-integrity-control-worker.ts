#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadWalmartListingIntegrityControlRunSnapshot,
} from "../src/lib/walmart/listing-integrity-control-store.server.ts";
import {
  invokeWalmartListingIntegrityFrozenPreflightProcess,
  type WalmartListingIntegrityFrozenProcessConfig,
} from "../src/lib/walmart/listing-integrity-frozen-process-adapter.server.ts";
import {
  runWalmartListingIntegrityProductionCycleOnce,
} from "../src/lib/walmart/listing-integrity-production-cycle.server.ts";
import {
  runWalmartListingIntegrityProductionDiagnosisOnce,
} from "../src/lib/walmart/listing-integrity-production-diagnosis.server.ts";
import {
  runWalmartListingIntegrityProductionRemediationOnce,
} from "../src/lib/walmart/listing-integrity-production-remediation.server.ts";

const RELEASE_DIRECTORY = "walmart-listing-repair-engine-2026-08-01-v50";
const RELEASE_ID = "729f5cc081663b97d09b483dcda5226117dff07a094e978f0774e6c1eeebdd6c";
const MANIFEST_SHA = "65f6fff8599a8001a5a3b1dfcdaca149aae2f0456c90cc41a6b164a6ec953aff";
const PRODUCT_TRUTH_MANIFEST_SHA =
  "94359db196ec3bc73c964edce7a88df56e5e1942fc0ba9824670034609e9062c";
const GLOBAL_ADMISSION_IDENTITY_SHA =
  "971d12097b154220d0818a03af8d78679aac26bf42a024ac654e7f4256232650";
const GLOBAL_ADMISSION_ROOT =
  "/Users/vladimirkuznetsov/.ss-command-center-owner/walmart/listing-integrity-global-admission-v1";
const MAX_PERMIT_BYTES = 16 * 1024 * 1024;

type WorkerCommand = "doctor" | "audit-once" | "prepare-once" | "once";

export interface WalmartListingIntegrityControlWorkerArgs {
  command: WorkerCommand;
  permit_path: string | null;
  permit_file_sha256: string | null;
  package_path: string | null;
  package_sha256: string | null;
  custody_root: string | null;
}

export interface WalmartListingIntegrityControlRuntimeRoots {
  workspace_root: string;
  engine_root: string;
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function absolute(value: string | undefined, label: string): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value || value.includes("\u0000")) {
    fail("CONTROL_WORKER_CLI_INVALID", `${label} must be an absolute normalized path`);
  }
  return value;
}

function sha(value: string | undefined, label: string): string {
  if (!value || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("CONTROL_WORKER_CLI_INVALID", `${label} must be lowercase SHA-256`);
  }
  return value;
}

export function parseWalmartListingIntegrityControlWorkerArgs(
  argv: readonly string[],
): WalmartListingIntegrityControlWorkerArgs {
  const command = argv[0];
  if (command !== "doctor" && command !== "audit-once"
    && command !== "prepare-once" && command !== "once") {
    fail(
      "CONTROL_WORKER_CLI_INVALID",
      "command must be doctor, audit-once, prepare-once, or once",
    );
  }
  const allowed = command === "doctor"
    ? new Set<string>()
    : command === "audit-once" || command === "prepare-once"
      ? new Set(["custody-root"])
    : new Set(["permit", "permit-file-sha256", "package", "package-sha256", "custody-root"]);
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token || !token.startsWith("--") || token.includes("=")
      || !value || value.startsWith("--")) {
      fail("CONTROL_WORKER_CLI_INVALID", "flags must be exact --name value pairs");
    }
    const key = token.slice(2);
    if (!allowed.has(key) || values.has(key)) {
      fail("CONTROL_WORKER_CLI_INVALID", `flag --${key} is forbidden or repeated`);
    }
    values.set(key, value);
  }
  if (values.size !== allowed.size || [...allowed].some((key) => !values.has(key))) {
    fail("CONTROL_WORKER_CLI_INVALID", "required flags are missing");
  }
  return {
    command,
    permit_path: command === "once" ? absolute(values.get("permit"), "--permit") : null,
    permit_file_sha256: command === "once"
      ? sha(values.get("permit-file-sha256"), "--permit-file-sha256") : null,
    package_path: command === "once" ? absolute(values.get("package"), "--package") : null,
    package_sha256: command === "once"
      ? sha(values.get("package-sha256"), "--package-sha256") : null,
    custody_root: command === "once" || command === "audit-once" || command === "prepare-once"
      ? absolute(values.get("custody-root"), "--custody-root") : null,
  };
}

export function walmartListingIntegrityControlWorkerProcessConfig(
  cwd = process.cwd(),
): WalmartListingIntegrityFrozenProcessConfig {
  const root = resolve(cwd);
  const releaseRoot = resolve(root, "../release-artifacts", RELEASE_DIRECTORY);
  return Object.freeze({
    node_path: process.execPath,
    env_file: resolve(root, ".env"),
    engine_root: resolve(releaseRoot, "engine/ss-control-center"),
    manifest_path: resolve(releaseRoot, "release-manifest.json"),
    manifest_sha256: MANIFEST_SHA,
    release_id_sha256: RELEASE_ID,
    global_admission_root: GLOBAL_ADMISSION_ROOT,
    global_admission_identity_sha256: GLOBAL_ADMISSION_IDENTITY_SHA,
  });
}

export function walmartListingIntegrityDiagnosisProcessConfig(
  workspaceRoot = process.cwd(),
  engineRoot = workspaceRoot,
) {
  const workspace = resolve(workspaceRoot);
  const engine = resolve(engineRoot);
  return Object.freeze({
    node_path: process.execPath,
    env_file: resolve(workspace, ".env"),
    engine_root: engine,
    product_truth_manifest_sha256: PRODUCT_TRUTH_MANIFEST_SHA,
  });
}

export function walmartListingIntegrityRemediationConfig(
  workspaceRoot = process.cwd(),
  engineRoot = workspaceRoot,
) {
  const workspace = resolve(workspaceRoot);
  const engine = resolve(engineRoot);
  const releaseRoot = resolve(workspace, "../release-artifacts", RELEASE_DIRECTORY);
  return Object.freeze({
    process: Object.freeze({
      node_path: process.execPath,
      env_file: resolve(workspace, ".env"),
      workspace_engine_root: engine,
      frozen_engine_root: resolve(releaseRoot, "engine/ss-control-center"),
    }),
    owner_private_key_path:
      "/Users/vladimirkuznetsov/.ss-command-center-owner/walmart/listing-integrity-service-private-key-v1.pem",
    owner_package_custody_root:
      "/Users/vladimirkuznetsov/.ss-command-center-owner/walmart",
    frozen_release_id_sha256: RELEASE_ID,
    approved_by: "owner-policy:walmart-listing-integrity-continuous-one-sku",
    defer_image_repairs: true,
  });
}

async function readExactPrivateJson(path: string, expectedSha: string): Promise<unknown> {
  const stat = await lstat(path).catch(() => fail(
    "CONTROL_WORKER_PERMIT_INVALID",
    "permit artifact does not exist",
  ));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (stat.mode & 0o077) !== 0 || stat.size < 2 || stat.size > MAX_PERMIT_BYTES
    || await realpath(path) !== path) {
    fail("CONTROL_WORKER_PERMIT_INVALID", "permit must be one private canonical file");
  }
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha) {
    fail("CONTROL_WORKER_PERMIT_INVALID", "permit file SHA differs");
  }
  try {
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch {
    return fail("CONTROL_WORKER_PERMIT_INVALID", "permit is not UTF-8 JSON");
  }
}

export async function runWalmartListingIntegrityControlWorker(
  args: WalmartListingIntegrityControlWorkerArgs,
  runtime: WalmartListingIntegrityControlRuntimeRoots = {
    workspace_root: process.cwd(),
    engine_root: process.cwd(),
  },
) {
  const workspaceRoot = resolve(runtime.workspace_root);
  const engineRoot = resolve(runtime.engine_root);
  const config = walmartListingIntegrityControlWorkerProcessConfig(workspaceRoot);
  if (args.command === "doctor") {
    const [snapshot, frozenDoctorBytes] = await Promise.all([
      loadWalmartListingIntegrityControlRunSnapshot(),
      invokeWalmartListingIntegrityFrozenPreflightProcess({
        config,
        operator_args: ["doctor"],
      }),
    ]);
    return {
      schema_version: "walmart-listing-integrity-control-worker-doctor/v1",
      status: snapshot.installation === "INSTALLED" && snapshot.run?.status === "ACTIVE"
        ? "READY_FOR_EXACT_PERMIT" : "DEFAULT_OFF",
      evaluated_at: new Date().toISOString(),
      control: {
        installation: snapshot.installation,
        runtime_policy_stage: snapshot.runtime_policy_stage,
        run_id: snapshot.run?.run_id ?? null,
        run_status: snapshot.run?.status ?? null,
        active_sku: snapshot.run?.items.find((item) => ![
          "AUDITED_PASS",
          "QUALIFIED_PASS",
          "QUARANTINED_SOURCE_REQUIRED",
          "QUARANTINED_UNRESOLVED",
        ].includes(item.state))?.identity.sku ?? null,
      },
      frozen_doctor: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(frozenDoctorBytes)),
      marketplace_write_authorized: false,
      walmart_writes: 0,
      next_command: snapshot.installation === "INSTALLED" && snapshot.run?.status === "ACTIVE"
        ? ["QUEUED", "DIAGNOSING"].includes(snapshot.run.items.find((item) => ![
          "AUDITED_PASS",
          "QUALIFIED_PASS",
          "QUARANTINED_SOURCE_REQUIRED",
          "QUARANTINED_UNRESOLVED",
        ].includes(item.state))?.state ?? "")
          ? "audit-once --custody-root <ABS>"
          : snapshot.run.items.find((item) => ![
            "AUDITED_PASS",
            "QUALIFIED_PASS",
            "QUARANTINED_SOURCE_REQUIRED",
            "QUARANTINED_UNRESOLVED",
          ].includes(item.state))?.state === "ISSUE_PROVEN"
            ? "prepare-once --custody-root <ABS>"
            : "exact next stage inputs required"
        : null,
    };
  }
  if (args.command === "audit-once") {
    return runWalmartListingIntegrityProductionDiagnosisOnce({
      custody_root: args.custody_root!,
      process_config: walmartListingIntegrityDiagnosisProcessConfig(
        workspaceRoot,
        engineRoot,
      ),
    });
  }
  if (args.command === "prepare-once") {
    return runWalmartListingIntegrityProductionRemediationOnce({
      custody_root: args.custody_root!,
      config: walmartListingIntegrityRemediationConfig(workspaceRoot, engineRoot),
    });
  }
  const permit = await readExactPrivateJson(
    args.permit_path!,
    args.permit_file_sha256!,
  );
  return runWalmartListingIntegrityProductionCycleOnce({
    owner_permit: permit,
    execution_package_path: args.package_path!,
    execution_package_sha256: args.package_sha256!,
    custody_root: args.custody_root!,
    process_config: config,
    reporting_process_config: walmartListingIntegrityRemediationConfig(
      workspaceRoot,
      engineRoot,
    ).process,
  });
}

async function main() {
  const args = parseWalmartListingIntegrityControlWorkerArgs(process.argv.slice(2));
  const result = await runWalmartListingIntegrityControlWorker(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      schema_version: "walmart-listing-integrity-control-worker-error/v1",
      status: "ERROR",
      message: error instanceof Error ? error.message : String(error),
      automatic_retry_allowed: false,
      automatic_replay_allowed: false,
    })}\n`);
    process.exitCode = 1;
  });
}
