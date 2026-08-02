import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export type WalmartListingIntegrityDiagnosisCommand =
  | {
      command: "capture";
      sku: string;
      store_index: number;
      product_truth_manifest_sha256: string;
      output_dir: string;
    }
  | {
      command: "inspect";
      sku: string;
      store_index: number;
      product_truth_manifest_sha256: string;
      output_dir: string;
    }
  | {
      command: "observe";
      intake_dir: string;
      output_dir: string;
    }
  | {
      command: "diagnose";
      product_truth: string;
      buyer_snapshot: string;
      buyer_pdp: string;
      observations: string;
      asset_root: string;
      output: string;
    };

export interface WalmartListingIntegrityDiagnosisProcessConfig {
  node_path: string;
  env_file: string;
  engine_root: string;
  product_truth_manifest_sha256: string;
}

function fail(message: string): never {
  throw new Error(`WALMART_LISTING_DIAGNOSIS_PROCESS_INVALID: ${message}`);
}

function exactPath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes("\u0000")) {
    fail(`${label} must be an absolute normalized path`);
  }
  return value;
}

function exactSku(value: string): string {
  if (!value || value !== value.trim() || value.length > 500
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("SKU must be bounded exact text");
  }
  return value;
}

function exactSha(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) fail(`${label} must be lowercase SHA-256`);
  return value;
}

export function buildWalmartListingIntegrityDiagnosisArgv(
  command: WalmartListingIntegrityDiagnosisCommand,
): string[] {
  if (command.command === "capture" || command.command === "inspect") {
    if (!Number.isSafeInteger(command.store_index) || command.store_index < 1
      || command.store_index > 10) {
      fail("store_index must be between 1 and 10");
    }
    return [
      command.command,
      `--sku=${exactSku(command.sku)}`,
      `--store-index=${command.store_index}`,
      `--product-truth-manifest-sha256=${exactSha(
        command.product_truth_manifest_sha256,
        "product_truth_manifest_sha256",
      )}`,
      `--output-dir=${exactPath(command.output_dir, "output_dir")}`,
    ];
  }
  if (command.command === "observe") {
    return [
      "observe",
      `--intake-dir=${exactPath(command.intake_dir, "intake_dir")}`,
      `--output-dir=${exactPath(command.output_dir, "output_dir")}`,
    ];
  }
  return [
    "diagnose",
    `--product-truth=${exactPath(command.product_truth, "product_truth")}`,
    `--buyer-snapshot=${exactPath(command.buyer_snapshot, "buyer_snapshot")}`,
    `--buyer-pdp=${exactPath(command.buyer_pdp, "buyer_pdp")}`,
    `--observations=${exactPath(command.observations, "observations")}`,
    `--asset-root=${exactPath(command.asset_root, "asset_root")}`,
    `--output=${exactPath(command.output, "output")}`,
  ];
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production" };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || [
      "NODE_OPTIONS",
      "NODE_PATH",
      "NODE_REPL_EXTERNAL_MODULE",
      "NODE_INSPECT_RESUME_ON_START",
    ].includes(key)) continue;
    env[key] = value;
  }
  return env;
}

export function parseWalmartListingIntegrityDiagnosisProcessStdout(
  bytes: Uint8Array,
): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
  } catch {
    return fail("process stdout is not UTF-8");
  }
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.trimStart().startsWith("{")) continue;
    const prefix = lines.slice(0, index).filter((line) => line.length > 0);
    if (prefix.some((line) => !/^\[WALMART\]\[STORE\d+\] /u.test(line))) continue;
    const candidate = lines.slice(index).join("\n").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail("process result must be one object");
    }
    return parsed as Record<string, unknown>;
  }
  return fail("process stdout does not end in one JSON object after bounded Walmart logs");
}

export async function invokeWalmartListingIntegrityDiagnosisProcess(input: {
  config: WalmartListingIntegrityDiagnosisProcessConfig;
  command: WalmartListingIntegrityDiagnosisCommand;
  timeout_ms?: number;
}): Promise<Record<string, unknown>> {
  const nodePath = exactPath(input.config.node_path, "node_path");
  const envFile = exactPath(input.config.env_file, "env_file");
  const engineRoot = exactPath(input.config.engine_root, "engine_root");
  exactSha(
    input.config.product_truth_manifest_sha256,
    "config.product_truth_manifest_sha256",
  );
  const argv = buildWalmartListingIntegrityDiagnosisArgv(input.command);
  const script = resolve(engineRoot, "scripts/walmart-listing-integrity-process.ts");
  const child = spawn(nodePath, [
    `--env-file=${envFile}`,
    "--import",
    "tsx",
    script,
    ...argv,
  ], {
    cwd: engineRoot,
    env: safeEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= MAX_STDOUT_BYTES) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
  });
  const timeoutMs = input.timeout_ms ?? (
    input.command.command === "observe" ? 20 * 60_000 : 5 * 60_000
  );
  const exitCode = await new Promise<number | null>((accept, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("WALMART_LISTING_DIAGNOSIS_PROCESS_TIMEOUT"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      accept(code);
    });
  });
  if (stdoutBytes < 2 || stdoutBytes > MAX_STDOUT_BYTES || stderrBytes > MAX_STDERR_BYTES) {
    fail("bounded process output was empty or exceeded its limit");
  }
  const row = parseWalmartListingIntegrityDiagnosisProcessStdout(Buffer.concat(stdout));
  const unknownObservation = exitCode === 2
    && row.status === "OBSERVATION_UNKNOWN_OUTCOME";
  if (exitCode !== 0 && !unknownObservation) {
    fail(`process exited ${exitCode}: ${Buffer.concat(stderr).toString("utf8").slice(-2_000)}`);
  }
  return row;
}
