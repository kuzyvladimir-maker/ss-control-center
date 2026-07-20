-- Product Truth operational runner v1.
--
-- This migration stores only sealed run control, exact listing work items, and
-- an append-only event chain. It does not import a manifest, infer a listing
-- scope, enqueue work, call a provider, or backfill legacy rows.

CREATE TABLE "ProductTruthOperationalRun" (
  "runId" TEXT NOT NULL PRIMARY KEY CHECK (length("runId") > 0 AND "runId" = trim("runId")),
  "approvalId" TEXT NOT NULL UNIQUE CHECK (length("approvalId") > 0 AND "approvalId" = trim("approvalId")),
  "planSchemaVersion" TEXT NOT NULL,
  "planSha256" TEXT NOT NULL UNIQUE CHECK (
    length("planSha256") = 64
    AND "planSha256" = lower("planSha256")
    AND "planSha256" NOT GLOB '*[^0-9a-f]*'
  ),
  "planJson" TEXT NOT NULL CHECK (json_valid("planJson")),
  "mode" TEXT NOT NULL CHECK ("mode" IN ('CANARY','WAVE')),
  "environment" TEXT NOT NULL CHECK ("environment" IN ('production','local-test')),
  "targetFingerprint" TEXT NOT NULL CHECK (
    length("targetFingerprint") = 64
    AND "targetFingerprint" = lower("targetFingerprint")
    AND "targetFingerprint" NOT GLOB '*[^0-9a-f]*'
  ),
  "manifestSha256" TEXT NOT NULL CHECK (
    length("manifestSha256") = 64
    AND "manifestSha256" = lower("manifestSha256")
    AND "manifestSha256" NOT GLOB '*[^0-9a-f]*'
  ),
  "targetSetSha256" TEXT NOT NULL CHECK (
    length("targetSetSha256") = 64
    AND "targetSetSha256" = lower("targetSetSha256")
    AND "targetSetSha256" NOT GLOB '*[^0-9a-f]*'
  ),
  "targetCount" INTEGER NOT NULL CHECK ("targetCount" > 0 AND "targetCount" <= 100),
  "sourcePolicyJson" TEXT NOT NULL CHECK (json_valid("sourcePolicyJson")),
  "providerCeilingsJson" TEXT NOT NULL CHECK (json_valid("providerCeilingsJson")),
  "status" TEXT NOT NULL DEFAULT 'prepared'
    CHECK ("status" IN ('prepared','running','interrupted','blocked','ambiguous','completed','failed')),
  "leaseOwner" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" DATETIME,
  "heartbeatAt" DATETIME,
  "startedAt" DATETIME,
  "finishedAt" DATETIME,
  "eventChainHead" TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
    CHECK (
      length("eventChainHead") = 64
      AND "eventChainHead" = lower("eventChainHead")
      AND "eventChainHead" NOT GLOB '*[^0-9a-f]*'
    ),
  "reportSha256" TEXT CHECK (
    "reportSha256" IS NULL OR (
      length("reportSha256") = 64
      AND "reportSha256" = lower("reportSha256")
      AND "reportSha256" NOT GLOB '*[^0-9a-f]*'
    )
  ),
  "artifactIndexSha256" TEXT CHECK (
    "artifactIndexSha256" IS NULL OR (
      length("artifactIndexSha256") = 64
      AND "artifactIndexSha256" = lower("artifactIndexSha256")
      AND "artifactIndexSha256" NOT GLOB '*[^0-9a-f]*'
    )
  ),
  "createdAt" DATETIME NOT NULL CHECK (julianday("createdAt") IS NOT NULL),
  "updatedAt" DATETIME NOT NULL CHECK (julianday("updatedAt") IS NOT NULL),
  CONSTRAINT "ProductTruthOperationalRun_plan_projection" CHECK (
    json_extract("planJson", '$.runId') = "runId"
    AND json_extract("planJson", '$.schemaVersion') = "planSchemaVersion"
    AND json_extract("planJson", '$.mode') = "mode"
    AND json_extract("planJson", '$.targetFingerprint') = "targetFingerprint"
    AND json_extract("planJson", '$.manifest.sha256') = "manifestSha256"
    AND json_extract("planJson", '$.targetSetSha256') = "targetSetSha256"
    AND json_array_length("planJson", '$.targets') = "targetCount"
  )
);

-- Exactly one operational executor may own production at a time. Read-only
-- doctor/plan/status/report commands never create a running row.
CREATE UNIQUE INDEX "ProductTruthOperationalRun_one_running_environment"
  ON "ProductTruthOperationalRun"("environment")
  WHERE "status"='running';

CREATE INDEX "ProductTruthOperationalRun_status_updated_idx"
  ON "ProductTruthOperationalRun"("status", "updatedAt");

CREATE TRIGGER "ProductTruthOperationalRun_initial_state_guard"
BEFORE INSERT ON "ProductTruthOperationalRun"
WHEN NEW."status" <> 'prepared'
  OR NEW."leaseOwner" IS NOT NULL
  OR NEW."leaseToken" IS NOT NULL
  OR NEW."leaseExpiresAt" IS NOT NULL
  OR NEW."heartbeatAt" IS NOT NULL
  OR NEW."startedAt" IS NOT NULL
  OR NEW."finishedAt" IS NOT NULL
  OR NEW."reportSha256" IS NOT NULL
  OR NEW."artifactIndexSha256" IS NOT NULL
  OR NEW."eventChainHead" <> '0000000000000000000000000000000000000000000000000000000000000000'
  OR EXISTS (
    SELECT 1 FROM "MeteredProviderBudget" budget
    WHERE budget."runId" = NEW."runId"
  )
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_RUN_INITIAL_STATE_INVALID');
END;

CREATE TRIGGER "ProductTruthOperationalRun_identity_immutable"
BEFORE UPDATE ON "ProductTruthOperationalRun"
WHEN NEW."runId" <> OLD."runId"
  OR NEW."approvalId" <> OLD."approvalId"
  OR NEW."planSchemaVersion" <> OLD."planSchemaVersion"
  OR NEW."planSha256" <> OLD."planSha256"
  OR NEW."planJson" <> OLD."planJson"
  OR NEW."mode" <> OLD."mode"
  OR NEW."environment" <> OLD."environment"
  OR NEW."targetFingerprint" <> OLD."targetFingerprint"
  OR NEW."manifestSha256" <> OLD."manifestSha256"
  OR NEW."targetSetSha256" <> OLD."targetSetSha256"
  OR NEW."targetCount" <> OLD."targetCount"
  OR NEW."sourcePolicyJson" <> OLD."sourcePolicyJson"
  OR NEW."providerCeilingsJson" <> OLD."providerCeilingsJson"
  OR NEW."createdAt" <> OLD."createdAt"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_RUN_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER "ProductTruthOperationalRun_status_transition_guard"
BEFORE UPDATE OF "status" ON "ProductTruthOperationalRun"
WHEN NEW."status" <> OLD."status" AND NOT (
  (OLD."status"='prepared' AND NEW."status" IN ('running','blocked','failed'))
  OR (OLD."status"='running' AND NEW."status" IN ('interrupted','blocked','ambiguous','completed','failed'))
  OR (OLD."status"='interrupted' AND NEW."status" IN ('running','blocked','ambiguous','failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_RUN_STATUS_INVALID');
END;

CREATE TRIGGER "ProductTruthOperationalRun_lease_contract_guard"
BEFORE UPDATE ON "ProductTruthOperationalRun"
WHEN (
  NEW."status"='running' AND (
    NEW."leaseOwner" IS NULL OR NEW."leaseOwner"=''
    OR NEW."leaseToken" IS NULL OR NEW."leaseToken"=''
    OR NEW."leaseExpiresAt" IS NULL
    OR NEW."heartbeatAt" IS NULL
    OR julianday(NEW."leaseExpiresAt") <= julianday(NEW."heartbeatAt")
    OR NEW."startedAt" IS NULL
    OR NEW."finishedAt" IS NOT NULL
  )
) OR (
  NEW."status"<>'running' AND (
    NEW."leaseOwner" IS NOT NULL OR NEW."leaseToken" IS NOT NULL
    OR NEW."leaseExpiresAt" IS NOT NULL OR NEW."heartbeatAt" IS NOT NULL
  )
) OR (
  NEW."status" IN ('completed','failed','blocked','ambiguous')
  AND NEW."finishedAt" IS NULL
) OR (
  NEW."status" IN ('prepared','running','interrupted')
  AND NEW."finishedAt" IS NOT NULL
) OR (
  NEW."status"='completed'
  AND (NEW."reportSha256" IS NULL OR NEW."artifactIndexSha256" IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_RUN_LEASE_CONTRACT_INVALID');
END;

CREATE TRIGGER "ProductTruthOperationalRun_time_guard"
BEFORE UPDATE ON "ProductTruthOperationalRun"
WHEN julianday(NEW."updatedAt") IS NULL
  OR julianday(NEW."updatedAt") < julianday(OLD."updatedAt")
  OR (
    NEW."startedAt" IS NOT NULL AND (
      julianday(NEW."startedAt") IS NULL
      OR julianday(NEW."startedAt") < julianday(NEW."createdAt")
    )
  )
  OR (
    NEW."heartbeatAt" IS NOT NULL AND (
      julianday(NEW."heartbeatAt") IS NULL
      OR julianday(NEW."heartbeatAt") < julianday(NEW."startedAt")
      OR (
        OLD."heartbeatAt" IS NOT NULL
        AND julianday(NEW."heartbeatAt") < julianday(OLD."heartbeatAt")
      )
    )
  )
  OR (
    NEW."finishedAt" IS NOT NULL AND (
      julianday(NEW."finishedAt") IS NULL
      OR julianday(NEW."finishedAt") < julianday(NEW."startedAt")
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_RUN_TIME_INVALID');
END;

-- The append-only event trigger is the only legitimate way to advance the
-- chain head. A direct UPDATE cannot detach the run from its journal.
CREATE TRIGGER "ProductTruthOperationalRun_event_chain_head_guard"
BEFORE UPDATE OF "eventChainHead" ON "ProductTruthOperationalRun"
WHEN NEW."eventChainHead" <> OLD."eventChainHead" AND NOT EXISTS (
  SELECT 1
  FROM "ProductTruthOperationalEvent" event
  WHERE event."runId" = OLD."runId"
    AND event."previousHash" = OLD."eventChainHead"
    AND event."eventHash" = NEW."eventChainHead"
    AND event."eventIndex" = (
      SELECT COUNT(*) - 1
      FROM "ProductTruthOperationalEvent" all_events
      WHERE all_events."runId" = OLD."runId"
    )
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_EVENT_CHAIN_HEAD_INVALID');
END;

CREATE TRIGGER "ProductTruthOperationalRun_delete_guard"
BEFORE DELETE ON "ProductTruthOperationalRun"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_RUN_IMMUTABLE');
END;

-- A metered permit for an operational run can be materialized only while the
-- exact sealed run lease is live. Legacy/non-operational runIds remain under
-- the original ledger contract and do not match this trigger's WHEN clause.
CREATE TRIGGER "MeteredProviderBudget_operational_run_guard"
BEFORE INSERT ON "MeteredProviderBudget"
WHEN EXISTS (
  SELECT 1 FROM "ProductTruthOperationalRun" run
  WHERE run."runId" = NEW."runId"
) AND NOT EXISTS (
  SELECT 1
  FROM "ProductTruthOperationalRun" run
  JOIN json_each(run."providerCeilingsJson") ceiling
  WHERE run."runId" = NEW."runId"
    AND run."status" = 'running'
    AND run."approvalId" = NEW."approvalId"
    AND run."leaseToken" IS NOT NULL
    AND julianday(run."leaseExpiresAt") > julianday(CURRENT_TIMESTAMP)
    AND json_extract(ceiling.value, '$.provider') = NEW."provider"
    AND json(json_extract(ceiling.value, '$.operations')) = json(NEW."operations")
    AND json_extract(ceiling.value, '$.maxCalls') = NEW."maxCalls"
    AND (
      (
        json_type(ceiling.value, '$.maxUnits') = 'null'
        AND NEW."maxUnitsMicros" IS NULL
      )
      OR (
        json_type(ceiling.value, '$.maxUnits') IN ('integer','real')
        AND NEW."maxUnitsMicros" = CAST(
          ROUND(json_extract(ceiling.value, '$.maxUnits') * 1000000) AS INTEGER
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'METERED_BUDGET_OPERATIONAL_RUN_MISMATCH');
END;

-- Counter authorization also requires the lease to remain live. This closes
-- the gap between inserting a pending receipt and incrementing its budget.
CREATE TRIGGER "MeteredProviderBudget_operational_counter_guard"
BEFORE UPDATE OF "reservedCalls", "reservedUnitsMicros" ON "MeteredProviderBudget"
WHEN EXISTS (
  SELECT 1 FROM "ProductTruthOperationalRun" run
  WHERE run."runId" = OLD."runId"
) AND NOT EXISTS (
  SELECT 1 FROM "ProductTruthOperationalRun" run
  WHERE run."runId" = OLD."runId"
    AND run."approvalId" = OLD."approvalId"
    AND run."status" = 'running'
    AND run."leaseToken" IS NOT NULL
    AND julianday(run."leaseExpiresAt") > julianday(CURRENT_TIMESTAMP)
)
BEGIN
  SELECT RAISE(ABORT, 'METERED_BUDGET_OPERATIONAL_RUN_NOT_LIVE');
END;

CREATE TRIGGER "MeteredReservationReceipt_operational_run_guard"
BEFORE INSERT ON "MeteredReservationReceipt"
WHEN EXISTS (
  SELECT 1
  FROM "MeteredProviderBudget" budget
  JOIN "ProductTruthOperationalRun" run ON run."runId" = budget."runId"
  WHERE budget."id" = NEW."budgetId"
) AND NOT EXISTS (
  SELECT 1
  FROM "MeteredProviderBudget" budget
  JOIN "ProductTruthOperationalRun" run ON run."runId" = budget."runId"
  WHERE budget."id" = NEW."budgetId"
    AND run."approvalId" = budget."approvalId"
    AND run."status" = 'running'
    AND run."leaseToken" IS NOT NULL
    AND julianday(run."leaseExpiresAt") > julianday(CURRENT_TIMESTAMP)
)
BEGIN
  SELECT RAISE(ABORT, 'METERED_RECEIPT_OPERATIONAL_RUN_NOT_LIVE');
END;

CREATE TRIGGER "MeteredReservationReceipt_operational_authorization_guard"
BEFORE UPDATE OF "status" ON "MeteredReservationReceipt"
WHEN OLD."status" = 'pending' AND NEW."status" = 'reserved'
  AND EXISTS (
    SELECT 1
    FROM "MeteredProviderBudget" budget
    JOIN "ProductTruthOperationalRun" run ON run."runId" = budget."runId"
    WHERE budget."id" = NEW."budgetId"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "MeteredProviderBudget" budget
    JOIN "ProductTruthOperationalRun" run ON run."runId" = budget."runId"
    WHERE budget."id" = NEW."budgetId"
      AND run."approvalId" = budget."approvalId"
      AND run."status" = 'running'
      AND run."leaseToken" IS NOT NULL
      AND julianday(run."leaseExpiresAt") > julianday(CURRENT_TIMESTAMP)
  )
BEGIN
  SELECT RAISE(ABORT, 'METERED_RECEIPT_OPERATIONAL_RUN_NOT_LIVE');
END;

CREATE TABLE "ProductTruthOperationalRunItem" (
  "id" TEXT NOT NULL PRIMARY KEY CHECK (length("id") > 0 AND "id" = trim("id")),
  "runId" TEXT NOT NULL CHECK (length("runId") > 0 AND "runId" = trim("runId")),
  "listingKey" TEXT NOT NULL CHECK (length("listingKey") > 0 AND "listingKey" = trim("listingKey")),
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" >= 0),
  "requestedFields" TEXT NOT NULL CHECK (
    json_valid("requestedFields")
    AND json_type("requestedFields") = 'array'
    AND json_array_length("requestedFields") > 0
  ),
  "queueJobId" TEXT UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'pending'
    CHECK ("status" IN (
      'pending','claimed','reuse_checked','costing','harvesting','verifying',
      'done','terminal_gap','blocked','ambiguous','failed'
    )),
  "stage" TEXT NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0 AND "attempts" <= 1),
  "leaseToken" TEXT,
  "leaseExpiresAt" DATETIME,
  "checkpointJson" TEXT CHECK ("checkpointJson" IS NULL OR json_valid("checkpointJson")),
  "checkpointSha256" TEXT CHECK (
    "checkpointSha256" IS NULL OR (
      length("checkpointSha256") = 64
      AND "checkpointSha256" = lower("checkpointSha256")
      AND "checkpointSha256" NOT GLOB '*[^0-9a-f]*'
    )
  ),
  "resultJson" TEXT CHECK ("resultJson" IS NULL OR json_valid("resultJson")),
  "resultSha256" TEXT CHECK (
    "resultSha256" IS NULL OR (
      length("resultSha256") = 64
      AND "resultSha256" = lower("resultSha256")
      AND "resultSha256" NOT GLOB '*[^0-9a-f]*'
    )
  ),
  "lastError" TEXT,
  "startedAt" DATETIME,
  "finishedAt" DATETIME,
  "createdAt" DATETIME NOT NULL CHECK (julianday("createdAt") IS NOT NULL),
  "updatedAt" DATETIME NOT NULL CHECK (julianday("updatedAt") IS NOT NULL),
  CONSTRAINT "ProductTruthOperationalRunItem_run_fk"
    FOREIGN KEY ("runId") REFERENCES "ProductTruthOperationalRun"("runId")
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "ProductTruthOperationalRunItem_scope_fk"
    FOREIGN KEY ("listingKey") REFERENCES "ProductTruthListingScope"("listingKey")
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "ProductTruthOperationalRunItem_queue_fk"
    FOREIGN KEY ("queueJobId") REFERENCES "EnrichmentJob"("id")
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE ("runId", "listingKey"),
  UNIQUE ("runId", "ordinal")
);

CREATE INDEX "ProductTruthOperationalRunItem_claim_idx"
  ON "ProductTruthOperationalRunItem"("runId", "status", "ordinal");

-- The v1 executor is deliberately sequential. This also prevents a corrupt or
-- duplicated executor from owning two listing attempts in the same run.
CREATE UNIQUE INDEX "ProductTruthOperationalRunItem_one_active_per_run"
  ON "ProductTruthOperationalRunItem"("runId")
  WHERE "status" IN ('claimed','reuse_checked','costing','harvesting','verifying');

CREATE TRIGGER "ProductTruthOperationalRunItem_initial_state_guard"
BEFORE INSERT ON "ProductTruthOperationalRunItem"
WHEN NEW."status" <> 'pending'
  OR NEW."stage" <> 'QUEUED'
  OR NEW."attempts" <> 0
  OR NEW."queueJobId" IS NOT NULL
  OR NEW."leaseToken" IS NOT NULL
  OR NEW."leaseExpiresAt" IS NOT NULL
  OR NEW."checkpointJson" IS NOT NULL
  OR NEW."checkpointSha256" IS NOT NULL
  OR NEW."resultJson" IS NOT NULL
  OR NEW."resultSha256" IS NOT NULL
  OR NEW."lastError" IS NOT NULL
  OR NEW."startedAt" IS NOT NULL
  OR NEW."finishedAt" IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_ITEM_INITIAL_STATE_INVALID');
END;

CREATE TRIGGER "ProductTruthOperationalRunItem_identity_immutable"
BEFORE UPDATE ON "ProductTruthOperationalRunItem"
WHEN NEW."id" <> OLD."id"
  OR NEW."runId" <> OLD."runId"
  OR NEW."listingKey" <> OLD."listingKey"
  OR NEW."ordinal" <> OLD."ordinal"
  OR NEW."requestedFields" <> OLD."requestedFields"
  OR NEW."createdAt" <> OLD."createdAt"
  OR (
    OLD."queueJobId" IS NOT NULL
    AND NEW."queueJobId" IS NOT OLD."queueJobId"
    AND NOT (
      NEW."queueJobId" IS NULL
      AND OLD."status" IN ('claimed','reuse_checked','verifying')
      AND NEW."status"='pending'
      AND OLD."attempts"=0 AND NEW."attempts"=0
      AND OLD."leaseExpiresAt" IS NOT NULL
      AND julianday(OLD."leaseExpiresAt") <= julianday(NEW."updatedAt")
      AND NEW."stage"='QUEUED'
      AND NEW."leaseToken" IS NULL AND NEW."leaseExpiresAt" IS NULL
      AND EXISTS (
        SELECT 1
        FROM "EnrichmentJob" job
        JOIN "ProductTruthOperationalRun" run ON run."runId"=OLD."runId"
        WHERE job."id"=OLD."queueJobId"
          AND job."targetType"='sku'
          AND job."listingKey"=OLD."listingKey"
          AND job."runId"=OLD."runId"
          AND job."approvalId"=run."approvalId"
          AND job."status"='cancelled'
          AND job."attempts"=0
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_ITEM_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER "ProductTruthOperationalRunItem_attempt_guard"
BEFORE UPDATE ON "ProductTruthOperationalRunItem"
WHEN NEW."attempts" <> OLD."attempts" AND NOT (
  OLD."status" = 'reuse_checked'
  AND NEW."status" = 'costing'
  AND OLD."attempts" = 0
  AND NEW."attempts" = 1
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_ITEM_ATTEMPT_INVALID');
END;

-- Crossing into `costing` is the single execution-attempt boundary. The exact
-- queue row must already own its one lease and carry the same sealed
-- run/approval/listing identity; otherwise no paid-capable stage may begin.
CREATE TRIGGER "ProductTruthOperationalRunItem_attempt_queue_guard"
BEFORE UPDATE OF "status" ON "ProductTruthOperationalRunItem"
WHEN NEW."status" = 'costing' AND OLD."status" <> 'costing' AND NOT EXISTS (
  SELECT 1
  FROM "EnrichmentJob" job
  JOIN "ProductTruthOperationalRun" run ON run."runId" = NEW."runId"
  JOIN "ProductTruthListingScope" scope ON scope."listingKey" = NEW."listingKey"
  WHERE job."id" = NEW."queueJobId"
    AND job."targetType" = 'sku'
    AND job."target" = scope."sku"
    AND job."listingKey" = NEW."listingKey"
    AND job."runId" = NEW."runId"
    AND job."approvalId" = run."approvalId"
    AND job."status" = 'running'
    AND job."attempts" = 1
    AND job."leaseToken" IS NOT NULL
    AND julianday(job."leaseExpiresAt") > julianday(NEW."updatedAt")
    AND run."status" = 'running'
    AND run."leaseToken" IS NOT NULL
    AND julianday(run."leaseExpiresAt") > julianday(NEW."updatedAt")
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_ITEM_QUEUE_ATTEMPT_REQUIRED');
END;

CREATE TRIGGER "ProductTruthOperationalRunItem_status_transition_guard"
BEFORE UPDATE OF "status" ON "ProductTruthOperationalRunItem"
WHEN NEW."status" <> OLD."status" AND NOT (
  (OLD."status"='pending' AND NEW."status"='claimed')
  OR (OLD."status"='claimed' AND NEW."status" IN ('reuse_checked','blocked','ambiguous','failed'))
  OR (OLD."status"='reuse_checked' AND NEW."status" IN ('costing','verifying','blocked','ambiguous','failed'))
  OR (OLD."status"='costing' AND NEW."status" IN ('harvesting','verifying','terminal_gap','blocked','ambiguous','failed'))
  OR (OLD."status"='harvesting' AND NEW."status" IN ('verifying','terminal_gap','blocked','ambiguous','failed'))
  OR (OLD."status"='verifying' AND NEW."status" IN ('done','terminal_gap','blocked','ambiguous','failed'))
  OR (
    OLD."status" IN ('claimed','reuse_checked','verifying')
    AND NEW."status"='pending'
    AND OLD."attempts"=0
    AND OLD."leaseExpiresAt" IS NOT NULL
    AND julianday(OLD."leaseExpiresAt") <= julianday(NEW."updatedAt")
    AND NEW."stage"='QUEUED'
    AND NEW."leaseToken" IS NULL
    AND NEW."leaseExpiresAt" IS NULL
    AND NEW."startedAt" IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_ITEM_STATUS_INVALID');
END;

CREATE TRIGGER "ProductTruthOperationalRunItem_terminal_guard"
BEFORE UPDATE ON "ProductTruthOperationalRunItem"
WHEN (
  NEW."status" IN ('done','terminal_gap','blocked','ambiguous','failed')
  AND NEW."finishedAt" IS NULL
) OR (
  NEW."status" IN ('done','terminal_gap')
  AND (NEW."resultJson" IS NULL OR NEW."resultSha256" IS NULL)
) OR (
  NEW."status" IN ('claimed','reuse_checked','costing','harvesting','verifying')
  AND (NEW."leaseToken" IS NULL OR NEW."leaseExpiresAt" IS NULL)
) OR (
  NEW."status" NOT IN ('claimed','reuse_checked','costing','harvesting','verifying')
  AND (NEW."leaseToken" IS NOT NULL OR NEW."leaseExpiresAt" IS NOT NULL)
) OR (
  NEW."status" IN ('claimed','reuse_checked','costing','harvesting','verifying')
  AND julianday(NEW."leaseExpiresAt") <= julianday(NEW."updatedAt")
) OR (
  (NEW."checkpointJson" IS NULL) <> (NEW."checkpointSha256" IS NULL)
) OR (
  (NEW."resultJson" IS NULL) <> (NEW."resultSha256" IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_ITEM_TERMINAL_CONTRACT_INVALID');
END;

CREATE TRIGGER "ProductTruthOperationalRunItem_time_guard"
BEFORE UPDATE ON "ProductTruthOperationalRunItem"
WHEN julianday(NEW."updatedAt") IS NULL
  OR julianday(NEW."updatedAt") < julianday(OLD."updatedAt")
  OR (
    NEW."startedAt" IS NOT NULL AND (
      julianday(NEW."startedAt") IS NULL
      OR julianday(NEW."startedAt") < julianday(NEW."createdAt")
    )
  )
  OR (
    NEW."finishedAt" IS NOT NULL AND (
      julianday(NEW."finishedAt") IS NULL
      OR julianday(NEW."finishedAt") < julianday(NEW."startedAt")
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_ITEM_TIME_INVALID');
END;

CREATE TRIGGER "ProductTruthOperationalRunItem_queue_scope_guard"
BEFORE UPDATE OF "queueJobId" ON "ProductTruthOperationalRunItem"
WHEN NEW."queueJobId" IS NOT OLD."queueJobId" AND NOT (
  (
    OLD."queueJobId" IS NULL
    AND NEW."queueJobId" IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM "EnrichmentJob" job
      WHERE job."id" = NEW."queueJobId"
        AND job."targetType" = 'sku'
        AND job."listingKey" = NEW."listingKey"
    )
  )
  OR (
    OLD."queueJobId" IS NOT NULL
    AND NEW."queueJobId" IS NULL
    AND OLD."status" IN ('claimed','reuse_checked','verifying')
    AND NEW."status"='pending'
    AND OLD."attempts"=0 AND NEW."attempts"=0
    AND OLD."leaseExpiresAt" IS NOT NULL
    AND julianday(OLD."leaseExpiresAt") <= julianday(NEW."updatedAt")
    AND NEW."stage"='QUEUED'
    AND NEW."leaseToken" IS NULL AND NEW."leaseExpiresAt" IS NULL
    AND EXISTS (
      SELECT 1
      FROM "EnrichmentJob" job
      JOIN "ProductTruthOperationalRun" run ON run."runId"=OLD."runId"
      WHERE job."id"=OLD."queueJobId"
        AND job."targetType"='sku'
        AND job."listingKey"=OLD."listingKey"
        AND job."runId"=OLD."runId"
        AND job."approvalId"=run."approvalId"
        AND job."status"='cancelled'
        AND job."attempts"=0
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_ITEM_QUEUE_SCOPE_INVALID');
END;

CREATE TRIGGER "ProductTruthOperationalRunItem_delete_guard"
BEFORE DELETE ON "ProductTruthOperationalRunItem"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_ITEM_IMMUTABLE');
END;

CREATE TABLE "ProductTruthOperationalEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "eventIndex" INTEGER NOT NULL CHECK ("eventIndex" >= 0),
  "eventType" TEXT NOT NULL,
  "itemId" TEXT,
  "previousHash" TEXT NOT NULL CHECK (
    length("previousHash") = 64
    AND "previousHash" = lower("previousHash")
    AND "previousHash" NOT GLOB '*[^0-9a-f]*'
  ),
  "payloadJson" TEXT NOT NULL CHECK (json_valid("payloadJson")),
  "payloadSha256" TEXT NOT NULL CHECK (
    length("payloadSha256") = 64
    AND "payloadSha256" = lower("payloadSha256")
    AND "payloadSha256" NOT GLOB '*[^0-9a-f]*'
  ),
  "eventHash" TEXT NOT NULL UNIQUE CHECK (
    length("eventHash") = 64
    AND "eventHash" = lower("eventHash")
    AND "eventHash" NOT GLOB '*[^0-9a-f]*'
  ),
  "createdAt" DATETIME NOT NULL CHECK (julianday("createdAt") IS NOT NULL),
  CONSTRAINT "ProductTruthOperationalEvent_run_fk"
    FOREIGN KEY ("runId") REFERENCES "ProductTruthOperationalRun"("runId")
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "ProductTruthOperationalEvent_item_fk"
    FOREIGN KEY ("itemId") REFERENCES "ProductTruthOperationalRunItem"("id")
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE ("runId", "eventIndex")
);

CREATE INDEX "ProductTruthOperationalEvent_run_idx"
  ON "ProductTruthOperationalEvent"("runId", "eventIndex");

CREATE TRIGGER "ProductTruthOperationalEvent_chain_guard"
BEFORE INSERT ON "ProductTruthOperationalEvent"
WHEN NOT EXISTS (
  SELECT 1 FROM "ProductTruthOperationalRun" run
  WHERE run."runId"=NEW."runId"
    AND run."eventChainHead"=NEW."previousHash"
    AND NEW."eventIndex"=(
      SELECT COUNT(*) FROM "ProductTruthOperationalEvent" event
      WHERE event."runId"=NEW."runId"
    )
    AND julianday(NEW."createdAt") >= julianday(run."updatedAt")
) OR (
  NEW."itemId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ProductTruthOperationalRunItem" item
    WHERE item."id"=NEW."itemId" AND item."runId"=NEW."runId"
  )
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_EVENT_CHAIN_INVALID');
END;

CREATE TRIGGER "ProductTruthOperationalEvent_advance_chain"
AFTER INSERT ON "ProductTruthOperationalEvent"
BEGIN
  UPDATE "ProductTruthOperationalRun"
  SET "eventChainHead"=NEW."eventHash", "updatedAt"=NEW."createdAt"
  WHERE "runId"=NEW."runId" AND "eventChainHead"=NEW."previousHash";
END;

CREATE TRIGGER "ProductTruthOperationalEvent_update_guard"
BEFORE UPDATE ON "ProductTruthOperationalEvent"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_EVENT_IMMUTABLE');
END;

CREATE TRIGGER "ProductTruthOperationalEvent_delete_guard"
BEFORE DELETE ON "ProductTruthOperationalEvent"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_OPERATIONAL_EVENT_IMMUTABLE');
END;
