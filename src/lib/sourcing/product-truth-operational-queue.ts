import { randomUUID } from "node:crypto";

import type { Client } from "@libsql/client";

import {
  enqueueEnrichment,
  normalizeEnrichmentFields,
  type EnrichmentField,
} from "./enrichment-queue";
import type { ProductTruthOperationalTarget } from "./product-truth-operational-run-contract";

const ACTIVE_STATUSES = new Set(["queued", "running", "retry_wait"]);
const TERMINAL_STATUSES = new Set(["done", "partial", "source_unavailable", "error", "cancelled"]);

export interface ProductTruthOperationalQueueJob {
  id: string;
  listingKey: string;
  target: string;
  status: string;
  runId: string;
  approvalId: string;
  requestedFields: EnrichmentField[];
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  estimatedSpendUnits: number;
  actualSpendUnits: number;
  result: string | null;
  checkpoint: string | null;
  terminalReason: string | null;
}

export class ProductTruthOperationalQueueError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthOperationalQueueError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthOperationalQueueError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function exactText(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum) {
    fail("OPERATIONAL_QUEUE_INPUT_INVALID", `${label} must be exact non-empty text`);
  }
  return value;
}

function canonicalInstant(value: string | Date, label: string): string {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) fail("OPERATIONAL_QUEUE_INPUT_INVALID", `${label} is invalid`);
  return new Date(timestamp).toISOString();
}

function safeNumber(value: unknown, label: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) {
    fail("OPERATIONAL_QUEUE_SCHEMA_INVALID", `${label} must be non-negative`);
  }
  return number;
}

function safeInteger(value: unknown, label: string): number {
  const number = safeNumber(value, label);
  if (!Number.isSafeInteger(number)) fail("OPERATIONAL_QUEUE_SCHEMA_INVALID", `${label} must be an integer`);
  return number;
}

function nullableText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") fail("OPERATIONAL_QUEUE_SCHEMA_INVALID", "expected nullable text");
  return value;
}

function parseFields(value: unknown): EnrichmentField[] {
  if (typeof value !== "string") fail("OPERATIONAL_QUEUE_SCHEMA_INVALID", "requestedFields must be JSON text");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    fail("OPERATIONAL_QUEUE_SCHEMA_INVALID", "requestedFields is invalid JSON", error);
  }
  if (!Array.isArray(parsed) || parsed.some((field) => typeof field !== "string")) {
    fail("OPERATIONAL_QUEUE_SCHEMA_INVALID", "requestedFields must be a string array");
  }
  return parsed as EnrichmentField[];
}

function parseJob(row: Record<string, unknown>): ProductTruthOperationalQueueJob {
  const listingKey = exactText(row.listingKey, "queue.listingKey");
  const runId = exactText(row.runId, "queue.runId");
  const approvalId = exactText(row.approvalId, "queue.approvalId");
  return {
    id: exactText(row.id, "queue.id"),
    listingKey,
    target: exactText(row.target, "queue.target"),
    status: exactText(row.status, "queue.status"),
    runId,
    approvalId,
    requestedFields: parseFields(row.requestedFields),
    attempts: safeInteger(row.attempts, "queue.attempts"),
    leaseToken: nullableText(row.leaseToken),
    leaseExpiresAt: row.leaseExpiresAt == null
      ? null
      : canonicalInstant(String(row.leaseExpiresAt), "queue.leaseExpiresAt"),
    estimatedSpendUnits: safeNumber(row.estimatedSpendUnits, "queue.estimatedSpendUnits"),
    actualSpendUnits: safeNumber(row.actualSpendUnits, "queue.actualSpendUnits"),
    result: nullableText(row.result),
    checkpoint: nullableText(row.checkpoint),
    terminalReason: nullableText(row.terminalReason),
  };
}

const SELECT = [
  "id", "listingKey", "target", "status", "runId", "approvalId",
  "requestedFields", "attempts", "leaseToken", "leaseExpiresAt",
  "estimatedSpendUnits", "actualSpendUnits", "result", "checkpoint",
  "terminalReason",
].map((column) => `"${column}"`).join(", ");

export async function getProductTruthOperationalQueueJob(
  db: Client,
  id: string,
): Promise<ProductTruthOperationalQueueJob | null> {
  const result = await db.execute({
    sql: `SELECT ${SELECT} FROM "EnrichmentJob" WHERE "id"=? LIMIT 1`,
    args: [exactText(id, "queueJobId")],
  });
  return result.rows[0] ? parseJob(result.rows[0] as Record<string, unknown>) : null;
}

function assertJobIdentity(
  job: ProductTruthOperationalQueueJob,
  input: {
    target: ProductTruthOperationalTarget;
    runId: string;
    approvalId: string;
  },
): void {
  if (
    job.listingKey !== input.target.listingKey
    || job.target !== input.target.sku
    || job.runId !== input.runId
    || job.approvalId !== input.approvalId
    || JSON.stringify(job.requestedFields)
      !== JSON.stringify(normalizeEnrichmentFields([...input.target.requestedFields]))
  ) {
    fail(
      "OPERATIONAL_QUEUE_SCOPE_CONFLICT",
      `active queue job ${job.id} does not belong to the exact approved listing intent`,
    );
  }
}

/** Create or recover the one active queue row belonging to this sealed item. */
export async function ensureProductTruthOperationalQueueJob(
  db: Client,
  input: {
    target: ProductTruthOperationalTarget;
    runId: string;
    approvalId: string;
    estimatedSpendUnits: number;
    existingQueueJobId?: string | null;
  },
): Promise<ProductTruthOperationalQueueJob> {
  const runId = exactText(input.runId, "runId", 120);
  const approvalId = exactText(input.approvalId, "approvalId", 120);
  if (input.existingQueueJobId) {
    const existing = await getProductTruthOperationalQueueJob(db, input.existingQueueJobId);
    if (!existing) fail("OPERATIONAL_QUEUE_JOB_MISSING", "bound queue job does not exist");
    assertJobIdentity(existing, { target: input.target, runId, approvalId });
    return existing;
  }

  const enqueued = await enqueueEnrichment(db, {
    targetType: "sku",
    target: input.target.sku,
    channel: input.target.channel,
    storeIndex: input.target.storeIndex,
    requestedFields: [...input.target.requestedFields],
    source: "product-truth-operational-runner",
    priority: input.target.ordinal === 0 ? 100 : 50,
    requestedBy: "owner-approved-plan",
    runId,
    approvalId,
    estimatedSpendUnits: input.estimatedSpendUnits,
  });
  const job = await getProductTruthOperationalQueueJob(db, enqueued.id);
  if (!job) fail("OPERATIONAL_QUEUE_JOB_MISSING", "enqueue did not produce a queue row");
  assertJobIdentity(job, { target: input.target, runId, approvalId });
  if (!ACTIVE_STATUSES.has(job.status)) {
    fail("OPERATIONAL_QUEUE_STATE_INVALID", `newly resolved queue job is ${job.status}`);
  }
  return job;
}

export async function claimProductTruthOperationalQueueJob(
  db: Client,
  input: {
    job: ProductTruthOperationalQueueJob;
    leaseOwner: string;
    leaseToken?: string;
    at: string;
    leaseExpiresAt: string;
  },
): Promise<ProductTruthOperationalQueueJob> {
  if (input.job.status === "running") {
    fail("OPERATIONAL_QUEUE_ALREADY_RUNNING", "queue job already crossed the attempt boundary");
  }
  if (input.job.status !== "queued" && input.job.status !== "retry_wait") {
    fail("OPERATIONAL_QUEUE_STATE_INVALID", `cannot claim queue job from ${input.job.status}`);
  }
  if (input.job.attempts !== 0) {
    fail("OPERATIONAL_QUEUE_ATTEMPT_EXHAUSTED", "v1 queue job permits one attempt only");
  }
  const at = canonicalInstant(input.at, "at");
  const leaseExpiresAt = canonicalInstant(input.leaseExpiresAt, "leaseExpiresAt");
  if (Date.parse(leaseExpiresAt) <= Date.parse(at)) {
    fail("OPERATIONAL_QUEUE_INPUT_INVALID", "queue lease must expire in the future");
  }
  const leaseToken = exactText(input.leaseToken ?? randomUUID(), "leaseToken", 200);
  const updated = await db.execute({
    sql: `UPDATE "EnrichmentJob"
          SET "status"='running', "attempts"=1,
              "startedAt"=COALESCE("startedAt",?), "heartbeatAt"=?,
              "leaseOwner"=?, "leaseToken"=?, "leaseExpiresAt"=?, "updatedAt"=?
          WHERE "id"=? AND "status" IN ('queued','retry_wait') AND "attempts"=0
            AND "runId"=? AND "approvalId"=? AND "listingKey"=?
          RETURNING ${SELECT}`,
    args: [
      at,
      at,
      exactText(input.leaseOwner, "leaseOwner", 200),
      leaseToken,
      leaseExpiresAt,
      at,
      input.job.id,
      input.job.runId,
      input.job.approvalId,
      input.job.listingKey,
    ],
  });
  if (!updated.rows[0]) fail("OPERATIONAL_QUEUE_CAS_LOST", `could not claim ${input.job.id}`);
  return parseJob(updated.rows[0] as Record<string, unknown>);
}

export async function heartbeatProductTruthOperationalQueueJob(
  db: Client,
  input: {
    jobId: string;
    leaseToken: string;
    at: string;
    leaseExpiresAt: string;
  },
): Promise<ProductTruthOperationalQueueJob> {
  const at = canonicalInstant(input.at, "at");
  const leaseExpiresAt = canonicalInstant(input.leaseExpiresAt, "leaseExpiresAt");
  if (Date.parse(leaseExpiresAt) <= Date.parse(at)) {
    fail("OPERATIONAL_QUEUE_INPUT_INVALID", "queue lease must expire in the future");
  }
  const result = await db.execute({
    sql: `UPDATE "EnrichmentJob"
          SET "heartbeatAt"=?, "leaseExpiresAt"=?, "updatedAt"=?
          WHERE "id"=? AND "status"='running' AND "leaseToken"=?
          RETURNING ${SELECT}`,
    args: [at, leaseExpiresAt, at, input.jobId, input.leaseToken],
  });
  if (!result.rows[0]) fail("OPERATIONAL_QUEUE_CAS_LOST", "queue heartbeat lost its lease");
  return parseJob(result.rows[0] as Record<string, unknown>);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export async function finishProductTruthOperationalQueueJob(
  db: Client,
  input: {
    job: ProductTruthOperationalQueueJob;
    leaseToken: string;
    status: "done" | "partial" | "source_unavailable" | "error";
    at: string;
    completedFields: readonly EnrichmentField[];
    unavailableFields: readonly EnrichmentField[];
    actualSpendUnits: number;
    result: unknown;
    checkpoint: unknown;
    terminalReason: string | null;
    error?: string | null;
  },
): Promise<ProductTruthOperationalQueueJob> {
  if (input.job.status !== "running" || input.job.attempts !== 1) {
    fail("OPERATIONAL_QUEUE_STATE_INVALID", "only the one claimed attempt can finish");
  }
  if (!TERMINAL_STATUSES.has(input.status)) {
    fail("OPERATIONAL_QUEUE_INPUT_INVALID", `unsupported terminal status ${input.status}`);
  }
  const at = canonicalInstant(input.at, "at");
  const actualSpendUnits = safeNumber(input.actualSpendUnits, "actualSpendUnits");
  const result = await db.execute({
    sql: `UPDATE "EnrichmentJob"
          SET "status"=?, "finishedAt"=?, "result"=?, "error"=?,
              "terminalReason"=?, "completedFields"=?, "unavailableFields"=?,
              "checkpoint"=?, "actualSpendUnits"=?,
              "leaseOwner"=NULL, "leaseToken"=NULL, "leaseExpiresAt"=NULL,
              "heartbeatAt"=?, "nextEligibleAt"=NULL, "updatedAt"=?
          WHERE "id"=? AND "status"='running' AND "attempts"=1 AND "leaseToken"=?
          RETURNING ${SELECT}`,
    args: [
      input.status,
      at,
      json(input.result),
      input.error == null ? null : String(input.error).slice(0, 2_000),
      input.terminalReason,
      json(input.completedFields),
      json(input.unavailableFields),
      json(input.checkpoint),
      actualSpendUnits,
      at,
      at,
      input.job.id,
      exactText(input.leaseToken, "leaseToken", 200),
    ],
  });
  if (!result.rows[0]) fail("OPERATIONAL_QUEUE_CAS_LOST", `could not finish ${input.job.id}`);
  return parseJob(result.rows[0] as Record<string, unknown>);
}

/** Expired attempted queue work is terminally ambiguous and is never replayed. */
export async function reapExpiredProductTruthOperationalQueueJobs(
  db: Client,
  input: { runId: string; approvalId: string; at: string },
): Promise<number> {
  const at = canonicalInstant(input.at, "at");
  const result = await db.execute({
    sql: `UPDATE "EnrichmentJob"
          SET "status"='error', "finishedAt"=?,
              "error"='lease expired after the one authorized attempt',
              "terminalReason"='METERED_ATTEMPT_OUTCOME_AMBIGUOUS',
              "leaseOwner"=NULL, "leaseToken"=NULL, "leaseExpiresAt"=NULL,
              "heartbeatAt"=?, "nextEligibleAt"=NULL, "updatedAt"=?
          WHERE "status"='running' AND "attempts">0
            AND "leaseExpiresAt" IS NOT NULL
            AND julianday("leaseExpiresAt")<=julianday(?)
            AND "runId"=? AND "approvalId"=?`,
    args: [
      at,
      at,
      at,
      at,
      exactText(input.runId, "runId", 120),
      exactText(input.approvalId, "approvalId", 120),
    ],
  });
  return result.rowsAffected;
}
