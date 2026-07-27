-- Frozen Analytics v2.0: proactive risk prediction + rule storage + learning-loop back-link.

-- AlterTable: add learning-loop back-link from incident → predictive alert.
ALTER TABLE "FrozenIncident" ADD COLUMN "linkedAlertId" TEXT;
CREATE INDEX "FrozenIncident_linkedAlertId_idx" ON "FrozenIncident"("linkedAlertId");

-- CreateTable: predictive risk alert (one row per orderId × shipDate).
CREATE TABLE "FrozenRiskAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "orderId" TEXT NOT NULL,
    "veeqoOrderId" TEXT,
    "storeIndex" INTEGER,
    "storeName" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'Amazon',
    "sku" TEXT NOT NULL,
    "productName" TEXT,
    "asin" TEXT,
    "shipDate" TEXT NOT NULL,
    "edd" TEXT,
    "transitDays" INTEGER,
    "plannedCarrier" TEXT,
    "plannedService" TEXT,
    "destZip" TEXT NOT NULL,
    "destCity" TEXT,
    "destState" TEXT,
    "destLat" REAL,
    "destLon" REAL,
    "originTempF" REAL,
    "originFeelsLikeF" REAL,
    "originTempMaxF" REAL,
    "originNormalF" REAL,
    "originAnomalyF" REAL,
    "originWeatherDesc" TEXT,
    "destTempF" REAL,
    "destFeelsLikeF" REAL,
    "destTempMaxF" REAL,
    "destNormalF" REAL,
    "destAnomalyF" REAL,
    "destWeatherDesc" TEXT,
    "riskLevel" TEXT NOT NULL,
    "riskScore" INTEGER NOT NULL,
    "triggeredRules" TEXT NOT NULL,
    "recommendations" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "appliedAt" DATETIME,
    "appliedBy" TEXT,
    "userNotes" TEXT,
    "shippingChoiceFollowed" BOOLEAN,
    "resultedInComplaint" BOOLEAN,
    "linkedIncidentId" TEXT
);
CREATE UNIQUE INDEX "FrozenRiskAlert_orderId_shipDate_key" ON "FrozenRiskAlert"("orderId", "shipDate");
CREATE INDEX "FrozenRiskAlert_riskLevel_status_idx" ON "FrozenRiskAlert"("riskLevel", "status");
CREATE INDEX "FrozenRiskAlert_shipDate_idx" ON "FrozenRiskAlert"("shipDate");
CREATE INDEX "FrozenRiskAlert_sku_idx" ON "FrozenRiskAlert"("sku");
CREATE INDEX "FrozenRiskAlert_storeIndex_idx" ON "FrozenRiskAlert"("storeIndex");

-- CreateTable: configurable rules (R1-R6 base + M1-M4 modifiers).
CREATE TABLE "FrozenRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "conditions" TEXT NOT NULL,
    "riskLevel" TEXT,
    "modifier" INTEGER,
    "recommendation" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100
);
CREATE UNIQUE INDEX "FrozenRule_ruleCode_key" ON "FrozenRule"("ruleCode");
