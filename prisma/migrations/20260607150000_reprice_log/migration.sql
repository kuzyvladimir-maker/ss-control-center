-- Featured-Offer repricer audit log. One row per actionable SKU evaluated by
-- /api/cron/reprice-amazon (price changes, manual-review flags, errors).
CREATE TABLE "RepriceLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storeIndex" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "asin" TEXT,
    "title" TEXT,
    "oldPrice" REAL NOT NULL,
    "newPrice" REAL,
    "shipping" REAL NOT NULL DEFAULT 0,
    "targetLanded" REAL,
    "competitors" INTEGER NOT NULL DEFAULT 0,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX "RepriceLog_storeIndex_createdAt_idx"
    ON "RepriceLog"("storeIndex", "createdAt");

CREATE INDEX "RepriceLog_sku_idx" ON "RepriceLog"("sku");
