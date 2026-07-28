#!/usr/bin/env -S node --experimental-strip-types

/**
 * Execution-only Claude observer for a frozen Walmart listing-integrity lock.
 *
 * `plan` is strictly read-only and offline. `execute` is deliberately narrow:
 * after a sealed family preflight it opens only one deterministic partition,
 * performs one worker health GET, finishes local OCR for every selected shard,
 * writes an immutable attempt reservation, and makes exactly one POST for that
 * shard. An attempt without a verifiable result is never retried: the next run
 * terminalizes it offline as all-image TECH_ERROR/REVIEW and advances safely.
 */

import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  BLIND_OBSERVATION_SCHEMA,
  BLIND_PROMPT_VERSION,
  WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE,
  buildBlindObservationPrompt,
  parseBlindResponse,
} from "../src/lib/walmart/catalog-visual-audit.ts";
import {
  VISUAL_PREPROCESS_VERSION,
  preprocessCatalogVisual,
} from "../src/lib/walmart/catalog-visual-preprocess.ts";
import {
  WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
  WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA,
  WALMART_LISTING_OBSERVER_VERSION,
  WALMART_LISTING_OBSERVER_RESPONSE_MARGIN_MS,
  WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
  WALMART_LISTING_WORKER_REQUEST_SCHEMA,
  canonicalWalmartListingObservationJson,
  parseWalmartListingWorkerReservationLedgerContract,
  sealWalmartListingObservationBatch,
  sealWalmartListingObservationTechnicalErrorTerminal,
  verifyWalmartListingObservationArtifact,
  walmartListingObservationCallKey,
  walmartListingObservationSha256,
} from "../src/lib/walmart/listing-integrity-observation.ts";
import {
  LOCAL_VISUAL_OCR_ENGINE,
  parseLocalOcrOutput,
} from "../src/lib/walmart/local-visual-ocr.ts";
import {
  assertExecutionPermitWindow,
  assertPreflightCertificateMatchesRunLockMetadata,
  loadPinnedObserverPartitionContext,
  loadPinnedListingContext,
  parseWalmartListingIntegrityExecutionPermit,
  sha256Bytes,
} from "./walmart-listing-integrity-engine.mjs";

export const WALMART_LISTING_OBSERVER_EXECUTOR_VERSION =
  "walmart-listing-observer-executor/v3";
export const WALMART_LISTING_OBSERVER_ATTEMPT_SCHEMA =
  "walmart-listing-observation-attempt/v3";

const MAX_CALL_BUDGET = 6;
const MAX_OBSERVATION_BYTES = 64 * 1024 * 1024;
const MAX_WORKER_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_WORKER_REQUEST_CHARACTERS = 24_000_000;
const MAX_EXECUTION_PERMIT_BYTES = 1024 * 1024;
const HEALTH_TIMEOUT_MS = 15_000;
const LOCAL_OCR_TIMEOUT_MS = 180_000;
const LOCAL_OCR_OUTPUT_BYTES = 8 * 1024 * 1024;
const LOCAL_OCR_ROLES = new Set(["full", "tile_front", "bottom_label", "top_left_badge"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const execFile = promisify(execFileCallback);
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_OCR_SOURCE = path.join(SCRIPT_DIRECTORY, "walmart-visual-ocr.swift");
const PINNED_SYSTEM_CHILD_ENV = Object.freeze({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C",
  LC_ALL: "C",
});

const HELP = `Usage:
  npm run walmart-listing-observer -- plan \\
    --run-lock=/absolute/path/run-lock.json \\
    --expect-run-lock-sha256=<lowercase-sha256> \\
    --partition-id=<locked-partition-id> \\
    --execution-permit=/absolute/path/execution-permit.json \\
    --expect-execution-permit-sha256=<exact-file-byte-sha256> \\
    --preflight-certificate=/absolute/path/preflight-certificate.json \\
    --expect-preflight-certificate-sha256=<exact-file-byte-sha256>

  npm run walmart-listing-observer -- execute \\
    --run-lock=/absolute/path/run-lock.json \\
    --expect-run-lock-sha256=<lowercase-sha256> \\
    --partition-id=<locked-partition-id> \\
    --execution-permit=/absolute/path/execution-permit.json \\
    --expect-execution-permit-sha256=<exact-file-byte-sha256> \\
    --preflight-certificate=/absolute/path/preflight-certificate.json \\
    --expect-preflight-certificate-sha256=<exact-file-byte-sha256> \\
    --from-call=<exact-completed-prefix> \\
    --call-budget=<1..6>

The worker URL is frozen in the run-lock. The bearer token is read only from
CODEX_IMAGE_WORKER_TOKEN. There are no provider, retry, fallback, output-path,
paid-API, OpenAI, Walmart, database, or R2 options.
`;

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys must be exactly ${wanted.join(",")}`);
  }
}

function safeText(value, label, maximum = 10_000) {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a non-empty trimmed string without control characters`);
  }
  return value;
}

function digest(value, label) {
  const parsed = safeText(value, label, 64);
  if (!SHA256_PATTERN.test(parsed)) throw new Error(`${label} must be lowercase SHA-256`);
  return parsed;
}

function safeInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a safe integer in ${minimum}..${maximum}`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  const parsed = safeText(value, label, 64);
  if (!Number.isFinite(Date.parse(parsed)) || new Date(parsed).toISOString() !== parsed) {
    throw new Error(`${label} must be canonical UTC ISO-8601`);
  }
  return parsed;
}

function exactJsonEqual(left, right) {
  return canonicalWalmartListingObservationJson(left)
    === canonicalWalmartListingObservationJson(right);
}

function absolutePath(value, label) {
  const parsed = safeText(value, label, 16_384);
  if (!path.isAbsolute(parsed) || path.resolve(parsed) !== parsed) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return parsed;
}

function parseIntegerFlag(value, label, minimum, maximum) {
  const parsed = safeText(value, label, 32);
  if (!/^(?:0|[1-9]\d*)$/u.test(parsed)) throw new Error(`${label} must be a decimal integer`);
  return safeInteger(Number(parsed), label, minimum, maximum);
}

export function parseObserverCliArgs(argv) {
  if (!Array.isArray(argv)) throw new Error("argv must be an array");
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help")) {
    return { help: true };
  }
  if (argv.length === 2 && (argv[0] === "plan" || argv[0] === "execute")
    && argv[1] === "--help") return { help: true };
  const command = argv[0];
  if (command !== "plan" && command !== "execute") {
    throw new Error("first argument must be plan, execute, or --help");
  }
  const flags = new Map();
  for (const argument of argv.slice(1)) {
    const equals = argument.indexOf("=");
    if (!argument.startsWith("--") || equals <= 2) throw new Error(`unsupported argument: ${argument}`);
    const name = argument.slice(2, equals);
    if (flags.has(name)) throw new Error(`--${name} was repeated`);
    flags.set(name, argument.slice(equals + 1));
  }
  const common = [
    "run-lock", "expect-run-lock-sha256", "partition-id", "execution-permit",
    "expect-execution-permit-sha256", "preflight-certificate",
    "expect-preflight-certificate-sha256",
  ];
  const allowed = command === "plan"
    ? new Set(common)
    : new Set([...common, "from-call", "call-budget"]);
  for (const key of flags.keys()) {
    if (!allowed.has(key)) throw new Error(`unsupported flag for ${command}: --${key}`);
  }
  for (const key of allowed) {
    if (!flags.has(key)) throw new Error(`${command} requires --${key}=...`);
  }
  const parsed = {
    help: false,
    command,
    run_lock: absolutePath(flags.get("run-lock"), "--run-lock"),
    expect_run_lock_sha256: digest(
      flags.get("expect-run-lock-sha256"),
      "--expect-run-lock-sha256",
    ),
    partition_id: safeText(flags.get("partition-id"), "--partition-id", 200),
    execution_permit: absolutePath(flags.get("execution-permit"), "--execution-permit"),
    expect_execution_permit_sha256: digest(
      flags.get("expect-execution-permit-sha256"),
      "--expect-execution-permit-sha256",
    ),
    preflight_certificate: absolutePath(
      flags.get("preflight-certificate"),
      "--preflight-certificate",
    ),
    expect_preflight_certificate_sha256: digest(
      flags.get("expect-preflight-certificate-sha256"),
      "--expect-preflight-certificate-sha256",
    ),
  };
  if (command === "execute") {
    parsed.from_call = parseIntegerFlag(flags.get("from-call"), "--from-call", 0);
    parsed.call_budget = parseIntegerFlag(
      flags.get("call-budget"),
      "--call-budget",
      1,
      MAX_CALL_BUDGET,
    );
  }
  return parsed;
}

function partitionFromContext(context, partitionId) {
  const matches = context.run_lock.observer_partitions.filter((row) => (
    row.partition_id === partitionId
  ));
  if (matches.length !== 1) {
    throw new Error("--partition-id must identify exactly one locked observer partition");
  }
  const partition = matches[0];
  const shardById = new Map(context.run_lock.shards.map((shard) => [shard.shard_id, shard]));
  const shards = partition.shard_ids.map((shardId) => {
    const shard = shardById.get(shardId);
    if (!shard) throw new Error(`${partition.partition_id} contains an unknown shard ${shardId}`);
    return shard;
  });
  return { partition, shards };
}

async function assertExternalRegularFileWithoutSymlinks(target, label) {
  const parsed = path.parse(target);
  const segments = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`${label} may not contain symlinks: ${cursor}`);
  }
  const info = await lstat(target);
  if (!info.isFile()) throw new Error(`${label} must be a regular file`);
  return info;
}

async function loadObserverExecutionPermit(options, context, partition) {
  const info = await assertExternalRegularFileWithoutSymlinks(
    options.execution_permit,
    "--execution-permit",
  );
  if (info.size > MAX_EXECUTION_PERMIT_BYTES) {
    throw new Error("execution permit exceeds its byte cap");
  }
  const bytes = await readFile(options.execution_permit);
  if (bytes.byteLength !== info.size) throw new Error("execution permit changed while being read");
  const exactByteSha = sha256Bytes(bytes);
  if (exactByteSha !== options.expect_execution_permit_sha256) {
    throw new Error("execution permit exact-byte SHA-256 differs from expectation");
  }
  let raw;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("execution permit must be valid UTF-8 JSON");
  }
  return {
    exact_byte_sha256: exactByteSha,
    permit: parseWalmartListingIntegrityExecutionPermit(raw, {
      run_lock: context.run_lock,
      owner_execution_authority: context.run_lock.owner_execution_authority,
      run_lock_sha256: context.run_lock_sha256,
      run_id: context.run_lock.run_id,
      partition,
      preflight_certificate_sha256: context.preflight_certificate_sha256,
      family_created_at: context.run_lock.created_at,
    }),
  };
}

function parseObserverExecutionPermit(raw, context, partition) {
  return parseWalmartListingIntegrityExecutionPermit(raw, {
    run_lock: context.run_lock,
    owner_execution_authority: context.run_lock.owner_execution_authority,
    run_lock_sha256: context.run_lock_sha256,
    run_id: context.run_lock.run_id,
    partition,
    preflight_certificate_sha256: context.preflight_certificate_sha256,
    family_created_at: context.run_lock.created_at,
  });
}

function permitWindowStatus(permit, runLock, rawNow) {
  const now = canonicalTimestamp(rawNow, "execution clock");
  const nowMs = Date.parse(now);
  const requiredHeadroomMs = requiredObservationWindowMs(runLock);
  const remainingMs = Date.parse(permit.body.expires_at) - nowMs;
  if (nowMs < Date.parse(permit.body.created_at)) {
    return {
      execution_allowed: false,
      reason: "permit_window_not_started",
      now,
      remaining_ms: remainingMs,
      required_headroom_ms: requiredHeadroomMs,
      headroom_sufficient: remainingMs >= requiredHeadroomMs,
    };
  }
  if (nowMs >= Date.parse(permit.body.expires_at)) {
    return {
      execution_allowed: false,
      reason: "permit_window_expired",
      now,
      remaining_ms: remainingMs,
      required_headroom_ms: requiredHeadroomMs,
      headroom_sufficient: false,
    };
  }
  if (remainingMs < requiredHeadroomMs) {
    return {
      execution_allowed: false,
      reason: "permit_headroom_insufficient",
      now,
      remaining_ms: remainingMs,
      required_headroom_ms: requiredHeadroomMs,
      headroom_sufficient: false,
    };
  }
  return {
    execution_allowed: true,
    reason: null,
    now,
    remaining_ms: remainingMs,
    required_headroom_ms: requiredHeadroomMs,
    headroom_sufficient: true,
  };
}

function requiredObservationWindowMs(runLock) {
  const observer = runLock.observer_contract;
  return observer.vision_timeout_ms + observer.observer_response_margin_ms;
}

function assertExecutionPermitHeadroom(permit, runLock, rawNow) {
  const now = canonicalTimestamp(rawNow, "execution clock");
  assertExecutionPermitWindow(permit, now);
  const requiredMs = requiredObservationWindowMs(runLock);
  const remainingMs = Date.parse(permit.body.expires_at) - Date.parse(now);
  if (remainingMs < requiredMs) {
    throw new Error(
      `execution permit has ${remainingMs}ms remaining; at least ${requiredMs}ms is required before reservation/POST`,
    );
  }
  return now;
}

function canonicalWorkerAnalyzeUrl(raw) {
  const text = safeText(raw, "run_lock.observer_contract.worker_analyze_url", 2_048);
  let url;
  try { url = new URL(text); } catch {
    throw new Error("worker_analyze_url must be an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("worker_analyze_url may not contain credentials, query, or fragment");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback.has(url.hostname))) {
    throw new Error("worker_analyze_url must use HTTPS (HTTP is allowed only on loopback)");
  }
  if (!url.pathname.endsWith("/analyze-claude") || url.pathname.endsWith("/analyze-claude/")) {
    throw new Error("worker_analyze_url path must end exactly in /analyze-claude");
  }
  if (url.toString() !== text) throw new Error("worker_analyze_url must be canonical");
  return text;
}

function workerContractFromLock(runLock) {
  const observer = runLock.observer_contract;
  return {
    worker_build: `sha256:${observer.worker_build_sha256}`,
    model: "sonnet",
    reasoning_effort: null,
    cli_version: observer.cli_version,
    node_version: observer.node_version,
    runtime_platform: observer.platform,
    runtime_arch: observer.arch,
    vision_timeout_ms: observer.vision_timeout_ms,
    reservation_ledger: parseWalmartListingWorkerReservationLedgerContract(
      observer.reservation_ledger,
      "run_lock.observer_contract.reservation_ledger",
    ),
  };
}

function requestAttestation(context, shard, callKey, executionPermit) {
  return {
    schema_version: WALMART_LISTING_WORKER_REQUEST_SCHEMA,
    run_lock_sha256: context.run_lock_sha256,
    shard_id: shard.shard_id,
    call_index: shard.call_index,
    call_key: callKey,
    prompt_sha256: shard.prompt_sha256,
    execution_permit_sha256: executionPermit.sha256,
    partition_id: executionPermit.body.partition_id,
    image_sha256: shard.images.map((row) => row.model_view_sha256),
  };
}

function attemptPathForObservation(observationPath) {
  return `${observationPath}.attempt.json`;
}

function resolveBelowLock(context, relativePath, label) {
  const target = path.resolve(context.lock_directory, ...relativePath.split("/"));
  const relation = path.relative(context.lock_directory, target);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`)
    || path.isAbsolute(relation)) throw new Error(`${label} must resolve below the lock directory`);
  return target;
}

async function assertNoSymlinkParents(context, target, label) {
  const relation = path.relative(context.lock_directory, path.dirname(target));
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`${label} parent escapes the lock directory`);
  }
  const segments = relation ? relation.split(path.sep) : [];
  let cursor = context.lock_directory;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${label} parent must contain only real directories: ${cursor}`);
    }
  }
}

async function existingImmutableFile(context, target, label) {
  await assertNoSymlinkParents(context, target, label);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file`);
    return info;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readImmutableJson(context, target, label, maximum = MAX_OBSERVATION_BYTES) {
  const info = await existingImmutableFile(context, target, label);
  if (!info) throw new Error(`${label} is missing`);
  if ((info.mode & 0o777) !== 0o444) throw new Error(`${label} mode must be exactly 0444`);
  if (info.size > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
  const bytes = await readFile(target);
  if (bytes.byteLength !== info.size) throw new Error(`${label} changed while being read`);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
    throw new Error(`${label} must be valid UTF-8 JSON`);
  }
}

function buildAttemptBody(context, shard, localOcr, reservedAt, executionPermit) {
  const workerContract = workerContractFromLock(context.run_lock);
  const callKey = walmartListingObservationCallKey({
    run_lock_sha256: context.run_lock_sha256,
    shard_id: shard.shard_id,
    call_index: shard.call_index,
    worker_contract: workerContract,
    prompt_sha256: shard.prompt_sha256,
    image_bindings: shard.images,
  });
  const request = requestAttestation(context, shard, callKey, executionPermit);
  const body = {
    schema_version: WALMART_LISTING_OBSERVER_ATTEMPT_SCHEMA,
    executor_version: WALMART_LISTING_OBSERVER_EXECUTOR_VERSION,
    run_lock_sha256: context.run_lock_sha256,
    shard_id: shard.shard_id,
    call_index: shard.call_index,
    call_key: callKey,
    reserved_at: reservedAt,
    observation_batch_path: shard.observation_batch_path,
    provider: "claude_cli_subscription",
    worker_contract: workerContract,
    execution_permit: executionPermit,
    prompt: { version: BLIND_PROMPT_VERSION, sha256: shard.prompt_sha256 },
    image_bindings: shard.images,
    local_ocr_sha256: walmartListingObservationSha256(localOcr),
    request_attestation: request,
    execution_policy: {
      transport_attempts: 1,
      retries: 0,
      fallbacks: 0,
      paid_api_calls: 0,
      openai_model_calls: 0,
      output_write_policy: "immutable_wx_0444",
    },
  };
  return {
    ...body,
    body_sha256: walmartListingObservationSha256(body),
  };
}

function parseAttempt(raw, context, shard, partition, expectedExecutionPermit) {
  exactKeys(raw, [
    "schema_version", "executor_version", "run_lock_sha256", "shard_id", "call_index",
    "call_key", "reserved_at", "observation_batch_path", "provider", "worker_contract",
    "execution_permit",
    "prompt", "image_bindings", "local_ocr_sha256", "request_attestation",
    "execution_policy", "body_sha256",
  ], `${shard.shard_id} attempt`);
  const { body_sha256: rawBodySha, ...body } = raw;
  if (raw.schema_version !== WALMART_LISTING_OBSERVER_ATTEMPT_SCHEMA
    || raw.executor_version !== WALMART_LISTING_OBSERVER_EXECUTOR_VERSION
    || raw.run_lock_sha256 !== context.run_lock_sha256
    || raw.shard_id !== shard.shard_id || raw.call_index !== shard.call_index
    || raw.observation_batch_path !== shard.observation_batch_path
    || raw.provider !== "claude_cli_subscription") {
    throw new Error(`${shard.shard_id} attempt differs from the frozen shard`);
  }
  const reservedAt = canonicalTimestamp(raw.reserved_at, `${shard.shard_id} attempt.reserved_at`);
  digest(raw.local_ocr_sha256, `${shard.shard_id} attempt.local_ocr_sha256`);
  const executionPermit = parseObserverExecutionPermit(
    raw.execution_permit,
    context,
    partition,
  );
  if (Date.parse(reservedAt) < Date.parse(executionPermit.body.created_at)
    || Date.parse(reservedAt) >= Date.parse(executionPermit.body.expires_at)) {
    throw new Error(`${shard.shard_id} attempt reservation is outside its permit window`);
  }
  const remainingPermitMs = Date.parse(executionPermit.body.expires_at)
    - Date.parse(reservedAt);
  const requiredPermitMs = requiredObservationWindowMs(context.run_lock);
  if (remainingPermitMs < requiredPermitMs) {
    throw new Error(
      `${shard.shard_id} attempt reservation has ${remainingPermitMs}ms permit headroom; at least ${requiredPermitMs}ms is required`,
    );
  }
  if (expectedExecutionPermit !== undefined
    && !exactJsonEqual(executionPermit, expectedExecutionPermit)) {
    throw new Error(`${shard.shard_id} attempt uses a different execution permit`);
  }
  const workerContract = workerContractFromLock(context.run_lock);
  const expectedCallKey = walmartListingObservationCallKey({
    run_lock_sha256: context.run_lock_sha256,
    shard_id: shard.shard_id,
    call_index: shard.call_index,
    worker_contract: workerContract,
    prompt_sha256: shard.prompt_sha256,
    image_bindings: shard.images,
  });
  if (raw.call_key !== expectedCallKey
    || !exactJsonEqual(raw.worker_contract, workerContract)
    || !exactJsonEqual(raw.prompt, { version: BLIND_PROMPT_VERSION, sha256: shard.prompt_sha256 })
    || !exactJsonEqual(raw.image_bindings, shard.images)
    || !exactJsonEqual(
      raw.request_attestation,
      requestAttestation(context, shard, expectedCallKey, executionPermit),
    )
    || !exactJsonEqual(raw.execution_policy, {
      transport_attempts: 1, retries: 0, fallbacks: 0, paid_api_calls: 0,
      openai_model_calls: 0, output_write_policy: "immutable_wx_0444",
    })) {
    throw new Error(`${shard.shard_id} attempt call contract mismatch`);
  }
  const bodySha = digest(rawBodySha, `${shard.shard_id} attempt.body_sha256`);
  if (bodySha !== walmartListingObservationSha256(body)) {
    throw new Error(`${shard.shard_id} attempt body SHA mismatch`);
  }
  return raw;
}

function verifyCompletedPair(rawAttempt, rawObservation, context, shard, partition) {
  const attempt = parseAttempt(rawAttempt, context, shard, partition);
  const observation = verifyWalmartListingObservationArtifact(
    rawObservation,
    context.run_lock_sha256,
  );
  if (observation.run_lock_sha256 !== context.run_lock_sha256
    || observation.shard_id !== shard.shard_id
    || observation.call_index !== shard.call_index
    || observation.call_key !== attempt.call_key
    || !exactJsonEqual(observation.prompt, attempt.prompt)
    || !exactJsonEqual(observation.image_bindings, shard.images)
    || !exactJsonEqual(observation.worker_contract, attempt.worker_contract)
    || !exactJsonEqual(observation.execution_permit, attempt.execution_permit)) {
    throw new Error(`${shard.shard_id} completed artifact does not bind its reservation/run-lock`);
  }
  if (observation.schema_version === WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA) {
    if (observation.reserved_at !== attempt.reserved_at
      || observation.attempt_body_sha256 !== attempt.body_sha256
      || observation.execution.pass_eligible !== false
      || observation.image_outcomes.length !== shard.images.length
      || observation.image_outcomes.some((row, index) => (
        row.image_id !== shard.images[index].image_id
        || row.outcome !== "TECH_ERROR" || row.required_action !== "REVIEW"
      ))) {
      throw new Error(`${shard.shard_id} technical-error terminal does not bind its attempt`);
    }
    return { attempt, observation, kind: "technical_error_terminal" };
  }
  const observer = context.run_lock.observer_contract;
  const receiptBody = observation.worker_receipt.body;
  const attemptMs = Date.parse(attempt.reserved_at);
  const signedReservationMs = Date.parse(receiptBody.reservation_reserved_at);
  const signedIssuedMs = Date.parse(receiptBody.issued_at);
  const requiredWindowMs = requiredObservationWindowMs(context.run_lock);
  if (observation.worker_receipt.key_id !== observer.worker_receipt_key_id
    || observation.worker_receipt.public_key_spki_sha256
      !== observer.worker_receipt_public_key_sha256
    || !exactJsonEqual(receiptBody.request_attestation, attempt.request_attestation)
    || attemptMs > signedReservationMs
    || signedIssuedMs < signedReservationMs
    || signedIssuedMs > attemptMs + requiredWindowMs
    || walmartListingObservationSha256(observation.local_ocr) !== attempt.local_ocr_sha256) {
    throw new Error(`${shard.shard_id} completed observation does not bind its reservation/run-lock`);
  }
  return { attempt, observation, kind: "observed" };
}

export function buildAmbiguousTechnicalErrorTerminal(
  rawAttempt,
  context,
  shard,
  partition,
  rawTerminalizedAt,
) {
  const attempt = parseAttempt(rawAttempt, context, shard, partition);
  const terminalizedAt = canonicalTimestamp(rawTerminalizedAt, "terminalization clock");
  return sealWalmartListingObservationTechnicalErrorTerminal({
    schema_version: WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA,
    observer_version: WALMART_LISTING_OBSERVER_VERSION,
    run_lock_sha256: context.run_lock_sha256,
    shard_id: shard.shard_id,
    call_index: shard.call_index,
    call_key: attempt.call_key,
    reserved_at: attempt.reserved_at,
    terminalized_at: terminalizedAt,
    terminal_state: "BLOCKED_AMBIGUOUS",
    audit_outcome: "TECH_ERROR",
    reason_code: "attempt_reserved_without_verifiable_worker_result",
    attempt_body_sha256: attempt.body_sha256,
    execution_permit: attempt.execution_permit,
    worker_contract: attempt.worker_contract,
    prompt: attempt.prompt,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    image_bindings: attempt.image_bindings,
    image_outcomes: attempt.image_bindings.map((binding) => ({
      image_id: binding.image_id,
      outcome: "TECH_ERROR",
      required_action: "REVIEW",
    })),
    execution: {
      subscription_calls_consumed: "unknown_0_or_1",
      transport_attempts_maximum: 1,
      retries: 0,
      fallbacks: 0,
      paid_api_calls: 0,
      openai_model_calls: 0,
      worker_result_present: false,
      worker_receipt_present: false,
      pass_eligible: false,
    },
  });
}

/** Inspect immutable attempt/observation state without writing or using network. */
export async function inspectObserverExecutionState(
  context,
  partitionInput,
  rawNow = new Date().toISOString(),
) {
  workerContractFromLock(context.run_lock);
  const inspectedAt = canonicalTimestamp(rawNow, "observer state inspection clock");
  const inspectedAtMs = Date.parse(inspectedAt);
  const partitionId = typeof partitionInput === "string"
    ? partitionInput
    : partitionInput?.partition_id;
  if (typeof partitionId !== "string") {
    throw new Error("observer state inspection requires a locked partition");
  }
  const { partition, shards } = partitionFromContext(context, partitionId);
  if (partitionInput && typeof partitionInput === "object"
    && !exactJsonEqual(partitionInput, partition)) {
    throw new Error("observer state partition differs from the run-lock");
  }
  const pathSet = new Set();
  const rows = [];
  for (const shard of shards) {
    const observationPath = resolveBelowLock(
      context,
      shard.observation_batch_path,
      `${shard.shard_id} observation path`,
    );
    const attemptPath = attemptPathForObservation(observationPath);
    for (const candidate of [observationPath, attemptPath]) {
      if (pathSet.has(candidate)) throw new Error("attempt/observation paths collide between shards");
      pathSet.add(candidate);
    }
    const observationInfo = await existingImmutableFile(
      context,
      observationPath,
      `${shard.shard_id} observation`,
    );
    const attemptInfo = await existingImmutableFile(context, attemptPath, `${shard.shard_id} attempt`);
    if (attemptInfo && !observationInfo) {
      try {
        const attempt = parseAttempt(
          await readImmutableJson(context, attemptPath, `${shard.shard_id} attempt`),
          context,
          shard,
          partition,
        );
        const graceExpiresAtMs = Date.parse(attempt.reserved_at)
          + requiredObservationWindowMs(context.run_lock);
        const graceExpiresAt = new Date(graceExpiresAtMs).toISOString();
        if (inspectedAtMs < graceExpiresAtMs) {
          rows.push({
            shard,
            state: "IN_FLIGHT_GRACE",
            grace_expires_at: graceExpiresAt,
            grace_remaining_ms: graceExpiresAtMs - inspectedAtMs,
            observation_path: observationPath,
            attempt_path: attemptPath,
          });
        } else {
          rows.push({
            shard,
            state: "BLOCKED_AMBIGUOUS",
            grace_expires_at: graceExpiresAt,
            grace_remaining_ms: 0,
            observation_path: observationPath,
            attempt_path: attemptPath,
          });
        }
      } catch (error) {
        rows.push({
          shard,
          state: "INVALID",
          reason: error instanceof Error ? error.message : String(error),
          observation_path: observationPath,
          attempt_path: attemptPath,
        });
      }
      continue;
    }
    if (observationInfo && !attemptInfo) {
      rows.push({ shard, state: "INVALID", reason: "observation_without_reservation", observation_path: observationPath, attempt_path: attemptPath });
      continue;
    }
    if (!attemptInfo && !observationInfo) {
      rows.push({ shard, state: "PENDING", observation_path: observationPath, attempt_path: attemptPath });
      continue;
    }
    try {
      const attempt = await readImmutableJson(context, attemptPath, `${shard.shard_id} attempt`);
      const observation = await readImmutableJson(
        context,
        observationPath,
        `${shard.shard_id} observation`,
      );
      const completed = verifyCompletedPair(attempt, observation, context, shard, partition);
      rows.push({
        shard,
        state: completed.kind === "observed" ? "COMPLETE" : "TECH_ERROR_TERMINAL",
        observation_path: observationPath,
        attempt_path: attemptPath,
      });
    } catch (error) {
      rows.push({
        shard,
        state: "INVALID",
        reason: error instanceof Error ? error.message : String(error),
        observation_path: observationPath,
        attempt_path: attemptPath,
      });
    }
  }
  let completedPrefix = 0;
  while (["COMPLETE", "TECH_ERROR_TERMINAL"].includes(rows[completedPrefix]?.state)) {
    completedPrefix += 1;
  }
  const firstNoncomplete = rows[completedPrefix] ?? null;
  let sequenceError = null;
  if (rows.some((row) => row.state === "INVALID")) {
    sequenceError = "invalid observer artifact state";
  } else if (rows.slice(completedPrefix + 1).some((row) => row.state !== "PENDING")) {
    sequenceError = "observer artifacts are not an exact contiguous prefix";
  }
  return {
    partition,
    rows,
    completed_prefix: completedPrefix,
    next_state: firstNoncomplete?.state ?? "DONE",
    sequence_valid: sequenceError === null,
    sequence_error: sequenceError,
  };
}

function summarizeState(state) {
  return {
    partition_id: state.partition.partition_id,
    partition_index: state.partition.partition_index,
    completed_prefix: state.completed_prefix,
    next_state: state.next_state,
    sequence_valid: state.sequence_valid,
    sequence_error: state.sequence_error,
    shards: state.rows.map((row, localIndex) => ({
      partition_call_index: localIndex,
      call_index: row.shard.call_index,
      shard_id: row.shard.shard_id,
      state: row.state,
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.grace_expires_at ? { grace_expires_at: row.grace_expires_at } : {}),
      ...(row.grace_remaining_ms !== undefined
        ? { grace_remaining_ms: row.grace_remaining_ms }
        : {}),
      observation_batch_path: row.shard.observation_batch_path,
      attempt_path: `${row.shard.observation_batch_path}.attempt.json`,
    })),
  };
}

function emitJson(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function assertObserverConstraints(runLock) {
  const observer = runLock.observer_contract;
  workerContractFromLock(runLock);
  if (observer.provider !== "claude_cli_subscription" || observer.model !== "sonnet"
    || observer.observer_version !== WALMART_LISTING_OBSERVER_VERSION
    || observer.observation_schema_version !== WALMART_LISTING_OBSERVATION_BATCH_SCHEMA
    || observer.vision_timeout_ms !== 180_000
    || observer.observer_response_margin_ms
      !== WALMART_LISTING_OBSERVER_RESPONSE_MARGIN_MS) {
    throw new Error("observer identity/schema/timeout differs from the sealed one-shot contract");
  }
  const constraints = runLock.observer_execution_constraints;
  if (!isRecord(constraints)) {
    throw new Error("run-lock has no parsed observer_execution_constraints");
  }
  const expected = {
    network_target: "locked_worker_only",
    worker_health_calls_per_execute: 1,
    subscription_calls_total: runLock.shards.length,
    calls_per_shard: 1,
    max_calls_per_execute: MAX_CALL_BUDGET,
    transport_attempts_per_shard: 1,
    retries: 0,
    fallbacks: 0,
    paid_api_calls: 0,
    openai_model_calls: 0,
    database_reads: 0,
    database_writes: 0,
    marketplace_reads: 0,
    marketplace_writes: 0,
    local_ocr_required: true,
    execution_order: "partition_contiguous_prefix",
    ambiguous_attempt_policy: "offline_terminalize_technical_error_no_retry_then_resume",
    output_write_policy: "immutable_wx_attempt_and_observation_only",
  };
  if (!exactJsonEqual(constraints, expected)) {
    throw new Error("observer_execution_constraints differ from one-shot execution safety");
  }
  return constraints;
}

function healthUrlFromAnalyze(analyzeUrl) {
  const url = new URL(canonicalWorkerAnalyzeUrl(analyzeUrl));
  url.pathname = url.pathname.replace(/\/analyze-claude$/u, "/health");
  return url.toString();
}

async function responseJson(response, label, maximum = MAX_WORKER_RESPONSE_BYTES) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined && contentLength !== "") {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
      throw new Error(`${label} Content-Length is invalid or too large`);
    }
  }
  let text;
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const row = await reader.read();
      if (row.done) break;
      const chunk = Buffer.from(row.value);
      total += chunk.byteLength;
      if (total > maximum) {
        try { await reader.cancel(); } catch { /* best-effort transport stop */ }
        throw new Error(`${label} response is too large`);
      }
      chunks.push(chunk);
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      throw new Error(`${label} response is not valid UTF-8`);
    }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximum) {
      throw new Error(`${label} response is too large`);
    }
  }
  try { return JSON.parse(text); } catch { throw new Error(`${label} returned invalid JSON`); }
}

async function fetchWorkerHealth(context, fetchImpl, token) {
  const observer = context.run_lock.observer_contract;
  const response = await fetchImpl(healthUrlFromAnalyze(observer.worker_analyze_url), {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  const body = await responseJson(response, "worker health");
  if (!response.ok || body?.ok !== true || body.health_authorization_verified !== true) {
    throw new Error("worker health differs from the frozen observer contract");
  }
  const contract = body?.vision_contracts?.claude_cli_subscription;
  const healthReservationLedger = parseWalmartListingWorkerReservationLedgerContract(
    body?.reservation_ledger,
    "worker health.reservation_ledger",
  );
  const lockedReservationLedger = workerContractFromLock(context.run_lock).reservation_ledger;
  if (body.worker_build !== `sha256:${observer.worker_build_sha256}`
    || !Array.isArray(body.vision_providers)
    || !body.vision_providers.includes("claude_cli_subscription")
    || !isRecord(contract)
    || contract.model !== "sonnet" || contract.reasoning_effort !== null
    || contract.cli_version !== observer.cli_version
    || contract.node_version !== observer.node_version
    || contract.platform !== observer.platform || contract.arch !== observer.arch
    || body.vision_timeout_ms !== observer.vision_timeout_ms
    || body?.signed_vision_receipts?.schema_version !== "vision-worker-receipt/v2"
    || body.signed_vision_receipts.key_id !== observer.worker_receipt_key_id
    || body.signed_vision_receipts.public_key_spki_sha256
      !== observer.worker_receipt_public_key_sha256
    || body.durable_call_key_reservations !== true
    || !exactJsonEqual(healthReservationLedger, lockedReservationLedger)) {
    throw new Error("worker health differs from the frozen observer contract");
  }
  return true;
}

export async function attestLocalOcrRuntime(context, injected = {}) {
  const execFileImpl = injected.exec_file ?? execFile;
  const readFileImpl = injected.read_file ?? readFile;
  const runtimePlatform = injected.platform ?? process.platform;
  if (runtimePlatform !== "darwin") {
    throw new Error("required Apple Vision OCR is available only on macOS");
  }
  const observer = context.run_lock.observer_contract;
  const [swiftBytes, xcrunBytes] = await Promise.all([
    readFileImpl("/usr/bin/swift"),
    readFileImpl("/usr/bin/xcrun"),
  ]);
  if (sha256Bytes(swiftBytes) !== observer.swift_executable_sha256
    || sha256Bytes(xcrunBytes) !== observer.xcrun_executable_sha256) {
    throw new Error("local OCR executable bytes differ from the run-lock");
  }
  const swiftVersion = await execFileImpl("/usr/bin/swift", ["--version"], {
    encoding: null,
    env: PINNED_SYSTEM_CHILD_ENV,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  const swiftStdout = Buffer.isBuffer(swiftVersion.stdout)
    ? swiftVersion.stdout
    : Buffer.from(swiftVersion.stdout);
  if (sha256Bytes(swiftStdout) !== observer.swift_version_output_sha256) {
    throw new Error("swift --version exact stdout differs from the run-lock");
  }
  const [sdkVersionResult, sdkPathResult] = await Promise.all([
    execFileImpl("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"], {
      encoding: "utf8", env: PINNED_SYSTEM_CHILD_ENV, timeout: 15_000, maxBuffer: 64 * 1024,
    }),
    execFileImpl("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
      encoding: "utf8", env: PINNED_SYSTEM_CHILD_ENV, timeout: 15_000, maxBuffer: 64 * 1024,
    }),
  ]);
  const sdkVersion = safeText(sdkVersionResult.stdout.trim(), "macOS SDK version", 128);
  const sdkPath = safeText(sdkPathResult.stdout.trim(), "macOS SDK path", 4_096);
  if (sdkVersion !== observer.macos_sdk_version
    || sha256Bytes(Buffer.from(sdkPath, "utf8")) !== observer.macos_sdk_path_sha256) {
    throw new Error("macOS SDK version/path differs from the run-lock");
  }
  return {
    exec_file: execFileImpl,
    sdk_path: sdkPath,
    swift_version_output_sha256: observer.swift_version_output_sha256,
    macos_sdk_version: sdkVersion,
    macos_sdk_path_sha256: observer.macos_sdk_path_sha256,
  };
}

export function buildLocalOcrChildEnv({ sdk_path, module_cache, staging_directory }) {
  return {
    ...PINNED_SYSTEM_CHILD_ENV,
    SDKROOT: absolutePath(sdk_path, "local OCR SDK path"),
    CLANG_MODULE_CACHE_PATH: absolutePath(module_cache, "local OCR module cache"),
    TMPDIR: absolutePath(staging_directory, "local OCR staging directory"),
  };
}

function derivedOcrOutput(preprocessedByImage, parsed, stagedByPath) {
  const imageByPath = new Map(parsed.images.map((row) => [row.path, row]));
  const outputByImageId = new Map();
  for (const entry of preprocessedByImage) {
    const views = entry.views.map((view) => {
      const staged = stagedByPath.find((row) => row.image_id === entry.image.image_id
        && row.view_sha256 === view.sha256);
      const ocr = staged ? imageByPath.get(staged.path) : null;
      if (!staged || !ocr || ocr.width !== view.width || ocr.height !== view.height) {
        throw new Error(`${entry.image.image_id}/${view.role} OCR dimensions or path mismatch`);
      }
      if (ocr.observations.length > 1_000) {
        throw new Error(`${entry.image.image_id}/${view.role} OCR exceeds the sealed 1000-row cap`);
      }
      return {
        view_role: view.role,
        view_sha256: view.sha256,
        width: ocr.width,
        height: ocr.height,
        observations: ocr.observations,
      };
    });
    const ocrOutput = {
      schema_version: WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
      engine: LOCAL_VISUAL_OCR_ENGINE,
      views,
    };
    const trustedByLiteral = new Map();
    for (const view of views) {
      for (const row of view.observations) {
        if (row.confidence < WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE) continue;
        const selected = {
          text: row.text,
          confidence: row.confidence,
          view_role: view.view_role,
          view_sha256: view.view_sha256,
          bounding_box: row.bounding_box,
        };
        const key = `${view.view_sha256}|${row.text.trim().replace(/\s+/gu, " ").toLowerCase()}`;
        const prior = trustedByLiteral.get(key);
        if (!prior || row.confidence > prior.confidence) trustedByLiteral.set(key, selected);
      }
    }
    const trusted = [...trustedByLiteral.values()];
    outputByImageId.set(entry.image.image_id, {
      image_id: entry.image.image_id,
      asset_sha256: entry.image.asset_sha256,
      full_view_sha256: entry.image.model_view_sha256,
      preprocessor_version: VISUAL_PREPROCESS_VERSION,
      ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
      ocr_script_sha256: entry.ocr_script_sha256,
      ocr_output_sha256: walmartListingObservationSha256(ocrOutput),
      ocr_output: ocrOutput,
      truncated: trusted.length > 100,
      auxiliary_ocr: { ocr_texts: trusted.slice(0, 100) },
    });
  }
  return outputByImageId;
}

function validatePreparedLocalOcr(shard, rows, observer) {
  if (!Array.isArray(rows) || rows.length !== shard.images.length) {
    throw new Error(`${shard.shard_id} local OCR batch is incomplete`);
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const image = shard.images[index];
    exactKeys(row, [
      "image_id", "asset_sha256", "full_view_sha256", "preprocessor_version",
      "ocr_engine", "ocr_script_sha256", "ocr_output_sha256", "ocr_output",
      "truncated", "auxiliary_ocr",
    ], `${shard.shard_id} local_ocr[${index}]`);
    if (row.image_id !== image.image_id || row.asset_sha256 !== image.asset_sha256
      || row.full_view_sha256 !== image.model_view_sha256
      || row.preprocessor_version !== VISUAL_PREPROCESS_VERSION
      || row.ocr_engine !== LOCAL_VISUAL_OCR_ENGINE
      || row.ocr_script_sha256 !== observer.local_ocr_script_sha256
      || typeof row.truncated !== "boolean") {
      throw new Error(`${shard.shard_id}/${image.image_id} local OCR binding mismatch`);
    }
    exactKeys(row.ocr_output, ["schema_version", "engine", "views"], `${shard.shard_id} OCR output`);
    if (row.ocr_output.schema_version !== WALMART_LISTING_OCR_EVIDENCE_SCHEMA
      || row.ocr_output.engine !== LOCAL_VISUAL_OCR_ENGINE
      || !Array.isArray(row.ocr_output.views)
      || row.ocr_output.views.length < 1 || row.ocr_output.views.length > 4) {
      throw new Error(`${shard.shard_id}/${image.image_id} OCR output contract mismatch`);
    }
    const roles = new Set();
    const viewShas = new Set();
    const trustedByLiteral = new Map();
    for (const [viewIndex, view] of row.ocr_output.views.entries()) {
      exactKeys(view, [
        "view_role", "view_sha256", "width", "height", "observations",
      ], `${shard.shard_id} OCR view[${viewIndex}]`);
      if (!LOCAL_OCR_ROLES.has(view.view_role) || roles.has(view.view_role)
        || viewShas.has(view.view_sha256)) {
        throw new Error(`${shard.shard_id}/${image.image_id} OCR views are not unique/valid`);
      }
      roles.add(view.view_role);
      viewShas.add(digest(view.view_sha256, `${shard.shard_id} OCR view SHA`));
      safeInteger(view.width, `${shard.shard_id} OCR width`, 1);
      safeInteger(view.height, `${shard.shard_id} OCR height`, 1);
      if (!Array.isArray(view.observations) || view.observations.length > 1_000) {
        throw new Error(`${shard.shard_id}/${image.image_id} OCR view exceeds its row cap`);
      }
      for (const [observationIndex, observation] of view.observations.entries()) {
        const label = `${shard.shard_id} OCR observation[${viewIndex}][${observationIndex}]`;
        exactKeys(observation, ["text", "confidence", "bounding_box"], label);
        safeText(observation.text, `${label}.text`, 500);
        if (typeof observation.confidence !== "number" || !Number.isFinite(observation.confidence)
          || observation.confidence < 0 || observation.confidence > 1) {
          throw new Error(`${label}.confidence must be in 0..1`);
        }
        exactKeys(observation.bounding_box, ["x", "y", "width", "height"], `${label}.bounding_box`);
        const box = observation.bounding_box;
        for (const key of ["x", "y", "width", "height"]) {
          if (typeof box[key] !== "number" || !Number.isFinite(box[key])
            || box[key] < 0 || box[key] > 1) throw new Error(`${label}.bounding_box.${key} is invalid`);
        }
        if (box.width <= 0 || box.height <= 0
          || box.x + box.width > 1.000001 || box.y + box.height > 1.000001) {
          throw new Error(`${label}.bounding_box is invalid`);
        }
        if (observation.confidence >= WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE) {
          const selected = {
            text: observation.text,
            confidence: observation.confidence,
            view_role: view.view_role,
            view_sha256: view.view_sha256,
            bounding_box: box,
          };
          const key = `${view.view_sha256}|${observation.text.trim().replace(/\s+/gu, " ").toLowerCase()}`;
          const prior = trustedByLiteral.get(key);
          if (!prior || observation.confidence > prior.confidence) {
            trustedByLiteral.set(key, selected);
          }
        }
      }
    }
    if (!roles.has("full")
      || row.ocr_output.views.find((view) => view.view_role === "full")?.view_sha256
        !== image.model_view_sha256) {
      throw new Error(`${shard.shard_id}/${image.image_id} OCR lacks the exact full view`);
    }
    if (digest(row.ocr_output_sha256, `${shard.shard_id} OCR output SHA`)
      !== walmartListingObservationSha256(row.ocr_output)) {
      throw new Error(`${shard.shard_id}/${image.image_id} OCR output SHA mismatch`);
    }
    exactKeys(row.auxiliary_ocr, ["ocr_texts"], `${shard.shard_id} auxiliary OCR`);
    const trusted = [...trustedByLiteral.values()];
    if (!exactJsonEqual(row.auxiliary_ocr, { ocr_texts: trusted.slice(0, 100) })
      || row.truncated !== (trusted.length > 100)) {
      throw new Error(`${shard.shard_id}/${image.image_id} auxiliary OCR does not rebuild`);
    }
  }
  return rows;
}

async function prepareOneShardOcr(context, shard, runtime) {
  const listingByKey = new Map();
  const preprocessedByImage = [];
  const stagedByPath = [];
  for (const image of shard.images) {
    let sourceBytes = context.selected_asset_bytes?.get?.(image.image_id);
    if (!sourceBytes) {
      let listing = listingByKey.get(image.listing_key);
      if (!listing) {
        const ref = context.run_lock.listings.find((row) => row.listing_key === image.listing_key);
        if (!ref) throw new Error(`${shard.shard_id}/${image.image_id} listing is not locked`);
        listing = await loadPinnedListingContext(context, ref);
        listingByKey.set(image.listing_key, listing);
      }
      sourceBytes = listing.asset_bytes.get(image.slot);
    }
    if (!sourceBytes || sha256Bytes(sourceBytes) !== image.asset_sha256) {
      throw new Error(`${shard.shard_id}/${image.image_id} buyer asset bytes mismatch`);
    }
    const preprocessed = await preprocessCatalogVisual(sourceBytes);
    const views = preprocessed.views;
    if (views.length < 1 || views.some((view) => !LOCAL_OCR_ROLES.has(view.role))
      || new Set(views.map((view) => view.role)).size !== views.length) {
      throw new Error(`${shard.shard_id}/${image.image_id} preprocessor emitted invalid OCR views`);
    }
    const full = views.find((view) => view.role === "full");
    if (!full || full.sha256 !== image.model_view_sha256) {
      throw new Error(`${shard.shard_id}/${image.image_id} full view differs from run-lock`);
    }
    for (const [viewIndex, view] of views.entries()) {
      const extension = view.media_type === "image/png" ? "png" : "jpg";
      const file = path.join(
        runtime.staging_directory,
        `${shard.call_index}-${image.image_id}-${viewIndex}-${view.role}.${extension}`,
      );
      await writeFile(file, view.bytes, { flag: "wx", mode: 0o400 });
      stagedByPath.push({
        image_id: image.image_id,
        view_sha256: view.sha256,
        path: path.resolve(file),
      });
    }
    preprocessedByImage.push({
      image,
      views,
      ocr_script_sha256: runtime.script_sha256,
    });
  }
  const requested = stagedByPath.map((row) => row.path);
  let stdout;
  try {
    ({ stdout } = await runtime.exec_file(
      "/usr/bin/swift",
      [runtime.script_path, ...requested],
      {
        encoding: "utf8",
        env: buildLocalOcrChildEnv({
          sdk_path: runtime.sdk_path,
          module_cache: runtime.module_cache,
          staging_directory: runtime.staging_directory,
        }),
        timeout: LOCAL_OCR_TIMEOUT_MS,
        maxBuffer: LOCAL_OCR_OUTPUT_BYTES,
      },
    ));
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().slice(0, 2_000);
    throw new Error(`${shard.shard_id} required local Apple Vision OCR failed: ${detail}`);
  }
  let raw;
  try { raw = JSON.parse(stdout); } catch { throw new Error(`${shard.shard_id} local OCR returned invalid JSON`); }
  const parsed = parseLocalOcrOutput(raw, requested);
  const byImage = derivedOcrOutput(preprocessedByImage, parsed, stagedByPath);
  return shard.images.map((row) => {
    const evidence = byImage.get(row.image_id);
    if (!evidence) throw new Error(`${shard.shard_id}/${row.image_id} local OCR is missing`);
    return evidence;
  });
}

/** Finish OCR for all selected shards before the first immutable reservation. */
export async function prepareSelectedLocalOcr(context, shards, injected = {}) {
  const runtimeAttestation = injected.runtime_attestation
    ?? await attestLocalOcrRuntime(context, injected);
  const execFileImpl = runtimeAttestation.exec_file;
  const scriptBytes = await readFile(LOCAL_OCR_SOURCE);
  const scriptSha = createHash("sha256").update(scriptBytes).digest("hex");
  if (scriptSha !== context.run_lock.observer_contract.local_ocr_script_sha256) {
    throw new Error("local OCR script bytes differ from the run-lock");
  }
  const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), "walmart-listing-ocr-"));
  try {
    const scriptPath = path.join(stagingDirectory, "walmart-visual-ocr.swift");
    const moduleCache = path.join(stagingDirectory, "swift-module-cache");
    await writeFile(scriptPath, scriptBytes, { flag: "wx", mode: 0o400 });
    await mkdir(moduleCache, { mode: 0o700 });
    const sdkPath = runtimeAttestation.sdk_path;
    const prepared = new Map();
    for (const shard of shards) {
      prepared.set(shard.shard_id, await prepareOneShardOcr(context, shard, {
        exec_file: execFileImpl,
        script_path: scriptPath,
        script_sha256: scriptSha,
        sdk_path: sdkPath,
        module_cache: moduleCache,
        staging_directory: stagingDirectory,
      }));
    }
    return prepared;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function loadShardModelImages(context, shard) {
  const listingByKey = new Map();
  const images = [];
  for (const image of shard.images) {
    let bytes = context.selected_model_views?.get?.(image.image_id);
    if (!bytes) {
      let listing = listingByKey.get(image.listing_key);
      if (!listing) {
        const ref = context.run_lock.listings.find((row) => row.listing_key === image.listing_key);
        if (!ref) throw new Error(`${shard.shard_id}/${image.image_id} listing is not locked`);
        listing = await loadPinnedListingContext(context, ref);
        listingByKey.set(image.listing_key, listing);
      }
      bytes = listing.model_views.get(image.slot);
    }
    if (!bytes || sha256Bytes(bytes) !== image.model_view_sha256) {
      throw new Error(`${shard.shard_id}/${image.image_id} model view bytes mismatch`);
    }
    images.push(Buffer.from(bytes).toString("base64"));
  }
  return images;
}

async function writeImmutableJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const staging = `${file}.staging-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(staging, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o444);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await open(path.dirname(file), "r");
    try {
      // Same-directory hard-link publication is atomic and refuses every
      // existing target (including a symlink); unlike rename it cannot clobber.
      await link(staging, file);
      await directory.sync();
      await unlink(staging);
      await directory.sync();
    } finally {
      await directory.close();
    }
    return bytes;
  } catch (error) {
    try { await unlink(staging); } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        throw new AggregateError([error, cleanupError], `immutable publish cleanup failed: ${file}`);
      }
    }
    throw error;
  }
}

function validateWorkerResponse(raw, context, shard, attempt) {
  exactKeys(raw, [
    "ok", "result", "input_image_count", "vision_provider", "vision_model",
    "vision_reasoning_effort", "cli_version", "node_version", "runtime_platform",
    "runtime_arch", "worker_build", "vision_timeout_ms", "request_attestation_verified",
    "worker_receipt", "reservation_ledger",
  ], `${shard.shard_id} worker response`);
  const observer = context.run_lock.observer_contract;
  const lockedWorkerContract = workerContractFromLock(context.run_lock);
  const responseReservationLedger = parseWalmartListingWorkerReservationLedgerContract(
    raw.reservation_ledger,
    `${shard.shard_id} worker response.reservation_ledger`,
  );
  if (raw.ok !== true || raw.input_image_count !== shard.images.length
    || raw.vision_provider !== "claude_cli_subscription" || raw.vision_model !== "sonnet"
    || raw.vision_reasoning_effort !== null
    || raw.cli_version !== observer.cli_version || raw.node_version !== observer.node_version
    || raw.runtime_platform !== observer.platform || raw.runtime_arch !== observer.arch
    || raw.worker_build !== `sha256:${observer.worker_build_sha256}`
    || raw.vision_timeout_ms !== observer.vision_timeout_ms
    || raw.request_attestation_verified !== true
    || !exactJsonEqual(
      responseReservationLedger,
      lockedWorkerContract.reservation_ledger,
    )) {
    throw new Error(`${shard.shard_id} worker response runtime attestation mismatch`);
  }
  const observations = parseBlindResponse(raw.result, shard.images.map((row) => row.image_id));
  const result = { schema_version: BLIND_OBSERVATION_SCHEMA, observations };
  if (walmartListingObservationSha256(raw.result) !== walmartListingObservationSha256(result)) {
    throw new Error(`${shard.shard_id} worker signed a non-canonical model result`);
  }
  return {
    schema_version: WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
    observer_version: WALMART_LISTING_OBSERVER_VERSION,
    run_lock_sha256: context.run_lock_sha256,
    shard_id: shard.shard_id,
    call_index: shard.call_index,
    call_key: attempt.call_key,
    created_at: raw.worker_receipt?.body?.reservation_reserved_at,
    provider: "claude_cli_subscription",
    worker_contract: attempt.worker_contract,
    worker_receipt: raw.worker_receipt,
    execution_permit: attempt.execution_permit,
    execution: {
      subscription_calls_consumed: 1,
      transport_attempts: 1,
      retries: 0,
      fallbacks: 0,
      paid_api_calls: 0,
      openai_model_calls: 0,
      input_image_count_attested: true,
      worker_contract_attested: true,
    },
    prompt: attempt.prompt,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    image_bindings: shard.images,
    result_canonical_sha256: walmartListingObservationSha256(result),
    result,
    local_ocr: null,
  };
}

export function buildWorkerRequestBody(
  shard,
  attempt,
  images,
  maximumCharacters = MAX_WORKER_REQUEST_CHARACTERS,
) {
  if (!Array.isArray(images) || images.length !== shard.images.length) {
    throw new Error(`${shard.shard_id} model image batch is incomplete`);
  }
  for (let index = 0; index < images.length; index += 1) {
    const encoded = images[index];
    if (typeof encoded !== "string" || !encoded
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
      throw new Error(`${shard.shard_id} model image ${index} is not canonical base64`);
    }
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.toString("base64") !== encoded
      || sha256Bytes(bytes) !== shard.images[index].model_view_sha256) {
      throw new Error(`${shard.shard_id} model image ${index} differs from locked bytes`);
    }
  }
  const body = JSON.stringify({
    prompt: buildBlindObservationPrompt(shard.images.map((row) => row.image_id)),
    images,
    request_attestation: attempt.request_attestation,
  });
  // server.js destroys a request as soon as its decoded request string exceeds
  // this exact cap. Prove the payload fits before creating the reservation.
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 1) {
    throw new Error("worker request maximumCharacters must be a positive safe integer");
  }
  if (body.length > maximumCharacters) {
    throw new Error(`${shard.shard_id} worker request exceeds the frozen worker body cap`);
  }
  return body;
}

class DefinitiveWorkerResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "DefinitiveWorkerResponseError";
  }
}

async function postShardOnce({
  context, partition, shard, attempt, localOcr, requestBody, fetchImpl, token,
}) {
  const analyzeUrl = canonicalWorkerAnalyzeUrl(context.run_lock.observer_contract.worker_analyze_url);
  const observer = context.run_lock.observer_contract;
  if (observer.observer_response_margin_ms !== WALMART_LISTING_OBSERVER_RESPONSE_MARGIN_MS) {
    throw new Error("observer response margin differs from the sealed observation verifier");
  }
  const observationTimeoutMs = observer.vision_timeout_ms
    + observer.observer_response_margin_ms;
  let response;
  try {
    response = await fetchImpl(analyzeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: requestBody,
      redirect: "error",
      signal: AbortSignal.timeout(observationTimeoutMs),
    });
  } catch (error) {
    throw new Error(`${shard.shard_id} single worker POST ended ambiguously: ${error instanceof Error ? error.message : String(error)}`);
  }
  let raw;
  try {
    raw = await responseJson(response, `${shard.shard_id} worker`);
  } catch (error) {
    throw new Error(`${shard.shard_id} single worker POST response ended ambiguously: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new DefinitiveWorkerResponseError(
      `${shard.shard_id} single worker POST failed definitively with HTTP ${response.status}`,
    );
  }
  try {
    const body = validateWorkerResponse(raw, context, shard, attempt);
    body.local_ocr = localOcr;
    const sealed = sealWalmartListingObservationBatch(body);
    verifyCompletedPair(attempt, sealed, context, shard, partition);
    return sealed;
  } catch (error) {
    throw new DefinitiveWorkerResponseError(
      `${shard.shard_id} complete worker response failed validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function executionToken(env) {
  const token = env?.CODEX_IMAGE_WORKER_TOKEN;
  if (typeof token !== "string" || !token || token !== token.trim()
    || /[\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error("CODEX_IMAGE_WORKER_TOKEN must be explicitly configured in the environment");
  }
  return token;
}

async function loadObserverPartitionExecutionContext(options, context, injected) {
  if (context.preflight_certificate_sha256 !== options.expect_preflight_certificate_sha256) {
    throw new Error("loaded preflight certificate exact-byte SHA-256 differs from expectation");
  }
  const validateCertificate = injected.validate_preflight_certificate
    ?? assertPreflightCertificateMatchesRunLockMetadata;
  await validateCertificate(context);
  const { partition, shards } = partitionFromContext(context, options.partition_id);
  if (context.partition !== undefined && !exactJsonEqual(context.partition, partition)) {
    throw new Error("partition-scoped context differs from --partition-id");
  }
  if (context.shards !== undefined && !exactJsonEqual(context.shards, shards)) {
    throw new Error("partition-scoped context shard membership differs from the run-lock");
  }
  const loadedPermit = context.execution_permit !== undefined
    ? {
      exact_byte_sha256: context.execution_permit_file_sha256,
      permit: context.execution_permit,
    }
    : await (injected.load_execution_permit
      ? injected.load_execution_permit(options, context, partition)
      : loadObserverExecutionPermit(options, context, partition));
  if (!isRecord(loadedPermit)
    || loadedPermit.exact_byte_sha256 !== options.expect_execution_permit_sha256) {
    throw new Error("loaded execution permit exact-byte SHA-256 differs from expectation");
  }
  const permit = parseObserverExecutionPermit(loadedPermit.permit, context, partition);
  return { partition, shards, permit };
}

export async function runObserverPlan(options, injected = {}) {
  const stdout = injected.stdout ?? process.stdout;
  const loadContext = injected.load_context ?? loadPinnedObserverPartitionContext;
  const inspect = injected.inspect_state ?? inspectObserverExecutionState;
  const context = await loadContext(options, { now: injected.now });
  assertObserverConstraints(context.run_lock);
  canonicalWorkerAnalyzeUrl(context.run_lock.observer_contract.worker_analyze_url);
  const { partition, shards, permit } = await loadObserverPartitionExecutionContext(
    options,
    context,
    injected,
  );
  const planNow = (injected.now ?? (() => new Date().toISOString()))();
  const state = await inspect(context, partition, planNow);
  const window = permitWindowStatus(permit, context.run_lock, planNow);
  emitJson(stdout, {
    schema_version: "walmart-listing-observer-plan/v2",
    mode: "PLAN",
    executor_version: WALMART_LISTING_OBSERVER_EXECUTOR_VERSION,
    run_id: context.run_lock.run_id,
    run_lock_sha256: context.run_lock_sha256,
    code_bundle_id: context.code_bundle_manifest?.bundle_id ?? null,
    code_bundle_manifest_sha256: context.code_bundle_manifest_sha256 ?? null,
    listing_count: context.run_lock.listings.length,
    family_shard_count: context.run_lock.shards.length,
    partition_id: partition.partition_id,
    partition_index: partition.partition_index,
    partition_shard_count: shards.length,
    execution_permit_sha256: permit.sha256,
    execution_permit_exact_byte_sha256: options.expect_execution_permit_sha256,
    preflight_certificate_sha256: context.preflight_certificate_sha256,
    permit_window: window,
    execution_state: summarizeState(state),
    offline_terminalization_required: state.next_state === "BLOCKED_AMBIGUOUS",
    in_flight_grace: state.next_state === "IN_FLIGHT_GRACE",
    execution_allowed: window.execution_allowed
      && state.sequence_valid && state.next_state === "PENDING",
    assurance: {
      writes: 0,
      network_calls: 0,
      model_calls: 0,
      database_reads: 0,
      database_writes: 0,
      marketplace_reads: 0,
      marketplace_writes: 0,
    },
  });
}

export async function runObserverExecute(options, injected = {}) {
  const stdout = injected.stdout ?? process.stdout;
  const loadContext = injected.load_context ?? loadPinnedObserverPartitionContext;
  const inspect = injected.inspect_state ?? inspectObserverExecutionState;
  const fetchImpl = injected.fetch ?? globalThis.fetch;
  const prepareOcr = injected.prepare_local_ocr_batches ?? prepareSelectedLocalOcr;
  const attestOcrRuntime = injected.attest_local_ocr_runtime ?? attestLocalOcrRuntime;
  const loadImages = injected.load_model_images ?? loadShardModelImages;
  const now = injected.now ?? (() => new Date().toISOString());
  const context = await loadContext(options, { now });
  assertObserverConstraints(context.run_lock);
  canonicalWorkerAnalyzeUrl(context.run_lock.observer_contract.worker_analyze_url);
  const { partition, shards, permit } = await loadObserverPartitionExecutionContext(
    options,
    context,
    injected,
  );
  const inspectionNow = now();
  const initial = await inspect(context, partition, inspectionNow);
  if (!initial.sequence_valid) throw new Error(initial.sequence_error);
  if (initial.next_state === "IN_FLIGHT_GRACE") {
    emitJson(stdout, {
      schema_version: "walmart-listing-observer-execution/v2",
      mode: "EXECUTE",
      action: "IN_FLIGHT_GRACE",
      executor_version: WALMART_LISTING_OBSERVER_EXECUTOR_VERSION,
      run_id: context.run_lock.run_id,
      run_lock_sha256: context.run_lock_sha256,
      partition_id: partition.partition_id,
      partition_index: partition.partition_index,
      execution_permit_sha256: permit.sha256,
      subscription_calls_consumed: 0,
      completed_prefix_before: initial.completed_prefix,
      completed_prefix_after: initial.completed_prefix,
      execution_state: summarizeState(initial),
      assurance: {
        writes: 0,
        health_gets: 0,
        local_ocr_runs: 0,
        worker_posts: 0,
        model_calls: 0,
        retries: 0,
        fallbacks: 0,
        paid_api_calls: 0,
        openai_model_calls: 0,
        database_reads: 0,
        database_writes: 0,
        marketplace_reads: 0,
        marketplace_writes: 0,
      },
    });
    return;
  }
  if (initial.next_state === "BLOCKED_AMBIGUOUS") {
    const row = initial.rows[initial.completed_prefix];
    if (!row || row.state !== "BLOCKED_AMBIGUOUS") {
      throw new Error("ambiguous observer state cannot be terminalized");
    }
    const attempt = await readImmutableJson(
      context,
      row.attempt_path,
      `${row.shard.shard_id} attempt`,
    );
    const terminal = buildAmbiguousTechnicalErrorTerminal(
      attempt,
      context,
      row.shard,
      partition,
      inspectionNow,
    );
    await writeImmutableJson(row.observation_path, terminal);
    const written = await readImmutableJson(
      context,
      row.observation_path,
      `${row.shard.shard_id} technical-error terminal`,
    );
    verifyCompletedPair(attempt, written, context, row.shard, partition);
    const finalState = await inspect(context, partition, inspectionNow);
    if (!finalState.sequence_valid
      || finalState.completed_prefix !== initial.completed_prefix + 1) {
      throw new Error("offline terminalization did not advance the exact partition prefix");
    }
    emitJson(stdout, {
      schema_version: "walmart-listing-observer-execution/v2",
      mode: "EXECUTE",
      action: "OFFLINE_TERMINALIZE_TECH_ERROR",
      executor_version: WALMART_LISTING_OBSERVER_EXECUTOR_VERSION,
      run_id: context.run_lock.run_id,
      run_lock_sha256: context.run_lock_sha256,
      partition_id: partition.partition_id,
      partition_index: partition.partition_index,
      shard_id: row.shard.shard_id,
      call_index: row.shard.call_index,
      execution_permit_sha256: attempt.execution_permit.sha256,
      subscription_calls_consumed: 0,
      completed_prefix_before: initial.completed_prefix,
      completed_prefix_after: finalState.completed_prefix,
      execution_state: summarizeState(finalState),
      assurance: {
        health_gets: 0,
        local_ocr_runs: 0,
        worker_posts: 0,
        model_calls: 0,
        retries: 0,
        fallbacks: 0,
        paid_api_calls: 0,
        openai_model_calls: 0,
        database_reads: 0,
        database_writes: 0,
        marketplace_reads: 0,
        marketplace_writes: 0,
      },
    });
    return;
  }
  if (initial.next_state !== "PENDING") throw new Error("there are no pending contiguous shards to execute");
  if (options.from_call !== initial.completed_prefix) {
    throw new Error(`--from-call=${options.from_call} must equal exact completed prefix ${initial.completed_prefix}`);
  }
  const selected = shards.slice(
    options.from_call,
    Math.min(shards.length, options.from_call + options.call_budget),
  );
  if (!selected.length) throw new Error("call budget selects no pending shard");
  if (selected.length !== options.call_budget) {
    throw new Error(`--call-budget=${options.call_budget} exceeds remaining exact shard count ${selected.length}`);
  }
  assertExecutionPermitHeadroom(permit, context.run_lock, inspectionNow);
  const token = executionToken(injected.env ?? process.env);
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  // No network, reservation, or model call occurs until the exact local OCR
  // executable/runtime contract is attested. No reservation/model call occurs
  // until health and all selected local OCR have also succeeded.
  const localOcrRuntime = await attestOcrRuntime(context, injected.local_ocr ?? {});
  await (injected.fetch_health ?? fetchWorkerHealth)(context, fetchImpl, token);
  const ocrByShard = await prepareOcr(context, selected, {
    ...(injected.local_ocr ?? {}),
    runtime_attestation: localOcrRuntime,
  });
  for (const shard of selected) {
    validatePreparedLocalOcr(
      shard,
      ocrByShard.get(shard.shard_id),
      context.run_lock.observer_contract,
    );
  }

  // Validate every selected request's exact model bytes and worker body cap
  // before the first reservation/model call. Reloading per shard below keeps
  // memory bounded while rechecking that the locked bytes did not change.
  for (const shard of selected) {
    const preflightImages = await loadImages(context, shard);
    const preflightAttempt = buildAttemptBody(
      context,
      shard,
      ocrByShard.get(shard.shard_id),
      permit.body.created_at,
      permit,
    );
    buildWorkerRequestBody(shard, preflightAttempt, preflightImages);
  }

  let callsConsumed = 0;
  for (const [selectedIndex, shard] of selected.entries()) {
    const partitionCallIndex = options.from_call + selectedIndex;
    const row = initial.rows[partitionCallIndex];
    if (!row || row.state !== "PENDING") throw new Error(`${shard.shard_id} is no longer pending`);
    const images = await loadImages(context, shard);
    if (!Array.isArray(images) || images.length !== shard.images.length) {
      throw new Error(`${shard.shard_id} model image batch is incomplete`);
    }
    const reservedAt = assertExecutionPermitHeadroom(permit, context.run_lock, now());
    const attempt = buildAttemptBody(
      context,
      shard,
      ocrByShard.get(shard.shard_id),
      reservedAt,
      permit,
    );
    const requestBody = buildWorkerRequestBody(shard, attempt, images);
    await writeImmutableJson(row.attempt_path, attempt);
    const persistedAttempt = parseAttempt(
      await readImmutableJson(context, row.attempt_path, `${shard.shard_id} attempt`),
      context,
      shard,
      partition,
      permit,
    );
    const postClock = assertExecutionPermitHeadroom(permit, context.run_lock, now());
    if (Date.parse(postClock) < Date.parse(persistedAttempt.reserved_at)) {
      throw new Error(`${shard.shard_id} execution clock moved backwards before POST`);
    }
    // A complete, definitive worker response may be sealed locally as TECH_ERROR.
    // Transport/response ambiguity leaves only the reservation; a later process
    // must respect its full in-flight grace window. There is never a retry/fallback.
    let sealed;
    try {
      sealed = await postShardOnce({
        context,
        partition,
        shard,
        attempt: persistedAttempt,
        localOcr: ocrByShard.get(shard.shard_id),
        requestBody,
        fetchImpl,
        token,
      });
    } catch (error) {
      if (!(error instanceof DefinitiveWorkerResponseError)) throw error;
      const terminalizedAt = now();
      const terminal = buildAmbiguousTechnicalErrorTerminal(
        persistedAttempt,
        context,
        shard,
        partition,
        terminalizedAt,
      );
      await writeImmutableJson(row.observation_path, terminal);
      const written = await readImmutableJson(
        context,
        row.observation_path,
        `${shard.shard_id} definitive-failure terminal`,
      );
      verifyCompletedPair(persistedAttempt, written, context, shard, partition);
      const terminalState = await inspect(context, partition, terminalizedAt);
      if (!terminalState.sequence_valid
        || terminalState.completed_prefix !== initial.completed_prefix + selectedIndex + 1) {
        throw new Error("definitive failure terminalization did not advance the exact partition prefix");
      }
      emitJson(stdout, {
        schema_version: "walmart-listing-observer-execution/v2",
        mode: "EXECUTE",
        action: "DEFINITIVE_FAILURE_TERMINALIZE_TECH_ERROR",
        executor_version: WALMART_LISTING_OBSERVER_EXECUTOR_VERSION,
        run_id: context.run_lock.run_id,
        run_lock_sha256: context.run_lock_sha256,
        partition_id: partition.partition_id,
        partition_index: partition.partition_index,
        shard_id: shard.shard_id,
        call_index: shard.call_index,
        execution_permit_sha256: permit.sha256,
        subscription_calls_consumed: "unknown_0_or_1",
        completed_prefix_before: initial.completed_prefix,
        completed_prefix_after: terminalState.completed_prefix,
        execution_state: summarizeState(terminalState),
        definitive_failure: error.message,
        assurance: {
          writes: 2,
          health_gets: 1,
          local_ocr_runs: selected.length,
          worker_posts: selectedIndex + 1,
          model_calls: "unknown_0_or_1_for_terminal_shard",
          retries: 0,
          fallbacks: 0,
          paid_api_calls: 0,
          openai_model_calls: 0,
          database_reads: 0,
          database_writes: 0,
          marketplace_reads: 0,
          marketplace_writes: 0,
        },
      });
      return;
    }
    await writeImmutableJson(row.observation_path, sealed);
    const written = await readImmutableJson(context, row.observation_path, `${shard.shard_id} observation`);
    verifyCompletedPair(persistedAttempt, written, context, shard, partition);
    callsConsumed += 1;
  }
  const finalState = await inspect(context, partition, now());
  if (!finalState.sequence_valid
    || finalState.completed_prefix !== initial.completed_prefix + selected.length) {
    throw new Error("post-execution state does not form the expected exact prefix");
  }
  emitJson(stdout, {
    schema_version: "walmart-listing-observer-execution/v2",
    mode: "EXECUTE",
    action: "OBSERVE",
    executor_version: WALMART_LISTING_OBSERVER_EXECUTOR_VERSION,
    run_id: context.run_lock.run_id,
    run_lock_sha256: context.run_lock_sha256,
    partition_id: partition.partition_id,
    partition_index: partition.partition_index,
    execution_permit_sha256: permit.sha256,
    code_bundle_id: context.code_bundle_manifest?.bundle_id ?? null,
    code_bundle_manifest_sha256: context.code_bundle_manifest_sha256 ?? null,
    from_call: options.from_call,
    call_budget: options.call_budget,
    subscription_calls_consumed: callsConsumed,
    completed_prefix_before: initial.completed_prefix,
    completed_prefix_after: finalState.completed_prefix,
    execution_state: summarizeState(finalState),
    assurance: {
      health_gets: 1,
      worker_posts: callsConsumed,
      transport_attempts_per_shard: 1,
      retries: 0,
      fallbacks: 0,
      paid_api_calls: 0,
      openai_model_calls: 0,
      database_reads: 0,
      database_writes: 0,
      marketplace_reads: 0,
      marketplace_writes: 0,
    },
  });
}

export async function main(argv = process.argv.slice(2), injected = {}) {
  const options = parseObserverCliArgs(argv);
  const stdout = injected.stdout ?? process.stdout;
  if (options.help) {
    stdout.write(HELP);
    return;
  }
  if (options.command === "plan") return runObserverPlan(options, injected);
  return runObserverExecute(options, injected);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
