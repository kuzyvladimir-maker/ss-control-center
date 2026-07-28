-- Durable, bounded content-harvest lifecycle for one donor/source/item identity.
-- This migration only creates the contract; it does not enable any worker/cron.
CREATE TABLE "DonorHarvestState" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "donorProductId" TEXT NOT NULL CHECK (length(trim("donorProductId")) > 0),
  "source" TEXT NOT NULL
    CHECK (length(trim("source")) > 0 AND "source" = lower(trim("source"))),
  "retailerProductId" TEXT NOT NULL CHECK (length(trim("retailerProductId")) > 0),

  "status" TEXT NOT NULL DEFAULT 'pending'
    CHECK ("status" IN (
      'pending', 'running', 'retry_wait', 'partial', 'complete',
      'source_unavailable', 'error', 'cancelled'
    )),
  "requestedFields" TEXT NOT NULL
    CHECK (
      json_valid("requestedFields")
      AND json_type("requestedFields") = 'array'
      AND json_array_length("requestedFields") > 0
    ),
  "completedFields" TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid("completedFields") AND json_type("completedFields") = 'array'),
  "unavailableFields" TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid("unavailableFields") AND json_type("unavailableFields") = 'array'),

  -- Attempts count source/network dispatches only. Scheduler claims and denied
  -- budget permits must leave this value unchanged.
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "maxAttempts" INTEGER NOT NULL DEFAULT 3 CHECK ("maxAttempts" > 0),
  "nextEligibleAt" DATETIME,
  "terminalReason" TEXT,
  "lastError" TEXT,
  "lastBlockReason" TEXT,

  "runId" TEXT,
  "approvalId" TEXT,
  "leaseOwner" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" DATETIME,
  "claimedAt" DATETIME,
  "sourceAttemptStartedAt" DATETIME,
  "finishedAt" DATETIME,

  -- Workers must claim with UPDATE ... WHERE version=? and check one affected row.
  "version" INTEGER NOT NULL DEFAULT 0 CHECK ("version" >= 0),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DonorHarvestState_donorProductId_fkey"
    FOREIGN KEY ("donorProductId") REFERENCES "DonorProduct" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DonorHarvestState_attempt_cap"
    CHECK (
      "attempts" < "maxAttempts"
      OR "status" = 'running'
      OR "status" IN ('complete', 'source_unavailable', 'error', 'cancelled')
    ),
  CONSTRAINT "DonorHarvestState_terminal_reason"
    CHECK (
      "status" NOT IN ('source_unavailable', 'error', 'cancelled')
      OR "terminalReason" IS NOT NULL
    ),
  CONSTRAINT "DonorHarvestState_terminal_not_scheduled"
    CHECK (
      "status" NOT IN ('complete', 'source_unavailable', 'error', 'cancelled')
      OR "nextEligibleAt" IS NULL
    ),
  CONSTRAINT "DonorHarvestState_terminal_finished"
    CHECK (
      "status" NOT IN ('complete', 'source_unavailable', 'error', 'cancelled')
      OR "finishedAt" IS NOT NULL
    ),
  CONSTRAINT "DonorHarvestState_running_lease"
    CHECK (
      (
        "status" = 'running'
        AND "runId" IS NOT NULL
        AND "leaseOwner" IS NOT NULL
        AND "leaseToken" IS NOT NULL
        AND "leaseExpiresAt" IS NOT NULL
        AND "claimedAt" IS NOT NULL
      )
      OR (
        "status" <> 'running'
        AND "leaseOwner" IS NULL
        AND "leaseToken" IS NULL
        AND "leaseExpiresAt" IS NULL
        AND "sourceAttemptStartedAt" IS NULL
      )
    ),
  CONSTRAINT "DonorHarvestState_started_attempt_counted"
    CHECK ("sourceAttemptStartedAt" IS NULL OR "attempts" > 0),
  CONSTRAINT "DonorHarvestState_nonterminal_unfinished"
    CHECK (
      "status" IN ('complete', 'source_unavailable', 'error', 'cancelled')
      OR ("finishedAt" IS NULL AND "terminalReason" IS NULL)
    )
);

-- One lifecycle row per concrete donor/source/retailer item. Historical runs are
-- represented by run/approval provenance and should later be copied to an event
-- ledger if per-transition audit history becomes a consumer requirement.
CREATE UNIQUE INDEX "DonorHarvestState_identity_key"
  ON "DonorHarvestState" ("donorProductId", "source", "retailerProductId");

CREATE INDEX "DonorHarvestState_claimable_idx"
  ON "DonorHarvestState" ("status", "nextEligibleAt", "attempts");

CREATE INDEX "DonorHarvestState_expired_lease_idx"
  ON "DonorHarvestState" ("status", "leaseExpiresAt");

CREATE INDEX "DonorHarvestState_runId_idx"
  ON "DonorHarvestState" ("runId");

-- Database-level fail-closed guard: application code cannot mark a row complete
-- while any requested field is absent from both completed and unavailable lists.
CREATE TRIGGER "DonorHarvestState_complete_insert_guard"
BEFORE INSERT ON "DonorHarvestState"
WHEN NEW."status" = 'complete' AND EXISTS (
  SELECT 1
  FROM json_each(NEW."requestedFields") AS requested
  WHERE NOT EXISTS (
    SELECT 1 FROM json_each(NEW."completedFields") AS completed
    WHERE completed.value = requested.value
  )
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW."unavailableFields") AS unavailable
    WHERE unavailable.value = requested.value
  )
)
BEGIN
  SELECT RAISE(ABORT, 'HARVEST_COMPLETE_WITH_UNRESOLVED_FIELDS');
END;

CREATE TRIGGER "DonorHarvestState_complete_update_guard"
BEFORE UPDATE OF "status", "requestedFields", "completedFields", "unavailableFields"
ON "DonorHarvestState"
WHEN NEW."status" = 'complete' AND EXISTS (
  SELECT 1
  FROM json_each(NEW."requestedFields") AS requested
  WHERE NOT EXISTS (
    SELECT 1 FROM json_each(NEW."completedFields") AS completed
    WHERE completed.value = requested.value
  )
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW."unavailableFields") AS unavailable
    WHERE unavailable.value = requested.value
  )
)
BEGIN
  SELECT RAISE(ABORT, 'HARVEST_COMPLETE_WITH_UNRESOLVED_FIELDS');
END;
