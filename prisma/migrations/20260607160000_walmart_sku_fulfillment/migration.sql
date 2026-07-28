-- Per-SKU fulfillment speed, derived from our own Walmart order history.

CREATE TABLE "WalmartSkuFulfillment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "sku" TEXT NOT NULL,
    "orders" INTEGER NOT NULL,
    "avgHandlingDays" REAL NOT NULL,
    "minHandlingDays" INTEGER NOT NULL,
    "maxHandlingDays" INTEGER NOT NULL,
    "classification" TEXT NOT NULL,
    "carriers" TEXT,
    "lastOrderAt" DATETIME,
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "WalmartSkuFulfillment_storeIndex_sku_key"
    ON "WalmartSkuFulfillment"("storeIndex", "sku");
CREATE INDEX "WalmartSkuFulfillment_storeIndex_classification_idx"
    ON "WalmartSkuFulfillment"("storeIndex", "classification");
CREATE INDEX "WalmartSkuFulfillment_storeIndex_avgHandlingDays_idx"
    ON "WalmartSkuFulfillment"("storeIndex", "avgHandlingDays");
