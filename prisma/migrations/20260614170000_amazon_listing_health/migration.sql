-- Amazon Growth (Listing Health). Amazon has no native Listing Quality Score,
-- so we compute our own from Listings Items issues/status, FYP suppressed
-- report, Sales & Traffic conversion, Catalog content, and our compliance gate.
-- See docs/wiki/amazon-growth-roadmap.md.

CREATE TABLE "AmazonListingHealthSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "healthScore" REAL NOT NULL,
    "buyabilityScore" REAL,
    "issuesScore" REAL,
    "contentScore" REAL,
    "complianceScore" REAL,
    "buyBoxScore" REAL,
    "conversionScore" REAL,
    "totalListings" INTEGER NOT NULL,
    "suppressedCount" INTEGER NOT NULL DEFAULT 0,
    "errorIssueCount" INTEGER NOT NULL DEFAULT 0,
    "warningIssueCount" INTEGER NOT NULL DEFAULT 0,
    "rawData" TEXT
);

CREATE INDEX "AmazonListingHealthSnapshot_storeIndex_capturedAt_idx"
    ON "AmazonListingHealthSnapshot"("storeIndex", "capturedAt");

CREATE TABLE "AmazonListingHealthItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "sku" TEXT NOT NULL,
    "asin" TEXT,
    "productType" TEXT,
    "itemName" TEXT,
    "conditionType" TEXT,
    "mainImageUrl" TEXT,
    "healthScore" REAL,
    "topFixComponent" TEXT,
    "buyabilityScore" REAL,
    "issuesScore" REAL,
    "contentScore" REAL,
    "complianceScore" REAL,
    "buyBoxScore" REAL,
    "conversionScore" REAL,
    "isBuyable" BOOLEAN NOT NULL DEFAULT false,
    "isDiscoverable" BOOLEAN NOT NULL DEFAULT false,
    "isSuppressed" BOOLEAN NOT NULL DEFAULT false,
    "fulfillmentAvailable" BOOLEAN NOT NULL DEFAULT false,
    "errorIssueCount" INTEGER NOT NULL DEFAULT 0,
    "warningIssueCount" INTEGER NOT NULL DEFAULT 0,
    "issuesSummary" TEXT,
    "hasFeaturedOffer" BOOLEAN NOT NULL DEFAULT false,
    "buyBoxWinner" BOOLEAN NOT NULL DEFAULT false,
    "priceGap" REAL,
    "sessions30d" INTEGER,
    "pageViews30d" INTEGER,
    "unitsOrdered30d" INTEGER,
    "buyBoxPercentage" REAL,
    "unitSessionPct" REAL,
    "suppressionReason" TEXT,
    "lastUpdatedAt" DATETIME,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "AmazonListingHealthItem_storeIndex_sku_key"
    ON "AmazonListingHealthItem"("storeIndex", "sku");
CREATE INDEX "AmazonListingHealthItem_storeIndex_healthScore_idx"
    ON "AmazonListingHealthItem"("storeIndex", "healthScore");
CREATE INDEX "AmazonListingHealthItem_storeIndex_isSuppressed_idx"
    ON "AmazonListingHealthItem"("storeIndex", "isSuppressed");
CREATE INDEX "AmazonListingHealthItem_storeIndex_syncedAt_idx"
    ON "AmazonListingHealthItem"("storeIndex", "syncedAt");

CREATE TABLE "AmazonHealthSyncState" (
    "storeIndex" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
    "cursor" TEXT,
    "sweepStartedAt" DATETIME,
    "pagesThisSweep" INTEGER NOT NULL DEFAULT 0,
    "itemsThisSweep" INTEGER NOT NULL DEFAULT 0,
    "lastFullSweepAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "AmazonGrowthReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "reportType" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusCheckedAt" DATETIME,
    "doneAt" DATETIME,
    "rowCount" INTEGER,
    "error" TEXT,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "AmazonGrowthReport_reportId_key"
    ON "AmazonGrowthReport"("reportId");
CREATE INDEX "AmazonGrowthReport_storeIndex_reportType_requestedAt_idx"
    ON "AmazonGrowthReport"("storeIndex", "reportType", "requestedAt");
CREATE INDEX "AmazonGrowthReport_status_idx"
    ON "AmazonGrowthReport"("status");
