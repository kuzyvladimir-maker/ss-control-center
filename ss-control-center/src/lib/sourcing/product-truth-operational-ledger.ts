import type { Client } from "@libsql/client";

import { assertMeteredBudgetLedgerReady } from "./metered-budget-store";
import type {
  ProductTruthOperationalPlan,
  ProductTruthProviderCeiling,
} from "./product-truth-operational-run-contract";

export const PRODUCT_TRUTH_OPERATIONAL_LEDGER_VERSION =
  "product-truth-operational-ledger/1.0.0" as const;

export interface ProductTruthOperationalMeteredReceipt {
  receiptId: string;
  budgetId: string;
  provider: string;
  operation: string;
  reservationKey: string;
  unitsMicros: number;
  units: number;
  status: "pending" | "reserved" | "succeeded" | "failed" | "rejected";
  failureCode: string | null;
  createdAt: string;
  reservedAt: string | null;
  settledAt: string | null;
}

export interface ProductTruthOperationalLedgerSnapshot {
  schemaVersion: typeof PRODUCT_TRUTH_OPERATIONAL_LEDGER_VERSION;
  runId: string;
  receipts: ProductTruthOperationalMeteredReceipt[];
  totals: {
    calls: number;
    units: number;
    byProvider: Record<string, { calls: number; units: number }>;
  };
}

export class ProductTruthOperationalLedgerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthOperationalLedgerError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthOperationalLedgerError(code, message);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) fail("OPERATIONAL_LEDGER_INVALID", `${label} is invalid`);
  return value;
}

function nullableText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") fail("OPERATIONAL_LEDGER_INVALID", "expected nullable text");
  return value;
}

function integer(value: unknown, label: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    fail("OPERATIONAL_LEDGER_INVALID", `${label} must be an integer`);
  }
  return number;
}

function instant(value: unknown, label: string): string {
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) fail("OPERATIONAL_LEDGER_INVALID", `${label} is invalid`);
  return new Date(timestamp).toISOString();
}

function nullableInstant(value: unknown, label: string): string | null {
  return value == null ? null : instant(value, label);
}

function parseReceipt(row: Record<string, unknown>): ProductTruthOperationalMeteredReceipt {
  const status = text(row.status, "receipt.status");
  if (!["pending", "reserved", "succeeded", "failed", "rejected"].includes(status)) {
    fail("OPERATIONAL_LEDGER_INVALID", `unknown receipt status ${status}`);
  }
  const unitsMicros = integer(row.unitsMicros, "receipt.unitsMicros");
  return {
    receiptId: text(row.receiptId, "receipt.id"),
    budgetId: text(row.budgetId, "receipt.budgetId"),
    provider: text(row.provider, "receipt.provider"),
    operation: text(row.operation, "receipt.operation"),
    reservationKey: text(row.reservationKey, "receipt.reservationKey"),
    unitsMicros,
    units: unitsMicros / 1_000_000,
    status: status as ProductTruthOperationalMeteredReceipt["status"],
    failureCode: nullableText(row.failureCode),
    createdAt: instant(row.createdAt, "receipt.createdAt"),
    reservedAt: nullableInstant(row.reservedAt, "receipt.reservedAt"),
    settledAt: nullableInstant(row.settledAt, "receipt.settledAt"),
  };
}

function totals(receipts: readonly ProductTruthOperationalMeteredReceipt[]) {
  const byProvider: Record<string, { calls: number; units: number }> = {};
  for (const receipt of receipts) {
    const value = byProvider[receipt.provider] ?? { calls: 0, units: 0 };
    value.calls += 1;
    value.units += receipt.units;
    byProvider[receipt.provider] = value;
  }
  return {
    calls: receipts.length,
    units: receipts.reduce((sum, receipt) => sum + receipt.units, 0),
    byProvider,
  };
}

export async function readProductTruthOperationalLedger(
  db: Client,
  runId: string,
): Promise<ProductTruthOperationalLedgerSnapshot> {
  await assertMeteredBudgetLedgerReady(db);
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) throw new TypeError("runId is required");
  const result = await db.execute({
    sql: `SELECT receipt.id AS receiptId, receipt.budgetId,
                 budget.provider, receipt.operation, receipt.reservationKey,
                 receipt.unitsMicros, receipt.status, receipt.failureCode,
                 receipt.createdAt, receipt.reservedAt, receipt.settledAt
          FROM "MeteredReservationReceipt" receipt
          JOIN "MeteredProviderBudget" budget ON budget.id=receipt.budgetId
          WHERE budget.runId=?
          ORDER BY receipt.createdAt, receipt.id`,
    args: [normalizedRunId],
  });
  const receipts = result.rows.map((row) => parseReceipt(row as Record<string, unknown>));
  return {
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_LEDGER_VERSION,
    runId: normalizedRunId,
    receipts,
    totals: totals(receipts),
  };
}

function parseOperations(value: unknown): string[] {
  if (typeof value !== "string") fail("OPERATIONAL_LEDGER_INVALID", "budget operations must be JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail("OPERATIONAL_LEDGER_INVALID", "budget operations JSON is invalid");
  }
  if (!Array.isArray(parsed) || parsed.some((operation) => typeof operation !== "string")) {
    fail("OPERATIONAL_LEDGER_INVALID", "budget operations must be a string array");
  }
  return parsed as string[];
}

function ceilingEquals(
  row: Record<string, unknown>,
  ceiling: ProductTruthProviderCeiling,
): boolean {
  const maxUnitsMicros = row.maxUnitsMicros == null ? null : integer(row.maxUnitsMicros, "maxUnitsMicros");
  return row.provider === ceiling.provider
    && integer(row.maxCalls, "maxCalls") === ceiling.maxCalls
    && maxUnitsMicros === (ceiling.maxUnits == null ? null : Math.round(ceiling.maxUnits * 1_000_000))
    && JSON.stringify(parseOperations(row.operations)) === JSON.stringify(ceiling.operations);
}

/** Every materialized budget must be an exact subset member of the sealed plan. */
export async function assertProductTruthOperationalLedgerBinding(
  db: Client,
  input: {
    plan: ProductTruthOperationalPlan;
    approvalId: string;
  },
): Promise<void> {
  await assertMeteredBudgetLedgerReady(db);
  const result = await db.execute({
    sql: `SELECT id,runId,approvalId,provider,operations,maxCalls,maxUnitsMicros
          FROM "MeteredProviderBudget" WHERE runId=? ORDER BY provider`,
    args: [input.plan.runId],
  });
  const ceilings = new Map(input.plan.providerCeilings.map((ceiling) => [ceiling.provider, ceiling]));
  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const provider = text(row.provider, "budget.provider");
    const ceiling = ceilings.get(provider as ProductTruthProviderCeiling["provider"]);
    if (
      row.runId !== input.plan.runId
      || row.approvalId !== input.approvalId
      || !ceiling
      || !ceilingEquals(row, ceiling)
    ) {
      fail("OPERATIONAL_LEDGER_BINDING_MISMATCH", `budget ${String(row.id)} differs from sealed plan`);
    }
  }
}

export function productTruthOperationalLedgerDelta(
  before: ProductTruthOperationalLedgerSnapshot,
  after: ProductTruthOperationalLedgerSnapshot,
): ProductTruthOperationalLedgerSnapshot {
  if (before.runId !== after.runId) fail("OPERATIONAL_LEDGER_INVALID", "ledger snapshots belong to different runs");
  const prior = new Set(before.receipts.map((receipt) => receipt.receiptId));
  const receipts = after.receipts.filter((receipt) => !prior.has(receipt.receiptId));
  if (after.receipts.length !== before.receipts.length + receipts.length) {
    fail("OPERATIONAL_LEDGER_HISTORY_INVALID", "a prior receipt disappeared or changed identity");
  }
  return {
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_LEDGER_VERSION,
    runId: after.runId,
    receipts,
    totals: totals(receipts),
  };
}

export function assertProductTruthOperationalLedgerSettled(
  snapshot: ProductTruthOperationalLedgerSnapshot,
): void {
  const ambiguous = snapshot.receipts.filter((receipt) => (
    receipt.status === "pending" || receipt.status === "reserved"
  ));
  if (ambiguous.length) {
    fail(
      "OPERATIONAL_LEDGER_OUTCOME_AMBIGUOUS",
      `unsettled receipts: ${ambiguous.map((receipt) => receipt.receiptId).join(", ")}`,
    );
  }
}
