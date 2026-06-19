-- A+ Content Factory jobs (generate → qualify → approve → publish lifecycle).
CREATE TABLE "AmazonAplusJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "sku" TEXT NOT NULL,
    "asin" TEXT,
    "itemName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "variant" TEXT NOT NULL DEFAULT 'A',
    "documentName" TEXT,
    "contentJson" TEXT,
    "imagePlanJson" TEXT,
    "qualificationJson" TEXT,
    "qualified" BOOLEAN NOT NULL DEFAULT false,
    "comments" TEXT,
    "contentReferenceKey" TEXT,
    "submissionId" TEXT,
    "amazonStatus" TEXT,
    "error" TEXT,
    "beforeConversion" REAL,
    "afterConversion" REAL,
    "measuredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedAt" DATETIME,
    "approvedAt" DATETIME,
    "publishedAt" DATETIME
);
CREATE UNIQUE INDEX "AmazonAplusJob_storeIndex_sku_variant_key" ON "AmazonAplusJob"("storeIndex", "sku", "variant");
CREATE INDEX "AmazonAplusJob_storeIndex_status_idx" ON "AmazonAplusJob"("storeIndex", "status");
CREATE INDEX "AmazonAplusJob_storeIndex_asin_idx" ON "AmazonAplusJob"("storeIndex", "asin");
