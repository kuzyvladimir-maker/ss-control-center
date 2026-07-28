-- Product Truth Web Operations Stage A.
--
-- This is an SS Command Center control-plane migration, not a ninth migration
-- in the frozen exact-eight Product Truth business-data schema. Stage A creates
-- only durable command/artifact/event custody. Runtime remains hardcoded OFF;
-- this migration is not applied to production by code or by its presence here.

CREATE TABLE "ProductTruthControlCommand" (
    "commandId" TEXT NOT NULL PRIMARY KEY,
    "schemaVersion" TEXT NOT NULL,
    "commandKind" TEXT NOT NULL,
    "gateClass" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "idempotencyKey" TEXT NOT NULL,
    "requestSha256" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "requestedAt" DATETIME NOT NULL,
    "engineReleaseId" TEXT NOT NULL,
    "engineCommitSha" TEXT NOT NULL,
    "engineTreeSha" TEXT NOT NULL,
    "executableTreeSha256" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "databaseTargetFingerprint" TEXT NOT NULL,
    "manifestSha256" TEXT NOT NULL,
    "runId" TEXT,
    "planSha256" TEXT,
    "approvalId" TEXT,
    "requestArtifactId" TEXT,
    "planArtifactId" TEXT,
    "approvalArtifactId" TEXT,
    "permitArtifactId" TEXT,
    "balanceArtifactId" TEXT,
    "resultArtifactId" TEXT,
    "artifactIndexArtifactId" TEXT,
    "reportArtifactId" TEXT,
    "zeroAttemptEvidenceArtifactId" TEXT,
    "ownerKeyId" TEXT,
    "ownerNonce" TEXT,
    "ownerSignatureSha256" TEXT,
    "ownerAuthorizedAt" DATETIME,
    "ownerAuthorizationExpiresAt" DATETIME,
    "workerLeaseOwner" TEXT,
    "workerLeaseTokenSha256" TEXT,
    "workerLeaseExpiresAt" DATETIME,
    "workerHeartbeatAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "executionStartedAt" DATETIME,
    "executionBoundary" TEXT,
    "exitCode" INTEGER,
    "outcome" TEXT,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductTruthControlCommand_schemaVersion_check"
      CHECK ("schemaVersion" = 'product-truth-control-command/1.0.0'),
    CONSTRAINT "ProductTruthControlCommand_kind_check"
      CHECK ("commandKind" IN (
        'DOCTOR','READINESS','STATUS','REPORT','CENSUS_CAPTURE',
        'MANIFEST_COMPILE','MIGRATIONS_PLAN','BACKFILL_PLAN','RUN_PLAN',
        'MIGRATIONS_APPLY','BACKFILL_APPLY','EXECUTE','RESUME'
      )),
    CONSTRAINT "ProductTruthControlCommand_gateClass_check"
      CHECK ("gateClass" IN (
        'READ_ONLY','ARTIFACT_PLAN','DB_WRITE','METERED_EXECUTE'
      )),
    CONSTRAINT "ProductTruthControlCommand_status_check"
      CHECK ("status" IN (
        'DRAFT','VALIDATING','BLOCKED','AWAITING_OWNER','ADMITTED',
        'CLAIMED','RUNNING','SUCCEEDED','FAILED','AMBIGUOUS','CANCELLED'
      )),
    CONSTRAINT "ProductTruthControlCommand_environment_check"
      CHECK ("environment" IN ('LOCAL','STAGING','PRODUCTION')),
    CONSTRAINT "ProductTruthControlCommand_hashes_check"
      CHECK (
        length("requestSha256") = 64
        AND "requestSha256" NOT GLOB '*[^0-9a-f]*'
        AND length("engineCommitSha") = 40
        AND "engineCommitSha" NOT GLOB '*[^0-9a-f]*'
        AND length("engineTreeSha") = 40
        AND "engineTreeSha" NOT GLOB '*[^0-9a-f]*'
        AND length("executableTreeSha256") = 64
        AND "executableTreeSha256" NOT GLOB '*[^0-9a-f]*'
        AND length("databaseTargetFingerprint") = 64
        AND "databaseTargetFingerprint" NOT GLOB '*[^0-9a-f]*'
        AND length("manifestSha256") = 64
        AND "manifestSha256" NOT GLOB '*[^0-9a-f]*'
        AND ("planSha256" IS NULL OR (
          length("planSha256") = 64
          AND "planSha256" NOT GLOB '*[^0-9a-f]*'
        ))
        AND ("ownerSignatureSha256" IS NULL OR (
          length("ownerSignatureSha256") = 64
          AND "ownerSignatureSha256" NOT GLOB '*[^0-9a-f]*'
        ))
        AND ("workerLeaseTokenSha256" IS NULL OR (
          length("workerLeaseTokenSha256") = 64
          AND "workerLeaseTokenSha256" NOT GLOB '*[^0-9a-f]*'
        ))
      ),
    CONSTRAINT "ProductTruthControlCommand_attempts_check"
      CHECK (
        "attempts" >= 0
        AND "maxAttempts" = 1
        AND "attempts" <= "maxAttempts"
      ),
    CONSTRAINT "ProductTruthControlCommand_read_authority_check"
      CHECK (
        "gateClass" IN ('DB_WRITE','METERED_EXECUTE')
        OR (
          "ownerKeyId" IS NULL
          AND "ownerNonce" IS NULL
          AND "ownerSignatureSha256" IS NULL
          AND "ownerAuthorizedAt" IS NULL
          AND "ownerAuthorizationExpiresAt" IS NULL
        )
      ),
    CONSTRAINT "ProductTruthControlCommand_kind_gate_check"
      CHECK (
        ("commandKind" IN ('DOCTOR','READINESS','STATUS','REPORT')
          AND "gateClass" = 'READ_ONLY')
        OR
        ("commandKind" IN (
          'CENSUS_CAPTURE','MANIFEST_COMPILE','MIGRATIONS_PLAN',
          'BACKFILL_PLAN','RUN_PLAN'
        ) AND "gateClass" = 'ARTIFACT_PLAN')
        OR
        ("commandKind" IN ('MIGRATIONS_APPLY','BACKFILL_APPLY')
          AND "gateClass" = 'DB_WRITE')
        OR
        ("commandKind" IN ('EXECUTE','RESUME')
          AND "gateClass" = 'METERED_EXECUTE')
      )
);

CREATE UNIQUE INDEX "ProductTruthControlCommand_idempotencyKey_key"
  ON "ProductTruthControlCommand"("idempotencyKey");
CREATE UNIQUE INDEX "ProductTruthControlCommand_requestSha256_key"
  ON "ProductTruthControlCommand"("requestSha256");
CREATE UNIQUE INDEX "ProductTruthControlCommand_ownerNonce_key"
  ON "ProductTruthControlCommand"("ownerNonce");
CREATE INDEX "ProductTruthControlCommand_status_requestedAt_idx"
  ON "ProductTruthControlCommand"("status", "requestedAt");
CREATE INDEX "ProductTruthControlCommand_leaseExpiresAt_idx"
  ON "ProductTruthControlCommand"("workerLeaseExpiresAt");
CREATE INDEX "ProductTruthControlCommand_kind_status_idx"
  ON "ProductTruthControlCommand"("commandKind", "status");

CREATE TRIGGER "ProductTruthControlCommand_immutable_identity_update_guard"
BEFORE UPDATE ON "ProductTruthControlCommand"
WHEN
  NEW."commandId" IS NOT OLD."commandId"
  OR NEW."schemaVersion" IS NOT OLD."schemaVersion"
  OR NEW."commandKind" IS NOT OLD."commandKind"
  OR NEW."gateClass" IS NOT OLD."gateClass"
  OR NEW."idempotencyKey" IS NOT OLD."idempotencyKey"
  OR NEW."requestSha256" IS NOT OLD."requestSha256"
  OR NEW."requestedByUserId" IS NOT OLD."requestedByUserId"
  OR NEW."requestedAt" IS NOT OLD."requestedAt"
  OR NEW."engineReleaseId" IS NOT OLD."engineReleaseId"
  OR NEW."engineCommitSha" IS NOT OLD."engineCommitSha"
  OR NEW."engineTreeSha" IS NOT OLD."engineTreeSha"
  OR NEW."executableTreeSha256" IS NOT OLD."executableTreeSha256"
  OR NEW."environment" IS NOT OLD."environment"
  OR NEW."databaseTargetFingerprint" IS NOT OLD."databaseTargetFingerprint"
  OR NEW."manifestSha256" IS NOT OLD."manifestSha256"
BEGIN
  SELECT RAISE(ABORT, 'ProductTruthControlCommand identity is immutable');
END;

CREATE TRIGGER "ProductTruthControlCommand_terminal_update_guard"
BEFORE UPDATE ON "ProductTruthControlCommand"
WHEN OLD."status" IN ('BLOCKED','SUCCEEDED','FAILED','AMBIGUOUS','CANCELLED')
BEGIN
  SELECT RAISE(ABORT, 'ProductTruthControlCommand terminal state is immutable');
END;

CREATE TRIGGER "ProductTruthControlCommand_transition_guard"
BEFORE UPDATE OF "status" ON "ProductTruthControlCommand"
WHEN NEW."status" IS NOT OLD."status"
  AND NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('VALIDATING','CANCELLED'))
    OR (OLD."status" = 'VALIDATING' AND NEW."status" IN ('BLOCKED','CANCELLED'))
    OR (
      OLD."status" = 'VALIDATING'
      AND NEW."status" = 'ADMITTED'
      AND OLD."gateClass" IN ('READ_ONLY','ARTIFACT_PLAN')
    )
    OR (
      OLD."status" = 'VALIDATING'
      AND NEW."status" = 'AWAITING_OWNER'
      AND OLD."gateClass" IN ('DB_WRITE','METERED_EXECUTE')
    )
    OR (OLD."status" = 'AWAITING_OWNER' AND NEW."status" = 'CANCELLED')
    OR (
      OLD."status" = 'AWAITING_OWNER'
      AND NEW."status" = 'ADMITTED'
      AND NEW."ownerKeyId" IS NOT NULL
      AND NEW."ownerNonce" IS NOT NULL
      AND NEW."ownerSignatureSha256" IS NOT NULL
      AND NEW."ownerAuthorizedAt" IS NOT NULL
      AND NEW."ownerAuthorizationExpiresAt" IS NOT NULL
      AND NEW."ownerAuthorizationExpiresAt" > CURRENT_TIMESTAMP
    )
    OR (OLD."status" = 'ADMITTED' AND NEW."status" = 'CANCELLED')
    OR (
      OLD."status" = 'ADMITTED'
      AND NEW."status" = 'CLAIMED'
      AND NEW."workerLeaseOwner" IS NOT NULL
      AND NEW."workerLeaseTokenSha256" IS NOT NULL
      AND NEW."workerLeaseExpiresAt" IS NOT NULL
      AND NEW."workerLeaseExpiresAt" > CURRENT_TIMESTAMP
      AND NEW."attempts" = 0
      AND NEW."executionBoundary" IS NULL
    )
    OR (
      OLD."status" = 'CLAIMED'
      AND NEW."status" = 'RUNNING'
      AND NEW."attempts" = OLD."attempts" + 1
      AND NEW."executionBoundary" IS NOT NULL
      AND NEW."executionStartedAt" IS NOT NULL
    )
    OR (
      OLD."status" IN ('CLAIMED','RUNNING')
      AND NEW."status" = 'AMBIGUOUS'
      AND NEW."executionBoundary" = 'UNKNOWN'
    )
    OR (
      OLD."status" = 'CLAIMED'
      AND NEW."status" = 'ADMITTED'
      AND OLD."attempts" = 0
      AND OLD."executionBoundary" IS NULL
      AND OLD."workerLeaseExpiresAt" IS NOT NULL
      AND OLD."workerLeaseExpiresAt" < CURRENT_TIMESTAMP
      AND NEW."zeroAttemptEvidenceArtifactId" IS NOT NULL
    )
    OR (OLD."status" = 'RUNNING' AND NEW."status" IN ('SUCCEEDED','FAILED'))
  )
BEGIN
  SELECT RAISE(ABORT, 'ProductTruthControlCommand transition is not permitted');
END;

CREATE TRIGGER "ProductTruthControlCommand_attempt_guard"
BEFORE UPDATE ON "ProductTruthControlCommand"
WHEN
  NEW."attempts" < OLD."attempts"
  OR NEW."attempts" > OLD."attempts" + 1
  OR (
    NEW."attempts" = OLD."attempts" + 1
    AND (
      OLD."status" <> 'CLAIMED'
      OR NEW."status" <> 'RUNNING'
      OR
      OLD."executionBoundary" IS NOT NULL
      OR NEW."executionBoundary" IS NULL
      OR NEW."executionStartedAt" IS NULL
    )
  )
  OR (
    OLD."executionBoundary" IS NOT NULL
    AND NEW."executionBoundary" IS NOT OLD."executionBoundary"
  )
BEGIN
  SELECT RAISE(ABORT, 'ProductTruthControlCommand attempt boundary is invalid');
END;

CREATE TRIGGER "ProductTruthControlCommand_owner_authority_update_guard"
BEFORE UPDATE ON "ProductTruthControlCommand"
WHEN OLD."ownerKeyId" IS NOT NULL
  AND (
    NEW."ownerKeyId" IS NOT OLD."ownerKeyId"
    OR NEW."ownerNonce" IS NOT OLD."ownerNonce"
    OR NEW."ownerSignatureSha256" IS NOT OLD."ownerSignatureSha256"
    OR NEW."ownerAuthorizedAt" IS NOT OLD."ownerAuthorizedAt"
    OR NEW."ownerAuthorizationExpiresAt" IS NOT OLD."ownerAuthorizationExpiresAt"
  )
BEGIN
  SELECT RAISE(ABORT, 'ProductTruthControlCommand owner authority is immutable');
END;

CREATE TRIGGER "ProductTruthControlCommand_delete_guard"
BEFORE DELETE ON "ProductTruthControlCommand"
BEGIN
  SELECT RAISE(ABORT, 'ProductTruthControlCommand cannot be deleted');
END;

CREATE TABLE "ProductTruthControlArtifact" (
    "artifactId" TEXT NOT NULL PRIMARY KEY,
    "commandId" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "content" BLOB NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "locator" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "createdByPrincipal" TEXT NOT NULL,
    CONSTRAINT "ProductTruthControlArtifact_commandId_fkey"
      FOREIGN KEY ("commandId") REFERENCES "ProductTruthControlCommand" ("commandId")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ProductTruthControlArtifact_schema_check"
      CHECK ("schemaVersion" = 'product-truth-control-artifact/1.0.0'),
    CONSTRAINT "ProductTruthControlArtifact_role_check"
      CHECK ("role" IN (
        'REQUEST','CENSUS_CAPTURE','OWNER_DISPOSITION','SOURCE_REPORT',
        'MANIFEST','MIGRATION_PLAN','MIGRATION_CERTIFICATION','BACKFILL_PLAN',
        'RUN_PLAN','OWNER_APPROVAL','PROVIDER_PERMIT','BALANCE_EVIDENCE',
        'RESULT','REPORT','ARTIFACT_INDEX'
      )),
    CONSTRAINT "ProductTruthControlArtifact_bytes_check"
      CHECK (
        "byteSize" > 0
        AND "byteSize" <= 4194304
        AND length("content") = "byteSize"
        AND length("sha256") = 64
        AND "sha256" NOT GLOB '*[^0-9a-f]*'
      )
);

CREATE UNIQUE INDEX "ProductTruthControlArtifact_command_role_sha_key"
  ON "ProductTruthControlArtifact"("commandId", "role", "sha256");
CREATE UNIQUE INDEX "ProductTruthControlArtifact_locator_key"
  ON "ProductTruthControlArtifact"("locator");
CREATE INDEX "ProductTruthControlArtifact_command_created_idx"
  ON "ProductTruthControlArtifact"("commandId", "createdAt");

CREATE TRIGGER "ProductTruthControlArtifact_duplicate_insert_guard"
BEFORE INSERT ON "ProductTruthControlArtifact"
WHEN EXISTS (
  SELECT 1 FROM "ProductTruthControlArtifact"
  WHERE "artifactId" = NEW."artifactId"
     OR "locator" = NEW."locator"
     OR (
       "commandId" = NEW."commandId"
       AND "role" = NEW."role"
       AND "sha256" = NEW."sha256"
     )
)
BEGIN
  SELECT RAISE(ABORT, 'ProductTruthControlArtifact duplicate insert is forbidden');
END;

CREATE TRIGGER "ProductTruthControlArtifact_update_guard"
BEFORE UPDATE ON "ProductTruthControlArtifact"
BEGIN
  SELECT RAISE(ABORT, 'ProductTruthControlArtifact is append-only');
END;

CREATE TRIGGER "ProductTruthControlArtifact_delete_guard"
BEFORE DELETE ON "ProductTruthControlArtifact"
BEGIN
  SELECT RAISE(ABORT, 'ProductTruthControlArtifact is append-only');
END;

CREATE TABLE "ProductTruthControlEvent" (
    "eventId" TEXT NOT NULL PRIMARY KEY,
    "commandId" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL,
    "payload" BLOB NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "previousEventHash" TEXT NOT NULL,
    "eventHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductTruthControlEvent_commandId_fkey"
      FOREIGN KEY ("commandId") REFERENCES "ProductTruthControlCommand" ("commandId")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ProductTruthControlEvent_schema_check"
      CHECK ("schemaVersion" = 'product-truth-control-event/1.0.0'),
    CONSTRAINT "ProductTruthControlEvent_type_check"
      CHECK ("eventType" IN (
        'REQUESTED','ARTIFACTS_VALIDATED','AWAITING_OWNER','OWNER_VERIFIED',
        'ADMITTED','CLAIMED','HEARTBEAT','EXECUTION_BOUNDARY',
        'ARTIFACT_RECEIVED','SUCCEEDED','FAILED','AMBIGUOUS',
        'CANCELLED_BEFORE_EXECUTION'
      )),
    CONSTRAINT "ProductTruthControlEvent_source_check"
      CHECK ("source" IN ('SERVER','OWNER_VERIFIER','WORKER')),
    CONSTRAINT "ProductTruthControlEvent_integrity_check"
      CHECK (
        "sequence" > 0
        AND length("payload") > 0
        AND length("payload") <= 4194304
        AND length("payloadSha256") = 64
        AND "payloadSha256" NOT GLOB '*[^0-9a-f]*'
        AND length("previousEventHash") = 64
        AND "previousEventHash" NOT GLOB '*[^0-9a-f]*'
        AND length("eventHash") = 64
        AND "eventHash" NOT GLOB '*[^0-9a-f]*'
      )
);

CREATE UNIQUE INDEX "ProductTruthControlEvent_command_sequence_key"
  ON "ProductTruthControlEvent"("commandId", "sequence");
CREATE UNIQUE INDEX "ProductTruthControlEvent_eventHash_key"
  ON "ProductTruthControlEvent"("eventHash");
CREATE INDEX "ProductTruthControlEvent_command_occurred_idx"
  ON "ProductTruthControlEvent"("commandId", "occurredAt");

CREATE TRIGGER "ProductTruthControlEvent_chain_insert_guard"
BEFORE INSERT ON "ProductTruthControlEvent"
WHEN
  NEW."sequence" IS NOT (
    SELECT COALESCE(MAX("sequence"), 0) + 1
    FROM "ProductTruthControlEvent"
    WHERE "commandId" = NEW."commandId"
  )
  OR NEW."previousEventHash" IS NOT COALESCE(
    (
      SELECT "eventHash"
      FROM "ProductTruthControlEvent"
      WHERE "commandId" = NEW."commandId"
      ORDER BY "sequence" DESC
      LIMIT 1
    ),
    '0000000000000000000000000000000000000000000000000000000000000000'
  )
BEGIN
  SELECT RAISE(ABORT, 'ProductTruthControlEvent chain advance is invalid');
END;

CREATE TRIGGER "ProductTruthControlEvent_duplicate_insert_guard"
BEFORE INSERT ON "ProductTruthControlEvent"
WHEN EXISTS (
  SELECT 1 FROM "ProductTruthControlEvent"
  WHERE "eventId" = NEW."eventId"
     OR "eventHash" = NEW."eventHash"
     OR (
       "commandId" = NEW."commandId"
       AND "sequence" = NEW."sequence"
     )
)
BEGIN
  SELECT RAISE(ABORT, 'ProductTruthControlEvent duplicate insert is forbidden');
END;

CREATE TRIGGER "ProductTruthControlEvent_update_guard"
BEFORE UPDATE ON "ProductTruthControlEvent"
BEGIN
  SELECT RAISE(ABORT, 'ProductTruthControlEvent is append-only');
END;

CREATE TRIGGER "ProductTruthControlEvent_delete_guard"
BEFORE DELETE ON "ProductTruthControlEvent"
BEGIN
  SELECT RAISE(ABORT, 'ProductTruthControlEvent is append-only');
END;
