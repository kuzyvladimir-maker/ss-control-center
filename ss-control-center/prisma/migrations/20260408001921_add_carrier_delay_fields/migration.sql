-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CsCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channel" TEXT NOT NULL,
    "store" TEXT,
    "orderId" TEXT,
    "customerName" TEXT,
    "product" TEXT,
    "productType" TEXT,
    "category" TEXT,
    "categoryName" TEXT,
    "priority" TEXT,
    "language" TEXT,
    "branch" TEXT,
    "branchName" TEXT,
    "response" TEXT,
    "action" TEXT,
    "urgency" TEXT,
    "internalNotes" TEXT,
    "imageData" TEXT,
    "carrierDelayDetected" BOOLEAN NOT NULL DEFAULT false,
    "carrierBadge" TEXT,
    "shippedOnTime" BOOLEAN,
    "promisedEdd" TEXT,
    "actualDelivery" TEXT,
    "daysLate" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CsCase" ("action", "branch", "branchName", "category", "categoryName", "channel", "createdAt", "customerName", "id", "imageData", "internalNotes", "language", "orderId", "priority", "product", "productType", "resolution", "resolvedAt", "response", "status", "store", "updatedAt", "urgency") SELECT "action", "branch", "branchName", "category", "categoryName", "channel", "createdAt", "customerName", "id", "imageData", "internalNotes", "language", "orderId", "priority", "product", "productType", "resolution", "resolvedAt", "response", "status", "store", "updatedAt", "urgency" FROM "CsCase";
DROP TABLE "CsCase";
ALTER TABLE "new_CsCase" RENAME TO "CsCase";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
