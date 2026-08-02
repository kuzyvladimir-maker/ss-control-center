import { spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

import type {
  WalmartListingIntegrityFrozenWorkerInvocation,
} from "./listing-integrity-frozen-operator-worker";

export const WALMART_LISTING_INTEGRITY_FROZEN_PROCESS_ADAPTER_SCHEMA =
  "walmart-listing-integrity-frozen-process-adapter/v1" as const;

const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 30 * 60 * 1_000;
const SHA256 = /^[a-f0-9]{64}$/u;

const REQUIRED_FLAGS = Object.freeze({
  execute: Object.freeze([
    "package",
    "package-sha256",
    "doctor-receipt",
    "doctor-receipt-sha256",
    "plan-receipt",
    "plan-receipt-sha256",
    "confirm",
  ]),
  resume: Object.freeze(["package", "package-sha256", "confirm"]),
  qualify: Object.freeze([
    "package",
    "package-sha256",
    "doctor-receipt",
    "doctor-receipt-sha256",
    "capture-dir",
  ]),
} as const);

export interface WalmartListingIntegrityFrozenProcessConfig {
  node_path: string;
  env_file: string;
  engine_root: string;
  manifest_path: string;
  manifest_sha256: string;
  release_id_sha256: string;
  global_admission_root: string;
  global_admission_identity_sha256: string;
}

export interface WalmartListingIntegrityFrozenProcessCommand {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeout_ms: typeof PROCESS_TIMEOUT_MS;
  maximum_stdout_bytes: typeof MAX_RECEIPT_BYTES;
  automatic_retry_allowed: false;
  automatic_replay_allowed: false;
}

type VerifiedProcessConfig = WalmartListingIntegrityFrozenProcessConfig;

export class WalmartListingIntegrityFrozenProcessAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "WalmartListingIntegrityFrozenProcessAdapterError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new WalmartListingIntegrityFrozenProcessAdapterError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function absolute(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value
    || value.includes("\u0000")) {
    fail("FROZEN_PROCESS_CONFIG_INVALID", `${label} must be an absolute normalized path`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("FROZEN_PROCESS_CONFIG_INVALID", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function verifiedConfig(
  input: WalmartListingIntegrityFrozenProcessConfig,
): VerifiedProcessConfig {
  return {
    node_path: absolute(input.node_path, "node_path"),
    env_file: absolute(input.env_file, "env_file"),
    engine_root: absolute(input.engine_root, "engine_root"),
    manifest_path: absolute(input.manifest_path, "manifest_path"),
    manifest_sha256: sha(input.manifest_sha256, "manifest_sha256"),
    release_id_sha256: sha(input.release_id_sha256, "release_id_sha256"),
    global_admission_root: absolute(
      input.global_admission_root,
      "global_admission_root",
    ),
    global_admission_identity_sha256: sha(
      input.global_admission_identity_sha256,
      "global_admission_identity_sha256",
    ),
  };
}

function wrapperCommand(
  config: VerifiedProcessConfig,
  operatorArgs: readonly string[],
): WalmartListingIntegrityFrozenProcessCommand {
  const wrapper = join(
    config.engine_root,
    "scripts/verify-and-run-walmart-listing-repair.mjs",
  );
  return Object.freeze({
    executable: config.node_path,
    args: Object.freeze([
      `--env-file=${config.env_file}`,
      wrapper,
      "--engine-root",
      config.engine_root,
      "--manifest",
      config.manifest_path,
      "--manifest-sha256",
      config.manifest_sha256,
      "--release-id-sha256",
      config.release_id_sha256,
      "--global-admission-root",
      config.global_admission_root,
      "--",
      ...operatorArgs,
    ]),
    cwd: config.engine_root,
    timeout_ms: PROCESS_TIMEOUT_MS,
    maximum_stdout_bytes: MAX_RECEIPT_BYTES,
    automatic_retry_allowed: false,
    automatic_replay_allowed: false,
  });
}

function operatorFlags(
  command: WalmartListingIntegrityFrozenWorkerInvocation["command"],
  args: readonly string[],
): ReadonlyMap<string, string> {
  if (args[0] !== command) {
    fail("FROZEN_PROCESS_SUFFIX_INVALID", "operator suffix command differs from worker decision");
  }
  const allowed = new Set<string>(REQUIRED_FLAGS[command]);
  const parsed = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const token = args[index];
    const value = args[index + 1];
    if (!token || !token.startsWith("--") || token.includes("=") || !value
      || value.startsWith("--") || value.includes("\u0000") || value.length > 4096) {
      fail("FROZEN_PROCESS_SUFFIX_INVALID", "operator suffix is not exact flag/value pairs");
    }
    const flag = token.slice(2);
    if (!allowed.has(flag) || parsed.has(flag)) {
      fail("FROZEN_PROCESS_SUFFIX_INVALID", `operator flag --${flag} is forbidden or repeated`);
    }
    parsed.set(flag, value);
  }
  if (parsed.size !== allowed.size
    || [...allowed].some((flag) => !parsed.has(flag))) {
    fail("FROZEN_PROCESS_SUFFIX_INVALID", "operator suffix has missing or extra flags");
  }
  return parsed;
}

export function buildWalmartListingIntegrityFrozenProcessCommand(input: {
  invocation: WalmartListingIntegrityFrozenWorkerInvocation;
  config: WalmartListingIntegrityFrozenProcessConfig;
  operator_args: readonly string[];
}): WalmartListingIntegrityFrozenProcessCommand {
  const config = verifiedConfig(input.config);
  const invocation = input.invocation;
  if (config.release_id_sha256 !== invocation.frozen_release_id_sha256
    || config.manifest_sha256 !== invocation.manifest_sha256
    || config.global_admission_identity_sha256
      !== invocation.global_admission_identity_sha256) {
    fail("FROZEN_PROCESS_RELEASE_DRIFT", "process config differs from worker release binding");
  }
  const flags = operatorFlags(invocation.command, input.operator_args);
  if (flags.get("package-sha256") !== invocation.execution_package_sha256) {
    fail("FROZEN_PROCESS_PACKAGE_DRIFT", "operator suffix differs from the exact package");
  }
  const expectedConfirm = invocation.command === "execute"
    ? `EXECUTE_ONE_WALMART_SKU:${invocation.listing_key}:${invocation.plan_body_sha256}`
    : invocation.command === "resume"
      ? `RESUME_EXACT_FEED_GET_ONLY:${invocation.owner_permit_sha256}`
      : null;
  if (expectedConfirm !== null && flags.get("confirm") !== expectedConfirm) {
    fail("FROZEN_PROCESS_CONFIRMATION_DRIFT", "operator suffix confirmation is not exact");
  }

  return wrapperCommand(config, input.operator_args);
}

export function buildWalmartListingIntegrityFrozenPreflightProcessCommand(input: {
  config: WalmartListingIntegrityFrozenProcessConfig;
  operator_args: readonly string[];
}): WalmartListingIntegrityFrozenProcessCommand {
  const config = verifiedConfig(input.config);
  const command = input.operator_args[0];
  const allowed = command === "doctor"
    ? new Set<string>()
    : command === "plan"
      ? new Set([
        "package",
        "package-sha256",
        "doctor-receipt",
        "doctor-receipt-sha256",
      ]) : null;
  if (!allowed) {
    fail("FROZEN_PREFLIGHT_SUFFIX_INVALID", "preflight admits only doctor or plan");
  }
  const parsed = new Map<string, string>();
  for (let index = 1; index < input.operator_args.length; index += 2) {
    const token = input.operator_args[index];
    const value = input.operator_args[index + 1];
    if (!token || !token.startsWith("--") || token.includes("=") || !value
      || value.startsWith("--") || value.includes("\u0000") || value.length > 4096) {
      fail("FROZEN_PREFLIGHT_SUFFIX_INVALID", "preflight suffix is not exact flag/value pairs");
    }
    const flag = token.slice(2);
    if (!allowed.has(flag) || parsed.has(flag)) {
      fail("FROZEN_PREFLIGHT_SUFFIX_INVALID", `preflight flag --${flag} is forbidden or repeated`);
    }
    parsed.set(flag, value);
  }
  if (parsed.size !== allowed.size || [...allowed].some((flag) => !parsed.has(flag))) {
    fail("FROZEN_PREFLIGHT_SUFFIX_INVALID", "preflight suffix has missing or extra flags");
  }
  return wrapperCommand(config, input.operator_args);
}

/** One spawn, no shell, no retry. Any lost/failed process is an unknown outcome. */
export async function invokeWalmartListingIntegrityFrozenProcess(input: {
  invocation: WalmartListingIntegrityFrozenWorkerInvocation;
  config: WalmartListingIntegrityFrozenProcessConfig;
  operator_args: readonly string[];
}): Promise<Uint8Array> {
  const command = buildWalmartListingIntegrityFrozenProcessCommand(input);
  return invokeFrozenCommand(command);
}

export async function invokeWalmartListingIntegrityFrozenPreflightProcess(input: {
  config: WalmartListingIntegrityFrozenProcessConfig;
  operator_args: readonly string[];
}): Promise<Uint8Array> {
  return invokeFrozenCommand(
    buildWalmartListingIntegrityFrozenPreflightProcessCommand(input),
  );
}

async function invokeFrozenCommand(
  command: WalmartListingIntegrityFrozenProcessCommand,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolvePromise, rejectPromise) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finishError = (code: string, message: string, cause?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new WalmartListingIntegrityFrozenProcessAdapterError(
        code,
        message,
        cause === undefined ? undefined : { cause },
      ));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > command.maximum_stdout_bytes) {
        child.kill("SIGKILL");
        finishError("FROZEN_PROCESS_OUTPUT_OVERFLOW", "operator stdout exceeded receipt limit");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_DIAGNOSTIC_BYTES) stderr.push(chunk);
    });
    child.once("error", (error) => {
      finishError("FROZEN_PROCESS_UNKNOWN_OUTCOME", "operator process could not be observed", error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").slice(0, 4096);
        finishError(
          "FROZEN_PROCESS_UNKNOWN_OUTCOME",
          `operator exited without an admitted receipt (code=${String(code)}, signal=${String(signal)}): ${diagnostic}`,
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise(Uint8Array.from(Buffer.concat(stdout)));
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finishError(
        "FROZEN_PROCESS_UNKNOWN_OUTCOME",
        "operator exceeded the bounded process window; automatic retry is forbidden",
      );
    }, command.timeout_ms);
    timer.unref();
  });
}
