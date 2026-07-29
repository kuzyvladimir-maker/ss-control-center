-- Extend the SS Command Center Product Truth control queue for the one fixed,
-- pinned standing-wave workflow. This is not a Product Truth business-data
-- migration and does not change the canonical Product Truth table set.
--
-- SQLite cannot alter CHECK constraints in place, so the command table is
-- rebuilt byte-for-column while artifact/event custody remains untouched.

PRAGMA foreign_keys=OFF;

CREATE TABLE "new_ProductTruthControlCommand" (
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
      CHECK ("schemaVersion" IN (
        'product-truth-control-command/1.0.0',
        'product-truth-standing-wave-web-request/1.0.0'
      )),
    CONSTRAINT "ProductTruthControlCommand_kind_check"
      CHECK ("commandKind" IN (
        'DOCTOR','READINESS','STATUS','REPORT','CENSUS_CAPTURE',
        'MANIFEST_COMPILE','MIGRATIONS_PLAN','BACKFILL_PLAN','RUN_PLAN',
        'MIGRATIONS_APPLY','BACKFILL_APPLY','EXECUTE','RESUME',
        'STANDING_WAVE'
      )),
    CONSTRAINT "ProductTruthControlCommand_gateClass_check"
      CHECK ("gateClass" IN (
        'READ_ONLY','ARTIFACT_PLAN','DB_WRITE','METERED_EXECUTE',
        'STANDING_METERED_EXECUTE'
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
        OR
        ("commandKind" = 'STANDING_WAVE'
          AND "gateClass" = 'STANDING_METERED_EXECUTE')
      )
);

INSERT INTO "new_ProductTruthControlCommand" (
  "commandId","schemaVersion","commandKind","gateClass","status",
  "idempotencyKey","requestSha256","requestedByUserId","requestedAt",
  "engineReleaseId","engineCommitSha","engineTreeSha",
  "executableTreeSha256","environment","databaseTargetFingerprint",
  "manifestSha256","runId","planSha256","approvalId","requestArtifactId",
  "planArtifactId","approvalArtifactId","permitArtifactId",
  "balanceArtifactId","resultArtifactId","artifactIndexArtifactId",
  "reportArtifactId","zeroAttemptEvidenceArtifactId","ownerKeyId",
  "ownerNonce","ownerSignatureSha256","ownerAuthorizedAt",
  "ownerAuthorizationExpiresAt","workerLeaseOwner",
  "workerLeaseTokenSha256","workerLeaseExpiresAt","workerHeartbeatAt",
  "attempts","maxAttempts","executionStartedAt","executionBoundary",
  "exitCode","outcome","errorCode","createdAt","updatedAt"
)
SELECT
  "commandId","schemaVersion","commandKind","gateClass","status",
  "idempotencyKey","requestSha256","requestedByUserId","requestedAt",
  "engineReleaseId","engineCommitSha","engineTreeSha",
  "executableTreeSha256","environment","databaseTargetFingerprint",
  "manifestSha256","runId","planSha256","approvalId","requestArtifactId",
  "planArtifactId","approvalArtifactId","permitArtifactId",
  "balanceArtifactId","resultArtifactId","artifactIndexArtifactId",
  "reportArtifactId","zeroAttemptEvidenceArtifactId","ownerKeyId",
  "ownerNonce","ownerSignatureSha256","ownerAuthorizedAt",
  "ownerAuthorizationExpiresAt","workerLeaseOwner",
  "workerLeaseTokenSha256","workerLeaseExpiresAt","workerHeartbeatAt",
  "attempts","maxAttempts","executionStartedAt","executionBoundary",
  "exitCode","outcome","errorCode","createdAt","updatedAt"
FROM "ProductTruthControlCommand";

DROP TABLE "ProductTruthControlCommand";
ALTER TABLE "new_ProductTruthControlCommand"
  RENAME TO "ProductTruthControlCommand";

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

CREATE TRIGGER "ProductTruthControlCommand_standing_single_active_insert_guard"
BEFORE INSERT ON "ProductTruthControlCommand"
WHEN NEW."commandKind" = 'STANDING_WAVE'
  AND NEW."status" IN ('ADMITTED','CLAIMED','RUNNING')
  AND EXISTS (
    SELECT 1
    FROM "ProductTruthControlCommand"
    WHERE "commandKind" = 'STANDING_WAVE'
      AND "status" IN ('ADMITTED','CLAIMED','RUNNING')
  )
BEGIN
  SELECT RAISE(ABORT, 'Only one standing wave may be active');
END;

CREATE TRIGGER "ProductTruthControlCommand_standing_single_active_update_guard"
BEFORE UPDATE OF "status" ON "ProductTruthControlCommand"
WHEN NEW."commandKind" = 'STANDING_WAVE'
  AND NEW."status" IN ('ADMITTED','CLAIMED','RUNNING')
  AND EXISTS (
    SELECT 1
    FROM "ProductTruthControlCommand"
    WHERE "commandKind" = 'STANDING_WAVE'
      AND "status" IN ('ADMITTED','CLAIMED','RUNNING')
      AND "commandId" <> NEW."commandId"
  )
BEGIN
  SELECT RAISE(ABORT, 'Only one standing wave may be active');
END;

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
      AND OLD."gateClass" IN (
        'READ_ONLY','ARTIFACT_PLAN','STANDING_METERED_EXECUTE'
      )
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
      AND julianday(NEW."ownerAuthorizationExpiresAt")
        > julianday(CURRENT_TIMESTAMP)
    )
    OR (OLD."status" = 'ADMITTED' AND NEW."status" = 'CANCELLED')
    OR (
      OLD."status" = 'ADMITTED'
      AND NEW."status" = 'CLAIMED'
      AND NEW."workerLeaseOwner" IS NOT NULL
      AND NEW."workerLeaseTokenSha256" IS NOT NULL
      AND NEW."workerLeaseExpiresAt" IS NOT NULL
      AND julianday(NEW."workerLeaseExpiresAt") > julianday(CURRENT_TIMESTAMP)
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
      OLD."status" = 'CLAIMED'
      AND NEW."status" = 'AMBIGUOUS'
      AND NEW."executionBoundary" = 'UNKNOWN'
    )
    OR (
      OLD."status" = 'CLAIMED'
      AND NEW."status" = 'ADMITTED'
      AND OLD."attempts" = 0
      AND OLD."executionBoundary" IS NULL
      AND OLD."workerLeaseExpiresAt" IS NOT NULL
      AND NEW."zeroAttemptEvidenceArtifactId" IS NOT NULL
      AND julianday(OLD."workerLeaseExpiresAt") < julianday(CURRENT_TIMESTAMP)
    )
    OR (
      OLD."status" = 'RUNNING'
      AND NEW."status" IN ('SUCCEEDED','FAILED','AMBIGUOUS')
      AND NEW."executionBoundary" IS OLD."executionBoundary"
    )
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
      OR OLD."executionBoundary" IS NOT NULL
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

PRAGMA foreign_keys=ON;
