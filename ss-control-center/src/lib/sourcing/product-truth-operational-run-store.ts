import { createHash } from "node:crypto";

import type { Client, InStatement, ResultSet } from "@libsql/client";

import {
  PRODUCT_TRUTH_OPERATIONAL_PLAN_VERSION,
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
  type ProductTruthOperationalPlan,
} from "./product-truth-operational-run-contract";

export const PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR =
  "PRODUCT_TRUTH_OPERATIONAL_MIGRATION_REQUIRED" as const;
export const PRODUCT_TRUTH_OPERATIONAL_EVENT_VERSION =
  "product-truth-operational-event/1.0.0" as const;

const ZERO_HASH = "0".repeat(64);
const ACTIVE_ITEM_STATUSES = [
  "claimed",
  "reuse_checked",
  "costing",
  "harvesting",
  "verifying",
] as const;

const RUN_COLUMNS = [
  "runId", "approvalId", "planSchemaVersion", "planSha256", "planJson",
  "mode", "environment", "targetFingerprint", "manifestSha256",
  "targetSetSha256", "targetCount", "sourcePolicyJson", "providerCeilingsJson",
  "status", "leaseOwner", "leaseToken", "leaseExpiresAt", "heartbeatAt",
  "startedAt", "finishedAt", "eventChainHead", "reportSha256",
  "artifactIndexSha256", "createdAt", "updatedAt",
] as const;

const ITEM_COLUMNS = [
  "id", "runId", "listingKey", "ordinal", "requestedFields", "queueJobId",
  "status", "stage", "attempts", "leaseToken", "leaseExpiresAt",
  "checkpointJson", "checkpointSha256", "resultJson", "resultSha256",
  "lastError", "startedAt", "finishedAt", "createdAt", "updatedAt",
] as const;

const EVENT_COLUMNS = [
  "id", "runId", "eventIndex", "eventType", "itemId", "previousHash",
  "payloadJson", "payloadSha256", "eventHash", "createdAt",
] as const;

const REQUIRED_TRIGGERS = [
  "ProductTruthOperationalRun_initial_state_guard",
  "ProductTruthOperationalRun_identity_immutable",
  "ProductTruthOperationalRun_status_transition_guard",
  "ProductTruthOperationalRun_lease_contract_guard",
  "ProductTruthOperationalRun_time_guard",
  "ProductTruthOperationalRun_event_chain_head_guard",
  "ProductTruthOperationalRun_delete_guard",
  "MeteredProviderBudget_operational_run_guard",
  "MeteredProviderBudget_operational_counter_guard",
  "MeteredReservationReceipt_operational_run_guard",
  "MeteredReservationReceipt_operational_authorization_guard",
  "ProductTruthOperationalRunItem_initial_state_guard",
  "ProductTruthOperationalRunItem_identity_immutable",
  "ProductTruthOperationalRunItem_attempt_guard",
  "ProductTruthOperationalRunItem_attempt_queue_guard",
  "ProductTruthOperationalRunItem_status_transition_guard",
  "ProductTruthOperationalRunItem_terminal_guard",
  "ProductTruthOperationalRunItem_time_guard",
  "ProductTruthOperationalRunItem_queue_scope_guard",
  "ProductTruthOperationalRunItem_delete_guard",
  "ProductTruthOperationalEvent_chain_guard",
  "ProductTruthOperationalEvent_advance_chain",
  "ProductTruthOperationalEvent_update_guard",
  "ProductTruthOperationalEvent_delete_guard",
] as const;

const REQUIRED_INDEXES = [
  "ProductTruthOperationalRun_one_running_environment",
  "ProductTruthOperationalRun_status_updated_idx",
  "ProductTruthOperationalRunItem_claim_idx",
  "ProductTruthOperationalRunItem_one_active_per_run",
  "ProductTruthOperationalEvent_run_idx",
] as const;

const REQUIRED_TRIGGER_MARKERS: Record<(typeof REQUIRED_TRIGGERS)[number], readonly string[]> = {
  ProductTruthOperationalRun_initial_state_guard: ["PRODUCT_TRUTH_OPERATIONAL_RUN_INITIAL_STATE_INVALID"],
  ProductTruthOperationalRun_identity_immutable: ["PRODUCT_TRUTH_OPERATIONAL_RUN_IDENTITY_IMMUTABLE"],
  ProductTruthOperationalRun_status_transition_guard: ["PRODUCT_TRUTH_OPERATIONAL_RUN_STATUS_INVALID"],
  ProductTruthOperationalRun_lease_contract_guard: ["PRODUCT_TRUTH_OPERATIONAL_RUN_LEASE_CONTRACT_INVALID"],
  ProductTruthOperationalRun_time_guard: ["PRODUCT_TRUTH_OPERATIONAL_RUN_TIME_INVALID"],
  ProductTruthOperationalRun_event_chain_head_guard: ["PRODUCT_TRUTH_OPERATIONAL_EVENT_CHAIN_HEAD_INVALID"],
  ProductTruthOperationalRun_delete_guard: ["PRODUCT_TRUTH_OPERATIONAL_RUN_IMMUTABLE"],
  MeteredProviderBudget_operational_run_guard: ["METERED_BUDGET_OPERATIONAL_RUN_MISMATCH", "providerCeilingsJson"],
  MeteredProviderBudget_operational_counter_guard: ["METERED_BUDGET_OPERATIONAL_RUN_NOT_LIVE"],
  MeteredReservationReceipt_operational_run_guard: ["METERED_RECEIPT_OPERATIONAL_RUN_NOT_LIVE"],
  MeteredReservationReceipt_operational_authorization_guard: ["METERED_RECEIPT_OPERATIONAL_RUN_NOT_LIVE"],
  ProductTruthOperationalRunItem_initial_state_guard: ["PRODUCT_TRUTH_OPERATIONAL_ITEM_INITIAL_STATE_INVALID"],
  ProductTruthOperationalRunItem_identity_immutable: ["PRODUCT_TRUTH_OPERATIONAL_ITEM_IDENTITY_IMMUTABLE"],
  ProductTruthOperationalRunItem_attempt_guard: ["PRODUCT_TRUTH_OPERATIONAL_ITEM_ATTEMPT_INVALID"],
  ProductTruthOperationalRunItem_attempt_queue_guard: ["PRODUCT_TRUTH_OPERATIONAL_ITEM_QUEUE_ATTEMPT_REQUIRED", "EnrichmentJob"],
  ProductTruthOperationalRunItem_status_transition_guard: ["PRODUCT_TRUTH_OPERATIONAL_ITEM_STATUS_INVALID"],
  ProductTruthOperationalRunItem_terminal_guard: ["PRODUCT_TRUTH_OPERATIONAL_ITEM_TERMINAL_CONTRACT_INVALID", "reuse_checked"],
  ProductTruthOperationalRunItem_time_guard: ["PRODUCT_TRUTH_OPERATIONAL_ITEM_TIME_INVALID"],
  ProductTruthOperationalRunItem_queue_scope_guard: ["PRODUCT_TRUTH_OPERATIONAL_ITEM_QUEUE_SCOPE_INVALID", "EnrichmentJob"],
  ProductTruthOperationalRunItem_delete_guard: ["PRODUCT_TRUTH_OPERATIONAL_ITEM_IMMUTABLE"],
  ProductTruthOperationalEvent_chain_guard: ["PRODUCT_TRUTH_OPERATIONAL_EVENT_CHAIN_INVALID", "eventChainHead"],
  ProductTruthOperationalEvent_advance_chain: ["eventChainHead", "eventHash"],
  ProductTruthOperationalEvent_update_guard: ["PRODUCT_TRUTH_OPERATIONAL_EVENT_IMMUTABLE"],
  ProductTruthOperationalEvent_delete_guard: ["PRODUCT_TRUTH_OPERATIONAL_EVENT_IMMUTABLE"],
};

const REQUIRED_INDEX_CONTRACTS: Record<
  (typeof REQUIRED_INDEXES)[number],
  { table: string; columns: readonly string[]; unique: boolean; partial: boolean }
> = {
  ProductTruthOperationalRun_one_running_environment: {
    table: "ProductTruthOperationalRun",
    columns: ["environment"],
    unique: true,
    partial: true,
  },
  ProductTruthOperationalRun_status_updated_idx: {
    table: "ProductTruthOperationalRun",
    columns: ["status", "updatedAt"],
    unique: false,
    partial: false,
  },
  ProductTruthOperationalRunItem_claim_idx: {
    table: "ProductTruthOperationalRunItem",
    columns: ["runId", "status", "ordinal"],
    unique: false,
    partial: false,
  },
  ProductTruthOperationalRunItem_one_active_per_run: {
    table: "ProductTruthOperationalRunItem",
    columns: ["runId"],
    unique: true,
    partial: true,
  },
  ProductTruthOperationalEvent_run_idx: {
    table: "ProductTruthOperationalEvent",
    columns: ["runId", "eventIndex"],
    unique: false,
    partial: false,
  },
};

const TERMINAL_ITEM_STATUSES = [
  "done",
  "terminal_gap",
  "blocked",
  "ambiguous",
  "failed",
] as const;

export type ProductTruthOperationalEnvironment = "production" | "local-test";
export type ProductTruthOperationalRunStatus =
  | "prepared"
  | "running"
  | "interrupted"
  | "blocked"
  | "ambiguous"
  | "completed"
  | "failed";
export type ProductTruthOperationalItemStatus =
  | "pending"
  | "claimed"
  | "reuse_checked"
  | "costing"
  | "harvesting"
  | "verifying"
  | "done"
  | "terminal_gap"
  | "blocked"
  | "ambiguous"
  | "failed";

export interface StoredProductTruthOperationalRun {
  runId: string;
  approvalId: string;
  planSchemaVersion: string;
  planSha256: string;
  planJson: string;
  mode: "CANARY" | "WAVE";
  environment: ProductTruthOperationalEnvironment;
  targetFingerprint: string;
  manifestSha256: string;
  targetSetSha256: string;
  targetCount: number;
  sourcePolicyJson: string;
  providerCeilingsJson: string;
  status: ProductTruthOperationalRunStatus;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  eventChainHead: string;
  reportSha256: string | null;
  artifactIndexSha256: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredProductTruthOperationalRunItem {
  id: string;
  runId: string;
  listingKey: string;
  ordinal: number;
  requestedFields: string[];
  queueJobId: string | null;
  status: ProductTruthOperationalItemStatus;
  stage: string;
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  checkpointJson: string | null;
  checkpointSha256: string | null;
  resultJson: string | null;
  resultSha256: string | null;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductTruthOperationalEvent {
  id: string;
  runId: string;
  eventIndex: number;
  eventType: string;
  itemId: string | null;
  previousHash: string;
  payloadJson: string;
  payloadSha256: string;
  eventHash: string;
  createdAt: string;
}

interface SqlExecutor {
  execute(statement: InStatement): Promise<ResultSet>;
}

export class ProductTruthOperationalStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthOperationalStoreError";
    this.code = code;
  }
}

function storeError(code: string, message: string, cause?: unknown): ProductTruthOperationalStoreError {
  return new ProductTruthOperationalStoreError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function exactText(value: unknown, label: string, maximum = 1_000): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum) {
    throw storeError("OPERATIONAL_STORE_INPUT_INVALID", `${label} must be exact non-empty text`);
  }
  return value;
}

function exactHash(value: unknown, label: string): string {
  const text = exactText(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw storeError("OPERATIONAL_STORE_INPUT_INVALID", `${label} must be a lowercase SHA-256 digest`);
  }
  return text;
}

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw storeError("OPERATIONAL_STORE_INPUT_INVALID", `${label} must be a timestamp`);
  }
  const milliseconds = Date.parse(String(value));
  if (!Number.isFinite(milliseconds)) {
    throw storeError("OPERATIONAL_STORE_INPUT_INVALID", `${label} must be a valid timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, "expected nullable text");
  return value;
}

function canonicalJsonText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, `${label} must be non-empty JSON text`);
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (renderProductTruthOperationalJson(parsed) !== value) {
      throw new Error("not canonical Product Truth JSON");
    }
  } catch (error) {
    throw storeError(
      PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR,
      `${label} must be canonical JSON with its trailing newline`,
      error,
    );
  }
  return value;
}

function verifiedJsonHash(
  jsonValue: unknown,
  hashValue: unknown,
  label: string,
  maximum: number,
): { json: string | null; hash: string | null } {
  if (jsonValue == null && hashValue == null) return { json: null, hash: null };
  if (jsonValue == null || hashValue == null) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, `${label} JSON/hash pair is incomplete`);
  }
  const json = canonicalJsonText(jsonValue, `${label}Json`, maximum);
  const hash = exactHash(hashValue, `${label}Sha256`);
  if (sha256(json) !== hash) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, `${label} JSON hash does not match`);
  }
  return { json, hash };
}

function integer(value: unknown, label: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, `${label} must be an integer`);
  }
  return number;
}

function parseStringArray(value: unknown, label: string): string[] {
  const json = canonicalJsonText(value, label, 100_000);
  try {
    const parsed = JSON.parse(json) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length < 1
      || parsed.some((item) => typeof item !== "string" || !item || item !== item.trim())
      || new Set(parsed).size !== parsed.length
    ) throw new Error("not an exact unique string array");
    return parsed;
  } catch (error) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, `${label} must be a JSON string array`, error);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function productTruthOperationalRunItemId(runId: string, listingKey: string): string {
  return `ptori_${sha256(`product-truth-operational-item/1\n${exactText(runId, "runId")}\n${exactText(listingKey, "listingKey")}`)}`;
}

function runSelect(): string {
  return RUN_COLUMNS.map((column) => `"${column}"`).join(", ");
}

function itemSelect(): string {
  return ITEM_COLUMNS.map((column) => `"${column}"`).join(", ");
}

function eventSelect(): string {
  return EVENT_COLUMNS.map((column) => `"${column}"`).join(", ");
}

export function parseProductTruthOperationalRunRow(
  row: Record<string, unknown>,
): StoredProductTruthOperationalRun {
  const status = String(row.status) as ProductTruthOperationalRunStatus;
  if (!["prepared", "running", "interrupted", "blocked", "ambiguous", "completed", "failed"].includes(status)) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, `unknown run status ${status}`);
  }
  const mode = String(row.mode);
  const environment = String(row.environment);
  if ((mode !== "CANARY" && mode !== "WAVE") || (environment !== "production" && environment !== "local-test")) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, "invalid run mode/environment");
  }
  const planJson = canonicalJsonText(row.planJson, "planJson", 10_000_000);
  const planSha256 = exactHash(row.planSha256, "planSha256");
  if (sha256(planJson) !== planSha256) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, "planJson does not match planSha256");
  }
  const sourcePolicyJson = canonicalJsonText(row.sourcePolicyJson, "sourcePolicyJson", 100_000);
  const providerCeilingsJson = canonicalJsonText(row.providerCeilingsJson, "providerCeilingsJson", 100_000);
  const parsedPlan = JSON.parse(planJson) as Record<string, unknown>;
  const parsedManifest = parsedPlan.manifest as Record<string, unknown> | undefined;
  const parsedTargets = parsedPlan.targets;
  if (
    parsedPlan.runId !== row.runId
    || parsedPlan.schemaVersion !== row.planSchemaVersion
    || parsedPlan.mode !== mode
    || parsedPlan.targetFingerprint !== row.targetFingerprint
    || parsedManifest?.sha256 !== row.manifestSha256
    || parsedPlan.targetSetSha256 !== row.targetSetSha256
    || !Array.isArray(parsedTargets)
    || parsedTargets.length !== integer(row.targetCount, "targetCount")
    || renderProductTruthOperationalJson(parsedPlan.sourcePolicy) !== sourcePolicyJson
    || renderProductTruthOperationalJson(parsedPlan.providerCeilings) !== providerCeilingsJson
  ) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, "stored run projection differs from sealed plan");
  }
  const leaseOwner = nullableText(row.leaseOwner);
  const leaseToken = nullableText(row.leaseToken);
  const leaseExpiresAt = row.leaseExpiresAt == null ? null : canonicalInstant(row.leaseExpiresAt, "leaseExpiresAt");
  const heartbeatAt = row.heartbeatAt == null ? null : canonicalInstant(row.heartbeatAt, "heartbeatAt");
  const startedAt = row.startedAt == null ? null : canonicalInstant(row.startedAt, "startedAt");
  const finishedAt = row.finishedAt == null ? null : canonicalInstant(row.finishedAt, "finishedAt");
  const reportSha256 = row.reportSha256 == null ? null : exactHash(row.reportSha256, "reportSha256");
  const artifactIndexSha256 = row.artifactIndexSha256 == null
    ? null
    : exactHash(row.artifactIndexSha256, "artifactIndexSha256");
  const runningLeaseComplete = Boolean(
    leaseOwner && leaseToken && leaseExpiresAt && heartbeatAt && startedAt,
  );
  if (
    (status === "running") !== runningLeaseComplete
    || (status !== "running" && Boolean(leaseOwner || leaseToken || leaseExpiresAt || heartbeatAt))
    || (["completed", "failed", "blocked", "ambiguous"].includes(status) !== Boolean(finishedAt))
    || (status === "completed" && (!reportSha256 || !artifactIndexSha256))
  ) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, "stored run lease/terminal projection is invalid");
  }
  return {
    runId: exactText(row.runId, "runId"),
    approvalId: exactText(row.approvalId, "approvalId"),
    planSchemaVersion: exactText(row.planSchemaVersion, "planSchemaVersion"),
    planSha256,
    planJson,
    mode,
    environment,
    targetFingerprint: exactHash(row.targetFingerprint, "targetFingerprint"),
    manifestSha256: exactHash(row.manifestSha256, "manifestSha256"),
    targetSetSha256: exactHash(row.targetSetSha256, "targetSetSha256"),
    targetCount: integer(row.targetCount, "targetCount"),
    sourcePolicyJson,
    providerCeilingsJson,
    status,
    leaseOwner,
    leaseToken,
    leaseExpiresAt,
    heartbeatAt,
    startedAt,
    finishedAt,
    eventChainHead: exactHash(row.eventChainHead, "eventChainHead"),
    reportSha256,
    artifactIndexSha256,
    createdAt: canonicalInstant(row.createdAt, "createdAt"),
    updatedAt: canonicalInstant(row.updatedAt, "updatedAt"),
  };
}

export function parseProductTruthOperationalItemRow(
  row: Record<string, unknown>,
): StoredProductTruthOperationalRunItem {
  const status = String(row.status) as ProductTruthOperationalItemStatus;
  const known = [
    "pending", "claimed", "reuse_checked", "costing", "harvesting", "verifying",
    "done", "terminal_gap", "blocked", "ambiguous", "failed",
  ];
  if (!known.includes(status)) throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, `unknown item status ${status}`);
  const checkpoint = verifiedJsonHash(
    row.checkpointJson,
    row.checkpointSha256,
    "item.checkpoint",
    1_000_000,
  );
  const result = verifiedJsonHash(
    row.resultJson,
    row.resultSha256,
    "item.result",
    1_000_000,
  );
  const attempts = integer(row.attempts, "item.attempts");
  const leaseToken = nullableText(row.leaseToken);
  const leaseExpiresAt = row.leaseExpiresAt == null
    ? null
    : canonicalInstant(row.leaseExpiresAt, "item.leaseExpiresAt");
  const finishedAt = row.finishedAt == null
    ? null
    : canonicalInstant(row.finishedAt, "item.finishedAt");
  if (attempts < 0 || attempts > 1) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, "item.attempts is outside v1 policy");
  }
  const active = (ACTIVE_ITEM_STATUSES as readonly string[]).includes(status);
  const terminal = (TERMINAL_ITEM_STATUSES as readonly string[]).includes(status);
  if (active !== Boolean(leaseToken && leaseExpiresAt) || terminal !== Boolean(finishedAt)) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, "item lease/terminal projection is invalid");
  }
  if ((status === "done" || status === "terminal_gap") && result.json === null) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, `${status} item has no verified result`);
  }
  return {
    id: exactText(row.id, "item.id"),
    runId: exactText(row.runId, "item.runId"),
    listingKey: exactText(row.listingKey, "item.listingKey"),
    ordinal: integer(row.ordinal, "item.ordinal"),
    requestedFields: parseStringArray(row.requestedFields, "item.requestedFields"),
    queueJobId: nullableText(row.queueJobId),
    status,
    stage: exactText(row.stage, "item.stage"),
    attempts,
    leaseToken,
    leaseExpiresAt,
    checkpointJson: checkpoint.json,
    checkpointSha256: checkpoint.hash,
    resultJson: result.json,
    resultSha256: result.hash,
    lastError: nullableText(row.lastError),
    startedAt: row.startedAt == null ? null : canonicalInstant(row.startedAt, "item.startedAt"),
    finishedAt,
    createdAt: canonicalInstant(row.createdAt, "item.createdAt"),
    updatedAt: canonicalInstant(row.updatedAt, "item.updatedAt"),
  };
}

export function parseProductTruthOperationalEventRow(
  row: Record<string, unknown>,
): ProductTruthOperationalEvent {
  const payloadJson = canonicalJsonText(row.payloadJson, "event.payloadJson", 1_000_000);
  const payloadSha256 = exactHash(row.payloadSha256, "event.payloadSha256");
  if (sha256(payloadJson) !== payloadSha256) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, "event payload hash does not match");
  }
  return {
    id: exactText(row.id, "event.id"),
    runId: exactText(row.runId, "event.runId"),
    eventIndex: integer(row.eventIndex, "event.eventIndex"),
    eventType: exactText(row.eventType, "event.eventType", 100),
    itemId: nullableText(row.itemId),
    previousHash: exactHash(row.previousHash, "event.previousHash"),
    payloadJson,
    payloadSha256,
    eventHash: exactHash(row.eventHash, "event.eventHash"),
    createdAt: canonicalInstant(row.createdAt, "event.createdAt"),
  };
}

function verifyEventChain(
  run: StoredProductTruthOperationalRun,
  events: readonly ProductTruthOperationalEvent[],
): void {
  if (events.length < 1 || events[0]?.eventType !== "RUN_PREPARED") {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, "operational event chain has no RUN_PREPARED root");
  }
  let previousHash = ZERO_HASH;
  let previousAt = run.createdAt;
  for (const [index, event] of events.entries()) {
    if (
      event.runId !== run.runId
      || event.eventIndex !== index
      || event.previousHash !== previousHash
      || Date.parse(event.createdAt) < Date.parse(previousAt)
    ) {
      throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, `operational event chain breaks at ${index}`);
    }
    const expectedHash = sha256(renderProductTruthOperationalJson({
      runId: event.runId,
      eventIndex: event.eventIndex,
      eventType: event.eventType,
      itemId: event.itemId,
      previousHash: event.previousHash,
      payloadSha256: event.payloadSha256,
      createdAt: event.createdAt,
    }));
    if (event.eventHash !== expectedHash || event.id !== `ptore_${expectedHash}`) {
      throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, `operational event hash breaks at ${index}`);
    }
    previousHash = event.eventHash;
    previousAt = event.createdAt;
  }
  if (run.eventChainHead !== previousHash) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, "run eventChainHead does not match journal tail");
  }
}

async function selectRun(
  db: SqlExecutor,
  runId: string,
): Promise<StoredProductTruthOperationalRun | null> {
  const result = await db.execute({
    sql: `SELECT ${runSelect()} FROM "ProductTruthOperationalRun" WHERE "runId"=? LIMIT 1`,
    args: [exactText(runId, "runId")],
  });
  return result.rows[0]
    ? parseProductTruthOperationalRunRow(result.rows[0] as Record<string, unknown>)
    : null;
}

async function selectEvents(
  db: SqlExecutor,
  runId: string,
): Promise<ProductTruthOperationalEvent[]> {
  const result = await db.execute({
    sql: `SELECT ${eventSelect()} FROM "ProductTruthOperationalEvent"
          WHERE "runId"=? ORDER BY "eventIndex"`,
    args: [exactText(runId, "runId")],
  });
  return result.rows.map((row) => parseProductTruthOperationalEventRow(row as Record<string, unknown>));
}

export async function assertProductTruthOperationalRunSchema(db: Client): Promise<void> {
  try {
    const foreignKeys = await db.execute("PRAGMA foreign_keys");
    if (integer(foreignKeys.rows[0]?.foreign_keys, "PRAGMA foreign_keys") !== 1) {
      throw new Error("PRAGMA foreign_keys must be ON for operational execution");
    }
    for (const [table, columns] of [
      ["ProductTruthOperationalRun", RUN_COLUMNS],
      ["ProductTruthOperationalRunItem", ITEM_COLUMNS],
      ["ProductTruthOperationalEvent", EVENT_COLUMNS],
      ["ProductTruthListingScope", [
        "listingKey", "keyVersion", "channel", "storeIndex", "sku", "manifestSha256",
      ]],
      ["EnrichmentJob", [
        "id", "targetType", "target", "listingKey", "requestedFields", "status",
        "runId", "approvalId", "attempts", "result", "error", "terminalReason",
        "completedFields", "unavailableFields", "checkpoint", "estimatedSpendUnits",
        "actualSpendUnits", "leaseOwner", "leaseToken", "leaseExpiresAt", "heartbeatAt",
        "finishedAt", "nextEligibleAt", "updatedAt",
      ]],
      ["MeteredProviderBudget", [
        "id", "runId", "approvalId", "provider", "operations", "maxCalls",
        "maxUnitsMicros", "reservedCalls", "reservedUnitsMicros",
      ]],
      ["MeteredReservationReceipt", ["id", "budgetId", "status"]],
    ] as const) {
      const info = await db.execute(`PRAGMA table_info("${table}")`);
      const present = new Set(info.rows.map((row) => String(row.name)));
      const missing = columns.filter((column) => !present.has(column));
      if (missing.length) throw new Error(`missing ${table} columns: ${missing.join(", ")}`);
    }
    const schema = await db.execute({
      sql: `SELECT type,name,tbl_name,sql FROM sqlite_schema
            WHERE name IN (${[...REQUIRED_TRIGGERS, ...REQUIRED_INDEXES].map(() => "?").join(",")})`,
      args: [...REQUIRED_TRIGGERS, ...REQUIRED_INDEXES],
    });
    const rowsByName = new Map(schema.rows.map((row) => [String(row.name), row]));
    const triggers = new Set(schema.rows.filter((row) => row.type === "trigger").map((row) => String(row.name)));
    const indexes = new Set(schema.rows.filter((row) => row.type === "index").map((row) => String(row.name)));
    const missingTriggers = REQUIRED_TRIGGERS.filter((name) => !triggers.has(name));
    const missingIndexes = REQUIRED_INDEXES.filter((name) => !indexes.has(name));
    if (missingTriggers.length || missingIndexes.length) {
      throw new Error(`missing guards: ${[...missingTriggers, ...missingIndexes].join(", ")}`);
    }
    for (const trigger of REQUIRED_TRIGGERS) {
      const sql = String(rowsByName.get(trigger)?.sql ?? "");
      for (const marker of REQUIRED_TRIGGER_MARKERS[trigger]) {
        if (!sql.includes(marker)) throw new Error(`${trigger} is missing contract marker ${marker}`);
      }
    }
    for (const indexName of REQUIRED_INDEXES) {
      const contract = REQUIRED_INDEX_CONTRACTS[indexName];
      const indexList = await db.execute(`PRAGMA index_list("${contract.table}")`);
      const descriptor = indexList.rows.find((row) => row.name === indexName);
      if (
        !descriptor
        || Boolean(integer(descriptor.unique, `${indexName}.unique`)) !== contract.unique
        || Boolean(integer(descriptor.partial, `${indexName}.partial`)) !== contract.partial
      ) {
        throw new Error(`${indexName} uniqueness/partial contract differs`);
      }
      const info = await db.execute(`PRAGMA index_info("${indexName}")`);
      const columns = info.rows
        .slice()
        .sort((left, right) => integer(left.seqno, "index seqno") - integer(right.seqno, "index seqno"))
        .map((row) => String(row.name));
      if (JSON.stringify(columns) !== JSON.stringify(contract.columns)) {
        throw new Error(`${indexName} columns differ: ${columns.join(", ")}`);
      }
    }
    for (const [table, expected] of [
      ["ProductTruthOperationalRunItem", [
        ["runId", "ProductTruthOperationalRun", "runId"],
        ["listingKey", "ProductTruthListingScope", "listingKey"],
        ["queueJobId", "EnrichmentJob", "id"],
      ]],
      ["ProductTruthOperationalEvent", [
        ["runId", "ProductTruthOperationalRun", "runId"],
        ["itemId", "ProductTruthOperationalRunItem", "id"],
      ]],
    ] as const) {
      const links = await db.execute(`PRAGMA foreign_key_list("${table}")`);
      const actual = new Set(links.rows.map((row) => `${String(row.from)}\n${String(row.table)}\n${String(row.to)}`));
      for (const [from, targetTable, to] of expected) {
        if (!actual.has(`${from}\n${targetTable}\n${to}`)) {
          throw new Error(`missing ${table}.${from} foreign key to ${targetTable}.${to}`);
        }
      }
    }
  } catch (error) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, "operational runner schema is not ready", error);
  }
}

async function appendEvent(
  db: SqlExecutor,
  input: {
    runId: string;
    eventType: string;
    itemId?: string | null;
    payload: unknown;
    at: string;
  },
): Promise<ProductTruthOperationalEvent> {
  const current = await db.execute({
    sql: `SELECT "eventChainHead" FROM "ProductTruthOperationalRun" WHERE "runId"=? LIMIT 1`,
    args: [input.runId],
  });
  const previousHash = exactHash(current.rows[0]?.eventChainHead, "eventChainHead");
  const count = await db.execute({
    sql: `SELECT COUNT(*) AS count FROM "ProductTruthOperationalEvent" WHERE "runId"=?`,
    args: [input.runId],
  });
  const eventIndex = integer(count.rows[0]?.count, "eventIndex");
  const eventType = exactText(input.eventType, "eventType", 100);
  const itemId = input.itemId == null ? null : exactText(input.itemId, "itemId");
  const createdAt = canonicalInstant(input.at, "event.at");
  const payloadJson = renderProductTruthOperationalJson({
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_EVENT_VERSION,
    ...((input.payload && typeof input.payload === "object" && !Array.isArray(input.payload))
      ? input.payload as Record<string, unknown>
      : { value: input.payload }),
  });
  const payloadSha256 = sha256(payloadJson);
  const eventHash = sha256(renderProductTruthOperationalJson({
    runId: input.runId,
    eventIndex,
    eventType,
    itemId,
    previousHash,
    payloadSha256,
    createdAt,
  }));
  const event: ProductTruthOperationalEvent = {
    id: `ptore_${eventHash}`,
    runId: input.runId,
    eventIndex,
    eventType,
    itemId,
    previousHash,
    payloadJson,
    payloadSha256,
    eventHash,
    createdAt,
  };
  await db.execute({
    sql: `INSERT INTO "ProductTruthOperationalEvent"
          ("id","runId","eventIndex","eventType","itemId","previousHash",
           "payloadJson","payloadSha256","eventHash","createdAt")
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [
      event.id, event.runId, event.eventIndex, event.eventType, event.itemId,
      event.previousHash, event.payloadJson, event.payloadSha256, event.eventHash,
      event.createdAt,
    ],
  });
  return event;
}

function expectedRunIdentity(
  plan: ProductTruthOperationalPlan,
  approvalId: string,
  environment: ProductTruthOperationalEnvironment,
  at: string,
) {
  return {
    runId: plan.runId,
    approvalId,
    planSchemaVersion: PRODUCT_TRUTH_OPERATIONAL_PLAN_VERSION,
    planSha256: productTruthOperationalSha256(plan),
    planJson: renderProductTruthOperationalJson(plan),
    mode: plan.mode,
    environment,
    targetFingerprint: plan.targetFingerprint,
    manifestSha256: plan.manifest.sha256,
    targetSetSha256: plan.targetSetSha256,
    targetCount: plan.targets.length,
    sourcePolicyJson: renderProductTruthOperationalJson(plan.sourcePolicy),
    providerCeilingsJson: renderProductTruthOperationalJson(plan.providerCeilings),
    createdAt: canonicalInstant(at, "at"),
  };
}

function assertStoredRunIdentity(
  stored: StoredProductTruthOperationalRun,
  expected: ReturnType<typeof expectedRunIdentity>,
): void {
  for (const key of [
    "runId", "approvalId", "planSchemaVersion", "planSha256", "planJson", "mode",
    "environment", "targetFingerprint", "manifestSha256", "targetSetSha256",
    "targetCount", "sourcePolicyJson", "providerCeilingsJson",
  ] as const) {
    if (stored[key] !== expected[key]) {
      throw storeError("OPERATIONAL_RUN_CONFLICT", `stored run differs in ${key}`);
    }
  }
}

export async function getProductTruthOperationalRun(
  db: Client,
  runId: string,
): Promise<StoredProductTruthOperationalRun | null> {
  await assertProductTruthOperationalRunSchema(db);
  const transaction = await db.transaction("read");
  try {
    const run = await selectRun(transaction, runId);
    if (run) verifyEventChain(run, await selectEvents(transaction, run.runId));
    await transaction.commit();
    return run;
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}

export async function listProductTruthOperationalEvents(
  db: Client,
  runId: string,
): Promise<ProductTruthOperationalEvent[]> {
  await assertProductTruthOperationalRunSchema(db);
  const transaction = await db.transaction("read");
  try {
    const run = await selectRun(transaction, runId);
    if (!run) throw storeError("OPERATIONAL_RUN_MISSING", `unknown run ${runId}`);
    const events = await selectEvents(transaction, run.runId);
    verifyEventChain(run, events);
    await transaction.commit();
    return events;
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}

export async function listProductTruthOperationalRunItems(
  db: Client,
  runId: string,
): Promise<StoredProductTruthOperationalRunItem[]> {
  await assertProductTruthOperationalRunSchema(db);
  const result = await db.execute({
    sql: `SELECT ${itemSelect()} FROM "ProductTruthOperationalRunItem"
          WHERE "runId"=? ORDER BY "ordinal"`,
    args: [exactText(runId, "runId")],
  });
  return result.rows.map((row) => parseProductTruthOperationalItemRow(row as Record<string, unknown>));
}

export async function seedProductTruthOperationalRun(
  db: Client,
  input: {
    plan: ProductTruthOperationalPlan;
    approvalId: string;
    environment: ProductTruthOperationalEnvironment;
    at: string;
  },
): Promise<{ created: boolean; run: StoredProductTruthOperationalRun; items: StoredProductTruthOperationalRunItem[] }> {
  await assertProductTruthOperationalRunSchema(db);
  const approvalId = exactText(input.approvalId, "approvalId", 120);
  const expected = expectedRunIdentity(input.plan, approvalId, input.environment, input.at);
  const transaction = await db.transaction("write");
  try {
    const scopes = await transaction.execute({
      sql: `SELECT "listingKey","keyVersion","channel","storeIndex","sku","manifestSha256"
            FROM "ProductTruthListingScope"
            WHERE "listingKey" IN (${input.plan.targets.map(() => "?").join(",")})`,
      args: input.plan.targets.map((target) => target.listingKey),
    });
    const registered = new Map(scopes.rows.map((row) => [String(row.listingKey), row]));
    const missing = input.plan.targets.filter((target) => !registered.has(target.listingKey));
    if (missing.length) {
      throw storeError("OPERATIONAL_SCOPE_NOT_REGISTERED", `unregistered listing scopes: ${missing.map((item) => item.listingKey).join(", ")}`);
    }
    for (const target of input.plan.targets) {
      const scope = registered.get(target.listingKey);
      if (
        !scope
        || scope.keyVersion !== target.listingKeyVersion
        || scope.channel !== target.channel
        || integer(scope.storeIndex, "scope.storeIndex") !== target.storeIndex
        || scope.sku !== target.sku
        || scope.manifestSha256 !== input.plan.manifest.sha256
      ) {
        throw storeError("OPERATIONAL_SCOPE_CONFLICT", `registry projection differs for ${target.listingKey}`);
      }
    }

    let storedResult = await transaction.execute({
      sql: `SELECT ${runSelect()} FROM "ProductTruthOperationalRun" WHERE "runId"=? LIMIT 1`,
      args: [expected.runId],
    });
    let created = false;
    if (!storedResult.rows[0]) {
      const ambiguousOverlap = await transaction.execute({
        sql: `SELECT "runId","listingKey" FROM "ProductTruthOperationalRunItem"
              WHERE "status"='ambiguous'
                AND "listingKey" IN (${input.plan.targets.map(() => "?").join(",")})
              ORDER BY "listingKey","runId" LIMIT 1`,
        args: input.plan.targets.map((target) => target.listingKey),
      });
      if (ambiguousOverlap.rows[0]) {
        throw storeError(
          "OPERATIONAL_AMBIGUOUS_TARGET_OVERLAP",
          `listing ${String(ambiguousOverlap.rows[0].listingKey)} remains ambiguous in run ${String(ambiguousOverlap.rows[0].runId)}`,
        );
      }
      const conflictingIdentity = await transaction.execute({
        sql: `SELECT "runId" FROM "ProductTruthOperationalRun"
              WHERE "approvalId"=? OR "planSha256"=? LIMIT 1`,
        args: [expected.approvalId, expected.planSha256],
      });
      if (conflictingIdentity.rows[0]) {
        throw storeError(
          "OPERATIONAL_RUN_CONFLICT",
          `approvalId or planSha256 is already bound to run ${String(conflictingIdentity.rows[0].runId)}`,
        );
      }
      const inserted = await transaction.execute({
        sql: `INSERT INTO "ProductTruthOperationalRun"
              ("runId","approvalId","planSchemaVersion","planSha256","planJson",
               "mode","environment","targetFingerprint","manifestSha256","targetSetSha256",
               "targetCount","sourcePolicyJson","providerCeilingsJson","status",
               "createdAt","updatedAt")
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`,
        args: [
          expected.runId, expected.approvalId, expected.planSchemaVersion,
          expected.planSha256, expected.planJson, expected.mode, expected.environment,
          expected.targetFingerprint, expected.manifestSha256, expected.targetSetSha256,
          expected.targetCount, expected.sourcePolicyJson, expected.providerCeilingsJson,
          expected.createdAt, expected.createdAt,
        ],
      });
      if (inserted.rowsAffected !== 1) {
        throw storeError("OPERATIONAL_RUN_CONFLICT", "sealed run insert did not create one row");
      }
      created = true;
      storedResult = await transaction.execute({
        sql: `SELECT ${runSelect()} FROM "ProductTruthOperationalRun" WHERE "runId"=? LIMIT 1`,
        args: [expected.runId],
      });
    }
    if (!storedResult.rows[0]) throw storeError("OPERATIONAL_RUN_MISSING", "seeded run disappeared");
    const stored = parseProductTruthOperationalRunRow(storedResult.rows[0] as Record<string, unknown>);
    assertStoredRunIdentity(stored, expected);

    for (const target of input.plan.targets) {
      const id = productTruthOperationalRunItemId(input.plan.runId, target.listingKey);
      const requestedFields = renderProductTruthOperationalJson(target.requestedFields);
      if (created) {
        const insertedItem = await transaction.execute({
          sql: `INSERT INTO "ProductTruthOperationalRunItem"
                ("id","runId","listingKey","ordinal","requestedFields","status","stage",
                 "attempts","createdAt","updatedAt")
                VALUES (?,?,?,?,?,'pending','QUEUED',0,?,?)`,
          args: [
            id,
            input.plan.runId,
            target.listingKey,
            target.ordinal,
            requestedFields,
            expected.createdAt,
            expected.createdAt,
          ],
        });
        if (insertedItem.rowsAffected !== 1) {
          throw storeError("OPERATIONAL_ITEM_CONFLICT", `could not create item ${target.listingKey}`);
        }
      }
      const row = await transaction.execute({
        sql: `SELECT ${itemSelect()} FROM "ProductTruthOperationalRunItem" WHERE "id"=? LIMIT 1`,
        args: [id],
      });
      if (!row.rows[0]) {
        throw storeError("OPERATIONAL_ITEM_CONFLICT", `stored item is missing for ${target.listingKey}`);
      }
      const item = parseProductTruthOperationalItemRow(row.rows[0] as Record<string, unknown>);
      if (
        item.runId !== input.plan.runId
        || item.listingKey !== target.listingKey
        || item.ordinal !== target.ordinal
        || renderProductTruthOperationalJson(item.requestedFields) !== requestedFields
      ) {
        throw storeError("OPERATIONAL_ITEM_CONFLICT", `stored item differs for ${target.listingKey}`);
      }
    }
    const count = await transaction.execute({
      sql: `SELECT COUNT(*) AS count FROM "ProductTruthOperationalRunItem" WHERE "runId"=?`,
      args: [input.plan.runId],
    });
    if (integer(count.rows[0]?.count, "item count") !== input.plan.targets.length) {
      throw storeError("OPERATIONAL_ITEM_CONFLICT", "stored item set differs from sealed plan");
    }
    if (created) {
      await appendEvent(transaction, {
        runId: input.plan.runId,
        eventType: "RUN_PREPARED",
        payload: {
          planSha256: expected.planSha256,
          manifestSha256: expected.manifestSha256,
          targetSetSha256: expected.targetSetSha256,
          targetCount: expected.targetCount,
        },
        at: expected.createdAt,
      });
    }
    const run = await selectRun(transaction, input.plan.runId);
    if (!run) throw storeError("OPERATIONAL_RUN_MISSING", "seeded run disappeared");
    verifyEventChain(run, await selectEvents(transaction, input.plan.runId));
    const itemsResult = await transaction.execute({
      sql: `SELECT ${itemSelect()} FROM "ProductTruthOperationalRunItem"
            WHERE "runId"=? ORDER BY "ordinal"`,
      args: [input.plan.runId],
    });
    const items = itemsResult.rows.map((row) => (
      parseProductTruthOperationalItemRow(row as Record<string, unknown>)
    ));
    await transaction.commit();
    return { created, run, items };
  } catch (error) {
    await transaction.rollback();
    if (error instanceof ProductTruthOperationalStoreError) throw error;
    throw storeError("OPERATIONAL_RUN_SEED_FAILED", "could not seed sealed operational run", error);
  } finally {
    transaction.close();
  }
}

/**
 * Seed the one-donor TARGETED_WALMART_EVIDENCE control row without fabricating
 * a ProductTruthListingScope. The common operational table still owns the
 * environment lease and is therefore able to fence the existing metered
 * budget/receipt triggers. Work state itself lives in one exact product queue
 * row; no OperationalRunItem is created because its FK is intentionally
 * listing-scope-only.
 */
export async function seedProductTruthTargetedEvidenceControlRun(
  db: Client,
  input: {
    plan: {
      schemaVersion: "product-truth-targeted-walmart-evidence-plan/1.0.0";
      runId: string;
      mode: "WAVE";
      targetFingerprint: string;
      manifest: { sha256: string };
      targetSetSha256: string;
      targets: readonly [unknown];
      sourcePolicy: unknown;
      providerCeilings: unknown;
    };
    planSha256: string;
    approvalId: string;
    environment: ProductTruthOperationalEnvironment;
    at: string;
  },
): Promise<{ created: boolean; run: StoredProductTruthOperationalRun }> {
  await assertProductTruthOperationalRunSchema(db);
  const plan = input.plan;
  const createdAt = canonicalInstant(input.at, "at");
  const planJson = renderProductTruthOperationalJson(plan);
  const planSha256 = exactHash(input.planSha256, "planSha256");
  if (sha256(planJson) !== planSha256) {
    throw storeError("OPERATIONAL_RUN_CONFLICT", "targeted plan bytes differ from planSha256");
  }
  const expected = {
    runId: exactText(plan.runId, "runId", 120),
    approvalId: exactText(input.approvalId, "approvalId", 120),
    planSchemaVersion: plan.schemaVersion,
    planSha256,
    planJson,
    mode: plan.mode,
    environment: input.environment,
    targetFingerprint: exactHash(plan.targetFingerprint, "targetFingerprint"),
    manifestSha256: exactHash(plan.manifest.sha256, "manifestSha256"),
    targetSetSha256: exactHash(plan.targetSetSha256, "targetSetSha256"),
    targetCount: 1,
    sourcePolicyJson: renderProductTruthOperationalJson(plan.sourcePolicy),
    providerCeilingsJson: renderProductTruthOperationalJson(plan.providerCeilings),
    createdAt,
  };
  const transaction = await db.transaction("write");
  try {
    let storedResult = await transaction.execute({
      sql: `SELECT ${runSelect()} FROM "ProductTruthOperationalRun" WHERE "runId"=? LIMIT 1`,
      args: [expected.runId],
    });
    let created = false;
    if (!storedResult.rows[0]) {
      const conflict = await transaction.execute({
        sql: `SELECT "runId" FROM "ProductTruthOperationalRun"
              WHERE "approvalId"=? OR "planSha256"=? LIMIT 1`,
        args: [expected.approvalId, expected.planSha256],
      });
      if (conflict.rows[0]) {
        throw storeError(
          "OPERATIONAL_RUN_CONFLICT",
          `approvalId or planSha256 is already bound to run ${String(conflict.rows[0].runId)}`,
        );
      }
      const inserted = await transaction.execute({
        sql: `INSERT INTO "ProductTruthOperationalRun"
              ("runId","approvalId","planSchemaVersion","planSha256","planJson",
               "mode","environment","targetFingerprint","manifestSha256","targetSetSha256",
               "targetCount","sourcePolicyJson","providerCeilingsJson","status",
               "createdAt","updatedAt")
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`,
        args: [
          expected.runId, expected.approvalId, expected.planSchemaVersion,
          expected.planSha256, expected.planJson, expected.mode, expected.environment,
          expected.targetFingerprint, expected.manifestSha256, expected.targetSetSha256,
          expected.targetCount, expected.sourcePolicyJson, expected.providerCeilingsJson,
          expected.createdAt, expected.createdAt,
        ],
      });
      if (inserted.rowsAffected !== 1) {
        throw storeError("OPERATIONAL_RUN_CONFLICT", "targeted control run insert did not create one row");
      }
      created = true;
      await appendEvent(transaction, {
        runId: expected.runId,
        eventType: "RUN_PREPARED",
        payload: {
          planSha256: expected.planSha256,
          manifestSha256: expected.manifestSha256,
          targetSetSha256: expected.targetSetSha256,
          targetCount: 1,
          executionKind: "TARGETED_WALMART_EVIDENCE",
        },
        at: expected.createdAt,
      });
      storedResult = await transaction.execute({
        sql: `SELECT ${runSelect()} FROM "ProductTruthOperationalRun" WHERE "runId"=? LIMIT 1`,
        args: [expected.runId],
      });
    }
    if (!storedResult.rows[0]) throw storeError("OPERATIONAL_RUN_MISSING", "targeted run disappeared");
    const stored = parseProductTruthOperationalRunRow(storedResult.rows[0] as Record<string, unknown>);
    for (const key of [
      "runId", "approvalId", "planSchemaVersion", "planSha256", "planJson", "mode",
      "environment", "targetFingerprint", "manifestSha256", "targetSetSha256",
      "targetCount", "sourcePolicyJson", "providerCeilingsJson",
    ] as const) {
      if (stored[key] !== expected[key]) {
        throw storeError("OPERATIONAL_RUN_CONFLICT", `stored targeted run differs in ${key}`);
      }
    }
    const items = await transaction.execute({
      sql: `SELECT COUNT(*) AS count FROM "ProductTruthOperationalRunItem" WHERE "runId"=?`,
      args: [expected.runId],
    });
    if (integer(items.rows[0]?.count, "targeted run item count") !== 0) {
      throw storeError("OPERATIONAL_RUN_CONFLICT", "targeted donor run must not contain listing items");
    }
    verifyEventChain(stored, await selectEvents(transaction, expected.runId));
    await transaction.commit();
    return { created, run: stored };
  } catch (error) {
    await transaction.rollback();
    if (error instanceof ProductTruthOperationalStoreError) throw error;
    throw storeError("OPERATIONAL_RUN_SEED_FAILED", "could not seed targeted evidence control run", error);
  } finally {
    transaction.close();
  }
}

export async function acquireProductTruthOperationalRunLease(
  db: Client,
  input: {
    runId: string;
    leaseOwner: string;
    leaseToken: string;
    at: string;
    leaseExpiresAt: string;
  },
): Promise<StoredProductTruthOperationalRun> {
  await assertProductTruthOperationalRunSchema(db);
  const at = canonicalInstant(input.at, "at");
  const leaseExpiresAt = canonicalInstant(input.leaseExpiresAt, "leaseExpiresAt");
  if (Date.parse(leaseExpiresAt) <= Date.parse(at) || Date.parse(leaseExpiresAt) - Date.parse(at) > 10 * 60 * 1_000) {
    throw storeError("OPERATIONAL_LEASE_INVALID", "run lease must be in the future and at most ten minutes");
  }
  const runId = exactText(input.runId, "runId");
  const leaseOwner = exactText(input.leaseOwner, "leaseOwner", 200);
  const leaseToken = exactText(input.leaseToken, "leaseToken", 200);
  const transaction = await db.transaction("write");
  try {
    const result = await transaction.execute({
      sql: `UPDATE "ProductTruthOperationalRun"
            SET "status"='running', "leaseOwner"=?, "leaseToken"=?,
                "leaseExpiresAt"=?, "heartbeatAt"=?, "startedAt"=COALESCE("startedAt",?),
                "finishedAt"=NULL, "updatedAt"=?
            WHERE "runId"=? AND "status" IN ('prepared','interrupted')`,
      args: [leaseOwner, leaseToken, leaseExpiresAt, at, at, at, runId],
    });
    if (result.rowsAffected !== 1) {
      const existing = await selectRun(transaction, runId);
      if (!existing) throw storeError("OPERATIONAL_RUN_MISSING", "run does not exist");
      if (existing.status === "running") {
        throw storeError("OPERATIONAL_RUN_LOCK_HELD", "run already has an active executor");
      }
      throw storeError("OPERATIONAL_RUN_TERMINAL", `run cannot start from ${existing.status}`);
    }
    await appendEvent(transaction, {
      runId,
      eventType: "RUN_LEASE_ACQUIRED",
      payload: { leaseOwner, leaseExpiresAt },
      at,
    });
    const run = await selectRun(transaction, runId);
    if (!run) throw storeError("OPERATIONAL_RUN_MISSING", "acquired run disappeared");
    verifyEventChain(run, await selectEvents(transaction, runId));
    await transaction.commit();
    return run;
  } catch (error) {
    await transaction.rollback();
    if (error instanceof ProductTruthOperationalStoreError) throw error;
    if (/UNIQUE constraint failed: ProductTruthOperationalRun\.environment/i.test(String(error))) {
      throw storeError("OPERATIONAL_RUN_LOCK_HELD", "environment already has an active executor", error);
    }
    throw storeError("OPERATIONAL_RUN_ACQUIRE_FAILED", "could not acquire operational run lease", error);
  } finally {
    transaction.close();
  }
}

export async function heartbeatProductTruthOperationalRunLease(
  db: Client,
  input: {
    runId: string;
    runLeaseToken: string;
    at: string;
    leaseExpiresAt: string;
    activeItem?: {
      itemId: string;
      itemLeaseToken: string;
      queueLeaseToken?: string | null;
    } | null;
  },
): Promise<{
  run: StoredProductTruthOperationalRun;
  activeItem: StoredProductTruthOperationalRunItem | null;
}> {
  await assertProductTruthOperationalRunSchema(db);
  const runId = exactText(input.runId, "runId");
  const runLeaseToken = exactText(input.runLeaseToken, "runLeaseToken", 200);
  const at = canonicalInstant(input.at, "at");
  const leaseExpiresAt = canonicalInstant(input.leaseExpiresAt, "leaseExpiresAt");
  if (
    Date.parse(leaseExpiresAt) <= Date.parse(at)
    || Date.parse(leaseExpiresAt) - Date.parse(at) > 10 * 60 * 1_000
  ) {
    throw storeError("OPERATIONAL_LEASE_INVALID", "heartbeat lease must be in the future and at most ten minutes");
  }
  const transaction = await db.transaction("write");
  try {
    const currentRun = await selectRun(transaction, runId);
    if (
      !currentRun
      || currentRun.status !== "running"
      || currentRun.leaseToken !== runLeaseToken
      || !currentRun.leaseExpiresAt
      || Date.parse(currentRun.leaseExpiresAt) <= Date.parse(at)
      || Date.parse(leaseExpiresAt) <= Date.parse(currentRun.leaseExpiresAt)
    ) {
      throw storeError("OPERATIONAL_RUN_CAS_LOST", "run lease is not eligible for heartbeat");
    }
    const activeResult = await transaction.execute({
      sql: `SELECT ${itemSelect()} FROM "ProductTruthOperationalRunItem"
            WHERE "runId"=? AND "status" IN (${ACTIVE_ITEM_STATUSES.map(() => "?").join(",")})
            ORDER BY "ordinal"`,
      args: [runId, ...ACTIVE_ITEM_STATUSES],
    });
    const activeItems = activeResult.rows.map((row) => (
      parseProductTruthOperationalItemRow(row as Record<string, unknown>)
    ));
    if (activeItems.length > 1) {
      throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, "more than one item owns a run lease");
    }
    const activeItem = activeItems[0] ?? null;
    if (activeItem) {
      if (
        !input.activeItem
        || exactText(input.activeItem.itemId, "activeItem.itemId") !== activeItem.id
        || exactText(input.activeItem.itemLeaseToken, "activeItem.itemLeaseToken", 200) !== activeItem.leaseToken
      ) {
        throw storeError("OPERATIONAL_ITEM_HEARTBEAT_REQUIRED", "active item lease must be extended with the run");
      }
      const itemUpdate = await transaction.execute({
        sql: `UPDATE "ProductTruthOperationalRunItem"
              SET "leaseExpiresAt"=?, "updatedAt"=?
              WHERE "id"=? AND "runId"=? AND "status" IN (${ACTIVE_ITEM_STATUSES.map(() => "?").join(",")})
                AND "leaseToken"=?
                AND julianday("leaseExpiresAt")>julianday(?)
                AND julianday(?)>julianday("leaseExpiresAt")`,
        args: [
          leaseExpiresAt, at, activeItem.id, runId, ...ACTIVE_ITEM_STATUSES,
          activeItem.leaseToken, at, leaseExpiresAt,
        ],
      });
      if (itemUpdate.rowsAffected !== 1) {
        throw storeError("OPERATIONAL_ITEM_CAS_LOST", "active item lease expired or was lost before heartbeat");
      }
      if (activeItem.queueJobId) {
        const queueResult = await transaction.execute({
          sql: `SELECT "status","attempts","leaseToken","leaseExpiresAt","runId","approvalId","listingKey"
                FROM "EnrichmentJob" WHERE "id"=? LIMIT 1`,
          args: [activeItem.queueJobId],
        });
        const queue = queueResult.rows[0];
        if (
          !queue
          || queue.runId !== runId
          || queue.approvalId !== currentRun.approvalId
          || queue.listingKey !== activeItem.listingKey
        ) {
          throw storeError("OPERATIONAL_QUEUE_CAS_LOST", "bound queue identity differs during heartbeat");
        }
        if (queue.status === "running") {
          const queueLeaseToken = input.activeItem.queueLeaseToken == null
            ? null
            : exactText(input.activeItem.queueLeaseToken, "activeItem.queueLeaseToken", 200);
          if (
            integer(queue.attempts, "queue.attempts") !== 1
            || !queueLeaseToken
            || queue.leaseToken !== queueLeaseToken
            || queue.leaseExpiresAt == null
          ) {
            throw storeError("OPERATIONAL_QUEUE_HEARTBEAT_REQUIRED", "running queue lease must extend with its item");
          }
          const queueUpdate = await transaction.execute({
            sql: `UPDATE "EnrichmentJob"
                  SET "heartbeatAt"=?, "leaseExpiresAt"=?, "updatedAt"=?
                  WHERE "id"=? AND "status"='running' AND "attempts"=1
                    AND "runId"=? AND "listingKey"=? AND "leaseToken"=?
                    AND julianday("leaseExpiresAt")>julianday(?)
                    AND julianday(?)>julianday("leaseExpiresAt")`,
            args: [
              at, leaseExpiresAt, at, activeItem.queueJobId, runId,
              activeItem.listingKey, queueLeaseToken, at, leaseExpiresAt,
            ],
          });
          if (queueUpdate.rowsAffected !== 1) {
            throw storeError("OPERATIONAL_QUEUE_CAS_LOST", "running queue lease expired or was lost before heartbeat");
          }
        } else if (
          !["queued", "retry_wait"].includes(String(queue.status))
          || integer(queue.attempts, "queue.attempts") !== 0
          || input.activeItem.queueLeaseToken != null
        ) {
          throw storeError("OPERATIONAL_QUEUE_CAS_LOST", "bound queue is not safely pending or running");
        }
      } else if (input.activeItem.queueLeaseToken != null) {
        throw storeError("OPERATIONAL_QUEUE_CAS_LOST", "queue lease token supplied for an unbound item");
      }
    } else if (input.activeItem) {
      throw storeError("OPERATIONAL_ITEM_CAS_LOST", "heartbeat named an item that is no longer active");
    }
    const runUpdate = await transaction.execute({
      sql: `UPDATE "ProductTruthOperationalRun"
            SET "leaseExpiresAt"=?, "heartbeatAt"=?, "updatedAt"=?
            WHERE "runId"=? AND "status"='running' AND "leaseToken"=?
              AND julianday("leaseExpiresAt")>julianday(?)
              AND julianday(?)>julianday("leaseExpiresAt")
              AND julianday("heartbeatAt")<=julianday(?)`,
      args: [leaseExpiresAt, at, at, runId, runLeaseToken, at, leaseExpiresAt, at],
    });
    if (runUpdate.rowsAffected !== 1) {
      throw storeError("OPERATIONAL_RUN_CAS_LOST", "run lease expired or was lost before heartbeat");
    }
    await appendEvent(transaction, {
      runId,
      eventType: "RUN_HEARTBEAT",
      itemId: activeItem?.id,
      payload: { leaseExpiresAt },
      at,
    });
    const run = await selectRun(transaction, runId);
    if (!run) throw storeError("OPERATIONAL_RUN_MISSING", "heartbeat run disappeared");
    const refreshedItem = activeItem
      ? parseProductTruthOperationalItemRow((await transaction.execute({
        sql: `SELECT ${itemSelect()} FROM "ProductTruthOperationalRunItem" WHERE "id"=? LIMIT 1`,
        args: [activeItem.id],
      })).rows[0] as Record<string, unknown>)
      : null;
    verifyEventChain(run, await selectEvents(transaction, runId));
    await transaction.commit();
    return { run, activeItem: refreshedItem };
  } catch (error) {
    await transaction.rollback();
    if (error instanceof ProductTruthOperationalStoreError) throw error;
    throw storeError("OPERATIONAL_HEARTBEAT_FAILED", "could not extend operational leases", error);
  } finally {
    transaction.close();
  }
}

export async function heartbeatProductTruthOperationalItemLease(
  db: Client,
  input: {
    runId: string;
    runLeaseToken: string;
    itemId: string;
    itemLeaseToken: string;
    queueLeaseToken?: string | null;
    at: string;
    leaseExpiresAt: string;
  },
): Promise<{
  run: StoredProductTruthOperationalRun;
  item: StoredProductTruthOperationalRunItem;
}> {
  const heartbeat = await heartbeatProductTruthOperationalRunLease(db, {
    runId: input.runId,
    runLeaseToken: input.runLeaseToken,
    at: input.at,
    leaseExpiresAt: input.leaseExpiresAt,
    activeItem: {
      itemId: input.itemId,
      itemLeaseToken: input.itemLeaseToken,
      queueLeaseToken: input.queueLeaseToken,
    },
  });
  if (!heartbeat.activeItem) {
    throw storeError("OPERATIONAL_ITEM_CAS_LOST", "item disappeared during atomic heartbeat");
  }
  return { run: heartbeat.run, item: heartbeat.activeItem };
}

export async function claimNextProductTruthOperationalItem(
  db: Client,
  input: {
    runId: string;
    runLeaseToken: string;
    itemLeaseToken: string;
    at: string;
    leaseExpiresAt: string;
  },
): Promise<StoredProductTruthOperationalRunItem | null> {
  await assertProductTruthOperationalRunSchema(db);
  const at = canonicalInstant(input.at, "at");
  const leaseExpiresAt = canonicalInstant(input.leaseExpiresAt, "leaseExpiresAt");
  if (
    Date.parse(leaseExpiresAt) <= Date.parse(at)
    || Date.parse(leaseExpiresAt) - Date.parse(at) > 10 * 60 * 1_000
  ) {
    throw storeError("OPERATIONAL_LEASE_INVALID", "item lease must be in the future and at most ten minutes");
  }
  const runId = exactText(input.runId, "runId");
  const runLeaseToken = exactText(input.runLeaseToken, "runLeaseToken", 200);
  const itemLeaseToken = exactText(input.itemLeaseToken, "itemLeaseToken", 200);
  const transaction = await db.transaction("write");
  try {
    const result = await transaction.execute({
      sql: `UPDATE "ProductTruthOperationalRunItem"
            SET "status"='claimed', "stage"='CLAIMED', "leaseToken"=?,
                "leaseExpiresAt"=?, "startedAt"=COALESCE("startedAt",?), "updatedAt"=?
            WHERE "id"=(
              SELECT item."id" FROM "ProductTruthOperationalRunItem" item
              JOIN "ProductTruthOperationalRun" run ON run."runId"=item."runId"
              WHERE item."runId"=? AND item."status"='pending' AND item."attempts"=0
                AND run."status"='running' AND run."leaseToken"=?
                AND julianday(run."leaseExpiresAt")>julianday(?)
                AND julianday(?)<=julianday(run."leaseExpiresAt")
              ORDER BY item."ordinal" LIMIT 1
            ) AND "status"='pending' AND "attempts"=0
            RETURNING ${itemSelect()}`,
      args: [
        itemLeaseToken, leaseExpiresAt, at, at, runId,
        runLeaseToken, at, leaseExpiresAt,
      ],
    });
    if (!result.rows[0]) {
      await transaction.commit();
      return null;
    }
    const item = parseProductTruthOperationalItemRow(result.rows[0] as Record<string, unknown>);
    await appendEvent(transaction, {
      runId,
      eventType: "ITEM_CLAIMED",
      itemId: item.id,
      payload: { listingKey: item.listingKey, ordinal: item.ordinal, leaseExpiresAt },
      at,
    });
    await transaction.commit();
    return item;
  } catch (error) {
    await transaction.rollback();
    if (error instanceof ProductTruthOperationalStoreError) throw error;
    if (/ProductTruthOperationalRunItem\.runId/i.test(String(error))) {
      throw storeError("OPERATIONAL_ITEM_ALREADY_ACTIVE", "run already has an active item", error);
    }
    throw storeError("OPERATIONAL_ITEM_CLAIM_FAILED", "could not claim next operational item", error);
  } finally {
    transaction.close();
  }
}

const ITEM_TRANSITIONS: Record<ProductTruthOperationalItemStatus, readonly ProductTruthOperationalItemStatus[]> = {
  pending: ["claimed"],
  claimed: ["reuse_checked", "blocked", "failed", "ambiguous"],
  reuse_checked: ["costing", "verifying", "blocked", "failed", "ambiguous"],
  costing: ["harvesting", "verifying", "terminal_gap", "blocked", "failed", "ambiguous"],
  harvesting: ["verifying", "terminal_gap", "blocked", "failed", "ambiguous"],
  verifying: ["done", "terminal_gap", "blocked", "failed", "ambiguous"],
  done: [],
  terminal_gap: [],
  blocked: [],
  ambiguous: [],
  failed: [],
};

export async function transitionProductTruthOperationalItem(
  db: Client,
  input: {
    item: StoredProductTruthOperationalRunItem;
    runLeaseToken: string;
    leaseToken: string;
    nextStatus: ProductTruthOperationalItemStatus;
    stage: string;
    at: string;
    checkpoint?: unknown;
    result?: unknown;
    error?: string | null;
  },
): Promise<StoredProductTruthOperationalRunItem> {
  await assertProductTruthOperationalRunSchema(db);
  if (!ITEM_TRANSITIONS[input.item.status].includes(input.nextStatus)) {
    throw storeError("OPERATIONAL_ITEM_TRANSITION_INVALID", `${input.item.status} -> ${input.nextStatus}`);
  }
  const at = canonicalInstant(input.at, "at");
  const runLeaseToken = exactText(input.runLeaseToken, "runLeaseToken", 200);
  const itemLeaseToken = exactText(input.leaseToken, "leaseToken", 200);
  const terminal = (TERMINAL_ITEM_STATUSES as readonly string[]).includes(input.nextStatus);
  const checkpointJson = input.checkpoint === undefined
    ? input.item.checkpointJson
    : renderProductTruthOperationalJson(input.checkpoint);
  const checkpointSha256 = checkpointJson == null ? null : sha256(checkpointJson);
  const resultJson = input.result === undefined
    ? input.item.resultJson
    : renderProductTruthOperationalJson(input.result);
  const resultSha256 = resultJson == null ? null : sha256(resultJson);
  if ((input.nextStatus === "done" || input.nextStatus === "terminal_gap") && resultJson === null) {
    throw storeError("OPERATIONAL_ITEM_RESULT_REQUIRED", `${input.nextStatus} requires a result`);
  }
  const attempts = input.nextStatus === "costing" ? input.item.attempts + 1 : input.item.attempts;
  const stage = exactText(input.stage, "stage", 100);
  const transaction = await db.transaction("write");
  try {
    const updated = await transaction.execute({
      sql: `UPDATE "ProductTruthOperationalRunItem"
            SET "status"=?, "stage"=?, "attempts"=?,
                "leaseToken"=?, "leaseExpiresAt"=?,
                "checkpointJson"=?, "checkpointSha256"=?,
                "resultJson"=?, "resultSha256"=?, "lastError"=?,
                "finishedAt"=?, "updatedAt"=?
            WHERE "id"=? AND "runId"=? AND "status"=? AND "attempts"=? AND "leaseToken"=?
              AND julianday("leaseExpiresAt")>julianday(?)
              AND EXISTS (
                SELECT 1 FROM "ProductTruthOperationalRun" run
                WHERE run."runId"="ProductTruthOperationalRunItem"."runId"
                  AND run."status"='running' AND run."leaseToken"=?
                  AND julianday(run."leaseExpiresAt")>julianday(?)
              )
            RETURNING ${itemSelect()}`,
      args: [
        input.nextStatus,
        stage,
        attempts,
        terminal ? null : itemLeaseToken,
        terminal ? null : input.item.leaseExpiresAt,
        checkpointJson,
        checkpointSha256,
        resultJson,
        resultSha256,
        input.error == null ? null : String(input.error).slice(0, 2_000),
        terminal ? at : null,
        at,
        input.item.id,
        input.item.runId,
        input.item.status,
        input.item.attempts,
        itemLeaseToken,
        at,
        runLeaseToken,
        at,
      ],
    });
    if (!updated.rows[0]) {
      throw storeError("OPERATIONAL_ITEM_CAS_LOST", `lost or expired lease for ${input.item.id}`);
    }
    const item = parseProductTruthOperationalItemRow(updated.rows[0] as Record<string, unknown>);
    await appendEvent(transaction, {
      runId: item.runId,
      eventType: "ITEM_TRANSITIONED",
      itemId: item.id,
      payload: {
        fromStatus: input.item.status,
        toStatus: item.status,
        stage: item.stage,
        attempts: item.attempts,
        checkpointSha256: item.checkpointSha256,
        resultSha256: item.resultSha256,
      },
      at,
    });
    await transaction.commit();
    return item;
  } catch (error) {
    await transaction.rollback();
    if (error instanceof ProductTruthOperationalStoreError) throw error;
    throw storeError("OPERATIONAL_ITEM_TRANSITION_FAILED", `could not transition ${input.item.id}`, error);
  } finally {
    transaction.close();
  }
}

export async function bindProductTruthOperationalQueueJob(
  db: Client,
  input: {
    item: StoredProductTruthOperationalRunItem;
    queueJobId: string;
    runLeaseToken: string;
    itemLeaseToken: string;
    at: string;
  },
): Promise<StoredProductTruthOperationalRunItem> {
  await assertProductTruthOperationalRunSchema(db);
  const queueJobId = exactText(input.queueJobId, "queueJobId", 200);
  const runLeaseToken = exactText(input.runLeaseToken, "runLeaseToken", 200);
  const itemLeaseToken = exactText(input.itemLeaseToken, "itemLeaseToken", 200);
  const at = canonicalInstant(input.at, "at");
  const transaction = await db.transaction("write");
  try {
    const currentResult = await transaction.execute({
      sql: `SELECT ${ITEM_COLUMNS.map((column) => `item."${column}"`).join(", ")}
            FROM "ProductTruthOperationalRunItem" item
            JOIN "ProductTruthOperationalRun" run ON run."runId"=item."runId"
            WHERE item."id"=?
              AND item."status" IN (${ACTIVE_ITEM_STATUSES.map(() => "?").join(",")})
              AND item."leaseToken"=? AND julianday(item."leaseExpiresAt")>julianday(?)
              AND run."status"='running' AND run."leaseToken"=?
              AND julianday(run."leaseExpiresAt")>julianday(?)
            LIMIT 1`,
      args: [
        input.item.id, ...ACTIVE_ITEM_STATUSES, itemLeaseToken, at,
        runLeaseToken, at,
      ],
    });
    if (!currentResult.rows[0]) {
      throw storeError("OPERATIONAL_ITEM_CAS_LOST", "queue target item does not own an exact live lease");
    }
    const current = parseProductTruthOperationalItemRow(currentResult.rows[0] as Record<string, unknown>);
    if (current.queueJobId === queueJobId) {
      await transaction.commit();
      return current;
    }
    if (current.queueJobId !== null) {
      throw storeError("OPERATIONAL_QUEUE_BIND_CONFLICT", "queue job binding differs");
    }
    const result = await transaction.execute({
      sql: `UPDATE "ProductTruthOperationalRunItem"
            SET "queueJobId"=?, "updatedAt"=?
            WHERE "id"=? AND "runId"=? AND "status" IN (${ACTIVE_ITEM_STATUSES.map(() => "?").join(",")})
              AND "queueJobId" IS NULL AND "leaseToken"=?
              AND julianday("leaseExpiresAt")>julianday(?)
              AND EXISTS (
                SELECT 1 FROM "ProductTruthOperationalRun" run
                WHERE run."runId"="ProductTruthOperationalRunItem"."runId"
                  AND run."status"='running' AND run."leaseToken"=?
                  AND julianday(run."leaseExpiresAt")>julianday(?)
              )`,
      args: [
        queueJobId, at, input.item.id, input.item.runId, ...ACTIVE_ITEM_STATUSES,
        itemLeaseToken, at, runLeaseToken, at,
      ],
    });
    if (result.rowsAffected !== 1) {
      throw storeError("OPERATIONAL_QUEUE_BIND_CONFLICT", "queue binding lost its exact active lease");
    }
    await appendEvent(transaction, {
      runId: input.item.runId,
      eventType: "ITEM_QUEUE_BOUND",
      itemId: input.item.id,
      payload: { queueJobId },
      at,
    });
    const storedResult = await transaction.execute({
      sql: `SELECT ${itemSelect()} FROM "ProductTruthOperationalRunItem" WHERE "id"=? LIMIT 1`,
      args: [input.item.id],
    });
    const stored = parseProductTruthOperationalItemRow(storedResult.rows[0] as Record<string, unknown>);
    await transaction.commit();
    return stored;
  } catch (error) {
    await transaction.rollback();
    if (error instanceof ProductTruthOperationalStoreError) throw error;
    throw storeError("OPERATIONAL_QUEUE_BIND_FAILED", "could not bind exact queue job", error);
  } finally {
    transaction.close();
  }
}

export interface TerminalizedProductTruthOperationalPreAttempt {
  item: StoredProductTruthOperationalRunItem;
  queue: {
    id: string;
    status: "cancelled";
    attempts: 0;
    cancelled: boolean;
  } | null;
}

function parseQueueRequestedFields(value: unknown): string[] {
  if (typeof value !== "string") {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, "queue requestedFields must be JSON text");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, "queue requestedFields is invalid JSON", error);
  }
  if (
    !Array.isArray(parsed)
    || parsed.length < 1
    || parsed.some((field) => typeof field !== "string" || !field || field !== field.trim())
    || new Set(parsed).size !== parsed.length
  ) {
    throw storeError(
      PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR,
      "queue requestedFields must be an exact unique string array",
    );
  }
  return [...parsed].sort((left, right) => left.localeCompare(right, "en-US"));
}

/**
 * Close work that failed before the one authorized attempt. Queue discovery is
 * deliberately database-authoritative: an enqueue or bind may have committed
 * even when its response never reached the runner. Any exact active intent is
 * cancelled in the same transaction as the attempts=0 item terminalization.
 */
export async function terminalizeProductTruthOperationalPreAttempt(
  db: Client,
  input: {
    item: StoredProductTruthOperationalRunItem;
    runLeaseToken: string;
    itemLeaseToken: string;
    itemStatus: "blocked" | "failed";
    stage: string;
    at: string;
    result: unknown;
    checkpoint: unknown;
    error: string;
  },
): Promise<TerminalizedProductTruthOperationalPreAttempt> {
  await assertProductTruthOperationalRunSchema(db);
  if (input.itemStatus !== "blocked" && input.itemStatus !== "failed") {
    throw storeError(
      "OPERATIONAL_PRE_ATTEMPT_OUTCOME_INVALID",
      "pre-attempt terminal status must be blocked or failed",
    );
  }
  const runLeaseToken = exactText(input.runLeaseToken, "runLeaseToken", 200);
  const itemLeaseToken = exactText(input.itemLeaseToken, "itemLeaseToken", 200);
  const stage = exactText(input.stage, "stage", 100);
  const at = canonicalInstant(input.at, "at");
  const error = exactText(input.error, "error", 2_000);
  const resultJson = renderProductTruthOperationalJson(input.result);
  const resultSha256 = sha256(resultJson);
  const checkpointJson = renderProductTruthOperationalJson(input.checkpoint);
  const checkpointSha256 = sha256(checkpointJson);
  const transaction = await db.transaction("write");
  try {
    const run = await selectRun(transaction, input.item.runId);
    if (
      !run
      || run.status !== "running"
      || run.leaseToken !== runLeaseToken
      || !run.leaseExpiresAt
      || Date.parse(run.leaseExpiresAt) <= Date.parse(at)
      || Date.parse(run.updatedAt) > Date.parse(at)
    ) {
      throw storeError("OPERATIONAL_RUN_CAS_LOST", "run lease is not live for pre-attempt terminalization");
    }

    const currentResult = await transaction.execute({
      sql: `SELECT ${itemSelect()} FROM "ProductTruthOperationalRunItem"
            WHERE "id"=? AND "runId"=? AND "listingKey"=?
              AND "status" IN (${ACTIVE_ITEM_STATUSES.map(() => "?").join(",")})
              AND "leaseToken"=?
              AND julianday("leaseExpiresAt")>julianday(?)
            LIMIT 1`,
      args: [
        input.item.id,
        input.item.runId,
        input.item.listingKey,
        ...ACTIVE_ITEM_STATUSES,
        itemLeaseToken,
        at,
      ],
    });
    if (!currentResult.rows[0]) {
      throw storeError(
        "OPERATIONAL_ITEM_CAS_LOST",
        "item is not exact live attempts=0 work at pre-attempt terminalization",
      );
    }
    const current = parseProductTruthOperationalItemRow(
      currentResult.rows[0] as Record<string, unknown>,
    );
    if (
      current.attempts > 0
      || current.status === "costing"
      || current.status === "harvesting"
    ) {
      throw storeError(
        "OPERATIONAL_ATTEMPT_ALREADY_STARTED",
        "item crossed the one-attempt boundary; pre-attempt terminalization is forbidden",
      );
    }
    if (!["claimed", "reuse_checked", "verifying"].includes(current.status)) {
      throw storeError(
        "OPERATIONAL_PRE_ATTEMPT_STATE_INVALID",
        `item status ${current.status} is not pre-attempt work`,
      );
    }
    if (!ITEM_TRANSITIONS[current.status].includes(input.itemStatus)) {
      throw storeError(
        "OPERATIONAL_ITEM_TRANSITION_INVALID",
        `${current.status} -> ${input.itemStatus}`,
      );
    }
    if (
      input.item.queueJobId !== null
      && current.queueJobId !== null
      && input.item.queueJobId !== current.queueJobId
    ) {
      throw storeError(
        "OPERATIONAL_QUEUE_BIND_CONFLICT",
        "local and durable pre-attempt queue bindings disagree",
      );
    }

    const queuesResult = await transaction.execute({
      sql: `SELECT job."id",job."targetType",job."target",job."listingKey",
                   job."requestedFields",job."status",job."source",job."runId",
                   job."approvalId",job."attempts",scope."sku" AS "scopeSku"
            FROM "EnrichmentJob" job
            JOIN "ProductTruthListingScope" scope ON scope."listingKey"=job."listingKey"
            WHERE job."runId"=? AND job."approvalId"=? AND job."listingKey"=?
            ORDER BY job."createdAt",job."id"`,
      args: [current.runId, run.approvalId, current.listingKey],
    });
    const queueRows = queuesResult.rows as unknown as Record<string, unknown>[];
    const currentFields = [...current.requestedFields]
      .sort((left, right) => left.localeCompare(right, "en-US"));
    for (const queue of queueRows) {
      const queueFields = parseQueueRequestedFields(queue.requestedFields);
      if (
        queue.targetType !== "sku"
        || queue.target !== queue.scopeSku
        || queue.listingKey !== current.listingKey
        || queue.runId !== current.runId
        || queue.approvalId !== run.approvalId
        || queue.source !== "product-truth-operational-runner"
        || JSON.stringify(queueFields) !== JSON.stringify(currentFields)
      ) {
        throw storeError(
          "OPERATIONAL_QUEUE_SCOPE_CONFLICT",
          "pre-attempt queue intent differs from the sealed listing scope",
        );
      }
      const attempts = integer(queue.attempts, "queue.attempts");
      if (attempts > 0 || queue.status === "running") {
        throw storeError(
          "OPERATIONAL_ATTEMPT_ALREADY_STARTED",
          "queue crossed the one-attempt boundary; pre-attempt terminalization is forbidden",
        );
      }
      if (!["queued", "retry_wait", "cancelled"].includes(String(queue.status))) {
        throw storeError(
          "OPERATIONAL_QUEUE_STATE_INVALID",
          `attempts=0 pre-attempt queue has unsupported status ${String(queue.status)}`,
        );
      }
    }

    const activeQueues = queueRows.filter((queue) => (
      queue.status === "queued" || queue.status === "retry_wait"
    ));
    if (activeQueues.length > 1) {
      throw storeError(
        PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR,
        "more than one exact active pre-attempt queue intent exists",
      );
    }
    const rowById = new Map(queueRows.map((queue) => [String(queue.id), queue]));
    if (current.queueJobId && !rowById.has(current.queueJobId)) {
      throw storeError(
        "OPERATIONAL_QUEUE_SCOPE_CONFLICT",
        "durably bound queue does not belong to the exact run/approval/listing intent",
      );
    }
    if (input.item.queueJobId && !rowById.has(input.item.queueJobId)) {
      throw storeError(
        "OPERATIONAL_QUEUE_SCOPE_CONFLICT",
        "locally observed queue does not belong to the exact run/approval/listing intent",
      );
    }
    const activeQueue = activeQueues[0] ?? null;
    const resolvedQueueJobId = current.queueJobId
      ?? input.item.queueJobId
      ?? (activeQueue ? String(activeQueue.id) : null);
    if (activeQueue && resolvedQueueJobId !== String(activeQueue.id)) {
      throw storeError(
        "OPERATIONAL_QUEUE_BIND_CONFLICT",
        "active pre-attempt queue differs from the resolved exact binding",
      );
    }

    let queueCancelled = false;
    if (activeQueue) {
      const queueUpdate = await transaction.execute({
        sql: `UPDATE "EnrichmentJob"
              SET "status"='cancelled', "finishedAt"=?, "result"=?, "error"=?,
                  "terminalReason"='PRE_ATTEMPT_ABORTED',
                  "completedFields"='[]', "unavailableFields"="requestedFields",
                  "checkpoint"=?, "actualSpendUnits"=0,
                  "leaseOwner"=NULL, "leaseToken"=NULL, "leaseExpiresAt"=NULL,
                  "heartbeatAt"=?, "nextEligibleAt"=NULL, "updatedAt"=?
              WHERE "id"=? AND "targetType"='sku' AND "listingKey"=?
                AND "runId"=? AND "approvalId"=?
                AND "status" IN ('queued','retry_wait') AND "attempts"=0`,
        args: [
          at,
          resultJson,
          error,
          checkpointJson,
          at,
          at,
          String(activeQueue.id),
          current.listingKey,
          current.runId,
          run.approvalId,
        ],
      });
      if (queueUpdate.rowsAffected !== 1) {
        throw storeError(
          "OPERATIONAL_QUEUE_CAS_LOST",
          "exact pre-attempt queue changed before atomic cancellation",
        );
      }
      queueCancelled = true;
    }

    const itemUpdate = await transaction.execute({
      sql: `UPDATE "ProductTruthOperationalRunItem"
            SET "queueJobId"=?, "status"=?, "stage"=?,
                "leaseToken"=NULL, "leaseExpiresAt"=NULL,
                "checkpointJson"=?, "checkpointSha256"=?,
                "resultJson"=?, "resultSha256"=?, "lastError"=?,
                "finishedAt"=?, "updatedAt"=?
            WHERE "id"=? AND "runId"=? AND "listingKey"=? AND "status"=?
              AND "attempts"=0 AND "leaseToken"=?
              AND julianday("leaseExpiresAt")>julianday(?)`,
      args: [
        resolvedQueueJobId,
        input.itemStatus,
        stage,
        checkpointJson,
        checkpointSha256,
        resultJson,
        resultSha256,
        error,
        at,
        at,
        current.id,
        current.runId,
        current.listingKey,
        current.status,
        itemLeaseToken,
        at,
      ],
    });
    if (itemUpdate.rowsAffected !== 1) {
      throw storeError(
        "OPERATIONAL_ITEM_CAS_LOST",
        "pre-attempt item changed during atomic terminalization",
      );
    }
    await appendEvent(transaction, {
      runId: current.runId,
      eventType: "PRE_ATTEMPT_TERMINALIZED",
      itemId: current.id,
      payload: {
        fromStatus: current.status,
        itemStatus: input.itemStatus,
        stage,
        queueJobId: resolvedQueueJobId,
        queueCancelled,
        resultSha256,
        checkpointSha256,
      },
      at,
    });
    const storedResult = await transaction.execute({
      sql: `SELECT ${itemSelect()} FROM "ProductTruthOperationalRunItem" WHERE "id"=? LIMIT 1`,
      args: [current.id],
    });
    const item = parseProductTruthOperationalItemRow(
      storedResult.rows[0] as Record<string, unknown>,
    );
    await transaction.commit();
    return {
      item,
      queue: resolvedQueueJobId
        ? { id: resolvedQueueJobId, status: "cancelled", attempts: 0, cancelled: queueCancelled }
        : null,
    };
  } catch (error_) {
    await transaction.rollback();
    if (error_ instanceof ProductTruthOperationalStoreError) throw error_;
    throw storeError(
      "OPERATIONAL_PRE_ATTEMPT_TERMINALIZATION_FAILED",
      "atomic pre-attempt terminalization failed",
      error_,
    );
  } finally {
    transaction.close();
  }
}

export interface StartedProductTruthOperationalAttempt {
  item: StoredProductTruthOperationalRunItem;
  queue: {
    id: string;
    status: "running";
    attempts: 1;
    leaseToken: string;
    leaseExpiresAt: string;
  };
}

/**
 * The only safe v1 attempt boundary. Queue claim and item attempt increment
 * commit together, so a crash can never leave replayable item state beside an
 * already-attempted queue row.
 */
export async function startProductTruthOperationalAttempt(
  db: Client,
  input: {
    item: StoredProductTruthOperationalRunItem;
    runLeaseToken: string;
    itemLeaseToken: string;
    queueLeaseOwner: string;
    queueLeaseToken: string;
    at: string;
    checkpoint?: unknown;
  },
): Promise<StartedProductTruthOperationalAttempt> {
  await assertProductTruthOperationalRunSchema(db);
  if (
    input.item.status !== "reuse_checked"
    || input.item.attempts !== 0
    || !input.item.queueJobId
    || !input.item.leaseExpiresAt
  ) {
    throw storeError(
      "OPERATIONAL_ATTEMPT_STATE_INVALID",
      "attempt start requires one bound reuse_checked item before its attempt boundary",
    );
  }
  const runLeaseToken = exactText(input.runLeaseToken, "runLeaseToken", 200);
  const itemLeaseToken = exactText(input.itemLeaseToken, "itemLeaseToken", 200);
  const queueLeaseOwner = exactText(input.queueLeaseOwner, "queueLeaseOwner", 200);
  const queueLeaseToken = exactText(input.queueLeaseToken, "queueLeaseToken", 200);
  const at = canonicalInstant(input.at, "at");
  const checkpointJson = input.checkpoint === undefined
    ? input.item.checkpointJson
    : renderProductTruthOperationalJson(input.checkpoint);
  const checkpointSha256 = checkpointJson == null ? null : sha256(checkpointJson);
  const transaction = await db.transaction("write");
  try {
    const run = await selectRun(transaction, input.item.runId);
    if (
      !run
      || run.status !== "running"
      || run.leaseToken !== runLeaseToken
      || !run.leaseExpiresAt
      || Date.parse(run.leaseExpiresAt) <= Date.parse(at)
    ) {
      throw storeError("OPERATIONAL_RUN_CAS_LOST", "run lease is not live at the attempt boundary");
    }
    const currentItemResult = await transaction.execute({
      sql: `SELECT ${itemSelect()} FROM "ProductTruthOperationalRunItem"
            WHERE "id"=? AND "runId"=? AND "listingKey"=? AND "queueJobId"=?
              AND "status"='reuse_checked' AND "attempts"=0 AND "leaseToken"=?
              AND julianday("leaseExpiresAt")>julianday(?)
            LIMIT 1`,
      args: [
        input.item.id, input.item.runId, input.item.listingKey,
        input.item.queueJobId, itemLeaseToken, at,
      ],
    });
    if (!currentItemResult.rows[0]) {
      throw storeError("OPERATIONAL_ITEM_CAS_LOST", "item lease is not live at the attempt boundary");
    }
    const currentItem = parseProductTruthOperationalItemRow(
      currentItemResult.rows[0] as Record<string, unknown>,
    );
    if (Date.parse(currentItem.leaseExpiresAt!) > Date.parse(run.leaseExpiresAt)) {
      throw storeError(PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR, "item lease exceeds its run lease");
    }
    const queueUpdate = await transaction.execute({
      sql: `UPDATE "EnrichmentJob"
            SET "status"='running', "attempts"=1,
                "startedAt"=COALESCE("startedAt",?), "heartbeatAt"=?,
                "leaseOwner"=?, "leaseToken"=?, "leaseExpiresAt"=?, "updatedAt"=?
            WHERE "id"=? AND "targetType"='sku' AND "listingKey"=?
              AND "runId"=? AND "approvalId"=?
              AND "status" IN ('queued','retry_wait') AND "attempts"=0`,
      args: [
        at, at, queueLeaseOwner, queueLeaseToken, currentItem.leaseExpiresAt, at,
        currentItem.queueJobId, currentItem.listingKey, currentItem.runId, run.approvalId,
      ],
    });
    if (queueUpdate.rowsAffected !== 1) {
      throw storeError("OPERATIONAL_QUEUE_CAS_LOST", "queue row was already attempted or changed");
    }
    const itemUpdate = await transaction.execute({
      sql: `UPDATE "ProductTruthOperationalRunItem"
            SET "status"='costing', "stage"='COSTING', "attempts"=1,
                "checkpointJson"=?, "checkpointSha256"=?, "updatedAt"=?
            WHERE "id"=? AND "status"='reuse_checked' AND "attempts"=0
              AND "leaseToken"=? AND julianday("leaseExpiresAt")>julianday(?)`,
      args: [
        checkpointJson, checkpointSha256, at, currentItem.id, itemLeaseToken, at,
      ],
    });
    if (itemUpdate.rowsAffected !== 1) {
      throw storeError("OPERATIONAL_ITEM_CAS_LOST", "item changed while crossing attempt boundary");
    }
    await appendEvent(transaction, {
      runId: currentItem.runId,
      eventType: "ATTEMPT_STARTED",
      itemId: currentItem.id,
      payload: {
        queueJobId: currentItem.queueJobId,
        listingKey: currentItem.listingKey,
        attempts: 1,
        leaseExpiresAt: currentItem.leaseExpiresAt,
        checkpointSha256,
      },
      at,
    });
    const storedResult = await transaction.execute({
      sql: `SELECT ${itemSelect()} FROM "ProductTruthOperationalRunItem" WHERE "id"=? LIMIT 1`,
      args: [currentItem.id],
    });
    const item = parseProductTruthOperationalItemRow(storedResult.rows[0] as Record<string, unknown>);
    await transaction.commit();
    return {
      item,
      queue: {
        id: currentItem.queueJobId!,
        status: "running",
        attempts: 1,
        leaseToken: queueLeaseToken,
        leaseExpiresAt: currentItem.leaseExpiresAt!,
      },
    };
  } catch (error) {
    await transaction.rollback();
    if (error instanceof ProductTruthOperationalStoreError) throw error;
    throw storeError("OPERATIONAL_ATTEMPT_START_FAILED", "atomic attempt start failed", error);
  } finally {
    transaction.close();
  }
}

export type ProductTruthOperationalQueueTerminalStatus =
  | "done"
  | "partial"
  | "source_unavailable"
  | "error";

export interface TerminalizedProductTruthOperationalAttempt {
  item: StoredProductTruthOperationalRunItem;
  queue: {
    id: string;
    status: ProductTruthOperationalQueueTerminalStatus;
    runId: string;
    approvalId: string;
    listingKey: string;
    attempts: 1;
    actualSpendUnits: number;
    resultJson: string;
    checkpointJson: string;
    terminalReason: string | null;
  };
}

function canonicalStringArray(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values)) {
    throw storeError("OPERATIONAL_STORE_INPUT_INVALID", `${label} must be an array`);
  }
  const result = values.map((value, index) => exactText(value, `${label}[${index}]`, 100));
  if (new Set(result).size !== result.length) {
    throw storeError("OPERATIONAL_STORE_INPUT_INVALID", `${label} must not contain duplicates`);
  }
  return [...result].sort((left, right) => left.localeCompare(right, "en-US"));
}

/**
 * Atomically closes the one attempted queue lease and its operational item.
 * Neither half can become terminal if exact run/approval/listing provenance or
 * either lease differs. This is the only safe attempted-work terminalization
 * boundary for the operational runner.
 */
export async function terminalizeProductTruthOperationalAttempt(
  db: Client,
  input: {
    item: StoredProductTruthOperationalRunItem;
    runLeaseToken: string;
    itemLeaseToken: string;
    queueLeaseToken: string;
    queueStatus: ProductTruthOperationalQueueTerminalStatus;
    itemStatus: Extract<
      ProductTruthOperationalItemStatus,
      "done" | "terminal_gap" | "blocked" | "ambiguous" | "failed"
    >;
    stage: string;
    at: string;
    completedFields: readonly string[];
    unavailableFields: readonly string[];
    actualSpendUnits: number;
    result: unknown;
    checkpoint: unknown;
    terminalReason: string | null;
    error?: string | null;
  },
): Promise<TerminalizedProductTruthOperationalAttempt> {
  await assertProductTruthOperationalRunSchema(db);
  if (!input.item.queueJobId) {
    throw storeError("OPERATIONAL_QUEUE_BIND_REQUIRED", "attempted item has no bound queue job");
  }
  if (input.item.attempts !== 1 || !(ACTIVE_ITEM_STATUSES as readonly string[]).includes(input.item.status)) {
    throw storeError("OPERATIONAL_ITEM_ATTEMPT_INVALID", "only the one active attempt can be terminalized");
  }
  if (!ITEM_TRANSITIONS[input.item.status].includes(input.itemStatus)) {
    throw storeError("OPERATIONAL_ITEM_TRANSITION_INVALID", `${input.item.status} -> ${input.itemStatus}`);
  }
  const validPair = (
    (input.itemStatus === "done" && input.queueStatus === "done")
    || (
      input.itemStatus === "terminal_gap"
      && (input.queueStatus === "partial" || input.queueStatus === "source_unavailable")
    )
    || (
      ["blocked", "ambiguous", "failed"].includes(input.itemStatus)
      && input.queueStatus === "error"
    )
  );
  if (!validPair) {
    throw storeError("OPERATIONAL_TERMINAL_OUTCOME_INVALID", "queue and item terminal outcomes disagree");
  }
  const runLeaseToken = exactText(input.runLeaseToken, "runLeaseToken", 200);
  const itemLeaseToken = exactText(input.itemLeaseToken, "itemLeaseToken", 200);
  const queueLeaseToken = exactText(input.queueLeaseToken, "queueLeaseToken", 200);
  const stage = exactText(input.stage, "stage", 100);
  const at = canonicalInstant(input.at, "at");
  if (typeof input.actualSpendUnits !== "number" || !Number.isFinite(input.actualSpendUnits) || input.actualSpendUnits < 0) {
    throw storeError("OPERATIONAL_STORE_INPUT_INVALID", "actualSpendUnits must be finite and non-negative");
  }
  const completedFields = canonicalStringArray(input.completedFields, "completedFields");
  const unavailableFields = canonicalStringArray(input.unavailableFields, "unavailableFields");
  if (completedFields.some((field) => unavailableFields.includes(field))) {
    throw storeError("OPERATIONAL_STORE_INPUT_INVALID", "completed and unavailable fields must be disjoint");
  }
  const terminalReason = input.terminalReason == null
    ? null
    : exactText(input.terminalReason, "terminalReason", 500);
  if (input.queueStatus === "done" ? terminalReason !== null : terminalReason === null) {
    throw storeError("OPERATIONAL_TERMINAL_OUTCOME_INVALID", "non-success requires one terminal reason and success forbids it");
  }
  const resultJson = renderProductTruthOperationalJson(input.result);
  const resultSha256 = sha256(resultJson);
  const checkpointJson = renderProductTruthOperationalJson(input.checkpoint);
  const checkpointSha256 = sha256(checkpointJson);
  const completedFieldsJson = renderProductTruthOperationalJson(completedFields);
  const unavailableFieldsJson = renderProductTruthOperationalJson(unavailableFields);
  const error = input.error == null ? null : String(input.error).slice(0, 2_000);
  const transaction = await db.transaction("write");
  try {
    const run = await selectRun(transaction, input.item.runId);
    if (
      !run
      || run.status !== "running"
      || run.leaseToken !== runLeaseToken
      || !run.leaseExpiresAt
      || Date.parse(run.leaseExpiresAt) <= Date.parse(at)
    ) {
      throw storeError("OPERATIONAL_RUN_CAS_LOST", "run lease is not live for terminalization");
    }
    const queueResult = await transaction.execute({
      sql: `SELECT job."id",job."targetType",job."target",job."listingKey",job."status",
                   job."runId",job."approvalId",job."attempts",job."leaseToken",
                   job."leaseExpiresAt",job."estimatedSpendUnits",scope."sku" AS "scopeSku"
            FROM "EnrichmentJob" job
            JOIN "ProductTruthListingScope" scope ON scope."listingKey"=job."listingKey"
            WHERE job."id"=? LIMIT 1`,
      args: [input.item.queueJobId],
    });
    const queue = queueResult.rows[0];
    if (
      !queue
      || queue.targetType !== "sku"
      || queue.target !== queue.scopeSku
      || queue.listingKey !== input.item.listingKey
      || queue.runId !== input.item.runId
      || queue.approvalId !== run.approvalId
      || queue.status !== "running"
      || integer(queue.attempts, "queue.attempts") !== 1
      || queue.leaseToken !== queueLeaseToken
      || queue.leaseExpiresAt == null
      || Date.parse(String(queue.leaseExpiresAt)) <= Date.parse(at)
    ) {
      throw storeError("OPERATIONAL_QUEUE_CAS_LOST", "bound queue attempt provenance or lease differs");
    }
    const queueUpdate = await transaction.execute({
      sql: `UPDATE "EnrichmentJob"
            SET "status"=?, "finishedAt"=?, "result"=?, "error"=?,
                "terminalReason"=?, "completedFields"=?, "unavailableFields"=?,
                "checkpoint"=?, "actualSpendUnits"=?,
                "leaseOwner"=NULL, "leaseToken"=NULL, "leaseExpiresAt"=NULL,
                "heartbeatAt"=?, "nextEligibleAt"=NULL, "updatedAt"=?
            WHERE "id"=? AND "targetType"='sku' AND "listingKey"=?
              AND "runId"=? AND "approvalId"=?
              AND "status"='running' AND "attempts"=1 AND "leaseToken"=?
              AND julianday("leaseExpiresAt")>julianday(?)`,
      args: [
        input.queueStatus, at, resultJson, error, terminalReason,
        completedFieldsJson, unavailableFieldsJson, checkpointJson,
        input.actualSpendUnits, at, at, input.item.queueJobId,
        input.item.listingKey, input.item.runId, run.approvalId,
        queueLeaseToken, at,
      ],
    });
    if (queueUpdate.rowsAffected !== 1) {
      throw storeError("OPERATIONAL_QUEUE_CAS_LOST", "queue lease changed during terminalization");
    }
    const itemUpdate = await transaction.execute({
      sql: `UPDATE "ProductTruthOperationalRunItem"
            SET "status"=?, "stage"=?, "leaseToken"=NULL, "leaseExpiresAt"=NULL,
                "checkpointJson"=?, "checkpointSha256"=?,
                "resultJson"=?, "resultSha256"=?, "lastError"=?,
                "finishedAt"=?, "updatedAt"=?
            WHERE "id"=? AND "runId"=? AND "listingKey"=? AND "queueJobId"=?
              AND "status"=? AND "attempts"=1 AND "leaseToken"=?
              AND julianday("leaseExpiresAt")>julianday(?)`,
      args: [
        input.itemStatus, stage, checkpointJson, checkpointSha256,
        resultJson, resultSha256, error, at, at,
        input.item.id, input.item.runId, input.item.listingKey, input.item.queueJobId,
        input.item.status, itemLeaseToken, at,
      ],
    });
    if (itemUpdate.rowsAffected !== 1) {
      throw storeError("OPERATIONAL_ITEM_CAS_LOST", "item lease changed during terminalization");
    }
    await appendEvent(transaction, {
      runId: input.item.runId,
      eventType: "ATTEMPT_TERMINALIZED",
      itemId: input.item.id,
      payload: {
        queueJobId: input.item.queueJobId,
        queueStatus: input.queueStatus,
        itemStatus: input.itemStatus,
        actualSpendUnits: input.actualSpendUnits,
        completedFields,
        unavailableFields,
        terminalReason,
        resultSha256,
        checkpointSha256,
      },
      at,
    });
    const storedItemResult = await transaction.execute({
      sql: `SELECT ${itemSelect()} FROM "ProductTruthOperationalRunItem" WHERE "id"=? LIMIT 1`,
      args: [input.item.id],
    });
    const item = parseProductTruthOperationalItemRow(storedItemResult.rows[0] as Record<string, unknown>);
    await transaction.commit();
    return {
      item,
      queue: {
        id: input.item.queueJobId,
        status: input.queueStatus,
        runId: input.item.runId,
        approvalId: run.approvalId,
        listingKey: input.item.listingKey,
        attempts: 1,
        actualSpendUnits: input.actualSpendUnits,
        resultJson,
        checkpointJson,
        terminalReason,
      },
    };
  } catch (error_) {
    await transaction.rollback();
    if (error_ instanceof ProductTruthOperationalStoreError) throw error_;
    throw storeError("OPERATIONAL_ATTEMPT_TERMINALIZATION_FAILED", "queue/item atomic terminalization failed", error_);
  } finally {
    transaction.close();
  }
}

export async function finishProductTruthOperationalRun(
  db: Client,
  input: {
    runId: string;
    leaseToken: string;
    status: "interrupted" | "blocked" | "ambiguous" | "completed" | "failed";
    at: string;
    reportSha256?: string | null;
    artifactIndexSha256?: string | null;
  },
): Promise<StoredProductTruthOperationalRun> {
  await assertProductTruthOperationalRunSchema(db);
  const at = canonicalInstant(input.at, "at");
  const reportSha256 = input.reportSha256 == null ? null : exactHash(input.reportSha256, "reportSha256");
  const artifactIndexSha256 = input.artifactIndexSha256 == null
    ? null
    : exactHash(input.artifactIndexSha256, "artifactIndexSha256");
  if (input.status === "completed" && (!reportSha256 || !artifactIndexSha256)) {
    throw storeError("OPERATIONAL_REPORT_REQUIRED", "completed run requires report and artifact index hashes");
  }
  const runId = exactText(input.runId, "runId");
  const leaseToken = exactText(input.leaseToken, "leaseToken", 200);
  const transaction = await db.transaction("write");
  try {
    const active = await transaction.execute({
      sql: `SELECT COUNT(*) AS count FROM "ProductTruthOperationalRunItem"
            WHERE "runId"=? AND "status" IN (${ACTIVE_ITEM_STATUSES.map(() => "?").join(",")})`,
      args: [runId, ...ACTIVE_ITEM_STATUSES],
    });
    if (integer(active.rows[0]?.count, "active item count") !== 0) {
      throw storeError("OPERATIONAL_ITEMS_ACTIVE", "cannot finish a run while an item owns a lease");
    }
    if (input.status === "completed") {
      const incomplete = await transaction.execute({
        sql: `SELECT COUNT(*) AS count FROM "ProductTruthOperationalRunItem"
              WHERE "runId"=? AND "status" NOT IN ('done','terminal_gap')`,
        args: [runId],
      });
      if (integer(incomplete.rows[0]?.count, "incomplete item count") !== 0) {
        throw storeError("OPERATIONAL_ITEMS_INCOMPLETE", "completed run contains non-terminal work");
      }
    }
    const result = await transaction.execute({
      sql: `UPDATE "ProductTruthOperationalRun"
            SET "status"=?, "leaseOwner"=NULL, "leaseToken"=NULL,
                "leaseExpiresAt"=NULL, "heartbeatAt"=NULL, "finishedAt"=?,
                "reportSha256"=?, "artifactIndexSha256"=?, "updatedAt"=?
            WHERE "runId"=? AND "status"='running' AND "leaseToken"=?
              AND julianday("leaseExpiresAt")>julianday(?)`,
      args: [
        input.status, input.status === "interrupted" ? null : at,
        reportSha256, artifactIndexSha256, at,
        runId, leaseToken, at,
      ],
    });
    if (result.rowsAffected !== 1) {
      throw storeError("OPERATIONAL_RUN_CAS_LOST", "run lease expired or was lost");
    }
    await appendEvent(transaction, {
      runId,
      eventType: "RUN_FINISHED",
      payload: {
        status: input.status,
        reportSha256,
        artifactIndexSha256,
      },
      at,
    });
    const run = await selectRun(transaction, runId);
    if (!run) throw storeError("OPERATIONAL_RUN_MISSING", "finished run disappeared");
    verifyEventChain(run, await selectEvents(transaction, runId));
    await transaction.commit();
    return run;
  } catch (error) {
    await transaction.rollback();
    if (error instanceof ProductTruthOperationalStoreError) throw error;
    throw storeError("OPERATIONAL_RUN_FINISH_FAILED", "could not finish operational run", error);
  } finally {
    transaction.close();
  }
}

/**
 * Targeted donor evidence has no listing-scoped OperationalRunItem, so the
 * listing runner's generic expiry reaper must never interpret its product job.
 * The caller first reconciles immutable metered receipts and exact evidence,
 * then supplies the only safe disposition. This function performs the durable
 * lease transition and quarantines an ambiguous product job atomically.
 */
export async function reapExpiredProductTruthTargetedEvidenceRun(
  db: Client,
  input: {
    runId: string;
    at: string;
    disposition: "interrupted" | "ambiguous";
    reason: string;
  },
): Promise<{
  status: "not_expired" | "interrupted" | "ambiguous";
  run: StoredProductTruthOperationalRun;
}> {
  await assertProductTruthOperationalRunSchema(db);
  const at = canonicalInstant(input.at, "at");
  const reason = exactText(input.reason, "reason", 500);
  const transaction = await db.transaction("write");
  try {
    const run = await selectRun(transaction, input.runId);
    if (!run) throw storeError("OPERATIONAL_RUN_MISSING", "run does not exist");
    if (run.planSchemaVersion !== "product-truth-targeted-walmart-evidence-plan/1.0.0") {
      throw storeError(
        "OPERATIONAL_RUN_KIND_MISMATCH",
        "targeted evidence reaper cannot handle another plan contract",
      );
    }
    if (
      run.status !== "running"
      || !run.leaseExpiresAt
      || Date.parse(run.leaseExpiresAt) > Date.parse(at)
    ) {
      await transaction.commit();
      return { status: "not_expired", run };
    }
    const itemCount = await transaction.execute({
      sql: `SELECT COUNT(*) AS count FROM "ProductTruthOperationalRunItem" WHERE "runId"=?`,
      args: [run.runId],
    });
    if (integer(itemCount.rows[0]?.count, "targeted run item count") !== 0) {
      throw storeError("OPERATIONAL_RUN_CONFLICT", "targeted run contains listing items");
    }
    const jobs = await transaction.execute({
      sql: `SELECT "id","targetType","target","listingKey","requestedFields",
                  "source","status","attempts",
                  "leaseOwner","leaseToken","leaseExpiresAt"
            FROM "EnrichmentJob" WHERE "runId"=? AND "approvalId"=?
            ORDER BY "createdAt","id"`,
      args: [run.runId, run.approvalId],
    });
    if (jobs.rows.length > 1) {
      throw storeError("OPERATIONAL_RUN_CONFLICT", "targeted run owns more than one queue job");
    }
    const job = jobs.rows[0];
    let sealedTarget: string;
    try {
      const parsed = JSON.parse(run.planJson) as { targets?: Array<{ donorProductId?: unknown }> };
      sealedTarget = exactText(parsed.targets?.[0]?.donorProductId, "targeted donorProductId");
    } catch (error) {
      throw storeError("OPERATIONAL_RUN_CONFLICT", "targeted plan target is unreadable", error);
    }
    const expectedJobId = `ptej_${sha256(`targeted-walmart-evidence-job/1\n${run.planSha256}`)}`;
    const expectedSource = `product-truth-targeted-walmart-evidence:${run.planSha256}`;
    if (job && (
      job.id !== expectedJobId
      || job.targetType !== "product"
      || job.target !== sealedTarget
      || job.listingKey !== null
      || job.requestedFields !== JSON.stringify(["content", "offers"])
      || job.source !== expectedSource
      || integer(job.attempts, "targeted queue attempts") > 1
    )) {
      throw storeError("OPERATIONAL_RUN_CONFLICT", "targeted product queue identity is invalid");
    }
    if (job && input.disposition === "ambiguous" && ["queued", "retry_wait", "running"].includes(String(job.status))) {
      const result = renderProductTruthOperationalJson({
        outcome: "AMBIGUOUS",
        reason,
      });
      const quarantined = await transaction.execute({
        sql: `UPDATE "EnrichmentJob"
              SET "status"='error',"terminalReason"=?,"result"=?,"error"=?,
                  "completedFields"=COALESCE("completedFields",'[]'),
                  "unavailableFields"=COALESCE("unavailableFields","requestedFields"),
                  "finishedAt"=?,"nextEligibleAt"=NULL,"leaseOwner"=NULL,
                  "leaseToken"=NULL,"leaseExpiresAt"=NULL,"heartbeatAt"=?,"updatedAt"=?
              WHERE "id"=? AND "runId"=? AND "approvalId"=? AND "status"=?
                AND "leaseOwner" IS ? AND "leaseToken" IS ? AND "leaseExpiresAt" IS ?`,
        args: [
          reason, result, reason, at, at, at, job.id, run.runId, run.approvalId,
          job.status, job.leaseOwner, job.leaseToken, job.leaseExpiresAt,
        ],
      });
      if (quarantined.rowsAffected !== 1) {
        throw storeError("OPERATIONAL_QUEUE_CAS_LOST", "targeted ambiguous job changed during recovery");
      }
    } else if (job && input.disposition === "interrupted" && String(job.status) === "running") {
      const released = await transaction.execute({
        sql: `UPDATE "EnrichmentJob"
              SET "leaseOwner"=NULL,"leaseToken"=NULL,"leaseExpiresAt"=NULL,
                  "heartbeatAt"=?,"updatedAt"=?
              WHERE "id"=? AND "runId"=? AND "approvalId"=? AND "status"=?
                AND "leaseOwner" IS ? AND "leaseToken" IS ? AND "leaseExpiresAt" IS ?`,
        args: [
          at, at, job.id, run.runId, run.approvalId, job.status,
          job.leaseOwner, job.leaseToken, job.leaseExpiresAt,
        ],
      });
      if (released.rowsAffected !== 1) {
        throw storeError("OPERATIONAL_QUEUE_CAS_LOST", "targeted job lease changed during recovery");
      }
    }
    const updated = await transaction.execute({
      sql: `UPDATE "ProductTruthOperationalRun"
            SET "status"=?,"leaseOwner"=NULL,"leaseToken"=NULL,
                "leaseExpiresAt"=NULL,"heartbeatAt"=NULL,"finishedAt"=?,"updatedAt"=?
            WHERE "runId"=? AND "status"='running' AND "leaseToken"=?
              AND julianday("leaseExpiresAt")<=julianday(?)`,
      args: [
        input.disposition,
        input.disposition === "ambiguous" ? at : null,
        at,
        run.runId,
        run.leaseToken,
        at,
      ],
    });
    if (updated.rowsAffected !== 1) {
      throw storeError("OPERATIONAL_RUN_CAS_LOST", "targeted expired run changed during recovery");
    }
    await appendEvent(transaction, {
      runId: run.runId,
      eventType: input.disposition === "ambiguous"
        ? "RUN_LEASE_EXPIRED_TARGETED_AMBIGUOUS"
        : "RUN_LEASE_EXPIRED_TARGETED_SAFE",
      payload: {
        executionKind: "TARGETED_WALMART_EVIDENCE",
        reason,
        queueJobId: job == null ? null : String(job.id),
      },
      at,
    });
    const stored = await selectRun(transaction, run.runId);
    if (!stored) throw storeError("OPERATIONAL_RUN_MISSING", "reaped targeted run disappeared");
    verifyEventChain(stored, await selectEvents(transaction, run.runId));
    await transaction.commit();
    return { status: input.disposition, run: stored };
  } catch (error) {
    await transaction.rollback();
    if (error instanceof ProductTruthOperationalStoreError) throw error;
    throw storeError(
      "OPERATIONAL_RUN_REAP_FAILED",
      "could not recover expired targeted evidence run lease",
      error,
    );
  } finally {
    transaction.close();
  }
}

export async function reapExpiredProductTruthOperationalRun(
  db: Client,
  input: { runId: string; at: string },
): Promise<{ status: "not_expired" | "interrupted" | "ambiguous"; run: StoredProductTruthOperationalRun }> {
  await assertProductTruthOperationalRunSchema(db);
  const at = canonicalInstant(input.at, "at");
  const transaction = await db.transaction("write");
  try {
    const runResult = await transaction.execute({
      sql: `SELECT ${runSelect()} FROM "ProductTruthOperationalRun" WHERE "runId"=? LIMIT 1`,
      args: [input.runId],
    });
    if (!runResult.rows[0]) throw storeError("OPERATIONAL_RUN_MISSING", "run does not exist");
    const run = parseProductTruthOperationalRunRow(runResult.rows[0] as Record<string, unknown>);
    if (run.status !== "running" || !run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) > Date.parse(at)) {
      await transaction.commit();
      return { status: "not_expired", run };
    }
    const itemsResult = await transaction.execute({
      sql: `SELECT ${itemSelect()} FROM "ProductTruthOperationalRunItem"
            WHERE "runId"=? ORDER BY "ordinal"`,
      args: [run.runId],
    });
    const allItems = itemsResult.rows.map((row) => (
      parseProductTruthOperationalItemRow(row as Record<string, unknown>)
    ));
    const itemByListing = new Map(allItems.map((item) => [item.listingKey, item]));
    const activeItems = allItems.filter((item) => (
      (ACTIVE_ITEM_STATUSES as readonly string[]).includes(item.status)
    ));
    const activeItemIds = new Set(activeItems.map((item) => item.id));
    const queueAttempted = new Map(activeItems.map((item) => [item.id, false]));
    const queueAnomalies: string[] = [];
    const safeActiveQueueIds = new Set<string>();
    const crossedActiveQueueIds = new Set<string>();
    const exactActiveQueueCount = new Map<string, number>();
    let queueUnsafe = false;

    const activeQueues = await transaction.execute({
      sql: `SELECT job."id",job."targetType",job."target",job."listingKey",
                   job."requestedFields",job."status",job."source",job."runId",
                   job."approvalId",job."attempts",scope."sku" AS "scopeSku"
            FROM "EnrichmentJob" job
            LEFT JOIN "ProductTruthListingScope" scope ON scope."listingKey"=job."listingKey"
            WHERE job."runId"=? AND job."approvalId"=?
              AND job."status" IN ('queued','retry_wait','running')
            ORDER BY job."createdAt",job."id"`,
      args: [run.runId, run.approvalId],
    });
    for (const row of activeQueues.rows as unknown as Record<string, unknown>[]) {
      const queueId = String(row.id);
      const listingKey = String(row.listingKey);
      const item = itemByListing.get(listingKey);
      let identityMatches = false;
      try {
        identityMatches = Boolean(
          item
          && row.targetType === "sku"
          && row.target === row.scopeSku
          && row.source === "product-truth-operational-runner"
          && JSON.stringify(parseQueueRequestedFields(row.requestedFields))
            === JSON.stringify([...item.requestedFields].sort((left, right) => left.localeCompare(right, "en-US"))),
        );
      } catch {
        identityMatches = false;
      }
      if (!identityMatches || !item) {
        queueUnsafe = true;
        if (item && activeItemIds.has(item.id)) queueAttempted.set(item.id, true);
        queueAnomalies.push(`${queueId}:QUEUE_IDENTITY_MISMATCH`);
        continue;
      }
      const count = (exactActiveQueueCount.get(item.id) ?? 0) + 1;
      exactActiveQueueCount.set(item.id, count);
      if (count > 1 || (item.queueJobId !== null && item.queueJobId !== queueId)) {
        queueUnsafe = true;
        if (activeItemIds.has(item.id)) queueAttempted.set(item.id, true);
        queueAnomalies.push(`${queueId}:QUEUE_BINDING_CONFLICT`);
        continue;
      }
      let attempts: number;
      try {
        attempts = integer(row.attempts, "queue.attempts");
      } catch {
        queueUnsafe = true;
        if (activeItemIds.has(item.id)) queueAttempted.set(item.id, true);
        queueAnomalies.push(`${queueId}:QUEUE_ATTEMPTS_INVALID`);
        continue;
      }
      const status = String(row.status);
      if (attempts > 0 || status === "running") {
        queueUnsafe = true;
        crossedActiveQueueIds.add(queueId);
        if (activeItemIds.has(item.id)) queueAttempted.set(item.id, true);
      } else {
        safeActiveQueueIds.add(queueId);
      }
    }

    for (const item of activeItems) {
      if (!item.queueJobId) continue;
      const bound = await transaction.execute({
        sql: `SELECT job."id",job."targetType",job."target",job."listingKey",
                     job."requestedFields",job."status",job."source",job."runId",
                     job."approvalId",job."attempts",scope."sku" AS "scopeSku"
              FROM "EnrichmentJob" job
              LEFT JOIN "ProductTruthListingScope" scope ON scope."listingKey"=job."listingKey"
              WHERE job."id"=? LIMIT 1`,
        args: [item.queueJobId],
      });
      const row = bound.rows[0] as Record<string, unknown> | undefined;
      let identityMatches = false;
      try {
        identityMatches = Boolean(
          row
          && row.targetType === "sku"
          && row.target === row.scopeSku
          && row.listingKey === item.listingKey
          && row.runId === run.runId
          && row.approvalId === run.approvalId
          && row.source === "product-truth-operational-runner"
          && JSON.stringify(parseQueueRequestedFields(row.requestedFields))
            === JSON.stringify([...item.requestedFields].sort((left, right) => left.localeCompare(right, "en-US"))),
        );
      } catch {
        identityMatches = false;
      }
      if (!row || !identityMatches) {
        queueUnsafe = true;
        queueAttempted.set(item.id, true);
        queueAnomalies.push(`${item.id}:QUEUE_IDENTITY_MISMATCH`);
        continue;
      }
      const attempts = integer(row.attempts, "queue.attempts");
      const status = String(row.status);
      const safe = attempts === 0 && ["queued", "retry_wait", "cancelled"].includes(status);
      if (!safe) {
        queueUnsafe = true;
        queueAttempted.set(item.id, true);
        if (attempts > 0 || status === "running") crossedActiveQueueIds.add(item.queueJobId);
        else queueAnomalies.push(`${item.id}:QUEUE_STATE_${status}_${attempts}`);
      }
    }

    const safeCancellationResult = renderProductTruthOperationalJson({
      outcome: "INTERRUPTED",
      reason: "RUN_LEASE_EXPIRED_BEFORE_ATTEMPT",
    });
    const cancelledPreAttemptQueueJobIds: string[] = [];
    for (const queueJobId of safeActiveQueueIds) {
      const cancelled = await transaction.execute({
        sql: `UPDATE "EnrichmentJob"
              SET "status"='cancelled', "finishedAt"=?, "result"=?,
                  "error"='run lease expired before the authorized attempt',
                  "terminalReason"='PRE_ATTEMPT_ABORTED',
                  "completedFields"='[]', "unavailableFields"="requestedFields",
                  "actualSpendUnits"=0,
                  "leaseOwner"=NULL, "leaseToken"=NULL, "leaseExpiresAt"=NULL,
                  "heartbeatAt"=?, "nextEligibleAt"=NULL, "updatedAt"=?
              WHERE "id"=? AND "runId"=? AND "approvalId"=?
                AND "status" IN ('queued','retry_wait') AND "attempts"=0`,
        args: [
          at, safeCancellationResult, at, at, queueJobId, run.runId, run.approvalId,
        ],
      });
      if (cancelled.rowsAffected !== 1) {
        throw storeError(
          "OPERATIONAL_QUEUE_CAS_LOST",
          `safe pre-attempt queue ${queueJobId} changed during expiry recovery`,
        );
      }
      cancelledPreAttemptQueueJobIds.push(queueJobId);
    }

    const ambiguityResult = renderProductTruthOperationalJson({
      outcome: "AMBIGUOUS",
      reason: "RUN_LEASE_EXPIRED_AFTER_ATTEMPT",
    });
    for (const queueJobId of crossedActiveQueueIds) {
      const quarantined = await transaction.execute({
        sql: `UPDATE "EnrichmentJob"
              SET "status"='error', "finishedAt"=?, "result"=?,
                  "error"='run lease expired after the one authorized attempt',
                  "terminalReason"='METERED_ATTEMPT_OUTCOME_AMBIGUOUS',
                  "completedFields"=COALESCE("completedFields", '[]'),
                  "unavailableFields"=COALESCE("unavailableFields", '[]'),
                  "leaseOwner"=NULL, "leaseToken"=NULL, "leaseExpiresAt"=NULL,
                  "heartbeatAt"=?, "nextEligibleAt"=NULL, "updatedAt"=?
              WHERE "id"=? AND "runId"=? AND "approvalId"=?
                AND "status" IN ('queued','retry_wait','running')
                AND ("attempts">0 OR "status"='running')`,
        args: [at, ambiguityResult, at, at, queueJobId, run.runId, run.approvalId],
      });
      if (quarantined.rowsAffected !== 1) {
        queueAnomalies.push(`${queueJobId}:QUEUE_QUARANTINE_CAS_LOST`);
      }
    }

    const ambiguous = queueUnsafe || activeItems.some((item) => (
      item.attempts > 0
      || ["costing", "harvesting"].includes(item.status)
      || queueAttempted.get(item.id) === true
    ));
    for (const item of activeItems) {
      if (ambiguous || item.attempts > 0) {
        if (item.queueJobId) {
          const ambiguityResult = renderProductTruthOperationalJson({
            outcome: "AMBIGUOUS",
            reason: "RUN_LEASE_EXPIRED_AFTER_ATTEMPT",
          });
          const queueUpdate = await transaction.execute({
            sql: `UPDATE "EnrichmentJob"
                  SET "status"='error', "finishedAt"=?, "result"=?,
                      "error"='run lease expired after the one authorized attempt',
                      "terminalReason"='METERED_ATTEMPT_OUTCOME_AMBIGUOUS',
                      "completedFields"=COALESCE("completedFields", '[]'),
                      "unavailableFields"=COALESCE("unavailableFields", '[]'),
                      "leaseOwner"=NULL, "leaseToken"=NULL, "leaseExpiresAt"=NULL,
                      "heartbeatAt"=?, "nextEligibleAt"=NULL, "updatedAt"=?
                  WHERE "id"=? AND "targetType"='sku' AND "listingKey"=?
                    AND "runId"=? AND "approvalId"=?
                    AND "status"='running' AND "attempts"=1`,
            args: [
              at, ambiguityResult, at, at, item.queueJobId, item.listingKey,
              run.runId, run.approvalId,
            ],
          });
          if (queueUpdate.rowsAffected !== 1) {
            const queue = await transaction.execute({
              sql: `SELECT "status","attempts","runId","approvalId","listingKey"
                    FROM "EnrichmentJob" WHERE "id"=? LIMIT 1`,
              args: [item.queueJobId],
            });
            const row = queue.rows[0];
            if (
              !row
              || row.runId !== run.runId
              || row.approvalId !== run.approvalId
              || row.listingKey !== item.listingKey
              || integer(row.attempts, "queue.attempts") !== 1
              || !["done", "partial", "source_unavailable", "error", "cancelled"].includes(String(row.status))
            ) {
              queueAnomalies.push(`${item.id}:QUEUE_QUARANTINE_CAS_LOST`);
            }
          }
        }
        const update = await transaction.execute({
          sql: `UPDATE "ProductTruthOperationalRunItem"
                SET "status"='ambiguous', "stage"='LEASE_EXPIRED_AMBIGUOUS',
                    "leaseToken"=NULL, "leaseExpiresAt"=NULL,
                    "lastError"='lease expired after an execution attempt; automatic replay forbidden',
                    "finishedAt"=?, "updatedAt"=?
                WHERE "id"=? AND "status"=? AND "leaseToken" IS ?`,
          args: [at, at, item.id, item.status, item.leaseToken],
        });
        if (update.rowsAffected !== 1) {
          throw storeError("OPERATIONAL_ITEM_CAS_LOST", `could not quarantine expired item ${item.id}`);
        }
      } else {
        const update = await transaction.execute({
          sql: `UPDATE "ProductTruthOperationalRunItem"
                SET "queueJobId"=NULL, "status"='pending', "stage"='QUEUED',
                    "leaseToken"=NULL, "leaseExpiresAt"=NULL, "startedAt"=NULL,
                    "updatedAt"=?
                WHERE "id"=? AND "status"=? AND "attempts"=0 AND "leaseToken" IS ?`,
          args: [at, item.id, item.status, item.leaseToken],
        });
        if (update.rowsAffected !== 1) {
          throw storeError("OPERATIONAL_ITEM_CAS_LOST", `could not safely release expired item ${item.id}`);
        }
      }
    }
    const nextStatus = ambiguous ? "ambiguous" : "interrupted";
    const runUpdate = await transaction.execute({
      sql: `UPDATE "ProductTruthOperationalRun"
            SET "status"=?, "leaseOwner"=NULL, "leaseToken"=NULL,
                "leaseExpiresAt"=NULL, "heartbeatAt"=NULL,
                "finishedAt"=?, "updatedAt"=?
            WHERE "runId"=? AND "status"='running' AND "leaseToken"=?
              AND julianday("leaseExpiresAt")<=julianday(?)`,
      args: [nextStatus, ambiguous ? at : null, at, run.runId, run.leaseToken, at],
    });
    if (runUpdate.rowsAffected !== 1) {
      throw storeError("OPERATIONAL_RUN_CAS_LOST", "expired run lease changed during recovery");
    }
    await appendEvent(transaction, {
      runId: run.runId,
      eventType: ambiguous ? "RUN_LEASE_EXPIRED_AMBIGUOUS" : "RUN_LEASE_EXPIRED_SAFE",
      payload: {
        activeItems: activeItems.map((item) => ({
          id: item.id,
          status: item.status,
          attempts: item.attempts,
          queueAttempted: queueAttempted.get(item.id) ?? false,
        })),
        cancelledPreAttemptQueueJobIds,
        queueAnomalies,
      },
      at,
    });
    const stored = await selectRun(transaction, run.runId);
    if (!stored) throw storeError("OPERATIONAL_RUN_MISSING", "reaped run disappeared");
    verifyEventChain(stored, await selectEvents(transaction, run.runId));
    await transaction.commit();
    return { status: ambiguous ? "ambiguous" : "interrupted", run: stored };
  } catch (error) {
    await transaction.rollback();
    if (error instanceof ProductTruthOperationalStoreError) throw error;
    throw storeError("OPERATIONAL_RUN_REAP_FAILED", "could not recover expired run lease", error);
  } finally {
    transaction.close();
  }
}

/**
 * Release an expired executor that owns the environment, regardless of runId.
 * This is a non-spending recovery primitive and therefore does not require the
 * expired run's approval to remain valid. The run-level reaper retains the sole
 * authority to decide safe interruption versus terminal ambiguity.
 */
export async function reapExpiredProductTruthOperationalEnvironmentRun(
  db: Client,
  input: { environment: ProductTruthOperationalEnvironment; at: string },
): Promise<{
  status: "none" | "not_expired" | "interrupted" | "ambiguous";
  run: StoredProductTruthOperationalRun | null;
}> {
  await assertProductTruthOperationalRunSchema(db);
  if (input.environment !== "production" && input.environment !== "local-test") {
    throw storeError(
      "OPERATIONAL_ENVIRONMENT_INVALID",
      "environment must be production or local-test",
    );
  }
  const at = canonicalInstant(input.at, "at");
  const running = await db.execute({
    sql: `SELECT "runId" FROM "ProductTruthOperationalRun"
          WHERE "environment"=? AND "status"='running'
          ORDER BY "runId"`,
    args: [input.environment],
  });
  if (running.rows.length > 1) {
    throw storeError(
      PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR,
      "more than one operational run owns the environment",
    );
  }
  if (!running.rows[0]) return { status: "none", run: null };
  const runId = exactText(running.rows[0].runId, "runId");
  return reapExpiredProductTruthOperationalRun(db, { runId, at });
}

export async function productTruthOperationalRunSummary(
  db: Client,
  runId: string,
): Promise<{
  run: StoredProductTruthOperationalRun;
  items: StoredProductTruthOperationalRunItem[];
  counts: Record<string, number>;
}> {
  const run = await getProductTruthOperationalRun(db, runId);
  if (!run) throw storeError("OPERATIONAL_RUN_MISSING", `unknown run ${runId}`);
  const items = await listProductTruthOperationalRunItems(db, runId);
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return { run, items, counts };
}
