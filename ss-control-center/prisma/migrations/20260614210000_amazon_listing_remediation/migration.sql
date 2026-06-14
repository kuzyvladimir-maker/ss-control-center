-- Amazon Growth — Optimizer impact tracking (mirror of Walmart remediation
-- history). One row per applied fix: BEFORE metrics at apply, AFTER metrics
-- filled by a later sweep, so we can prove + chart the lift.

CREATE TABLE "AmazonListingRemediation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "sku" TEXT NOT NULL,
    "asin" TEXT,
    "itemName" TEXT,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fixKinds" TEXT NOT NULL,
    "changeCount" INTEGER NOT NULL DEFAULT 0,
    "submissionId" TEXT,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "beforeHealthScore" REAL,
    "beforeErrorCount" INTEGER,
    "beforeComplianceScore" REAL,
    "afterMeasuredAt" DATETIME,
    "afterHealthScore" REAL,
    "afterErrorCount" INTEGER,
    "afterComplianceScore" REAL
);

CREATE INDEX "AmazonListingRemediation_storeIndex_runAt_idx"
    ON "AmazonListingRemediation"("storeIndex", "runAt");
CREATE INDEX "AmazonListingRemediation_storeIndex_afterMeasuredAt_idx"
    ON "AmazonListingRemediation"("storeIndex", "afterMeasuredAt");
