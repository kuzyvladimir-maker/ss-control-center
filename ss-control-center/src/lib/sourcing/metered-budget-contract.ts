/**
 * Pure contract for the durable Product Truth metered-budget ledger.
 *
 * The existing metered-call guard remains the environment/owner-approval
 * boundary. This contract turns the same MeteredRunPermit into canonical,
 * integer budget data that can be compared and reserved atomically in SQLite.
 * It performs no I/O and never authorizes a provider call by itself.
 */

import { createHash } from "node:crypto";

import {
  METERED_PROVIDERS,
  decodeMeteredRunPermit,
  encodeMeteredRunPermit,
  expectedMeteredRunConfirmation,
  type MeteredProvider,
  type MeteredRunPermit,
} from "./metered-call-guard";

export const METERED_BUDGET_UNIT_SCALE = 1_000_000;
export const METERED_BUDGET_MAX_PERMIT_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export type MeteredBudgetContractErrorCode =
  | "PERMIT_INVALID"
  | "PERMIT_NOT_CURRENT"
  | "PERMIT_TOO_LONG"
  | "CONFIRMATION_MISMATCH"
  | "PROVIDER_NOT_ALLOWED"
  | "OPERATION_NOT_ALLOWED"
  | "REQUEST_INVALID"
  | "UNIT_PRECISION_UNSUPPORTED";

export class MeteredBudgetContractError extends Error {
  readonly code: MeteredBudgetContractErrorCode;

  constructor(code: MeteredBudgetContractErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "MeteredBudgetContractError";
    this.code = code;
  }
}

export type CanonicalMeteredProviderBudget = {
  id: string;
  permitVersion: 1;
  runId: string;
  approvalId: string;
  approvedBy: "owner";
  provider: MeteredProvider;
  issuedAt: string;
  expiresAt: string;
  operations: string[];
  operationsJson: string;
  maxCalls: number;
  maxUnitsMicros: number | null;
};

export type CanonicalMeteredReservation = {
  id: string;
  budgetId: string;
  reservationKey: string;
  operation: string;
  unitsMicros: number;
  requestedAt: string;
};

export type PrepareMeteredProviderBudgetInput = {
  permit: MeteredRunPermit;
  confirmation: string;
  provider: MeteredProvider;
  at?: string | number | Date;
  /**
   * Only reservation is an authorization boundary and therefore requires a
   * currently valid permit. Settlement may be recorded after expiry because it
   * cannot authorize another network request.
   */
  requireCurrent?: boolean;
};

export type PrepareMeteredReservationInput = PrepareMeteredProviderBudgetInput & {
  operation: string;
  units?: number;
  reservationKey: string;
};

function fail(code: MeteredBudgetContractErrorCode, message: string): never {
  throw new MeteredBudgetContractError(code, message);
}

function canonicalInstant(value: string | number | Date | undefined, label: string): string {
  const milliseconds = value instanceof Date
    ? value.getTime()
    : value === undefined
      ? Date.now()
      : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) fail("REQUEST_INVALID", `${label} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function exactNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    fail("PERMIT_INVALID", `${label} must be non-empty text without surrounding whitespace`);
  }
  return value;
}

function canonicalOperations(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("PERMIT_INVALID", "provider operations must be a non-empty array");
  }
  const operations = value.map((operation, index) => exactNonEmpty(operation, `operations[${index}]`));
  if (new Set(operations).size !== operations.length) {
    fail("PERMIT_INVALID", "provider operations must not contain duplicates");
  }
  return [...operations].sort((left, right) => left.localeCompare(right, "en-US"));
}

/** Convert a positive unit value to exact integer micro-units. */
export function meteredUnitsToMicros(value: number, label = "units"): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail("REQUEST_INVALID", `${label} must be a positive finite number`);
  }
  const scaled = value * METERED_BUDGET_UNIT_SCALE;
  const micros = Math.round(scaled);
  if (!Number.isSafeInteger(micros)) {
    fail("REQUEST_INVALID", `${label} is outside the supported safe range`);
  }
  if (micros <= 0) {
    fail("UNIT_PRECISION_UNSUPPORTED", `${label} supports at most six decimal places`);
  }
  const roundTrip = micros / METERED_BUDGET_UNIT_SCALE;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(value)) * 4;
  if (Math.abs(roundTrip - value) > tolerance) {
    fail("UNIT_PRECISION_UNSUPPORTED", `${label} supports at most six decimal places`);
  }
  return micros;
}

export function meteredMicrosToUnits(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("metered unit micros must be a non-negative safe integer");
  }
  return value / METERED_BUDGET_UNIT_SCALE;
}

export function meteredBudgetId(runId: string, provider: MeteredProvider): string {
  return `mb_${createHash("sha256")
    .update(`metered-budget/v1\n${runId}\n${provider}`)
    .digest("hex")}`;
}

export function meteredReservationId(budgetId: string, reservationKey: string): string {
  return `mbr_${createHash("sha256")
    .update(`metered-reservation/v1\n${budgetId}\n${reservationKey}`)
    .digest("hex")}`;
}

export function meteredSettlementId(reservationId: string): string {
  return `mbs_${createHash("sha256")
    .update(`metered-settlement/v1\n${reservationId}`)
    .digest("hex")}`;
}

/**
 * Validate the complete v1 permit, exact owner confirmation and one provider
 * allowance, then return a canonical comparison record for persistence.
 */
export function prepareMeteredProviderBudget(
  input: PrepareMeteredProviderBudgetInput,
): CanonicalMeteredProviderBudget {
  const decoded = decodeMeteredRunPermit(encodeMeteredRunPermit(input.permit));
  if (!decoded) fail("PERMIT_INVALID", "metered run permit violates the v1 guard contract");
  if (decoded.version !== 1 || decoded.approvedBy !== "owner") {
    fail("PERMIT_INVALID", "only owner-approved v1 permits are accepted");
  }
  const runId = exactNonEmpty(decoded.runId, "runId");
  const approvalId = exactNonEmpty(decoded.approvalId, "approvalId");
  if (input.confirmation !== expectedMeteredRunConfirmation(decoded)) {
    fail("CONFIRMATION_MISMATCH", "explicit confirmation does not match runId and approvalId");
  }
  if (!(METERED_PROVIDERS as readonly string[]).includes(input.provider)) {
    fail("PROVIDER_NOT_ALLOWED", `${String(input.provider)} is not a known metered provider`);
  }

  const issuedAt = canonicalInstant(decoded.issuedAt, "issuedAt");
  const expiresAt = canonicalInstant(decoded.expiresAt, "expiresAt");
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (expiresAtMs <= issuedAtMs) {
    fail("PERMIT_INVALID", "expiresAt must be later than issuedAt");
  }
  if (expiresAtMs - issuedAtMs > METERED_BUDGET_MAX_PERMIT_LIFETIME_MS) {
    fail("PERMIT_TOO_LONG", "metered run permit lifetime exceeds 24 hours");
  }
  if (input.requireCurrent !== false) {
    const atMs = Date.parse(canonicalInstant(input.at, "at"));
    if (issuedAtMs > atMs || expiresAtMs <= atMs) {
      fail("PERMIT_NOT_CURRENT", "metered run permit is not currently valid");
    }
  }

  const allowance = decoded.providers[input.provider];
  if (!allowance) {
    fail("PROVIDER_NOT_ALLOWED", `${input.provider} is not allowed by this run permit`);
  }
  const operations = canonicalOperations(allowance.operations);
  if (!Number.isSafeInteger(allowance.maxCalls) || allowance.maxCalls <= 0) {
    fail("PERMIT_INVALID", "maxCalls must be a positive safe integer");
  }
  const maxUnitsMicros = allowance.maxUnits === undefined
    ? null
    : meteredUnitsToMicros(allowance.maxUnits, "maxUnits");

  return {
    id: meteredBudgetId(runId, input.provider),
    permitVersion: 1,
    runId,
    approvalId,
    approvedBy: "owner",
    provider: input.provider,
    issuedAt,
    expiresAt,
    operations,
    operationsJson: JSON.stringify(operations),
    maxCalls: allowance.maxCalls,
    maxUnitsMicros,
  };
}

/** Prepare an exact, deterministic reservation without touching storage. */
export function prepareMeteredReservation(
  input: PrepareMeteredReservationInput,
): { budget: CanonicalMeteredProviderBudget; reservation: CanonicalMeteredReservation } {
  const budget = prepareMeteredProviderBudget(input);
  const operation = typeof input.operation === "string" ? input.operation : "";
  if (!operation || operation !== operation.trim()) {
    fail("REQUEST_INVALID", "operation must be non-empty text without surrounding whitespace");
  }
  if (!budget.operations.includes(operation)) {
    fail("OPERATION_NOT_ALLOWED", `${budget.provider}:${operation} is not allowed by this run permit`);
  }
  const reservationKey = typeof input.reservationKey === "string" ? input.reservationKey : "";
  if (!reservationKey || reservationKey !== reservationKey.trim() || reservationKey.length > 512) {
    fail("REQUEST_INVALID", "reservationKey must be 1-512 characters without surrounding whitespace");
  }
  const unitsMicros = meteredUnitsToMicros(input.units ?? 1);
  const requestedAt = canonicalInstant(input.at, "at");
  return {
    budget,
    reservation: {
      id: meteredReservationId(budget.id, reservationKey),
      budgetId: budget.id,
      reservationKey,
      operation,
      unitsMicros,
      requestedAt,
    },
  };
}
