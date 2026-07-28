-- Product Truth queue v2: race-safe active-job idempotency, leases/backoff,
-- requested/completed fields, owner run provenance and spend accounting.
ALTER TABLE "EnrichmentJob" ADD COLUMN "normalizedTarget" TEXT;
ALTER TABLE "EnrichmentJob" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "EnrichmentJob" ADD COLUMN "requestedFields" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "EnrichmentJob" ADD COLUMN "runId" TEXT;
ALTER TABLE "EnrichmentJob" ADD COLUMN "approvalId" TEXT;
ALTER TABLE "EnrichmentJob" ADD COLUMN "estimatedSpendUnits" REAL NOT NULL DEFAULT 0;
ALTER TABLE "EnrichmentJob" ADD COLUMN "actualSpendUnits" REAL NOT NULL DEFAULT 0;
ALTER TABLE "EnrichmentJob" ADD COLUMN "providerAttempts" TEXT;
ALTER TABLE "EnrichmentJob" ADD COLUMN "terminalReason" TEXT;
ALTER TABLE "EnrichmentJob" ADD COLUMN "completedFields" TEXT;
ALTER TABLE "EnrichmentJob" ADD COLUMN "unavailableFields" TEXT;
ALTER TABLE "EnrichmentJob" ADD COLUMN "checkpoint" TEXT;
ALTER TABLE "EnrichmentJob" ADD COLUMN "nextEligibleAt" DATETIME;
ALTER TABLE "EnrichmentJob" ADD COLUMN "leaseOwner" TEXT;
ALTER TABLE "EnrichmentJob" ADD COLUMN "leaseToken" TEXT;
ALTER TABLE "EnrichmentJob" ADD COLUMN "leaseExpiresAt" DATETIME;
ALTER TABLE "EnrichmentJob" ADD COLUMN "heartbeatAt" DATETIME;

-- Existing completed jobs remain historical rows. Give every legacy row a
-- unique compatibility key so the active partial index can be introduced
-- without pretending old target strings were canonically equivalent.
UPDATE "EnrichmentJob"
SET "normalizedTarget"=lower(trim("target")),
    "idempotencyKey"='legacy:' || "id",
    "requestedFields"='["identity","offers","content","cogs"]',
    "nextEligibleAt"=COALESCE("queuedAt","createdAt")
WHERE "idempotencyKey" IS NULL;

CREATE INDEX "EnrichmentJob_status_nextEligibleAt_idx"
  ON "EnrichmentJob"("status", "nextEligibleAt");
CREATE INDEX "EnrichmentJob_leaseExpiresAt_idx"
  ON "EnrichmentJob"("leaseExpiresAt");
CREATE INDEX "EnrichmentJob_idempotencyKey_idx"
  ON "EnrichmentJob"("idempotencyKey");

-- Multiple historical terminal rows may share the same logical key, but there
-- can be only one active attempt across concurrent producers.
CREATE UNIQUE INDEX "EnrichmentJob_one_active_idempotencyKey"
  ON "EnrichmentJob"("idempotencyKey")
  WHERE "status" IN ('queued','running','retry_wait');
