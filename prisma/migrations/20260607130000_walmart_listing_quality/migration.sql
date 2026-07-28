-- Walmart Growth: Listing Quality. Two tables feeding the "Grow Sales" module,
-- populated nightly from the Insights API (/api/cron/walmart → syncListingQuality).

-- Seller-level headline + 6 component scores. One history row per sync so the
-- overall score can be charted climbing as items get fixed.
CREATE TABLE "WalmartListingQualitySnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "listingQuality" REAL NOT NULL,
    "offerScore" REAL,
    "ratingReviewScore" REAL,
    "contentScore" REAL,
    "priceScore" REAL,
    "shippingScore" REAL,
    "transactibilityScore" REAL,
    "itemDefectCnt" INTEGER,
    "defectRatio" REAL,
    "rawData" TEXT NOT NULL
);

CREATE INDEX "WalmartListingQualitySnapshot_storeIndex_capturedAt_idx"
    ON "WalmartListingQualitySnapshot"("storeIndex", "capturedAt");

-- Per-SKU quality + distilled issue list = the worklist. Upserted on
-- (storeIndex, sku); rows untouched by a pass are pruned (item left the feed).
CREATE TABLE "WalmartListingQualityItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "sku" TEXT NOT NULL,
    "itemId" TEXT,
    "productId" TEXT,
    "productName" TEXT,
    "productType" TEXT,
    "categoryName" TEXT,
    "condition" TEXT,
    "lqScore" REAL,
    "priority" TEXT,
    "ratingReviewScore" REAL,
    "shippingScore" REAL,
    "publishScore" REAL,
    "contentScore" REAL,
    "priceScore" REAL,
    "offerScore" REAL,
    "isInStock" BOOLEAN NOT NULL DEFAULT false,
    "isFastAndFreeShipping" BOOLEAN NOT NULL DEFAULT false,
    "wfsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ratingCount" INTEGER,
    "pageViews30d" INTEGER,
    "conversionRate30d" REAL,
    "gmv30d" REAL,
    "orders30d" INTEGER,
    "units30d" INTEGER,
    "topFixComponent" TEXT,
    "issueCount" INTEGER NOT NULL DEFAULT 0,
    "issuesSummary" TEXT,
    "scoredAt" DATETIME,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "WalmartListingQualityItem_storeIndex_sku_key"
    ON "WalmartListingQualityItem"("storeIndex", "sku");

CREATE INDEX "WalmartListingQualityItem_storeIndex_lqScore_idx"
    ON "WalmartListingQualityItem"("storeIndex", "lqScore");

CREATE INDEX "WalmartListingQualityItem_storeIndex_priority_idx"
    ON "WalmartListingQualityItem"("storeIndex", "priority");

CREATE INDEX "WalmartListingQualityItem_storeIndex_syncedAt_idx"
    ON "WalmartListingQualityItem"("storeIndex", "syncedAt");

-- Resumable-sweep state: the Insights /items endpoint has a tiny rate bucket,
-- so a full sweep spans several cron runs. One row per store.
CREATE TABLE "WalmartLqSyncState" (
    "storeIndex" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
    "cursor" TEXT,
    "sweepStartedAt" DATETIME,
    "pagesThisSweep" INTEGER NOT NULL DEFAULT 0,
    "itemsThisSweep" INTEGER NOT NULL DEFAULT 0,
    "lastFullSweepAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);
