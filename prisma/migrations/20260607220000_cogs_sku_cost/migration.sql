-- COGS unit-economics engine — Stage 0a
-- Adds manufacturer UPC/GTIN to our catalog + a dated per-SKU true-cost table.
-- Additive only (new nullable columns + new table) — safe, non-destructive.

-- SkuShippingData: manufacturer UPC pulled from our own listings (Stage 0b)
ALTER TABLE "SkuShippingData" ADD COLUMN "upc" TEXT;
ALTER TABLE "SkuShippingData" ADD COLUMN "upcSource" TEXT;

-- SkuCost: dated true-cost history (product / packaging / ice stored separately)
CREATE TABLE IF NOT EXISTS "SkuCost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "asin" TEXT,
    "effectiveDate" TEXT,
    "productCost" REAL,
    "packagingCost" REAL,
    "iceCost" REAL,
    "totalCost" REAL,
    "costPerUnit" REAL,
    "packSize" INTEGER,
    "includesPackaging" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "source" TEXT NOT NULL,
    "confidence" REAL,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "SkuCost_sku_source_effectiveDate_key" ON "SkuCost"("sku", "source", "effectiveDate");
CREATE INDEX IF NOT EXISTS "SkuCost_sku_idx" ON "SkuCost"("sku");
CREATE INDEX IF NOT EXISTS "SkuCost_asin_idx" ON "SkuCost"("asin");
CREATE INDEX IF NOT EXISTS "SkuCost_source_idx" ON "SkuCost"("source");
