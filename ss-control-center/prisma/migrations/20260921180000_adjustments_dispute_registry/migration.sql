-- Реестр споров по shipping adjustments.
--
-- Только добавление: ни одна колонка не удаляется и не переименовывается.
-- Старые adjusted* остаются на месте — в них для UPS лежит манифест, и их
-- ещё читает прежняя ручка dispute-pack.
--
-- SQL написан руками, потому что `prisma migrate dev` в этом репо не
-- проигрывается: июньская миграция 20260607220000_cogs_sku_cost падает на
-- shadow-базе (no such table: SkuShippingData). Боевая база — Turso, туда
-- миграция накатывается скриптом scripts/turso-migrate-adjustments-dispute-registry.mjs.

-- AlterTable: заявленное нами при покупке лейбла (как показывает кабинет)
ALTER TABLE "ShippingAdjustment" ADD COLUMN "enteredDimL" REAL;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "enteredDimW" REAL;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "enteredDimH" REAL;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "enteredDimUnit" TEXT;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "enteredWeight" REAL;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "enteredWeightUnit" TEXT;

-- AlterTable: настоящий аудит перевозчика
ALTER TABLE "ShippingAdjustment" ADD COLUMN "auditedDimL" REAL;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "auditedDimW" REAL;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "auditedDimH" REAL;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "auditedDimUnit" TEXT;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "auditedWeight" REAL;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "auditedWeightUnit" TEXT;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "auditSource" TEXT;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "auditCapturedAt" DATETIME;

-- AlterTable: разбивка начисления и привязка к проводке
ALTER TABLE "ShippingAdjustment" ADD COLUMN "chargeBreakdown" TEXT;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "amountAlreadyPaid" REAL;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "totalChargeFromCarrier" REAL;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "transactionTotal" REAL;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "financialEventId" TEXT;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "transactionDetailsUrl" TEXT;

-- AlterTable: класс расхождения и сводка спора
ALTER TABLE "ShippingAdjustment" ADD COLUMN "disputeClass" TEXT;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "disputeStatus" TEXT DEFAULT 'NONE';
ALTER TABLE "ShippingAdjustment" ADD COLUMN "amountRecovered" REAL DEFAULT 0;
ALTER TABLE "ShippingAdjustment" ADD COLUMN "lastDisputeEventAt" DATETIME;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ShippingAdjustment_storeId_disputeClass_idx" ON "ShippingAdjustment"("storeId", "disputeClass");
CREATE INDEX IF NOT EXISTS "ShippingAdjustment_trackingNumber_idx" ON "ShippingAdjustment"("trackingNumber");
CREATE INDEX IF NOT EXISTS "ShippingAdjustment_disputeStatus_idx" ON "ShippingAdjustment"("disputeStatus");

-- CreateTable: история урегулирования, по записи на событие
CREATE TABLE IF NOT EXISTS "AdjustmentDisputeEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adjustmentId" TEXT NOT NULL,
    "eventDate" TEXT NOT NULL,
    "eventAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventType" TEXT NOT NULL,
    "caseId" TEXT,
    "storeId" TEXT,
    "amountInDispute" REAL,
    "amountRefunded" REAL,
    "summary" TEXT,
    "sourceType" TEXT,
    "sourceRef" TEXT,
    CONSTRAINT "AdjustmentDisputeEvent_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "ShippingAdjustment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AdjustmentDisputeEvent_adjustmentId_eventDate_idx" ON "AdjustmentDisputeEvent"("adjustmentId", "eventDate");
CREATE INDEX IF NOT EXISTS "AdjustmentDisputeEvent_caseId_idx" ON "AdjustmentDisputeEvent"("caseId");
CREATE INDEX IF NOT EXISTS "AdjustmentDisputeEvent_eventType_idx" ON "AdjustmentDisputeEvent"("eventType");
