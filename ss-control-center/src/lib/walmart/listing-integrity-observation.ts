/**
 * Pure, fail-closed custody contract for Claude blind-observation batches.
 *
 * The untrusted executor supplies pixels to the worker and local OCR. This
 * module accepts neither a visual verdict nor an unsigned worker result: it
 * validates the exact blind schema, an Ed25519 worker receipt, frozen image
 * bindings, and recomputed OCR selection before sealing the batch. No I/O.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

import {
  BLIND_OBSERVATION_SCHEMA,
  BLIND_PROMPT_VERSION,
  WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE,
  buildBlindObservationPrompt,
  parseBlindResponse,
  type AuditAuxiliaryEvidence,
  type BlindObservation,
  type ImageSlot,
} from "./catalog-visual-audit.ts";
import { VISUAL_PREPROCESS_VERSION } from "./catalog-visual-preprocess.ts";
import { LOCAL_VISUAL_OCR_ENGINE } from "./local-visual-ocr.ts";

export const WALMART_LISTING_OBSERVATION_BATCH_SCHEMA =
  "walmart-listing-observation-batch/v3" as const;
export const WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA =
  "walmart-listing-observation-terminal/v2" as const;
export const WALMART_LISTING_OBSERVER_VERSION =
  "walmart-listing-observer/v3" as const;
export const WALMART_LISTING_OCR_EVIDENCE_SCHEMA =
  "walmart-listing-ocr-evidence/v1" as const;
export const WALMART_LISTING_WORKER_REQUEST_SCHEMA =
  "vision-request-attestation/v2" as const;
export const WALMART_LISTING_WORKER_RECEIPT_SCHEMA =
  "vision-worker-receipt/v2" as const;
export const WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA =
  "vision-call-reservation-ledger-contract/v1" as const;
export const WALMART_LISTING_EXECUTION_PERMIT_SCHEMA =
  "walmart-listing-integrity-execution-permit/v3" as const;
export const WALMART_LISTING_OBSERVER_RESPONSE_MARGIN_MS = 30_000 as const;

type JsonRecord = Record<string, unknown>;

export interface WalmartListingObservationImageBinding {
  listing_key: string;
  item_id: string;
  slot: ImageSlot;
  asset_sha256: string;
  model_view_sha256: string;
  image_id: string;
}

export interface WalmartListingWorkerReservationLedgerContract {
  schema_version: typeof WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA;
  ledger_id: `ledger-${string}`;
  ledger_epoch: `epoch-${string}`;
  state_directory_path_sha256: string;
  directory_identity_sha256: string;
  identity_artifact_sha256: string;
}

export interface WalmartListingObservationWorkerContract {
  worker_build: `sha256:${string}`;
  model: "sonnet";
  reasoning_effort: null;
  cli_version: string;
  node_version: string;
  runtime_platform: string;
  runtime_arch: string;
  vision_timeout_ms: number;
  reservation_ledger: WalmartListingWorkerReservationLedgerContract;
}

export interface WalmartListingExecutionPermit {
  sha256: string;
  body: {
    schema_version: typeof WALMART_LISTING_EXECUTION_PERMIT_SCHEMA;
    permit_id: string;
    run_lock_sha256: string;
    run_id: string;
    partition_id: string;
    partition_index: number;
    shard_ids: string[];
    preflight_certificate_sha256: string;
    created_at: string;
    expires_at: string;
    owner_authorization: JsonRecord;
    authorization_binding: JsonRecord;
    allowance_reservation: JsonRecord;
  };
}

export interface WalmartListingWorkerReceipt {
  schema_version: typeof WALMART_LISTING_WORKER_RECEIPT_SCHEMA;
  key_id: string;
  public_key_spki_der_base64: string;
  public_key_spki_sha256: string;
  body: {
    issued_at: string;
    request_attestation: {
      schema_version: typeof WALMART_LISTING_WORKER_REQUEST_SCHEMA;
      run_lock_sha256: string;
      shard_id: string;
      call_index: number;
      call_key: string;
      prompt_sha256: string;
      execution_permit_sha256: string;
      partition_id: string;
      image_sha256: string[];
    };
    reservation_reserved_at: string;
    result_canonical_sha256: string;
    worker_contract: {
      input_image_count: number;
      vision_provider: "claude_cli_subscription";
      vision_model: "sonnet";
      vision_reasoning_effort: null;
      cli_version: string;
      node_version: string;
      runtime_platform: string;
      runtime_arch: string;
      worker_build: `sha256:${string}`;
      vision_timeout_ms: number;
      reservation_ledger: WalmartListingWorkerReservationLedgerContract;
    };
    subscription_policy: {
      auth_mode: "claude_subscription_oauth";
      paid_api_environment_absent: true;
      alternate_cloud_routing_absent: true;
    };
  };
  signature_base64: string;
}

export interface WalmartListingOcrEvidenceRow {
  image_id: string;
  asset_sha256: string;
  full_view_sha256: string;
  preprocessor_version: typeof VISUAL_PREPROCESS_VERSION;
  ocr_engine: typeof LOCAL_VISUAL_OCR_ENGINE;
  ocr_script_sha256: string;
  ocr_output_sha256: string;
  ocr_output: {
    schema_version: typeof WALMART_LISTING_OCR_EVIDENCE_SCHEMA;
    engine: typeof LOCAL_VISUAL_OCR_ENGINE;
    views: Array<{
      view_role: "full" | "tile_front" | "bottom_label" | "top_left_badge";
      view_sha256: string;
      width: number;
      height: number;
      observations: Array<{
        text: string;
        confidence: number;
        bounding_box: { x: number; y: number; width: number; height: number };
      }>;
    }>;
  };
  truncated: boolean;
  auxiliary_ocr: AuditAuxiliaryEvidence;
}

export interface WalmartListingObservationBatchBody {
  schema_version: typeof WALMART_LISTING_OBSERVATION_BATCH_SCHEMA;
  observer_version: typeof WALMART_LISTING_OBSERVER_VERSION;
  run_lock_sha256: string;
  shard_id: string;
  call_index: number;
  call_key: string;
  created_at: string;
  provider: "claude_cli_subscription";
  worker_contract: WalmartListingObservationWorkerContract;
  worker_receipt: WalmartListingWorkerReceipt;
  execution_permit: WalmartListingExecutionPermit;
  execution: {
    subscription_calls_consumed: 1;
    transport_attempts: 1;
    retries: 0;
    fallbacks: 0;
    paid_api_calls: 0;
    openai_model_calls: 0;
    input_image_count_attested: true;
    worker_contract_attested: true;
  };
  prompt: { version: typeof BLIND_PROMPT_VERSION; sha256: string };
  preprocessor_version: typeof VISUAL_PREPROCESS_VERSION;
  image_bindings: WalmartListingObservationImageBinding[];
  result_canonical_sha256: string;
  result: {
    schema_version: typeof BLIND_OBSERVATION_SCHEMA;
    observations: BlindObservation[];
  };
  local_ocr: WalmartListingOcrEvidenceRow[];
}

export interface SealedWalmartListingObservationBatch
  extends WalmartListingObservationBatchBody {
  artifact_id: string;
  body_sha256: string;
}

/**
 * Fail-closed local terminal for an immutable attempt whose worker outcome is
 * unknowable. It deliberately cannot carry a model result or worker receipt.
 * Every bound image is forced to TECH_ERROR/REVIEW and is never PASS-eligible.
 */
export interface WalmartListingObservationTechnicalErrorTerminalBody {
  schema_version: typeof WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA;
  observer_version: typeof WALMART_LISTING_OBSERVER_VERSION;
  run_lock_sha256: string;
  shard_id: string;
  call_index: number;
  call_key: string;
  reserved_at: string;
  terminalized_at: string;
  terminal_state: "BLOCKED_AMBIGUOUS";
  audit_outcome: "TECH_ERROR";
  reason_code: "attempt_reserved_without_verifiable_worker_result";
  attempt_body_sha256: string;
  execution_permit: WalmartListingExecutionPermit;
  worker_contract: WalmartListingObservationWorkerContract;
  prompt: { version: typeof BLIND_PROMPT_VERSION; sha256: string };
  preprocessor_version: typeof VISUAL_PREPROCESS_VERSION;
  image_bindings: WalmartListingObservationImageBinding[];
  image_outcomes: Array<{
    image_id: string;
    outcome: "TECH_ERROR";
    required_action: "REVIEW";
  }>;
  execution: {
    subscription_calls_consumed: "unknown_0_or_1";
    transport_attempts_maximum: 1;
    retries: 0;
    fallbacks: 0;
    paid_api_calls: 0;
    openai_model_calls: 0;
    worker_result_present: false;
    worker_receipt_present: false;
    pass_eligible: false;
  };
}

export interface SealedWalmartListingObservationTechnicalErrorTerminal
  extends WalmartListingObservationTechnicalErrorTerminalBody {
  artifact_id: string;
  body_sha256: string;
}

export type SealedWalmartListingObservationArtifact =
  | SealedWalmartListingObservationBatch
  | SealedWalmartListingObservationTechnicalErrorTerminal;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: unknown, expected: readonly string[], path: string): asserts value is JsonRecord {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${path} fields must be exactly: ${wanted.join(", ")}`);
  }
}

function stringValue(value: unknown, path: string, maximum = 500): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${path} must be a non-empty trimmed string`);
  }
  return value;
}

function sha256Value(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${path} must be a lowercase SHA-256 digest`);
  }
  return value;
}

const RESERVATION_LEDGER_ID_PATTERN =
  /^ledger-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RESERVATION_LEDGER_EPOCH_PATTERN =
  /^epoch-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function parseWalmartListingWorkerReservationLedgerContract(
  raw: unknown,
  path = "reservation_ledger",
): WalmartListingWorkerReservationLedgerContract {
  exactKeys(raw, [
    "schema_version", "ledger_id", "ledger_epoch", "state_directory_path_sha256",
    "directory_identity_sha256", "identity_artifact_sha256",
  ], path);
  if (raw.schema_version !== WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA) {
    throw new Error(`${path}.schema_version is invalid`);
  }
  if (typeof raw.ledger_id !== "string"
    || !RESERVATION_LEDGER_ID_PATTERN.test(raw.ledger_id)) {
    throw new Error(`${path}.ledger_id is invalid`);
  }
  if (typeof raw.ledger_epoch !== "string"
    || !RESERVATION_LEDGER_EPOCH_PATTERN.test(raw.ledger_epoch)) {
    throw new Error(`${path}.ledger_epoch is invalid`);
  }
  return {
    schema_version: WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA,
    ledger_id: raw.ledger_id as `ledger-${string}`,
    ledger_epoch: raw.ledger_epoch as `epoch-${string}`,
    state_directory_path_sha256: sha256Value(
      raw.state_directory_path_sha256,
      `${path}.state_directory_path_sha256`,
    ),
    directory_identity_sha256: sha256Value(
      raw.directory_identity_sha256,
      `${path}.directory_identity_sha256`,
    ),
    identity_artifact_sha256: sha256Value(
      raw.identity_artifact_sha256,
      `${path}.identity_artifact_sha256`,
    ),
  };
}

function safeInteger(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${path} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be finite`);
  return value;
}

function canonicalTimestamp(value: unknown, path: string): string {
  const parsed = stringValue(value, path, 100);
  if (!Number.isFinite(Date.parse(parsed)) || new Date(parsed).toISOString() !== parsed) {
    throw new Error(`${path} must be canonical UTC ISO-8601`);
  }
  return parsed;
}

function canonicalOpaqueObject(value: unknown, path: string): JsonRecord {
  if (!isRecord(value) || Object.keys(value).length < 1) {
    throw new Error(`${path} must be a non-empty object`);
  }
  try {
    return JSON.parse(canonicalWalmartListingObservationJson(value)) as JsonRecord;
  } catch (error) {
    throw new Error(`${path} must contain only canonical JSON values`, { cause: error });
  }
}

export function canonicalWalmartListingObservationJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalWalmartListingObservationJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalWalmartListingObservationJson(value[key])}`
    )).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("canonical JSON rejects non-finite numbers");
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("canonical JSON rejects undefined");
  return encoded;
}

export function walmartListingObservationSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalWalmartListingObservationJson(value), "utf8")
    .digest("hex");
}

function exactEqual(left: unknown, right: unknown): boolean {
  return canonicalWalmartListingObservationJson(left)
    === canonicalWalmartListingObservationJson(right);
}

export function walmartListingObservationImageId(
  assetSha256: string,
  slot: ImageSlot,
  listingKey: string,
): string {
  return `i_${walmartListingObservationSha256({
    asset_sha256: assetSha256,
    slot,
    listing_key: listingKey,
  }).slice(0, 20)}`;
}

export function walmartListingObservationPromptSha256(imageIds: readonly string[]): string {
  return createHash("sha256")
    .update(buildBlindObservationPrompt(imageIds), "utf8")
    .digest("hex");
}

interface CallKeyInput {
  run_lock_sha256: string;
  shard_id: string;
  call_index: number;
  worker_contract: WalmartListingObservationWorkerContract;
  prompt_sha256: string;
  image_bindings: readonly WalmartListingObservationImageBinding[];
}

export function walmartListingObservationCallKey(input: CallKeyInput): string {
  return walmartListingObservationSha256({
    schema_version: WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
    observer_version: WALMART_LISTING_OBSERVER_VERSION,
    run_lock_sha256: input.run_lock_sha256,
    shard_id: input.shard_id,
    call_index: input.call_index,
    provider: "claude_cli_subscription",
    worker_contract: input.worker_contract,
    prompt: { version: BLIND_PROMPT_VERSION, sha256: input.prompt_sha256 },
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    image_bindings: input.image_bindings,
  });
}

function parseWorkerContract(raw: unknown): WalmartListingObservationWorkerContract {
  exactKeys(raw, [
    "worker_build", "model", "reasoning_effort", "cli_version", "node_version",
    "runtime_platform", "runtime_arch", "vision_timeout_ms", "reservation_ledger",
  ], "worker_contract");
  if (typeof raw.worker_build !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(raw.worker_build)) {
    throw new Error("worker_contract.worker_build is invalid");
  }
  if (raw.model !== "sonnet" || raw.reasoning_effort !== null) {
    throw new Error("worker_contract must use Claude sonnet with null reasoning effort");
  }
  return {
    worker_build: raw.worker_build as `sha256:${string}`,
    model: "sonnet",
    reasoning_effort: null,
    cli_version: stringValue(raw.cli_version, "worker_contract.cli_version", 200),
    node_version: stringValue(raw.node_version, "worker_contract.node_version", 100),
    runtime_platform: stringValue(raw.runtime_platform, "worker_contract.runtime_platform", 100),
    runtime_arch: stringValue(raw.runtime_arch, "worker_contract.runtime_arch", 100),
    vision_timeout_ms: safeInteger(raw.vision_timeout_ms, "worker_contract.vision_timeout_ms", 1_000),
    reservation_ledger: parseWalmartListingWorkerReservationLedgerContract(
      raw.reservation_ledger,
      "worker_contract.reservation_ledger",
    ),
  };
}

function parseBindings(raw: unknown): WalmartListingObservationImageBinding[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 6) {
    throw new Error("image_bindings must contain 1..6 images");
  }
  const rows = raw.map((value, index) => {
    const path = `image_bindings[${index}]`;
    exactKeys(value, [
      "listing_key", "item_id", "slot", "asset_sha256", "model_view_sha256", "image_id",
    ], path);
    const listingKey = stringValue(value.listing_key, `${path}.listing_key`);
    if (!/^walmart:[1-9]\d*:.+/u.test(listingKey)) throw new Error(`${path}.listing_key is not canonical`);
    const itemId = stringValue(value.item_id, `${path}.item_id`);
    if (!/^[1-9]\d*$/u.test(itemId)) throw new Error(`${path}.item_id must be numeric`);
    const slot = stringValue(value.slot, `${path}.slot`) as ImageSlot;
    if (slot !== "main" && !/^gallery-[1-9]\d*$/u.test(slot)) throw new Error(`${path}.slot is invalid`);
    const assetSha = sha256Value(value.asset_sha256, `${path}.asset_sha256`);
    const modelSha = sha256Value(value.model_view_sha256, `${path}.model_view_sha256`);
    const imageId = walmartListingObservationImageId(assetSha, slot, listingKey);
    if (value.image_id !== imageId) throw new Error(`${path}.image_id is not derived from listing/slot/asset SHA`);
    return {
      listing_key: listingKey,
      item_id: itemId,
      slot,
      asset_sha256: assetSha,
      model_view_sha256: modelSha,
      image_id: imageId,
    };
  });
  if (new Set(rows.map((row) => row.image_id)).size !== rows.length
    || new Set(rows.map((row) => `${row.listing_key}\u0000${row.item_id}\u0000${row.slot}`)).size !== rows.length) {
    throw new Error("image bindings and image IDs must be unique");
  }
  return rows;
}

function parseExecution(raw: unknown): WalmartListingObservationBatchBody["execution"] {
  exactKeys(raw, [
    "subscription_calls_consumed", "transport_attempts", "retries", "fallbacks",
    "paid_api_calls", "openai_model_calls", "input_image_count_attested",
    "worker_contract_attested",
  ], "execution");
  if (raw.subscription_calls_consumed !== 1 || raw.transport_attempts !== 1
    || raw.retries !== 0 || raw.fallbacks !== 0 || raw.paid_api_calls !== 0
    || raw.openai_model_calls !== 0 || raw.input_image_count_attested !== true
    || raw.worker_contract_attested !== true) {
    throw new Error("execution must prove exactly one attested call with no retry/fallback/paid/OpenAI call");
  }
  return {
    subscription_calls_consumed: 1,
    transport_attempts: 1,
    retries: 0,
    fallbacks: 0,
    paid_api_calls: 0,
    openai_model_calls: 0,
    input_image_count_attested: true,
    worker_contract_attested: true,
  };
}

function parseExecutionPermit(
  raw: unknown,
  runLockSha256: string,
  shardId: string,
): WalmartListingExecutionPermit {
  exactKeys(raw, ["sha256", "body"], "execution_permit");
  exactKeys(raw.body, [
    "schema_version", "permit_id", "run_lock_sha256", "run_id", "partition_id",
    "partition_index", "shard_ids", "preflight_certificate_sha256", "created_at",
    "expires_at", "owner_authorization", "authorization_binding", "allowance_reservation",
  ], "execution_permit.body");
  if (raw.body.schema_version !== WALMART_LISTING_EXECUTION_PERMIT_SCHEMA) {
    throw new Error("execution_permit schema is invalid");
  }
  if (!Array.isArray(raw.body.shard_ids) || raw.body.shard_ids.length < 1
    || raw.body.shard_ids.length > 6) {
    throw new Error("execution_permit.body.shard_ids is invalid");
  }
  const shardIds = raw.body.shard_ids.map((value, index) => (
    stringValue(value, `execution_permit.body.shard_ids[${index}]`, 200)
  ));
  if (new Set(shardIds).size !== shardIds.length || !shardIds.includes(shardId)) {
    throw new Error("execution_permit must uniquely include the observation shard");
  }
  const body = {
    schema_version: WALMART_LISTING_EXECUTION_PERMIT_SCHEMA,
    permit_id: stringValue(raw.body.permit_id, "execution_permit.body.permit_id", 200),
    run_lock_sha256: sha256Value(
      raw.body.run_lock_sha256,
      "execution_permit.body.run_lock_sha256",
    ),
    run_id: stringValue(raw.body.run_id, "execution_permit.body.run_id", 200),
    partition_id: stringValue(raw.body.partition_id, "execution_permit.body.partition_id", 200),
    partition_index: safeInteger(
      raw.body.partition_index,
      "execution_permit.body.partition_index",
    ),
    shard_ids: shardIds,
    preflight_certificate_sha256: sha256Value(
      raw.body.preflight_certificate_sha256,
      "execution_permit.body.preflight_certificate_sha256",
    ),
    created_at: canonicalTimestamp(raw.body.created_at, "execution_permit.body.created_at"),
    expires_at: canonicalTimestamp(raw.body.expires_at, "execution_permit.body.expires_at"),
    owner_authorization: canonicalOpaqueObject(
      raw.body.owner_authorization,
      "execution_permit.body.owner_authorization",
    ),
    authorization_binding: canonicalOpaqueObject(
      raw.body.authorization_binding,
      "execution_permit.body.authorization_binding",
    ),
    allowance_reservation: canonicalOpaqueObject(
      raw.body.allowance_reservation,
      "execution_permit.body.allowance_reservation",
    ),
  };
  const permitWindowMs = Date.parse(body.expires_at) - Date.parse(body.created_at);
  if (body.run_lock_sha256 !== runLockSha256
    || permitWindowMs <= 0
    || permitWindowMs > 24 * 60 * 60 * 1_000) {
    throw new Error("execution_permit run-lock or bounded 24h window mismatch");
  }
  const bodyWithoutId = {
    schema_version: body.schema_version,
    run_lock_sha256: body.run_lock_sha256,
    run_id: body.run_id,
    partition_id: body.partition_id,
    partition_index: body.partition_index,
    shard_ids: body.shard_ids,
    preflight_certificate_sha256: body.preflight_certificate_sha256,
    created_at: body.created_at,
    expires_at: body.expires_at,
    owner_authorization: body.owner_authorization,
    authorization_binding: body.authorization_binding,
    allowance_reservation: body.allowance_reservation,
  };
  const expectedPermitId = `permit-${String(body.partition_index).padStart(6, "0")}-${walmartListingObservationSha256(bodyWithoutId).slice(0, 20)}`;
  if (body.permit_id !== expectedPermitId) {
    throw new Error("execution_permit permit_id is not canonically derived");
  }
  const permitSha = sha256Value(raw.sha256, "execution_permit.sha256");
  if (permitSha !== walmartListingObservationSha256(body)) {
    throw new Error("execution_permit SHA does not seal its exact body");
  }
  return { sha256: permitSha, body };
}

function parseRequestAttestation(raw: unknown) {
  exactKeys(raw, [
    "schema_version", "run_lock_sha256", "shard_id", "call_index", "call_key",
    "prompt_sha256", "image_sha256", "execution_permit_sha256", "partition_id",
  ], "worker_receipt.body.request_attestation");
  if (raw.schema_version !== WALMART_LISTING_WORKER_REQUEST_SCHEMA) {
    throw new Error("worker request attestation schema is invalid");
  }
  if (!Array.isArray(raw.image_sha256) || raw.image_sha256.length < 1 || raw.image_sha256.length > 6) {
    throw new Error("worker request image_sha256 count is invalid");
  }
  return {
    schema_version: WALMART_LISTING_WORKER_REQUEST_SCHEMA,
    run_lock_sha256: sha256Value(raw.run_lock_sha256, "worker request run_lock_sha256"),
    shard_id: stringValue(raw.shard_id, "worker request shard_id", 200),
    call_index: safeInteger(raw.call_index, "worker request call_index"),
    call_key: sha256Value(raw.call_key, "worker request call_key"),
    prompt_sha256: sha256Value(raw.prompt_sha256, "worker request prompt_sha256"),
    execution_permit_sha256: sha256Value(
      raw.execution_permit_sha256,
      "worker request execution_permit_sha256",
    ),
    partition_id: stringValue(raw.partition_id, "worker request partition_id", 200),
    image_sha256: raw.image_sha256.map((value, index) => (
      sha256Value(value, `worker request image_sha256[${index}]`)
    )),
  };
}

function parseReceipt(
  raw: unknown,
  locked: {
    run_lock_sha256: string;
    shard_id: string;
    call_index: number;
    call_key: string;
    prompt_sha256: string;
    execution_permit_sha256: string;
    partition_id: string;
    image_sha256: string[];
    result_sha256: string;
    worker_contract: WalmartListingObservationWorkerContract;
    permit_created_at: string;
    permit_expires_at: string;
  },
): WalmartListingWorkerReceipt {
  exactKeys(raw, [
    "schema_version", "key_id", "public_key_spki_der_base64",
    "public_key_spki_sha256", "body", "signature_base64",
  ], "worker_receipt");
  if (raw.schema_version !== WALMART_LISTING_WORKER_RECEIPT_SCHEMA) {
    throw new Error("worker_receipt schema is invalid");
  }
  const keyId = stringValue(raw.key_id, "worker_receipt.key_id", 200);
  const publicBase64 = stringValue(raw.public_key_spki_der_base64, "worker_receipt.public_key_spki_der_base64", 20_000);
  const publicDer = Buffer.from(publicBase64, "base64");
  if (!publicDer.length || publicDer.toString("base64") !== publicBase64
    || createHash("sha256").update(publicDer).digest("hex")
      !== sha256Value(raw.public_key_spki_sha256, "worker_receipt.public_key_spki_sha256")) {
    throw new Error("worker_receipt public key fingerprint mismatch");
  }
  exactKeys(raw.body, [
    "issued_at", "reservation_reserved_at", "request_attestation", "result_canonical_sha256",
    "worker_contract", "subscription_policy",
  ], "worker_receipt.body");
  const request = parseRequestAttestation(raw.body.request_attestation);
  exactKeys(raw.body.worker_contract, [
    "input_image_count", "vision_provider", "vision_model", "vision_reasoning_effort",
    "cli_version", "node_version", "runtime_platform", "runtime_arch", "worker_build",
    "vision_timeout_ms", "reservation_ledger",
  ], "worker_receipt.body.worker_contract");
  const receiptContract = {
    input_image_count: safeInteger(raw.body.worker_contract.input_image_count, "receipt input_image_count", 1),
    vision_provider: raw.body.worker_contract.vision_provider,
    vision_model: raw.body.worker_contract.vision_model,
    vision_reasoning_effort: raw.body.worker_contract.vision_reasoning_effort,
    cli_version: stringValue(raw.body.worker_contract.cli_version, "receipt cli_version", 200),
    node_version: stringValue(raw.body.worker_contract.node_version, "receipt node_version", 100),
    runtime_platform: stringValue(raw.body.worker_contract.runtime_platform, "receipt runtime_platform", 100),
    runtime_arch: stringValue(raw.body.worker_contract.runtime_arch, "receipt runtime_arch", 100),
    worker_build: raw.body.worker_contract.worker_build,
    vision_timeout_ms: safeInteger(
      raw.body.worker_contract.vision_timeout_ms,
      "receipt vision_timeout_ms",
      1_000,
    ),
    reservation_ledger: parseWalmartListingWorkerReservationLedgerContract(
      raw.body.worker_contract.reservation_ledger,
      "worker_receipt.body.worker_contract.reservation_ledger",
    ),
  };
  exactKeys(raw.body.subscription_policy, [
    "auth_mode", "paid_api_environment_absent", "alternate_cloud_routing_absent",
  ], "worker_receipt.body.subscription_policy");
  const policy = raw.body.subscription_policy;
  const exactRequest = {
    schema_version: WALMART_LISTING_WORKER_REQUEST_SCHEMA,
    run_lock_sha256: locked.run_lock_sha256,
    shard_id: locked.shard_id,
    call_index: locked.call_index,
    call_key: locked.call_key,
    prompt_sha256: locked.prompt_sha256,
    execution_permit_sha256: locked.execution_permit_sha256,
    partition_id: locked.partition_id,
    image_sha256: locked.image_sha256,
  };
  const exactReceiptContract = {
    input_image_count: locked.image_sha256.length,
    vision_provider: "claude_cli_subscription",
    vision_model: "sonnet",
    vision_reasoning_effort: null,
    cli_version: locked.worker_contract.cli_version,
    node_version: locked.worker_contract.node_version,
    runtime_platform: locked.worker_contract.runtime_platform,
    runtime_arch: locked.worker_contract.runtime_arch,
    worker_build: locked.worker_contract.worker_build,
    vision_timeout_ms: locked.worker_contract.vision_timeout_ms,
    reservation_ledger: locked.worker_contract.reservation_ledger,
  } satisfies WalmartListingWorkerReceipt["body"]["worker_contract"];
  const resultSha = sha256Value(raw.body.result_canonical_sha256, "receipt result_canonical_sha256");
  const reservationReservedAt = canonicalTimestamp(
    raw.body.reservation_reserved_at,
    "worker_receipt.body.reservation_reserved_at",
  );
  const issuedAt = canonicalTimestamp(raw.body.issued_at, "worker_receipt.body.issued_at");
  const reservationMs = Date.parse(reservationReservedAt);
  const issuedMs = Date.parse(issuedAt);
  const requiredReservationHeadroomMs = locked.worker_contract.vision_timeout_ms
    + WALMART_LISTING_OBSERVER_RESPONSE_MARGIN_MS;
  if (!exactEqual(request, exactRequest)
    || !exactEqual(receiptContract, exactReceiptContract)
    || resultSha !== locked.result_sha256
    || policy.auth_mode !== "claude_subscription_oauth"
    || policy.paid_api_environment_absent !== true
    || policy.alternate_cloud_routing_absent !== true
    || reservationMs < Date.parse(locked.permit_created_at)
    || reservationMs >= Date.parse(locked.permit_expires_at)
    || Date.parse(locked.permit_expires_at) - reservationMs
      < requiredReservationHeadroomMs
    || issuedMs < reservationMs
    || issuedMs > reservationMs + locked.worker_contract.vision_timeout_ms
      + WALMART_LISTING_OBSERVER_RESPONSE_MARGIN_MS) {
    throw new Error("worker receipt exact locked request/result/runtime/subscription policy mismatch");
  }
  const signatureBase64 = stringValue(raw.signature_base64, "worker_receipt.signature_base64", 20_000);
  const signature = Buffer.from(signatureBase64, "base64");
  let publicKey;
  try {
    publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
  } catch {
    throw new Error("worker_receipt public key is invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519"
    || !signature.length || signature.toString("base64") !== signatureBase64
    || !verifySignature(
      null,
      Buffer.from(canonicalWalmartListingObservationJson(raw.body), "utf8"),
      publicKey,
      signature,
    )) {
    throw new Error("worker_receipt signature is invalid");
  }
  return {
    schema_version: WALMART_LISTING_WORKER_RECEIPT_SCHEMA,
    key_id: keyId,
    public_key_spki_der_base64: publicBase64,
    public_key_spki_sha256: sha256Value(raw.public_key_spki_sha256, "worker receipt key SHA"),
    body: {
      issued_at: issuedAt,
      reservation_reserved_at: reservationReservedAt,
      request_attestation: request,
      result_canonical_sha256: resultSha,
      worker_contract: exactReceiptContract,
      subscription_policy: {
        auth_mode: "claude_subscription_oauth",
        paid_api_environment_absent: true,
        alternate_cloud_routing_absent: true,
      },
    },
    signature_base64: signatureBase64,
  };
}

const OCR_VIEW_ROLES = new Set(["full", "tile_front", "bottom_label", "top_left_badge"]);

function parseBoundingBox(raw: unknown, path: string) {
  exactKeys(raw, ["x", "y", "width", "height"], path);
  const box = {
    x: finiteNumber(raw.x, `${path}.x`),
    y: finiteNumber(raw.y, `${path}.y`),
    width: finiteNumber(raw.width, `${path}.width`),
    height: finiteNumber(raw.height, `${path}.height`),
  };
  if (box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0
    || box.x + box.width > 1.000001 || box.y + box.height > 1.000001) {
    throw new Error(`${path} is outside normalized bounds`);
  }
  return box;
}

function parseLocalOcr(
  raw: unknown,
  bindings: readonly WalmartListingObservationImageBinding[],
): WalmartListingOcrEvidenceRow[] {
  if (!Array.isArray(raw) || raw.length !== bindings.length) {
    throw new Error("local_ocr must contain exactly one row per image binding");
  }
  return raw.map((value, index) => {
    const path = `local_ocr[${index}]`;
    const binding = bindings[index]!;
    exactKeys(value, [
      "image_id", "asset_sha256", "full_view_sha256", "preprocessor_version",
      "ocr_engine", "ocr_script_sha256", "ocr_output_sha256", "ocr_output",
      "truncated", "auxiliary_ocr",
    ], path);
    if (value.image_id !== binding.image_id || value.asset_sha256 !== binding.asset_sha256
      || value.full_view_sha256 !== binding.model_view_sha256
      || value.preprocessor_version !== VISUAL_PREPROCESS_VERSION
      || value.ocr_engine !== LOCAL_VISUAL_OCR_ENGINE) {
      throw new Error(`${path} is not bound to its image/preprocessor`);
    }
    exactKeys(value.ocr_output, ["schema_version", "engine", "views"], `${path}.ocr_output`);
    if (value.ocr_output.schema_version !== WALMART_LISTING_OCR_EVIDENCE_SCHEMA
      || value.ocr_output.engine !== LOCAL_VISUAL_OCR_ENGINE
      || !Array.isArray(value.ocr_output.views)
      || value.ocr_output.views.length < 1 || value.ocr_output.views.length > 4) {
      throw new Error(`${path}.ocr_output schema/engine/views are invalid`);
    }
    const roles = new Set<string>();
    const viewShas = new Set<string>();
    const trustedByLiteral = new Map<string, AuditAuxiliaryEvidence["ocr_texts"][number]>();
    const views = value.ocr_output.views.map((view, viewIndex) => {
      const viewPath = `${path}.ocr_output.views[${viewIndex}]`;
      exactKeys(view, ["view_role", "view_sha256", "width", "height", "observations"], viewPath);
      if (typeof view.view_role !== "string" || !OCR_VIEW_ROLES.has(view.view_role)
        || roles.has(view.view_role)) throw new Error(`${viewPath}.view_role is invalid/duplicate`);
      const viewSha = sha256Value(view.view_sha256, `${viewPath}.view_sha256`);
      if (viewShas.has(viewSha)) throw new Error(`${viewPath}.view_sha256 is duplicate`);
      roles.add(view.view_role);
      viewShas.add(viewSha);
      if (!Array.isArray(view.observations) || view.observations.length > 1_000) {
        throw new Error(`${viewPath}.observations exceeds its cap`);
      }
      const observations = view.observations.map((observation, observationIndex) => {
        const observationPath = `${viewPath}.observations[${observationIndex}]`;
        exactKeys(observation, ["text", "confidence", "bounding_box"], observationPath);
        const row = {
          text: stringValue(observation.text, `${observationPath}.text`, 500),
          confidence: finiteNumber(observation.confidence, `${observationPath}.confidence`),
          bounding_box: parseBoundingBox(observation.bounding_box, `${observationPath}.bounding_box`),
        };
        if (row.confidence < 0 || row.confidence > 1) throw new Error(`${observationPath}.confidence is outside 0..1`);
        if (row.confidence >= WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE) {
          const selected = {
            ...row,
            view_role: view.view_role as "full" | "tile_front" | "bottom_label" | "top_left_badge",
            view_sha256: viewSha,
          };
          const key = `${viewSha}|${row.text.trim().replace(/\s+/gu, " ").toLowerCase()}`;
          const prior = trustedByLiteral.get(key);
          if (!prior || row.confidence > prior.confidence) trustedByLiteral.set(key, selected);
        }
        return row;
      });
      return {
        view_role: view.view_role as "full" | "tile_front" | "bottom_label" | "top_left_badge",
        view_sha256: viewSha,
        width: safeInteger(view.width, `${viewPath}.width`, 1),
        height: safeInteger(view.height, `${viewPath}.height`, 1),
        observations,
      };
    });
    const full = views.filter((view) => view.view_role === "full");
    if (full.length !== 1 || full[0]!.view_sha256 !== binding.model_view_sha256) {
      throw new Error(`${path}.ocr_output must contain the exact full view`);
    }
    const trusted = [...trustedByLiteral.values()];
    const rebuiltAuxiliary = { ocr_texts: trusted.slice(0, 100) };
    const rebuiltTruncated = trusted.length > 100;
    if (!exactEqual(value.auxiliary_ocr, rebuiltAuxiliary)
      || value.truncated !== rebuiltTruncated) {
      throw new Error(`${path}.auxiliary_ocr/truncated does not rebuild from OCR output`);
    }
    const ocrOutput = {
      schema_version: WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
      engine: LOCAL_VISUAL_OCR_ENGINE,
      views,
    };
    if (value.ocr_output_sha256 !== walmartListingObservationSha256(ocrOutput)) {
      throw new Error(`${path}.ocr_output_sha256 mismatch`);
    }
    return {
      image_id: binding.image_id,
      asset_sha256: binding.asset_sha256,
      full_view_sha256: binding.model_view_sha256,
      preprocessor_version: VISUAL_PREPROCESS_VERSION,
      ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
      ocr_script_sha256: sha256Value(value.ocr_script_sha256, `${path}.ocr_script_sha256`),
      ocr_output_sha256: value.ocr_output_sha256,
      ocr_output: ocrOutput,
      truncated: rebuiltTruncated,
      auxiliary_ocr: rebuiltAuxiliary,
    };
  });
}

function parseBody(raw: unknown): WalmartListingObservationBatchBody {
  exactKeys(raw, [
    "schema_version", "observer_version", "run_lock_sha256", "shard_id", "call_index",
    "call_key", "created_at", "provider", "worker_contract", "worker_receipt",
    "execution_permit", "execution", "prompt", "preprocessor_version", "image_bindings",
    "result_canonical_sha256", "result", "local_ocr",
  ], "observation batch");
  if (raw.schema_version !== WALMART_LISTING_OBSERVATION_BATCH_SCHEMA
    || raw.observer_version !== WALMART_LISTING_OBSERVER_VERSION
    || raw.provider !== "claude_cli_subscription"
    || raw.preprocessor_version !== VISUAL_PREPROCESS_VERSION) {
    throw new Error("observation batch schema/version/provider/preprocessor mismatch");
  }
  const runLockSha = sha256Value(raw.run_lock_sha256, "run_lock_sha256");
  const shardId = stringValue(raw.shard_id, "shard_id", 200);
  const callIndex = safeInteger(raw.call_index, "call_index");
  const worker = parseWorkerContract(raw.worker_contract);
  const bindings = parseBindings(raw.image_bindings);
  const permit = parseExecutionPermit(raw.execution_permit, runLockSha, shardId);
  exactKeys(raw.prompt, ["version", "sha256"], "prompt");
  const imageIds = bindings.map((binding) => binding.image_id);
  const promptSha = walmartListingObservationPromptSha256(imageIds);
  if (raw.prompt.version !== BLIND_PROMPT_VERSION || raw.prompt.sha256 !== promptSha) {
    throw new Error("prompt version/SHA does not rebuild from image IDs");
  }
  const callKey = walmartListingObservationCallKey({
    run_lock_sha256: runLockSha,
    shard_id: shardId,
    call_index: callIndex,
    worker_contract: worker,
    prompt_sha256: promptSha,
    image_bindings: bindings,
  });
  if (raw.call_key !== callKey) throw new Error("call_key does not rebuild from the exact locked call");
  const observations = parseBlindResponse(raw.result, imageIds);
  const result = { schema_version: BLIND_OBSERVATION_SCHEMA, observations };
  const resultSha = walmartListingObservationSha256(result);
  if (raw.result_canonical_sha256 !== resultSha
    || walmartListingObservationSha256(raw.result) !== resultSha) {
    throw new Error("result_canonical_sha256/result mismatch");
  }
  const receipt = parseReceipt(raw.worker_receipt, {
    run_lock_sha256: runLockSha,
    shard_id: shardId,
    call_index: callIndex,
    call_key: callKey,
    prompt_sha256: promptSha,
    execution_permit_sha256: permit.sha256,
    partition_id: permit.body.partition_id,
    image_sha256: bindings.map((binding) => binding.model_view_sha256),
    result_sha256: resultSha,
    worker_contract: worker,
    permit_created_at: permit.body.created_at,
    permit_expires_at: permit.body.expires_at,
  });
  const createdAt = canonicalTimestamp(raw.created_at, "created_at");
  if (createdAt !== receipt.body.reservation_reserved_at) {
    throw new Error("created_at must equal the signed server reservation timestamp");
  }
  return {
    schema_version: WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
    observer_version: WALMART_LISTING_OBSERVER_VERSION,
    run_lock_sha256: runLockSha,
    shard_id: shardId,
    call_index: callIndex,
    call_key: callKey,
    created_at: createdAt,
    provider: "claude_cli_subscription",
    worker_contract: worker,
    worker_receipt: receipt,
    execution_permit: permit,
    execution: parseExecution(raw.execution),
    prompt: { version: BLIND_PROMPT_VERSION, sha256: promptSha },
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    image_bindings: bindings,
    result_canonical_sha256: resultSha,
    result,
    local_ocr: parseLocalOcr(raw.local_ocr, bindings),
  };
}

const TECHNICAL_ERROR_TERMINAL_EXECUTION = {
  subscription_calls_consumed: "unknown_0_or_1",
  transport_attempts_maximum: 1,
  retries: 0,
  fallbacks: 0,
  paid_api_calls: 0,
  openai_model_calls: 0,
  worker_result_present: false,
  worker_receipt_present: false,
  pass_eligible: false,
} as const;

function parseTechnicalErrorTerminalBody(
  raw: unknown,
): WalmartListingObservationTechnicalErrorTerminalBody {
  exactKeys(raw, [
    "schema_version", "observer_version", "run_lock_sha256", "shard_id", "call_index",
    "call_key", "reserved_at", "terminalized_at", "terminal_state", "audit_outcome",
    "reason_code", "attempt_body_sha256", "execution_permit", "worker_contract",
    "prompt", "preprocessor_version", "image_bindings", "image_outcomes", "execution",
  ], "technical-error terminal");
  if (raw.schema_version !== WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA
    || raw.observer_version !== WALMART_LISTING_OBSERVER_VERSION
    || raw.terminal_state !== "BLOCKED_AMBIGUOUS"
    || raw.audit_outcome !== "TECH_ERROR"
    || raw.reason_code !== "attempt_reserved_without_verifiable_worker_result"
    || raw.preprocessor_version !== VISUAL_PREPROCESS_VERSION) {
    throw new Error("technical-error terminal schema/status/reason/preprocessor mismatch");
  }
  const runLockSha = sha256Value(raw.run_lock_sha256, "terminal.run_lock_sha256");
  const shardId = stringValue(raw.shard_id, "terminal.shard_id", 200);
  const callIndex = safeInteger(raw.call_index, "terminal.call_index");
  const workerContract = parseWorkerContract(raw.worker_contract);
  const bindings = parseBindings(raw.image_bindings);
  const permit = parseExecutionPermit(raw.execution_permit, runLockSha, shardId);
  exactKeys(raw.prompt, ["version", "sha256"], "terminal.prompt");
  const imageIds = bindings.map((binding) => binding.image_id);
  const promptSha = walmartListingObservationPromptSha256(imageIds);
  if (raw.prompt.version !== BLIND_PROMPT_VERSION || raw.prompt.sha256 !== promptSha) {
    throw new Error("technical-error terminal prompt does not rebuild from image IDs");
  }
  const callKey = walmartListingObservationCallKey({
    run_lock_sha256: runLockSha,
    shard_id: shardId,
    call_index: callIndex,
    worker_contract: workerContract,
    prompt_sha256: promptSha,
    image_bindings: bindings,
  });
  if (raw.call_key !== callKey) {
    throw new Error("technical-error terminal call_key does not rebuild from the locked call");
  }
  const reservedAt = canonicalTimestamp(raw.reserved_at, "terminal.reserved_at");
  const terminalizedAt = canonicalTimestamp(raw.terminalized_at, "terminal.terminalized_at");
  const reservedMs = Date.parse(reservedAt);
  const requiredReservationHeadroomMs = workerContract.vision_timeout_ms
    + WALMART_LISTING_OBSERVER_RESPONSE_MARGIN_MS;
  if (reservedMs < Date.parse(permit.body.created_at)
    || reservedMs >= Date.parse(permit.body.expires_at)
    || Date.parse(permit.body.expires_at) - reservedMs
      < requiredReservationHeadroomMs
    || Date.parse(terminalizedAt) < reservedMs) {
    throw new Error("technical-error terminal timing is outside its permit/reservation bounds");
  }
  if (!Array.isArray(raw.image_outcomes) || raw.image_outcomes.length !== bindings.length) {
    throw new Error("technical-error terminal must contain one image outcome per binding");
  }
  const imageOutcomes = raw.image_outcomes.map((value, index) => {
    const path = `technical-error terminal.image_outcomes[${index}]`;
    exactKeys(value, ["image_id", "outcome", "required_action"], path);
    if (value.image_id !== bindings[index]!.image_id
      || value.outcome !== "TECH_ERROR" || value.required_action !== "REVIEW") {
      throw new Error(`${path} must map the ordered binding to TECH_ERROR/REVIEW`);
    }
    return {
      image_id: bindings[index]!.image_id,
      outcome: "TECH_ERROR" as const,
      required_action: "REVIEW" as const,
    };
  });
  if (!exactEqual(raw.execution, TECHNICAL_ERROR_TERMINAL_EXECUTION)) {
    throw new Error("technical-error terminal execution must remain fail-closed and non-PASS-eligible");
  }
  return {
    schema_version: WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA,
    observer_version: WALMART_LISTING_OBSERVER_VERSION,
    run_lock_sha256: runLockSha,
    shard_id: shardId,
    call_index: callIndex,
    call_key: callKey,
    reserved_at: reservedAt,
    terminalized_at: terminalizedAt,
    terminal_state: "BLOCKED_AMBIGUOUS",
    audit_outcome: "TECH_ERROR",
    reason_code: "attempt_reserved_without_verifiable_worker_result",
    attempt_body_sha256: sha256Value(
      raw.attempt_body_sha256,
      "terminal.attempt_body_sha256",
    ),
    execution_permit: permit,
    worker_contract: workerContract,
    prompt: { version: BLIND_PROMPT_VERSION, sha256: promptSha },
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    image_bindings: bindings,
    image_outcomes: imageOutcomes,
    execution: TECHNICAL_ERROR_TERMINAL_EXECUTION,
  };
}

export function sealWalmartListingObservationBatch(
  raw: WalmartListingObservationBatchBody,
): SealedWalmartListingObservationBatch {
  const body = parseBody(raw);
  const bodySha = walmartListingObservationSha256(body);
  return {
    ...body,
    artifact_id: `walmart-claude-observation-${body.call_index}-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

export function verifyWalmartListingObservationBatch(
  raw: unknown,
  expectedRunLockSha256?: string,
): SealedWalmartListingObservationBatch {
  exactKeys(raw, [
    "schema_version", "observer_version", "run_lock_sha256", "shard_id", "call_index",
    "call_key", "created_at", "provider", "worker_contract", "worker_receipt",
    "execution_permit", "execution", "prompt", "preprocessor_version", "image_bindings",
    "result_canonical_sha256", "result", "local_ocr", "artifact_id", "body_sha256",
  ], "sealed observation batch");
  const { artifact_id: artifactId, body_sha256: rawBodySha, ...rawBody } = raw;
  const body = parseBody(rawBody);
  const bodySha = walmartListingObservationSha256(body);
  if (rawBodySha !== bodySha
    || artifactId !== `walmart-claude-observation-${body.call_index}-${bodySha.slice(0, 16)}`) {
    throw new Error("sealed observation artifact_id/body_sha256 mismatch");
  }
  if (expectedRunLockSha256 !== undefined
    && body.run_lock_sha256 !== sha256Value(expectedRunLockSha256, "expected run_lock_sha256")) {
    throw new Error("sealed observation is not bound to the expected run lock");
  }
  return { ...body, artifact_id: artifactId as string, body_sha256: bodySha };
}

export function sealWalmartListingObservationTechnicalErrorTerminal(
  raw: WalmartListingObservationTechnicalErrorTerminalBody,
): SealedWalmartListingObservationTechnicalErrorTerminal {
  const body = parseTechnicalErrorTerminalBody(raw);
  const bodySha = walmartListingObservationSha256(body);
  return {
    ...body,
    artifact_id: `walmart-observation-terminal-${body.call_index}-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

export function verifyWalmartListingObservationTechnicalErrorTerminal(
  raw: unknown,
  expectedRunLockSha256?: string,
): SealedWalmartListingObservationTechnicalErrorTerminal {
  exactKeys(raw, [
    "schema_version", "observer_version", "run_lock_sha256", "shard_id", "call_index",
    "call_key", "reserved_at", "terminalized_at", "terminal_state", "audit_outcome",
    "reason_code", "attempt_body_sha256", "execution_permit", "worker_contract",
    "prompt", "preprocessor_version", "image_bindings", "image_outcomes", "execution",
    "artifact_id", "body_sha256",
  ], "sealed technical-error terminal");
  const { artifact_id: artifactId, body_sha256: rawBodySha, ...rawBody } = raw;
  const body = parseTechnicalErrorTerminalBody(rawBody);
  const bodySha = walmartListingObservationSha256(body);
  if (rawBodySha !== bodySha
    || artifactId !== `walmart-observation-terminal-${body.call_index}-${bodySha.slice(0, 16)}`) {
    throw new Error("sealed technical-error terminal artifact_id/body_sha256 mismatch");
  }
  if (expectedRunLockSha256 !== undefined
    && body.run_lock_sha256 !== sha256Value(expectedRunLockSha256, "expected run_lock_sha256")) {
    throw new Error("sealed technical-error terminal is not bound to the expected run lock");
  }
  return { ...body, artifact_id: artifactId as string, body_sha256: bodySha };
}

/** Verify the only two artifact variants allowed at an observation path. */
export function verifyWalmartListingObservationArtifact(
  raw: unknown,
  expectedRunLockSha256?: string,
): SealedWalmartListingObservationArtifact {
  if (!isRecord(raw)) throw new Error("sealed observation artifact must be an object");
  if (raw.schema_version === WALMART_LISTING_OBSERVATION_BATCH_SCHEMA) {
    return verifyWalmartListingObservationBatch(raw, expectedRunLockSha256);
  }
  if (raw.schema_version === WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA) {
    return verifyWalmartListingObservationTechnicalErrorTerminal(raw, expectedRunLockSha256);
  }
  throw new Error("sealed observation artifact schema is unsupported");
}
