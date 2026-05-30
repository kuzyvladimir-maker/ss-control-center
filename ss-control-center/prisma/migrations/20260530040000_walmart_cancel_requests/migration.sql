-- WalmartCancellationRequest table for the cancellation watchdog cron.
-- Records every PO where orderLineStatus.intentToCancel = "TRUE" so we
-- can dedupe + audit actions across cron runs.

CREATE TABLE "WalmartCancellationRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    "purchaseOrderId" TEXT NOT NULL,
    "storeIndex" INTEGER NOT NULL DEFAULT 1,
    "customerOrderId" TEXT,
    "productName" TEXT,
    "orderTotal" REAL,
    "shipBy" DATETIME,

    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actionedAt" DATETIME,
    "action" TEXT NOT NULL DEFAULT 'PENDING',
    "telegramSent" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT
);

CREATE UNIQUE INDEX "WalmartCancellationRequest_purchaseOrderId_key"
    ON "WalmartCancellationRequest"("purchaseOrderId");

CREATE INDEX "WalmartCancellationRequest_action_idx"
    ON "WalmartCancellationRequest"("action");

CREATE INDEX "WalmartCancellationRequest_detectedAt_idx"
    ON "WalmartCancellationRequest"("detectedAt");
