/**
 * Durable persistence for the pure donor-harvest lifecycle.
 *
 * This module deliberately has no compatibility path. If the complete
 * DonorHarvestState migration is absent, every database operation fails closed;
 * it never reconstructs work by scanning legacy DonorProduct rows.
 */

import { createHash } from "node:crypto";

import type { Client } from "@libsql/client";

import {
  assertDonorHarvestState,
  canClaimDonorHarvest,
  createDonorHarvestState,
  donorHarvestIdentityKey,
  normalizeDonorHarvestFields,
  transitionDonorHarvest,
  type CreateDonorHarvestStateInput,
  type DonorHarvestEvent,
  type DonorHarvestIdentity,
  type DonorHarvestMeteredBoundary,
  type DonorHarvestState,
  type DonorHarvestStatus,
} from "./donor-harvest-lifecycle";

export const DONOR_HARVEST_STORE_CONTRACT_ERROR = "DONOR_HARVEST_MIGRATION_REQUIRED";

const REQUIRED_COLUMNS = [
  "id",
  "donorProductId",
  "source",
  "retailerProductId",
  "status",
  "requestedFields",
  "completedFields",
  "unavailableFields",
  "attempts",
  "maxAttempts",
  "nextEligibleAt",
  "terminalReason",
  "lastError",
  "lastBlockReason",
  "runId",
  "approvalId",
  "leaseOwner",
  "leaseToken",
  "leaseExpiresAt",
  "claimedAt",
  "sourceAttemptStartedAt",
  "finishedAt",
  "version",
  "createdAt",
  "updatedAt",
] as const;

const REQUIRED_TRIGGERS = [
  "DonorHarvestState_complete_insert_guard",
  "DonorHarvestState_complete_update_guard",
] as const;

const SELECT_COLUMNS = REQUIRED_COLUMNS.map((column) => `"${column}"`).join(", ");

export type StoredDonorHarvestState = DonorHarvestState & { id: string };

export interface SerializedDonorHarvestState {
  donorProductId: string;
  source: string;
  retailerProductId: string;
  status: DonorHarvestStatus;
  requestedFields: string;
  completedFields: string;
  unavailableFields: string;
  attempts: number;
  maxAttempts: number;
  nextEligibleAt: string | null;
  terminalReason: string | null;
  lastError: string | null;
  lastBlockReason: string | null;
  runId: string | null;
  approvalId: string | null;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  claimedAt: string | null;
  sourceAttemptStartedAt: string | null;
  finishedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export class DonorHarvestStoreContractError extends Error {
  readonly code = DONOR_HARVEST_STORE_CONTRACT_ERROR;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DonorHarvestStoreContractError";
  }
}

export class DonorHarvestSeedConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DonorHarvestSeedConflictError";
  }
}

function contractError(detail: string, cause?: unknown): DonorHarvestStoreContractError {
  return new DonorHarvestStoreContractError(
    `${DONOR_HARVEST_STORE_CONTRACT_ERROR}: ${detail}`,
    cause === undefined ? undefined : { cause },
  );
}

function valueAt(row: Record<string, unknown>, key: string): unknown {
  if (!(key in row)) throw contractError(`DonorHarvestState row is missing ${key}`);
  return row[key];
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = valueAt(row, key);
  if (typeof value !== "string" || !value.trim()) {
    throw contractError(`DonorHarvestState.${key} must be non-empty text`);
  }
  return value.trim();
}

function nullableString(row: Record<string, unknown>, key: string): string | null {
  const value = valueAt(row, key);
  if (value === null) return null;
  if (typeof value !== "string") {
    throw contractError(`DonorHarvestState.${key} must be text or null`);
  }
  return value;
}

function safeInteger(row: Record<string, unknown>, key: string): number {
  const value = valueAt(row, key);
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw contractError(`DonorHarvestState.${key} must be a safe integer`);
  }
  return number;
}

function canonicalIso(value: unknown, label: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw contractError(`${label} must be a timestamp`);
  }
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) throw contractError(`${label} must be a valid timestamp`);
  return new Date(timestamp).toISOString();
}

function requiredIso(row: Record<string, unknown>, key: string): string {
  return canonicalIso(valueAt(row, key), `DonorHarvestState.${key}`);
}

function nullableIso(row: Record<string, unknown>, key: string): string | null {
  const value = valueAt(row, key);
  return value === null ? null : canonicalIso(value, `DonorHarvestState.${key}`);
}

function jsonStringArray(row: Record<string, unknown>, key: string): string[] {
  const encoded = requiredString(row, key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    throw contractError(`DonorHarvestState.${key} must contain valid JSON`, error);
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw contractError(`DonorHarvestState.${key} must contain a JSON string array`);
  }
  return parsed;
}

function normalizeIdentity(identity: DonorHarvestIdentity): DonorHarvestIdentity {
  const donorProductId = identity.donorProductId.trim();
  const source = identity.source.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  const retailerProductId = identity.retailerProductId.trim();
  if (!donorProductId || !source || !retailerProductId) {
    throw new DonorHarvestSeedConflictError("donorProductId, source and retailerProductId are required");
  }
  return { donorProductId, source, retailerProductId };
}

function normalizeTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} must be a valid timestamp`);
  return new Date(timestamp).toISOString();
}

/** A stable persistence id for one canonical donor/source/retailer-item identity. */
export function donorHarvestStateId(identity: DonorHarvestIdentity): string {
  return `dhs_${createHash("sha256")
    .update(`donor-harvest-state/v1\n${donorHarvestIdentityKey(identity)}`)
    .digest("hex")}`;
}

/**
 * Verifies the full migration contract, including the unique identity index and
 * complete-state guards. No result is cached so a process cannot mistake an
 * initially absent or partially applied migration for a usable store.
 */
export async function assertDonorHarvestStoreReady(db: Client): Promise<void> {
  try {
    const tableInfo = await db.execute(`PRAGMA table_info("DonorHarvestState")`);
    const columns = new Set(tableInfo.rows.map((row) => String(row.name)));
    const missingColumns = REQUIRED_COLUMNS.filter((column) => !columns.has(column));
    if (missingColumns.length > 0) {
      throw contractError(`missing DonorHarvestState columns: ${missingColumns.join(", ")}`);
    }

    const indexInfo = await db.execute(`PRAGMA index_list("DonorHarvestState")`);
    const hasUniqueIdentity = indexInfo.rows.some((row) => (
      String(row.name) === "DonorHarvestState_identity_key" && Number(row.unique) === 1
    ));
    if (!hasUniqueIdentity) {
      throw contractError("missing unique DonorHarvestState identity index");
    }

    const triggers = await db.execute({
      sql: `SELECT name FROM sqlite_schema
            WHERE type='trigger' AND tbl_name='DonorHarvestState'`,
      args: [],
    });
    const triggerNames = new Set(triggers.rows.map((row) => String(row.name)));
    const missingTriggers = REQUIRED_TRIGGERS.filter((trigger) => !triggerNames.has(trigger));
    if (missingTriggers.length > 0) {
      throw contractError(`missing DonorHarvestState guards: ${missingTriggers.join(", ")}`);
    }
  } catch (error) {
    if (error instanceof DonorHarvestStoreContractError) throw error;
    throw contractError("cannot verify DonorHarvestState migration", error);
  }
}

export function serializeDonorHarvestState(state: DonorHarvestState): SerializedDonorHarvestState {
  assertDonorHarvestState(state);
  return {
    donorProductId: state.donorProductId,
    source: state.source,
    retailerProductId: state.retailerProductId,
    status: state.status,
    requestedFields: JSON.stringify(state.requestedFields),
    completedFields: JSON.stringify(state.completedFields),
    unavailableFields: JSON.stringify(state.unavailableFields),
    attempts: state.attempts,
    maxAttempts: state.maxAttempts,
    nextEligibleAt: state.nextEligibleAt,
    terminalReason: state.terminalReason,
    lastError: state.lastError,
    lastBlockReason: state.lastBlockReason,
    runId: state.runId,
    approvalId: state.approvalId,
    leaseOwner: state.leaseOwner,
    leaseToken: state.leaseToken,
    leaseExpiresAt: state.leaseExpiresAt,
    claimedAt: state.claimedAt,
    sourceAttemptStartedAt: state.sourceAttemptStartedAt,
    finishedAt: state.finishedAt,
    version: state.version,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

export function parseDonorHarvestStateRow(row: Record<string, unknown>): StoredDonorHarvestState {
  const state: DonorHarvestState = {
    donorProductId: requiredString(row, "donorProductId"),
    source: requiredString(row, "source"),
    retailerProductId: requiredString(row, "retailerProductId"),
    status: requiredString(row, "status") as DonorHarvestStatus,
    requestedFields: jsonStringArray(row, "requestedFields"),
    completedFields: jsonStringArray(row, "completedFields"),
    unavailableFields: jsonStringArray(row, "unavailableFields"),
    attempts: safeInteger(row, "attempts"),
    maxAttempts: safeInteger(row, "maxAttempts"),
    nextEligibleAt: nullableIso(row, "nextEligibleAt"),
    terminalReason: nullableString(row, "terminalReason"),
    lastError: nullableString(row, "lastError"),
    lastBlockReason: nullableString(row, "lastBlockReason"),
    runId: nullableString(row, "runId"),
    approvalId: nullableString(row, "approvalId"),
    leaseOwner: nullableString(row, "leaseOwner"),
    leaseToken: nullableString(row, "leaseToken"),
    leaseExpiresAt: nullableIso(row, "leaseExpiresAt"),
    claimedAt: nullableIso(row, "claimedAt"),
    sourceAttemptStartedAt: nullableIso(row, "sourceAttemptStartedAt"),
    finishedAt: nullableIso(row, "finishedAt"),
    version: safeInteger(row, "version"),
    createdAt: requiredIso(row, "createdAt"),
    updatedAt: requiredIso(row, "updatedAt"),
  };
  try {
    assertDonorHarvestState(state);
  } catch (error) {
    throw contractError("persisted DonorHarvestState violates the lifecycle contract", error);
  }
  return { id: requiredString(row, "id"), ...state };
}

async function selectByIdentity(
  db: Client,
  identity: DonorHarvestIdentity,
): Promise<StoredDonorHarvestState | null> {
  const normalized = normalizeIdentity(identity);
  const result = await db.execute({
    sql: `SELECT ${SELECT_COLUMNS} FROM "DonorHarvestState"
          WHERE "donorProductId"=? AND "source"=? AND "retailerProductId"=?
          LIMIT 1`,
    args: [normalized.donorProductId, normalized.source, normalized.retailerProductId],
  });
  return result.rows[0]
    ? parseDonorHarvestStateRow(result.rows[0] as Record<string, unknown>)
    : null;
}

export async function getDonorHarvestState(
  db: Client,
  id: string,
): Promise<StoredDonorHarvestState | null> {
  await assertDonorHarvestStoreReady(db);
  const normalizedId = id.trim();
  if (!normalizedId) throw new TypeError("id is required");
  const result = await db.execute({
    sql: `SELECT ${SELECT_COLUMNS} FROM "DonorHarvestState" WHERE "id"=? LIMIT 1`,
    args: [normalizedId],
  });
  return result.rows[0]
    ? parseDonorHarvestStateRow(result.rows[0] as Record<string, unknown>)
    : null;
}

export interface SeedDonorHarvestResult {
  created: boolean;
  state: StoredDonorHarvestState;
}

/**
 * Idempotently seeds one identity. An existing identity is never reset or
 * reopened. A changed requested-field intent fails explicitly instead of
 * silently discarding new work or mutating a terminal lifecycle.
 */
export async function seedDonorHarvestState(
  db: Client,
  input: CreateDonorHarvestStateInput,
): Promise<SeedDonorHarvestResult> {
  await assertDonorHarvestStoreReady(db);
  const state = createDonorHarvestState(input);
  const id = donorHarvestStateId(state);
  const serialized = serializeDonorHarvestState(state);
  const inserted = await db.execute({
    sql: `INSERT INTO "DonorHarvestState" (
            "id", "donorProductId", "source", "retailerProductId", "status",
            "requestedFields", "completedFields", "unavailableFields",
            "attempts", "maxAttempts", "nextEligibleAt", "terminalReason",
            "lastError", "lastBlockReason", "runId", "approvalId",
            "leaseOwner", "leaseToken", "leaseExpiresAt", "claimedAt",
            "sourceAttemptStartedAt", "finishedAt", "version", "createdAt", "updatedAt"
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT("donorProductId", "source", "retailerProductId") DO NOTHING`,
    args: [
      id,
      serialized.donorProductId,
      serialized.source,
      serialized.retailerProductId,
      serialized.status,
      serialized.requestedFields,
      serialized.completedFields,
      serialized.unavailableFields,
      serialized.attempts,
      serialized.maxAttempts,
      serialized.nextEligibleAt,
      serialized.terminalReason,
      serialized.lastError,
      serialized.lastBlockReason,
      serialized.runId,
      serialized.approvalId,
      serialized.leaseOwner,
      serialized.leaseToken,
      serialized.leaseExpiresAt,
      serialized.claimedAt,
      serialized.sourceAttemptStartedAt,
      serialized.finishedAt,
      serialized.version,
      serialized.createdAt,
      serialized.updatedAt,
    ],
  });

  const stored = await selectByIdentity(db, state);
  if (!stored) throw contractError("seed/upsert did not produce an identity row");
  if (
    stored.requestedFields.join("\u0000") !== state.requestedFields.join("\u0000")
    || stored.maxAttempts !== state.maxAttempts
  ) {
    throw new DonorHarvestSeedConflictError(
      `Existing harvest identity ${donorHarvestIdentityKey(state)} has a different field intent or attempt cap`,
    );
  }
  return { created: inserted.rowsAffected === 1, state: stored };
}

export interface ListClaimableDonorHarvestOptions {
  now: string;
  limit?: number;
  source?: string;
}

export async function listClaimableDonorHarvestStates(
  db: Client,
  options: ListClaimableDonorHarvestOptions,
): Promise<StoredDonorHarvestState[]> {
  await assertDonorHarvestStoreReady(db);
  const now = normalizeTimestamp(options.now, "now");
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("limit must be an integer between 1 and 1000");
  }
  const source = options.source == null
    ? null
    : normalizeIdentity({ donorProductId: "_", source: options.source, retailerProductId: "_" }).source;
  const sourceClause = source === null ? "" : `AND "source"=?`;
  const args: Array<string | number> = [now];
  if (source !== null) args.push(source);
  args.push(limit);
  const result = await db.execute({
    sql: `SELECT ${SELECT_COLUMNS} FROM "DonorHarvestState"
          WHERE "status" IN ('pending','retry_wait','partial')
            AND "attempts" < "maxAttempts"
            AND ("nextEligibleAt" IS NULL OR julianday("nextEligibleAt") <= julianday(?))
            ${sourceClause}
          ORDER BY COALESCE("nextEligibleAt", "createdAt") ASC, "createdAt" ASC, "id" ASC
          LIMIT ?`,
    args,
  });
  const states = result.rows.map((row) => (
    parseDonorHarvestStateRow(row as Record<string, unknown>)
  ));
  for (const state of states) {
    if (!canClaimDonorHarvest(state, now)) {
      throw contractError(`claimable query returned non-claimable state ${state.id}`);
    }
  }
  return states;
}

type ClaimEvent = Extract<DonorHarvestEvent, { type: "claim" }>;

function updateArgs(state: DonorHarvestState): Array<string | number | null> {
  const serialized = serializeDonorHarvestState(state);
  return [
    serialized.status,
    serialized.requestedFields,
    serialized.completedFields,
    serialized.unavailableFields,
    serialized.attempts,
    serialized.maxAttempts,
    serialized.nextEligibleAt,
    serialized.terminalReason,
    serialized.lastError,
    serialized.lastBlockReason,
    serialized.runId,
    serialized.approvalId,
    serialized.leaseOwner,
    serialized.leaseToken,
    serialized.leaseExpiresAt,
    serialized.claimedAt,
    serialized.sourceAttemptStartedAt,
    serialized.finishedAt,
    serialized.version,
    serialized.updatedAt,
  ];
}

async function persistTransitionCas(
  db: Client,
  current: StoredDonorHarvestState,
  next: DonorHarvestState,
  event: DonorHarvestEvent,
): Promise<StoredDonorHarvestState | null> {
  const id = current.id.trim();
  if (!id) throw contractError("stored harvest id is empty");
  if (next.version !== current.version + 1) {
    throw contractError("a persisted transition must increment version exactly once");
  }
  const claimPredicate = event.type === "claim"
    ? `AND "status" IN ('pending','retry_wait','partial')
       AND "attempts" < "maxAttempts"
       AND ("nextEligibleAt" IS NULL OR julianday("nextEligibleAt") <= julianday(?))`
    : "";
  const runningLeasePredicate = event.type !== "claim" && current.status === "running"
    ? `AND "leaseToken"=?`
    : "";
  const args: Array<string | number | null> = [
    ...updateArgs(next),
    id,
    current.version,
    current.status,
    current.donorProductId,
    current.source,
    current.retailerProductId,
  ];
  if (event.type === "claim") args.push(next.claimedAt);
  if (event.type !== "claim" && current.status === "running") args.push(current.leaseToken);

  const updated = await db.execute({
    sql: `UPDATE "DonorHarvestState" SET
            "status"=?, "requestedFields"=?, "completedFields"=?, "unavailableFields"=?,
            "attempts"=?, "maxAttempts"=?, "nextEligibleAt"=?, "terminalReason"=?,
            "lastError"=?, "lastBlockReason"=?, "runId"=?, "approvalId"=?,
            "leaseOwner"=?, "leaseToken"=?, "leaseExpiresAt"=?, "claimedAt"=?,
            "sourceAttemptStartedAt"=?, "finishedAt"=?, "version"=?, "updatedAt"=?
          WHERE "id"=? AND "version"=? AND "status"=?
            AND "donorProductId"=? AND "source"=? AND "retailerProductId"=?
            ${claimPredicate}
            ${runningLeasePredicate}`,
    args,
  });
  return updated.rowsAffected === 1 ? { id, ...next } : null;
}

/**
 * Applies one pure lifecycle transition with an optimistic version CAS. A null
 * result is a normal lost-race signal; callers must not perform the network call.
 */
export async function persistDonorHarvestTransition(
  db: Client,
  current: StoredDonorHarvestState,
  event: DonorHarvestEvent,
): Promise<StoredDonorHarvestState | null> {
  await assertDonorHarvestStoreReady(db);
  const next = transitionDonorHarvest(current, event);
  return persistTransitionCas(db, current, next, event);
}

/** Atomic claim. Only a non-null winner may continue to budget reservation/network. */
export async function claimDonorHarvestState(
  db: Client,
  current: StoredDonorHarvestState,
  event: ClaimEvent,
): Promise<StoredDonorHarvestState | null> {
  return persistDonorHarvestTransition(db, current, event);
}

export interface ListExpiredDonorHarvestLeaseOptions {
  now: string;
  limit?: number;
}

/**
 * Lists only expired running leases. Selection itself never changes state; the
 * reaper below performs a lease-token/version CAS so a late worker completion
 * and a reaper cannot both win.
 */
export async function listExpiredDonorHarvestLeases(
  db: Client,
  options: ListExpiredDonorHarvestLeaseOptions,
): Promise<StoredDonorHarvestState[]> {
  await assertDonorHarvestStoreReady(db);
  const now = normalizeTimestamp(options.now, "now");
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("limit must be an integer between 1 and 1000");
  }
  const result = await db.execute({
    sql: `SELECT ${SELECT_COLUMNS} FROM "DonorHarvestState"
          WHERE "status"='running'
            AND "leaseExpiresAt" IS NOT NULL
            AND julianday("leaseExpiresAt") <= julianday(?)
          ORDER BY "leaseExpiresAt" ASC, "id" ASC
          LIMIT ?`,
    args: [now, limit],
  });
  const states = result.rows.map((row) => (
    parseDonorHarvestStateRow(row as Record<string, unknown>)
  ));
  for (const state of states) {
    if (!state.leaseExpiresAt || Date.parse(state.leaseExpiresAt) > Date.parse(now)) {
      throw contractError(`expired-lease query returned an active lease ${state.id}`);
    }
  }
  return states;
}

export interface ReapExpiredDonorHarvestLeaseOptions
  extends ListExpiredDonorHarvestLeaseOptions {
  /** Delay used only for a lease proven to have expired before reservation. */
  retryDelayMs?: number;
  /**
   * Must inspect the durable paid-call ledger. Omitting it fails closed as
   * observed_or_unknown; a generic caller can never accidentally authorize a
   * replay merely because the in-row attempt marker is absent.
   */
  meteredBoundaryFor?: (
    state: StoredDonorHarvestState,
  ) => DonorHarvestMeteredBoundary | Promise<DonorHarvestMeteredBoundary>;
}

export interface ReapExpiredDonorHarvestLeaseResult {
  scanned: number;
  requeuedPreReservation: number;
  terminalAmbiguous: number;
  lostRaces: number;
  states: StoredDonorHarvestState[];
}

function boundedError(error: unknown): string {
  const raw = String(error instanceof Error ? error.message : error).trim()
    || "Unknown metered-boundary probe failure";
  return raw
    .replace(/([?&](?:api_key|key|token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

/**
 * Crash-safe expired-lease recovery. A row is requeued only when the caller's
 * durable-ledger probe positively proves that no paid reservation exists. Any
 * marker, receipt, missing probe, or probe failure terminalizes the row for
 * reconciliation instead of silently repeating a possibly charged request.
 */
export async function reapExpiredDonorHarvestLeases(
  db: Client,
  options: ReapExpiredDonorHarvestLeaseOptions,
): Promise<ReapExpiredDonorHarvestLeaseResult> {
  const now = normalizeTimestamp(options.now, "now");
  const retryDelayMs = options.retryDelayMs ?? 6 * 60 * 60_000;
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1) {
    throw new RangeError("retryDelayMs must be a positive integer");
  }
  const expired = await listExpiredDonorHarvestLeases(db, options);
  const result: ReapExpiredDonorHarvestLeaseResult = {
    scanned: expired.length,
    requeuedPreReservation: 0,
    terminalAmbiguous: 0,
    lostRaces: 0,
    states: [],
  };

  for (const current of expired) {
    let meteredBoundary: DonorHarvestMeteredBoundary = "observed_or_unknown";
    let probeError: string | null = null;
    if (!current.sourceAttemptStartedAt && options.meteredBoundaryFor) {
      try {
        meteredBoundary = await options.meteredBoundaryFor(current);
        if (meteredBoundary !== "not_observed" && meteredBoundary !== "observed_or_unknown") {
          throw new TypeError(`unknown metered boundary decision: ${String(meteredBoundary)}`);
        }
      } catch (error) {
        meteredBoundary = "observed_or_unknown";
        probeError = boundedError(error);
      }
    }

    const safeToRetry = !current.sourceAttemptStartedAt && meteredBoundary === "not_observed";
    const saved = await persistDonorHarvestTransition(db, current, {
      type: "lease_expired",
      at: now,
      meteredBoundary,
      nextEligibleAt: safeToRetry
        ? new Date(Date.parse(now) + retryDelayMs).toISOString()
        : null,
      error: safeToRetry
        ? "Worker lease expired before durable metered reservation"
        : probeError
          ? `Metered boundary could not be disproved: ${probeError}`
          : "Worker lease expired after a metered reservation or at an ambiguous boundary",
    });
    if (!saved) {
      result.lostRaces++;
      continue;
    }
    result.states.push(saved);
    if (saved.status === "retry_wait") result.requeuedPreReservation++;
    else if (
      saved.status === "error"
      && saved.terminalReason === "METERED_ATTEMPT_OUTCOME_AMBIGUOUS"
    ) result.terminalAmbiguous++;
    else throw contractError(`lease reaper produced unexpected status ${saved.status}`);
  }
  return result;
}

export interface DonorProductHarvestSnapshot {
  title?: unknown;
  description?: unknown;
  bullets?: unknown;
  attributes?: unknown;
  nutritionFacts?: unknown;
  ingredients?: unknown;
  mainImageUrl?: unknown;
  imageUrls?: unknown;
  upc?: unknown;
  gtin?: unknown;
}

function nonEmptyText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (!value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function nonEmptyArray(value: unknown): boolean {
  const parsed = parsedJson(value);
  return Array.isArray(parsed) && parsed.length > 0;
}

function nonEmptyObject(value: unknown): boolean {
  const parsed = parsedJson(value);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    && Object.keys(parsed as Record<string, unknown>).length > 0;
}

/**
 * Conservative, network-free bootstrap helper. Unknown fields remain incomplete,
 * and a lone main image never counts as a full gallery.
 */
export function completedHarvestFieldsFromDonorProduct(
  donor: DonorProductHarvestSnapshot,
  requestedFields: readonly string[],
  options: { minGalleryImages?: number } = {},
): string[] {
  const minGalleryImages = options.minGalleryImages ?? 5;
  if (!Number.isSafeInteger(minGalleryImages) || minGalleryImages < 1) {
    throw new RangeError("minGalleryImages must be a positive integer");
  }
  const gallery = parsedJson(donor.imageUrls);
  const hasGallery = Array.isArray(gallery)
    && gallery.filter((value) => nonEmptyText(value)).length >= minGalleryImages;
  const checks: Record<string, () => boolean> = {
    title: () => nonEmptyText(donor.title),
    description: () => nonEmptyText(donor.description),
    bullets: () => nonEmptyArray(donor.bullets),
    attributes: () => nonEmptyObject(donor.attributes),
    ingredients: () => nonEmptyText(donor.ingredients),
    nutrition: () => nonEmptyText(donor.nutritionFacts),
    nutritionfacts: () => nonEmptyText(donor.nutritionFacts),
    "nutrition_facts": () => nonEmptyText(donor.nutritionFacts),
    gallery: () => hasGallery,
    images: () => hasGallery,
    imageurls: () => hasGallery,
    "main_image": () => nonEmptyText(donor.mainImageUrl),
    mainimageurl: () => nonEmptyText(donor.mainImageUrl),
    upc: () => nonEmptyText(donor.upc),
    gtin: () => nonEmptyText(donor.gtin),
  };
  return normalizeDonorHarvestFields(requestedFields).filter((field) => checks[field]?.() === true);
}
