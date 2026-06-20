-- Finance Core — Phase 1 (Funds)

CREATE TABLE "Payout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketplace" TEXT NOT NULL,
    "storeIndex" INTEGER,
    "entity" TEXT,
    "externalId" TEXT NOT NULL,
    "periodStart" TEXT,
    "periodEnd" TEXT,
    "depositDate" TEXT,
    "grossSales" REAL,
    "feesTotal" REAL,
    "netAmount" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "distributed" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'settlement',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "Payout_marketplace_externalId_key" ON "Payout"("marketplace", "externalId");
CREATE INDEX "Payout_depositDate_idx" ON "Payout"("depositDate");
CREATE INDEX "Payout_distributed_idx" ON "Payout"("distributed");

CREATE TABLE "Fund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "allocationType" TEXT NOT NULL DEFAULT 'percent',
    "value" REAL NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "cap" REAL,
    "balance" REAL NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "Fund_group_idx" ON "Fund"("group");
CREATE INDEX "Fund_active_idx" ON "Fund"("active");

CREATE TABLE "FundAllocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fundId" TEXT NOT NULL,
    "runId" TEXT,
    "payoutId" TEXT,
    "amount" REAL NOT NULL,
    "date" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "FundAllocation_fundId_idx" ON "FundAllocation"("fundId");
CREATE INDEX "FundAllocation_runId_idx" ON "FundAllocation"("runId");

CREATE TABLE "FinancePlanRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runDate" TEXT NOT NULL,
    "periodStart" TEXT,
    "periodEnd" TEXT,
    "totalIn" REAL NOT NULL DEFAULT 0,
    "totalReserved" REAL NOT NULL DEFAULT 0,
    "totalDistributed" REAL NOT NULL DEFAULT 0,
    "reserveRateUsed" REAL NOT NULL DEFAULT 0,
    "payoutCount" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "FinancePlanRun_runDate_idx" ON "FinancePlanRun"("runDate");
