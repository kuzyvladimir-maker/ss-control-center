-- Bulk remediation queue (Walmart-style). Filter → pool → "Fix all" enqueues;
-- a cron worker drains it, applying the chosen safe fixes per listing.

CREATE TABLE "AmazonRemediationQueue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "sku" TEXT NOT NULL,
    "asin" TEXT,
    "itemName" TEXT,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "changesApplied" INTEGER NOT NULL DEFAULT 0,
    "result" TEXT,
    "error" TEXT,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME
);

CREATE UNIQUE INDEX "AmazonRemediationQueue_storeIndex_sku_key"
    ON "AmazonRemediationQueue"("storeIndex", "sku");
CREATE INDEX "AmazonRemediationQueue_storeIndex_status_idx"
    ON "AmazonRemediationQueue"("storeIndex", "status");
CREATE INDEX "AmazonRemediationQueue_status_queuedAt_idx"
    ON "AmazonRemediationQueue"("status", "queuedAt");
