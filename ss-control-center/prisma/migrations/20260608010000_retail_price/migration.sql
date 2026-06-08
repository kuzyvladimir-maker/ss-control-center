-- COGS sourcing engine — RetailPrice (findings from external price services).
-- Additive only.
CREATE TABLE IF NOT EXISTS "RetailPrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT,
    "upc" TEXT,
    "retailer" TEXT NOT NULL,
    "retailerProductId" TEXT NOT NULL,
    "price" REAL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "inStock" BOOLEAN,
    "productUrl" TEXT,
    "title" TEXT,
    "description" TEXT,
    "keyFeatures" TEXT,
    "imageUrls" TEXT,
    "zip" TEXT,
    "packSizeSeen" INTEGER,
    "isBaseUnit" BOOLEAN,
    "unitMismatch" BOOLEAN NOT NULL DEFAULT false,
    "sourceApi" TEXT,
    "matchMethod" TEXT,
    "confidence" REAL,
    "fetchedAt" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "RetailPrice_retailer_retailerProductId_key" ON "RetailPrice"("retailer", "retailerProductId");
CREATE INDEX IF NOT EXISTS "RetailPrice_sku_idx" ON "RetailPrice"("sku");
CREATE INDEX IF NOT EXISTS "RetailPrice_upc_idx" ON "RetailPrice"("upc");
