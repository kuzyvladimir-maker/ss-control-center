import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createClient, type Client } from "@libsql/client";

import { expectedMeteredRunConfirmation, type MeteredRunPermit } from "../metered-call-guard";
import { MeteredBudgetContractError } from "../metered-budget-contract";
import {
  METERED_BUDGET_LEDGER_CONTRACT_ERROR,
  MeteredBudgetExceededError,
  MeteredBudgetIdempotencyConflictError,
  MeteredBudgetReceiptWriteError,
  MeteredBudgetSeedConflictError,
  MeteredBudgetSettlementError,
  assertMeteredBudgetLedgerReady,
  ensureMeteredProviderBudget,
  getMeteredProviderBudget,
  reserveMeteredProviderBudget,
  settleMeteredProviderBudget,
} from "../metered-budget-store";

const migrationUrl = new URL(
  "../../../../prisma/migrations/20260719000000_metered_budget_ledger/migration.sql",
  import.meta.url,
);

function permit(overrides: Partial<MeteredRunPermit> = {}): MeteredRunPermit {
  const now = Date.now();
  return {
    version: 1,
    runId: "phase0-canary-001",
    approvalId: "owner-ok-001",
    approvedBy: "owner",
    issuedAt: new Date(now - 60 * 60 * 1_000).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1_000).toISOString(),
    providers: {
      unwrangle: { operations: ["search", "detail"], maxCalls: 3, maxUnits: 5 },
    },
    ...overrides,
  };
}

function input(p = permit()) {
  return {
    permit: p,
    confirmation: expectedMeteredRunConfirmation(p),
    provider: "unwrangle" as const,
  };
}

async function migratedMemoryDb(): Promise<Client> {
  const db = createClient({ url: "file::memory:" });
  await db.execute("PRAGMA foreign_keys=ON");
  await db.executeMultiple(await readFile(migrationUrl, "utf8"));
  return db;
}

async function insertRawPendingReceipt(
  db: Client,
  input: {
    id: string;
    budgetId: string;
    reservationKey?: string;
    operation?: string;
    unitsMicros?: number;
    failureCode?: string | null;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO "MeteredReservationReceipt" (
            "id", "budgetId", "reservationKey", "operation", "unitsMicros",
            "status", "failureCode", "createdAt", "reservedAt", "settledAt", "updatedAt"
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, ?)`,
    args: [
      input.id,
      input.budgetId,
      input.reservationKey ?? input.id,
      input.operation ?? "search",
      input.unitsMicros ?? 1_000_000,
      input.failureCode ?? null,
      "2026-07-19T12:00:00.000Z",
      "2026-07-19T12:00:00.000Z",
    ],
  });
}

test("fails closed when the complete ledger migration is absent", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await assert.rejects(
      reserveMeteredProviderBudget(db, {
        ...input(),
        operation: "search",
        reservationKey: "missing-schema-1",
      }),
      (error: unknown) => error instanceof Error
        && error.message.includes(METERED_BUDGET_LEDGER_CONTRACT_ERROR),
    );
  } finally {
    await db.close();
  }
});

test("one run/provider row is idempotent but exact approval, caps, ops and expiry cannot drift", async () => {
  const db = await migratedMemoryDb();
  try {
    const p = permit();
    const first = await ensureMeteredProviderBudget(db, input(p));
    const second = await ensureMeteredProviderBudget(db, input(p));
    assert.equal(first.id, second.id);
    assert.equal(first.reservedCalls, 0);

    for (const changed of [
      permit({ approvalId: "owner-ok-CHANGED" }),
      permit({ providers: { unwrangle: { operations: ["search", "detail"], maxCalls: 4, maxUnits: 5 } } }),
      permit({ providers: { unwrangle: { operations: ["search"], maxCalls: 3, maxUnits: 5 } } }),
      permit({ expiresAt: new Date(Date.parse(p.expiresAt) - 60_000).toISOString() }),
    ]) {
      await assert.rejects(
        ensureMeteredProviderBudget(db, input(changed)),
        MeteredBudgetSeedConflictError,
      );
    }

    const rows = await db.execute("SELECT COUNT(*) AS count FROM MeteredProviderBudget");
    assert.equal(Number(rows.rows[0]?.count), 1);
  } finally {
    await db.close();
  }
});

test("ledger schema readiness requires every authorization and immutability guard", async () => {
  const db = await migratedMemoryDb();
  try {
    await assertMeteredBudgetLedgerReady(db);
    await db.execute(`DROP TRIGGER "MeteredReservationReceipt_reservation_coverage_guard"`);
    await assert.rejects(
      assertMeteredBudgetLedgerReady(db),
      (error: unknown) => error instanceof Error
        && error.message.includes("MeteredReservationReceipt_reservation_coverage_guard"),
    );
  } finally {
    await db.close();
  }
});

test("database guards reject forged ledger states and REPLACE cannot reset history", async () => {
  const db = await migratedMemoryDb();
  try {
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO "MeteredProviderBudget" (
          "id", "permitVersion", "runId", "approvalId", "approvedBy", "provider",
          "issuedAt", "expiresAt", "operations", "maxCalls", "maxUnitsMicros",
          "reservedCalls", "reservedUnitsMicros", "createdAt", "updatedAt"
        ) VALUES (?, 1, ?, ?, 'owner', 'unwrangle', ?, ?, ?, 2, 2000000, 1, 1000000, ?, ?)`,
        args: [
          "forged-budget", "forged-run", "forged-approval",
          "2026-07-19T11:00:00.000Z", "2026-07-20T11:00:00.000Z",
          JSON.stringify(["search"]),
          "2026-07-19T11:00:00.000Z", "2026-07-19T11:00:00.000Z",
        ],
      }),
      /METERED_BUDGET_INITIAL_COUNTERS_MUST_BE_ZERO/,
    );

    const p = permit({
      runId: "database-guard-test",
      approvalId: "database-guard-approval",
      providers: { unwrangle: { operations: ["search"], maxCalls: 3, maxUnits: 3 } },
    });
    const budget = await ensureMeteredProviderBudget(db, input(p));

    await assert.rejects(
      db.execute({
        sql: `INSERT INTO "MeteredReservationReceipt" (
          "id", "budgetId", "reservationKey", "operation", "unitsMicros",
          "status", "failureCode", "createdAt", "reservedAt", "settledAt", "updatedAt"
        ) VALUES (?, ?, ?, 'search', 1000000, 'succeeded', NULL, ?, ?, ?, ?)`,
        args: [
          "forged-terminal", budget.id, "forged-terminal",
          "2026-07-19T12:00:00.000Z", "2026-07-19T12:00:01.000Z",
          "2026-07-19T12:00:02.000Z", "2026-07-19T12:00:02.000Z",
        ],
      }),
      /METERED_RECEIPT_INITIAL_STATE_INVALID/,
    );
    await assert.rejects(
      insertRawPendingReceipt(db, {
        id: "forged-failure-metadata",
        budgetId: budget.id,
        failureCode: "FAKE_FAILURE",
      }),
      /METERED_RECEIPT_INITIAL_STATE_INVALID/,
    );
    await assert.rejects(
      insertRawPendingReceipt(db, {
        id: "forged-operation",
        budgetId: budget.id,
        operation: "detail",
      }),
      /METERED_RECEIPT_OPERATION_NOT_ALLOWED/,
    );

    await insertRawPendingReceipt(db, { id: "covered-receipt-1", budgetId: budget.id });
    await assert.rejects(
      db.execute(`UPDATE "MeteredReservationReceipt"
        SET "status"='reserved', "reservedAt"='2026-07-19T12:00:01.000Z',
            "updatedAt"='2026-07-19T12:00:01.000Z'
        WHERE "id"='covered-receipt-1'`),
      /METERED_RECEIPT_RESERVATION_NOT_COVERED/,
    );

    await db.execute({
      sql: `UPDATE "MeteredProviderBudget"
            SET "reservedCalls"="reservedCalls"+1,
                "reservedUnitsMicros"="reservedUnitsMicros"+1000000,
                "updatedAt"=?
            WHERE "id"=?`,
      args: ["2026-07-19T12:00:01.000Z", budget.id],
    });
    await db.execute(`UPDATE "MeteredReservationReceipt"
      SET "status"='reserved', "reservedAt"='2026-07-19T12:00:01.000Z',
          "updatedAt"='2026-07-19T12:00:01.000Z'
      WHERE "id"='covered-receipt-1'`);

    await insertRawPendingReceipt(db, { id: "uncovered-receipt-2", budgetId: budget.id });
    await assert.rejects(
      db.execute(`UPDATE "MeteredReservationReceipt"
        SET "status"='reserved', "reservedAt"='2026-07-19T12:00:02.000Z',
            "updatedAt"='2026-07-19T12:00:02.000Z'
        WHERE "id"='uncovered-receipt-2'`),
      /METERED_RECEIPT_RESERVATION_NOT_COVERED/,
    );

    await assert.rejects(
      db.execute(`UPDATE "MeteredReservationReceipt"
        SET "status"='succeeded', "settledAt"='2026-07-19T12:00:03.000Z',
            "updatedAt"='2026-07-19T12:00:03.000Z'
        WHERE "id"='covered-receipt-1'`),
      /METERED_RECEIPT_TERMINAL_REQUIRES_SETTLEMENT/,
    );
    await db.execute(`INSERT INTO "MeteredReservationSettlement" (
      "id", "reservationId", "outcome", "detail", "settledAt"
    ) VALUES (
      'covered-settlement-1', 'covered-receipt-1', 'success', NULL,
      '2026-07-19T12:00:03.000Z'
    )`);

    await assert.rejects(
      db.execute(`UPDATE "MeteredReservationReceipt"
        SET "updatedAt"='2026-07-19T12:00:04.000Z'
        WHERE "id"='covered-receipt-1'`),
      /METERED_RECEIPT_LIFECYCLE_METADATA_IMMUTABLE/,
    );

    await db.execute({
      sql: `INSERT OR REPLACE INTO "MeteredProviderBudget"
        SELECT "id", "permitVersion", "runId", "approvalId", "approvedBy", "provider",
               "issuedAt", "expiresAt", "operations", "maxCalls", "maxUnitsMicros",
               0, 0, "createdAt", "updatedAt"
        FROM "MeteredProviderBudget" WHERE "id"=?`,
      args: [budget.id],
    });
    await db.execute(`INSERT OR REPLACE INTO "MeteredReservationReceipt"
      SELECT "id", "budgetId", "reservationKey", "operation", "unitsMicros",
             'pending', NULL, "createdAt", NULL, NULL, "createdAt"
      FROM "MeteredReservationReceipt" WHERE "id"='covered-receipt-1'`);
    await db.execute(`INSERT OR REPLACE INTO "MeteredReservationSettlement"
      VALUES (
        'covered-settlement-1', 'covered-receipt-1', 'failure', 'FORGED',
        '2026-07-19T12:00:05.000Z'
      )`);

    const finalBudget = await db.execute({
      sql: `SELECT "reservedCalls", "reservedUnitsMicros"
            FROM "MeteredProviderBudget" WHERE "id"=?`,
      args: [budget.id],
    });
    assert.equal(Number(finalBudget.rows[0]?.reservedCalls), 1);
    assert.equal(Number(finalBudget.rows[0]?.reservedUnitsMicros), 1_000_000);
    const finalReceipt = await db.execute(
      `SELECT "status" FROM "MeteredReservationReceipt" WHERE "id"='covered-receipt-1'`,
    );
    assert.equal(finalReceipt.rows[0]?.status, "succeeded");
    const finalSettlement = await db.execute(
      `SELECT "outcome", "detail" FROM "MeteredReservationSettlement"
       WHERE "id"='covered-settlement-1'`,
    );
    assert.equal(finalSettlement.rows[0]?.outcome, "success");
    assert.equal(finalSettlement.rows[0]?.detail, null);
  } finally {
    await db.close();
  }
});

test("reservation is idempotent, auditable and bounded by both call and unit caps", async () => {
  const db = await migratedMemoryDb();
  try {
    const p = permit();
    const first = await reserveMeteredProviderBudget(db, {
      ...input(p),
      operation: "detail",
      units: 2,
      reservationKey: "sku:A:detail:v1",
    });
    assert.equal(first.networkAuthorized, true);
    assert.equal(first.replay, false);
    assert.equal(first.receipt.status, "reserved");
    assert.equal(first.receipt.operation, "detail");
    assert.equal(first.receipt.units, 2);

    const replay = await reserveMeteredProviderBudget(db, {
      ...input(p),
      operation: "detail",
      units: 2,
      reservationKey: "sku:A:detail:v1",
    });
    assert.equal(replay.networkAuthorized, false);
    assert.equal(replay.replay, true);
    assert.equal(replay.receipt.id, first.receipt.id);

    await assert.rejects(
      reserveMeteredProviderBudget(db, {
        ...input(p),
        operation: "search",
        units: 2,
        reservationKey: "sku:A:detail:v1",
      }),
      MeteredBudgetIdempotencyConflictError,
    );

    const second = await reserveMeteredProviderBudget(db, {
      ...input(p),
      operation: "search",
      units: 3,
      reservationKey: "sku:B:search:v1",
    });
    assert.equal(second.networkAuthorized, true);

    await assert.rejects(
      reserveMeteredProviderBudget(db, {
        ...input(p),
        operation: "search",
        units: 0.000001,
        reservationKey: "sku:C:search:v1",
      }),
      (error: unknown) => error instanceof MeteredBudgetExceededError
        && error.code === "UNIT_BUDGET_EXHAUSTED",
    );

    const stored = await getMeteredProviderBudget(db, p.runId, "unwrangle");
    assert.equal(stored?.reservedCalls, 2);
    assert.equal(stored?.reservedUnits, 5);
    const receipts = await db.execute(
      "SELECT status, operation, unitsMicros FROM MeteredReservationReceipt ORDER BY reservationKey",
    );
    assert.deepEqual(
      receipts.rows.map((row) => String(row.status)),
      ["reserved", "reserved", "rejected"],
    );
  } finally {
    await db.close();
  }
});

test("call-only permits stop exactly at maxCalls", async () => {
  const db = await migratedMemoryDb();
  try {
    const p = permit({
      runId: "call-cap-only",
      providers: { unwrangle: { operations: ["search"], maxCalls: 2 } },
    });
    for (const reservationKey of ["call-1", "call-2"]) {
      const result = await reserveMeteredProviderBudget(db, {
        ...input(p),
        operation: "search",
        units: 100,
        reservationKey,
      });
      assert.equal(result.networkAuthorized, true);
    }
    await assert.rejects(
      reserveMeteredProviderBudget(db, {
        ...input(p),
        operation: "search",
        units: 1,
        reservationKey: "call-3",
      }),
      (error: unknown) => error instanceof MeteredBudgetExceededError
        && error.code === "CALL_BUDGET_EXHAUSTED",
    );
    const budget = await getMeteredProviderBudget(db, p.runId, "unwrangle");
    assert.equal(budget?.reservedCalls, 2);
    assert.equal(budget?.reservedUnits, 200);
  } finally {
    await db.close();
  }
});

test("expired permit and unapproved provider/operation are rejected before reservation", async () => {
  const db = await migratedMemoryDb();
  try {
    const expired = permit({
      issuedAt: "2026-07-18T19:00:00.000Z",
      expiresAt: "2026-07-18T20:00:00.000Z",
    });
    await assert.rejects(
      reserveMeteredProviderBudget(db, {
        ...input(expired),
        operation: "search",
        reservationKey: "expired-1",
        // A JavaScript caller cannot smuggle the pure-test override through
        // the store authorization boundary.
        requireCurrent: false,
      } as Parameters<typeof reserveMeteredProviderBudget>[1]),
      (error: unknown) => error instanceof MeteredBudgetContractError
        && error.code === "PERMIT_NOT_CURRENT",
    );

    await assert.rejects(
      reserveMeteredProviderBudget(db, {
        ...input(),
        operation: "synthetic_probe",
        reservationKey: "operation-1",
      }),
      (error: unknown) => error instanceof MeteredBudgetContractError
        && error.code === "OPERATION_NOT_ALLOWED",
    );

    const p = permit();
    await assert.rejects(
      reserveMeteredProviderBudget(db, {
        permit: p,
        confirmation: expectedMeteredRunConfirmation(p),
        provider: "anthropic",
        operation: "vision",
        reservationKey: "provider-1",
      }),
      (error: unknown) => error instanceof MeteredBudgetContractError
        && error.code === "PROVIDER_NOT_ALLOWED",
    );
  } finally {
    await db.close();
  }
});

test("receipt finalization failure consumes capacity but never returns network authorization", async () => {
  const db = await migratedMemoryDb();
  try {
    await db.execute(`CREATE TRIGGER "test_receipt_write_failure"
      BEFORE UPDATE OF "status" ON "MeteredReservationReceipt"
      WHEN NEW."status" = 'reserved'
      BEGIN
        SELECT RAISE(ABORT, 'TEST_RECEIPT_WRITE_FAILURE');
      END`);

    const p = permit();
    await assert.rejects(
      reserveMeteredProviderBudget(db, {
        ...input(p),
        operation: "search",
        reservationKey: "fail-receipt-1",
      }),
      MeteredBudgetReceiptWriteError,
    );

    const budget = await getMeteredProviderBudget(db, p.runId, "unwrangle");
    assert.equal(budget?.reservedCalls, 1);
    assert.equal(budget?.reservedUnits, 1);
    const receipt = await db.execute(
      "SELECT status, reservedAt FROM MeteredReservationReceipt WHERE reservationKey='fail-receipt-1'",
    );
    assert.equal(receipt.rows[0]?.status, "pending");
    assert.equal(receipt.rows[0]?.reservedAt, null);
  } finally {
    await db.close();
  }
});

test("success and failure settlement are append-only, terminal and idempotent", async () => {
  const db = await migratedMemoryDb();
  try {
    const p = permit({ providers: { unwrangle: { operations: ["search"], maxCalls: 3 } } });
    await reserveMeteredProviderBudget(db, {
      ...input(p),
      operation: "search",
      reservationKey: "settle-success-1",
    });
    const success = await settleMeteredProviderBudget(db, {
      ...input(p),
      operation: "search",
      reservationKey: "settle-success-1",
      outcome: "success",
    });
    assert.equal(success.replay, false);
    assert.equal(success.receipt.status, "succeeded");
    assert.equal(success.settlement.outcome, "success");

    const replay = await settleMeteredProviderBudget(db, {
      ...input(p),
      operation: "search",
      reservationKey: "settle-success-1",
      outcome: "success",
    });
    assert.equal(replay.replay, true);

    await assert.rejects(
      settleMeteredProviderBudget(db, {
        ...input(p),
        operation: "search",
        reservationKey: "settle-success-1",
        outcome: "failure",
        detail: "HTTP_500",
      }),
      (error: unknown) => error instanceof MeteredBudgetSettlementError
        && error.code === "METERED_SETTLEMENT_CONFLICT",
    );

    await reserveMeteredProviderBudget(db, {
      ...input(p),
      operation: "search",
      reservationKey: "settle-failure-1",
    });
    const failure = await settleMeteredProviderBudget(db, {
      ...input(p),
      operation: "search",
      reservationKey: "settle-failure-1",
      outcome: "failure",
      detail: "HTTP_503",
    });
    assert.equal(failure.receipt.status, "failed");
    assert.equal(failure.receipt.failureCode, "HTTP_503");

    const counts = await db.execute(
      "SELECT (SELECT COUNT(*) FROM MeteredReservationSettlement) AS settlements,"
      + " (SELECT COUNT(*) FROM MeteredReservationReceipt WHERE status IN ('succeeded','failed')) AS terminal",
    );
    assert.equal(Number(counts.rows[0]?.settlements), 2);
    assert.equal(Number(counts.rows[0]?.terminal), 2);
  } finally {
    await db.close();
  }
});

test("atomic conditional UPDATE never exceeds caps across independent libSQL clients", async () => {
  const directory = await mkdtemp(join(tmpdir(), "metered-budget-ledger-"));
  const file = join(directory, "ledger.db");
  const url = `file:${file}`;
  const migrationClient = createClient({ url });
  const clients: Client[] = [];
  try {
    await migrationClient.execute("PRAGMA foreign_keys=ON");
    await migrationClient.executeMultiple(await readFile(migrationUrl, "utf8"));
    await migrationClient.close();

    for (let index = 0; index < 12; index += 1) {
      const client = createClient({ url });
      await client.execute("PRAGMA foreign_keys=ON");
      await client.execute("PRAGMA busy_timeout=5000");
      clients.push(client);
    }
    const p = permit({
      runId: "distributed-cap-test",
      providers: { unwrangle: { operations: ["search"], maxCalls: 5, maxUnits: 5 } },
    });
    const results = await Promise.allSettled(clients.map((client, index) => (
      reserveMeteredProviderBudget(client, {
        ...input(p),
        operation: "search",
        reservationKey: `parallel-${index}`,
      })
    )));
    const authorized = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof reserveMeteredProviderBudget>>> => (
        result.status === "fulfilled" && result.value.networkAuthorized
      ),
    );
    assert.equal(authorized.length, 5);
    for (const rejected of results.filter((result) => result.status === "rejected")) {
      assert.ok(rejected.status === "rejected" && rejected.reason instanceof MeteredBudgetExceededError);
    }

    const budget = await getMeteredProviderBudget(clients[0], p.runId, "unwrangle");
    assert.equal(budget?.reservedCalls, 5);
    assert.equal(budget?.reservedUnits, 5);
    const reservedReceipts = await clients[0].execute(
      "SELECT COUNT(*) AS count FROM MeteredReservationReceipt WHERE status='reserved'",
    );
    assert.equal(Number(reservedReceipts.rows[0]?.count), 5);

    const idempotentPermit = permit({
      runId: "distributed-idempotency-test",
      providers: { unwrangle: { operations: ["detail"], maxCalls: 3, maxUnits: 9 } },
    });
    const sameKey = await Promise.all([
      reserveMeteredProviderBudget(clients[0], {
        ...input(idempotentPermit),
        operation: "detail",
        units: 2,
        reservationKey: "shared-work-item",
      }),
      reserveMeteredProviderBudget(clients[1], {
        ...input(idempotentPermit),
        operation: "detail",
        units: 2,
        reservationKey: "shared-work-item",
      }),
    ]);
    assert.equal(sameKey.filter((result) => result.networkAuthorized).length, 1);
    assert.equal(sameKey.filter((result) => result.replay).length, 1);
    const idempotentBudget = await getMeteredProviderBudget(
      clients[0],
      idempotentPermit.runId,
      "unwrangle",
    );
    assert.equal(idempotentBudget?.reservedCalls, 1);
    assert.equal(idempotentBudget?.reservedUnits, 2);
  } finally {
    for (const client of clients) await client.close();
    try { await migrationClient.close(); } catch { /* already closed */ }
    await rm(directory, { recursive: true, force: true });
  }
});
