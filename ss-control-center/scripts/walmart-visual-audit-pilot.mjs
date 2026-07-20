#!/usr/bin/env node
/**
 * Strict, subscription-only Walmart visual-audit pilot.
 *
 * Default is a zero-network plan/manifest validation. Add --run to download the
 * frozen artifact images and call exactly one explicitly selected subscription
 * worker. This script imports no DB, Walmart write, R2 upload, remediation, or
 * paid API client.
 *
 *   node --experimental-strip-types scripts/walmart-visual-audit-pilot.mjs
 *   node --experimental-strip-types scripts/walmart-visual-audit-pilot.mjs --run --provider=codex --call-budget=6
 */

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import sharp from "sharp";

import {
  BLIND_OBSERVATION_SCHEMA,
  BLIND_PROMPT_VERSION,
  WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE,
  WALMART_VISUAL_COMPARATOR_VERSION,
  buildBlindObservationPrompt,
  decideBlind,
  parseBlindResponse,
  shuffledWithSeed,
  validateAuditManifest,
} from "../src/lib/walmart/catalog-visual-audit.ts";
import {
  VISUAL_PREPROCESS_SCHEMA,
  VISUAL_PREPROCESS_VERSION,
  preprocessCatalogVisual,
} from "../src/lib/walmart/catalog-visual-preprocess.ts";
import {
  LOCAL_VISUAL_OCR_ENGINE,
  LOCAL_VISUAL_OCR_SCHEMA,
  parseLocalOcrOutput,
} from "../src/lib/walmart/local-visual-ocr.ts";
import {
  buildCodexVisionWrappedPrompt,
  RECOVERED_SESSION_VISUAL_LINK_POLICY,
  validateRecoveredCodexSessionProof,
} from "./lib/walmart-recovered-session-proof.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RUNNER_SOURCE = fileURLToPath(import.meta.url);
const COMPARATOR_SOURCE = path.join(ROOT, "src/lib/walmart/catalog-visual-audit.ts");
const PREPROCESSOR_SOURCE = path.join(ROOT, "src/lib/walmart/catalog-visual-preprocess.ts");
const LOCAL_OCR_SCRIPT = path.join(ROOT, "scripts/walmart-visual-ocr.swift");
const SWIFT_EXECUTABLE = "/usr/bin/swift";
const LOCAL_OCR_SDK = "/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk";
const LOCAL_OCR_MODULE_CACHE = "/private/tmp/ss-walmart-visual-ocr-swift-module-cache";
const DEFAULT_MANIFEST = path.join(ROOT, "data/audits/walmart-visual-pilot-golden-pairs-v3.json");
const MAX_PILOT_CASES = 50;
const MAX_IMAGES_PER_CALL = 6;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const NORMALIZED_MAX_PX = 1800;
const NORMALIZED_JPEG_QUALITY = 92;
const LOCAL_OCR_VIEW_ROLES = new Set(["full", "tile_front", "bottom_label", "top_left_badge"]);
const REQUIRED_WORKER_MODELS = {
  codex: { model: "gpt-5.6-sol", reasoning_effort: "medium" },
  claude: { model: "sonnet", reasoning_effort: null },
};
const REPORT_SEAL_SCHEMA = "walmart-visual-pilot-report-seal/v1";
const RECOVERED_CALL_SCHEMA = "walmart-visual-pilot-recovered-call/v2";
const RECOVERY_RECEIPT_SCHEMA = "walmart-visual-pilot-recovery-receipt/v1";
const GATE_B_POLICY_VERSION = "walmart-visual-gate-b/2026-07-18-v2";
const execFile = promisify(execFileCallback);

loadEnv({ path: path.join(ROOT, ".env.local"), override: false, quiet: true });
loadEnv({ path: path.join(ROOT, ".env"), override: false, quiet: true });

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function equalJson(left, right) {
  return sha256(canonicalJson(left)) === sha256(canonicalJson(right));
}

export function parseArgs(argv) {
  const out = {
    run: false,
    freezeOnly: false,
    provider: "codex",
    manifest: DEFAULT_MANIFEST,
    layout: null,
    callBudget: null,
    expectConsumed: null,
    localOcr: "required",
    replays: [],
    recoverCall: null,
    recoverOnly: false,
    checkpoint: null,
    expectCheckpointSha256: null,
    expectPrefix: null,
    expectRecoveredBatch: null,
  };
  for (const arg of argv) {
    if (arg === "--run") out.run = true;
    else if (arg === "--freeze-only") out.freezeOnly = true;
    else if (arg === "--recover-only") out.recoverOnly = true;
    else if (arg.startsWith("--provider=")) out.provider = arg.slice("--provider=".length);
    else if (arg.startsWith("--manifest=")) out.manifest = path.resolve(ROOT, arg.slice("--manifest=".length));
    else if (arg.startsWith("--layout=")) out.layout = arg.slice("--layout=".length);
    else if (arg.startsWith("--call-budget=")) out.callBudget = Number(arg.slice("--call-budget=".length));
    else if (arg.startsWith("--expect-consumed=")) out.expectConsumed = Number(arg.slice("--expect-consumed=".length));
    else if (arg.startsWith("--local-ocr=")) out.localOcr = arg.slice("--local-ocr=".length);
    else if (arg.startsWith("--replay=")) out.replays.push(path.resolve(ROOT, arg.slice("--replay=".length)));
    else if (arg.startsWith("--recover-call=")) {
      if (out.recoverCall) throw new Error("--recover-call may be supplied only once");
      out.recoverCall = path.resolve(ROOT, arg.slice("--recover-call=".length));
    }
    else if (arg.startsWith("--checkpoint=")) {
      if (out.checkpoint) throw new Error("--checkpoint may be supplied only once");
      out.checkpoint = path.resolve(ROOT, arg.slice("--checkpoint=".length));
    }
    else if (arg.startsWith("--expect-checkpoint-sha256=")) {
      out.expectCheckpointSha256 = arg.slice("--expect-checkpoint-sha256=".length);
    }
    else if (arg.startsWith("--expect-prefix=")) {
      out.expectPrefix = Number(arg.slice("--expect-prefix=".length));
    }
    else if (arg.startsWith("--expect-recovered-batch=")) {
      out.expectRecoveredBatch = Number(arg.slice("--expect-recovered-batch=".length));
    }
    else if (arg.startsWith("--merge-reports=")) {
      for (const file of arg.slice("--merge-reports=".length).split(",").filter(Boolean)) out.replays.push(path.resolve(ROOT, file));
    }
    else throw new Error(`unsupported argument: ${arg}`);
  }
  if (out.provider !== "codex" && out.provider !== "claude") {
    throw new Error("--provider must be codex or claude; auto/paid providers are forbidden");
  }
  if (out.localOcr !== "required" && out.localOcr !== "off") {
    throw new Error("--local-ocr must be required or off");
  }
  if ([out.run, out.freezeOnly, out.recoverOnly, out.replays.length > 0].filter(Boolean).length > 1) {
    throw new Error("--run, --freeze-only, --recover-only, and replay modes are mutually exclusive");
  }
  if (out.callBudget !== null && (!Number.isInteger(out.callBudget) || out.callBudget < 1)) {
    throw new Error("--call-budget must be a positive integer");
  }
  if (out.run && out.callBudget === null) {
    throw new Error("--run requires an explicit positive --call-budget");
  }
  if (out.expectConsumed !== null && (!Number.isInteger(out.expectConsumed) || out.expectConsumed < 0)) {
    throw new Error("--expect-consumed must be a non-negative integer");
  }
  if (out.expectConsumed !== null && !out.run && !out.recoverOnly) {
    throw new Error("--expect-consumed requires --run or --recover-only");
  }
  if (out.expectCheckpointSha256 !== null
    && !/^[a-f0-9]{64}$/.test(out.expectCheckpointSha256)) {
    throw new Error("--expect-checkpoint-sha256 must be a lowercase SHA-256");
  }
  if (out.expectPrefix !== null && (!Number.isInteger(out.expectPrefix) || out.expectPrefix < 0)) {
    throw new Error("--expect-prefix must be a non-negative integer");
  }
  if (out.expectRecoveredBatch !== null
    && (!Number.isInteger(out.expectRecoveredBatch) || out.expectRecoveredBatch < 0)) {
    throw new Error("--expect-recovered-batch must be a non-negative integer");
  }
  if (out.recoverOnly) {
    if (!out.recoverCall || !out.checkpoint || out.expectConsumed === null
      || out.expectPrefix === null || !out.expectCheckpointSha256) {
      throw new Error(
        "--recover-only requires --recover-call, --checkpoint, --expect-consumed=N, "
        + "--expect-prefix=N, and --expect-checkpoint-sha256=SHA256",
      );
    }
    if (out.callBudget !== null) throw new Error("--recover-only forbids --call-budget");
    if (out.expectRecoveredBatch !== null) {
      throw new Error("--expect-recovered-batch is only valid for a post-recovery --run resume");
    }
  } else if (out.run && out.expectConsumed !== null) {
    if (!out.expectCheckpointSha256 || out.expectPrefix === null) {
      throw new Error(
        "resuming --run requires --expect-checkpoint-sha256=SHA256 and --expect-prefix=N",
      );
    }
    if (out.recoverCall || out.checkpoint) {
      throw new Error("--recover-call and --checkpoint are exclusive to --recover-only");
    }
    if (out.expectPrefix !== out.expectConsumed) {
      throw new Error("resume requires --expect-prefix to equal --expect-consumed");
    }
    if (out.expectRecoveredBatch !== null && out.expectRecoveredBatch >= out.expectPrefix) {
      throw new Error("--expect-recovered-batch must be inside the expected prefix");
    }
  } else if (out.recoverCall || out.checkpoint || out.expectCheckpointSha256
    || out.expectPrefix !== null || out.expectRecoveredBatch !== null) {
    throw new Error("recovery arguments require --recover-only");
  }
  return out;
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function safeStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function atomicJson(file, value) {
  if (await fileExists(`${file}.recover.lock`)) {
    throw new Error(`refusing to write while offline recovery lock exists: ${file}`);
  }
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

export async function atomicCompareAndSwapJson(file, expectedSha256, value, hooks = {}) {
  exactSha(expectedSha256, "expected checkpoint SHA-256");
  const resolved = path.resolve(file);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("recovery checkpoint must be a regular non-symlink file");
  }
  await realpath(resolved);
  const lockFile = `${resolved}.recover.lock`;
  const tempFile = `${resolved}.recover-${process.pid}.tmp`;
  let lockHandle = null;
  let tempHandle = null;
  let tempExists = false;
  try {
    lockHandle = await open(lockFile, "wx", 0o600);
    const before = await readFile(resolved);
    if (sha256(before) !== expectedSha256) {
      throw new Error("checkpoint changed before recovery lock was acquired");
    }
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    tempHandle = await open(tempFile, "wx", 0o600);
    tempExists = true;
    await tempHandle.writeFile(bytes);
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = null;
    if (hooks.beforeCommit) await hooks.beforeCommit();
    const immediatelyBeforeCommit = await readFile(resolved);
    if (sha256(immediatelyBeforeCommit) !== expectedSha256) {
      throw new Error("checkpoint changed concurrently during recovery");
    }
    await rename(tempFile, resolved);
    tempExists = false;
    const after = await readFile(resolved);
    if (sha256(after) !== sha256(bytes)) {
      throw new Error("checkpoint post-recovery byte verification failed");
    }
    return { before_sha256: expectedSha256, after_sha256: sha256(after), bytes: after };
  } finally {
    if (tempHandle) await tempHandle.close().catch(() => {});
    if (tempExists) await unlink(tempFile).catch(() => {});
    if (lockHandle) await lockHandle.close().catch(() => {});
    if (lockHandle) await unlink(lockFile).catch(() => {});
  }
}

async function fileExists(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

export async function readJsonIfPresent(file, fallback, label = "JSON file") {
  let bytes;
  try {
    bytes = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${file}`, { cause: error });
  }
}

export function assertGoldenPilotPurpose(manifest) {
  if (manifest?.purpose !== "golden-pilot") {
    throw new Error(
      `runner is restricted to purpose=golden-pilot until buyer-facing PDP/truth binding is implemented; received ${manifest?.purpose ?? "missing"}`,
    );
  }
}

export function assertCheckpointAccounting(state, expectedConsumed = null) {
  if (!state || typeof state !== "object" || Array.isArray(state)
    || !state.calls || typeof state.calls !== "object" || Array.isArray(state.calls)) {
    throw new Error("checkpoint accounting is invalid");
  }
  const completedAttempts = Object.values(state.calls).reduce((sum, call) => {
    if (!Array.isArray(call?.transport_attempts)) throw new Error("checkpoint call has invalid transport_attempts");
    return sum + call.transport_attempts.length;
  }, 0);
  if (!Number.isInteger(state.subscription_calls_consumed)
    || state.subscription_calls_consumed < 0
    || state.subscription_calls_consumed !== completedAttempts) {
    throw new Error(
      `checkpoint has ambiguous call accounting: consumed=${state.subscription_calls_consumed ?? "missing"}, recorded_attempts=${completedAttempts}; refusing any retry`,
    );
  }
  if (expectedConsumed !== null && state.subscription_calls_consumed !== expectedConsumed) {
    throw new Error(
      `resume guard: expected ${expectedConsumed} consumed calls, found ${state.subscription_calls_consumed}`,
    );
  }
  return completedAttempts;
}

function exactObjectKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (!equalJson(actual, expected)) throw new Error(`${label} has unsupported or missing fields`);
  return value;
}

function exactString(value, label) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function exactSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function exactIso(value, label) {
  exactString(value, label);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

export function validateRecoveredCallEvidence(raw) {
  const value = exactObjectKeys(raw, [
    "schema_version", "recovery_id", "recovered_at", "source", "checkpoint", "binding", "result",
  ], "recovered call evidence");
  if (value.schema_version !== RECOVERED_CALL_SCHEMA) throw new Error("recovered call schema is unsupported");
  exactString(value.recovery_id, "recovery_id");
  exactIso(value.recovered_at, "recovered_at");
  const source = exactObjectKeys(value.source, [
    "kind", "host", "remote_path", "local_file", "session_id",
    "session_log_sha256", "session_log_bytes", "embedded_input_image_sha256",
    "embedded_input_image_bytes", "embedded_input_image_width", "embedded_input_image_height",
    "started_at", "completed_at", "duration_ms", "input_image_count",
    "model", "reasoning_effort", "cli_version", "result_canonical_sha256",
  ], "recovered call source");
  if (source.kind !== "codex_session_log" || source.host !== "openclaw") {
    throw new Error("recovered call source must be the attested openclaw Codex session log");
  }
  exactString(source.session_id, "source.session_id");
  exactString(source.remote_path, "source.remote_path");
  if (!source.remote_path.startsWith("/root/.codex/sessions/")
    || !source.remote_path.endsWith(`${source.session_id}.jsonl`)) {
    throw new Error("recovered session path does not bind the session_id");
  }
  exactString(source.local_file, "source.local_file");
  if (path.isAbsolute(source.local_file) || source.local_file.includes("..")) {
    throw new Error("recovered local session file must be a workspace-relative path");
  }
  exactSha(source.session_log_sha256, "source.session_log_sha256");
  exactSha(source.embedded_input_image_sha256, "source.embedded_input_image_sha256");
  if (!Number.isInteger(source.session_log_bytes) || source.session_log_bytes < 1
    || !Number.isInteger(source.duration_ms) || source.duration_ms < 1
    || !Number.isInteger(source.input_image_count) || source.input_image_count < 1
    || !Number.isInteger(source.embedded_input_image_bytes) || source.embedded_input_image_bytes < 1
    || !Number.isInteger(source.embedded_input_image_width) || source.embedded_input_image_width < 1
    || !Number.isInteger(source.embedded_input_image_height) || source.embedded_input_image_height < 1) {
    throw new Error("recovered session numeric metadata is invalid");
  }
  exactIso(source.started_at, "source.started_at");
  exactIso(source.completed_at, "source.completed_at");
  if (new Date(source.completed_at) <= new Date(source.started_at)
    || Math.abs(
      (new Date(source.completed_at).getTime() - new Date(source.started_at).getTime())
      - source.duration_ms,
    ) > 1_000) {
    throw new Error("recovered session duration does not match its timestamps");
  }
  exactString(source.model, "source.model");
  exactString(source.reasoning_effort, "source.reasoning_effort");
  exactString(source.cli_version, "source.cli_version");
  exactSha(source.result_canonical_sha256, "source.result_canonical_sha256");

  const checkpoint = exactObjectKeys(value.checkpoint, [
    "pre_recovery_sha256", "subscription_calls_consumed", "recorded_attempts",
    "completed_prefix_length",
  ], "recovered call checkpoint binding");
  exactSha(checkpoint.pre_recovery_sha256, "checkpoint.pre_recovery_sha256");
  for (const key of ["subscription_calls_consumed", "recorded_attempts", "completed_prefix_length"]) {
    if (!Number.isInteger(checkpoint[key]) || checkpoint[key] < 0) {
      throw new Error(`checkpoint.${key} must be a non-negative integer`);
    }
  }
  if (checkpoint.subscription_calls_consumed !== checkpoint.recorded_attempts + 1
    || checkpoint.recorded_attempts !== checkpoint.completed_prefix_length) {
    throw new Error("recovered checkpoint binding is not an exact one-attempt prefix gap");
  }

  const binding = exactObjectKeys(value.binding, [
    "manifest_sha256", "provider", "worker_build", "worker_contract",
    "selected_layout_plan_sha256", "layout_name", "batch_index", "prompt_version",
    "prompt_sha256", "call_key", "preprocessor_version", "image_ids", "full_view_sha256",
  ], "recovered call binding");
  exactSha(binding.manifest_sha256, "binding.manifest_sha256");
  if (binding.provider !== "codex") throw new Error("recovered call provider must be codex");
  if (typeof binding.worker_build !== "string" || !/^sha256:[a-f0-9]{64}$/.test(binding.worker_build)) {
    throw new Error("binding.worker_build is invalid");
  }
  const contract = exactObjectKeys(binding.worker_contract, [
    "vision_model", "vision_reasoning_effort", "cli_version", "node_version",
    "runtime_platform", "runtime_arch",
  ], "recovered call worker contract");
  for (const [key, item] of Object.entries(contract)) exactString(item, `binding.worker_contract.${key}`);
  exactSha(binding.selected_layout_plan_sha256, "binding.selected_layout_plan_sha256");
  exactString(binding.layout_name, "binding.layout_name");
  if (!Number.isInteger(binding.batch_index) || binding.batch_index < 0) {
    throw new Error("binding.batch_index is invalid");
  }
  exactString(binding.prompt_version, "binding.prompt_version");
  exactSha(binding.prompt_sha256, "binding.prompt_sha256");
  exactSha(binding.call_key, "binding.call_key");
  exactString(binding.preprocessor_version, "binding.preprocessor_version");
  for (const [key, items] of [["image_ids", binding.image_ids], ["full_view_sha256", binding.full_view_sha256]]) {
    if (!Array.isArray(items) || items.length !== source.input_image_count || new Set(items).size !== items.length) {
      throw new Error(`binding.${key} does not match the recovered input count`);
    }
    for (const item of items) {
      if (key === "image_ids") exactString(item, `binding.${key}`);
      else exactSha(item, `binding.${key}`);
    }
  }
  const normalizedSessionCli = source.cli_version.startsWith("codex-cli ")
    ? source.cli_version
    : `codex-cli ${source.cli_version}`;
  if (source.model !== contract.vision_model
    || source.reasoning_effort !== contract.vision_reasoning_effort
    || normalizedSessionCli !== contract.cli_version) {
    throw new Error("recovered session model/runtime does not match the worker contract");
  }
  if (source.result_canonical_sha256 !== sha256(canonicalJson(value.result))) {
    throw new Error("recovered result canonical SHA-256 mismatch");
  }
  return value;
}

export function assertExactCheckpointPrefix(state, plannedCalls, prefixLength, options = {}) {
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > plannedCalls.length) {
    throw new Error("checkpoint prefix length is outside the planned calls");
  }
  const expectedPrefix = plannedCalls.slice(0, prefixLength);
  if (new Set(plannedCalls.map((call) => call.call_key)).size !== plannedCalls.length) {
    throw new Error("planned call identities are not unique");
  }
  const actualKeys = Object.keys(state.calls || {}).sort();
  const expectedKeys = expectedPrefix.map((call) => call.call_key).sort();
  if (!equalJson(actualKeys, expectedKeys)) {
    throw new Error(`checkpoint is not the exact planned prefix 0..${prefixLength - 1}`);
  }
  const explicitlyAllowedRecovered = Array.isArray(options.allowedRecoveredBatchIndexes)
    ? options.allowedRecoveredBatchIndexes
    : options.allowRecoveredLast && prefixLength > 0 ? [prefixLength - 1] : [];
  if (explicitlyAllowedRecovered.some((index) => (
    !Number.isInteger(index) || index < 0 || index >= prefixLength
  )) || new Set(explicitlyAllowedRecovered).size !== explicitlyAllowedRecovered.length) {
    throw new Error("allowed recovered batch indexes are invalid");
  }
  const allowedRecovered = new Set(explicitlyAllowedRecovered);
  const seenRecovered = new Set();
  for (const planned of expectedPrefix) {
    const record = state.calls[planned.call_key];
    for (const key of [
      "call_key", "provider", "prompt_version", "prompt_sha256", "preprocessor_version",
      "image_ids", "full_view_sha256", "worker_build",
    ]) {
      if (!equalJson(record?.[key], planned[key])) {
        throw new Error(`checkpoint prefix binding mismatch at batch ${planned.batch_index}: ${key}`);
      }
    }
    if (!Array.isArray(record.transport_attempts) || record.transport_attempts.length !== 1) {
      throw new Error(`checkpoint prefix batch ${planned.batch_index} must contain exactly one attempt`);
    }
    if (record.recovery_provenance_validated === true) {
      if (!allowedRecovered.has(planned.batch_index)
        || record.recovery_result_reusable !== true
        || record.worker_contract_attested !== false
        || record.worker_model_runtime_attested !== false
        || record.recovery?.session_log_locally_revalidated !== true
        || record.recovery?.client_response_observed !== false
        || record.recovery?.http_status !== null) {
        throw new Error("recovered checkpoint record is outside the explicitly allowed batches");
      }
      seenRecovered.add(planned.batch_index);
    } else if (record.worker_contract_attested !== true
      || record.worker_model_runtime_attested !== true
      || record.schema_valid !== true) {
      throw new Error(`checkpoint prefix batch ${planned.batch_index} lacks normal worker attestation`);
    }
    parseBlindResponse(record.observations, planned.image_ids);
  }
  if (!equalJson([...seenRecovered].sort((a, b) => a - b), [...allowedRecovered].sort((a, b) => a - b))) {
    throw new Error("checkpoint recovered batches do not exactly match the declared allowlist");
  }
  return true;
}

export function assertSingleRecoveryMutation(before, after, targetCallKey) {
  const { calls: beforeCalls = {}, ...beforeMeta } = before || {};
  const { calls: afterCalls = {}, ...afterMeta } = after || {};
  if (!equalJson(beforeMeta, afterMeta)) throw new Error("recovery changed checkpoint metadata");
  if (Object.hasOwn(beforeCalls, targetCallKey)
    || !Object.hasOwn(afterCalls, targetCallKey)
    || Object.keys(afterCalls).length !== Object.keys(beforeCalls).length + 1) {
    throw new Error("recovery did not add exactly the intended call record");
  }
  for (const [callKey, record] of Object.entries(beforeCalls)) {
    if (!equalJson(record, afterCalls[callKey])) {
      throw new Error(`recovery changed existing call record ${callKey}`);
    }
  }
  return true;
}

export function reconcileRecoveredCall(state, rawEvidence, expected) {
  const evidence = validateRecoveredCallEvidence(rawEvidence);
  const binding = evidence.binding;
  const expectedBinding = {
    manifest_sha256: expected.manifest_sha256,
    provider: expected.provider,
    worker_build: expected.worker_build,
    worker_contract: expected.worker_contract,
    selected_layout_plan_sha256: expected.selected_layout_plan_sha256,
    layout_name: expected.layout_name,
    batch_index: expected.batch_index,
    prompt_version: expected.prompt_version,
    prompt_sha256: expected.prompt_sha256,
    call_key: expected.call_key,
    preprocessor_version: expected.preprocessor_version,
    image_ids: expected.image_ids,
    full_view_sha256: expected.full_view_sha256,
  };
  if (!equalJson(binding, expectedBinding)) throw new Error("recovered call binding does not match the planned call");
  if (evidence.checkpoint.pre_recovery_sha256 !== expected.checkpoint_pre_sha256
    || evidence.checkpoint.subscription_calls_consumed !== state.subscription_calls_consumed
    || evidence.checkpoint.recorded_attempts !== expected.completed_prefix_length
    || evidence.checkpoint.completed_prefix_length !== expected.completed_prefix_length
    || binding.batch_index !== expected.completed_prefix_length) {
    throw new Error("recovered call does not match the exact checkpoint gap and next target");
  }
  const observations = parseBlindResponse(evidence.result, expected.image_ids);
  const evidenceSha = sha256(canonicalJson(evidence));
  const existing = state.calls?.[expected.call_key];
  if (existing) {
    if (existing.recovery?.evidence_canonical_sha256 !== evidenceSha
      || !equalJson(existing.observations, evidence.result)) {
      throw new Error("existing recovered call does not match the supplied evidence");
    }
    assertCheckpointAccounting(state, state.subscription_calls_consumed);
    assertExactCheckpointPrefix(
      state,
      expected.planned_calls,
      expected.completed_prefix_length + 1,
      { allowRecoveredLast: true },
    );
    return { applied: false, record: existing, observations };
  }
  assertExactCheckpointPrefix(state, expected.planned_calls, expected.completed_prefix_length);
  const recordedAttempts = Object.values(state.calls || {}).reduce((sum, call) => {
    if (!Array.isArray(call?.transport_attempts)) throw new Error("checkpoint call has invalid transport_attempts");
    return sum + call.transport_attempts.length;
  }, 0);
  if (state.subscription_calls_consumed !== recordedAttempts + 1) {
    throw new Error(
      `recovery requires exactly one interrupted attempt; consumed=${state.subscription_calls_consumed}, recorded=${recordedAttempts}`,
    );
  }
  const contract = binding.worker_contract;
  const attempt = {
    attempt: 1,
    status: null,
    duration_ms: null,
    ok: null,
    error: "HTTP client disconnected before response; completed Codex session recovered offline",
    attested_image_count: null,
    worker_provider: null,
    worker_build: null,
    vision_model: null,
    vision_reasoning_effort: null,
    cli_version: null,
    node_version: null,
    runtime_platform: null,
    runtime_arch: null,
    worker_model_runtime_attested: false,
    worker_contract_attested: false,
    client_response_observed: false,
    remote_session_completed: true,
    recovered_after_client_disconnect: true,
  };
  const record = {
    call_key: binding.call_key,
    provider: binding.provider,
    prompt_version: binding.prompt_version,
    prompt_sha256: binding.prompt_sha256,
    preprocessor_version: binding.preprocessor_version,
    image_ids: binding.image_ids,
    full_view_sha256: binding.full_view_sha256,
    transport_attempts: [attempt],
    transport_ok: null,
    schema_valid: true,
    schema_error: null,
    image_count_attested: false,
    worker_contract_attested: false,
    worker_provider: null,
    worker_build: binding.worker_build,
    vision_model: null,
    vision_reasoning_effort: null,
    cli_version: null,
    node_version: null,
    runtime_platform: null,
    runtime_arch: null,
    worker_model_runtime_attested: false,
    recovery_provenance_validated: true,
    recovery_result_reusable: true,
    observations: evidence.result,
    completed_at: evidence.source.completed_at,
    recovery: {
      schema_version: evidence.schema_version,
      recovery_id: evidence.recovery_id,
      evidence_canonical_sha256: evidenceSha,
      session_id: evidence.source.session_id,
      session_log_sha256: evidence.source.session_log_sha256,
      session_log_bytes: evidence.source.session_log_bytes,
      session_embedded_input_image_sha256: evidence.source.embedded_input_image_sha256,
      source_full_view_sha256: binding.full_view_sha256,
      session_log_locally_revalidated: true,
      client_response_observed: false,
      http_status: null,
      transport_duration_ms: null,
      remote_session_model: contract.vision_model,
      remote_session_reasoning_effort: contract.vision_reasoning_effort,
      remote_session_cli_version: evidence.source.cli_version,
      deterministic_visual_binding: expected.session_proof.image_link,
      checkpoint_pre_sha256: expected.checkpoint_pre_sha256,
      recovered_at: evidence.recovered_at,
    },
  };
  state.calls ??= {};
  state.calls[binding.call_key] = record;
  assertCheckpointAccounting(state, state.subscription_calls_consumed);
  assertExactCheckpointPrefix(
    state,
    expected.planned_calls,
    expected.completed_prefix_length + 1,
    { allowRecoveredLast: true },
  );
  return { applied: true, record, observations };
}

export function assertExactRunCallBudget(run, callBudget, plannedCalls) {
  if (run && callBudget !== plannedCalls) {
    throw new Error(
      `--call-budget must equal the exact ${plannedCalls} planned primary calls for the selected layout(s); received ${callBudget}`,
    );
  }
}

export function selectedLayoutPlanSha256(layouts) {
  if (!Array.isArray(layouts) || layouts.length === 0) {
    throw new Error("selected layout plan must not be empty");
  }
  const names = new Set();
  const plan = layouts.map((layout) => {
    if (!layout || typeof layout !== "object"
      || typeof layout.name !== "string" || !layout.name
      || names.has(layout.name)
      || !Number.isInteger(layout.batch_size) || layout.batch_size < 1
      || (layout.shuffle_seed !== null && !Number.isInteger(layout.shuffle_seed))) {
      throw new Error("selected layout plan is invalid or contains duplicate names");
    }
    names.add(layout.name);
    return {
      name: layout.name,
      batch_size: layout.batch_size,
      shuffle_seed: layout.shuffle_seed,
    };
  });
  return sha256(canonicalJson(plan));
}

function manifestSourceFingerprint(manifest) {
  return sha256(JSON.stringify(manifest.cases.map((item) => ({
    case_id: item.case_id,
    images: item.images.map((image) => ({ slot: image.slot, url: image.url, surface: image.surface })),
  }))));
}

function workerRunKey({ manifest, manifestSha, layoutPlanSha, workerBuild, provider }) {
  const promptBaseSha = sha256(buildBlindObservationPrompt(["i_template"]));
  return `${manifest.manifest_id}-${manifestSha.slice(0, 12)}-${layoutPlanSha.slice(0, 12)}`
    + `-${promptBaseSha.slice(0, 12)}-${sha256(VISUAL_PREPROCESS_VERSION).slice(0, 8)}`
    + `-${workerBuild.slice(7, 19)}-${provider}`;
}

function pilotArtifactPaths({ manifest, manifestSha, layoutPlanSha, workerBuild, provider }) {
  const runKey = workerRunKey({ manifest, manifestSha, layoutPlanSha, workerBuild, provider });
  const snapshotKey = `walmart-main-${manifestSourceFingerprint(manifest).slice(0, 20)}`;
  const runDir = path.join(ROOT, "data/audits/walmart-visual-pilot-runs", runKey);
  const snapshotDir = path.join(ROOT, "data/audits/walmart-visual-pilot-snapshots", snapshotKey);
  return {
    runKey,
    runDir,
    snapshotDir,
    stateFile: path.join(runDir, "checkpoint.json"),
    sourceIndexFile: path.join(snapshotDir, "source-index.json"),
  };
}

async function buildOfflinePlannedCalls({
  manifest, layout, provider, workerContract, snapshotDir, sourceIndexFile,
}) {
  const sourceIndexBytes = await readFile(sourceIndexFile);
  let sourceIndex;
  try {
    sourceIndex = JSON.parse(sourceIndexBytes.toString("utf8"));
  } catch (error) {
    throw new Error("offline recovery source index is invalid JSON", { cause: error });
  }
  const ordered = layout.shuffle_seed === null
    ? [...manifest.cases]
    : shuffledWithSeed(manifest.cases, layout.shuffle_seed);
  const batches = chunks(ordered, layout.batch_size);
  const planned = [];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const items = [];
    for (const item of batches[batchIndex]) {
      const image = item.images[0];
      const frozen = sourceIndex[image.url];
      if (!frozen || frozen.url !== image.url || frozen.slot !== image.slot
        || frozen.surface !== image.surface
        || frozen.buyer_facing_verified !== image.buyer_facing_verified) {
        throw new Error(`offline recovery source binding mismatch for ${item.case_id}`);
      }
      const fullViews = frozen.visual_evidence?.preprocessor?.views
        ?.filter((view) => view.role === "full") ?? [];
      if (fullViews.length !== 1 || fullViews[0].media_type !== "image/jpeg") {
        throw new Error(`offline recovery requires one frozen JPEG full view for ${item.case_id}`);
      }
      const fullPath = ensureUnderDirectory(
        snapshotDir,
        fullViews[0].file,
        `offline recovery full view for ${item.case_id}`,
      );
      const fullBytes = await readFile(fullPath);
      if (sha256(fullBytes) !== fullViews[0].sha256
        || fullBytes.length !== fullViews[0].byte_length) {
        throw new Error(`offline recovery full-view bytes mismatch for ${item.case_id}`);
      }
      items.push({
        case: item,
        image,
        frozen,
        localVisualEvidence: frozen.visual_evidence,
        modelAttachment: {
          role: "full",
          sha256: fullViews[0].sha256,
          file: fullViews[0].file,
          path: fullPath,
        },
      });
    }
    const identity = visionCallIdentity({
      provider,
      layoutName: layout.name,
      batchIndex,
      items,
      workerContract,
    });
    planned.push({
      batch_index: batchIndex,
      case_ids: items.map((item) => item.case.case_id),
      call_key: identity.callKey,
      provider,
      worker_build: workerContract.worker_build,
      prompt_version: BLIND_PROMPT_VERSION,
      prompt_sha256: identity.promptSha,
      prompt: identity.prompt,
      preprocessor_version: VISUAL_PREPROCESS_VERSION,
      image_ids: identity.imageIds,
      full_view_sha256: items.map((item) => item.modelAttachment.sha256),
      full_view_paths: items.map((item) => item.modelAttachment.path),
      full_view_metadata: items.map((item) => {
        const full = item.localVisualEvidence.preprocessor.views.find((view) => view.role === "full");
        return { byte_length: full.byte_length, width: full.width, height: full.height };
      }),
    });
  }
  return { planned, source_index_sha256: sha256(sourceIndexBytes) };
}

async function assertRegularResolvedFile(file, label) {
  const resolved = ensureWorkspaceFile(file, label);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  if (await realpath(resolved) !== resolved) throw new Error(`${label} realpath mismatch`);
  return resolved;
}

async function runOfflineRecovery({
  args, manifest, manifestPath, manifestSha, layouts, layoutPlanSha,
}) {
  if (layouts.length !== 1) throw new Error("--recover-only requires exactly one selected layout");
  if (args.provider !== "codex") throw new Error("offline session recovery supports only the Codex provider");
  const evidenceFile = await assertRegularResolvedFile(args.recoverCall, "recovered call evidence");
  const evidenceBytes = await readFile(evidenceFile);
  let evidence;
  try {
    evidence = validateRecoveredCallEvidence(JSON.parse(evidenceBytes.toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("recovered call evidence is invalid JSON", { cause: error });
    throw error;
  }
  if (evidence.binding.provider !== args.provider
    || evidence.binding.manifest_sha256 !== manifestSha
    || evidence.binding.selected_layout_plan_sha256 !== layoutPlanSha
    || evidence.binding.layout_name !== layouts[0].name) {
    throw new Error("recovery evidence does not match the selected manifest/provider/layout");
  }
  if (args.expectCheckpointSha256 !== evidence.checkpoint.pre_recovery_sha256
    || args.expectConsumed !== evidence.checkpoint.subscription_calls_consumed
    || args.expectPrefix !== evidence.checkpoint.completed_prefix_length) {
    throw new Error("recovery CLI guards do not exactly match the sealed evidence");
  }
  const workerContract = {
    worker_build: evidence.binding.worker_build,
    vision_provider: "codex_cli_subscription",
    ...evidence.binding.worker_contract,
  };
  const artifacts = pilotArtifactPaths({
    manifest,
    manifestSha,
    layoutPlanSha,
    workerBuild: workerContract.worker_build,
    provider: args.provider,
  });
  const requestedCheckpoint = path.resolve(args.checkpoint);
  if (requestedCheckpoint !== artifacts.stateFile) {
    throw new Error("--checkpoint is not the deterministically selected run checkpoint");
  }
  const checkpointFile = await assertRegularResolvedFile(requestedCheckpoint, "recovery checkpoint");
  const checkpointBytes = await readFile(checkpointFile);
  if (sha256(checkpointBytes) !== args.expectCheckpointSha256) {
    throw new Error("recovery checkpoint raw SHA-256 does not match --expect-checkpoint-sha256");
  }
  let state;
  try {
    state = JSON.parse(checkpointBytes.toString("utf8"));
  } catch (error) {
    throw new Error("recovery checkpoint is invalid JSON", { cause: error });
  }
  if (state.schema_version !== "walmart-visual-pilot-checkpoint/v1"
    || state.manifest_sha256 !== manifestSha
    || state.provider !== args.provider
    || state.worker_build !== workerContract.worker_build
    || state.preprocessor_version !== VISUAL_PREPROCESS_VERSION
    || state.selected_layout_plan_sha256 !== layoutPlanSha) {
    throw new Error("offline recovery checkpoint fingerprint mismatch");
  }
  const recordedAttempts = Object.values(state.calls || {}).reduce((sum, call) => {
    if (!Array.isArray(call?.transport_attempts)) throw new Error("checkpoint call has invalid transport_attempts");
    return sum + call.transport_attempts.length;
  }, 0);
  if (state.subscription_calls_consumed !== args.expectConsumed
    || recordedAttempts !== args.expectPrefix
    || state.subscription_calls_consumed !== recordedAttempts + 1) {
    throw new Error("offline recovery requires the exact declared one-attempt checkpoint gap");
  }
  await assertRegularResolvedFile(artifacts.sourceIndexFile, "offline recovery source index");
  const { planned, source_index_sha256: sourceIndexSha } = await buildOfflinePlannedCalls({
    manifest,
    layout: layouts[0],
    provider: args.provider,
    workerContract,
    snapshotDir: artifacts.snapshotDir,
    sourceIndexFile: artifacts.sourceIndexFile,
  });
  assertExactCheckpointPrefix(state, planned, args.expectPrefix);
  const target = planned[args.expectPrefix];
  if (!target || target.batch_index !== evidence.binding.batch_index
    || target.image_ids.length !== 1 || target.full_view_paths.length !== 1) {
    throw new Error("recovery evidence is not the single exact next planned call");
  }
  const sessionLogFile = await assertRegularResolvedFile(
    path.join(ROOT, evidence.source.local_file),
    "local recovered Codex session log",
  );
  const localFullViewFile = await assertRegularResolvedFile(
    target.full_view_paths[0],
    "recovery target full view",
  );
  const [sessionLogBytes, localFullViewJpegBytes] = await Promise.all([
    readFile(sessionLogFile),
    readFile(localFullViewFile),
  ]);
  const sessionProof = await validateRecoveredCodexSessionProof({
    sessionLogBytes,
    localFullViewJpegBytes,
    expected: {
      session_log: {
        sha256: evidence.source.session_log_sha256,
        byte_length: evidence.source.session_log_bytes,
      },
      session: {
        id: evidence.source.session_id,
        cli_version: evidence.source.cli_version,
        model: evidence.source.model,
        reasoning_effort: evidence.source.reasoning_effort,
        started_at: evidence.source.started_at,
        completed_at: evidence.source.completed_at,
        duration_ms: evidence.source.duration_ms,
      },
      prompt: {
        base: target.prompt,
        base_sha256: target.prompt_sha256,
        wrapped: buildCodexVisionWrappedPrompt(target.prompt, target.image_ids.length),
      },
      result: evidence.result,
      result_canonical_sha256: evidence.source.result_canonical_sha256,
      embedded_image: {
        sha256: evidence.source.embedded_input_image_sha256,
        byte_length: evidence.source.embedded_input_image_bytes,
        width: evidence.source.embedded_input_image_width,
        height: evidence.source.embedded_input_image_height,
      },
      local_full_view: {
        sha256: target.full_view_sha256[0],
        ...target.full_view_metadata[0],
      },
    },
  });
  const before = structuredClone(state);
  const after = structuredClone(state);
  const recovery = reconcileRecoveredCall(after, evidence, {
    manifest_sha256: manifestSha,
    provider: args.provider,
    worker_build: workerContract.worker_build,
    worker_contract: evidence.binding.worker_contract,
    selected_layout_plan_sha256: layoutPlanSha,
    layout_name: layouts[0].name,
    batch_index: target.batch_index,
    prompt_version: target.prompt_version,
    prompt_sha256: target.prompt_sha256,
    call_key: target.call_key,
    preprocessor_version: target.preprocessor_version,
    image_ids: target.image_ids,
    full_view_sha256: target.full_view_sha256,
    checkpoint_pre_sha256: args.expectCheckpointSha256,
    completed_prefix_length: args.expectPrefix,
    planned_calls: planned,
    session_proof: sessionProof,
  });
  if (!recovery.applied) throw new Error("offline recovery target unexpectedly already exists");
  assertSingleRecoveryMutation(before, after, target.call_key);
  if (after.subscription_calls_consumed !== args.expectConsumed) {
    throw new Error("offline recovery changed the consumed-call counter");
  }
  const cas = await atomicCompareAndSwapJson(
    checkpointFile,
    args.expectCheckpointSha256,
    after,
  );
  const persisted = JSON.parse(cas.bytes.toString("utf8"));
  assertCheckpointAccounting(persisted, args.expectConsumed);
  assertExactCheckpointPrefix(
    persisted,
    planned,
    args.expectPrefix + 1,
    { allowRecoveredLast: true },
  );
  assertSingleRecoveryMutation(before, persisted, target.call_key);
  const receiptBody = {
    schema_version: "walmart-visual-pilot-recovery-receipt/v1",
    recovery_id: evidence.recovery_id,
    created_at: new Date().toISOString(),
    mode: "offline-recover-only",
    manifest: {
      path: path.relative(ROOT, manifestPath),
      sha256: manifestSha,
    },
    layout: {
      name: layouts[0].name,
      selected_layout_plan_sha256: layoutPlanSha,
      batch_index: target.batch_index,
      call_key: target.call_key,
      image_ids: target.image_ids,
      full_view_sha256: target.full_view_sha256,
    },
    checkpoint: {
      path: path.relative(ROOT, checkpointFile),
      before_sha256: cas.before_sha256,
      after_sha256: cas.after_sha256,
      consumed_calls: persisted.subscription_calls_consumed,
      recorded_attempts: Object.values(persisted.calls)
        .reduce((sum, call) => sum + call.transport_attempts.length, 0),
    },
    evidence: {
      path: path.relative(ROOT, evidenceFile),
      canonical_sha256: sha256(canonicalJson(evidence)),
      session_log_path: path.relative(ROOT, sessionLogFile),
      session_log_sha256: sessionProof.session.sha256,
      source_index_sha256: sourceIndexSha,
      result_canonical_sha256: sessionProof.result.canonical_sha256,
      image_link: sessionProof.image_link,
    },
    execution: {
      network_calls: 0,
      model_calls: 0,
      worker_health_calls: 0,
      image_downloads: 0,
      walmart_writes: 0,
      database_writes: 0,
    },
  };
  const sealedReceipt = sealReport(receiptBody);
  const receiptBytes = Buffer.from(`${JSON.stringify(sealedReceipt, null, 2)}\n`);
  const receiptFile = path.join(
    artifacts.runDir,
    `recovery-${safeStamp()}-${sealedReceipt.report_seal.canonical_body_sha256.slice(0, 16)}.json`,
  );
  await writeImmutableBytes(receiptFile, receiptBytes);
  console.log("offline recovery complete: 0 network calls · 0 model calls · 0 image downloads");
  console.log(`checkpoint accounting: ${args.expectConsumed} consumed = ${args.expectConsumed} recorded attempts`);
  console.log(`recovered batch: ${target.batch_index + 1}/${planned.length} ${target.call_key}`);
  console.log(`checkpoint: ${path.relative(ROOT, checkpointFile)}`);
  console.log(`receipt: ${path.relative(ROOT, receiptFile)}`);
}

async function writeImmutableBytes(file, bytes, expectedSha = sha256(bytes)) {
  if (sha256(bytes) !== expectedSha) throw new Error(`immutable write hash mismatch for ${file}`);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(file);
    if (sha256(existing) !== expectedSha) throw new Error(`immutable artifact collision at ${file}`);
  }
}

export function sealReport(reportBody) {
  if (!reportBody || typeof reportBody !== "object" || Array.isArray(reportBody)) {
    throw new Error("report body must be an object");
  }
  if (Object.prototype.hasOwnProperty.call(reportBody, "report_seal")) {
    throw new Error("report body must not already contain report_seal");
  }
  const canonicalBodySha = sha256(canonicalJson(reportBody));
  return {
    ...reportBody,
    report_seal: {
      schema_version: REPORT_SEAL_SCHEMA,
      canonical_body_sha256: canonicalBodySha,
    },
  };
}

export function verifySealedReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("sealed report must be an object");
  }
  const { report_seal: seal, ...body } = report;
  if (seal?.schema_version !== REPORT_SEAL_SCHEMA
    || typeof seal?.canonical_body_sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(seal.canonical_body_sha256)) {
    throw new Error("report seal is missing or invalid");
  }
  const actual = sha256(canonicalJson(body));
  if (actual !== seal.canonical_body_sha256) throw new Error("report body seal mismatch");
  return true;
}

export function reportBodyWithoutSeal(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("report must be an object");
  }
  const body = { ...report };
  delete body.report_seal;
  return body;
}

async function writeSealedReport(directory, reportBody) {
  const sealed = sealReport(reportBody);
  const bodySha = sealed.report_seal.canonical_body_sha256;
  const file = path.join(directory, `report-${safeStamp()}-${bodySha.slice(0, 16)}.json`);
  const bytes = Buffer.from(`${JSON.stringify(sealed, null, 2)}\n`);
  await writeImmutableBytes(file, bytes, sha256(bytes));
  return { file, sealed };
}

async function buildArtifactAttestation() {
  const [runnerBytes, comparatorBytes, preprocessorBytes, ocrScriptBytes] = await Promise.all([
    readFile(RUNNER_SOURCE),
    readFile(COMPARATOR_SOURCE),
    readFile(PREPROCESSOR_SOURCE),
    readFile(LOCAL_OCR_SCRIPT),
  ]);
  return {
    runner_source_sha256: sha256(runnerBytes),
    comparator_version: WALMART_VISUAL_COMPARATOR_VERSION,
    comparator_source_sha256: sha256(comparatorBytes),
    preprocessor_schema: VISUAL_PREPROCESS_SCHEMA,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    preprocessor_source_sha256: sha256(preprocessorBytes),
    local_ocr_schema: LOCAL_VISUAL_OCR_SCHEMA,
    local_ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
    local_ocr_script_sha256: sha256(ocrScriptBytes),
    local_ocr_runtime: {
      executable: SWIFT_EXECUTABLE,
      sdk: path.basename(LOCAL_OCR_SDK),
    },
  };
}

async function assertLocalOcrAvailable() {
  const [swift, script, sdk] = await Promise.all([
    stat(SWIFT_EXECUTABLE),
    stat(LOCAL_OCR_SCRIPT),
    stat(LOCAL_OCR_SDK),
  ]);
  if (!swift.isFile() || !script.isFile() || !sdk.isDirectory()) {
    throw new Error("required local Apple Vision OCR is unavailable");
  }
}

function serializableView(view, snapshotDir, file) {
  return {
    view_id: view.view_id,
    role: view.role,
    media_type: view.media_type,
    width: view.width,
    height: view.height,
    byte_length: view.byte_length,
    sha256: view.sha256,
    provenance_sha256: view.provenance_sha256,
    transform: view.transform,
    file: path.relative(snapshotDir, file),
  };
}

async function invokeLocalOcr(imagePaths) {
  const requested = imagePaths.map((file) => path.resolve(file));
  await mkdir(LOCAL_OCR_MODULE_CACHE, { recursive: true });
  let stdout;
  try {
    ({ stdout } = await execFile(SWIFT_EXECUTABLE, [LOCAL_OCR_SCRIPT, ...requested], {
      encoding: "utf8",
      env: {
        ...process.env,
        SDKROOT: LOCAL_OCR_SDK,
        CLANG_MODULE_CACHE_PATH: LOCAL_OCR_MODULE_CACHE,
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180_000,
    }));
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().slice(0, 2_000);
    throw new Error(`required local Apple Vision OCR failed: ${detail}`);
  }
  let raw;
  try { raw = JSON.parse(stdout); } catch {
    throw new Error("required local Apple Vision OCR returned invalid JSON");
  }
  return { parsed: parseLocalOcrOutput(raw, requested), rawBytes: Buffer.from(stdout) };
}

async function prepareLocalVisualEvidence({ frozen, snapshotDir, localOcrMode, attestation }) {
  const rawBytes = await readFile(frozen.raw_path);
  if (sha256(rawBytes) !== frozen.raw_sha256) {
    throw new Error(`raw snapshot hash mismatch: ${frozen.raw_file}`);
  }
  const preprocessed = await preprocessCatalogVisual(rawBytes);
  if (preprocessed.preprocessor_version !== VISUAL_PREPROCESS_VERSION
    || preprocessed.schema_version !== VISUAL_PREPROCESS_SCHEMA
    || preprocessed.source.sha256 !== frozen.raw_sha256) {
    throw new Error("visual preprocessor attestation mismatch");
  }

  const persistedViews = [];
  const viewPaths = [];
  const seenViewIds = new Set();
  const seenViewRoles = new Set();
  const seenViewPaths = new Set();
  const seenViewTuples = new Set();
  for (const view of preprocessed.views) {
    if (!LOCAL_OCR_VIEW_ROLES.has(view.role)) throw new Error(`preprocessor emitted unsupported view role ${view.role}`);
    if (sha256(view.bytes) !== view.sha256 || view.bytes.length !== view.byte_length) {
      throw new Error(`derived view integrity mismatch: ${view.view_id}`);
    }
    const extension = view.media_type === "image/png" ? "png" : "jpg";
    const file = path.join(snapshotDir, "derived", `${view.role}-${view.sha256}.${extension}`);
    const tuple = `${view.view_id}|${view.role}|${view.sha256}|${file}`;
    if (seenViewIds.has(view.view_id)
      || seenViewRoles.has(view.role)
      || seenViewPaths.has(file)
      || seenViewTuples.has(tuple)) {
      throw new Error(`preprocessor emitted duplicate view identity: ${tuple}`);
    }
    seenViewIds.add(view.view_id);
    seenViewRoles.add(view.role);
    seenViewPaths.add(file);
    seenViewTuples.add(tuple);
    await writeImmutableBytes(file, view.bytes, view.sha256);
    persistedViews.push(serializableView(view, snapshotDir, file));
    viewPaths.push(file);
  }

  const provenance = {
    schema_version: preprocessed.schema_version,
    preprocessor_version: preprocessed.preprocessor_version,
    source: preprocessed.source,
    analysis: preprocessed.analysis,
    views: persistedViews,
  };
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`);
  const provenanceSha = sha256(provenanceBytes);
  const provenanceFile = path.join(snapshotDir, "provenance", `${provenanceSha}.json`);
  await writeImmutableBytes(provenanceFile, provenanceBytes, provenanceSha);

  const common = {
    preprocessor: {
      schema_version: preprocessed.schema_version,
      version: preprocessed.preprocessor_version,
      source_sha256: preprocessed.source.sha256,
      analysis: preprocessed.analysis,
      views: persistedViews,
      provenance_sha256: provenanceSha,
      provenance_file: path.relative(snapshotDir, provenanceFile),
    },
  };
  if (localOcrMode === "off") {
    return { ...common, local_ocr: { mode: "off" }, auxiliary: undefined };
  }

  const evidenceKey = sha256(JSON.stringify({
    schema: LOCAL_VISUAL_OCR_SCHEMA,
    engine: LOCAL_VISUAL_OCR_ENGINE,
    script_sha256: attestation.local_ocr_script_sha256,
    runtime: attestation.local_ocr_runtime,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    views: persistedViews.map((view) => ({ role: view.role, sha256: view.sha256 })),
  }));
  const cacheFile = path.join(snapshotDir, "local-evidence-index.json");
  const cache = await readJsonIfPresent(cacheFile, {}, "local OCR cache index");
  const cached = cache[evidenceKey];
  let parsed;
  let rawSha;
  let rawFile;
  let reused = false;
  if (cached?.raw_file && /^[a-f0-9]{64}$/.test(cached?.raw_sha256 || "")) {
    rawFile = ensureUnderDirectory(snapshotDir, cached.raw_file, "cached OCR output");
    if (await fileExists(rawFile)) {
      const bytes = await readFile(rawFile);
      if (sha256(bytes) === cached.raw_sha256) {
        let raw;
        try {
          raw = JSON.parse(bytes.toString("utf8"));
        } catch (error) {
          throw new Error(`cached OCR output is invalid JSON: ${rawFile}`, { cause: error });
        }
        try {
          parsed = parseLocalOcrOutput(raw, viewPaths.map((file) => path.resolve(file)));
        } catch (error) {
          throw new Error(`cached OCR output is invalid: ${rawFile}`, { cause: error });
        }
        rawSha = cached.raw_sha256;
        reused = true;
      }
    }
  }
  if (!parsed) {
    const invoked = await invokeLocalOcr(viewPaths);
    parsed = invoked.parsed;
    rawSha = sha256(invoked.rawBytes);
    rawFile = path.join(snapshotDir, "ocr", `${rawSha}.json`);
    await writeImmutableBytes(rawFile, invoked.rawBytes, rawSha);
    cache[evidenceKey] = {
      raw_sha256: rawSha,
      raw_file: path.relative(snapshotDir, rawFile),
      schema_version: parsed.schema_version,
      engine: parsed.engine,
      script_sha256: attestation.local_ocr_script_sha256,
      runtime: attestation.local_ocr_runtime,
      view_sha256: persistedViews.map((view) => view.sha256),
    };
    await atomicJson(cacheFile, cache);
  }

  const pathToView = new Map(viewPaths.map((file, index) => [path.resolve(file), persistedViews[index]]));
  const ocrViews = parsed.images.map((image) => {
    const view = pathToView.get(image.path);
    if (!view || !LOCAL_OCR_VIEW_ROLES.has(view.role)) throw new Error(`OCR returned an unpermitted image path: ${image.path}`);
    return {
      role: view.role,
      view_sha256: view.sha256,
      width: image.width,
      height: image.height,
      observations: image.observations,
    };
  });
  const trustedByLiteral = new Map();
  const trustedCandidates = ocrViews.flatMap((view) => view.observations
    .filter((row) => row.confidence >= WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE)
    .map((row) => ({
      text: row.text,
      confidence: row.confidence,
      view_role: view.role,
      view_sha256: view.view_sha256,
      bounding_box: row.bounding_box,
    })));
  for (const row of trustedCandidates) {
    // A tiled MAIN repeats the exact same OCR literal at several coordinates.
    // Keep one deterministic representative per sealed view/literal so those
    // duplicates cannot exhaust the 100-row safety cap. View identity remains
    // part of the key, preserving cross-view corroboration and one spatial box
    // for stacked-badge adjacency within each view.
    const key = [
      row.view_sha256,
      row.text.trim().replace(/\s+/g, " ").toLowerCase(),
    ].join("|");
    const prior = trustedByLiteral.get(key);
    if (!prior || row.confidence > prior.confidence) {
      trustedByLiteral.set(key, row);
    }
  }
  const trustedUnique = [...trustedByLiteral.values()];
  const auxiliary = { ocr_texts: trustedUnique.slice(0, 100) };
  return {
    ...common,
    local_ocr: {
      mode: "required",
      schema_version: parsed.schema_version,
      engine: parsed.engine,
      script_sha256: attestation.local_ocr_script_sha256,
      runtime: attestation.local_ocr_runtime,
      evidence_key: evidenceKey,
      raw_sha256: rawSha,
      raw_file: path.relative(snapshotDir, rawFile),
      reused,
      auxiliary_selection: {
        minimum_confidence: WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE,
        trusted_candidates: trustedCandidates.length,
        unique_literals: trustedUnique.length,
        passed_to_comparator: auxiliary.ocr_texts.length,
        truncated: trustedUnique.length > auxiliary.ocr_texts.length,
      },
      views: ocrViews,
    },
    auxiliary,
  };
}

function decideWithLocalEvidence(caseInput, image, observation, localVisualEvidence) {
  const decision = decideBlind(caseInput, image, observation, localVisualEvidence.auxiliary);
  if (decision.verdict !== "PASS" || !localVisualEvidence.local_ocr?.auxiliary_selection?.truncated) {
    return decision;
  }
  return {
    ...decision,
    verdict: "REVIEW",
    unknowns: [...decision.unknowns, "local OCR evidence exceeded the conservative comparator limit"],
  };
}

function modelAttachmentFromEvidence(evidence, snapshotDir) {
  const fullViews = evidence.preprocessor.views.filter((view) => view.role === "full");
  if (fullViews.length !== 1 || fullViews[0].media_type !== "image/jpeg") {
    throw new Error("preprocessor must emit exactly one JPEG full view for the worker");
  }
  return {
    role: "full",
    sha256: fullViews[0].sha256,
    file: fullViews[0].file,
    path: ensureUnderDirectory(snapshotDir, fullViews[0].file, "model full attachment"),
  };
}

function extensionForFormat(format) {
  return ({ jpeg: "jpg", png: "png", webp: "webp", gif: "gif", tiff: "tif", avif: "avif" })[format] ?? "bin";
}

async function readResponseWithLimit(response, limit) {
  if (!response.body) throw new Error("response body is missing");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`response exceeds ${limit} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function fetchImageOnce(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "SS-Walmart-ReadOnly-Visual-Pilot/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`image fetch HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error(`image exceeds ${MAX_IMAGE_BYTES} bytes`);
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) throw new Error(`unexpected content-type ${contentType || "missing"}`);
  const raw = await readResponseWithLimit(response, MAX_IMAGE_BYTES);
  if (!raw.length || raw.length > MAX_IMAGE_BYTES) throw new Error(`invalid image byte length ${raw.length}`);
  return { raw, contentType };
}

async function freezeImage(input, dirs, prior) {
  const cached = prior?.[input.url];
  if (cached) {
    const rawPath = path.join(dirs.runDir, cached.raw_file);
    const normalizedPath = path.join(dirs.runDir, cached.normalized_file);
    if (await fileExists(rawPath) && await fileExists(normalizedPath)) {
      const [raw, normalized] = await Promise.all([readFile(rawPath), readFile(normalizedPath)]);
      if (sha256(raw) === cached.raw_sha256 && sha256(normalized) === cached.normalized_sha256) {
        return { ...cached, raw_path: rawPath, normalized_path: normalizedPath, reused_frozen_bytes: true };
      }
    }
  }

  const { raw, contentType } = await fetchImageOnce(input.url);
  const rawSha = sha256(raw);
  let metadata;
  try { metadata = await sharp(raw).metadata(); } catch (error) {
    throw new Error(`image decode failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error("image dimensions/format unavailable");
  const normalized = await sharp(raw)
    .rotate()
    .resize(NORMALIZED_MAX_PX, NORMALIZED_MAX_PX, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: NORMALIZED_JPEG_QUALITY, chromaSubsampling: "4:4:4" })
    .toBuffer();
  const normalizedMeta = await sharp(normalized).metadata();
  const normalizedSha = sha256(normalized);
  const rawFile = path.join("raw", `${rawSha}.${extensionForFormat(metadata.format)}`);
  const normalizedFile = path.join("normalized", `${normalizedSha}.jpg`);
  const rawPath = path.join(dirs.runDir, rawFile);
  const normalizedPath = path.join(dirs.runDir, normalizedFile);
  if (!(await fileExists(rawPath))) await writeFile(rawPath, raw);
  if (!(await fileExists(normalizedPath))) await writeFile(normalizedPath, normalized);
  return {
    url: input.url,
    slot: input.slot,
    surface: input.surface,
    buyer_facing_verified: input.buyer_facing_verified,
    content_type: contentType,
    raw_sha256: rawSha,
    raw_bytes: raw.length,
    raw_width: metadata.width,
    raw_height: metadata.height,
    raw_format: metadata.format,
    normalized_sha256: normalizedSha,
    normalized_bytes: normalized.length,
    normalized_width: normalizedMeta.width,
    normalized_height: normalizedMeta.height,
    normalization: `jpeg-max${NORMALIZED_MAX_PX}-q${NORMALIZED_JPEG_QUALITY}-444-white`,
    raw_file: rawFile,
    normalized_file: normalizedFile,
    raw_path: rawPath,
    normalized_path: normalizedPath,
    reused_frozen_bytes: false,
    frozen_at: new Date().toISOString(),
  };
}

function workerEndpoint(provider) {
  const generationUrl = process.env.CODEX_IMAGE_WORKER_URL;
  const token = process.env.CODEX_IMAGE_WORKER_TOKEN;
  if (!generationUrl || !token) throw new Error("subscription worker is not configured");
  const url = new URL(generationUrl);
  if (url.protocol !== "https:") throw new Error("subscription worker must use HTTPS");
  url.pathname = url.pathname.replace(/\/generate\/?$/, provider === "codex" ? "/analyze" : "/analyze-claude");
  if (!url.pathname.endsWith(provider === "codex" ? "/analyze" : "/analyze-claude")) {
    throw new Error("CODEX_IMAGE_WORKER_URL must end in /generate");
  }
  return { url, token };
}

function expectedWorkerProvider(provider) {
  return provider === "codex" ? "codex_cli_subscription" : "claude_cli_subscription";
}

export function validateHealthVisionContract(body, provider) {
  const expectedProvider = expectedWorkerProvider(provider);
  const expectedModel = REQUIRED_WORKER_MODELS[provider];
  const contract = body?.vision_contracts?.[expectedProvider];
  if (!contract || typeof contract !== "object") {
    throw new Error(`worker health has no runtime contract for ${expectedProvider}`);
  }
  if (contract.model !== expectedModel.model
    || contract.reasoning_effort !== expectedModel.reasoning_effort) {
    throw new Error(
      `worker vision model contract ${contract.model || "missing"}/${contract.reasoning_effort ?? "null"}`
      + ` != required ${expectedModel.model}/${expectedModel.reasoning_effort ?? "null"}`,
    );
  }
  for (const key of ["cli_version", "node_version", "platform", "arch"]) {
    if (typeof contract[key] !== "string" || !contract[key].trim()) {
      throw new Error(`worker health runtime contract is missing ${key}`);
    }
  }
  return {
    vision_model: contract.model,
    vision_reasoning_effort: contract.reasoning_effort,
    cli_version: contract.cli_version,
    node_version: contract.node_version,
    runtime_platform: contract.platform,
    runtime_arch: contract.arch,
  };
}

async function fetchWorkerContract(provider) {
  const { url } = workerEndpoint(provider);
  url.pathname = url.pathname.replace(/\/analyze(?:-claude)?\/?$/, "/health");
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => null);
  const expectedProvider = expectedWorkerProvider(provider);
  if (!response.ok || body?.ok !== true) throw new Error(`worker health failed: HTTP ${response.status}`);
  if (typeof body.worker_build !== "string" || !/^sha256:[a-f0-9]{64}$/.test(body.worker_build)) {
    throw new Error("worker health has no valid build attestation");
  }
  if (!Array.isArray(body.vision_providers) || !body.vision_providers.includes(expectedProvider)) {
    throw new Error(`worker health does not attest ${expectedProvider}`);
  }
  return {
    worker_build: body.worker_build,
    vision_provider: expectedProvider,
    ...validateHealthVisionContract(body, provider),
  };
}

async function postWorkerOnce({ provider, images, prompt, workerContract }) {
  const endpoint = workerEndpoint(provider);
  const started = Date.now();
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify({ prompt, images }),
      signal: AbortSignal.timeout(220_000),
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* captured as transport failure below */ }
    const expectedProvider = expectedWorkerProvider(provider);
    const attestedImageCount = Number.isInteger(body?.input_image_count)
      ? body.input_image_count
      : Number(response.headers.get("x-vision-image-count") || NaN);
    const workerProvider = body?.vision_provider ?? null;
    const workerBuild = body?.worker_build ?? null;
    const runtimeContract = {
      vision_model: body?.vision_model ?? null,
      vision_reasoning_effort: body?.vision_reasoning_effort ?? null,
      cli_version: body?.cli_version ?? null,
      node_version: body?.node_version ?? null,
      runtime_platform: body?.runtime_platform ?? null,
      runtime_arch: body?.runtime_arch ?? null,
    };
    const basicResultOk = response.ok
      && body?.ok === true
      && body?.result
      && typeof body.result === "object"
      && !Array.isArray(body.result);
    const contractErrors = [];
    if (attestedImageCount !== images.length) {
      contractErrors.push(`input_image_count ${Number.isFinite(attestedImageCount) ? attestedImageCount : "missing"} != ${images.length}`);
    }
    if (workerProvider !== expectedProvider) {
      contractErrors.push(`vision_provider ${workerProvider || "missing"} != ${expectedProvider}`);
    }
    if (typeof workerBuild !== "string" || !/^sha256:[a-f0-9]{64}$/.test(workerBuild)) {
      contractErrors.push("worker_build attestation missing or invalid");
    } else if (workerBuild !== workerContract.worker_build) {
      contractErrors.push(`worker_build ${workerBuild} != health-attested ${workerContract.worker_build}`);
    }
    for (const [key, value] of Object.entries(runtimeContract)) {
      if (value !== workerContract[key]) {
        contractErrors.push(`${key} ${value ?? "missing"} != health-attested ${workerContract[key] ?? "null"}`);
      }
    }
    const workerContractAttested = contractErrors.length === 0;
    const ok = basicResultOk && workerContractAttested;
    return {
      ok,
      retryable: response.status === 429 || response.status >= 500,
      status: response.status,
      duration_ms: Date.now() - started,
      result: body?.result ?? null,
      error: ok
        ? null
        : response.ok
          ? (body?.error || contractErrors.join("; ") || (body ? "missing result" : "invalid JSON"))
          : (body?.error || `HTTP ${response.status}`),
      attested_image_count: attestedImageCount,
      worker_provider: workerProvider,
      worker_build: workerBuild,
      ...runtimeContract,
      worker_model_runtime_attested: Object.entries(runtimeContract)
        .every(([key, value]) => value === workerContract[key]),
      worker_contract_attested: workerContractAttested,
    };
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      status: null,
      duration_ms: Date.now() - started,
      result: null,
      error: error instanceof Error ? error.message : String(error),
      attested_image_count: NaN,
      worker_provider: null,
      worker_build: null,
      vision_model: null,
      vision_reasoning_effort: null,
      cli_version: null,
      node_version: null,
      runtime_platform: null,
      runtime_arch: null,
      worker_model_runtime_attested: false,
      worker_contract_attested: false,
    };
  }
}

async function callTransport({
  provider, images, prompt, workerContract, callBudget, state, stateFile,
}) {
  const attempts = [];
  const maxAttempts = Number.isFinite(callBudget.max) ? 1 : 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (callBudget.used >= callBudget.max) {
      throw new Error(`subscription call budget exhausted at ${callBudget.used}/${callBudget.max}`);
    }
    callBudget.used += 1;
    state.subscription_calls_consumed = callBudget.used;
    await atomicJson(stateFile, state);
    const response = await postWorkerOnce({ provider, images, prompt, workerContract });
    attempts.push({
      attempt: attempt + 1,
      status: response.status,
      duration_ms: response.duration_ms,
      ok: response.ok,
      error: response.error || null,
      attested_image_count: Number.isFinite(response.attested_image_count) ? response.attested_image_count : null,
      worker_provider: response.worker_provider,
      worker_build: response.worker_build,
      vision_model: response.vision_model,
      vision_reasoning_effort: response.vision_reasoning_effort,
      cli_version: response.cli_version,
      node_version: response.node_version,
      runtime_platform: response.runtime_platform,
      runtime_arch: response.runtime_arch,
      worker_model_runtime_attested: response.worker_model_runtime_attested,
      worker_contract_attested: response.worker_contract_attested,
    });
    if (response.ok) return { response, attempts };
    if (!response.retryable || attempt === maxAttempts - 1) return { response, attempts };
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 2_000 : 5_000));
  }
  throw new Error("unreachable transport loop");
}

function imageIdFor(layoutName, batchIndex, position, normalizedSha) {
  return `i_${sha256(`${layoutName}|${batchIndex}|${position}|${normalizedSha}`).slice(0, 16)}`;
}

function visionCallIdentity({ provider, layoutName, batchIndex, items, workerContract }) {
  const imageIds = items.map((item, index) => (
    imageIdFor(layoutName, batchIndex, index, item.modelAttachment.sha256)
  ));
  const prompt = buildBlindObservationPrompt(imageIds);
  const promptSha = sha256(prompt);
  const callKey = sha256(JSON.stringify({
    provider,
    observation_schema: BLIND_OBSERVATION_SCHEMA,
    prompt_sha256: promptSha,
    worker_build: workerContract.worker_build,
    vision_contract: {
      vision_model: workerContract.vision_model,
      vision_reasoning_effort: workerContract.vision_reasoning_effort,
      cli_version: workerContract.cli_version,
      node_version: workerContract.node_version,
      runtime_platform: workerContract.runtime_platform,
      runtime_arch: workerContract.runtime_arch,
    },
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    full_view_sha256: items.map((item) => item.modelAttachment.sha256),
  }));
  return { imageIds, prompt, promptSha, callKey };
}

async function executeVisionCall({
  provider, layoutName, batchIndex, items, state, stateFile, workerContract, callBudget,
}) {
  const { imageIds, prompt, promptSha, callKey } = visionCallIdentity({
    provider, layoutName, batchIndex, items, workerContract,
  });
  const prior = state.calls?.[callKey];
  const normallyReusable = prior?.schema_valid && prior?.observations
    && prior?.worker_contract_attested && prior?.worker_model_runtime_attested;
  const recoveredReusable = prior?.schema_valid && prior?.observations
    && prior?.recovery_result_reusable === true
    && prior?.recovery_provenance_validated === true
    && prior?.recovery?.session_log_locally_revalidated === true;
  if (normallyReusable || recoveredReusable) {
    const observations = parseBlindResponse(prior.observations, imageIds);
    return { ...prior, call_key: callKey, image_ids: imageIds, prompt_sha256: promptSha, observations, resumed: true };
  }

  // Only the deterministic full view is sent to the worker. Detail crops are
  // local-OCR-only evidence and never alter model image count or grid semantics.
  const imageB64 = await Promise.all(items.map(async (item) => (await readFile(item.modelAttachment.path)).toString("base64")));
  const transport = await callTransport({
    provider,
    images: imageB64,
    prompt,
    workerContract,
    callBudget,
    state,
    stateFile,
  });
  let observations = null;
  let schemaError = null;
  if (transport.response.ok) {
    try { observations = parseBlindResponse(transport.response.result, imageIds); }
    catch (error) { schemaError = error instanceof Error ? error.message : String(error); }
  }
  const record = {
    call_key: callKey,
    provider,
    prompt_version: BLIND_PROMPT_VERSION,
    prompt_sha256: promptSha,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    image_ids: imageIds,
    full_view_sha256: items.map((item) => item.modelAttachment.sha256),
    transport_attempts: transport.attempts,
    transport_ok: transport.response.ok,
    schema_valid: !!observations,
    schema_error: schemaError,
    image_count_attested: transport.response.attested_image_count === items.length,
    worker_contract_attested: transport.response.worker_contract_attested,
    worker_provider: transport.response.worker_provider,
    worker_build: transport.response.worker_build,
    vision_model: transport.response.vision_model,
    vision_reasoning_effort: transport.response.vision_reasoning_effort,
    cli_version: transport.response.cli_version,
    node_version: transport.response.node_version,
    runtime_platform: transport.response.runtime_platform,
    runtime_arch: transport.response.runtime_arch,
    worker_model_runtime_attested: transport.response.worker_model_runtime_attested,
    observations: transport.response.result,
    completed_at: new Date().toISOString(),
  };
  state.calls ??= {};
  state.calls[callKey] = record;
  await atomicJson(stateFile, state);
  return { ...record, observations, resumed: false };
}

async function runBatchWithSchemaFallback(args) {
  const primary = await executeVisionCall(args);
  if (primary.observations) return { primary, fallback: [], observations: primary.observations };
  if (Number.isFinite(args.callBudget.max)) {
    return { primary, fallback: [], observations: null };
  }
  // A malformed multi-image response is retried one image at a time. This can
  // recover the report, but first-attempt schema reliability remains failed.
  if (args.items.length === 1) return { primary, fallback: [], observations: null };
  const fallback = [];
  const observations = [];
  for (let index = 0; index < args.items.length; index++) {
    const item = args.items[index];
    const one = await executeVisionCall({
      ...args,
      layoutName: `${args.layoutName}-schema-fallback`,
      batchIndex: args.batchIndex * 100 + index,
      items: [item],
    });
    fallback.push(one);
    if (!one.observations) return { primary, fallback, observations: null };
    observations.push(one.observations[0]);
  }
  return { primary, fallback, observations };
}

function aggregateVerdicts(verdicts) {
  if (verdicts.includes("TECHNICAL_ERROR")) return "TECHNICAL_ERROR";
  if (verdicts.length && verdicts.every((verdict) => verdict === "PASS")) return "PASS";
  if (verdicts.length && verdicts.every((verdict) => verdict === "BAD")) return "BAD";
  return "REVIEW";
}

function inspectDeclaredLayoutCoverage(manifest, layouts) {
  const expectedCaseIds = new Set(manifest.cases.map((item) => item.case_id));
  const expectedSkuByCase = new Map(manifest.cases.map((item) => [item.case_id, item.sku]));
  const plannedByName = new Map();
  const actualByName = new Map();
  const issues = [];

  for (const planned of manifest.layouts) {
    if (plannedByName.has(planned.name)) issues.push(`duplicate declared layout ${planned.name}`);
    else plannedByName.set(planned.name, planned);
  }
  for (const actual of layouts) {
    const entries = actualByName.get(actual.name) ?? [];
    entries.push(actual);
    actualByName.set(actual.name, entries);
  }
  for (const actualName of actualByName.keys()) {
    if (!plannedByName.has(actualName)) issues.push(`undeclared layout ${actualName}`);
  }

  for (const [name, planned] of plannedByName) {
    const matches = actualByName.get(name) ?? [];
    if (matches.length !== 1) {
      issues.push(`${name}: expected exactly one layout result, found ${matches.length}`);
      continue;
    }
    const actual = matches[0];
    if (actual.batch_size !== planned.batch_size || actual.shuffle_seed !== planned.shuffle_seed) {
      issues.push(`${name}: layout parameters do not match the manifest`);
    }
    const expectedCallCount = Math.ceil(manifest.cases.length / planned.batch_size);
    if (!Array.isArray(actual.calls) || actual.calls.length !== expectedCallCount) {
      issues.push(`${name}: expected ${expectedCallCount} calls, found ${Array.isArray(actual.calls) ? actual.calls.length : "invalid"}`);
    } else {
      for (let callIndex = 0; callIndex < actual.calls.length; callIndex++) {
        const expectedImageCount = Math.min(
          planned.batch_size,
          manifest.cases.length - callIndex * planned.batch_size,
        );
        const ids = actual.calls[callIndex]?.primary?.image_ids;
        if (!Array.isArray(ids) || ids.length !== expectedImageCount || new Set(ids).size !== ids.length) {
          issues.push(`${name}: call ${callIndex + 1} does not cover exactly ${expectedImageCount} unique images`);
        }
      }
    }

    const resultCounts = new Map();
    if (!Array.isArray(actual.case_results)) {
      issues.push(`${name}: case_results is invalid`);
      continue;
    }
    for (const result of actual.case_results) {
      if (!expectedCaseIds.has(result.case_id)) {
        issues.push(`${name}: unexpected case result ${result.case_id ?? "missing"}`);
        continue;
      }
      if (result.sku !== expectedSkuByCase.get(result.case_id)) {
        issues.push(`${name}: SKU mismatch for ${result.case_id}`);
      }
      resultCounts.set(result.case_id, (resultCounts.get(result.case_id) ?? 0) + 1);
    }
    for (const caseId of expectedCaseIds) {
      const count = resultCounts.get(caseId) ?? 0;
      if (count !== 1) issues.push(`${name}: expected one result for ${caseId}, found ${count}`);
    }
    if (actual.case_results.length !== manifest.cases.length) {
      issues.push(`${name}: expected ${manifest.cases.length} total case results, found ${actual.case_results.length}`);
    }
  }

  return { complete: issues.length === 0, issues };
}

function inspectGateBTopology(manifest) {
  const issues = [];
  if (manifest.purpose !== "golden-pilot") {
    issues.push("Gate B requires purpose=golden-pilot");
  }
  const required = new Map([
    ["batch-4", { batch_size: 4, shuffle: "ordered" }],
    ["batch-4-shuffled", { batch_size: 4, shuffle: "seeded" }],
    ["singleton", { batch_size: 1, shuffle: "ordered" }],
  ]);
  const actual = new Map((manifest.layouts ?? []).map((layout) => [layout.name, layout]));
  if (actual.size !== required.size) {
    issues.push(`Gate B requires exactly ${required.size} layouts, found ${actual.size}`);
  }
  for (const [name, rule] of required) {
    const layout = actual.get(name);
    if (!layout) {
      issues.push(`Gate B layout ${name} is missing`);
      continue;
    }
    if (layout.batch_size !== rule.batch_size) {
      issues.push(`Gate B layout ${name} must use batch_size=${rule.batch_size}`);
    }
    if (rule.shuffle === "ordered" && layout.shuffle_seed !== null) {
      issues.push(`Gate B layout ${name} must be ordered`);
    }
    if (rule.shuffle === "seeded" && !Number.isInteger(layout.shuffle_seed)) {
      issues.push(`Gate B layout ${name} must use an explicit integer shuffle seed`);
    }
  }
  for (const name of actual.keys()) {
    if (!required.has(name)) issues.push(`Gate B has unsupported extra layout ${name}`);
  }
  return { complete: issues.length === 0, issues };
}

function expectedCallKeyFromRecord(record, execution) {
  const visionContract = {
    vision_model: execution.vision_model_attested,
    vision_reasoning_effort: execution.vision_reasoning_effort_attested,
    cli_version: execution.cli_version_attested,
    node_version: execution.node_version_attested,
    runtime_platform: execution.runtime_platform_attested,
    runtime_arch: execution.runtime_arch_attested,
  };
  return sha256(JSON.stringify({
    provider: record.provider,
    observation_schema: execution.observation_schema,
    prompt_sha256: record.prompt_sha256,
    worker_build: record.worker_build,
    vision_contract: visionContract,
    preprocessor_version: record.preprocessor_version,
    full_view_sha256: record.full_view_sha256,
  }));
}

function assertGateBCallIdentity(record, execution) {
  if (!record || typeof record !== "object" || !execution || typeof execution !== "object") {
    throw new Error("call or execution context is missing");
  }
  const ids = record.image_ids;
  const hashes = record.full_view_sha256;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IMAGES_PER_CALL
    || new Set(ids).size !== ids.length
    || !Array.isArray(hashes) || hashes.length !== ids.length) {
    throw new Error("call image/hash vector is invalid");
  }
  for (const id of ids) exactString(id, "call image_id");
  for (const hash of hashes) exactSha(hash, "call full-view SHA-256");
  if (record.provider !== execution.provider
    || record.prompt_version !== execution.prompt_version
    || record.prompt_version !== BLIND_PROMPT_VERSION
    || record.preprocessor_version !== execution.preprocessor_version
    || record.worker_build !== execution.worker_build_attested
    || record.prompt_sha256 !== sha256(buildBlindObservationPrompt(ids))
    || record.call_key !== expectedCallKeyFromRecord(record, execution)) {
    throw new Error("call identity does not match the execution contract");
  }
  parseStoredBlindObservations(record.observations, ids);
}

function exactRecoveredVisualLink(link) {
  exactObjectKeys(link, [
    "kind", "deterministic", "cryptographic", "byte_identical", "reason", "policy",
    "sharp_version", "libvips_version", "metrics",
  ], "recovered deterministic visual link");
  if (link.kind !== "deterministic_canonical_pixel_similarity"
    || link.deterministic !== true
    || link.cryptographic !== false
    || link.byte_identical !== false
    || !equalJson(link.policy, RECOVERED_SESSION_VISUAL_LINK_POLICY)) {
    throw new Error("recovered deterministic visual-link policy mismatch");
  }
  exactString(link.reason, "recovered visual-link reason");
  exactString(link.sharp_version, "recovered Sharp version");
  exactString(link.libvips_version, "recovered libvips version");
  const metrics = exactObjectKeys(link.metrics, [
    "mean_absolute_error", "root_mean_square_error", "pearson_correlation",
    "fraction_absolute_difference_above_8", "fraction_absolute_difference_above_16",
  ], "recovered visual-link metrics");
  if (Object.values(metrics).some((value) => !Number.isFinite(value))
    || metrics.mean_absolute_error < 0
    || metrics.root_mean_square_error < 0
    || metrics.pearson_correlation < -1 || metrics.pearson_correlation > 1
    || metrics.fraction_absolute_difference_above_8 < 0
    || metrics.fraction_absolute_difference_above_8 > 1
    || metrics.fraction_absolute_difference_above_16 < 0
    || metrics.fraction_absolute_difference_above_16 > 1
    || metrics.mean_absolute_error > link.policy.max_mean_absolute_error
    || metrics.root_mean_square_error > link.policy.max_root_mean_square_error
    || metrics.pearson_correlation < link.policy.min_pearson_correlation
    || metrics.fraction_absolute_difference_above_8
      > link.policy.max_fraction_absolute_difference_above_8
    || metrics.fraction_absolute_difference_above_16
      > link.policy.max_fraction_absolute_difference_above_16) {
    throw new Error("recovered deterministic visual-link metrics are outside policy");
  }
}

function assertNormalHttpExecutionProvenance(record, execution) {
  assertGateBCallIdentity(record, execution);
  const attempts = record.transport_attempts;
  if (record.recovery !== undefined || record.recovery_provenance_validated === true
    || record.recovery_result_reusable === true
    || record.transport_ok !== true
    || record.schema_valid !== true
    || record.schema_error !== null
    || record.image_count_attested !== true
    || record.worker_contract_attested !== true
    || record.worker_model_runtime_attested !== true
    || record.worker_provider !== execution.vision_provider_attested
    || record.vision_model !== execution.vision_model_attested
    || record.vision_reasoning_effort !== execution.vision_reasoning_effort_attested
    || record.cli_version !== execution.cli_version_attested
    || record.node_version !== execution.node_version_attested
    || record.runtime_platform !== execution.runtime_platform_attested
    || record.runtime_arch !== execution.runtime_arch_attested
    || !Array.isArray(attempts) || attempts.length !== 1) {
    throw new Error("normal HTTP call attestation is incomplete");
  }
  const attempt = exactObjectKeys(attempts[0], [
    "attempt", "status", "duration_ms", "ok", "error", "attested_image_count",
    "worker_provider", "worker_build", "vision_model", "vision_reasoning_effort",
    "cli_version", "node_version", "runtime_platform", "runtime_arch",
    "worker_model_runtime_attested", "worker_contract_attested",
  ], "normal HTTP transport attempt");
  if (attempt?.attempt !== 1 || attempt.status !== 200 || attempt.ok !== true
    || attempt.error !== null
    || !Number.isFinite(attempt.duration_ms) || attempt.duration_ms < 0
    || attempt.attested_image_count !== record.image_ids.length
    || attempt.worker_provider !== execution.vision_provider_attested
    || attempt.worker_build !== execution.worker_build_attested
    || attempt.vision_model !== execution.vision_model_attested
    || attempt.vision_reasoning_effort !== execution.vision_reasoning_effort_attested
    || attempt.cli_version !== execution.cli_version_attested
    || attempt.node_version !== execution.node_version_attested
    || attempt.runtime_platform !== execution.runtime_platform_attested
    || attempt.runtime_arch !== execution.runtime_arch_attested
    || attempt.worker_contract_attested !== true
    || attempt.worker_model_runtime_attested !== true) {
    throw new Error("normal HTTP transport attempt is not exactly attested");
  }
}

function assertRecoveredRawSessionExecutionProvenance(record, execution, options) {
  assertGateBCallIdentity(record, execution);
  if (options.isPrimary !== true
    || options.sourceReportsSealedAndVerified !== true
    || options.recoveryEvidenceRevalidated !== true
    || record.image_ids.length !== 1
    || record.schema_valid !== true
    || record.schema_error !== null
    || record.recovery_provenance_validated !== true
    || record.recovery_result_reusable !== true
    || record.transport_ok !== null
    || record.image_count_attested !== false
    || record.worker_contract_attested !== false
    || record.worker_model_runtime_attested !== false
    || record.worker_provider !== null
    || record.vision_model !== null
    || record.vision_reasoning_effort !== null
    || record.cli_version !== null
    || record.node_version !== null
    || record.runtime_platform !== null
    || record.runtime_arch !== null) {
    throw new Error("recovered call is not an isolated, revalidated primary record");
  }
  const attempts = record.transport_attempts;
  if (!Array.isArray(attempts) || attempts.length !== 1) {
    throw new Error("recovered call must contain exactly one disconnected attempt");
  }
  const attempt = exactObjectKeys(attempts[0], [
    "attempt", "status", "duration_ms", "ok", "error", "attested_image_count",
    "worker_provider", "worker_build", "vision_model", "vision_reasoning_effort",
    "cli_version", "node_version", "runtime_platform", "runtime_arch",
    "worker_model_runtime_attested", "worker_contract_attested", "client_response_observed",
    "remote_session_completed", "recovered_after_client_disconnect",
  ], "recovered transport attempt");
  if (attempt.attempt !== 1
    || attempt.status !== null || attempt.duration_ms !== null || attempt.ok !== null
    || attempt.error !== "HTTP client disconnected before response; completed Codex session recovered offline"
    || attempt.attested_image_count !== null
    || attempt.worker_provider !== null || attempt.worker_build !== null
    || attempt.vision_model !== null || attempt.vision_reasoning_effort !== null
    || attempt.cli_version !== null || attempt.node_version !== null
    || attempt.runtime_platform !== null || attempt.runtime_arch !== null
    || attempt.worker_model_runtime_attested !== false
    || attempt.worker_contract_attested !== false
    || attempt.client_response_observed !== false
    || attempt.remote_session_completed !== true
    || attempt.recovered_after_client_disconnect !== true) {
    throw new Error("recovered disconnected attempt contains unsupported attestation");
  }
  const recovery = exactObjectKeys(record.recovery, [
    "schema_version", "recovery_id", "evidence_canonical_sha256", "session_id",
    "session_log_sha256", "session_log_bytes", "session_embedded_input_image_sha256",
    "source_full_view_sha256", "session_log_locally_revalidated", "client_response_observed",
    "http_status", "transport_duration_ms", "remote_session_model",
    "remote_session_reasoning_effort", "remote_session_cli_version",
    "deterministic_visual_binding", "checkpoint_pre_sha256", "recovered_at",
  ], "recovered provenance");
  if (recovery.schema_version !== RECOVERED_CALL_SCHEMA
    || !/^[a-f0-9-]{36}$/.test(recovery.session_id)
    || !Number.isSafeInteger(recovery.session_log_bytes)
    || recovery.session_log_bytes < 1 || recovery.session_log_bytes > 20 * 1024 * 1024
    || recovery.session_log_locally_revalidated !== true
    || recovery.client_response_observed !== false
    || recovery.http_status !== null || recovery.transport_duration_ms !== null
    || recovery.remote_session_model !== execution.vision_model_attested
    || recovery.remote_session_reasoning_effort !== execution.vision_reasoning_effort_attested
    || `codex-cli ${recovery.remote_session_cli_version}` !== execution.cli_version_attested
    || !equalJson(recovery.source_full_view_sha256, record.full_view_sha256)) {
    throw new Error("recovered session provenance does not match the execution contract");
  }
  exactString(recovery.recovery_id, "recovery_id");
  exactSha(recovery.evidence_canonical_sha256, "recovery evidence SHA-256");
  exactSha(recovery.session_log_sha256, "recovery session-log SHA-256");
  exactSha(recovery.session_embedded_input_image_sha256, "recovery embedded-image SHA-256");
  exactSha(recovery.checkpoint_pre_sha256, "recovery checkpoint SHA-256");
  exactIso(recovery.recovered_at, "recovered_at");
  exactIso(record.completed_at, "recovered call completed_at");
  exactRecoveredVisualLink(recovery.deterministic_visual_binding);
}

export function executionProvenanceKind(record, execution, options = {}) {
  try {
    if (record?.recovery_provenance_validated === true || record?.recovery !== undefined) {
      assertRecoveredRawSessionExecutionProvenance(record, execution, options);
      return "recovered_raw_session";
    }
    assertNormalHttpExecutionProvenance(record, execution);
    return "normal_http";
  } catch {
    return "invalid";
  }
}

export function evaluate(manifest, layouts, localOcrMode, context = {}) {
  const byCase = new Map(manifest.cases.map((item) => [item.case_id, []]));
  for (const layout of layouts) {
    for (const result of layout.case_results ?? []) {
      if (byCase.has(result.case_id)) byCase.get(result.case_id).push({ layout: layout.name, verdict: result.verdict });
    }
  }
  const layoutCoverage = inspectDeclaredLayoutCoverage(manifest, layouts);
  const gateBTopology = inspectGateBTopology(manifest);
  const cases = manifest.cases.map((item) => {
    const runs = byCase.get(item.case_id);
    const verdicts = runs.map((run) => run.verdict);
    const aggregate = aggregateVerdicts(verdicts);
    const truth = item.ground_truth?.verdict ?? null;
    return {
      case_id: item.case_id,
      sku: item.sku,
      truth,
      runs,
      aggregate,
      stable: new Set(verdicts).size === 1,
      false_pass_any_run: truth === "BAD" && verdicts.includes("PASS"),
      false_bad_any_run: truth === "PASS" && verdicts.includes("BAD"),
    };
  });
  const callEntries = layouts.flatMap((layout) => (layout.calls ?? []).flatMap(
    (call, batchIndex) => [
      { record: call.primary, isPrimary: true, layout: layout.name, batchIndex },
      ...(call.fallback ?? []).map((record, fallbackIndex) => ({
        record,
        isPrimary: false,
        layout: layout.name,
        batchIndex,
        fallbackIndex,
      })),
    ].filter((entry) => entry.record),
  ));
  const calls = callEntries.map((entry) => entry.record);
  const revalidatedRecoveredCallKeys = new Set(context.revalidatedRecoveredCallKeys ?? []);
  const provenanceEntries = callEntries.map((entry) => ({
    ...entry,
    kind: executionProvenanceKind(entry.record, context.execution, {
      isPrimary: entry.isPrimary,
      sourceReportsSealedAndVerified: context.sourceReportsSealedAndVerified === true,
      recoveryEvidenceRevalidated: revalidatedRecoveredCallKeys.has(entry.record.call_key),
    }),
  }));
  const recoveredEntries = provenanceEntries.filter((entry) => entry.kind === "recovered_raw_session");
  const invalidProvenanceEntries = provenanceEntries.filter((entry) => entry.kind === "invalid");
  const knownPass = cases.filter((item) => item.truth === "PASS");
  const knownBad = cases.filter((item) => item.truth === "BAD");
  const knownPassAutoPassRate = knownPass.length
    ? knownPass.filter((item) => item.aggregate === "PASS").length / knownPass.length
    : 0;
  const completeGroundTruth = cases.length > 0
    && cases.every((item) => item.truth === "PASS" || item.truth === "BAD")
    && knownPass.length > 0
    && knownBad.length > 0;
  const exactAgreementCases = cases.filter((item) => item.stable);
  const plannedPrimaryCalls = (manifest.layouts ?? []).reduce(
    (sum, layout) => sum + Math.ceil(manifest.cases.length / layout.batch_size),
    0,
  );
  const primaryEntries = callEntries.filter((entry) => entry.isPrimary);
  const fallbackEntries = callEntries.filter((entry) => !entry.isPrimary);
  const execution = context.execution;
  const safetyGates = {
    all_planned_layouts_completed: layoutCoverage.complete,
    golden_ground_truth_complete_with_pass_and_bad: completeGroundTruth,
    zero_false_pass: cases.every((item) => !item.false_pass_any_run),
    zero_false_bad: cases.every((item) => !item.false_bad_any_run),
    zero_technical_errors: cases.every((item) => !item.runs.some((run) => run.verdict === "TECHNICAL_ERROR")),
    all_known_bad_detected_every_layout: knownBad.every((item) => (
      item.runs.length > 0 && item.runs.every((run) => run.verdict === "BAD")
    )),
    all_known_pass_avoid_bad: knownPass.every((item) => item.aggregate !== "BAD"),
    cross_layout_pass_bad_contradictions_zero: cases.every((item) => !(
      item.runs.some((run) => run.verdict === "PASS")
      && item.runs.some((run) => run.verdict === "BAD")
    )),
    fail_closed_cross_layout_consistency_100pct: cases.every((item) => (
      item.truth === "BAD"
        ? item.runs.every((run) => run.verdict === "BAD")
        : item.runs.every((run) => run.verdict === "PASS" || run.verdict === "REVIEW")
    )),
    known_pass_auto_pass_rate_at_least_80pct: knownPassAutoPassRate >= 0.8,
    schema_valid_first_attempt_100pct: layouts.flatMap((layout) => layout.calls ?? []).every((call) => call.primary?.schema_valid),
    schema_fallback_calls_zero: fallbackEntries.length === 0,
    execution_provenance_validated_100pct: provenanceEntries.length > 0
      && invalidProvenanceEntries.length === 0,
    recovered_call_count_at_most_one: recoveredEntries.length <= 1,
    recovered_calls_primary_only: recoveredEntries.every((entry) => entry.isPrimary),
    exact_primary_call_and_attempt_accounting: layoutCoverage.complete
      && primaryEntries.length === plannedPrimaryCalls
      && primaryEntries.every((entry) => entry.record.transport_attempts?.length === 1),
    exact_layout_batch_membership_and_order_verified:
      context.layoutPlanBatchMembershipVerified === true,
    required_local_ocr_completed_100pct: localOcrMode === "required"
      && layouts.flatMap((layout) => layout.case_results ?? []).every(
        (result) => result.local_visual_evidence?.local_ocr?.mode === "required",
      ),
    no_paid_fallback: execution?.paid_api_fallback === false,
    no_remote_or_database_writes: execution?.remote_writes === 0
      && execution?.database_access === 0,
    zero_model_replay_certification: execution?.provider_mode === "zero-model-call-replay"
      && execution?.replay_model_calls === 0
      && execution?.subscription_calls_used === 0,
    sealed_evidence_chain_verified: context.sourceReportsSealedAndVerified === true,
  };
  const diagnostics = {
    cross_layout_exact_verdict_agreement_100pct: exactAgreementCases.length === cases.length,
    cross_layout_exact_verdict_agreement_rate: cases.length
      ? exactAgreementCases.length / cases.length
      : 0,
    cross_layout_exact_verdict_disagreement_case_ids: cases
      .filter((item) => !item.stable)
      .map((item) => item.case_id),
    cross_layout_exact_verdict_agreement_blocking: false,
    verdict_stability_100pct: exactAgreementCases.length === cases.length,
    verdict_stability_100pct_deprecated_alias: true,
    normal_worker_image_count_attested_100pct: calls.every((call) => call.image_count_attested === true),
    normal_worker_contract_attested_100pct: calls.every((call) => call.worker_contract_attested === true),
    normal_worker_model_runtime_attested_100pct: calls.every(
      (call) => call.worker_model_runtime_attested === true,
    ),
    normal_http_call_count: provenanceEntries.filter((entry) => entry.kind === "normal_http").length,
    recovered_raw_session_call_count: recoveredEntries.length,
    invalid_execution_provenance_call_keys: invalidProvenanceEntries.map(
      (entry) => entry.record.call_key ?? `${entry.layout}/${entry.batchIndex}`,
    ),
  };
  const declaredLayoutSafetyGo = Object.values(safetyGates).every(Boolean);
  const gateBRequiredGates = {
    gate_b_policy_v2: true,
    required_layout_topology_complete: gateBTopology.complete,
    ...safetyGates,
  };
  const gateBGo = Object.values(gateBRequiredGates).every(Boolean);
  const readinessGates = {
    algorithm_golden_passed: gateBGo,
    worker_image_count_attested_100pct: calls.every((call) => call.image_count_attested),
    worker_contract_attested_100pct: calls.every((call) => call.worker_contract_attested === true),
    worker_model_runtime_attested_100pct: calls.every(
      (call) => call.worker_model_runtime_attested === true,
    ),
    buyer_facing_snapshot_validated: false,
    shadow_main_50_completed: false,
    gallery_golden_and_pilot_completed: false,
  };
  return {
    gate_b_policy_version: GATE_B_POLICY_VERSION,
    cases,
    known_pass_auto_pass_rate: knownPassAutoPassRate,
    layout_coverage_issues: layoutCoverage.issues,
    gate_b_topology_issues: gateBTopology.issues,
    correctness_gates: safetyGates,
    gate_b_required_gates: gateBRequiredGates,
    diagnostics,
    declared_layout_safety_go: declaredLayoutSafetyGo,
    algorithm_go: gateBGo,
    gate_b_go: gateBGo,
    mass_run_readiness_gates: readinessGates,
    mass_run_go: Object.values(readinessGates).every(Boolean),
  };
}

function ensureWorkspaceFile(file, label) {
  const resolved = path.resolve(ROOT, file);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error(`${label} escapes the workspace`);
  }
  return resolved;
}

function ensureUnderDirectory(directory, file, label) {
  if (typeof file !== "string" || !file.trim() || path.isAbsolute(file)) {
    throw new Error(`${label} must be a relative file`);
  }
  const base = path.resolve(directory);
  const resolved = path.resolve(base, file);
  if (!resolved.startsWith(`${base}${path.sep}`)) throw new Error(`${label} escapes its snapshot`);
  return ensureWorkspaceFile(resolved, label);
}

async function replayFrozenSources(priors, manifest) {
  const byUrl = new Map();
  for (const { report } of priors) {
    if (typeof report.source_index_file !== "string") continue;
    const indexFile = ensureWorkspaceFile(report.source_index_file, "replay source index");
    const indexBytes = await readFile(indexFile);
    if (report.source_index_sha256 && sha256(indexBytes) !== report.source_index_sha256) {
      throw new Error(`replay source index hash mismatch: ${report.source_index_file}`);
    }
    let index;
    try {
      index = JSON.parse(indexBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`replay source index is invalid JSON: ${report.source_index_file}`, { cause: error });
    }
    const snapshotDir = path.dirname(indexFile);
    for (const [url, record] of Object.entries(index)) {
      if (record?.url !== url) throw new Error(`replay source index URL mismatch: ${url}`);
      const prior = byUrl.get(url);
      if (prior) {
        const priorIdentity = {
          raw_sha256: prior.record.raw_sha256,
          normalized_sha256: prior.record.normalized_sha256,
        };
        const nextIdentity = {
          raw_sha256: record.raw_sha256,
          normalized_sha256: record.normalized_sha256,
        };
        if (!equalJson(priorIdentity, nextIdentity)) {
          throw new Error(`conflicting replay frozen sources for ${url}`);
        }
        continue;
      }
      byUrl.set(url, { record, snapshotDir });
    }
  }
  const out = new Map();
  for (const item of manifest.cases) {
    const image = item.images[0];
    const source = byUrl.get(image.url);
    if (!source) throw new Error(`replay has no frozen source for ${item.case_id}`);
    if (source.record.slot !== image.slot
      || source.record.surface !== image.surface
      || source.record.buyer_facing_verified !== image.buyer_facing_verified) {
      throw new Error(`replay frozen source does not match manifest image metadata for ${item.case_id}`);
    }
    const normalizedPath = ensureUnderDirectory(
      source.snapshotDir,
      source.record.normalized_file,
      `replay normalized source for ${item.case_id}`,
    );
    const rawPath = ensureUnderDirectory(
      source.snapshotDir,
      source.record.raw_file,
      `replay raw source for ${item.case_id}`,
    );
    if (!(await fileExists(normalizedPath)) || !(await fileExists(rawPath))) {
      throw new Error(`replay frozen source is missing for ${item.case_id}`);
    }
    const [normalizedBytes, rawBytes] = await Promise.all([readFile(normalizedPath), readFile(rawPath)]);
    if (sha256(normalizedBytes) !== source.record.normalized_sha256
      || sha256(rawBytes) !== source.record.raw_sha256) {
      throw new Error(`replay frozen source hash mismatch for ${item.case_id}`);
    }
    out.set(item.case_id, {
      record: source.record,
      frozen: { ...source.record, normalized_path: normalizedPath, raw_path: rawPath },
      snapshotDir: source.snapshotDir,
    });
  }
  return out;
}

function recoveredRecordsFromPrior(prior) {
  const records = [];
  for (const layout of prior.report.layouts ?? []) {
    for (let batchIndex = 0; batchIndex < (layout.calls ?? []).length; batchIndex++) {
      const call = layout.calls[batchIndex];
      if (call.primary?.recovery_provenance_validated === true || call.primary?.recovery !== undefined) {
        records.push({
          record: call.primary,
          isPrimary: true,
          layout,
          batchIndex,
        });
      }
      for (let fallbackIndex = 0; fallbackIndex < (call.fallback ?? []).length; fallbackIndex++) {
        const record = call.fallback[fallbackIndex];
        if (record?.recovery_provenance_validated === true || record?.recovery !== undefined) {
          records.push({
            record,
            isPrimary: false,
            layout,
            batchIndex,
            fallbackIndex,
          });
        }
      }
    }
  }
  return records;
}

function validateRecoveryReceiptBody(receipt, prior, entry, evidence) {
  const body = exactObjectKeys(reportBodyWithoutSeal(receipt), [
    "schema_version", "recovery_id", "created_at", "mode", "manifest", "layout",
    "checkpoint", "evidence", "execution",
  ], "recovery receipt body");
  if (body.schema_version !== RECOVERY_RECEIPT_SCHEMA
    || body.recovery_id !== entry.record.recovery?.recovery_id
    || body.mode !== "offline-recover-only") {
    throw new Error("recovery receipt identity or mode mismatch");
  }
  exactIso(body.created_at, "recovery receipt created_at");
  const manifestReceipt = exactObjectKeys(body.manifest, ["path", "sha256"], "recovery receipt manifest");
  if (manifestReceipt.path !== prior.report.manifest.path
    || manifestReceipt.sha256 !== prior.report.manifest.sha256) {
    throw new Error("recovery receipt manifest mismatch");
  }
  const layoutReceipt = exactObjectKeys(body.layout, [
    "name", "selected_layout_plan_sha256", "batch_index", "call_key", "image_ids",
    "full_view_sha256",
  ], "recovery receipt layout");
  if (layoutReceipt.name !== entry.layout.name
    || layoutReceipt.selected_layout_plan_sha256 !== prior.report.execution.selected_layout_plan_sha256
    || layoutReceipt.batch_index !== entry.batchIndex
    || layoutReceipt.call_key !== entry.record.call_key
    || !equalJson(layoutReceipt.image_ids, entry.record.image_ids)
    || !equalJson(layoutReceipt.full_view_sha256, entry.record.full_view_sha256)) {
    throw new Error("recovery receipt layout/call binding mismatch");
  }
  const checkpoint = exactObjectKeys(body.checkpoint, [
    "path", "before_sha256", "after_sha256", "consumed_calls", "recorded_attempts",
  ], "recovery receipt checkpoint");
  exactString(checkpoint.path, "recovery receipt checkpoint path");
  exactSha(checkpoint.before_sha256, "recovery receipt before checkpoint");
  exactSha(checkpoint.after_sha256, "recovery receipt after checkpoint");
  if (checkpoint.before_sha256 !== entry.record.recovery.checkpoint_pre_sha256
    || checkpoint.before_sha256 !== evidence.checkpoint.pre_recovery_sha256
    || checkpoint.consumed_calls !== evidence.checkpoint.subscription_calls_consumed
    || checkpoint.recorded_attempts !== evidence.checkpoint.recorded_attempts + 1
    || checkpoint.recorded_attempts !== checkpoint.consumed_calls) {
    throw new Error("recovery receipt checkpoint accounting mismatch");
  }
  const evidenceReceipt = exactObjectKeys(body.evidence, [
    "path", "canonical_sha256", "session_log_path", "session_log_sha256",
    "source_index_sha256", "result_canonical_sha256", "image_link",
  ], "recovery receipt evidence");
  if (evidenceReceipt.canonical_sha256 !== entry.record.recovery.evidence_canonical_sha256
    || evidenceReceipt.canonical_sha256 !== sha256(canonicalJson(evidence))
    || evidenceReceipt.session_log_path !== evidence.source.local_file
    || evidenceReceipt.session_log_sha256 !== evidence.source.session_log_sha256
    || evidenceReceipt.session_log_sha256 !== entry.record.recovery.session_log_sha256
    || evidenceReceipt.source_index_sha256 !== prior.report.source_index_sha256
    || evidenceReceipt.result_canonical_sha256 !== evidence.source.result_canonical_sha256
    || evidenceReceipt.result_canonical_sha256 !== sha256(canonicalJson(evidence.result))) {
    throw new Error("recovery receipt evidence binding mismatch");
  }
  const execution = exactObjectKeys(body.execution, [
    "network_calls", "model_calls", "worker_health_calls", "image_downloads",
    "walmart_writes", "database_writes",
  ], "recovery receipt execution");
  if (Object.values(execution).some((value) => value !== 0)) {
    throw new Error("recovery receipt is not a zero-I/O offline recovery");
  }
  return evidenceReceipt;
}

async function revalidateOneRecoveredEvidenceChain(prior, entry, receipts, frozenSources) {
  if (entry.isPrimary !== true || prior.report.report_seal === undefined) {
    throw new Error("recovered replay call must be a primary in a sealed source report");
  }
  const matches = receipts.filter((receipt) => (
    receipt.recovery_id === entry.record.recovery?.recovery_id
    && receipt.layout?.call_key === entry.record.call_key
  ));
  if (matches.length !== 1) {
    throw new Error(`recovered call ${entry.record.call_key} requires exactly one sealed recovery receipt`);
  }
  const receipt = matches[0];
  verifySealedReport(receipt);
  const evidenceFile = ensureWorkspaceFile(receipt.evidence?.path, "recovery evidence file");
  const evidenceBytes = await readFile(evidenceFile);
  let evidence;
  try {
    evidence = JSON.parse(evidenceBytes.toString("utf8"));
  } catch (error) {
    throw new Error("recovery evidence is invalid JSON", { cause: error });
  }
  validateRecoveredCallEvidence(evidence);
  const evidenceReceipt = validateRecoveryReceiptBody(receipt, prior, entry, evidence);
  const binding = evidence.binding;
  if (binding.layout_name !== entry.layout.name
    || binding.batch_index !== entry.batchIndex
    || binding.call_key !== entry.record.call_key
    || binding.prompt_version !== entry.record.prompt_version
    || binding.prompt_sha256 !== entry.record.prompt_sha256
    || binding.worker_build !== entry.record.worker_build
    || !equalJson(binding.image_ids, entry.record.image_ids)
    || !equalJson(binding.full_view_sha256, entry.record.full_view_sha256)
    || entry.record.recovery.schema_version !== evidence.schema_version
    || entry.record.recovery.recovery_id !== evidence.recovery_id
    || entry.record.recovery.evidence_canonical_sha256 !== sha256(canonicalJson(evidence))
    || entry.record.recovery.session_id !== evidence.source.session_id
    || entry.record.recovery.session_log_sha256 !== evidence.source.session_log_sha256
    || entry.record.recovery.session_log_bytes !== evidence.source.session_log_bytes
    || entry.record.recovery.session_embedded_input_image_sha256
      !== evidence.source.embedded_input_image_sha256
    || entry.record.recovery.checkpoint_pre_sha256 !== evidence.checkpoint.pre_recovery_sha256
    || entry.record.recovery.recovered_at !== evidence.recovered_at
    || entry.record.completed_at !== evidence.source.completed_at
    || !equalJson(
      parseStoredBlindObservations(evidence.result, entry.record.image_ids),
      parseStoredBlindObservations(entry.record.observations, entry.record.image_ids),
    )) {
    throw new Error("recovery evidence does not match the sealed call record");
  }

  const matchingResults = (entry.layout.case_results ?? []).filter((result) => (
    entry.record.image_ids.includes(result.observation?.image_id)
  ));
  if (matchingResults.length !== 1) {
    throw new Error("recovered call must bind to exactly one case result");
  }
  const frozen = frozenSources.get(matchingResults[0].case_id);
  const fullViews = frozen?.record?.visual_evidence?.preprocessor?.views?.filter((view) => (
    view.role === "full" && view.sha256 === entry.record.full_view_sha256[0]
  )) ?? [];
  if (fullViews.length !== 1) throw new Error("recovered call has no unique frozen full-view source");
  const fullView = fullViews[0];
  const fullViewFile = ensureUnderDirectory(frozen.snapshotDir, fullView.file, "recovered full view");
  const sessionFile = ensureWorkspaceFile(evidenceReceipt.session_log_path, "recovery session log");
  const [localFullViewJpegBytes, sessionLogBytes] = await Promise.all([
    readFile(fullViewFile),
    readFile(sessionFile),
  ]);
  const promptBase = buildBlindObservationPrompt(entry.record.image_ids);
  const proof = await validateRecoveredCodexSessionProof({
    sessionLogBytes,
    localFullViewJpegBytes,
    expected: {
      session_log: {
        sha256: evidence.source.session_log_sha256,
        byte_length: evidence.source.session_log_bytes,
      },
      session: {
        id: evidence.source.session_id,
        cli_version: evidence.source.cli_version,
        model: evidence.source.model,
        reasoning_effort: evidence.source.reasoning_effort,
        started_at: evidence.source.started_at,
        completed_at: evidence.source.completed_at,
        duration_ms: evidence.source.duration_ms,
      },
      prompt: {
        base: promptBase,
        base_sha256: sha256(promptBase),
        wrapped: buildCodexVisionWrappedPrompt(promptBase, 1),
      },
      result: evidence.result,
      result_canonical_sha256: evidence.source.result_canonical_sha256,
      embedded_image: {
        sha256: evidence.source.embedded_input_image_sha256,
        byte_length: evidence.source.embedded_input_image_bytes,
        width: evidence.source.embedded_input_image_width,
        height: evidence.source.embedded_input_image_height,
      },
      local_full_view: {
        sha256: fullView.sha256,
        byte_length: fullView.byte_length,
        width: fullView.width,
        height: fullView.height,
      },
    },
  });
  if (!equalJson(proof.image_link, evidenceReceipt.image_link)
    || !equalJson(proof.image_link, entry.record.recovery.deterministic_visual_binding)) {
    throw new Error("recovered raw-session visual proof does not match the receipt and call record");
  }
  return {
    call_key: entry.record.call_key,
    recovery_id: entry.record.recovery.recovery_id,
    receipt_seal: receipt.report_seal.canonical_body_sha256,
    evidence_canonical_sha256: entry.record.recovery.evidence_canonical_sha256,
    session_log_sha256: entry.record.recovery.session_log_sha256,
    raw_session_proof_revalidated: true,
  };
}

export async function validateReplayRecoveryEvidenceChains(priors, frozenSources) {
  const validated = [];
  for (const prior of priors) {
    const entries = recoveredRecordsFromPrior(prior);
    if (entries.length === 0) continue;
    verifySealedReport(prior.report);
    const receiptNames = (await readdir(path.dirname(prior.priorPath)))
      .filter((name) => /^recovery-[A-Za-z0-9._-]+\.json$/.test(name));
    const receipts = await Promise.all(receiptNames.map(async (name) => {
      const file = path.join(path.dirname(prior.priorPath), name);
      const bytes = await readFile(file);
      let receipt;
      try {
        receipt = JSON.parse(bytes.toString("utf8"));
      } catch (error) {
        throw new Error(`recovery receipt ${name} is invalid JSON`, { cause: error });
      }
      return receipt;
    }));
    for (const entry of entries) {
      validated.push(await revalidateOneRecoveredEvidenceChain(prior, entry, receipts, frozenSources));
    }
  }
  if (new Set(validated.map((item) => item.call_key)).size !== validated.length) {
    throw new Error("duplicate recovered call in replay evidence chain");
  }
  return validated;
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} is not a SHA-256 digest`);
  }
}

function parseStoredBlindObservations(value, imageIds) {
  const response = Array.isArray(value)
    ? { schema_version: BLIND_OBSERVATION_SCHEMA, observations: value }
    : value;
  return parseBlindResponse(response, imageIds);
}

function validateReplayCallRecord({
  record,
  report,
  layoutName,
  batchIndex,
  fallbackIndex = null,
  observationByImageId,
  attachmentByImageId,
}) {
  const label = fallbackIndex === null
    ? `${layoutName} call ${batchIndex + 1}`
    : `${layoutName} call ${batchIndex + 1} fallback ${fallbackIndex + 1}`;
  if (!record || typeof record !== "object") throw new Error(`${label} record is missing`);
  const ids = record.image_ids;
  const hasFullViews = Array.isArray(record.full_view_sha256);
  const hasNormalized = Array.isArray(record.normalized_image_sha256);
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error(`${label} has invalid or duplicate image_ids`);
  }
  if (hasFullViews === hasNormalized) {
    throw new Error(`${label} must attest exactly one attachment hash vector`);
  }
  const attachmentKind = hasFullViews ? "full" : "normalized";
  const hashes = hasFullViews ? record.full_view_sha256 : record.normalized_image_sha256;
  if (hashes.length !== ids.length) throw new Error(`${label} image/hash cardinality mismatch`);
  hashes.forEach((hash, index) => assertSha256(hash, `${label} attachment ${index + 1}`));

  if (record.prompt_version !== report.execution.prompt_version
    || record.prompt_version !== BLIND_PROMPT_VERSION) {
    throw new Error(`${label} prompt version mismatch`);
  }
  if (record.provider !== report.execution.provider
    || record.worker_build !== report.execution.worker_build_attested) {
    throw new Error(`${label} worker attestation mismatch`);
  }
  const recovered = record.recovery_provenance_validated === true;
  const executionRuntime = {
    vision_model: report.execution.vision_model_attested,
    vision_reasoning_effort: report.execution.vision_reasoning_effort_attested,
    cli_version: report.execution.cli_version_attested,
    node_version: report.execution.node_version_attested,
    runtime_platform: report.execution.runtime_platform_attested,
    runtime_arch: report.execution.runtime_arch_attested,
  };
  if (recovered) {
    const attempt = Array.isArray(record.transport_attempts) && record.transport_attempts.length === 1
      ? record.transport_attempts[0]
      : null;
    const recovery = record.recovery;
    if (record.recovery_result_reusable !== true
      || record.worker_contract_attested !== false
      || record.worker_model_runtime_attested !== false
      || record.worker_provider !== null
      || record.image_count_attested !== false
      || record.transport_ok !== null
      || !attempt
      || attempt.status !== null || attempt.duration_ms !== null || attempt.ok !== null
      || attempt.client_response_observed !== false
      || attempt.remote_session_completed !== true
      || attempt.recovered_after_client_disconnect !== true
      || recovery?.session_log_locally_revalidated !== true
      || recovery?.client_response_observed !== false
      || recovery?.http_status !== null
      || recovery?.transport_duration_ms !== null
      || recovery?.source_full_view_sha256?.length !== hashes.length
      || !equalJson(recovery.source_full_view_sha256, hashes)
      || recovery?.deterministic_visual_binding?.deterministic !== true
      || recovery?.deterministic_visual_binding?.cryptographic !== false
      || recovery?.remote_session_model !== executionRuntime.vision_model
      || recovery?.remote_session_reasoning_effort !== executionRuntime.vision_reasoning_effort
      || `codex-cli ${recovery?.remote_session_cli_version}` !== executionRuntime.cli_version) {
      throw new Error(`${label} recovered session provenance is invalid or impersonates HTTP attestation`);
    }
    assertSha256(recovery.session_log_sha256, `${label} recovered session log`);
    assertSha256(recovery.session_embedded_input_image_sha256, `${label} recovered embedded image`);
  } else {
    if (record.worker_provider !== report.execution.vision_provider_attested) {
      throw new Error(`${label} worker provider attestation mismatch`);
    }
    if (record.worker_contract_attested !== true) throw new Error(`${label} worker contract is unattested`);
  }
  const hasRuntimeAttestation = record.worker_model_runtime_attested !== undefined
    || record.vision_model !== undefined
    || report.execution.vision_model_attested !== undefined;
  let replayVisionContract = recovered ? executionRuntime : null;
  if (!recovered && hasRuntimeAttestation) {
    if (record.worker_model_runtime_attested !== true) {
      throw new Error(`${label} worker model/runtime contract is unattested`);
    }
    replayVisionContract = {
      vision_model: record.vision_model,
      vision_reasoning_effort: record.vision_reasoning_effort,
      cli_version: record.cli_version,
      node_version: record.node_version,
      runtime_platform: record.runtime_platform,
      runtime_arch: record.runtime_arch,
    };
    if (!equalJson(replayVisionContract, executionRuntime)) {
      throw new Error(`${label} worker model/runtime attestation mismatch`);
    }
  }
  const promptSha = sha256(buildBlindObservationPrompt(ids));
  if (record.prompt_sha256 !== promptSha) throw new Error(`${label} prompt hash mismatch`);

  const effectiveLayoutName = fallbackIndex === null ? layoutName : `${layoutName}-schema-fallback`;
  const effectiveBatchIndex = fallbackIndex === null ? batchIndex : batchIndex * 100 + fallbackIndex;
  for (let index = 0; index < ids.length; index++) {
    const expectedId = imageIdFor(effectiveLayoutName, effectiveBatchIndex, index, hashes[index]);
    if (ids[index] !== expectedId) throw new Error(`${label} image_id/hash binding mismatch at position ${index + 1}`);
    if (attachmentByImageId.has(ids[index])) throw new Error(`duplicate replay image_id ${ids[index]}`);
    attachmentByImageId.set(ids[index], { kind: attachmentKind, sha256: hashes[index], label });
  }

  const expectedCallKey = sha256(JSON.stringify(attachmentKind === "full" ? {
    provider: record.provider,
    observation_schema: report.execution.observation_schema,
    prompt_sha256: record.prompt_sha256,
    worker_build: record.worker_build,
    ...(replayVisionContract ? { vision_contract: replayVisionContract } : {}),
    preprocessor_version: record.preprocessor_version,
    full_view_sha256: hashes,
  } : {
    provider: record.provider,
    observation_schema: report.execution.observation_schema,
    prompt_sha256: record.prompt_sha256,
    worker_build: record.worker_build,
    normalized_image_sha256: hashes,
  }));
  if (record.call_key !== expectedCallKey) throw new Error(`${label} call_key mismatch`);

  if (!record.schema_valid) return [];
  const observations = parseStoredBlindObservations(record.observations, ids);
  for (const observation of observations) {
    if (observationByImageId.has(observation.image_id)) {
      throw new Error(`duplicate replay observation ${observation.image_id}`);
    }
    observationByImageId.set(observation.image_id, observation);
  }
  return observations;
}

export function validateReplayReportBindings(priors, manifest, frozenSources) {
  const currentByCase = new Map(manifest.cases.map((item) => [item.case_id, item]));
  const plannedByLayout = new Map((manifest.layouts ?? []).map((layout) => [layout.name, layout]));
  const seenLayoutNames = new Set();

  for (const { report } of priors) {
    if (report.execution?.observation_schema !== BLIND_OBSERVATION_SCHEMA) {
      throw new Error("replay observation schema mismatch");
    }
    if (report.execution?.prompt_version !== BLIND_PROMPT_VERSION) {
      throw new Error("replay prompt version mismatch");
    }
    for (const layout of report.layouts) {
      if (seenLayoutNames.has(layout.name)) throw new Error(`duplicate replay layout ${layout.name}`);
      seenLayoutNames.add(layout.name);
      const plannedLayout = plannedByLayout.get(layout.name);
      if (!plannedLayout
        || layout.batch_size !== plannedLayout.batch_size
        || layout.shuffle_seed !== plannedLayout.shuffle_seed) {
        throw new Error(`replay layout ${layout.name} does not match the declared plan`);
      }
      const plannedCases = plannedLayout.shuffle_seed === null
        ? [...manifest.cases]
        : shuffledWithSeed(manifest.cases, plannedLayout.shuffle_seed);
      const observationByImageId = new Map();
      const authoritativeObservationByImageId = new Map();
      const attachmentByImageId = new Map();
      const resultCountByCase = new Map();
      const usedResultImageIds = new Set();
      const caseIdByObservationId = new Map();
      const finalObservationIdsByCall = [];

      for (let batchIndex = 0; batchIndex < (layout.calls ?? []).length; batchIndex++) {
        const call = layout.calls[batchIndex];
        const primaryObservations = validateReplayCallRecord({
          record: call.primary,
          report,
          layoutName: layout.name,
          batchIndex,
          observationByImageId,
          attachmentByImageId,
        });
        const fallbackObservations = [];
        for (let fallbackIndex = 0; fallbackIndex < (call.fallback ?? []).length; fallbackIndex++) {
          fallbackObservations.push(...validateReplayCallRecord({
            record: call.fallback[fallbackIndex],
            report,
            layoutName: layout.name,
            batchIndex,
            fallbackIndex,
            observationByImageId,
            attachmentByImageId,
          }));
        }
        if (call.observations) {
          const authoritative = primaryObservations.length ? primaryObservations : fallbackObservations;
          const finalIds = authoritative.map((observation) => observation.image_id);
          const finalObservations = parseStoredBlindObservations(call.observations, finalIds);
          if (!equalJson(finalObservations, authoritative)) {
            throw new Error(`${layout.name} call ${batchIndex + 1} final observations mismatch call records`);
          }
          for (const observation of finalObservations) {
            if (authoritativeObservationByImageId.has(observation.image_id)) {
              throw new Error(`duplicate authoritative replay observation ${observation.image_id}`);
            }
            authoritativeObservationByImageId.set(observation.image_id, observation);
          }
          finalObservationIdsByCall.push(finalIds);
        } else {
          finalObservationIdsByCall.push([]);
        }
      }

      for (const result of layout.case_results ?? []) {
        const current = currentByCase.get(result.case_id);
        if (!current || current.sku !== result.sku) throw new Error(`replay case mismatch: ${result.case_id}`);
        resultCountByCase.set(result.case_id, (resultCountByCase.get(result.case_id) ?? 0) + 1);
        if (resultCountByCase.get(result.case_id) > 1) {
          throw new Error(`duplicate replay case result ${layout.name}/${result.case_id}`);
        }
        const source = frozenSources.get(result.case_id);
        if (!source) throw new Error(`replay source binding is missing for ${result.case_id}`);
        if (result.raw_sha256 !== source.record.raw_sha256
          || result.normalized_sha256 !== source.record.normalized_sha256) {
          throw new Error(`replay case/source hash mismatch: ${result.case_id}`);
        }
        assertSha256(result.raw_sha256, `${result.case_id} raw source`);
        assertSha256(result.normalized_sha256, `${result.case_id} normalized source`);
        if (!result.observation) continue;
        if (usedResultImageIds.has(result.observation.image_id)) {
          throw new Error(`duplicate replay case observation ${layout.name}/${result.observation.image_id}`);
        }
        usedResultImageIds.add(result.observation.image_id);
        caseIdByObservationId.set(result.observation.image_id, result.case_id);
        const observation = authoritativeObservationByImageId.get(result.observation.image_id);
        const attachment = attachmentByImageId.get(result.observation.image_id);
        if (!observation || !attachment || !equalJson(result.observation, observation)) {
          throw new Error(`replay case/observation binding mismatch: ${result.case_id}`);
        }
        if (attachment.kind === "normalized") {
          if (result.normalized_sha256 !== attachment.sha256) {
            throw new Error(`replay normalized attachment mismatch: ${result.case_id}`);
          }
        } else {
          if (result.model_full_sha256 !== attachment.sha256) {
            throw new Error(`replay full-view attachment mismatch: ${result.case_id}`);
          }
          const fullViews = source.record.visual_evidence?.preprocessor?.views
            ?.filter((view) => view.role === "full") ?? [];
          if (fullViews.length !== 1 || fullViews[0].sha256 !== attachment.sha256) {
            throw new Error(`replay full-view/source evidence mismatch: ${result.case_id}`);
          }
        }
      }
      for (const imageId of authoritativeObservationByImageId.keys()) {
        if (!usedResultImageIds.has(imageId)) {
          throw new Error(`replay call observation is not bound to a case result: ${layout.name}/${imageId}`);
        }
      }
      for (let batchIndex = 0; batchIndex < finalObservationIdsByCall.length; batchIndex++) {
        const expectedCaseIds = plannedCases
          .slice(batchIndex * plannedLayout.batch_size, (batchIndex + 1) * plannedLayout.batch_size)
          .map((item) => item.case_id);
        const actualCaseIds = finalObservationIdsByCall[batchIndex]
          .map((imageId) => caseIdByObservationId.get(imageId) ?? null);
        if (!equalJson(actualCaseIds, expectedCaseIds)) {
          throw new Error(
            `replay layout ${layout.name} batch ${batchIndex + 1} case membership/order mismatch`,
          );
        }
      }
    }
  }
  return true;
}

function executionEvidenceAttestation(attestation, localOcrMode, replay = false) {
  return {
    runner_source_sha256: attestation.runner_source_sha256,
    comparator_version: attestation.comparator_version,
    comparator_source_sha256: attestation.comparator_source_sha256,
    preprocessor_schema: attestation.preprocessor_schema,
    preprocessor_version: attestation.preprocessor_version,
    preprocessor_source_sha256: attestation.preprocessor_source_sha256,
    local_ocr_mode: localOcrMode,
    local_ocr_schema: attestation.local_ocr_schema,
    local_ocr_engine: attestation.local_ocr_engine,
    local_ocr_script_sha256: attestation.local_ocr_script_sha256,
    local_ocr_runtime: attestation.local_ocr_runtime,
    model_attachment_roles: [replay ? "historical_report_observation" : "preprocessed_full"],
    preprocessed_full_sent_to_model: !replay,
    detail_crops_sent_to_model: false,
    report_write_contract: "immutable-wx-canonical-body-sha256/v1",
  };
}

export function aggregateReplaySourceExecutionSafety(priors) {
  const attestations = priors.map(({ report }) => ({
    report_id: report?.report_id,
    report_seal: report?.report_seal?.canonical_body_sha256 ?? null,
    paid_api_fallback: report?.execution?.paid_api_fallback,
    remote_writes: report?.execution?.remote_writes,
    database_access: report?.execution?.database_access,
  }));
  const paidValuesKnown = attestations.every(
    (item) => item.paid_api_fallback === false || item.paid_api_fallback === true,
  );
  const writeValuesKnown = attestations.every((item) => (
    Number.isSafeInteger(item.remote_writes) && item.remote_writes >= 0
    && Number.isSafeInteger(item.database_access) && item.database_access >= 0
  ));
  return {
    paid_api_fallback: paidValuesKnown
      ? attestations.some((item) => item.paid_api_fallback === true)
      : null,
    remote_writes: writeValuesKnown
      ? attestations.reduce((sum, item) => sum + item.remote_writes, 0)
      : null,
    database_access: writeValuesKnown
      ? attestations.reduce((sum, item) => sum + item.database_access, 0)
      : null,
    attestations,
  };
}

async function replayPriorReports({
  priorPaths, manifest, manifestPath, manifestSha, localOcrMode, attestation,
}) {
  const priors = await Promise.all(priorPaths.map(async (priorPath) => ({
    priorPath,
    report: JSON.parse(await readFile(priorPath, "utf8")),
  })));
  for (const { report } of priors) {
    if (report?.schema_version !== "walmart-visual-pilot-report/v1" || !Array.isArray(report.layouts)) {
      throw new Error("--replay input is not a v1 pilot report");
    }
    if (report.execution?.observation_schema !== BLIND_OBSERVATION_SCHEMA) {
      throw new Error(`replay observation schema ${report.execution?.observation_schema || "missing"} != ${BLIND_OBSERVATION_SCHEMA}`);
    }
    if (report.report_seal !== undefined) verifySealedReport(report);
  }
  const frozenSources = await replayFrozenSources(priors, manifest);
  const layoutPlanBatchMembershipVerified = validateReplayReportBindings(
    priors,
    manifest,
    frozenSources,
  );
  const recoveredEvidenceChains = await validateReplayRecoveryEvidenceChains(priors, frozenSources);
  const sourceReportsSealedAndVerified = priors.every(({ report }) => report.report_seal !== undefined);
  const evidenceByCase = new Map();
  for (const item of manifest.cases) {
    const source = frozenSources.get(item.case_id);
    const evidence = await prepareLocalVisualEvidence({
      frozen: source.frozen,
      snapshotDir: source.snapshotDir,
      localOcrMode,
      attestation,
    });
    evidenceByCase.set(item.case_id, evidence);
  }
  const prior = priors[0].report;
  // A replay is a new immutable report, not a mutation of the source report.
  // Never carry the source seal into the new body; writeSealedReport computes
  // a fresh seal after the replay decisions and provenance have been bound.
  const priorBody = reportBodyWithoutSeal(prior);
  const currentByCase = new Map(manifest.cases.map((item) => [item.case_id, item]));
  const layoutNames = new Set();
  const sourceLayouts = priors.flatMap(({ report }) => report.layouts).filter((layout) => {
    if (layoutNames.has(layout.name)) throw new Error(`duplicate replay layout ${layout.name}`);
    layoutNames.add(layout.name);
    return true;
  });
  const layouts = sourceLayouts.map((layout) => ({
    ...layout,
    case_results: layout.case_results.map((result) => {
      const current = currentByCase.get(result.case_id);
      if (!current || current.sku !== result.sku) throw new Error(`replay case mismatch: ${result.case_id}`);
      const localVisualEvidence = evidenceByCase.get(result.case_id);
      if (!result.observation) {
        return {
          ...result,
          verdict: "TECHNICAL_ERROR",
          technical_error: "prior observation unavailable",
          local_visual_evidence: localVisualEvidence,
        };
      }
      const [observation] = parseBlindResponse({
        schema_version: BLIND_OBSERVATION_SCHEMA,
        observations: [result.observation],
      }, [result.observation.image_id]);
      const decision = decideWithLocalEvidence(current, current.images[0], observation, localVisualEvidence);
      const fullView = localVisualEvidence.preprocessor.views.find((view) => view.role === "full");
      return {
        ...result,
        verdict: decision.verdict,
        decision,
        observation,
        replay_preprocessed_full_sha256: fullView?.sha256 ?? null,
        local_visual_evidence: localVisualEvidence,
      };
    }),
  }));
  const sourceExecutionSafety = aggregateReplaySourceExecutionSafety(priors);
  const replayExecution = {
    ...prior.execution,
    ...executionEvidenceAttestation(attestation, localOcrMode, true),
    provider_mode: "zero-model-call-replay",
    subscription_call_budget: 0,
    subscription_calls_used: 0,
    replay_model_calls: 0,
    replay_source_report_seals: priors.map(({ report }) => (
      report.report_seal === undefined ? "legacy_unsealed" : "verified"
    )),
    paid_api_fallback: sourceExecutionSafety.paid_api_fallback,
    remote_writes: sourceExecutionSafety.remote_writes,
    database_access: sourceExecutionSafety.database_access,
    source_execution_safety_attestations: sourceExecutionSafety.attestations,
    recovered_evidence_chains_revalidated: recoveredEvidenceChains,
  };
  const evaluation = evaluate(manifest, layouts, localOcrMode, {
    execution: replayExecution,
    sourceReportsSealedAndVerified,
    layoutPlanBatchMembershipVerified,
    revalidatedRecoveredCallKeys: recoveredEvidenceChains.map((item) => item.call_key),
  });
  const replay = {
    ...priorBody,
    report_id: `${manifest.manifest_id}-replay-${safeStamp()}`,
    created_at: new Date().toISOString(),
    replayed_from: priorPaths.map((priorPath) => path.relative(ROOT, priorPath)),
    execution: replayExecution,
    manifest: {
      path: path.relative(ROOT, manifestPath),
      id: manifest.manifest_id,
      sha256: manifestSha,
      cases: manifest.cases.length,
      buyer_facing_verified: manifest.cases.filter((item) => item.images[0].buyer_facing_verified).length,
      artifact_only: manifest.cases.filter((item) => !item.images[0].buyer_facing_verified).length,
    },
    layouts,
    evaluation,
  };
  const replayDir = path.join(ROOT, "data/audits/walmart-visual-pilot-replays");
  await mkdir(replayDir, { recursive: true });
  const { file: replayFile } = await writeSealedReport(replayDir, replay);
  console.log(`replay used 0 vision calls from ${priorPaths.length} report(s)`);
  console.log(`declared-layout safety: ${evaluation.declared_layout_safety_go ? "GO" : "NO-GO"}`);
  console.log(`full Gate B: ${evaluation.gate_b_go ? "GO" : "NO-GO"}`);
  console.log(`report: ${path.relative(ROOT, replayFile)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = args.manifest;
  const manifestBytes = await readFile(manifestPath);
  const manifestSha = sha256(manifestBytes);
  const manifest = validateAuditManifest(JSON.parse(manifestBytes.toString("utf8")));
  assertGoldenPilotPurpose(manifest);
  if (manifest.cases.length > MAX_PILOT_CASES) {
    throw new Error(`pilot refuses ${manifest.cases.length} cases; maximum is ${MAX_PILOT_CASES}`);
  }
  let layouts = args.layout ? manifest.layouts.filter((layout) => layout.name === args.layout) : manifest.layouts;
  if (!layouts.length) throw new Error(`layout not found: ${args.layout}`);
  const layoutPlanSha = selectedLayoutPlanSha256(layouts);
  for (const item of manifest.cases) {
    if (item.images.length !== 1 || item.images[0].slot !== "main") {
      throw new Error("v1 golden runner accepts exactly one MAIN image per case; gallery gets a separate pilot");
    }
  }
  const plannedCalls = layouts.reduce((sum, layout) => sum + Math.ceil(manifest.cases.length / layout.batch_size), 0);
  assertExactRunCallBudget(args.run, args.callBudget, plannedCalls);
  if (args.recoverOnly) {
    console.log(`manifest: ${manifest.manifest_id}`);
    console.log(`layouts: ${layouts.map((layout) => `${layout.name}:${layout.batch_size}`).join(", ")}`);
    console.log("planned subscription calls: 0 (offline checkpoint recovery only)");
    console.log("remote writes: 0 · DB access: 0 · paid fallback: forbidden");
    await runOfflineRecovery({
      args,
      manifest,
      manifestPath,
      manifestSha,
      layouts,
      layoutPlanSha,
    });
    return;
  }
  const attestation = await buildArtifactAttestation();
  if ((args.run || args.freezeOnly || args.replays.length) && args.localOcr === "required") {
    await assertLocalOcrAvailable();
  }
  const buyerFacing = manifest.cases.filter((item) => item.images[0].buyer_facing_verified).length;
  console.log(`manifest: ${manifest.manifest_id}`);
  console.log(`cases: ${manifest.cases.length} (${buyerFacing} buyer-facing verified, ${manifest.cases.length - buyerFacing} artifacts)`);
  console.log(`layouts: ${layouts.map((layout) => `${layout.name}:${layout.batch_size}`).join(", ")}`);
  console.log(args.replays.length
    ? "planned subscription calls: 0 (zero-model replay)"
    : `planned subscription calls: ${plannedCalls} (no undeclared fallback calls)`);
  console.log("remote writes: 0 · DB access: 0 · paid fallback: forbidden");
  if (args.replays.length) {
    await replayPriorReports({
      priorPaths: args.replays,
      manifest,
      manifestPath,
      manifestSha,
      localOcrMode: args.localOcr,
      attestation,
    });
    return;
  }
  if (!args.run && !args.freezeOnly) {
    console.log("validation-only complete; add --freeze-only to hash images or --run to execute the small pilot");
    return;
  }

  const workerContract = args.run ? await fetchWorkerContract(args.provider) : null;
  if (workerContract) {
    console.log(`worker contract: ${workerContract.vision_provider} ${workerContract.worker_build.slice(0, 19)}`);
  }
  const runKey = workerContract
    ? workerRunKey({
      manifest,
      manifestSha,
      layoutPlanSha,
      workerBuild: workerContract.worker_build,
      provider: args.provider,
    })
    : `${manifest.manifest_id}-${manifestSha.slice(0, 12)}-${layoutPlanSha.slice(0, 12)}-${sha256(VISUAL_PREPROCESS_VERSION).slice(0, 8)}-freeze-only`;
  const snapshotKey = `walmart-main-${manifestSourceFingerprint(manifest).slice(0, 20)}`;
  const runDir = path.join(ROOT, "data/audits/walmart-visual-pilot-runs", runKey);
  const snapshotDir = path.join(ROOT, "data/audits/walmart-visual-pilot-snapshots", snapshotKey);
  const dirs = {
    runDir: snapshotDir,
    raw: path.join(snapshotDir, "raw"),
    normalized: path.join(snapshotDir, "normalized"),
  };
  await Promise.all([
    mkdir(runDir, { recursive: true }),
    mkdir(dirs.raw, { recursive: true }),
    mkdir(dirs.normalized, { recursive: true }),
  ]);
  const sourceIndexFile = path.join(snapshotDir, "source-index.json");
  const stateFile = path.join(runDir, "checkpoint.json");
  let existingState = null;
  if (args.run && await fileExists(stateFile)) {
    const checkpointBytes = await readFile(stateFile);
    if (args.expectCheckpointSha256
      && sha256(checkpointBytes) !== args.expectCheckpointSha256) {
      throw new Error("resume guard: checkpoint raw SHA-256 mismatch");
    }
    try {
      existingState = JSON.parse(checkpointBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`pilot checkpoint is invalid JSON: ${stateFile}`, { cause: error });
    }
  }
  if (existingState) {
    if (existingState.manifest_sha256 !== manifestSha
      || existingState.provider !== args.provider
      || existingState.worker_build !== workerContract.worker_build
      || existingState.preprocessor_version !== VISUAL_PREPROCESS_VERSION
      || existingState.selected_layout_plan_sha256 !== layoutPlanSha) {
      throw new Error("resume guard: checkpoint fingerprint mismatch");
    }
    if (args.expectConsumed === null) {
      throw new Error(
        `resume guard: checkpoint already exists with ${existingState.subscription_calls_consumed} consumed calls; rerun with --expect-consumed=${existingState.subscription_calls_consumed}`,
      );
    }
    if (existingState.subscription_calls_consumed !== args.expectConsumed) {
      throw new Error(
        `resume guard: expected ${args.expectConsumed} consumed calls, found ${existingState.subscription_calls_consumed}`,
      );
    }
    assertCheckpointAccounting(existingState, args.expectConsumed);
    console.log(`resume guard: checkpoint confirmed at ${args.expectConsumed} consumed calls`);
  } else if (args.expectConsumed !== null) {
    throw new Error(`resume guard: checkpoint does not exist for run ${runKey}`);
  }
  const priorIndex = await readJsonIfPresent(sourceIndexFile, {}, "frozen source index");
  const sourceIndex = {};
  const frozenByCase = new Map();
  const evidenceByCase = new Map();
  for (let index = 0; index < manifest.cases.length; index++) {
    const item = manifest.cases[index];
    const frozen = await freezeImage(item.images[0], dirs, priorIndex);
    const localVisualEvidence = await prepareLocalVisualEvidence({
      frozen,
      snapshotDir,
      localOcrMode: args.localOcr,
      attestation,
    });
    sourceIndex[item.images[0].url] = {
      ...Object.fromEntries(Object.entries(frozen).filter(([key]) => !key.endsWith("_path") && key !== "visual_evidence")),
      visual_evidence: localVisualEvidence,
    };
    frozenByCase.set(item.case_id, frozen);
    evidenceByCase.set(item.case_id, localVisualEvidence);
    const ocrStatus = localVisualEvidence.local_ocr.mode === "off"
      ? "ocr-off"
      : localVisualEvidence.local_ocr.reused ? "ocr-reused" : "ocr-local";
    console.log(`snapshot ${index + 1}/${manifest.cases.length}: ${item.case_id} ${frozen.reused_frozen_bytes ? "reused" : "downloaded"} ${frozen.raw_sha256.slice(0, 12)} ${ocrStatus}`);
  }
  await atomicJson(sourceIndexFile, sourceIndex);
  if (args.freezeOnly) {
    console.log(`freeze-only complete: ${manifest.cases.length} immutable image snapshots, 0 vision calls`);
    console.log(`source index: ${path.relative(ROOT, sourceIndexFile)}`);
    return;
  }
  if (!workerContract) throw new Error("worker contract unavailable");
  const state = existingState ?? {
    schema_version: "walmart-visual-pilot-checkpoint/v1",
    manifest_sha256: manifestSha,
    provider: args.provider,
    worker_build: workerContract.worker_build,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    selected_layout_plan_sha256: layoutPlanSha,
    subscription_calls_consumed: 0,
    calls: {},
  };
  if (state.manifest_sha256 !== manifestSha
    || state.provider !== args.provider
    || state.worker_build !== workerContract.worker_build
    || state.preprocessor_version !== VISUAL_PREPROCESS_VERSION
    || state.selected_layout_plan_sha256 !== layoutPlanSha) {
    throw new Error("checkpoint fingerprint mismatch; use a new manifest id/version");
  }
  if (existingState) {
    if (layouts.length !== 1) throw new Error("resume guard requires exactly one selected layout");
    const { planned: resumePlan } = await buildOfflinePlannedCalls({
      manifest,
      layout: layouts[0],
      provider: args.provider,
      workerContract,
      snapshotDir,
      sourceIndexFile,
    });
    assertExactCheckpointPrefix(state, resumePlan, args.expectPrefix, {
      allowedRecoveredBatchIndexes: args.expectRecoveredBatch === null
        ? []
        : [args.expectRecoveredBatch],
    });
    if (plannedCalls - args.expectPrefix !== args.callBudget - args.expectConsumed) {
      throw new Error("resume guard: remaining call budget does not equal the planned suffix");
    }
    console.log(
      `resume prefix: exact 0..${args.expectPrefix - 1}; remaining batches `
      + `${args.expectPrefix}..${plannedCalls - 1}`,
    );
  }
  assertCheckpointAccounting(state);
  const callBudget = {
    max: args.callBudget ?? Number.POSITIVE_INFINITY,
    used: state.subscription_calls_consumed,
  };
  if (callBudget.used > callBudget.max) {
    throw new Error(`checkpoint already consumed ${callBudget.used} calls, above budget ${callBudget.max}`);
  }

  const layoutResults = [];
  let stoppedEarlyReason = null;
  for (const layout of layouts) {
    const ordered = layout.shuffle_seed === null
      ? [...manifest.cases]
      : shuffledWithSeed(manifest.cases, layout.shuffle_seed);
    const batches = chunks(ordered, layout.batch_size);
    const layoutResult = { name: layout.name, batch_size: layout.batch_size, shuffle_seed: layout.shuffle_seed, calls: [], case_results: [] };
    console.log(`layout ${layout.name}: ${batches.length} call(s)`);
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batchCases = batches[batchIndex];
      const items = batchCases.map((item) => ({
        case: item,
        image: item.images[0],
        frozen: frozenByCase.get(item.case_id),
        localVisualEvidence: evidenceByCase.get(item.case_id),
        modelAttachment: modelAttachmentFromEvidence(evidenceByCase.get(item.case_id), snapshotDir),
      }));
      if (items.length > MAX_IMAGES_PER_CALL) throw new Error(`batch has ${items.length} images; max ${MAX_IMAGES_PER_CALL}`);
      const call = await runBatchWithSchemaFallback({
        provider: args.provider,
        layoutName: layout.name,
        batchIndex,
        items,
        state,
        stateFile,
        workerContract,
        callBudget,
      });
      layoutResult.calls.push(call);
      if (!call.observations) {
        for (const item of items) {
          layoutResult.case_results.push({
            case_id: item.case.case_id,
            sku: item.case.sku,
            verdict: "TECHNICAL_ERROR",
            technical_error: call.primary.schema_error || "vision transport unavailable",
            raw_sha256: item.frozen.raw_sha256,
            normalized_sha256: item.frozen.normalized_sha256,
            model_full_sha256: item.modelAttachment.sha256,
            local_visual_evidence: item.localVisualEvidence,
          });
        }
        stoppedEarlyReason = `technical/schema failure in ${layout.name} batch ${batchIndex + 1}`;
      } else {
        for (let index = 0; index < items.length; index++) {
          const item = items[index];
          const observation = call.observations[index];
          const decision = decideWithLocalEvidence(item.case, item.image, observation, item.localVisualEvidence);
          layoutResult.case_results.push({
            case_id: item.case.case_id,
            sku: item.case.sku,
            verdict: decision.verdict,
            decision,
            observation,
            raw_sha256: item.frozen.raw_sha256,
            normalized_sha256: item.frozen.normalized_sha256,
            model_full_sha256: item.modelAttachment.sha256,
            local_visual_evidence: item.localVisualEvidence,
          });
          console.log(`  ${layout.name} ${item.case.case_id}: ${decision.verdict}`);
          const truth = item.case.ground_truth?.verdict;
          if (truth === "BAD" && decision.verdict !== "BAD" && !stoppedEarlyReason) {
            stoppedEarlyReason = `${item.case.case_id}: known BAD returned ${decision.verdict}`;
          }
          if (truth === "PASS" && decision.verdict === "BAD" && !stoppedEarlyReason) {
            stoppedEarlyReason = `${item.case.case_id}: known PASS returned BAD`;
          }
        }
        if (!call.primary.schema_valid && !stoppedEarlyReason) {
          stoppedEarlyReason = `first-attempt schema failure in ${layout.name} batch ${batchIndex + 1}`;
        }
      }
      if (stoppedEarlyReason) break;
    }
    layoutResults.push(layoutResult);
    if (stoppedEarlyReason) break;
  }

  const sourceIndexSha = sha256(await readFile(sourceIndexFile));
  const reportExecution = {
    provider: args.provider,
    provider_mode: "forced-subscription-worker-no-fallback",
    vision_provider_attested: workerContract.vision_provider,
    worker_build_attested: workerContract.worker_build,
    vision_model_attested: workerContract.vision_model,
    vision_reasoning_effort_attested: workerContract.vision_reasoning_effort,
    cli_version_attested: workerContract.cli_version,
    node_version_attested: workerContract.node_version,
    runtime_platform_attested: workerContract.runtime_platform,
    runtime_arch_attested: workerContract.runtime_arch,
    prompt_version: BLIND_PROMPT_VERSION,
    base_prompt_sha256: sha256(buildBlindObservationPrompt(["i_template"])),
    observation_schema: BLIND_OBSERVATION_SCHEMA,
    ...executionEvidenceAttestation(attestation, args.localOcr),
    remote_writes: 0,
    database_access: 0,
    paid_api_fallback: false,
    subscription_call_budget: Number.isFinite(callBudget.max) ? callBudget.max : null,
    subscription_calls_used: callBudget.used,
    selected_layout_plan_sha256: layoutPlanSha,
    stopped_early_reason: stoppedEarlyReason,
    frozen_image_normalization: `jpeg-max${NORMALIZED_MAX_PX}-q${NORMALIZED_JPEG_QUALITY}-444-white`,
    model_image_preprocessing: VISUAL_PREPROCESS_VERSION,
  };
  // A live report is sealed only after evaluation. Gate B certification is
  // therefore issued by a subsequent zero-call replay that verifies the seal
  // and, when present, revalidates the raw recovery evidence chain.
  const evaluation = evaluate(manifest, layoutResults, args.localOcr, {
    execution: reportExecution,
    sourceReportsSealedAndVerified: false,
    layoutPlanBatchMembershipVerified: false,
    revalidatedRecoveredCallKeys: [],
  });
  const report = {
    schema_version: "walmart-visual-pilot-report/v1",
    report_id: `${runKey}-${safeStamp()}`,
    created_at: new Date().toISOString(),
    manifest: {
      path: path.relative(ROOT, manifestPath),
      id: manifest.manifest_id,
      sha256: manifestSha,
      cases: manifest.cases.length,
      buyer_facing_verified: buyerFacing,
      artifact_only: manifest.cases.length - buyerFacing,
    },
    execution: reportExecution,
    source_index_file: path.relative(ROOT, sourceIndexFile),
    source_index_sha256: sourceIndexSha,
    checkpoint_file: path.relative(ROOT, stateFile),
    layouts: layoutResults,
    evaluation,
  };
  const { file: reportFile } = await writeSealedReport(runDir, report);
  if (stoppedEarlyReason) console.log(`stopped early: ${stoppedEarlyReason}`);
  console.log(`declared-layout safety: ${evaluation.declared_layout_safety_go ? "GO" : "NO-GO"}`);
  console.log(`full Gate B: ${evaluation.gate_b_go ? "GO" : "NO-GO"}`);
  console.log(`mass-run readiness: ${evaluation.mass_run_go ? "GO" : "NO-GO"}`);
  console.log(`report: ${path.relative(ROOT, reportFile)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`pilot failed closed: ${error instanceof Error ? error.message : String(error)}`);
    if (process.env.WALMART_VISUAL_DEBUG === "1" && error instanceof Error) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  });
}
