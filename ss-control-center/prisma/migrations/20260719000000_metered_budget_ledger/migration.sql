-- Distributed hard cap for every owner-approved metered Product Truth run.
-- This migration creates storage only; it does not enable a worker, schedule,
-- provider, or paid network path.

CREATE TABLE "MeteredProviderBudget" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "permitVersion" INTEGER NOT NULL CHECK ("permitVersion" = 1),
  "runId" TEXT NOT NULL CHECK (length(trim("runId")) > 0 AND "runId" = trim("runId")),
  "approvalId" TEXT NOT NULL
    CHECK (length(trim("approvalId")) > 0 AND "approvalId" = trim("approvalId")),
  "approvedBy" TEXT NOT NULL CHECK ("approvedBy" = 'owner'),
  "provider" TEXT NOT NULL
    CHECK ("provider" IN ('unwrangle', 'bluecart', 'oxylabs', 'anthropic', 'gemini', 'openai')),
  "issuedAt" DATETIME NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "operations" TEXT NOT NULL
    CHECK (
      json_valid("operations")
      AND json_type("operations") = 'array'
      AND json_array_length("operations") > 0
    ),
  "maxCalls" INTEGER NOT NULL CHECK ("maxCalls" > 0),
  -- Integer micro-units avoid floating-point cap races. NULL means the permit
  -- has a call cap only; units are still counted for audit.
  "maxUnitsMicros" INTEGER CHECK ("maxUnitsMicros" IS NULL OR "maxUnitsMicros" > 0),
  "reservedCalls" INTEGER NOT NULL DEFAULT 0
    CHECK ("reservedCalls" >= 0 AND "reservedCalls" <= "maxCalls"),
  "reservedUnitsMicros" INTEGER NOT NULL DEFAULT 0
    CHECK (
      "reservedUnitsMicros" >= 0
      AND ("maxUnitsMicros" IS NULL OR "reservedUnitsMicros" <= "maxUnitsMicros")
    ),
  "createdAt" DATETIME NOT NULL,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "MeteredProviderBudget_valid_window"
    CHECK (julianday("expiresAt") > julianday("issuedAt"))
);

CREATE UNIQUE INDEX "MeteredProviderBudget_run_provider_key"
  ON "MeteredProviderBudget" ("runId", "provider");

CREATE INDEX "MeteredProviderBudget_approval_idx"
  ON "MeteredProviderBudget" ("approvalId", "expiresAt");

-- Every persisted budget begins unused. Defaults are not a sufficient guard:
-- a direct SQL writer can explicitly supply counters unless the database
-- rejects that initial state.
CREATE TRIGGER "MeteredProviderBudget_initial_counters_guard"
BEFORE INSERT ON "MeteredProviderBudget"
WHEN NEW."reservedCalls" <> 0 OR NEW."reservedUnitsMicros" <> 0
BEGIN
  SELECT RAISE(ABORT, 'METERED_BUDGET_INITIAL_COUNTERS_MUST_BE_ZERO');
END;

-- RAISE(IGNORE) makes application INSERT OR IGNORE idempotency safe and, more
-- importantly, prevents INSERT OR REPLACE from deleting/resetting an existing
-- budget when recursive_triggers is disabled.
CREATE TRIGGER "MeteredProviderBudget_duplicate_insert_guard"
BEFORE INSERT ON "MeteredProviderBudget"
WHEN EXISTS (
  SELECT 1 FROM "MeteredProviderBudget" existing
  WHERE existing."id" = NEW."id"
     OR (existing."runId" = NEW."runId" AND existing."provider" = NEW."provider")
)
BEGIN
  SELECT RAISE(IGNORE);
END;

-- A permit is immutable once its run/provider budget is seeded. A later
-- process presenting the same runId with changed approval, caps, operations or
-- expiry must fail validation rather than silently widen the budget.
CREATE TRIGGER "MeteredProviderBudget_contract_immutable"
BEFORE UPDATE OF
  "id", "permitVersion", "runId", "approvalId", "approvedBy", "provider",
  "issuedAt", "expiresAt", "operations", "maxCalls", "maxUnitsMicros", "createdAt"
ON "MeteredProviderBudget"
BEGIN
  SELECT RAISE(ABORT, 'METERED_BUDGET_CONTRACT_IMMUTABLE');
END;

-- Reservation counters can only move forward one call at a time. Failed
-- receipt persistence intentionally does not roll them back.
CREATE TRIGGER "MeteredProviderBudget_counter_monotonic"
BEFORE UPDATE OF "reservedCalls", "reservedUnitsMicros"
ON "MeteredProviderBudget"
WHEN
  NEW."reservedCalls" <> OLD."reservedCalls" + 1
  OR NEW."reservedUnitsMicros" <= OLD."reservedUnitsMicros"
BEGIN
  SELECT RAISE(ABORT, 'METERED_BUDGET_COUNTER_TRANSITION_INVALID');
END;

CREATE TRIGGER "MeteredProviderBudget_delete_guard"
BEFORE DELETE ON "MeteredProviderBudget"
BEGIN
  SELECT RAISE(ABORT, 'METERED_BUDGET_HISTORY_IMMUTABLE');
END;

CREATE TABLE "MeteredReservationReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "budgetId" TEXT NOT NULL,
  "reservationKey" TEXT NOT NULL
    CHECK (
      length("reservationKey") BETWEEN 1 AND 512
      AND "reservationKey" = trim("reservationKey")
    ),
  "operation" TEXT NOT NULL
    CHECK (length(trim("operation")) > 0 AND "operation" = trim("operation")),
  "unitsMicros" INTEGER NOT NULL CHECK ("unitsMicros" > 0),
  "status" TEXT NOT NULL
    CHECK ("status" IN ('pending', 'reserved', 'succeeded', 'failed', 'rejected')),
  "failureCode" TEXT,
  "createdAt" DATETIME NOT NULL,
  "reservedAt" DATETIME,
  "settledAt" DATETIME,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "MeteredReservationReceipt_budget_fkey"
    FOREIGN KEY ("budgetId") REFERENCES "MeteredProviderBudget" ("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "MeteredReservationReceipt_status_fields"
    CHECK (
      (
        "status" = 'pending'
        AND "failureCode" IS NULL AND "reservedAt" IS NULL AND "settledAt" IS NULL
      )
      OR (
        "status" = 'reserved'
        AND "failureCode" IS NULL AND "reservedAt" IS NOT NULL AND "settledAt" IS NULL
      )
      OR (
        "status" = 'succeeded'
        AND "failureCode" IS NULL AND "reservedAt" IS NOT NULL AND "settledAt" IS NOT NULL
      )
      OR (
        "status" = 'failed'
        AND length(trim(COALESCE("failureCode", ''))) > 0
        AND "reservedAt" IS NOT NULL AND "settledAt" IS NOT NULL
      )
      OR (
        "status" = 'rejected'
        AND length(trim(COALESCE("failureCode", ''))) > 0
        AND "reservedAt" IS NULL AND "settledAt" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "MeteredReservationReceipt_budget_key"
  ON "MeteredReservationReceipt" ("budgetId", "reservationKey");

CREATE INDEX "MeteredReservationReceipt_budget_status_idx"
  ON "MeteredReservationReceipt" ("budgetId", "status", "createdAt");

-- Receipts are append-only intents. Neither a caller nor a migration may
-- pre-authorize a network call by inserting a reserved/terminal row.
CREATE TRIGGER "MeteredReservationReceipt_initial_state_guard"
BEFORE INSERT ON "MeteredReservationReceipt"
WHEN
  NEW."status" <> 'pending'
  OR NEW."failureCode" IS NOT NULL
  OR NEW."reservedAt" IS NOT NULL
  OR NEW."settledAt" IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'METERED_RECEIPT_INITIAL_STATE_INVALID');
END;

-- The operation authorized by a receipt must be one of the immutable
-- operations in its owner-approved provider budget. This join also fails
-- closed if foreign_keys was disabled for the connection.
CREATE TRIGGER "MeteredReservationReceipt_operation_guard"
BEFORE INSERT ON "MeteredReservationReceipt"
WHEN NOT EXISTS (
  SELECT 1
  FROM "MeteredProviderBudget" budget
  JOIN json_each(budget."operations") permitted
  WHERE budget."id" = NEW."budgetId"
    AND permitted.type = 'text'
    AND permitted.value = NEW."operation"
)
BEGIN
  SELECT RAISE(ABORT, 'METERED_RECEIPT_OPERATION_NOT_ALLOWED');
END;

-- Block SQLite REPLACE from erasing a previous audit row while retaining the
-- existing INSERT OR IGNORE idempotency contract used by the store.
CREATE TRIGGER "MeteredReservationReceipt_duplicate_insert_guard"
BEFORE INSERT ON "MeteredReservationReceipt"
WHEN EXISTS (
  SELECT 1 FROM "MeteredReservationReceipt" existing
  WHERE existing."id" = NEW."id"
     OR (
       existing."budgetId" = NEW."budgetId"
       AND existing."reservationKey" = NEW."reservationKey"
     )
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER "MeteredReservationReceipt_identity_immutable"
BEFORE UPDATE OF "id", "budgetId", "reservationKey", "operation", "unitsMicros", "createdAt"
ON "MeteredReservationReceipt"
BEGIN
  SELECT RAISE(ABORT, 'METERED_RECEIPT_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER "MeteredReservationReceipt_status_transition"
BEFORE UPDATE OF "status" ON "MeteredReservationReceipt"
WHEN NEW."status" <> OLD."status" AND NOT (
  (OLD."status" = 'pending' AND NEW."status" IN ('reserved', 'rejected'))
  OR (OLD."status" = 'reserved' AND NEW."status" IN ('succeeded', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'METERED_RECEIPT_STATUS_TRANSITION_INVALID');
END;

-- A pending receipt can become network-authorizing only when the durable
-- counters cover all already-authorized receipts plus this one. Aggregate
-- coverage makes one counter increment impossible to reuse for two receipts,
-- while deliberately stranded capacity remains fail-closed/auditable.
CREATE TRIGGER "MeteredReservationReceipt_reservation_coverage_guard"
BEFORE UPDATE OF "status" ON "MeteredReservationReceipt"
WHEN OLD."status" = 'pending' AND NEW."status" = 'reserved' AND NOT EXISTS (
  SELECT 1
  FROM "MeteredProviderBudget" budget
  WHERE budget."id" = NEW."budgetId"
    AND budget."reservedCalls" >= (
      SELECT COUNT(*)
      FROM "MeteredReservationReceipt" receipt
      WHERE receipt."budgetId" = NEW."budgetId"
        AND (
          receipt."status" IN ('reserved', 'succeeded', 'failed')
          OR receipt."id" = NEW."id"
        )
    )
    AND budget."reservedUnitsMicros" >= (
      SELECT COALESCE(SUM(receipt."unitsMicros"), 0)
      FROM "MeteredReservationReceipt" receipt
      WHERE receipt."budgetId" = NEW."budgetId"
        AND (
          receipt."status" IN ('reserved', 'succeeded', 'failed')
          OR receipt."id" = NEW."id"
        )
    )
    AND budget."reservedCalls" <= budget."maxCalls"
    AND (
      budget."maxUnitsMicros" IS NULL
      OR budget."reservedUnitsMicros" <= budget."maxUnitsMicros"
    )
)
BEGIN
  SELECT RAISE(ABORT, 'METERED_RECEIPT_RESERVATION_NOT_COVERED');
END;

-- Success/failure is produced only by appending the one-to-one settlement.
-- The settlement row is already visible while its AFTER INSERT trigger updates
-- the receipt, so a direct reserved -> terminal UPDATE cannot forge success.
CREATE TRIGGER "MeteredReservationReceipt_terminal_settlement_guard"
BEFORE UPDATE OF "status" ON "MeteredReservationReceipt"
WHEN
  OLD."status" = 'reserved'
  AND NEW."status" IN ('succeeded', 'failed')
  AND NOT EXISTS (
    SELECT 1
    FROM "MeteredReservationSettlement" settlement
    WHERE settlement."reservationId" = NEW."id"
      AND settlement."outcome" = CASE NEW."status"
        WHEN 'succeeded' THEN 'success'
        ELSE 'failure'
      END
      AND settlement."settledAt" IS NEW."settledAt"
      AND settlement."settledAt" IS NEW."updatedAt"
      AND (
        (NEW."status" = 'succeeded' AND NEW."failureCode" IS NULL)
        OR (
          NEW."status" = 'failed'
          AND NEW."failureCode" IS COALESCE(settlement."detail", 'PROVIDER_CALL_FAILED')
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'METERED_RECEIPT_TERMINAL_REQUIRES_SETTLEMENT');
END;

-- Lifecycle metadata changes only as part of a status transition. Without
-- this guard a direct UPDATE could rewrite audit timestamps/failure evidence
-- while leaving the status unchanged.
CREATE TRIGGER "MeteredReservationReceipt_lifecycle_metadata_guard"
BEFORE UPDATE OF "failureCode", "reservedAt", "settledAt", "updatedAt"
ON "MeteredReservationReceipt"
WHEN NEW."status" = OLD."status"
BEGIN
  SELECT RAISE(ABORT, 'METERED_RECEIPT_LIFECYCLE_METADATA_IMMUTABLE');
END;

CREATE TRIGGER "MeteredReservationReceipt_delete_guard"
BEFORE DELETE ON "MeteredReservationReceipt"
BEGIN
  SELECT RAISE(ABORT, 'METERED_RECEIPT_HISTORY_IMMUTABLE');
END;

-- Settlement is append-only and one-to-one with a reservation receipt. The
-- AFTER INSERT trigger atomically records the terminal receipt status. A
-- failure in either half aborts the settlement insert.
CREATE TABLE "MeteredReservationSettlement" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "reservationId" TEXT NOT NULL,
  "outcome" TEXT NOT NULL CHECK ("outcome" IN ('success', 'failure')),
  "detail" TEXT,
  "settledAt" DATETIME NOT NULL,
  CONSTRAINT "MeteredReservationSettlement_receipt_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "MeteredReservationReceipt" ("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "MeteredReservationSettlement_reservation_key"
  ON "MeteredReservationSettlement" ("reservationId");

-- As with budgets and receipts, prevent OR REPLACE from bypassing history
-- immutability when SQLite recursive delete triggers are disabled.
CREATE TRIGGER "MeteredReservationSettlement_duplicate_insert_guard"
BEFORE INSERT ON "MeteredReservationSettlement"
WHEN EXISTS (
  SELECT 1 FROM "MeteredReservationSettlement" existing
  WHERE existing."id" = NEW."id"
     OR existing."reservationId" = NEW."reservationId"
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER "MeteredReservationSettlement_apply"
AFTER INSERT ON "MeteredReservationSettlement"
BEGIN
  UPDATE "MeteredReservationReceipt"
  SET
    "status" = CASE NEW."outcome" WHEN 'success' THEN 'succeeded' ELSE 'failed' END,
    "settledAt" = NEW."settledAt",
    "updatedAt" = NEW."settledAt",
    "failureCode" = CASE
      WHEN NEW."outcome" = 'failure' THEN COALESCE(NEW."detail", 'PROVIDER_CALL_FAILED')
      ELSE NULL
    END
  WHERE "id" = NEW."reservationId" AND "status" = 'reserved';

  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'METERED_SETTLEMENT_REQUIRES_RESERVED_RECEIPT')
  END;
END;

CREATE TRIGGER "MeteredReservationSettlement_immutable"
BEFORE UPDATE ON "MeteredReservationSettlement"
BEGIN
  SELECT RAISE(ABORT, 'METERED_SETTLEMENT_IMMUTABLE');
END;

CREATE TRIGGER "MeteredReservationSettlement_delete_guard"
BEFORE DELETE ON "MeteredReservationSettlement"
BEGIN
  SELECT RAISE(ABORT, 'METERED_SETTLEMENT_HISTORY_IMMUTABLE');
END;
