-- Customer Hub: Amazon buyer cancellation notices (owner, topic 42, 2026-11-02).
-- Additive only. Turso: scripts/turso-migrate-customer-hub-cancel-requests.mjs

CREATE TABLE IF NOT EXISTS "AmazonCancelRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "storeIndex" INTEGER NOT NULL,
  "amazonOrderId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "requestedAt" DATETIME NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'amazon-notification',
  "gmailMessageId" TEXT NOT NULL,
  "subject" TEXT,
  "labelPurchasedAt" DATETIME,
  "labelSource" TEXT,
  "beforeShipment" BOOLEAN,
  "resolvedAt" DATETIME
);
CREATE UNIQUE INDEX IF NOT EXISTS "AmazonCancelRequest_gmailMessageId_key" ON "AmazonCancelRequest"("gmailMessageId");
CREATE INDEX IF NOT EXISTS "AmazonCancelRequest_amazonOrderId_idx" ON "AmazonCancelRequest"("amazonOrderId");
CREATE INDEX IF NOT EXISTS "AmazonCancelRequest_requestedAt_idx" ON "AmazonCancelRequest"("requestedAt");
