-- CreateTable
CREATE TABLE "ShippingAdjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "externalId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amazonOrderId" TEXT,
    "walmartOrderId" TEXT,
    "adjustmentDate" TEXT NOT NULL,
    "adjustmentType" TEXT NOT NULL,
    "adjustmentAmount" REAL NOT NULL,
    "adjustmentReason" TEXT,
    "sku" TEXT,
    "productName" TEXT,
    "carrier" TEXT,
    "service" TEXT,
    "declaredWeightLbs" REAL,
    "declaredDimL" REAL,
    "declaredDimW" REAL,
    "declaredDimH" REAL,
    "originalLabelCost" REAL,
    "adjustedWeightLbs" REAL,
    "adjustedDimL" REAL,
    "adjustedDimW" REAL,
    "adjustedDimH" REAL,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "skuDataFixed" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT
);

-- CreateTable
CREATE TABLE "SkuAdjustmentProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "updatedAt" DATETIME NOT NULL,
    "sku" TEXT NOT NULL,
    "productName" TEXT,
    "totalAdjustments" INTEGER NOT NULL DEFAULT 0,
    "totalAmountLost" REAL NOT NULL DEFAULT 0,
    "avgAdjustmentAmount" REAL,
    "mostCommonType" TEXT,
    "needsSkuDbUpdate" BOOLEAN NOT NULL DEFAULT false,
    "suggestedWeight" REAL,
    "lastAdjustmentDate" TEXT,
    "channel" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "ShippingAdjustment_externalId_key" ON "ShippingAdjustment"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "SkuAdjustmentProfile_sku_key" ON "SkuAdjustmentProfile"("sku");
