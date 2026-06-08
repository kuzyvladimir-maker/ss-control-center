-- Walmart Growth Phase B: async Insights reports (Buy Box).

-- Report request state machine (request → poll → download), one row per request.
CREATE TABLE "WalmartReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "reportType" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusCheckedAt" DATETIME,
    "readyAt" DATETIME,
    "downloadedAt" DATETIME,
    "rowCount" INTEGER,
    "error" TEXT,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "WalmartReport_requestId_key" ON "WalmartReport"("requestId");
CREATE INDEX "WalmartReport_storeIndex_reportType_requestedAt_idx"
    ON "WalmartReport"("storeIndex", "reportType", "requestedAt");
CREATE INDEX "WalmartReport_status_idx" ON "WalmartReport"("status");

-- Parsed Buy Box rows — who holds the Buy Box per SKU + price gap.
CREATE TABLE "WalmartBuyBoxItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "sku" TEXT NOT NULL,
    "itemId" TEXT,
    "productName" TEXT,
    "productCategory" TEXT,
    "sellerItemPrice" REAL,
    "sellerShipPrice" REAL,
    "sellerTotalPrice" REAL,
    "isWinner" BOOLEAN NOT NULL DEFAULT false,
    "buyBoxItemPrice" REAL,
    "buyBoxShipPrice" REAL,
    "buyBoxTotalPrice" REAL,
    "priceGap" REAL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "WalmartBuyBoxItem_storeIndex_sku_key"
    ON "WalmartBuyBoxItem"("storeIndex", "sku");
CREATE INDEX "WalmartBuyBoxItem_storeIndex_isWinner_idx"
    ON "WalmartBuyBoxItem"("storeIndex", "isWinner");
CREATE INDEX "WalmartBuyBoxItem_storeIndex_priceGap_idx"
    ON "WalmartBuyBoxItem"("storeIndex", "priceGap");
