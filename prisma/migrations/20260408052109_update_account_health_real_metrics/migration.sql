-- CreateTable
CREATE TABLE "ReportSyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storeId" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "amazonReportId" TEXT,
    "amazonDocumentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "error" TEXT,
    "completedAt" DATETIME
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AccountHealthSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storeId" TEXT NOT NULL,
    "storeName" TEXT,
    "sellerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "orderDefectRate" REAL,
    "negativeFeedbackRate" REAL,
    "atozClaimsRate" REAL,
    "chargebackRate" REAL,
    "lateShipmentRate" REAL,
    "preFulfillmentCancelRate" REAL,
    "validTrackingRate" REAL,
    "onTimeDeliveryRate" REAL,
    "totalOrders30d" INTEGER,
    "totalOrders7d" INTEGER,
    "cancelledOrders7d" INTEGER,
    "lateShipments30d" INTEGER,
    "shippedOrders30d" INTEGER,
    "syncStatus" TEXT NOT NULL DEFAULT 'pending',
    "syncError" TEXT,
    "syncedAt" DATETIME,
    "alertCount" INTEGER NOT NULL DEFAULT 0,
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "alertsJson" TEXT
);
INSERT INTO "new_AccountHealthSnapshot" ("alertCount", "alertsJson", "createdAt", "criticalCount", "id", "lateShipmentRate", "onTimeDeliveryRate", "orderDefectRate", "preFulfillmentCancelRate", "status", "storeId", "storeName", "validTrackingRate") SELECT "alertCount", "alertsJson", "createdAt", "criticalCount", "id", "lateShipmentRate", "onTimeDeliveryRate", "orderDefectRate", "preFulfillmentCancelRate", "status", "storeId", "storeName", "validTrackingRate" FROM "AccountHealthSnapshot";
DROP TABLE "AccountHealthSnapshot";
ALTER TABLE "new_AccountHealthSnapshot" RENAME TO "AccountHealthSnapshot";
CREATE INDEX "AccountHealthSnapshot_storeId_createdAt_idx" ON "AccountHealthSnapshot"("storeId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
