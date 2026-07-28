-- Change log / audit trail — every Amazon listing write lands one row, with
-- before/after values (rollback) + before/after metrics + outcome classification.

CREATE TABLE "AmazonChangeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "sku" TEXT NOT NULL,
    "asin" TEXT,
    "itemName" TEXT,
    "source" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "field" TEXT,
    "beforeValue" TEXT,
    "afterValue" TEXT,
    "patch" TEXT,
    "submissionId" TEXT,
    "amazonStatus" TEXT,
    "beforeHealthScore" REAL,
    "beforeConversion" REAL,
    "beforeOpportunity" REAL,
    "beforeErrorCount" INTEGER,
    "afterMeasuredAt" DATETIME,
    "afterHealthScore" REAL,
    "afterConversion" REAL,
    "afterErrorCount" INTEGER,
    "outcome" TEXT,
    "rolledBack" BOOLEAN NOT NULL DEFAULT false,
    "rolledBackAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "AmazonChangeLog_storeIndex_createdAt_idx" ON "AmazonChangeLog"("storeIndex", "createdAt");
CREATE INDEX "AmazonChangeLog_storeIndex_sku_idx" ON "AmazonChangeLog"("storeIndex", "sku");
CREATE INDEX "AmazonChangeLog_outcome_idx" ON "AmazonChangeLog"("outcome");
CREATE INDEX "AmazonChangeLog_afterMeasuredAt_idx" ON "AmazonChangeLog"("afterMeasuredAt");
