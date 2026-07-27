/**
 * Durable, distributed budget reservations for metered Product Truth calls.
 *
 * Safety order for a reservation:
 *   1. verify the complete migration contract;
 *   2. seed or exactly validate one immutable run/provider budget;
 *   3. append a pending idempotency receipt;
 *   4. atomically increment counters with cap predicates;
 *   5. persist receipt status `reserved`;
 *   6. only then return `networkAuthorized: true`.
 *
 * Counter increment and receipt finalization are intentionally separate. If
 * the receipt write fails, the caller receives an error and must not perform
 * network I/O; the reserved capacity remains consumed conservatively.
 */

import type { Client } from "@libsql/client";

import type { MeteredProvider, MeteredRunPermit } from "./metered-call-guard";
import {
  MeteredBudgetContractError,
  meteredMicrosToUnits,
  meteredSettlementId,
  prepareMeteredProviderBudget,
  prepareMeteredReservation,
  type CanonicalMeteredProviderBudget,
  type CanonicalMeteredReservation,
} from "./metered-budget-contract";

export const METERED_BUDGET_LEDGER_CONTRACT_ERROR = "METERED_BUDGET_LEDGER_MIGRATION_REQUIRED";

const BUDGET_COLUMNS = [
  "id", "permitVersion", "runId", "approvalId", "approvedBy", "provider",
  "issuedAt", "expiresAt", "operations", "maxCalls", "maxUnitsMicros",
  "reservedCalls", "reservedUnitsMicros", "createdAt", "updatedAt",
] as const;

const RECEIPT_COLUMNS = [
  "id", "budgetId", "reservationKey", "operation", "unitsMicros", "status",
  "failureCode", "createdAt", "reservedAt", "settledAt", "updatedAt",
] as const;

const SETTLEMENT_COLUMNS = [
  "id", "reservationId", "outcome", "detail", "settledAt",
] as const;

const REQUIRED_UNIQUE_INDEXES = [
  ["MeteredProviderBudget", "MeteredProviderBudget_run_provider_key"],
  ["MeteredReservationReceipt", "MeteredReservationReceipt_budget_key"],
  ["MeteredReservationSettlement", "MeteredReservationSettlement_reservation_key"],
] as const;

const REQUIRED_TRIGGERS = [
  "MeteredProviderBudget_initial_counters_guard",
  "MeteredProviderBudget_duplicate_insert_guard",
  "MeteredProviderBudget_contract_immutable",
  "MeteredProviderBudget_counter_monotonic",
  "MeteredProviderBudget_delete_guard",
  "MeteredReservationReceipt_initial_state_guard",
  "MeteredReservationReceipt_operation_guard",
  "MeteredReservationReceipt_duplicate_insert_guard",
  "MeteredReservationReceipt_identity_immutable",
  "MeteredReservationReceipt_status_transition",
  "MeteredReservationReceipt_reservation_coverage_guard",
  "MeteredReservationReceipt_terminal_settlement_guard",
  "MeteredReservationReceipt_lifecycle_metadata_guard",
  "MeteredReservationReceipt_delete_guard",
  "MeteredReservationSettlement_duplicate_insert_guard",
  "MeteredReservationSettlement_apply",
  "MeteredReservationSettlement_immutable",
  "MeteredReservationSettlement_delete_guard",
] as const;

const BUDGET_SELECT = BUDGET_COLUMNS.map((column) => `"${column}"`).join(", ");
const RECEIPT_SELECT = RECEIPT_COLUMNS.map((column) => `"${column}"`).join(", ");
const SETTLEMENT_SELECT = SETTLEMENT_COLUMNS.map((column) => `"${column}"`).join(", ");

export type MeteredReservationStatus = "pending" | "reserved" | "succeeded" | "failed" | "rejected";
export type MeteredSettlementOutcome = "success" | "failure";

export type StoredMeteredProviderBudget = CanonicalMeteredProviderBudget & {
  reservedCalls: number;
  reservedUnitsMicros: number;
  reservedUnits: number;
  createdAt: string;
  updatedAt: string;
};

export type StoredMeteredReservationReceipt = {
  id: string;
  budgetId: string;
  reservationKey: string;
  operation: string;
  unitsMicros: number;
  units: number;
  status: MeteredReservationStatus;
  failureCode: string | null;
  createdAt: string;
  reservedAt: string | null;
  settledAt: string | null;
  updatedAt: string;
};

export type StoredMeteredReservationSettlement = {
  id: string;
  reservationId: string;
  outcome: MeteredSettlementOutcome;
  detail: string | null;
  settledAt: string;
};

export type MeteredBudgetPermitInput = {
  permit: MeteredRunPermit;
  confirmation: string;
  provider: MeteredProvider;
};

export type ReserveMeteredBudgetInput = MeteredBudgetPermitInput & {
  operation: string;
  units?: number;
  reservationKey: string;
};

export type SettleMeteredBudgetInput = ReserveMeteredBudgetInput & {
  outcome: MeteredSettlementOutcome;
  detail?: string | null;
};

export type MeteredBudgetReservationResult = {
  /** True exactly once, after both cap reservation and receipt persistence. */
  networkAuthorized: boolean;
  /** Existing idempotency receipt; it never grants another network call. */
  replay: boolean;
  budget: StoredMeteredProviderBudget;
  receipt: StoredMeteredReservationReceipt;
};

export type MeteredBudgetSettlementResult = {
  replay: boolean;
  receipt: StoredMeteredReservationReceipt;
  settlement: StoredMeteredReservationSettlement;
};

export class MeteredBudgetLedgerContractError extends Error {
  readonly code = METERED_BUDGET_LEDGER_CONTRACT_ERROR;

  constructor(message: string, options?: ErrorOptions) {
    super(`${METERED_BUDGET_LEDGER_CONTRACT_ERROR}: ${message}`, options);
    this.name = "MeteredBudgetLedgerContractError";
  }
}

export class MeteredBudgetSeedConflictError extends Error {
  readonly code = "METERED_BUDGET_PERMIT_CONFLICT";

  constructor(message: string) {
    super(`METERED_BUDGET_PERMIT_CONFLICT: ${message}`);
    this.name = "MeteredBudgetSeedConflictError";
  }
}

export type MeteredBudgetExceededCode =
  | "BUDGET_EXPIRED"
  | "CALL_BUDGET_EXHAUSTED"
  | "UNIT_BUDGET_EXHAUSTED"
  | "BUDGET_RESERVATION_CONFLICT";

export class MeteredBudgetExceededError extends Error {
  readonly code: MeteredBudgetExceededCode;

  constructor(code: MeteredBudgetExceededCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "MeteredBudgetExceededError";
    this.code = code;
  }
}

export class MeteredBudgetIdempotencyConflictError extends Error {
  readonly code = "METERED_RESERVATION_KEY_CONFLICT";

  constructor(message: string) {
    super(`METERED_RESERVATION_KEY_CONFLICT: ${message}`);
    this.name = "MeteredBudgetIdempotencyConflictError";
  }
}

export class MeteredBudgetReceiptWriteError extends Error {
  readonly code = "METERED_RECEIPT_WRITE_FAILED";

  constructor(message: string, options?: ErrorOptions) {
    super(`METERED_RECEIPT_WRITE_FAILED: ${message}`, options);
    this.name = "MeteredBudgetReceiptWriteError";
  }
}

export class MeteredBudgetSettlementError extends Error {
  readonly code:
    | "METERED_RESERVATION_NOT_FOUND"
    | "METERED_RESERVATION_NOT_RESERVED"
    | "METERED_SETTLEMENT_CONFLICT"
    | "METERED_SETTLEMENT_WRITE_FAILED";

  constructor(code: MeteredBudgetSettlementError["code"], message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "MeteredBudgetSettlementError";
    this.code = code;
  }
}

function migrationError(message: string, cause?: unknown): MeteredBudgetLedgerContractError {
  return new MeteredBudgetLedgerContractError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function valueAt(row: Record<string, unknown>, key: string): unknown {
  if (!(key in row)) throw migrationError(`row is missing ${key}`);
  return row[key];
}

function textAt(row: Record<string, unknown>, key: string): string {
  const value = valueAt(row, key);
  if (typeof value !== "string" || !value) throw migrationError(`${key} must be non-empty text`);
  return value;
}

function nullableTextAt(row: Record<string, unknown>, key: string): string | null {
  const value = valueAt(row, key);
  if (value === null) return null;
  if (typeof value !== "string") throw migrationError(`${key} must be text or null`);
  return value;
}

function integerAt(row: Record<string, unknown>, key: string): number {
  const value = valueAt(row, key);
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw migrationError(`${key} must be a safe integer`);
  }
  return number;
}

function nullableIntegerAt(row: Record<string, unknown>, key: string): number | null {
  if (valueAt(row, key) === null) return null;
  return integerAt(row, key);
}

function isoAt(row: Record<string, unknown>, key: string): string {
  const value = valueAt(row, key);
  if (typeof value !== "string" && typeof value !== "number") {
    throw migrationError(`${key} must be a timestamp`);
  }
  const milliseconds = Date.parse(String(value));
  if (!Number.isFinite(milliseconds)) throw migrationError(`${key} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function nullableIsoAt(row: Record<string, unknown>, key: string): string | null {
  return valueAt(row, key) === null ? null : isoAt(row, key);
}

function canonicalAt(value: string | number | Date | undefined): string {
  const milliseconds = value instanceof Date
    ? value.getTime()
    : value === undefined
      ? Date.now()
      : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new TypeError("at must be a valid timestamp");
  return new Date(milliseconds).toISOString();
}

function parseOperations(encoded: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    throw migrationError("operations must contain valid JSON", error);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((value) => typeof value !== "string")) {
    throw migrationError("operations must contain a non-empty JSON string array");
  }
  return parsed;
}

export function parseMeteredProviderBudgetRow(row: Record<string, unknown>): StoredMeteredProviderBudget {
  const provider = textAt(row, "provider") as MeteredProvider;
  const permitVersion = integerAt(row, "permitVersion");
  const approvedBy = textAt(row, "approvedBy");
  if (permitVersion !== 1 || approvedBy !== "owner") {
    throw migrationError("budget row is not an owner-approved v1 contract");
  }
  const operationsJson = textAt(row, "operations");
  const reservedUnitsMicros = integerAt(row, "reservedUnitsMicros");
  return {
    id: textAt(row, "id"),
    permitVersion: 1,
    runId: textAt(row, "runId"),
    approvalId: textAt(row, "approvalId"),
    approvedBy: "owner",
    provider,
    issuedAt: isoAt(row, "issuedAt"),
    expiresAt: isoAt(row, "expiresAt"),
    operations: parseOperations(operationsJson),
    operationsJson,
    maxCalls: integerAt(row, "maxCalls"),
    maxUnitsMicros: nullableIntegerAt(row, "maxUnitsMicros"),
    reservedCalls: integerAt(row, "reservedCalls"),
    reservedUnitsMicros,
    reservedUnits: meteredMicrosToUnits(reservedUnitsMicros),
    createdAt: isoAt(row, "createdAt"),
    updatedAt: isoAt(row, "updatedAt"),
  };
}

export function parseMeteredReservationReceiptRow(
  row: Record<string, unknown>,
): StoredMeteredReservationReceipt {
  const status = textAt(row, "status");
  if (!["pending", "reserved", "succeeded", "failed", "rejected"].includes(status)) {
    throw migrationError(`unknown receipt status ${status}`);
  }
  const unitsMicros = integerAt(row, "unitsMicros");
  return {
    id: textAt(row, "id"),
    budgetId: textAt(row, "budgetId"),
    reservationKey: textAt(row, "reservationKey"),
    operation: textAt(row, "operation"),
    unitsMicros,
    units: meteredMicrosToUnits(unitsMicros),
    status: status as MeteredReservationStatus,
    failureCode: nullableTextAt(row, "failureCode"),
    createdAt: isoAt(row, "createdAt"),
    reservedAt: nullableIsoAt(row, "reservedAt"),
    settledAt: nullableIsoAt(row, "settledAt"),
    updatedAt: isoAt(row, "updatedAt"),
  };
}

export function parseMeteredReservationSettlementRow(
  row: Record<string, unknown>,
): StoredMeteredReservationSettlement {
  const outcome = textAt(row, "outcome");
  if (outcome !== "success" && outcome !== "failure") {
    throw migrationError(`unknown settlement outcome ${outcome}`);
  }
  return {
    id: textAt(row, "id"),
    reservationId: textAt(row, "reservationId"),
    outcome,
    detail: nullableTextAt(row, "detail"),
    settledAt: isoAt(row, "settledAt"),
  };
}

/** Verify every table, required column, unique key and safety trigger. */
export async function assertMeteredBudgetLedgerReady(db: Client): Promise<void> {
  try {
    for (const [table, columns] of [
      ["MeteredProviderBudget", BUDGET_COLUMNS],
      ["MeteredReservationReceipt", RECEIPT_COLUMNS],
      ["MeteredReservationSettlement", SETTLEMENT_COLUMNS],
    ] as const) {
      const info = await db.execute(`PRAGMA table_info("${table}")`);
      const present = new Set(info.rows.map((row) => String(row.name)));
      const missing = columns.filter((column) => !present.has(column));
      if (missing.length > 0) throw migrationError(`missing ${table} columns: ${missing.join(", ")}`);
    }

    for (const [table, index] of REQUIRED_UNIQUE_INDEXES) {
      const info = await db.execute(`PRAGMA index_list("${table}")`);
      const found = info.rows.some((row) => String(row.name) === index && Number(row.unique) === 1);
      if (!found) throw migrationError(`missing unique index ${index}`);
    }

    const triggerRows = await db.execute({
      sql: `SELECT name FROM sqlite_schema
            WHERE type='trigger' AND name IN (${REQUIRED_TRIGGERS.map(() => "?").join(", ")})`,
      args: [...REQUIRED_TRIGGERS],
    });
    const triggers = new Set(triggerRows.rows.map((row) => String(row.name)));
    const missingTriggers = REQUIRED_TRIGGERS.filter((trigger) => !triggers.has(trigger));
    if (missingTriggers.length > 0) {
      throw migrationError(`missing ledger guards: ${missingTriggers.join(", ")}`);
    }
  } catch (error) {
    if (error instanceof MeteredBudgetLedgerContractError) throw error;
    throw migrationError("cannot verify metered budget ledger migration", error);
  }
}

function assertBudgetMatches(
  stored: StoredMeteredProviderBudget,
  expected: CanonicalMeteredProviderBudget,
): void {
  const mismatches: string[] = [];
  for (const key of [
    "id", "permitVersion", "runId", "approvalId", "approvedBy", "provider",
    "issuedAt", "expiresAt", "operationsJson", "maxCalls", "maxUnitsMicros",
  ] as const) {
    if (stored[key] !== expected[key]) mismatches.push(key);
  }
  if (mismatches.length > 0) {
    throw new MeteredBudgetSeedConflictError(
      `persisted ${expected.runId}:${expected.provider} budget differs in ${mismatches.join(", ")}`,
    );
  }
}

async function findBudget(
  db: Client,
  expected: CanonicalMeteredProviderBudget,
): Promise<StoredMeteredProviderBudget | null> {
  const result = await db.execute({
    sql: `SELECT ${BUDGET_SELECT}
          FROM "MeteredProviderBudget"
          WHERE "id" = ? OR ("runId" = ? AND "provider" = ?)
          LIMIT 2`,
    args: [expected.id, expected.runId, expected.provider],
  });
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) {
    throw new MeteredBudgetSeedConflictError("budget identity resolves to more than one row");
  }
  return parseMeteredProviderBudgetRow(result.rows[0] as Record<string, unknown>);
}

async function seedCanonicalBudget(
  db: Client,
  expected: CanonicalMeteredProviderBudget,
  at: string,
): Promise<StoredMeteredProviderBudget> {
  await db.execute({
    sql: `INSERT OR IGNORE INTO "MeteredProviderBudget" (
            "id", "permitVersion", "runId", "approvalId", "approvedBy", "provider",
            "issuedAt", "expiresAt", "operations", "maxCalls", "maxUnitsMicros",
            "reservedCalls", "reservedUnitsMicros", "createdAt", "updatedAt"
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    args: [
      expected.id,
      expected.permitVersion,
      expected.runId,
      expected.approvalId,
      expected.approvedBy,
      expected.provider,
      expected.issuedAt,
      expected.expiresAt,
      expected.operationsJson,
      expected.maxCalls,
      expected.maxUnitsMicros,
      at,
      at,
    ],
  });
  const stored = await findBudget(db, expected);
  if (!stored) throw new MeteredBudgetSeedConflictError("budget insert did not produce a readable row");
  assertBudgetMatches(stored, expected);
  return stored;
}

/** Seed once, or validate every immutable permit field against the existing row. */
export async function ensureMeteredProviderBudget(
  db: Client,
  input: MeteredBudgetPermitInput,
): Promise<StoredMeteredProviderBudget> {
  await assertMeteredBudgetLedgerReady(db);
  const at = canonicalAt(undefined);
  const expected = prepareMeteredProviderBudget({ ...input, at, requireCurrent: true });
  return seedCanonicalBudget(db, expected, at);
}

export async function getMeteredProviderBudget(
  db: Client,
  runId: string,
  provider: MeteredProvider,
): Promise<StoredMeteredProviderBudget | null> {
  await assertMeteredBudgetLedgerReady(db);
  const result = await db.execute({
    sql: `SELECT ${BUDGET_SELECT} FROM "MeteredProviderBudget"
          WHERE "runId" = ? AND "provider" = ?`,
    args: [runId, provider],
  });
  return result.rows.length === 0
    ? null
    : parseMeteredProviderBudgetRow(result.rows[0] as Record<string, unknown>);
}

async function getReceiptByIntent(
  db: Client,
  intent: CanonicalMeteredReservation,
): Promise<StoredMeteredReservationReceipt | null> {
  const result = await db.execute({
    sql: `SELECT ${RECEIPT_SELECT}
          FROM "MeteredReservationReceipt"
          WHERE "id" = ? OR ("budgetId" = ? AND "reservationKey" = ?)
          LIMIT 2`,
    args: [intent.id, intent.budgetId, intent.reservationKey],
  });
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) {
    throw new MeteredBudgetIdempotencyConflictError("reservation identity resolves to more than one row");
  }
  return parseMeteredReservationReceiptRow(result.rows[0] as Record<string, unknown>);
}

function assertReceiptMatches(
  receipt: StoredMeteredReservationReceipt,
  intent: CanonicalMeteredReservation,
): void {
  if (
    receipt.id !== intent.id
    || receipt.budgetId !== intent.budgetId
    || receipt.reservationKey !== intent.reservationKey
    || receipt.operation !== intent.operation
    || receipt.unitsMicros !== intent.unitsMicros
  ) {
    throw new MeteredBudgetIdempotencyConflictError(
      `${intent.reservationKey} was already used with a different provider operation or unit amount`,
    );
  }
}

async function markReceiptRejected(
  db: Client,
  receiptId: string,
  code: MeteredBudgetExceededCode,
  at: string,
): Promise<void> {
  try {
    await db.execute({
      sql: `UPDATE "MeteredReservationReceipt"
            SET "status" = 'rejected', "failureCode" = ?,
                "settledAt" = ?, "updatedAt" = ?
            WHERE "id" = ? AND "status" = 'pending'`,
      args: [code, at, at, receiptId],
    });
  } catch {
    // Reservation was not granted; a pending audit row is still fail-closed.
  }
}

function exceededReason(
  budget: StoredMeteredProviderBudget,
  intent: CanonicalMeteredReservation,
): MeteredBudgetExceededError {
  if (Date.parse(budget.expiresAt) <= Date.parse(intent.requestedAt)) {
    return new MeteredBudgetExceededError("BUDGET_EXPIRED", "persisted permit has expired");
  }
  if (budget.reservedCalls + 1 > budget.maxCalls) {
    return new MeteredBudgetExceededError(
      "CALL_BUDGET_EXHAUSTED",
      `${budget.provider} call cap ${budget.maxCalls} is exhausted`,
    );
  }
  if (
    budget.maxUnitsMicros !== null
    && budget.reservedUnitsMicros + intent.unitsMicros > budget.maxUnitsMicros
  ) {
    return new MeteredBudgetExceededError(
      "UNIT_BUDGET_EXHAUSTED",
      `${budget.provider} unit cap ${meteredMicrosToUnits(budget.maxUnitsMicros)} is exhausted`,
    );
  }
  return new MeteredBudgetExceededError(
    "BUDGET_RESERVATION_CONFLICT",
    "conditional budget update did not win; no provider call is authorized",
  );
}

/**
 * Reserve one distributed call. `networkAuthorized` is true only for the
 * invocation that both consumed cap and persisted the final reserved receipt.
 */
export async function reserveMeteredProviderBudget(
  db: Client,
  input: ReserveMeteredBudgetInput,
): Promise<MeteredBudgetReservationResult> {
  await assertMeteredBudgetLedgerReady(db);
  const { budget: expected, reservation: intent } = prepareMeteredReservation({
    ...input,
    at: canonicalAt(undefined),
    requireCurrent: true,
  });
  let budget = await seedCanonicalBudget(db, expected, intent.requestedAt);

  let inserted;
  try {
    inserted = await db.execute({
      sql: `INSERT OR IGNORE INTO "MeteredReservationReceipt" (
              "id", "budgetId", "reservationKey", "operation", "unitsMicros",
              "status", "failureCode", "createdAt", "reservedAt", "settledAt", "updatedAt"
            ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL, ?)`,
      args: [
        intent.id,
        intent.budgetId,
        intent.reservationKey,
        intent.operation,
        intent.unitsMicros,
        intent.requestedAt,
        intent.requestedAt,
      ],
    });
  } catch (error) {
    throw new MeteredBudgetReceiptWriteError("could not append pending reservation receipt", { cause: error });
  }

  if (inserted.rowsAffected !== 1) {
    const existing = await getReceiptByIntent(db, intent);
    if (!existing) {
      throw new MeteredBudgetReceiptWriteError("idempotency insert was ignored without a readable receipt");
    }
    assertReceiptMatches(existing, intent);
    return { networkAuthorized: false, replay: true, budget, receipt: existing };
  }

  const reserved = await db.execute({
    sql: `UPDATE "MeteredProviderBudget"
          SET "reservedCalls" = "reservedCalls" + 1,
              "reservedUnitsMicros" = "reservedUnitsMicros" + ?,
              "updatedAt" = ?
          WHERE "id" = ?
            AND "permitVersion" = ?
            AND "runId" = ?
            AND "approvalId" = ?
            AND "approvedBy" = ?
            AND "provider" = ?
            AND "issuedAt" = ?
            AND "expiresAt" = ?
            AND "operations" = ?
            AND "maxCalls" = ?
            AND "maxUnitsMicros" IS ?
            AND "expiresAt" > ?
            AND julianday("issuedAt") <= julianday('now')
            AND julianday("expiresAt") > julianday('now')
            AND "reservedCalls" + 1 <= "maxCalls"
            AND (
              "maxUnitsMicros" IS NULL
              OR "reservedUnitsMicros" + ? <= "maxUnitsMicros"
            )`,
    args: [
      intent.unitsMicros,
      intent.requestedAt,
      expected.id,
      expected.permitVersion,
      expected.runId,
      expected.approvalId,
      expected.approvedBy,
      expected.provider,
      expected.issuedAt,
      expected.expiresAt,
      expected.operationsJson,
      expected.maxCalls,
      expected.maxUnitsMicros,
      intent.requestedAt,
      intent.unitsMicros,
    ],
  });

  if (reserved.rowsAffected !== 1) {
    const latest = await findBudget(db, expected);
    if (!latest) throw new MeteredBudgetSeedConflictError("budget disappeared during reservation");
    assertBudgetMatches(latest, expected);
    const error = exceededReason(latest, intent);
    await markReceiptRejected(db, intent.id, error.code, intent.requestedAt);
    throw error;
  }

  // Refresh after the atomic increment. Any later failure remains a deliberate
  // capacity loss and cannot result in network authorization.
  const latest = await findBudget(db, expected);
  if (!latest) throw new MeteredBudgetReceiptWriteError("reserved budget is no longer readable");
  budget = latest;

  let finalized;
  try {
    finalized = await db.execute({
      sql: `UPDATE "MeteredReservationReceipt"
            SET "status" = 'reserved', "reservedAt" = ?, "updatedAt" = ?
            WHERE "id" = ? AND "status" = 'pending'`,
      args: [intent.requestedAt, intent.requestedAt, intent.id],
    });
  } catch (error) {
    throw new MeteredBudgetReceiptWriteError(
      "budget was consumed but the reserved receipt could not be persisted; network is forbidden",
      { cause: error },
    );
  }
  if (finalized.rowsAffected !== 1) {
    throw new MeteredBudgetReceiptWriteError(
      "budget was consumed but receipt finalization lost its compare-and-set; network is forbidden",
    );
  }
  const receipt = await getReceiptByIntent(db, intent);
  if (!receipt || receipt.status !== "reserved") {
    throw new MeteredBudgetReceiptWriteError(
      "final reserved receipt is not readable; network is forbidden",
    );
  }
  return { networkAuthorized: true, replay: false, budget, receipt };
}

async function getSettlement(
  db: Client,
  reservationId: string,
): Promise<StoredMeteredReservationSettlement | null> {
  const result = await db.execute({
    sql: `SELECT ${SETTLEMENT_SELECT}
          FROM "MeteredReservationSettlement" WHERE "reservationId" = ?`,
    args: [reservationId],
  });
  return result.rows.length === 0
    ? null
    : parseMeteredReservationSettlementRow(result.rows[0] as Record<string, unknown>);
}

function canonicalSettlementDetail(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 2_048) {
    throw new MeteredBudgetSettlementError(
      "METERED_SETTLEMENT_CONFLICT",
      "detail must be 1-2048 trimmed characters when provided",
    );
  }
  return value;
}

/**
 * Append an idempotent success/failure settlement. Expiry is intentionally not
 * an obstacle here: settlement cannot authorize network I/O and must remain
 * recordable after an in-flight request crosses the permit expiry boundary.
 */
export async function settleMeteredProviderBudget(
  db: Client,
  input: SettleMeteredBudgetInput,
): Promise<MeteredBudgetSettlementResult> {
  await assertMeteredBudgetLedgerReady(db);
  if (input.outcome !== "success" && input.outcome !== "failure") {
    throw new MeteredBudgetSettlementError("METERED_SETTLEMENT_CONFLICT", "unknown settlement outcome");
  }
  const { budget: expected, reservation: intent } = prepareMeteredReservation({
    ...input,
    at: canonicalAt(undefined),
    requireCurrent: false,
  });
  const budget = await findBudget(db, expected);
  if (!budget) {
    throw new MeteredBudgetSettlementError("METERED_RESERVATION_NOT_FOUND", "provider budget was not seeded");
  }
  assertBudgetMatches(budget, expected);
  const receipt = await getReceiptByIntent(db, intent);
  if (!receipt) {
    throw new MeteredBudgetSettlementError("METERED_RESERVATION_NOT_FOUND", "reservation receipt does not exist");
  }
  assertReceiptMatches(receipt, intent);
  const detail = canonicalSettlementDetail(input.detail);

  const existingSettlement = await getSettlement(db, receipt.id);
  if (existingSettlement) {
    if (existingSettlement.outcome !== input.outcome || existingSettlement.detail !== detail) {
      throw new MeteredBudgetSettlementError(
        "METERED_SETTLEMENT_CONFLICT",
        "reservation already has a different terminal outcome",
      );
    }
    const terminalReceipt = await getReceiptByIntent(db, intent);
    if (!terminalReceipt) {
      throw new MeteredBudgetSettlementError("METERED_SETTLEMENT_WRITE_FAILED", "terminal receipt disappeared");
    }
    return { replay: true, receipt: terminalReceipt, settlement: existingSettlement };
  }

  if (receipt.status !== "reserved") {
    throw new MeteredBudgetSettlementError(
      "METERED_RESERVATION_NOT_RESERVED",
      `receipt is ${receipt.status}; only a reserved call can be settled`,
    );
  }

  const settlementId = meteredSettlementId(receipt.id);
  let inserted;
  try {
    inserted = await db.execute({
      sql: `INSERT OR IGNORE INTO "MeteredReservationSettlement" (
              "id", "reservationId", "outcome", "detail", "settledAt"
            ) VALUES (?, ?, ?, ?, ?)`,
      args: [settlementId, receipt.id, input.outcome, detail, intent.requestedAt],
    });
  } catch (error) {
    throw new MeteredBudgetSettlementError(
      "METERED_SETTLEMENT_WRITE_FAILED",
      "could not append settlement",
      { cause: error },
    );
  }

  const settlement = await getSettlement(db, receipt.id);
  if (!settlement) {
    throw new MeteredBudgetSettlementError(
      "METERED_SETTLEMENT_WRITE_FAILED",
      "settlement insert produced no readable audit row",
    );
  }
  if (settlement.outcome !== input.outcome || settlement.detail !== detail) {
    throw new MeteredBudgetSettlementError(
      "METERED_SETTLEMENT_CONFLICT",
      "a concurrent settlement recorded a different terminal outcome",
    );
  }
  const terminalReceipt = await getReceiptByIntent(db, intent);
  const expectedStatus = input.outcome === "success" ? "succeeded" : "failed";
  if (!terminalReceipt || terminalReceipt.status !== expectedStatus) {
    throw new MeteredBudgetSettlementError(
      "METERED_SETTLEMENT_WRITE_FAILED",
      "settlement did not atomically transition the receipt",
    );
  }
  return { replay: inserted.rowsAffected !== 1, receipt: terminalReceipt, settlement };
}

export { MeteredBudgetContractError };
