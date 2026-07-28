/**
 * One authorization boundary for every paid Product Truth provider request.
 *
 * The synchronous permit guard is intentionally kept as the first fence. A
 * valid permit then has to reserve capacity in the distributed libSQL ledger
 * before `networkCall` can run. The deterministic request fingerprint is the
 * idempotency boundary: a replay may read its receipt, but can never authorize
 * another provider request.
 */

import { createHash } from "node:crypto";

import { createClient, type Client } from "@libsql/client";

import {
  assertMeteredProviderCall,
  isMeteredProviderBlockedError,
  type MeteredCallRequest,
  type MeteredRunPermit,
} from "./metered-call-guard";
import {
  MeteredBudgetContractError,
  MeteredBudgetExceededError,
  MeteredBudgetIdempotencyConflictError,
  MeteredBudgetLedgerContractError,
  MeteredBudgetReceiptWriteError,
  MeteredBudgetSeedConflictError,
  MeteredBudgetSettlementError,
  reserveMeteredProviderBudget,
  settleMeteredProviderBudget,
} from "./metered-budget-store";

export type MeteredProviderRuntimeEnv = {
  SS_METERED_RUN_PERMIT?: string;
  SS_METERED_RUN_CONFIRM?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  DATABASE_URL?: string;
};

export type MeteredProviderAuthorization = {
  runId: string;
  approvalId: string;
  provider: MeteredCallRequest["provider"];
  operation: string;
  reservationKey: string;
  receiptId: string;
};

export type MeteredProviderCallInput = MeteredCallRequest & {
  /**
   * Stable, secret-free description of the provider request. Do not add an
   * attempt nonce unless the owning durable job explicitly authorizes a retry.
   */
  requestFingerprint: unknown;
  /** Runs after the durable reservation and before the network request. */
  onAuthorized?: (authorization: MeteredProviderAuthorization) => void | Promise<void>;
};

export class MeteredBudgetLedgerUnavailableError extends Error {
  readonly code = "METERED_BUDGET_LEDGER_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(`METERED_BUDGET_LEDGER_UNAVAILABLE: ${message}`, options);
    this.name = "MeteredBudgetLedgerUnavailableError";
  }
}

export class MeteredProviderReplayError extends Error {
  readonly code = "METERED_PROVIDER_REPLAY_BLOCKED";
  readonly reservationKey: string;
  readonly receiptId: string;

  constructor(reservationKey: string, receiptId: string) {
    super(`METERED_PROVIDER_REPLAY_BLOCKED: ${reservationKey} already has receipt ${receiptId}`);
    this.name = "MeteredProviderReplayError";
    this.reservationKey = reservationKey;
    this.receiptId = receiptId;
  }
}

export class MeteredProviderAuthorizationCallbackError extends Error {
  readonly code = "METERED_PROVIDER_AUTHORIZATION_CALLBACK_FAILED";

  constructor(message: string, options?: ErrorOptions) {
    super(`METERED_PROVIDER_AUTHORIZATION_CALLBACK_FAILED: ${message}`, options);
    this.name = "MeteredProviderAuthorizationCallbackError";
  }
}

export class MeteredProviderSettlementFailureError extends Error {
  readonly code = "METERED_PROVIDER_SETTLEMENT_FAILED";

  constructor(message: string, options?: ErrorOptions) {
    super(`METERED_PROVIDER_SETTLEMENT_FAILED: ${message}`, options);
    this.name = "MeteredProviderSettlementFailureError";
  }
}

function cleanEnv(value: string | undefined): string {
  return (value || "").trim().replace(/^['"]|['"]$/g, "");
}

function stableFingerprint(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean:${value ? "1" : "0"}`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("requestFingerprint numbers must be finite");
    return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
  }
  if (typeof value === "bigint") return `bigint:${value.toString(10)}`;
  if (typeof value === "symbol" || typeof value === "function") {
    throw new TypeError("requestFingerprint must contain serializable data only");
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError("requestFingerprint dates must be valid");
    return `date:${value.toISOString()}`;
  }
  if (value instanceof Uint8Array) {
    return `bytes:${Buffer.from(value).toString("base64")}`;
  }

  const object = value as object;
  if (seen.has(object)) throw new TypeError("requestFingerprint must not contain cycles");
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      return `array:[${value.map((item) => stableFingerprint(item, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("requestFingerprint objects must be plain records");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `object:{${keys
      .map((key) => `${JSON.stringify(key)}:${stableFingerprint(record[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

/** A deterministic, opaque idempotency key. Raw request data never enters DB. */
export function meteredProviderReservationKey(
  request: Pick<MeteredProviderCallInput, "provider" | "operation" | "requestFingerprint">,
): string {
  const digest = createHash("sha256")
    .update("metered-provider-request/v1\n")
    .update(request.provider)
    .update("\n")
    .update(request.operation)
    .update("\n")
    .update(stableFingerprint(request.requestFingerprint))
    .digest("hex");
  return `mpr_v1_${digest}`;
}

function createLedgerClient(env: MeteredProviderRuntimeEnv): Client {
  const url = cleanEnv(env.TURSO_DATABASE_URL) || cleanEnv(env.DATABASE_URL);
  if (!url) {
    throw new MeteredBudgetLedgerUnavailableError(
      "TURSO_DATABASE_URL or DATABASE_URL is required before a metered provider call",
    );
  }
  const authToken = cleanEnv(env.TURSO_AUTH_TOKEN) || undefined;
  try {
    return createClient({ url, authToken });
  } catch (error) {
    throw new MeteredBudgetLedgerUnavailableError("could not create the libSQL ledger client", { cause: error });
  }
}

function settlementDetail(error: unknown): string {
  const name = error instanceof Error && error.name.trim() ? error.name.trim() : "ProviderCallError";
  const rawMessage = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "provider request failed";
  const message = rawMessage
    .replace(/([?&](?:api_key|key|token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/g, "Basic [REDACTED]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]");
  return `${name}: ${message}`.slice(0, 2_048).trim() || "ProviderCallError: provider request failed";
}

async function closeLedgerClient(db: Client): Promise<void> {
  try {
    await db.close();
  } catch {
    // Reservation/settlement is already durable. Transport teardown is not an
    // authorization decision and must not rewrite the provider result.
  }
}

/**
 * True for spend-control failures that callers must never downgrade to a normal
 * provider miss/fallback. This includes both the legacy permit fence and every
 * durable ledger denial, replay or settlement failure.
 */
export function isMeteredProviderControlError(error: unknown): boolean {
  return isMeteredProviderBlockedError(error)
    || error instanceof MeteredBudgetLedgerUnavailableError
    || error instanceof MeteredProviderReplayError
    || error instanceof MeteredProviderAuthorizationCallbackError
    || error instanceof MeteredProviderSettlementFailureError
    || error instanceof MeteredBudgetContractError
    || error instanceof MeteredBudgetLedgerContractError
    || error instanceof MeteredBudgetSeedConflictError
    || error instanceof MeteredBudgetExceededError
    || error instanceof MeteredBudgetIdempotencyConflictError
    || error instanceof MeteredBudgetReceiptWriteError
    || error instanceof MeteredBudgetSettlementError;
}

export function throwIfMeteredProviderControlError(error: unknown): void {
  if (isMeteredProviderControlError(error)) throw error;
}

/**
 * Authorize and execute one provider request. `networkCall` is invoked only
 * when the durable reservation returns `networkAuthorized: true` exactly once.
 */
export async function withMeteredProviderCall<T>(
  input: MeteredProviderCallInput,
  networkCall: () => Promise<T>,
  runtimeEnv: MeteredProviderRuntimeEnv = {
    SS_METERED_RUN_PERMIT: process.env.SS_METERED_RUN_PERMIT,
    SS_METERED_RUN_CONFIRM: process.env.SS_METERED_RUN_CONFIRM,
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
    DATABASE_URL: process.env.DATABASE_URL,
  },
): Promise<T> {
  // Keep this first so a missing/invalid permit preserves the established
  // MeteredProviderBlockedError API and never reaches DB or network I/O.
  const permit: MeteredRunPermit = assertMeteredProviderCall(
    { provider: input.provider, operation: input.operation, units: input.units },
    runtimeEnv,
  );
  const confirmation = cleanEnv(runtimeEnv.SS_METERED_RUN_CONFIRM);
  const reservationKey = meteredProviderReservationKey(input);
  const db = createLedgerClient(runtimeEnv);
  const ledgerInput = {
    permit,
    confirmation,
    provider: input.provider,
    operation: input.operation,
    units: input.units,
    reservationKey,
  };

  try {
    const reservation = await reserveMeteredProviderBudget(db, ledgerInput);
    if (!reservation.networkAuthorized) {
      throw new MeteredProviderReplayError(reservationKey, reservation.receipt.id);
    }

    const authorization: MeteredProviderAuthorization = {
      runId: permit.runId,
      approvalId: permit.approvalId,
      provider: input.provider,
      operation: input.operation,
      reservationKey,
      receiptId: reservation.receipt.id,
    };

    if (input.onAuthorized) {
      try {
        await input.onAuthorized(authorization);
      } catch (error) {
        try {
          await settleMeteredProviderBudget(db, {
            ...ledgerInput,
            outcome: "failure",
            detail: settlementDetail(error),
          });
        } catch (settlementError) {
          throw new MeteredProviderSettlementFailureError(
            "could not settle a failed authorization callback",
            { cause: settlementError },
          );
        }
        throw new MeteredProviderAuthorizationCallbackError(
          "the post-reservation callback failed before network I/O",
          { cause: error },
        );
      }
    }

    let result: T;
    try {
      result = await networkCall();
    } catch (error) {
      try {
        await settleMeteredProviderBudget(db, {
          ...ledgerInput,
          outcome: "failure",
          detail: settlementDetail(error),
        });
      } catch (settlementError) {
        throw new MeteredProviderSettlementFailureError(
          "provider request failed and its failure settlement could not be appended",
          { cause: settlementError },
        );
      }
      throw error;
    }

    try {
      await settleMeteredProviderBudget(db, {
        ...ledgerInput,
        outcome: "success",
      });
    } catch (error) {
      throw new MeteredProviderSettlementFailureError(
        "provider request completed but its success settlement could not be appended",
        { cause: error },
      );
    }
    return result;
  } finally {
    await closeLedgerClient(db);
  }
}
