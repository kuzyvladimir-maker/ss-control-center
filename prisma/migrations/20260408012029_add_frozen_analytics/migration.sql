-- CreateTable
CREATE TABLE "FrozenIncident" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "csCaseId" TEXT,
    "orderId" TEXT NOT NULL,
    "amazonOrderId" TEXT,
    "trackingNumber" TEXT,
    "sku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "boxSize" TEXT,
    "weightLbs" REAL,
    "carrier" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "shipDate" TEXT NOT NULL,
    "promisedEdd" TEXT,
    "actualDelivery" TEXT,
    "daysInTransit" INTEGER,
    "daysLate" INTEGER,
    "claimsProtectedBadge" BOOLEAN,
    "labelCost" REAL,
    "destZip" TEXT,
    "destCity" TEXT,
    "destState" TEXT,
    "destLat" REAL,
    "destLon" REAL,
    "originTempF" REAL,
    "originFeelsLikeF" REAL,
    "originTempHighF" REAL,
    "originWeatherDesc" TEXT,
    "destTempF" REAL,
    "destFeelsLikeF" REAL,
    "destTempHighF" REAL,
    "destWeatherDesc" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'thawed',
    "customerComplained" BOOLEAN NOT NULL DEFAULT true,
    "resolution" TEXT,
    "notes" TEXT
);

-- CreateTable
CREATE TABLE "SkuRiskProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "updatedAt" DATETIME NOT NULL,
    "sku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "totalIncidents" INTEGER NOT NULL DEFAULT 0,
    "thawedCount" INTEGER NOT NULL DEFAULT 0,
    "thawRate" REAL,
    "avgDaysInTransit" REAL,
    "avgOriginTempF" REAL,
    "avgDestTempF" REAL,
    "mostCommonCarrier" TEXT,
    "mostCommonService" TEXT,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskLevel" TEXT NOT NULL DEFAULT 'unknown',
    "lastIncidentDate" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "SkuRiskProfile_sku_key" ON "SkuRiskProfile"("sku");
