-- Durable, fail-closed bridge between SS Command Center and the OpenClaw
-- worker controlling the owner's authenticated ChannelMAX Chrome profile.

CREATE TABLE "ChannelMaxAgentJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operation" TEXT NOT NULL,
    "mutation" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "accountId" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "requestSha256" TEXT NOT NULL,
    "mutationPlanSha256" TEXT,
    "mutationPlanLock" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "ownerApproved" BOOLEAN NOT NULL DEFAULT false,
    "ownerApprovedBy" TEXT,
    "ownerApprovedById" TEXT,
    "ownerApprovedAt" DATETIME,
    "assignmentArtifactSha256" TEXT,
    "approvalSubjectJson" TEXT,
    "approvalSha256" TEXT,
    "approvalExpiresAt" DATETIME,
    "approvalNonce" TEXT,
    "approvalStepUpAssertionId" TEXT,
    "approvalStepUpMethod" TEXT,
    "approvalStepUpCeremonyId" TEXT,
    "approvalStepUpVerifiedAt" DATETIME,
    "workerId" TEXT,
    "workerActorId" TEXT,
    "accountLeaseKey" TEXT,
    "browserLeaseKey" TEXT,
    "leaseTokenSha256" TEXT,
    "leaseExpiresAt" DATETIME,
    "lastHeartbeatAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "mutationStartedAt" DATETIME,
    "mutationOutcome" TEXT,
    "ambiguityReason" TEXT,
    "eventSequence" INTEGER NOT NULL DEFAULT 0,
    "cancelledAt" DATETIME,
    "cancelledBy" TEXT,
    "cancellationReason" TEXT,
    "reconcilesJobId" TEXT,
    "reconciledByJobId" TEXT,
    "resultJson" TEXT,
    "resultSha256" TEXT,
    "error" TEXT,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "ChannelMaxAgentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT,
    "metadataJson" TEXT NOT NULL,
    "metadataSha256" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "evidenceSha256" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelMaxAgentEvent_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "ChannelMaxAgentJob" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ChannelMaxAgentJob_idempotencyKey_key"
  ON "ChannelMaxAgentJob"("idempotencyKey");
CREATE UNIQUE INDEX "ChannelMaxAgentJob_approvalNonce_key"
  ON "ChannelMaxAgentJob"("approvalNonce");
CREATE UNIQUE INDEX "ChannelMaxAgentJob_accountLeaseKey_key"
  ON "ChannelMaxAgentJob"("accountLeaseKey");
CREATE UNIQUE INDEX "ChannelMaxAgentJob_browserLeaseKey_key"
  ON "ChannelMaxAgentJob"("browserLeaseKey");
CREATE UNIQUE INDEX "ChannelMaxAgentJob_mutationPlanLock_key"
  ON "ChannelMaxAgentJob"("mutationPlanLock");
CREATE UNIQUE INDEX "ChannelMaxAgentJob_approvalStepUpAssertionId_key"
  ON "ChannelMaxAgentJob"("approvalStepUpAssertionId");
CREATE INDEX "ChannelMaxAgentJob_status_priority_queuedAt_idx"
  ON "ChannelMaxAgentJob"("status", "priority", "queuedAt");
CREATE INDEX "ChannelMaxAgentJob_leaseExpiresAt_idx"
  ON "ChannelMaxAgentJob"("leaseExpiresAt");
CREATE INDEX "ChannelMaxAgentJob_operation_status_idx"
  ON "ChannelMaxAgentJob"("operation", "status");
CREATE INDEX "ChannelMaxAgentJob_mutationPlanSha256_idx"
  ON "ChannelMaxAgentJob"("mutationPlanSha256");
CREATE INDEX "ChannelMaxAgentJob_reconcilesJobId_idx"
  ON "ChannelMaxAgentJob"("reconcilesJobId");
CREATE UNIQUE INDEX "ChannelMaxAgentEvent_jobId_sequence_key"
  ON "ChannelMaxAgentEvent"("jobId", "sequence");
CREATE UNIQUE INDEX "ChannelMaxAgentEvent_jobId_eventKey_key"
  ON "ChannelMaxAgentEvent"("jobId", "eventKey");
CREATE INDEX "ChannelMaxAgentEvent_jobId_occurredAt_idx"
  ON "ChannelMaxAgentEvent"("jobId", "occurredAt");

CREATE TRIGGER "ChannelMaxAgentEvent_append_only_update"
BEFORE UPDATE ON "ChannelMaxAgentEvent"
BEGIN
  SELECT RAISE(ABORT, 'ChannelMaxAgentEvent is append-only');
END;

CREATE TRIGGER "ChannelMaxAgentEvent_append_only_delete"
BEFORE DELETE ON "ChannelMaxAgentEvent"
BEGIN
  SELECT RAISE(ABORT, 'ChannelMaxAgentEvent is append-only');
END;

CREATE TABLE "ChannelMaxStepUpAssertion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "ceremonyId" TEXT NOT NULL,
    "verifiedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "jobId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "ChannelMaxStepUpAssertion_ceremonyId_key"
  ON "ChannelMaxStepUpAssertion"("ceremonyId");
CREATE INDEX "ChannelMaxStepUpAssertion_userId_expiresAt_idx"
  ON "ChannelMaxStepUpAssertion"("userId", "expiresAt");
CREATE INDEX "ChannelMaxStepUpAssertion_jobId_expiresAt_idx"
  ON "ChannelMaxStepUpAssertion"("jobId", "expiresAt");
