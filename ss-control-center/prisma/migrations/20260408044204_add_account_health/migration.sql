-- CreateTable
CREATE TABLE "AccountHealthSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storeId" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "orderDefectRate" REAL,
    "lateShipmentRate" REAL,
    "preFulfillmentCancelRate" REAL,
    "validTrackingRate" REAL,
    "onTimeDeliveryRate" REAL,
    "alertCount" INTEGER NOT NULL DEFAULT 0,
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "alertsJson" TEXT
);

-- CreateTable
CREATE TABLE "AccountAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storeId" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "threshold" REAL NOT NULL,
    "message" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "AccountHealthSnapshot_storeId_createdAt_idx" ON "AccountHealthSnapshot"("storeId", "createdAt");
