-- Bulk AI-advisor queue (stage 2 after the deterministic Optimizer). Filter →
-- pool → "Analyze & fix" enqueues; a worker runs the LLM advisor per listing,
-- stores the diagnosis + plan, and auto-applies the safe executable subset.

CREATE TABLE "AmazonAdvisorQueue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "sku" TEXT NOT NULL,
    "asin" TEXT,
    "itemName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "autoApply" BOOLEAN NOT NULL DEFAULT true,
    "diagnosis" TEXT,
    "rootCause" TEXT,
    "expectedOutcome" TEXT,
    "confidence" TEXT,
    "actionsJson" TEXT,
    "actionsApplied" INTEGER NOT NULL DEFAULT 0,
    "result" TEXT,
    "error" TEXT,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME
);

CREATE UNIQUE INDEX "AmazonAdvisorQueue_storeIndex_sku_key"
    ON "AmazonAdvisorQueue"("storeIndex", "sku");
CREATE INDEX "AmazonAdvisorQueue_storeIndex_status_idx"
    ON "AmazonAdvisorQueue"("storeIndex", "status");
CREATE INDEX "AmazonAdvisorQueue_status_queuedAt_idx"
    ON "AmazonAdvisorQueue"("status", "queuedAt");
