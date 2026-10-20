-- Customer Hub: VPS agent tasks, Telegram approval cards, owner corrections.
-- Additive only. Turso: scripts/turso-migrate-customer-hub-cards.mjs

ALTER TABLE "BuyerMessage" ADD COLUMN "caseDataJson" TEXT;
ALTER TABLE "BuyerMessage" ADD COLUMN "caseStage" TEXT;

CREATE TABLE IF NOT EXISTS "CsTask" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "storeIndex" INTEGER NOT NULL,
  "amazonOrderId" TEXT,
  "buyerMessageId" TEXT NOT NULL,
  "cardId" TEXT,
  "payloadJson" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "approvedBy" TEXT,
  "approvedAt" DATETIME,
  "claimedBy" TEXT,
  "claimedAt" DATETIME,
  "completedAt" DATETIME,
  "resultJson" TEXT,
  "error" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "CsTask_idempotencyKey_key" ON "CsTask"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "CsTask_storeIndex_status_idx" ON "CsTask"("storeIndex", "status");
CREATE INDEX IF NOT EXISTS "CsTask_buyerMessageId_idx" ON "CsTask"("buyerMessageId");

CREATE TABLE IF NOT EXISTS "CsCard" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "buyerMessageId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "cardJson" TEXT NOT NULL,
  "telegramMessageId" TEXT,
  "publishedAt" DATETIME,
  "decidedAt" DATETIME,
  "decision" TEXT,
  "ownerComment" TEXT
);
CREATE INDEX IF NOT EXISTS "CsCard_status_idx" ON "CsCard"("status");
CREATE INDEX IF NOT EXISTS "CsCard_buyerMessageId_idx" ON "CsCard"("buyerMessageId");

CREATE TABLE IF NOT EXISTS "CsOwnerRule" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "text" TEXT NOT NULL,
  "problemType" TEXT,
  "cardId" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'correction',
  "active" BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS "CsOwnerRule_createdAt_idx" ON "CsOwnerRule"("createdAt");
