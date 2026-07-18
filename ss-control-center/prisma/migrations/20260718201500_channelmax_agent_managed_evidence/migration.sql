-- Adds duplicate-reconciliation fencing plus SSCC-owned immutable evidence.
-- Kept separate from the original queue migration so already-migrated
-- installations can upgrade without editing migration history.

ALTER TABLE "ChannelMaxAgentJob"
  ADD COLUMN "reconciliationTargetLock" TEXT;

CREATE UNIQUE INDEX "ChannelMaxAgentJob_reconciliationTargetLock_key"
  ON "ChannelMaxAgentJob"("reconciliationTargetLock");

CREATE TABLE "ChannelMaxAgentEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "mediaType" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL,
    "uri" TEXT NOT NULL,
    "content" BLOB NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelMaxAgentEvidence_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "ChannelMaxAgentJob" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ChannelMaxAgentEvidence_jobId_kind_sha256_key"
  ON "ChannelMaxAgentEvidence"("jobId", "kind", "sha256");
CREATE UNIQUE INDEX "ChannelMaxAgentEvidence_uri_key"
  ON "ChannelMaxAgentEvidence"("uri");
CREATE INDEX "ChannelMaxAgentEvidence_jobId_createdAt_idx"
  ON "ChannelMaxAgentEvidence"("jobId", "createdAt");

CREATE TRIGGER "ChannelMaxAgentEvidence_append_only_update"
BEFORE UPDATE ON "ChannelMaxAgentEvidence"
BEGIN
  SELECT RAISE(ABORT, 'ChannelMaxAgentEvidence is append-only');
END;

CREATE TRIGGER "ChannelMaxAgentEvidence_append_only_delete"
BEFORE DELETE ON "ChannelMaxAgentEvidence"
BEGIN
  SELECT RAISE(ABORT, 'ChannelMaxAgentEvidence is append-only');
END;
