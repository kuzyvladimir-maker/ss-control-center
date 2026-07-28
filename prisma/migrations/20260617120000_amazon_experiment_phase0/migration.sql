-- Experiment engine Phase 0: per-ASIN daily funnel history + versioned listing snapshots.

CREATE TABLE "AmazonAsinDaily" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "asin" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "sessions" INTEGER,
    "pageViews" INTEGER,
    "unitsOrdered" INTEGER,
    "totalOrderItems" INTEGER,
    "orderedProductSales" REAL,
    "featuredOfferPct" REAL,
    "unitSessionPct" REAL,
    "avgSellingPrice" REAL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AmazonAsinDaily_storeIndex_asin_date_key" ON "AmazonAsinDaily"("storeIndex", "asin", "date");
CREATE INDEX "AmazonAsinDaily_storeIndex_asin_idx" ON "AmazonAsinDaily"("storeIndex", "asin");
CREATE INDEX "AmazonAsinDaily_storeIndex_date_idx" ON "AmazonAsinDaily"("storeIndex", "date");

CREATE TABLE "AmazonListingSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "sku" TEXT NOT NULL,
    "asin" TEXT,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'cron',
    "brand" TEXT,
    "productType" TEXT,
    "title" TEXT,
    "bulletsJson" TEXT,
    "description" TEXT,
    "mainImageUrl" TEXT,
    "imageCount" INTEGER,
    "price" REAL,
    "attributesJson" TEXT,
    "contentHash" TEXT NOT NULL,
    "sessions30d" INTEGER,
    "unitSessionPct" REAL,
    "revenue30d" REAL,
    "healthScore" REAL
);
CREATE INDEX "AmazonListingSnapshot_storeIndex_sku_capturedAt_idx" ON "AmazonListingSnapshot"("storeIndex", "sku", "capturedAt");
CREATE INDEX "AmazonListingSnapshot_storeIndex_asin_idx" ON "AmazonListingSnapshot"("storeIndex", "asin");
